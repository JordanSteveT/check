import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { RoomDO, RoomState } from "../src/room.js";
import { LOCAL_ROOM_SERVICES, type RoomServices } from "../src/room_services.js";
import { authenticated, createRoom, signToken, type Client } from "./helpers.js";

type Message = Record<string, unknown>;

function room(roomId: string) {
  return env.ROOM.get(env.ROOM.idFromString(roomId));
}

function user(userId: string) {
  return env.USER.get(env.USER.idFromName(userId));
}

async function state(roomId: string): Promise<RoomState> {
  const r = await room(roomId).getState();
  if (r === null) throw new Error("room not initialized");
  return r;
}

/** Waits (up to 2 s) until `check` resolves to true: releases happen just after the messages. */
async function eventually(check: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < 40; i++) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

const isFree = (userId: string) => async () => (await user(userId).getCurrentRoom(userId)) === null;

/** Room connection of `userId`, with a helper sending an action and returning its reply. */
async function seat(roomId: string, userId: string) {
  const client = await authenticated(
    `/ws/room/${roomId}`,
    await signToken({ claims: { sub: userId } }),
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

async function withServices(roomId: string, services: Partial<RoomServices>): Promise<void> {
  await runInDurableObject(room(roomId), (instance: RoomDO) => {
    instance.services = { ...LOCAL_ROOM_SERVICES, ...services };
  });
}

describe("SRV-09 — un joueur ne peut pas être dans deux salons", () => {
  it("JOIN dans un 2e salon : ALREADY_IN_ROOM ; après LEAVE du 1er, l'entrée est acceptée", async () => {
    const me = crypto.randomUUID();
    const room1 = await createRoom();
    const room2 = await createRoom();
    const s1 = await seat(room1, me);
    const s2 = await seat(room2, me);
    expect(await s1.act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
    expect(await user(me).getCurrentRoom(me)).toBe(room1);
    expect(await s2.act({ t: "JOIN" })).toMatchObject({ t: "ERROR", code: "ALREADY_IN_ROOM" });
    expect((await state(room2)).players).toEqual([]);

    expect(await s1.act({ t: "LEAVE" })).toMatchObject({ t: "ACK" });
    expect(await eventually(isFree(me))).toBe(true);
    expect(await s2.act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
    expect(await user(me).getCurrentRoom(me)).toBe(room2);
    s1.client.close();
    s2.client.close();
  });

  it("deux JOIN simultanés dans deux salons : un seul réussit", async () => {
    const me = crypto.randomUUID();
    const room1 = await createRoom();
    const room2 = await createRoom();
    const s1 = await seat(room1, me);
    const s2 = await seat(room2, me);
    const replies = await Promise.all([s1.act({ t: "JOIN" }), s2.act({ t: "JOIN" })]);
    expect(replies.map((r) => r["t"]).sort()).toEqual(["ACK", "ERROR"]);
    expect(replies.find((r) => r["t"] === "ERROR")).toMatchObject({ code: "ALREADY_IN_ROOM" });
    const seated = [...(await state(room1)).players, ...(await state(room2)).players].filter(
      (p) => p.id === me,
    );
    expect(seated).toHaveLength(1);
    s1.client.close();
    s2.client.close();
  });

  it("un refus de check_can_join libère le joueur", async () => {
    const me = crypto.randomUUID();
    const room1 = await createRoom();
    await withServices(room1, {
      checkCanJoin: () => Promise.resolve({ ok: false, code: "GUEST_NOT_ALLOWED" }),
    });
    const s1 = await seat(room1, me);
    expect(await s1.act({ t: "JOIN" })).toMatchObject({ code: "GUEST_NOT_ALLOWED" });
    expect(await eventually(isFree(me))).toBe(true);
    s1.client.close();
  });

  it("une réservation laissée par un salon qui ne tient plus le joueur ne bloque pas", async () => {
    const me = crypto.randomUUID();
    const stale = await createRoom();
    const room2 = await createRoom();
    // Reservation for a room where the player is not seated (missed release).
    expect(await user(me).claimRoom(me, stale)).toBe(true);
    const s2 = await seat(room2, me);
    expect(await s2.act({ t: "JOIN" })).toMatchObject({ t: "ACK" });
    expect(await user(me).getCurrentRoom(me)).toBe(room2);
    s2.client.close();
  });
});

describe("SRV-09 — libération du joueur", () => {
  it("abandon et fin de partie : les deux joueurs sont libérés", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const roomId = await createRoom({ hostId: a });
    const sa = await seat(roomId, a);
    const sb = await seat(roomId, b);
    await sa.act({ t: "JOIN" });
    await sb.act({ t: "JOIN" });
    expect(await sa.act({ t: "START" })).toMatchObject({ t: "ACK" });
    expect(await user(a).getCurrentRoom(a)).toBe(roomId);
    expect(await sa.act({ t: "LEAVE" })).toMatchObject({ t: "ACK" });
    expect(await eventually(isFree(a))).toBe(true);
    expect(await eventually(isFree(b))).toBe(true);
    expect((await state(roomId)).status).toBe("FINISHED");
    sa.client.close();
    sb.client.close();
  });

  it("joueur retiré au lancement (débit refusé) : libéré", async () => {
    const host = crypto.randomUUID();
    const kicked = crypto.randomUUID();
    const roomId = await createRoom({ hostId: host });
    const seats = [];
    for (const id of [host, crypto.randomUUID(), kicked]) {
      const s = await seat(roomId, id);
      await s.act({ t: "JOIN" });
      seats.push(s);
    }
    await withServices(roomId, { debitEntryFees: () => Promise.resolve({ failed: [kicked] }) });
    await seats[0]?.act({ t: "START" });
    expect(await eventually(isFree(kicked))).toBe(true);
    expect(await user(host).getCurrentRoom(host)).toBe(roomId);
    for (const s of seats) s.client.close();
  });

  it("salon détruit au bout de sa durée de vie : libéré", async () => {
    const me = crypto.randomUUID();
    const roomId = await createRoom();
    const s = await seat(roomId, me);
    await s.act({ t: "JOIN" });
    const createdAt = (await state(roomId)).createdAt;
    await runInDurableObject(room(roomId), (instance: RoomDO) => {
      instance.clock = () => createdAt + 300_000;
    });
    await runDurableObjectAlarm(room(roomId));
    expect(await eventually(isFree(me))).toBe(true);
  });
});

describe("SRV-09 — connexion joueur /ws/user (protocole §6.3)", () => {
  it("CURRENT_ROOM à la connexion, puis à chaque changement de salon", async () => {
    const me = crypto.randomUUID();
    const presence: Client = await authenticated(
      `/ws/user/${me}`,
      await signToken({ claims: { sub: me } }),
    );
    expect(await presence.next()).toEqual({ t: "CURRENT_ROOM", roomId: null });

    const roomId = await createRoom();
    const s = await seat(roomId, me);
    await s.act({ t: "JOIN" });
    expect(await presence.next()).toEqual({ t: "CURRENT_ROOM", roomId });
    await s.act({ t: "LEAVE" });
    expect(await presence.next()).toEqual({ t: "CURRENT_ROOM", roomId: null });

    // After a reload (new connection), the current room is given again.
    await s.act({ t: "JOIN" });
    await presence.next();
    presence.close();
    const again = await authenticated(`/ws/user/${me}`, await signToken({ claims: { sub: me } }));
    expect(await again.next()).toEqual({ t: "CURRENT_ROOM", roomId });
    again.close();
    s.client.close();
  });
});
