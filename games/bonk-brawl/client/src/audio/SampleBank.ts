// ElevenLabs-generated audio for Bonk Brawl, layered over the procedural Web Audio engine.
// The bank is optional: every lookup falls back to the existing synth recipe when a file has not
// decoded yet, so a slow network, a missing manifest or an offline build sounds like the original.
//
// Files live in client/public/audio/bonk-brawl/ and are produced by scripts/generate-bonk-sfx.mjs.
// One-shots are peak-normalized, loops are RMS-normalized with a peak ceiling, and the announcer
// lines are peak-normalized a little hotter because they sit above the crowd bed.

import { bendSource } from "./synth/dsp";

export interface ManifestEntry {
  file: string;
  duration?: number;
  hash?: string;
  text?: string;
}

interface Manifest {
  version: number;
  sfx?: Record<string, ManifestEntry>;
  loops?: Record<string, ManifestEntry>;
  voices?: Record<string, ManifestEntry>;
}

export interface StartResult {
  source: AudioBufferSourceNode;
  endTime: number;
}

const SFX_PEAK = 0.85;
const LOOP_RMS = 0.045;
const LOOP_PEAK = 0.85;
const VOICE_PEAK = 0.95;
const AMBIENCE_LEVEL = 0.18;
const AMBIENCE_FADE = 2.5;

/** Which generated file(s) back a synth id. Bonk cycles three weights so repeated hits vary. */
const SFX_SAMPLES: Readonly<Record<string, readonly string[]>> = {
  bonk: ["bonk1", "bonk2", "bonk3"],
  whiff: ["whiff"],
  ballDrop: ["ballDrop"],
  ko: ["ko"],
  slideWhistle: ["ringOut"],
  countdownTick: ["countdownTick"],
  countdownGo: ["countdownGo"],
  uiClick: ["uiClick"],
  uiConfirm: ["uiConfirm"],
  crowdOoh: ["crowdOoh"],
};

export const AMBIENCE_LOOPS = ["arena", "crowd"] as const;

function baseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL || "/games/bonk-brawl/";
  return `${base.replace(/\/?$/, "/")}audio/bonk-brawl/`;
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

function normalize(buffer: AudioBuffer, kind: "sfx" | "loop" | "voice"): void {
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
  const gain =
    kind === "loop"
      ? Math.min(LOOP_RMS / Math.max(1e-6, rms), LOOP_PEAK / peak)
      : (kind === "voice" ? VOICE_PEAK : SFX_PEAK) / peak;
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

  /** Name of the generated one-shot for a synth id, or null when the id has no file. */
  pickSfx(id: string): string | null {
    const names = SFX_SAMPLES[id];
    if (!names || names.length === 0) return null;
    return names[Math.floor(Math.random() * names.length)] ?? names[0] ?? null;
  }

  /** Begin background downloads/decodes: ambience first, then one-shots, then announcer lines. */
  prime(ctx: AudioContext): void {
    if (this.primed) return;
    this.primed = true;
    void (async () => {
      const manifest = await this.manifestPromise;
      if (!manifest) return;
      await this.warm(ctx, [...AMBIENCE_LOOPS].map((name) => ["loop", name] as const));
      await this.warm(
        ctx,
        Object.values(SFX_SAMPLES)
          .flat()
          .map((name) => ["sfx", name] as const),
      );
      await this.warm(ctx, Object.keys(manifest.voices ?? {}).map((name) => ["voice", name] as const));
    })();
  }

  /** Start a generated one-shot. Returns null when the file is not decoded yet (caller keeps synth). */
  startSfx(name: string, ctx: AudioContext, out: AudioNode, when: number, rate: number, bend: ConstantSourceNode | null = null): StartResult | null {
    return this.start("sfx", name, ctx, out, when, rate, bend);
  }

  /** Start an announcer line. Returns null when the file is not decoded yet. */
  startVoice(name: string, ctx: AudioContext, out: AudioNode, when: number, rate = 1): StartResult | null {
    return this.start("voice", name, ctx, out, when, rate);
  }

  /**
   * Start the continuous arena bed once the files exist. Two source loops feed one bed gain that
   * fades in under the mix; the bed is deliberately quiet so hit/UI cues stay legible.
   */
  async startAmbience(ctx: AudioContext, destination: AudioNode): Promise<void> {
    const manifest = await (this.manifestPromise ?? this.fetchManifest());
    if (!manifest) return;
    const bed = ctx.createGain();
    const now = ctx.currentTime;
    bed.gain.setValueAtTime(0, now);
    bed.gain.linearRampToValueAtTime(AMBIENCE_LEVEL, now + AMBIENCE_FADE);
    bed.connect(destination);
    for (const [name, level] of [["arena", 0.6], ["crowd", 0.5]] as const) {
      const buffer = await this.ensureLoop(name, ctx);
      if (!buffer) continue;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const gain = ctx.createGain();
      gain.gain.value = level;
      source.connect(gain).connect(bed);
      source.start(now);
    }
  }

  private start(
    kind: "sfx" | "voice",
    name: string,
    ctx: AudioContext,
    out: AudioNode,
    when: number,
    rate: number,
    bend: ConstantSourceNode | null = null,
  ): StartResult | null {
    const buffer = this.buffers.get(`${kind}:${name}`);
    if (!buffer) {
      void this.ensureBuffer(kind, name, ctx);
      return null;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    if (bend) bendSource(bend, source);
    source.connect(out);
    source.start(when);
    return { source, endTime: when + buffer.duration / Math.max(0.01, rate) };
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

  private async warm(ctx: AudioContext, entries: ReadonlyArray<readonly ["sfx" | "loop" | "voice", string]>): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const entry = entries[cursor++];
        if (!entry) return;
        await this.ensureBuffer(entry[0], entry[1], ctx);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  private async ensureLoop(name: string, ctx: AudioContext): Promise<AudioBuffer | null> {
    return this.ensureBuffer("loop", name, ctx);
  }

  private async ensureBuffer(
    kind: "sfx" | "loop" | "voice",
    name: string,
    ctx: AudioContext,
  ): Promise<AudioBuffer | null> {
    const key = `${kind}:${name}`;
    const done = this.buffers.get(key);
    if (done) return done;
    if (this.failed.has(key)) return null;
    const pending = this.loading.get(key);
    if (pending) return pending;

    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const manifest = await (this.manifestPromise ?? this.fetchManifest());
        const entry = kind === "sfx" ? manifest?.sfx?.[name] : kind === "loop" ? manifest?.loops?.[name] : manifest?.voices?.[name];
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
