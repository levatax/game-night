// Low-level Web Audio helpers shared by SFX recipes, character voices, loops and music.
// Everything works on BaseAudioContext so the same code renders live and in an OfflineAudioContext.

export type NoiseColor = "white" | "pink" | "brown";

/** [time offset (s), value] or [time, value, ramp kind]. The first point is always a hard set. */
export type CurvePoint = readonly [number, number] | readonly [number, number, RampKind];
export type RampKind = "lin" | "exp" | "set";

const NOISE_SECONDS = 2;
const EXP_FLOOR = 0.0001;

const noiseCache = new WeakMap<BaseAudioContext, Partial<Record<NoiseColor, AudioBuffer>>>();
const shaperCurves = new Map<number, Float32Array<ArrayBuffer>>();

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/** 2 s mono noise buffer per context and color (looped by sources that need longer). */
export function getNoiseBuffer(ctx: BaseAudioContext, color: NoiseColor): AudioBuffer {
  let entry = noiseCache.get(ctx);
  if (!entry) {
    entry = {};
    noiseCache.set(ctx, entry);
  }
  const cached = entry[color];
  if (cached) return cached;
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * NOISE_SECONDS), ctx.sampleRate);
  fillNoise(buffer.getChannelData(0), color);
  entry[color] = buffer;
  return buffer;
}

function fillNoise(data: Float32Array, color: NoiseColor): void {
  if (color === "white") {
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  } else if (color === "pink") {
    // Paul Kellet's economy pink filter.
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < data.length; i++) {
      const w = Math.random() * 2 - 1;
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = b0 + b1 + b2 + w * 0.1848;
    }
  } else {
    let last = 0;
    for (let i = 0; i < data.length; i++) {
      last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
      data[i] = last;
    }
  }
  removeDc(data);
  normalizePeak(data, 0.95);
}

export function removeDc(data: Float32Array): void {
  let sum = 0;
  for (let i = 0; i < data.length; i++) sum += data[i];
  const mean = sum / data.length;
  for (let i = 0; i < data.length; i++) data[i] -= mean;
}

export function normalizePeak(data: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) peak = Math.max(peak, Math.abs(data[i]));
  if (peak <= 0) return;
  const k = target / peak;
  for (let i = 0; i < data.length; i++) data[i] *= k;
}

/** Soft-clip (tanh) curve, cached by drive amount. Used for buzz (kazoo, horns, croaks). */
export function softClipCurve(drive: number): Float32Array<ArrayBuffer> {
  const key = Math.round(drive * 100);
  const cached = shaperCurves.get(key);
  if (cached) return cached;
  const n = 1024;
  const curve = new Float32Array(n);
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * drive) / norm;
  }
  shaperCurves.set(key, curve);
  return curve;
}

/**
 * Apply an automation curve to a param. Times are offsets from `t0`; values are multiplied by
 * `scale` (pitch rate for frequency curves). "exp" ramps clamp to a tiny positive floor.
 */
export function applyCurve(param: AudioParam, t0: number, points: ReadonlyArray<CurvePoint>, scale = 1): void {
  if (points.length === 0) return;
  const [firstT, firstV] = points[0];
  param.cancelScheduledValues(t0 + firstT);
  param.setValueAtTime(firstV * scale, t0 + firstT);
  for (let i = 1; i < points.length; i++) {
    const p = points[i];
    const time = t0 + p[0];
    const value = p[1] * scale;
    const kind = p[2] ?? "lin";
    if (kind === "set") param.setValueAtTime(value, time);
    else if (kind === "exp") param.exponentialRampToValueAtTime(Math.max(EXP_FLOOR, Math.abs(value)) * Math.sign(value || 1), time);
    else param.linearRampToValueAtTime(value, time);
  }
}

/** Same curve with every value multiplied by `k` (e.g. an octave-up copy of a pitch curve). */
export function scaleCurve(points: ReadonlyArray<CurvePoint>, k: number): CurvePoint[] {
  return points.map((p): CurvePoint => (p.length === 3 ? [p[0], p[1] * k, p[2]] : [p[0], p[1] * k]));
}

/** Percussive amplitude envelope: linear attack to `peak`, exponential decay, hard zero at the end. */
export function percEnvelope(param: AudioParam, start: number, peak: number, attack: number, decay: number): number {
  const end = start + attack + decay;
  param.setValueAtTime(0, start);
  param.linearRampToValueAtTime(peak, start + attack);
  param.exponentialRampToValueAtTime(EXP_FLOOR, end);
  param.setValueAtTime(0, end);
  return end;
}

/** connect() overloads differ for nodes and params; this picks the right one. */
export function connectTo(node: AudioNode, dest: AudioNode | AudioParam): void {
  if (dest instanceof AudioNode) node.connect(dest);
  else node.connect(dest);
}

/** Route a shared cents signal into a source's detune (oscillators and buffer sources only). */
export function bendSource(bus: AudioNode, src: AudioScheduledSourceNode): void {
  if (!(src instanceof OscillatorNode || src instanceof AudioBufferSourceNode)) return;
  const detune = src.detune;
  bus.connect(detune);
  // A fan-out connection into a finished node's param would otherwise outlive the node.
  src.addEventListener("ended", () => safeDisconnect(bus, detune), { once: true });
}

/** disconnect(dest) throws when the connection is already gone; that is fine here. */
export function safeDisconnect(node: AudioNode, dest?: AudioNode | AudioParam): void {
  try {
    if (dest instanceof AudioParam) node.disconnect(dest);
    else if (dest) node.disconnect(dest);
    else node.disconnect();
  } catch {
    // Already disconnected.
  }
}

/** Disconnect a chain when its driving source ends, so finished voices free their nodes promptly. */
export function disconnectOnEnd(source: AudioScheduledSourceNode, ...nodes: AudioNode[]): void {
  source.onended = () => {
    source.disconnect();
    for (const node of nodes) node.disconnect();
  };
}

/**
 * Builder for one synthesized sound (an SFX voice or a character voice). Recipes create nodes
 * through it so the voice knows every scheduled source (for stealing) and its end time.
 * All time arguments are offsets in seconds from `t`.
 */
export class Synth {
  readonly sources: AudioScheduledSourceNode[] = [];
  private end: number;
  private lastSource: AudioScheduledSourceNode | null = null;

  constructor(
    readonly ctx: BaseAudioContext,
    /** Voice input: every recipe chain ends here. */
    readonly out: AudioNode,
    /** Absolute start time (context seconds). */
    readonly t: number,
    /** Pitch multiplier (PlayOptions.pitch × random variation). */
    readonly rate = 1,
    /** Optional cents signal summed into every source's detune (the engine's slow-mo bend). */
    readonly detuneBus: AudioNode | null = null,
  ) {
    this.end = t;
  }

  /** Absolute time when the last scheduled source stops. */
  get endTime(): number {
    return this.end;
  }

  /** Source whose `ended` marks the end of the whole voice. */
  get finalSource(): AudioScheduledSourceNode | null {
    return this.lastSource;
  }

  /** Gain node into `dest`; a param destination makes it a modulation depth (LFO → param). */
  gain(value: number, dest: AudioNode | AudioParam = this.out): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    connectTo(g, dest);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    return f;
  }

  shaper(drive: number, dest: AudioNode): WaveShaperNode {
    const s = this.ctx.createWaveShaper();
    s.curve = softClipCurve(drive);
    s.oversample = "2x";
    s.connect(dest);
    return s;
  }

  osc(type: OscillatorType, freq: number, start: number, stop: number, dest: AudioNode): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq * this.rate;
    o.connect(dest);
    this.schedule(o, start, stop);
    return o;
  }

  noise(color: NoiseColor, start: number, stop: number, dest: AudioNode, playbackRate = 1): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    const buffer = getNoiseBuffer(this.ctx, color);
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = playbackRate;
    src.connect(dest);
    this.schedule(src, start, stop, Math.random() * buffer.duration * 0.9);
    return src;
  }

  /** Sine LFO added onto `param` with an optional depth curve (absolute units of the param). */
  lfo(rateHz: number, depth: number, param: AudioParam, start: number, stop: number, depthCurve?: ReadonlyArray<CurvePoint>): GainNode {
    const depthGain = this.ctx.createGain();
    depthGain.gain.value = depth;
    if (depthCurve) applyCurve(depthGain.gain, this.t, depthCurve);
    depthGain.connect(param);
    const o = this.ctx.createOscillator();
    o.frequency.value = rateHz;
    o.connect(depthGain);
    this.schedule(o, start, stop);
    return depthGain;
  }

  /** Amplitude tremolo node: route a chain through the returned gain (depth 0..1). */
  tremolo(rateHz: number, depth: number, start: number, stop: number, dest: AudioNode): GainNode {
    const g = this.gain(1 - depth / 2, dest);
    this.lfo(rateHz, depth / 2, g.gain, start, stop);
    return g;
  }

  curve(param: AudioParam, points: ReadonlyArray<CurvePoint>, scale = 1): void {
    applyCurve(param, this.t, points, scale);
  }

  /** Frequency curve scaled by the voice's pitch rate. */
  freq(param: AudioParam, points: ReadonlyArray<CurvePoint>): void {
    applyCurve(param, this.t, points, this.rate);
  }

  perc(param: AudioParam, start: number, peak: number, attack: number, decay: number): void {
    percEnvelope(param, this.t + start, peak, attack, decay);
  }

  private schedule(src: AudioScheduledSourceNode, start: number, stop: number, offset?: number): void {
    const at = this.t + start;
    const until = this.t + Math.max(stop, start + 0.005);
    if (offset !== undefined && src instanceof AudioBufferSourceNode) src.start(at, offset);
    else src.start(at);
    src.stop(until);
    if (this.detuneBus) bendSource(this.detuneBus, src);
    this.sources.push(src);
    if (until >= this.end) {
      this.end = until;
      this.lastSource = src;
    }
  }
}
