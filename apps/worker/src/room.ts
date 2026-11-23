// RoomDO: one object per room (architecture §4): the waiting room (protocole §4.1: JOIN,
// LEAVE, host, UPDATE_OPTIONS, START, public countdown, room lifetime), the STARTING step
// (entry fees), then the game (PLAYING) driven by the rules engine, and FINISHED.

import {
  EngineError,
  applyCheckCall,
  applyDraw,
  applyForfeit,
  applyPlay,
  applyTimeout,
  createGame,
  getPlayerView,
  setConnected,
  type ActionResult,
  type EngineEvent,
  type GameOverEvent,
  type GameState,
  type PlayInput,
  type Rng,
  type RoomOptions,
} from "@check/engine";
import {
  CLOSE_CODES,
  RoomOptionsSchema,
  isValidFee,
  type ErrorCode,
  type PlayerView,
  type RoomStatus,
  type RoomType,
} from "@check/protocol";
import { dueDeadlines, roomDeadlines, type Deadline, type DeadlineTimers } from "./deadlines.js";
import { ProtocolObject, type ActionMessage } from "./durable_objects.js";
import { GAME_CONFIG, toEngineConfig } from "./game_config.js";
import { LOBBY_NAME } from "./lobby.js";
import { withRetry } from "./retry.js";
import {
  LOCAL_ROOM_SERVICES,
  type LobbyPublisher,
  type RoomRegistry,
  type RoomServices,
} from "./room_services.js";
import { computeSettlement } from "./settlement.js";

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
  /** Players whose entry fee was debited (refunded on a draw, §7). */
  debited: string[];
  /** Rules engine state while PLAYING and after the end (for the last STATE). */
  game: GameState | null;
  /**
   * Replies already sent, by action id (most recent last): a repeated id gets the same reply
   * without being processed again (protocole §3).
   */
  replies: { id: string; reply: "ACK" | ErrorCode }[];
  /** Start of the game (PLAYING); aborted after 2 h (protocole §9). */
  startedAt: number | null;
  /** End of the game; the room closes 60 s later (protocole §9). */
  finishedAt: number | null;
};

/** Events broadcast to the players, before `seq` is added. */
type RoomEvent =
  | { t: "PLAYER_JOINED"; player: PlayerView["players"][number] }
  | { t: "PLAYER_LEFT"; playerId: string; reason: "LEFT" | "KICKED_BALANCE" }
  | { t: "HOST_CHANGED"; hostId: string }
  | { t: "OPTIONS_UPDATED"; options: RoomOptions; fee: number }
  | { t: "COUNTDOWN_STARTED"; endsAt: number }
  | { t: "COUNTDOWN_CANCELLED"; endsAt: number }
  | { t: "GAME_STARTING" }
  | {
      t: "GAME_STARTED";
      gameId: string;
      pot: number;
      seats: string[];
      starterCard: string;
      currentPlayerId: string;
      turnDeadline: number;
      handCounts: Record<string, number>;
    }
  | Exclude<EngineEvent, { t: "YOU_DREW" | "GAME_OVER" }>
  | (GameOverEvent & { pot: number; commission: number; payout: number });

type GameMessage = Extract<ActionMessage<"room">, { t: "PLAY" | "DRAW" | "CALL_CHECK" }>;

const STORAGE_KEY = "room";
/** Number of action ids remembered for duplicate detection. */
const REPLIES_KEPT = 200;
/** Room timers (protocole §9), from the game constants. */
const TIMERS: DeadlineTimers = {
  roomTtlMs: GAME_CONFIG.timers.room_ttl_seconds * 1000,
  gameMaxMs: GAME_CONFIG.timers.game_max_duration_seconds * 1000,
  closeAfterFinishMs: GAME_CONFIG.timers.finished_room_close_seconds * 1000,
  minPlayers: GAME_CONFIG.players.min,
};
/** Safety bound on the deadlines handled by one alarm (chains of automatic actions). */
const MAX_DEADLINES_PER_ALARM = 50;

/** Cryptographically secure generator for dealing and reshuffling (cahier B6). */
const cryptoRng: Rng = () => (crypto.getRandomValues(new Uint32Array(1))[0] ?? 0) / 4294967296;

export class RoomDO extends ProtocolObject<"room"> {
  protected readonly kind = "room";
  /** External services (Supabase, UserDO). Public so that tests can replace them. */
  services: RoomServices = LOCAL_ROOM_SERVICES;
  /** One room at a time per player (UserDO). Public so that tests can replace it. */
  registry: RoomRegistry;
  /** List of public rooms (LobbyDO). Public so that tests can replace it. */
  lobby: LobbyPublisher;
  /** Last entry published to the lobby (JSON), to publish only changes. */
  private lobbyPublished: string | null = null;
  /** Random generator of the game. Public so that tests can use a seeded one. */
  rng: Rng = cryptoRng;
  private state: RoomState | null = null;
  /**
   * Messages waiting for the state to be saved: nothing reaches a client before the state it
   * describes is durable, so a restart never loses a move that a player has seen (SRV-07).
   */
  private outbox: { ws: WebSocket; message: unknown }[] = [];
  /** Players to free in their UserDO at the next commit. */
  private releases = new Set<string>();
  /** Players whose JOIN is in progress (claimed in their UserDO, not seated yet). */
  private joining = new Set<string>();

  constructor(ctx: DurableObjectState, env: ConstructorParameters<typeof ProtocolObject>[1]) {
    super(ctx, env);
    // Calls to other objects: a fresh stub per attempt, retried on transient failures.
    const userStub = (userId: string) => env.USER.get(env.USER.idFromName(userId));
    this.registry = {
      claim: (userId, roomId) => withRetry(() => userStub(userId).claimRoom(userId, roomId)),
      release: (userId, roomId) => withRetry(() => userStub(userId).releaseRoom(roomId)),
    };
    const lobbyStub = () => env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
    this.lobby = {
      upsert: (room) => withRetry(() => lobbyStub().upsertRoom(room)),
      remove: (roomId) => withRetry(() => lobbyStub().removeRoom(roomId)),
    };
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
      createdAt: this.clock(),
      status: "WAITING",
      players: [],
      countdownEndsAt: null,
      seq: 0,
      gameId: null,
      pot: 0,
      debited: [],
      game: null,
      replies: [],
      startedAt: null,
      finishedAt: null,
    };
    await this.commit();
    await this.reschedule();
  }

  /** Whether the player still holds a seat here (asked by the UserDO before refusing a room). */
  isSeated(userId: string): boolean {
    // A JOIN in progress holds the seat too: two simultaneous JOINs cannot both succeed.
    if (this.joining.has(userId)) return true;
    const room = this.state;
    if (room === null || !room.players.some((p) => p.id === userId)) return false;
    if (room.status === "PLAYING") return !(room.game?.forfeited.includes(userId) ?? false);
    return room.status === "WAITING" || room.status === "COUNTDOWN" || room.status === "STARTING";
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
    try {
      await this.handleMessage(ws, userId, message);
    } finally {
      await this.commit();
    }
  }

  private async handleMessage(
    ws: WebSocket,
    userId: string,
    message: ActionMessage<"room">,
  ): Promise<void> {
    if (message.t !== "JOIN" && message.t !== "SYNC") {
      const previous = this.room().replies.find((r) => r.id === message.id);
      if (previous !== undefined) {
        // Already processed (resent after a reconnection): same reply, nothing replayed.
        if (previous.reply === "ACK") this.ack(ws, previous.id);
        else this.error(ws, previous.id, previous.reply);
        return;
      }
    }
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
        this.queue(ws, { t: "STATE", view: this.viewFor(userId) });
        return;
      case "PLAY":
      case "DRAW":
      case "CALL_CHECK":
        return this.gameAction(ws, userId, message);
    }
  }

  protected override deadlines(): number[] {
    return this.state === null
      ? []
      : roomDeadlines(this.deadlineInput(this.state), TIMERS).map((d) => d.at);
  }

  /**
   * Handles every due deadline, nearest first. Each handler re-checks the state, so a late or
   * repeated alarm is harmless; a chain (e.g. several disconnected players in a row) is handled
   * in one alarm, up to a safety bound.
   */
  protected override async onDeadline(now: number): Promise<void> {
    for (let i = 0; i < MAX_DEADLINES_PER_ALARM; i++) {
      const room = this.state;
      if (room === null) return;
      const due = dueDeadlines(this.deadlineInput(room), TIMERS, now)[0];
      if (due === undefined) return;
      const before = JSON.stringify(room);
      await this.handleDeadline(due, now);
      await this.commit();
      if (JSON.stringify(this.state) === before) return; // nothing changed: stop
    }
  }

  private async handleDeadline(deadline: Deadline, now: number): Promise<void> {
    const room = this.room();
    switch (deadline.kind) {
      case "ROOM_TTL":
        // §2.1.4 — fewer than 2 players 300 s after creation: the room is destroyed.
        await this.closeRoom();
        return;
      case "COUNTDOWN":
        await this.startGame();
        return;
      case "TURN":
        // Automatic action of the current player (cahier §7.3, §9); no-op if not due.
        if (room.game !== null) await this.applyGameResult(applyTimeout(room.game, this.rng, now));
        return;
      case "GAME_LIMIT":
        await this.abortGame();
        return;
      case "CLOSE":
        await this.closeRoom();
        return;
    }
  }

  private deadlineInput(room: RoomState) {
    return {
      status: room.status,
      createdAt: room.createdAt,
      playerCount: room.players.length,
      countdownEndsAt: room.countdownEndsAt,
      turnDeadline: room.game?.turnDeadline ?? null,
      startedAt: room.startedAt,
      finishedAt: room.finishedAt,
    };
  }

  // ---------- Connections (protocole §7) ----------

  /**
   * After AUTH: an older connection of the same player is closed (4003), and a seated player
   * gets the STATE directly (§7.3); in a game, the engine learns that the player is back.
   */
  protected override async onAuthenticated(
    ws: WebSocket,
    userId: string,
    first: boolean,
  ): Promise<void> {
    if (!first || this.state === null) return;
    const older = this.sockets(userId).filter((socket) => socket !== ws);
    for (const socket of older) socket.close(CLOSE_CODES.REPLACED, "REPLACED");
    if (!this.isPlayer(userId)) return;
    const room = this.room();
    if (room.status === "PLAYING" && room.game !== null) {
      this.absorbGameResult(setConnected(room.game, userId, true, this.clock()));
    } else if ((room.status === "WAITING" || room.status === "COUNTDOWN") && older.length === 0) {
      this.broadcast({ t: "PLAYER_CONNECTION", playerId: userId, connected: true }, userId);
    }
    this.queue(ws, { t: "STATE", view: this.viewFor(userId) });
    await this.commit();
    await this.reschedule();
  }

  /** The last connection of a seated player closed: the others are told (and the engine). */
  protected override async onSocketClosed(userId: string): Promise<void> {
    if (this.state === null || !this.isPlayer(userId) || this.sockets(userId).length > 0) return;
    const room = this.room();
    if (room.status === "PLAYING" && room.game !== null) {
      // Disconnected during the turn: 60 s in total (cahier §9).
      this.absorbGameResult(setConnected(room.game, userId, false, this.clock()));
    } else if (room.status === "WAITING" || room.status === "COUNTDOWN") {
      this.broadcast({ t: "PLAYER_CONNECTION", playerId: userId, connected: false });
    } else {
      return;
    }
    await this.commit();
    await this.reschedule();
  }

  // ---------- Waiting room (protocole §4.1, cahier §2.1) ----------

  private async join(ws: WebSocket, userId: string, id: string): Promise<void> {
    if (this.isPlayer(userId)) {
      // Already seated (new tab, reconnection): just resend the state.
      this.ack(ws, id);
      this.queue(ws, { t: "STATE", view: this.viewFor(userId) });
      return;
    }
    const refused = this.joinRefusal();
    if (refused !== null) {
      this.error(ws, id, refused);
      return;
    }

    const roomId = this.ctx.id.toString();
    this.joining.add(userId);
    try {
      await this.joinClaimed(ws, userId, id, roomId);
    } finally {
      this.joining.delete(userId);
    }
  }

  private async joinClaimed(
    ws: WebSocket,
    userId: string,
    id: string,
    roomId: string,
  ): Promise<void> {
    if (!(await this.registry.claim(userId, roomId))) {
      this.error(ws, id, "ALREADY_IN_ROOM");
      return;
    }
    const check = await this.services.checkCanJoin(userId, {
      type: this.room().type,
      fee: this.room().fee,
    });
    // The state may have changed during the calls.
    const refusedNow = this.isPlayer(userId) ? null : this.joinRefusal();
    if (refusedNow !== null || !check.ok) {
      if (!this.isPlayer(userId)) this.releases.add(userId);
      this.error(ws, id, refusedNow ?? (check.ok ? "ROOM_LOCKED" : check.code));
      return;
    }

    const room = this.room();
    if (!this.isPlayer(userId)) {
      room.players.push({ id: userId, pseudo: check.pseudo, joinedAt: this.clock() });
      const player = this.publicPlayers().find((p) => p.id === userId);
      if (player !== undefined) this.broadcast({ t: "PLAYER_JOINED", player }, userId);
    }
    this.ack(ws, id);
    this.queue(ws, { t: "STATE", view: this.viewFor(userId) });

    // §2.1.2 — the public countdown starts when the 2nd player arrives, and is not reset.
    if (
      room.type === "PUBLIC" &&
      room.status === "WAITING" &&
      room.players.length >= GAME_CONFIG.players.min
    ) {
      room.status = "COUNTDOWN";
      room.countdownEndsAt =
        this.clock() + GAME_CONFIG.timers.public_start_countdown_seconds * 1000;
      this.broadcast({ t: "COUNTDOWN_STARTED", endsAt: room.countdownEndsAt });
    }
    await this.commit();
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
    if (room.status === "PLAYING" && room.game !== null) {
      // LEAVE during the game = abandon (protocole §6.1, cahier §9).
      this.ack(ws, id);
      await this.applyGameResult(applyForfeit(room.game, userId, "LEFT", this.clock()));
      return;
    }
    if (room.status !== "WAITING" && room.status !== "COUNTDOWN") {
      // After the game, leaving changes nothing.
      this.ack(ws, id);
      return;
    }
    if (this.isPlayer(userId)) this.removePlayer(userId, "LEFT");
    this.ack(ws, id);
    await this.commit();
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
    await this.commit();
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
    await this.commit();

    const ids = room.players.map((p) => p.id);
    let failed: string[];
    try {
      failed = (await this.services.debitEntryFees(gameId, ids, room.fee)).failed;
    } catch {
      failed = ids; // technical failure: nobody is considered debited
    }
    for (const playerId of failed) {
      for (const socket of this.sockets(playerId)) {
        this.queue(socket, {
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
          this.queue(socket, { t: "STATE", view: this.viewFor(player.id) });
        }
      }
    } else {
      this.beginGame(gameId, debited);
    }
    await this.commit();
    await this.reschedule();
  }

  /** PLAYING: deals the cards (rules engine) and announces the game (protocole §6.2). */
  private beginGame(gameId: string, debited: string[]): void {
    const room = this.room();
    const now = this.clock();
    const game = createGame(
      toEngineConfig(GAME_CONFIG),
      room.options,
      room.players.map((p) => p.id),
      this.rng,
      now,
      gameId,
    );
    room.status = "PLAYING";
    room.startedAt = now;
    room.debited = debited;
    room.pot = room.fee * debited.length;
    room.game = game;
    this.broadcast({
      t: "GAME_STARTED",
      gameId,
      pot: room.pot,
      seats: game.seats,
      starterCard: game.discard[game.discard.length - 1] ?? "",
      currentPlayerId: game.currentPlayerId,
      turnDeadline: game.turnDeadline,
      handCounts: Object.fromEntries(game.seats.map((id) => [id, game.hands[id]?.length ?? 0])),
    });
    for (const id of game.seats) {
      for (const socket of this.sockets(id)) {
        this.queue(socket, { t: "HAND", cards: game.hands[id] ?? [] });
      }
    }
  }

  // ---------- Game (PLAYING) ----------

  private async gameAction(ws: WebSocket, userId: string, message: GameMessage): Promise<void> {
    const room = this.room();
    if (room.status !== "PLAYING" || room.game === null) {
      let code: ErrorCode = message.t === "CALL_CHECK" ? "NO_CHECK_TO_CALL" : "NOT_YOUR_TURN";
      if (room.status === "STARTING") code = "ROOM_STARTING";
      this.error(ws, message.id, code);
      return;
    }
    let result: ActionResult;
    try {
      const now = this.clock();
      if (message.t === "PLAY") {
        const input: PlayInput = {
          cards: message.cards,
          ...(message.suit === undefined ? {} : { suit: message.suit }),
          ...(message.declareCheck === undefined ? {} : { declareCheck: message.declareCheck }),
        };
        result = applyPlay(room.game, userId, input, this.rng, now);
      } else if (message.t === "DRAW") {
        result = applyDraw(room.game, userId, this.rng, now);
      } else {
        result = applyCheckCall(room.game, userId, message.targetId, this.rng);
      }
    } catch (err) {
      if (err instanceof EngineError) {
        this.error(ws, message.id, err.code);
        return;
      }
      throw err;
    }
    this.ack(ws, message.id);
    await this.applyGameResult(result);
  }

  /** Stores the new engine state and sends its events (private ones to their recipient). */
  private async applyGameResult(result: ActionResult): Promise<void> {
    if (result.events.length === 0) return;
    const over = this.absorbGameResult(result);
    if (over !== null) await this.finishGame(over);
    await this.commit();
    await this.reschedule();
  }

  /** Stores the engine state and queues its events; returns GAME_OVER if the game ended. */
  private absorbGameResult(result: ActionResult): GameOverEvent | null {
    const room = this.room();
    room.game = result.state;
    let over: GameOverEvent | null = null;
    for (const event of result.events) {
      if (event.t === "PLAYER_FORFEIT") this.releases.add(event.playerId);
      if (event.t === "YOU_DREW") {
        for (const socket of this.sockets(event.playerId)) {
          this.queue(socket, { t: "YOU_DREW", cards: event.cards });
        }
      } else if (event.t === "GAME_OVER") {
        over = event;
      } else {
        this.broadcast(event);
      }
    }
    return over;
  }

  /**
   * Game still running 2 h after its start (protocole §9): aborted for a technical reason,
   * every debited player is refunded (spécification des jetons §7).
   */
  private async abortGame(): Promise<void> {
    const room = this.room();
    const game = room.game;
    if (room.status !== "PLAYING" || game === null) return;
    room.game = { ...game, status: "FINISHED" };
    await this.finishGame({
      t: "GAME_OVER",
      result: "ABORTED",
      winnerId: null,
      reason: "TECHNICAL",
      hands: Object.fromEntries(Object.entries(game.hands).map(([id, h]) => [id, [...h]])),
    });
    await this.reschedule();
  }

  /** GAME_OVER with the amounts, then settlement or refund (spécification des jetons §6.4, §7). */
  private async finishGame(event: GameOverEvent): Promise<void> {
    const room = this.room();
    const settlement = computeSettlement(room.pot, this.services.commissionPercent, event.result);
    room.status = "FINISHED";
    room.finishedAt = this.clock();
    for (const player of room.players) this.releases.add(player.id);
    this.broadcast({ ...event, ...settlement });
    await this.commit();
    const gameId = room.gameId ?? "";
    try {
      if (event.winnerId !== null && event.result === "WIN") {
        await this.services.settleGame(
          gameId,
          event.winnerId,
          settlement.payout,
          settlement.commission,
        );
      } else {
        await this.services.refundGame(gameId, room.debited, room.fee);
      }
    } catch (err) {
      // Retries and alerts: ECO-04.
      console.error(JSON.stringify({ msg: "settlement failed", gameId, error: String(err) }));
    }
  }

  /** §2.1.4 — the room is destroyed: every connection is closed with 4004. */
  private async closeRoom(): Promise<void> {
    this.room().status = "CLOSED";
    for (const player of this.room().players) this.releases.add(player.id);
    await this.commit();
    for (const ws of this.ctx.getWebSockets()) ws.close(CLOSE_CODES.ROOM_CLOSED, "ROOM_CLOSED");
  }

  /** Removes a seated player, passes the host role and cancels the countdown if needed. */
  private removePlayer(userId: string, reason: "LEFT" | "KICKED_BALANCE"): void {
    const room = this.room();
    room.players = room.players.filter((p) => p.id !== userId);
    this.releases.add(userId);
    this.broadcast({ t: "PLAYER_LEFT", playerId: userId, reason });
    // §2.1.5 — the host role passes to the player who arrived first.
    const first = room.players[0];
    if (room.hostId === userId && first !== undefined) {
      room.hostId = first.id;
      this.broadcast({ t: "HOST_CHANGED", hostId: first.id });
    }
    if (room.status === "COUNTDOWN" && room.players.length < GAME_CONFIG.players.min) {
      const endsAt = room.countdownEndsAt ?? this.clock();
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
    const room = this.room();
    if (room.game !== null) {
      const pseudos = new Map(room.players.map((p) => [p.id, p.pseudo]));
      return getPlayerView(room.game, "").players.map((p) => ({
        ...p,
        pseudo: pseudos.get(p.id) ?? "",
      }));
    }
    return room.players.map((p, seat) => ({
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
      me: room.game === null ? { id: userId, hand: [] } : getPlayerView(room.game, userId).me,
      ...(room.game === null ? {} : { game: this.gameView(room.game, userId) }),
      seq: room.seq,
      serverTime: this.clock(),
    };
  }

  private gameView(game: GameState, userId: string): NonNullable<PlayerView["game"]> {
    const view = getPlayerView(game, userId).game;
    return {
      gameId: view.gameId,
      pot: this.room().pot,
      topCard: view.topCard,
      deckCount: view.deckCount,
      currentPlayerId: view.currentPlayerId,
      turnDeadline: view.turnDeadline,
      penalty: view.penalty,
      requestedSuit: view.requestedSuit,
      openColor: view.openColor,
      checkWindowTargetId: view.checkWindowTargetId,
      legal: view.legal,
    };
  }

  /** Numbers the event and sends it to every seated player (optionally but one). */
  private broadcast(event: RoomEvent, exceptUserId?: string): void {
    const room = this.room();
    room.seq += 1;
    const message = { ...event, seq: room.seq };
    for (const player of room.players) {
      if (player.id === exceptUserId) continue;
      for (const socket of this.sockets(player.id)) this.queue(socket, message);
    }
  }

  private ack(ws: WebSocket, id: string): void {
    this.remember(id, "ACK");
    this.queue(ws, { t: "ACK", id });
  }

  private error(ws: WebSocket, id: string, code: ErrorCode): void {
    this.remember(id, code);
    this.queue(ws, { t: "ERROR", id, code, message: code });
  }

  private remember(id: string, reply: "ACK" | ErrorCode): void {
    const replies = this.room().replies.filter((r) => r.id !== id);
    replies.push({ id, reply });
    this.room().replies = replies.slice(-REPLIES_KEPT);
  }

  /** Queues a message; it is sent by the next `commit`. */
  private queue(ws: WebSocket, message: unknown): void {
    this.outbox.push({ ws, message });
  }

  /** Saves the state, then sends the queued messages (in order). */
  private async commit(): Promise<void> {
    if (this.state !== null) await this.ctx.storage.put(STORAGE_KEY, this.state);
    for (const { ws, message } of this.outbox.splice(0)) this.send(ws, message);
    const roomId = this.ctx.id.toString();
    for (const userId of [...this.releases]) {
      this.releases.delete(userId);
      try {
        await this.registry.release(userId, roomId);
      } catch (err) {
        // The UserDO checks with the room before refusing a claim, so a missed release
        // cannot lock the player out.
        console.error(
          JSON.stringify({ msg: "release failed", roomId, userId, error: String(err) }),
        );
      }
    }
    await this.syncLobby();
  }

  /**
   * A public room is listed in the lobby while it can be joined or is starting (WAITING,
   * COUNTDOWN, STARTING), then removed; only changes are published (protocole §6.4).
   */
  private async syncLobby(): Promise<void> {
    const room = this.state;
    if (room?.type !== "PUBLIC") return;
    const roomId = this.ctx.id.toString();
    const listed =
      room.status === "WAITING" || room.status === "COUNTDOWN" || room.status === "STARTING";
    const entry = listed
      ? {
          roomId,
          fee: room.fee,
          options: room.options,
          playerCount: room.players.length,
          maxPlayers: GAME_CONFIG.players.max,
          status: room.status,
          countdownEndsAt: room.countdownEndsAt,
        }
      : null;
    const key = JSON.stringify(entry);
    if (key === this.lobbyPublished) return;
    try {
      if (entry === null) await this.lobby.remove(roomId);
      else await this.lobby.upsert(entry);
      this.lobbyPublished = key;
    } catch (err) {
      console.error(JSON.stringify({ msg: "lobby update failed", roomId, error: String(err) }));
    }
  }
}
