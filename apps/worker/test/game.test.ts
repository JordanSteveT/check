import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { createSeededRng } from "@check/engine";
import { parseServerMessage } from "@check/protocol";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
import { LOCAL_ROOM_SERVICES, type RoomServices } from "../src/room_services.js";
import { computeSettlement } from "../src/settlement.js";
import { authenticated, closedWithin, createRoom, signToken, type Client } from "./helpers.js";

type Message = Record<string, unknown>;

/** A player whose received messages are all recorded (and checked against the protocol). */
type Player = {
  id: string;
  client: Client;
  log: Message[];
  /** Reads until a message matching `match`; every message read is recorded. */
  until: (match: (m: Message) => boolean) => Promise<Message>;
  act: (message: Message) => Promise<Message>;
};

function stub(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

async function player(roomId: string, userId = crypto.randomUUID()): Promise<Player> {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: userId } }),
  );
  const log: Message[] = [];
  const until = async (match: (m: Message) => boolean): Promise<Message> => {
    for (let i = 0; i < 50; i++) {
      const message = await client.next();
      const valid = parseServerMessage("room", JSON.stringify(message)).success;
      expect({ t: message["t"], valid }).toEqual({ t: message["t"], valid: true });
      log.push(message);
      if (match(message)) return message;
    }
    throw new Error("expected message not received");
  };
  const act = async (message: Message): Promise<Message> => {
    const id = crypto.randomUUID();
    client.send({ ...message, id });
    return until((m) => (m["t"] === "ACK" || m["t"] === "ERROR") && m["id"] === id);
  };
  return { id: userId, client, log, until, act };
}

const is = (t: string) => (m: Message) => m["t"] === t;

async function withRoom(roomId: string, apply: (instance: RoomDO) => void): Promise<void> {
  await runInDurableObject(stub(roomId), apply);
}

async function state(roomId: string): Promise<RoomState> {
  const room = await stub(roomId).getState();
  if (room === null) throw new Error("room not initialized");
  return room;
}

/** Private room with two seated players, started with a seeded generator. */
async function startedDuel(
  seed = 1,
  services: Partial<RoomServices> = {},
): Promise<{ roomId: string; a: Player; b: Player }> {
  const hostId = crypto.randomUUID();
  const roomId = await createRoom({ hostId });
  await withRoom(roomId, (instance) => {
    instance.rng = createSeededRng(seed);
    instance.rateRule = { limit: 10_000, windowMs: 1000, maxStrikes: 3 }; // simulated play is fast

    instance.services = { ...LOCAL_ROOM_SERVICES, ...services };
  });
  const a = await player(roomId, hostId);
  const b = await player(roomId);
  for (const p of [a, b]) {
    await p.act({ t: "JOIN" });
    await p.until(is("STATE"));
  }
  expect(await a.act({ t: "START" })).toMatchObject({ t: "ACK" });
  for (const p of [a, b]) await p.until(is("HAND"));
  return { roomId, a, b };
}

async function view(p: Player): Promise<Message> {
  await p.act({ t: "SYNC" });
  return (await p.until(is("STATE")))["view"] as Message;
}

describe("SRV-05 — montants de fin de partie (spécification des jetons §6.4, §7)", () => {
  it("commission de 10 % arrondie à l'inférieur, gain = cagnotte − commission", () => {
    expect(computeSettlement(400, 10, "WIN")).toEqual({ pot: 400, commission: 40, payout: 360 });
    expect(computeSettlement(800, 10, "WIN")).toEqual({ pot: 800, commission: 80, payout: 720 });
    expect(computeSettlement(1200, 10, "WIN")).toEqual({
      pot: 1200,
      commission: 120,
      payout: 1080,
    });
    expect(computeSettlement(3000, 10, "WIN")).toEqual({
      pot: 3000,
      commission: 300,
      payout: 2700,
    });
    // T19: 3 players at 200, one abandon, then a winner.
    expect(computeSettlement(600, 10, "WIN")).toEqual({ pot: 600, commission: 60, payout: 540 });
    expect(computeSettlement(250, 10, "WIN")).toEqual({ pot: 250, commission: 25, payout: 225 });
    expect(computeSettlement(205, 10, "WIN")).toEqual({ pot: 205, commission: 20, payout: 185 });
  });

  it("partie nulle ou annulée : ni commission ni gain (remboursement)", () => {
    expect(computeSettlement(1500, 10, "DRAW")).toEqual({ pot: 1500, commission: 0, payout: 0 });
    expect(computeSettlement(400, 10, "ABORTED")).toEqual({ pot: 400, commission: 0, payout: 0 });
  });
});

describe("SRV-05 — lancement de la partie", () => {
  it("GAME_STARTED à tous, puis HAND à chacun avec ses seules cartes", async () => {
    const { roomId, a, b } = await startedDuel();
    const started = a.log.find(is("GAME_STARTED"));
    expect(started).toMatchObject({
      pot: 400,
      seats: [a.id, b.id],
      handCounts: { [a.id]: 5, [b.id]: 5 },
    });
    expect(b.log.find(is("GAME_STARTED"))).toEqual(started);
    const handA = a.log.find(is("HAND"))?.["cards"] as string[];
    const handB = b.log.find(is("HAND"))?.["cards"] as string[];
    expect(handA).toHaveLength(5);
    expect(handB).toHaveLength(5);
    expect(handA.filter((c) => handB.includes(c))).toEqual([]);
    const room = await state(roomId);
    expect(room.status).toBe("PLAYING");
    expect(room.game?.hands[a.id]).toEqual(handA);
    a.client.close();
    b.client.close();
  });

  it("STATE en partie : sa main, la carte visible, les coups permis, jamais la main adverse", async () => {
    const { a, b } = await startedDuel();
    const handB = b.log.find(is("HAND"))?.["cards"] as string[];
    const v = await view(a);
    expect(v).toMatchObject({ roomStatus: "PLAYING", game: { pot: 400, deckCount: 43 } });
    expect((v["me"] as Message)["hand"]).toEqual(a.log.find(is("HAND"))?.["cards"]);
    const text = JSON.stringify(v);
    const top = (v["game"] as Message)["topCard"] as string;
    for (const card of handB) if (card !== top) expect(text).not.toContain(`"${card}"`);
    a.client.close();
    b.client.close();
  });
});

describe("SRV-05 — coups joués", () => {
  it("un coup refusé par le moteur renvoie son code (NOT_YOUR_TURN, CARD_NOT_IN_HAND)", async () => {
    const { roomId, a, b } = await startedDuel();
    const current = (await state(roomId)).game?.currentPlayerId;
    const [turn, other] = current === a.id ? [a, b] : [b, a];
    expect(await other.act({ t: "DRAW" })).toMatchObject({ t: "ERROR", code: "NOT_YOUR_TURN" });
    const notMine = (other.log.find(is("HAND"))?.["cards"] as string[])[0];
    expect(await turn.act({ t: "PLAY", cards: [notMine] })).toMatchObject({
      code: "CARD_NOT_IN_HAND",
    });
    expect(await turn.act({ t: "CALL_CHECK", targetId: other.id })).toMatchObject({
      code: "NO_CHECK_TO_CALL",
    });
    a.client.close();
    b.client.close();
  });

  it("DRAW : CARDS_DRAWN à tous, YOU_DREW (sans playerId) au seul joueur qui pioche", async () => {
    const { roomId, a, b } = await startedDuel();
    const current = (await state(roomId)).game?.currentPlayerId;
    const [turn, other] = current === a.id ? [a, b] : [b, a];
    expect(await turn.act({ t: "DRAW" })).toMatchObject({ t: "ACK" });
    const drawn = await other.until(is("CARDS_DRAWN"));
    expect(drawn).toMatchObject({
      playerId: turn.id,
      count: 1,
      reason: "NORMAL",
      nextPlayerId: other.id,
    });
    const mine = await turn.until(is("YOU_DREW"));
    expect(Object.keys(mine).sort()).toEqual(["cards", "t"]);
    expect(other.log.some(is("YOU_DREW"))).toBe(false);
    a.client.close();
    b.client.close();
  });

  it("une partie complète entre deux clients, jusqu'à GAME_OVER", async () => {
    const settled: unknown[][] = [];
    const { roomId, a, b } = await startedDuel(7, {
      settleGame: (...args) => {
        settled.push(args);
        return Promise.resolve();
      },
    });
    const byId = new Map([
      [a.id, a],
      [b.id, b],
    ]);
    let over: Message | undefined;
    for (let step = 0; step < 1000 && over === undefined; step++) {
      const room = await state(roomId);
      if (room.status !== "PLAYING") break;
      const turn = byId.get(room.game?.currentPlayerId ?? "");
      if (turn === undefined) throw new Error("unknown current player");
      const v = await view(turn);
      const legal = (v["game"] as Message)["legal"] as { playable: string[] };
      const first = legal.playable[0];
      const reply =
        first === undefined
          ? await turn.act({ t: "DRAW" })
          : await turn.act({ t: "PLAY", cards: [first], suit: "H", declareCheck: true });
      expect(reply).toMatchObject({ t: "ACK" });
      over = [...a.log, ...b.log].find(is("GAME_OVER"));
    }
    for (const p of [a, b]) over = await p.until(is("GAME_OVER"));
    expect(over).toMatchObject({
      result: "WIN",
      reason: "EMPTY_HAND",
      pot: 400,
      commission: 40,
      payout: 360,
    });
    const winner = over?.["winnerId"] as string;
    expect([a.id, b.id]).toContain(winner);
    expect(settled).toEqual([[expect.any(String), winner, 360, 40]]);
    expect((await state(roomId)).status).toBe("FINISHED");

    // From GAME_STARTED on, both players received every broadcast, numbered without gaps.
    const seqsOf = (p: Player) => {
      const start = p.log.findIndex(is("GAME_STARTED"));
      return p.log
        .slice(start)
        .filter((m) => typeof m["seq"] === "number")
        .map((m) => m["seq"] as number);
    };
    const seqsA = seqsOf(a);
    expect(seqsOf(b)).toEqual(seqsA);
    expect(seqsA.length).toBeGreaterThan(10);
    seqsA.forEach((seq, i) => {
      expect(seq).toBe((seqsA[0] ?? 0) + i);
    });
    expect(a.log.filter(is("CARDS_PLAYED")).length).toBeGreaterThan(3);
    a.client.close();
    b.client.close();
  });
});

describe("SRV-05 — abandon, temps écoulé et fin", () => {
  it("LEAVE en partie = abandon : PLAYER_FORFEIT, puis victoire de l'autre par forfait", async () => {
    const settled: unknown[][] = [];
    const { roomId, a, b } = await startedDuel(3, {
      settleGame: (...args) => {
        settled.push(args);
        return Promise.resolve();
      },
    });
    expect(await a.act({ t: "LEAVE" })).toMatchObject({ t: "ACK" });
    expect(await b.until(is("PLAYER_FORFEIT"))).toMatchObject({ playerId: a.id, reason: "LEFT" });
    expect(await b.until(is("GAME_OVER"))).toMatchObject({
      result: "WIN",
      winnerId: b.id,
      reason: "LAST_PLAYER",
      pot: 400,
      payout: 360,
    });
    expect(settled).toEqual([[expect.any(String), b.id, 360, 40]]);
    expect((await state(roomId)).status).toBe("FINISHED");
    a.client.close();
    b.client.close();
  });

  it("à l'échéance du tour, l'alarme joue l'action automatique (CARDS_DRAWN, TIMEOUT)", async () => {
    const { roomId, a, b } = await startedDuel();
    const current = (await state(roomId)).game?.currentPlayerId;
    await withRoom(roomId, (instance) => {
      const room = (instance as unknown as { state: RoomState }).state;
      if (room.game) room.game.turnDeadline = Date.now() - 1;
    });
    await runDurableObjectAlarm(stub(roomId));
    expect(await a.until(is("CARDS_DRAWN"))).toMatchObject({
      playerId: current,
      reason: "TIMEOUT",
    });
    expect((await state(roomId)).game?.missedTurns[current ?? ""]).toBe(1);
    a.client.close();
    b.client.close();
  });

  it("60 s après la fin de la partie, le salon est fermé (4004)", async () => {
    const { roomId, a, b } = await startedDuel();
    await a.act({ t: "LEAVE" });
    await b.until(is("GAME_OVER"));
    await withRoom(roomId, (instance) => {
      const room = (instance as unknown as { state: RoomState }).state;
      room.finishedAt = Date.now() - 61_000;
    });
    await runDurableObjectAlarm(stub(roomId));
    expect((await closedWithin(b.client)).code).toBe(4004);
    expect((await state(roomId)).status).toBe("CLOSED");
  });
});
