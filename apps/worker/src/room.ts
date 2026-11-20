// RoomDO: one object per room (architecture §4). This file covers the waiting room
// (protocole §4.1): JOIN, LEAVE, host, UPDATE_OPTIONS, START, public countdown, room lifetime,
// and the STARTING step (entry fees). The game itself (PLAYING) arrives with SRV-05.

import type { RoomOptions } from "@check/engine";
import {
  CLOSE_CODES,
  RoomOptionsSchema,
  isValidFee,
  type ErrorCode,
  type PlayerView,
  type RoomStatus,
  type RoomType,
} from "@check/protocol";
import { ProtocolObject, type ActionMessage } from "./durable_objects.js";
import { GAME_CONFIG } from "./game_config.js";
import { LOCAL_ROOM_SERVICES, type RoomServices } from "./room_services.js";

/** Parameters given by `POST /api/rooms` (already validated by the Worker). */
export type RoomInit = {
  type: RoomType;
  fee: number;
  options: RoomOptions;
  /** Creator of the room: its first host. */
  hostId: string;
  /** 6-character invitation code (private room only). */
  code?: string;
};

export type RoomPlayer = { id: string; pseudo: string; joinedAt: number };

/** Persistent state of the room (Durable Object storage). */
export type RoomState = {
  type: RoomType;
  code: string | null;
  hostId: string;
  fee: number;
  options: RoomOptions;
  createdAt: number;
  status: RoomStatus;
  /** In order of arrival; the seat is the position in this list. */
  players: RoomPlayer[];
  countdownEndsAt: number | null;
  /** Last `seq` sent (protocole §3). */
  seq: number;
  gameId: string | null;
  pot: number;
};

/** Events broadcast to the players, before `seq` is added. */
type RoomEvent =
  | { t: "PLAYER_JOINED"; player: PlayerView["players"][number] }
  | { t: "PLAYER_LEFT"; playerId: string; reason: "LEFT" | "KICKED_BALANCE" }
  | { t: "HOST_CHANGED"; hostId: string }
  | { t: "OPTIONS_UPDATED"; options: RoomOptions; fee: number }
  | { t: "COUNTDOWN_STARTED"; endsAt: number }
  | { t: "COUNTDOWN_CANCELLED"; endsAt: number }
  | { t: "GAME_STARTING" };

const STORAGE_KEY = "room";

export class RoomDO extends ProtocolObject<"room"> {
  protected readonly kind = "room";
  /** External services (Supabase, UserDO). Public so that tests can replace them. */
  services: RoomServices = LOCAL_ROOM_SERVICES;
  private state: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof ProtocolObject>[1]) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get<RoomState>(STORAGE_KEY)) ?? null;
    });
  }

  // ---------- RPC (called by the Worker) ----------

  /** Creates the room (`POST /api/rooms`). Fails if it already exists. */
  async init(params: RoomInit): Promise<void> {
    if (this.state !== null) throw new Error("Room already initialized");
    const options = RoomOptionsSchema.parse(params.options);
    if (!isValidFee(params.fee, this.services.feeRule)) throw new Error("Invalid fee");
    this.state = {
      type: params.type,
      code: params.type === "PRIVATE" ? (params.code ?? null) : null,
      hostId: params.hostId,
      fee: params.fee,
      options,
      createdAt: Date.now(),
      status: "WAITING",
      players: [],
      countdownEndsAt: null,
      seq: 0,
      gameId: null,
      pot: 0,
    };
    await this.save();
    await this.reschedule();
  }

  /** Copy of the state (debugging and tests). */
  getState(): RoomState | null {
    return this.state === null ? null : (JSON.parse(JSON.stringify(this.state)) as RoomState);
  }

  // ---------- Connection hooks ----------

  protected override acceptsConnections(): boolean {
    return this.state !== null && this.state.status !== "CLOSED";
  }

  protected override async onMessage(
    ws: WebSocket,
    userId: string,
    message: ActionMessage<"room">,
  ): Promise<void> {
    switch (message.t) {
      case "JOIN":
        return this.join(ws, userId, message.id);
      case "LEAVE":
        return this.leave(ws, userId, message.id);
      case "UPDATE_OPTIONS":
        return this.updateOptions(ws, userId, message.id, message.options, message.fee);
      case "START":
        return this.start(ws, userId, message.id);
      case "SYNC":
        this.ack(ws, message.id);
        this.send(ws, { t: "STATE", view: this.viewFor(userId) });
        return;
      case "PLAY":
      case "DRAW":
      case "CALL_CHECK":
        // The game (PLAYING) is handled from SRV-05 on.
        this.error(
          ws,
          message.id,
          this.room().status === "STARTING" ? "ROOM_STARTING" : "NOT_YOUR_TURN",
        );
        return;
    }
  }

  protected override deadlines(): number[] {
    const room = this.state;
    if (room === null) return [];
    if (room.status === "WAITING")
      return [room.createdAt + GAME_CONFIG.timers.room_ttl_seconds * 1000];
    if (room.status === "COUNTDOWN" && room.countdownEndsAt !== null) return [room.countdownEndsAt];
    return [];
  }

  protected override async onDeadline(now: number): Promise<void> {
    const room = this.state;
    if (room === null) return;
    const ttlEnd = room.createdAt + GAME_CONFIG.timers.room_ttl_seconds * 1000;
    if (
      room.status === "WAITING" &&
      ttlEnd <= now &&
      room.players.length < GAME_CONFIG.players.min
    ) {
      await this.closeRoom();
    } else if (
      room.status === "COUNTDOWN" &&
      room.countdownEndsAt !== null &&
      room.countdownEndsAt <= now
    ) {
      await this.startGame();
    }
  }

  // ---------- Waiting room (protocole §4.1, cahier §2.1) ----------

  private async join(ws: WebSocket, userId: string, id: string): Promise<void> {
    if (this.isPlayer(userId)) {
      // Already seated (new tab, reconnection): just resend the state.
      this.ack(ws, id);
      this.send(ws, { t: "STATE", view: this.viewFor(userId) });
      return;
    }
    const refused = this.joinRefusal();
    if (refused !== null) {
      this.error(ws, id, refused);
      return;
    }

    const check = await this.services.checkCanJoin(userId, {
      type: this.room().type,
      fee: this.room().fee,
    });
    // The state may have changed during the call.
    const refusedNow = this.isPlayer(userId) ? null : this.joinRefusal();
    if (refusedNow !== null) {
      this.error(ws, id, refusedNow);
      return;
    }
    if (!check.ok) {
      this.error(ws, id, check.code);
      return;
    }

    const room = this.room();
    if (!this.isPlayer(userId)) {
      room.players.push({ id: userId, pseudo: check.pseudo, joinedAt: Date.now() });
      const player = this.publicPlayers().find((p) => p.id === userId);
      if (player !== undefined) this.broadcast({ t: "PLAYER_JOINED", player }, userId);
    }
    this.ack(ws, id);
    this.send(ws, { t: "STATE", view: this.viewFor(userId) });

    // §2.1.2 — the public countdown starts when the 2nd player arrives, and is not reset.
    if (
      room.type === "PUBLIC" &&
      room.status === "WAITING" &&
      room.players.length >= GAME_CONFIG.players.min
    ) {
      room.status = "COUNTDOWN";
      room.countdownEndsAt = Date.now() + GAME_CONFIG.timers.public_start_countdown_seconds * 1000;
      this.broadcast({ t: "COUNTDOWN_STARTED", endsAt: room.countdownEndsAt });
    }
    await this.save();
    // §2.1.3 — full table: immediate start, whatever the room type.
    if (room.players.length >= GAME_CONFIG.players.max) await this.startGame();
    else await this.reschedule();
  }

  private joinRefusal(): ErrorCode | null {
    const room = this.room();
    if (room.status === "STARTING") return "ROOM_STARTING";
    if (room.status !== "WAITING" && room.status !== "COUNTDOWN") return "ROOM_LOCKED";
    if (room.players.length >= GAME_CONFIG.players.max) return "ROOM_FULL";
    return null;
  }

  private async leave(ws: WebSocket, userId: string, id: string): Promise<void> {
    const room = this.room();
    if (room.status === "STARTING") {
      this.error(ws, id, "ROOM_STARTING");
      return;
    }
    if (room.status !== "WAITING" && room.status !== "COUNTDOWN") {
      // PLAYING (abandon) is handled from SRV-05 on; after the game, leaving changes nothing.
      this.ack(ws, id);
      return;
    }
    if (this.isPlayer(userId)) this.removePlayer(userId, "LEFT");
    this.ack(ws, id);
    await this.save();
    await this.reschedule();
  }

  private async updateOptions(
    ws: WebSocket,
    userId: string,
    id: string,
    options: RoomOptions,
    fee: number,
  ): Promise<void> {
    const refused = this.optionsRefusal(userId);
    if (refused !== null) {
      this.error(ws, id, refused);
      return;
    }
    if (!isValidFee(fee, this.services.feeRule)) {
      this.error(ws, id, "INVALID_FEE");
      return;
    }
    // The host must be able to pay the new fee (protocole §6.1).
    const check = await this.services.checkCanJoin(userId, { type: this.room().type, fee });
    const refusedNow = this.optionsRefusal(userId);
    if (refusedNow !== null) {
      this.error(ws, id, refusedNow);
      return;
    }
    if (!check.ok && check.code === "INSUFFICIENT_BALANCE") {
      this.error(ws, id, "INSUFFICIENT_BALANCE");
      return;
    }
    const room = this.room();
    room.options = { ...options };
    room.fee = fee;
    this.ack(ws, id);
    this.broadcast({ t: "OPTIONS_UPDATED", options: room.options, fee });
    await this.save();
  }

  private optionsRefusal(userId: string): ErrorCode | null {
    const room = this.room();
    if (room.status === "STARTING") return "ROOM_STARTING";
    if (room.status !== "WAITING") return "ROOM_LOCKED";
    if (room.hostId !== userId) return "NOT_HOST";
    return null;
  }

  private async start(ws: WebSocket, userId: string, id: string): Promise<void> {
    const room = this.room();
    if (room.status === "STARTING") {
      this.error(ws, id, "ROOM_STARTING");
      return;
    }
    if (room.status !== "WAITING") {
      this.error(ws, id, "ROOM_LOCKED");
      return;
    }
    // Manual start only in a private room, by the host (cahier §2.1.1).
    if (room.type !== "PRIVATE" || room.hostId !== userId) {
      this.error(ws, id, "NOT_HOST");
      return;
    }
    if (room.players.length < GAME_CONFIG.players.min) {
      this.error(ws, id, "NOT_ENOUGH_PLAYERS");
      return;
    }
    this.ack(ws, id);
    await this.startGame();
  }

  /**
   * STARTING (spécification des jetons §6.3): debit the entry fees; a player whose debit fails
   * leaves the room; with fewer than 2 players left, refund and go back to WAITING.
   */
  private async startGame(): Promise<void> {
    const room = this.room();
    const gameId = crypto.randomUUID();
    room.status = "STARTING";
    room.countdownEndsAt = null;
    room.gameId = gameId;
    this.broadcast({ t: "GAME_STARTING" });
    await this.save();

    const ids = room.players.map((p) => p.id);
    let failed: string[];
    try {
      failed = (await this.services.debitEntryFees(gameId, ids, room.fee)).failed;
    } catch {
      failed = ids; // technical failure: nobody is considered debited
    }
    for (const playerId of failed) {
      for (const socket of this.sockets(playerId)) {
        this.send(socket, {
          t: "ERROR",
          code: "INSUFFICIENT_BALANCE",
          message: "Entry fee could not be debited",
        });
      }
      if (this.isPlayer(playerId)) this.removePlayer(playerId, "KICKED_BALANCE");
    }
    const debited = ids.filter((playerId) => !failed.includes(playerId));

    if (debited.length < GAME_CONFIG.players.min) {
      if (debited.length > 0) await this.services.refundEntryFees(gameId, debited, room.fee);
      room.status = "WAITING";
      room.gameId = null;
      for (const player of room.players) {
        for (const socket of this.sockets(player.id)) {
          this.send(socket, { t: "STATE", view: this.viewFor(player.id) });
        }
      }
    } else {
      room.status = "PLAYING";
      room.pot = room.fee * debited.length;
      // createGame, GAME_STARTED and HAND: SRV-05.
    }
    await this.save();
    await this.reschedule();
  }

  /** §2.1.4 — the room is destroyed: every connection is closed with 4004. */
  private async closeRoom(): Promise<void> {
    this.room().status = "CLOSED";
    await this.save();
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_CODES.ROOM_CLOSED, "ROOM_CLOSED");
  }

  /** Removes a seated player, passes the host role and cancels the countdown if needed. */
  private removePlayer(userId: string, reason: "LEFT" | "KICKED_BALANCE"): void {
    const room = this.room();
    room.players = room.players.filter((p) => p.id !== userId);
    this.broadcast({ t: "PLAYER_LEFT", playerId: userId, reason });
    // §2.1.5 — the host role passes to the player who arrived first.
    const first = room.players[0];
    if (room.hostId === userId && first !== undefined) {
      room.hostId = first.id;
      this.broadcast({ t: "HOST_CHANGED", hostId: first.id });
    }
    if (room.status === "COUNTDOWN" && room.players.length < GAME_CONFIG.players.min) {
      const endsAt = room.countdownEndsAt ?? Date.now();
      room.status = "WAITING";
      room.countdownEndsAt = null;
      this.broadcast({ t: "COUNTDOWN_CANCELLED", endsAt });
    }
  }

  // ---------- Helpers ----------

  private room(): RoomState {
    if (this.state === null) throw new Error("Room not initialized");
    return this.state;
  }

  private isPlayer(userId: string): boolean {
    return this.room().players.some((p) => p.id === userId);
  }

  private publicPlayers(): PlayerView["players"] {
    return this.room().players.map((p, seat) => ({
      id: p.id,
      pseudo: p.pseudo,
      seat,
      handCount: 0,
      connected: this.sockets(p.id).length > 0,
      checkDeclared: false,
      forfeited: false,
    }));
  }

  private viewFor(userId: string): PlayerView {
    const room = this.room();
    return {
      roomId: this.ctx.id.toString(),
      roomStatus: room.status,
      roomType: room.type,
      ...(room.code === null ? {} : { code: room.code }),
      hostId: room.hostId,
      fee: room.fee,
      options: room.options,
      players: this.publicPlayers(),
      me: { id: userId, hand: [] },
      seq: room.seq,
      serverTime: Date.now(),
    };
  }

  /** Numbers the event and sends it to every seated player (optionally but one). */
  private broadcast(event: RoomEvent, exceptUserId?: string): void {
    const room = this.room();
    room.seq += 1;
    const message = { ...event, seq: room.seq };
    for (const player of room.players) {
      if (player.id === exceptUserId) continue;
      for (const socket of this.sockets(player.id)) this.send(socket, message);
    }
  }

  private ack(ws: WebSocket, id: string): void {
    this.send(ws, { t: "ACK", id });
  }

  private error(ws: WebSocket, id: string, code: ErrorCode): void {
    this.send(ws, { t: "ERROR", id, code, message: code });
  }

  private async save(): Promise<void> {
    await this.ctx.storage.put(STORAGE_KEY, this.state);
  }
}
