// Win fanfare and the lose sad-trombone, as one-shot step scores in the island tune's key. Owner:
// client-fx-audio. Adapted from games/bonk-brawl/client/src/audio/music/jingles.ts (matchWin, roundLose),
// transposed into any key with computed ukulele voicings.

import { StepGrid, type ScoreEvent } from "./score";
import { makeChord, noteToMidi } from "./theory";

export type Jingle = "win" | "lose";
export const JINGLE_IDS: ReadonlyArray<Jingle> = ["win", "lose"];

export interface JingleScore {
  bpm: number;
  steps: ReadonlyArray<ReadonlyArray<ScoreEvent>>;
  /** Seconds from the start until the last note has rung out (for ducking the loop). */
  duration: number;
}

function stepSec(bpm: number): number {
  return 60 / bpm / 4;
}

/** Transpose C-based jingle notes into `key` (keeping them in a comfortable register). */
function transposer(key: number): (note: string) => number {
  const shift = key > 6 ? key - 12 : key;
  return (note) => noteToMidi(note) + shift;
}

/** Drum roll → I–IV–V7 fanfare → held high tonic over tremolo strums → final stab. */
function win(key: number): JingleScore {
  const n = transposer(key);
  const I = makeChord(key, "maj").uke;
  const IV = makeChord(key + 5, "maj").uke;
  const V7 = makeChord(key + 7, "dom7").uke;
  const bpm = 160;
  const g = new StepGrid(44);
  const kazoo = (note: string, lenSteps: number, vel: number, extra: Partial<Extract<ScoreEvent, { kind: "kazoo" }>> = {}): ScoreEvent => ({ kind: "kazoo", midi: n(note), lenSteps, vel, ...extra });
  const strum = (voicing: readonly number[], dir: "down" | "up", vel: number, holdSteps: number): ScoreEvent => ({ kind: "strum", voicing, dir, vel, holdSteps });
  const bass = (note: string, lenSteps: number, vel: number): ScoreEvent => ({ kind: "bass", midi: n(note), lenSteps, vel });
  for (let s = 0; s < 6; s++) g.add(s, { kind: "snare", vel: 0.25 + s * 0.1 });
  g.add(0, { kind: "kick", vel: 0.6 });
  const fanfare: ReadonlyArray<[number, string, number, readonly number[], "down" | "up", string | null]> = [
    [6, "C5", 2, I, "down", "C2"],
    [8, "E5", 2, I, "up", null],
    [10, "G5", 2, IV, "down", "F2"],
    [12, "A5", 2, IV, "up", null],
    [14, "G5", 3, V7, "down", "G2"],
    [17, "E5", 1, V7, "up", null],
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
  ["C5", "E5", "G5", "C6", "E6", "G6", "C7"].forEach((x, i) => g.add(18 + i, { kind: "pan", midi: n(x), vel: 0.65 }));
  for (let s = 18; s < 30; s++) g.add(s, strum(I, s % 2 === 0 ? "down" : "up", 0.7 - ((s - 18) / 11) * 0.3, 1));
  g.add(30, { kind: "kick", vel: 1 });
  g.add(30, { kind: "snare", vel: 0.8 });
  g.add(30, { kind: "crash", vel: 0.9 });
  g.add(30, strum(I, "down", 1, 10));
  g.add(30, bass("C2", 8, 1));
  g.add(30, { kind: "xylo", midi: n("C7"), vel: 0.8 });
  g.add(30, kazoo("G5", 2, 0.7));
  g.add(32, kazoo("C6", 6, 0.85, { vibratoCents: 25 }));
  return { bpm, steps: g.steps, duration: 42 * stepSec(bpm) };
}

/** The sad trombone: "wah… wah… wah… waaaaah" (descending semitones, wobbly last note). */
function lose(key: number): JingleScore {
  const n = transposer(key);
  const bpm = 100;
  const g = new StepGrid(20);
  const notes: ReadonlyArray<[number, string, string]> = [
    [0, "G4", "G2"],
    [3, "F#4", "F#2"],
    [6, "F4", "F2"],
  ];
  for (const [s, note, low] of notes) {
    g.add(s, { kind: "kazoo", midi: n(note), lenSteps: 2.6, vel: 0.8, attack: 0.12, vibratoCents: 0 });
    g.add(s, { kind: "bass", midi: n(low), lenSteps: 2.6, vel: 0.45 });
  }
  g.add(9, { kind: "kazoo", midi: n("E4"), lenSteps: 10, vel: 0.85, attack: 0.16, vibratoCents: 75, droop: 1.5 });
  g.add(9, { kind: "bass", midi: n("E2"), lenSteps: 10, vel: 0.5 });
  return { bpm, steps: g.steps, duration: 20 * stepSec(bpm) };
}

/** Both jingles in a key. */
export function buildJingles(key: number): Readonly<Record<Jingle, JingleScore>> {
  return { win: win(key), lose: lose(key) };
}
