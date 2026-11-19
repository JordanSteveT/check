// Game creation: shuffle, deal, starter card, first player (cahier §3, B1–B7).

import { createDeck, isJoker, rankOf, type Card } from "./cards.js";
import { randomInt, shuffle, type Rng } from "./random.js";
import type { EngineConfig, GameState, PlayerId, RoomOptions } from "./state.js";

/**
 * Whether a card cannot be the starter card (B5): the Joker always (colour effect), and a 7,
 * an Ace, a Jack or a 2 whose effect is enabled in the room options (cahier §2.2).
 */
export function isSpecialStarter(card: Card, options: RoomOptions): boolean {
  if (isJoker(card)) return true;
  switch (rankOf(card)) {
    case "7":
      return options.seven_draw_two;
    case "A":
      return options.ace_skips;
    case "J":
      return options.jack_commands || options.jack_wild;
    case "2":
      return options.two_transparent;
    default:
      return false;
  }
}

/**
 * Turns over the top card of `deck` (index 0). While it is special, it is put back,
 * the deck is reshuffled and a new card is turned over (B5). The input is not modified.
 */
export function drawStarterCard(
  deck: readonly Card[],
  options: RoomOptions,
  rng: Rng,
): { starter: Card; deck: Card[] } {
  if (!deck.some((card) => !isSpecialStarter(card, options))) {
    throw new RangeError("drawStarterCard: the deck contains no ordinary card");
  }
  let pile = [...deck];
  for (;;) {
    const [top, ...rest] = pile as [Card, ...Card[]];
    if (!isSpecialStarter(top, options)) return { starter: top, deck: rest };
    pile = shuffle(pile, rng);
  }
}

/**
 * Creates a new game. `players` are given in clockwise seat order. `now` is the server time
 * (ms) and `gameId` the identifier chosen by the server (also used in Supabase).
 */
export function createGame(
  config: EngineConfig,
  options: RoomOptions,
  players: readonly PlayerId[],
  rng: Rng,
  now: number,
  gameId: string,
): GameState {
  if (players.length < config.minPlayers || players.length > config.maxPlayers) {
    throw new RangeError(
      `createGame: ${players.length} players, expected ${config.minPlayers} to ${config.maxPlayers}`,
    );
  }
  if (new Set(players).size !== players.length) {
    throw new RangeError("createGame: duplicate player ids");
  }
  const seats = [...players];
  let deck = shuffle(createDeck(), rng);
  if (seats.length * config.initialHandSize >= deck.length) {
    throw new RangeError("createGame: not enough cards to deal");
  }

  // B4 — one card at a time, clockwise.
  const hands: Record<PlayerId, Card[]> = {};
  for (const id of seats) hands[id] = [];
  for (let round = 0; round < config.initialHandSize; round++) {
    for (const id of seats) {
      (hands[id] as Card[]).push(deck.shift() as Card);
    }
  }

  // B5 — starter card.
  const { starter, deck: rest } = drawStarterCard(deck, options, rng);
  deck = rest;

  // B7 — first player drawn at random.
  const currentPlayerId = seats[randomInt(rng, seats.length)] as PlayerId;

  const missedTurns: Record<PlayerId, number> = {};
  const connected: Record<PlayerId, boolean> = {};
  for (const id of seats) {
    missedTurns[id] = 0;
    connected[id] = true;
  }

  return {
    gameId,
    config,
    options,
    seats,
    hands,
    deck,
    discard: [starter],
    currentPlayerId,
    turnStartedAt: now,
    turnDeadline: now + config.turnSeconds * 1000,
    penalty: 0,
    requestedSuit: null,
    openColor: null,
    checkWindow: null,
    checkDeclared: [],
    status: "PLAYING",
    missedTurns,
    connected,
    forfeited: [],
    roundsWithoutPlay: 0,
  };
}
