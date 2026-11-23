import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createSeededRng } from "@check/engine";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
import { LOCAL_ROOM_SERVICES, type RoomServices } from "../src/room_services.js";
import { authenticated, closedWithin, createRoom, signToken, type Client } from "./helpers.js";

type Message = Record<string, unknown>;

function stub(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

async function state(roomId: string): Promise<RoomState> {
  const room = await stub(roomId).getState();
  if (room === null) throw new Error("room not initialized");
  return room;
}

/** Simulated server clock of the room. */
async function setClock(roomId: string, now: number): Promise<void> {
  await runInDurableObject(stub(roomId), (instance: RoomDO) => {
    instance.clock = () => now;
  });
}

/** Moves the clock to `now`, then fires the alarm. */
async function alarmAt(roomId: string, now: number): Promise<void> {
  await setClock(roomId, now);
  await runDurableObjectAlarm(stub(roomId));
}

async function armedAlarm(roomId: string): Promise<number | null> {
  return runInDurableObject(stub(roomId), (_instance, s) => s.storage.getAlarm());
}

type Player = { id: string; client: Client; log: Message[]; act: (m: Message) => Promise<Message> };

async function player(roomId: string, id = crypto.randomUUID()): Promise<Player> {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: id } }),
  );
  const log: Message[] = [];
  const act = async (message: Message): Promise<Message> => {
    const actionId = crypto.randomUUID();
    client.send({ ...message, id: actionId });
    for (let i = 0; i < 50; i++) {
      const m = await client.next();
      log.push(m);
      if (m["id"] === actionId) return m;
    }
    throw new Error("no reply");
  };
  return { id, client, log, act };
}

/** Records the messages received so far (waits a little for broadcasts). */
async function drain(p: Player): Promise<Message[]> {
  p.log.push(...(await p.client.received()));
  return p.log;
}

async function seated(
  type: "PRIVATE" | "PUBLIC",
  count: number,
): Promise<{ roomId: string; players: Player[] }> {
  const hostId = crypto.randomUUID();
  const roomId = await createRoom({ type, hostId });
  const players: Player[] = [];
  for (let i = 0; i < count; i++) {
    const p = await player(roomId, i === 0 ? hostId : undefined);
    expect(await p.act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
    players.push(p);
  }
  return { roomId, players };
}

/** Private duel started with a seeded generator and the given services. */
async function startedDuel(services: Partial<RoomServices> = {}) {
  const hostId = crypto.randomUUID();
  const roomId = await createRoom({ hostId });
  await runInDurableObject(stub(roomId), (instance: RoomDO) => {
    instance.rng = createSeededRng(11);
    instance.services = { ...LOCAL_ROOM_SERVICES, ...services };
  });
  const a = await player(roomId, hostId);
  const b = await player(roomId);
  for (const p of [a, b]) await p.act({ t: "JOIN" });
  expect(await a.act({ t: "START" })).toMatchObject({ t: "ACK" });
  await drain(a);
  await drain(b);
  return { roomId, a, b };
}

const count = (log: Message[], t: string) => log.filter((m) => m["t"] === t).length;

describe("SRV-06 — alarme unique armée sur l'échéance la plus proche", () => {
  it("un salon vide est armé sur sa fin de vie (300 s)", async () => {
    const roomId = await createRoom();
    const room = await state(roomId);
    expect(await armedAlarm(roomId)).toBe(room.createdAt + 300_000);
  });

  it("régression : un salon privé de 2 joueurs passé 300 s n'arme pas d'alarme dans le passé", async () => {
    const { roomId, players } = await seated("PRIVATE", 2);
    expect(await armedAlarm(roomId)).toBeNull();
    const room = await state(roomId);
    await alarmAt(roomId, room.createdAt + 400_000);
    expect((await state(roomId)).status).toBe("WAITING");
    expect(await armedAlarm(roomId)).toBeNull();
    for (const p of players) p.client.close();
  });

  it("en partie, l'alarme est armée sur la fin du tour", async () => {
    const { roomId, a, b } = await startedDuel();
    expect(await armedAlarm(roomId)).toBe((await state(roomId)).game?.turnDeadline);
    a.client.close();
    b.client.close();
  });
});

describe("SRV-06 — échéances avec horloge simulée", () => {
  it("vie du salon : rien à 299,999 s, fermeture (4004) à 300 s", async () => {
    const { roomId, players } = await seated("PRIVATE", 1);
    const createdAt = (await state(roomId)).createdAt;
    await alarmAt(roomId, createdAt + 299_999);
    expect((await state(roomId)).status).toBe("WAITING");
    await alarmAt(roomId, createdAt + 300_000);
    expect((await state(roomId)).status).toBe("CLOSED");
    expect((await closedWithin(players[0]?.client as Client)).code).toBe(4004);
  });

  it("compte à rebours public : lancement à l'instant exact de sa fin", async () => {
    const { roomId, players } = await seated("PUBLIC", 2);
    const endsAt = (await state(roomId)).countdownEndsAt ?? 0;
    await alarmAt(roomId, endsAt - 1);
    expect((await state(roomId)).status).toBe("COUNTDOWN");
    await alarmAt(roomId, endsAt);
    expect((await state(roomId)).status).toBe("PLAYING");
    for (const p of players) p.client.close();
  });

  it("fin du tour : une seule action automatique, même si l'alarme se déclenche deux fois", async () => {
    const { roomId, a, b } = await startedDuel();
    const before = await state(roomId);
    const deadline = before.game?.turnDeadline ?? 0;
    const current = before.game?.currentPlayerId ?? "";

    await alarmAt(roomId, deadline - 1);
    expect((await state(roomId)).seq).toBe(before.seq);

    await alarmAt(roomId, deadline);
    await alarmAt(roomId, deadline);
    const after = await state(roomId);
    expect(after.game?.missedTurns[current]).toBe(1);
    expect(after.game?.turnDeadline).toBe(deadline + 30_000);
    expect(count(await drain(a), "CARDS_DRAWN")).toBe(1);
    b.client.close();
    a.client.close();
  });

  it("alarme très en retard : une seule action automatique, le tour suivant repart de maintenant", async () => {
    const { roomId, a, b } = await startedDuel();
    const before = await state(roomId);
    const late = (before.game?.turnDeadline ?? 0) + 10 * 60_000;
    const current = before.game?.currentPlayerId ?? "";
    await alarmAt(roomId, late);
    const after = await state(roomId);
    expect(after.game?.missedTurns[current]).toBe(1);
    expect(after.game?.currentPlayerId).not.toBe(current);
    expect(after.game?.turnDeadline).toBe(late + 30_000);
    a.client.close();
    b.client.close();
  });

  it("partie encore en cours 2 h après son lancement : annulée (ABORTED, TECHNICAL) et remboursée", async () => {
    const refunds: unknown[][] = [];
    const { roomId, a, b } = await startedDuel({
      refundGame: (...args) => {
        refunds.push(args);
        return Promise.resolve();
      },
    });
    const startedAt = (await state(roomId)).startedAt ?? 0;
    await alarmAt(roomId, startedAt + 7_200_000);
    const room = await state(roomId);
    expect(room.status).toBe("FINISHED");
    const over = (await drain(b)).find((m) => m["t"] === "GAME_OVER");
    expect(over).toMatchObject({
      result: "ABORTED",
      winnerId: null,
      reason: "TECHNICAL",
      pot: 400,
      commission: 0,
      payout: 0,
    });
    expect(refunds).toEqual([[room.gameId, [a.id, b.id], 200]]);
    expect(await a.act({ t: "DRAW" })).toMatchObject({ t: "ERROR", code: "NOT_YOUR_TURN" });
    a.client.close();
    b.client.close();
  });

  it("fermeture 60 s après la fin, à l'instant exact", async () => {
    const { roomId, a, b } = await startedDuel();
    await a.act({ t: "LEAVE" });
    const finishedAt = (await state(roomId)).finishedAt ?? 0;
    await alarmAt(roomId, finishedAt + 59_999);
    expect((await state(roomId)).status).toBe("FINISHED");
    await alarmAt(roomId, finishedAt + 60_000);
    expect((await state(roomId)).status).toBe("CLOSED");
    expect(await armedAlarm(roomId)).toBeNull();
    b.client.close();
  });
});
