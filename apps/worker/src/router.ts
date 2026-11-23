// URL routing of the Worker (protocole_temps_reel.md §2 and §6.5). Pure function: no I/O.

export type ApiRouteName =
  "health" | "createRoom" | "roomByCode" | "guestLogout" | "deleteAccount" | "clientErrors";

export type Route =
  | { type: "api"; name: ApiRouteName; params: Record<string, string> }
  | { type: "ws"; target: "room"; roomId: string }
  | { type: "ws"; target: "user"; userId: string }
  | { type: "ws"; target: "lobby" }
  | { type: "methodNotAllowed"; allow: string[] }
  | { type: "notFound" };

type Method = "GET" | "POST" | "DELETE";

type Definition = {
  pattern: RegExp;
  method: Method;
  build: (groups: Record<string, string>) => Route;
};

/** Durable Object id produced by `newUniqueId()` (64 lowercase hex characters). */
const ROOM_ID = "(?<roomId>[0-9a-f]{64})";
/** Supabase user id (UUID). */
const USER_ID = "(?<userId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})";
/** Private room code: 6 upper-case letters or digits (spécification des écrans E8). */
const ROOM_CODE = "(?<code>[A-Z0-9]{6})";

const api =
  (name: ApiRouteName, ...keys: string[]) =>
  (groups: Record<string, string>): Route => ({
    type: "api",
    name,
    params: Object.fromEntries(keys.map((k) => [k, groups[k] ?? ""])),
  });

const ROUTES: Definition[] = [
  { pattern: /^\/api\/health$/, method: "GET", build: api("health") },
  { pattern: /^\/api\/rooms$/, method: "POST", build: api("createRoom") },
  {
    pattern: new RegExp(`^/api/rooms/by-code/${ROOM_CODE}$`),
    method: "GET",
    build: api("roomByCode", "code"),
  },
  { pattern: /^\/api\/guest\/logout$/, method: "POST", build: api("guestLogout") },
  { pattern: /^\/api\/account$/, method: "DELETE", build: api("deleteAccount") },
  { pattern: /^\/api\/client-errors$/, method: "POST", build: api("clientErrors") },
  {
    pattern: new RegExp(`^/ws/room/${ROOM_ID}$`),
    method: "GET",
    build: (g) => ({ type: "ws", target: "room", roomId: g["roomId"] ?? "" }),
  },
  {
    pattern: new RegExp(`^/ws/user/${USER_ID}$`),
    method: "GET",
    build: (g) => ({ type: "ws", target: "user", userId: g["userId"] ?? "" }),
  },
  { pattern: /^\/ws\/lobby$/, method: "GET", build: () => ({ type: "ws", target: "lobby" }) },
];

export function matchRoute(method: string, pathname: string): Route {
  const allow: string[] = [];
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (match === null) continue;
    if (route.method === method) return route.build(match.groups ?? {});
    allow.push(route.method);
  }
  return allow.length > 0 ? { type: "methodNotAllowed", allow } : { type: "notFound" };
}
