// Events produced by the engine (protocole §6.2), without `seq` (added by the RoomDO).
// Room-level fields (pot, commission, payout…) are added by the RoomDO.

import type { Card, Color, Suit } from "./cards.js";
import type { PlayerId } from "./state.js";

export type CardsPlayedEvent = {
  t: "CARDS_PLAYED";
  playerId: PlayerId;
  cards: Card[];
  topCard: Card;
  requestedSuit: Suit | null;
  openColor: Color | null;
  penalty: number;
  /** Players skipped by Aces, in order. */
  skipped: PlayerId[];
  handCount: number;
  checkDeclared: boolean;
  /** `null` when the move ends the game. */
  nextPlayerId: PlayerId | null;
  turnDeadline: number | null;
};

export type GameOverEvent = {
  t: "GAME_OVER";
  result: "WIN" | "DRAW" | "ABORTED";
  winnerId: PlayerId | null;
  reason: "EMPTY_HAND" | "LAST_PLAYER" | "BLOCKED" | "TECHNICAL";
  /** Remaining hands, revealed. */
  hands: Record<PlayerId, Card[]>;
};

export type CardsDrawnEvent = {
  t: "CARDS_DRAWN";
  playerId: PlayerId;
  /** Cards actually received (may be less than requested when the deck runs out, §7.4). */
  count: number;
  reason: "NORMAL" | "PENALTY" | "CHECK_PENALTY" | "TIMEOUT";
  handCount: number;
  deckCount: number;
  nextPlayerId: PlayerId | null;
  turnDeadline: number | null;
};

/**
 * Private event: only sent to `playerId` (the RoomDO removes `playerId` before sending,
 * the protocol message is `{ t: "YOU_DREW", cards }`).
 */
export type YouDrewEvent = {
  t: "YOU_DREW";
  playerId: PlayerId;
  cards: Card[];
};

export type DeckReshuffledEvent = {
  t: "DECK_RESHUFFLED";
  deckCount: number;
};

/** A forgotten "Check" can be called (`targetId`), or the window is closed (`null`). */
export type CheckWindowEvent = {
  t: "CHECK_WINDOW";
  targetId: PlayerId | null;
};

export type CheckCalledEvent = {
  t: "CHECK_CALLED";
  callerId: PlayerId;
  targetId: PlayerId;
  penalty: number;
};

export type PlayerConnectionEvent = {
  t: "PLAYER_CONNECTION";
  playerId: PlayerId;
  connected: boolean;
};

export type ForfeitReason = "LEFT" | "TIMEOUTS" | "DISCONNECTED";

export type PlayerForfeitEvent = {
  t: "PLAYER_FORFEIT";
  playerId: PlayerId;
  reason: ForfeitReason;
  /** Whose turn it is after the forfeit (`null` if the game is over). */
  nextPlayerId: PlayerId | null;
  turnDeadline: number | null;
};

export type EngineEvent =
  | PlayerConnectionEvent
  | PlayerForfeitEvent
  | CardsPlayedEvent
  | CardsDrawnEvent
  | YouDrewEvent
  | DeckReshuffledEvent
  | CheckWindowEvent
  | CheckCalledEvent
  | GameOverEvent;
