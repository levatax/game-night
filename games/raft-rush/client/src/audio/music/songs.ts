// The procedural island tune (§18): every island seed composes its own little song — a key, two chord
// progressions and a set of melodic motifs — and each music mood re-arranges that same tune, so the night is
// recognizably "the day song, gone minor": day / lobby / launch in major, dusk sparser, night in the parallel minor
// (same tonic, harmonic-minor V for bite), boss / storm the minor tune at full intensity. Composition is
// deterministic (mulberry32 on the seed): every client hums the same tune for the same island. Pure data out —
// no Web Audio here (unit-tested). Owner: client-fx-audio. Pattern vocabulary from
// games/bonk-brawl/client/src/audio/music/songs.ts.

import type { MusicMood } from "../Sfx";
import { StepGrid, type ScoreEvent } from "./score";
import {
  bassRoot,
  degreeOffset,
  degreeSemitones,
  mulberry32,
  parseRoman,
  triadDegrees,
  type ChordDef,
  type Degree,
  type Mode,
} from "./theory";

export type SongId = "lobby" | "day" | "dusk" | "night" | "boss" | "storm" | "launch" | "lose";
export const SONG_IDS: ReadonlyArray<SongId> = ["lobby", "day", "dusk", "night", "boss", "storm", "launch", "lose"];

export const STEPS_PER_BAR = 16;
/** Bars per loop: A A' B A' (4 bars each). */
export const SONG_BARS = 16;

export interface Song {
  id: SongId;
  bpm: number;
  swing: number;
  strumSpread: number;
  mode: Mode;
  /** Total loop length in steps. */
  length: number;
  /** Events per loop step. */
  steps: ReadonlyArray<ReadonlyArray<ScoreEvent>>;
  /** Chord per bar (inspection / tests). */
  bars: ReadonlyArray<ChordDef>;
}

/** One melody note in scale-degree space (0 = tonic of the lead octave). */
export interface DegreeNote {
  /** Step inside its 4-bar phrase (0..63). */
  step: number;
  len: number;
  degree: number;
}

/** The seed's tune: shared by every mood's arrangement. */
export interface Tune {
  seed: number;
  /** Tonic pitch class. */
  key: number;
  /** Roman numerals (major-mode spelling), 4 chords each. */
  progA: readonly string[];
  progB: readonly string[];
  /** 4-bar phrases. A2 ends on the tonic; A and B end on a half cadence. */
  phraseA: readonly DegreeNote[];
  phraseA2: readonly DegreeNote[];
  phraseB: readonly DegreeNote[];
  /** Small tempo personality (bpm offset). */
  tempoNudge: number;
}

export interface SongBook {
  seed: number;
  tune: Tune;
  songs: Readonly<Record<SongId, Song>>;
}

/** Which song plays for a music mood (win / lose: after their jingle). */
export function songForMood(mood: MusicMood): SongId | null {
  switch (mood) {
    case "off":
      return null;
    case "win":
      return "launch";
    default:
      return mood;
  }
}

/* ================================================================ tune */

/** Ukulele-friendly keys (and their parallel minors at night). */
const KEYS: readonly number[] = [0, 2, 5, 7, 9];

const PROGRESSIONS_A: ReadonlyArray<readonly string[]> = [
  ["I", "vi", "IV", "V"],
  ["I", "IV", "vi", "V"],
  ["I", "V", "vi", "IV"],
  ["I", "iii", "IV", "V"],
  ["I", "IV", "I", "V"],
  ["I", "vi", "ii", "V"],
];

const PROGRESSIONS_B: ReadonlyArray<readonly string[]> = [
  ["IV", "V", "iii", "vi"],
  ["vi", "IV", "I", "V"],
  ["IV", "I", "ii", "V7"],
  ["ii", "V", "I", "vi"],
  ["IV", "IV", "I", "V7"],
  ["vi", "V", "IV", "V"],
];

/** Rhythm cells for one bar: note lengths in 16ths, negative = rest (sums to 16). */
const RHYTHMS: ReadonlyArray<readonly number[]> = [
  [4, 4, 4, 4],
  [2, 2, 4, 2, 2, 4],
  [4, 2, 2, 8],
  [2, 2, 2, 2, 8],
  [3, 3, 2, 4, 4],
  [6, 2, 4, 4],
  [2, 2, 4, 8],
  [4, 4, 8],
  [2, 2, 2, 2, 4, -4],
  [-2, 2, 2, 2, 4, 4],
  [3, 3, 2, 2, 2, 4],
  [4, -2, 2, 4, 4],
];
/** Cadence bars: a long final note. */
const CADENCE_RHYTHMS: ReadonlyArray<readonly number[]> = [
  [4, 4, 8],
  [2, 2, 4, 8],
  [4, 2, 2, 8],
  [6, 2, 8],
];

const STEP_CHOICES: readonly number[] = [-2, -1, -1, 0, 1, 1, 2];
const MIN_DEGREE = -3;
const MAX_DEGREE = 9;

function pickFrom<T>(rng: () => number, list: ReadonlyArray<T>): T {
  return list[Math.floor(rng() * list.length) % list.length]!;
}

/** Degree of the chord tone (any octave) nearest `near`, optionally pushed in `dir`. */
function nearestChordTone(chordRoot: number, near: number, dir: number): number {
  const tones = triadDegrees(chordRoot);
  let best = near;
  let bestCost = Infinity;
  for (let d = MIN_DEGREE; d <= MAX_DEGREE; d++) {
    if (!tones.includes(((d % 7) + 7) % 7)) continue;
    const cost = Math.abs(d - (near + dir));
    if (cost < bestCost) {
      bestCost = cost;
      best = d;
    }
  }
  return best;
}

/** Nearest degree ≡ target (mod 7) to `near`. */
function nearestOctave(target: number, near: number): number {
  let best = target;
  for (let k = -2; k <= 2; k++) {
    const d = target + k * 7;
    if (d < MIN_DEGREE || d > MAX_DEGREE) continue;
    if (Math.abs(d - near) < Math.abs(best - near)) best = d;
  }
  return best;
}

/** One bar of melody over `chordRoot`. `end` forces the last note's degree class (cadences). */
function composeBar(rng: () => number, rhythm: readonly number[], chordRoot: number, start: number, barStep: number, end: number | null, out: DegreeNote[]): number {
  let cur = start;
  let step = 0;
  const notes = rhythm.filter((l) => l > 0).length;
  let index = 0;
  for (const len of rhythm) {
    if (len < 0) {
      step += -len;
      continue;
    }
    const last = index === notes - 1;
    let d: number;
    if (last && end !== null) d = nearestOctave(end, cur);
    else if (step % 8 === 0 || len >= 4) d = nearestChordTone(chordRoot, cur, Math.round((rng() - 0.5) * 4));
    else d = cur + pickFrom(rng, STEP_CHOICES);
    d = Math.max(MIN_DEGREE, Math.min(MAX_DEGREE, d));
    out.push({ step: barStep + step, len, degree: d });
    cur = d;
    step += len;
    index++;
  }
  return cur;
}

/** A 4-bar phrase: motif, answer, motif varied, cadence. */
function composePhrase(rng: () => number, prog: readonly string[], cadence: number, motif: readonly number[], answer: readonly number[]): DegreeNote[] {
  const out: DegreeNote[] = [];
  const roots = prog.map((n) => romanDegree(n));
  let cur = nearestChordTone(roots[0]!, 2, 0);
  const firstStart = cur;
  cur = composeBar(rng, motif, roots[0]!, cur, 0, null, out);
  cur = composeBar(rng, answer, roots[1]!, cur, 16, null, out);
  // Motif again (same rhythm, starting where it started), its last notes free to wander.
  cur = composeBar(rng, motif, roots[2]!, firstStart + (rng() < 0.5 ? 0 : 2), 32, null, out);
  composeBar(rng, pickFrom(rng, CADENCE_RHYTHMS), roots[3]!, cur, 48, cadence, out);
  return out;
}

/** Scale degree (0..6) of a roman numeral. */
function romanDegree(numeral: string): number {
  return parseRoman(numeral, 0, "major").degree;
}

/** The seed's tune (key, progressions, phrases). */
export function composeTune(seed: number): Tune {
  const rng = mulberry32((seed ^ 0x9e3779b9) >>> 0);
  const key = pickFrom(rng, KEYS);
  const progA = pickFrom(rng, PROGRESSIONS_A);
  const progB = pickFrom(rng, PROGRESSIONS_B);
  const motifA = pickFrom(rng, RHYTHMS);
  const answerA = pickFrom(rng, RHYTHMS);
  const motifB = pickFrom(rng, RHYTHMS);
  const answerB = pickFrom(rng, RHYTHMS);
  const phraseA = composePhrase(rng, progA, 4, motifA, answerA);
  // A2: same phrase, re-composed cadence onto the tonic.
  const phraseA2 = phraseA.filter((n) => n.step < 48);
  composeBar(rng, pickFrom(rng, CADENCE_RHYTHMS), romanDegree(progA[3]!), phraseA2[phraseA2.length - 1]?.degree ?? 2, 48, 0, phraseA2);
  const phraseB = composePhrase(rng, progB, 4, motifB, answerB);
  const tempoNudge = Math.round((rng() - 0.5) * 8);
  return { seed: seed >>> 0, key, progA, progB, phraseA, phraseA2, phraseB, tempoNudge };
}

/* ================================================================ arrangement */

interface StrumHit {
  step: number;
  dir: "down" | "up";
  vel: number;
}

interface BassHit {
  step: number;
  degree: Degree;
  len: number;
  vel: number;
}

type DrumKind = "kick" | "snare" | "shaker" | "hat" | "blockHi" | "blockLo" | "tomLo" | "tomHi" | "slap";

interface DrumHit {
  step: number;
  kind: DrumKind;
  vel: number;
}

interface LeadPart {
  inst: "xylo" | "pan" | "kazoo";
  vel: number;
  /** Semitones (the kazoo hums an octave down). */
  octave: number;
}

interface Arrangement {
  mode: Mode;
  bpm: number;
  swing: number;
  strumSpread: number;
  strum: readonly StrumHit[];
  /** Arpeggiated plucks (night). */
  pick: boolean;
  /** 16th tremolo strums (storm). */
  tremolo: boolean;
  bass: readonly BassHit[];
  leadA: LeadPart | null;
  leadB: LeadPart | null;
  /** Kazoo doubling the B melody an octave down (velocity, 0 = none). */
  kazooB: number;
  /** Xylophone off-beat arpeggio in these sections. */
  arp: "none" | "B" | "all";
  drums: readonly DrumHit[];
  fill: readonly DrumHit[];
  /** Crash on every n-th bar (0 = only after fills). */
  crashEvery: number;
  /** 0..1 chance to drop a melody note (sparser moods). */
  thin: number;
}

const ISLAND_STRUM: readonly StrumHit[] = [
  { step: 0, dir: "down", vel: 0.9 },
  { step: 4, dir: "down", vel: 0.6 },
  { step: 6, dir: "up", vel: 0.5 },
  { step: 10, dir: "up", vel: 0.5 },
  { step: 12, dir: "down", vel: 0.65 },
  { step: 14, dir: "up", vel: 0.5 },
];

const DRIVING_STRUM: readonly StrumHit[] = [
  { step: 0, dir: "down", vel: 0.9 },
  { step: 2, dir: "up", vel: 0.42 },
  { step: 4, dir: "down", vel: 0.7 },
  { step: 6, dir: "up", vel: 0.45 },
  { step: 8, dir: "down", vel: 0.85 },
  { step: 10, dir: "up", vel: 0.42 },
  { step: 12, dir: "down", vel: 0.7 },
  { step: 14, dir: "up", vel: 0.5 },
];

const HALF_STRUM: readonly StrumHit[] = [
  { step: 0, dir: "down", vel: 0.7 },
  { step: 8, dir: "down", vel: 0.5 },
];

const LOBBY_BASS: readonly BassHit[] = [
  { step: 0, degree: "R", len: 5, vel: 0.9 },
  { step: 6, degree: "5", len: 2, vel: 0.6 },
  { step: 8, degree: "R", len: 3, vel: 0.75 },
  { step: 12, degree: "5", len: 2, vel: 0.62 },
  { step: 14, degree: "3", len: 2, vel: 0.5 },
];

const LONG_BASS: readonly BassHit[] = [
  { step: 0, degree: "R", len: 8, vel: 0.75 },
  { step: 8, degree: "5", len: 8, vel: 0.55 },
];

const DRONE_BASS: readonly BassHit[] = [
  { step: 0, degree: "R", len: 10, vel: 0.8 },
  { step: 10, degree: "-5", len: 2, vel: 0.5 },
  { step: 12, degree: "R", len: 4, vel: 0.6 },
];

const OCTAVE_BASS: readonly BassHit[] = [
  { step: 0, degree: "R", len: 2, vel: 1 },
  { step: 2, degree: "8", len: 2, vel: 0.55 },
  { step: 4, degree: "5", len: 2, vel: 0.8 },
  { step: 6, degree: "8", len: 2, vel: 0.55 },
  { step: 8, degree: "R", len: 2, vel: 0.9 },
  { step: 10, degree: "8", len: 2, vel: 0.55 },
  { step: 12, degree: "5", len: 2, vel: 0.8 },
  { step: 14, degree: "3", len: 2, vel: 0.65 },
];

const shakers = (accent: number, soft: number, sixteenths = false): DrumHit[] =>
  Array.from({ length: sixteenths ? 16 : 8 }, (_, i): DrumHit => {
    const step = sixteenths ? i : i * 2;
    return { step, kind: "shaker", vel: (sixteenths ? step % 2 === 1 : step % 4 === 2) ? accent : soft };
  });

const LOBBY_DRUMS: readonly DrumHit[] = [
  { step: 0, kind: "kick", vel: 0.45 },
  { step: 4, kind: "blockLo", vel: 0.32 },
  { step: 12, kind: "blockLo", vel: 0.32 },
  ...shakers(0.3, 0.17),
];

const DAY_DRUMS: readonly DrumHit[] = [
  { step: 0, kind: "kick", vel: 0.6 },
  { step: 8, kind: "kick", vel: 0.5 },
  { step: 4, kind: "blockLo", vel: 0.35 },
  { step: 12, kind: "blockHi", vel: 0.3 },
  { step: 14, kind: "blockLo", vel: 0.25 },
  ...shakers(0.32, 0.18),
];

const DUSK_DRUMS: readonly DrumHit[] = [...shakers(0.22, 0.12)];

const NIGHT_DRUMS: readonly DrumHit[] = [
  { step: 4, kind: "blockLo", vel: 0.22 },
  { step: 12, kind: "blockLo", vel: 0.22 },
  { step: 14, kind: "blockHi", vel: 0.14 },
  { step: 2, kind: "hat", vel: 0.1 },
  { step: 10, kind: "hat", vel: 0.1 },
];

const BOSS_DRUMS: readonly DrumHit[] = [
  { step: 0, kind: "kick", vel: 0.95 },
  { step: 6, kind: "kick", vel: 0.6 },
  { step: 8, kind: "kick", vel: 0.85 },
  { step: 14, kind: "tomLo", vel: 0.6 },
  { step: 4, kind: "snare", vel: 0.7 },
  { step: 12, kind: "snare", vel: 0.72 },
  { step: 10, kind: "tomHi", vel: 0.45 },
  ...Array.from({ length: 8 }, (_, i): DrumHit => ({ step: i * 2, kind: "hat", vel: i % 2 === 1 ? 0.3 : 0.18 })),
];

const STORM_DRUMS: readonly DrumHit[] = [
  ...[0, 4, 8, 12].map((step): DrumHit => ({ step, kind: "kick", vel: 0.85 })),
  { step: 4, kind: "snare", vel: 0.75 },
  { step: 12, kind: "snare", vel: 0.75 },
  { step: 15, kind: "snare", vel: 0.4 },
  ...Array.from({ length: 16 }, (_, step): DrumHit => ({ step, kind: "hat", vel: step % 2 === 1 ? 0.34 : 0.2 })),
];

const LAUNCH_DRUMS: readonly DrumHit[] = [
  { step: 0, kind: "kick", vel: 0.95 },
  { step: 8, kind: "kick", vel: 0.85 },
  { step: 10, kind: "kick", vel: 0.5 },
  { step: 4, kind: "snare", vel: 0.72 },
  { step: 12, kind: "snare", vel: 0.72 },
  ...shakers(0.32, 0.18, true),
];

const BLOCK_FILL: readonly DrumHit[] = [
  { step: 12, kind: "blockHi", vel: 0.4 },
  { step: 13, kind: "blockLo", vel: 0.35 },
  { step: 14, kind: "blockHi", vel: 0.45 },
  { step: 15, kind: "blockLo", vel: 0.4 },
];

const SNARE_FILL: readonly DrumHit[] = [
  { step: 12, kind: "snare", vel: 0.45 },
  { step: 13, kind: "snare", vel: 0.55 },
  { step: 14, kind: "snare", vel: 0.68 },
  { step: 15, kind: "snare", vel: 0.82 },
];

const TOM_FILL: readonly DrumHit[] = [
  { step: 12, kind: "tomHi", vel: 0.6 },
  { step: 13, kind: "tomHi", vel: 0.55 },
  { step: 14, kind: "tomLo", vel: 0.7 },
  { step: 15, kind: "tomLo", vel: 0.8 },
];

/** Per-mood arrangement of the tune (pure table; bpm before the tune's nudge). */
export const ARRANGEMENTS: Readonly<Record<SongId, Arrangement>> = {
  lobby: {
    mode: "major", bpm: 98, swing: 0.2, strumSpread: 0.016, strum: ISLAND_STRUM, pick: false, tremolo: false, bass: LOBBY_BASS,
    leadA: { inst: "xylo", vel: 0.78, octave: 0 }, leadB: { inst: "kazoo", vel: 0.62, octave: -12 }, kazooB: 0, arp: "B",
    drums: LOBBY_DRUMS, fill: BLOCK_FILL, crashEvery: 0, thin: 0,
  },
  day: {
    mode: "major", bpm: 108, swing: 0.16, strumSpread: 0.014, strum: ISLAND_STRUM, pick: false, tremolo: false, bass: LOBBY_BASS,
    leadA: { inst: "pan", vel: 0.85, octave: 0 }, leadB: { inst: "xylo", vel: 0.85, octave: 0 }, kazooB: 0.45, arp: "B",
    drums: DAY_DRUMS, fill: BLOCK_FILL, crashEvery: 0, thin: 0,
  },
  dusk: {
    mode: "major", bpm: 100, swing: 0.12, strumSpread: 0.02, strum: HALF_STRUM, pick: false, tremolo: false, bass: LONG_BASS,
    leadA: { inst: "xylo", vel: 0.5, octave: 0 }, leadB: { inst: "pan", vel: 0.5, octave: -12 }, kazooB: 0, arp: "none",
    drums: DUSK_DRUMS, fill: [], crashEvery: 0, thin: 0.35,
  },
  night: {
    mode: "minor", bpm: 90, swing: 0.1, strumSpread: 0.02, strum: [], pick: true, tremolo: false, bass: DRONE_BASS,
    leadA: { inst: "xylo", vel: 0.5, octave: 0 }, leadB: { inst: "pan", vel: 0.45, octave: -12 }, kazooB: 0, arp: "none",
    drums: NIGHT_DRUMS, fill: [], crashEvery: 0, thin: 0.3,
  },
  boss: {
    mode: "minor", bpm: 124, swing: 0, strumSpread: 0.01, strum: DRIVING_STRUM, pick: false, tremolo: false, bass: OCTAVE_BASS,
    leadA: { inst: "kazoo", vel: 0.72, octave: -12 }, leadB: { inst: "kazoo", vel: 0.78, octave: 0 }, kazooB: 0, arp: "B",
    drums: BOSS_DRUMS, fill: TOM_FILL, crashEvery: 4, thin: 0,
  },
  storm: {
    mode: "minor", bpm: 136, swing: 0, strumSpread: 0.008, strum: [], pick: false, tremolo: true, bass: OCTAVE_BASS,
    leadA: { inst: "kazoo", vel: 0.78, octave: -12 }, leadB: { inst: "xylo", vel: 0.85, octave: 0 }, kazooB: 0.5, arp: "all",
    drums: STORM_DRUMS, fill: SNARE_FILL, crashEvery: 2, thin: 0.15,
  },
  launch: {
    mode: "major", bpm: 128, swing: 0.06, strumSpread: 0.011, strum: DRIVING_STRUM, pick: false, tremolo: false, bass: OCTAVE_BASS,
    leadA: { inst: "kazoo", vel: 0.82, octave: 0 }, leadB: { inst: "pan", vel: 0.9, octave: 0 }, kazooB: 0, arp: "all",
    drums: LAUNCH_DRUMS, fill: SNARE_FILL, crashEvery: 4, thin: 0,
  },
  lose: {
    mode: "minor", bpm: 78, swing: 0.1, strumSpread: 0.024, strum: HALF_STRUM, pick: false, tremolo: false, bass: LONG_BASS,
    leadA: { inst: "kazoo", vel: 0.45, octave: -12 }, leadB: { inst: "xylo", vel: 0.38, octave: 0 }, kazooB: 0, arp: "none",
    drums: [], fill: [], crashEvery: 0, thin: 0.45,
  },
};

/** Minor-mode spelling of a major-mode roman numeral (same degree): I→i, ii→iv (avoids ii°), V→V7 (harmonic). */
const MINOR_NUMERAL: readonly string[] = ["i", "iv", "III", "iv", "V7", "VI", "VII"];

function realizeChord(numeral: string, key: number, mode: Mode): { degree: number; chord: ChordDef } {
  const degree = romanDegree(numeral);
  if (mode === "major") return parseRoman(numeral, key, "major");
  return { degree, chord: parseRoman(MINOR_NUMERAL[degree]!, key, "minor").chord };
}

/** Lead tonic MIDI note for a key (C5..G#5 region; high keys drop an octave). */
export function leadTonic(key: number): number {
  const t = 72 + key;
  return t > 76 ? t - 12 : t;
}

function drumEvent(hit: DrumHit): ScoreEvent {
  switch (hit.kind) {
    case "blockHi":
    case "blockLo":
      return { kind: "block", high: hit.kind === "blockHi", vel: hit.vel };
    case "tomLo":
    case "tomHi":
      return { kind: "tom", pitch: hit.kind === "tomHi" ? 0.7 : 0.1, vel: hit.vel };
    default:
      return { kind: hit.kind, vel: hit.vel };
  }
}

/** Arrange one mood of a tune. */
export function arrangeSong(tune: Tune, id: SongId): Song {
  const arr = ARRANGEMENTS[id];
  const rng = mulberry32((tune.seed * 31 + SONG_IDS.indexOf(id) * 7919) >>> 0);
  const grid = new StepGrid(SONG_BARS * STEPS_PER_BAR);
  const progs = [tune.progA, tune.progA, tune.progB, tune.progA];
  const phrases = [tune.phraseA, tune.phraseA2, tune.phraseB, tune.phraseA2];
  const bars: ChordDef[] = [];
  const chordDegrees: number[] = [];
  for (let section = 0; section < 4; section++) {
    for (let i = 0; i < 4; i++) {
      const { degree, chord } = realizeChord(progs[section]![i]!, tune.key, arr.mode);
      bars.push(chord);
      chordDegrees.push(degree);
    }
  }
  // Harmony, bass, arpeggios, drums per bar.
  bars.forEach((chord, b) => {
    const base = b * STEPS_PER_BAR;
    const sectionB = b >= 8 && b < 12;
    if (arr.tremolo) {
      for (let s = 0; s < STEPS_PER_BAR; s++) grid.add(base + s, { kind: "strum", voicing: chord.uke, dir: s % 2 === 0 ? "down" : "up", vel: s % 4 === 0 ? 0.55 : 0.34, holdSteps: 1 });
    }
    arr.strum.forEach((hit, i) => {
      const next = arr.strum[i + 1]?.step ?? STEPS_PER_BAR + (arr.strum[0]?.step ?? 0);
      grid.add(base + hit.step, { kind: "strum", voicing: chord.uke, dir: hit.dir, vel: hit.vel, holdSteps: next - hit.step });
    });
    if (arr.pick) {
      const pattern: readonly Degree[] = ["R", "5", "8", "10", "8", "5", "R", "5"];
      pattern.forEach((d, i) => {
        grid.add(base + i * 2, { kind: "pluck", midi: 60 + chord.root + degreeOffset(chord, d), vel: i === 0 ? 0.5 : 0.34, holdSteps: 3 });
      });
    }
    for (const hit of arr.bass) grid.add(base + hit.step, { kind: "bass", midi: bassRoot(chord) + degreeOffset(chord, hit.degree), lenSteps: hit.len, vel: hit.vel });
    if (arr.arp === "all" || (arr.arp === "B" && sectionB)) {
      const arp: ReadonlyArray<[number, Degree]> = [
        [2, "5"],
        [6, "8"],
        [10, "3"],
        [14, "5"],
      ];
      for (const [step, d] of arp) grid.add(base + step, { kind: "xylo", midi: 79 + chord.root - (chord.root > 4 ? 12 : 0) + degreeOffset(chord, d), vel: 0.28 });
    }
    const fillBar = arr.fill.length > 0 && (b === 7 || b === 15);
    for (const hit of arr.drums) {
      if (fillBar && hit.step >= 12 && hit.kind !== "shaker" && hit.kind !== "hat") continue;
      grid.add(base + hit.step, drumEvent(hit));
    }
    if (fillBar) for (const hit of arr.fill) grid.add(base + hit.step, drumEvent(hit));
    const afterFill = arr.fill.length > 0 && (b === 0 || b === 8);
    if (afterFill || (arr.crashEvery > 0 && b % arr.crashEvery === 0)) grid.add(base, { kind: "crash", vel: 0.5 });
  });
  // Melody: the tune's degrees in this mood's mode, on this mood's lead instruments.
  const tonic = leadTonic(tune.key);
  phrases.forEach((phrase, section) => {
    const lead = section === 2 ? arr.leadB : arr.leadA;
    let prevMidi: number | null = null;
    for (const n of phrase) {
      if (arr.thin > 0 && rng() < arr.thin && n.len < 8) continue;
      const bar = section * 4 + Math.floor(n.step / STEPS_PER_BAR);
      const overV = arr.mode === "minor" && chordDegrees[bar] === 4;
      const midi = tonic + degreeSemitones(n.degree, arr.mode, overV);
      const step = section * 64 + n.step;
      if (lead) {
        const m = midi + lead.octave;
        if (lead.inst === "kazoo") {
          const glide = prevMidi !== null && Math.abs(prevMidi - m) <= 3 && rng() < 0.25 ? prevMidi : undefined;
          grid.add(step, { kind: "kazoo", midi: m, lenSteps: n.len, vel: lead.vel, glideFrom: glide, droop: id === "lose" && n.len >= 8 ? 1.5 : undefined });
          prevMidi = m;
        } else {
          grid.add(step, { kind: lead.inst, midi: m, vel: lead.vel });
        }
      }
      if (section === 2 && arr.kazooB > 0) grid.add(step, { kind: "kazoo", midi: midi - 12, lenSteps: n.len, vel: arr.kazooB });
    }
  });
  return {
    id,
    bpm: arr.bpm + tune.tempoNudge,
    swing: arr.swing,
    strumSpread: arr.strumSpread,
    mode: arr.mode,
    length: grid.steps.length,
    steps: grid.steps,
    bars,
  };
}

/** Every mood's song for an island seed. */
export function composeSongBook(seed: number): SongBook {
  const tune = composeTune(seed);
  const songs = {} as Record<SongId, Song>;
  for (const id of SONG_IDS) songs[id] = arrangeSong(tune, id);
  return { seed: tune.seed, tune, songs };
}
