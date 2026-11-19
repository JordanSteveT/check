// Legal moves of a player (protocole §5 `legal`, §12 `getLegalMoves`).

import type { Card } from "./cards.js";
import { isAceFinishForbidden } from "./actions.js";
import { handOf } from "./internal.js";
import { canPlayCard, isCommandingJack } from "./rules.js";
import type { GameState, PlayerId } from "./state.js";

export type LegalMoves = {
  /** Cards that can be played alone, or as the first card of a combination. */
  playable: Card[];
  /** Whether `DRAW` is possible (always, on one's turn). */
  canDraw: boolean;
  /** Whether a playable commanding Jack requires choosing a suit (R2, not the last card). */
  mustChooseSuit: boolean;
};

const NONE: LegalMoves = { playable: [], canDraw: false, mustChooseSuit: false };

/**
 * Legal moves of `playerId`. Combinations are not enumerated (their number grows quickly):
 * the app checks a selection of several cards with `checkPlay`.
 */
export function getLegalMoves(state: GameState, playerId: PlayerId): LegalMoves {
  if (state.status !== "PLAYING" || state.currentPlayerId !== playerId)
    return { ...NONE, playable: [] };
  const hand = handOf(state, playerId);
  const playable = hand.filter(
    (card) =>
      canPlayCard(state, card) && !(hand.length === 1 && isAceFinishForbidden(state, [card])),
  );
  const mustChooseSuit =
    hand.length > 1 && playable.some((card) => isCommandingJack(card, state.options));
  return { playable, canDraw: true, mustChooseSuit };
}
