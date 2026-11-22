// Message rate limit of a connection (protocole §8): 20 messages per second; beyond, the
// message is refused with `ERROR RATE_LIMITED`; the 3rd second in which the limit is exceeded
// closes the connection (4008). Pure function; the state lives in the WebSocket attachment.

export type RateState = {
  /** Start of the current one-second window (ms). */
  windowStart: number;
  /** Messages received in the window. */
  count: number;
  /** Windows in which the limit was exceeded, since the connection opened. */
  strikes: number;
  /** Whether the current window already counted as a strike. */
  struck: boolean;
};

export type RateRule = { limit: number; windowMs: number; maxStrikes: number };

/** Protocol values (§8). */
export const RATE_RULE: RateRule = { limit: 20, windowMs: 1000, maxStrikes: 3 };

export type RateDecision = { state: RateState; allowed: boolean; close: boolean };

/** Counts one message received at `now`. */
export function checkRate(
  previous: RateState | undefined,
  now: number,
  rule: RateRule = RATE_RULE,
): RateDecision {
  const sameWindow = previous !== undefined && now - previous.windowStart < rule.windowMs;
  const state: RateState = sameWindow
    ? { ...previous, count: previous.count + 1 }
    : { windowStart: now, count: 1, strikes: previous?.strikes ?? 0, struck: false };
  if (state.count <= rule.limit) return { state, allowed: true, close: false };
  if (!state.struck) {
    state.strikes += 1;
    state.struck = true;
  }
  return { state, allowed: false, close: state.strikes >= rule.maxStrikes };
}
