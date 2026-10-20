// RTT measurement from ping/pong round trips (TECH_BRIEF §3).

import { RTT_EMA_ALPHA } from "../../shared/constants.js";
import { readField } from "./lobby.js";

/** Samples above this are stale/forged pongs and ignored. */
export const MAX_RTT_SAMPLE_MS = 10_000;

/** RTT sample from a pong payload (`now - t`), or null when the payload is invalid or implausible. */
export function rttSample(msg: unknown, nowMs: number): number | null {
  const t = readField(msg, "t");
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const rtt = nowMs - t;
  return rtt >= 0 && rtt <= MAX_RTT_SAMPLE_MS ? rtt : null;
}

/** Exponential moving average; the first sample is taken as is. */
export function nextRttEma(previous: number | undefined, sample: number): number {
  return previous === undefined ? sample : previous + RTT_EMA_ALPHA * (sample - previous);
}
