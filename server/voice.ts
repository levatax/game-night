// ElevenLabs text-to-speech proxy for the game clients (currently KASALA's announcer, Cemil Abi).
//
// Optional: the KASALA client ships with pre-rendered mp3s (games/kasala/client/public/audio/spiker), so the
// game works without any voice credentials. This proxy covers lines that have no recorded file yet and lets a
// deployment render voices on demand.
//
// Configuration (environment, never hard-coded):
//   ELEVENLABS_API_KEY        required to enable the proxy; missing → every /tts request answers 204 and the
//                             client falls back to its recorded mp3 / browser speech / subtitle.
//   ELEVENLABS_VOICE_ID       default voice (default: Adam, pNInz6obpgDQGcFmaJgB).
//   ELEVENLABS_VOICE_<GAME>   per-game override, e.g. ELEVENLABS_VOICE_KASALA.
//   ELEVENLABS_VOICE_<GAME>_<CHARACTER>  per-character override (optional `character` query parameter).
//   ELEVENLABS_MODEL_ID       default eleven_v4 (supports audio tags and the room treatment).
//   ELEVENLABS_OUTPUT_FORMAT  default mp3_44100_128.
//   ELEVENLABS_TTS_DISABLED=1 turns the proxy off even when a key is set.
//   VOICE_CACHE_DIR           where rendered mp3s are kept (default .voice-cache next to the process cwd).
//
// The key never leaves this process: clients only see whether the proxy is enabled and the public voice id.
// Rendered audio is cached by a hash of voice + model + format + text, so a line is paid for once no matter
// how many players hear it.

import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { Router } from "express";

/** Adam — deep, low, authoritative; the general default. */
export const DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB";
/** Voice ids chosen per game; KASALA's Cemil Abi uses the Istanbul-accented Adam. */
const GAME_VOICE_IDS: Readonly<Record<string, string>> = {
  kasala: "J17lijyP1BHYcM7ld0Rg",
};
export const DEFAULT_MODEL_ID = "eleven_v4";
const DEFAULT_OUTPUT_FORMAT = "mp3_44100_128";
const MAX_CHARS = 1000;
/** Upstream calls in flight at once: enough for a room joining, gentle enough for ElevenLabs rate limits. */
const UPSTREAM_CONCURRENCY = 3;
const CACHE_DIR = path.resolve(process.env.VOICE_CACHE_DIR ?? ".voice-cache");
const VOICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;
const OUTPUT_FORMAT_PATTERN = /^[a-z0-9_]{3,32}$/;
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,40}$/;

// Local development convenience: pick up a .env file when Node supports it. In production the host sets the
// variables (EasyPanel/Render/Fly…); a missing .env is normal and never fatal.
try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  /* no .env */
}

const apiKey = (): string => (process.env.ELEVENLABS_API_KEY ?? "").trim();
const enabled = (): boolean => process.env.ELEVENLABS_TTS_DISABLED !== "1" && apiKey().length > 0;

const cleanName = (value: unknown): string | undefined =>
  typeof value === "string" && NAME_PATTERN.test(value) ? value : undefined;

const envPart = (value: string): string => value.toUpperCase().replace(/[^A-Z0-9]+/g, "_");

const validVoice = (value: string | undefined): string | undefined =>
  value && VOICE_ID_PATTERN.test(value) ? value : undefined;

/** Voice id for a game/character, from per-character → per-game → global → Adam. */
export function voiceFor(game?: string, character?: string): string {
  if (game) {
    const g = envPart(game);
    if (character) {
      const specific = validVoice(process.env[`ELEVENLABS_VOICE_${g}_${envPart(character)}`]?.trim());
      if (specific) return specific;
    }
    const perGame = validVoice(process.env[`ELEVENLABS_VOICE_${g}`]?.trim());
    if (perGame) return perGame;
    const builtIn = validVoice(GAME_VOICE_IDS[game.toLowerCase()]);
    if (builtIn) return builtIn;
  }
  return validVoice(process.env.ELEVENLABS_VOICE_ID?.trim()) ?? DEFAULT_VOICE_ID;
}

function modelId(): string {
  const value = process.env.ELEVENLABS_MODEL_ID?.trim();
  return value && /^[a-zA-Z0-9_.-]{3,64}$/.test(value) ? value : DEFAULT_MODEL_ID;
}

function outputFormat(): string {
  const value = process.env.ELEVENLABS_OUTPUT_FORMAT?.trim();
  return value && OUTPUT_FORMAT_PATTERN.test(value) ? value : DEFAULT_OUTPUT_FORMAT;
}

/** Voice settings shared with scripts/generate-voices.ts. */
export function voiceSettings(): Record<string, number | boolean> {
  // v4 supports only stability and similarity_boost.
  return { stability: 0.35, similarity_boost: 0.85 };
}

// ---------------------------------------------------------------- cache + queue

const inFlight = new Map<string, Promise<Buffer | null>>();
const waiting: Array<() => void> = [];
let active = 0;

async function acquire(): Promise<void> {
  if (active < UPSTREAM_CONCURRENCY) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiting.shift();
  if (next) next();
}

function cacheFile(hash: string): string {
  return path.join(CACHE_DIR, `${hash}.mp3`);
}

async function readCache(hash: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(cacheFile(hash));
  } catch {
    return null;
  }
}

async function writeCache(hash: string, audio: Buffer): Promise<void> {
  try {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const file = cacheFile(hash);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await fsp.writeFile(tmp, audio);
    await fsp.rename(tmp, file);
  } catch (err) {
    console.warn("[voice] could not write cache:", (err as Error).message);
  }
}

async function synthesize(text: string, voice: string, model: string, format: string): Promise<Buffer | null> {
  const hash = createHash("sha256").update([model, voice, format, text].join("\0")).digest("hex");
  const cached = await readCache(hash);
  if (cached) return cached;
  const running = inFlight.get(hash);
  if (running) return running;

  const job = (async (): Promise<Buffer | null> => {
    await acquire();
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=${encodeURIComponent(format)}`,
        {
          method: "POST",
          headers: { "xi-api-key": apiKey(), "Content-Type": "application/json", Accept: "audio/mpeg" },
          body: JSON.stringify({ text, model_id: model, voice_settings: voiceSettings() }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        // Status only: an error body can echo request details, and the key must never reach a log.
        console.warn(`[voice] ElevenLabs answered ${res.status}`);
        return null;
      }
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length === 0) return null;
      await writeCache(hash, audio);
      return audio;
    } catch (err) {
      console.warn("[voice] ElevenLabs request failed:", (err as Error).name);
      return null;
    } finally {
      release();
      inFlight.delete(hash);
    }
  })();
  inFlight.set(hash, job);
  return job;
}

// ---------------------------------------------------------------- routes

export const voiceRouter = Router();

voiceRouter.get("/config", (req, res) => {
  const game = cleanName(req.query.game);
  const character = cleanName(req.query.character);
  const isOn = enabled();
  res.set("Cache-Control", "no-store").json({
    enabled: isOn,
    game: game ?? null,
    character: character ?? null,
    voiceId: isOn ? voiceFor(game, character) : null,
    modelId: modelId(),
    maxChars: MAX_CHARS,
  });
});

voiceRouter.get("/tts", async (req, res) => {
  if (!enabled()) return void res.status(204).set("Cache-Control", "no-store").end();
  const text = typeof req.query.text === "string" ? req.query.text.trim() : "";
  if (!text || text.length > MAX_CHARS) {
    return void res.status(400).json({ error: `text must be 1..${MAX_CHARS} characters` });
  }
  const voice = voiceFor(cleanName(req.query.game), cleanName(req.query.character));
  const audio = await synthesize(text, voice, modelId(), outputFormat());
  if (!audio) return void res.status(502).json({ error: "voice synthesis is unavailable" });
  res
    .set({
      "Content-Type": "audio/mpeg",
      "Content-Length": String(audio.length),
      "Cache-Control": "public, max-age=31536000, immutable",
    })
    .send(audio);
});

/** One startup line so a deployer can see whether the proxy is on, without printing the key. */
export function voiceStatus(): { enabled: boolean; voiceId: string; cacheDir: string } {
  return { enabled: enabled(), voiceId: voiceFor(), cacheDir: CACHE_DIR };
}
