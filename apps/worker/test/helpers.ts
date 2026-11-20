// Test helpers: Supabase-like access tokens and WebSocket clients.

import { SELF, env } from "cloudflare:test";

export const BASE = "https://check.test";
export const USER_ID = "3f1c2a4e-8b7d-4c6e-9f10-112233445566";
export const OTHER_USER_ID = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
export const ISSUER = "https://test.supabase.co/auth/v1";

function base64url(bytes: Uint8Array | string): string {
  const raw = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let binary = "";
  for (const b of raw) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type SignOptions = {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  /** Private JWK to sign with (default: the test key trusted by the Worker). */
  jwk?: JsonWebKey;
  algorithm?: "ES256" | "RS256";
};

/** Signs a JWT shaped like a Supabase access token. */
export async function signToken(options: SignOptions = {}): Promise<string> {
  const algorithm = options.algorithm ?? "ES256";
  const jwk = options.jwk ?? (JSON.parse(env.TEST_SIGNING_JWK) as JsonWebKey);
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: algorithm, kid: "test-key", typ: "JWT", ...options.header };
  const claims = {
    sub: USER_ID,
    aud: "authenticated",
    iss: ISSUER,
    role: "authenticated",
    iat: now,
    exp: now + 3600,
    ...options.claims,
  };
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const params =
    algorithm === "ES256"
      ? { import: { name: "ECDSA", namedCurve: "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } }
      : {
          import: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          sign: { name: "RSASSA-PKCS1-v1_5" },
        };
  const key = await crypto.subtle.importKey("jwk", jwk, params.import, false, ["sign"]);
  const signature = await crypto.subtle.sign(params.sign, key, new TextEncoder().encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

export type Client = {
  send: (message: unknown) => void;
  sendRaw: (raw: string) => void;
  /** Next message received (rejects after 2 s). */
  next: () => Promise<Record<string, unknown>>;
  /** Resolves when the server closes the socket. */
  closed: Promise<{ code: number; reason: string }>;
  close: () => void;
  /** Waits `ms`, then returns (and removes) every message received and not read yet. */
  received: (ms?: number) => Promise<Record<string, unknown>[]>;
};

/** Opens a WebSocket on `path` through the Worker. */
export async function connect(path: string): Promise<Client> {
  const response = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket" } });
  const ws = response.webSocket;
  if (ws === null) throw new Error(`no WebSocket for ${path} (HTTP ${response.status})`);
  ws.accept();
  const inbox: Record<string, unknown>[] = [];
  const waiting: ((m: Record<string, unknown>) => void)[] = [];
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(event.data as string) as Record<string, unknown>;
    const waiter = waiting.shift();
    if (waiter) waiter(message);
    else inbox.push(message);
  });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.addEventListener("close", (event) => {
      resolve({ code: event.code, reason: event.reason });
    });
  });
  return {
    send: (message) => {
      ws.send(JSON.stringify(message));
    },
    sendRaw: (raw) => {
      ws.send(raw);
    },
    next: () => {
      const queued = inbox.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error("no message within 2 s"));
        }, 2000);
        waiting.push((m) => {
          clearTimeout(timer);
          resolve(m);
        });
      });
    },
    closed,
    close: () => {
      ws.close(1000, "test");
    },
    received: async (ms = 150) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return inbox.splice(0, inbox.length);
    },
  };
}

/** Waits for the server to close the socket (rejects after 3 s). */
export function closedWithin(client: Client, ms = 3000): Promise<{ code: number; reason: string }> {
  return Promise.race([
    client.closed,
    new Promise<never>((_, reject) =>
      setTimeout(() => {
        reject(new Error(`socket still open after ${ms} ms`));
      }, ms),
    ),
  ]);
}

/** Opens a socket and authenticates it. */
export async function authenticated(path: string, token?: string): Promise<Client> {
  const client = await connect(path);
  client.send({ t: "AUTH", token: token ?? (await signToken()), v: 1 });
  const reply = await client.next();
  if (reply["t"] !== "AUTH_OK") throw new Error(`expected AUTH_OK, got ${JSON.stringify(reply)}`);
  return client;
}

export const DEFAULT_OPTIONS = {
  two_transparent: true,
  jack_commands: true,
  jack_wild: true,
  ace_skips: true,
  seven_draw_two: true,
  joker_draw_four: true,
  joker_wild: true,
  allow_multiples: true,
};

/** Creates and initializes a room (what `POST /api/rooms` will do); returns its id. */
export async function createRoom(
  init: Partial<{ type: "PRIVATE" | "PUBLIC"; fee: number; hostId: string; code: string }> = {},
): Promise<string> {
  const id = env.ROOM.newUniqueId();
  const type = init.type ?? "PRIVATE";
  await env.ROOM.get(id).init({
    type,
    fee: init.fee ?? 200,
    options: DEFAULT_OPTIONS,
    hostId: init.hostId ?? USER_ID,
    ...(type === "PRIVATE" ? { code: init.code ?? "ABC123" } : {}),
  });
  return id.toString();
}
