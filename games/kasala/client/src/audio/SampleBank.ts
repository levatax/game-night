// ElevenLabs-generated sound files, loaded alongside the procedural synth. The bank is deliberately optional:
// every lookup falls back to the existing Web Audio recipe until a file has decoded, so a slow network, a
// missing manifest or an offline build sounds exactly like the original game.
//
// Files live in client/public/audio/kasala/ and are produced by scripts/generate-kasala-sfx.mjs. Loops are
// marked in the manifest and requested with loop=true; one-shots are decoded lazily but warmed in the
// background after the audio context exists.

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

/** Generated one-shots are peak-normalized; beds are RMS-normalized with a peak ceiling so nothing clips. */
const SFX_PEAK = 0.78;
const LOOP_RMS = 0.05;
const LOOP_PEAK = 0.85;
const FADE_IN = 1.2;

function baseUrl(): string {
  const env = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env;
  const base = env?.BASE_URL || "/games/kasala/";
  return `${base.replace(/\/?$/, "/")}audio/kasala/`;
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

export interface LoopHandle {
  setGain(value: number, now: number): void;
  stop(now: number): void;
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
      const loops = Object.keys(manifest.loops ?? {});
      const sfx = Object.keys(manifest.sfx ?? {});
      for (const name of loops) await this.loadLoop(name, ctx);
      await this.warmSfx(ctx, sfx);
    })();
  }

  /** Start a generated one-shot. Returns false while the file is not ready (the caller keeps the synth). */
  playSfx(
    name: string,
    ctx: AudioContext,
    out: AudioNode,
    when: number,
    rate: number,
    volume: number,
    pan = 0,
  ): boolean {
    const buffer = this.buffers.get(`sfx:${name}`);
    if (!buffer) {
      void this.ensureSfx(name, ctx);
      return false;
    }
    try {
      const gain = ctx.createGain();
      gain.gain.value = Math.max(0, volume);
      let tail: AudioNode = gain;
      if (Math.abs(pan) > 0.01) {
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        gain.connect(panner);
        tail = panner;
      }
      tail.connect(out);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.playbackRate.value = Math.max(0.25, Math.min(4, rate));
      source.connect(gain);
      source.onended = () => {
        source.disconnect();
        gain.disconnect();
        if (tail !== gain) tail.disconnect();
      };
      source.start(when);
      return true;
    } catch {
      return false;
    }
  }

  /** True once a generated loop is decoded. */
  hasLoop(name: string): boolean {
    return this.buffers.has(`loop:${name}`);
  }

  /** Load (and decode) a generated loop. Resolves null when it is unavailable. */
  async loadLoop(name: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    return this.ensureBuffer("loop", name, ctx);
  }

  /** Start a decoded loop; the caller owns the returned handle. */
  startLoop(buffer: AudioBuffer, ctx: AudioContext, out: AudioNode, initial = 0): LoopHandle {
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const gain = ctx.createGain();
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(Math.max(0, initial), now + FADE_IN);
    source.connect(gain).connect(out);
    source.start(now);
    let stopped = false;
    return {
      setGain(value: number, at: number): void {
        if (stopped) return;
        gain.gain.setTargetAtTime(Math.max(0, value), at, 0.45);
      },
      stop(at: number): void {
        if (stopped) return;
        stopped = true;
        gain.gain.cancelScheduledValues(at);
        gain.gain.setValueAtTime(gain.gain.value, at);
        gain.gain.linearRampToValueAtTime(0, at + 0.8);
        try {
          source.stop(at + 0.85);
        } catch {
          /* already stopped */
        }
      },
    };
  }

  private async warmSfx(ctx: AudioContext, names: readonly string[]): Promise<void> {
    let cursor = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const name = names[cursor++];
        if (!name) return;
        await this.ensureSfx(name, ctx);
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
  }

  private async ensureSfx(name: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
    return this.ensureBuffer("sfx", name, ctx);
  }

  private async ensureBuffer(kind: "sfx" | "loop", name: string, ctx: BaseAudioContext): Promise<AudioBuffer | null> {
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
        if (!buffer) {
          this.failed.add(key);
          return null;
        }
        normalize(buffer, kind);
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
}

type Mode = "off" | "lobby" | "lounge" | "wheel" | "tango" | "victory";

/** Per-mode bed levels, relative to the normalized loop level. */
const BEDS: Record<Mode, Readonly<Record<string, number>>> = {
  off: {},
  lobby: { room: 0.62, rain: 0.16, neon: 0.12 },
  lounge: { room: 0.5, rain: 0.26, neon: 0.1 },
  wheel: { room: 0.32, rain: 0.1, neon: 0.05, crowd: 0.5 },
  tango: { room: 0.24, rain: 0.32, neon: 0.05, crowd: 0.2 },
  victory: { room: 0.58, rain: 0.12, neon: 0.1, crowd: 0.42 },
};

const BED_NAMES = ["room", "rain", "neon", "crowd"] as const;

/**
 * Generated ambience under the procedural jazz: room tone, rain, neon hum and a crowd bed. Routed to the
 * music bus, so the music slider controls it. Missing files simply stay silent.
 */
export class Ambience {
  private mode: Mode = "off";
  private readonly handles = new Map<string, LoopHandle>();
  private readonly ctx: AudioContext;
  private live = false;

  constructor(
    ctx: AudioContext,
    out: AudioNode,
    private readonly bank: SampleBank,
  ) {
    this.ctx = ctx;
    void this.load(ctx, out);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.apply();
  }

  private async load(ctx: AudioContext, out: AudioNode): Promise<void> {
    const buffers = await Promise.all(BED_NAMES.map((name) => this.bank.loadLoop(name, ctx)));
    let any = false;
    BED_NAMES.forEach((name, i) => {
      const buffer = buffers[i];
      if (!buffer) return;
      this.handles.set(name, this.bank.startLoop(buffer, ctx, out, 0));
      any = true;
    });
    this.live = any;
    this.apply();
  }

  private apply(): void {
    if (!this.live) return;
    const now = this.ctx.currentTime;
    const target = BEDS[this.mode];
    for (const [name, handle] of this.handles) handle.setGain(target[name] ?? 0, now);
  }
}
