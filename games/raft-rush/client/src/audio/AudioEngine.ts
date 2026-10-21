// Audio facade: Web Audio graph (master / music / sfx buses from settings, mute), synthesized SFX, positional
// sounds, ambience (waves, gulls / wind by day, crickets at night, rain, storm; dusk drums whose tempo follows
// the monster count), procedural island music (Emekli Amca's radio is the source: it fades with distance from
// him), per-tourist gibberish voices, ducking on banners / boss entry. Owner: client-audio. Signatures by the
// architect; keep them.
//
// Copied + adapted from games/bonk-brawl/client/src/audio/{AudioEngine,engine/*,synth/dsp,synth/blocks,
// music/MusicCore,music/instruments,music/theory,music/ticker}.ts; games/jelly-jackpot/client/src/audio/sfx/
// voices.ts. Everything is synthesized (no audio files):
//   engine/graph (buses) · engine/VoicePool (caps) · engine/spatial (panners, radio curves) · synth/recipes (one
//   recipe per SfxName) · synth/loops (every LoopName) · voices (tourist formant gibberish) · ambience (beds) ·
//   music/* (seeded island tune, Band instruments, jingles, MusicCore sequencer, worker ticker).
//
// Before unlock() (first user gesture) everything is a silent no-op that remembers the desired music mood, radio,
// ambience and volumes; nothing throws when Web Audio is unavailable.
//
// Loops: loop(key, name, opts) starts or updates a continuous sound; `opts.param` (0..1) drives its character
// (charge fraction, fire size, intensity, swim speed, fuse urgency, reel speed, channel progress, drum tempo),
// `pitch` detunes it, `volume` scales it, `pos` makes it positional. The ambience beds (waves, wind, gulls,
// crickets, rain, storm, drums) already play from setAmbience(); an explicit loop with one of those names mutes
// the matching bed while it runs (e.g. a positional surf loop at the nearest shore point).

import type { CharacterId, Vec3Like, Weather } from "../../../shared/types";
import type { SettingsStore } from "../app/settings";
import { AmbienceMixer } from "./ambience";
import { WORLD_OPEN_HZ, WORLD_UNDERWATER_HZ, buildGraph, disposeGraph, rampGain, sliderToGain, type EngineGraph } from "./engine/graph";
import {
  createDirectionalPanner,
  createPanner,
  isFiniteVec,
  radioDirectional,
  radioGain,
  radioLowCutHz,
  radioToneHz,
  setListenerPose,
  setPannerPosition,
} from "./engine/spatial";
import { VoicePool } from "./engine/VoicePool";
import { MusicCore } from "./music/MusicCore";
import { composeSongBook, songForMood } from "./music/songs";
import { Ticker } from "./music/ticker";
import type { LoopName, MusicMood, SfxName, VoiceKind } from "./Sfx";
import { Synth, belowNyquist, safeDisconnect } from "./synth/dsp";
import { LOOP_LEVEL, createLoop, type LoopVoice } from "./synth/loops";
import { SFX_DEFS, SFX_RECIPES, sfxGain } from "./synth/recipes";
import { VOICE_LEVEL, speakWord } from "./voices";

export interface PlayOptions {
  /** World position (positional); omit for 2D UI sounds. */
  pos?: Vec3Like;
  /** 0..2 (1 = default). */
  volume?: number;
  /** Playback-rate / pitch multiplier (1 = default). */
  pitch?: number;
  /** Seconds from now. */
  delay?: number;
  /** loop() only: the loop's 0..1 parameter (charge, fire size, intensity, speed, progress…). Default 0.5. */
  param?: number;
}

export interface AmbienceFrame {
  /** 0 (night) .. 1 (noon). */
  daylight: number;
  weather: Weather;
  /** 0..1 how close the listener is to the shore. */
  sea: number;
  /** Monsters alive (drum tempo / density). */
  monsters: number;
  /** 0..1 storm build-up. */
  storm: number;
  /** Listener is underwater / swimming (low-pass). */
  underwater: boolean;
}

/** Simultaneous one-shot voices before the oldest is stolen. */
const MAX_VOICES = 40;
/** Simultaneous explicit loops (6 players × charge / swim / fuse / reel / channel + sites). */
const MAX_LOOPS = 24;
/** Same sound re-triggered within this window is dropped (one frame of duplicate events). */
const RETRIGGER_GAP = 0.025;
/** Each already-playing copy of a sound attenuates the next one by this factor. */
const SAME_KEY_FALLOFF = 0.8;
const PITCH_JITTER = 0.04;
/** Small scheduling offset so a sound never starts "in the past" (clipped attack). */
const START_DELAY = 0.005;
const LOOP_FADE = 0.12;
/** Ticker period and scheduling lookahead (s); background tabs get a longer lookahead. */
const TICK_MS = 25;
const LOOKAHEAD = 0.15;
const HIDDEN_LOOKAHEAD = 1.6;
const RADIO_TAU = 0.25;
/** Ambience fades out when setAmbience() hasn't been called for this long (left the match view). */
const AMBIENCE_STALE_SEC = 1.5;
const UNDERWATER_TAU = 0.12;
/** Music level while ducked by duck(). */
const DUCK_LEVEL = 0.3;
/** Defaults mirror app/settings DEFAULT_SETTINGS (used until the store is read). */
const DEFAULT_VOLUMES = { master: 0.8, music: 0.5, sfx: 0.9, muted: false };

const AMBIENCE_BEDS: ReadonlySet<LoopName> = new Set<LoopName>(["waves", "wind", "gulls", "crickets", "rain", "storm", "drums"]);

interface ActiveLoop {
  name: LoopName;
  voice: LoopVoice;
  out: GainNode;
  panner: PannerNode | null;
}

interface RadioChain {
  input: GainNode;
  flat: GainNode;
  directional: GainNode;
  panner: PannerNode;
  lowpass: BiquadFilterNode;
  highpass: BiquadFilterNode;
  level: GainNode;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: EngineGraph | null = null;
  private music: MusicCore | null = null;
  private radioChain: RadioChain | null = null;
  private ambience: AmbienceMixer | null = null;
  private ticker: Ticker | null = null;
  private readonly pool = new VoicePool(MAX_VOICES);
  private readonly loops = new Map<string, ActiveLoop>();
  private volumes = { ...DEFAULT_VOLUMES };
  private mood: MusicMood = "off";
  private musicSeed = 0;
  private radio: Vec3Like | null = null;
  private readonly listener = { x: 0, y: 0, z: 0 };
  private readonly forward = { x: 0, y: 0, z: -1 };
  private ambienceFrame: AmbienceFrame = { daylight: 1, weather: "clear", sea: 0.3, monsters: 0, storm: 0, underwater: false };
  private ambienceAge = Infinity;
  private underwater = false;
  private hrtf = true;
  private lookahead = LOOKAHEAD;
  private unavailable = false;
  private disposed = false;
  private readonly unsubscribe: () => void;

  constructor(settings: SettingsStore) {
    const s = settings.get();
    this.volumes = { master: s.masterVolume, music: s.musicVolume, sfx: s.sfxVolume, muted: s.muted };
    this.unsubscribe = settings.onChange((next, changed) => {
      if (changed.some((k) => k === "masterVolume" || k === "musicVolume" || k === "sfxVolume" || k === "muted")) {
        this.volumes = { master: next.masterVolume, music: next.musicVolume, sfx: next.sfxVolume, muted: next.muted };
        this.applyVolumes();
      }
    });
    if (typeof document !== "undefined") document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Resume the AudioContext (call from the first user gesture). */
  unlock(): void {
    if (this.disposed || this.unavailable) return;
    const ctx = this.ctx ?? this.create();
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    ctx.resume().catch(() => {
      // Not allowed yet (no gesture): the next unlock() retries.
    });
  }

  setListener(pos: Vec3Like, forward: Vec3Like): void {
    if (!isFiniteVec(pos) || !isFiniteVec(forward)) return;
    this.listener.x = pos.x;
    this.listener.y = pos.y;
    this.listener.z = pos.z;
    this.forward.x = forward.x;
    this.forward.y = forward.y;
    this.forward.z = forward.z;
    if (this.ctx) setListenerPose(this.ctx.listener, pos, forward);
  }

  play(name: SfxName, opts?: PlayOptions): void {
    const def = SFX_DEFS[name];
    const recipe = SFX_RECIPES[name];
    if (!def || !recipe) return;
    const ctx = this.runningContext();
    const graph = this.graph;
    if (!ctx || !graph) return;
    const bus = def.bus === "ui" ? graph.ui : graph.sfx;
    this.spawn(ctx, name, def.cap, sfxGain(name) * clampVolume(opts?.volume ?? 1), bus, def.positional ? opts?.pos : undefined, opts, recipe);
  }

  /** Start (or update the position / volume / pitch of) a continuous sound identified by `key`. */
  loop(key: string, name: LoopName, opts?: PlayOptions): void {
    const ctx = this.runningContext();
    const graph = this.graph;
    if (!ctx || !graph) return;
    const now = ctx.currentTime;
    let active = this.loops.get(key);
    if (active && active.name !== name) {
      this.stopLoop(key);
      active = undefined;
    }
    if (!active) {
      if (this.loops.size >= MAX_LOOPS) return;
      const out = ctx.createGain();
      out.gain.value = LOOP_LEVEL[name] * clampVolume(opts?.volume ?? 1);
      const pos = opts?.pos && isFiniteVec(opts.pos) ? opts.pos : null;
      const panner = pos ? createPanner(ctx, pos, this.hrtf) : null;
      const bus = AMBIENCE_BEDS.has(name) ? graph.ambience : graph.sfx;
      if (panner) out.connect(panner).connect(bus);
      else out.connect(bus);
      const voice = createLoop(ctx, name, out, now + START_DELAY, opts?.param ?? 0.5);
      voice.onEnded = () => {
        safeDisconnect(out);
        if (panner) safeDisconnect(panner);
      };
      active = { name, voice, out, panner };
      this.loops.set(key, active);
    } else {
      if (opts?.volume !== undefined) active.out.gain.setTargetAtTime(LOOP_LEVEL[name] * clampVolume(opts.volume), now, 0.05);
      if (opts?.pos && active.panner) setPannerPosition(active.panner, opts.pos);
    }
    if (opts?.param !== undefined) active.voice.setParam(opts.param, now);
    if (opts?.pitch !== undefined) active.voice.setPitch(opts.pitch, now);
    active.voice.tick(now, now + this.lookahead);
  }

  stopLoop(key: string): void {
    const active = this.loops.get(key);
    if (!active) return;
    this.loops.delete(key);
    const ctx = this.ctx;
    if (ctx) active.voice.stop(ctx.currentTime, LOOP_FADE);
  }

  voice(character: CharacterId, kind: VoiceKind, pos?: Vec3Like): void {
    const ctx = this.runningContext();
    const graph = this.graph;
    if (!ctx || !graph) return;
    // One mouth per tourist: a new line cuts off that tourist's previous one.
    this.spawn(ctx, `voice:${character}`, 1, VOICE_LEVEL, graph.voice, pos, { pitch: 1 }, (s) => void speakWord(s, character, kind), true);
  }

  setMusic(mood: MusicMood): void {
    if (mood === this.mood) return;
    const previous = this.mood;
    this.mood = mood;
    const music = this.music;
    if (!music) return;
    if ((mood === "win" || mood === "lose") && previous !== mood && this.runningContext()) music.jingle(mood);
    music.play(songForMood(mood));
    this.wake();
  }

  /** Emekli Amca's radio position (music source), or null (music plays flat, e.g. no Amca in the match / menus). */
  setRadio(pos: Vec3Like | null): void {
    this.radio = pos && isFiniteVec(pos) ? { x: pos.x, y: pos.y, z: pos.z } : null;
  }

  setAmbience(a: AmbienceFrame): void {
    this.ambienceFrame = a;
    this.ambienceAge = 0;
  }

  /** Lower the music for `seconds` (banners, boss entry). */
  duck(seconds: number): void {
    this.music?.duck(DUCK_LEVEL, seconds);
    this.wake();
  }

  update(dt: number): void {
    const ctx = this.ctx;
    const graph = this.graph;
    if (!ctx || !graph || this.disposed) return;
    const now = ctx.currentTime;
    this.updateRadio(now);
    this.ambienceAge += Math.max(0, dt);
    const ambienceOn = this.ambienceAge < AMBIENCE_STALE_SEC;
    const under = ambienceOn && this.ambienceFrame.underwater;
    if (under !== this.underwater) {
      this.underwater = under;
      graph.world.frequency.cancelScheduledValues(now);
      graph.world.frequency.setTargetAtTime(belowNyquist(ctx, under ? WORLD_UNDERWATER_HZ : WORLD_OPEN_HZ), now, UNDERWATER_TAU);
    }
    if (this.ambience) {
      const suppressed = new Set<LoopName>();
      for (const l of this.loops.values()) if (AMBIENCE_BEDS.has(l.name)) suppressed.add(l.name);
      this.ambience.setEnabled(ambienceOn);
      this.ambience.set(this.ambienceFrame, this.mood, suppressed);
      this.ambience.update(Math.max(0, dt), now + this.lookahead);
    }
    for (const l of this.loops.values()) l.voice.tick(now, now + this.lookahead);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    if (typeof document !== "undefined") document.removeEventListener("visibilitychange", this.onVisibility);
    const ctx = this.ctx;
    for (const key of [...this.loops.keys()]) this.stopLoop(key);
    this.ticker?.dispose();
    this.ticker = null;
    this.ambience?.dispose();
    this.ambience = null;
    this.music?.dispose();
    this.music = null;
    if (ctx) this.pool.clear(ctx.currentTime);
    if (this.radioChain) for (const n of Object.values(this.radioChain)) safeDisconnect(n);
    this.radioChain = null;
    if (this.graph) disposeGraph(this.graph);
    this.graph = null;
    this.ctx = null;
    ctx?.close().catch(() => {
      // Already closed.
    });
  }

  /* ------------------------------------------------- extras (app / dev harness) */

  /** Island seed → the island's own tune (key, chords, motifs). Call on every new island. */
  setMusicSeed(seed: number): void {
    const s = Number.isFinite(seed) ? seed >>> 0 : 0;
    if (s === this.musicSeed && this.music?.songBook) return;
    this.musicSeed = s;
    this.music?.setBook(composeSongBook(s));
  }

  /** Spatialization quality: HRTF (default) or cheaper equal-power panning (low quality). */
  setSpatialQuality(hrtf: boolean): void {
    this.hrtf = hrtf;
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  /** The live context once unlocked (meters, debugging). */
  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  /** Post-limiter node (tap it with an AnalyserNode for meters). */
  get outputNode(): AudioNode | null {
    return this.graph?.output ?? null;
  }

  get activeVoices(): number {
    return this.pool.size;
  }

  get activeLoops(): number {
    return this.loops.size + (this.ambience?.activeBeds ?? 0);
  }

  get musicMood(): MusicMood {
    return this.mood;
  }

  /** The current radio gain (1 = right next to Amca or no radio). */
  get radioLevel(): number {
    return this.radio ? radioGain(this.radioDistance()) : 1;
  }

  /* ------------------------------------------------------------------ private */

  private create(): AudioContext | null {
    const Ctor = audioContextCtor();
    if (!Ctor) {
      this.unavailable = true;
      return null;
    }
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ latencyHint: "interactive" });
    } catch {
      this.unavailable = true;
      return null;
    }
    this.ctx = ctx;
    const graph = buildGraph(ctx);
    this.graph = graph;
    this.applyVolumes();
    primeOutput(ctx);
    this.radioChain = this.buildRadio(ctx, graph.music);
    this.music = new MusicCore(ctx, this.radioChain.input);
    this.music.setBook(composeSongBook(this.musicSeed));
    this.music.play(songForMood(this.mood));
    this.ambience = new AmbienceMixer(ctx, graph.ambience);
    setListenerPose(ctx.listener, this.listener, this.forward);
    this.ticker = new Ticker(TICK_MS, () => this.pump());
    this.ticker.start();
    this.onVisibility();
    return ctx;
  }

  /** music → [flat | directional panner] → tone (low-pass, high-pass) → distance level → music bus. */
  private buildRadio(ctx: AudioContext, dest: AudioNode): RadioChain {
    const level = ctx.createGain();
    level.connect(dest);
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.frequency.value = 30;
    highpass.Q.value = 0.7;
    highpass.connect(level);
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.frequency.value = belowNyquist(ctx, 16000);
    lowpass.Q.value = 0.8;
    lowpass.connect(highpass);
    const panner = createDirectionalPanner(ctx);
    panner.connect(lowpass);
    const flat = ctx.createGain();
    flat.connect(lowpass);
    const directional = ctx.createGain();
    directional.gain.value = 0;
    directional.connect(panner);
    const input = ctx.createGain();
    input.connect(flat);
    input.connect(directional);
    return { input, flat, directional, panner, lowpass, highpass, level };
  }

  private radioDistance(): number {
    const r = this.radio;
    if (!r) return 0;
    return Math.hypot(r.x - this.listener.x, r.y - this.listener.y, r.z - this.listener.z);
  }

  private updateRadio(now: number): void {
    const chain = this.radioChain;
    if (!chain) return;
    const r = this.radio;
    const d = this.radioDistance();
    const dir = r ? radioDirectional(d) : 0;
    if (r) setPannerPosition(chain.panner, r);
    chain.flat.gain.setTargetAtTime(1 - dir, now, RADIO_TAU);
    chain.directional.gain.setTargetAtTime(dir, now, RADIO_TAU);
    chain.level.gain.setTargetAtTime(r ? radioGain(d) : 1, now, RADIO_TAU);
    chain.lowpass.frequency.setTargetAtTime(belowNyquist(chain.lowpass.context, r ? radioToneHz(d) : 16000), now, RADIO_TAU);
    chain.highpass.frequency.setTargetAtTime(r ? radioLowCutHz(d) : 30, now, RADIO_TAU);
  }

  /** Ticker: keep music / beds / loop events scheduled even between frames (and in background tabs). */
  private pump(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed) return;
    const horizon = ctx.currentTime + this.lookahead;
    this.music?.pump(horizon);
    this.ambience?.tick(horizon);
    for (const l of this.loops.values()) l.voice.tick(ctx.currentTime, horizon);
  }

  private wake(): void {
    this.ticker?.start();
    this.pump();
  }

  /**
   * The context when sounds can start now. A suspended context would queue them and burst them on resume, so
   * before unlock (or while the OS holds audio) everything is a silent no-op.
   */
  private runningContext(): AudioContext | null {
    const ctx = this.ctx;
    return ctx && ctx.state === "running" ? ctx : null;
  }

  private applyVolumes(): void {
    const ctx = this.ctx;
    const g = this.graph;
    if (!ctx || !g) return;
    const now = ctx.currentTime;
    const sfx = sliderToGain(this.volumes.sfx);
    rampGain(g.master.gain, this.volumes.muted ? 0 : sliderToGain(this.volumes.master), now);
    rampGain(g.music.gain, sliderToGain(this.volumes.music), now);
    rampGain(g.sfx.gain, sfx, now);
    rampGain(g.voice.gain, sfx, now);
    rampGain(g.ambience.gain, sfx, now);
    rampGain(g.ui.gain, sfx, now);
  }

  private spawn(
    ctx: AudioContext,
    key: string,
    cap: number,
    volume: number,
    bus: AudioNode,
    pos: Vec3Like | undefined,
    opts: PlayOptions | undefined,
    recipe: (s: Synth) => void,
    exactPitch = false,
  ): void {
    const now = ctx.currentTime;
    const delay = Math.max(0, Math.min(10, opts?.delay ?? 0));
    const same = this.pool.admit(key, cap, now + delay, RETRIGGER_GAP);
    if (same < 0) return;
    const out = ctx.createGain();
    out.gain.value = clampVolume(volume) * SAME_KEY_FALLOFF ** same;
    const chain: AudioNode[] = [out];
    if (pos && isFiniteVec(pos)) {
      const panner = createPanner(ctx, pos, this.hrtf);
      out.connect(panner).connect(bus);
      chain.push(panner);
    } else {
      out.connect(bus);
    }
    const synth = new Synth(ctx, out, now + START_DELAY + delay, pitchOf(opts, exactPitch));
    recipe(synth);
    this.pool.add({ key, startedAt: now + delay, endsAt: synth.endTime, output: out, chain, sources: synth.sources }, synth.finalSource);
  }

  private readonly onVisibility = (): void => {
    if (typeof document === "undefined") return;
    this.lookahead = document.visibilityState === "hidden" ? HIDDEN_LOOKAHEAD : LOOKAHEAD;
    this.pump();
  };
}

function pitchOf(opts: PlayOptions | undefined, exact: boolean): number {
  const base = opts?.pitch !== undefined && Number.isFinite(opts.pitch) && opts.pitch > 0 ? opts.pitch : 1;
  if (exact) return base;
  return base * (1 + (Math.random() * 2 - 1) * PITCH_JITTER);
}

function clampVolume(v: number): number {
  return Number.isFinite(v) ? Math.min(2, Math.max(0, v)) : 0;
}

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/** iOS only fully opens the output after something plays inside the unlocking gesture. */
function primeOutput(ctx: AudioContext): void {
  const src = ctx.createBufferSource();
  src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
  src.connect(ctx.destination);
  src.start();
  src.addEventListener("ended", () => safeDisconnect(src), { once: true });
}
