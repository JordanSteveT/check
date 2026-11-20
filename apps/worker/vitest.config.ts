import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

/**
 * Test signing key, generated at each run (never stored): the Worker gets the public key as
 * an inline JWKS (`SUPABASE_JWKS`), the tests get the private key (`TEST_SIGNING_JWK`) to sign
 * Supabase-like access tokens. Uses Web Crypto, available both in Node and in workerd.
 */
async function testKeys(): Promise<{ jwks: string; privateJwk: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const kid = "test-key";
  return {
    jwks: JSON.stringify({ keys: [{ ...publicJwk, kid, alg: "ES256", use: "sig" }] }),
    privateJwk: JSON.stringify({ ...privateJwk, kid, alg: "ES256" }),
  };
}

export default defineWorkersConfig(async () => {
  const keys = await testKeys();
  return {
    test: {
      include: ["test/**/*.test.ts"],
      poolOptions: {
        workers: {
          // Durable Objects holding WebSockets are not compatible with isolated storage.
          isolatedStorage: false,
          // Required for WebSockets to Durable Objects. workerd then logs "info: ... invalidating
          // this Durable Object" when a test file reloads the module: harmless.
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              SUPABASE_URL: "https://test.supabase.co",
              SUPABASE_JWKS: keys.jwks,
              TEST_SIGNING_JWK: keys.privateJwk,
              // 5 s in production (protocole §2.1); shortened so that the test does not wait.
              AUTH_TIMEOUT_MS: "300",
            },
          },
        },
      },
    },
  };
});
