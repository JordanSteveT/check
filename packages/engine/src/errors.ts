// Game error codes — exactly those of protocole_temps_reel.md §6.1 and §11.

export const ERROR_CODES = [
  "NOT_YOUR_TURN",
  "CARD_NOT_IN_HAND",
  "ILLEGAL_PLAY",
  "INVALID_COMBO",
  "SUIT_REQUIRED",
  "MUST_COUNTER_OR_DRAW",
  "ACE_FINISH_FORBIDDEN",
  "NO_CHECK_TO_CALL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** A rejected action. The state is unchanged and the turn is not consumed (cahier §11.1). */
export class EngineError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string = code) {
    super(message);
    this.name = "EngineError";
    this.code = code;
  }
}
