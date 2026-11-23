// HTTP requests of the Worker (protocole_temps_reel.md §6.5).

import { z } from "zod";
import { ErrorCodeSchema, RoomIdSchema, RoomOptionsSchema, RoomTypeSchema } from "./common.js";

/** `POST /api/rooms` */
export const CreateRoomRequestSchema = z.strictObject({
  type: RoomTypeSchema,
  fee: z.number(),
  options: RoomOptionsSchema,
});
export const CreateRoomResponseSchema = z.strictObject({
  roomId: RoomIdSchema,
  /** Only for a private room (6 characters). */
  code: z.string().optional(),
});

/** `GET /api/rooms/by-code/{code}` */
export const RoomByCodeResponseSchema = z.strictObject({ roomId: RoomIdSchema });

/** `DELETE /api/account` */
export const DeleteAccountRequestSchema = z.strictObject({ confirm: z.literal(true) });

/** `POST /api/client-errors` */
export const ClientErrorRequestSchema = z.strictObject({
  message: z.string().max(2000),
  stack: z.string().max(8000).optional(),
  context: z.record(z.string(), z.unknown()).optional(),
});

/** `{ ok: true }` answers (`POST /api/guest/logout`, `DELETE /api/account`, client errors). */
export const OkResponseSchema = z.strictObject({ ok: z.literal(true) });

/** Body of every HTTP error answer. */
export const HttpErrorSchema = z.strictObject({ code: ErrorCodeSchema, message: z.string() });

export type CreateRoomRequest = z.infer<typeof CreateRoomRequestSchema>;
export type CreateRoomResponse = z.infer<typeof CreateRoomResponseSchema>;
export type HttpError = z.infer<typeof HttpErrorSchema>;
