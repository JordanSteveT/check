// Helpers shared by the engine actions.

import type { Card } from "./cards.js";
import type { EngineEvent, GameOverEvent } from "./events.js";
import type { GameState, PlayerId } from "./state.js";

export type ActionResult = { state: GameState; events: EngineEvent[] };

/** Deep copy of a (plain JSON) game state. */
export function cloneState(state: GameState): GameState {
  const hands: Record<PlayerId, Card[]> = {};
  for (const [id, cards] of Object.entries(state.hands)) hands[id] = [...cards];
  return {
    ...state,
    config: { ...state.config, checkCall: { ...state.config.checkCall } },
    options: { ...state.options },
    seats: [...state.seats],
    hands,
    deck: [...state.deck],
    discard: [...state.discard],
    checkWindow: state.checkWindow === null ? null : { ...state.checkWindow },
    checkDeclared: [...state.checkDeclared],
    missedTurns: { ...state.missedTurns },
    connected: { ...state.connected },
    forfeited: [...state.forfeited],
  };
}

/** GAME_OVER with the remaining hands revealed. `winnerId` null means a draw. */
export function gameOverEvent(
  state: GameState,
  winnerId: PlayerId | null,
  reason: GameOverEvent["reason"],
): GameOverEvent {
  return {
    t: "GAME_OVER",
    result: winnerId === null ? "DRAW" : "WIN",
    winnerId,
    reason,
    hands: Object.fromEntries(Object.entries(state.hands).map(([id, h]) => [id, [...h]])),
  };
}

/** Closes the "Check" call window, if open (cahier §8), mutating `state`. */
export function closeCheckWindow(state: GameState, events: EngineEvent[]): void {
  if (state.checkWindow === null) return;
  state.checkWindow = null;
  events.push({ t: "CHECK_WINDOW", targetId: null });
}

/** Keeps in `checkDeclared` only the players who still hold exactly one card. */
export function syncCheckDeclared(state: GameState): void {
  state.checkDeclared = state.checkDeclared.filter((id) => state.hands[id]?.length === 1);
}

/**
 * Starts `playerId`'s turn at `now`. A disconnected player gets an already expired turn:
 * the RoomDO then runs the automatic action at once (cahier §9).
 */
export function startTurn(state: GameState, playerId: PlayerId, now: number): void {
  state.currentPlayerId = playerId;
  state.turnStartedAt = now;
  state.turnDeadline =
    state.connected[playerId] === false ? now : now + state.config.turnSeconds * 1000;
}

/** A player's hand (empty for an unknown id, e.g. a spectator). */
export function handOf(state: GameState, playerId: PlayerId): Card[] {
  return state.hands[playerId] ?? [];
}
