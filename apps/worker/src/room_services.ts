// What the room needs from the outside world (Supabase, UserDO). The real implementation
// arrives with the account and token tickets (ECO-03, ECO-04) and SRV-09; until then the
// local implementation accepts everyone, which is enough for local play and the tests.

import type { RoomType } from "@check/protocol";

export type FeeRule = { min: number; max: number; step: number };

export type JoinCheck =
  | { ok: true; pseudo: string }
  | {
      ok: false;
      code: "INSUFFICIENT_BALANCE" | "GUEST_NOT_ALLOWED" | "EMAIL_NOT_VERIFIED" | "ALREADY_IN_ROOM";
    };

export interface RoomServices {
  /** `fees.min` / `fees.max` / `fees.step` (Supabase `app_config`). */
  readonly feeRule: FeeRule;
  /** `check_can_join` (spécification des jetons §6.2) and the player's pseudo. */
  checkCanJoin(userId: string, room: { type: RoomType; fee: number }): Promise<JoinCheck>;
  /** Debits the entry fee of each player (§6.3); returns the players whose debit failed. */
  debitEntryFees(gameId: string, playerIds: string[], fee: number): Promise<{ failed: string[] }>;
  /** Refunds the entry fees already debited (§6.3, step 3). */
  refundEntryFees(gameId: string, playerIds: string[], fee: number): Promise<void>;
  /** `economy.house_commission_percent` (Supabase `app_config`). */
  readonly commissionPercent: number;
  /** End of a game with a winner: `settle_game` (§6.4). */
  settleGame(gameId: string, winnerId: string, payout: number, commission: number): Promise<void>;
  /** Draw or aborted game: `refund_game`, every debited player gets the fee back (§7). */
  refundGame(gameId: string, playerIds: string[], fee: number): Promise<void>;
}

/** One room at a time per player (spécification des jetons P8), kept by the UserDOs. */
export interface RoomRegistry {
  /** Reserves the player for the room; false if already seated in another room. */
  claim(userId: string, roomId: string): Promise<boolean>;
  /** Frees the player (if still reserved by this room). */
  release(userId: string, roomId: string): Promise<void>;
}

/** Default values of `app_config` (spécification des jetons §12). */
export const DEFAULT_FEE_RULE: FeeRule = { min: 200, max: 10_000, step: 100 };

/** Accepts every player and every debit (local development, tests). */
export const LOCAL_ROOM_SERVICES: RoomServices = {
  feeRule: DEFAULT_FEE_RULE,
  checkCanJoin: (userId) => Promise.resolve({ ok: true, pseudo: `Joueur ${userId.slice(0, 4)}` }),
  debitEntryFees: () => Promise.resolve({ failed: [] }),
  refundEntryFees: () => Promise.resolve(),
  commissionPercent: 10,
  settleGame: () => Promise.resolve(),
  refundGame: () => Promise.resolve(),
};
