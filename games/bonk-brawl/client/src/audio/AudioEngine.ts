// Web Audio engine: buses, positional one-shots, loops, voices, music. Owner: client-audio.

import { CHARACTERS } from "../../../shared/constants";
import type { CharacterId, Vec3Like } from "../../../shared/types";
import { buildGraph, disposeGraph, rampGain, sliderToGain, type EngineGraph } from "./engine/graph";
import { createPanner, setListenerPose, setPannerPosition } from "./engine/spatial";
import { VoicePool } from "./engine/VoicePool";
import { Music, type Jingle, type MusicTrack } from "./Music";
import { ANNOUNCER_FILES, SFX, type AnnouncerLine, type LoopId, type SfxBus, type SfxId, type VoiceKind } from "./Sfx";
import { SampleBank } from "./SampleBank";
import { Synth, safeDisconnect } from "./synth/dsp";
import { LOOP_LEVEL, createLoop } from "./synth/loops";
import { SFX_RECIPES, sfxGain } from "./synth/sfxRecipes";
import { VOICE_LEVEL, synthVoice } from "./synth/voices";

export interface PlayOptions {
  /** World position → PannerNode (HRTF on high quality, equalpower otherwise), distance model inverse, ref 3 m, max 40 m. */
  pos?: Vec3Like;
  /** Gain multiplier (default 1). */
  volume?: number;
  /** Playback-rate / pitch multiplier (default 1, with ±4% random variation unless exact). */
  pitch?: number;
  exactPitch?: boolean;
}

export interface LoopHandle {
  /** 0..1 loop parameter (charge amount, speed). */
  setParam(value: number): void;
  setPosition(pos: Vec3Like): void;
  /** Fade out and release (default 0.08 s). Safe to call twice. */
  stop(fadeSec?: number): void;
}

/** Simultaneous one-shot voices (all sounds) before the oldest is stolen. */
const MAX_VOICES = 32;
/** Simultaneous loops (up to 8 players × charge + zoomies + slide fits). */
const MAX_LOOPS = 12;
/** Same sound re-triggered within this window is dropped (one frame of duplicate events). */
const RETRIGGER_GAP = 0.025;
/** Each already-playing copy of a sound attenuates the next one by this factor. */
const SAME_KEY_FALLOFF = 0.8;
const DEFAULT_CAP = 3;
const PITCH_JITTER = 0.04;
/** Small scheduling offset so a sound never starts "in the past" (clipped attack). */
const START_DELAY = 0.005;
const DEFAULT_LOOP_FADE = 0.08;
/** Pitch factor at time scale 0+ (slow-mo bends sfx down toward this, never further). */
const SLOWMO_PITCH_FLOOR = 0.7;
/** Defaults mirror app/settings DEFAULT_SETTINGS (audio may only import shared/). */
const DEFAULT_VOLUMES = { master: 0.8, music: 0.5, sfx: 0.9 };

/** Per-sound concurrency caps (default 3). Long or "announcer" sounds get 1–2. */
const SFX_CAPS: Partial<Record<SfxId, number>> = {
  bounce: 5,
  squeak: 2,
  throw: 4,
  jump: 4,
  land: 4,
  bonk: 4,
  crowdOoh: 1,
  ding: 2,
  slideWhistle: 2,
  ballDrop: 2,
  powerUpWarning: 1,
  powerUpSparkle: 1,
  powerUpPickup: 2,
  ringShake: 2,
  crumbleRumble: 2,
  countdownTick: 1,
  countdownGo: 1,
  suddenDeath: 1,
  uiHover: 2,
  uiClick: 2,
};

const NOOP_LOOP: LoopHandle = Object.freeze({
  setParam() {},
  setPosition() {},
  stop() {},
});

type Recipe = (s: Synth) => void;

interface Spawn {
  key: string;
  cap: number;
  volume: number;
  bus: SfxBus;
  pos: Vec3Like | undefined;
  opts: PlayOptions | undefined;
  recipe: Recipe;
  sampleName?: string | null;
}

/**
 * Graph: sources → (sfx | ui) bus → master → destination; music → music bus → master.
 * Volumes from settings (master/music/sfx; ui bus follows sfx). Everything is synthesized at
 * play time (oscillators, noise buffers, envelopes) — cache noise buffers. Before unlock() (no
 * user gesture yet) every call is a silent no-op; nothing throws if Web Audio is unavailable.
 * Listener follows the camera (setListener each frame).
 * Character voices: CharacterDef.voice preset (quack, ribbit, grumble, meow, squawk, bleat) with
 * a VoiceKind variant (pitch/length/emotion), positional.
 */
export class AudioEngine {
  private ctx: AudioContext | null = null;
  private graph: EngineGraph | null = null;
  private music: Music | null = null;
  private readonly pool = new VoicePool(MAX_VOICES);
  private readonly bank = new SampleBank();
  private announcerSource: AudioBufferSourceNode | null = null;
  private readonly loops = new Set<LoopHandle>();
  private volumes = { ...DEFAULT_VOLUMES };
  private desiredTrack: MusicTrack = "none";
  private tempo = 1;
  private hrtf = true;
  private bendCents = 0;
  private unavailable = false;
  private disposed = false;

  /** Create/resume the AudioContext. Call from user gestures (first click/key); idempotent. */
  unlock(): void {
    if (this.disposed || this.unavailable) return;
    const ctx = this.ctx ?? this.create();
    if (!ctx || ctx.state === "running" || ctx.state === "closed") return;
    ctx.resume().catch(() => {
      // Not allowed yet (no gesture): the next unlock() retries.
    });
  }

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === "running";
  }

  setVolumes(master: number, music: number, sfx: number): void {
    this.volumes = { master, music, sfx };
    this.applyVolumes();
  }

  /** Listener pose (camera position + forward). */
  setListener(pos: Vec3Like, forward: Vec3Like): void {
    if (this.ctx && this.graph) setListenerPose(this.ctx.listener, pos, forward);
  }

  play(id: SfxId, opts?: PlayOptions): void {
    const def = SFX[id];
    const recipe = SFX_RECIPES[id];
    if (!def || !recipe) return;
    this.spawn({
      key: id,
      cap: SFX_CAPS[id] ?? DEFAULT_CAP,
      volume: sfxGain(id) * (opts?.volume ?? 1),
      bus: def.bus,
      pos: def.positional ? opts?.pos : undefined,
      opts,
      recipe,
      sampleName: this.bank.pickSfx(id),
    });
  }

  voice(character: CharacterId, kind: VoiceKind, opts?: PlayOptions): void {
    const preset = CHARACTERS[character]?.voice;
    if (!preset) return;
    // One mouth per animal: a new line cuts off that animal's previous one.
    this.spawn({
      key: `voice:${character}`,
      cap: 1,
      volume: VOICE_LEVEL * (opts?.volume ?? 1),
      bus: "sfx",
      pos: opts?.pos,
      opts,
      recipe: (s) => void synthVoice(s, preset, kind),
    });
  }

  /** Play one short arena-announcer line. A new line cuts the previous one. */
  announce(line: AnnouncerLine): void {
    const ctx = this.runningContext();
    const graph = this.graph;
    if (!ctx || !graph) return;
    const previous = this.announcerSource;
    if (previous) {
      this.announcerSource = null;
      try {
        previous.stop();
      } catch {
        /* already ended */
      }
    }
    const out = ctx.createGain();
    out.gain.value = 0.9;
    out.connect(graph.ui);
    const started = this.bank.startVoice(ANNOUNCER_FILES[line], ctx, out, ctx.currentTime + START_DELAY);
    if (!started) {
      safeDisconnect(out);
      return;
    }
    this.announcerSource = started.source;
    started.source.addEventListener(
      "ended",
      () => {
        safeDisconnect(out);
        if (this.announcerSource === started.source) this.announcerSource = null;
      },
      { once: true },
    );
  }

  /** Returns a handle even before unlock (a no-op handle). */
  startLoop(id: LoopId, opts?: PlayOptions): LoopHandle {
    const ctx = this.runningContext();
    const graph = this.graph;
    if (!ctx || !graph || this.loops.size >= MAX_LOOPS) return NOOP_LOOP;
    const now = ctx.currentTime;
    const out = ctx.createGain();
    out.gain.value = LOOP_LEVEL[id] * clampVolume(opts?.volume ?? 1);
    const panner = opts?.pos ? createPanner(ctx, opts.pos, this.hrtf) : null;
    if (panner) out.connect(panner).connect(graph.sfx);
    else out.connect(graph.sfx);

    const voice = createLoop(ctx, id, out, now + START_DELAY, graph.bend);
    let stopped = false;
    const handle: LoopHandle = {
      setParam: (value) => voice.setParam(value, ctx.currentTime),
      setPosition: (pos) => {
        if (panner && !stopped) setPannerPosition(panner, pos);
      },
      stop: (fadeSec = DEFAULT_LOOP_FADE) => {
        if (stopped) return;
        stopped = true;
        this.loops.delete(handle);
        voice.stop(ctx.currentTime, fadeSec);
      },
    };
    voice.onEnded = () => {
      safeDisconnect(out);
      if (panner) safeDisconnect(panner);
    };
    this.loops.add(handle);
    return handle;
  }

  playMusic(track: MusicTrack): void {
    this.desiredTrack = track;
    this.music?.play(track);
  }

  setMusicTempo(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    this.tempo = scale;
    this.music?.setTempo(scale);
  }

  jingle(kind: Jingle): void {
    // A jingle queued on a suspended context would fire late, out of context: drop it.
    if (this.runningContext()) this.music?.jingle(kind);
  }

  /** Global slow-mo pitch bend for sfx (Feel.timeScale), 1 = normal. */
  setTimeScale(scale: number): void {
    const bend = this.graph?.bend;
    // 0 is a hit-stop freeze frame: the BONK that caused it must not drop in pitch.
    if (!this.ctx || !bend || !(scale > 0)) return;
    const s = Math.min(1, scale);
    const target = s >= 1 ? 0 : 1200 * Math.log2(SLOWMO_PITCH_FLOOR + (1 - SLOWMO_PITCH_FLOOR) * s);
    if (Math.abs(target - this.bendCents) < 1) return;
    // Drop into slow-mo quickly, ease back out of it.
    const tau = target < this.bendCents ? 0.03 : 0.12;
    this.bendCents = target;
    bend.offset.cancelScheduledValues(this.ctx.currentTime);
    bend.offset.setTargetAtTime(target, this.ctx.currentTime, tau);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const loop of [...this.loops]) loop.stop(0.02);
    this.music?.dispose();
    this.music = null;
    const ctx = this.ctx;
    if (ctx) this.pool.clear(ctx.currentTime);
    if (this.graph) disposeGraph(this.graph);
    this.graph = null;
    this.ctx = null;
    ctx?.close().catch(() => {
      // Already closed.
    });
  }

  /* ------------------------------------------------- extras (harness / integrator) */

  /** Spatialization quality: HRTF (default, best front/back cues) or cheaper equal-power panning. */
  setSpatialQuality(hrtf: boolean): void {
    this.hrtf = hrtf;
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
    return this.loops.size;
  }

  get musicTrack(): MusicTrack {
    return this.music?.track ?? "none";
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
    this.graph = buildGraph(ctx);
    this.applyVolumes();
    primeOutput(ctx);
    this.music = new Music(ctx, this.graph.music);
    this.music.setTempo(this.tempo);
    this.music.play(this.desiredTrack);
    this.bank.prime(ctx);
    void this.bank.startAmbience(ctx, this.graph.sfx);
    return ctx;
  }

  /**
   * The context when sounds can start now. A suspended context would queue them and burst them
   * on resume, so before unlock (or while the OS holds audio) everything is a silent no-op.
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
    rampGain(g.master.gain, sliderToGain(this.volumes.master), now);
    rampGain(g.music.gain, sliderToGain(this.volumes.music), now);
    rampGain(g.sfx.gain, sfx, now);
    rampGain(g.ui.gain, sfx, now);
  }

  private spawn(sp: Spawn): void {
    const ctx = this.runningContext();
    const graph = this.graph;
    if (!ctx || !graph) return;
    const now = ctx.currentTime;
    const same = this.pool.admit(sp.key, sp.cap, now, RETRIGGER_GAP);
    if (same < 0) return;

    const out = ctx.createGain();
    out.gain.value = clampVolume(sp.volume) * SAME_KEY_FALLOFF ** same;
    const chain: AudioNode[] = [out];
    const bus = sp.bus === "ui" ? graph.ui : graph.sfx;
    if (sp.pos) {
      const panner = createPanner(ctx, sp.pos, this.hrtf);
      out.connect(panner).connect(bus);
      chain.push(panner);
    } else {
      out.connect(bus);
    }

    const start = now + START_DELAY;
    const pitch = pitchOf(sp.opts);
    const sample = sp.sampleName ? this.bank.startSfx(sp.sampleName, ctx, out, start, pitch, sp.bus === "ui" ? null : graph.bend) : null;
    if (sample) {
      this.pool.add(
        { key: sp.key, startedAt: now, endsAt: sample.endTime, output: out, chain, sources: [sample.source] },
        sample.source,
      );
      return;
    }

    const bend = sp.bus === "ui" ? null : graph.bend;
    const synth = new Synth(ctx, out, start, pitch, bend);
    sp.recipe(synth);
    this.pool.add(
      { key: sp.key, startedAt: now, endsAt: synth.endTime, output: out, chain, sources: synth.sources },
      synth.finalSource,
    );
  }
}

function pitchOf(opts: PlayOptions | undefined): number {
  const base = opts?.pitch !== undefined && Number.isFinite(opts.pitch) && opts.pitch > 0 ? opts.pitch : 1;
  if (opts?.exactPitch) return base;
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
