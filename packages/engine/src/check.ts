// The "Check!" announcement and the call window (cahier §8).

import { drawCardsInto } from "./draw.js";
import { EngineError } from "./errors.js";
import type { EngineEvent } from "./events.js";
import { closeCheckWindow, cloneState, syncCheckDeclared, type ActionResult } from "./internal.js";
import type { Rng } from "./random.js";
import { activeSeats } from "./rules.js";
import type { GameState, PlayerId } from "./state.js";

/**
 * Makes `targetId` draw the forgotten-"Check" penalty (`check_call.penalty`), mutating
 * `state`. It cannot be countered and does not change whose turn it is.
 */
export function applyCheckPenalty(
  state: GameState,
  targetId: PlayerId,
  rng: Rng,
  events: EngineEvent[],
): void {
  const drawn = drawCardsInto(state, targetId, state.config.checkCall.penalty, rng, events);
  syncCheckDeclared(state);
  events.push(
    {
      t: "CARDS_DRAWN",
      playerId: targetId,
      count: drawn.length,
      reason: "CHECK_PENALTY",
      handCount: state.hands[targetId]?.length ?? 0,
      deckCount: state.deck.length,
      nextPlayerId: state.currentPlayerId,
      turnDeadline: state.turnDeadline,
    },
    { t: "YOU_DREW", playerId: targetId, cards: drawn },
  );
}

/**
 * `CALL_CHECK` (protocole §6.1): an opponent calls a forgotten "Check" while the window is
 * open. The first caller wins; any other call gets `NO_CHECK_TO_CALL`.
 */
export function applyCheckCall(
  state: GameState,
  callerId: PlayerId,
  targetId: PlayerId,
  rng: Rng,
): ActionResult {
  if (
    state.status !== "PLAYING" ||
    state.checkWindow?.targetId !== targetId ||
    callerId === targetId ||
    !activeSeats(state).includes(callerId)
  ) {
    throw new EngineError("NO_CHECK_TO_CALL");
  }
  const next = cloneState(state);
  const penalty = next.config.checkCall.penalty;
  const events: EngineEvent[] = [{ t: "CHECK_CALLED", callerId, targetId, penalty }];
  applyCheckPenalty(next, targetId, rng, events);
  closeCheckWindow(next, events);
  return { state: next, events };
}
