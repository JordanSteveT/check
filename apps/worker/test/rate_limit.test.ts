import { describe, expect, it } from "vitest";
import { checkRate, type RateState } from "../src/rate_limit.js";

const T0 = 1_000_000;

/** Sends `n` messages at `now`, starting from `state`. */
function burst(state: RateState | undefined, now: number, n: number) {
  let current = state;
  const decisions = [];
  for (let i = 0; i < n; i++) {
    const decision = checkRate(current, now);
    decisions.push(decision);
    current = decision.state;
  }
  return { state: current, decisions };
}

describe("SRV-08 — limite de débit d'une connexion (protocole §8)", () => {
  it("20 messages par seconde passent ; au-delà, refusés, sans fermer à la 1re fois", () => {
    const { state, decisions } = burst(undefined, T0, 25);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(20);
    expect(decisions.filter((d) => !d.allowed)).toHaveLength(5);
    expect(decisions.some((d) => d.close)).toBe(false);
    expect(state?.strikes).toBe(1); // one strike per second, not per message
  });

  it("une nouvelle seconde remet le compteur à zéro, pas les dépassements", () => {
    const first = burst(undefined, T0, 21);
    const next = checkRate(first.state, T0 + 1000);
    expect(next).toMatchObject({ allowed: true, state: { count: 1, strikes: 1 } });
    expect(checkRate(first.state, T0 + 999).allowed).toBe(false);
  });

  it("la 3e seconde de dépassement ferme la connexion", () => {
    let state = burst(undefined, T0, 21).state;
    state = burst(state, T0 + 1000, 21).state;
    const third = burst(state, T0 + 2000, 21).decisions;
    expect(third.slice(0, 20).every((d) => d.allowed)).toBe(true);
    expect(third[20]).toMatchObject({ allowed: false, close: true });
  });
});
