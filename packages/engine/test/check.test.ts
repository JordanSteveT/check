import { describe, expect, it } from "vitest";
import {
  applyCheckCall,
  applyDraw,
  applyPlay,
  createSeededRng,
  type Card,
  type GameState,
  type PlayInput,
} from "../src/index.js";
import { LATER, expectError, makeState, type MakeStateInput } from "./helpers.js";

const rng = () => createSeededRng(1);

function play(state: GameState, playerId: string, cards: Card[], declareCheck?: boolean) {
  const input: PlayInput = declareCheck === undefined ? { cards } : { cards, declareCheck };
  return applyPlay(state, playerId, input, rng(), LATER);
}

function call(state: GameState, callerId: string, targetId: string) {
  return applyCheckCall(state, callerId, targetId, rng());
}

/** A holds exactly 2 cards: 9H (playable on 5H) and KC. */
function aWithTwo(extra: MakeStateInput = {}): GameState {
  return makeState({ hands: { A: ["9H", "KC"], B: ["9D"] }, exact: ["A"], ...extra });
}

/** CH2: A played 9H without announcing "Check"; B to play. */
function afterCH2(extra: MakeStateInput = {}): GameState {
  return play(aWithTwo(extra), "A", ["9H"]).state;
}

describe("ENG-07 — CH. Annonce « Check »", () => {
  it("CH1 — A a 2 cartes, joue 1 carte avec declareCheck : OK, A marqué « Check », aucune fenêtre", () => {
    const { state, events } = play(aWithTwo(), "A", ["9H"], true);
    expect(state.checkDeclared).toEqual(["A"]);
    expect(state.checkWindow).toBeNull();
    expect(events.map((e) => e.t)).toEqual(["CARDS_PLAYED"]);
    expect(events[0]).toMatchObject({ checkDeclared: true, handCount: 1 });
  });

  it("CH2 — A a 2 cartes, joue 1 carte sans declareCheck : fenêtre ouverte (CHECK_WINDOW cible A)", () => {
    const { state, events } = play(aWithTwo(), "A", ["9H"]);
    expect(state.checkWindow).toEqual({ targetId: "A" });
    expect(state.checkDeclared).toEqual([]);
    expect(events).toContainEqual({ t: "CHECK_WINDOW", targetId: "A" });
    expect(events[0]).toMatchObject({ t: "CARDS_PLAYED", checkDeclared: false });
  });

  it("CH3 — suite de CH2, avant toute action de B, C CALL_CHECK A : A reçoit 2 cartes, CHECK_CALLED, fenêtre fermée, le tour reste à B", () => {
    const before = afterCH2();
    const { state, events } = call(before, "C", "A");
    expect(state.hands["A"]).toHaveLength(3);
    expect(state.checkWindow).toBeNull();
    expect(state.currentPlayerId).toBe("B");
    expect(state.turnDeadline).toBe(before.turnDeadline);
    expect(events).toEqual([
      { t: "CHECK_CALLED", callerId: "C", targetId: "A", penalty: 2 },
      {
        t: "CARDS_DRAWN",
        playerId: "A",
        count: 2,
        reason: "CHECK_PENALTY",
        handCount: 3,
        deckCount: before.deck.length - 2,
        nextPlayerId: "B",
        turnDeadline: before.turnDeadline,
      },
      { t: "YOU_DREW", playerId: "A", cards: before.deck.slice(0, 2) },
      { t: "CHECK_WINDOW", targetId: null },
    ]);
  });

  it("CH4 — suite de CH2, B joue un coup valide, puis C CALL_CHECK : NO_CHECK_TO_CALL", () => {
    const { state, events } = play(afterCH2(), "B", ["9D"]);
    expect(state.checkWindow).toBeNull();
    expect(events[0]).toEqual({ t: "CHECK_WINDOW", targetId: null });
    expectError(() => call(state, "C", "A"), "NO_CHECK_TO_CALL");
  });

  it("CH5 — suite de CH2, C puis B CALL_CHECK : seul C compte ; B reçoit NO_CHECK_TO_CALL", () => {
    const { state } = call(afterCH2(), "C", "A");
    expectError(() => call(state, "B", "A"), "NO_CHECK_TO_CALL");
    expect(state.hands["A"]).toHaveLength(3);
  });

  it("CH6 — suite de CH2, A CALL_CHECK A : NO_CHECK_TO_CALL (seul un adversaire peut dénoncer)", () => {
    expectError(() => call(afterCH2(), "A", "A"), "NO_CHECK_TO_CALL");
  });

  it("CH8 — 2 joueurs, A a 2 cartes, joue AH sans annoncer : fenêtre ouverte jusqu'à la prochaine action de A ; B peut dénoncer", () => {
    const start = makeState({ n: 2, hands: { A: ["AH", "KC"] }, exact: ["A"] });
    const { state } = play(start, "A", ["AH"]);
    expect(state.currentPlayerId).toBe("A");
    expect(state.checkWindow).toEqual({ targetId: "A" });
    // B calls during the window: A takes 2 cards and keeps the turn.
    const called = call(state, "B", "A").state;
    expect(called.hands["A"]).toHaveLength(3);
    expect(called.currentPlayerId).toBe("A");
    // Without a call, A's next action closes the window.
    const drawn = applyDraw(state, "A", rng(), LATER).state;
    expect(drawn.checkWindow).toBeNull();
    expectError(() => call(drawn, "B", "A"), "NO_CHECK_TO_CALL");
  });

  it("CH9 — A a 3 cartes de même valeur, les pose ensemble : victoire, aucune annonce requise", () => {
    const state = makeState({ discard: ["8H"], hands: { A: ["8S", "8D", "8C"] }, exact: ["A"] });
    const { state: next, events } = play(state, "A", ["8S", "8D", "8C"]);
    expect(next.status).toBe("FINISHED");
    expect(next.checkWindow).toBeNull();
    expect(events.map((e) => e.t)).toEqual(["CARDS_PLAYED", "GAME_OVER"]);
  });

  it("CH10 — A marqué « Check », A pioche (sa main passe à 2) : marque « Check » retirée", () => {
    const state = makeState({ hands: { A: ["KC"] }, exact: ["A"] });
    state.checkDeclared = ["A"];
    const { state: next } = applyDraw(state, "A", rng(), LATER);
    expect(next.hands["A"]).toHaveLength(2);
    expect(next.checkDeclared).toEqual([]);
  });

  it("CH11 — declareCheck envoyé alors que la main ne passe pas à 1 carte : OK, declareCheck ignoré", () => {
    const { state, events } = play(makeState({ hands: { A: ["9H"] } }), "A", ["9H"], true);
    expect(state.checkDeclared).toEqual([]);
    expect(state.checkWindow).toBeNull();
    expect(events[0]).toMatchObject({ checkDeclared: false });
  });
});

describe("ENG-07 — fenêtre de dénonciation : cas complémentaires", () => {
  it("la pioche du joueur suivant ferme la fenêtre", () => {
    const { state, events } = applyDraw(afterCH2(), "B", rng(), LATER);
    expect(state.checkWindow).toBeNull();
    expect(events[0]).toEqual({ t: "CHECK_WINDOW", targetId: null });
  });

  it("dénoncer un autre joueur que la cible : NO_CHECK_TO_CALL", () => {
    expectError(() => call(afterCH2(), "C", "B"), "NO_CHECK_TO_CALL");
  });

  it("un joueur sorti ne peut pas dénoncer", () => {
    const state = afterCH2({ n: 4, forfeited: ["D"] });
    expectError(() => call(state, "D", "A"), "NO_CHECK_TO_CALL");
    expectError(() => call(state, "Z", "A"), "NO_CHECK_TO_CALL");
  });

  it("aucune dénonciation une fois la partie terminée", () => {
    const state = { ...afterCH2(), status: "FINISHED" as const };
    expectError(() => call(state, "C", "A"), "NO_CHECK_TO_CALL");
  });

  it("le joueur qui a dénoncé n'a pas besoin que ce soit son tour, et la pénalité suit check_call.penalty", () => {
    const state = afterCH2({
      config: { checkCall: { enabled: true, penalty: 3, mode: "denunciation" } },
    });
    const { state: next, events } = call(state, "C", "A");
    expect(next.hands["A"]).toHaveLength(4);
    expect(events[0]).toEqual({ t: "CHECK_CALLED", callerId: "C", targetId: "A", penalty: 3 });
  });

  it("mode « automatic » : la pénalité est appliquée d'office, sans fenêtre", () => {
    const state = aWithTwo({
      config: { checkCall: { enabled: true, penalty: 2, mode: "automatic" } },
    });
    const { state: next, events } = play(state, "A", ["9H"]);
    expect(next.hands["A"]).toHaveLength(3);
    expect(next.checkWindow).toBeNull();
    expect(next.currentPlayerId).toBe("B");
    expect(events.map((e) => e.t)).toEqual(["CARDS_PLAYED", "CARDS_DRAWN", "YOU_DREW"]);
    expect(events[1]).toMatchObject({
      playerId: "A",
      count: 2,
      reason: "CHECK_PENALTY",
      nextPlayerId: "B",
    });
  });

  it("mode « automatic » : aucune pénalité si l'annonce est faite", () => {
    const state = aWithTwo({
      config: { checkCall: { enabled: true, penalty: 2, mode: "automatic" } },
    });
    expect(play(state, "A", ["9H"], true).state.hands["A"]).toHaveLength(1);
  });

  it("check_call.enabled = false : ni fenêtre ni pénalité", () => {
    const state = aWithTwo({
      config: { checkCall: { enabled: false, penalty: 2, mode: "denunciation" } },
    });
    const { state: next, events } = play(state, "A", ["9H"]);
    expect(next.checkWindow).toBeNull();
    expect(next.hands["A"]).toHaveLength(1);
    expect(events.map((e) => e.t)).toEqual(["CARDS_PLAYED"]);
  });

  it("une nouvelle fenêtre remplace l'ancienne quand le joueur suivant oublie à son tour", () => {
    const state = afterCH2({ hands: { A: ["9H", "KC"], B: ["9D", "QD"] }, exact: ["A", "B"] });
    const { state: next, events } = play(state, "B", ["9D"]);
    expect(next.checkWindow).toEqual({ targetId: "B" });
    expect(events.map((e) => e.t)).toEqual(["CHECK_WINDOW", "CARDS_PLAYED", "CHECK_WINDOW"]);
  });
});
