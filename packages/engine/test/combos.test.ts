import { describe, expect, it } from "vitest";
import { applyPlay, type Card, type GameState, type Suit } from "../src/index.js";
import { LATER, rng, expectError, makeState, top, type MakeStateInput } from "./helpers.js";

function play(state: GameState, playerId: string, cards: Card[], suit?: Suit) {
  return applyPlay(state, playerId, suit === undefined ? { cards } : { cards, suit }, rng(), LATER);
}

/** A to play, with the given hand cards (padded with neutral cards). */
function aWith(cards: Card[], extra: MakeStateInput = {}): GameState {
  return makeState({ hands: { A: cards }, ...extra });
}

/** B to play under an active penalty. */
function bUnderPenalty(cards: Card[], penalty: number, extra: MakeStateInput = {}): GameState {
  return makeState({ current: "B", penalty, hands: { B: cards }, discard: ["7D"], ...extra });
}

describe("ENG-04 — C. Combinaisons (R8)", () => {
  it("C1 — talon 8H, A joue [8S, 8D] : OK, carte visible 8D", () => {
    const { state, events } = play(aWith(["8S", "8D"], { discard: ["8H"] }), "A", ["8S", "8D"]);
    expect(top(state)).toBe("8D");
    expect(state.discard).toEqual(["8H", "8S", "8D"]);
    expect(state.hands["A"]).toHaveLength(3);
    expect(events[0]).toMatchObject({ cards: ["8S", "8D"], topCard: "8D", handCount: 3 });
  });

  it("C2 — talon 5H : [8S, 8H] ILLEGAL_PLAY (la 1re carte doit être jouable) ; [8H, 8S] OK, visible 8S", () => {
    expectError(() => play(aWith(["8S", "8H"]), "A", ["8S", "8H"]), "ILLEGAL_PLAY");
    expect(top(play(aWith(["8S", "8H"]), "A", ["8H", "8S"]).state)).toBe("8S");
  });

  it("C3 — talon 8H, A joue [8H, 9H] : INVALID_COMBO", () => {
    expectError(
      () => play(aWith(["8H", "9H"], { discard: ["8C"] }), "A", ["8H", "9H"]),
      "INVALID_COMBO",
    );
  });

  it("C4 — talon 5H, A joue [7H, XB] : OK, pén 6, visible XB, ouv B", () => {
    const { state } = play(aWith(["7H", "XB"]), "A", ["7H", "XB"]);
    expect(state.penalty).toBe(6);
    expect(top(state)).toBe("XB");
    expect(state.openColor).toBe("B");
    expect(state.currentPlayerId).toBe("B");
  });

  it("C5 — talon 5H, R7 cochée, A joue [XB, 7H] : OK, pén 6, visible 7H, ouv null", () => {
    const { state } = play(aWith(["XB", "7H"]), "A", ["XB", "7H"]);
    expect(state.penalty).toBe(6);
    expect(top(state)).toBe("7H");
    expect(state.openColor).toBeNull();
  });

  it("C6 — talon 5H, R7 décochée : [XB, 7H] ILLEGAL_PLAY ; [7H, XB] OK", () => {
    const opts = { options: { joker_wild: false } };
    expectError(() => play(aWith(["XB", "7H"], opts), "A", ["XB", "7H"]), "ILLEGAL_PLAY");
    expect(play(aWith(["XB", "7H"], opts), "A", ["7H", "XB"]).state.penalty).toBe(6);
  });

  it("C7 — pén 2, B joue [7S, XR] : OK, pén 8", () => {
    const { state } = play(bUnderPenalty(["7S", "XR"], 2), "B", ["7S", "XR"]);
    expect(state.penalty).toBe(8);
    expect(state.currentPlayerId).toBe("C");
    expect(state.openColor).toBe("R");
  });

  it("C8 — talon 5H, A joue [JH, JS] couleur C : OK, dem = C", () => {
    const { state } = play(aWith(["JH", "JS"]), "A", ["JH", "JS"], "C");
    expect(state.requestedSuit).toBe("C");
    expect(top(state)).toBe("JS");
  });

  it("C8 (suite) — plusieurs Valets sans couleur : SUIT_REQUIRED", () => {
    expectError(() => play(aWith(["JH", "JS"]), "A", ["JH", "JS"]), "SUIT_REQUIRED");
  });

  it("C9 — R8 décochée, talon 8H, A joue [8S, 8D] : INVALID_COMBO", () => {
    const state = aWith(["8S", "8D"], { discard: ["8H"], options: { allow_multiples: false } });
    expectError(() => play(state, "A", ["8S", "8D"]), "INVALID_COMBO");
  });

  it("C9 (suite) — R8 décochée : contre à une seule carte, [7S, XR] refusé", () => {
    const state = bUnderPenalty(["7S", "XR"], 2, { options: { allow_multiples: false } });
    expectError(() => play(state, "B", ["7S", "XR"]), "INVALID_COMBO");
    expect(play(state, "B", ["XR"]).state.penalty).toBe(6);
  });

  it("C10 — talon 7S encaissé, A joue [7H, 7D, XB] : OK, pén 8", () => {
    const { state } = play(aWith(["7H", "7D", "XB"], { discard: ["7S"] }), "A", ["7H", "7D", "XB"]);
    expect(state.penalty).toBe(8);
  });

  it("C11 — A n'a pas 8D, A joue [8S, 8D] : CARD_NOT_IN_HAND", () => {
    expectError(
      () => play(aWith(["8S"], { discard: ["8H"] }), "A", ["8S", "8D"]),
      "CARD_NOT_IN_HAND",
    );
  });

  it("C12 — A joue [8S, 8S] : INVALID_COMBO (doublon)", () => {
    expectError(() => play(aWith(["8S"], { discard: ["8H"] }), "A", ["8S", "8S"]), "INVALID_COMBO");
  });

  it("C13 — A joue [2H, 5H] : INVALID_COMBO", () => {
    expectError(() => play(aWith(["2H", "5D"]), "A", ["2H", "5D"]), "INVALID_COMBO");
  });

  it("C14 — talon 5H, A joue [XR, XB] : OK, pén 8, visible XB, ouv B", () => {
    const { state } = play(aWith(["XR", "XB"]), "A", ["XR", "XB"]);
    expect(state.penalty).toBe(8);
    expect(top(state)).toBe("XB");
    expect(state.openColor).toBe("B");
  });

  it("C15 — pén 2, B joue [XB, XR] : OK, pén 10, ouv R", () => {
    const { state } = play(bUnderPenalty(["XB", "XR"], 2), "B", ["XB", "XR"]);
    expect(state.penalty).toBe(10);
    expect(state.openColor).toBe("R");
  });

  it("C16 — R6 décochée, talon 5H, A joue [7H, XR] : INVALID_COMBO", () => {
    const state = aWith(["7H", "XR"], { options: { joker_draw_four: false } });
    expectError(() => play(state, "A", ["7H", "XR"]), "INVALID_COMBO");
  });

  it("C17 — R5 décochée, talon 5H, A joue [7H, XR] : OK, pén 4 (le 7 ne compte pas), visible XR, ouv R", () => {
    const state = aWith(["7H", "XR"], { options: { seven_draw_two: false } });
    const { state: next } = play(state, "A", ["7H", "XR"]);
    expect(next.penalty).toBe(4);
    expect(top(next)).toBe("XR");
    expect(next.openColor).toBe("R");
  });

  it("C18 — R5 décochée, talon 5S, A joue [7S, XR] : INVALID_COMBO (7 noir, Joker rouge)", () => {
    const state = aWith(["7S", "XR"], { discard: ["5S"], options: { seven_draw_two: false } });
    expectError(() => play(state, "A", ["7S", "XR"]), "INVALID_COMBO");
  });

  it("C18 (suite) — R5 décochée : [7S, XR, XB] OK (le 7 noir a la couleur du Joker noir)", () => {
    const state = aWith(["7S", "XR", "XB"], {
      discard: ["5S"],
      options: { seven_draw_two: false },
    });
    expect(play(state, "A", ["7S", "XR", "XB"]).state.penalty).toBe(8);
  });

  it("C19 — R6 décochée, talon 5H, A joue [XR, XB] : OK, pén 0, visible XB, ouv B", () => {
    const state = aWith(["XR", "XB"], { options: { joker_draw_four: false } });
    const { state: next } = play(state, "A", ["XR", "XB"]);
    expect(next.penalty).toBe(0);
    expect(top(next)).toBe("XB");
    expect(next.openColor).toBe("B");
  });

  it("C20 — R5 décochée, pén 4 (talon XB), B joue [XR, 7H] : MUST_COUNTER_OR_DRAW", () => {
    const state = bUnderPenalty(["XR", "7H"], 4, {
      discard: ["5H", "XB"],
      openColor: "B",
      options: { seven_draw_two: false },
    });
    expectError(() => play(state, "B", ["XR", "7H"]), "MUST_COUNTER_OR_DRAW");
    expect(play(state, "B", ["XR"]).state.penalty).toBe(8);
  });
});

describe("ENG-04 — combinaisons du 2 transparent", () => {
  it("D7 — talon 9S, A joue [2H, 2S] : OK, talon visible reste 9S", () => {
    const { state } = play(aWith(["2H", "2S"], { discard: ["9S"] }), "A", ["2H", "2S"]);
    expect(top(state)).toBe("9S");
    expect(state.discard).toEqual(["2H", "2S", "9S"]);
    expect(state.currentPlayerId).toBe("B");
  });
});

describe("ENG-04 — ordre de pose et cas limites", () => {
  it("l'ordre fixe la carte visible, pas le total de pénalité", () => {
    const a = play(aWith(["7H", "7D", "XB"], { discard: ["7S"] }), "A", ["7H", "XB", "7D"]).state;
    expect(a.penalty).toBe(8);
    expect(top(a)).toBe("7D");
    expect(a.openColor).toBeNull();
  });

  it("sous pénalité, un contre mélangé à une carte ordinaire est refusé", () => {
    expectError(() => play(bUnderPenalty(["7S", "9S"], 2), "B", ["7S", "9S"]), "INVALID_COMBO");
  });

  it("sous pénalité, plusieurs 7 contrent dans n'importe quel ordre", () => {
    expect(play(bUnderPenalty(["7S", "7H"], 2), "B", ["7H", "7S"]).state.penalty).toBe(6);
  });

  it("des 7 et un Joker sans pénalité : R5 décochée, seule la carte jouable en premier compte", () => {
    const state = aWith(["XR", "7H"], { options: { seven_draw_two: false, joker_wild: false } });
    expect(top(play(state, "A", ["XR", "7H"]).state)).toBe("7H");
  });

  it("une combinaison qui vide la main fait gagner, sans annonce (CH9)", () => {
    const state = aWith(["8S", "8D", "8C"], { discard: ["8H"], exact: ["A"] });
    const { state: next, events } = play(state, "A", ["8S", "8D", "8C"]);
    expect(next.status).toBe("FINISHED");
    expect(events.at(-1)).toMatchObject({ t: "GAME_OVER", winnerId: "A", reason: "EMPTY_HAND" });
  });
});
