import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  OTHER_USER_ID,
  USER_ID,
  authenticated,
  closedWithin,
  connect,
  createRoom,
  signToken,
} from "./helpers.js";

const roomPath = async () => `/ws/room/${await createRoom()}`;
const ACTION_ID = "3f1c2a4e-8b7d-4c6e-9f10-112233445566";

describe("SRV-03 — connexion et AUTH (protocole §2.1)", () => {
  it("AUTH valide : AUTH_OK avec l'identifiant du joueur et l'heure du serveur", async () => {
    const client = await connect(await roomPath());
    const before = Date.now();
    client.send({ t: "AUTH", token: await signToken(), v: 1 });
    const reply = await client.next();
    expect(reply).toEqual({
      t: "AUTH_OK",
      userId: USER_ID,
      serverTime: expect.any(Number) as number,
    });
    expect(reply["serverTime"] as number).toBeGreaterThanOrEqual(before - 1000);
    client.close();
  });

  it("sans AUTH dans le délai : fermeture 4001", async () => {
    const client = await connect(await roomPath());
    expect((await closedWithin(client)).code).toBe(4001);
  });

  it("un jeton invalide : fermeture 4001", async () => {
    const client = await connect(await roomPath());
    client.send({ t: "AUTH", token: await signToken({ claims: { exp: 1 } }), v: 1 });
    expect((await closedWithin(client)).code).toBe(4001);
  });

  it("un premier message autre que AUTH : fermeture 4001", async () => {
    for (const first of [JSON.stringify({ t: "PING", c: 1 }), "pas du json"]) {
      const client = await connect(await roomPath());
      client.sendRaw(first);
      expect((await closedWithin(client)).code).toBe(4001);
    }
  });

  it("une version de protocole non supportée : fermeture 4002", async () => {
    const client = await connect(await roomPath());
    client.send({ t: "AUTH", token: await signToken(), v: 2 });
    expect((await closedWithin(client)).code).toBe(4002);
  });

  it("un message de plus de 4 Ko : fermeture 4008", async () => {
    const client = await authenticated(await roomPath());
    client.send({ t: "PING", c: 1, pad: "x".repeat(5000) });
    expect((await closedWithin(client)).code).toBe(4008);
  });

  it("après AUTH : PING reçoit PONG, un message invalide reçoit ERROR", async () => {
    const client = await authenticated(await roomPath());
    client.send({ t: "PING", c: 1234 });
    expect(await client.next()).toEqual({ t: "PONG", c: 1234, s: expect.any(Number) as number });
    client.send({ t: "PLAY", id: ACTION_ID, cards: ["1Z"] });
    expect(await client.next()).toMatchObject({
      t: "ERROR",
      id: ACTION_ID,
      code: "INVALID_MESSAGE",
    });
    client.close();
  });

  it("un nouvel AUTH du même joueur (jeton rafraîchi) est accepté sans fermer", async () => {
    const client = await authenticated(await roomPath());
    client.send({ t: "AUTH", token: await signToken(), v: 1 });
    expect(await client.next()).toMatchObject({ t: "AUTH_OK", userId: USER_ID });
    client.close();
  });

  it("un nouvel AUTH d'un autre joueur sur la même connexion : fermeture 4001", async () => {
    const client = await authenticated(await roomPath());
    client.send({ t: "AUTH", token: await signToken({ claims: { sub: OTHER_USER_ID } }), v: 1 });
    expect((await closedWithin(client)).code).toBe(4001);
  });

  it("la connexion authentifiée est enregistrée dans la pièce jointe du WebSocket (hibernation)", async () => {
    const roomId = await createRoom();
    const client = await authenticated(`/ws/room/${roomId}`);
    const attachments = await runInDurableObject(
      env.ROOM.get(env.ROOM.idFromString(roomId)),
      (_instance, state) =>
        state.getWebSockets().map((ws) => ws.deserializeAttachment() as unknown),
    );
    expect(attachments).toEqual([
      { phase: "authed", userId: USER_ID, connectedAt: expect.any(Number) as number },
    ]);
    client.close();
  });
});

describe("SRV-03 — AUTH sur les connexions joueur et liste", () => {
  it("/ws/user/{userId} : le jeton doit appartenir à ce joueur", async () => {
    // Fresh ids: a UserDO used by another test file may be invalidated between files.
    const me = crypto.randomUUID();
    const own = await connect(`/ws/user/${me}`);
    own.send({ t: "AUTH", token: await signToken({ claims: { sub: me } }), v: 1 });
    expect(await own.next()).toMatchObject({ t: "AUTH_OK", userId: me });
    own.close();

    const other = await connect(`/ws/user/${crypto.randomUUID()}`);
    other.send({ t: "AUTH", token: await signToken({ claims: { sub: me } }), v: 1 });
    expect((await closedWithin(other)).code).toBe(4001);
  });

  it("/ws/lobby : AUTH puis PING", async () => {
    const client = await authenticated("/ws/lobby");
    client.send({ t: "PING", c: 5 });
    expect(await client.next()).toMatchObject({ t: "PONG", c: 5 });
    client.close();
  });
});
