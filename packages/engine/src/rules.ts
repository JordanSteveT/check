// Legality of a single card (cahier §5.1, §5.2, §5.4, §5.5, §5.6).

import { colorOf, isJoker, rankOf, suitColor, suitOf, type Card } from "./cards.js";
import type { GameState, PlayerId, RoomOptions } from "./state.js";

/** The visible card (top of the discard pile). */
export function topCard(state: GameState): Card {
  const card = state.discard[state.discard.length - 1];
  if (card === undefined) throw new Error("invariant: the discard pile is empty");
  return card;
}

/** Whether the card is a 7 or a Joker whose draw effect is enabled (R5, R6). */
export function isCounterCard(card: Card, options: RoomOptions): boolean {
  if (isJoker(card)) return options.joker_draw_four;
  return rankOf(card) === "7" && options.seven_draw_two;
}

export function isTransparentTwo(card: Card, options: RoomOptions): boolean {
  return options.two_transparent && rankOf(card) === "2";
}

/** Whether the Jack must announce a suit (R2). */
export function isCommandingJack(card: Card, options: RoomOptions): boolean {
  return options.jack_commands && rankOf(card) === "J";
}

/**
 * Whether `card` can be played alone (or as the first card of a combination) on the current
 * state. Under an active penalty, only counters are playable (§5.2).
 */
export function canPlayCard(state: GameState, card: Card): boolean {
  const { options } = state;
  if (state.penalty > 0) return isCounterCard(card, options);

  if (isTransparentTwo(card, options)) return true;
  if (options.jack_wild && rankOf(card) === "J") return true;

  const top = topCard(state);
  // Colour opened by a Joker: both suits of that colour, no play "by value" (§5.4).
  const openColor = state.openColor ?? (isJoker(top) ? colorOf(top) : null);
  // Suit to follow: the suit requested by a Jack, otherwise the suit of the visible card.
  const refSuit = state.requestedSuit ?? suitOf(top);

  if (isJoker(card)) {
    if (options.joker_wild) return true;
    if (isJoker(top)) return true;
    if (rankOf(top) === "7" && options.seven_draw_two && options.joker_draw_four) return true;
    return refSuit !== null && colorOf(card) === suitColor(refSuit);
  }

  if (openColor !== null) return colorOf(card) === openColor;
  return suitOf(card) === refSuit || rankOf(card) === rankOf(top);
}

/**
 * Whether several cards may be played together (cahier §5.3), regardless of the table:
 * - same value (e.g. three 8s, several Jacks, several 2s);
 * - sevens and/or jokers: the two jokers together are always allowed; sevens with jokers only
 *   if R6 is enabled, and if R5 is disabled each 7 must share the colour of one of the jokers.
 * Without R8, a single card per turn.
 */
export function isValidCombination(cards: readonly Card[], options: RoomOptions): boolean {
  if (!options.allow_multiples) return false;
  const jokers = cards.filter((card) => isJoker(card));
  const others = cards.filter((card) => !isJoker(card));
  if (jokers.length === 0) {
    const rank = rankOf(others[0] as Card);
    return others.every((card) => rankOf(card) === rank);
  }
  if (!others.every((card) => rankOf(card) === "7")) return false;
  if (others.length === 0) return true;
  if (!options.joker_draw_four) return false;
  if (!options.seven_draw_two) {
    const jokerColors = new Set(jokers.map(colorOf));
    return others.every((card) => jokerColors.has(colorOf(card)));
  }
  return true;
}

/** Players still in the game, in clockwise order. */
export function activeSeats(state: GameState): PlayerId[] {
  return state.seats.filter((id) => !state.forfeited.includes(id));
}

/**
 * Next player after `fromId`, skipping `skips` active players (Aces):
 * `next = seat (i + 1 + k) mod N` among active players (cas de test, section A).
 */
export function nextPlayerId(state: GameState, fromId: PlayerId, skips = 0): PlayerId {
  const active = activeSeats(state);
  const i = active.indexOf(fromId);
  return active[(i + 1 + skips) % active.length] as PlayerId;
}
