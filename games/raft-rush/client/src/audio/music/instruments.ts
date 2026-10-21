// The island band: Karplus-Strong ukulele, kazoo (buzz + formants + vibrato), xylophone, plucky bass and light
// percussion — copied from games/bonk-brawl/client/src/audio/music/instruments.ts — plus Raft Rush additions: a
// steel pan (the beach-bar lead), low jungle toms and a hand-drum slap (the dusk / night drums). Each Band owns
// its mixing buses; notes are scheduled at absolute context times and build their nodes on the fly.
// Owner: client-fx-audio.

import { WOOD_PARTIALS, click, noiseBurst, struck, thump, vibrato, type Formant, type Partial } from "../synth/blocks";
import { Synth, midiToFreq, safeDisconnect, type CurvePoint } from "../synth/dsp";
import { getPluck } from "./pluck";

export type Part = "uke" | "kazoo" | "xylo" | "pan" | "bass" | "drums" | "toms";

/** Mix of the band (tuned with the dev/audio.html renders). */
const PART_LEVEL: Readonly<Record<Part, number>> = {
  uke: 0.72,
  kazoo: 0.3,
  xylo: 0.4,
  pan: 0.42,
  bass: 0.6,
  drums: 0.55,
  toms: 0.7,
};

/** Kazoo "oo" hum resonances plus the membrane's nasal buzz band. */
const KAZOO_FORMANTS: ReadonlyArray<Formant> = [
  [650, 3, 1.3],
  [1300, 4, 0.8],
  [2700, 5, 0.4],
];

/** Xylophone bars are tuned so the first overtone sits at 3× (a bright, woody plink). */
const XYLO_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [3, 0.32, 0.3],
  [6.2, 0.08, 0.12],
];

/** Steel pan: near-harmonic octave + twelfth partials, the octave ringing almost as long as the note. */
const PAN_PARTIALS: ReadonlyArray<Partial> = [
  [1, 1, 1],
  [2, 0.55, 0.8],
  [3.01, 0.22, 0.45],
  [4.02, 0.08, 0.25],
];

export interface KazooOptions {
  /** Glide in from this MIDI note instead of the hummed scoop. */
  glideFrom?: number;
  /** Swell time (s): long swells give the sad-trombone "wah". */
  attack?: number;
  /** Vibrato depth in cents (default 20; only on notes long enough to hear it). */
  vibratoCents?: number;
  vibratoHz?: number;
  /** Pitch droop at the end of the note, in semitones (sad endings). */
  droop?: number;
}

export class Band {
  private readonly mix: GainNode;
  private readonly buses: Record<Part, GainNode>;
  private readonly kazooIn: GainNode;
  private readonly owned: AudioNode[] = [];

  constructor(
    readonly ctx: BaseAudioContext,
    out: AudioNode,
  ) {
    this.mix = this.node(ctx.createGain(), out);
    this.buses = {
      uke: this.ukeBody(),
      kazoo: this.part("kazoo"),
      xylo: this.part("xylo"),
      pan: this.part("pan"),
      bass: this.part("bass"),
      drums: this.part("drums"),
      toms: this.part("toms"),
    };
    this.kazooIn = this.kazooChain();
  }

  /** Strum a ukulele voicing (strings G C E A). Up-strums skip the low-reentrant G string. */
  strum(at: number, voicing: readonly number[], dir: "down" | "up", vel: number, hold: number, spread: number): void {
    const order = dir === "down" ? voicing : voicing.slice(1).reverse();
    order.forEach((midi, i) => {
      const accent = dir === "down" ? 1 - i * 0.06 : 0.8 - i * 0.06;
      this.pluck(at + i * spread * (0.85 + Math.random() * 0.3), midi, vel * accent, hold - i * spread);
    });
  }

  /** One plucked string, muted (fast release) after `hold` seconds. */
  pluck(at: number, midi: number, vel: number, hold: number): void {
    const { buffer, rate } = getPluck(this.ctx, midi);
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    const end = Math.min(at + Math.max(0.06, hold), at + buffer.duration / rate);
    g.gain.setValueAtTime(vel, at);
    g.gain.setValueAtTime(vel, end);
    g.gain.linearRampToValueAtTime(0, end + 0.05);
    src.connect(g).connect(this.buses.uke);
    src.start(at);
    src.stop(end + 0.06);
    src.addEventListener("ended", () => safeDisconnect(g), { once: true });
  }

  kazoo(at: number, midi: number, dur: number, vel: number, o: KazooOptions = {}): void {
    const s = new Synth(this.ctx, this.kazooIn, at);
    const f = midiToFreq(midi);
    const env = s.gain(0);
    const osc = s.osc("sawtooth", f, 0, dur + 0.1, env);
    const glide = o.glideFrom !== undefined;
    const pitch: CurvePoint[] = [
      [0, glide ? midiToFreq(o.glideFrom ?? midi) : f * 0.94],
      [glide ? 0.07 : 0.035, f, "exp"],
    ];
    if (o.droop) pitch.push([Math.max(0.08, dur * 0.6), f, "exp"], [dur + 0.05, f * 2 ** (-o.droop / 12), "exp"]);
    s.freq(osc.frequency, pitch);
    if (dur > 0.22) vibrato(s, osc, 0, dur + 0.1, o.vibratoHz ?? 5.6, o.vibratoCents ?? 20, Math.min(0.15, dur * 0.3));
    const attack = Math.min(o.attack ?? 0.025, dur * 0.6);
    const hold = Math.max(attack + 0.02, dur - 0.04);
    s.curve(env.gain, [
      [0, 0],
      [attack, vel],
      [Math.min(hold, attack + 0.08), vel * 0.85],
      [hold, vel * 0.75],
      [dur + 0.06, 0.0001, "exp"],
    ]);
  }

  xylo(at: number, midi: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.xylo, at);
    struck(s, 0, midiToFreq(midi), 0.5, 0.5 * vel, XYLO_PARTIALS);
    click(s, 0, 0.06 * vel, 5200);
  }

  /** Steel pan note: a soft mallet "ping" with a quick pitch settle and a long shimmering octave. */
  pan(at: number, midi: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.pan, at);
    const f = midiToFreq(midi);
    for (const [ratio, gain, decay] of PAN_PARTIALS) {
      const g = s.gain(0);
      const o = s.osc("sine", f * ratio * 1.012, 0, 0.9 * decay + 0.05, g);
      s.freq(o.frequency, [
        [0, f * ratio * 1.012],
        [0.03, f * ratio, "exp"],
      ]);
      s.perc(g.gain, 0, 0.42 * vel * gain, 0.004, 0.9 * decay);
    }
    noiseBurst(s, 0, 0.02, 0.05 * vel, { type: "bandpass", from: 2400, q: 1.5 });
  }

  /** Round plucky bass: a sawtooth with a closing filter ("bwop") over a sine sub. */
  bass(at: number, midi: number, dur: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.bass, at);
    const f = midiToFreq(midi);
    const env = s.gain(0);
    const lp = s.filter("lowpass", f * 10, 2.5, env);
    s.osc("sawtooth", f, 0, dur + 0.1, lp);
    s.osc("sine", f, 0, dur + 0.1, s.gain(0.9, env));
    s.curve(lp.frequency, [
      [0, f * 12],
      [0.14, f * 2.2, "exp"],
    ]);
    const hold = Math.max(0.16, dur - 0.03);
    s.curve(env.gain, [
      [0, 0],
      [0.006, vel],
      [0.15, vel * 0.62],
      [hold, vel * 0.45],
      [dur + 0.07, 0.0001, "exp"],
    ]);
  }

  kick(at: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.drums, at);
    thump(s, 0, 150, 46, 0.24, 0.95 * vel);
    click(s, 0, 0.12 * vel, 1600);
  }

  snare(at: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.drums, at);
    noiseBurst(s, 0, 0.13, 0.5 * vel, { type: "bandpass", from: 2600, to: 1500, q: 0.8 });
    thump(s, 0, 230, 170, 0.07, 0.3 * vel);
  }

  shaker(at: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.drums, at);
    noiseBurst(s, 0, 0.055, 0.32 * vel, { type: "highpass", from: 6500, q: 0.7, attack: 0.014 });
  }

  hat(at: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.drums, at);
    noiseBurst(s, 0, 0.03, 0.28 * vel, { type: "highpass", from: 8500, q: 0.7 });
  }

  block(at: number, high: boolean, vel: number): void {
    const s = new Synth(this.ctx, this.buses.drums, at);
    struck(s, 0, high ? 1250 : 860, 0.07, 0.5 * vel, WOOD_PARTIALS);
  }

  crash(at: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.drums, at);
    noiseBurst(s, 0, 1.3, 0.32 * vel, { type: "highpass", from: 5200, to: 3200, q: 0.5, attack: 0.003 });
    noiseBurst(s, 0, 0.6, 0.18 * vel, { type: "bandpass", from: 9000, to: 6000, q: 1.5 });
  }

  /** Low jungle tom ("dum"): a pitched sine thump with a skin rattle. `pitch` 0 = lowest, 1 = high tom. */
  tom(at: number, pitch: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.toms, at);
    const f0 = 95 + 85 * pitch;
    thump(s, 0, f0 * 1.5, f0, 0.38 - 0.12 * pitch, 0.9 * vel);
    noiseBurst(s, 0, 0.09, 0.16 * vel, { type: "bandpass", from: 420 + 300 * pitch, to: 220, q: 1.2, color: "pink" });
    click(s, 0, 0.06 * vel, 900);
  }

  /** Open-hand slap on a goatskin drum ("pak"). */
  slap(at: number, vel: number): void {
    const s = new Synth(this.ctx, this.buses.toms, at);
    noiseBurst(s, 0, 0.07, 0.55 * vel, { type: "bandpass", from: 1700, to: 900, q: 1.1 });
    thump(s, 0, 320, 210, 0.06, 0.35 * vel);
  }

  /** Disconnect the band's persistent buses (call after its last note has rung out). */
  dispose(): void {
    for (const n of this.owned) safeDisconnect(n);
  }

  private node<T extends AudioNode>(n: T, dest: AudioNode): T {
    n.connect(dest);
    this.owned.push(n);
    return n;
  }

  private part(p: Part): GainNode {
    const g = this.node(this.ctx.createGain(), this.mix);
    g.gain.value = PART_LEVEL[p];
    return g;
  }

  /** A little wooden body: warm low-mid bump, softened top. */
  private ukeBody(): GainNode {
    const ctx = this.ctx;
    const shelf = this.node(ctx.createBiquadFilter(), this.part("uke"));
    shelf.type = "highshelf";
    shelf.frequency.value = 3500;
    shelf.gain.value = -5;
    const body = this.node(ctx.createBiquadFilter(), shelf);
    body.type = "peaking";
    body.frequency.value = 320;
    body.Q.value = 1.1;
    body.gain.value = 4;
    return this.node(ctx.createGain(), body);
  }

  /** Shared kazoo resonator: soft-clip buzz → formant band-passes → tone control. */
  private kazooChain(): GainNode {
    const ctx = this.ctx;
    const bus = this.buses.kazoo;
    const lp = this.node(ctx.createBiquadFilter(), bus);
    lp.type = "lowpass";
    lp.frequency.value = 4200;
    lp.Q.value = 0.7;
    const hp = this.node(ctx.createBiquadFilter(), lp);
    hp.type = "highpass";
    hp.frequency.value = 170;
    hp.Q.value = 0.7;
    const fan = ctx.createGain();
    this.owned.push(fan);
    for (const [freq, q, gain] of KAZOO_FORMANTS) {
      const band = this.node(ctx.createBiquadFilter(), this.node(gainNode(ctx, gain), hp));
      band.type = "bandpass";
      band.frequency.value = freq;
      band.Q.value = q;
      fan.connect(band);
    }
    const shaper = this.node(ctx.createWaveShaper(), fan);
    shaper.curve = buzzCurve();
    shaper.oversample = "2x";
    const input = this.node(ctx.createGain(), shaper);
    // A little of the dry hum keeps the fundamental under the buzz.
    input.connect(this.node(gainNode(ctx, 0.12), hp));
    return input;
  }
}

function gainNode(ctx: BaseAudioContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

let buzz: Float32Array<ArrayBuffer> | null = null;

/** Asymmetric soft clip: the even harmonics give the kazoo membrane its nasal rasp. */
function buzzCurve(): Float32Array<ArrayBuffer> {
  if (buzz) return buzz;
  const n = 1024;
  const curve = new Float32Array(n);
  const drive = 2.6;
  const norm = Math.tanh(drive);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const y = Math.tanh(drive * (x + 0.18 * x * x)) / norm;
    curve[i] = Math.max(-1, Math.min(1, y));
  }
  buzz = curve;
  return curve;
}
