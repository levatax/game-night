// ElevenLabs voice client for the KASALA announcer.
//
// Asks the hub whether voice synthesis is enabled (`/api/voice/config`), then loads a line from the server-side
// proxy as a decoded AudioBuffer. Everything is best-effort: a disabled proxy, an offline hub, a slow or failed
// request all resolve to null, and the caller keeps its recorded mp3 → browser speech → subtitle fallback chain.
// Decoded buffers are cached in memory (LRU), and identical requests are deduplicated while in flight.

export interface VoiceConfig {
  enabled: boolean;
  game: string | null;
  character: string | null;
  voiceId: string | null;
  modelId: string;
  maxChars: number;
}

const CONFIG_URL = "/api/voice/config";
const TTS_URL = "/api/voice/tts";
const CACHE_MAX = 24;
const REQUEST_TIMEOUT_MS = 8000;

export class ElevenLabsVoice {
  private config: VoiceConfig | null = null;
  private readonly configPromise: Promise<VoiceConfig | null>;
  private readonly cache = new Map<string, AudioBuffer>();
  private readonly loading = new Map<string, Promise<AudioBuffer | null>>();

  constructor(
    private readonly game: string,
    private readonly character?: string,
  ) {
    this.configPromise = this.fetchConfig();
  }

  /** True once the hub answered that synthesis is enabled (false before the answer or when it failed). */
  get enabled(): boolean {
    return !!this.config?.enabled;
  }

  /** Resolves with the hub's answer (or null when the hub can't be reached). */
  ready(): Promise<VoiceConfig | null> {
    return this.configPromise;
  }

  /** Load a line as a decoded AudioBuffer, or null when synthesis is unavailable. */
  async load(ctx: AudioContext, id: string, text: string): Promise<AudioBuffer | null> {
    const cfg = await this.configPromise;
    if (!cfg?.enabled) return null;
    if (!text.trim() || text.length > cfg.maxChars) return null;

    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const pending = this.loading.get(id);
    if (pending) return pending;

    const job = (async (): Promise<AudioBuffer | null> => {
      try {
        const params = new URLSearchParams({ game: this.game, text });
        if (this.character) params.set("character", this.character);
        const res = await fetch(`${TTS_URL}?${params.toString()}`, {
          cache: "force-cache",
          signal: timeoutSignal(),
        });
        if (!res.ok) return null;
        const data = await res.arrayBuffer();
        const buffer = await decode(ctx, data);
        if (!buffer) return null;
        this.cache.set(id, buffer);
        while (this.cache.size > CACHE_MAX) {
          const oldest = this.cache.keys().next().value;
          if (oldest === undefined) break;
          this.cache.delete(oldest);
        }
        return buffer;
      } catch {
        return null;
      } finally {
        this.loading.delete(id);
      }
    })();
    this.loading.set(id, job);
    return job;
  }

  private async fetchConfig(): Promise<VoiceConfig | null> {
    try {
      const params = new URLSearchParams({ game: this.game });
      if (this.character) params.set("character", this.character);
      const res = await fetch(`${CONFIG_URL}?${params.toString()}`, {
        cache: "no-store",
        signal: timeoutSignal(),
      });
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<VoiceConfig>;
      const config: VoiceConfig = {
        enabled: data.enabled === true,
        game: typeof data.game === "string" ? data.game : null,
        character: typeof data.character === "string" ? data.character : null,
        voiceId: typeof data.voiceId === "string" ? data.voiceId : null,
        modelId: typeof data.modelId === "string" ? data.modelId : "eleven_multilingual_v2",
        maxChars: typeof data.maxChars === "number" ? data.maxChars : 1000,
      };
      this.config = config;
      return config;
    } catch {
      return null;
    }
  }
}

function timeoutSignal(): AbortSignal | undefined {
  try {
    return typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
      : undefined;
  } catch {
    return undefined;
  }
}

function decode(ctx: AudioContext, data: ArrayBuffer): Promise<AudioBuffer | null> {
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
