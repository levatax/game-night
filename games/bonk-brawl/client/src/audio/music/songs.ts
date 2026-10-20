// The two loops: a relaxed lobby tune (F major, 110 BPM) and the fight tune (C major, 120 BPM)
// with a sudden-death tension layer. Patterns are per bar (16 steps of a 16th note).

import { StepGrid, type ScoreEvent } from "./score";
import { bassRoot, chordAt, degreeOffset, parseChords, parseMelody, type ChordDef, type Degree, type NoteEvent } from "./theory";

export type SongId = "lobby" | "fight";

const STEPS_PER_BAR = 16;

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

interface ArpHit {
  step: number;
  degree: Degree;
  vel: number;
}

interface DrumHit {
  step: number;
  kind: "kick" | "snare" | "shaker" | "hat" | "blockHi" | "blockLo";
  vel: number;
}

interface SongSource {
  bpm: number;
  /** Fraction of a step that off-16ths are delayed (shuffle feel). */
  swing: number;
  strumSpread: number;
  chords: string;
  kazoo: string;
  /** Semitones applied to the kazoo part (the lobby hums the xylophone tune an octave down). */
  kazooTranspose: number;
  kazooVel: number;
  lead: string;
  leadVel: number;
  /** Bars (0-based) where the xylophone arpeggio counter-line plays. */
  arpBars: readonly number[];
  arpOctave: number;
  strum: readonly StrumHit[];
  bass: readonly BassHit[];
  arp: readonly ArpHit[];
  drums: readonly DrumHit[];
  /** Bars ending in a fill; the next downbeat gets a crash. */
  fillBars: readonly number[];
  fill: readonly DrumHit[];
  /** Fill steps replace the regular drums from this step of the fill bar on. */
  fillFrom: number;
}

export interface Song {
  id: SongId;
  bpm: number;
  swing: number;
  strumSpread: number;
  /** Total loop length in steps. */
  length: number;
  /** Events per loop step. */
  steps: ReadonlyArray<ReadonlyArray<ScoreEvent>>;
  /** Sudden-death tension layer per loop step (empty for songs without one). */
  tension: ReadonlyArray<ReadonlyArray<ScoreEvent>>;
}

/* ---------------------------------------------------------------- patterns */

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

const LOBBY_BASS: readonly BassHit[] = [
  { step: 0, degree: "R", len: 5, vel: 0.9 },
  { step: 6, degree: "5", len: 2, vel: 0.6 },
  { step: 8, degree: "R", len: 3, vel: 0.75 },
  { step: 12, degree: "5", len: 2, vel: 0.62 },
  { step: 14, degree: "3", len: 2, vel: 0.5 },
];

/** Bouncy octave bass. */
const FIGHT_BASS: readonly BassHit[] = [
  { step: 0, degree: "R", len: 2, vel: 1 },
  { step: 2, degree: "8", len: 2, vel: 0.55 },
  { step: 4, degree: "5", len: 2, vel: 0.8 },
  { step: 6, degree: "8", len: 2, vel: 0.55 },
  { step: 8, degree: "R", len: 2, vel: 0.9 },
  { step: 10, degree: "8", len: 2, vel: 0.55 },
  { step: 12, degree: "5", len: 2, vel: 0.8 },
  { step: 14, degree: "3", len: 2, vel: 0.65 },
];

const OFFBEAT_ARP: readonly ArpHit[] = [
  { step: 2, degree: "5", vel: 0.32 },
  { step: 6, degree: "8", vel: 0.3 },
  { step: 10, degree: "3", vel: 0.32 },
  { step: 14, degree: "5", vel: 0.3 },
];

const LOBBY_DRUMS: readonly DrumHit[] = [
  { step: 0, kind: "kick", vel: 0.55 },
  { step: 8, kind: "kick", vel: 0.45 },
  { step: 4, kind: "blockLo", vel: 0.35 },
  { step: 12, kind: "blockLo", vel: 0.35 },
  ...[0, 2, 4, 6, 8, 10, 12, 14].map((step): DrumHit => ({ step, kind: "shaker", vel: step % 4 === 2 ? 0.32 : 0.18 })),
];

const LOBBY_FILL: readonly DrumHit[] = [
  { step: 12, kind: "blockHi", vel: 0.4 },
  { step: 13, kind: "blockLo", vel: 0.35 },
  { step: 14, kind: "blockHi", vel: 0.45 },
  { step: 15, kind: "blockLo", vel: 0.4 },
];

const FIGHT_DRUMS: readonly DrumHit[] = [
  { step: 0, kind: "kick", vel: 0.9 },
  { step: 8, kind: "kick", vel: 0.8 },
  { step: 10, kind: "kick", vel: 0.5 },
  { step: 4, kind: "snare", vel: 0.7 },
  { step: 12, kind: "snare", vel: 0.7 },
  ...Array.from({ length: 16 }, (_, step): DrumHit => ({ step, kind: "shaker", vel: step % 2 === 1 ? 0.3 : 0.16 })),
];

const FIGHT_FILL: readonly DrumHit[] = [
  { step: 12, kind: "snare", vel: 0.45 },
  { step: 13, kind: "snare", vel: 0.55 },
  { step: 14, kind: "snare", vel: 0.68 },
  { step: 15, kind: "snare", vel: 0.82 },
];

/* ------------------------------------------------------------------- songs */

const LOBBY_MELODY = [
  "C6/2 A5/2 F5/2 A5/2 C6/4 -/4",
  "D6/2 C6/2 A5/4 F5/4 -/4",
  "G5/2 A5/2 Bb5/2 D6/2 C6/4 Bb5/4",
  "Bb5/2 A5/2 G5/2 E5/2 C5/4 -/4",
  "F5/2 A5/2 C6/2 F6/2 E6/2 D6/2 C6/4",
  "D6/4 A5/4 F5/4 D5/4",
  "D6/2 C6/2 Bb5/4 G5/2 Bb5/2 E6/4",
  "F6/4 C6/2 A5/2 F5/4 -/4",
].join(" | ");

const REST_BAR = "-/16";
const rests = (bars: number): string => Array.from({ length: bars }, () => REST_BAR).join(" | ");

const LOBBY: SongSource = {
  bpm: 110,
  swing: 0.2,
  strumSpread: 0.016,
  chords: "F | Dm | Gm | C7 | F | Dm | Bb C7 | F | F | Dm | Gm | C7 | F | Dm | Bb C7 | F",
  lead: `${LOBBY_MELODY} | ${rests(8)}`,
  leadVel: 0.85,
  // Second half: the kazoo hums the same tune an octave down, with a couple of goofy slides.
  kazoo: `${rests(8)} | ${LOBBY_MELODY.replace("E5/2 C5/4", "E5/2 ~C5/4").replace("D5/4", "~D5/4")}`,
  kazooTranspose: -12,
  kazooVel: 0.7,
  arpBars: [8, 9, 10, 11, 12, 13, 14, 15],
  arpOctave: 72,
  strum: ISLAND_STRUM,
  bass: LOBBY_BASS,
  arp: OFFBEAT_ARP,
  drums: LOBBY_DRUMS,
  fillBars: [7, 15],
  fill: LOBBY_FILL,
  fillFrom: 12,
};

const FIGHT_A = [
  "G4/2 C5/2 E5/2 G5/4 E5/2 C5/2 E5/2",
  "A5/4 G5/2 E5/2 C5/4 -/4",
  "F5/2 F5/2 A5/2 F5/2 C5/4 A4/2 C5/2",
  "D5/2 B4/2 G4/4 B4/2 D5/2 G5/4",
  "E5/2 G5/2 A5/2 G5/2 E5/2 C5/2 D5/4",
  "C5/2 A4/2 C5/4 E5/4 -/4",
  "F5/4 A5/4 G5/4 B4/4",
  "C5/8 -/4 E5/2 G5/2",
].join(" | ");

const FIGHT_B_LEAD = [
  "A5/4 A5/2 G5/2 F5/4 C5/4",
  "D5/2 F5/2 A5/2 G5/2 F5/8",
  "G5/4 G5/2 E5/2 C5/4 E5/4",
  "G5/2 E5/2 C5/4 -/8",
].join(" | ");

const FIGHT_B_KAZOO = [
  "F#5/4 F#5/2 E5/2 D5/4 A4/4",
  "C5/2 D5/2 F#5/2 A5/2 ~F#5/8",
  "G5/4 D5/4 B4/4 G4/4",
  "F5/2 E5/2 D5/2 B4/2 G4/2 A4/2 B4/2 -/2",
].join(" | ");

const FIGHT: SongSource = {
  bpm: 120,
  swing: 0.08,
  strumSpread: 0.011,
  chords: "C | Am | F | G | C | Am | F G | C | F | F | C | C | D7 | D7 | G | G7",
  kazoo: `${FIGHT_A} | ${rests(4)} | ${FIGHT_B_KAZOO}`,
  kazooTranspose: 0,
  kazooVel: 0.8,
  lead: `${rests(8)} | ${FIGHT_B_LEAD} | ${rests(4)}`,
  leadVel: 0.9,
  arpBars: [0, 1, 2, 3, 4, 5, 6, 7, 12, 13, 14, 15],
  arpOctave: 84,
  strum: DRIVING_STRUM,
  bass: FIGHT_BASS,
  arp: OFFBEAT_ARP,
  drums: FIGHT_DRUMS,
  fillBars: [7, 15],
  fill: FIGHT_FILL,
  fillFrom: 12,
};

/* --------------------------------------------------------------- arranger */

function compile(id: SongId, src: SongSource, withTension: boolean): Song {
  const bars = parseChords(src.chords);
  const length = bars.length * STEPS_PER_BAR;
  const grid = new StepGrid(length);
  bars.forEach((bar, b) => arrangeBar(grid, src, bar, b, bars.length));
  addMelody(grid, parseMelody(src.lead), (n) => ({ kind: "xylo", midi: n.midi, vel: src.leadVel }));
  addKazoo(grid, parseMelody(src.kazoo, src.kazooTranspose), src.kazooVel);
  return {
    id,
    bpm: src.bpm,
    swing: src.swing,
    strumSpread: src.strumSpread,
    length,
    steps: grid.steps,
    tension: withTension ? tensionLayer(bars) : [],
  };
}

function arrangeBar(grid: StepGrid, src: SongSource, bar: readonly ChordDef[], b: number, barCount: number): void {
  const base = b * STEPS_PER_BAR;
  src.strum.forEach((hit, i) => {
    const next = src.strum[i + 1]?.step ?? STEPS_PER_BAR + (src.strum[0]?.step ?? 0);
    const c = chordAt(bar, hit.step);
    grid.add(base + hit.step, { kind: "strum", voicing: c.uke, dir: hit.dir, vel: hit.vel, holdSteps: next - hit.step });
  });
  for (const hit of src.bass) {
    const c = chordAt(bar, hit.step);
    grid.add(base + hit.step, { kind: "bass", midi: bassRoot(c) + degreeOffset(c, hit.degree), lenSteps: hit.len, vel: hit.vel });
  }
  if (src.arpBars.includes(b)) {
    for (const hit of src.arp) {
      const c = chordAt(bar, hit.step);
      grid.add(base + hit.step, { kind: "xylo", midi: src.arpOctave + c.root + degreeOffset(c, hit.degree), vel: hit.vel });
    }
  }
  const isFill = src.fillBars.includes(b);
  for (const hit of src.drums) {
    if (isFill && hit.step >= src.fillFrom && hit.kind !== "shaker") continue;
    grid.add(base + hit.step, drumEvent(hit));
  }
  if (isFill) for (const hit of src.fill) grid.add(base + hit.step, drumEvent(hit));
  const afterFill = src.fillBars.includes((b + barCount - 1) % barCount);
  if (afterFill) grid.add(base, { kind: "crash", vel: 0.55 });
}

function drumEvent(hit: DrumHit): ScoreEvent {
  if (hit.kind === "blockHi" || hit.kind === "blockLo") return { kind: "block", high: hit.kind === "blockHi", vel: hit.vel };
  return { kind: hit.kind, vel: hit.vel };
}

function addMelody(grid: StepGrid, notes: readonly NoteEvent[], make: (n: NoteEvent) => ScoreEvent): void {
  for (const n of notes) grid.add(n.step, make(n));
}

function addKazoo(grid: StepGrid, notes: readonly NoteEvent[], vel: number): void {
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    const glideFrom = n.slide && prev ? prev.midi : undefined;
    grid.add(n.step, { kind: "kazoo", midi: n.midi, lenSteps: n.len, vel, glideFrom });
  });
}

/** Sudden death: four-on-the-floor, ticking woodblock, 16th hats and a nervous xylophone pulse. */
function tensionLayer(bars: readonly (readonly ChordDef[])[]): ScoreEvent[][] {
  const grid = new StepGrid(bars.length * STEPS_PER_BAR);
  const pulse: readonly Degree[] = ["R", "5", "8", "5"];
  bars.forEach((bar, b) => {
    const base = b * STEPS_PER_BAR;
    for (let s = 0; s < STEPS_PER_BAR; s++) {
      grid.add(base + s, { kind: "hat", vel: s % 2 === 1 ? 0.34 : 0.2 });
      const c = chordAt(bar, s);
      grid.add(base + s, { kind: "xylo", midi: 72 + c.root + degreeOffset(c, pulse[s % pulse.length]), vel: s % 4 === 0 ? 0.26 : 0.17 });
      if (s % 4 === 0) grid.add(base + s, { kind: "kick", vel: 0.55 });
      if (s % 2 === 0) grid.add(base + s, { kind: "block", high: s % 4 === 0, vel: 0.3 });
    }
  });
  return grid.steps;
}

export const SONGS: Readonly<Record<SongId, Song>> = {
  lobby: compile("lobby", LOBBY, false),
  fight: compile("fight", FIGHT, true),
};

/** Raw melody sources (bar-length checks in the dev harness). */
export const SONG_SOURCES: Readonly<Record<SongId, { chords: string; kazoo: string; lead: string }>> = {
  lobby: LOBBY,
  fight: FIGHT,
};
