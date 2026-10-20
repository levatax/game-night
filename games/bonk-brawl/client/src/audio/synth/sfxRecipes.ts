// Procedural recipe for every SfxId (see Sfx.ts for the briefs). A recipe schedules nodes into a
// Synth starting at s.t; levels are tuned so each sound peaks around 0.5–0.9 before bus volumes.

import { SFX, type SfxId } from "../Sfx";
import {
  BELL_PARTIALS,
  WOOD_PARTIALS,
  blip,
  boing,
  click,
  formantChain,
  grains,
  noiseBurst,
  struck,
  thump,
  vibrato,
  type Formant,
} from "./blocks";
import { midiToFreq, rand, scaleCurve, type CurvePoint, type Synth } from "./dsp";

export type SfxRecipe = (s: Synth) => void;

const KAZOO_FORMANTS: ReadonlyArray<Formant> = [
  [700, 3, 1.4],
  [1400, 4, 0.9],
  [2600, 5, 0.45],
];

/* ------------------------------------------------------------- balls */

const bounce: SfxRecipe = (s) => {
  thump(s, 0, 170, 70, 0.08, 0.45);
  boing(s, 0.004, 190, 290, 0.3, 0.5, { wobbleHz: 22, wobbleDepth: 55 });
  noiseBurst(s, 0, 0.03, 0.2, { type: "lowpass", from: 1400, to: 400, q: 0.7 });
};

const squeak: SfxRecipe = (s) => {
  const g = s.gain(0);
  const band = s.filter("bandpass", 2100, 2.5, g);
  const o = s.osc("square", 950, 0, 0.16, band);
  s.freq(o.frequency, [
    [0, 950],
    [0.035, 1550, "exp"],
    [0.1, 1250, "exp"],
  ]);
  s.lfo(38, 70 * s.rate, o.frequency, 0, 0.16);
  s.curve(g.gain, [
    [0, 0],
    [0.008, 1.1],
    [0.07, 0.8],
    [0.13, 0.001, "exp"],
  ]);
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

const ballDrop: SfxRecipe = (s) => {
  const g = s.gain(0);
  const o = s.osc("sine", 2100, 0, 1.05, g);
  s.freq(o.frequency, [
    [0, 2100],
    [0.95, 650],
  ]);
  vibrato(s, o, 0, 1.0, 6, 14);
  s.curve(g.gain, [
    [0, 0],
    [0.25, 0.55],
    [0.85, 0.5],
    [1.0, 0.001, "exp"],
  ]);
};

const pickup: SfxRecipe = (s) => {
  blip(s, 0, 280, 950, 0.12, 0.75, "sine");
  blip(s, 0, 560, 1900, 0.08, 0.12, "triangle");
};

/* ----------------------------------------------------------- combat */

const bonk: SfxRecipe = (s) => {
  // Hollow coconut knock.
  struck(s, 0, 740, 0.1, 0.55, WOOD_PARTIALS);
  click(s, 0, 0.55, 2500);
  // Cartoon pitch-drop "boyoyoing".
  boing(s, 0.012, 640, 150, 0.4, 0.5, { wobbleHz: 26, wobbleDepth: 80, glide: 0.65 });
  thump(s, 0, 190, 60, 0.13, 0.65);
};

const ding: SfxRecipe = (s) => {
  struck(s, 0, 1568, 0.9, 0.45, BELL_PARTIALS);
  struck(s, 0, 1573, 0.7, 0.14, [[1, 1, 1]]);
  struck(s, 0.03, 2349, 0.5, 0.14, [[1, 1, 1]]);
  click(s, 0, 0.12, 6000);
};

const catchThwap: SfxRecipe = (s) => {
  thump(s, 0, 150, 48, 0.2, 0.95);
  noiseBurst(s, 0, 0.05, 0.75, { type: "highpass", from: 1500, q: 0.7 });
  noiseBurst(s, 0, 0.1, 0.55, { type: "bandpass", from: 520, to: 280, q: 1.2, color: "pink" });
};

const crowdOoh: SfxRecipe = (s) => {
  const env = s.gain(0);
  const lp = s.filter("lowpass", 1300, 0.7, env);
  const f1 = s.filter("bandpass", 330, 4, s.gain(1.6, lp));
  const f2 = s.filter("bandpass", 820, 5, s.gain(0.8, lp));
  s.freq(f1.frequency, [
    [0, 320],
    [0.7, 430],
    [1.4, 380],
  ]);
  const voices = s.gain(1);
  voices.connect(f1);
  voices.connect(f2);
  for (let i = 0; i < 11; i++) {
    const high = i % 3 === 0;
    const base = high ? rand(200, 290) : rand(105, 165);
    const delay = rand(0, 0.09);
    const g = s.gain(0.13, voices);
    const o = s.osc("sawtooth", base, delay, 1.6, g);
    s.freq(o.frequency, [
      [0, base * 0.93],
      [0.42 + delay, base * 1.14, "exp"],
      [1.45, base * 0.8, "exp"],
    ]);
    vibrato(s, o, delay, 1.6, rand(4.5, 6.2), rand(12, 28), 0.2);
  }
  const breath = s.filter("bandpass", 600, 1, s.gain(0.25, lp));
  s.noise("pink", 0, 1.6, breath);
  s.curve(env.gain, [
    [0, 0],
    [0.35, 1],
    [0.9, 0.85],
    [1.5, 0.001, "exp"],
  ]);
};

const whiff: SfxRecipe = (s) => {
  // Flailing whoosh.
  const g = s.gain(0);
  const trem = s.tremolo(14, 0.7, 0, 0.32, g);
  const band = s.filter("bandpass", 1800, 1.4, trem);
  s.noise("white", 0, 0.32, band);
  s.freq(band.frequency, [
    [0, 1800],
    [0.28, 500, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.04, 0.9],
    [0.3, 0.001, "exp"],
  ]);
  // Sad "wah" slide.
  const wahGain = s.gain(0);
  const wah = s.filter("lowpass", 300, 7, wahGain);
  const o = s.osc("sawtooth", 392, 0.12, 0.66, wah);
  s.freq(o.frequency, [
    [0.12, 392],
    [0.6, 300, "exp"],
  ]);
  vibrato(s, o, 0.12, 0.54, 6, 30, 0.1);
  s.freq(wah.frequency, [
    [0.12, 300],
    [0.22, 1700, "exp"],
    [0.6, 380, "exp"],
  ]);
  s.curve(wahGain.gain, [
    [0.12, 0],
    [0.15, 0.4],
    [0.5, 0.3],
    [0.64, 0.001, "exp"],
  ]);
};

const slideWhistle: SfxRecipe = (s) => {
  const curve: CurvePoint[] = [
    [0, 1450],
    [0.08, 1850, "exp"],
    [1.2, 270, "exp"],
  ];
  const g = s.gain(0);
  const o = s.osc("sine", 1450, 0, 1.3, g);
  s.freq(o.frequency, curve);
  vibrato(s, o, 0, 1.3, 7, 22, 0.15);
  const h2 = s.gain(0.1, g);
  const o2 = s.osc("sine", 2900, 0, 1.3, h2);
  s.freq(o2.frequency, scaleCurve(curve, 2));
  const breath = s.filter("bandpass", 1450, 9, s.gain(0.35, g));
  s.noise("white", 0, 1.3, breath);
  s.freq(breath.frequency, curve);
  s.curve(g.gain, [
    [0, 0],
    [0.03, 0.75],
    [1.0, 0.6],
    [1.26, 0.001, "exp"],
  ]);
};

const ko: SfxRecipe = (s) => {
  blip(s, 0, 900, 170, 0.07, 0.75, "sine");
  click(s, 0, 0.45, 3500);
  noiseBurst(s, 0.01, 0.45, 0.7, { type: "lowpass", from: 4200, to: 550, q: 0.8, attack: 0.03 });
  grains(s, 0.06, 0.4, 9, 0.12, 4000, 8000);
};

/* ------------------------------------------------------- movement */

const jump: SfxRecipe = (s) => {
  boing(s, 0, 230, 640, 0.22, 0.6, { wobbleHz: 18, wobbleDepth: 40, glide: 0.7 });
  noiseBurst(s, 0, 0.06, 0.18, { type: "lowpass", from: 900, to: 400 });
};

const land: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.15, 0.8, { type: "lowpass", from: 750, to: 200, q: 0.8, color: "pink" });
  thump(s, 0, 115, 50, 0.13, 0.65);
};

const roll: SfxRecipe = (s) => {
  const g = s.gain(0);
  const trem = s.tremolo(13, 0.65, 0, 0.45, g);
  const band = s.filter("bandpass", 600, 1.2, trem);
  s.noise("pink", 0, 0.45, band);
  s.freq(band.frequency, [
    [0, 600],
    [0.2, 1500, "exp"],
    [0.42, 700, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.06, 1.1],
    [0.42, 0.001, "exp"],
  ]);
};

/* -------------------------------------------------------- abilities */

const flapDash: SfxRecipe = (s) => {
  for (let i = 0; i < 5; i++) {
    const at = i * 0.055;
    noiseBurst(s, at, 0.045, 0.6 * (1 - i * 0.12), { type: "bandpass", from: 1300, to: 700, q: 0.9, color: "pink" });
    thump(s, at, 170, 90, 0.04, 0.22);
  }
  noiseBurst(s, 0.05, 0.32, 0.55, { type: "bandpass", from: 500, to: 2900, q: 1.5, attack: 0.1 });
};

const groundPoundLeap: SfxRecipe = (s) => {
  // "hup!"
  const hupGain = s.gain(0);
  const chain = formantChain(s, 2, [[750, 3, 1.4], [1250, 4, 0.7]], hupGain);
  const o = s.osc("sawtooth", 200, 0, 0.12, chain);
  s.freq(o.frequency, [
    [0, 200],
    [0.08, 310, "exp"],
  ]);
  s.perc(hupGain.gain, 0, 0.6, 0.01, 0.1);
  boing(s, 0.05, 180, 760, 0.36, 0.5, { wobbleHz: 16, wobbleDepth: 40, glide: 0.8 });
};

const shockwave: SfxRecipe = (s) => {
  thump(s, 0, 95, 28, 0.65, 0.95);
  noiseBurst(s, 0, 0.04, 0.5, { type: "highpass", from: 1500, q: 0.7 });
  noiseBurst(s, 0, 1.15, 0.8, { type: "lowpass", from: 300, to: 80, q: 0.9, color: "brown", attack: 0.03 });
  grains(s, 0.05, 0.55, 8, 0.18, 900, 2500);
};

const bellyBoing: SfxRecipe = (s) => {
  const g = s.gain(0);
  const lp = s.filter("lowpass", 1400, 0.8, g);
  const curve: CurvePoint[] = [
    [0, 85],
    [0.12, 155, "exp"],
    [0.95, 118, "exp"],
  ];
  const o1 = s.osc("triangle", 85, 0, 1.0, lp);
  s.freq(o1.frequency, curve);
  s.lfo(11, 45 * s.rate, o1.frequency, 0, 1.0, [
    [0, 45 * s.rate],
    [0.95, 0.5, "exp"],
  ]);
  const h2 = s.gain(0.35, lp);
  const o2 = s.osc("sine", 170, 0, 1.0, h2);
  s.freq(o2.frequency, scaleCurve(curve, 2));
  s.lfo(11, 90 * s.rate, o2.frequency, 0, 1.0, [
    [0, 90 * s.rate],
    [0.95, 1, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.012, 1.0],
    [0.95, 0.001, "exp"],
  ]);
  noiseBurst(s, 0, 0.25, 0.3, { type: "lowpass", from: 300, to: 1100, q: 4, color: "pink" });
};

const curveArm: SfxRecipe = (s) => {
  const notes = [84, 86, 88, 90, 92, 94, 92, 90, 88];
  notes.forEach((midi, i) => struck(s, i * 0.035, midiToFreq(midi), 0.2, 0.22, [[1, 1, 1], [2, 0.2, 0.4]]));
  const g = s.gain(0);
  const band = s.filter("bandpass", 2500, 6, g);
  s.lfo(9, 1200 * s.rate, band.frequency, 0, 0.5);
  s.noise("white", 0, 0.5, band);
  s.curve(g.gain, [
    [0, 0],
    [0.15, 0.4],
    [0.45, 0.001, "exp"],
  ]);
};

const bellySlide: SfxRecipe = (s) => {
  // "wheee"
  const g = s.gain(0);
  const chain = formantChain(s, 1.6, [[300, 5, 1.2], [2300, 8, 1.0], [3000, 9, 0.5]], g);
  const o = s.osc("sawtooth", 380, 0, 0.6, chain);
  s.freq(o.frequency, [
    [0, 380],
    [0.45, 780, "exp"],
  ]);
  vibrato(s, o, 0, 0.6, 6, 35, 0.15);
  s.curve(g.gain, [
    [0, 0],
    [0.03, 0.55],
    [0.4, 0.5],
    [0.56, 0.001, "exp"],
  ]);
  noiseBurst(s, 0.1, 0.7, 0.45, { type: "lowpass", from: 1600, to: 900, color: "pink", attack: 0.15 });
};

const headbutt: SfxRecipe = (s) => {
  struck(s, 0, 320, 0.14, 0.7, [
    [1, 1, 1],
    [2.64, 0.5, 0.55],
    [4.4, 0.2, 0.3],
  ]);
  click(s, 0, 0.5, 1800);
  thump(s, 0, 140, 60, 0.1, 0.5);
  for (const at of [0.06, 0.13, 0.22]) {
    struck(s, at + rand(-0.01, 0.01), 2093 * rand(0.98, 1.02), 0.45, 0.16, [
      [1, 1, 1],
      [2.42, 0.4, 0.5],
      [4.1, 0.2, 0.3],
    ]);
  }
};

const boomerang: SfxRecipe = (s) => {
  const g = s.gain(0);
  const trem = s.tremolo(6.5, 0.9, 0, 0.85, g);
  const band = s.filter("bandpass", 900, 3, trem);
  s.lfo(6.5, 400 * s.rate, band.frequency, 0, 0.85);
  s.noise("pink", 0, 0.85, band);
  const woo = s.gain(0.18, trem);
  const o = s.osc("sine", 500, 0, 0.85, woo);
  s.freq(o.frequency, [
    [0, 500],
    [0.35, 720, "exp"],
    [0.8, 440, "exp"],
  ]);
  s.curve(g.gain, [
    [0, 0],
    [0.1, 1.3],
    [0.6, 1.1],
    [0.82, 0.001, "exp"],
  ]);
};

/* ------------------------------------------------------------ emotes */

const honk: SfxRecipe = (s) => {
  [0, 0.21].forEach((at, i) => {
    const p = i === 0 ? 1 : 0.94;
    const g = s.gain(0);
    const lp = s.filter("lowpass", 3200, 0.7, g);
    const chain = formantChain(s, 4, [[1100, 1.5, 1.2], [2400, 3, 0.5]], lp);
    const a = s.osc("sawtooth", 440 * p, at, at + 0.19, chain);
    const b = s.osc("square", 442 * p, at, at + 0.19, chain);
    for (const o of [a, b]) {
      s.freq(o.frequency, [
        [at, 445 * p],
        [at + 0.03, 415 * p, "exp"],
      ]);
    }
    s.curve(g.gain, [
      [at, 0],
      [at + 0.01, 0.5],
      [at + 0.13, 0.45],
      [at + 0.17, 0.001, "exp"],
    ]);
  });
};

/* ---------------------------------------------------------- power-ups */

const powerUpWarning: SfxRecipe = (s) => {
  // Shimmer whose tremolo speeds up as the power-up is about to appear.
  const shimmer = s.gain(0);
  const trem = s.gain(0.6, shimmer);
  const tremLfo = s.osc("sine", 7, 0, 2.05, s.gain(0.4, trem.gain));
  s.curve(tremLfo.frequency, [
    [0, 7],
    [1.9, 22, "exp"],
  ]);
  for (const f of [1568, 2093, 2637, 3136]) s.osc("sine", f * rand(0.997, 1.003), 0, 2.05, s.gain(0.08, trem));
  s.curve(shimmer.gain, [
    [0, 0],
    [1.75, 1],
    [2.0, 0.001, "exp"],
  ]);
  const scale = [72, 74, 76, 79, 81, 84, 86, 88];
  scale.forEach((midi, i) => struck(s, i * 0.24, midiToFreq(midi + 12), 0.35, 0.1 + i * 0.03, BELL_PARTIALS));
};

const powerUpSparkle: SfxRecipe = (s) => {
  [84, 88, 91, 96, 100, 103].forEach((midi, i) => struck(s, i * 0.045, midiToFreq(midi), 0.5, 0.26, BELL_PARTIALS));
  const g = s.gain(0);
  const trem = s.tremolo(20, 0.7, 0, 0.65, g);
  s.noise("white", 0, 0.65, s.filter("highpass", 6500, 0.7, trem));
  s.curve(g.gain, [
    [0, 0],
    [0.1, 0.18],
    [0.62, 0.001, "exp"],
  ]);
};

const powerUpPickup: SfxRecipe = (s) => {
  const chip = (at: number, midi: number, dur: number, level: number): void => {
    const g = s.gain(0);
    s.osc("square", midiToFreq(midi), at, at + dur + 0.02, s.filter("lowpass", 4500, 0.7, g));
    s.perc(g.gain, at, level, 0.004, dur);
  };
  chip(0, 83, 0.08, 0.3);
  chip(0.085, 88, 0.55, 0.32);
  struck(s, 0.085, midiToFreq(88), 0.7, 0.3, BELL_PARTIALS);
  struck(s, 0.1, midiToFreq(92), 0.6, 0.12, BELL_PARTIALS);
  struck(s, 0.115, midiToFreq(95), 0.55, 0.1, BELL_PARTIALS);
};

const zoomies: SfxRecipe = (s) => {
  const g = s.gain(0);
  const lp = s.filter("lowpass", 2200, 1.5, g);
  const o = s.osc("sawtooth", 120, 0, 0.65, lp);
  s.freq(o.frequency, [
    [0, 120],
    [0.45, 680, "exp"],
  ]);
  s.lfo(8, 30 * s.rate, o.frequency, 0, 0.65);
  s.curve(g.gain, [
    [0, 0],
    [0.05, 0.4],
    [0.42, 0.42],
    [0.62, 0.001, "exp"],
  ]);
  noiseBurst(s, 0.1, 0.45, 0.4, { type: "bandpass", from: 800, to: 3200, q: 1.2, attack: 0.15 });
};

/* ------------------------------------------------------ arena events */

const ringShake: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.035, 0.6, { type: "highpass", from: 2000, q: 0.7 });
  const creakGain = s.gain(0);
  const band = s.filter("bandpass", 950, 12, creakGain);
  const o = s.osc("sawtooth", 72, 0, 0.75, band);
  s.freq(o.frequency, [
    [0, 72],
    [0.7, 52],
  ]);
  s.lfo(13, 9 * s.rate, o.frequency, 0, 0.75);
  s.curve(creakGain.gain, [
    [0, 0],
    [0.05, 2.2],
    [0.5, 1.8],
    [0.72, 0.001, "exp"],
  ]);
  const rattle = s.gain(0);
  const trem = s.tremolo(24, 0.85, 0, 0.85, rattle);
  s.noise("brown", 0, 0.85, s.filter("lowpass", 420, 0.8, trem));
  s.curve(rattle.gain, [
    [0, 0],
    [0.08, 0.7],
    [0.8, 0.001, "exp"],
  ]);
};

const crumbleRumble: SfxRecipe = (s) => {
  noiseBurst(s, 0, 0.05, 0.5, { type: "highpass", from: 1800, q: 0.7 });
  thump(s, 0, 70, 30, 0.55, 0.7);
  const g = s.gain(0);
  s.noise("brown", 0, 1.9, s.filter("lowpass", 190, 0.9, g));
  s.curve(g.gain, [
    [0, 0],
    [0.15, 0.95],
    [1.2, 0.7],
    [1.85, 0.001, "exp"],
  ]);
  grains(s, 0.05, 1.4, 26, 0.3, 600, 3000);
};

/* ------------------------------------------------------- round flow */

const countdownTick: SfxRecipe = (s) => {
  struck(s, 0, 1050, 0.08, 0.6, WOOD_PARTIALS);
  click(s, 0, 0.3, 3000);
};

const countdownGo: SfxRecipe = (s) => {
  struck(s, 0, 740, 0.1, 0.45, WOOD_PARTIALS);
  click(s, 0, 0.4, 2500);
  const honkGain = s.gain(0);
  const chain = formantChain(s, 3, [[1000, 1.2, 1.1], [2200, 2, 0.4]], s.filter("lowpass", 3500, 0.7, honkGain));
  for (const midi of [60, 64, 67, 72]) {
    const o = s.osc("sawtooth", midiToFreq(midi), 0.01, 0.65, s.gain(0.3, chain));
    s.freq(o.frequency, [
      [0.01, midiToFreq(midi) * 1.03],
      [0.05, midiToFreq(midi), "exp"],
    ]);
  }
  s.curve(honkGain.gain, [
    [0.01, 0],
    [0.03, 0.5],
    [0.4, 0.42],
    [0.62, 0.001, "exp"],
  ]);
  struck(s, 0, 110, 1.5, 0.35, [
    [1, 1, 1],
    [1.48, 0.6, 0.7],
    [2.0, 0.45, 0.6],
    [2.76, 0.3, 0.45],
    [3.4, 0.2, 0.35],
  ]);
  thump(s, 0, 120, 45, 0.3, 0.6);
};

const suddenDeath: SfxRecipe = (s) => {
  const g = s.gain(0);
  const chain = formantChain(s, 2.5, KAZOO_FORMANTS, g);
  const o = s.osc("sawtooth", 600, 0, 1.7, chain);
  s.freq(o.frequency, [
    [0, 560],
    [0.25, 800],
    [0.5, 600],
    [0.75, 800],
    [1.0, 600],
    [1.25, 820],
    [1.6, 520],
  ]);
  vibrato(s, o, 0, 1.7, 6, 20);
  s.curve(g.gain, [
    [0, 0],
    [0.05, 0.6],
    [1.45, 0.55],
    [1.65, 0.001, "exp"],
  ]);
};

/* ---------------------------------------------------------------- UI */

const uiClick: SfxRecipe = (s) => {
  blip(s, 0, 380, 1150, 0.06, 0.7, "sine");
};

const uiHover: SfxRecipe = (s) => {
  blip(s, 0, 2400, 2600, 0.025, 0.5, "sine");
};

const uiToggle: SfxRecipe = (s) => {
  blip(s, 0, 880, 880, 0.06, 0.5, "triangle");
  blip(s, 0.065, 1320, 1320, 0.08, 0.5, "triangle");
};

const uiError: SfxRecipe = (s) => {
  [
    [0, 180, 120],
    [0.17, 150, 95],
  ].forEach(([at, f0, f1]) => {
    const g = s.gain(0);
    const o = s.osc("sawtooth", f0, at, at + 0.17, s.filter("lowpass", 900, 1.5, g));
    s.freq(o.frequency, [
      [at, f0],
      [at + 0.14, f1, "exp"],
    ]);
    s.perc(g.gain, at, 0.6, 0.01, 0.15);
  });
};

/**
 * Per-recipe calibration measured with the offline renders in dev/audio.html: brings each raw
 * recipe to a consistent loudness so SFX[id].volume alone expresses the mix (big hits peak
 * ≈ 0.85, everyday sounds ≈ 0.3–0.5, UI quieter), and nothing peaks above 1 before the buses.
 */
const SFX_TRIM: Partial<Record<SfxId, number>> = {
  bounce: 1.4,
  throw: 1.5,
  bonk: 0.85,
  catch: 0.62,
  whiff: 1.3,
  slideWhistle: 0.85,
  jump: 1.6,
  land: 1.3,
  roll: 3.5,
  flapDash: 2.2,
  groundPoundLeap: 1.5,
  shockwave: 0.85,
  curveArm: 2,
  bellySlide: 2,
  headbutt: 0.8,
  boomerang: 1.8,
  powerUpWarning: 1.6,
  ringShake: 1.4,
  crumbleRumble: 0.88,
  countdownGo: 0.78,
  suddenDeath: 0.75,
  uiToggle: 1.3,
};

/** Gain for one SFX before PlayOptions.volume and the buses: its mix volume × calibration. */
export function sfxGain(id: SfxId): number {
  return SFX[id].volume * (SFX_TRIM[id] ?? 1);
}

export const SFX_RECIPES: Readonly<Record<SfxId, SfxRecipe>> = {
  bounce,
  squeak,
  throw: throwFwip,
  throwHeavy,
  bonk,
  ding,
  catch: catchThwap,
  crowdOoh,
  whiff,
  slideWhistle,
  pickup,
  ballDrop,
  jump,
  land,
  roll,
  flapDash,
  groundPoundLeap,
  shockwave,
  bellyBoing,
  curveArm,
  bellySlide,
  headbutt,
  boomerang,
  honk,
  ko,
  powerUpWarning,
  powerUpSparkle,
  powerUpPickup,
  zoomies,
  ringShake,
  crumbleRumble,
  countdownTick,
  countdownGo,
  suddenDeath,
  uiClick,
  uiHover,
  uiToggle,
  uiError,
};
