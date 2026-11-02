// Pre-renders KASALA's announcer lines with ElevenLabs, so the deployed game has instant, offline audio.
//
//   ELEVENLABS_API_KEY=sk_… npm run voices            # only lines whose mp3 is missing
//   ELEVENLABS_API_KEY=sk_… npm run voices -- --force # re-render every line
//
// Voice: ELEVENLABS_VOICE_KASALA, else ELEVENLABS_VOICE_ID, else the Istanbul-accented Adam chosen for Cemil
// Abi (J17lijyP1BHYcM7ld0Rg). Model: ELEVENLABS_MODEL_ID (default eleven_multilingual_v2).
// Writes games/kasala/client/public/audio/spiker/<line id>.mp3 and updates manifest.json. The hub's runtime
// proxy (server/voice.ts) renders any line that has no file, so this script is optional but makes playback
// instant and means production needs no API key.
//
// The key is read from the environment and never written anywhere. Nothing here is imported by the game.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANNOUNCER_LINES } from "../games/kasala/shared/announcer";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "games", "kasala", "client", "public", "audio", "spiker");
const CONCURRENCY = 3;
const MODEL = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2";
const OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT?.trim() || "mp3_44100_128";
const VOICE =
  process.env.ELEVENLABS_VOICE_KASALA?.trim() ||
  process.env.ELEVENLABS_VOICE_ID?.trim() ||
  "J17lijyP1BHYcM7ld0Rg";
const FORCE = process.argv.includes("--force");

try {
  (process as unknown as { loadEnvFile?: () => void }).loadEnvFile?.();
} catch {
  /* no .env */
}

const key = (process.env.ELEVENLABS_API_KEY ?? "").trim();
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set. Export it (or put it in .env) and run again.");
  process.exit(1);
}

await fs.mkdir(OUT_DIR, { recursive: true });

const missing = FORCE
  ? ANNOUNCER_LINES
  : (
      await Promise.all(
        ANNOUNCER_LINES.map(async (line) => {
          try {
            await fs.access(path.join(OUT_DIR, `${line.id}.mp3`));
            return null;
          } catch {
            return line;
          }
        }),
      )
    ).filter((line): line is (typeof ANNOUNCER_LINES)[number] => line !== null);

const chars = missing.reduce((sum, line) => sum + line.text.length, 0);
console.log(
  `${missing.length}/${ANNOUNCER_LINES.length} line(s) to render · ${chars.toLocaleString("en-US")} chars ` +
    `· voice ${VOICE} · ~$${((chars / 1000) * 0.08).toFixed(3)} at $0.08/1k chars`,
);
if (missing.length === 0) {
  await writeManifest();
  console.log("Everything is already rendered.");
  process.exit(0);
}

const queue = [...missing];
const failed: string[] = [];
let done = 0;

async function renderOne(line: (typeof ANNOUNCER_LINES)[number]): Promise<void> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE)}?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: "audio/mpeg" },
      body: JSON.stringify({
        text: line.text,
        model_id: MODEL,
        voice_settings: { stability: 0.45, similarity_boost: 0.8, style: 0.1, use_speaker_boost: true },
      }),
      signal: AbortSignal.timeout(60_000),
    },
  );
  if (!res.ok) {
    failed.push(`${line.id} (HTTP ${res.status})`);
    return;
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length === 0) {
    failed.push(`${line.id} (empty response)`);
    return;
  }
  const file = path.join(OUT_DIR, `${line.id}.mp3`);
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, audio);
  await fs.rename(tmp, file);
  done++;
  if (done % 10 === 0 || done === missing.length) console.log(`  ${done}/${missing.length} rendered`);
}

async function worker(): Promise<void> {
  for (;;) {
    const line = queue.shift();
    if (!line) return;
    try {
      await renderOne(line);
    } catch (err) {
      failed.push(`${line.id} (${(err as Error).name})`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, missing.length) }, () => worker()));
await writeManifest();

if (failed.length > 0) {
  console.error(`\n${failed.length} line(s) failed:\n  ${failed.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nDone: ${done} line(s) written to ${path.relative(ROOT, OUT_DIR)}`);

async function writeManifest(): Promise<void> {
  const lines = (await fs.readdir(OUT_DIR))
    .filter((name) => name.toLowerCase().endsWith(".mp3"))
    .map((name) => name.slice(0, -4))
    .sort();
  await fs.writeFile(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify({ lines })}\n`);
}
