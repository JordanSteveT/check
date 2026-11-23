// Deadlines of a room (protocole §9). Pure functions: the RoomDO keeps a single alarm armed on
// the nearest deadline and, when it fires, handles every deadline that is due, re-checking the
// state each time, so that a late, repeated or spurious alarm does nothing wrong.

import type { RoomStatus } from "@check/protocol";

export type DeadlineKind = "ROOM_TTL" | "COUNTDOWN" | "TURN" | "GAME_LIMIT" | "CLOSE";

export type Deadline = { kind: DeadlineKind; at: number };

/** What the deadlines depend on (subset of the room state). */
export type DeadlineInput = {
  status: RoomStatus;
  createdAt: number;
  playerCount: number;
  countdownEndsAt: number | null;
  turnDeadline: number | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type DeadlineTimers = {
  /** `timers.room_ttl_seconds` (300). */
  roomTtlMs: number;
  /** `timers.game_max_duration_seconds` (2 h). */
  gameMaxMs: number;
  /** `timers.finished_room_close_seconds` (60). */
  closeAfterFinishMs: number;
  /** `players.min` (2). */
  minPlayers: number;
};

/** Every pending deadline of the room, nearest first. */
export function roomDeadlines(room: DeadlineInput, timers: DeadlineTimers): Deadline[] {
  const list: Deadline[] = [];
  switch (room.status) {
    case "WAITING":
      // Only relevant while the room lacks players: otherwise it would stay due forever.
      if (room.playerCount < timers.minPlayers) {
        list.push({ kind: "ROOM_TTL", at: room.createdAt + timers.roomTtlMs });
      }
      break;
    case "COUNTDOWN":
      if (room.countdownEndsAt !== null) list.push({ kind: "COUNTDOWN", at: room.countdownEndsAt });
      break;
    case "PLAYING":
      if (room.turnDeadline !== null) list.push({ kind: "TURN", at: room.turnDeadline });
      if (room.startedAt !== null) {
        list.push({ kind: "GAME_LIMIT", at: room.startedAt + timers.gameMaxMs });
      }
      break;
    case "FINISHED":
      if (room.finishedAt !== null) {
        list.push({ kind: "CLOSE", at: room.finishedAt + timers.closeAfterFinishMs });
      }
      break;
    case "STARTING":
    case "CLOSED":
      break;
  }
  return list.sort((a, b) => a.at - b.at);
}

/** The deadlines due at `now`, nearest first. */
export function dueDeadlines(room: DeadlineInput, timers: DeadlineTimers, now: number): Deadline[] {
  return roomDeadlines(room, timers).filter((d) => d.at <= now);
}
