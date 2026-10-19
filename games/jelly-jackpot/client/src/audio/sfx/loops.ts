// Continuous loops: the wind howl (Wind card) and the cake-stand motor hum (spinning stand). Both are built
// lazily on first use, glide smoothly between levels, and fully stop their sources a while after going silent.

import { Kit } from "./kit";

const OFF_AFTER = 1.5;

abstract class Loop {
  protected nodes: AudioNode[] = [];
  protected sources: AudioScheduledSourceNode[] = [];
  protected out: GainNode | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(protected kit: Kit) {}

  protected abstract build(out: GainNode): void;

  protected ensure(): GainNode {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.out) return this.out;
    const out = this.kit.ctx.createGain();
    out.gain.value = 0.0001;
    out.connect(this.kit.out);
    this.out = out;
    this.build(out);
    for (const s of this.sources) s.start();
    return out;
  }

  protected fadeTo(v: number, tc = 0.25): void {
    if (v <= 0.0005) {
      if (!this.out) return;
      this.out.gain.setTargetAtTime(0, this.kit.now, tc);
      if (!this.stopTimer) this.stopTimer = setTimeout(() => this.teardown(), OFF_AFTER * 1000 + tc * 4000);
      return;
    }
    const out = this.ensure();
    out.gain.setTargetAtTime(v, this.kit.now, tc);
  }

  private teardown(): void {
    this.stopTimer = null;
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* never started */
      }
    }
    for (const n of [...this.nodes, ...(this.out ? [this.out] : [])]) n.disconnect();
    this.sources = [];
    this.nodes = [];
    this.out = null;
  }

  protected node<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  protected osc(type: OscillatorType, f: number): OscillatorNode {
    const o = this.node(this.kit.ctx.createOscillator());
    o.type = type;
    o.frequency.value = f;
    this.sources.push(o);
    return o;
  }

  protected noise(kind: "white" | "pink" | "brown"): AudioBufferSourceNode {
    const s = this.node(this.kit.ctx.createBufferSource());
    s.buffer = this.kit.noiseBuffer(kind);
    s.loop = true;
    this.sources.push(s);
    return s;
  }

  protected filter(type: BiquadFilterType, f: number, Q: number): BiquadFilterNode {
    const b = this.node(this.kit.ctx.createBiquadFilter());
    b.type = type;
    b.frequency.value = f;
    b.Q.value = Q;
    return b;
  }

  protected gain(v: number): GainNode {
    const g = this.node(this.kit.ctx.createGain());
    g.gain.value = v;
    return g;
  }

  /** LFO osc → depth → param. */
  protected lfo(rate: number, depth: number, param: AudioParam, type: OscillatorType = "sine"): void {
    const o = this.osc(type, rate);
    const d = this.gain(depth);
    o.connect(d);
    d.connect(param);
  }
}

/** Ghostly "wooOOOooo" cartoon wind: two resonant bands of noise drifting around, plus a whistly sine. */
export class WindLoop extends Loop {
  private howl: BiquadFilterNode | null = null;

  protected build(out: GainNode): void {
    const n = this.noise("pink");
    const a = this.filter("bandpass", 520, 7);
    const b = this.filter("bandpass", 1150, 10);
    const ga = this.gain(1.4);
    const gb = this.gain(0.7);
    n.connect(a).connect(ga).connect(out);
    n.connect(b).connect(gb).connect(out);
    this.lfo(0.17, 180, a.frequency);
    this.lfo(0.11, 320, b.frequency, "triangle");
    // Swell the loudness slowly so it gusts.
    const gust = this.gain(0.75);
    ga.disconnect();
    ga.connect(gust).connect(out);
    this.lfo(0.23, 0.35, gust.gain);
    // A faint "whistle through the window" tone.
    const w = this.osc("sine", 760);
    const wg = this.gain(0.03);
    w.connect(wg).connect(out);
    this.lfo(0.3, 90, w.frequency);
    this.howl = a;
  }

  set(level: number): void {
    const v = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
    this.fadeTo(v * 0.5, 0.4);
    if (this.howl) this.howl.Q.setTargetAtTime(5 + v * 6, this.kit.now, 0.3);
  }
}

/** Cheap toy motor "whirrr" for the spinning cake stand; pitch follows the spin speed. */
export class HumLoop extends Loop {
  private main: OscillatorNode | null = null;
  private second: OscillatorNode | null = null;
  private lp: BiquadFilterNode | null = null;

  protected build(out: GainNode): void {
    const lp = this.filter("lowpass", 500, 2);
    lp.connect(out);
    const m = this.osc("sawtooth", 60);
    const s = this.osc("square", 120);
    const sg = this.gain(0.3);
    m.connect(lp);
    s.connect(sg).connect(lp);
    // Gear rattle: a little wobble so it sounds like a wonky kitchen gadget.
    this.lfo(9, 3, m.frequency);
    this.lfo(13, 6, s.frequency, "square");
    const brush = this.noise("brown");
    const bg = this.gain(0.25);
    brush.connect(this.filter("bandpass", 300, 2)).connect(bg).connect(out);
    this.main = m;
    this.second = s;
    this.lp = lp;
  }

  set(degPerSec: number): void {
    const d = Number.isFinite(degPerSec) ? Math.abs(degPerSec) : 0;
    if (d < 0.5) {
      this.fadeTo(0, 0.2);
      return;
    }
    const k = Math.min(1, d / 90);
    this.fadeTo(0.05 + k * 0.08, 0.2);
    const f = 45 + d * 0.9;
    const now = this.kit.now;
    this.main?.frequency.setTargetAtTime(f, now, 0.15);
    this.second?.frequency.setTargetAtTime(f * 2.02, now, 0.15);
    this.lp?.frequency.setTargetAtTime(300 + k * 900, now, 0.2);
  }
}
