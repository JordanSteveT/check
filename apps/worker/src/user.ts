// UserDO: one object per player (architecture §4): presence and current room. A player is in
// at most one room at a time (spécification des jetons P8): rooms claim and release the player
// here. Guest expiry (ECO-05) will live here too.

import { ProtocolObject } from "./durable_objects.js";
import type { Env } from "./env.js";

type UserState = {
  /** Room the player is seated in (waiting room or game), or null. */
  currentRoomId: string | null;
};

const STORAGE_KEY = "user";

export class UserDO extends ProtocolObject<"user"> {
  protected readonly kind = "user";
  private state: UserState = { currentRoomId: null };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<UserState>(STORAGE_KEY)) ?? { currentRoomId: null };
    });
  }

  // ---------- RPC (called by the RoomDOs) ----------

  /**
   * Reserves the player for `roomId`. Refused (false) if the player is seated in another room.
   * A reservation left by a room that no longer holds the player (closed room, finished game,
   * missed release) does not block: the other room is asked first.
   */
  async claimRoom(userId: string, roomId: string): Promise<boolean> {
    const current = this.state.currentRoomId;
    if (current !== null && current !== roomId) {
      if (await this.stillSeated(userId, current)) return false;
      // The state may have changed while the other room answered.
      if (this.state.currentRoomId !== current) return this.claimRoom(userId, roomId);
    }
    await this.setCurrentRoom(roomId);
    return true;
  }

  /** Frees the player, if still reserved by `roomId`. */
  async releaseRoom(roomId: string): Promise<void> {
    if (this.state.currentRoomId === roomId) await this.setCurrentRoom(null);
  }

  /** Current room, after checking that the player is really still seated there. */
  async getCurrentRoom(userId: string): Promise<string | null> {
    const current = this.state.currentRoomId;
    if (current === null) return null;
    if (await this.stillSeated(userId, current)) return current;
    if (this.state.currentRoomId === current) await this.setCurrentRoom(null);
    return this.state.currentRoomId;
  }

  // ---------- Connection (protocole §6.3) ----------

  /** At connection: CURRENT_ROOM, so that the app can go back to a game after a reload. */
  protected override async onAuthenticated(
    ws: WebSocket,
    userId: string,
    first: boolean,
  ): Promise<void> {
    if (!first) return;
    this.send(ws, { t: "CURRENT_ROOM", roomId: await this.getCurrentRoom(userId) });
  }

  // ---------- Helpers ----------

  private async stillSeated(userId: string, roomId: string): Promise<boolean> {
    try {
      return await this.env.ROOM.get(this.env.ROOM.idFromString(roomId)).isSeated(userId);
    } catch {
      // Unknown room id, or the room cannot answer: the reservation is kept (safer).
      return true;
    }
  }

  /** Stores the current room and tells the player's open connections. */
  private async setCurrentRoom(roomId: string | null): Promise<void> {
    this.state = { currentRoomId: roomId };
    await this.ctx.storage.put(STORAGE_KEY, this.state);
    for (const ws of this.sockets()) this.send(ws, { t: "CURRENT_ROOM", roomId });
  }
}
