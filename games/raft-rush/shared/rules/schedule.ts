// The match clock: Timings.days × (day, dusk, night) after the landing. Owner: architect (complete).
// Pure functions shared by the server (phase flow, spawns) and the client (sun / sky / HUD clock).

import { DIFFICULTIES, RAFT_STAGES, type Timings } from "../constants.js";
import type { DayPhase, Difficulty, Phase } from "../types.js";

export interface ClockInfo {
  /** 1..t.days (stays t.days once the clock runs out). */
  day: number;
  dayPhase: DayPhase;
  /** Ticks elapsed / total / left in the current day phase. */
  phaseElapsed: number;
  phaseLength: number;
  phaseLeft: number;
  /**
   * 0..1 through the current day's cycle: [0, dayEnd) daylight, [dayEnd, duskEnd) dusk, [duskEnd, 1) night,
   * where dayEnd = day / cycleLen and duskEnd = (day + dusk) / cycleLen. The client maps it to sun / moon angles.
   */
  cycle: number;
  /** Ticks until the end of the last night (the storm). */
  stormLeft: number;
  /** The last night has ended. */
  over: boolean;
}

/** Ticks of one day + dusk + night cycle. */
export function cycleTicks(t: Timings): number {
  return t.day + t.dusk + t.night;
}

/** Ticks from `playing` start to the storm. */
export function matchTicks(t: Timings): number {
  return t.days * cycleTicks(t);
}

/** First day raft stage `stage` accepts materials (RAFT_STAGES[stage].minDay; 1 with the cheap fast raft). */
export function stageDayLock(stage: number, t: Pick<Timings, "cheapRaft">): number {
  if (t.cheapRaft) return 1;
  return RAFT_STAGES[stage]?.minDay ?? 1;
}

/** First day the finished raft may be boarded (DifficultyDef.launchDay; 1 with the cheap fast raft). */
export function launchDayFor(difficulty: Difficulty, t: Pick<Timings, "cheapRaft">): number {
  if (t.cheapRaft) return 1;
  return (DIFFICULTIES[difficulty] ?? DIFFICULTIES.normal).launchDay;
}

/** Clock for `clockTicks` ticks since playing began. */
export function clockAt(clockTicks: number, t: Timings): ClockInfo {
  const cyc = cycleTicks(t);
  const total = t.days * cyc;
  const clamped = clockTicks < 0 ? 0 : clockTicks >= total ? total - 1 : clockTicks;
  const dayIndex = Math.floor(clamped / cyc);
  const inCycle = clamped - dayIndex * cyc;
  let dayPhase: DayPhase;
  let phaseElapsed: number;
  let phaseLength: number;
  if (inCycle < t.day) {
    dayPhase = "day";
    phaseElapsed = inCycle;
    phaseLength = t.day;
  } else if (inCycle < t.day + t.dusk) {
    dayPhase = "dusk";
    phaseElapsed = inCycle - t.day;
    phaseLength = t.dusk;
  } else {
    dayPhase = "night";
    phaseElapsed = inCycle - t.day - t.dusk;
    phaseLength = t.night;
  }
  const over = clockTicks >= total;
  return {
    day: dayIndex + 1,
    dayPhase,
    phaseElapsed,
    phaseLength,
    phaseLeft: over ? 0 : phaseLength - phaseElapsed,
    cycle: inCycle / cyc,
    stormLeft: over ? 0 : total - clockTicks,
    over,
  };
}

/** Light level 0 (deep night) .. 1 (noon) for a cycle fraction (client sky + server "is it dark" checks). */
export function daylight(cycle: number, t: Timings): number {
  const cyc = cycleTicks(t);
  const dayEnd = t.day / cyc;
  const duskEnd = (t.day + t.dusk) / cyc;
  if (cycle < dayEnd) {
    // Dawn ramps up over the first 12% of the day.
    const u = cycle / dayEnd;
    return u < 0.12 ? 0.35 + (u / 0.12) * 0.65 : 1;
  }
  if (cycle < duskEnd) return 1 - ((cycle - dayEnd) / (duskEnd - dayEnd)) * 0.85;
  return 0.15;
}

/**
 * Input is locked (stepPlayer ctx.locked): the landing wake-up (its first `landingLock` ticks), the launch and
 * storm cinematics, the lobby and the podium. `phaseTicksLeft` is state.phaseTicksLeft.
 */
export function inputLocked(phase: Phase, phaseTicksLeft: number, t: Timings): boolean {
  if (phase === "playing") return false;
  if (phase === "landing") return phaseTicksLeft > t.landing - t.landingLock;
  return true;
}

/** Phases in which players are simulated (inputs flow). */
export function simulatedPhase(phase: Phase): boolean {
  return phase === "landing" || phase === "playing" || phase === "launch" || phase === "storm";
}
