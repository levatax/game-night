// Shared synth helpers for the KASALA sfx: pooled noise buffers, envelopes, and a per-sound node Group that
// disconnects everything it created once the sound is over (one-shots never leak nodes). The number of live
// groups is bounded (MAX_ACTIVE) so a burst of events can't pile up voices.

export type NoiseKind = "white" | "pink" | "brown";

/** Floor for exponential ramps (they can't reach 0). */
export const SILENT = 0.0001;

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
/** Random multiplier around 1 (±amt), for pitch variation so repeats aren't samey. */
export const vary = (amt = 0.06): number => 1 + (Math.random() * 2 - 1) * amt;
export const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
export const pick = <T>(arr: readonly T[]): T => arr[Math.min(arr.length - 1, Math.floor(Math.random() * arr.length))];
export const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);

/** Percussive envelope: silent → peak in `a`, optional hold, exponential decay over `d`. */
export function env(param: AudioParam, t: number, a: number, peak: number, d: number, hold = 0): void {
  const p = Math.max(SILENT * 2, Number.isFinite(peak) ? peak : 0);
  param.cancelScheduledValues(t);
  param.setValueAtTime(SILENT, t);
  param.linearRampToValueAtTime(p, t + Math.max(0.001, a));
  if (hold > 0) param.setValueAtTime(p, t + a + hold);
  param.exponentialRampToValueAtTime(SILENT, t + a + hold + Math.max(0.005, d));
}

/** Glide a frequency param through [time offset, value] points (exponential, values must be > 0). */
export function glide(param: AudioParam, t: number, pts: ReadonlyArray<readonly [number, number]>): void {
  if (pts.length === 0) return;
  param.setValueAtTime(Math.max(1, pts[0][1]), t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) param.exponentialRampToValueAtTime(Math.max(1, pts[i][1]), t + pts[i][0]);
}

const MAX_ACTIVE = 40;

export class Kit {
  readonly ctx: AudioContext;
  readonly out: AudioNode;
  /** Reverb send (the smoky back room), or null. */
  readonly wet: AudioNode | null;
  active = 0;
  private pan = 0;
  private buffers = new Map<NoiseKind, AudioBuffer>();
  private shaperCurve: Float32Array<ArrayBuffer> | null = null;

  constructor(ctx: AudioContext, out: AudioNode, wet: AudioNode | null) {
    this.ctx = ctx;
    this.out = out;
    this.wet = wet;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** A sound group living from t for `dur` seconds at volume `vol`; null when over the voice budget. */
  group(t: number, dur: number, vol: number): Group | null {
    if (this.active >= MAX_ACTIVE || !(vol > 0)) return null;
    return new Group(this, t, dur, vol, this.pan);
  }

  /** Run `fn` with every group it creates panned to `pan` (-1..1). */
  withPan<T>(pan: number, fn: () => T): T {
    const prev = this.pan;
    this.pan = Number.isFinite(pan) ? Math.max(-1, Math.min(1, pan)) : 0;
    try {
      return fn();
    } finally {
      this.pan = prev;
    }
  }

  /** 2-second mono noise buffers, generated once and shared by every sound. */
  noiseBuffer(kind: NoiseKind): AudioBuffer {
    const hit = this.buffers.get(kind);
    if (hit) return hit;
    const buf = makeNoise(this.ctx, kind, 2);
    this.buffers.set(kind, buf);
    return buf;
  }

  /** Soft-clip curve for crunchy/buzzy things (cracks, buzzers, kazoo-ish voices). */
  crunchCurve(): Float32Array<ArrayBuffer> {
    if (this.shaperCurve) return this.shaperCurve;
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 3) * 0.8;
    }
    this.shaperCurve = c;
    return c;
  }
}

/** Mono noise buffer of `sec` seconds. */
export function makeNoise(ctx: BaseAudioContext, kind: NoiseKind, sec: number): AudioBuffer {
  const len = Math.max(1, Math.floor(ctx.sampleRate * sec));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === "white") d[i] = w * 0.7;
    else if (kind === "pink") {
      // Paul Kellet's pink filter
      b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852; b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
      d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.08;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.2;
    }
  }
  return buf;
}

/**
 * Stereo room impulse response: decaying noise that gets darker as it fades (a low, smoky back room).
 * Shared by the music and sfx reverbs.
 */
export function makeRoomImpulse(ctx: BaseAudioContext, sec = 1.5, decay = 3.2): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.max(1, Math.floor(rate * sec));
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const x = i / len;
      // One-pole lowpass whose cutoff closes over time.
      const k = 0.55 - 0.45 * x;
      lp += k * (Math.random() * 2 - 1 - lp);
      const early = i < rate * 0.012 ? 0 : 1;
      d[i] = lp * Math.pow(1 - x, decay) * early * 0.9;
    }
  }
  return buf;
}

/** All nodes of one sound. Everything routes into `out` (a gain at the sound's volume, optionally panned). */
export class Group {
  readonly out: GainNode;
  readonly ctx: AudioContext;
  private nodes: AudioNode[] = [];
  private disposed = false;

  constructor(private kit: Kit, t: number, dur: number, vol: number, pan: number) {
    this.ctx = kit.ctx;
    this.out = kit.ctx.createGain();
    this.out.gain.value = Math.min(1.6, vol);
    this.nodes.push(this.out);
    if (pan !== 0 && typeof kit.ctx.createStereoPanner === "function") {
      const p = kit.ctx.createStereoPanner();
      p.pan.value = pan;
      this.out.connect(p);
      p.connect(kit.out);
      this.nodes.push(p);
    } else this.out.connect(kit.out);
    kit.active++;
    const ms = Math.max(0, t - kit.now + dur + 0.3) * 1000;
    setTimeout(() => this.dispose(), ms);
  }

  private dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already gone */
      }
    }
    this.nodes.length = 0;
    this.kit.active = Math.max(0, this.kit.active - 1);
  }

  private track<T extends AudioNode>(n: T, dest: AudioNode | null): T {
    if (dest) n.connect(dest);
    this.nodes.push(n);
    return n;
  }

  /** Send this sound into the room reverb at `level`. */
  send(level: number): void {
    if (!this.kit.wet || !(level > 0)) return;
    const s = this.gain(level, this.kit.wet);
    this.out.connect(s);
  }

  gain(value: number, dest: AudioNode | null = this.out): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    return this.track(g, dest);
  }

  /** A gain that starts silent: shape it with env(). */
  vca(dest: AudioNode | null = this.out): GainNode {
    return this.gain(0, dest);
  }

  filter(type: BiquadFilterType, freq: number, Q = 1, dest: AudioNode | null = this.out): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = Q;
    return this.track(f, dest);
  }

  shaper(dest: AudioNode | null = this.out): WaveShaperNode {
    const s = this.ctx.createWaveShaper();
    s.curve = this.kit.crunchCurve();
    s.oversample = "2x";
    return this.track(s, dest);
  }

  osc(type: OscillatorType, freq: number, t0: number, t1: number, dest: AudioNode | null = this.out): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, freq), t0);
    this.track(o, dest);
    o.start(t0);
    o.stop(t1);
    return o;
  }

  /** LFO (osc → depth gain) connected into `param`. */
  lfo(type: OscillatorType, rate: number, depth: number, param: AudioParam, t0: number, t1: number): { osc: OscillatorNode; depth: GainNode } {
    const d = this.ctx.createGain();
    d.gain.value = depth;
    this.nodes.push(d);
    d.connect(param);
    const o = this.osc(type, rate, t0, t1, d);
    return { osc: o, depth: d };
  }

  noise(kind: NoiseKind, t0: number, t1: number, dest: AudioNode | null = this.out, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.kit.noiseBuffer(kind);
    s.loop = true;
    s.playbackRate.value = rate;
    this.track(s, dest);
    s.start(t0, Math.random() * 1.8);
    s.stop(t1);
    return s;
  }
}

// ---- tiny building blocks shared by the recipe files -------------------------------------------------

/** One-off oscillator with a frequency glide and a percussive gain envelope. */
export function blip(
  g: Group,
  type: OscillatorType,
  t: number,
  pts: ReadonlyArray<readonly [number, number]>,
  peak: number,
  d: number,
  a = 0.003,
  dest: AudioNode = g.out,
): OscillatorNode {
  const v = g.vca(dest);
  const o = g.osc(type, pts[0][1], t, t + a + d + 0.05, v);
  glide(o.frequency, t, pts);
  env(v.gain, t, a, peak, d);
  return o;
}

/** Filtered noise burst with a percussive envelope. Returns the filter (for sweeps). */
export function noiseHit(
  g: Group,
  kind: NoiseKind,
  t: number,
  type: BiquadFilterType,
  f: number,
  Q: number,
  peak: number,
  d: number,
  a = 0.002,
  dest: AudioNode = g.out,
): BiquadFilterNode {
  const v = g.vca(dest);
  const fl = g.filter(type, f, Q, v);
  g.noise(kind, t, t + a + d + 0.05, fl);
  env(v.gain, t, a, peak, d);
  return fl;
}

/** Struck bell / metal: sine partials [ratio, relative amp, relative decay] with staggered decays. */
export function strike(
  g: Group,
  t: number,
  f: number,
  partials: ReadonlyArray<readonly [number, number, number]>,
  peak: number,
  d: number,
  dest: AudioNode = g.out,
): void {
  for (const [r, a, dk] of partials) {
    const fr = f * r;
    if (fr > 17000) continue;
    const v = g.vca(dest);
    g.osc("sine", fr, t, t + d * dk + 0.06, v);
    env(v.gain, t, 0.0015, peak * a, d * dk);
  }
}

/** Classic bell partials (minor-third hum, tierce, quint…). */
export const BELL: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1],
  [2.0, 0.5, 0.7],
  [2.76, 0.4, 0.5],
  [5.4, 0.2, 0.28],
  [8.93, 0.1, 0.16],
];
/** Small metal parts (coins, cuffs, latches): very inharmonic, short. */
export const TINK: ReadonlyArray<readonly [number, number, number]> = [
  [1, 1, 1],
  [2.32, 0.7, 0.6],
  [4.25, 0.45, 0.35],
  [6.63, 0.25, 0.2],
];
