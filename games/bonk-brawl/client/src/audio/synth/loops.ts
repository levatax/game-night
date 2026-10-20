// Continuous, parameter-driven sounds behind LoopHandle: the charge whoosh (pitch follows charge),
// Pip's belly-slide scrape and the Zoomies sneaker patter. Works on any BaseAudioContext.

import type { LoopId } from "../Sfx";
import { bendSource, clamp01, getNoiseBuffer, safeDisconnect, type NoiseColor } from "./dsp";

/** Smoothing time constant for parameter changes (s): fast enough to track a 1 s charge. */
const PARAM_TAU = 0.035;
const FADE_IN = 0.06;
const PARAM_EPSILON = 0.002;

/** A running loop voice. Times are absolute context seconds. */
export interface LoopVoice {
  setParam(value: number, now: number): void;
  /** Fade out over `fade` seconds from `now`; returns when every source has stopped. */
  stop(now: number, fade: number): number;
  /** Fires once after stop() when the voice has fully ended. */
  onEnded: (() => void) | null;
}

/** Base gain of each loop before PlayOptions.volume (tuned against the one-shot SFX levels). */
export const LOOP_LEVEL: Readonly<Record<LoopId, number>> = {
  charge: 0.8,
  slide: 0.55,
  zoomies: 0.7,
};

/** Small node factory that remembers every source so the loop can stop them together. */
class LoopKit {
  readonly sources: AudioScheduledSourceNode[] = [];
  readonly nodes: AudioNode[] = [];

  constructor(
    readonly ctx: BaseAudioContext,
    readonly start: number,
    private readonly bend: AudioNode | null,
  ) {}

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
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    this.nodes.push(f);
    return f;
  }

  osc(type: OscillatorType, freq: number, dest: AudioNode | AudioParam): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    if (dest instanceof AudioParam) o.connect(dest);
    else o.connect(dest);
    this.begin(o);
    return o;
  }

  noise(color: NoiseColor, dest: AudioNode): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = getNoiseBuffer(this.ctx, color);
    src.loop = true;
    src.connect(dest);
    this.begin(src, Math.random() * src.buffer.duration);
    return src;
  }

  /** Stop every source at `at`; `onEnded` fires when the last one has ended. */
  stopAll(at: number, onEnded: () => void): void {
    let pending = this.sources.length;
    const done = (): void => {
      if (--pending > 0) return;
      for (const n of this.nodes) safeDisconnect(n);
      for (const s of this.sources) safeDisconnect(s);
      onEnded();
    };
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
    if (this.bend) bendSource(this.bend, src);
    this.sources.push(src);
  }
}

/** Ramp toward a target without stacking unbounded automation events. */
function glide(param: AudioParam, value: number, now: number, tau = PARAM_TAU): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, tau);
}

type ParamFn = (p: number, now: number) => void;

/**
 * Build one loop. `out` receives the loop's signal (the caller adds volume / panning after it).
 * The voice starts at `start` with a short fade-in and parameter 0.
 */
export function createLoop(ctx: BaseAudioContext, id: LoopId, out: AudioNode, start: number, bend: AudioNode | null = null): LoopVoice {
  const kit = new LoopKit(ctx, start, bend);
  const master = kit.gain(0, out);
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(1, start + FADE_IN);
  const apply = BUILDERS[id](kit, master);
  apply(0, start);

  let stopped = false;
  let last = 0;
  const voice: LoopVoice = {
    onEnded: null,
    setParam(value, now) {
      const v = clamp01(value);
      // Callers update every frame; skip no-op changes so automation events don't pile up.
      if (stopped || Math.abs(v - last) < PARAM_EPSILON) return;
      last = v;
      apply(v, now);
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

/* ------------------------------------------------------------------ charge */

/**
 * Wind-up whoosh: a band-passed air layer and a whistling tone that both rise with the charge,
 * a wobble that speeds up, and a sparkly shimmer that blooms only at full charge.
 */
function buildCharge(k: LoopKit, out: GainNode): ParamFn {
  // Wobble: amplitude flutter whose rate follows the charge.
  const wobble = k.gain(0.75, out);
  const wobbleLfo = k.osc("sine", 5, k.gain(0.25, wobble.gain));

  const air = k.gain(0.5, wobble);
  const airBand = k.filter("bandpass", 500, 2.2, air);
  k.noise("pink", airBand);

  const toneGain = k.gain(0.12, wobble);
  const toneLp = k.filter("lowpass", 900, 0.8, toneGain);
  const tone = k.osc("triangle", 180, toneLp);
  const octave = k.osc("sine", 360, k.gain(0.5, toneLp));

  const shimmer = k.gain(0, out);
  const shimmerTrem = k.gain(0.6, shimmer);
  k.osc("sine", 13, k.gain(0.4, shimmerTrem.gain));
  for (const f of [2093, 2637, 3136, 4186]) k.osc("sine", f, k.gain(0.06, shimmerTrem));

  return (p, now) => {
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
  };
}

/* ------------------------------------------------------------------- slide */

/** Belly-slide scrape: grainy air + a low rumble, brighter and louder with speed. */
function buildSlide(k: LoopKit, out: GainNode): ParamFn {
  const flutter = k.gain(0.8, out);
  k.osc("sine", 7, k.gain(0.2, flutter.gain));

  const scrape = k.gain(0.4, flutter);
  const scrapeBand = k.filter("bandpass", 1400, 1.4, scrape);
  k.noise("white", scrapeBand);

  const rumble = k.gain(0.6, flutter);
  const rumbleLp = k.filter("lowpass", 260, 0.9, rumble);
  k.noise("brown", rumbleLp);

  return (p, now) => {
    glide(scrapeBand.frequency, 900 + 2400 * p, now, 0.08);
    glide(scrape.gain, 0.08 + 0.32 * p, now, 0.08);
    glide(rumbleLp.frequency, 180 + 380 * p, now, 0.08);
    glide(rumble.gain, 0.35 + 0.5 * p, now, 0.08);
  };
}

/* ----------------------------------------------------------------- zoomies */

/** Cartoon sneaker patter (pulsed squeaky noise) over a revving motor tone. */
function buildZoomies(k: LoopKit, out: GainNode): ParamFn {
  // Patter: band-passed noise gated by a smoothed square LFO.
  const patter = k.gain(0.5, out);
  const gate = k.gain(0.5, patter);
  const patterBand = k.filter("bandpass", 1900, 2.2, gate);
  k.noise("white", patterBand);
  const gateSmooth = k.filter("lowpass", 70, 0.7, k.gain(0.5, gate.gain));
  const step = k.osc("square", 8, gateSmooth);

  const motorGain = k.gain(0.12, out);
  const motorLp = k.filter("lowpass", 700, 2, motorGain);
  const motor = k.osc("sawtooth", 90, motorLp);
  k.osc("sine", 9, k.gain(6, motor.frequency));

  return (p, now) => {
    glide(step.frequency, 7 + 9 * p, now, 0.1);
    glide(patterBand.frequency, 1500 + 1400 * p, now, 0.1);
    glide(patter.gain, 0.2 + 0.6 * p, now, 0.1);
    glide(motor.frequency, 80 + 150 * p, now, 0.12);
    glide(motorLp.frequency, 500 + 1300 * p, now, 0.12);
    glide(motorGain.gain, 0.05 + 0.13 * p, now, 0.12);
  };
}

const BUILDERS: Readonly<Record<LoopId, (k: LoopKit, out: GainNode) => ParamFn>> = {
  charge: buildCharge,
  slide: buildSlide,
  zoomies: buildZoomies,
};
