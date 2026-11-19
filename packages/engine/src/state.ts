// Game state, room options and engine configuration.
// See cahier des charges §2.2 (options R1–R8), §11.3 (configuration) and protocole §4.2 (state).

import type { Card, Color, Suit } from "./cards.js";

export type PlayerId = string;

/** Room rule options R1–R8, chosen by the room creator (cahier §2.2). Keys as documented. */
export type RoomOptions = {
  /** R1 — the 2 is transparent. */
  two_transparent: boolean;
  /** R2 — the Jack commands a suit. */
  jack_commands: boolean;
  /** R3 — the Jack can be played on any card. */
  jack_wild: boolean;
  /** R4 — the Ace skips the next player. */
  ace_skips: boolean;
  /** R5 — the 7 makes the next player draw 2. */
  seven_draw_two: boolean;
  /** R6 — the Joker makes the next player draw 4. */
  joker_draw_four: boolean;
  /** R7 — the Joker can be played on any card. */
  joker_wild: boolean;
  /** R8 — cards of the same value can be played together. */
  allow_multiples: boolean;
};

/**
 * Game constants used by the engine. The Worker builds this object from
 * `apps/worker/src/game_config.ts` (cahier §11.3); the engine has no defaults of its own.
 */
export type EngineConfig = {
  /** `players.min` */
  minPlayers: number;
  /** `players.max` */
  maxPlayers: number;
  /** `hand.initial_size` */
  initialHandSize: number;
  /** `timers.turn_seconds` */
  turnSeconds: number;
  /** `timers.disconnect_grace_seconds` (total turn length when disconnected during one's turn) */
  disconnectGraceSeconds: number;
  /** `afk.max_consecutive_missed_turns` */
  maxConsecutiveMissedTurns: number;
  /** `penalty.seven` */
  penaltySeven: number;
  /** `penalty.joker` */
  penaltyJoker: number;
  /** `check_call.*` */
  checkCall: {
    enabled: boolean;
    penalty: number;
    mode: "denunciation" | "automatic";
  };
  /** `win.forbid_finish_on_ace_in_duel` (only applies when R4 is enabled) */
  forbidFinishOnAceInDuel: boolean;
};

export type GameStatus = "PLAYING" | "FINISHED";

/**
 * Full authoritative game state (protocole §4.2). Plain JSON only (no Set/Map) so that the
 * RoomDO can persist it as is. Never sent to clients: use `getPlayerView`.
 */
export type GameState = {
  gameId: string;
  config: EngineConfig;
  options: RoomOptions;
  /** All players in clockwise order, including those who forfeited. */
  seats: PlayerId[];
  /** Private hands. */
  hands: Record<PlayerId, Card[]>;
  /** Draw pile; `deck[0]` is the top card, the end of the array is the bottom. */
  deck: Card[];
  /** Discard pile; the last element is the visible card. */
  discard: Card[];
  currentPlayerId: PlayerId;
  /** Start of the current turn (ms, server clock). */
  turnStartedAt: number;
  /** End of the current turn (ms, server clock). */
  turnDeadline: number;
  /** Active penalty (sevens and jokers stacked), 0 if none. */
  penalty: number;
  /** Suit requested by a Jack (R2). */
  requestedSuit: Suit | null;
  /** Colour opened by a Joker. */
  openColor: Color | null;
  /** Forgotten "Check" that can still be called (cahier §8). */
  checkWindow: { targetId: PlayerId } | null;
  /** Players who declared "Check" and still hold exactly one card. */
  checkDeclared: PlayerId[];
  status: GameStatus;
  /** Consecutive missed turns (timeouts / disconnections). */
  missedTurns: Record<PlayerId, number>;
  connected: Record<PlayerId, boolean>;
  /** Players out of the game (abandon or forfeit), in order of exit. */
  forfeited: PlayerId[];
  /** For the blocked-game rule (cahier §7.4). */
  roundsWithoutPlay: number;
};
