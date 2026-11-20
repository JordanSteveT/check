import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { createJwksProvider, verifyAccessToken, type KeyProvider } from "../src/auth.js";
import { ISSUER, USER_ID, signToken } from "./helpers.js";

const NOW = () => Math.floor(Date.now() / 1000);
const keys: KeyProvider = createJwksProvider({
  SUPABASE_URL: env.SUPABASE_URL,
  SUPABASE_JWKS: env.SUPABASE_JWKS,
});

async function otherKey(algorithm: "ES256" | "RS256") {
  const params =
    algorithm === "ES256"
      ? { name: "ECDSA", namedCurve: "P-256" }
      : {
          name: "RSASSA-PKCS1-v1_5",
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: "SHA-256",
        };
  const pair = (await crypto.subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    publicJwk: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey,
    privateJwk: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey,
  };
}

describe("SRV-03 — vérification du jeton d'accès Supabase (JWKS)", () => {
  it("accepte un jeton ES256 valide et renvoie l'identifiant du joueur", async () => {
    const result = await verifyAccessToken(await signToken(), keys, ISSUER, NOW());
    expect(result).toEqual({ ok: true, userId: USER_ID, expiresAt: expect.any(Number) as number });
  });

  it("refuse un jeton expiré, d'un autre émetteur, d'une autre audience ou sans joueur valide", async () => {
    const cases: Record<string, unknown>[] = [
      { exp: NOW() - 1 },
      { iss: "https://evil.example/auth/v1" },
      { aud: "anon" },
      { nbf: NOW() + 600 },
      { sub: "not-a-uuid" },
      { sub: undefined },
    ];
    for (const claims of cases) {
      const result = await verifyAccessToken(await signToken({ claims }), keys, ISSUER, NOW());
      expect({ claims, ok: result.ok }).toEqual({ claims, ok: false });
    }
  });

  it("refuse une signature faite avec une autre clé, ou une clé inconnue", async () => {
    const { privateJwk } = await otherKey("ES256");
    const forged = await signToken({ jwk: privateJwk });
    expect((await verifyAccessToken(forged, keys, ISSUER, NOW())).ok).toBe(false);
    const unknownKid = await signToken({ header: { kid: "other" } });
    expect((await verifyAccessToken(unknownKid, keys, ISSUER, NOW())).ok).toBe(false);
  });

  it("refuse les algorithmes non asymétriques et les jetons mal formés", async () => {
    const none = await signToken({ header: { alg: "none" } });
    const hs256 = await signToken({ header: { alg: "HS256" } });
    const tampered = `${(await signToken()).slice(0, -4)}AAAA`;
    for (const token of [none, hs256, "abc", "a.b.c", "", tampered]) {
      expect((await verifyAccessToken(token, keys, ISSUER, NOW())).ok).toBe(false);
    }
  });

  it("accepte un jeton RS256 si sa clé est publiée dans le JWKS", async () => {
    const { publicJwk, privateJwk } = await otherKey("RS256");
    const rsaKeys = createJwksProvider({
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_JWKS: JSON.stringify({ keys: [{ ...publicJwk, kid: "rsa", alg: "RS256" }] }),
    });
    const token = await signToken({ algorithm: "RS256", jwk: privateJwk, header: { kid: "rsa" } });
    expect((await verifyAccessToken(token, rsaKeys, ISSUER, NOW())).ok).toBe(true);
  });

  it("sans JWKS en ligne, la clé est lue sur le point JWKS de Supabase, puis gardée en cache", async () => {
    const urls: string[] = [];
    const fetcher = (url: string) => {
      urls.push(url);
      return Promise.resolve(new Response(env.SUPABASE_JWKS));
    };
    const remote = createJwksProvider({ SUPABASE_URL: "https://test.supabase.co" }, fetcher);
    expect((await verifyAccessToken(await signToken(), remote, ISSUER, NOW())).ok).toBe(true);
    expect((await verifyAccessToken(await signToken(), remote, ISSUER, NOW())).ok).toBe(true);
    expect(urls).toEqual(["https://test.supabase.co/auth/v1/.well-known/jwks.json"]);
  });

  it("un point JWKS injoignable fait refuser le jeton sans lever d'exception", async () => {
    const failing = createJwksProvider({ SUPABASE_URL: "https://test.supabase.co" }, () =>
      Promise.resolve(new Response("down", { status: 503 })),
    );
    expect((await verifyAccessToken(await signToken(), failing, ISSUER, NOW())).ok).toBe(false);
  });
});
