import { describe, expect, it } from "vitest";
import { applyPlay, type Card, type GameState } from "../src/index.js";
import { LATER, rng, expectError, makeState, top, type MakeStateInput } from "./helpers.js";

function play(state: GameState, playerId: string, cards: Card[]) {
  return applyPlay(state, playerId, { cards }, rng(), LATER);
}

function aWith(cards: Card[], extra: MakeStateInput = {}): GameState {
  return makeState({ hands: { A: cards }, ...extra });
}

describe("ENG-05 — A. As (R4)", () => {
  it("A1 — 3 joueurs, talon 5H, A joue AH : OK, skipped = [B], tour de C", () => {
    const { state, events } = play(aWith(["AH"]), "A", ["AH"]);
    expect(state.currentPlayerId).toBe("C");
    expect(events[0]).toMatchObject({ t: "CARDS_PLAYED", skipped: ["B"], nextPlayerId: "C" });
  });

  it("A2 — 2 joueurs, A joue AH : B sauté, A rejoue avec un nouveau turnDeadline", () => {
    const { state, events } = play(aWith(["AH"], { n: 2 }), "A", ["AH"]);
    expect(state.currentPlayerId).toBe("A");
    expect(state.turnStartedAt).toBe(LATER);
    expect(state.turnDeadline).toBe(LATER + 30_000);
    expect(events[0]).toMatchObject({ skipped: ["B"], nextPlayerId: "A" });
  });

  it("A3 — 4 joueurs, A joue [AH, AS] : B et C sautés, tour de D", () => {
    const { state, events } = play(aWith(["AH", "AS"], { n: 4 }), "A", ["AH", "AS"]);
    expect(state.currentPlayerId).toBe("D");
    expect(events[0]).toMatchObject({ skipped: ["B", "C"] });
  });

  it("A4 — 3 joueurs, A joue [AH, AS] : B et C sautés, A rejoue", () => {
    const { state, events } = play(aWith(["AH", "AS"]), "A", ["AH", "AS"]);
    expect(state.currentPlayerId).toBe("A");
    expect(events[0]).toMatchObject({ skipped: ["B", "C"] });
  });

  it("A5 — 3 joueurs, A joue [AH, AS, AD] : tour de B (formule)", () => {
    const { state, events } = play(aWith(["AH", "AS", "AD"]), "A", ["AH", "AS", "AD"]);
    expect(state.currentPlayerId).toBe("B");
    expect(events[0]).toMatchObject({ skipped: ["B", "C", "A"] });
  });

  it("A6 — pén 2, A joue AS : MUST_COUNTER_OR_DRAW", () => {
    expectError(
      () => play(aWith(["AS"], { penalty: 2, discard: ["7D"] }), "A", ["AS"]),
      "MUST_COUNTER_OR_DRAW",
    );
  });

  it("A7 — R4 décochée, talon 5H, A joue AH : OK, aucun saut, tour de B", () => {
    const { state, events } = play(aWith(["AH"], { options: { ace_skips: false } }), "A", ["AH"]);
    expect(state.currentPlayerId).toBe("B");
    expect(events[0]).toMatchObject({ skipped: [] });
  });

  it("A8 — 4 joueurs, C a abandonné, A joue AH : B sauté, tour de D", () => {
    const { state, events } = play(aWith(["AH"], { n: 4, forfeited: ["C"] }), "A", ["AH"]);
    expect(state.currentPlayerId).toBe("D");
    expect(events[0]).toMatchObject({ skipped: ["B"] });
  });

  it("l'As posé par le dernier siège fait sauter le premier", () => {
    const state = makeState({ current: "C", hands: { C: ["AH"] } });
    const { state: next, events } = play(state, "C", ["AH"]);
    expect(next.currentPlayerId).toBe("B");
    expect(events[0]).toMatchObject({ skipped: ["A"] });
  });
});

describe("ENG-05 — K. Pénalités et cumul (R5, R6)", () => {
  /** State after K1: A played 7H on 5H, B to play under a penalty of 2. */
  function afterK1(bCards: Card[]): GameState {
    return play(aWith(["7H"], { hands: { A: ["7H"], B: bCards } }), "A", ["7H"]).state;
  }

  it("K1 — talon 5H, A joue 7H : pén 2, tour de B", () => {
    const state = afterK1([]);
    expect(state.penalty).toBe(2);
    expect(state.currentPlayerId).toBe("B");
  });

  it("K3 — suite de K1, B joue 7S : pén 4, tour de C", () => {
    const { state } = play(afterK1(["7S"]), "B", ["7S"]);
    expect(state.penalty).toBe(4);
    expect(state.currentPlayerId).toBe("C");
  });

  it("K4 — suite de K1, B joue XR : pén 6, tour de C", () => {
    const { state } = play(afterK1(["XR"]), "B", ["XR"]);
    expect(state.penalty).toBe(6);
    expect(state.currentPlayerId).toBe("C");
    expect(state.openColor).toBe("R");
  });

  it("K6 — pén 4, B joue 9H : MUST_COUNTER_OR_DRAW", () => {
    const state = makeState({
      current: "B",
      penalty: 4,
      discard: ["5H", "XR"],
      openColor: "R",
      hands: { B: ["9H"] },
    });
    expectError(() => play(state, "B", ["9H"]), "MUST_COUNTER_OR_DRAW");
  });

  it("K7 — talon XR, pén 4, B joue 7C : OK (contre sans condition d'enseigne), pén 6", () => {
    const state = makeState({
      current: "B",
      penalty: 4,
      discard: ["5H", "XR"],
      openColor: "R",
      hands: { B: ["7C"] },
    });
    const { state: next } = play(state, "B", ["7C"]);
    expect(next.penalty).toBe(6);
    expect(top(next)).toBe("7C");
    expect(next.openColor).toBeNull();
    expect(next.currentPlayerId).toBe("C");
  });

  it("K8 — talon 7H encaissé, C joue 7S : OK, nouvelle pén 2 pour A", () => {
    const state = makeState({ current: "C", discard: ["7H"], hands: { C: ["7S"] } });
    const { state: next } = play(state, "C", ["7S"]);
    expect(next.penalty).toBe(2);
    expect(next.currentPlayerId).toBe("A");
  });

  it("K9 — R5 décochée, talon 5H, A joue 7H : OK, pén 0, tour de B normal", () => {
    const { state } = play(aWith(["7H"], { options: { seven_draw_two: false } }), "A", ["7H"]);
    expect(state.penalty).toBe(0);
    expect(state.currentPlayerId).toBe("B");
  });

  it("K10 — R5 décochée, R6 cochée, pén 4, B joue 7S : MUST_COUNTER_OR_DRAW", () => {
    const state = makeState({
      current: "B",
      penalty: 4,
      discard: ["5S", "XB"],
      openColor: "B",
      options: { seven_draw_two: false },
      hands: { B: ["7S"] },
    });
    expectError(() => play(state, "B", ["7S"]), "MUST_COUNTER_OR_DRAW");
  });

  it("K11 — R5 cochée, R6 décochée, pén 2, B joue XR : MUST_COUNTER_OR_DRAW", () => {
    const state = makeState({
      current: "B",
      penalty: 2,
      discard: ["7D"],
      options: { joker_draw_four: false },
      hands: { B: ["XR"] },
    });
    expectError(() => play(state, "B", ["XR"]), "MUST_COUNTER_OR_DRAW");
  });

  it("la pénalité suit la configuration (penalty.seven / penalty.joker)", () => {
    const state = aWith(["7H", "XB"], { config: { penaltySeven: 3, penaltyJoker: 5 } });
    expect(play(state, "A", ["7H", "XB"]).state.penalty).toBe(8);
  });

  it("chaîne de contres 7 → Joker → 7 sur trois joueurs : la pénalité revient sur A", () => {
    let state = makeState({ hands: { A: ["7H"], B: ["XB"], C: ["7D"] } });
    state = play(state, "A", ["7H"]).state;
    state = play(state, "B", ["XB"]).state;
    state = play(state, "C", ["7D"]).state;
    expect(state.penalty).toBe(8);
    expect(state.currentPlayerId).toBe("A");
    expect(top(state)).toBe("7D");
  });
});
