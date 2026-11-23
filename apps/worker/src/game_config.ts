// Game constants (cahier des charges §11.3). Economic values (fees, starting balances…) live
// in the Supabase `app_config` table, not here. The module refuses to load if a key is missing
// or invalid, so the Worker cannot start with an incomplete configuration (CLAUDE.md).

import type { EngineConfig, RoomOptions } from "@check/engine";
import { RoomOptionsSchema } from "@check/protocol";
import { z } from "zod";

const positiveInt = z.number().int().positive();

const GameConfigSchema = z.strictObject({
  players: z.strictObject({ min: positiveInt, max: positiveInt }),
  hand: z.strictObject({ initial_size: positiveInt }),
  timers: z.strictObject({
    turn_seconds: z.number().int().min(15).max(60),
    disconnect_grace_seconds: positiveInt,
    room_ttl_seconds: positiveInt,
    public_start_countdown_seconds: positiveInt,
    game_max_duration_seconds: positiveInt,
    finished_room_close_seconds: positiveInt,
  }),
  afk: z.strictObject({ max_consecutive_missed_turns: positiveInt }),
  penalty: z.strictObject({ seven: positiveInt, joker: positiveInt }),
  ace: z.strictObject({ combo_cumulative: z.boolean() }),
  check_call: z.strictObject({
    enabled: z.boolean(),
    penalty: positiveInt,
    mode: z.enum(["denunciation", "automatic"]),
  }),
  win: z.strictObject({ forbid_finish_on_ace_in_duel: z.boolean() }),
  room_options: z.strictObject({ defaults: RoomOptionsSchema }),
});

export type GameConfig = z.infer<typeof GameConfigSchema>;

/** MVP values (cahier des charges §11.3). */
export const GAME_CONFIG: GameConfig = GameConfigSchema.parse({
  players: { min: 2, max: 6 },
  hand: { initial_size: 5 },
  timers: {
    turn_seconds: 30,
    disconnect_grace_seconds: 60,
    room_ttl_seconds: 300,
    public_start_countdown_seconds: 60,
    game_max_duration_seconds: 7200,
    finished_room_close_seconds: 60,
  },
  afk: { max_consecutive_missed_turns: 3 },
  penalty: { seven: 2, joker: 4 },
  ace: { combo_cumulative: true },
  check_call: { enabled: true, penalty: 2, mode: "denunciation" },
  win: { forbid_finish_on_ace_in_duel: true },
  room_options: {
    defaults: {
      two_transparent: true,
      jack_commands: true,
      jack_wild: true,
      ace_skips: true,
      seven_draw_two: true,
      joker_draw_four: true,
      joker_wild: true,
      allow_multiples: true,
    } satisfies RoomOptions,
  },
});

/** Engine configuration built from the game constants. */
export function toEngineConfig(config: GameConfig): EngineConfig {
  return {
    minPlayers: config.players.min,
    maxPlayers: config.players.max,
    initialHandSize: config.hand.initial_size,
    turnSeconds: config.timers.turn_seconds,
    disconnectGraceSeconds: config.timers.disconnect_grace_seconds,
    maxConsecutiveMissedTurns: config.afk.max_consecutive_missed_turns,
    penaltySeven: config.penalty.seven,
    penaltyJoker: config.penalty.joker,
    checkCall: { ...config.check_call },
    forbidFinishOnAceInDuel: config.win.forbid_finish_on_ace_in_duel,
  };
}
