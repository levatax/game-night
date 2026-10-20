// Server time estimate. Owner: client-net.

import { TICK_MS } from "../../../shared/constants";

/** Errors larger than this many ticks snap the estimate instead of slewing toward it. */
const SNAP_TICKS = 10;
/** The estimated tick rate may run at most ±10% off real time while it converges. */
const MAX_SLEW = 0.1;
/**
 * Seconds to absorb an error. Samples only ever arrive LATE (network jitter, the patch timer
 * running after the tick), so "the server is further ahead" is trusted quickly and "the server
 * is behind" only slowly: the estimate tracks the least-delayed samples.
 */
const CATCH_UP_SEC = 0.5;
const FALL_BACK_SEC = 3;
/** A slew only applies this long after its sample, so a stalled feed (hidden tab) never drifts. */
const SLEW_WINDOW_MS = 250;
/** Light smoothing on top of the server's own RTT EMA. */
const RTT_SMOOTHING = 0.3;

/**
 * Estimates the server's current (fractional) tick from PING messages and state patches.
 *
 * Model: serverTick(now) = anchorTick + (now - anchorLocalMs) / TICK_MS, where each sample
 * (tick received at local time t with RTT r) implies anchor = tick + (r / 2) / TICK_MS at t.
 * New samples are blended in (slew at most ±10% speed, i.e. never jump backwards) except when
 * the error exceeds 10 ticks (then snap). Before the first sample serverTickAt returns 0.
 * serverTickAt() is the server's PRESENT tick (balls are dead-reckoned to it; lag-compensated
 * catches assume it). Interpolation subtracts rttMs / 2 + INTERP_DELAY_MS from it.
 */
export class Clock {
  private anchorTick = 0;
  private anchorMs = 0;
  /** Extra speed (−MAX_SLEW..MAX_SLEW) applied for SLEW_WINDOW_MS after the anchor. */
  private slew = 0;
  private rtt = 0;
  private hasSample = false;
  /** Last answer, so queries never go backwards (even across a backward snap). */
  private lastQueryMs = -Infinity;
  private lastTick = 0;

  /** Smoothed RTT in ms (from the local player's `ping` field or ping/pong). */
  get rttMs(): number {
    return this.rtt;
  }

  /** True after the first sample. */
  get synced(): boolean {
    return this.hasSample;
  }

  /** Feed a sample: a server tick observed at local time nowMs (performance.now()). */
  sample(serverTick: number, nowMs: number, rttMs: number): void {
    if (!Number.isFinite(serverTick) || !Number.isFinite(nowMs)) return;
    this.updateRtt(rttMs);
    const implied = serverTick + this.rtt / 2 / TICK_MS;
    if (!this.hasSample) {
      this.hasSample = true;
      this.reanchor(implied, nowMs, 0);
      return;
    }
    const estimate = this.rawTickAt(nowMs);
    const error = implied - estimate;
    if (Math.abs(error) > SNAP_TICKS) {
      this.reanchor(implied, nowMs, 0);
      return;
    }
    const absorbSec = error > 0 ? CATCH_UP_SEC : FALL_BACK_SEC;
    const correction = error / (absorbSec * (1000 / TICK_MS));
    this.reanchor(estimate, nowMs, clampSigned(correction, MAX_SLEW));
  }

  /** Estimated server tick (fractional) at local time nowMs. Monotonic non-decreasing. */
  serverTickAt(nowMs: number): number {
    if (!this.hasSample) return 0;
    let tick = this.rawTickAt(nowMs);
    if (nowMs >= this.lastQueryMs) {
      tick = Math.max(tick, this.lastTick);
      this.lastQueryMs = nowMs;
      this.lastTick = tick;
    }
    return tick;
  }

  /** Same in milliseconds of server time (tick * TICK_MS). */
  serverTimeMs(nowMs: number): number {
    return this.serverTickAt(nowMs) * TICK_MS;
  }

  reset(): void {
    this.anchorTick = 0;
    this.anchorMs = 0;
    this.slew = 0;
    this.rtt = 0;
    this.hasSample = false;
    this.lastQueryMs = -Infinity;
    this.lastTick = 0;
  }

  private rawTickAt(nowMs: number): number {
    const elapsed = nowMs - this.anchorMs;
    const slewed = Math.min(Math.max(elapsed, 0), SLEW_WINDOW_MS);
    return this.anchorTick + (elapsed + slewed * this.slew) / TICK_MS;
  }

  private reanchor(tick: number, nowMs: number, slew: number): void {
    this.anchorTick = tick;
    this.anchorMs = nowMs;
    this.slew = slew;
  }

  /** rttMs <= 0 means "not measured yet" (the server's ping field starts at 0): keep the old value. */
  private updateRtt(rttMs: number): void {
    if (!Number.isFinite(rttMs) || rttMs <= 0) return;
    this.rtt = this.rtt > 0 ? this.rtt + (rttMs - this.rtt) * RTT_SMOOTHING : rttMs;
  }
}

function clampSigned(v: number, limit: number): number {
  return v > limit ? limit : v < -limit ? -limit : v;
}
