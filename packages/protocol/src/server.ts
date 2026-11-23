// Server → client messages (protocole_temps_reel.md §5, §6.2, §6.3, §6.4).
// Broadcast room events carry `seq`; private messages (ACK, ERROR, STATE, PONG, HAND,
// YOU_DREW, AUTH_OK) do not, so that they never create gaps for the other players.

import { z } from "zod";
import {
  ActionIdSchema,
  CardSchema,
  ColorSchema,
  CountSchema,
  ErrorCodeSchema,
  PlayerIdSchema,
  RoomIdSchema,
  RoomOptionsSchema,
  RoomStatusSchema,
  RoomTypeSchema,
  SuitSchema,
  TimestampSchema,
} from "./common.js";

const seq = { seq: z.number().int().positive() };
const nextTurn = {
  nextPlayerId: PlayerIdSchema.nullable(),
  turnDeadline: TimestampSchema.nullable(),
};

// ---------- Player view (§5) ----------

export const PlayerPublicSchema = z.strictObject({
  id: PlayerIdSchema,
  pseudo: z.string(),
  seat: CountSchema,
  handCount: CountSchema,
  connected: z.boolean(),
  checkDeclared: z.boolean(),
  forfeited: z.boolean(),
});

export const LegalMovesSchema = z.strictObject({
  playable: z.array(CardSchema),
  canDraw: z.boolean(),
  mustChooseSuit: z.boolean(),
});

export const PlayerViewSchema = z.strictObject({
  roomId: RoomIdSchema,
  roomStatus: RoomStatusSchema,
  roomType: RoomTypeSchema,
  /** Only for a private room. */
  code: z.string().optional(),
  hostId: PlayerIdSchema,
  fee: CountSchema,
  options: RoomOptionsSchema,
  players: z.array(PlayerPublicSchema),
  /** The player's own hand only. */
  me: z.strictObject({ id: PlayerIdSchema, hand: z.array(CardSchema) }),
  game: z
    .strictObject({
      gameId: z.string(),
      pot: CountSchema,
      topCard: CardSchema,
      deckCount: CountSchema,
      currentPlayerId: PlayerIdSchema,
      turnDeadline: TimestampSchema,
      penalty: CountSchema,
      requestedSuit: SuitSchema.nullable(),
      openColor: ColorSchema.nullable(),
      checkWindowTargetId: PlayerIdSchema.nullable(),
      legal: LegalMovesSchema,
    })
    .optional(),
  seq: CountSchema,
  serverTime: TimestampSchema,
});

// ---------- Messages common to every connection ----------

export const AuthOkSchema = z.strictObject({
  t: z.literal("AUTH_OK"),
  userId: PlayerIdSchema,
  serverTime: TimestampSchema,
});
export const AckSchema = z.strictObject({ t: z.literal("ACK"), id: ActionIdSchema });
export const ErrorMessageSchema = z.strictObject({
  t: z.literal("ERROR"),
  /** Absent when the faulty message could not be read. */
  id: ActionIdSchema.optional(),
  code: ErrorCodeSchema,
  message: z.string(),
});
export const PongSchema = z.strictObject({
  t: z.literal("PONG"),
  c: TimestampSchema,
  s: TimestampSchema,
});

// ---------- Room connection (§6.2) ----------

export const StateSchema = z.strictObject({ t: z.literal("STATE"), view: PlayerViewSchema });
export const PlayerJoinedSchema = z.strictObject({
  t: z.literal("PLAYER_JOINED"),
  ...seq,
  player: PlayerPublicSchema,
});
export const PlayerLeftSchema = z.strictObject({
  t: z.literal("PLAYER_LEFT"),
  ...seq,
  playerId: PlayerIdSchema,
  reason: z.enum(["LEFT", "KICKED_BALANCE"]),
});
export const HostChangedSchema = z.strictObject({
  t: z.literal("HOST_CHANGED"),
  ...seq,
  hostId: PlayerIdSchema,
});
export const OptionsUpdatedSchema = z.strictObject({
  t: z.literal("OPTIONS_UPDATED"),
  ...seq,
  options: RoomOptionsSchema,
  fee: CountSchema,
});
export const CountdownStartedSchema = z.strictObject({
  t: z.literal("COUNTDOWN_STARTED"),
  ...seq,
  endsAt: TimestampSchema,
});
export const CountdownCancelledSchema = z.strictObject({
  t: z.literal("COUNTDOWN_CANCELLED"),
  ...seq,
  endsAt: TimestampSchema,
});
export const GameStartingSchema = z.strictObject({ t: z.literal("GAME_STARTING"), ...seq });
export const GameStartedSchema = z.strictObject({
  t: z.literal("GAME_STARTED"),
  ...seq,
  gameId: z.string(),
  pot: CountSchema,
  seats: z.array(PlayerIdSchema),
  starterCard: CardSchema,
  currentPlayerId: PlayerIdSchema,
  turnDeadline: TimestampSchema,
  handCounts: z.record(PlayerIdSchema, CountSchema),
});
export const HandSchema = z.strictObject({ t: z.literal("HAND"), cards: z.array(CardSchema) });
export const CardsPlayedSchema = z.strictObject({
  t: z.literal("CARDS_PLAYED"),
  ...seq,
  playerId: PlayerIdSchema,
  cards: z.array(CardSchema).min(1),
  topCard: CardSchema,
  requestedSuit: SuitSchema.nullable(),
  openColor: ColorSchema.nullable(),
  penalty: CountSchema,
  skipped: z.array(PlayerIdSchema),
  handCount: CountSchema,
  checkDeclared: z.boolean(),
  ...nextTurn,
});
export const CardsDrawnSchema = z.strictObject({
  t: z.literal("CARDS_DRAWN"),
  ...seq,
  playerId: PlayerIdSchema,
  count: CountSchema,
  reason: z.enum(["NORMAL", "PENALTY", "CHECK_PENALTY", "TIMEOUT"]),
  handCount: CountSchema,
  deckCount: CountSchema,
  ...nextTurn,
});
export const YouDrewSchema = z.strictObject({
  t: z.literal("YOU_DREW"),
  cards: z.array(CardSchema),
});
export const DeckReshuffledSchema = z.strictObject({
  t: z.literal("DECK_RESHUFFLED"),
  ...seq,
  deckCount: CountSchema,
});
export const CheckWindowSchema = z.strictObject({
  t: z.literal("CHECK_WINDOW"),
  ...seq,
  targetId: PlayerIdSchema.nullable(),
});
export const CheckCalledSchema = z.strictObject({
  t: z.literal("CHECK_CALLED"),
  ...seq,
  callerId: PlayerIdSchema,
  targetId: PlayerIdSchema,
  penalty: CountSchema,
});
export const PlayerConnectionSchema = z.strictObject({
  t: z.literal("PLAYER_CONNECTION"),
  ...seq,
  playerId: PlayerIdSchema,
  connected: z.boolean(),
});
export const PlayerForfeitSchema = z.strictObject({
  t: z.literal("PLAYER_FORFEIT"),
  ...seq,
  playerId: PlayerIdSchema,
  reason: z.enum(["LEFT", "TIMEOUTS", "DISCONNECTED"]),
  ...nextTurn,
});
export const GameOverSchema = z.strictObject({
  t: z.literal("GAME_OVER"),
  ...seq,
  result: z.enum(["WIN", "DRAW", "ABORTED"]),
  winnerId: PlayerIdSchema.nullable(),
  reason: z.enum(["EMPTY_HAND", "LAST_PLAYER", "BLOCKED", "TECHNICAL"]),
  pot: CountSchema,
  commission: CountSchema,
  payout: CountSchema,
  /** Remaining hands, revealed. */
  hands: z.record(PlayerIdSchema, z.array(CardSchema)),
});

export const RoomServerMessageSchema = z.discriminatedUnion("t", [
  AuthOkSchema,
  AckSchema,
  ErrorMessageSchema,
  PongSchema,
  StateSchema,
  PlayerJoinedSchema,
  PlayerLeftSchema,
  HostChangedSchema,
  OptionsUpdatedSchema,
  CountdownStartedSchema,
  CountdownCancelledSchema,
  GameStartingSchema,
  GameStartedSchema,
  HandSchema,
  CardsPlayedSchema,
  CardsDrawnSchema,
  YouDrewSchema,
  DeckReshuffledSchema,
  CheckWindowSchema,
  CheckCalledSchema,
  PlayerConnectionSchema,
  PlayerForfeitSchema,
  GameOverSchema,
]);

// ---------- User connection (§6.3) ----------

export const CurrentRoomSchema = z.strictObject({
  t: z.literal("CURRENT_ROOM"),
  roomId: RoomIdSchema.nullable(),
});
export const GuestExpiringSchema = z.strictObject({
  t: z.literal("GUEST_EXPIRING"),
  secondsLeft: CountSchema,
});

export const UserServerMessageSchema = z.discriminatedUnion("t", [
  AuthOkSchema,
  ErrorMessageSchema,
  PongSchema,
  CurrentRoomSchema,
  GuestExpiringSchema,
]);

// ---------- Lobby connection (§6.4) ----------

export const LobbyRoomSchema = z.strictObject({
  roomId: RoomIdSchema,
  fee: CountSchema,
  options: RoomOptionsSchema,
  playerCount: CountSchema,
  maxPlayers: CountSchema,
  status: RoomStatusSchema,
  countdownEndsAt: TimestampSchema.nullable(),
});

export const LobbyServerMessageSchema = z.discriminatedUnion("t", [
  AuthOkSchema,
  AckSchema,
  ErrorMessageSchema,
  PongSchema,
  z.strictObject({ t: z.literal("LOBBY_SNAPSHOT"), rooms: z.array(LobbyRoomSchema) }),
  z.strictObject({ t: z.literal("LOBBY_ROOM_UPSERT"), room: LobbyRoomSchema }),
  z.strictObject({ t: z.literal("LOBBY_ROOM_REMOVED"), roomId: RoomIdSchema }),
  z.strictObject({ t: z.literal("QUICK_PLAY_MATCHED"), roomId: RoomIdSchema }),
]);

export type PlayerPublic = z.infer<typeof PlayerPublicSchema>;
export type PlayerView = z.infer<typeof PlayerViewSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type LobbyRoom = z.infer<typeof LobbyRoomSchema>;
export type RoomServerMessage = z.infer<typeof RoomServerMessageSchema>;
export type UserServerMessage = z.infer<typeof UserServerMessageSchema>;
export type LobbyServerMessage = z.infer<typeof LobbyServerMessageSchema>;
