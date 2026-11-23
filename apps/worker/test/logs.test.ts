import { env, runInDurableObject } from "cloudflare:test";
import { parseClientMessage } from "@check/protocol";
import { describe, expect, it } from "vitest";
import { logEntry, shouldLog, type LogEntry } from "../src/log.js";
import type { RoomDO } from "../src/room.js";
import {
  authenticated,
  closedWithin,
  connect,
  createRoom,
  signToken,
  type Client,
} from "./helpers.js";

type Message = Record<string, unknown>;

function room(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

/** Collects the structured logs of a room. */
async function collectLogs(roomId: string): Promise<LogEntry[]> {
  const logs: LogEntry[] = [];
  await runInDurableObject(room(roomId), (instance: RoomDO) => {
    instance.logSink = (entry) => logs.push(entry);
  });
  return logs;
}

async function seat(roomId: string, userId: string, token?: string) {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    token ?? (await signToken({ claims: { sub: userId } })),
  );
  const act = async (message: Message): Promise<Message> => {
    const id = crypto.randomUUID();
    client.send({ ...message, id });
    for (let i = 0; i < 50; i++) {
      const m = await client.next();
      if (m["id"] === id) return m;
    }
    throw new Error("no reply");
  };
  return { client, act };
}

const find = (logs: LogEntry[], msg: string, extra: Record<string, unknown> = {}) =>
  logs.find((e) => e.msg === msg && Object.entries(extra).every(([k, v]) => e[k] === v));

/** Waits (up to 2 s) for a log entry. */
async function logged(logs: LogEntry[], msg: string, extra: Record<string, unknown> = {}) {
  for (let i = 0; i < 40 && find(logs, msg, extra) === undefined; i++) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return find(logs, msg, extra);
}

describe("SRV-11 — format des journaux", () => {
  it("une entrée JSON par événement : heure, niveau, message, contexte ; les champs vides sont omis", () => {
    expect(
      logEntry("info", "ping", { roomId: "r1", userId: "u1", gameId: undefined, rtt: 87 }, 5),
    ).toEqual({
      ts: 5,
      level: "info",
      msg: "ping",
      roomId: "r1",
      userId: "u1",
      rtt: 87,
    });
  });

  it("niveau minimum (LOG_LEVEL) : seules les entrées de ce niveau ou plus graves sont écrites", () => {
    expect(shouldLog("info", "info")).toBe(true);
    expect(shouldLog("debug", "info")).toBe(false);
    expect(shouldLog("warn", "info")).toBe(true);
    expect(shouldLog("info", "warn")).toBe(false);
    expect(shouldLog("error", "warn")).toBe(true);
  });

  it("PING accepte la latence mesurée par l'app (rtt), facultative", () => {
    const ping = (extra: Message) =>
      parseClientMessage("room", JSON.stringify({ t: "PING", c: 1, ...extra })).ok;
    expect(ping({})).toBe(true);
    expect(ping({ rtt: 120 })).toBe(true);
    expect(ping({ rtt: -1 })).toBe(false);
    expect(ping({ rtt: 1.5 })).toBe(false);
  });
});

describe("SRV-11 — journaux d'un salon (roomId, gameId, userId)", () => {
  it("connexion, action avec sa durée, latence du PING", async () => {
    const userId = crypto.randomUUID();
    const roomId = await createRoom({ hostId: userId });
    const logs = await collectLogs(roomId);
    const token = await signToken({ claims: { sub: userId } });
    const p = await seat(roomId, userId, token);
    expect(await p.act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
    p.client.send({ t: "PING", c: Date.now(), rtt: 87 });
    await p.client.next();

    expect(find(logs, "auth_ok")).toMatchObject({ level: "info", roomId, userId, first: true });
    expect(await logged(logs, "action", { t: "JOIN" })).toMatchObject({
      roomId,
      userId,
      reply: "ACK",
      durationMs: expect.any(Number) as number,
    });
    expect(await logged(logs, "ping")).toMatchObject({ roomId, userId, rtt: 87 });
    expect(await p.act({ t: "START" })).toMatchObject({ code: "NOT_ENOUGH_PLAYERS" });
    expect(await logged(logs, "action", { t: "START" })).toMatchObject({
      reply: "NOT_ENOUGH_PLAYERS",
    });

    // Never a token in the logs.
    expect(JSON.stringify(logs)).not.toContain(token);
    p.client.close();
  });

  it("partie : début, coups (avec gameId) et fin avec les montants", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const roomId = await createRoom({ hostId: a });
    const logs = await collectLogs(roomId);
    const pa = await seat(roomId, a);
    const pb = await seat(roomId, b);
    await pa.act({ t: "JOIN" });
    await pb.act({ t: "JOIN" });
    await pa.act({ t: "START" });
    const started = await logged(logs, "game_started");
    expect(started).toMatchObject({ roomId, players: 2, fee: 200 });
    const gameId = started?.["gameId"] as string;
    expect(gameId).toMatch(/^[0-9a-f-]{36}$/);

    await pa.act({ t: "LEAVE" });
    expect(await logged(logs, "action", { t: "LEAVE", userId: a })).toMatchObject({
      gameId,
      reply: "ACK",
    });
    expect(await logged(logs, "game_over")).toMatchObject({
      roomId,
      gameId,
      result: "WIN",
      reason: "LAST_PLAYER",
      winnerId: b,
      pot: 400,
      commission: 40,
      payout: 360,
    });
    pa.client.close();
    pb.client.close();
  });

  it("refus d'authentification et connexion remplacée", async () => {
    const userId = crypto.randomUUID();
    const roomId = await createRoom();
    const logs = await collectLogs(roomId);
    const bad: Client = await connect(`/ws/room/${roomId}`);
    bad.send({ t: "AUTH", token: await signToken({ claims: { exp: 1 } }), v: 1 });
    await closedWithin(bad);
    expect(find(logs, "auth_failed")).toMatchObject({ level: "warn", roomId, reason: "expired" });

    const first = await seat(roomId, userId);
    const second = await seat(roomId, userId);
    await closedWithin(first.client);
    expect(find(logs, "connection_replaced")).toMatchObject({ roomId, userId });
    second.client.close();
  });
});
