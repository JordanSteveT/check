// Filtered view sent to each player (anti-cheat, cahier §11.2, protocole §5).
// Only the engine part: the RoomDO adds the room fields (roomId, pseudo, fee, pot, seq…).

import type { Card, Color, Suit } from "./cards.js";
import { handOf } from "./internal.js";
import { getLegalMoves, type LegalMoves } from "./legal.js";
import { topCard } from "./rules.js";
import type { GameState, GameStatus, PlayerId } from "./state.js";

export type PlayerSummary = {
  id: PlayerId;
  seat: number;
  handCount: number;
  connected: boolean;
  checkDeclared: boolean;
  forfeited: boolean;
};

export type EnginePlayerView = {
  players: PlayerSummary[];
  /** The player's own hand only. */
  me: { id: PlayerId; hand: Card[] };
  game: {
    gameId: string;
    status: GameStatus;
    topCard: Card;
    deckCount: number;
    currentPlayerId: PlayerId;
    turnDeadline: number;
    penalty: number;
    requestedSuit: Suit | null;
    openColor: Color | null;
    checkWindowTargetId: PlayerId | null;
    legal: LegalMoves;
  };
};

/** Never contains the deck or other players' hands, only their sizes. */
export function getPlayerView(state: GameState, playerId: PlayerId): EnginePlayerView {
  return {
    players: state.seats.map((id, seat) => ({
      id,
      seat,
      handCount: handOf(state, id).length,
      connected: state.connected[id] === true,
      checkDeclared: state.checkDeclared.includes(id),
      forfeited: state.forfeited.includes(id),
    })),
    me: { id: playerId, hand: [...handOf(state, playerId)] },
    game: {
      gameId: state.gameId,
      status: state.status,
      topCard: topCard(state),
      deckCount: state.deck.length,
      currentPlayerId: state.currentPlayerId,
      turnDeadline: state.turnDeadline,
      penalty: state.penalty,
      requestedSuit: state.requestedSuit,
      openColor: state.openColor,
      checkWindowTargetId: state.checkWindow?.targetId ?? null,
      legal: getLegalMoves(state, playerId),
    },
  };
}
