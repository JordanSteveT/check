// Random game simulation used by the property tests (S3, S4, S5).

import {
  applyCheckCall,
  applyDraw,
  applyForfeit,
  applyPlay,
  applyTimeout,
  checkPlay,
  createGame,
  getLegalMoves,
  randomInt,
  rankOf,
  setConnected,
  SUITS,
  type ActionResult,
  type Card,
  type GameState,
  type RoomOptions,
  type Rng,
} from "../src/index.js";
import { NOW, TEST_CONFIG, players } from "./helpers.js";

export function randomOptions(rng: Rng): RoomOptions {
  const flag = () => rng() < 0.75;
  return {
    two_transparent: flag(),
    jack_commands: flag(),
    jack_wild: flag(),
    ace_skips: flag(),
    seven_draw_two: flag(),
    joker_draw_four: flag(),
    joker_wild: flag(),
    allow_multiples: flag(),
  };
}

export function randomGame(rng: Rng, seed: number): GameState {
  const n = 2 + randomInt(rng, 5);
  return createGame(TEST_CONFIG, randomOptions(rng), players(n), rng, NOW, `sim-${seed}`);
}

/** Builds a random legal combination starting with `first`, or `[first]`. */
function randomCombo(state: GameState, first: Card, rng: Rng): Card[] {
  const hand = state.hands[state.currentPlayerId] ?? [];
  const cards = [first];
  const candidates = hand.filter(
    (c) => c !== first && (rankOf(c) === rankOf(first) || rankOf(c) === "7" || rankOf(c) === null),
  );
  for (const c of candidates) {
    if (
      rng() < 0.5 &&
      checkPlay(state, state.currentPlayerId, { cards: [...cards, c], suit: "H" }) === null
    ) {
      cards.push(c);
    }
  }
  return cards;
}

/** Plays one random step (mostly legal moves, sometimes timeouts, calls, disconnections, forfeits). */
export function randomStep(state: GameState, rng: Rng, now: number): ActionResult {
  const current = state.currentPlayerId;
  const active = state.seats.filter((id) => !state.forfeited.includes(id));
  const r = rng();

  if (state.checkWindow !== null && r < 0.3) {
    const callers = active.filter((id) => id !== state.checkWindow?.targetId);
    const caller = callers[randomInt(rng, callers.length)] as string;
    return applyCheckCall(state, caller, state.checkWindow.targetId, rng);
  }
  if (r < 0.005) {
    return applyForfeit(state, active[randomInt(rng, active.length)] as string, "LEFT", now);
  }
  if (r < 0.03) {
    const who = active[randomInt(rng, active.length)] as string;
    return setConnected(state, who, !(state.connected[who] ?? true), now);
  }
  if (r < 0.06 || state.connected[current] === false) {
    return applyTimeout(state, rng, Math.max(now, state.turnDeadline));
  }

  const legal = getLegalMoves(state, current);
  if (legal.playable.length > 0 && rng() < 0.85) {
    const first = legal.playable[randomInt(rng, legal.playable.length)] as Card;
    const cards = randomCombo(state, first, rng);
    const suit = SUITS[randomInt(rng, 4)] ?? "H";
    return applyPlay(state, current, { cards, suit, declareCheck: rng() < 0.7 }, rng, now);
  }
  return applyDraw(state, current, rng, now);
}
