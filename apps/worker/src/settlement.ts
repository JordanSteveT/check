// End-of-game amounts (spécification des jetons §6.4, §6.5, §7). Pure function.

export type Settlement = { pot: number; commission: number; payout: number };

/**
 * With a winner (including by forfeit): commission = floor(pot × percent / 100), payout = the
 * rest. Draw or aborted game: everyone is refunded, no commission and no payout.
 */
export function computeSettlement(
  pot: number,
  commissionPercent: number,
  result: "WIN" | "DRAW" | "ABORTED",
): Settlement {
  if (result !== "WIN") return { pot, commission: 0, payout: 0 };
  const commission = Math.floor((pot * commissionPercent) / 100);
  return { pot, commission, payout: pot - commission };
}
