// LobbyDO: single object (architecture §4) holding the list of public rooms, sent live to the
// "Salons publics" screen (protocole §6.4), and quick play. Public rooms publish themselves
// here (upsertRoom / removeRoom); the lobby never handles a game.

import { isValidFee, type ErrorCode, type LobbyRoom } from "@check/protocol";
import { ProtocolObject, type ActionMessage } from "./durable_objects.js";
import type { Env } from "./env.js";
import { GAME_CONFIG } from "./game_config.js";
import { withRetry } from "./retry.js";
import { DEFAULT_FEE_RULE } from "./room_services.js";

/** Name of the single LobbyDO instance. */
export const LOBBY_NAME = "lobby";

type LobbyState = { rooms: Record<string, LobbyRoom> };

const STORAGE_KEY = "lobby";

/** Rooms a player can join, the fullest first, then the nearest countdown end. */
function byFillThenCountdown(a: LobbyRoom, b: LobbyRoom): number {
  if (a.playerCount !== b.playerCount) return b.playerCount - a.playerCount;
  return (a.countdownEndsAt ?? Infinity) - (b.countdownEndsAt ?? Infinity);
}

function isJoinable(room: LobbyRoom): boolean {
  return (
    (room.status === "WAITING" || room.status === "COUNTDOWN") && room.playerCount < room.maxPlayers
  );
}

export class LobbyDO extends ProtocolObject<"lobby"> {
  protected readonly kind = "lobby";
  private state: LobbyState = { rooms: {} };
  /** Quick-play room being created, by fee: simultaneous requests share it. */
  private creating = new Map<number, Promise<string>>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<LobbyState>(STORAGE_KEY)) ?? { rooms: {} };
    });
  }

  // ---------- RPC (called by the public RoomDOs) ----------

  /** A public room was created or changed (players, status, countdown, fee, options). */
  async upsertRoom(room: LobbyRoom): Promise<void> {
    this.state.rooms[room.roomId] = room;
    await this.ctx.storage.put(STORAGE_KEY, this.state);
    this.broadcast({ t: "LOBBY_ROOM_UPSERT", room });
  }

  /** A public room is no longer listed (game started, room closed). */
  async removeRoom(roomId: string): Promise<void> {
    if (!(roomId in this.state.rooms)) return;
    // Rebuilt without the key (no dynamic delete).
    this.state.rooms = Object.fromEntries(
      Object.entries(this.state.rooms).filter(([id]) => id !== roomId),
    );
    await this.ctx.storage.put(STORAGE_KEY, this.state);
    this.broadcast({ t: "LOBBY_ROOM_REMOVED", roomId });
  }

  /** Listed rooms, the fullest first (debugging and tests). */
  listRooms(): LobbyRoom[] {
    return Object.values(this.state.rooms).sort(byFillThenCountdown);
  }

  // ---------- Connection (protocole §6.4) ----------

  protected override onAuthenticated(ws: WebSocket, _userId: string, first: boolean): void {
    if (first) this.send(ws, { t: "LOBBY_SNAPSHOT", rooms: this.listRooms() });
  }

  protected override async onMessage(
    ws: WebSocket,
    userId: string,
    message: ActionMessage<"lobby">,
  ): Promise<void> {
    // The only lobby action: QUICK_PLAY.
    const { id, fee } = message;
    if (!isValidFee(fee, DEFAULT_FEE_RULE)) {
      this.reply(ws, id, "INVALID_FEE");
      return;
    }
    const roomId =
      this.listRooms().find((r) => r.fee === fee && isJoinable(r))?.roomId ??
      (await this.createQuickPlayRoom(fee, userId));
    this.send(ws, { t: "ACK", id });
    this.send(ws, { t: "QUICK_PLAY_MATCHED", roomId });
  }

  // ---------- Helpers ----------

  /** New public room with the default options (cahier §2.2); it publishes itself here. */
  private createQuickPlayRoom(fee: number, hostId: string): Promise<string> {
    const pending = this.creating.get(fee);
    if (pending !== undefined) return pending;
    const creation = (async () => {
      try {
        const id = this.env.ROOM.newUniqueId();
        const init = {
          type: "PUBLIC" as const,
          fee,
          options: GAME_CONFIG.room_options.defaults,
          hostId,
        };
        await withRetry(async () => {
          try {
            await this.env.ROOM.get(id).init(init);
          } catch (err) {
            // A retried call whose first attempt succeeded: the room exists, that is fine.
            if (!String(err).includes("already initialized")) throw err;
          }
        });
        return id.toString();
      } finally {
        this.creating.delete(fee);
      }
    })();
    this.creating.set(fee, creation);
    return creation;
  }

  private broadcast(message: unknown): void {
    for (const ws of this.sockets()) this.send(ws, message);
  }

  private reply(ws: WebSocket, id: string, code: ErrorCode): void {
    this.send(ws, { t: "ERROR", id, code, message: code });
  }
}
