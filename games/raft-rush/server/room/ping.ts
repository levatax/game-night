// RTT measurement from ping / pong round trips (ARCHITECTURE §4.2). Owner: server-room.
// The room sends PingMsg { t: Date.now(), tick } every PING_INTERVAL_MS; the client echoes t in a PongMsg.

import { RTT_EMA_ALPHA } from "../../shared/constants.js";
import { readField } from "./lobby.js";

/** Samples above this are stale / forged pongs and ignored. */
export const MAX_RTT_SAMPLE_MS = 10_000;
/** player.ping is a uint16. */
export const MAX_PING_MS = 0xffff;

/** RTT sample from a pong payload (`now - t`), or null when the payload is invalid or implausible. */
export function rttSample(msg: unknown, nowMs: number): number | null {
  const t = readField(msg, "t");
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  const rtt = nowMs - t;
  return rtt >= 0 && rtt <= MAX_RTT_SAMPLE_MS ? rtt : null;
}

/** Exponential moving average (α = RTT_EMA_ALPHA); the first sample is taken as is. */
export function nextRttEma(previous: number | undefined, sample: number): number {
  return previous === undefined ? sample : previous + RTT_EMA_ALPHA * (sample - previous);
}

/** The EMA as the schema's player.ping (whole ms, uint16). */
export function pingField(ema: number): number {
  return Math.max(0, Math.min(MAX_PING_MS, Math.round(ema)));
}
