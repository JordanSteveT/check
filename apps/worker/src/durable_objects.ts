// Durable Objects of the game server (architecture §4). The common base handles the
// connection protocol (protocole §2.1, §3): AUTH within the deadline, token check, version,
// PING/PONG and message validation, with the hibernation API (state kept in attachments).

import { DurableObject } from "cloudflare:workers";
import {
  CLOSE_CODES,
  PROTOCOL_VERSION,
  parseClientMessage,
  type AuthMessage,
  type ConnectionKind,
  type LobbyClientMessage,
  type RoomClientMessage,
  type UserClientMessage,
} from "@check/protocol";
import { createJwksProvider, issuerFor, verifyAccessToken, type KeyProvider } from "./auth.js";
import { loadServerConfig, type Env, type ServerConfig } from "./env.js";

/** Header set by the Worker for `/ws/user/{userId}` (never trusted from clients). */
export const USER_ID_HEADER = "X-Check-User-Id";

/** State of a WebSocket, stored with `serializeAttachment` (survives hibernation). */
export type Attachment =
  | { phase: "pending"; connectedAt: number; expectedUserId?: string }
  | { phase: "authed"; userId: string; connectedAt: number };

type MessageOf = {
  room: RoomClientMessage;
  user: UserClientMessage;
  lobby: LobbyClientMessage;
};

/** One key provider per Supabase project and isolate, so that the JWKS cache is shared. */
const providers = new Map<string, KeyProvider>();

function keyProvider(env: Env): KeyProvider {
  const cacheKey = `${env.SUPABASE_URL}|${env.SUPABASE_JWKS ?? ""}`;
  let provider = providers.get(cacheKey);
  if (provider === undefined) {
    provider = createJwksProvider(env);
    providers.set(cacheKey, provider);
  }
  return provider;
}

function send(ws: WebSocket, message: unknown): void {
  ws.send(JSON.stringify(message));
}

abstract class ProtocolObject<K extends ConnectionKind> extends DurableObject<Env> {
  protected abstract readonly kind: K;
  protected readonly config: ServerConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadServerConfig(env);
  }

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const expectedUserId = request.headers.get(USER_ID_HEADER) ?? undefined;
    const attachment: Attachment =
      expectedUserId === undefined
        ? { phase: "pending", connectedAt: Date.now() }
        : { phase: "pending", connectedAt: Date.now(), expectedUserId };
    this.ctx.acceptWebSocket(pair[1]);
    pair[1].serializeAttachment(attachment);
    await this.scheduleAuthCheck(attachment.connectedAt + this.config.authTimeoutMs);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Closes the sockets that did not authenticate in time, then re-arms for the others. */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let next: number | null = null;
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.phase !== "pending") continue;
      const deadline = att.connectedAt + this.config.authTimeoutMs;
      if (deadline <= now) ws.close(CLOSE_CODES.UNAUTHORIZED, "UNAUTHORIZED");
      else next = next === null ? deadline : Math.min(next, deadline);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment;
    const raw = typeof data === "string" ? data : null;
    const parsed = raw === null ? null : parseClientMessage(this.kind, raw);

    if (parsed?.ok === false && parsed.close !== undefined) {
      ws.close(parsed.close, "TOO_MANY_MESSAGES");
      return;
    }
    if (att.phase === "pending") {
      // §2.1 — the first message must be AUTH.
      if (parsed?.ok !== true || parsed.message.t !== "AUTH") {
        ws.close(CLOSE_CODES.UNAUTHORIZED, "UNAUTHORIZED");
        return;
      }
      await this.authenticate(ws, att, parsed.message);
      return;
    }
    if (parsed === null) {
      send(ws, {
        t: "ERROR",
        code: "INVALID_MESSAGE",
        message: "Binary messages are not supported",
      });
      return;
    }
    if (!parsed.ok) {
      if (parsed.error !== undefined) send(ws, parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.t === "AUTH") {
      await this.authenticate(ws, att, message);
    } else if (message.t === "PING") {
      send(ws, { t: "PONG", c: message.c, s: Date.now() });
    } else {
      await this.onMessage(
        ws,
        att.userId,
        message as Exclude<MessageOf[K], { t: "AUTH" | "PING" }>,
      );
    }
  }

  override webSocketClose(ws: WebSocket): void {
    // Answer the client's close frame (codes such as 1005/1006 cannot be echoed).
    ws.close();
  }

  /**
   * Handles a validated message from an authenticated player. Implemented by each object in
   * the following tickets (SRV-04 room, SRV-09 user, SRV-10 lobby).
   */
  protected onMessage(
    _ws: WebSocket,
    _userId: string,
    _message: Exclude<MessageOf[K], { t: "AUTH" | "PING" }>,
  ): Promise<void> | void {
    // Nothing yet.
  }

  /** First AUTH, or a later AUTH with a refreshed token (§2.1, step 5). */
  private async authenticate(ws: WebSocket, att: Attachment, message: AuthMessage): Promise<void> {
    if (message.v !== PROTOCOL_VERSION) {
      ws.close(CLOSE_CODES.UPGRADE_REQUIRED, "UPGRADE_REQUIRED");
      return;
    }
    const result = await verifyAccessToken(
      message.token,
      keyProvider(this.env),
      issuerFor(this.config.supabaseUrl),
      Math.floor(Date.now() / 1000),
    );
    const expected = att.phase === "pending" ? att.expectedUserId : att.userId;
    if (!result.ok || (expected !== undefined && result.userId !== expected)) {
      ws.close(CLOSE_CODES.UNAUTHORIZED, "UNAUTHORIZED");
      return;
    }
    const authed: Attachment = {
      phase: "authed",
      userId: result.userId,
      connectedAt: att.connectedAt,
    };
    ws.serializeAttachment(authed);
    send(ws, { t: "AUTH_OK", userId: result.userId, serverTime: Date.now() });
  }

  /** Arms the alarm for `at` unless an earlier one is already set. */
  private async scheduleAuthCheck(at: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }
}

/** One object per room: waiting room and game. */
export class RoomDO extends ProtocolObject<"room"> {
  protected readonly kind = "room";
}

/** One object per player: presence and current room. */
export class UserDO extends ProtocolObject<"user"> {
  protected readonly kind = "user";
}

/** Single object: list of public rooms and quick play. */
export class LobbyDO extends ProtocolObject<"lobby"> {
  protected readonly kind = "lobby";
}
