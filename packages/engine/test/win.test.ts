import { describe, expect, it } from "vitest";
import { applyDraw, applyPlay, type Card, type GameState, type Suit } from "../src/index.js";
import { LATER, expectError, makeState, rng, type MakeStateInput } from "./helpers.js";

function play(state: GameState, playerId: string, cards: Card[], suit?: Suit) {
  return applyPlay(state, playerId, suit === undefined ? { cards } : { cards, suit }, rng(), LATER);
}

/** A holds exactly `cards`; other players are padded to 5 cards. */
function aOnly(cards: Card[], extra: MakeStateInput = {}): GameState {
  return makeState({ hands: { A: cards }, exact: ["A"], ...extra });
}

function expectWin(result: ReturnType<typeof play>, winnerId = "A") {
  expect(result.state.status).toBe("FINISHED");
  expect(result.events.at(-1)).toMatchObject({
    t: "GAME_OVER",
    result: "WIN",
    winnerId,
    reason: "EMPTY_HAND",
  });
}

describe("ENG-08 — W. Victoire", () => {
  it("W1 — A a 1 carte ordinaire jouable, la joue : GAME_OVER WIN, A, raison EMPTY_HAND", () => {
    const result = play(aOnly(["9H"]), "A", ["9H"]);
    expectWin(result);
    expect(result.events.map((e) => e.t)).toEqual(["CARDS_PLAYED", "GAME_OVER"]);
    expect(result.events[0]).toMatchObject({
      handCount: 0,
      nextPlayerId: null,
      turnDeadline: null,
    });
    expect(result.events[1]).toMatchObject({ hands: { A: [] } });
  });

  it("W2 — 3 joueurs, dernière carte de A 7H : victoire immédiate de A ; B ne pioche pas", () => {
    const result = play(aOnly(["7H"]), "A", ["7H"]);
    expectWin(result);
    expect(result.state.penalty).toBe(0);
    expect(result.state.hands["B"]).toHaveLength(5);
  });

  it("W3 — 2 joueurs, dernière carte de A 7H : victoire immédiate ; B ne pioche pas et ne peut pas contrer", () => {
    const result = play(aOnly(["7H"], { n: 2, hands: { A: ["7H"], B: ["7S"] } }), "A", ["7H"]);
    expectWin(result);
    expect(result.state.penalty).toBe(0);
    expect(result.state.hands["B"]).toHaveLength(5);
    expectError(() => play(result.state, "B", ["7S"]), "NOT_YOUR_TURN");
    expectError(() => applyDraw(result.state, "B", rng(), LATER), "NOT_YOUR_TURN");
  });

  it("W4 — 2 joueurs, dernière carte de A XR : victoire immédiate de A", () => {
    const result = play(aOnly(["XR"], { n: 2 }), "A", ["XR"]);
    expectWin(result);
    expect(result.state.penalty).toBe(0);
  });

  it("W5 — 2 joueurs, A n'a plus que 7H et XB, pose [7H, XB] : victoire immédiate de A", () => {
    expectWin(play(aOnly(["7H", "XB"], { n: 2 }), "A", ["7H", "XB"]));
  });

  it("W6 — 2 joueurs, A n'a que AH, joue AH : ACE_FINISH_FORBIDDEN ; A doit piocher", () => {
    const state = aOnly(["AH"], { n: 2 });
    expectError(() => play(state, "A", ["AH"]), "ACE_FINISH_FORBIDDEN");
    const { state: next } = applyDraw(state, "A", rng(), LATER);
    expect(next.hands["A"]).toHaveLength(2);
    expect(next.currentPlayerId).toBe("B");
  });

  it("W7 — 2 joueurs, A a AH et 5H, talon 9H : A joue AH, puis 5H ; A rejoue après l'As, puis gagne", () => {
    const after = play(aOnly(["AH", "5H"], { n: 2, discard: ["9H"] }), "A", ["AH"], undefined);
    expect(after.state.currentPlayerId).toBe("A");
    expectWin(play(after.state, "A", ["5H"]));
  });

  it("W8 — 3 joueurs, A n'a que AH, joue AH : victoire de A", () => {
    expectWin(play(aOnly(["AH"]), "A", ["AH"]));
  });

  it("W9 — A n'a que JS, joue JS sans couleur : victoire (pas de couleur exigée sur la dernière carte)", () => {
    const result = play(aOnly(["JS"]), "A", ["JS"]);
    expectWin(result);
    expect(result.state.requestedSuit).toBeNull();
  });

  it("W10 — 2 joueurs, R4 décochée, A n'a que AH, joue AH : victoire de A", () => {
    expectWin(play(aOnly(["AH"], { n: 2, options: { ace_skips: false } }), "A", ["AH"]));
  });

  it("W11 — 2 joueurs, A n'a plus que 2H (R1 cochée), le joue : victoire immédiate de A", () => {
    expectWin(play(aOnly(["2H"], { n: 2, discard: ["9S"] }), "A", ["2H"]));
  });

  it("W13 — 3 joueurs, C a abandonné, A n'a que AH : ACE_FINISH_FORBIDDEN (N = 2 au moment de la pose)", () => {
    // State right after C's abandonment (the abandonment itself is tested with ENG-09).
    const state = aOnly(["AH"], { forfeited: ["C"] });
    expectError(() => play(state, "A", ["AH"]), "ACE_FINISH_FORBIDDEN");
  });

  it("W14 — 2 joueurs, A n'a plus que AH et AS, pose [AH, AS] : ACE_FINISH_FORBIDDEN", () => {
    expectError(
      () => play(aOnly(["AH", "AS"], { n: 2 }), "A", ["AH", "AS"]),
      "ACE_FINISH_FORBIDDEN",
    );
  });
});

describe("ENG-08 — As en duel : cas complémentaires", () => {
  it("à 2 joueurs, des As qui ne vident pas la main restent permis", () => {
    const { state, events } = play(aOnly(["AH", "AS", "5H"], { n: 2 }), "A", ["AH", "AS"]);
    expect(state.status).toBe("PLAYING");
    // Formula (i + 1 + k) mod N with k = 2, N = 2: B plays.
    expect(state.currentPlayerId).toBe("B");
    expect(events[0]).toMatchObject({ skipped: ["B", "A"] });
  });

  it("win.forbid_finish_on_ace_in_duel = false : finir sur un As en duel est permis", () => {
    const state = aOnly(["AH"], { n: 2, config: { forbidFinishOnAceInDuel: false } });
    expectWin(play(state, "A", ["AH"]));
  });

  it("la carte illégale reste ILLEGAL_PLAY même si c'est un As en dernière carte", () => {
    expectError(() => play(aOnly(["AS"], { n: 2 }), "A", ["AS"]), "ILLEGAL_PLAY");
  });

  it("le joueur suivant gagne aussi en posant sa dernière carte", () => {
    const state = makeState({ current: "B", hands: { B: ["9H"] }, exact: ["B"] });
    expectWin(play(state, "B", ["9H"]), "B");
  });
});
