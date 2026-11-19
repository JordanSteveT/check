import { describe, expect, it } from "vitest";
import {
  createGame,
  createSeededRng,
  drawStarterCard,
  isSpecialStarter,
  rankOf,
  type Card,
  type GameState,
} from "../src/index.js";
import { NOW, TEST_CONFIG, options, players } from "./helpers.js";

function newGame(n: number, seed: number, opts = options()): GameState {
  return createGame(TEST_CONFIG, opts, players(n), createSeededRng(seed), NOW, `game-${seed}`);
}

function allCards(state: GameState): Card[] {
  return [...Object.values(state.hands).flat(), ...state.deck, ...state.discard];
}

describe("ENG-02 — I. Initialisation", () => {
  it("I1 — 2 joueurs : 5 cartes par main, 1 au talon, 43 dans la pioche ; 54 cartes uniques", () => {
    const state = newGame(2, 1);
    expect(state.hands["A"]).toHaveLength(5);
    expect(state.hands["B"]).toHaveLength(5);
    expect(state.discard).toHaveLength(1);
    expect(state.deck).toHaveLength(43);
    const cards = allCards(state);
    expect(cards).toHaveLength(54);
    expect(new Set(cards).size).toBe(54);
  });

  it("I2 — 6 joueurs : 30 cartes en main, 1 au talon, 23 dans la pioche", () => {
    const state = newGame(6, 2);
    expect(Object.values(state.hands).flat()).toHaveLength(30);
    for (const id of players(6)) expect(state.hands[id]).toHaveLength(5);
    expect(state.discard).toHaveLength(1);
    expect(state.deck).toHaveLength(23);
    expect(new Set(allCards(state)).size).toBe(54);
  });

  it("I3 — une 1re carte retournée 7H est remise dans la pioche ; le talon n'est jamais spécial", () => {
    // First card turned over is 7H: it goes back into the deck and another card is turned.
    const { starter, deck } = drawStarterCard(["7H", "5S"], options(), createSeededRng(3));
    expect(starter).toBe("5S");
    expect(deck).toEqual(["7H"]);

    // With all options, the starter is never a 7, an Ace, a Jack, a Joker or a 2.
    for (let seed = 0; seed < 1000; seed++) {
      const top = newGame(4, seed).discard[0];
      expect(top).toBeDefined();
      expect(["7", "A", "J", "2", null]).not.toContain(rankOf(top as Card));
    }
  });

  it("I4 — R1 décochée : 2S accepté comme carte de départ", () => {
    const opts = options({ two_transparent: false });
    expect(drawStarterCard(["2S", "5S"], opts, createSeededRng(4))).toEqual({
      starter: "2S",
      deck: ["5S"],
    });
    expect(isSpecialStarter("2S", opts)).toBe(false);
    expect(isSpecialStarter("2S", options())).toBe(true);
  });

  it("I5 — R4 décochée : AH accepté comme carte de départ", () => {
    const opts = options({ ace_skips: false });
    expect(drawStarterCard(["AH", "5S"], opts, createSeededRng(5)).starter).toBe("AH");
    expect(isSpecialStarter("AH", opts)).toBe(false);
    expect(isSpecialStarter("AH", options())).toBe(true);
  });

  it("I6 — même graine, mêmes joueurs : états strictement identiques", () => {
    expect(newGame(4, 42)).toEqual(newGame(4, 42));
    expect(newGame(4, 42)).not.toEqual(newGame(4, 43));
  });

  it("I7 — 1 000 parties, 4 joueurs : chaque joueur commence au moins une fois", () => {
    const starters = new Map<string, number>();
    for (let seed = 0; seed < 1000; seed++) {
      const first = newGame(4, seed).currentPlayerId;
      starters.set(first, (starters.get(first) ?? 0) + 1);
    }
    expect([...starters.keys()].sort()).toEqual(["A", "B", "C", "D"]);
    for (const count of starters.values()) expect(count).toBeGreaterThan(150);
  });

  it("I8 — nouvelle partie : pén 0, dem null, ouv null, turnDeadline = now + 30 s", () => {
    const state = newGame(3, 8);
    expect(state.penalty).toBe(0);
    expect(state.requestedSuit).toBeNull();
    expect(state.openColor).toBeNull();
    expect(state.turnStartedAt).toBe(NOW);
    expect(state.turnDeadline).toBe(NOW + 30_000);
    expect(state.status).toBe("PLAYING");
    expect(state.gameId).toBe("game-8");
    expect(state.seats).toEqual(["A", "B", "C"]);
    expect(state.checkWindow).toBeNull();
    expect(state.checkDeclared).toEqual([]);
    expect(state.forfeited).toEqual([]);
    expect(state.roundsWithoutPlay).toBe(0);
    expect(state.missedTurns).toEqual({ A: 0, B: 0, C: 0 });
    expect(state.connected).toEqual({ A: true, B: true, C: true });
  });
});

describe("ENG-02 — carte de départ selon les options (B5)", () => {
  it("le Joker est toujours spécial, même avec R6 et R7 décochées", () => {
    const opts = options({ joker_draw_four: false, joker_wild: false });
    expect(isSpecialStarter("XR", opts)).toBe(true);
    expect(isSpecialStarter("XB", opts)).toBe(true);
  });

  it("le 7 est spécial seulement si R5 est cochée", () => {
    expect(isSpecialStarter("7D", options())).toBe(true);
    expect(isSpecialStarter("7D", options({ seven_draw_two: false }))).toBe(false);
  });

  it("le Valet est spécial si R2 ou R3 est cochée, ordinaire si les deux sont décochées", () => {
    expect(isSpecialStarter("JC", options({ jack_commands: false }))).toBe(true);
    expect(isSpecialStarter("JC", options({ jack_wild: false }))).toBe(true);
    expect(isSpecialStarter("JC", options({ jack_commands: false, jack_wild: false }))).toBe(false);
  });

  it("Dame, Roi et cartes numérotées ne sont jamais spéciales", () => {
    for (const card of ["QH", "KS", "3D", "10C"] as const) {
      expect(isSpecialStarter(card, options())).toBe(false);
    }
  });

  it("avec toutes les options décochées sauf le Joker, un 2 ou un As peut sortir au départ", () => {
    const opts = options({ two_transparent: false, ace_skips: false });
    const ranks = new Set<string | null>();
    for (let seed = 0; seed < 300; seed++)
      ranks.add(rankOf(newGame(2, seed, opts).discard[0] as Card));
    expect(ranks.has("2")).toBe(true);
    expect(ranks.has("A")).toBe(true);
    expect(ranks.has(null)).toBe(false);
  });

  it("drawStarterCard ne modifie pas la pioche reçue", () => {
    const deck: Card[] = ["7H", "5S"];
    drawStarterCard(deck, options(), createSeededRng(9));
    expect(deck).toEqual(["7H", "5S"]);
  });

  it("drawStarterCard refuse une pioche sans carte ordinaire", () => {
    expect(() => drawStarterCard(["7H", "XR"], options(), createSeededRng(1))).toThrow(RangeError);
    expect(() => drawStarterCard([], options(), createSeededRng(1))).toThrow(RangeError);
  });
});

describe("ENG-02 — validation des paramètres de createGame", () => {
  const rng = () => createSeededRng(1);

  it("refuse moins de 2 ou plus de 6 joueurs", () => {
    expect(() => createGame(TEST_CONFIG, options(), ["A"], rng(), NOW, "g")).toThrow(RangeError);
    expect(() => createGame(TEST_CONFIG, options(), [...players(6), "G"], rng(), NOW, "g")).toThrow(
      RangeError,
    );
  });

  it("refuse des identifiants de joueurs en double", () => {
    expect(() => createGame(TEST_CONFIG, options(), ["A", "A"], rng(), NOW, "g")).toThrow(
      RangeError,
    );
  });

  it("refuse une configuration où le paquet ne suffit pas", () => {
    const config = { ...TEST_CONFIG, initialHandSize: 9 };
    expect(() => createGame(config, options(), players(6), rng(), NOW, "g")).toThrow(RangeError);
  });

  it("ne modifie pas la liste de joueurs reçue", () => {
    const list = ["A", "B"];
    const state = createGame(TEST_CONFIG, options(), list, rng(), NOW, "g");
    state.seats.push("Z");
    expect(list).toEqual(["A", "B"]);
  });
});
