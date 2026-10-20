// Synth instruments for the procedural music. Every note builds a few nodes, schedules itself and
// disconnects everything once its sources end (no leaks). Noise and vinyl-crackle buffers are made once.
//
// Upright bass, vibraphone, Rhodes (2-op FM), tango piano, bandoneon (free-reed saws), big-band brass,
// brushes, ride, foot hi-hat, feathered kick, stage snare, crash, swells, timpani, the heartbeat thump,
// the tango "chicharra" violin scrape and the smoky vinyl crackle bed.

import { mtof } from "./theory";

const EPS = 0.0001;
const rand = (a: number, b: number): number => a + Math.random() * (b - a);

export class Inst {
  readonly ctx: AudioContext;
  private readonly noiseBuf: AudioBuffer;
  private crackleBuf: AudioBuffer | null = null;
  private readonly live = new Set<AudioScheduledSourceNode>();

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
    const len = Math.floor(ctx.sampleRate * 2);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  /** Stop every sounding note (Music.dispose). */
  stopAll(): void {
    for (const s of this.live) {
      try {
        s.stop();
      } catch {
        /* not started / already stopped */
      }
    }
    this.live.clear();
  }

  // ---- plumbing ------------------------------------------------------------------------------------------

  /** Track sources, stop them at `stopAt`, and disconnect the voice's nodes once all sources ended. */
  private finish(srcs: AudioScheduledSourceNode[], nodes: AudioNode[], stopAt: number): void {
    let left = srcs.length;
    for (const s of srcs) {
      this.live.add(s);
      s.onended = () => {
        this.live.delete(s);
        try {
          s.disconnect();
        } catch {
          /* gone */
        }
        if (--left === 0) for (const n of nodes) n.disconnect();
      };
      s.stop(stopAt);
    }
  }

  osc(type: OscillatorType, freq: number, t: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, freq), t);
    o.start(t);
    return o;
  }

  noise(t: number, rate = 1): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, Math.random() * 1.5);
    return s;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  gain(v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /** Percussive envelope: quick attack to `peak`, exponential decay to silence by t + dur. */
  private perc(g: GainNode, t: number, peak: number, dur: number, attack = 0.003): void {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(Math.max(EPS * 2, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(EPS, t + Math.max(attack + 0.01, dur));
  }

  // ---- pitched -----------------------------------------------------------------------------------------

  /** Upright bass: sine + lowpassed triangle "wood" + a finger thump, plucky envelope. */
  bass(t: number, midi: number, vel: number, dur: number, dest: AudioNode): void {
    const f = mtof(midi);
    vel *= 0.45;
    const o1 = this.osc("sine", f, t);
    const o2 = this.osc("triangle", f, t);
    const lp = this.filter("lowpass", 900, 1.2);
    lp.frequency.setValueAtTime(1200, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.18);
    const g2 = this.gain(0.55);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.008);
    env.gain.exponentialRampToValueAtTime(vel * 0.4, t + 0.12);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.08);
    o1.connect(env);
    o2.connect(lp).connect(g2).connect(env);
    // Finger thump.
    const n = this.noise(t, 0.5);
    const nlp = this.filter("lowpass", 500, 1);
    const ng = this.gain();
    this.perc(ng, t, vel * 0.35, 0.04, 0.002);
    n.connect(nlp).connect(ng).connect(dest);
    env.connect(dest);
    this.finish([o1, o2, n], [lp, g2, env, nlp, ng], t + dur + 0.1);
  }

  /** Vibraphone bar: sine + bright 4th-partial strike. Tremolo comes from the vibes bus (shared motor). */
  vibe(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    vel *= 1.2;
    const f = mtof(midi);
    const o = this.osc("sine", f, t);
    const o4 = this.osc("sine", f * 4, t);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.003);
    env.gain.exponentialRampToValueAtTime(vel * 0.45, t + 0.25);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur);
    const strike = this.gain();
    this.perc(strike, t, vel * 0.22, 0.12, 0.002);
    o.connect(env).connect(dest);
    o4.connect(strike).connect(dest);
    this.finish([o, o4], [env, strike], t + dur + 0.02);
  }

  /** Rhodes electric piano: 2-op FM with a decaying index (the "bark") and a tiny tine ping. */
  rhodes(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    vel *= 0.8;
    const f = mtof(midi);
    const car = this.osc("sine", f, t);
    const mod = this.osc("sine", f, t);
    const idx = this.gain();
    idx.gain.setValueAtTime(f * (0.9 + vel * 4), t);
    idx.gain.exponentialRampToValueAtTime(f * 0.18, t + 0.3);
    mod.connect(idx).connect(car.frequency);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.005);
    env.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.35);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur);
    const tine = this.osc("sine", f * 7.02, t);
    const tg = this.gain();
    this.perc(tg, t, vel * 0.08, 0.07, 0.001);
    car.connect(env).connect(dest);
    tine.connect(tg).connect(dest);
    this.finish([car, mod, tine], [idx, env, tg], t + dur + 0.02);
  }

  /** Tango piano stab: triangle + saw through a fast-closing lowpass. */
  piano(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    vel *= 0.32;
    const f = mtof(midi);
    const o1 = this.osc("triangle", f, t);
    const o2 = this.osc("sawtooth", f * 1.002, t);
    const lp = this.filter("lowpass", 3200, 0.8);
    lp.frequency.setValueAtTime(3600, t);
    lp.frequency.exponentialRampToValueAtTime(700, t + 0.16);
    const g2 = this.gain(0.35);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.002);
    env.gain.exponentialRampToValueAtTime(vel * 0.3, t + 0.1);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur);
    o1.connect(lp);
    o2.connect(g2).connect(lp);
    lp.connect(env).connect(dest);
    this.finish([o1, o2], [lp, g2, env], t + dur + 0.02);
  }

  /** Bandoneon: two detuned reed saws + an octave reed, nasal formant; `swell` = bellows crescendo. */
  bandoneon(t: number, midi: number, dur: number, vel: number, dest: AudioNode, swell = false): void {
    vel *= 0.075;
    const f = mtof(midi);
    const o1 = this.osc("sawtooth", f, t);
    o1.detune.value = -7;
    const o2 = this.osc("sawtooth", f, t);
    o2.detune.value = 7;
    const o3 = this.osc("square", f * 2, t);
    const g3 = this.gain(0.18);
    const hp = this.filter("highpass", 220, 0.7);
    const pk = this.filter("peaking", 1150, 1.6);
    pk.gain.value = 7;
    const lp = this.filter("lowpass", 2700, 0.7);
    const env = this.gain();
    const end = t + dur;
    env.gain.setValueAtTime(0, t);
    if (swell) {
      env.gain.linearRampToValueAtTime(vel * 0.3, t + 0.06);
      env.gain.linearRampToValueAtTime(vel, end - 0.06);
    } else {
      env.gain.linearRampToValueAtTime(vel, t + 0.035);
      env.gain.setValueAtTime(vel * 0.85, end - 0.05);
    }
    env.gain.linearRampToValueAtTime(0, end);
    o1.connect(hp);
    o2.connect(hp);
    o3.connect(g3).connect(hp);
    hp.connect(pk).connect(lp).connect(env).connect(dest);
    this.finish([o1, o2, o3], [g3, hp, pk, lp, env], end + 0.02);
  }

  /** Big-band brass note: saws through a lowpass that blats open; optional scoop up and fall-off. */
  brass(t: number, midi: number, dur: number, vel: number, dest: AudioNode, o: { scoop?: boolean; fall?: boolean } = {}): void {
    vel *= 0.085;
    const f = mtof(midi);
    const o1 = this.osc("sawtooth", f, t);
    const o2 = this.osc("sawtooth", f, t);
    o2.detune.value = 8;
    const end = t + dur;
    for (const p of [o1.frequency, o2.frequency]) {
      if (o.scoop) {
        p.setValueAtTime(f * 0.94, t);
        p.exponentialRampToValueAtTime(f, t + 0.06);
      }
      if (o.fall) {
        p.setValueAtTime(f, end - dur * 0.3);
        p.exponentialRampToValueAtTime(f * 0.6, end);
      }
    }
    const lp = this.filter("lowpass", 400, 1.5);
    lp.frequency.setValueAtTime(380, t);
    lp.frequency.exponentialRampToValueAtTime(3200, t + 0.045);
    lp.frequency.exponentialRampToValueAtTime(1500, t + Math.min(0.3, dur * 0.6));
    if (o.fall) lp.frequency.exponentialRampToValueAtTime(500, end);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.025);
    env.gain.setValueAtTime(vel * 0.8, end - Math.min(0.05, dur * 0.3));
    env.gain.linearRampToValueAtTime(0, end);
    const mix = this.gain(0.5);
    o1.connect(mix);
    o2.connect(mix);
    mix.connect(lp).connect(env).connect(dest);
    this.finish([o1, o2], [mix, lp, env], end + 0.02);
  }

  // ---- drums ---------------------------------------------------------------------------------------------

  /** Brush: a soft circular swish (long) or a slap (short). */
  brush(t: number, vel: number, dur: number, swish: boolean, dest: AudioNode): void {
    const n = this.noise(t);
    const bp = this.filter("bandpass", swish ? 3200 : 2300, swish ? 0.6 : 0.9);
    const g = this.gain();
    if (swish) {
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(vel, t + dur * 0.45);
      g.gain.linearRampToValueAtTime(0, t + dur);
    } else this.perc(g, t, vel * 1.5, dur, 0.004);
    n.connect(bp).connect(g).connect(dest);
    this.finish([n], [bp, g], t + dur + 0.01);
  }

  /** Ride cymbal "ding": highpassed noise + a faint metallic ping. */
  ride(t: number, vel: number, dest: AudioNode): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", 6500);
    const g = this.gain();
    this.perc(g, t, vel, 0.32, 0.002);
    const o = this.osc("sine", 4100 * rand(0.99, 1.01), t);
    const go = this.gain();
    this.perc(go, t, vel * 0.25, 0.25, 0.002);
    n.connect(hp).connect(g).connect(dest);
    o.connect(go).connect(dest);
    this.finish([n, o], [hp, g, go], t + 0.34);
  }

  /** Closed / foot hi-hat "chick". */
  hat(t: number, vel: number, dest: AudioNode, open = false): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", open ? 6500 : 7800);
    const bp = this.filter("peaking", 10000, 1);
    bp.gain.value = 4;
    const g = this.gain();
    this.perc(g, t, vel, open ? 0.22 : 0.045, 0.001);
    n.connect(hp).connect(bp).connect(g).connect(dest);
    this.finish([n], [hp, bp, g], t + (open ? 0.24 : 0.06));
  }

  /** Soft kick (feathered on jazz beats, punchier in the stings). */
  kick(t: number, vel: number, dest: AudioNode): void {
    const o = this.osc("sine", 120, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.1);
    const g = this.gain();
    this.perc(g, t, vel, 0.22, 0.004);
    o.connect(g).connect(dest);
    this.finish([o], [g], t + 0.24);
  }

  /** Stage snare: noise rattle + a tonal body. */
  snare(t: number, vel: number, dest: AudioNode): void {
    const n = this.noise(t);
    const bp = this.filter("bandpass", 2300, 0.8);
    const g = this.gain();
    this.perc(g, t, vel, 0.09, 0.0015);
    const o = this.osc("triangle", 190, t);
    o.frequency.exponentialRampToValueAtTime(150, t + 0.05);
    const go = this.gain();
    this.perc(go, t, vel * 0.5, 0.06, 0.001);
    n.connect(bp).connect(g).connect(dest);
    o.connect(go).connect(dest);
    this.finish([n, o], [bp, g, go], t + 0.1);
  }

  /**
   * Snare roll over [t, t + dur]: one noise source chopped by a fast inverted-saw LFO (sharp hit + decay
   * per stroke), level ramping from a to b. Far cheaper than one voice per stroke.
   */
  roll(t: number, dur: number, rate: number, a: number, b: number, dest: AudioNode): void {
    const n = this.noise(t);
    const bp = this.filter("bandpass", 2200, 0.8);
    const chop = this.gain(0.5);
    const lfo = this.osc("sawtooth", rate, t);
    const depth = this.gain(-0.5);
    lfo.connect(depth).connect(chop.gain);
    const body = this.osc("triangle", 180, t);
    const bg = this.gain(0.25);
    const env = this.gain();
    env.gain.setValueAtTime(Math.max(EPS, a), t);
    env.gain.linearRampToValueAtTime(Math.max(EPS, b), t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.015);
    n.connect(bp).connect(chop);
    body.connect(bg).connect(chop);
    chop.connect(env).connect(dest);
    this.finish([n, lfo, body], [bp, chop, depth, bg, env], t + dur + 0.02);
  }

  crash(t: number, vel: number, dur: number, dest: AudioNode): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", 4200);
    const g = this.gain();
    this.perc(g, t, vel, dur, 0.003);
    n.connect(hp).connect(g).connect(dest);
    this.finish([n], [hp, g], t + dur + 0.02);
  }

  /** Cymbal swell from level a to b across dur. */
  swell(t: number, dur: number, a: number, b: number, dest: AudioNode): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", 5500);
    const g = this.gain();
    g.gain.setValueAtTime(Math.max(EPS, a), t);
    g.gain.exponentialRampToValueAtTime(Math.max(EPS * 2, b), t + dur);
    g.gain.linearRampToValueAtTime(0, t + dur + 0.02);
    n.connect(hp).connect(g).connect(dest);
    this.finish([n], [hp, g], t + dur + 0.03);
  }

  /** Timpani: pitched sine + triangle with a slight drop, plus a mallet thud. */
  timpani(t: number, midi: number, vel: number, dur: number, dest: AudioNode): void {
    vel *= 0.7;
    const f = mtof(midi);
    const o = this.osc("sine", f * 1.04, t);
    o.frequency.exponentialRampToValueAtTime(f, t + 0.08);
    const tri = this.osc("triangle", f * 2, t);
    const gt = this.gain(0.35);
    const g = this.gain();
    this.perc(g, t, vel, dur, 0.004);
    const n = this.noise(t);
    const lp = this.filter("lowpass", 500);
    const gn = this.gain();
    this.perc(gn, t, vel * 0.5, 0.08, 0.002);
    o.connect(g);
    tri.connect(gt).connect(g);
    n.connect(lp).connect(gn).connect(dest);
    g.connect(dest);
    this.finish([o, tri, n], [gt, g, lp, gn], t + dur + 0.02);
  }

  /** Heartbeat thump (lub or dub) with a triangle overtone so laptop speakers can hear it. */
  thump(t: number, freq: number, vel: number, dest: AudioNode): void {
    vel *= 0.5;
    const o = this.osc("sine", freq * 1.7, t);
    o.frequency.exponentialRampToValueAtTime(freq, t + 0.06);
    const tri = this.osc("triangle", freq * 2, t);
    const lp = this.filter("lowpass", 260);
    const gt = this.gain(0.6);
    const g = this.gain();
    this.perc(g, t, vel, 0.24, 0.005);
    o.connect(g);
    tri.connect(lp).connect(gt).connect(g);
    g.connect(dest);
    this.finish([o, tri], [lp, gt, g], t + 0.26);
  }

  /** Tango "golpe": a knock on the instrument body. */
  knock(t: number, vel: number, dest: AudioNode): void {
    const o = this.osc("sine", 210, t);
    o.frequency.exponentialRampToValueAtTime(120, t + 0.05);
    const g = this.gain();
    this.perc(g, t, vel, 0.09, 0.001);
    const n = this.noise(t);
    const bp = this.filter("bandpass", 900, 2);
    const gn = this.gain();
    this.perc(gn, t, vel * 0.6, 0.03, 0.0008);
    o.connect(g).connect(dest);
    n.connect(bp).connect(gn).connect(dest);
    this.finish([o, n], [g, bp, gn], t + 0.1);
  }

  /** Tango "chicharra": the violin bow scraped behind the bridge — a gritty, buzzing rasp. */
  chicharra(t: number, dur: number, vel: number, dest: AudioNode): void {
    const n = this.noise(t);
    const bp = this.filter("bandpass", 2600, 2.5);
    const am = this.gain(0.5);
    const lfo = this.osc("sawtooth", 55, t);
    const depth = this.gain(0.5);
    lfo.connect(depth).connect(am.gain);
    const g = this.gain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.02);
    g.gain.linearRampToValueAtTime(vel * 0.6, t + dur * 0.7);
    g.gain.linearRampToValueAtTime(0, t + dur);
    n.connect(bp).connect(am).connect(g).connect(dest);
    this.finish([n, lfo], [bp, am, depth, g], t + dur + 0.02);
  }

  /**
   * Looping vinyl crackle + faint hiss (the smoky record-player bed). Returns a stop function; the caller
   * owns its lifetime.
   */
  crackleBed(t: number, vel: number, dest: AudioNode): () => void {
    if (!this.crackleBuf) this.crackleBuf = makeCrackle(this.ctx);
    const s = this.ctx.createBufferSource();
    s.buffer = this.crackleBuf;
    s.loop = true;
    const g = this.gain(vel);
    const hp = this.filter("highpass", 900, 0.5);
    s.connect(hp).connect(g).connect(dest);
    s.start(t);
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      try {
        s.stop();
      } catch {
        /* never started */
      }
      s.disconnect();
      hp.disconnect();
      g.disconnect();
    };
  }
}

/** 5 s of sparse vinyl pops and ticks over a whisper of hiss. */
function makeCrackle(ctx: AudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * 5);
  const buf = ctx.createBuffer(1, len, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.012;
  const pops = 140;
  for (let k = 0; k < pops; k++) {
    const at = Math.floor(Math.random() * (len - 200));
    const amp = Math.random() < 0.12 ? rand(0.5, 0.9) : rand(0.08, 0.3);
    const n = 6 + Math.floor(Math.random() * 30);
    for (let j = 0; j < n; j++) d[at + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / (n * 0.3));
  }
  return buf;
}
