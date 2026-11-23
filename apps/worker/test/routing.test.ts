import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { upgradeRequest } from "./helpers.js";

const BASE = "https://check.test";

function upgrade(path: string): Promise<Response> {
  return upgradeRequest(path);
}

/** Opens then closes the WebSocket returned by a 101 response. */
function closeSocket(response: Response): void {
  const socket = response.webSocket;
  if (socket === null) throw new Error("no WebSocket in the response");
  socket.accept();
  socket.close(1000, "test");
}

describe("SRV-02 — routage HTTP du Worker", () => {
  it("GET /api/health répond 200 { ok: true }", async () => {
    const response = await SELF.fetch(`${BASE}/api/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it("une mauvaise méthode répond 405 avec l'en-tête Allow", async () => {
    const response = await SELF.fetch(`${BASE}/api/health`, { method: "POST" });
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET");
  });

  it("une route inconnue répond 404", async () => {
    for (const path of ["/api/unknown", "/ws/room/not-a-room", "/ws/user/42", "/nothing"]) {
      const response = await SELF.fetch(`${BASE}${path}`);
      expect({ path, status: response.status }).toEqual({ path, status: 404 });
      await response.body?.cancel();
    }
  });

  it("les routes de l'API pas encore écrites répondent 501", async () => {
    const calls: [string, string][] = [
      ["POST", "/api/rooms"],
      ["GET", "/api/rooms/by-code/AB12CD"],
      ["POST", "/api/guest/logout"],
      ["DELETE", "/api/account"],
      ["POST", "/api/client-errors"],
    ];
    for (const [method, path] of calls) {
      const response = await SELF.fetch(`${BASE}${path}`, { method });
      expect({ path, status: response.status }).toEqual({ path, status: 501 });
      await response.body?.cancel();
    }
  });
});

describe("SRV-02 — routage des WebSockets vers les Durable Objects", () => {
  it("sans en-tête Upgrade: websocket, une route /ws répond 426", async () => {
    const response = await SELF.fetch(`${BASE}/ws/lobby`);
    expect(response.status).toBe(426);
    await response.body?.cancel();
  });

  it("/ws/lobby ouvre un WebSocket (LobbyDO)", async () => {
    const response = await upgrade("/ws/lobby");
    expect(response.status).toBe(101);
    closeSocket(response);
  });

  it("/ws/room/{roomId} ouvre un WebSocket (RoomDO)", async () => {
    const roomId = env.ROOM.newUniqueId().toString();
    const response = await upgrade(`/ws/room/${roomId}`);
    expect(response.status).toBe(101);
    closeSocket(response);
  });

  it("/ws/user/{userId} ouvre un WebSocket (UserDO)", async () => {
    // A fresh user id: the UserDO of another test file may be invalidated between files.
    const response = await upgrade(`/ws/user/${crypto.randomUUID()}`);
    expect(response.status).toBe(101);
    closeSocket(response);
  });

  it("un identifiant de salon qui n'a pas été émis par ce Worker répond 404", async () => {
    const response = await upgrade(`/ws/room/${"0".repeat(64)}`);
    expect(response.status).toBe(404);
    await response.body?.cancel();
  });
});
