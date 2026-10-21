// Structured room logs: one JSON line per lifecycle transition (create, first join, match start, phase change,
// match end + reason, dispose) and per operational warning (dropped sim time after a stall, message floods,
// refused creates). Owner: server-room.
//
// Lines go to stdout (console.log; warnings console.warn) as {"ts","game","event",...fields} so a log shipper can
// index them. Quiet under RAFT_TEST=1 unless RAFT_LOG=1 (the room tests create dozens of rooms). Errors keep
// their own console.error path in RaftRoom (stack traces). LogThrottle folds repeats into one line per period.

import { GAME_ID } from "../../shared/constants.js";

export type LogValue = string | number | boolean | null | readonly string[];
export type LogFields = Readonly<Record<string, LogValue>>;
export type LogLevel = "info" | "warn";

interface LogEnv {
  RAFT_TEST?: string;
  RAFT_LOG?: string;
}

/** Room logs are on, except in RAFT_TEST runs that didn't ask for them with RAFT_LOG=1. */
export function loggingOn(env: LogEnv = process.env): boolean {
  return env.RAFT_TEST !== "1" || env.RAFT_LOG === "1";
}

/** The JSON line for `event` (fields after the fixed keys; a field can't override ts / game / event). */
export function formatLine(event: string, fields: LogFields, nowMs: number): string {
  return JSON.stringify({ ...fields, ts: new Date(nowMs).toISOString(), game: GAME_ID, event });
}

/** Write one structured line (no-op while logging is off). */
export function logLine(event: string, fields: LogFields = {}, level: LogLevel = "info"): void {
  if (!loggingOn()) return;
  const line = formatLine(event, fields, Date.now());
  if (level === "warn") console.warn(line);
  else console.log(line);
}

/** A held summary of repeated occurrences: how many and their summed amount. */
export interface ThrottleSummary {
  count: number;
  total: number;
}

/**
 * Rate limit for a repeating log line: the first occurrence is let through at once, later ones are summed and
 * let through as one summary at most every `everyMs`.
 */
export class LogThrottle {
  private count = 0;
  private total = 0;
  private last = Number.NEGATIVE_INFINITY;

  constructor(private readonly everyMs: number) {}

  /** Note one occurrence worth `amount`: the summary to log now (then reset), or null (held for later). */
  note(amount: number, nowMs: number): ThrottleSummary | null {
    this.count++;
    this.total += amount;
    if (nowMs - this.last < this.everyMs) return null;
    const out = { count: this.count, total: this.total };
    this.count = 0;
    this.total = 0;
    this.last = nowMs;
    return out;
  }

  /** The held summary (occurrences not let through yet), then reset; null when nothing is held. */
  flush(): ThrottleSummary | null {
    if (this.count === 0) return null;
    const out = { count: this.count, total: this.total };
    this.count = 0;
    this.total = 0;
    return out;
  }
}
