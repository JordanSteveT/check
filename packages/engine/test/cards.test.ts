import { describe, expect, it } from "vitest";
import {
  ALL_CARDS,
  colorOf,
  createDeck,
  createSeededRng,
  isCard,
  isJoker,
  randomInt,
  rankOf,
  shuffle,
  suitColor,
  suitOf,
} from "../src/index.js";

describe("ENG-01 — cartes et paquet", () => {
  it("I1 (paquet) — le paquet contient 54 cartes uniques : 52 + 2 Jokers", () => {
    const deck = createDeck();
    expect(deck).toHaveLength(54);
    expect(new Set(deck).size).toBe(54);
    expect(deck.filter(isJoker).sort()).toEqual(["XB", "XR"]);
    for (const suit of ["H", "D", "S", "C"] as const) {
      expect(deck.filter((c) => suitOf(c) === suit)).toHaveLength(13);
    }
  });

  it("B1 — codage des cartes du protocole §1", () => {
    expect(ALL_CARDS).toContain("7H");
    expect(ALL_CARDS).toContain("10S");
    expect(ALL_CARDS).toContain("AD");
    expect(ALL_CARDS).toContain("JC");
    expect(isCard("10S")).toBe(true);
    expect(isCard("1S")).toBe(false);
    expect(isCard("XX")).toBe(false);
    expect(isCard("7h")).toBe(false);
    expect(isCard(7)).toBe(false);
    expect(rankOf("10S")).toBe("10");
    expect(suitOf("10S")).toBe("S");
    expect(rankOf("XR")).toBeNull();
    expect(suitOf("XB")).toBeNull();
  });

  it("B2 — couleurs : rouges = ♥ ♦ et Joker rouge ; noires = ♠ ♣ et Joker noir", () => {
    expect(colorOf("5H")).toBe("R");
    expect(colorOf("QD")).toBe("R");
    expect(colorOf("XR")).toBe("R");
    expect(colorOf("AS")).toBe("B");
    expect(colorOf("10C")).toBe("B");
    expect(colorOf("XB")).toBe("B");
    expect(suitColor("H")).toBe("R");
    expect(suitColor("D")).toBe("R");
    expect(suitColor("S")).toBe("B");
    expect(suitColor("C")).toBe("B");
  });

  it("createDeck renvoie un nouveau tableau à chaque appel", () => {
    const a = createDeck();
    a.pop();
    expect(createDeck()).toHaveLength(54);
  });
});

describe("ENG-01 — mélange avec générateur injecté", () => {
  it("I6 (mélange) — même graine, même mélange (déterminisme)", () => {
    const a = shuffle(createDeck(), createSeededRng(42));
    const b = shuffle(createDeck(), createSeededRng(42));
    expect(a).toEqual(b);
    const c = shuffle(createDeck(), createSeededRng(43));
    expect(c).not.toEqual(a);
  });

  it("le mélange est une permutation et ne modifie pas le tableau reçu", () => {
    const deck = createDeck();
    const copy = [...deck];
    const shuffled = shuffle(deck, createSeededRng(7));
    expect(deck).toEqual(copy);
    expect(shuffled).not.toBe(deck);
    expect([...shuffled].sort()).toEqual([...deck].sort());
  });

  it("le mélange est uniforme (chaque carte en 1re position ≈ 1/54)", () => {
    const rng = createSeededRng(2026);
    const counts = new Map<string, number>();
    const runs = 54_000;
    for (let i = 0; i < runs; i++) {
      const first = shuffle(ALL_CARDS, rng)[0];
      if (first !== undefined) counts.set(first, (counts.get(first) ?? 0) + 1);
    }
    expect(counts.size).toBe(54);
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1200);
    }
  });

  it("randomInt reste dans [0, n) même si le générateur renvoie une valeur limite", () => {
    expect(randomInt(() => 0, 6)).toBe(0);
    expect(randomInt(() => 0.999999999999, 6)).toBe(5);
    expect(() => randomInt(() => 1, 6)).toThrow(RangeError);
    expect(() => randomInt(() => -0.1, 6)).toThrow(RangeError);
    expect(() => randomInt(() => Number.NaN, 6)).toThrow(RangeError);
    expect(() => randomInt(() => 0.5, 0)).toThrow(RangeError);
  });

  it("le générateur à graine donne des valeurs dans [0, 1)", () => {
    const rng = createSeededRng(1);
    for (let i = 0; i < 10_000; i++) {
      const x = rng();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
