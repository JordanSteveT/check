// Structured logs (architecture §8): one JSON object per line, read by Workers Logs. Every
// entry carries its context (object, room, game, player) so that a game can be followed from
// end to end. No secrets and no personal data: ids only, never tokens, pseudos or emails.

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogEntry = { ts: number; level: LogLevel; msg: string } & Record<string, unknown>;

export type LogSink = (entry: LogEntry) => void;

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/** Whether an entry of `level` is written when the minimum level is `min`. */
export function shouldLog(level: LogLevel, min: LogLevel): boolean {
  return RANK[level] >= RANK[min];
}

/** Builds an entry; fields set to `undefined` are left out. */
export function logEntry(
  level: LogLevel,
  msg: string,
  fields: Record<string, unknown>,
  ts: number,
): LogEntry {
  const entry: LogEntry = { ts, level, msg };
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) entry[key] = value;
  }
  return entry;
}

/** Writes to the console as JSON (Workers Logs indexes the fields). */
export const consoleSink: LogSink = (entry) => {
  const line = JSON.stringify(entry);
  if (entry.level === "error") console.error(line);
  else if (entry.level === "warn") console.warn(line);
  else console.log(line);
};
