// Note names, ukulele chord voicings and a tiny melody notation for the procedural score.

const NOTE_INDEX: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4" → 60, "F#5" → 78, "Bb3" → 58. Throws on a malformed name (score data is static). */
export function noteToMidi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`[audio] bad note name "${name}"`);
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]] + accidental;
}

export interface NoteEvent {
  /** Start, in 16th-note steps from the start of the part. */
  step: number;
  midi: number;
  /** Length in steps. */
  len: number;
  /** Glide in from the previous note (kazoo slides). */
  slide: boolean;
}

/**
 * Melody notation, one token per note: `<note>/<16ths>`; `-/<16ths>` is a rest, a leading `~`
 * glides into the note from the previous one, `|` bar lines are ignored (they only help reading).
 * Example: "G4/2 C5/2 ~E5/4 -/8 | ...".
 */
export function parseMelody(src: string, transpose = 0): NoteEvent[] {
  const notes: NoteEvent[] = [];
  let step = 0;
  for (const token of src.split(/\s+/)) {
    if (token === "" || token === "|") continue;
    const m = /^(~?)([^/]+)\/(\d+)$/.exec(token);
    if (!m) throw new Error(`[audio] bad melody token "${token}"`);
    const len = Number(m[3]);
    if (m[2] !== "-") notes.push({ step, midi: noteToMidi(m[2]) + transpose, len, slide: m[1] === "~" });
    step += len;
  }
  return notes;
}

/** Total length of a melody string in steps (bar-length checks in the harness). */
export function melodyLength(src: string): number {
  let steps = 0;
  for (const token of src.split(/\s+/)) {
    const m = /\/(\d+)$/.exec(token);
    if (m) steps += Number(m[1]);
  }
  return steps;
}

export interface ChordDef {
  name: string;
  /** Root pitch class (C = 0). */
  root: number;
  /** Chord tones as semitones above the root: [0, third, fifth] (+ seventh). */
  tones: readonly number[];
  /** Ukulele voicing, strings G4 C4 E4 A4 (re-entrant tuning), as MIDI notes. */
  uke: readonly number[];
}

function chord(name: string, root: number, tones: readonly number[], uke: readonly number[]): ChordDef {
  return { name, root, tones, uke };
}

const MAJ = [0, 4, 7];
const MIN = [0, 3, 7];
const DOM7 = [0, 4, 7, 10];

/** Standard open ukulele shapes (fret patterns in the comments). */
export const CHORDS: Readonly<Record<string, ChordDef>> = {
  C: chord("C", 0, MAJ, [67, 60, 64, 72]), // 0003
  C7: chord("C7", 0, DOM7, [67, 60, 64, 70]), // 0001
  Dm: chord("Dm", 2, MIN, [69, 62, 65, 69]), // 2210
  D7: chord("D7", 2, DOM7, [69, 62, 66, 72]), // 2223
  Em: chord("Em", 4, MIN, [67, 64, 67, 71]), // 0432
  E7: chord("E7", 4, DOM7, [68, 62, 64, 71]), // 1202
  F: chord("F", 5, MAJ, [69, 60, 65, 69]), // 2010
  Fm: chord("Fm", 5, MIN, [68, 60, 65, 72]), // 1013
  G: chord("G", 7, MAJ, [67, 62, 67, 71]), // 0232
  G7: chord("G7", 7, DOM7, [67, 62, 65, 71]), // 0212
  Gm: chord("Gm", 7, MIN, [67, 62, 65, 70]), // 0231
  Am: chord("Am", 9, MIN, [69, 60, 64, 69]), // 2000
  A7: chord("A7", 9, DOM7, [67, 61, 64, 69]), // 0100
  Bb: chord("Bb", 10, MAJ, [70, 62, 65, 70]), // 3211
};

/** "C | Am | F G" → one entry per bar, each with one chord (whole bar) or two (half bars). */
export function parseChords(src: string): ChordDef[][] {
  return src.split("|").map((bar) =>
    bar
      .trim()
      .split(/\s+/)
      .map((name) => {
        const c = CHORDS[name];
        if (!c) throw new Error(`[audio] unknown chord "${name}"`);
        return c;
      }),
  );
}

/** Chord sounding at `stepInBar` (0..15) of a bar with one or two chords. */
export function chordAt(bar: readonly ChordDef[], stepInBar: number): ChordDef {
  return bar.length > 1 && stepInBar >= 8 ? bar[1] : bar[0];
}

/** Chord degree names used by bass and arpeggio patterns. */
export type Degree = "R" | "3" | "5" | "7" | "8" | "10" | "-5";

/** Semitones above the root for a degree of `c` (a missing 7th falls back to the octave). */
export function degreeOffset(c: ChordDef, d: Degree): number {
  switch (d) {
    case "R":
      return 0;
    case "3":
      return c.tones[1];
    case "5":
      return c.tones[2];
    case "7":
      return c.tones[3] ?? 12;
    case "8":
      return 12;
    case "10":
      return 12 + c.tones[1];
    case "-5":
      return c.tones[2] - 12;
  }
}

/** Bass register root: A1..G#2 keeps every key's root low but clear. */
export function bassRoot(c: ChordDef): number {
  return 33 + ((c.root + 3) % 12);
}
