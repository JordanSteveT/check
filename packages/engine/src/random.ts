// Injected randomness — the engine never creates its own source of randomness (cahier B6).

/**
 * A random number generator returning a float in [0, 1).
 * Production: backed by `crypto.getRandomValues` (CSPRNG) in the Worker.
 * Tests: `createSeededRng(seed)`.
 */
export type Rng = () => number;

/** Uniform integer in [0, n). Throws if the generator breaks its contract. */
export function randomInt(rng: Rng, n: number): number {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`randomInt: n must be a positive integer, got ${n}`);
  }
  const x = rng();
  if (!(x >= 0 && x < 1)) {
    throw new RangeError(`randomInt: rng must return a number in [0, 1), got ${x}`);
  }
  return Math.floor(x * n);
}

/** Fisher–Yates shuffle. Returns a new array; the input is not modified. */
export function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(rng, i + 1);
    const tmp = result[i] as T;
    result[i] = result[j] as T;
    result[j] = tmp;
  }
  return result;
}

/**
 * Deterministic generator (mulberry32) for tests and simulations.
 * NOT cryptographically secure: never use it to deal real games.
 */
export function createSeededRng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
