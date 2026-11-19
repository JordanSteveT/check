// Engine actions. Pure functions: the input state is never modified.

import { colorOf, isCard, isJoker, rankOf, type Card, type Suit } from "./cards.js";
import { EngineError, type ErrorCode } from "./errors.js";
import { applyCheckPenalty } from "./check.js";
import type { EngineEvent } from "./events.js";
import {
  closeCheckWindow,
  cloneState,
  gameOverEvent,
  handOf,
  startTurn,
  syncCheckDeclared,
  type ActionResult,
} from "./internal.js";
import type { Rng } from "./random.js";
import {
  activeSeats,
  canPlayCard,
  isCommandingJack,
  isCounterCard,
  isTransparentTwo,
  isValidCombination,
  nextPlayerId,
  topCard,
} from "./rules.js";
import type { GameState, PlayerId } from "./state.js";

export type PlayInput = {
  /** Ordered list of cards; the last one becomes the visible card. */
  cards: readonly Card[];
  /** Suit announced with a commanding Jack (R2). */
  suit?: Suit;
  /** "Check!" announced with the move (cahier §8). */
  declareCheck?: boolean;
};

/**
 * §10.1 — with 2 active players (counted at the time of the move) and R4 enabled, a move
 * that would empty the hand with one or more Aces is refused.
 */
export function isAceFinishForbidden(state: GameState, cards: readonly Card[]): boolean {
  return (
    state.options.ace_skips &&
    state.config.forbidFinishOnAceInDuel &&
    activeSeats(state).length === 2 &&
    cards.some((card) => rankOf(card) === "A")
  );
}

/**
 * Error code that `applyPlay` would raise for this move, or `null` if it is accepted.
 * Lets the app check a selection of cards without catching exceptions.
 */
export function checkPlay(
  state: GameState,
  playerId: PlayerId,
  input: PlayInput,
): ErrorCode | null {
  try {
    validatePlay(state, playerId, input);
    return null;
  } catch (err) {
    if (err instanceof EngineError) return err.code;
    throw err;
  }
}

/** Validates a move and throws the matching EngineError if it is refused. */
function validatePlay(state: GameState, playerId: PlayerId, input: PlayInput): void {
  if (state.status !== "PLAYING" || state.currentPlayerId !== playerId) {
    throw new EngineError("NOT_YOUR_TURN");
  }
  const { cards } = input;
  if (cards.length === 0) throw new EngineError("INVALID_COMBO", "no card played");
  if (new Set(cards).size !== cards.length) {
    throw new EngineError("INVALID_COMBO", "duplicate card");
  }
  const hand = handOf(state, playerId);
  for (const card of cards) {
    if (!isCard(card) || !hand.includes(card)) throw new EngineError("CARD_NOT_IN_HAND");
  }
  if (cards.length > 1 && !isValidCombination(cards, state.options)) {
    throw new EngineError("INVALID_COMBO");
  }
  // §5.2 — under a penalty, every card must be a counter (any order, no suit condition).
  if (state.penalty > 0 && !cards.every((card) => isCounterCard(card, state.options))) {
    throw new EngineError("MUST_COUNTER_OR_DRAW");
  }
  // §5.3 — otherwise the first card must be playable; the others only follow the combination.
  if (!canPlayCard(state, cards[0] as Card)) throw new EngineError("ILLEGAL_PLAY");

  const emptiesHand = hand.length === cards.length;
  if (emptiesHand && isAceFinishForbidden(state, cards)) {
    throw new EngineError("ACE_FINISH_FORBIDDEN");
  }
  const last = cards[cards.length - 1] as Card;
  if (!emptiesHand && isCommandingJack(last, state.options) && input.suit === undefined) {
    throw new EngineError("SUIT_REQUIRED");
  }
}

/** Plays one card or a combination (protocole §12). */
export function applyPlay(
  state: GameState,
  playerId: PlayerId,
  input: PlayInput,
  rng: Rng,
  now: number,
): ActionResult {
  validatePlay(state, playerId, input);
  const next = cloneState(state);
  const events: EngineEvent[] = [];
  // §8 — any valid action closes a pending "Check" call window.
  closeCheckWindow(next, events);
  const { options, config } = next;
  const cards = [...input.cards];
  const hand = handOf(next, playerId).filter((card) => !cards.includes(card));
  next.hands[playerId] = hand;
  next.missedTurns[playerId] = 0;
  next.roundsWithoutPlay = 0;

  for (const card of cards) {
    if (isTransparentTwo(card, options)) {
      // §5.6 — slides under the visible card; nothing else changes.
      next.discard.splice(next.discard.length - 1, 0, card);
      continue;
    }
    next.discard.push(card);
    next.requestedSuit = null;
    next.openColor = isJoker(card) ? colorOf(card) : null;
    if (isCounterCard(card, options)) {
      next.penalty += isJoker(card) ? config.penaltyJoker : config.penaltySeven;
    }
  }

  const last = cards[cards.length - 1] as Card;
  if (isCommandingJack(last, options) && input.suit !== undefined) {
    next.requestedSuit = input.suit;
    next.openColor = null;
  }

  if (hand.length === 0) {
    // §10 — immediate win; the effects of the last card are not applied.
    next.status = "FINISHED";
    next.penalty = 0;
    events.push(playedEvent(next, playerId, cards, null, []));
    events.push(gameOverEvent(next, playerId, "EMPTY_HAND"));
    return { state: next, events };
  }

  // §5.3 / §6 — each Ace skips one active player; if the skip comes back to the poser,
  // the poser plays again. A combination of Aces only contains Aces (same value).
  const aces = options.ace_skips ? cards.filter((card) => rankOf(card) === "A").length : 0;
  const skipped = skippedPlayers(next, playerId, aces);
  startTurn(next, nextPlayerId(next, playerId, aces), now);

  // §8 — a player left with one card must announce "Check!".
  const mustAnnounce = hand.length === 1;
  const declared = mustAnnounce && input.declareCheck === true;
  if (declared && !next.checkDeclared.includes(playerId)) next.checkDeclared.push(playerId);
  syncCheckDeclared(next);
  events.push(playedEvent(next, playerId, cards, next.currentPlayerId, skipped));

  if (mustAnnounce && !declared && config.checkCall.enabled) {
    if (config.checkCall.mode === "automatic") {
      applyCheckPenalty(next, playerId, rng, events);
    } else {
      next.checkWindow = { targetId: playerId };
      events.push({ t: "CHECK_WINDOW", targetId: playerId });
    }
  }
  return { state: next, events };
}

/** The `k` active players skipped after `fromId`, in order (may include the poser). */
function skippedPlayers(state: GameState, fromId: PlayerId, k: number): PlayerId[] {
  const active = activeSeats(state);
  const i = active.indexOf(fromId);
  return Array.from({ length: k }, (_, j) => active[(i + 1 + j) % active.length] as PlayerId);
}

function playedEvent(
  state: GameState,
  playerId: PlayerId,
  cards: Card[],
  nextId: PlayerId | null,
  skipped: PlayerId[],
): EngineEvent {
  return {
    t: "CARDS_PLAYED",
    playerId,
    cards,
    topCard: topCard(state),
    requestedSuit: state.requestedSuit,
    openColor: state.openColor,
    penalty: state.penalty,
    skipped,
    handCount: state.hands[playerId]?.length ?? 0,
    checkDeclared: state.checkDeclared.includes(playerId),
    nextPlayerId: nextId,
    turnDeadline: nextId === null ? null : state.turnDeadline,
  };
}
