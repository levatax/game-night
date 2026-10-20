// Procedural lounge-jazz music (§15). Owner: client-audio. The MusicMode type is the contract (AudioEngine
// and Game use it); the implementation is yours.
//
// Look-ahead scheduler (25 ms timer, ~120 ms ahead; 1.2 s when the tab is hidden and timers throttle).
// Each mode is a "layer" with its own beat clock, crossfade gain and generator (music/*.ts):
//   lobby / lounge → BandGen (same layer; switching keeps the song position and just re-arranges)
//   victory → BandGen "swing" (big-band shout chorus, then A♭ swing) · tango → TangoGen · wheel → WheelGen
//   off → SilentGen (keeps a clock for the heartbeat)
// Switching modes starts the new layer on the old one's next beat and crossfades both over ~0.8 s.
// setTension (the siren level, scale in music/layer.ts) thins the arrangement (tensionMix); from ~0.3
// (≈22% raid chance, card 2) a heartbeat thumps on its own output (AudioEngine routes it to the sfx bus so it
// is heard even with the music turned down), on every beat from ~0.6.
//
// Graph: layer { bus ← drums/bass, keys/vib/mel (tremolo sub-buses) → bus + reverb send }
//        → mix → out (music bus);  sends → room convolver → out.

import { BandGen, type BandStyle } from "./music/band";
import { Inst } from "./music/inst";
import type { Gen, LayerOut } from "./music/layer";
import { TangoGen } from "./music/tango";
import { SilentGen, WheelGen } from "./music/wheel";

export type MusicMode = "off" | "lobby" | "lounge" | "wheel" | "tango" | "victory";

type Kind = "off" | "band" | "victory" | "tango" | "wheel";

const XFADE = 0.8;
const LOOKAHEAD = 0.12;
const LOOKAHEAD_HIDDEN = 1.2;
const TICK_MS = 25;
/** Reverb send relative to the layer level. */
const WET = 0.32;
/** Tension where the heartbeat starts (just under card 2's 0.33). */
const HEART_FROM = 0.3;

const LEVEL: Record<MusicMode, number> = { off: 0, lobby: 1, lounge: 0.78, wheel: 0.95, tango: 0.9, victory: 1 };

const kindOf = (m: MusicMode): Kind => (m === "lobby" || m === "lounge" ? "band" : m);

interface Layer {
  kind: Kind;
  gen: Gen;
  out: LayerOut;
  wet: GainNode;
  nodes: AudioNode[];
  lfos: OscillatorNode[];
  next: number;
  n: number;
  /** Stops scheduling at this time (fading out), null while it's the live layer. */
  endAt: number | null;
}

export class Music {
  private readonly ctx: AudioContext;
  private readonly inst: Inst;
  private readonly mix: GainNode;
  private readonly sendIn: GainNode;
  private readonly verb: ConvolverNode | null = null;
  private readonly verbOut: GainNode;
  private readonly heart: GainNode;
  private layers: Layer[] = [];
  private primary: Layer;
  private target: MusicMode = "off";
  private tensionTarget = 0;
  private tension = 0;
  private interval: ReturnType<typeof setInterval> | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  private disposed = false;

  /**
   * `out`: the music bus. `heartOut`: where the heartbeat goes (the sfx bus). `impulse`: room reverb IR
   * (null = dry).
   */
  constructor(ctx: AudioContext, out: AudioNode, heartOut: AudioNode, impulse: AudioBuffer | null) {
    this.ctx = ctx;
    this.inst = new Inst(ctx);
    this.mix = ctx.createGain();
    this.mix.gain.value = 1.3;
    this.mix.connect(out);
    this.sendIn = ctx.createGain();
    this.verbOut = ctx.createGain();
    this.verbOut.gain.value = 0.85;
    this.verbOut.connect(out);
    if (impulse) {
      try {
        const v = ctx.createConvolver();
        v.buffer = impulse;
        this.sendIn.connect(v).connect(this.verbOut);
        this.verb = v;
      } catch {
        this.verb = null;
      }
    }
    this.heart = ctx.createGain();
    this.heart.gain.value = 0.4;
    this.heart.connect(heartOut);
    this.primary = this.makeLayer("off", "off", ctx.currentTime + 0.05);
    this.interval = setInterval(this.tick, TICK_MS);
  }

  get mode(): MusicMode {
    return this.target;
  }

  setMode(mode: MusicMode): void {
    if (this.disposed || mode === this.target) return;
    this.target = mode;
    const kind = kindOf(mode);
    const P = this.primary;
    const now = this.ctx.currentTime;
    if (P.kind === "band" && kind === "band") {
      (P.gen as BandGen).setStyle(mode as BandStyle);
      this.ramp(P, LEVEL[mode], now, XFADE);
      return;
    }
    // Start on the old layer's next beat when that's soon, else right away.
    const t0 = P.next - now < 0.35 && P.next > now ? P.next : now + 0.06;
    P.endAt = t0 + XFADE;
    this.ramp(P, 0, now, t0 + XFADE - now);
    this.retire(P, t0 + XFADE + 2.5);
    this.primary = this.makeLayer(kind, mode, t0);
  }

  /** 0..1 siren tension (AudioEngine `sirenTension` of the next card's raid chance; scale in music/layer.ts). */
  setTension(level: number): void {
    this.tensionTarget = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
    for (const h of this.timers) clearTimeout(h);
    this.timers.clear();
    this.inst.stopAll();
    for (const L of this.layers) this.destroy(L);
    this.layers = [];
    for (const n of [this.mix, this.sendIn, this.verbOut, this.heart, ...(this.verb ? [this.verb] : [])]) n.disconnect();
  }

  // ==== layers ===========================================================================================

  private makeLayer(kind: Kind, mode: MusicMode, t0: number): Layer {
    const ctx = this.ctx;
    const nodes: AudioNode[] = [];
    const lfos: OscillatorNode[] = [];
    const g = (v: number): GainNode => {
      const n = ctx.createGain();
      n.gain.value = v;
      nodes.push(n);
      return n;
    };
    const bus = g(0);
    bus.connect(this.mix);
    const wet = g(0);
    wet.connect(this.sendIn);
    const sub = (base: number, rate: number, depth: number): GainNode => {
      const s = g(base);
      s.connect(bus);
      s.connect(wet);
      if (depth > 0) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = rate;
        const d = g(depth);
        lfo.connect(d).connect(s.gain);
        lfo.start(t0);
        lfos.push(lfo);
      }
      return s;
    };
    const out: LayerOut = { bus, keys: sub(0.85, 4.4, 0.15), vib: sub(0.75, 5.6, 0.25), mel: sub(1, 0, 0) };
    let gen: Gen;
    switch (kind) {
      case "band":
        gen = new BandGen(this.inst, out, mode === "lounge" ? "lounge" : "lobby", t0);
        break;
      case "victory":
        gen = new BandGen(this.inst, out, "swing", t0);
        break;
      case "tango":
        gen = new TangoGen(this.inst, out);
        break;
      case "wheel":
        gen = new WheelGen(this.inst, out);
        break;
      default:
        gen = new SilentGen();
    }
    const L: Layer = { kind, gen, out, wet, nodes, lfos, next: t0, n: 0, endAt: null };
    const level = LEVEL[mode];
    bus.gain.setValueAtTime(0, Math.max(ctx.currentTime, t0 - 0.01));
    bus.gain.linearRampToValueAtTime(level, t0 + XFADE);
    wet.gain.setValueAtTime(0, Math.max(ctx.currentTime, t0 - 0.01));
    wet.gain.linearRampToValueAtTime(level * WET, t0 + XFADE);
    this.layers.push(L);
    return L;
  }

  /** Ramp a layer's dry + wet level to `level` from `from` over `dur`. */
  private ramp(L: Layer, level: number, from: number, dur: number): void {
    for (const [gn, v] of [[L.out.bus, level], [L.wet, level * WET]] as const) {
      const p = gn.gain;
      const cur = p.value;
      p.cancelScheduledValues(from);
      p.setValueAtTime(cur, from);
      p.linearRampToValueAtTime(v, from + Math.max(0.02, dur));
    }
  }

  private retire(L: Layer, at: number): void {
    const ms = Math.max(0, (at - this.ctx.currentTime) * 1000);
    const h = setTimeout(() => {
      this.timers.delete(h);
      this.layers = this.layers.filter((x) => x !== L);
      this.destroy(L);
    }, ms);
    this.timers.add(h);
  }

  private destroy(L: Layer): void {
    try {
      L.gen.dispose();
    } catch {
      /* ignore */
    }
    for (const o of L.lfos) {
      try {
        o.stop();
      } catch {
        /* not started */
      }
      o.disconnect();
    }
    for (const n of L.nodes) n.disconnect();
    L.lfos = [];
    L.nodes = [];
  }

  // ==== scheduler ========================================================================================

  private readonly tick = (): void => {
    if (this.disposed) return;
    try {
      const hidden = typeof document !== "undefined" && document.hidden;
      this.pump(this.ctx.currentTime + (hidden ? LOOKAHEAD_HIDDEN : LOOKAHEAD));
    } catch (e) {
      console.warn("[kasala] music scheduler", e);
    }
  };

  private pump(horizon: number): void {
    const now = this.ctx.currentTime;
    for (const L of this.layers) {
      // Context was suspended or the tab throttled: don't machine-gun the missed beats.
      if (L.next < now - 0.25) L.next = now + 0.05;
      while (L.next < horizon) {
        if (L.endAt !== null && L.next >= L.endAt) break;
        const t = L.next;
        if (L === this.primary) {
          // Tighten quickly on a new card, relax a little slower after the turn.
          this.tension += (this.tensionTarget - this.tension) * (this.tensionTarget > this.tension ? 0.65 : 0.4);
          if (Math.abs(this.tension - this.tensionTarget) < 0.005) this.tension = this.tensionTarget;
          this.heartbeat(t, L);
        }
        L.gen.beat(t, this.tension);
        L.n++;
        L.next += L.gen.spb;
      }
    }
  }

  /**
   * Lub-dub on beats 1 and 3 from ~0.31 tension (card 2, 22%: faint), on every beat from 0.6 (card 4, 36%),
   * louder as it rises.
   */
  private heartbeat(t: number, L: Layer): void {
    const I = this.tension;
    const hb = Math.min(1, Math.max(0, (I - HEART_FROM) / 0.45));
    if (hb < 0.02 || L.kind === "wheel") return;
    const every = I >= 0.6 ? 1 : 2;
    if (L.n % every !== 0) return;
    const v = 0.3 + 0.7 * hb;
    this.inst.thump(t, 54, v, this.heart);
    this.inst.thump(t + Math.min(0.18, L.gen.spb * 0.3), 50, v * 0.7, this.heart);
  }
}
