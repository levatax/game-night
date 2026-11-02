// Continuous, parameter-driven sounds for every LoopName: per-player loops (charge whoosh, swim churn, puffer
// fuse, reel ratchet, hold-E channel hum), site loops (campfire crackle) and the ambience beds (waves, wind,
// gulls, crickets, rain, storm, dusk drums). Owner: client-fx-audio. The LoopKit / createLoop shell and the
// charge whoosh are copied from games/bonk-brawl/client/src/audio/synth/loops.ts; the wind is
// games/jelly-jackpot/client/src/audio/sfx/loops.ts WindLoop. New here: `tick()` schedules stochastic one-shots
// (crackles, drops, bird calls, ratchet clicks, drum hits) a little ahead, and `setPitch()` detunes every source.

import type { LoopName } from "../Sfx";
import { Band } from "../music/instruments";
import { WOOD_PARTIALS, chirp, click, crackle, droplet, formantChain, noiseBurst, struck, thump } from "./blocks";
import { Synth, belowNyquist, clamp01, getNoiseBuffer, rand, safeDisconnect, type NoiseColor } from "./dsp";

/** Smoothing time constant for parameter changes (s). */
const PARAM_TAU = 0.05;
const FADE_IN = 0.12;
const PARAM_EPSILON = 0.002;

/** A running loop voice. Times are absolute context seconds. */
export interface LoopVoice {
  readonly kind: "synth" | "sample";
  /** 0..1 loop parameter (charge, fire size, intensity, speed, progress, drum tempo…). */
  setParam(value: number, now: number): void;
  /** Pitch multiplier (1 = as designed). */
  setPitch(mult: number, now: number): void;
  /** Schedule stochastic events up to `horizon` (call every frame / ticker beat). */
  tick(now: number, horizon: number): void;
  /** Fade out over `fade` seconds from `now`; returns when every source has stopped. */
  stop(now: number, fade: number): number;
  /** Fires once after stop() when the voice has fully ended. */
  onEnded: (() => void) | null;
}

/** Creates a synth or sampled loop; AmbienceMixer can swap one for the other when a file finishes decoding. */
export type LoopFactory = (ctx: BaseAudioContext, name: LoopName, out: AudioNode, start: number, initial?: number) => LoopVoice;

/** Base gain of each loop before PlayOptions.volume (tuned against the one-shots). */
export const LOOP_LEVEL: Readonly<Record<LoopName, number>> = {
  charge: 0.7,
  fire: 0.75,
  rain: 0.55,
  waves: 0.6,
  crickets: 0.4,
  gulls: 0.5,
  wind: 0.45,
  drums: 0.7,
  swim: 0.5,
  fuse: 0.55,
  reel: 0.5,
  storm: 0.75,
  channel: 0.3,
};

/** Drum-circle tempo for a loop param 0..1 (BPM). */
export function drumBpmForParam(p: number): number {
  return 76 + 74 * clamp01(p);
}

/** Small node factory that remembers every source so the loop can stop them together. */
class LoopKit {
  readonly sources: AudioScheduledSourceNode[] = [];
  readonly nodes: AudioNode[] = [];
  private readonly disposers: Array<() => void> = [];
  /** Detune (cents) fed to every source: the loop's pitch. */
  readonly detune: ConstantSourceNode | null;

  constructor(
    readonly ctx: BaseAudioContext,
    readonly start: number,
  ) {
    if (typeof ctx.createConstantSource === "function") {
      this.detune = ctx.createConstantSource();
      this.detune.offset.value = 0;
      this.detune.start(start);
      this.sources.push(this.detune);
    } else {
      this.detune = null;
    }
  }

  gain(value: number, dest: AudioNode | AudioParam): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest instanceof AudioParam) g.connect(dest);
    else g.connect(dest);
    this.nodes.push(g);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = belowNyquist(this.ctx, freq);
    f.Q.value = q;
    f.connect(dest);
    this.nodes.push(f);
    return f;
  }

  osc(type: OscillatorType, freq: number, dest: AudioNode | AudioParam, pitched = true): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = belowNyquist(this.ctx, freq);
    if (dest instanceof AudioParam) o.connect(dest);
    else o.connect(dest);
    if (pitched && this.detune) this.detune.connect(o.detune);
    this.begin(o);
    return o;
  }

  noise(color: NoiseColor, dest: AudioNode, pitched = true): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = getNoiseBuffer(this.ctx, color);
    src.loop = true;
    src.connect(dest);
    if (pitched && this.detune) this.detune.connect(src.detune);
    this.begin(src, Math.random() * src.buffer.duration);
    return src;
  }

  /** LFO: osc → depth gain → param (never pitched). */
  lfo(rate: number, depth: number, param: AudioParam, type: OscillatorType = "sine"): OscillatorNode {
    return this.osc(type, rate, this.gain(depth, param), false);
  }

  /** Run `fn` when the loop has fully stopped (extra owned resources, e.g. a drum Band). */
  onDispose(fn: () => void): void {
    this.disposers.push(fn);
  }

  /** Stop every source at `at`; `onEnded` fires when the last one has ended. */
  stopAll(at: number, onEnded: () => void): void {
    let pending = this.sources.length;
    const done = (): void => {
      if (--pending > 0) return;
      for (const n of this.nodes) safeDisconnect(n);
      for (const s of this.sources) safeDisconnect(s);
      for (const fn of this.disposers) fn();
      onEnded();
    };
    if (pending === 0) {
      onEnded();
      return;
    }
    for (const s of this.sources) {
      s.addEventListener("ended", done, { once: true });
      try {
        s.stop(at);
      } catch {
        done();
      }
    }
  }

  private begin(src: AudioScheduledSourceNode, offset?: number): void {
    if (offset !== undefined && src instanceof AudioBufferSourceNode) src.start(this.start, offset);
    else src.start(this.start);
    this.sources.push(src);
  }
}

/** Ramp toward a target without stacking unbounded automation events. */
function glide(param: AudioParam, value: number, now: number, tau = PARAM_TAU): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tau);
}

interface LoopBehavior {
  /** Apply the 0..1 parameter. */
  apply(p: number, now: number): void;
  /**
   * Stochastic events: schedule into `out` from `from` up to `horizon` (absolute times). Returns the time of the
   * next pending event (the kit re-calls with that as `from`).
   */
  events?(from: number, horizon: number, p: number, out: AudioNode, rate: number): number;
}

type Builder = (k: LoopKit, out: GainNode) => LoopBehavior;

/**
 * Build one loop. `out` receives the loop's signal (the caller adds volume / panning after it). The voice
 * starts at `start` with a short fade-in and parameter `initial`.
 */
export function createLoop(ctx: BaseAudioContext, name: LoopName, out: AudioNode, start: number, initial = 0.5): LoopVoice {
  const kit = new LoopKit(ctx, start);
  const master = kit.gain(0, out);
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(1, start + FADE_IN);
  const behavior = BUILDERS[name](kit, master);
  let param = clamp01(initial);
  behavior.apply(param, start);

  let stopped = false;
  let last = param;
  let rate = 1;
  let nextEvent = start + 0.05;
  const voice: LoopVoice = {
    kind: "synth",
    onEnded: null,
    setParam(value, now) {
      const v = clamp01(value);
      // Callers update every frame; skip no-op changes so automation events don't pile up.
      if (stopped || Math.abs(v - last) < PARAM_EPSILON) return;
      last = v;
      param = v;
      behavior.apply(v, now);
    },
    setPitch(mult, now) {
      if (stopped || !Number.isFinite(mult) || mult <= 0) return;
      if (Math.abs(mult - rate) < 0.002) return;
      rate = mult;
      if (kit.detune) glide(kit.detune.offset, 1200 * Math.log2(mult), now, 0.04);
    },
    tick(now, horizon) {
      if (stopped || !behavior.events) return;
      if (nextEvent < now) nextEvent = now;
      if (nextEvent < horizon) nextEvent = behavior.events(nextEvent, horizon, param, master, rate);
    },
    stop(now, fade) {
      const f = Math.max(0.01, fade);
      const end = now + f + 0.03;
      if (stopped) return end;
      stopped = true;
      const g = master.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(0, now + f);
      kit.stopAll(end, () => voice.onEnded?.());
      return end;
    },
  };
  return voice;
}

/** Schedule `count`-rate Poisson events: returns the next event time after `from` (exponential gaps). */
function nextPoisson(from: number, perSec: number): number {
  const r = Math.max(0.05, perSec);
  return from - Math.log(1 - Math.random() * 0.999) / r;
}

/* ------------------------------------------------------------------ charge */

/** Wind-up whoosh (Bonk): air + whistling tone rising with the charge, shimmer at full. */
function buildCharge(k: LoopKit, out: GainNode): LoopBehavior {
  const wobble = k.gain(0.75, out);
  const wobbleLfo = k.lfo(5, 0.25, wobble.gain);
  const air = k.gain(0.5, wobble);
  const airBand = k.filter("bandpass", 500, 2.2, air);
  k.noise("pink", airBand);
  const toneGain = k.gain(0.12, wobble);
  const toneLp = k.filter("lowpass", 900, 0.8, toneGain);
  const tone = k.osc("triangle", 180, toneLp);
  const octave = k.osc("sine", 360, k.gain(0.5, toneLp));
  const shimmer = k.gain(0, out);
  const shimmerTrem = k.gain(0.6, shimmer);
  k.lfo(13, 0.4, shimmerTrem.gain);
  for (const f of [2093, 2637, 3136, 4186]) k.osc("sine", f, k.gain(0.06, shimmerTrem));
  return {
    apply(p, now) {
      const curve = p * p * (3 - 2 * p);
      glide(airBand.frequency, 450 + 2800 * curve, now);
      glide(air.gain, 0.35 + 0.45 * p, now);
      const f = 170 * 2 ** (2.1 * curve);
      glide(tone.frequency, f, now);
      glide(octave.frequency, f * 2, now);
      glide(toneLp.frequency, 700 + 2600 * curve, now);
      glide(toneGain.gain, 0.08 + 0.12 * p, now);
      glide(wobbleLfo.frequency, 4 + 14 * curve, now);
      glide(shimmer.gain, p >= 0.98 ? 1 : 0, now, p >= 0.98 ? 0.05 : 0.02);
    },
  };
}

/* -------------------------------------------------------------------- fire */

/** Campfire: a low roar + hiss that flickers, with random crackles and pops (param = fire size). */
function buildFire(k: LoopKit, out: GainNode): LoopBehavior {
  const roar = k.gain(0.4, out);
  const roarLp = k.filter("lowpass", 420, 0.8, roar);
  k.noise("brown", roarLp);
  k.lfo(0.7, 0.12, roar.gain);
  k.lfo(1.9, 0.07, roar.gain, "triangle");
  const hiss = k.gain(0.06, out);
  k.noise("pink", k.filter("bandpass", 1300, 0.8, hiss));
  return {
    apply(p, now) {
      glide(roar.gain, 0.2 + 0.4 * p, now, 0.3);
      glide(roarLp.frequency, 260 + 500 * p, now, 0.3);
      glide(hiss.gain, 0.03 + 0.06 * p, now, 0.3);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        const s = new Synth(k.ctx, dest, t, rate);
        crackle(s, 0, (0.1 + 0.3 * Math.random()) * (0.4 + 0.6 * p));
        if (Math.random() < 0.08) thump(s, 0, 160, 70, 0.06, 0.15 * p);
        t = nextPoisson(t, 2 + 9 * p);
      }
      return t;
    },
  };
}

/* -------------------------------------------------------------------- rain */

/** Rain: a hissing bed, a soft body and plinks on leaves / water (param = intensity). */
function buildRain(k: LoopKit, out: GainNode): LoopBehavior {
  const hiss = k.gain(0.3, out);
  k.noise("white", k.filter("highpass", 1800, 0.6, k.filter("lowpass", 9000, 0.6, hiss)));
  const body = k.gain(0.15, out);
  k.noise("pink", k.filter("lowpass", 900, 0.7, body));
  k.lfo(0.13, 0.05, body.gain);
  return {
    apply(p, now) {
      glide(hiss.gain, 0.08 + 0.35 * p, now, 0.6);
      glide(body.gain, 0.06 + 0.2 * p, now, 0.6);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        droplet(new Synth(k.ctx, dest, t, rate), 0, rand(1100, 3200), 0.04 + 0.08 * Math.random());
        t = nextPoisson(t, 3 + 14 * p);
      }
      return t;
    },
  };
}

/* ------------------------------------------------------------------- waves */

/** Surf: a swelling filtered-noise wash on a slow cycle, foam hiss on the crest, occasional crashes. */
function buildWaves(k: LoopKit, out: GainNode): LoopBehavior {
  const wash = k.gain(0.5, out);
  const washLp = k.filter("lowpass", 700, 0.7, wash);
  k.noise("brown", washLp);
  const swell = k.lfo(0.11, 0.3, wash.gain);
  const cutoff = k.lfo(0.11, 450, washLp.frequency);
  const foam = k.gain(0.08, out);
  k.noise("pink", k.filter("highpass", 900, 0.6, foam));
  k.lfo(0.11, 0.07, foam.gain);
  return {
    apply(p, now) {
      glide(wash.gain, 0.3 + 0.45 * p, now, 0.8);
      glide(foam.gain, 0.03 + 0.12 * p, now, 0.8);
      glide(swell.frequency, 0.09 + 0.06 * p, now, 1);
      glide(cutoff.frequency, 0.09 + 0.06 * p, now, 1);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        if (p > 0.35) {
          const s = new Synth(k.ctx, dest, t, rate);
          noiseBurst(s, 0, rand(1.2, 2), 0.25 * p, { type: "lowpass", from: 300, to: 1600, q: 0.6, color: "pink", attack: 0.5 });
        }
        t += rand(5, 10) / (0.6 + p);
      }
      return t;
    },
  };
}

/* ---------------------------------------------------------------- crickets */

/** Night crickets (three chirping in turn) and a frog now and then (param = how many are singing). */
function buildCrickets(k: LoopKit): LoopBehavior {
  const voices = [4300, 4750, 5200];
  return {
    apply() {},
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        const s = new Synth(k.ctx, dest, t, rate);
        const f = voices[Math.floor(Math.random() * voices.length)]!;
        const pulses = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < pulses; i++) chirp(s, i * 0.035, f, f * 1.03, 0.018, 0.12 + 0.08 * Math.random());
        if (Math.random() < 0.05) {
          // Frog: a low throaty "rrbt".
          const g = s.gain(0);
          const chain = formantChain(s, 3, [
            [400, 4, 1.2],
            [900, 5, 0.4],
          ], g);
          s.osc("sawtooth", rand(70, 90), 0.2, 0.36, chain);
          s.lfo(32, 15, g.gain, 0.2, 0.36);
          s.perc(g.gain, 0.2, 0.18, 0.02, 0.14);
        }
        t += rand(0.25, 0.9) / (0.4 + p);
      }
      return t;
    },
  };
}

/* ------------------------------------------------------------------- gulls */

/** Seagull calls across the beach every few seconds, plus a soft sea breeze (param = gull density). */
function buildGulls(k: LoopKit, out: GainNode): LoopBehavior {
  const breeze = k.gain(0.05, out);
  k.noise("pink", k.filter("bandpass", 700, 0.6, breeze));
  return {
    apply(p, now) {
      glide(breeze.gain, 0.02 + 0.04 * p, now, 0.6);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        if (t > k.start + 0.5) {
          const s = new Synth(k.ctx, dest, t, rate * rand(0.85, 1.2));
          const calls = 1 + Math.floor(Math.random() * 3);
          const level = 0.12 + 0.18 * Math.random();
          for (let i = 0; i < calls; i++) {
            const at = i * rand(0.22, 0.32);
            const g = s.gain(0);
            const chain = formantChain(s, 2.2, [
              [1500, 4, 1.2],
              [2700, 6, 0.6],
            ], s.filter("lowpass", 4500, 0.7, g));
            const f = rand(950, 1200);
            const o = s.osc("sawtooth", f, at, at + 0.24, chain);
            s.freq(o.frequency, [
              [at, f * 0.8],
              [at + 0.06, f * 1.4, "exp"],
              [at + 0.22, f, "exp"],
            ]);
            s.curve(g.gain, [
              [at, 0],
              [at + 0.03, level],
              [at + 0.22, 0.001, "exp"],
            ]);
          }
        }
        t += rand(2.5, 7) / (0.3 + p);
      }
      return t;
    },
  };
}

/* -------------------------------------------------------------------- wind */

/** Gusty "wooOOOooo" wind (Jelly WindLoop): two drifting resonant noise bands + a faint whistle. */
function buildWind(k: LoopKit, out: GainNode): LoopBehavior {
  const gust = k.gain(0.7, out);
  k.lfo(0.23, 0.3, gust.gain);
  const a = k.filter("bandpass", 520, 6, k.gain(1.2, gust));
  const b = k.filter("bandpass", 1150, 9, k.gain(0.6, gust));
  const n = k.noise("pink", a);
  n.connect(b);
  k.lfo(0.17, 180, a.frequency);
  k.lfo(0.11, 320, b.frequency, "triangle");
  const whistleGain = k.gain(0.02, out);
  const whistle = k.osc("sine", 760, whistleGain);
  k.lfo(0.3, 90, whistle.frequency);
  return {
    apply(p, now) {
      glide(gust.gain, 0.25 + 0.75 * p, now, 0.6);
      glide(a.Q, 4 + p * 6, now, 0.5);
      glide(whistleGain.gain, 0.01 + 0.04 * p, now, 0.6);
    },
  };
}

/* ------------------------------------------------------------------- drums */

/** The dusk drum circle: low toms + slaps in a 16-step pattern whose tempo is the param (monster count). */
function buildDrums(k: LoopKit, out: GainNode): LoopBehavior {
  const band = new Band(k.ctx, out);
  k.onDispose(() => band.dispose());
  let step = 0;
  let bpm = drumBpmForParam(0.3);
  // D = low tom, d = high tom, s = slap, . = rest. Two bars so it breathes.
  const pattern = "D..d..D.s.D...d.D..d..D.s..dDd.s";
  return {
    apply(p) {
      bpm = drumBpmForParam(p);
    },
    events(from, horizon, p) {
      let t = from;
      while (t < horizon) {
        const ch = pattern[step % pattern.length]!;
        const accent = step % 8 === 0 ? 1 : 0.8;
        const v = (0.55 + 0.45 * p) * accent;
        if (ch === "D") band.tom(t, 0.05, v);
        else if (ch === "d") band.tom(t, 0.6, v * 0.8);
        else if (ch === "s") band.slap(t, v * 0.7);
        step++;
        t += 60 / bpm / 4;
      }
      return t;
    },
  };
}

/* -------------------------------------------------------------------- swim */

/** Swimming: water churning in strokes (param = speed), a gurgle under it, drips. */
function buildSwim(k: LoopKit, out: GainNode): LoopBehavior {
  const stroke = k.gain(0.3, out);
  const gate = k.gain(0.5, stroke);
  k.noise("pink", k.filter("bandpass", 900, 1, gate));
  const strokeLfo = k.lfo(1.6, 0.5, gate.gain);
  const gurgle = k.gain(0.12, out);
  k.noise("brown", k.filter("lowpass", 320, 1.5, gurgle));
  return {
    apply(p, now) {
      glide(strokeLfo.frequency, 1.2 + 1.4 * p, now, 0.2);
      glide(stroke.gain, 0.15 + 0.35 * p, now, 0.2);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        droplet(new Synth(k.ctx, dest, t, rate), 0, rand(700, 1600), 0.08);
        t = nextPoisson(t, 1 + 4 * p);
      }
      return t;
    },
  };
}

/* -------------------------------------------------------------------- fuse */

/** Puffer fuse sizzle: hissing with flickers and sparks, faster and brighter as it runs out (param = urgency). */
function buildFuse(k: LoopKit, out: GainNode): LoopBehavior {
  const hiss = k.gain(0.25, out);
  const band = k.filter("highpass", 4000, 0.7, hiss);
  k.noise("white", band);
  k.lfo(37, 0.12, hiss.gain, "square");
  k.lfo(23, 0.08, hiss.gain);
  return {
    apply(p, now) {
      glide(hiss.gain, 0.15 + 0.3 * p, now, 0.1);
      glide(band.frequency, 4000 + 2500 * p, now, 0.1);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        const s = new Synth(k.ctx, dest, t, rate);
        crackle(s, 0, 0.15 + 0.2 * Math.random());
        if (Math.random() < 0.15 + 0.3 * p) click(s, 0, 0.3, 3500 + 2000 * p);
        t = nextPoisson(t, 8 + 24 * p);
      }
      return t;
    },
  };
}

/* -------------------------------------------------------------------- reel */

/** Fishing reel ratchet: clicks at a rate set by the param (reel speed). */
function buildReel(k: LoopKit): LoopBehavior {
  return {
    apply() {},
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        const s = new Synth(k.ctx, dest, t, rate);
        struck(s, 0, 1400 * rand(0.96, 1.04), 0.03, 0.35, WOOD_PARTIALS);
        click(s, 0, 0.2, 4200);
        t += 1 / (6 + 30 * p);
      }
      return t;
    },
  };
}

/* ------------------------------------------------------------------- storm */

/** The Great Storm: howling wind, heavy rain, a constant low rumble and rolling thunder (param = build-up). */
function buildStorm(k: LoopKit, out: GainNode): LoopBehavior {
  const wind = k.gain(0.5, out);
  const a = k.filter("bandpass", 420, 3, wind);
  const b = k.filter("bandpass", 950, 5, wind);
  const n = k.noise("pink", a);
  n.connect(b);
  k.lfo(0.21, 160, a.frequency);
  k.lfo(0.13, 300, b.frequency, "triangle");
  k.lfo(0.31, 0.25, wind.gain);
  const rain = k.gain(0.3, out);
  k.noise("white", k.filter("highpass", 1500, 0.6, rain));
  const low = k.gain(0.4, out);
  k.noise("brown", k.filter("lowpass", 120, 0.8, low));
  return {
    apply(p, now) {
      glide(wind.gain, 0.25 + 0.65 * p, now, 0.8);
      glide(rain.gain, 0.1 + 0.4 * p, now, 0.8);
      glide(low.gain, 0.2 + 0.6 * p, now, 0.8);
    },
    events(from, horizon, p, dest, rate) {
      let t = from;
      while (t < horizon) {
        if (t > k.start + 1) {
          const s = new Synth(k.ctx, dest, t, rate);
          noiseBurst(s, 0, rand(1.5, 3), 0.25 + 0.35 * p, { type: "lowpass", from: 380, to: 60, q: 0.8, color: "brown", attack: 0.08 });
          if (p > 0.6 && Math.random() < 0.4) noiseBurst(s, 0, 0.12, 0.3, { type: "highpass", from: 1600, q: 0.6 });
        }
        t += rand(5, 13) / (0.5 + p);
      }
      return t;
    },
  };
}

/* ----------------------------------------------------------------- channel */

/** Hold-E work hum (gather / revive): a soft rising tone and a brushing pulse (param = progress). */
function buildChannel(k: LoopKit, out: GainNode): LoopBehavior {
  const toneGain = k.gain(0.12, out);
  const trem = k.gain(0.7, toneGain);
  k.lfo(6, 0.3, trem.gain);
  const tone = k.osc("triangle", 220, k.filter("lowpass", 1400, 0.7, trem));
  const brush = k.gain(0.1, out);
  const gate = k.gain(0.5, brush);
  k.noise("pink", k.filter("bandpass", 2200, 1, gate));
  k.lfo(3, 0.5, gate.gain, "square");
  return {
    apply(p, now) {
      glide(tone.frequency, 220 * 2 ** (p * 1.0), now, 0.08);
      glide(toneGain.gain, 0.08 + 0.1 * p, now, 0.08);
    },
  };
}

const BUILDERS: Readonly<Record<LoopName, Builder>> = {
  charge: buildCharge,
  fire: buildFire,
  rain: buildRain,
  waves: buildWaves,
  crickets: buildCrickets,
  gulls: buildGulls,
  wind: buildWind,
  drums: buildDrums,
  swim: buildSwim,
  fuse: buildFuse,
  reel: buildReel,
  storm: buildStorm,
  channel: buildChannel,
};
