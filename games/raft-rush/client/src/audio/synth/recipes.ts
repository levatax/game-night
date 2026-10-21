// A procedural recipe for every SfxName (Sfx.ts) plus its mix definition (bus, positional, volume, voice cap).
// Owner: client-fx-audio. Style and several recipes come from games/bonk-brawl/client/src/audio/synth/
// sfxRecipes.ts (throw fwip, BONK, catch thwap, splash, UI blips) and games/jelly-jackpot/client/src/audio/sfx/
// foley.ts (kazoo toots, crowd); the rest is island foley: wood "tok", stone clack, coconut thunk, crab clicks,
// ship horn, reel ratchet, rooster, thunder. A recipe schedules nodes into a Synth starting at s.t; raw levels
// peak around 0.5–0.9 before SFX_DEFS volume and the buses (tune with the offline meter in dev/audio.html).

import { SFX_NAMES, type SfxName } from "../Sfx";
import { crowdAww, crowdCheer, speak, type Speaker } from "../voices";
import {
  BELL_PARTIALS,
  WOOD_PARTIALS,
  blip,
  boing,
  chirp,
  click,
  crackle,
  droplet,
  formantChain,
  glug,
  grains,
  knock,
  noiseBurst,
  squelch,
  struck,
  thump,
  vibrato,
  type Formant,
  type Partial,
} from "./blocks";
import { midiToFreq, rand, type CurvePoint, type Synth } from "./dsp";

export type SfxRecipe = (s: Synth) => void;
export type SfxBus = "sfx" | "ui";

export interface SfxDef {
  bus: SfxBus;
  /** Played through a PannerNode when PlayOptions.pos is given (else always flat). */
  positional: boolean;
  /** Base gain 0..1 before PlayOptions.volume and the buses. */
  volume: number;
  /** Simultaneous copies before the oldest is stolen. */
  cap: number;
}

const KAZOO: ReadonlyArray<Formant> = [
  [700, 3, 1.4],
  [1400, 4, 0.9],
  [2600, 5, 0.45],
];
const STONE_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [2.76, 0.5, 0.5],
  [5.4, 0.25, 0.3],
];
const SHELL_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [1.6, 0.45, 0.6],
  [3.1, 0.2, 0.3],
];
const GONG_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [1.48, 0.6, 0.8],
  [2.0, 0.45, 0.7],
  [2.76, 0.3, 0.55],
  [3.4, 0.2, 0.45],
];
const XYLO: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [3, 0.32, 0.3],
  [6.2, 0.08, 0.12],
];

/* --------------------------------------------------------------- helpers */

/** Leaves / bush rustle: band-passed noise with a jittery tremolo. */
function rustleBed(s: Synth, at: number, dur: number, level: number, from = 2200, to = 3400): void {
  const g = s.gain(0);
  const trem = s.tremolo(rand(15, 22), 0.75, at, at + dur + 0.02, g);
  const band = s.filter("bandpass", from, 0.9, trem);
  s.noise("white", at, at + dur + 0.02, band);
  s.freq(band.frequency, [
    [at, from],
    [at + dur * 0.5, to, "exp"],
    [at + dur, from * 0.8, "exp"],
  ]);
  s.curve(g.gain, [
    [at, 0],
    [at + dur * 0.2, level],
    [at + dur * 0.7, level * 0.7],
    [at + dur, 0.001, "exp"],
  ]);
}

/** Wooden creak: a slow sawtooth through a narrow resonance. */
function creak(s: Synth, at: number, dur: number, level: number, f0 = 95, f1 = 65, band = 900): void {
  const g = s.gain(0);
  const bp = s.filter("bandpass", band, 11, g);
  const o = s.osc("sawtooth", f0, at, at + dur + 0.02, bp);
  s.freq(o.frequency, [
    [at, f0],
    [at + dur, f1],
  ]);
  s.lfo(13, 6 * s.rate, o.frequency, at, at + dur);
  s.curve(g.gain, [
    [at, 0],
    [at + 0.05, level * 2],
    [at + dur * 0.75, level * 1.5],
    [at + dur, 0.001, "exp"],
  ]);
}

/** Air whoosh: band-passed noise sweeping up then down. */
function whoosh(s: Synth, at: number, dur: number, level: number, lo = 600, hi = 2800, color: "white" | "pink" = "white"): void {
  const g = s.gain(0);
  const band = s.filter("bandpass", lo, 1.5, g);
  s.noise(color, at, at + dur + 0.02, band);
  s.freq(band.frequency, [
    [at, lo],
    [at + dur * 0.25, hi, "exp"],
    [at + dur, lo * 1.1, "exp"],
  ]);
  s.curve(g.gain, [
    [at, 0],
    [at + dur * 0.2, level],
    [at + dur, 0.001, "exp"],
  ]);
}

/** Water splash body (crash + plop + droplets). */
function splashBody(s: Synth, at: number, level: number, size = 1): void {
  noiseBurst(s, at, 0.32 * size, 0.8 * level, { type: "lowpass", from: 3600, to: 380, q: 0.8, attack: 0.008 });
  noiseBurst(s, at, 0.12 * size, 0.45 * level, { type: "bandpass", from: 1300, to: 480, q: 1, color: "pink" });
  const g = s.gain(0);
  const o = s.osc("sine", 520 / Math.sqrt(size), at, at + 0.14, g);
  s.freq(o.frequency, [
    [at, 520 / Math.sqrt(size)],
    [at + 0.09, 170 / Math.sqrt(size), "exp"],
  ]);
  s.perc(g.gain, at, 0.5 * level, 0.004, 0.11);
  for (let i = 0; i < 5; i++) droplet(s, at + 0.05 + Math.random() * 0.35 * size, rand(900, 2300), 0.12 * level);
}

/** Kazoo toot through the formant chain (party horns, sad wahs, roosters). */
function kazooNote(s: Synth, at: number, points: ReadonlyArray<CurvePoint>, dur: number, level: number, vibratoCents = 18): void {
  const g = s.gain(0);
  const chain = formantChain(s, 2.6, KAZOO, s.filter("lowpass", 4200, 0.7, g));
  const o = s.osc("sawtooth", points[0]![1], at, at + dur + 0.06, chain);
  s.freq(o.frequency, points.map((p): CurvePoint => [at + p[0], p[1], p[2] ?? "exp"]));
  if (vibratoCents > 0) vibrato(s, o, at, dur, 5.8, vibratoCents, Math.min(0.12, dur * 0.3));
  s.curve(g.gain, [
    [at, 0],
    [at + 0.03, level],
    [at + dur * 0.8, level * 0.8],
    [at + dur, 0.001, "exp"],
  ]);
}

/** Ship horn ("HOOONK"): two detuned low saws through throat formants. */
function shipHorn(s: Synth, at: number, dur: number, level: number, f = 98): void {
  const g = s.gain(0);
  const chain = formantChain(s, 3.2, [
    [380, 3, 1.4],
    [820, 4, 0.8],
    [1700, 6, 0.3],
  ], s.filter("lowpass", 2400, 0.7, g));
  for (const k of [1, 1.5, 1.006]) {
    const o = s.osc("sawtooth", f * k, at, at + dur + 0.1, s.gain(0.4, chain));
    s.freq(o.frequency, [
      [at, f * k * 0.96],
      [at + 0.12, f * k, "exp"],
    ]);
  }
  s.curve(g.gain, [
    [at, 0],
    [at + 0.12, level],
    [at + dur * 0.85, level * 0.9],
    [at + dur, 0.001, "exp"],
  ]);
}

/** Ratchet: clicks whose interval goes from i0 to i1 seconds. */
function ratchet(s: Synth, at: number, dur: number, i0: number, i1: number, level: number): void {
  let t = at;
  while (t < at + dur) {
    const k = (t - at) / dur;
    struck(s, t, 1400 * rand(0.95, 1.05), 0.03, level, WOOD_PARTIALS);
    click(s, t, level * 0.5, 4200);
    t += i0 + (i1 - i0) * k;
  }
}

/** Distant rumble (thunder tail, boss, storm). */
function rumble(s: Synth, at: number, dur: number, level: number, from = 380, to = 70): void {
  const g = s.gain(0);
  const trem = s.tremolo(rand(2.5, 4), 0.55, at, at + dur + 0.02, g);
  const lp = s.filter("lowpass", from, 0.9, trem);
  s.noise("brown", at, at + dur + 0.02, lp);
  s.freq(lp.frequency, [
    [at, from],
    [at + dur, to, "exp"],
  ]);
  s.curve(g.gain, [
    [at, 0],
    [at + 0.08, level],
    [at + dur * 0.5, level * 0.6],
    [at + dur, 0.001, "exp"],
  ]);
}

const MONKEY: Speaker = { pitch: 340, formant: 1.3, vibRate: 9, vibDepth: 0.06, buzz: 0.45 };

/* ------------------------------------------------------------------ ui */

const uiClick: SfxRecipe = (s) => blip(s, 0, 380, 1150, 0.06, 0.7, "sine");
const uiHover: SfxRecipe = (s) => blip(s, 0, 2400, 2600, 0.025, 0.5, "sine");
const uiOpen: SfxRecipe = (s) => {
  knock(s, 0, 660, 0.4, 0.06);
  knock(s, 0.06, 990, 0.45, 0.08);
  noiseBurst(s, 0, 0.12, 0.12, { type: "bandpass", from: 800, to: 3000, q: 1.2 });
};
const uiClose: SfxRecipe = (s) => {
  knock(s, 0, 990, 0.38, 0.06);
  knock(s, 0.055, 620, 0.42, 0.08);
};
const uiError: SfxRecipe = (s) => {
  for (const [at, f0, f1] of [
    [0, 180, 120],
    [0.17, 150, 95],
  ] as const) {
    const g = s.gain(0);
    const o = s.osc("sawtooth", f0, at, at + 0.17, s.filter("lowpass", 900, 1.5, g));
    s.freq(o.frequency, [
      [at, f0],
      [at + 0.14, f1, "exp"],
    ]);
    s.perc(g.gain, at, 0.6, 0.01, 0.15);
  }
};
const uiTick: SfxRecipe = (s) => {
  struck(s, 0, 1050, 0.06, 0.5, WOOD_PARTIALS);
  click(s, 0, 0.25, 3000);
};

/* ---------------------------------------------------- gathering & items */

const chop: SfxRecipe = (s) => {
  knock(s, 0, rand(380, 460), 0.7, 0.12);
  thump(s, 0, 160, 80, 0.08, 0.5);
  noiseBurst(s, 0, 0.05, 0.4, { type: "bandpass", from: 2400, to: 1200, q: 1.4 });
  grains(s, 0.01, 0.1, 3, 0.12, 1500, 3500);
};
const chopDone: SfxRecipe = (s) => {
  knock(s, 0, 330, 0.8, 0.16);
  noiseBurst(s, 0, 0.18, 0.6, { type: "bandpass", from: 3000, to: 700, q: 0.9 });
  creak(s, 0.08, 0.5, 0.7);
  rustleBed(s, 0.2, 0.5, 0.35);
  thump(s, 0.45, 110, 45, 0.25, 0.6);
};
const mine: SfxRecipe = (s) => {
  struck(s, 0, rand(1300, 1600), 0.12, 0.45, STONE_PARTIALS);
  click(s, 0, 0.6, 4000);
  noiseBurst(s, 0, 0.08, 0.35, { type: "highpass", from: 2500, q: 0.7 });
  grains(s, 0.02, 0.18, 4, 0.12, 2000, 6000);
  thump(s, 0, 140, 70, 0.06, 0.3);
};
const mineDone: SfxRecipe = (s) => {
  struck(s, 0, 1200, 0.14, 0.5, STONE_PARTIALS);
  click(s, 0, 0.6, 3600);
  thump(s, 0, 90, 40, 0.3, 0.7);
  noiseBurst(s, 0, 0.5, 0.5, { type: "lowpass", from: 420, to: 120, color: "brown", attack: 0.02 });
  grains(s, 0.02, 0.5, 14, 0.25, 600, 3000);
};
const rustle: SfxRecipe = (s) => rustleBed(s, 0, 0.35, 0.6);
const berry: SfxRecipe = (s) => {
  blip(s, 0, 500, 1300, 0.05, 0.5);
  squelch(s, 0.02, 0.12, 0.35, 400, 1600);
};
const pickup: SfxRecipe = (s) => {
  blip(s, 0, 280, 950, 0.12, 0.75, "sine");
  blip(s, 0, 560, 1900, 0.08, 0.12, "triangle");
};
const drop: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.1, 0.5, { type: "lowpass", from: 700, to: 200, color: "pink" });
  thump(s, 0, 130, 60, 0.09, 0.5);
  thump(s, 0.11, 150, 70, 0.05, 0.2);
};
const coconutFall: SfxRecipe = (s) => {
  const g = s.gain(0);
  const o = s.osc("sine", 1800, 0, 0.32, g);
  s.freq(o.frequency, [
    [0, 1800],
    [0.3, 700, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.05, 0.22],
    [0.28, 0.18],
    [0.32, 0.001, "exp"],
  ]);
  struck(s, 0.3, 230, 0.16, 0.8, WOOD_PARTIALS);
  thump(s, 0.3, 170, 60, 0.15, 0.8);
  click(s, 0.3, 0.4, 1800);
};
const palmShake: SfxRecipe = (s) => {
  rustleBed(s, 0, 0.6, 0.7, 1200, 3200);
  whoosh(s, 0, 0.45, 0.35, 500, 2200, "pink");
  creak(s, 0.05, 0.4, 0.45, 120, 90, 700);
};
const craft: SfxRecipe = (s) => {
  knock(s, 0, 520, 0.5);
  knock(s, 0.1, 620, 0.5);
  knock(s, 0.2, 560, 0.55);
  [84, 88, 91, 96].forEach((m, i) => struck(s, 0.3 + i * 0.06, midiToFreq(m), 0.5, 0.25, BELL_PARTIALS));
};
const hammer: SfxRecipe = (s) => {
  for (let i = 0; i < 3; i++) {
    knock(s, i * 0.16, rand(560, 660), 0.7, 0.08);
    thump(s, i * 0.16, 200, 90, 0.05, 0.4);
  }
};
const place: SfxRecipe = (s) => {
  thump(s, 0, 120, 50, 0.18, 0.9);
  noiseBurst(s, 0, 0.2, 0.5, { type: "lowpass", from: 900, to: 200, color: "pink" });
  knock(s, 0.02, 300, 0.3);
  grains(s, 0.03, 0.25, 6, 0.1, 800, 2500);
};
const chestOpen: SfxRecipe = (s) => {
  creak(s, 0, 0.45, 0.8, 150, 210, 1100);
  knock(s, 0.42, 280, 0.5);
  struck(s, 0.46, midiToFreq(96), 0.4, 0.12, BELL_PARTIALS);
  struck(s, 0.5, midiToFreq(100), 0.4, 0.1, BELL_PARTIALS);
};
const chestClose: SfxRecipe = (s) => {
  knock(s, 0, 240, 0.8, 0.14);
  thump(s, 0, 110, 50, 0.15, 0.7);
  click(s, 0.12, 0.5, 3500);
};
const eat: SfxRecipe = (s) => {
  for (let i = 0; i < 3; i++) {
    const at = i * 0.13;
    noiseBurst(s, at, 0.07, 0.55, { type: "bandpass", from: rand(1200, 2200), to: 800, q: 1.3, color: "pink" });
    thump(s, at, 160, 90, 0.05, 0.3);
    grains(s, at, at + 0.06, 3, 0.12, 2500, 5000);
  }
};
const drink: SfxRecipe = (s) => {
  glug(s, 0, 300, 0.5);
  glug(s, 0.2, 280, 0.5);
  glug(s, 0.42, 320, 0.45);
};
const burp: SfxRecipe = (s) => {
  const g = s.gain(0);
  const chain = formantChain(s, 3, [
    [500, 4, 1.4],
    [1100, 5, 0.6],
  ], g);
  const o = s.osc("sawtooth", 95, 0, 0.55, chain);
  s.freq(o.frequency, [
    [0, 105],
    [0.1, 85],
    [0.45, 70],
  ]);
  s.lfo(28, 12 * s.rate, o.frequency, 0, 0.55);
  s.curve(g.gain, [
    [0, 0],
    [0.04, 0.7],
    [0.35, 0.55],
    [0.52, 0.001, "exp"],
  ]);
};
const spring: SfxRecipe = (s) => {
  for (let i = 0; i < 5; i++) glug(s, i * 0.09, 220 + i * 60, 0.35);
  noiseBurst(s, 0, 0.6, 0.2, { type: "bandpass", from: 1800, to: 900, q: 0.8 });
  droplet(s, 0.5, 1400, 0.3);
};

/* ------------------------------------------------------------- throwing */

const chargeStart: SfxRecipe = (s) => {
  const g = s.gain(0);
  const band = s.filter("bandpass", 400, 2, g);
  s.noise("pink", 0, 0.25, band);
  s.freq(band.frequency, [
    [0, 400],
    [0.22, 1400, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.08, 0.8],
    [0.24, 0.001, "exp"],
  ]);
  blip(s, 0, 200, 420, 0.18, 0.12, "triangle");
};
const throwFwip: SfxRecipe = (s) => {
  const g = s.gain(0);
  const band = s.filter("bandpass", 700, 1.6, g);
  s.noise("white", 0, 0.24, band);
  s.freq(band.frequency, [
    [0, 700],
    [0.04, 3400, "exp"],
    [0.21, 850, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.035, 1.4],
    [0.21, 0.001, "exp"],
  ]);
  blip(s, 0.01, 900, 1700, 0.16, 0.06);
};
const throwHeavy: SfxRecipe = (s) => {
  const g = s.gain(0);
  const lp = s.filter("lowpass", 500, 2.2, g);
  s.noise("pink", 0, 0.5, lp);
  s.freq(lp.frequency, [
    [0, 500],
    [0.07, 5200, "exp"],
    [0.46, 280, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.06, 1.2],
    [0.46, 0.001, "exp"],
  ]);
  thump(s, 0.02, 130, 45, 0.3, 0.75);
  noiseBurst(s, 0.0, 0.4, 0.35, { type: "lowpass", from: 260, to: 120, color: "brown", attack: 0.05 });
};
const toss: SfxRecipe = (s) => whoosh(s, 0, 0.2, 0.9, 500, 1600, "pink");
const catchThwap: SfxRecipe = (s) => {
  thump(s, 0, 150, 48, 0.2, 0.95);
  noiseBurst(s, 0, 0.05, 0.75, { type: "highpass", from: 1500, q: 0.7 });
  noiseBurst(s, 0, 0.1, 0.55, { type: "bandpass", from: 520, to: 280, q: 1.2, color: "pink" });
};
const bonk: SfxRecipe = (s) => {
  // Hollow coconut knock + cartoon pitch-drop "boyoyoing".
  struck(s, 0, 740, 0.1, 0.55, WOOD_PARTIALS);
  click(s, 0, 0.55, 2500);
  boing(s, 0.012, 640, 150, 0.4, 0.5, { wobbleHz: 26, wobbleDepth: 80, glide: 0.65 });
  thump(s, 0, 190, 60, 0.13, 0.65);
};
const hit: SfxRecipe = (s) => {
  thump(s, 0, 170, 60, 0.12, 0.8);
  noiseBurst(s, 0, 0.06, 0.6, { type: "bandpass", from: 1200, to: 600, q: 1 });
  click(s, 0, 0.4, 2200);
  knock(s, 0, 500, 0.25);
};
const bootBonk: SfxRecipe = (s) => {
  // Rubber squeak, hollow boot clonk, springy boing.
  const g = s.gain(0);
  const band = s.filter("bandpass", 2100, 2.5, g);
  const o = s.osc("square", 950, 0, 0.16, band);
  s.freq(o.frequency, [
    [0, 950],
    [0.035, 1550, "exp"],
    [0.1, 1250, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.008, 0.9],
    [0.13, 0.001, "exp"],
  ]);
  struck(s, 0.03, 280, 0.12, 0.6, [
    [1, 1, 1],
    [2.3, 0.5, 0.5],
  ]);
  boing(s, 0.05, 520, 140, 0.5, 0.45, { wobbleHz: 20, wobbleDepth: 70, glide: 0.6 });
};
const splash: SfxRecipe = (s) => splashBody(s, 0, 1, 1);
const stick: SfxRecipe = (s) => {
  thump(s, 0, 180, 90, 0.08, 0.7);
  click(s, 0, 0.6, 2500);
  // "Doyoyoing": the shaft quivering.
  const g = s.gain(0);
  const o = s.osc("triangle", 190, 0.01, 0.6, g);
  s.lfo(16, 25 * s.rate, o.frequency, 0.01, 0.6, [
    [0.01, 25 * s.rate],
    [0.55, 1, "exp"],
  ]);
  s.perc(g.gain, 0.01, 0.4, 0.005, 0.55);
};
const bounce: SfxRecipe = (s) => {
  thump(s, 0, 170, 80, 0.07, 0.6);
  knock(s, 0, 360, 0.25, 0.05);
  noiseBurst(s, 0, 0.04, 0.2, { type: "lowpass", from: 1200, to: 400 });
};
const swing: SfxRecipe = (s) => {
  whoosh(s, 0, 0.3, 0.9, 400, 2400);
  noiseBurst(s, 0, 0.32, 0.45, { type: "lowpass", from: 300, to: 900, color: "brown", attack: 0.05 });
};

/* ---------------------------------------------------------- fire & raft */

const fireFeed: SfxRecipe = (s) => {
  knock(s, 0, 260, 0.5, 0.1);
  thump(s, 0, 120, 55, 0.12, 0.5);
  const g = s.gain(0);
  const lp = s.filter("lowpass", 200, 1, g);
  s.noise("brown", 0.05, 0.9, lp);
  s.freq(lp.frequency, [
    [0.05, 200],
    [0.3, 1400, "exp"],
    [0.85, 500, "exp"],
  ]);
  s.curve(g.gain, [
    [0.05, 0],
    [0.25, 1.2],
    [0.85, 0.001, "exp"],
  ]);
  for (let i = 0; i < 7; i++) crackle(s, 0.15 + Math.random() * 0.7, rand(0.15, 0.35));
};
const fireLow: SfxRecipe = (s) => {
  for (let i = 0; i < 3; i++) crackle(s, i * 0.18 + rand(0, 0.05), 0.3);
  const g = s.gain(0);
  const lp = s.filter("lowpass", 900, 1, g);
  s.noise("brown", 0, 0.7, lp);
  s.freq(lp.frequency, [
    [0, 900],
    [0.7, 160, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.1, 0.6],
    [0.7, 0.001, "exp"],
  ]);
};
const fireOut: SfxRecipe = (s) => {
  noiseBurst(s, 0, 1.2, 0.7, { type: "highpass", from: 3200, to: 1400, q: 0.7, attack: 0.03 });
  for (let i = 0; i < 4; i++) glug(s, 0.2 + i * 0.15, rand(500, 800), 0.12);
  const g = s.gain(0);
  const o = s.osc("sawtooth", 160, 0.5, 1.2, s.filter("lowpass", 700, 1.4, g));
  s.freq(o.frequency, [
    [0.5, 160],
    [1.1, 85, "exp"],
  ]);
  s.perc(g.gain, 0.5, 0.35, 0.03, 0.6);
};
const deliver: SfxRecipe = (s) => {
  knock(s, 0, 300, 0.6, 0.12);
  knock(s, 0.09, 360, 0.5, 0.1);
  creak(s, 0.1, 0.3, 0.4, 110, 80, 800);
  struck(s, 0.2, midiToFreq(88), 0.4, 0.25, BELL_PARTIALS);
};
const raftStage: SfxRecipe = (s) => {
  for (let i = 0; i < 4; i++) knock(s, i * 0.09, rand(520, 640), 0.55, 0.07);
  [72, 76, 79, 84, 88].forEach((m, i) => struck(s, 0.38 + i * 0.07, midiToFreq(m), 0.6, 0.32, BELL_PARTIALS));
};
const raftReady: SfxRecipe = (s) => {
  struck(s, 0, 1250, 0.9, 0.4, BELL_PARTIALS);
  struck(s, 0.3, 1250, 0.9, 0.4, BELL_PARTIALS);
  shipHorn(s, 0.55, 1.1, 0.75);
};
const raftGnaw: SfxRecipe = (s) => {
  for (let i = 0; i < 10; i++) click(s, i * 0.05 + rand(0, 0.02), rand(0.2, 0.4), rand(1800, 3500));
  const g = s.gain(0);
  const trem = s.tremolo(22, 0.8, 0, 0.52, g);
  s.noise("white", 0, 0.52, s.filter("bandpass", 2600, 2, trem));
  s.curve(g.gain, [
    [0, 0],
    [0.05, 0.5],
    [0.45, 0.4],
    [0.52, 0.001, "exp"],
  ]);
};
const board: SfxRecipe = (s) => {
  knock(s, 0, 220, 0.6, 0.15);
  creak(s, 0.05, 0.35, 0.5, 100, 75, 750);
  noiseBurst(s, 0.08, 0.25, 0.35, { type: "lowpass", from: 2200, to: 400, q: 0.8 });
};
const launch: SfxRecipe = (s) => {
  shipHorn(s, 0, 1.6, 0.8, 87);
  const g = s.gain(0);
  const lp = s.filter("lowpass", 200, 0.8, g);
  s.noise("pink", 0.2, 2.4, lp);
  s.freq(lp.frequency, [
    [0.2, 200],
    [1.2, 2200, "exp"],
    [2.3, 300, "exp"],
  ]);
  s.curve(g.gain, [
    [0.2, 0],
    [1.1, 0.8],
    [2.3, 0.001, "exp"],
  ]);
  splashBody(s, 0.9, 0.8, 1.6);
};
const fenceBreak: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.14, 0.7, { type: "bandpass", from: 2800, to: 900, q: 0.9 });
  knock(s, 0, 300, 0.6, 0.1);
  knock(s, 0.07, 380, 0.45, 0.08);
  grains(s, 0.02, 0.35, 10, 0.22, 900, 3200);
  thump(s, 0.05, 120, 50, 0.18, 0.5);
};

/* -------------------------------------------------------------- monsters */

const crabEmerge: SfxRecipe = (s) => {
  for (let i = 0; i < 4; i++) glug(s, i * 0.08, rand(260, 420), 0.18);
  noiseBurst(s, 0.15, 0.25, 0.4, { type: "lowpass", from: 2400, to: 500, q: 0.8 });
  for (let i = 0; i < 6; i++) click(s, 0.35 + i * 0.05, 0.25, rand(2200, 3600));
};
const crabClick: SfxRecipe = (s) => {
  for (const at of [0, 0.06, 0.1]) {
    struck(s, at + rand(0, 0.01), rand(2200, 2800), 0.03, 0.4, SHELL_PARTIALS);
    click(s, at, 0.25, 4200);
  }
};
const crabBite: SfxRecipe = (s) => {
  click(s, 0, 0.9, 3200);
  struck(s, 0, 1800, 0.05, 0.6, SHELL_PARTIALS);
  noiseBurst(s, 0.01, 0.08, 0.5, { type: "bandpass", from: 900, to: 500, q: 1.2, color: "pink" });
  thump(s, 0, 140, 70, 0.08, 0.5);
};
const crabFlip: SfxRecipe = (s) => {
  // "ÇAT!" — crack, then the boing of a crab landing on its back, then frantic leg scrabbling.
  click(s, 0, 0.9, 2800);
  noiseBurst(s, 0, 0.05, 0.6, { type: "bandpass", from: 2200, q: 1.5 });
  boing(s, 0.02, 700, 220, 0.4, 0.4, { wobbleHz: 24, wobbleDepth: 60, glide: 0.5 });
  for (let i = 0; i < 10; i++) click(s, 0.25 + i * 0.045, 0.18, rand(2500, 4000));
};
const crabDie: SfxRecipe = (s) => {
  blip(s, 0, 900, 170, 0.07, 0.6, "sine");
  grains(s, 0, 0.15, 6, 0.25, 1500, 4000);
  struck(s, 0, 1600, 0.06, 0.4, SHELL_PARTIALS);
  blip(s, 0.08, 1200, 300, 0.3, 0.3, "triangle");
};
const pufferPop: SfxRecipe = (s) => {
  blip(s, 0, 300, 1200, 0.05, 0.6, "sine");
  click(s, 0, 0.5, 2800);
  noiseBurst(s, 0.02, 0.45, 0.4, { type: "highpass", from: 3000, to: 1200, q: 0.7, attack: 0.01 });
  const g = s.gain(0);
  const o = s.osc("sine", 900, 0.03, 0.5, g);
  s.freq(o.frequency, [
    [0.03, 900],
    [0.45, 300, "exp"],
  ]);
  s.perc(g.gain, 0.03, 0.2, 0.01, 0.42);
};
const bossRoar: SfxRecipe = (s) => {
  const g = s.gain(0);
  const trem = s.tremolo(30, 0.5, 0, 1.45, g);
  const chain = formantChain(s, 4, [
    [600, 3, 1.4],
    [1100, 4, 0.7],
    [2300, 6, 0.3],
  ], s.filter("lowpass", 3000, 0.7, trem));
  for (const f of [70, 73.5]) {
    const o = s.osc("sawtooth", f, 0, 1.45, s.gain(0.5, chain));
    s.freq(o.frequency, [
      [0, f * 0.85],
      [0.35, f * 1.2, "exp"],
      [1.4, f * 0.75, "exp"],
    ]);
  }
  s.curve(g.gain, [
    [0, 0],
    [0.15, 0.9],
    [1.0, 0.75],
    [1.42, 0.001, "exp"],
  ]);
  for (const at of [0.2, 0.5, 0.8]) {
    struck(s, at, rand(1400, 2000), 0.05, 0.4, SHELL_PARTIALS);
    click(s, at, 0.5, 3800);
  }
  rumble(s, 0, 1.6, 0.7, 260, 60);
};
const bossStomp: SfxRecipe = (s) => {
  thump(s, 0, 80, 28, 0.45, 1);
  noiseBurst(s, 0, 0.6, 0.6, { type: "lowpass", from: 260, to: 80, color: "brown", attack: 0.01 });
  grains(s, 0.03, 0.4, 8, 0.18, 500, 1800);
};
const monkey: SfxRecipe = (s) => {
  speak(s, 0, MONKEY, [
    { v: "u", d: 0.09, p0: 1.0, p1: 1.4 },
    { v: "o", d: 0.08, p0: 1.4, p1: 1.1, amp: 0.6 },
    { v: "u", d: 0.09, p0: 1.1, p1: 1.5 },
    { v: "o", d: 0.08, p0: 1.5, p1: 1.2, amp: 0.6 },
    { v: "a", d: 0.03, p0: 1.6, p1: 1.6, amp: 0.1, breath: 0.9 },
    { v: "a", d: 0.13, p0: 1.8, p1: 2.1 },
    { v: "a", d: 0.03, p0: 1.8, p1: 1.8, amp: 0.1, breath: 0.9 },
    { v: "a", d: 0.16, p0: 2.0, p1: 1.6 },
  ], 1, s.gain(0.9));
};
const gull: SfxRecipe = (s) => {
  for (const at of [0, 0.3]) {
    const g = s.gain(0);
    const chain = formantChain(s, 2.2, [
      [1500, 4, 1.2],
      [2700, 6, 0.6],
    ], s.filter("lowpass", 5000, 0.7, g));
    const f = rand(950, 1150);
    const o = s.osc("sawtooth", f, at, at + 0.26, chain);
    s.freq(o.frequency, [
      [at, f * 0.8],
      [at + 0.06, f * 1.4, "exp"],
      [at + 0.24, f, "exp"],
    ]);
    s.lfo(22, 40 * s.rate, o.frequency, at, at + 0.26);
    s.curve(g.gain, [
      [at, 0],
      [at + 0.03, 0.6],
      [at + 0.18, 0.4],
      [at + 0.25, 0.001, "exp"],
    ]);
  }
};
const steal: SfxRecipe = (s) => {
  const g = s.gain(0);
  const o = s.osc("sine", 500, 0, 0.3, g);
  s.freq(o.frequency, [
    [0, 500],
    [0.25, 1800, "exp"],
  ]);
  vibrato(s, o, 0, 0.3, 7, 20);
  s.curve(g.gain, [
    [0, 0],
    [0.03, 0.55],
    [0.22, 0.5],
    [0.3, 0.001, "exp"],
  ]);
  blip(s, 0.28, 600, 1400, 0.06, 0.4);
  speak(s, 0.34, MONKEY, [
    { v: "i", d: 0.05, p0: 1.6, p1: 1.7 },
    { v: "i", d: 0.03, p0: 1.7, p1: 1.7, amp: 0.1, breath: 0.8 },
    { v: "i", d: 0.05, p0: 1.65, p1: 1.55 },
    { v: "i", d: 0.03, p0: 1.55, p1: 1.55, amp: 0.1, breath: 0.8 },
    { v: "i", d: 0.08, p0: 1.5, p1: 1.3 },
  ], 1, s.gain(0.6));
};
const kraken: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.15, 0.8, { type: "lowpass", from: 2000, to: 300, q: 1.1, color: "pink" });
  thump(s, 0, 110, 45, 0.18, 0.7);
  squelch(s, 0.05, 0.4, 0.6, 250, 1500);
  for (let i = 0; i < 4; i++) glug(s, 0.2 + i * 0.07, rand(240, 400), 0.15);
};

/* ---------------------------------------------------------- player state */

const jump: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.06, 0.3, { type: "lowpass", from: 900, to: 400, color: "pink" });
  blip(s, 0, 180, 320, 0.12, 0.18, "triangle");
};
const land: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.15, 0.8, { type: "lowpass", from: 750, to: 200, q: 0.8, color: "pink" });
  thump(s, 0, 115, 50, 0.13, 0.65);
  grains(s, 0.01, 0.1, 3, 0.1, 2500, 5000);
};
const footstep: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.07, 0.5, { type: "lowpass", from: rand(900, 1400), to: 300, q: 0.7, color: "pink" });
  grains(s, 0, 0.05, 2, 0.08, 2500, 5000);
};
const swimStroke: SfxRecipe = (s) => {
  whoosh(s, 0, 0.35, 0.7, 600, 1400, "pink");
  for (let i = 0; i < 3; i++) droplet(s, 0.15 + Math.random() * 0.25, rand(800, 1800), 0.12);
};
const waterIn: SfxRecipe = (s) => {
  splashBody(s, 0, 1, 1.3);
  const g = s.gain(0);
  const o = s.osc("sine", 300, 0.05, 0.4, g);
  s.freq(o.frequency, [
    [0.05, 300],
    [0.35, 110, "exp"],
  ]);
  s.perc(g.gain, 0.05, 0.4, 0.01, 0.3);
};
const waterOut: SfxRecipe = (s) => {
  whoosh(s, 0, 0.3, 0.5, 500, 1800);
  for (let i = 0; i < 6; i++) droplet(s, 0.1 + i * 0.09 + rand(0, 0.04), rand(1000, 2400), 0.15);
};
const hurt: SfxRecipe = (s) => {
  thump(s, 0, 140, 60, 0.12, 0.8);
  noiseBurst(s, 0, 0.08, 0.5, { type: "bandpass", from: 900, to: 400, q: 1.1, color: "pink" });
  click(s, 0, 0.3, 2000);
};
const downed: SfxRecipe = (s) => {
  thump(s, 0, 120, 45, 0.2, 0.8);
  const g = s.gain(0);
  const o = s.osc("sine", 1200, 0.05, 0.95, g);
  s.freq(o.frequency, [
    [0.05, 1200],
    [0.9, 300, "exp"],
  ]);
  vibrato(s, o, 0.05, 0.9, 6, 20, 0.1);
  s.curve(g.gain, [
    [0.05, 0],
    [0.08, 0.5],
    [0.8, 0.4],
    [0.95, 0.001, "exp"],
  ]);
};
const revive: SfxRecipe = (s) => {
  [72, 76, 79, 84, 88].forEach((m, i) => struck(s, i * 0.06, midiToFreq(m), 0.5, 0.3, XYLO));
  boing(s, 0.25, 300, 900, 0.35, 0.3, { wobbleHz: 14, wobbleDepth: 30, glide: 0.8 });
  noiseBurst(s, 0.25, 0.4, 0.15, { type: "highpass", from: 6500, q: 0.7, attack: 0.1 });
};
const washed: SfxRecipe = (s) => {
  const g = s.gain(0);
  const lp = s.filter("lowpass", 300, 0.8, g);
  s.noise("pink", 0, 1.4, lp);
  s.freq(lp.frequency, [
    [0, 300],
    [0.5, 2600, "exp"],
    [1.35, 400, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.45, 0.9],
    [1.35, 0.001, "exp"],
  ]);
  kazooNote(s, 0.6, [
    [0, 330],
    [0.3, 310],
  ], 0.32, 0.35, 0);
  kazooNote(s, 0.95, [
    [0, 300],
    [0.6, 250],
  ], 0.65, 0.4, 60);
};
const respawn: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.3, 0.5, { type: "lowpass", from: 3000, to: 500, q: 0.8, attack: 0.02 });
  [79, 84, 88, 91].forEach((m, i) => struck(s, 0.1 + i * 0.06, midiToFreq(m), 0.45, 0.25, BELL_PARTIALS));
  splashBody(s, 0.05, 0.4, 0.6);
};
const lowBar: SfxRecipe = (s) => {
  struck(s, 0, 660, 0.25, 0.5, WOOD_PARTIALS);
  struck(s, 0.16, 520, 0.3, 0.5, WOOD_PARTIALS);
};
const shiver: SfxRecipe = (s) => {
  for (let i = 0; i < 14; i++) click(s, i * 0.045 + rand(0, 0.008), rand(0.2, 0.35), rand(2400, 3600));
  const g = s.gain(0);
  const trem = s.tremolo(22, 0.8, 0, 0.66, g);
  s.osc("sine", 180, 0, 0.66, trem);
  s.curve(g.gain, [
    [0, 0],
    [0.05, 0.25],
    [0.5, 0.2],
    [0.65, 0.001, "exp"],
  ]);
};
const blast: SfxRecipe = (s) => {
  thump(s, 0, 95, 30, 0.6, 1);
  noiseBurst(s, 0, 0.7, 0.9, { type: "lowpass", from: 4000, to: 300, q: 0.7, attack: 0.004 });
  noiseBurst(s, 0, 0.06, 0.6, { type: "highpass", from: 2500, q: 0.7 });
  const g = s.gain(0);
  const band = s.filter("bandpass", 1400, 3, g);
  const o = s.osc("sawtooth", 1400, 0.01, 0.28, band);
  s.freq(o.frequency, [
    [0.01, 1400],
    [0.26, 200, "exp"],
  ]);
  s.freq(band.frequency, [
    [0.01, 1400],
    [0.26, 300, "exp"],
  ]);
  s.perc(g.gain, 0.01, 0.6, 0.005, 0.25);
  grains(s, 0.05, 0.5, 12, 0.22, 800, 3500);
};
const jellyZap: SfxRecipe = (s) => {
  const g = s.gain(0);
  const o = s.osc("square", 120, 0, 0.36, s.filter("bandpass", 1800, 1.2, g));
  s.lfo(61, 90 * s.rate, o.frequency, 0, 0.36);
  s.lfo(13, 40 * s.rate, o.frequency, 0, 0.36);
  s.curve(g.gain, [
    [0, 0],
    [0.01, 0.6],
    [0.3, 0.45],
    [0.36, 0.001, "exp"],
  ]);
  grains(s, 0, 0.35, 10, 0.25, 4000, 8000);
};
const fuseTick: SfxRecipe = (s) => {
  click(s, 0, 0.6, 3500);
  blip(s, 0, 1800, 1700, 0.04, 0.25, "square");
  noiseBurst(s, 0, 0.06, 0.15, { type: "highpass", from: 6000, q: 0.7 });
};

/* -------------------------------------------------------- fishing & luck */

const cast: SfxRecipe = (s) => {
  whoosh(s, 0, 0.22, 0.8, 800, 3500);
  ratchet(s, 0.05, 0.42, 0.018, 0.05, 0.22);
  const g = s.gain(0);
  const o = s.osc("sine", 600, 0.55, 0.72, g);
  s.freq(o.frequency, [
    [0.55, 600],
    [0.65, 200, "exp"],
  ]);
  s.perc(g.gain, 0.55, 0.5, 0.004, 0.14);
  noiseBurst(s, 0.55, 0.15, 0.25, { type: "lowpass", from: 2400, to: 500, q: 0.8 });
};
const bite: SfxRecipe = (s) => {
  const g = s.gain(0);
  const o = s.osc("sine", 500, 0, 0.16, g);
  s.freq(o.frequency, [
    [0, 500],
    [0.1, 160, "exp"],
  ]);
  s.perc(g.gain, 0, 0.6, 0.004, 0.13);
  noiseBurst(s, 0, 0.12, 0.3, { type: "lowpass", from: 2600, to: 500, q: 0.8 });
  struck(s, 0.08, 1568, 0.3, 0.4, BELL_PARTIALS);
  struck(s, 0.18, 2093, 0.4, 0.4, BELL_PARTIALS);
};
const reelSpin: SfxRecipe = (s) => ratchet(s, 0, 0.6, 0.06, 0.02, 0.3);
const reelTick: SfxRecipe = (s) => {
  struck(s, 0, 1400, 0.04, 0.45, WOOD_PARTIALS);
  click(s, 0, 0.35, 4200);
};
const reelStop: SfxRecipe = (s) => {
  knock(s, 0, 500, 0.7, 0.1);
  struck(s, 0.03, midiToFreq(88), 0.5, 0.3, BELL_PARTIALS);
};
const catchFish: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.2, 0.6, { type: "highpass", from: 1200, to: 700, q: 0.7, attack: 0.005 });
  for (let i = 0; i < 4; i++) droplet(s, 0.05 + i * 0.06, rand(1000, 2200), 0.15);
  squelch(s, 0.2, 0.12, 0.45, 500, 1800);
  squelch(s, 0.36, 0.1, 0.4, 600, 2000);
  struck(s, 0.45, midiToFreq(79), 0.45, 0.35, XYLO);
  struck(s, 0.55, midiToFreq(84), 0.6, 0.4, XYLO);
};
const miss: SfxRecipe = (s) => {
  blip(s, 0, 420, 200, 0.12, 0.45, "sine");
  kazooNote(s, 0.12, [
    [0, 262],
    [0.45, 196],
  ], 0.5, 0.3, 40);
  noiseBurst(s, 0, 0.1, 0.2, { type: "lowpass", from: 1800, to: 400, q: 0.8 });
};
const treasure: SfxRecipe = (s) => {
  const shimmer = s.gain(0);
  const trem = s.tremolo(14, 0.6, 0, 0.9, shimmer);
  for (const f of [2093, 2637, 3136]) s.osc("sine", f * rand(0.997, 1.003), 0, 0.9, s.gain(0.07, trem));
  s.curve(shimmer.gain, [
    [0, 0],
    [0.2, 1],
    [0.85, 0.001, "exp"],
  ]);
  [72, 76, 79, 84, 88, 91].forEach((m, i) => struck(s, i * 0.06, midiToFreq(m), 0.6, 0.28, BELL_PARTIALS));
  for (let i = 0; i < 6; i++) struck(s, 0.3 + Math.random() * 0.5, rand(3000, 4500), 0.15, 0.1, BELL_PARTIALS);
};
const golden: SfxRecipe = (s) => {
  // Bell glissando up a pentatonic, a choir-ish "aaah" chord swelling under it, coins raining.
  [72, 74, 76, 79, 81, 84, 86, 88, 91, 93, 96].forEach((m, i) => struck(s, i * 0.045, midiToFreq(m), 0.7, 0.24, BELL_PARTIALS));
  const g = s.gain(0);
  const chain = formantChain(s, 1.6, [
    [800, 4, 1.2],
    [1200, 5, 0.6],
    [2700, 6, 0.25],
  ], s.filter("lowpass", 3800, 0.7, g));
  for (const m of [60, 64, 67, 72]) {
    const o = s.osc("sawtooth", midiToFreq(m), 0.2, 1.7, s.gain(0.3, chain));
    vibrato(s, o, 0.2, 1.5, 5.5, 22, 0.2);
  }
  s.curve(g.gain, [
    [0.2, 0],
    [0.7, 0.55],
    [1.3, 0.45],
    [1.7, 0.001, "exp"],
  ]);
  for (let i = 0; i < 10; i++) struck(s, 0.4 + Math.random() * 1.0, rand(3200, 5000), 0.12, 0.09, BELL_PARTIALS);
};
const bottle: SfxRecipe = (s) => {
  blip(s, 0, 300, 900, 0.05, 0.55, "sine");
  click(s, 0, 0.5, 2600);
  struck(s, 0.12, 2400, 0.5, 0.3, BELL_PARTIALS);
  rustleBed(s, 0.25, 0.4, 0.3, 2800, 3600);
};
const legendary: SfxRecipe = (s) => {
  const g = s.gain(0);
  const chain = formantChain(s, 2.4, [
    [600, 3, 1.3],
    [1250, 4, 0.7],
    [2500, 6, 0.3],
  ], s.filter("lowpass", 3200, 0.7, g));
  for (const m of [48, 55, 60, 64, 67]) {
    const o = s.osc("sawtooth", midiToFreq(m), 0, 1.6, s.gain(0.25, chain));
    vibrato(s, o, 0, 1.6, 5, 15, 0.3);
  }
  s.curve(g.gain, [
    [0, 0],
    [0.5, 0.7],
    [1.2, 0.6],
    [1.6, 0.001, "exp"],
  ]);
  struck(s, 0, 110, 1.8, 0.45, GONG_PARTIALS);
  for (let i = 0; i < 8; i++) struck(s, 0.2 + Math.random() * 1.0, rand(2500, 4500), 0.2, 0.1, BELL_PARTIALS);
};

/* -------------------------------------------------------- flow & social */

const marker: SfxRecipe = (s) => {
  struck(s, 0, midiToFreq(84), 0.25, 0.4, BELL_PARTIALS);
  struck(s, 0.09, midiToFreq(91), 0.35, 0.4, BELL_PARTIALS);
};
const emote: SfxRecipe = (s) => {
  blip(s, 0, 500, 900, 0.07, 0.5, "triangle");
  blip(s, 0.07, 700, 1300, 0.08, 0.4, "sine");
};
const dayStart: SfxRecipe = (s) => {
  // A tropical morning: marimba arpeggio, a rooster with a kazoo for a throat, birds.
  [72, 76, 79, 84].forEach((m, i) => struck(s, i * 0.08, midiToFreq(m), 0.5, 0.3, XYLO));
  kazooNote(s, 0.45, [
    [0, 523],
    [0.07, 659],
  ], 0.1, 0.32, 0);
  kazooNote(s, 0.57, [
    [0, 659],
    [0.07, 784],
  ], 0.1, 0.32, 0);
  kazooNote(s, 0.7, [
    [0, 784],
    [0.15, 880],
    [0.6, 698],
  ], 0.65, 0.36, 30);
  for (let i = 0; i < 3; i++) chirp(s, 1.2 + i * 0.13, 2600, 3800, 0.08, 0.15);
};
const duskDrums: SfxRecipe = (s) => {
  let t = 0;
  for (let i = 0; i < 9; i++) {
    const low = i % 2 === 0;
    thump(s, t, low ? 150 : 210, low ? 85 : 130, 0.3, 0.6 + i * 0.04);
    noiseBurst(s, t, 0.07, 0.15, { type: "bandpass", from: low ? 420 : 640, to: 240, q: 1.2, color: "pink" });
    t += 0.24 - i * 0.018;
  }
  thump(s, t + 0.05, 120, 40, 0.7, 1);
  rumble(s, t + 0.05, 1.0, 0.4, 300, 70);
};
const nightStart: SfxRecipe = (s) => {
  struck(s, 0, 98, 2.4, 0.5, GONG_PARTIALS);
  const g = s.gain(0);
  const o = s.osc("sine", 1200, 0.3, 1.6, g);
  s.freq(o.frequency, [
    [0.3, 1200],
    [1.5, 700, "exp"],
  ]);
  vibrato(s, o, 0.3, 1.3, 5, 30, 0.2);
  s.curve(g.gain, [
    [0.3, 0],
    [0.6, 0.15],
    [1.3, 0.12],
    [1.6, 0.001, "exp"],
  ]);
  for (let i = 0; i < 5; i++) click(s, 1.0 + i * 0.07, 0.12, rand(2200, 3200));
};
const stormWarn: SfxRecipe = (s) => {
  for (const at of [0, 0.35, 0.7]) struck(s, at, 1250, 0.8, 0.4, BELL_PARTIALS);
  rumble(s, 0, 2.0, 0.6, 140, 320);
};
const thunder: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.12, 0.9, { type: "highpass", from: 1500, q: 0.6, attack: 0.002 });
  noiseBurst(s, 0, 0.35, 0.6, { type: "bandpass", from: 3000, to: 600, q: 0.7 });
  noiseBurst(s, 0.3, 0.2, 0.35, { type: "bandpass", from: 2200, to: 500, q: 0.8 });
  rumble(s, 0.05, 2.6, 1, 420, 70);
  thump(s, 0.02, 70, 30, 0.6, 0.6);
};
const win: SfxRecipe = (s) => {
  kazooNote(s, 0, [
    [0, 300],
    [0.25, 620],
  ], 0.45, 0.4, 25);
  crowdCheer(s, 0.15, 0.35);
  for (const at of [0.05, 0.3, 0.55]) {
    click(s, at, 0.7, 2500);
    noiseBurst(s, at, 0.12, 0.45, { type: "bandpass", from: 2000, to: 900, q: 1 });
    grains(s, at + 0.02, at + 0.3, 5, 0.1, 3000, 7000);
  }
};
const lose: SfxRecipe = (s) => {
  whoosh(s, 0, 1.5, 0.6, 300, 1500, "pink");
  rumble(s, 0, 1.6, 0.5, 300, 60);
  crowdAww(s, 0.2, 0.35);
};

/* ================================================================ tables */

export const SFX_RECIPES: Readonly<Record<SfxName, SfxRecipe>> = {
  uiClick,
  uiHover,
  uiOpen,
  uiClose,
  uiError,
  uiTick,
  chop,
  chopDone,
  mine,
  mineDone,
  rustle,
  berry,
  pickup,
  drop,
  coconutFall,
  palmShake,
  craft,
  hammer,
  place,
  chestOpen,
  chestClose,
  eat,
  drink,
  burp,
  spring,
  chargeStart,
  throw: throwFwip,
  throwHeavy,
  toss,
  catch: catchThwap,
  bonk,
  hit,
  bootBonk,
  splash,
  stick,
  bounce,
  swing,
  fireFeed,
  fireLow,
  fireOut,
  deliver,
  raftStage,
  raftReady,
  raftGnaw,
  board,
  launch,
  fenceBreak,
  crabEmerge,
  crabClick,
  crabBite,
  crabFlip,
  crabDie,
  pufferPop,
  bossRoar,
  bossStomp,
  monkey,
  gull,
  steal,
  kraken,
  jump,
  land,
  footstep,
  swimStroke,
  waterIn,
  waterOut,
  hurt,
  downed,
  revive,
  washed,
  respawn,
  lowBar,
  shiver,
  blast,
  jellyZap,
  fuseTick,
  cast,
  bite,
  reelSpin,
  reelTick,
  reelStop,
  catchFish,
  miss,
  treasure,
  golden,
  bottle,
  legendary,
  marker,
  emote,
  dayStart,
  duskDrums,
  nightStart,
  stormWarn,
  thunder,
  win,
  lose,
};

const ui = (volume: number, cap = 2): SfxDef => ({ bus: "ui", positional: false, volume, cap });
const world = (volume: number, cap = 3): SfxDef => ({ bus: "sfx", positional: true, volume, cap });
/** Announcements: flat even when a pos is passed (banners, stingers, the local player's own feedback). */
const flat = (volume: number, cap = 1): SfxDef => ({ bus: "sfx", positional: false, volume, cap });

/** Mix definition per sound (pure table, unit-tested for completeness). */
export const SFX_DEFS: Readonly<Record<SfxName, SfxDef>> = {
  uiClick: ui(0.4),
  uiHover: ui(0.15),
  uiOpen: ui(0.4),
  uiClose: ui(0.35),
  uiError: ui(0.4),
  uiTick: ui(0.4, 3),
  chop: world(0.6, 4),
  chopDone: world(0.75, 2),
  mine: world(0.6, 4),
  mineDone: world(0.7, 2),
  rustle: world(0.45, 3),
  berry: world(0.5, 3),
  pickup: world(0.45, 4),
  drop: world(0.45, 4),
  coconutFall: world(0.7, 4),
  palmShake: world(0.6, 3),
  craft: world(0.6, 2),
  hammer: world(0.6, 3),
  place: world(0.65, 3),
  chestOpen: world(0.55, 2),
  chestClose: world(0.5, 2),
  eat: world(0.55, 3),
  drink: world(0.55, 3),
  burp: world(0.6, 2),
  spring: world(0.55, 2),
  chargeStart: world(0.4, 3),
  throw: world(0.6, 5),
  throwHeavy: world(0.75, 3),
  toss: world(0.5, 4),
  catch: world(0.85, 3),
  bonk: world(0.9, 4),
  hit: world(0.75, 4),
  bootBonk: world(0.85, 3),
  splash: world(0.7, 4),
  stick: world(0.75, 3),
  bounce: world(0.45, 6),
  swing: world(0.6, 3),
  fireFeed: world(0.65, 2),
  fireLow: world(0.5, 1),
  fireOut: world(0.7, 1),
  deliver: world(0.65, 3),
  raftStage: flat(0.7),
  raftReady: flat(0.85),
  raftGnaw: world(0.6, 3),
  board: world(0.6, 3),
  launch: flat(0.9),
  fenceBreak: world(0.75, 2),
  crabEmerge: world(0.5, 4),
  crabClick: world(0.45, 5),
  crabBite: world(0.7, 4),
  crabFlip: world(0.8, 3),
  crabDie: world(0.7, 3),
  pufferPop: world(0.7, 3),
  bossRoar: world(1, 1),
  bossStomp: world(0.85, 2),
  monkey: world(0.6, 2),
  gull: world(0.55, 2),
  steal: world(0.6, 2),
  kraken: world(0.75, 2),
  jump: world(0.35, 4),
  land: world(0.4, 4),
  footstep: world(0.28, 6),
  swimStroke: world(0.4, 4),
  waterIn: world(0.6, 3),
  waterOut: world(0.45, 3),
  hurt: world(0.75, 4),
  downed: world(0.8, 3),
  revive: world(0.7, 3),
  washed: world(0.8, 2),
  respawn: world(0.65, 3),
  lowBar: flat(0.45, 2),
  shiver: world(0.5, 3),
  blast: world(1, 3),
  jellyZap: world(0.55, 2),
  fuseTick: world(0.5, 3),
  cast: world(0.55, 3),
  bite: world(0.75, 2),
  reelSpin: world(0.5, 2),
  reelTick: flat(0.4, 3),
  reelStop: flat(0.55, 2),
  catchFish: world(0.7, 2),
  miss: world(0.55, 2),
  treasure: flat(0.75),
  golden: flat(0.85),
  bottle: world(0.6, 2),
  legendary: flat(0.85),
  marker: world(0.6, 3),
  emote: world(0.45, 3),
  dayStart: flat(0.75),
  duskDrums: flat(0.8),
  nightStart: flat(0.75),
  stormWarn: flat(0.85),
  thunder: flat(0.95, 2),
  win: flat(0.85),
  lose: flat(0.85),
};

/**
 * Per-recipe calibration measured with the offline loudness probe in dev/audio.html: brings each raw recipe to a
 * consistent loudness so SFX_DEFS volume alone expresses the mix (big hits ≈ −2 dBFS effective, everyday sounds
 * ≈ −8, footsteps / UI ≈ −14), and nothing peaks much above 0 before the buses.
 */
export const SFX_TRIM: { readonly [K in SfxName]?: number } = {
  blast: 0.56,
  bossRoar: 0.74,
  catch: 0.53,
  bonk: 0.78,
  chopDone: 0.63,
  coconutFall: 0.61,
  mineDone: 0.64,
  crabBite: 0.66,
  throwHeavy: 0.69,
  chop: 0.55,
  hammer: 0.67,
  fenceBreak: 0.85,
  monkey: 0.68,
  chestClose: 0.67,
  mine: 0.83,
  crabFlip: 1.24,
  chargeStart: 4.3,
  footstep: 2.66,
  swimStroke: 4.1,
  toss: 4.1,
  jump: 2.24,
  waterOut: 2.3,
  shiver: 1.8,
  raftGnaw: 2.14,
  reelSpin: 1.46,
  rustle: 1.46,
  fireLow: 1.78,
  fuseTick: 1.74,
  eat: 1.68,
  berry: 1.35,
  crabEmerge: 1.41,
  emote: 1.36,
  crabClick: 1.17,
  swing: 1.3,
  drop: 1.26,
  miss: 1.46,
  jellyZap: 1.48,
  burp: 1.27,
  cast: 1.19,
  uiHover: 1.36,
};

/** Gain for one SFX before PlayOptions.volume and the buses: its mix volume × calibration. */
export function sfxGain(name: SfxName): number {
  return SFX_DEFS[name].volume * (SFX_TRIM[name] ?? 1);
}

/** Every name the engine can play (re-exported for the harness / tests). */
export const ALL_SFX: ReadonlyArray<SfxName> = SFX_NAMES;
