import { env, runInDurableObject } from "cloudflare:test";
import { createSeededRng } from "@check/engine";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
import { authenticated, createRoom, signToken, type Client } from "./helpers.js";

type Message = Record<string, unknown>;

function stub(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

async function state(roomId: string): Promise<RoomState> {
  const room = await stub(roomId).getState();
  if (room === null) throw new Error("room not initialized");
  return room;
}

type Player = {
  id: string;
  client: Client;
  log: Message[];
  until: (match: (m: Message) => boolean) => Promise<Message>;
  act: (m: Message) => Promise<Message>;
};

async function connectPlayer(roomId: string, id: string): Promise<Player> {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: id } }),
  );
  const log: Message[] = [];
  const until = async (match: (m: Message) => boolean) => {
    for (let i = 0; i < 50; i++) {
      const m = await client.next();
      log.push(m);
      if (match(m)) return m;
    }
    throw new Error("expected message not received");
  };
  const act = async (message: Message) => {
    const actionId = crypto.randomUUID();
    client.send({ ...message, id: actionId });
    return until((m) => m["id"] === actionId);
  };
  return { id, client, log, until, act };
}

const is = (t: string) => (m: Message) => m["t"] === t;

/** Restarts the Durable Object: the in-memory instance is dropped, the storage is kept. */
async function restart(roomId: string): Promise<void> {
  await runInDurableObject(stub(roomId), (instance: RoomDO) => {
    Object.assign(instance, { marker: "before restart" });
  });
  await runInDurableObject(stub(roomId), (_instance, s) => {
    s.abort("test restart");
  }).catch(() => undefined);
}

async function instanceMarker(roomId: string): Promise<unknown> {
  return runInDurableObject(
    stub(roomId),
    (instance: RoomDO) => (instance as unknown as { marker?: unknown }).marker,
  );
}

describe("SRV-07 — sauvegarde après chaque coup et reprise après redémarrage", () => {
  it("redémarrage en pleine partie : l'état est relu, les joueurs reviennent, la partie continue jusqu'au bout", async () => {
    const hostId = crypto.randomUUID();
    const otherId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    await runInDurableObject(stub(roomId), (instance: RoomDO) => {
      instance.rng = createSeededRng(21);
      instance.rateRule = { limit: 10_000, windowMs: 1000, maxStrikes: 3 }; // simulated play is fast
    });
    let a = await connectPlayer(roomId, hostId);
    let b = await connectPlayer(roomId, otherId);
    for (const p of [a, b]) await p.act({ t: "JOIN" });
    await a.act({ t: "START" });
    for (const p of [a, b]) await p.until(is("HAND"));

    // One move, then an immediate restart: the move seen by the players must be saved.
    const first = await state(roomId);
    const mover = first.game?.currentPlayerId === hostId ? a : b;
    expect(await mover.act({ t: "DRAW" })).toMatchObject({ t: "ACK" });
    const drawn = await mover.until(is("CARDS_DRAWN"));
    const before = await state(roomId);
    expect(before.seq).toBe(drawn["seq"]);

    await restart(roomId);
    expect(await instanceMarker(roomId)).toBeUndefined(); // a new instance was created
    await runInDurableObject(stub(roomId), (instance: RoomDO) => {
      // The new instance starts with the normal rate rule; simulated play is fast.
      instance.rateRule = { limit: 10_000, windowMs: 1000, maxStrikes: 3 };
    });
    const after = await state(roomId);
    expect(after).toEqual(before);
    expect(after.game?.currentPlayerId).not.toBe(first.game?.currentPlayerId);

    // The alarm survives the restart and stays on the turn deadline.
    const alarm = await runInDurableObject(stub(roomId), (_i, s) => s.storage.getAlarm());
    expect(alarm).toBe(after.game?.turnDeadline);

    // The players come back (new connections): JOIN gives them the saved game and their hand.
    a.client.close();
    b.client.close();
    a = await connectPlayer(roomId, hostId);
    b = await connectPlayer(roomId, otherId);
    for (const p of [a, b]) {
      expect(await p.act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
      const view = (await p.until(is("STATE")))["view"] as Message;
      expect(view).toMatchObject({ roomStatus: "PLAYING", seq: before.seq });
      expect((view["me"] as Message)["hand"]).toEqual(before.game?.hands[p.id]);
    }

    // The game goes on until GAME_OVER.
    const byId = new Map([
      [hostId, a],
      [otherId, b],
    ]);
    for (let step = 0; step < 1000; step++) {
      const room = await state(roomId);
      if (room.status !== "PLAYING") break;
      const turn = byId.get(room.game?.currentPlayerId ?? "");
      if (turn === undefined) throw new Error("unknown current player");
      await turn.act({ t: "SYNC" });
      const view = (await turn.until(is("STATE")))["view"] as Message;
      const playable = ((view["game"] as Message)["legal"] as { playable: string[] }).playable;
      const card = playable[0];
      const reply =
        card === undefined
          ? await turn.act({ t: "DRAW" })
          : await turn.act({ t: "PLAY", cards: [card], suit: "H", declareCheck: true });
      expect(reply).toMatchObject({ t: "ACK" });
    }
    const end = await state(roomId);
    expect(end.status).toBe("FINISHED");
    expect(await a.until(is("GAME_OVER"))).toMatchObject({ result: "WIN", pot: 400 });
    a.client.close();
    b.client.close();
  });

  it("redémarrage en salle d'attente : joueurs, hôte, options et numérotation sont conservés", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ type: "PUBLIC", hostId });
    const a = await connectPlayer(roomId, hostId);
    const b = await connectPlayer(roomId, crypto.randomUUID());
    for (const p of [a, b]) await p.act({ t: "JOIN" });
    const before = await state(roomId);
    expect(before.status).toBe("COUNTDOWN");
    await restart(roomId);
    expect(await state(roomId)).toEqual(before);
    const alarm = await runInDurableObject(stub(roomId), (_i, s) => s.storage.getAlarm());
    expect(alarm).toBe(before.countdownEndsAt);
    a.client.close();
    b.client.close();
  });
});
