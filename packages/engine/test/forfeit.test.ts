import { describe, expect, it } from "vitest";
import {
  applyCheckCall,
  applyDraw,
  applyForfeit,
  applyPlay,
  applyTimeout,
  setConnected,
  type Card,
  type GameState,
} from "../src/index.js";
import { LATER, NOW, expectError, makeState, rng, top, type MakeStateInput } from "./helpers.js";

const T30 = NOW + 30_000;
const T60 = NOW + 60_000;

function play(state: GameState, playerId: string, cards: Card[], at = LATER) {
  return applyPlay(state, playerId, { cards }, rng(), at);
}

function timeout(state: GameState, at: number) {
  return applyTimeout(state, rng(), at);
}

/** CH2: A (2 cards) played 9H without announcing "Check"; B to play. */
function afterCH2(extra: MakeStateInput = {}): GameState {
  const state = makeState({ hands: { A: ["9H", "KC"] }, exact: ["A"], ...extra });
  return play(state, "A", ["9H"], NOW).state;
}

describe("ENG-09 — R. Temps écoulé", () => {
  it("R3 — pén 0, applyTimeout : A reçoit 1 carte, raison TIMEOUT, tour de B, missedTurns[A] = 1", () => {
    const { state, events } = timeout(makeState(), T30);
    expect(state.hands["A"]).toHaveLength(6);
    expect(state.currentPlayerId).toBe("B");
    expect(state.missedTurns["A"]).toBe(1);
    expect(state.turnDeadline).toBe(T30 + 30_000);
    expect(events[0]).toMatchObject({
      t: "CARDS_DRAWN",
      playerId: "A",
      count: 1,
      reason: "TIMEOUT",
      nextPlayerId: "B",
    });
  });

  it("R4 — pén 4, applyTimeout : A reçoit 4 cartes, tour de B", () => {
    const state = makeState({ penalty: 4, discard: ["5H", "XR"], openColor: "R" });
    const { state: next } = timeout(state, T30);
    expect(next.hands["A"]).toHaveLength(9);
    expect(next.penalty).toBe(0);
    expect(next.currentPlayerId).toBe("B");
  });

  it("R5 — missedTurns[A] = 2, applyTimeout : A pioche d'abord, puis forfait (PLAYER_FORFEIT, raison TIMEOUTS)", () => {
    const state = makeState();
    state.missedTurns["A"] = 2;
    const { state: next, events } = timeout(state, T30);
    expect(events.map((e) => e.t)).toEqual(["CARDS_DRAWN", "YOU_DREW", "PLAYER_FORFEIT"]);
    expect(events[0]).toMatchObject({
      playerId: "A",
      count: 1,
      reason: "TIMEOUT",
      nextPlayerId: "B",
    });
    expect(events[2]).toMatchObject({ playerId: "A", reason: "TIMEOUTS", nextPlayerId: "B" });
    expect(next.forfeited).toEqual(["A"]);
    expect(next.hands["A"]).toEqual([]);
    // The 6 cards (5 + the one drawn) went under the deck.
    expect(next.deck).toHaveLength(state.deck.length - 1 + 6);
    expect(next.currentPlayerId).toBe("B");
  });

  it("applyTimeout avant l'échéance ne fait rien (idempotent)", () => {
    const state = makeState();
    const result = timeout(state, T30 - 1);
    expect(result.state).toBe(state);
    expect(result.events).toEqual([]);
  });

  it("applyTimeout sur une partie terminée ne fait rien", () => {
    const state = { ...makeState(), status: "FINISHED" as const };
    expect(timeout(state, T30).events).toEqual([]);
  });

  it("CH7 — suite de CH2, temps de B écoulé (action automatique) : fenêtre fermée", () => {
    const state = afterCH2();
    const { state: next, events } = timeout(state, state.turnDeadline);
    expect(next.checkWindow).toBeNull();
    expect(events[0]).toEqual({ t: "CHECK_WINDOW", targetId: null });
    expectError(() => applyCheckCall(next, "C", "A", rng()), "NO_CHECK_TO_CALL");
  });
});

describe("ENG-09 — F. Déconnexions et forfaits", () => {
  it("F1 — tour de A commencé à t0, A se déconnecte à t0 + 10 s : turnDeadline = t0 + 60 s", () => {
    const { state, events } = setConnected(makeState(), "A", false, NOW + 10_000);
    expect(state.turnDeadline).toBe(T60);
    expect(state.connected["A"]).toBe(false);
    expect(events).toEqual([{ t: "PLAYER_CONNECTION", playerId: "A", connected: false }]);
  });

  it("F2 — suite de F1, A toujours absent à t0 + 60 s : action automatique, tour de B", () => {
    const disconnected = setConnected(makeState(), "A", false, NOW + 10_000).state;
    expect(timeout(disconnected, T30).events).toEqual([]);
    const { state } = timeout(disconnected, T60);
    expect(state.hands["A"]).toHaveLength(6);
    expect(state.currentPlayerId).toBe("B");
  });

  it("F3 — A toujours déconnecté, son tour revient : action automatique immédiate", () => {
    let state = setConnected(makeState(), "A", false, NOW + 10_000).state;
    state = timeout(state, T60).state; // A's 1st automatic action
    state = applyDraw(state, "B", rng(), T60 + 1_000).state;
    const at = T60 + 2_000;
    state = applyDraw(state, "C", rng(), at).state;
    // A's turn starts already expired: the RoomDO runs the automatic action at once.
    expect(state.currentPlayerId).toBe("A");
    expect(state.turnDeadline).toBe(at);
    const { state: next } = timeout(state, at);
    expect(next.missedTurns["A"]).toBe(2);
    expect(next.currentPlayerId).toBe("B");
  });

  it("F4 — A déconnecté depuis 3 tours, 3e action automatique : forfait de A (raison DISCONNECTED)", () => {
    const state = setConnected(makeState(), "A", false, NOW + 10_000).state;
    state.missedTurns["A"] = 2;
    const { state: next, events } = timeout(state, T60);
    expect(events.at(-1)).toMatchObject({
      t: "PLAYER_FORFEIT",
      playerId: "A",
      reason: "DISCONNECTED",
    });
    expect(next.forfeited).toEqual(["A"]);
  });

  it("F5 — A reconnecté pendant son tour : le turnDeadline en cours est conservé", () => {
    const disconnected = setConnected(makeState(), "A", false, NOW + 10_000).state;
    const { state, events } = setConnected(disconnected, "A", true, NOW + 20_000);
    expect(state.turnDeadline).toBe(T60);
    expect(state.connected["A"]).toBe(true);
    expect(events).toEqual([{ t: "PLAYER_CONNECTION", playerId: "A", connected: true }]);
  });

  it("F6 — forfait de A (5 cartes) : ses cartes vont sous la pioche ; talon inchangé ; A retiré de la rotation", () => {
    const state = makeState({ current: "B", hands: { B: ["9H"] } });
    const hand = state.hands["A"] ?? [];
    const { state: next, events } = applyForfeit(state, "A", "LEFT", LATER);
    expect(next.deck).toEqual([...state.deck, ...hand]);
    expect(next.discard).toEqual(state.discard);
    expect(next.hands["A"]).toEqual([]);
    expect(next.currentPlayerId).toBe("B");
    expect(next.turnDeadline).toBe(state.turnDeadline);
    expect(events).toEqual([
      { t: "PLAYER_FORFEIT", playerId: "A", reason: "LEFT", nextPlayerId: "B", turnDeadline: T30 },
    ]);
    // After B, the turn goes to C, then back to B: A is skipped.
    const afterB = play(next, "B", ["9H"]).state;
    expect(afterB.currentPlayerId).toBe("C");
    expect(applyDraw(afterB, "C", rng(), LATER).state.currentPlayerId).toBe("B");
  });

  it("F7 — pén 4 visant B, B abandonne : pén annulée, tour de C sans pénalité", () => {
    const state = makeState({ current: "B", penalty: 4, discard: ["5H", "XR"], openColor: "R" });
    const { state: next, events } = applyForfeit(state, "B", "LEFT", LATER);
    expect(next.penalty).toBe(0);
    expect(next.currentPlayerId).toBe("C");
    expect(next.turnDeadline).toBe(LATER + 30_000);
    expect(next.openColor).toBe("R");
    expect(events[0]).toMatchObject({ nextPlayerId: "C", turnDeadline: LATER + 30_000 });
  });

  it("F8 — tour de A, A abandonne : tour de B", () => {
    const { state } = applyForfeit(makeState(), "A", "LEFT", LATER);
    expect(state.currentPlayerId).toBe("B");
  });

  it("F9 — tour de B, A connecté ; A se déconnecte, puis B joue (tour de A) : action automatique immédiate", () => {
    let state = makeState({ n: 2, current: "B", hands: { B: ["9H"] } });
    const disconnected = setConnected(state, "A", false, NOW + 5_000);
    expect(disconnected.state.turnDeadline).toBe(T30); // B's turn is not extended
    state = play(disconnected.state, "B", ["9H"], NOW + 8_000).state;
    expect(state.currentPlayerId).toBe("A");
    expect(state.turnDeadline).toBe(NOW + 8_000);
    const { state: next } = timeout(state, NOW + 8_000);
    expect(next.hands["A"]).toHaveLength(6);
    expect(next.currentPlayerId).toBe("B");
    expect(next.turnDeadline).toBe(NOW + 8_000 + 30_000);
  });
});

describe("ENG-09 — abandon : fenêtre de dénonciation et victoire", () => {
  it("CH12 — suite de CH2, 4 joueurs, D abandonne : fenêtre toujours ouverte ; C peut dénoncer A", () => {
    const state = afterCH2({ n: 4 });
    const { state: next } = applyForfeit(state, "D", "LEFT", LATER);
    expect(next.checkWindow).toEqual({ targetId: "A" });
    expect(applyCheckCall(next, "C", "A", rng()).state.hands["A"]).toHaveLength(3);
  });

  it("CH13 — suite de CH2, A abandonne : fenêtre fermée", () => {
    const { state, events } = applyForfeit(afterCH2(), "A", "LEFT", LATER);
    expect(state.checkWindow).toBeNull();
    expect(events).toContainEqual({ t: "CHECK_WINDOW", targetId: null });
  });

  it("W12 — B et C abandonnent : victoire de A, raison LAST_PLAYER", () => {
    let state = makeState();
    state = applyForfeit(state, "B", "LEFT", LATER).state;
    const { state: end, events } = applyForfeit(state, "C", "LEFT", LATER);
    expect(end.status).toBe("FINISHED");
    expect(events.at(-1)).toMatchObject({
      t: "GAME_OVER",
      result: "WIN",
      winnerId: "A",
      reason: "LAST_PLAYER",
    });
  });

  it("W13 — 3 joueurs, C abandonne, puis A n'a que AH : ACE_FINISH_FORBIDDEN (N = 2 au moment de la pose)", () => {
    const state = makeState({ hands: { A: ["AH"] }, exact: ["A"] });
    const { state: next } = applyForfeit(state, "C", "LEFT", LATER);
    expectError(() => play(next, "A", ["AH"]), "ACE_FINISH_FORBIDDEN");
  });

  it("l'abandon du joueur courant lui retire aussi sa marque « Check »", () => {
    const state = makeState({ current: "B", hands: { A: ["KC"] }, exact: ["A"] });
    state.checkDeclared = ["A"];
    expect(applyForfeit(state, "A", "LEFT", LATER).state.checkDeclared).toEqual([]);
  });

  it("le tour passe au joueur suivant de celui qui abandonne, même s'il est déconnecté", () => {
    let state = setConnected(makeState(), "B", false, NOW).state;
    state = applyForfeit(state, "A", "LEFT", LATER).state;
    expect(state.currentPlayerId).toBe("B");
    expect(state.turnDeadline).toBe(LATER);
  });

  it("abandonner deux fois, ou après la fin, ne change rien", () => {
    const once = applyForfeit(makeState(), "B", "LEFT", LATER).state;
    const twice = applyForfeit(once, "B", "LEFT", LATER);
    expect(twice.state).toBe(once);
    expect(twice.events).toEqual([]);
    const finished = { ...makeState(), status: "FINISHED" as const };
    expect(applyForfeit(finished, "B", "LEFT", LATER).events).toEqual([]);
  });

  it("applyForfeit ne modifie pas l'état reçu", () => {
    const state = makeState();
    const before = JSON.parse(JSON.stringify(state)) as unknown;
    applyForfeit(state, "A", "LEFT", LATER);
    expect(state).toEqual(before);
  });
});

describe("ENG-09 — setConnected : cas limites", () => {
  it("un état déjà à jour, un joueur inconnu ou sorti : aucun événement", () => {
    const state = makeState({ forfeited: ["C"] });
    expect(setConnected(state, "A", true, LATER).events).toEqual([]);
    expect(setConnected(state, "Z", false, LATER).events).toEqual([]);
    expect(setConnected(state, "C", false, LATER).events).toEqual([]);
  });

  it("une déconnexion tardive ne raccourcit jamais l'échéance", () => {
    const state = makeState({ config: { turnSeconds: 60, disconnectGraceSeconds: 45 } });
    state.turnDeadline = NOW + 60_000;
    expect(setConnected(state, "A", false, LATER).state.turnDeadline).toBe(state.turnDeadline);
  });

  it("une déconnexion pendant la partie terminée est notée sans changer d'échéance", () => {
    const state = { ...makeState(), status: "FINISHED" as const };
    const { state: next, events } = setConnected(state, "A", false, LATER);
    expect(next.turnDeadline).toBe(state.turnDeadline);
    expect(events).toHaveLength(1);
  });

  it("un forfait ne change pas la carte visible", () => {
    const state = makeState({ current: "B" });
    expect(top(applyForfeit(state, "A", "LEFT", LATER).state)).toBe("5H");
  });
});

describe("ENG-09 — temps écoulé qui termine la partie", () => {
  it("à 2 joueurs, le 3e tour manqué de A donne la victoire à B (LAST_PLAYER)", () => {
    const state = makeState({ n: 2 });
    state.missedTurns["A"] = 2;
    const { state: end, events } = timeout(state, T30);
    expect(end.status).toBe("FINISHED");
    expect(events[0]).toMatchObject({ t: "CARDS_DRAWN", nextPlayerId: null, turnDeadline: null });
    expect(events.at(-1)).toMatchObject({ t: "GAME_OVER", winnerId: "B", reason: "LAST_PLAYER" });
  });

  it("un temps écoulé peut compléter le tour de table du blocage (BLOCKED)", () => {
    let state = makeState({
      deck: [],
      discard: ["9S"],
      hands: { A: ["3H"], B: ["3D", "4D"], C: ["3C", "4C"] },
      exact: ["A", "B", "C"],
    });
    state = applyDraw(state, "A", rng(), LATER).state;
    state = applyDraw(state, "B", rng(), LATER).state;
    const { state: end, events } = timeout(state, state.turnDeadline);
    expect(end.status).toBe("FINISHED");
    expect(events[0]).toMatchObject({ t: "CARDS_DRAWN", reason: "TIMEOUT", nextPlayerId: null });
    expect(events.at(-1)).toMatchObject({ result: "WIN", winnerId: "A", reason: "BLOCKED" });
  });

  it("une déconnexion après l'échéance ne prolonge pas le tour (l'action automatique est due)", () => {
    const { state } = setConnected(makeState(), "A", false, T30 + 1);
    expect(state.turnDeadline).toBe(T30);
  });
});
