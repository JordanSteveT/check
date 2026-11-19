import { describe, expect, it } from "vitest";
import { applyPlay, canPlayCard, type Card, type GameState, type Suit } from "../src/index.js";
import { LATER, rng, expectError, makeState, top } from "./helpers.js";

function play(state: GameState, playerId: string, cards: Card[], suit?: Suit) {
  return applyPlay(state, playerId, suit === undefined ? { cards } : { cards, suit }, rng(), LATER);
}

describe("ENG-03 — P. Pose standard", () => {
  it("P1 — talon 5H, A joue 9H : OK (même enseigne), tour de B", () => {
    const { state } = play(makeState({ hands: { A: ["9H"] } }), "A", ["9H"]);
    expect(top(state)).toBe("9H");
    expect(state.currentPlayerId).toBe("B");
    expect(state.hands["A"]).not.toContain("9H");
    expect(state.hands["A"]).toHaveLength(4);
  });

  it("P2 — talon 5H, A joue 5S : OK (même valeur)", () => {
    const { state } = play(makeState({ hands: { A: ["5S"] } }), "A", ["5S"]);
    expect(top(state)).toBe("5S");
  });

  it("P3 — talon 5H, A joue 9S : ILLEGAL_PLAY", () => {
    expectError(() => play(makeState({ hands: { A: ["9S"] } }), "A", ["9S"]), "ILLEGAL_PLAY");
  });

  it("P4 — A n'a pas 9H : CARD_NOT_IN_HAND", () => {
    expectError(() => play(makeState(), "A", ["9H"]), "CARD_NOT_IN_HAND");
  });

  it("P5 — tour de A, B joue une carte : NOT_YOUR_TURN", () => {
    expectError(() => play(makeState({ hands: { B: ["9H"] } }), "B", ["9H"]), "NOT_YOUR_TURN");
  });

  it("P6 — talon KH, A joue QH : OK ; Dame et Roi sans effet", () => {
    const { state } = play(makeState({ discard: ["KH"], hands: { A: ["QH"] } }), "A", ["QH"]);
    expect(top(state)).toBe("QH");
    expect(state.penalty).toBe(0);
    expect(state.requestedSuit).toBeNull();
    expect(state.openColor).toBeNull();
    expect(state.currentPlayerId).toBe("B");
  });

  it("P7 — talon 7S déjà encaissé (pén 0), A joue 3S : OK, aucune pénalité", () => {
    const { state } = play(makeState({ discard: ["7S"], hands: { A: ["3S"] } }), "A", ["3S"]);
    expect(state.penalty).toBe(0);
  });

  it("P8 — talon 7S déjà encaissé, A joue 7H : OK (valeur), nouvelle pén 2 pour B", () => {
    const { state } = play(makeState({ discard: ["7S"], hands: { A: ["7H"] } }), "A", ["7H"]);
    expect(state.penalty).toBe(2);
    expect(state.currentPlayerId).toBe("B");
  });

  it("P9 — coup valide : turnDeadline = now + 30 s pour B ; CARDS_PLAYED émis", () => {
    const { state, events } = play(makeState({ hands: { A: ["9H"] } }), "A", ["9H"]);
    expect(state.turnStartedAt).toBe(LATER);
    expect(state.turnDeadline).toBe(LATER + 30_000);
    expect(events).toEqual([
      {
        t: "CARDS_PLAYED",
        playerId: "A",
        cards: ["9H"],
        topCard: "9H",
        requestedSuit: null,
        openColor: null,
        penalty: 0,
        skipped: [],
        handCount: 4,
        checkDeclared: false,
        nextPlayerId: "B",
        turnDeadline: LATER + 30_000,
      },
    ]);
  });
});

describe("ENG-03 — V. Valet (R2 « commande », R3 « passe partout »)", () => {
  it("V1 — talon 5H, A joue JS couleur D : OK, dem = D, tour de B", () => {
    const { state } = play(makeState({ hands: { A: ["JS"] } }), "A", ["JS"], "D");
    expect(state.requestedSuit).toBe("D");
    expect(top(state)).toBe("JS");
    expect(state.currentPlayerId).toBe("B");
  });

  it("V2 — talon 5H, A joue JS sans couleur : SUIT_REQUIRED", () => {
    expectError(() => play(makeState({ hands: { A: ["JS"] } }), "A", ["JS"]), "SUIT_REQUIRED");
  });

  const demD = (extra: Parameters<typeof makeState>[0] = {}) =>
    makeState({ discard: ["5H", "JS"], requestedSuit: "D", current: "B", ...extra });

  it("V3 — dem D (talon JS), B joue 9D : OK, dem effacée", () => {
    const { state } = play(demD({ hands: { B: ["9D"] } }), "B", ["9D"]);
    expect(state.requestedSuit).toBeNull();
    expect(top(state)).toBe("9D");
  });

  it("V4 — dem D (talon JS), B joue 9S : ILLEGAL_PLAY (la couleur demandée remplace l'enseigne)", () => {
    expectError(() => play(demD({ hands: { B: ["9S"] } }), "B", ["9S"]), "ILLEGAL_PLAY");
  });

  it("V5 — dem D, B joue JH couleur C : OK, dem = C", () => {
    const { state } = play(demD({ hands: { B: ["JH"] } }), "B", ["JH"], "C");
    expect(state.requestedSuit).toBe("C");
  });

  it("V6 — dem D, R7 cochée, B joue XB : OK", () => {
    const { state } = play(demD({ hands: { B: ["XB"] } }), "B", ["XB"]);
    expect(top(state)).toBe("XB");
    expect(state.requestedSuit).toBeNull();
    expect(state.openColor).toBe("B");
  });

  it("V7 — dem D, R7 décochée : XR OK (rouge = carreau) ; XB ILLEGAL_PLAY", () => {
    const opts = { joker_wild: false };
    const { state } = play(demD({ hands: { B: ["XR"] }, options: opts }), "B", ["XR"]);
    expect(top(state)).toBe("XR");
    expectError(
      () => play(demD({ hands: { B: ["XB"] }, options: opts }), "B", ["XB"]),
      "ILLEGAL_PLAY",
    );
  });

  it("V8 — pén 2, B joue JC : MUST_COUNTER_OR_DRAW", () => {
    const state = makeState({ discard: ["7D"], penalty: 2, current: "B", hands: { B: ["JC"] } });
    expectError(() => play(state, "B", ["JC"], "H"), "MUST_COUNTER_OR_DRAW");
  });

  it("V9 — talon 5S, A joue JS couleur S : OK, dem = S", () => {
    const { state } = play(makeState({ discard: ["5S"], hands: { A: ["JS"] } }), "A", ["JS"], "S");
    expect(state.requestedSuit).toBe("S");
  });

  it("V10 — talon XR encaissé (ouv R), A joue JS couleur C : OK, ouv effacée, dem = C", () => {
    const state = makeState({ discard: ["5D", "XR"], openColor: "R", hands: { A: ["JS"] } });
    const { state: next } = play(state, "A", ["JS"], "C");
    expect(next.openColor).toBeNull();
    expect(next.requestedSuit).toBe("C");
  });

  it("V11 — R2 décochée, R3 cochée, talon 5H : A joue JS sans couleur, OK ; B doit jouer pique ou un Valet", () => {
    const state = makeState({
      options: { jack_commands: false },
      hands: { A: ["JS"], B: ["9S", "9H", "JD"] },
    });
    const { state: next } = play(state, "A", ["JS"]);
    expect(next.requestedSuit).toBeNull();
    expect(next.currentPlayerId).toBe("B");
    expect(canPlayCard(next, "9S")).toBe(true);
    expect(canPlayCard(next, "JD")).toBe(true);
    expect(canPlayCard(next, "9H")).toBe(false);
  });

  it("V12 — R2 cochée, R3 décochée : JS sur 5H ILLEGAL_PLAY ; sur 5S OK et couleur obligatoire", () => {
    const opts = { jack_wild: false };
    expectError(
      () => play(makeState({ options: opts, hands: { A: ["JS"] } }), "A", ["JS"], "D"),
      "ILLEGAL_PLAY",
    );
    const on5S = makeState({ options: opts, discard: ["5S"], hands: { A: ["JS"] } });
    expectError(() => play(on5S, "A", ["JS"]), "SUIT_REQUIRED");
    expect(play(on5S, "A", ["JS"], "H").state.requestedSuit).toBe("H");
  });

  it("V13 — R2 et R3 décochées, talon 5S : A joue JS sans couleur, OK, carte ordinaire", () => {
    const state = makeState({
      options: { jack_commands: false, jack_wild: false },
      discard: ["5S"],
      hands: { A: ["JS"] },
    });
    const { state: next } = play(state, "A", ["JS"]);
    expect(next.requestedSuit).toBeNull();
    expect(canPlayCard(next, "9S")).toBe(true);
    expect(canPlayCard(next, "JH")).toBe(true);
    expect(canPlayCard(next, "9H")).toBe(false);
  });
});

describe("ENG-03 — J. Joker (R6 « piquer 4 », R7 « passe partout »)", () => {
  it("J1 — talon 5S, A joue XR : OK, pén 4 pour B, ouv R", () => {
    const { state } = play(makeState({ discard: ["5S"], hands: { A: ["XR"] } }), "A", ["XR"]);
    expect(state.penalty).toBe(4);
    expect(state.openColor).toBe("R");
    expect(state.currentPlayerId).toBe("B");
  });

  it("J2 — R7 décochée : XR sur 5S ILLEGAL_PLAY ; sur 5H OK", () => {
    const opts = { joker_wild: false };
    expectError(
      () => play(makeState({ options: opts, discard: ["5S"], hands: { A: ["XR"] } }), "A", ["XR"]),
      "ILLEGAL_PLAY",
    );
    const { state } = play(makeState({ options: opts, hands: { A: ["XR"] } }), "A", ["XR"]);
    expect(top(state)).toBe("XR");
  });

  it("J3 — R7 décochée, talon 7S encaissé : XR OK (Joker sur un 7)", () => {
    const state = makeState({
      options: { joker_wild: false },
      discard: ["7S"],
      hands: { A: ["XR"] },
    });
    expect(top(play(state, "A", ["XR"]).state)).toBe("XR");
  });

  it("J4 — R7 et R5 décochées, talon 7S : XR ILLEGAL_PLAY (règle « sur un 7 » inactive)", () => {
    const state = makeState({
      options: { joker_wild: false, seven_draw_two: false },
      discard: ["7S"],
      hands: { A: ["XR"] },
    });
    expectError(() => play(state, "A", ["XR"]), "ILLEGAL_PLAY");
  });

  it("J5 — R7 décochée, talon XB encaissé : XR OK (Joker sur Joker)", () => {
    const state = makeState({
      options: { joker_wild: false },
      discard: ["5S", "XB"],
      openColor: "B",
      hands: { A: ["XR"] },
    });
    const { state: next } = play(state, "A", ["XR"]);
    expect(next.openColor).toBe("R");
  });

  it("J6 — talon XR encaissé (ouv R) : 9D OK ; 9H OK ; 9S ILLEGAL_PLAY", () => {
    const at = (card: Card) =>
      makeState({ discard: ["5D", "XR"], openColor: "R", hands: { A: [card] } });
    expect(top(play(at("9D"), "A", ["9D"]).state)).toBe("9D");
    const { state } = play(at("9H"), "A", ["9H"]);
    expect(top(state)).toBe("9H");
    expect(state.openColor).toBeNull();
    expectError(() => play(at("9S"), "A", ["9S"]), "ILLEGAL_PLAY");
  });

  it("J7 — pas de jeu à la valeur sur un Joker (XR posé sur 5D, encaissé ; A joue 5S)", () => {
    const state = makeState({ discard: ["5D", "XR"], openColor: "R", hands: { A: ["5S"] } });
    expectError(() => play(state, "A", ["5S"]), "ILLEGAL_PLAY");
  });

  it("J8 — pén 2 (talon 7D), B joue XB : OK (contre sans condition), pén 6 pour C, ouv B", () => {
    const state = makeState({ discard: ["7D"], penalty: 2, current: "B", hands: { B: ["XB"] } });
    const { state: next } = play(state, "B", ["XB"]);
    expect(next.penalty).toBe(6);
    expect(next.currentPlayerId).toBe("C");
    expect(next.openColor).toBe("B");
  });

  it("J9 — après encaissement de C : tour de A, A peut jouer pique ou trèfle, pas cœur", () => {
    // State right after C took the 6 cards (the draw itself is tested with ENG-06).
    const state = makeState({
      discard: ["7D", "XB"],
      openColor: "B",
      hands: { A: ["5S", "5C", "5H"] },
    });
    expect(canPlayCard(state, "5S")).toBe(true);
    expect(canPlayCard(state, "5C")).toBe(true);
    expect(canPlayCard(state, "5H")).toBe(false);
  });

  it("J10 — dem C, R7 décochée : XB OK ; XR ILLEGAL_PLAY", () => {
    const at = (card: Card) =>
      makeState({
        options: { joker_wild: false },
        discard: ["5H", "JD"],
        requestedSuit: "C",
        hands: { A: [card] },
      });
    expect(top(play(at("XB"), "A", ["XB"]).state)).toBe("XB");
    expectError(() => play(at("XR"), "A", ["XR"]), "ILLEGAL_PLAY");
  });

  it("J11 — R6 décochée, talon 5H, A joue XR : OK, pén 0, ouv R, B joue normalement", () => {
    const state = makeState({
      options: { joker_draw_four: false },
      hands: { A: ["XR"], B: ["9D"] },
    });
    const { state: next } = play(state, "A", ["XR"]);
    expect(next.penalty).toBe(0);
    expect(next.openColor).toBe("R");
    expect(next.currentPlayerId).toBe("B");
    expect(top(play(next, "B", ["9D"]).state)).toBe("9D");
  });
});

describe("ENG-03 — D. Le 2 transparent (R1)", () => {
  it("D1 — talon 9S, A joue 2H : OK ; talon visible reste 9S ; B peut jouer 4S", () => {
    const state = makeState({ discard: ["9S"], hands: { A: ["2H"], B: ["4S"] } });
    const { state: next } = play(state, "A", ["2H"]);
    expect(next.discard).toEqual(["2H", "9S"]);
    expect(next.currentPlayerId).toBe("B");
    expect(top(play(next, "B", ["4S"]).state)).toBe("4S");
  });

  it("D2 — dem D, A joue 2C : OK, dem reste D", () => {
    const state = makeState({ discard: ["5H", "JS"], requestedSuit: "D", hands: { A: ["2C"] } });
    const { state: next } = play(state, "A", ["2C"]);
    expect(next.requestedSuit).toBe("D");
    expect(top(next)).toBe("JS");
  });

  it("D3 — talon XR encaissé (ouv R), A joue 2S : OK, ouv reste R", () => {
    const state = makeState({ discard: ["5D", "XR"], openColor: "R", hands: { A: ["2S"] } });
    const { state: next } = play(state, "A", ["2S"]);
    expect(next.openColor).toBe("R");
    expect(top(next)).toBe("XR");
  });

  it("D4 — pén 2, A joue 2H : MUST_COUNTER_OR_DRAW", () => {
    const state = makeState({ discard: ["7D"], penalty: 2, hands: { A: ["2H"] } });
    expectError(() => play(state, "A", ["2H"]), "MUST_COUNTER_OR_DRAW");
  });

  it("D5 — talon 7H encaissé (pén 0), A joue 2S : OK, aucune nouvelle pénalité pour B", () => {
    const state = makeState({ discard: ["7H"], hands: { A: ["2S"] } });
    const { state: next } = play(state, "A", ["2S"]);
    expect(next.penalty).toBe(0);
    expect(next.currentPlayerId).toBe("B");
  });

  it("D6 — talon AH (effet déjà appliqué), A joue 2D : OK, B n'est pas sauté", () => {
    const state = makeState({ discard: ["AH"], hands: { A: ["2D"] } });
    const { state: next, events } = play(state, "A", ["2D"]);
    expect(next.currentPlayerId).toBe("B");
    expect(events[0]).toMatchObject({ skipped: [] });
  });

  it("D8 — R1 décochée : 2H sur 9S ILLEGAL_PLAY ; sur 9H OK et la carte visible devient 2H", () => {
    const opts = { two_transparent: false };
    expectError(
      () => play(makeState({ options: opts, discard: ["9S"], hands: { A: ["2H"] } }), "A", ["2H"]),
      "ILLEGAL_PLAY",
    );
    const { state } = play(
      makeState({ options: opts, discard: ["9H"], hands: { A: ["2H"] } }),
      "A",
      ["2H"],
    );
    expect(top(state)).toBe("2H");
  });

  it("D9 — A n'a plus que 2H, A joue 2H : victoire de A", () => {
    const state = makeState({ discard: ["9S"], hands: { A: ["2H"] }, exact: ["A"] });
    const { state: next, events } = play(state, "A", ["2H"]);
    expect(next.status).toBe("FINISHED");
    expect(events.at(-1)).toMatchObject({
      t: "GAME_OVER",
      result: "WIN",
      winnerId: "A",
      reason: "EMPTY_HAND",
    });
  });
});

describe("ENG-03 — contrôles généraux de applyPlay", () => {
  it("une liste de cartes vide est refusée (INVALID_COMBO)", () => {
    expectError(() => play(makeState(), "A", []), "INVALID_COMBO");
  });

  it("un identifiant de carte inconnu est refusé (CARD_NOT_IN_HAND)", () => {
    expectError(() => play(makeState(), "A", ["1Z" as Card]), "CARD_NOT_IN_HAND");
  });

  it("aucun coup n'est accepté une fois la partie terminée (NOT_YOUR_TURN)", () => {
    const state = { ...makeState({ hands: { A: ["9H"] } }), status: "FINISHED" as const };
    expectError(() => play(state, "A", ["9H"]), "NOT_YOUR_TURN");
  });

  it("une couleur envoyée sans Valet est ignorée", () => {
    const { state } = play(makeState({ hands: { A: ["9H"] } }), "A", ["9H"], "S");
    expect(state.requestedSuit).toBeNull();
  });

  it("le Valet posé en dernière carte ne demande pas de couleur (W9)", () => {
    const state = makeState({ hands: { A: ["JS"] }, exact: ["A"] });
    expect(play(state, "A", ["JS"]).state.status).toBe("FINISHED");
  });

  it("R6 — missedTurns[A] = 2, A joue un coup valide : missedTurns[A] remis à 0", () => {
    const state = makeState({ hands: { A: ["9H"] } });
    state.missedTurns["A"] = 2;
    expect(play(state, "A", ["9H"]).state.missedTurns["A"]).toBe(0);
  });

  it("applyPlay ne modifie pas l'état reçu", () => {
    const state = makeState({ hands: { A: ["9H"] } });
    const before = JSON.parse(JSON.stringify(state)) as unknown;
    play(state, "A", ["9H"]);
    expect(state).toEqual(before);
  });

  it("le tour passe en sautant les joueurs sortis", () => {
    const state = makeState({ n: 4, forfeited: ["B"], hands: { A: ["9H"] } });
    expect(play(state, "A", ["9H"]).state.currentPlayerId).toBe("C");
  });

  it("le tour du dernier siège revient au premier", () => {
    const state = makeState({ current: "C", hands: { C: ["9H"] } });
    expect(play(state, "C", ["9H"]).state.currentPlayerId).toBe("A");
  });
});
