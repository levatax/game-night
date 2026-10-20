// Round-win / match-win fanfares and the round-lose sad trombone, as one-shot step scores.

import type { Jingle } from "../Music";
import { StepGrid, type ScoreEvent } from "./score";
import { CHORDS, noteToMidi } from "./theory";

export interface JingleScore {
  bpm: number;
  steps: ReadonlyArray<ReadonlyArray<ScoreEvent>>;
  /** Seconds from the start until the last note has rung out (for ducking the loop). */
  duration: number;
}

const n = noteToMidi;
const C = CHORDS.C.uke;
const F = CHORDS.F.uke;
const G = CHORDS.G.uke;
const G7 = CHORDS.G7.uke;

function stepSec(bpm: number): number {
  return 60 / bpm / 4;
}

function strum(voicing: readonly number[], dir: "down" | "up", vel: number, holdSteps: number): ScoreEvent {
  return { kind: "strum", voicing, dir, vel, holdSteps };
}

function kazoo(note: string, lenSteps: number, vel: number, extra: Partial<Extract<ScoreEvent, { kind: "kazoo" }>> = {}): ScoreEvent {
  return { kind: "kazoo", midi: n(note), lenSteps, vel, ...extra };
}

function bass(note: string, lenSteps: number, vel: number): ScoreEvent {
  return { kind: "bass", midi: n(note), lenSteps, vel };
}

/** Rapid alternating strums (the "brrrang" under a held fanfare note). */
function tremolo(grid: StepGrid, voicing: readonly number[], from: number, to: number, startVel: number, endVel: number): void {
  for (let s = from; s < to; s++) {
    const t = (s - from) / Math.max(1, to - from - 1);
    grid.add(s, strum(voicing, s % 2 === 0 ? "down" : "up", startVel + (endVel - startVel) * t, 1));
  }
}

/** "Ta-ta-ta-TAAA, ta-TAAAA!" in C, with a xylophone sparkle run. */
function roundWin(): JingleScore {
  const bpm = 160;
  const g = new StepGrid(34);
  ["C5", "E5", "G5"].forEach((x, i) => g.add(i * 2, { kind: "xylo", midi: n(x), vel: 0.6 }));
  for (const s of [0, 2, 4]) {
    g.add(s, kazoo("C5", 1.5, 0.75));
    g.add(s, strum(C, s === 2 ? "up" : "down", 0.6, 1));
  }
  g.add(6, kazoo("G5", 5, 0.85));
  g.add(6, strum(C, "down", 1, 6));
  g.add(6, bass("C2", 5, 0.9));
  g.add(6, { kind: "kick", vel: 0.9 });
  g.add(6, { kind: "crash", vel: 0.6 });
  g.add(12, kazoo("E5", 2, 0.8));
  g.add(12, strum(G, "down", 0.8, 2));
  g.add(12, bass("G2", 2, 0.8));
  g.add(14, kazoo("G5", 10, 0.9, { vibratoCents: 30 }));
  g.add(14, bass("C2", 10, 1));
  g.add(14, { kind: "kick", vel: 1 });
  g.add(14, { kind: "crash", vel: 0.8 });
  g.add(14, strum(C, "down", 1, 2));
  ["C6", "E6", "G6", "C7"].forEach((x, i) => g.add(14 + i, { kind: "xylo", midi: n(x), vel: 0.7 }));
  tremolo(g, C, 16, 24, 0.55, 0.3);
  g.add(24, strum(C, "down", 0.85, 8));
  return { bpm, steps: g.steps, duration: 33 * stepSec(bpm) };
}

/** Drum roll → C–F–G7–C fanfare → held high C over tremolo strums → final stab. */
function matchWin(): JingleScore {
  const bpm = 160;
  const g = new StepGrid(44);
  for (let s = 0; s < 6; s++) g.add(s, { kind: "snare", vel: 0.25 + s * 0.1 });
  g.add(0, { kind: "kick", vel: 0.6 });
  const fanfare: ReadonlyArray<[number, string, number, readonly number[], "down" | "up", string | null]> = [
    [6, "C5", 2, C, "down", "C2"],
    [8, "E5", 2, C, "up", null],
    [10, "G5", 2, F, "down", "F2"],
    [12, "A5", 2, F, "up", null],
    [14, "G5", 3, G7, "down", "G2"],
    [17, "E5", 1, G7, "up", null],
  ];
  for (const [s, note, len, chord, dir, bassNote] of fanfare) {
    g.add(s, kazoo(note, len, 0.85));
    g.add(s, strum(chord, dir, dir === "down" ? 0.9 : 0.55, len));
    if (bassNote) g.add(s, bass(bassNote, len, 0.9));
  }
  g.add(6, { kind: "crash", vel: 0.7 });
  g.add(6, { kind: "kick", vel: 0.9 });
  g.add(18, kazoo("C6", 12, 0.9, { vibratoCents: 32 }));
  g.add(18, bass("C2", 12, 1));
  g.add(18, { kind: "crash", vel: 1 });
  g.add(18, { kind: "kick", vel: 1 });
  ["C5", "E5", "G5", "C6", "E6", "G6", "C7"].forEach((x, i) => g.add(18 + i, { kind: "xylo", midi: n(x), vel: 0.65 }));
  tremolo(g, C, 18, 30, 0.7, 0.4);
  g.add(30, { kind: "kick", vel: 1 });
  g.add(30, { kind: "snare", vel: 0.8 });
  g.add(30, { kind: "crash", vel: 0.9 });
  g.add(30, strum(C, "down", 1, 10));
  g.add(30, bass("C2", 8, 1));
  g.add(30, { kind: "xylo", midi: n("C7"), vel: 0.8 });
  g.add(30, kazoo("G5", 2, 0.7));
  g.add(32, kazoo("C6", 6, 0.85, { vibratoCents: 25 }));
  return { bpm, steps: g.steps, duration: 42 * stepSec(bpm) };
}

/** The sad trombone: "wah… wah… wah… waaaaah" (descending semitones, wobbly last note). */
function roundLose(): JingleScore {
  const bpm = 100;
  const g = new StepGrid(20);
  const notes: ReadonlyArray<[number, string, string]> = [
    [0, "G4", "G2"],
    [3, "F#4", "F#2"],
    [6, "F4", "F2"],
  ];
  for (const [s, note, low] of notes) {
    g.add(s, kazoo(note, 2.6, 0.8, { attack: 0.12, vibratoCents: 0 }));
    g.add(s, bass(low, 2.6, 0.45));
  }
  g.add(9, kazoo("E4", 10, 0.85, { attack: 0.16, vibratoCents: 75, droop: 1.5 }));
  g.add(9, bass("E2", 10, 0.5));
  return { bpm, steps: g.steps, duration: 20 * stepSec(bpm) };
}

export const JINGLES: Readonly<Record<Jingle, JingleScore>> = {
  roundWin: roundWin(),
  matchWin: matchWin(),
  roundLose: roundLose(),
};
