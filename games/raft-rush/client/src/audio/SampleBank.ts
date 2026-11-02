// ElevenLabs-generated sound files, loaded alongside the procedural synth. The bank is deliberately optional:
// every lookup falls back to the existing Web Audio recipe / loop until a file has decoded, so a slow network,
// a missing manifest or an offline build sounds exactly like the original game. Owner: client-fx-audio.
//
// Files live in client/public/audio/raft-rush/ and are produced by scripts/generate-raft-sfx.mjs. Loops are marked
// in the manifest and requested from ElevenLabs with loop=true; one-shots are decoded lazily but warmed in the
// background after the audio context exists.

import { LOOP_NAMES, SFX_NAMES, type LoopName, type SfxName } from "./Sfx";
import { safeDisconnect } from "./synth/dsp";
import type { LoopVoice } from "./synth/loops";

interface ManifestEntry {
  file: string;
  duration?: number;
  hash?: string;
}

interface Manifest {
  version: number;
  sfx?: Record<string, ManifestEntry>;
  loops?: Record<string, ManifestEntry>;
}

interface StartResult {
  source: AudioBufferSourceNode;
  endTime: number;
}

/** Loop speed range at parameter 0 and 1. Pitch is multiplied on top. */
const LOOP_RATE: Readonly<Record<LoopName, readonly [number, number]>> = {
  charge: [0.62, 1.48],
  fire: [0.94, 1.06],
  rain: [0.98, 1.03],
  waves: [0.95, 1.06],
  crickets: [0.98, 1.02],
  gulls: [0.98, 1.03],
  wind: [0.93, 1.1],
  drums: [0.82, 1.28],
  swim: [0.82, 1.22],
  fuse: [0.9, 1.34],
  reel: [0.9, 1.18],
  storm: [0.94, 1.09],
  channel: [0.95, 1.12],
};

const PARAM_TAU = 0.06;
const FADE_IN = 0.1;
/** Generated one-shots are peak-normalized; beds are RMS-normalized with a peak ceiling so nothing clips. */
const SFX_PEAK = 0.8;
const LOOP_RMS = 0.045;
const LOOP_PEAK = 0.85;

function baseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL || "/games/raft-rush/";
  return `${base.replace(/\/?$/, "/")}audio/raft-rush/`;
}

function absolute(relative: string): string {
  try {
    return new URL(relative, new URL(baseUrl(), document.baseURI)).href;
  } catch {
    return `${baseUrl()}${relative}`;
  }
}

function decode(ctx: BaseAudioContext, data: ArrayBuffer): Promise<AudioBuffer | null> {
  return new Promise((resolve) => {
    try {
      const maybe = ctx.decodeAudioData(
        data,
        (buffer) => resolve(buffer),
        () => resolve(null),
      );
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

function normalize(buffer: AudioBuffer, kind: "sfx" | "loop"): void {
  let peak = 0;
  let sumSq = 0;
  let count = 0;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = data[i]!;
      const a = Math.abs(v);
      if (a > peak) peak = a;
      sumSq += v * v;
      count++;
    }
  }
  if (peak < 1e-6 || count === 0) return;
  const rms = Math.sqrt(sumSq / count);
  const gain = kind === "sfx" ? SFX_PEAK / peak : Math.min(LOOP_RMS / Math.max(1e-6, rms), LOOP_PEAK / peak);
  if (!Number.isFinite(gain) || gain <= 0.001) return;
  for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch);
    for (let i = 0; i < data.length; i++) data[i] = data[i]! * gain;
  }
}

export class SampleBank {
  private manifestPromise: Promise<Manifest | null> | null = null;
  private readonly buffers = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();
  private readonly failed = new Set<string>();
  private primed = false;

  constructor() {
    if (typeof fetch !== "function" || typeof document === "undefined") return;
    this.manifestPromise = this.fetchManifest();
  }

  /** Begin background downloads/decodes for loops first, then every one-shot. Safe to call more than once. */
  prime(ctx: AudioContext): void {
    if (this.primed) return;
    this.primed = true;
    void (async () => {
      const manifest = await this.manifestPromise;
      if (!manifest) return;
      await this.warm(ctx, [...LOOP_NAMES].map((name) => ["loop", name] as const));
      await this.warm(ctx, [...SFX_NAMES].map((name) => ["sfx", name] as const));
    })();
  }

  /** True once the generated loop is decoded and can replace a running synth loop. */
  hasLoop(name: LoopName): boolean {
    return this.buffers.has(`loop:${name}`);
  }

  /** Start a generated one-shot. Returns null when the file is not ready yet (the caller keeps the synth). */
  startSfx(name: SfxName, ctx: AudioContext, out: AudioNode, when: number, rate: number): StartResult | null {
    const buffer = this.buffers.get(`sfx:${name}`);
    if (!buffer) {
      void this.ensureSfx(name, ctx);
      return null;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    source.connect(out);
    source.start(when);
    return { source, endTime: when + buffer.duration / Math.max(0.01, rate) };
  }

  /** Start a generated loop. Returns null when the file is not ready yet (the caller keeps the synth). */
  startLoop(name: LoopName, ctx: AudioContext, out: AudioNode, start: number, initial: number): LoopVoice | null {
    const buffer = this.buffers.get(`loop:${name}`);
    if (!buffer) {
      void this.ensureLoop(name, ctx);
      return null;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const fade = ctx.createGain();
    fade.gain.setValueAtTime(0, start);
    fade.gain.linearRampToValueAtTime(1, start + FADE_IN);
    source.connect(fade).connect(out);

    let param = Math.min(1, Math.max(0, Number.isFinite(initial) ? initial : 0.5));
    let pitch = 1;
    let stopped = false;
    const [lo, hi] = LOOP_RATE[name];
    const rateFor = (): number => pitch * (lo + (hi - lo) * param);
    source.playbackRate.setValueAtTime(rateFor(), start);
    source.start(start);

    const voice: LoopVoice = {
      kind: "sample",
      onEnded: null,
      setParam(value, now) {
        if (stopped || !Number.isFinite(value)) return;
        const next = Math.min(1, Math.max(0, value));
        if (Math.abs(next - param) < 0.002) return;
        param = next;
        source.playbackRate.setTargetAtTime(rateFor(), now, PARAM_TAU);
      },
      setPitch(mult, now) {
        if (stopped || !Number.isFinite(mult) || mult <= 0) return;
        pitch = mult;
        source.playbackRate.setTargetAtTime(rateFor(), now, PARAM_TAU);
      },
      tick() {
        /* The buffer is continuous; there are no stochastic events to schedule. */
      },
      stop(now, fadeSeconds) {
        const f = Math.max(0.01, fadeSeconds);
        const end = now + f + 0.03;
        if (stopped) return end;
        stopped = true;
        fade.gain.cancelScheduledValues(now);
        fade.gain.setValueAtTime(fade.gain.value, now);
        fade.gain.linearRampToValueAtTime(0, now + f);
        try {
          source.stop(end);
        } catch {
          /* Already stopped. */
        }
        return end;
      },
    };

    source.addEventListener(
      "ended",
      () => {
        safeDisconnect(source);
        safeDisconnect(fade);
        voice.onEnded?.();
      },
      { once: true },
    );
    return voice;
  }

  private async fetchManifest(): Promise<Manifest | null> {
    try {
      const res = await fetch(absolute("manifest.json"), { cache: "force-cache" });
      if (!res.ok) return null;
      const data = (await res.json()) as Manifest;
      if (!data || data.version !== 1) return null;
      return data;
    } catch {
      return null;
    }
  }

  private async warm(ctx: AudioContext, entries: ReadonlyArray<readonly ["sfx" | "loop", string]>): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = entries[cursor++];
        if (!entry) return;
        const [kind, name] = entry;
        if (kind === "loop") await this.ensureLoop(name as LoopName, ctx);
        else await this.ensureSfx(name as SfxName, ctx);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  private async ensureSfx(name: SfxName, ctx: AudioContext): Promise<AudioBuffer | null> {
    return this.ensureBuffer("sfx", name, ctx);
  }

  private async ensureLoop(name: LoopName, ctx: AudioContext): Promise<AudioBuffer | null> {
    return this.ensureBuffer("loop", name, ctx);
  }

  private async ensureBuffer(kind: "sfx" | "loop", name: string, ctx: AudioContext): Promise<AudioBuffer | null> {
    const key = `${kind}:${name}`;
    const done = this.buffers.get(key);
    if (done) return done;
    if (this.failed.has(key)) return null;
    const pending = this.loading.get(key);
    if (pending) return pending;

    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const manifest = await (this.manifestPromise ?? this.fetchManifest());
        const entry = kind === "sfx" ? manifest?.sfx?.[name] : manifest?.loops?.[name];
        if (!entry?.file) {
          this.failed.add(key);
          return null;
        }
        const res = await fetch(absolute(entry.file), { cache: "force-cache" });
        if (!res.ok) {
          this.failed.add(key);
          return null;
        }
        const buffer = await decode(ctx, await res.arrayBuffer());
        if (buffer) normalize(buffer, kind);
        if (!buffer) {
          this.failed.add(key);
          return null;
        }
        this.buffers.set(key, buffer);
        return buffer;
      } catch {
        this.failed.add(key);
        return null;
      } finally {
        this.loading.delete(key);
      }
    })();
    this.loading.set(key, job);
    return job;
  }
}
