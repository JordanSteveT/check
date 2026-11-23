// Reading raw WebSocket messages (protocole_temps_reel.md §3, §8).

import type { z } from "zod";
import {
  LobbyClientMessageSchema,
  RoomClientMessageSchema,
  UserClientMessageSchema,
  type LobbyClientMessage,
  type RoomClientMessage,
  type UserClientMessage,
} from "./client.js";
import { ActionIdSchema, CLOSE_CODES, MAX_MESSAGE_BYTES, type ErrorCode } from "./common.js";
import {
  LobbyServerMessageSchema,
  RoomServerMessageSchema,
  UserServerMessageSchema,
  type ErrorMessage,
} from "./server.js";

export type ConnectionKind = "room" | "user" | "lobby";

type ClientMessageOf = {
  room: RoomClientMessage;
  user: UserClientMessage;
  lobby: LobbyClientMessage;
};

export type ParseResult<T> =
  | { ok: true; message: T }
  /** Answer with `error` (the action is refused), or close the socket with `close`. */
  | { ok: false; error?: ErrorMessage; close?: typeof CLOSE_CODES.TOO_MANY_MESSAGES };

const CLIENT_SCHEMAS = {
  room: RoomClientMessageSchema,
  user: UserClientMessageSchema,
  lobby: LobbyClientMessageSchema,
} as const;

const SERVER_SCHEMAS = {
  room: RoomServerMessageSchema,
  user: UserServerMessageSchema,
  lobby: LobbyServerMessageSchema,
} as const;

/** Size of a string in UTF-8 bytes (no TextEncoder: the package targets plain ES2022). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4; // surrogate pair
      i++;
    } else bytes += 3;
  }
  return bytes;
}

function errorCodeFor(issues: readonly z.core.$ZodIssue[]): ErrorCode {
  if (issues.length > 0 && issues.every((issue) => issue.path[0] === "options")) {
    return "INVALID_OPTIONS";
  }
  if (issues.length > 0 && issues.every((issue) => issue.path[0] === "fee")) return "INVALID_FEE";
  return "INVALID_MESSAGE";
}

function actionIdOf(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const id = (value as { id?: unknown }).id;
  return ActionIdSchema.safeParse(id).success ? (id as string) : undefined;
}

/**
 * Reads a client message received on a connection of the given kind. A message over 4 KB
 * asks for close code 4008; an unreadable or invalid message gets an `ERROR` reply that
 * repeats its `id` when it has a valid one.
 */
export function parseClientMessage<K extends ConnectionKind>(
  kind: K,
  raw: string,
): ParseResult<ClientMessageOf[K]> {
  if (utf8Length(raw) > MAX_MESSAGE_BYTES) {
    return { ok: false, close: CLOSE_CODES.TOO_MANY_MESSAGES };
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: { t: "ERROR", code: "INVALID_MESSAGE", message: "Invalid JSON" } };
  }
  const result = CLIENT_SCHEMAS[kind].safeParse(data);
  if (result.success) return { ok: true, message: result.data as ClientMessageOf[K] };

  const id = actionIdOf(data);
  const error: ErrorMessage = {
    t: "ERROR",
    code: errorCodeFor(result.error.issues),
    message: result.error.issues[0]?.message ?? "Invalid message",
  };
  return { ok: false, error: id === undefined ? error : { ...error, id } };
}

/** Reads a server message on the client side (to detect a server/app version mismatch). */
export function parseServerMessage(kind: ConnectionKind, raw: string) {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { success: false as const };
  }
  return SERVER_SCHEMAS[kind].safeParse(data);
}
