// Public API of the Check rules engine (protocole_temps_reel.md §12).
export const ENGINE_VERSION = "0.0.0";

export {
  ALL_CARDS,
  RANKS,
  SUITS,
  colorOf,
  createDeck,
  isCard,
  isJoker,
  rankOf,
  suitColor,
  suitOf,
} from "./cards.js";
export type { Card, Color, Joker, Rank, Suit } from "./cards.js";
export { createSeededRng, randomInt, shuffle } from "./random.js";
export type { Rng } from "./random.js";
export { createGame, drawStarterCard, isSpecialStarter } from "./game.js";
export type { EngineConfig, GameState, GameStatus, PlayerId, RoomOptions } from "./state.js";
export { EngineError, ERROR_CODES } from "./errors.js";
export type { ErrorCode } from "./errors.js";
export type { CardsPlayedEvent, EngineEvent, GameOverEvent } from "./events.js";
export {
  activeSeats,
  canPlayCard,
  isCounterCard,
  isValidCombination,
  nextPlayerId,
  topCard,
} from "./rules.js";
export { applyPlay, checkPlay, isAceFinishForbidden } from "./actions.js";
export type { PlayInput } from "./actions.js";
export { cloneState } from "./internal.js";
export type { ActionResult } from "./internal.js";
export { applyCheckCall } from "./check.js";
export { applyDraw, isExhausted } from "./draw.js";
export type {
  CardsDrawnEvent,
  CheckCalledEvent,
  CheckWindowEvent,
  DeckReshuffledEvent,
  YouDrewEvent,
} from "./events.js";
export { applyForfeit, applyTimeout, setConnected } from "./presence.js";
export type { ForfeitReason, PlayerConnectionEvent, PlayerForfeitEvent } from "./events.js";
export { getLegalMoves } from "./legal.js";
export type { LegalMoves } from "./legal.js";
export { getPlayerView } from "./view.js";
export type { EnginePlayerView, PlayerSummary } from "./view.js";
