import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
import { DEFAULT_OPTIONS, authenticated, createRoom, signToken, type Client } from "./helpers.js";

// The LobbyDO is shared by every test: each test uses its own fee and only looks at its rooms.

type Message = Record<string, unknown>;

function room(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

async function state(roomId: string): Promise<RoomState> {
  const r = await room(roomId).getState();
  if (r === null) throw new Error("room not initialized");
  return r;
}

/** Reads messages until one matches (other rooms' updates are skipped). */
async function until(client: Client, match: (m: Message) => boolean): Promise<Message> {
  for (let i = 0; i < 100; i++) {
    const m = await client.next();
    if (match(m)) return m;
  }
  throw new Error("expected lobby message not received");
}

const upsertOf = (roomId: string) => (m: Message) =>
  m["t"] === "LOBBY_ROOM_UPSERT" && (m["room"] as Message)["roomId"] === roomId;
const removalOf = (roomId: string) => (m: Message) =>
  m["t"] === "LOBBY_ROOM_REMOVED" && m["roomId"] === roomId;

/** Lobby connection; returns the client and the snapshot it received. */
async function lobby(userId = crypto.randomUUID()) {
  const client = await authenticated("/ws/lobby", await signToken({ claims: { sub: userId } }));
  const snapshot = await until(client, (m) => m["t"] === "LOBBY_SNAPSHOT");
  const act = async (message: Message): Promise<Message[]> => {
    const id = crypto.randomUUID();
    client.send({ ...message, id });
    const reply = await until(client, (m) => m["id"] === id);
    if (reply["t"] !== "ACK") return [reply];
    return [reply, await until(client, (m) => m["t"] === "QUICK_PLAY_MATCHED")];
  };
  return { client, snapshot: snapshot["rooms"] as Message[], act };
}

/** Room connection of a new player, with JOIN done. */
async function joined(roomId: string, userId = crypto.randomUUID()) {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: userId } }),
  );
  const act = async (message: Message): Promise<Message> => {
    const id = crypto.randomUUID();
    client.send({ ...message, id });
    return until(client, (m) => m["id"] === id);
  };
  expect(await act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
  return { client, act };
}

describe("SRV-10 — liste des salons publics (protocole §6.4)", () => {
  it("LOBBY_SNAPSHOT à la connexion : les salons publics seulement", async () => {
    const pub = await createRoom({ type: "PUBLIC", fee: 7100 });
    const priv = await createRoom({ type: "PRIVATE", fee: 7100 });
    const { client, snapshot } = await lobby();
    expect(snapshot.find((r) => r["roomId"] === pub)).toEqual({
      roomId: pub,
      fee: 7100,
      options: DEFAULT_OPTIONS,
      playerCount: 0,
      maxPlayers: 6,
      status: "WAITING",
      countdownEndsAt: null,
    });
    expect(snapshot.some((r) => r["roomId"] === priv)).toBe(false);
    client.close();
  });

  it("deux clients voient la liste se mettre à jour : arrivées, compte à rebours, lancement", async () => {
    const l1 = await lobby();
    const l2 = await lobby();
    const roomId = await createRoom({ type: "PUBLIC", fee: 7200 });
    for (const l of [l1, l2]) {
      expect(await until(l.client, upsertOf(roomId))).toMatchObject({ room: { playerCount: 0 } });
    }
    const p1 = await joined(roomId);
    for (const l of [l1, l2]) {
      expect(await until(l.client, upsertOf(roomId))).toMatchObject({ room: { playerCount: 1 } });
    }
    const p2 = await joined(roomId);
    for (const l of [l1, l2]) {
      const update = await until(l.client, upsertOf(roomId));
      expect(update).toMatchObject({ room: { playerCount: 2, status: "COUNTDOWN" } });
      expect((update["room"] as Message)["countdownEndsAt"]).toEqual(expect.any(Number));
    }
    // End of the countdown: the game starts and the room leaves the list.
    const endsAt = (await state(roomId)).countdownEndsAt ?? 0;
    await runInDurableObject(room(roomId), (instance: RoomDO) => {
      instance.clock = () => endsAt;
    });
    await runDurableObjectAlarm(room(roomId));
    for (const l of [l1, l2]) {
      expect(await until(l.client, removalOf(roomId))).toEqual({ t: "LOBBY_ROOM_REMOVED", roomId });
    }
    expect((await state(roomId)).status).toBe("PLAYING");
    for (const c of [l1.client, l2.client, p1.client, p2.client]) c.close();
  });

  it("le changement de frais par l'hôte est publié ; un salon détruit quitte la liste", async () => {
    const hostId = crypto.randomUUID();
    const l = await lobby();
    const roomId = await createRoom({ type: "PUBLIC", fee: 7300, hostId });
    await until(l.client, upsertOf(roomId));
    const host = await joined(roomId, hostId);
    await until(l.client, upsertOf(roomId));
    expect(
      await host.act({ t: "UPDATE_OPTIONS", options: DEFAULT_OPTIONS, fee: 7400 }),
    ).toMatchObject({
      t: "ACK",
    });
    expect(await until(l.client, upsertOf(roomId))).toMatchObject({ room: { fee: 7400 } });

    const createdAt = (await state(roomId)).createdAt;
    await runInDurableObject(room(roomId), (instance: RoomDO) => {
      instance.clock = () => createdAt + 300_000;
    });
    await runDurableObjectAlarm(room(roomId));
    expect(await until(l.client, removalOf(roomId))).toMatchObject({ roomId });
    l.client.close();
  });
});

describe("SRV-10 — partie rapide (QUICK_PLAY)", () => {
  it("choisit un salon public en attente au même montant, le plus rempli d'abord", async () => {
    const emptyRoom = await createRoom({ type: "PUBLIC", fee: 7500 });
    const fuller = await createRoom({ type: "PUBLIC", fee: 7500 });
    const p = await joined(fuller);
    const l = await lobby();
    const [ack, matched] = await l.act({ t: "QUICK_PLAY", fee: 7500 });
    expect(ack).toMatchObject({ t: "ACK" });
    expect(matched).toEqual({ t: "QUICK_PLAY_MATCHED", roomId: fuller });
    expect(emptyRoom).not.toBe(fuller);
    l.client.close();
    p.client.close();
  });

  it("sans salon au bon montant : crée un salon public aux options par défaut, où l'on peut entrer", async () => {
    const userId = crypto.randomUUID();
    const l = await lobby(userId);
    const [, matched] = await l.act({ t: "QUICK_PLAY", fee: 7600 });
    const roomId = matched?.["roomId"] as string;
    const created = await state(roomId);
    expect(created).toMatchObject({
      type: "PUBLIC",
      fee: 7600,
      options: DEFAULT_OPTIONS,
      hostId: userId,
      status: "WAITING",
    });
    // The new room published itself in the lobby (before QUICK_PLAY_MATCHED was sent).
    const listed = await env.LOBBY.get(env.LOBBY.idFromName("lobby")).listRooms();
    expect(listed.find((r) => r.roomId === roomId)).toMatchObject({ fee: 7600, playerCount: 0 });
    const p = await joined(roomId, userId);
    l.client.close();
    p.client.close();
  });

  it("deux parties rapides simultanées au même montant aboutissent au même salon", async () => {
    const l1 = await lobby();
    const l2 = await lobby();
    const [[, m1], [, m2]] = await Promise.all([
      l1.act({ t: "QUICK_PLAY", fee: 7700 }),
      l2.act({ t: "QUICK_PLAY", fee: 7700 }),
    ]);
    expect(m1?.["roomId"]).toBe(m2?.["roomId"]);
    l1.client.close();
    l2.client.close();
  });

  it("un montant invalide : ERROR INVALID_FEE", async () => {
    const l = await lobby();
    const [reply] = await l.act({ t: "QUICK_PLAY", fee: 150 });
    expect(reply).toMatchObject({ t: "ERROR", code: "INVALID_FEE" });
    l.client.close();
  });
});
