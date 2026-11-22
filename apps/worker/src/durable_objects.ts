// Durable Objects of the game server (architecture §4). The common base handles the
// connection protocol (protocole §2.1, §3): AUTH within the deadline, token check, version,
// PING/PONG and message validation, with the hibernation API (state kept in attachments).
// It also owns the single alarm of the object (protocole §9): subclasses list their own
// deadlines and the base always arms the nearest one.

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
import { RATE_RULE, checkRate, type RateRule, type RateState } from "./rate_limit.js";

/** Header set by the Worker for `/ws/user/{userId}` (never trusted from clients). */
export const USER_ID_HEADER = "X-Check-User-Id";

/** State of a WebSocket, stored with `serializeAttachment` (survives hibernation). */
export type Attachment =
  | { phase: "pending"; connectedAt: number; expectedUserId?: string }
  | { phase: "authed"; userId: string; connectedAt: number; rate?: RateState };

type MessageOf = {
  room: RoomClientMessage;
  user: UserClientMessage;
  lobby: LobbyClientMessage;
};

/** Messages left to the subclass once AUTH and PING are handled. */
export type ActionMessage<K extends ConnectionKind> = Exclude<MessageOf[K], { t: "AUTH" | "PING" }>;

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

const OPEN = 1; // WebSocket.READY_STATE_OPEN

export abstract class ProtocolObject<K extends ConnectionKind> extends DurableObject<Env> {
  protected abstract readonly kind: K;
  protected readonly config: ServerConfig;
  /** Server clock (ms). Public so that tests can simulate time; tokens use the real time. */
  clock: () => number = () => Date.now();
  /** Message rate rule (protocole §8). Public so that fast simulated games can relax it. */
  rateRule: RateRule = RATE_RULE;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.config = loadServerConfig(env);
  }

  override async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (!this.acceptsConnections()) {
      pair[1].close(CLOSE_CODES.ROOM_CLOSED, "ROOM_CLOSED");
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const expectedUserId = request.headers.get(USER_ID_HEADER) ?? undefined;
    const attachment: Attachment =
      expectedUserId === undefined
        ? { phase: "pending", connectedAt: this.clock() }
        : { phase: "pending", connectedAt: this.clock(), expectedUserId };
    pair[1].serializeAttachment(attachment);
    await this.reschedule();
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Single alarm: AUTH deadlines, then the subclass deadlines; re-armed for the next one. */
  override async alarm(): Promise<void> {
    const now = this.clock();
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.phase === "pending" && att.connectedAt + this.config.authTimeoutMs <= now) {
        ws.close(CLOSE_CODES.UNAUTHORIZED, "UNAUTHORIZED");
      }
    }
    await this.onDeadline(now);
    await this.reschedule();
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    let att = ws.deserializeAttachment() as Attachment;
    const raw = typeof data === "string" ? data : null;
    const parsed = raw === null ? null : parseClientMessage(this.kind, raw);

    if (parsed?.ok === false && parsed.close !== undefined) {
      ws.close(parsed.close, "TOO_MANY_MESSAGES");
      return;
    }
    if (att.phase === "authed") {
      // §8 — 20 messages per second; the 3rd second over the limit closes the connection.
      const decision = checkRate(att.rate, this.clock(), this.rateRule);
      att = { ...att, rate: decision.state };
      ws.serializeAttachment(att);
      if (decision.close) {
        ws.close(CLOSE_CODES.TOO_MANY_MESSAGES, "TOO_MANY_MESSAGES");
        return;
      }
      if (!decision.allowed) {
        const id = parsed?.ok === true && "id" in parsed.message ? parsed.message.id : undefined;
        this.send(ws, {
          t: "ERROR",
          ...(id === undefined ? {} : { id }),
          code: "RATE_LIMITED",
          message: "Too many messages",
        });
        return;
      }
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
      this.send(ws, {
        t: "ERROR",
        code: "INVALID_MESSAGE",
        message: "Binary messages are not supported",
      });
      return;
    }
    if (!parsed.ok) {
      if (parsed.error !== undefined) this.send(ws, parsed.error);
      return;
    }
    const message = parsed.message;
    if (message.t === "AUTH") {
      await this.authenticate(ws, att, message);
    } else if (message.t === "PING") {
      this.send(ws, { t: "PONG", c: message.c, s: this.clock() });
    } else {
      await this.onMessage(ws, att.userId, message as ActionMessage<K>);
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    // Answer the client's close frame (codes such as 1005/1006 cannot be echoed); the socket
    // may already be closing when the server initiated the close (4003, 4004…).
    try {
      ws.close();
    } catch {
      // already closed
    }
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att?.phase === "authed") await this.onSocketClosed(att.userId);
  }

  // ---------- Hooks for the subclasses ----------

  /** Whether new connections are accepted (otherwise they are closed with 4004). */
  protected acceptsConnections(): boolean {
    return true;
  }

  /** Handles a validated message from an authenticated player. */
  protected onMessage(
    _ws: WebSocket,
    _userId: string,
    _message: ActionMessage<K>,
  ): Promise<void> | void {
    // Implemented by each object (SRV-04 room, SRV-09 user, SRV-10 lobby).
  }

  /** Deadlines of the subclass (ms); the nearest one, if any, arms the alarm. */
  protected deadlines(): number[] {
    return [];
  }

  /** Called by the alarm; handles the subclass deadlines that are due at `now`. */
  protected onDeadline(_now: number): Promise<void> | void {
    // Nothing by default.
  }

  /**
   * Called after a successful AUTH (`first`: the first one of this connection, not a token
   * refresh).
   */
  protected onAuthenticated(
    _ws: WebSocket,
    _userId: string,
    _first: boolean,
  ): Promise<void> | void {
    // Nothing by default.
  }

  /** Called after an authenticated socket closed. */
  protected onSocketClosed(_userId: string): Promise<void> | void {
    // Nothing by default.
  }

  // ---------- Helpers ----------

  protected send(ws: WebSocket, message: unknown): void {
    if (ws.readyState === OPEN) ws.send(JSON.stringify(message));
  }

  /** Open, authenticated sockets of a player (or of everyone). */
  protected sockets(userId?: string): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => {
      if (ws.readyState !== OPEN) return false;
      const att = ws.deserializeAttachment() as Attachment | null;
      return att?.phase === "authed" && (userId === undefined || att.userId === userId);
    });
  }

  /** Arms the alarm for the nearest deadline, or removes it if there is none. */
  protected async reschedule(): Promise<void> {
    const times = [...this.deadlines()];
    for (const ws of this.ctx.getWebSockets()) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att?.phase === "pending" && ws.readyState === OPEN) {
        times.push(att.connectedAt + this.config.authTimeoutMs);
      }
    }
    if (times.length === 0) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.min(...times));
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
      ...(att.phase === "authed" && att.rate !== undefined ? { rate: att.rate } : {}),
    };
    ws.serializeAttachment(authed);
    this.send(ws, { t: "AUTH_OK", userId: result.userId, serverTime: this.clock() });
    if (att.phase === "pending") await this.reschedule();
    await this.onAuthenticated(ws, result.userId, att.phase === "pending");
  }
}

/** One object per player: presence and current room. */
export class UserDO extends ProtocolObject<"user"> {
  protected readonly kind = "user";
}

/** Single object: list of public rooms and quick play. */
export class LobbyDO extends ProtocolObject<"lobby"> {
  protected readonly kind = "lobby";
}
