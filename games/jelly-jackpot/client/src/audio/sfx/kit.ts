// Shared synth helpers for the SFX: pooled noise buffers, envelopes and a per-sound node Group that
// disconnects everything it created once the sound is over (so one-shots never leak nodes).

export type NoiseKind = "white" | "pink" | "brown";

/** Floor for exponential ramps (they can't reach 0). */
export const SILENT = 0.0001;

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
/** Random multiplier around 1 (±amt), for pitch variation so repeats aren't samey. */
export const vary = (amt = 0.06): number => 1 + (Math.random() * 2 - 1) * amt;
export const clamp01 = (v: number): number => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);

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
export function glide(param: AudioParam, t: number, pts: Array<[number, number]>): void {
  if (pts.length === 0) return;
  param.setValueAtTime(Math.max(1, pts[0][1]), t + pts[0][0]);
  for (let i = 1; i < pts.length; i++) param.exponentialRampToValueAtTime(Math.max(1, pts[i][1]), t + pts[i][0]);
}

const MAX_ACTIVE = 48;

export class Kit {
  readonly ctx: AudioContext;
  readonly out: AudioNode;
  active = 0;
  private buffers = new Map<NoiseKind, AudioBuffer>();
  private shaper: Float32Array<ArrayBuffer> | null = null;

  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;
    this.out = out;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  /** A sound group living from t for `dur` seconds at volume `vol`; null when we're over the voice budget. */
  group(t: number, dur: number, vol: number, dest: AudioNode = this.out): Group | null {
    if (this.active >= MAX_ACTIVE || !(vol > 0)) return null;
    return new Group(this, t, dur, vol, dest);
  }

  /** 2-second mono noise buffers, generated once and shared by every sound. */
  noiseBuffer(kind: NoiseKind): AudioBuffer {
    const hit = this.buffers.get(kind);
    if (hit) return hit;
    const len = Math.floor(this.ctx.sampleRate * 2);
    const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
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
    this.buffers.set(kind, buf);
    return buf;
  }

  /** Soft-clip curve for crunchy/buzzy things (kazoo, record scratch). */
  crunchCurve(): Float32Array<ArrayBuffer> {
    if (this.shaper) return this.shaper;
    const n = 1024;
    const c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = Math.tanh(x * 3) * 0.8;
    }
    this.shaper = c;
    return c;
  }
}

/** All nodes of one sound. Everything routes into `out` (a gain at the sound's volume). */
export class Group {
  readonly out: GainNode;
  readonly ctx: AudioContext;
  private nodes: AudioNode[] = [];

  constructor(private kit: Kit, t: number, dur: number, vol: number, dest: AudioNode) {
    this.ctx = kit.ctx;
    this.out = kit.ctx.createGain();
    this.out.gain.value = Math.min(1.5, vol);
    this.out.connect(dest);
    this.nodes.push(this.out);
    kit.active++;
    const ms = Math.max(0, t - kit.now + dur + 0.25) * 1000;
    setTimeout(() => this.dispose(), ms);
  }

  private dispose(): void {
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
    o.frequency.setValueAtTime(freq, t0);
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
