// Server time estimate. Owner: client-net.

import { TICK_MS } from "../../../shared/constants";

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
  /** Smoothed RTT in ms (from the local player's `ping` field or ping/pong). */
  get rttMs(): number {
    return 0; // TODO(client-net)
  }

  /** True after the first sample. */
  get synced(): boolean {
    return false; // TODO(client-net)
  }

  /** Feed a sample: a server tick observed at local time nowMs (performance.now()). */
  sample(serverTick: number, nowMs: number, rttMs: number): void {
    void serverTick;
    void nowMs;
    void rttMs;
  }

  /** Estimated server tick (fractional) at local time nowMs. Monotonic non-decreasing. */
  serverTickAt(nowMs: number): number {
    void nowMs;
    return 0; // TODO(client-net)
  }

  /** Same in milliseconds of server time (tick * TICK_MS). */
  serverTimeMs(nowMs: number): number {
    return this.serverTickAt(nowMs) * TICK_MS;
  }

  reset(): void {}
}
