import { describe, expect, it } from "vitest";
import {
  applyPlay,
  checkPlay,
  createSeededRng,
  EngineError,
  getLegalMoves,
  getPlayerView,
  isCard,
  randomInt,
  type Card,
  type GameState,
} from "../src/index.js";
import { LATER, NOW, makeState, rng } from "./helpers.js";
import { randomGame, randomStep } from "./simulate.js";

/** Every card id found anywhere in a JSON-like value. */
function cardsIn(value: unknown, found = new Set<string>()): Set<string> {
  if (typeof value === "string") {
    if (isCard(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const v of value) cardsIn(v, found);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value)) cardsIn(v, found);
  }
  return found;
}

function allCards(state: GameState): Card[] {
  return [...Object.values(state.hands).flat(), ...state.deck, ...state.discard];
}

/** Random mid-game states: a random game advanced by 0 to 40 random steps. */
function randomStates(count: number, seed: number): GameState[] {
  const states: GameState[] = [];
  const r = createSeededRng(seed);
  for (let i = 0; states.length < count; i++) {
    let state = randomGame(r, i);
    const steps = randomInt(r, 41);
    let now = NOW;
    for (let s = 0; s < steps && state.status === "PLAYING"; s++) {
      now += 1_000;
      state = randomStep(state, r, now).state;
    }
    if (state.status === "PLAYING") states.push(state);
  }
  return states;
}

describe("ENG-10 — S. Vue joueur et propriétés globales", () => {
  it("S1 — getPlayerView(state, A) : main de A uniquement ; pour B et C seulement handCount", () => {
    const state = makeState({ hands: { A: ["9H"], B: ["9S"], C: ["9D"] } });
    const view = getPlayerView(state, "A");
    expect(view.me).toEqual({ id: "A", hand: state.hands["A"] });
    expect(view.players).toEqual([
      { id: "A", seat: 0, handCount: 5, connected: true, checkDeclared: false, forfeited: false },
      { id: "B", seat: 1, handCount: 5, connected: true, checkDeclared: false, forfeited: false },
      { id: "C", seat: 2, handCount: 5, connected: true, checkDeclared: false, forfeited: false },
    ]);
    const visible = cardsIn(view);
    for (const card of [...(state.hands["B"] ?? []), ...(state.hands["C"] ?? [])]) {
      expect(visible.has(card)).toBe(false);
    }
  });

  it("S1 / S2 — sur 1 000 états aléatoires, la vue ne contient que la main du joueur et la carte visible", () => {
    for (const state of randomStates(1000, 101)) {
      for (const id of state.seats) {
        const view = getPlayerView(state, id);
        const allowed = new Set<string>([...(state.hands[id] ?? []), state.discard.at(-1) as Card]);
        for (const card of cardsIn(view)) expect(allowed.has(card)).toBe(true);
        expect(view.game.deckCount).toBe(state.deck.length);
        expect(view.me.hand).toEqual(state.hands[id]);
      }
    }
  });

  it("S2 — getPlayerView ne contient jamais la pioche, seulement deckCount", () => {
    const state = makeState();
    const view = getPlayerView(state, "B");
    expect(view.game.deckCount).toBe(state.deck.length);
    expect(JSON.stringify(view)).not.toContain('"deck"');
    const visible = cardsIn(view);
    for (const card of state.deck) expect(visible.has(card)).toBe(false);
  });

  it("S3 — 1 000 états aléatoires : toute carte de legal.playable est acceptée seule ; toute autre est refusée", () => {
    for (const state of randomStates(1000, 202)) {
      const id = state.currentPlayerId;
      const { playable } = getLegalMoves(state, id);
      for (const card of state.hands[id] ?? []) {
        let accepted = true;
        try {
          applyPlay(state, id, { cards: [card], suit: "H" }, rng(), LATER);
        } catch (err) {
          if (!(err instanceof EngineError)) throw err;
          accepted = false;
        }
        expect({ card, accepted }).toEqual({ card, accepted: playable.includes(card) });
        expect(checkPlay(state, id, { cards: [card], suit: "H" }) === null).toBe(accepted);
      }
    }
  });

  it("S4 — 1 000 parties simulées jusqu'au bout : 54 cartes uniques à chaque étape, aucune exception, chaque partie se termine", () => {
    const r = createSeededRng(303);
    const reasons = new Map<string, number>();
    for (let game = 0; game < 1000; game++) {
      let state = randomGame(r, game);
      let now = NOW;
      let steps = 0;
      while (state.status === "PLAYING") {
        now += 1_000;
        const { state: next, events } = randomStep(state, r, now);
        state = next;
        const cards = allCards(state);
        expect(cards).toHaveLength(54);
        expect(new Set(cards).size).toBe(54);
        expect(state.discard.length).toBeGreaterThan(0);
        for (const e of events) {
          if (e.t === "GAME_OVER") reasons.set(e.reason, (reasons.get(e.reason) ?? 0) + 1);
        }
        steps++;
        expect(steps).toBeLessThan(20_000);
      }
    }
    expect([...reasons.values()].reduce((a, b) => a + b, 0)).toBe(1000);
    expect(reasons.get("EMPTY_HAND")).toBeGreaterThan(500);
    expect(reasons.get("LAST_PLAYER")).toBeGreaterThan(0);
  });

  it("S5 — les actions ne modifient jamais l'état reçu (fonctions pures)", () => {
    const r = createSeededRng(404);
    for (let game = 0; game < 200; game++) {
      let state = randomGame(r, game);
      let now = NOW;
      while (state.status === "PLAYING") {
        now += 1_000;
        const before = JSON.stringify(state);
        const { state: next } = randomStep(state, r, now);
        expect(JSON.stringify(state)).toBe(before);
        state = next;
      }
    }
  });
});

describe("ENG-10 — getLegalMoves", () => {
  it("cartes jouables, pioche possible, aucune couleur à choisir", () => {
    const state = makeState({ hands: { A: ["9H", "5S", "9S"] } });
    const legal = getLegalMoves(state, "A");
    // A holds 9H, 5S, 9S and the fillers QC, KC; the visible card is 5H.
    expect(legal.playable.sort()).toEqual(["5S", "9H"]);
    expect(legal.playable).not.toContain("9S");
    expect(legal.canDraw).toBe(true);
    expect(legal.mustChooseSuit).toBe(false);
  });

  it("sous pénalité, seuls les contres sont jouables", () => {
    const state = makeState({
      penalty: 2,
      discard: ["7D"],
      hands: { A: ["7S", "XB", "9D", "JD"] },
    });
    expect(getLegalMoves(state, "A").playable.sort()).toEqual(["7S", "XB"]);
  });

  it("un Valet qui commande demande une couleur", () => {
    const legal = getLegalMoves(makeState({ hands: { A: ["JS"] } }), "A");
    expect(legal.playable).toContain("JS");
    expect(legal.mustChooseSuit).toBe(true);
  });

  it("pas de couleur à choisir pour un Valet posé en dernière carte", () => {
    const legal = getLegalMoves(makeState({ hands: { A: ["JS"] }, exact: ["A"] }), "A");
    expect(legal).toEqual({ playable: ["JS"], canDraw: true, mustChooseSuit: false });
  });

  it("à 2 joueurs, l'As en dernière carte n'est pas jouable (W6)", () => {
    const legal = getLegalMoves(makeState({ n: 2, hands: { A: ["AH"] }, exact: ["A"] }), "A");
    expect(legal.playable).toEqual([]);
    expect(legal.canDraw).toBe(true);
  });

  it("hors de son tour, ou partie terminée : rien n'est permis", () => {
    const none = { playable: [], canDraw: false, mustChooseSuit: false };
    expect(getLegalMoves(makeState(), "B")).toEqual(none);
    expect(getLegalMoves({ ...makeState(), status: "FINISHED" }, "A")).toEqual(none);
  });

  it("checkPlay renvoie le code d'erreur sans lever d'exception", () => {
    const state = makeState({ hands: { A: ["9S", "8S", "8D"] }, discard: ["8H"] });
    expect(checkPlay(state, "A", { cards: ["9S"] })).toBe("ILLEGAL_PLAY");
    expect(checkPlay(state, "A", { cards: ["8S", "8D"] })).toBeNull();
    expect(checkPlay(state, "B", { cards: ["8S"] })).toBe("NOT_YOUR_TURN");
  });
});

describe("ENG-10 — getPlayerView : champs de la partie", () => {
  it("reprend l'état public de la partie et les coups permis du joueur", () => {
    const state = makeState({ discard: ["5H", "JS"], requestedSuit: "D", hands: { A: ["9D"] } });
    state.checkDeclared = [];
    const view = getPlayerView(state, "A");
    expect(view.game).toEqual({
      gameId: "test-game",
      status: "PLAYING",
      topCard: "JS",
      deckCount: state.deck.length,
      currentPlayerId: "A",
      turnDeadline: NOW + 30_000,
      penalty: 0,
      requestedSuit: "D",
      openColor: null,
      checkWindowTargetId: null,
      legal: getLegalMoves(state, "A"),
    });
    expect(getPlayerView(state, "B").game.legal.canDraw).toBe(false);
  });

  it("un identifiant inconnu (spectateur) ne voit aucune main", () => {
    const view = getPlayerView(makeState(), "Z");
    expect(view.me).toEqual({ id: "Z", hand: [] });
    expect(cardsIn(view)).toEqual(new Set(["5H"]));
  });
});
