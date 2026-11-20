import type { Env } from "../src/env.js";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    /** Private key matching SUPABASE_JWKS (vitest.config.ts), to sign test tokens. */
    TEST_SIGNING_JWK: string;
  }
}
