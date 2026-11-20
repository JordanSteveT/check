// Verification of Supabase access tokens (architecture §6, protocole §2.1).
// Supabase signs tokens with asymmetric keys published as a JWKS; we verify with Web Crypto
// only (no dependency). Symmetric (HS256) tokens are refused.

/** Returns the public key for a key id, or `undefined` if unknown. */
export type KeyProvider = (kid: string) => Promise<JsonWebKey | undefined>;

export type VerifyResult =
  { ok: true; userId: string; expiresAt: number } | { ok: false; reason: string };

type Fetcher = (url: string) => Promise<Response>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** How long a fetched JWKS is reused before being fetched again (ms). */
const JWKS_TTL_MS = 10 * 60 * 1000;

const ALGORITHMS = {
  ES256: {
    importParams: { name: "ECDSA", namedCurve: "P-256" },
    verifyParams: { name: "ECDSA", hash: "SHA-256" },
  },
  RS256: {
    importParams: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyParams: { name: "RSASSA-PKCS1-v1_5" },
  },
} as const;

type Algorithm = keyof typeof ALGORITHMS;

function isAlgorithm(value: unknown): value is Algorithm {
  return value === "ES256" || value === "RS256";
}

function decodeBase64url(part: string): Uint8Array {
  const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function decodeJson(part: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64url(part)));
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function parseJwks(text: string): Map<string, JsonWebKey> {
  const keys = new Map<string, JsonWebKey>();
  const data = JSON.parse(text) as { keys?: (JsonWebKey & { kid?: string })[] };
  for (const key of data.keys ?? []) {
    if (typeof key.kid === "string") keys.set(key.kid, key);
  }
  return keys;
}

/**
 * Key provider for the Worker. `SUPABASE_JWKS` (inline JSON) is used when set — tests and
 * local development; otherwise the JWKS is fetched from
 * `{SUPABASE_URL}/auth/v1/.well-known/jwks.json` and cached, then fetched again for an
 * unknown key id (key rotation).
 */
export function createJwksProvider(
  env: { SUPABASE_URL: string; SUPABASE_JWKS?: string | undefined },
  fetcher: Fetcher = (url) => fetch(url),
): KeyProvider {
  if (env.SUPABASE_JWKS !== undefined && env.SUPABASE_JWKS !== "") {
    const inline = parseJwks(env.SUPABASE_JWKS);
    return (kid) => Promise.resolve(inline.get(kid));
  }
  const url = `${env.SUPABASE_URL.replace(/\/$/, "")}/auth/v1/.well-known/jwks.json`;
  let cache: { keys: Map<string, JsonWebKey>; fetchedAt: number } | null = null;

  async function load(): Promise<Map<string, JsonWebKey>> {
    const response = await fetcher(url);
    if (!response.ok) throw new Error(`JWKS fetch failed: HTTP ${response.status}`);
    const keys = parseJwks(await response.text());
    cache = { keys, fetchedAt: Date.now() };
    return keys;
  }

  return async (kid) => {
    const fresh = cache !== null && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
    const known = fresh ? cache?.keys.get(kid) : undefined;
    if (known !== undefined) return known;
    return (await load()).get(kid);
  };
}

/**
 * Verifies a Supabase access token: signature (ES256 or RS256, key from the JWKS), expiry,
 * `nbf`, issuer (`{SUPABASE_URL}/auth/v1`), audience `authenticated` and a UUID `sub`.
 * `now` is in seconds. Never throws.
 */
export async function verifyAccessToken(
  token: string,
  keys: KeyProvider,
  issuer: string,
  now: number,
): Promise<VerifyResult> {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return { ok: false, reason: "malformed" };
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = decodeJson(headerPart);
    const claims = decodeJson(payloadPart);
    if (header === null || claims === null) return { ok: false, reason: "malformed" };

    const alg = header["alg"];
    const kid = header["kid"];
    if (!isAlgorithm(alg)) return { ok: false, reason: "algorithm" };
    if (typeof kid !== "string") return { ok: false, reason: "kid" };
    const jwk = await keys(kid);
    if (jwk === undefined) return { ok: false, reason: "unknown key" };

    const { importParams, verifyParams } = ALGORITHMS[alg];
    const key = await crypto.subtle.importKey("jwk", jwk, importParams, false, ["verify"]);
    const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
    const valid = await crypto.subtle.verify(
      verifyParams,
      key,
      decodeBase64url(signaturePart),
      signed,
    );
    if (!valid) return { ok: false, reason: "signature" };

    const { exp, nbf, iss, aud, sub } = claims;
    if (typeof exp !== "number" || exp <= now) return { ok: false, reason: "expired" };
    if (typeof nbf === "number" && nbf > now) return { ok: false, reason: "not yet valid" };
    if (iss !== issuer) return { ok: false, reason: "issuer" };
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes("authenticated")) return { ok: false, reason: "audience" };
    if (typeof sub !== "string" || !UUID.test(sub)) return { ok: false, reason: "subject" };
    return { ok: true, userId: sub, expiresAt: exp };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "error" };
  }
}

/** Issuer of the project's tokens. */
export function issuerFor(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/$/, "")}/auth/v1`;
}
