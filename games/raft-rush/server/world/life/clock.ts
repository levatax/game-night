// Clock bookkeeping for the life systems. Owner: server-world-life.
//
// RaftWorld hands the systems the day clock through onClock(prev, clock) (every tick or only on transitions —
// either works) and the systems also derive it from state.clockTicks in their own step(). Transitions are
// recorded as "done for day N" marks, so every dawn / dusk / night / mid-day event fires exactly once per day
// no matter how often or from where the clock arrives. A clock that runs backwards means a new match: marks reset.

import { cycleTicks, type ClockInfo } from "../../../shared/rules/schedule.js";
import type { Timings } from "../../../shared/constants.js";

/** Ticks since playing began, reconstructed from a ClockInfo. */
export function clockTicksOf(c: ClockInfo, t: Readonly<Timings>): number {
  const offset = c.dayPhase === "day" ? 0 : c.dayPhase === "dusk" ? t.day : t.day + t.dusk;
  return (c.day - 1) * cycleTicks(t) + offset + c.phaseElapsed;
}

/** Fraction of the current day phase elapsed (0..1). */
export function phaseFraction(c: ClockInfo): number {
  return c.phaseLength > 0 ? c.phaseElapsed / c.phaseLength : 0;
}

/** Detects a rewound clock (new match). */
export class ClockRewind {
  private last = -1;

  /** True when `c` is earlier than the last clock seen (the caller resets its marks). */
  rewound(c: ClockInfo, t: Readonly<Timings>): boolean {
    const now = clockTicksOf(c, t);
    const back = now < this.last;
    this.last = now;
    return back;
  }

  reset(): void {
    this.last = -1;
  }
}
