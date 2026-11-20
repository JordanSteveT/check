// Worker entry point: routes `/api/*` to the HTTP handlers and `/ws/*` to the Durable Objects.

import { USER_ID_HEADER } from "./durable_objects.js";
import type { Env } from "./env.js";
import { matchRoute, type ApiRouteName, type Route } from "./router.js";

export { LobbyDO, RoomDO, UserDO } from "./durable_objects.js";

/** Name of the single LobbyDO instance (not exported: workerd only accepts handlers and classes as exports). */
const LOBBY_NAME = "lobby";

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

function handleApi(name: ApiRouteName): Response {
  if (name === "health") return json({ ok: true });
  // Written with the account and token tickets (ECO-03 to ECO-06) and SET-07.
  return text("Not implemented", 501);
}

/** Durable Object stub for a WebSocket route, or `null` if the room id is not one of ours. */
function stubFor(route: Extract<Route, { type: "ws" }>, env: Env): DurableObjectStub | null {
  switch (route.target) {
    case "room": {
      let id: DurableObjectId;
      try {
        id = env.ROOM.idFromString(route.roomId);
      } catch {
        return null;
      }
      return env.ROOM.get(id);
    }
    case "user":
      return env.USER.get(env.USER.idFromName(route.userId));
    case "lobby":
      return env.LOBBY.get(env.LOBBY.idFromName(LOBBY_NAME));
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const route = matchRoute(request.method, url.pathname);
    switch (route.type) {
      case "notFound":
        return text("Not found", 404);
      case "methodNotAllowed":
        return text("Method not allowed", 405, { Allow: route.allow.join(", ") });
      case "api":
        return handleApi(route.name);
      case "ws": {
        if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return text("Expected a WebSocket upgrade", 426, { Upgrade: "websocket" });
        }
        const stub = stubFor(route, env);
        if (stub === null) return text("Not found", 404);
        // The expected user id comes from the URL only, never from a client header.
        const forwarded = new Request(request);
        forwarded.headers.delete(USER_ID_HEADER);
        if (route.target === "user") forwarded.headers.set(USER_ID_HEADER, route.userId);
        return stub.fetch(forwarded);
      }
    }
  },
} satisfies ExportedHandler<Env>;
