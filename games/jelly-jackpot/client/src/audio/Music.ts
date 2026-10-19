// Procedural music (no audio files). Owner: client-music. PUBLIC API IS THE CONTRACT.
//
// Everything is synthesized with the Web Audio API and scheduled with a look-ahead scheduler
// (setInterval ~25 ms, schedule notes ~120 ms ahead on ctx.currentTime). It should sound FUNNY and
// cheesy-lounge: a lounge-casino jazz loop with a walking upright bass (sine + soft pluck envelope),
// brushed snare (filtered noise swishes), vibraphone chords (sine + tremolo), and a KAZOO lead
// (sawtooth through a formant-ish bandpass + vibrato) playing a goofy melody, ~110 BPM swing.
//
// Modes (setMode, crossfade ~0.4 s, always change on the next beat):
//  - "lobby":    full lounge band, kazoo melody
//  - "lounge":   between turns: same band, softer, no kazoo
//  - "tension":  during the hover: only a tense ticking hi-hat + a low heartbeat bass thump, pitch slowly rising
//  - "drumroll": during settling: a snare roll crescendo (fast noise bursts) with a cymbal-ish swell
//  - "victory":  matchEnd: a cheesy kazoo + vibes fanfare loop, major key
//  - "silent"
// stinger(kind) plays one-shot musical jingles over the music (does not change mode):
//  - "legendary": slot-machine jackpot arpeggio + bells
//  - "cursed":    ominous church organ chord (detuned saws + low sine) with a sad trombone wah-wah tail
//  - "stand":     short ta-da! (kazoo + vibes)
//  - "topple":    sad trombone "wah wah wah waaah"
//  - "reveal":    dramatic dun-dun-DUNNN
//  - "roleBaker" / "roleSaboteur": a cute ding-ding vs a villain cackle-ish minor sting
//
// Graph: per-mode bus (crossfaded) → duck (dips under stingers) → band master → soft limiter → out.
//        stingers → stinger bus → soft limiter → out. Every voice disconnects itself when it ends.

export type MusicMode = "lobby" | "lounge" | "tension" | "drumroll" | "victory" | "silent";
export type Stinger = "legendary" | "cursed" | "stand" | "topple" | "reveal" | "roleBaker" | "roleSaboteur";

// ---- timing ---------------------------------------------------------------------------------------
const BPM = 110;
const B = 60 / BPM; // one beat in seconds
const SWING = 0.64; // swung offbeat position inside a beat (0.5 = straight, 0.667 = triplet)
const LOOKAHEAD = 0.12; // seconds scheduled ahead while visible
const LOOKAHEAD_HIDDEN = 1.2; // background tabs throttle timers to ~1 Hz
const TICK_MS = 25;

const MODE_LEVEL: Record<MusicMode, number> = {
  lobby: 1,
  lounge: 0.75,
  tension: 0.9,
  drumroll: 1,
  victory: 1,
  silent: 0,
};

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const EPS = 0.0001;

// ---- harmony --------------------------------------------------------------------------------------
type Quality = "maj7" | "7" | "m7" | "6";
interface Chord {
  root: number; // bass register MIDI note
  q: Quality;
}
const IV: Record<Quality, [number, number, number, number]> = {
  maj7: [0, 4, 7, 11],
  "7": [0, 4, 7, 10],
  m7: [0, 3, 7, 10],
  "6": [0, 4, 7, 9],
};
const ch = (root: number, q: Quality): Chord => ({ root, q });
const F = 41, D = 38, G = 43, C = 36, A = 45, Bb = 46;

/** 8-bar lounge progression in F: I - VI7 - ii - V, then turnarounds (iii VI7 | ii V | I VI7 | ii V). */
const LOUNGE: Chord[][] = [
  [ch(F, "maj7")],
  [ch(D, "7")],
  [ch(G, "m7")],
  [ch(C, "7")],
  [ch(A, "m7"), ch(D, "7")],
  [ch(G, "m7"), ch(C, "7")],
  [ch(F, "maj7"), ch(D, "7")],
  [ch(G, "m7"), ch(C, "7")],
];
/** 4-bar victory oom-pah: I - IV - I - V7. */
const VICTORY: Chord[][] = [[ch(F, "6")], [ch(Bb, "6")], [ch(F, "6")], [ch(C, "7")]];

/** Rootless closed vibraphone voicing (3rd, 5th, 7th, 9th) between MIDI 58..69. */
function voicing(c: Chord): number[] {
  const pc = c.root % 12;
  const iv = IV[c.q];
  return [iv[1], iv[2], iv[3], 14]
    .map((i) => 58 + ((((pc + i - 58) % 12) + 12) % 12))
    .sort((a, b) => a - b);
}

/** Move a note `steps` scale degrees down inside F major (for the kazoo choir harmony). */
const F_MAJOR = [5, 7, 9, 10, 0, 2, 4];
function diatonicDown(m: number, steps: number): number {
  let n = m;
  let left = steps;
  while (left > 0) {
    n--;
    if (F_MAJOR.includes(((n % 12) + 12) % 12)) left--;
  }
  return n;
}

// ---- melodies: [eighth 0..7, midi, length in eighths] ------------------------------------------------
type Note = [number, number, number];
const MEL_A: Note[][] = [
  [[0, 72, 1], [1, 74, 1], [2, 76, 1], [3, 77, 3]],
  [[0, 78, 2], [2, 74, 1], [3, 72, 1], [4, 66, 2], [6, 69, 2]],
  [[0, 70, 1], [1, 69, 1], [2, 70, 1], [3, 74, 3], [6, 73, 2]],
  [[0, 72, 2], [2, 70, 1], [3, 67, 1], [4, 64, 4]],
  [[0, 72, 1], [1, 76, 1], [2, 79, 2], [4, 78, 2], [6, 74, 2]],
  [[0, 77, 1], [1, 74, 1], [2, 70, 2], [4, 76, 1], [5, 72, 1], [6, 70, 1], [7, 67, 1]],
  [[0, 69, 3], [3, 72, 1], [4, 66, 1], [5, 69, 1], [6, 72, 1], [7, 75, 1]],
  [[0, 74, 1], [1, 70, 1], [2, 67, 2], [4, 64, 1], [5, 67, 1], [6, 70, 1], [7, 71, 1]],
];
/** "Shave and a haircut... two bits!" ending for the second 8 bars. */
const SHAVE: Note[][] = [
  [[0, 77, 2], [2, 72, 1], [3, 72, 1], [4, 74, 2], [6, 72, 2]],
  [[2, 76, 2], [4, 77, 2]],
];
const MEL_VICTORY: Note[][] = [
  [[0, 72, 1], [1, 72, 1], [2, 72, 1], [3, 77, 5]],
  [[0, 74, 1], [1, 74, 1], [2, 74, 1], [3, 77, 1], [4, 82, 4]],
  [[0, 81, 2], [2, 79, 1], [3, 77, 1], [4, 76, 1], [5, 77, 1], [6, 79, 2]],
  [[0, 76, 2], [2, 72, 2], [4, 79, 1], [5, 76, 1], [6, 72, 2]],
];

interface KazooOpts {
  scoop?: boolean; // start flat and slide up into the note (very kazoo)
  glideTo?: number; // MIDI note to slide to over the note
  wobble?: number; // vibrato depth as a fraction of the frequency
  staccato?: boolean;
}
interface BrassOpts {
  glideTo?: number;
  droop?: boolean; // the last sad note: heavy growing vibrato + pitch sag
}

export class Music {
  private readonly ctx: AudioContext;
  private readonly duck: GainNode;
  private readonly band: GainNode;
  private readonly stingBus: GainNode;
  private readonly limiter: DynamicsCompressorNode;
  private readonly noiseBuf: AudioBuffer;
  private readonly buzzCurve: Float32Array<ArrayBuffer>;

  private bus: GainNode | null = null; // current mode's crossfade bus
  private current: MusicMode = "silent";
  private target: MusicMode = "silent";
  private pending: MusicMode | null = null;
  private modeStart = 0;
  private modeBeat = 0;
  private nextBeat = 0;
  private intensityTarget = 0;
  private intensity = 0;
  private lastBass = F;

  private readonly live = new Set<AudioScheduledSourceNode>();
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  /** `out` is the music bus (AudioEngine owns volume). */
  constructor(ctx: AudioContext, out: AudioNode) {
    this.ctx = ctx;

    // Gentle safety limiter so nothing ever gets harsh, whatever stacks up.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 12;
    this.limiter.ratio.value = 4;
    this.limiter.attack.value = 0.008;
    this.limiter.release.value = 0.25;
    this.limiter.connect(out);

    this.band = ctx.createGain();
    this.band.gain.value = 0.8;
    this.band.connect(this.limiter);
    this.duck = ctx.createGain();
    this.duck.connect(this.band);
    this.stingBus = ctx.createGain();
    this.stingBus.gain.value = 0.85;
    this.stingBus.connect(this.limiter);

    // Shared white noise (brushes, hats, cymbals, snare rolls).
    const len = Math.floor(ctx.sampleRate * 2);
    this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;

    // Soft-clip curve: gives the kazoo its buzzy membrane rasp.
    const n = 1024;
    this.buzzCurve = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      this.buzzCurve[i] = Math.tanh(2.4 * x) / Math.tanh(2.4);
    }

    this.nextBeat = ctx.currentTime + 0.05;
    this.interval = setInterval(this.tick, TICK_MS);
  }

  setMode(mode: MusicMode): void {
    if (this.disposed || mode === this.target) return;
    this.target = mode;
    this.pending = mode === this.current ? null : mode;
  }

  get mode(): MusicMode {
    return this.target;
  }

  stinger(kind: Stinger): void {
    if (this.disposed) return;
    const t = this.ctx.currentTime + 0.03;
    const len = this.playStinger(kind, t);
    // Duck the band under the jingle, then let it swell back.
    const g = this.duck.gain;
    g.cancelScheduledValues(t);
    g.setTargetAtTime(0.35, t, 0.04);
    g.setTargetAtTime(1, t + len, 0.35);
  }

  /** Tension mode intensity 0..1 (timer running out → faster ticks / higher pitch). */
  setIntensity(v: number): void {
    this.intensityTarget = Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    for (const s of this.live) {
      try {
        s.stop();
      } catch {
        /* never started or already stopped */
      }
    }
    this.live.clear();
    this.bus?.disconnect();
    this.bus = null;
    this.duck.disconnect();
    this.band.disconnect();
    this.stingBus.disconnect();
    this.limiter.disconnect();
  }

  // ==== scheduler ====================================================================================

  private readonly tick = (): void => {
    const hidden = typeof document !== "undefined" && document.hidden;
    this.pump(this.ctx.currentTime + (hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD));
  };

  /** Schedule every beat that starts before `horizon` (exposed privately for offline rendering tests). */
  private pump(horizon: number): void {
    if (this.disposed) return;
    const now = this.ctx.currentTime;
    if (this.nextBeat < now - 0.2) this.nextBeat = now + 0.05; // context was suspended / tab throttled
    while (this.nextBeat < horizon) {
      const t = this.nextBeat;
      if (this.pending !== null) {
        this.applyMode(this.pending, t);
        this.pending = null;
      }
      this.intensity += (this.intensityTarget - this.intensity) * 0.5;
      this.playBeat(t);
      this.modeBeat++;
      this.nextBeat += B;
    }
  }

  private applyMode(mode: MusicMode, t: number): void {
    const prev = this.current;
    const old = this.bus;
    if (old) {
      old.gain.cancelScheduledValues(t);
      old.gain.setTargetAtTime(0, t, 0.12);
      this.later(t + 1.5, () => old.disconnect());
    }
    this.current = mode;
    const band = (m: MusicMode): boolean => m === "lobby" || m === "lounge";
    if (!(band(prev) && band(mode))) {
      // Lobby <-> lounge keep the song position; anything else starts its loop fresh.
      this.modeStart = t;
      this.modeBeat = 0;
    }
    if (mode === "silent") {
      this.bus = null;
      return;
    }
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, this.ctx.currentTime);
    g.gain.setTargetAtTime(MODE_LEVEL[mode], t, 0.12);
    g.connect(this.duck);
    this.bus = g;
    if (mode === "victory") this.crash(t, 0.1, 1.8, g);
  }

  private playBeat(t: number): void {
    const bus = this.bus;
    if (!bus) return;
    switch (this.current) {
      case "lobby":
        this.bandBeat(t, bus, true);
        break;
      case "lounge":
        this.bandBeat(t, bus, false);
        break;
      case "tension":
        this.tensionBeat(t, bus);
        break;
      case "drumroll":
        this.drumrollBeat(t, bus);
        break;
      case "victory":
        this.victoryBeat(t, bus);
        break;
      case "silent":
        break;
    }
  }

  /** Time of eighth `e` (0/1) inside the beat starting at t, swung. */
  private static eighth(t: number, e: number): number {
    return e % 2 === 1 ? t + B * SWING : t;
  }

  // ==== modes ========================================================================================

  /** Lounge-casino jazz: walking bass, brushes + ride, vibes comping, optional kazoo lead. */
  private bandBeat(t: number, bus: GainNode, kazoo: boolean): void {
    const beat = this.modeBeat;
    const bar = Math.floor(beat / 4) % 16;
    const bib = beat % 4;
    const prog = LOUNGE[bar % 8];
    const two = prog.length === 2;
    const ci = two && bib >= 2 ? 1 : 0;
    const k = two ? bib % 2 : bib;
    const L = two ? 2 : 4;
    const chord = prog[ci];
    const next = ci + 1 < prog.length ? prog[ci + 1] : LOUNGE[(bar + 1) % 8][0];
    const soft = kazoo ? 1 : 0.8;
    const hum = (): number => rand(-0.006, 0.006); // a little human slop

    // Walking bass: root, then a scalar or arpeggiated step, then a chromatic approach to the next root.
    const iv = IV[chord.q];
    let n: number;
    if (k === 0) n = chord.root;
    else if (k === L - 1) n = this.lastBass > next.root ? next.root + 1 : next.root - 1;
    else if (bar % 2 === 0) n = chord.root + (k === 1 ? iv[1] : iv[2]);
    else n = chord.root + (k === 1 ? 2 : iv[1]);
    while (n > 50) n -= 12;
    while (n < 33) n += 12;
    this.lastBass = n;
    this.bass(t + hum(), n, (k === 0 ? 0.36 : 0.3) * soft, B * 0.92, bus);
    if (bib === 3 && Math.random() < 0.22) this.bass(t + B * SWING, n, 0.14 * soft, B * 0.3, bus); // ghost skip

    // Vibes: Charleston comping (on the chord + a swung push on the "and" of 2).
    const v = voicing(chord);
    if (k === 0) v.forEach((m, i) => this.vibe(t + i * 0.012, m, L === 4 ? 1.9 : 1.1, 0.055 * soft, bus));
    if (L === 4 && k === 1) v.forEach((m) => this.vibe(Music.eighth(t, 1), m, 0.55, 0.04 * soft, bus));
    // Lounge: a little vibes noodle descending into the turnaround instead of the kazoo.
    if (!kazoo && bar % 8 === 7 && bib >= 2) {
      const run = [...v].reverse().map((m) => m + 12);
      const base = (bib - 2) * 2;
      for (let e = 0; e < 2; e++) this.vibe(Music.eighth(t, e), run[(base + e) % run.length], 0.6, 0.05, bus);
    }

    // Brushes: a swish on every beat, slap on 2 and 4; ride "ding, ding-a ding"; feathered kick.
    this.brush(t, 0.035 * soft, B * 0.95, true, bus);
    if (bib % 2 === 1) this.brush(t + hum(), 0.1 * soft, 0.14, false, bus);
    this.ride(t + hum(), (bib % 2 === 1 ? 0.05 : 0.038) * soft, bus);
    if (bib % 2 === 1) this.ride(Music.eighth(t, 1), 0.028 * soft, bus);
    this.kick(t, 0.12 * soft, bus);
    if (bar === 0 && bib === 0 && beat > 0) this.crash(t, 0.05 * soft, 1.4, bus);

    if (!kazoo) return;
    const mel = bar < 8 ? MEL_A[bar] : bar < 14 ? MEL_A[bar - 8] : SHAVE[bar - 14];
    for (const [e, m, d] of mel) {
      if (e < bib * 2 || e > bib * 2 + 1) continue;
      const at = Music.eighth(t, e);
      const dur = Math.max(0.12, d * (B / 2) - 0.03);
      const long = d >= 3;
      this.kazoo(at, m, dur, 0.21, bus, { scoop: long || Math.random() < 0.15, wobble: long ? 0.02 : 0.011 });
      if (bar === 15) {
        // "...two bits!" — the whole band hits it.
        this.kick(at, 0.35, bus);
        this.brush(at, 0.16, 0.18, false, bus);
        voicing(ch(F, "6")).forEach((x) => this.vibe(at, x + 12, 0.5, 0.05, bus));
      }
    }
  }

  /** Hover tension: tick-tock, nervous hi-hat and a heartbeat that rise in pitch and speed. */
  private tensionBeat(t: number, bus: GainNode): void {
    const i = this.intensity;
    const el = t - this.modeStart;
    const rise = Math.min(6, el / 4) + i * 5; // semitones
    const up = Math.pow(2, rise / 12);
    const sub = i < 0.35 ? 2 : i < 0.7 ? 3 : 4;
    for (let s = 0; s < sub; s++) this.hat(t + (s * B) / sub, s === 0 ? 0.055 : 0.03 + i * 0.015, bus);
    this.block(t, (this.modeBeat % 2 === 0 ? 1250 : 940) * up, 0.05 + i * 0.03, bus);
    if (i >= 0.5 || this.modeBeat % 2 === 0) {
      const f = 55 * up;
      this.thump(t, f, 0.42, bus);
      this.thump(t + 0.17, f * 0.94, 0.28, bus);
    }
  }

  /** Settling: a snare roll that crescendos over ~5 s with a swelling cymbal and low timpani rumble. */
  private drumrollBeat(t: number, bus: GainNode): void {
    const level = (x: number): number => 0.25 + 0.75 * Math.min(1, Math.max(0, x - this.modeStart) / 5);
    const lv = level(t);
    const hits = 9;
    for (let k = 0; k < hits; k++) {
      const at = t + (k * B) / hits + rand(0, 0.004);
      this.snare(at, (0.05 + 0.14 * lv) * (k % 2 === 0 ? 1 : 0.8) * rand(0.85, 1.1), bus);
    }
    if (this.modeBeat % 4 === 0) {
      const a = level(t), b = level(t + 4 * B);
      this.swell(t, 4 * B, 0.004 + 0.035 * a, 0.004 + 0.035 * b, bus);
    }
    if (this.modeBeat % 2 === 0) this.timpani(t, 29, 0.12 * lv, 0.9, bus);
  }

  /** Match end: cheesy oom-pah fanfare with a kazoo choir. */
  private victoryBeat(t: number, bus: GainNode): void {
    const beat = this.modeBeat;
    const bar = Math.floor(beat / 4) % 4;
    const bib = beat % 4;
    const chord = VICTORY[bar][0];
    if (bib === 0) this.bass(t, chord.root, 0.38, B * 0.9, bus);
    if (bib === 2) this.bass(t, chord.root - 5 < 33 ? chord.root + 7 : chord.root - 5, 0.34, B * 0.9, bus);
    if (bib === 3 && bar === 3) this.bass(Music.eighth(t, 1), 40, 0.24, B * 0.3, bus); // pickup into F
    const v = voicing(chord).map((m) => m + 12);
    if (bib % 2 === 1) v.forEach((m) => this.vibe(t, m, 0.4, 0.045, bus)); // the "pah"
    if (bib === 0 && bar % 2 === 0) v.forEach((m, i) => this.vibe(t + i * 0.015, m, 1.6, 0.04, bus));
    this.kick(t, bib % 2 === 0 ? 0.32 : 0.1, bus);
    if (bib % 2 === 1) this.brush(t, 0.12, 0.16, false, bus);
    this.ride(t, 0.04, bus);
    this.ride(Music.eighth(t, 1), 0.026, bus);
    if (bar === 0 && bib === 0 && beat > 0) this.crash(t, 0.07, 1.6, bus);

    for (const [e, m, d] of MEL_VICTORY[bar]) {
      if (e < bib * 2 || e > bib * 2 + 1) continue;
      const at = Music.eighth(t, e);
      const dur = Math.max(0.12, d * (B / 2) - 0.03);
      this.kazoo(at, m, dur, 0.2, bus, { scoop: d >= 3, wobble: d >= 3 ? 0.022 : 0.012 });
      if (d >= 2) this.kazoo(at + 0.012, diatonicDown(m, 2), dur, 0.12, bus, { wobble: 0.016 });
    }
  }

  // ==== stingers =====================================================================================

  /** Plays the jingle starting at t and returns roughly how long the band should stay ducked. */
  private playStinger(kind: Stinger, t: number): number {
    const out = this.stingBus;
    switch (kind) {
      case "legendary": {
        // Slot machine: ascending chip arpeggio, ka-ching bells, a jackpot chord and a kazoo "wheee!".
        const arp = [65, 69, 72, 77, 81, 84, 89, 93, 96];
        arp.forEach((m, i) => this.chip(t + i * 0.055, m, 0.09, 0.07, out));
        const top = t + arp.length * 0.055;
        [77, 81, 84, 89].forEach((m, i) => this.bell(top + i * 0.03, m, 2.2, 0.075, out));
        this.bell(top - 0.05, 96, 0.8, 0.06, out);
        this.bell(top + 0.07, 100, 1.0, 0.06, out);
        for (let i = 0; i < 6; i++) this.bell(top + 0.35 + i * 0.075, i % 2 ? 103 : 100, 0.35, 0.035, out);
        this.kazoo(top, 72, 0.7, 0.2, out, { glideTo: 84, wobble: 0.025 });
        this.crash(top, 0.09, 2.0, out);
        this.timpani(top, 41, 0.3, 1.0, out);
        return 2.6;
      }
      case "cursed": {
        // Ominous church organ on a diminished chord over a low pedal... then the sad trombone gives up.
        [50, 53, 56, 62].forEach((m) => this.organ(t, m, 1.5, 0.05, out));
        this.organ(t, 38, 1.5, 0.06, out);
        this.thump(t, 36.7, 0.4, out);
        const notes = [55, 54, 53, 52];
        notes.forEach((m, i) => this.brass(t + 1.35 + i * 0.42, m, i === 3 ? 1.35 : 0.4, 0.17, out, { droop: i === 3 }));
        return 3.4;
      }
      case "stand": {
        // Ta-DA!
        [65, 69, 72].forEach((m) => this.vibe(t, m + 12, 0.25, 0.05, out));
        this.kazoo(t, 72, 0.11, 0.2, out, { staccato: true });
        const da = t + 0.16;
        this.kazoo(da, 77, 0.65, 0.23, out, { scoop: true, wobble: 0.024 });
        this.kazoo(da + 0.01, 72, 0.65, 0.13, out, { wobble: 0.018 });
        [65, 69, 72, 77].forEach((m) => this.vibe(da, m + 12, 1.4, 0.05, out));
        this.kick(da, 0.25, out);
        this.crash(da, 0.08, 1.4, out);
        return 0.9;
      }
      case "topple": {
        // Wah... wah... wah... waaaaah.
        [62, 61, 60, 59].forEach((m, i) => this.brass(t + i * 0.44, m, i === 3 ? 1.4 : 0.42, 0.19, out, { droop: i === 3 }));
        return 2.8;
      }
      case "reveal": {
        // Dun... dun... DUNNNN! (and a tiny confused kazoo "huh?" afterwards)
        this.stab(t, [38, 50, 53, 57], 0.26, 0.07, out);
        this.timpani(t, 38, 0.4, 0.6, out);
        this.stab(t + 0.38, [39, 51, 54, 58], 0.26, 0.07, out);
        this.timpani(t + 0.38, 39, 0.4, 0.6, out);
        const big = t + 0.8;
        this.stab(big, [26, 38, 45, 50, 53], 1.7, 0.08, out, true);
        this.timpani(big, 26, 0.6, 1.8, out);
        this.crash(big, 0.06, 2.0, out);
        this.kazoo(big + 1.75, 64, 0.22, 0.1, out, { glideTo: 69, wobble: 0.03 });
        return 2.4;
      }
      case "roleBaker": {
        // Ding-ding! + a cheerful "doo-doot".
        this.bell(t, 84, 1.0, 0.08, out);
        this.bell(t + 0.15, 89, 1.3, 0.08, out);
        this.bell(t + 0.15, 96, 0.6, 0.03, out);
        this.kazoo(t + 0.38, 77, 0.1, 0.17, out, { staccato: true });
        this.kazoo(t + 0.52, 81, 0.24, 0.19, out, { scoop: true, wobble: 0.02 });
        return 0.9;
      }
      case "roleSaboteur": {
        // Villain chord, then a kazoo "nyeh-heh-heh-heh" cackle sliding down into a low bwomp.
        [47, 50, 53, 56].forEach((m) => this.organ(t, m, 0.6, 0.05, out));
        this.timpani(t, 31, 0.4, 0.9, out);
        [70, 69, 68, 67, 66].forEach((m, i) =>
          this.kazoo(t + 0.4 + i * 0.12, m, 0.085, 0.18, out, { staccato: true, wobble: 0.05 }),
        );
        this.brass(t + 1.05, 43, 0.5, 0.17, out, { glideTo: 36 });
        return 1.6;
      }
    }
  }

  // ==== instruments ==================================================================================

  /** Track sources, stop them at `stopAt`, and disconnect every node of the voice once all have ended. */
  private finish(srcs: AudioScheduledSourceNode[], nodes: AudioNode[], stopAt: number): void {
    let left = srcs.length;
    for (const s of srcs) {
      this.live.add(s);
      s.onended = () => {
        this.live.delete(s);
        s.disconnect();
        if (--left === 0) for (const n of nodes) n.disconnect();
      };
      s.stop(stopAt);
    }
  }

  private later(at: number, fn: () => void): void {
    const ms = Math.max(0, (at - this.ctx.currentTime) * 1000);
    const h = setTimeout(() => {
      this.timers.delete(h);
      fn();
    }, ms);
    this.timers.add(h);
  }

  private osc(type: OscillatorType, freq: number, t: number): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.start(t);
    return o;
  }

  private noise(t: number): AudioBufferSourceNode {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBuf;
    s.loop = true;
    s.start(t, Math.random() * 1.5);
    return s;
  }

  private filter(type: BiquadFilterType, freq: number, q = 0.7): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    return f;
  }

  private gain(v = 0): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  /** Percussive envelope: quick attack to `peak`, exponential decay to silence by t+dur. */
  private perc(g: GainNode, t: number, peak: number, dur: number, attack = 0.003): void {
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(EPS, t + Math.max(attack + 0.01, dur));
  }

  /** Upright bass: sine fundamental + lowpassed triangle "wood", plucky envelope. */
  private bass(t: number, midi: number, vel: number, dur: number, dest: AudioNode): void {
    const f = mtof(midi);
    vel *= 0.45; // normalize: sine + triangle sum is hot
    const o1 = this.osc("sine", f, t);
    const o2 = this.osc("triangle", f, t);
    const lp = this.filter("lowpass", 900, 1.2);
    lp.frequency.setValueAtTime(1100, t);
    lp.frequency.exponentialRampToValueAtTime(320, t + 0.18);
    const g2 = this.gain(0.55);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.008);
    env.gain.exponentialRampToValueAtTime(vel * 0.4, t + 0.12);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.08);
    o1.connect(env);
    o2.connect(lp).connect(g2).connect(env);
    env.connect(dest);
    this.finish([o1, o2], [lp, g2, env], t + dur + 0.1);
  }

  /** Vibraphone: sine + bright 4th-partial strike, motor tremolo. */
  private vibe(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    vel *= 1.3;
    const f = mtof(midi);
    const o = this.osc("sine", f, t);
    const o4 = this.osc("sine", f * 4, t);
    const lfo = this.osc("sine", 5.2, t);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.003);
    env.gain.exponentialRampToValueAtTime(vel * 0.45, t + 0.25);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur);
    const strike = this.gain();
    this.perc(strike, t, vel * 0.22, 0.12, 0.002);
    const trem = this.gain(0.78);
    const depth = this.gain(0.22);
    o.connect(env).connect(trem);
    o4.connect(strike).connect(trem);
    lfo.connect(depth).connect(trem.gain);
    trem.connect(dest);
    this.finish([o, o4, lfo], [env, strike, trem, depth], t + dur + 0.02);
  }

  /** KAZOO: buzzy saw+square → soft clip → two vocal formants + body, with delayed vibrato. */
  private kazoo(t: number, midi: number, dur: number, vel: number, dest: AudioNode, o: KazooOpts = {}): void {
    const c = this.ctx;
    vel *= 0.5; // normalize: the formant stack is loud
    const f = mtof(midi) * rand(0.997, 1.003);
    const o1 = c.createOscillator();
    o1.type = "sawtooth";
    const o2 = c.createOscillator();
    o2.type = "square";
    o2.detune.value = 8;
    for (const p of [o1.frequency, o2.frequency]) {
      if (o.scoop) {
        p.setValueAtTime(f * 0.9, t);
        p.exponentialRampToValueAtTime(f, t + 0.07);
      } else p.setValueAtTime(f, t);
      if (o.glideTo !== undefined) p.exponentialRampToValueAtTime(mtof(o.glideTo), t + dur * 0.9);
    }
    const sq = this.gain(0.3);
    const pre = this.gain(0.7);
    const shaper = c.createWaveShaper();
    shaper.curve = this.buzzCurve;
    const f1 = this.filter("bandpass", 720, 3.5);
    const f2 = this.filter("bandpass", 1650, 5);
    const body = this.filter("lowpass", 1000, 0.7);
    const g1 = this.gain(1.4);
    const g2 = this.gain(0.9);
    const gb = this.gain(0.3);
    const lp = this.filter("lowpass", 3400, 0.6);
    const env = this.gain();
    const a = o.staccato ? 0.012 : 0.022;
    const rel = o.staccato ? 0.03 : 0.05;
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + a);
    env.gain.linearRampToValueAtTime(vel * 0.85, t + Math.max(a + 0.01, dur - rel));
    env.gain.linearRampToValueAtTime(0, t + dur);
    // Vibrato fades in like a singer warming up (and wobbles harder on long notes).
    const lfo = this.osc("sine", rand(5.4, 6.4), t);
    const vib = this.gain();
    vib.gain.setValueAtTime(0, t);
    vib.gain.linearRampToValueAtTime(f * (o.wobble ?? 0.012), t + Math.min(0.2, dur * 0.6));
    lfo.connect(vib);
    vib.connect(o1.frequency);
    vib.connect(o2.frequency);
    o1.connect(pre);
    o2.connect(sq).connect(pre);
    pre.connect(shaper);
    shaper.connect(f1).connect(g1).connect(lp);
    shaper.connect(f2).connect(g2).connect(lp);
    shaper.connect(body).connect(gb).connect(lp);
    lp.connect(env).connect(dest);
    o1.start(t);
    o2.start(t);
    this.finish([o1, o2, lfo], [sq, pre, shaper, f1, f2, body, g1, g2, gb, lp, env, vib], t + dur + 0.02);
  }

  /** Trombone: two saws through a "wah" lowpass that opens and closes on every note. */
  private brass(t: number, midi: number, dur: number, vel: number, dest: AudioNode, o: BrassOpts = {}): void {
    const f = mtof(midi);
    const o1 = this.osc("sawtooth", f, t);
    const o2 = this.osc("sawtooth", f * 1.004, t);
    const end = t + dur;
    for (const p of [o1.frequency, o2.frequency]) {
      if (o.glideTo !== undefined) p.exponentialRampToValueAtTime(mtof(o.glideTo), end);
      if (o.droop) {
        p.setValueAtTime(p === o1.frequency ? f : f * 1.004, t + dur * 0.4);
        p.exponentialRampToValueAtTime(f * 0.94, end);
      }
    }
    const lp = this.filter("lowpass", 300, 3);
    lp.frequency.setValueAtTime(260, t);
    lp.frequency.exponentialRampToValueAtTime(1300, t + Math.min(0.15, dur * 0.4));
    lp.frequency.exponentialRampToValueAtTime(o.droop ? 380 : 500, end);
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.04);
    env.gain.setValueAtTime(vel, end - 0.08);
    env.gain.linearRampToValueAtTime(0, end);
    const mix = this.gain(0.5);
    o1.connect(mix);
    o2.connect(mix);
    mix.connect(lp).connect(env).connect(dest);
    const srcs: AudioScheduledSourceNode[] = [o1, o2];
    const nodes: AudioNode[] = [mix, lp, env];
    if (o.droop) {
      // The pathetic wobble that makes the sad trombone sad.
      const lfo = this.osc("sine", 5, t);
      const vib = this.gain();
      vib.gain.setValueAtTime(0, t);
      vib.gain.linearRampToValueAtTime(f * 0.035, end);
      lfo.connect(vib);
      vib.connect(o1.frequency);
      vib.connect(o2.frequency);
      srcs.push(lfo);
      nodes.push(vib);
    }
    this.finish(srcs, nodes, end + 0.02);
  }

  /** Church organ: drawbar sines + detuned saws (lowpassed), slow swell, leslie wobble. */
  private organ(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    const f = mtof(midi);
    const srcs: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.18);
    env.gain.setValueAtTime(vel, t + dur);
    env.gain.linearRampToValueAtTime(0, t + dur + 0.45);
    const lp = this.filter("lowpass", 1500, 0.5);
    [[1, 1], [2, 0.5], [3, 0.3], [4, 0.2]].forEach(([r, a]) => {
      const o = this.osc("sine", f * r, t);
      const g = this.gain(a * 0.6);
      o.connect(g).connect(env);
      srcs.push(o);
      nodes.push(g);
    });
    for (const det of [-9, 9]) {
      const o = this.osc("sawtooth", f, t);
      o.detune.value = det;
      const g = this.gain(0.18);
      o.connect(g).connect(lp);
      srcs.push(o);
      nodes.push(g);
    }
    lp.connect(env);
    const trem = this.gain(0.85);
    const lfo = this.osc("sine", 6.3, t);
    const depth = this.gain(0.15);
    lfo.connect(depth).connect(trem.gain);
    env.connect(trem).connect(dest);
    srcs.push(lfo);
    nodes.push(env, lp, trem, depth);
    this.finish(srcs, nodes, t + dur + 0.5);
  }

  /** Brass/orchestra stab chord for dun-dun-DUNNN; `hold` adds a tremolo sustain. */
  private stab(t: number, notes: number[], dur: number, vel: number, dest: AudioNode, hold = false): void {
    vel *= 0.7;
    const lp = this.filter("lowpass", 2400, 1);
    lp.frequency.setValueAtTime(2600, t);
    lp.frequency.exponentialRampToValueAtTime(hold ? 700 : 500, t + Math.min(0.5, dur));
    const env = this.gain();
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(vel, t + 0.015);
    env.gain.exponentialRampToValueAtTime(vel * 0.5, t + 0.2);
    env.gain.setValueAtTime(vel * 0.5, t + dur * 0.6);
    env.gain.exponentialRampToValueAtTime(EPS, t + dur + 0.25);
    const srcs: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [lp, env];
    for (const m of notes) {
      for (const det of [-7, 6]) {
        const o = this.osc("sawtooth", mtof(m), t);
        o.detune.value = det;
        const g = this.gain(0.3);
        o.connect(g).connect(lp);
        srcs.push(o);
        nodes.push(g);
      }
    }
    lp.connect(env);
    if (hold) {
      const trem = this.gain(0.75);
      const lfo = this.osc("sine", 7, t);
      const depth = this.gain(0.25);
      lfo.connect(depth).connect(trem.gain);
      env.connect(trem).connect(dest);
      srcs.push(lfo);
      nodes.push(trem, depth);
    } else env.connect(dest);
    this.finish(srcs, nodes, t + dur + 0.3);
  }

  /** Bell: inharmonic sine partials with staggered decays. */
  private bell(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    const f = mtof(midi);
    const srcs: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [];
    [[1, 1, 1], [2.76, 0.45, 0.5], [5.4, 0.22, 0.3], [8.93, 0.1, 0.18]].forEach(([r, a, d]) => {
      if (f * r > 16000) return;
      const o = this.osc("sine", f * r, t);
      const g = this.gain();
      this.perc(g, t, vel * a, dur * d, 0.002);
      o.connect(g).connect(dest);
      srcs.push(o);
      nodes.push(g);
    });
    this.finish(srcs, nodes, t + dur + 0.02);
  }

  /** Slot-machine chip blip (lowpassed square). */
  private chip(t: number, midi: number, dur: number, vel: number, dest: AudioNode): void {
    const o = this.osc("square", mtof(midi), t);
    const lp = this.filter("lowpass", 3200);
    const g = this.gain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vel, t + 0.004);
    g.gain.setValueAtTime(vel, t + dur * 0.6);
    g.gain.exponentialRampToValueAtTime(EPS, t + dur);
    o.connect(lp).connect(g).connect(dest);
    this.finish([o], [lp, g], t + dur + 0.01);
  }

  /** Brush: a soft swish (long) or a slap (short), bandpassed noise. */
  private brush(t: number, vel: number, dur: number, swish: boolean, dest: AudioNode): void {
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
  private ride(t: number, vel: number, dest: AudioNode): void {
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

  private crash(t: number, vel: number, dur: number, dest: AudioNode): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", 4200);
    const g = this.gain();
    this.perc(g, t, vel, dur, 0.003);
    n.connect(hp).connect(g).connect(dest);
    this.finish([n], [hp, g], t + dur + 0.02);
  }

  /** Cymbal swell from level a to b across dur (drumroll). */
  private swell(t: number, dur: number, a: number, b: number, dest: AudioNode): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", 5500);
    const g = this.gain();
    g.gain.setValueAtTime(a, t);
    g.gain.linearRampToValueAtTime(b, t + dur);
    n.connect(hp).connect(g).connect(dest);
    this.finish([n], [hp, g], t + dur + 0.005);
  }

  private hat(t: number, vel: number, dest: AudioNode): void {
    const n = this.noise(t);
    const hp = this.filter("highpass", 7500);
    const g = this.gain();
    this.perc(g, t, vel, 0.04, 0.001);
    n.connect(hp).connect(g).connect(dest);
    this.finish([n], [hp, g], t + 0.05);
  }

  private snare(t: number, vel: number, dest: AudioNode): void {
    const n = this.noise(t);
    const bp = this.filter("bandpass", 2100, 0.8);
    const g = this.gain();
    this.perc(g, t, vel, 0.075, 0.002);
    n.connect(bp).connect(g).connect(dest);
    this.finish([n], [bp, g], t + 0.08);
  }

  /** Soft kick (feathered on jazz beats, punchier in the fanfare). */
  private kick(t: number, vel: number, dest: AudioNode): void {
    const o = this.osc("sine", 120, t);
    o.frequency.exponentialRampToValueAtTime(48, t + 0.1);
    const g = this.gain();
    this.perc(g, t, vel, 0.22, 0.004);
    o.connect(g).connect(dest);
    this.finish([o], [g], t + 0.24);
  }

  /** Woodblock tick-tock. */
  private block(t: number, freq: number, vel: number, dest: AudioNode): void {
    const o = this.osc("triangle", freq, t);
    const bp = this.filter("bandpass", freq, 4);
    const g = this.gain();
    this.perc(g, t, vel * 2, 0.05, 0.001);
    o.connect(bp).connect(g).connect(dest);
    this.finish([o], [bp, g], t + 0.06);
  }

  /** Heartbeat / low thump with a triangle overtone so laptop speakers can hear it. */
  private thump(t: number, freq: number, vel: number, dest: AudioNode): void {
    vel *= 0.45;
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

  /** Timpani: pitched sine + triangle with a slight drop, plus a mallet thud. */
  private timpani(t: number, midi: number, vel: number, dur: number, dest: AudioNode): void {
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
}
