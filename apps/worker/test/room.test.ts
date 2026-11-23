import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
import { LOCAL_ROOM_SERVICES, type RoomServices } from "../src/room_services.js";
import {
  DEFAULT_OPTIONS,
  authenticated,
  closedWithin,
  connect,
  createRoom,
  signToken,
  type Client,
} from "./helpers.js";

type Message = Record<string, unknown>;

function stub(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

/** Opens an authenticated socket for a new (or given) player. */
async function player(
  roomId: string,
  userId = crypto.randomUUID(),
): Promise<Client & { id: string }> {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: userId } }),
  );
  return Object.assign(client, { id: userId });
}

/** Reads messages until one of type `t` (the skipped ones are returned too). */
async function waitFor(client: Client, t: string): Promise<Message> {
  for (let i = 0; i < 20; i++) {
    const message = await client.next();
    if (message["t"] === t) return message;
  }
  throw new Error(`no ${t} message`);
}

/** Sends an action and returns the reply (ACK or ERROR) with the same id. */
async function act(client: Client, message: Message): Promise<Message> {
  const id = crypto.randomUUID();
  client.send({ ...message, id });
  for (let i = 0; i < 20; i++) {
    const reply = await client.next();
    if ((reply["t"] === "ACK" || reply["t"] === "ERROR") && reply["id"] === id) return reply;
  }
  throw new Error(`no reply to ${String(message["t"])}`);
}

/** JOIN; returns the STATE view received. */
async function join(client: Client): Promise<Message> {
  const reply = await act(client, { t: "JOIN" });
  expect(reply).toMatchObject({ t: "ACK" });
  return (await waitFor(client, "STATE"))["view"] as Message;
}

async function state(roomId: string): Promise<RoomState> {
  const room = await stub(roomId).getState();
  if (room === null) throw new Error("room not initialized");
  return room;
}

/** Replaces the room's external services (Supabase) for one test. */
async function withServices(roomId: string, services: Partial<RoomServices>): Promise<void> {
  await runInDurableObject(stub(roomId), (instance: RoomDO) => {
    instance.services = { ...LOCAL_ROOM_SERVICES, ...services };
  });
}

/** Moves a deadline into the past, then runs the alarm. */
async function expire(roomId: string, field: "createdAt" | "countdownEndsAt"): Promise<void> {
  await runInDurableObject(stub(roomId), (instance: RoomDO) => {
    const room = (instance as unknown as { state: RoomState }).state;
    room[field] = Date.now() - 400_000;
  });
  await runDurableObjectAlarm(stub(roomId));
}

describe("SRV-04 — connexion à un salon", () => {
  it("un salon qui n'a pas été créé : fermeture 4004", async () => {
    const client = await connect(`/ws/room/${env.ROOM.newUniqueId().toString()}`);
    expect((await closedWithin(client)).code).toBe(4004);
  });
});

describe("SRV-04 — JOIN et LEAVE (salle d'attente)", () => {
  it("JOIN : ACK puis STATE ; les autres reçoivent PLAYER_JOINED numéroté", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId, code: "QWE123" });
    const a = await player(roomId, hostId);
    const viewA = await join(a);
    expect(viewA).toMatchObject({
      roomId,
      roomStatus: "WAITING",
      roomType: "PRIVATE",
      code: "QWE123",
      hostId,
      fee: 200,
      options: DEFAULT_OPTIONS,
      players: [{ id: hostId, seat: 0, handCount: 0, connected: true, forfeited: false }],
      me: { id: hostId, hand: [] },
      // The arrival of A is event 1 (nobody else to receive it); STATE covers it.
      seq: 1,
    });
    expect(viewA["game"]).toBeUndefined();

    const b = await player(roomId);
    const viewB = await join(b);
    expect(await waitFor(a, "PLAYER_JOINED")).toMatchObject({
      seq: 2,
      player: { id: b.id, seat: 1 },
    });
    expect(viewB).toMatchObject({ seq: 2, players: [{ id: hostId }, { id: b.id }] });
    a.close();
    b.close();
  });

  it("un deuxième JOIN du même joueur renvoie l'état sans le dupliquer", async () => {
    const roomId = await createRoom();
    const a = await player(roomId);
    await join(a);
    const again = await join(a);
    expect(again["players"]).toHaveLength(1);
    a.close();
  });

  it("LEAVE : PLAYER_LEFT ; si l'hôte part, le rôle passe au joueur arrivé le plus tôt", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    const c = await player(roomId);
    for (const p of [a, b, c]) await join(p);
    expect(await act(a, { t: "LEAVE" })).toMatchObject({ t: "ACK" });
    expect(await waitFor(c, "PLAYER_LEFT")).toMatchObject({ playerId: hostId, reason: "LEFT" });
    expect(await waitFor(c, "HOST_CHANGED")).toMatchObject({ hostId: b.id });
    expect((await state(roomId)).players.map((p) => p.id)).toEqual([b.id, c.id]);
    for (const p of [a, b, c]) p.close();
  });

  it("le refus de check_can_join est renvoyé tel quel (ex. GUEST_NOT_ALLOWED)", async () => {
    const roomId = await createRoom();
    await withServices(roomId, {
      checkCanJoin: () => Promise.resolve({ ok: false, code: "GUEST_NOT_ALLOWED" }),
    });
    const a = await player(roomId);
    expect(await act(a, { t: "JOIN" })).toMatchObject({ t: "ERROR", code: "GUEST_NOT_ALLOWED" });
    expect((await state(roomId)).players).toEqual([]);
    a.close();
  });

  it("SYNC renvoie ACK puis STATE ; une action de jeu hors partie est refusée", async () => {
    const roomId = await createRoom();
    const a = await player(roomId);
    await join(a);
    expect(await act(a, { t: "SYNC" })).toMatchObject({ t: "ACK" });
    expect(await waitFor(a, "STATE")).toMatchObject({ view: { roomStatus: "WAITING" } });
    expect(await act(a, { t: "DRAW" })).toMatchObject({ t: "ERROR", code: "NOT_YOUR_TURN" });
    a.close();
  });
});

describe("SRV-04 — lancement d'un salon privé (cahier §2.1)", () => {
  it("START : NOT_HOST pour un autre joueur, NOT_ENOUGH_PLAYERS seul, puis lancement à 2", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    const a = await player(roomId, hostId);
    await join(a);
    expect(await act(a, { t: "START" })).toMatchObject({ code: "NOT_ENOUGH_PLAYERS" });
    const b = await player(roomId);
    await join(b);
    expect(await act(b, { t: "START" })).toMatchObject({ code: "NOT_HOST" });
    expect(await act(a, { t: "START" })).toMatchObject({ t: "ACK" });
    expect(await waitFor(b, "GAME_STARTING")).toMatchObject({ t: "GAME_STARTING" });
    const room = await state(roomId);
    expect(room.status).toBe("PLAYING");
    expect(room.pot).toBe(400);
    expect(room.gameId).toMatch(/^[0-9a-f-]{36}$/);
    a.close();
    b.close();
  });

  it("table pleine (6 joueurs) : lancement immédiat ; un 7e joueur reçoit ROOM_LOCKED", async () => {
    const roomId = await createRoom();
    const clients: Client[] = [];
    for (let i = 0; i < 6; i++) {
      const p = await player(roomId);
      await join(p);
      clients.push(p);
    }
    expect((await state(roomId)).status).toBe("PLAYING");
    const late = await player(roomId);
    expect(await act(late, { t: "JOIN" })).toMatchObject({ code: "ROOM_LOCKED" });
    for (const p of [...clients, late]) p.close();
  });

  it("pendant STARTING, les actions reçoivent ROOM_STARTING", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    let release: () => void = () => undefined;
    const pending = new Promise<{ failed: string[] }>((resolve) => {
      release = () => {
        resolve({ failed: [] });
      };
    });
    await withServices(roomId, { debitEntryFees: () => pending });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    await join(a);
    await join(b);
    expect(await act(a, { t: "START" })).toMatchObject({ t: "ACK" });
    const c = await player(roomId);
    expect(await act(c, { t: "JOIN" })).toMatchObject({ code: "ROOM_STARTING" });
    release();
    await waitFor(b, "GAME_STARTING");
    for (const p of [a, b, c]) p.close();
  });
});

describe("SRV-04 — débit des frais au lancement (spécification des jetons §6.3)", () => {
  it("un débit qui échoue : le joueur est retiré (KICKED_BALANCE) et la partie démarre à 2", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    const c = await player(roomId);
    for (const p of [a, b, c]) await join(p);
    await withServices(roomId, { debitEntryFees: () => Promise.resolve({ failed: [c.id] }) });
    await act(a, { t: "START" });
    expect(await waitFor(c, "ERROR")).toMatchObject({ code: "INSUFFICIENT_BALANCE" });
    expect(await waitFor(b, "PLAYER_LEFT")).toMatchObject({
      playerId: c.id,
      reason: "KICKED_BALANCE",
    });
    const room = await state(roomId);
    expect(room.status).toBe("PLAYING");
    expect(room.pot).toBe(400);
    for (const p of [a, b, c]) p.close();
  });

  it("s'il reste moins de 2 joueurs : remboursement et retour en attente", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    for (const p of [a, b]) await join(p);
    const refunded: string[][] = [];
    await withServices(roomId, {
      debitEntryFees: () => Promise.resolve({ failed: [b.id] }),
      refundEntryFees: (_gameId, ids) => {
        refunded.push(ids);
        return Promise.resolve();
      },
    });
    await act(a, { t: "START" });
    const view = (await waitFor(a, "STATE"))["view"] as Message;
    expect(view).toMatchObject({ roomStatus: "WAITING", players: [{ id: hostId }] });
    expect(refunded).toEqual([[hostId]]);
    expect((await state(roomId)).status).toBe("WAITING");
    a.close();
    b.close();
  });
});

describe("SRV-04 — salon public : compte à rebours (cahier §2.1.2)", () => {
  it("démarre à l'arrivée du 2e joueur, n'est pas remis à zéro, s'annule sous 2 joueurs", async () => {
    const roomId = await createRoom({ type: "PUBLIC" });
    const a = await player(roomId);
    await join(a);
    const before = Date.now();
    const b = await player(roomId);
    await join(b);
    const started = await waitFor(a, "COUNTDOWN_STARTED");
    const endsAt = started["endsAt"] as number;
    expect(endsAt).toBeGreaterThanOrEqual(before + 59_000);
    expect(endsAt).toBeLessThanOrEqual(Date.now() + 61_000);
    expect((await state(roomId)).status).toBe("COUNTDOWN");

    const c = await player(roomId);
    await join(c);
    expect((await state(roomId)).countdownEndsAt).toBe(endsAt);

    await act(c, { t: "LEAVE" });
    expect((await state(roomId)).status).toBe("COUNTDOWN");
    await act(b, { t: "LEAVE" });
    expect(await waitFor(a, "COUNTDOWN_CANCELLED")).toMatchObject({ endsAt });
    expect((await state(roomId)).status).toBe("WAITING");
    for (const p of [a, b, c]) p.close();
  });

  it("à la fin du compte à rebours : lancement", async () => {
    const roomId = await createRoom({ type: "PUBLIC" });
    const a = await player(roomId);
    const b = await player(roomId);
    await join(a);
    await join(b);
    await expire(roomId, "countdownEndsAt");
    expect(await waitFor(a, "GAME_STARTING")).toMatchObject({ t: "GAME_STARTING" });
    expect((await state(roomId)).status).toBe("PLAYING");
    a.close();
    b.close();
  });

  it("START n'existe pas dans un salon public (NOT_HOST)", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ type: "PUBLIC", hostId });
    const a = await player(roomId, hostId);
    await join(a);
    expect(await act(a, { t: "START" })).toMatchObject({ code: "NOT_HOST" });
    a.close();
  });
});

describe("SRV-04 — UPDATE_OPTIONS (cahier §2.2)", () => {
  it("l'hôte modifie options et frais ; tous reçoivent OPTIONS_UPDATED", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    await join(a);
    await join(b);
    const options = { ...DEFAULT_OPTIONS, two_transparent: false };
    expect(await act(a, { t: "UPDATE_OPTIONS", options, fee: 500 })).toMatchObject({ t: "ACK" });
    expect(await waitFor(b, "OPTIONS_UPDATED")).toMatchObject({ options, fee: 500 });
    expect((await state(roomId)).fee).toBe(500);
    a.close();
    b.close();
  });

  it("NOT_HOST, INVALID_FEE, INVALID_OPTIONS et INSUFFICIENT_BALANCE", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ hostId });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    await join(a);
    await join(b);
    expect(await act(b, { t: "UPDATE_OPTIONS", options: DEFAULT_OPTIONS, fee: 300 })).toMatchObject(
      {
        code: "NOT_HOST",
      },
    );
    expect(await act(a, { t: "UPDATE_OPTIONS", options: DEFAULT_OPTIONS, fee: 150 })).toMatchObject(
      {
        code: "INVALID_FEE",
      },
    );
    const { allow_multiples: _dropped, ...partial } = DEFAULT_OPTIONS;
    expect(await act(a, { t: "UPDATE_OPTIONS", options: partial, fee: 300 })).toMatchObject({
      code: "INVALID_OPTIONS",
    });
    await withServices(roomId, {
      checkCanJoin: () => Promise.resolve({ ok: false, code: "INSUFFICIENT_BALANCE" }),
    });
    expect(await act(a, { t: "UPDATE_OPTIONS", options: DEFAULT_OPTIONS, fee: 300 })).toMatchObject(
      {
        code: "INSUFFICIENT_BALANCE",
      },
    );
    expect((await state(roomId)).fee).toBe(200);
    a.close();
    b.close();
  });

  it("pendant le compte à rebours, les options sont verrouillées (ROOM_LOCKED)", async () => {
    const hostId = crypto.randomUUID();
    const roomId = await createRoom({ type: "PUBLIC", hostId });
    const a = await player(roomId, hostId);
    const b = await player(roomId);
    await join(a);
    await join(b);
    expect(await act(a, { t: "UPDATE_OPTIONS", options: DEFAULT_OPTIONS, fee: 300 })).toMatchObject(
      {
        code: "ROOM_LOCKED",
      },
    );
    a.close();
    b.close();
  });
});

describe("SRV-04 — durée de vie du salon (cahier §2.1.4)", () => {
  it("300 s après la création avec moins de 2 joueurs : salon détruit, connexions fermées en 4004", async () => {
    const roomId = await createRoom();
    const a = await player(roomId);
    await join(a);
    await expire(roomId, "createdAt");
    expect((await closedWithin(a)).code).toBe(4004);
    expect((await state(roomId)).status).toBe("CLOSED");
    const late = await connect(`/ws/room/${roomId}`);
    expect((await closedWithin(late)).code).toBe(4004);
  });

  it("avec 2 joueurs au bout de 300 s, le salon privé reste ouvert", async () => {
    const roomId = await createRoom();
    const a = await player(roomId);
    const b = await player(roomId);
    await join(a);
    await join(b);
    await expire(roomId, "createdAt");
    expect((await state(roomId)).status).toBe("WAITING");
    a.close();
    b.close();
  });
});
