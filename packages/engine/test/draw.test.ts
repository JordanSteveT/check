import { describe, expect, it } from "vitest";
import {
  applyDraw,
  applyPlay,
  canPlayCard,
  createSeededRng,
  type Card,
  type GameState,
} from "../src/index.js";
import { LATER, rng, expectError, makeState, top } from "./helpers.js";

function draw(state: GameState, playerId: string, seed = 1) {
  return applyDraw(state, playerId, createSeededRng(seed), LATER);
}

function play(state: GameState, playerId: string, cards: Card[]) {
  return applyPlay(state, playerId, { cards }, rng(), LATER);
}

describe("ENG-06 — R. Pioche et épuisement", () => {
  it("R1 — pén 0, A a une carte jouable, A DRAW : A reçoit 1 carte, tour de B", () => {
    const state = makeState({ hands: { A: ["9H"] }, deck: ["9D", "KC"] });
    const { state: next, events } = draw(state, "A");
    expect(next.hands["A"]).toHaveLength(6);
    expect(next.hands["A"]).toContain("9D");
    expect(next.deck).toEqual(["KC"]);
    expect(next.currentPlayerId).toBe("B");
    expect(next.turnStartedAt).toBe(LATER);
    expect(next.turnDeadline).toBe(LATER + 30_000);
    expect(events).toEqual([
      {
        t: "CARDS_DRAWN",
        playerId: "A",
        count: 1,
        reason: "NORMAL",
        handCount: 6,
        deckCount: 1,
        nextPlayerId: "B",
        turnDeadline: LATER + 30_000,
      },
      { t: "YOU_DREW", playerId: "A", cards: ["9D"] },
    ]);
  });

  it("R2 — suite de R1, A joue : NOT_YOUR_TURN", () => {
    const { state } = draw(makeState({ hands: { A: ["9H"] } }), "A");
    expectError(() => play(state, "A", ["9H"]), "NOT_YOUR_TURN");
  });

  it("R7 — pioche vide, talon [3H, 4H, 9S] : remélange, 9S reste visible, A reçoit 1 carte, DECK_RESHUFFLED", () => {
    const state = makeState({ deck: [], discard: ["3H", "4H", "9S"] });
    const { state: next, events } = draw(state, "A");
    expect(next.discard).toEqual(["9S"]);
    expect(next.deck).toHaveLength(1);
    const drawn = next.hands["A"]?.at(-1);
    expect(["3H", "4H"]).toContain(drawn);
    expect([...next.deck, drawn].sort()).toEqual(["3H", "4H"]);
    expect(events[0]).toEqual({ t: "DECK_RESHUFFLED", deckCount: 2 });
    expect(events[1]).toMatchObject({ t: "CARDS_DRAWN", count: 1, deckCount: 1 });
  });

  it("R8 — pioche vide, talon d'une seule carte, A DRAW : 0 carte reçue, tour de B", () => {
    const state = makeState({ deck: [], discard: ["9S"] });
    const { state: next, events } = draw(state, "A");
    expect(next.hands["A"]).toHaveLength(5);
    expect(next.currentPlayerId).toBe("B");
    expect(events).toEqual([
      expect.objectContaining({ t: "CARDS_DRAWN", count: 0, deckCount: 0 }),
      { t: "YOU_DREW", playerId: "A", cards: [] },
    ]);
  });

  it("R9 — pioche et talon épuisés, un tour de table complet sans pose : BLOCKED, le joueur qui a le moins de cartes gagne", () => {
    let state = makeState({
      deck: [],
      discard: ["9S"],
      hands: { A: ["3H", "4H", "6H"], B: ["3D", "4D"], C: ["3C", "4C", "6C", "8C"] },
      exact: ["A", "B", "C"],
    });
    state = draw(state, "A").state;
    state = draw(state, "B").state;
    expect(state.status).toBe("PLAYING");
    const { state: end, events } = draw(state, "C");
    expect(end.status).toBe("FINISHED");
    expect(events.at(-1)).toEqual({
      t: "GAME_OVER",
      result: "WIN",
      winnerId: "B",
      reason: "BLOCKED",
      hands: { A: ["3H", "4H", "6H"], B: ["3D", "4D"], C: ["3C", "4C", "6C", "8C"] },
    });
  });

  it("R10 — comme R9, égalité au plus petit nombre de cartes : partie nulle (DRAW)", () => {
    let state = makeState({
      deck: [],
      discard: ["9S"],
      hands: { A: ["3H", "4H"], B: ["3D", "4D"], C: ["3C", "4C", "6C"] },
      exact: ["A", "B", "C"],
    });
    state = draw(state, "A").state;
    state = draw(state, "B").state;
    const { state: end, events } = draw(state, "C");
    expect(end.status).toBe("FINISHED");
    expect(events.at(-1)).toMatchObject({
      t: "GAME_OVER",
      result: "DRAW",
      winnerId: null,
      reason: "BLOCKED",
    });
  });

  it("R11 — missedTurns[A] = 2, A DRAW (pioche volontaire) : missedTurns[A] remis à 0", () => {
    const state = makeState();
    state.missedTurns["A"] = 2;
    expect(draw(state, "A").state.missedTurns["A"]).toBe(0);
  });
});

describe("ENG-06 — encaissement de la pénalité", () => {
  it("K2 — suite de K1, B DRAW : B reçoit 2 cartes, pén 0, tour de C (B ne pose rien)", () => {
    let state = makeState({ hands: { A: ["7H"] } });
    state = play(state, "A", ["7H"]).state;
    const { state: next, events } = draw(state, "B");
    expect(next.hands["B"]).toHaveLength(7);
    expect(next.penalty).toBe(0);
    expect(next.currentPlayerId).toBe("C");
    expect(top(next)).toBe("7H");
    expect(events[0]).toMatchObject({ t: "CARDS_DRAWN", count: 2, reason: "PENALTY" });
  });

  it("K5 — A 7H, B XB, C 7D, A DRAW : A reçoit 8 cartes", () => {
    let state = makeState({ hands: { A: ["7H"], B: ["XB"], C: ["7D"] } });
    state = play(state, "A", ["7H"]).state;
    state = play(state, "B", ["XB"]).state;
    state = play(state, "C", ["7D"]).state;
    const { state: next } = draw(state, "A");
    expect(next.hands["A"]).toHaveLength(4 + 8);
    expect(next.penalty).toBe(0);
    expect(next.currentPlayerId).toBe("B");
  });

  it("K12 — pén 6, pioche 3 cartes, talon d'une seule carte, B DRAW : B reçoit 3 cartes, le reste est annulé, pén 0", () => {
    const state = makeState({
      current: "B",
      penalty: 6,
      discard: ["XR"],
      openColor: "R",
      deck: ["KD", "QD", "3D"],
    });
    const { state: next, events } = draw(state, "B");
    expect(next.hands["B"]).toHaveLength(8);
    expect(next.deck).toEqual([]);
    expect(next.penalty).toBe(0);
    expect(next.currentPlayerId).toBe("C");
    expect(events[0]).toMatchObject({ count: 3, reason: "PENALTY", deckCount: 0 });
  });

  it("J9 — suite de J8 : C encaisse 6 cartes ; tour de A, qui peut jouer pique ou trèfle, pas cœur", () => {
    let state = makeState({
      discard: ["7D"],
      penalty: 2,
      current: "B",
      hands: { A: ["5S", "5C", "5H"], B: ["XB"] },
    });
    state = play(state, "B", ["XB"]).state;
    const { state: next } = draw(state, "C");
    expect(next.hands["C"]).toHaveLength(5 + 6);
    expect(next.currentPlayerId).toBe("A");
    expect(next.openColor).toBe("B");
    expect(canPlayCard(next, "5S")).toBe(true);
    expect(canPlayCard(next, "5C")).toBe(true);
    expect(canPlayCard(next, "5H")).toBe(false);
  });

  it("la pioche se remélange au milieu d'un encaissement", () => {
    const state = makeState({
      current: "B",
      penalty: 2,
      deck: ["KD"],
      discard: ["3H", "4H", "7S"],
    });
    const { state: next, events } = draw(state, "B");
    expect(next.hands["B"]).toHaveLength(7);
    expect(next.hands["B"]).toContain("KD");
    expect(next.discard).toEqual(["7S"]);
    expect(next.deck).toHaveLength(1);
    expect(events.map((e) => e.t)).toEqual(["DECK_RESHUFFLED", "CARDS_DRAWN", "YOU_DREW"]);
  });
});

describe("ENG-06 — contrôles de applyDraw", () => {
  it("seul le joueur dont c'est le tour peut piocher (NOT_YOUR_TURN)", () => {
    expectError(() => draw(makeState(), "B"), "NOT_YOUR_TURN");
  });

  it("pas de pioche une fois la partie terminée", () => {
    const state = { ...makeState(), status: "FINISHED" as const };
    expectError(() => draw(state, "A"), "NOT_YOUR_TURN");
  });

  it("applyDraw ne modifie pas l'état reçu", () => {
    const state = makeState({ deck: [], discard: ["3H", "4H", "9S"] });
    const before = JSON.parse(JSON.stringify(state)) as unknown;
    draw(state, "A");
    expect(state).toEqual(before);
  });

  it("la couleur demandée et la couleur ouverte restent après une pioche", () => {
    const jack = makeState({ discard: ["5H", "JS"], requestedSuit: "D" });
    expect(draw(jack, "A").state.requestedSuit).toBe("D");
    const joker = makeState({ discard: ["5H", "XB"], openColor: "B" });
    expect(draw(joker, "A").state.openColor).toBe("B");
  });

  it("une pose remet à zéro le décompte du blocage", () => {
    let state = makeState({
      deck: [],
      discard: ["9S"],
      hands: { A: ["3H"], B: ["4S", "3D"], C: ["3C", "4C"] },
      exact: ["A", "B", "C"],
    });
    state = draw(state, "A").state;
    expect(state.roundsWithoutPlay).toBe(1);
    state = play(state, "B", ["4S"]).state;
    expect(state.roundsWithoutPlay).toBe(0);
    // 9S is under 4S again: C's draw reshuffles it, so the table is not exhausted yet.
    state = draw(state, "C").state;
    expect(state.hands["C"]).toContain("9S");
    expect(state.roundsWithoutPlay).toBe(0);
    state = draw(state, "A").state;
    state = draw(state, "B").state;
    expect(state.status).toBe("PLAYING");
    const end = draw(state, "C");
    expect(end.state.status).toBe("FINISHED");
    // A and B both have 1 card: draw.
    expect(end.events.at(-1)).toMatchObject({ result: "DRAW", winnerId: null, reason: "BLOCKED" });
  });
});
