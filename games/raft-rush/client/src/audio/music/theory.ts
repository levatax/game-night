// Note names, scales, chords (with computed ukulele voicings) and a tiny melody notation for the procedural
// island score. Owner: client-fx-audio. Copied from games/bonk-brawl/client/src/audio/music/theory.ts (noteToMidi,
// parseMelody, CHORDS, parseChords, chordAt, degreeOffset, bassRoot) and extended for Raft Rush: the island tune
// changes key per seed and switches to the parallel minor at night, so chords are built from roman numerals in any
// key and their ukulele voicings are searched instead of looked up. Pure (no Web Audio): unit-tested.

const NOTE_INDEX: Readonly<Record<string, number>> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4" → 60, "F#5" → 78, "Bb3" → 58. Throws on a malformed name (score data is static). */
export function noteToMidi(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`[audio] bad note name "${name}"`);
  const accidental = m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + NOTE_INDEX[m[1]!]! + accidental;
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
 * Melody notation, one token per note: `<note>/<16ths>`; `-/<16ths>` is a rest, a leading `~` glides into the
 * note from the previous one, `|` bar lines are ignored. Example: "G4/2 C5/2 ~E5/4 -/8 | ...".
 */
export function parseMelody(src: string, transpose = 0): NoteEvent[] {
  const notes: NoteEvent[] = [];
  let step = 0;
  for (const token of src.split(/\s+/)) {
    if (token === "" || token === "|") continue;
    const m = /^(~?)([^/]+)\/(\d+)$/.exec(token);
    if (!m) throw new Error(`[audio] bad melody token "${token}"`);
    const len = Number(m[3]);
    if (m[2] !== "-") notes.push({ step, midi: noteToMidi(m[2]!) + transpose, len, slide: m[1] === "~" });
    step += len;
  }
  return notes;
}

/** Total length of a melody string in steps. */
export function melodyLength(src: string): number {
  let steps = 0;
  for (const token of src.split(/\s+/)) {
    const m = /\/(\d+)$/.exec(token);
    if (m) steps += Number(m[1]);
  }
  return steps;
}

/* ================================================================== chords */

export type ChordQuality = "maj" | "min" | "dom7" | "min7" | "maj7" | "dim" | "sus4";

export const QUALITY_TONES: Readonly<Record<ChordQuality, readonly number[]>> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dom7: [0, 4, 7, 10],
  min7: [0, 3, 7, 10],
  maj7: [0, 4, 7, 11],
  dim: [0, 3, 6],
  sus4: [0, 5, 7],
};

export interface ChordDef {
  name: string;
  /** Root pitch class (C = 0). */
  root: number;
  /** Chord tones as semitones above the root: [0, third, fifth] (+ seventh). */
  tones: readonly number[];
  /** Ukulele voicing, strings G4 C4 E4 A4 (re-entrant tuning), as MIDI notes. */
  uke: readonly number[];
}

const PC_NAMES = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"] as const;
const QUALITY_SUFFIX: Readonly<Record<ChordQuality, string>> = { maj: "", min: "m", dom7: "7", min7: "m7", maj7: "maj7", dim: "dim", sus4: "sus4" };

/** Open strings of a re-entrant ukulele: G4 C4 E4 A4. */
export const UKE_STRINGS: readonly number[] = [67, 60, 64, 69];
/** Highest fret the voicing search uses (first-position chords only). */
const MAX_FRET = 5;

export function pc(n: number): number {
  return ((Math.round(n) % 12) + 12) % 12;
}

/**
 * First-position ukulele voicing for a chord: per string the lowest frets that land on chord tones, searched so
 * the root and the third (and the 7th of a seventh chord) are present, with the smallest fret sum and a playable
 * span (≤ 3 frets). Reproduces the standard open shapes (C 0003, Am 2000, F 2010, G 0232, Dm 2210…).
 */
export function ukeVoicing(root: number, tones: readonly number[]): number[] {
  const pcs = tones.map((t) => pc(root + t));
  const must = new Set<number>([pcs[0]!, pcs[1]!, ...(pcs.length > 3 ? [pcs[3]!] : [])]);
  const candidates = UKE_STRINGS.map((open) => {
    const list: number[] = [];
    for (let f = 0; f <= MAX_FRET && list.length < 3; f++) if (pcs.includes(pc(open + f))) list.push(f);
    return list.length > 0 ? list : [0];
  });
  let best: number[] | null = null;
  let bestScore = Infinity;
  const pick: number[] = [0, 0, 0, 0];
  const visit = (s: number): void => {
    if (s === UKE_STRINGS.length) {
      const notes = pick.map((f, i) => UKE_STRINGS[i]! + f);
      const have = new Set(notes.map(pc));
      let missing = 0;
      for (const m of must) if (!have.has(m)) missing++;
      const fretted = pick.filter((f) => f > 0);
      const span = fretted.length > 0 ? Math.max(...fretted) - Math.min(...fretted) : 0;
      const score = missing * 100 + (span > 3 ? 50 : 0) + pick.reduce((a, b) => a + b, 0) + (have.size < Math.min(3, pcs.length) ? 6 : 0);
      if (score < bestScore) {
        bestScore = score;
        best = notes;
      }
      return;
    }
    for (const f of candidates[s]!) {
      pick[s] = f;
      visit(s + 1);
    }
  };
  visit(0);
  return best ?? UKE_STRINGS.slice();
}

/** A chord with a computed ukulele voicing. */
export function makeChord(root: number, quality: ChordQuality): ChordDef {
  const r = pc(root);
  const tones = QUALITY_TONES[quality];
  return { name: `${PC_NAMES[r]}${QUALITY_SUFFIX[quality]}`, root: r, tones, uke: ukeVoicing(r, tones) };
}

function chord(name: string, root: number, tones: readonly number[], uke: readonly number[]): ChordDef {
  return { name, root, tones, uke };
}

const MAJ = QUALITY_TONES.maj;
const MIN = QUALITY_TONES.min;
const DOM7 = QUALITY_TONES.dom7;

/** Standard open ukulele shapes (fret patterns in the comments), for hand-written jingles. */
export const CHORDS: Readonly<Record<string, ChordDef>> = {
  C: chord("C", 0, MAJ, [67, 60, 64, 72]), // 0003
  C7: chord("C7", 0, DOM7, [67, 60, 64, 70]), // 0001
  Cm: chord("Cm", 0, MIN, [67, 63, 67, 72]), // 0333
  Dm: chord("Dm", 2, MIN, [69, 62, 65, 69]), // 2210
  D7: chord("D7", 2, DOM7, [69, 62, 66, 72]), // 2223
  Em: chord("Em", 4, MIN, [67, 64, 67, 71]), // 0432
  E7: chord("E7", 4, DOM7, [68, 62, 64, 71]), // 1202
  F: chord("F", 5, MAJ, [69, 60, 65, 69]), // 2010
  Fm: chord("Fm", 5, MIN, [68, 60, 65, 72]), // 1013
  G: chord("G", 7, MAJ, [67, 62, 67, 71]), // 0232
  G7: chord("G7", 7, DOM7, [67, 62, 65, 71]), // 0212
  Gm: chord("Gm", 7, MIN, [67, 62, 65, 70]), // 0231
  Ab: chord("Ab", 8, MAJ, [68, 63, 68, 72]), // 1343
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
  return bar.length > 1 && stepInBar >= 8 ? bar[1]! : bar[0]!;
}

/** Chord degree names used by bass and arpeggio patterns. */
export type Degree = "R" | "3" | "5" | "7" | "8" | "10" | "-5";

/** Semitones above the root for a degree of `c` (a missing 7th falls back to the octave). */
export function degreeOffset(c: ChordDef, d: Degree): number {
  switch (d) {
    case "R":
      return 0;
    case "3":
      return c.tones[1]!;
    case "5":
      return c.tones[2]!;
    case "7":
      return c.tones[3] ?? 12;
    case "8":
      return 12;
    case "10":
      return 12 + c.tones[1]!;
    case "-5":
      return c.tones[2]! - 12;
  }
}

/** Bass register root: A1..G#2 keeps every key's root low but clear. */
export function bassRoot(c: ChordDef): number {
  return 33 + ((c.root + 3) % 12);
}

/* ================================================================== scales */

export type Mode = "major" | "minor";

export const MAJOR_SCALE: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
export const MINOR_SCALE: readonly number[] = [0, 2, 3, 5, 7, 8, 10];

export function scaleOf(mode: Mode): readonly number[] {
  return mode === "major" ? MAJOR_SCALE : MINOR_SCALE;
}

/**
 * Semitone offset of scale degree `d` (0 = tonic, may be negative or ≥ 7 for other octaves) in `mode`.
 * `raiseSeventh` turns the minor 7th degree into the leading tone (harmonic minor, over a V chord).
 */
export function degreeSemitones(d: number, mode: Mode, raiseSeventh = false): number {
  const scale = scaleOf(mode);
  const octave = Math.floor(d / 7);
  const i = d - octave * 7;
  let semis = scale[i]! + octave * 12;
  if (raiseSeventh && mode === "minor" && i === 6) semis += 1;
  return semis;
}

/** Diatonic degrees (0..6, mod 7) of the triad on scale degree `root`. */
export function triadDegrees(root: number): [number, number, number] {
  const r = ((root % 7) + 7) % 7;
  return [r, (r + 2) % 7, (r + 4) % 7];
}

const ROMAN: ReadonlyArray<string> = ["I", "II", "III", "IV", "V", "VI", "VII"];

/** A progression chord: its scale degree (for melody snapping) and the sounding chord. */
export interface RomanChord {
  degree: number;
  chord: ChordDef;
}

/**
 * Parse a roman numeral in a key: upper case = major, lower case = minor, "°" / "o" = diminished, "7" = seventh
 * (dominant on a major numeral, minor 7th on a minor one), "s4" = sus4. The root is the degree of the *mode's*
 * scale (so "VI" in A minor is F, "VII" is G). Example: parseRoman("V7", 0, "minor") → G7 (harmonic minor).
 */
export function parseRoman(numeral: string, keyPc: number, mode: Mode): RomanChord {
  const m = /^([ivIV]+)(°|o)?(7|maj7|s4)?$/.exec(numeral);
  if (!m) throw new Error(`[audio] bad roman numeral "${numeral}"`);
  const upper = m[1]!.toUpperCase();
  const degree = ROMAN.indexOf(upper);
  if (degree < 0) throw new Error(`[audio] bad roman numeral "${numeral}"`);
  const isMajor = m[1] === upper;
  let quality: ChordQuality = isMajor ? "maj" : "min";
  if (m[2]) quality = "dim";
  else if (m[3] === "7") quality = isMajor ? "dom7" : "min7";
  else if (m[3] === "maj7") quality = "maj7";
  else if (m[3] === "s4") quality = "sus4";
  return { degree, chord: makeChord(keyPc + degreeSemitones(degree, mode), quality) };
}

/** "I vi IV V" → chords in a key (one per bar). */
export function parseProgression(src: string, keyPc: number, mode: Mode): RomanChord[] {
  return src
    .trim()
    .split(/\s+/)
    .map((n) => parseRoman(n, keyPc, mode));
}

/** Deterministic PRNG for composition (mulberry32): same seed → same tune on every client. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
