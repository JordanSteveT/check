// Bindings of the Worker (wrangler.jsonc) and server configuration read from them.

import type { LobbyDO } from "./lobby.js";
import type { LogLevel } from "./log.js";
import type { UserDO } from "./user.js";
import type { RoomDO } from "./room.js";

export type Env = {
  ROOM: DurableObjectNamespace<RoomDO>;
  USER: DurableObjectNamespace<UserDO>;
  LOBBY: DurableObjectNamespace<LobbyDO>;
  /** Supabase project URL, e.g. `https://xyz.supabase.co` (required). */
  SUPABASE_URL: string;
  /** Inline JWKS (JSON) replacing the fetch of the Supabase JWKS: tests and local use only. */
  SUPABASE_JWKS?: string;
  /** AUTH deadline in ms (default 5000, protocole §2.1); shortened in tests. */
  AUTH_TIMEOUT_MS?: string;
  /** Minimum log level: debug, info (default), warn or error. */
  LOG_LEVEL?: string;
};

export type ServerConfig = {
  supabaseUrl: string;
  authTimeoutMs: number;
  logLevel: LogLevel;
};

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

/** Default AUTH deadline (protocole §2.1). */
export const AUTH_TIMEOUT_MS = 5000;

/** Reads and checks the configuration; throws if a required key is missing (CLAUDE.md). */
export function loadServerConfig(env: Env): ServerConfig {
  if (typeof env.SUPABASE_URL !== "string" || env.SUPABASE_URL === "") {
    throw new Error("Missing configuration: SUPABASE_URL");
  }
  const timeout = env.AUTH_TIMEOUT_MS === undefined ? AUTH_TIMEOUT_MS : Number(env.AUTH_TIMEOUT_MS);
  if (!Number.isInteger(timeout) || timeout <= 0) {
    throw new Error("Invalid configuration: AUTH_TIMEOUT_MS");
  }
  const logLevel = (env.LOG_LEVEL ?? "info") as LogLevel;
  if (!LOG_LEVELS.includes(logLevel)) throw new Error("Invalid configuration: LOG_LEVEL");
  return { supabaseUrl: env.SUPABASE_URL, authTimeoutMs: timeout, logLevel };
}
