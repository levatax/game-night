// One clock for the whole match (8:15). Owner: architect / Level Designer tempo spec.
//
// The HUD's storm/clock label and the DAY / storm banner must never drift apart again (QA measured 7:55 on the
// HUD against 7:45 on the banner). Both read matchClock(): landing + 3 day cycles = 495 s, and every label is
// clockLabel() of the same number — including the landing phase, where the old code forgot the +20 s.

import { DAYS, type Timings } from "../constants.js";
import { matchTicks } from "./schedule.js";

/** Whole-match tempo: total / elapsed / left, in seconds, landing included. */
export interface MatchTempo {
  totalSec: number;
  elapsedSec: number;
  leftSec: number;
}

/** The match clock: `landingLeftTicks` is state.phaseTicksLeft during the landing, 0 elsewhere. */
export function matchClock(t: Readonly<Timings>, clockTicks: number, landingLeftTicks = 0): MatchTempo {
  const totalTicks = t.landing + matchTicks(t);
  const landingDone = Math.max(0, Math.min(t.landing, t.landing - Math.max(0, landingLeftTicks)));
  const elapsed = Math.min(totalTicks, landingDone + Math.max(0, clockTicks));
  return { totalSec: totalTicks / 30, elapsedSec: elapsed / 30, leftSec: (totalTicks - elapsed) / 30 };
}

/** "m:ss" — the single formatter every label uses. */
export function clockLabel(sec: number): string {
  const s = Math.max(0, Math.ceil(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Both labels from the same number: the HUD strip and the storm banner. Identical by construction. */
export function clockLabels(t: Readonly<Timings>, clockTicks: number, landingLeftTicks = 0): { hud: string; banner: string } {
  const label = clockLabel(matchClock(t, clockTicks, landingLeftTicks).leftSec);
  return { hud: label, banner: label };
}

/** Seconds left on the match clock (the storm banner prints this; no separate storm countdown exists). */
export function matchLeftSec(t: Readonly<Timings>, clockTicks: number, landingLeftTicks = 0): number {
  return Math.ceil(matchClock(t, clockTicks, landingLeftTicks).leftSec);
}

// DAYS is part of the tempo contract (3 day cycles) even though matchTicks() already encodes it.
void DAYS;
