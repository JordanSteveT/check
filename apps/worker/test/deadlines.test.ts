import { describe, expect, it } from "vitest";
import { dueDeadlines, roomDeadlines, type DeadlineInput } from "../src/deadlines.js";

const T0 = 1_763_550_000_000;
const TIMERS = {
  roomTtlMs: 300_000,
  gameMaxMs: 7_200_000,
  closeAfterFinishMs: 60_000,
  minPlayers: 2,
};

function room(overrides: Partial<DeadlineInput>): DeadlineInput {
  return {
    status: "WAITING",
    createdAt: T0,
    playerCount: 0,
    countdownEndsAt: null,
    turnDeadline: null,
    startedAt: null,
    finishedAt: null,
    ...overrides,
  };
}

describe("SRV-06 — échéances d'un salon (protocole §9)", () => {
  it("WAITING avec moins de 2 joueurs : vie du salon, 300 s après la création", () => {
    expect(roomDeadlines(room({ playerCount: 1 }), TIMERS)).toEqual([
      { kind: "ROOM_TTL", at: T0 + 300_000 },
    ]);
  });

  it("WAITING avec 2 joueurs ou plus : aucune échéance (sinon elle resterait due pour toujours)", () => {
    expect(roomDeadlines(room({ playerCount: 2 }), TIMERS)).toEqual([]);
  });

  it("COUNTDOWN : fin du compte à rebours", () => {
    const r = room({ status: "COUNTDOWN", playerCount: 2, countdownEndsAt: T0 + 60_000 });
    expect(roomDeadlines(r, TIMERS)).toEqual([{ kind: "COUNTDOWN", at: T0 + 60_000 }]);
  });

  it("PLAYING : fin du tour, puis limite de 2 h, triées par date", () => {
    const r = room({ status: "PLAYING", startedAt: T0, turnDeadline: T0 + 30_000 });
    expect(roomDeadlines(r, TIMERS)).toEqual([
      { kind: "TURN", at: T0 + 30_000 },
      { kind: "GAME_LIMIT", at: T0 + 7_200_000 },
    ]);
  });

  it("FINISHED : fermeture 60 s après la fin ; STARTING et CLOSED : aucune échéance", () => {
    expect(roomDeadlines(room({ status: "FINISHED", finishedAt: T0 }), TIMERS)).toEqual([
      { kind: "CLOSE", at: T0 + 60_000 },
    ]);
    expect(roomDeadlines(room({ status: "STARTING", playerCount: 0 }), TIMERS)).toEqual([]);
    expect(roomDeadlines(room({ status: "CLOSED", playerCount: 0 }), TIMERS)).toEqual([]);
  });

  it("dueDeadlines (horloge simulée) : rien avant l'échéance, l'échéance à l'instant exact", () => {
    const r = room({ status: "PLAYING", startedAt: T0, turnDeadline: T0 + 30_000 });
    expect(dueDeadlines(r, TIMERS, T0 + 29_999)).toEqual([]);
    expect(dueDeadlines(r, TIMERS, T0 + 30_000)).toEqual([{ kind: "TURN", at: T0 + 30_000 }]);
    expect(dueDeadlines(r, TIMERS, T0 + 8_000_000).map((d) => d.kind)).toEqual([
      "TURN",
      "GAME_LIMIT",
    ]);
  });
});
