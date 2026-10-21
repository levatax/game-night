// Score events and how they are played on a Band. Songs, jingles and the dusk drum circle all compile to arrays
// of these, indexed by 16th-note step, so the schedulers only walk small precomputed lists. Owner:
// client-fx-audio. Copied from games/bonk-brawl/client/src/audio/music/score.ts + steel pan, toms and slaps.

import type { Band } from "./instruments";

export type ScoreEvent =
  | { kind: "strum"; voicing: readonly number[]; dir: "down" | "up"; vel: number; holdSteps: number }
  | { kind: "pluck"; midi: number; vel: number; holdSteps: number }
  | { kind: "kazoo"; midi: number; lenSteps: number; vel: number; glideFrom?: number; attack?: number; vibratoCents?: number; droop?: number }
  | { kind: "xylo"; midi: number; vel: number }
  | { kind: "pan"; midi: number; vel: number }
  | { kind: "bass"; midi: number; lenSteps: number; vel: number }
  | { kind: "kick" | "snare" | "shaker" | "hat" | "crash" | "slap"; vel: number }
  | { kind: "block"; high: boolean; vel: number }
  | { kind: "tom"; pitch: number; vel: number };

export type ScoreKind = ScoreEvent["kind"];

export interface PlayContext {
  band: Band;
  /** Seconds per 16th step at the current tempo. */
  stepDur: number;
  /** Seconds between strings in a strum. */
  strumSpread: number;
}

/** Small humanization so loops don't sound machine-stamped. */
function human(vel: number, amount = 0.08): number {
  return Math.max(0, vel * (1 + (Math.random() * 2 - 1) * amount));
}

export function playEvent(ev: ScoreEvent, at: number, pc: PlayContext): void {
  const { band, stepDur } = pc;
  switch (ev.kind) {
    case "strum":
      band.strum(at, ev.voicing, ev.dir, human(ev.vel), ev.holdSteps * stepDur, pc.strumSpread);
      return;
    case "pluck":
      band.pluck(at, ev.midi, human(ev.vel), ev.holdSteps * stepDur);
      return;
    case "kazoo":
      band.kazoo(at, ev.midi, ev.lenSteps * stepDur, ev.vel, {
        glideFrom: ev.glideFrom,
        attack: ev.attack,
        vibratoCents: ev.vibratoCents,
        droop: ev.droop,
      });
      return;
    case "xylo":
      band.xylo(at, ev.midi, human(ev.vel));
      return;
    case "pan":
      band.pan(at, ev.midi, human(ev.vel));
      return;
    case "bass":
      band.bass(at, ev.midi, ev.lenSteps * stepDur, human(ev.vel, 0.05));
      return;
    case "kick":
      band.kick(at, ev.vel);
      return;
    case "snare":
      band.snare(at, human(ev.vel));
      return;
    case "shaker":
      band.shaker(at, human(ev.vel, 0.15));
      return;
    case "hat":
      band.hat(at, human(ev.vel, 0.15));
      return;
    case "crash":
      band.crash(at, ev.vel);
      return;
    case "slap":
      band.slap(at, human(ev.vel, 0.12));
      return;
    case "block":
      band.block(at, ev.high, human(ev.vel));
      return;
    case "tom":
      band.tom(at, ev.pitch, human(ev.vel, 0.1));
      return;
  }
}

/** Steps × step-indexed event lists, built with `add(step, ...)`. */
export class StepGrid {
  readonly steps: ScoreEvent[][];

  constructor(length: number) {
    this.steps = Array.from({ length }, () => []);
  }

  add(step: number, ev: ScoreEvent): void {
    const i = Math.round(step);
    if (i >= 0 && i < this.steps.length) this.steps[i]!.push(ev);
  }
}
