// Client → server messages (protocole_temps_reel.md §6.1, §6.3, §6.4).

import { z } from "zod";
import {
  ActionIdSchema,
  CardSchema,
  PlayerIdSchema,
  RoomOptionsSchema,
  SuitSchema,
  TimestampSchema,
} from "./common.js";

export const AuthMessageSchema = z.strictObject({
  t: z.literal("AUTH"),
  token: z.string().min(1),
  v: z.number().int(),
});
export const PingMessageSchema = z.strictObject({
  t: z.literal("PING"),
  c: TimestampSchema,
  /** Last round-trip time measured by the app (§10), in ms; logged by the server. */
  rtt: z.number().int().nonnegative().max(60_000).optional(),
});

const action = <T extends string>(t: T) => ({ t: z.literal(t), id: ActionIdSchema });

export const JoinMessageSchema = z.strictObject(action("JOIN"));
export const LeaveMessageSchema = z.strictObject(action("LEAVE"));
export const UpdateOptionsMessageSchema = z.strictObject({
  ...action("UPDATE_OPTIONS"),
  options: RoomOptionsSchema,
  // Range and step are business rules checked by the server (INVALID_FEE).
  fee: z.number(),
});
export const StartMessageSchema = z.strictObject(action("START"));
export const PlayMessageSchema = z.strictObject({
  ...action("PLAY"),
  /** Ordered list; the last card becomes the visible card. */
  cards: z.array(CardSchema).min(1).max(54),
  suit: SuitSchema.optional(),
  declareCheck: z.boolean().optional(),
});
export const DrawMessageSchema = z.strictObject(action("DRAW"));
export const CallCheckMessageSchema = z.strictObject({
  ...action("CALL_CHECK"),
  targetId: PlayerIdSchema,
});
export const SyncMessageSchema = z.strictObject(action("SYNC"));
export const QuickPlayMessageSchema = z.strictObject({ ...action("QUICK_PLAY"), fee: z.number() });

/** Messages accepted on `/ws/room/{roomId}`. */
export const RoomClientMessageSchema = z.discriminatedUnion("t", [
  AuthMessageSchema,
  PingMessageSchema,
  JoinMessageSchema,
  LeaveMessageSchema,
  UpdateOptionsMessageSchema,
  StartMessageSchema,
  PlayMessageSchema,
  DrawMessageSchema,
  CallCheckMessageSchema,
  SyncMessageSchema,
]);

/** Messages accepted on `/ws/user`. */
export const UserClientMessageSchema = z.discriminatedUnion("t", [
  AuthMessageSchema,
  PingMessageSchema,
]);

/** Messages accepted on `/ws/lobby`. */
export const LobbyClientMessageSchema = z.discriminatedUnion("t", [
  AuthMessageSchema,
  PingMessageSchema,
  QuickPlayMessageSchema,
]);

export type AuthMessage = z.infer<typeof AuthMessageSchema>;
export type PlayMessage = z.infer<typeof PlayMessageSchema>;
export type RoomClientMessage = z.infer<typeof RoomClientMessageSchema>;
export type UserClientMessage = z.infer<typeof UserClientMessageSchema>;
export type LobbyClientMessage = z.infer<typeof LobbyClientMessageSchema>;
