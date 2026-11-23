import { describe, expect, it } from "vitest";
import { matchRoute } from "../src/router.js";

const ROOM_ID = "a".repeat(64);
const USER_ID = "3f1c2a4e-8b7d-4c6e-9f10-112233445566";

describe("SRV-02 — matchRoute (routes HTTP, protocole §6.5)", () => {
  it("reconnaît chaque route de l'API avec sa méthode", () => {
    expect(matchRoute("GET", "/api/health")).toEqual({ type: "api", name: "health", params: {} });
    expect(matchRoute("POST", "/api/rooms")).toEqual({
      type: "api",
      name: "createRoom",
      params: {},
    });
    expect(matchRoute("GET", "/api/rooms/by-code/AB12CD")).toEqual({
      type: "api",
      name: "roomByCode",
      params: { code: "AB12CD" },
    });
    expect(matchRoute("POST", "/api/guest/logout")).toEqual({
      type: "api",
      name: "guestLogout",
      params: {},
    });
    expect(matchRoute("DELETE", "/api/account")).toEqual({
      type: "api",
      name: "deleteAccount",
      params: {},
    });
    expect(matchRoute("POST", "/api/client-errors")).toEqual({
      type: "api",
      name: "clientErrors",
      params: {},
    });
  });

  it("une mauvaise méthode donne methodNotAllowed avec les méthodes permises", () => {
    expect(matchRoute("POST", "/api/health")).toEqual({ type: "methodNotAllowed", allow: ["GET"] });
    expect(matchRoute("GET", "/api/account")).toEqual({
      type: "methodNotAllowed",
      allow: ["DELETE"],
    });
    expect(matchRoute("POST", "/ws/lobby")).toEqual({ type: "methodNotAllowed", allow: ["GET"] });
  });

  it("une route inconnue ou un paramètre mal formé donne notFound", () => {
    for (const path of [
      "/api",
      "/api/unknown",
      "/api/health/",
      "/api/rooms/by-code/abc",
      "/api/rooms/by-code/ABCDEFG",
      "/ws/room/not-a-room",
      `/ws/room/${"A".repeat(64)}`,
      "/ws/user",
      "/ws/user/42",
      "/ws/lobby/x",
      "/",
    ]) {
      expect({ path, route: matchRoute("GET", path) }).toEqual({
        path,
        route: { type: "notFound" },
      });
    }
  });
});

describe("SRV-02 — matchRoute (connexions WebSocket, protocole §2)", () => {
  it("/ws/room/{roomId} vise le RoomDO du salon", () => {
    expect(matchRoute("GET", `/ws/room/${ROOM_ID}`)).toEqual({
      type: "ws",
      target: "room",
      roomId: ROOM_ID,
    });
  });

  it("/ws/user/{userId} vise le UserDO du joueur", () => {
    expect(matchRoute("GET", `/ws/user/${USER_ID}`)).toEqual({
      type: "ws",
      target: "user",
      userId: USER_ID,
    });
  });

  it("/ws/lobby vise le LobbyDO unique", () => {
    expect(matchRoute("GET", "/ws/lobby")).toEqual({ type: "ws", target: "lobby" });
  });
});
