// Mixer + procedural sound effects (no audio files). Owner: client-sfx. PUBLIC API IS THE CONTRACT.
// Music itself is ./Music.ts (client-music); AudioEngine creates it on the music bus and forwards calls.
//
// Graph: ctx → master gain → (music bus, sfx bus) with a gentle compressor on master. Volumes from
// settings (master/music/sfx) via setVolumes. The AudioContext starts suspended: unlock() on the first
// user gesture (Game calls it on any pointerdown/keydown).
//
// SFX are all synthesized and should be FUNNY (cartoon foley):
//  - piece impacts by ImpactSound: squeak (rubber chicken: fast pitch-bent square/saw squeal), clank (metallic
//    inharmonic partials), blorp (jelly: low sine with fast downward pitch bend + wobble), slap (wet fish: noise
//    burst through a resonant lowpass), crack (egg: sharp click + crunchy noise), thud, boing (spring: sine with
//    vibrato pitch drop), clink (glass/ceramic), squish (soft filtered noise + pitch blip), bonk (cartoon bonk:
//    woodblock-ish). Volume/pitch scale with impact speed; slight random pitch variation so repeats aren't samey.
//  - reel ticks (reelTick, called by CaseReel with the current speed), rarity stings (light, the Music stingers
//    handle the big ones), button clicks/hover blips, coin jingles, cash register "ka-ching", slide whistle
//    (down) on topple, cake SPLAT, pie THWACK, confetti party-popper + kazoo toot, drumroll ending rimshot,
//    "TIMBER!" creak + crash, crowd "OOOOH" (several detuned formant voices), cheering crowd, record scratch,
//    *hic*, wind howl loop (setWindLevel), stand motor hum loop (setHum), earthquake rumble, devil cackle,
//    ticking timer (last 3 s), whoosh (piece drop), pop (UI card flip).
//  - chef gibberish voices (voice): short formant-synth "ooh!", "noo!", "yesss", "haha", "gasp", "hmm",
//    pitched per player (pitchSeed 0..5) so every chef has their own silly voice.

import type { ImpactSound } from "../../../shared/constants";
import { Music, type MusicMode, type Stinger } from "./Music";
import { Kit, clamp01, rand, vary } from "./sfx/kit";
import { IMPACTS, IMPACT_DUR } from "./sfx/impacts";
import { FOLEY } from "./sfx/foley";
import { chefVoice } from "./sfx/voices";
import { HumLoop, WindLoop } from "./sfx/loops";

export type Sfx =
  | "click"
  | "hover"
  | "cardFlip"
  | "coin"
  | "kaching"
  | "slideWhistle"
  | "splat"
  | "pie"
  | "partyPopper"
  | "rimshot"
  | "timber"
  | "ooh"
  | "cheer"
  | "recordScratch"
  | "hic"
  | "rumble"
  | "cackle"
  | "tick"
  | "whoosh"
  | "pop"
  | "ding"
  | "buzzer"
  | "lose";

export type Voice = "ooh" | "noo" | "yes" | "haha" | "gasp" | "hmm";

type Ctor = typeof AudioContext;

/** Minimum gap between two identical one-shots (stops impact/tick spam from stacking into mush). */
const MIN_GAP: Partial<Record<string, number>> = { hover: 0.04, click: 0.03, tick: 0.05, coin: 0.035, pop: 0.03 };

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private kit: Kit | null = null;
  private mus: Music | null = null;
  private wind: WindLoop | null = null;
  private hum: HumLoop | null = null;
  private last = new Map<string, number>();
  private vols = { master: 0.8, music: 0.6, sfx: 0.9 };
  private pendingMode: MusicMode | null = null;

  constructor() {
    try {
      const w = window as unknown as { AudioContext?: Ctor; webkitAudioContext?: Ctor };
      const C = w.AudioContext ?? w.webkitAudioContext;
      if (!C) return;
      const ctx = new C({ latencyHint: "interactive" });
      // master → compressor (gentle glue) → limiter-ish compressor → speakers
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.knee.value = 14;
      comp.ratio.value = 3.5;
      comp.attack.value = 0.004;
      comp.release.value = 0.22;
      const limit = ctx.createDynamicsCompressor();
      limit.threshold.value = -3;
      limit.knee.value = 0;
      limit.ratio.value = 20;
      limit.attack.value = 0.001;
      limit.release.value = 0.1;
      const master = ctx.createGain();
      const musicBus = ctx.createGain();
      const sfxBus = ctx.createGain();
      musicBus.connect(master);
      sfxBus.connect(master);
      master.connect(comp).connect(limit).connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.musicBus = musicBus;
      this.sfxBus = sfxBus;
      this.kit = new Kit(ctx, sfxBus);
      this.wind = new WindLoop(this.kit);
      this.hum = new HumLoop(this.kit);
      this.applyVolumes(true);
      try {
        this.mus = new Music(ctx, musicBus);
      } catch (e) {
        console.warn("[jelly-jackpot] music unavailable", e);
        this.mus = null;
      }
      ctx.addEventListener?.("statechange", () => {
        if (ctx.state === "running" && this.pendingMode) {
          const m = this.pendingMode;
          this.pendingMode = null;
          this.music(m);
        }
      });
    } catch (e) {
      console.warn("[jelly-jackpot] Web Audio unavailable", e);
      this.ctx = null;
      this.kit = null;
    }
  }

  /** Resume the AudioContext (call from a user gesture). Safe to call repeatedly. */
  unlock(): void {
    const ctx = this.ctx;
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    try {
      void ctx.resume().catch(() => undefined);
      // iOS Safari also wants a sound started inside the gesture.
      const b = ctx.createBufferSource();
      b.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      b.connect(ctx.destination);
      b.start();
    } catch {
      /* ignore */
    }
  }

  setVolumes(v: { master: number; music: number; sfx: number }): void {
    this.vols = { master: clamp01(v.master), music: clamp01(v.music), sfx: clamp01(v.sfx) };
    this.applyVolumes(false);
  }

  private applyVolumes(immediate: boolean): void {
    if (!this.ctx || !this.master || !this.musicBus || !this.sfxBus) return;
    // Perceptual-ish curve so the sliders feel linear.
    const curve = (x: number) => x * x;
    const now = this.ctx.currentTime;
    const set = (g: GainNode, x: number) => {
      if (immediate) g.gain.value = x;
      else g.gain.setTargetAtTime(x, now, 0.03);
    };
    set(this.master, curve(this.vols.master) * 0.9);
    set(this.musicBus, curve(this.vols.music) * 0.7);
    set(this.sfxBus, curve(this.vols.sfx));
  }

  private get running(): boolean {
    return !!this.ctx && this.ctx.state === "running" && !!this.kit;
  }

  /** True if a one-shot of `key` played less than `gap` seconds ago (and records this one otherwise). */
  private throttled(key: string, gap: number): boolean {
    const now = this.ctx?.currentTime ?? 0;
    const prev = this.last.get(key);
    if (prev !== undefined && now - prev < gap) return true;
    this.last.set(key, now);
    return false;
  }

  music(mode: MusicMode): void {
    if (!this.mus) return;
    if (this.ctx && this.ctx.state !== "running") this.pendingMode = mode;
    try {
      this.mus.setMode(mode);
    } catch (e) {
      console.warn("[jelly-jackpot] music.setMode failed", e);
    }
  }

  stinger(kind: Stinger): void {
    if (!this.mus || !this.running) return;
    try {
      this.mus.stinger(kind);
    } catch (e) {
      console.warn("[jelly-jackpot] music.stinger failed", e);
    }
  }

  /** Tension intensity 0..1, forwarded to Music. */
  setIntensity(v: number): void {
    if (!this.mus) return;
    try {
      this.mus.setIntensity(clamp01(v));
    } catch {
      /* ignore */
    }
  }

  sfx(name: Sfx, opts?: { volume?: number; pitch?: number }): void {
    const kit = this.kit;
    if (!this.running || !kit) return;
    const recipe = FOLEY[name];
    if (!recipe) return;
    if (this.throttled(name, MIN_GAP[name] ?? 0.02)) return;
    const vol = Math.max(0, Math.min(2, opts?.volume ?? 1));
    const pitch = Math.max(0.25, Math.min(4, opts?.pitch ?? 1)) * vary(0.04);
    try {
      recipe(kit, kit.now + 0.005, vol, pitch);
    } catch (e) {
      console.warn("[jelly-jackpot] sfx failed", name, e);
    }
  }

  /** Piece impact sound; speed in m/s. */
  impact(sound: ImpactSound, speed: number): void {
    const kit = this.kit;
    if (!this.running || !kit) return;
    const recipe = IMPACTS[sound];
    if (!recipe || !Number.isFinite(speed) || speed < 0.15) return;
    if (this.throttled("impact:" + sound, 0.045)) return;
    const s = clamp01(speed / 5);
    const vol = 0.18 + 0.82 * Math.sqrt(s);
    // Harder hits are a touch lower; random spread so a stack of chickens doesn't sound like one.
    const pitch = (1.08 - s * 0.16) * vary(0.09);
    const t = kit.now + 0.004;
    const g = kit.group(t, IMPACT_DUR[sound], vol * 0.7);
    if (!g) return;
    try {
      recipe(g, t, s, pitch);
    } catch (e) {
      console.warn("[jelly-jackpot] impact failed", sound, e);
    }
  }

  /** One reel tick; speed 0..1 (1 = blur). Higher speed → higher, quieter ticks. */
  reelTick(speed: number): void {
    const kit = this.kit;
    if (!this.running || !kit) return;
    const sp = clamp01(speed);
    // At full blur ticks come very fast: thin them out so they don't merge into a buzz.
    if (this.throttled("reelTick", 0.018 + (1 - sp) * 0.01)) return;
    const t = kit.now + 0.003;
    const g = kit.group(t, 0.08, 0.32 * (1 - sp * 0.6));
    if (!g) return;
    try {
      const f = (900 + sp * 1300) * rand(0.97, 1.03);
      const v = g.vca();
      const bp = g.filter("bandpass", f * 1.5, 4, v);
      const o = g.osc("square", f, t, t + 0.05, bp);
      o.frequency.exponentialRampToValueAtTime(f * 0.7, t + 0.03);
      v.gain.setValueAtTime(0.0001, t);
      v.gain.linearRampToValueAtTime(0.9, t + 0.001);
      v.gain.exponentialRampToValueAtTime(0.0001, t + 0.035);
    } catch {
      /* ignore */
    }
  }

  voice(kind: Voice, pitchSeed: number): void {
    const kit = this.kit;
    if (!this.running || !kit) return;
    if (this.throttled("voice:" + kind + ":" + pitchSeed, 0.15)) return;
    try {
      chefVoice(kit, kind, pitchSeed, 1);
    } catch (e) {
      console.warn("[jelly-jackpot] voice failed", kind, e);
    }
  }

  /** Looping wind howl 0..1 (0 = off). */
  setWindLevel(v: number): void {
    if (!this.ctx || !this.wind) return;
    try {
      this.wind.set(v);
    } catch {
      /* ignore */
    }
  }

  /** Looping stand motor hum, pitch from deg/s (0 = off). */
  setHum(degPerSec: number): void {
    if (!this.ctx || !this.hum) return;
    try {
      this.hum.set(degPerSec);
    } catch {
      /* ignore */
    }
  }
}
