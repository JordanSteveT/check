// Timeouts, disconnections, abandons and forfeits (cahier §7.3 and §9).

import { drawCardsInto, endTurnWithoutPlay, isExhausted } from "./draw.js";
import type { EngineEvent, ForfeitReason } from "./events.js";
import {
  closeCheckWindow,
  cloneState,
  gameOverEvent,
  startTurn,
  syncCheckDeclared,
  type ActionResult,
} from "./internal.js";
import type { Rng } from "./random.js";
import { activeSeats, nextPlayerId } from "./rules.js";
import type { GameState, PlayerId } from "./state.js";

/**
 * Removes `playerId` from the game, mutating `state` (cahier §9): their cards go under the
 * deck, a penalty aimed at them is cancelled and the turn passes to the next player. The last
 * remaining player wins by forfeit.
 */
function forfeitInto(
  state: GameState,
  playerId: PlayerId,
  reason: ForfeitReason,
  now: number,
  events: EngineEvent[],
): void {
  const wasCurrent = state.currentPlayerId === playerId;
  // Computed before removal: the next player clockwise among the others.
  const nextId = nextPlayerId(state, playerId);

  state.deck.push(...(state.hands[playerId] ?? []));
  state.hands[playerId] = [];
  state.forfeited.push(playerId);
  syncCheckDeclared(state);
  if (state.checkWindow?.targetId === playerId) closeCheckWindow(state, events);

  const active = activeSeats(state);
  if (active.length === 1) {
    state.status = "FINISHED";
    state.penalty = 0;
    events.push(
      { t: "PLAYER_FORFEIT", playerId, reason, nextPlayerId: null, turnDeadline: null },
      gameOverEvent(state, active[0] as PlayerId, "LAST_PLAYER"),
    );
    return;
  }
  if (wasCurrent) {
    state.penalty = 0;
    startTurn(state, nextId, now);
  }
  events.push({
    t: "PLAYER_FORFEIT",
    playerId,
    reason,
    nextPlayerId: state.currentPlayerId,
    turnDeadline: state.turnDeadline,
  });
}

/** `LEAVE` during a game (abandon), or a forfeit decided by the server. */
export function applyForfeit(
  state: GameState,
  playerId: PlayerId,
  reason: ForfeitReason,
  now: number,
): ActionResult {
  if (state.status !== "PLAYING" || !activeSeats(state).includes(playerId)) {
    return { state, events: [] };
  }
  const next = cloneState(state);
  const events: EngineEvent[] = [];
  forfeitInto(next, playerId, reason, now, events);
  return { state: next, events };
}

/**
 * Automatic action of the current player when the turn deadline has passed (§7.3): draws 1
 * card, or the whole penalty. After `afk.max_consecutive_missed_turns` missed turns, the
 * player is declared forfeit once the draw is done. Does nothing before the deadline, so the
 * RoomDO alarm can call it safely more than once.
 */
export function applyTimeout(state: GameState, rng: Rng, now: number): ActionResult {
  if (state.status !== "PLAYING" || now < state.turnDeadline) return { state, events: [] };
  const next = cloneState(state);
  const playerId = next.currentPlayerId;
  const events: EngineEvent[] = [];
  closeCheckWindow(next, events);

  const startedExhausted = isExhausted(next);
  const drawn = drawCardsInto(next, playerId, Math.max(next.penalty, 1), rng, events);
  syncCheckDeclared(next);
  next.penalty = 0;
  next.missedTurns[playerId] = (next.missedTurns[playerId] ?? 0) + 1;
  const handCount = next.hands[playerId]?.length ?? 0;
  const deckCount = next.deck.length;

  const after: EngineEvent[] = [];
  if ((next.missedTurns[playerId] ?? 0) >= next.config.maxConsecutiveMissedTurns) {
    const reason = next.connected[playerId] === false ? "DISCONNECTED" : "TIMEOUTS";
    forfeitInto(next, playerId, reason, now, after);
  } else {
    after.push(...endTurnWithoutPlay(next, playerId, startedExhausted, now).blocked);
  }

  const finished = next.status === "FINISHED";
  events.push(
    {
      t: "CARDS_DRAWN",
      playerId,
      count: drawn.length,
      reason: "TIMEOUT",
      handCount,
      deckCount,
      nextPlayerId: finished ? null : next.currentPlayerId,
      turnDeadline: finished ? null : next.turnDeadline,
    },
    { t: "YOU_DREW", playerId, cards: drawn },
    ...after,
  );
  return { state: next, events };
}

/**
 * Connection change of a player (§9). A player who disconnects during their own turn gets a
 * turn of `timers.disconnect_grace_seconds` in total; a reconnection keeps the deadline.
 * A player who disconnects outside their turn gets an immediate automatic action when their
 * turn comes (see `startTurn`).
 */
export function setConnected(
  state: GameState,
  playerId: PlayerId,
  connected: boolean,
  now: number,
): ActionResult {
  if (!activeSeats(state).includes(playerId) || state.connected[playerId] === connected) {
    return { state, events: [] };
  }
  const next = cloneState(state);
  next.connected[playerId] = connected;
  if (
    !connected &&
    next.status === "PLAYING" &&
    next.currentPlayerId === playerId &&
    now < next.turnDeadline
  ) {
    const graceEnd = next.turnStartedAt + next.config.disconnectGraceSeconds * 1000;
    next.turnDeadline = Math.max(next.turnDeadline, graceEnd);
  }
  return { state: next, events: [{ t: "PLAYER_CONNECTION", playerId, connected }] };
}
