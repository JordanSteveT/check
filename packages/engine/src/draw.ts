// Drawing: simple draw, taking the penalty, deck exhaustion and reshuffle, blocked game
// (cahier §6.2, §7.2, §7.4).

import type { Card } from "./cards.js";
import {
  closeCheckWindow,
  cloneState,
  gameOverEvent,
  startTurn,
  syncCheckDeclared,
  type ActionResult,
} from "./internal.js";
import { EngineError } from "./errors.js";
import type { CardsDrawnEvent, EngineEvent } from "./events.js";
import { shuffle, type Rng } from "./random.js";
import { activeSeats, nextPlayerId } from "./rules.js";
import type { GameState, PlayerId } from "./state.js";

/** Whether the deck is empty and the discard pile holds only the visible card. */
export function isExhausted(state: GameState): boolean {
  return state.deck.length === 0 && state.discard.length <= 1;
}

/**
 * Moves up to `count` cards from the deck to the player's hand, mutating `state`.
 * When the deck is empty, the discard pile except the visible card is shuffled into a new
 * deck (§7.4.1). If there are still not enough cards, the rest is cancelled (§7.4.2).
 */
export function drawCardsInto(
  state: GameState,
  playerId: PlayerId,
  count: number,
  rng: Rng,
  events: EngineEvent[],
): Card[] {
  const drawn: Card[] = [];
  const hand = state.hands[playerId] ?? [];
  while (drawn.length < count) {
    if (state.deck.length === 0) {
      if (state.discard.length <= 1) break;
      const visible = state.discard[state.discard.length - 1] as Card;
      state.deck = shuffle(state.discard.slice(0, -1), rng);
      state.discard = [visible];
      events.push({ t: "DECK_RESHUFFLED", deckCount: state.deck.length });
    }
    drawn.push(state.deck.shift() as Card);
  }
  state.hands[playerId] = [...hand, ...drawn];
  return drawn;
}

/**
 * Ends a turn in which `playerId` did not play: the turn passes to the next active player,
 * then the blocked-game rule is checked (§7.4.3). `startedExhausted` tells whether the deck
 * and the discard pile were already exhausted when the turn began.
 */
export function endTurnWithoutPlay(
  state: GameState,
  playerId: PlayerId,
  startedExhausted: boolean,
  now: number,
): { blocked: EngineEvent[] } {
  state.roundsWithoutPlay = startedExhausted ? state.roundsWithoutPlay + 1 : 0;
  const active = activeSeats(state);
  if (state.roundsWithoutPlay >= active.length) {
    // A full round of the table without any card played: fewest cards wins, a tie is a draw.
    state.status = "FINISHED";
    state.penalty = 0;
    const counts = active.map((id) => state.hands[id]?.length ?? 0);
    const min = Math.min(...counts);
    const leaders = active.filter((_, i) => counts[i] === min);
    const winnerId = leaders.length === 1 ? (leaders[0] as PlayerId) : null;
    return { blocked: [gameOverEvent(state, winnerId, "BLOCKED")] };
  }
  startTurn(state, nextPlayerId(state, playerId), now);
  return { blocked: [] };
}

/**
 * `DRAW` (protocole §6.1): without a penalty, draws 1 card; with a penalty, takes the whole
 * penalty. Drawing always ends the turn (§7.2). `rng` is used if the deck must be reshuffled.
 */
export function applyDraw(
  state: GameState,
  playerId: PlayerId,
  rng: Rng,
  now: number,
): ActionResult {
  if (state.status !== "PLAYING" || state.currentPlayerId !== playerId) {
    throw new EngineError("NOT_YOUR_TURN");
  }
  const next = cloneState(state);
  const startedExhausted = isExhausted(next);
  const reason = next.penalty > 0 ? "PENALTY" : "NORMAL";
  const events: EngineEvent[] = [];
  // §8 — drawing is a valid action: it closes a pending "Check" call window.
  closeCheckWindow(next, events);
  const drawn = drawCardsInto(next, playerId, Math.max(next.penalty, 1), rng, events);
  syncCheckDeclared(next);
  next.penalty = 0;
  next.missedTurns[playerId] = 0;

  const { blocked } = endTurnWithoutPlay(next, playerId, startedExhausted, now);
  const finished = next.status === "FINISHED";
  const drawnEvent: CardsDrawnEvent = {
    t: "CARDS_DRAWN",
    playerId,
    count: drawn.length,
    reason,
    handCount: next.hands[playerId]?.length ?? 0,
    deckCount: next.deck.length,
    nextPlayerId: finished ? null : next.currentPlayerId,
    turnDeadline: finished ? null : next.turnDeadline,
  };
  events.push(drawnEvent, { t: "YOU_DREW", playerId, cards: drawn }, ...blocked);
  return { state: next, events };
}
