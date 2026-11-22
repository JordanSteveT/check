import { env, runInDurableObject } from "cloudflare:test";
import { createSeededRng } from "@check/engine";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
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

type Player = {
  id: string;
  client: Client;
  until: (match: (m: Message) => boolean) => Promise<Message>;
  send: (message: Message, id?: string) => Promise<Message>;
};

/** Opens a connection (AUTH only) for player `id`. */
async function connectAs(roomId: string, id: string): Promise<Player> {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: id } }),
  );
  const until = async (match: (m: Message) => boolean) => {
    for (let i = 0; i < 50; i++) {
      const m = await client.next();
      if (match(m)) return m;
    }
    throw new Error("expected message not received");
  };
  const send = async (message: Message, id = crypto.randomUUID()) => {
    client.send({ ...message, id });
    return until((m) => m["id"] === id);
  };
  return { id, client, until, send };
}

const is = (t: string) => (m: Message) => m["t"] === t;
const connectionOf = (playerId: string, connected: boolean) => (m: Message) =>
  m["t"] === "PLAYER_CONNECTION" && m["playerId"] === playerId && m["connected"] === connected;

async function waitingRoom(): Promise<{ roomId: string; a: Player; b: Player }> {
  const hostId = crypto.randomUUID();
  const roomId = await createRoom({ hostId });
  const a = await connectAs(roomId, hostId);
  const b = await connectAs(roomId, crypto.randomUUID());
  for (const p of [a, b]) {
    await p.send({ t: "JOIN" });
    await p.until(is("STATE"));
  }
  return { roomId, a, b };
}

async function startedDuel(): Promise<{ roomId: string; a: Player; b: Player }> {
  const { roomId, a, b } = await waitingRoom();
  await runInDurableObject(stub(roomId), (instance: RoomDO) => {
    instance.rng = createSeededRng(5);
  });
  expect(await a.send({ t: "START" })).toMatchObject({ t: "ACK" });
  for (const p of [a, b]) await p.until(is("HAND"));
  return { roomId, a, b };
}

describe("SRV-08 — une seule connexion par joueur et par salon (protocole §7.6)", () => {
  it("une nouvelle connexion du même joueur ferme l'ancienne (4003) ; les autres ne voient pas de déconnexion", async () => {
    const { roomId, a, b } = await waitingRoom();
    const second = await connectAs(roomId, a.id);
    expect((await closedWithin(a.client)).code).toBe(4003);
    // A seated player gets the STATE right after AUTH.
    expect(await second.until(is("STATE"))).toMatchObject({ view: { me: { id: a.id } } });
    const seenByB = await b.client.received(300);
    expect(seenByB.some((m) => m["t"] === "PLAYER_CONNECTION")).toBe(false);
    expect((await state(roomId)).players.map((p) => p.id)).toContain(a.id);
    second.client.close();
    b.client.close();
  });
});

describe("SRV-08 — reconnexion (protocole §7, cahier §9)", () => {
  it("en salle d'attente : le joueur reste assis, les autres voient la coupure puis le retour, STATE direct", async () => {
    const { roomId, a, b } = await waitingRoom();
    b.client.close();
    expect(await a.until(connectionOf(b.id, false))).toMatchObject({ t: "PLAYER_CONNECTION" });
    expect((await state(roomId)).players.map((p) => p.id)).toContain(b.id);

    const back = await connectAs(roomId, b.id);
    const view = (await back.until(is("STATE")))["view"] as Message;
    expect(view["players"]).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: b.id, connected: true })]),
    );
    expect(await a.until(connectionOf(b.id, true))).toMatchObject({ connected: true });
    a.client.close();
    back.client.close();
  });

  it("en partie, déconnecté pendant son tour : 60 s au total ; au retour, STATE avec sa main, échéance conservée", async () => {
    const { roomId, a, b } = await startedDuel();
    const before = await state(roomId);
    const currentId = before.game?.currentPlayerId ?? "";
    const [current, other] = currentId === a.id ? [a, b] : [b, a];
    current.client.close();
    expect(await other.until(connectionOf(current.id, false))).toMatchObject({
      t: "PLAYER_CONNECTION",
    });
    const disconnected = await state(roomId);
    expect(disconnected.game?.connected[current.id]).toBe(false);
    expect(disconnected.game?.turnDeadline).toBe((before.game?.turnStartedAt ?? 0) + 60_000);

    const back = await connectAs(roomId, current.id);
    const view = (await back.until(is("STATE")))["view"] as Message;
    expect(view).toMatchObject({ roomStatus: "PLAYING" });
    expect((view["me"] as Message)["hand"]).toEqual(before.game?.hands[current.id]);
    expect(await other.until(connectionOf(current.id, true))).toMatchObject({ connected: true });
    const reconnected = await state(roomId);
    expect(reconnected.game?.connected[current.id]).toBe(true);
    expect(reconnected.game?.turnDeadline).toBe(disconnected.game?.turnDeadline);
    back.client.close();
    other.client.close();
  });

  it("déconnecté hors de son tour : quand son tour arrive, action automatique immédiate", async () => {
    const { roomId, a, b } = await startedDuel();
    const currentId = (await state(roomId)).game?.currentPlayerId ?? "";
    const [current, other] = currentId === a.id ? [a, b] : [b, a];
    other.client.close();
    await current.until(connectionOf(other.id, false));
    expect(await current.send({ t: "DRAW" })).toMatchObject({ t: "ACK" });
    // The alarm fires at once: the absent player draws automatically.
    const automatic = await current.until(
      (m) => m["t"] === "CARDS_DRAWN" && m["playerId"] === other.id,
    );
    expect(automatic).toMatchObject({ reason: "TIMEOUT", nextPlayerId: current.id });
    current.client.close();
  });
});

describe("SRV-08 — identifiant d'action déjà traité (protocole §3)", () => {
  it("un id renvoyé reçoit la même réponse, sans rejouer l'action", async () => {
    const { roomId, a, b } = await startedDuel();
    const currentId = (await state(roomId)).game?.currentPlayerId ?? "";
    const [current, other] = currentId === a.id ? [a, b] : [b, a];
    const id = crypto.randomUUID();
    expect(await current.send({ t: "DRAW" }, id)).toMatchObject({ t: "ACK", id });
    const afterFirst = await state(roomId);
    expect(await current.send({ t: "DRAW" }, id)).toMatchObject({ t: "ACK", id });
    expect(await state(roomId)).toEqual(afterFirst);

    const refused = crypto.randomUUID();
    expect(await current.send({ t: "DRAW" }, refused)).toMatchObject({ code: "NOT_YOUR_TURN" });
    expect(await current.send({ t: "DRAW" }, refused)).toMatchObject({ code: "NOT_YOUR_TURN" });
    // The other player, whose turn it is now, can still play.
    expect(await other.send({ t: "DRAW" })).toMatchObject({ t: "ACK" });
    a.client.close();
    b.client.close();
  });
});

describe("SRV-08 — limite de débit (protocole §8)", () => {
  it("au-delà de 20 messages par seconde : ERROR RATE_LIMITED", async () => {
    const { roomId, a, b } = await waitingRoom();
    // A fresh one-second window (JOIN, sent just before, counts in the current one).
    const later = Date.now() + 10_000;
    await runInDurableObject(stub(roomId), (instance: RoomDO) => {
      instance.clock = () => later;
    });
    for (let i = 0; i < 25; i++) a.client.send({ t: "PING", c: i });
    const replies = await a.client.received(500);
    expect(replies.filter((m) => m["t"] === "PONG")).toHaveLength(20);
    expect(replies.filter((m) => m["code"] === "RATE_LIMITED")).toHaveLength(5);
    a.client.close();
    b.client.close();
  });

  it("à la 3e seconde de dépassement : fermeture 4008", async () => {
    const { roomId, a, b } = await waitingRoom();
    const t0 = Date.now();
    for (let second = 0; second < 3; second++) {
      await runInDurableObject(stub(roomId), (instance: RoomDO) => {
        instance.clock = () => t0 + second * 1000;
      });
      for (let i = 0; i < 21; i++) a.client.send({ t: "PING", c: i });
      await a.client.received(300);
    }
    expect((await closedWithin(a.client)).code).toBe(4008);
    b.client.close();
  });
});
