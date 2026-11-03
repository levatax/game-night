// Renders Bonk Brawl's ElevenLabs sound bank.
//
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-bonk-sfx.mjs
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-bonk-sfx.mjs --force
//   node scripts/generate-bonk-sfx.mjs --key-file=/secure/path --only=bonk1,arena
//
// Writes games/bonk-brawl/client/public/audio/bonk-brawl/{sfx,loops,voices}/<name>.mp3 and manifest.json.
// Existing files are kept unless --force is given, so an interrupted run resumes where it stopped.
// The key is read from the environment or --key-file and is never written to the repository.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.join(ROOT, "games", "bonk-brawl", "client", "public", "audio", "bonk-brawl");
const SFX_DIR = path.join(OUT_ROOT, "sfx");
const LOOP_DIR = path.join(OUT_ROOT, "loops");
const VOICE_DIR = path.join(OUT_ROOT, "voices");
const MODEL = process.env.ELEVENLABS_SFX_MODEL?.trim() || "eleven_text_to_sound_v3";
const VOICE_MODEL = process.env.ELEVENLABS_MODEL_ID?.trim() || "eleven_multilingual_v2";
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID?.trim() || "pNInz6obpgDQGcFmaJgB";
const OUTPUT_FORMAT = "mp3_44100_128";
const CONCURRENCY = 3;
const RETRIES = 3;

const STYLE =
  "Stylized cartoon party brawler video game. One isolated, clean sound effect, punchy and playful, natural dynamics, no music bed, no speech, no voice, no crowd, no long reverb tail.";

const LOOP_STYLE =
  "Stylized cartoon party brawler video game arena ambience. Seamless loop, steady background bed, wide stereo field, no speech, no voices, no music, no sudden one-off spikes, clean loop point.";

/** name: [prompt, duration seconds, kind] */
const CUES = {
  bonk1: ["One isolated light bonk: a springy rubber mallet tapping a padded cartoon head, hollow woodblock knock with a tiny upward boing", 0.55, "sfx"],
  bonk2: ["One isolated medium bonk: solid woodblock thwack with a cartoon pitch-drop boing and soft body wobble", 0.7, "sfx"],
  bonk3: ["One isolated huge mega bonk: heavy cartoon impact, deep padded thud plus loud woodblock crack and long comic boing tail", 0.9, "sfx"],
  whiff: ["One isolated whiff: a ball whooshing past empty air with a flailing swish and a tiny sad descending slide", 0.55, "sfx"],
  ballDrop: ["One isolated ball dropping from the sky: a fast descending falling whistle ending in a soft rubbery bounce on a padded arena floor", 1.0, "sfx"],
  ko: ["One isolated KO pop: a soft pop followed by a puff of feathers and a comedic deflating slide, final and playful", 0.8, "sfx"],
  ringOut: ["One isolated ring-out: a classic slide whistle descending in pitch as something falls away, ending with a distant soft thump", 1.2, "sfx"],
  countdownTick: ["One crisp countdown tick: a clean wooden clock tick, dry and short, easy to hear over a crowd", 0.5, "sfx"],
  countdownGo: ["One big start gong: a bright wooden gong struck hard with a comic bonk layer and a short triumphant ring", 1.1, "sfx"],
  uiClick: ["One isolated UI click: a soft bubble pop with a tiny bright wooden tick, short and satisfying", 0.5, "sfx"],
  uiConfirm: ["One isolated UI confirm: a bright two-note wooden marimba confirmation with a soft bubbly tail, cheerful and clear", 0.8, "sfx"],
  crowdOoh: ["One crowd reaction: an arena crowd going OOOOH in surprise, stacked distant voices swelling and fading", 1.2, "sfx"],
  arena: ["Wide indoor arena room tone with a soft airy hum, faint distant crowd murmur and occasional tiny seat creaks", 20, "loop"],
  crowd: ["Lively but distant arena crowd walla, cheerful murmur and light laughter, even energy", 20, "loop"],
};

/** Announcer lines: short, in the game's English interface voice. */
const LINES = {
  announcerRound: "Round one! Let's brawl!",
  announcerBonk: "Ohhh, bonk!",
  announcerRingOut: "Ring out!",
  announcerLastOne: "Last one standing!",
  announcerSuddenDeath: "Sudden death!",
  announcerWin: "What a match!",
};

const args = new Set(process.argv.slice(2));
const FORCE = args.has("--force");
const onlyArg = process.argv.find((a) => a.startsWith("--only="));
const only = onlyArg ? new Set(onlyArg.slice("--only=".length).split(",").filter(Boolean)) : null;
const keyFileArg = process.argv.find((a) => a.startsWith("--key-file="));

async function readKey() {
  if (process.env.ELEVENLABS_API_KEY?.trim()) return process.env.ELEVENLABS_API_KEY.trim();
  if (keyFileArg) {
    const key = (await fs.readFile(keyFileArg.slice("--key-file=".length), "utf8")).trim();
    if (key) return key;
  }
  return "";
}

function hashOf(parts) {
  return crypto.createHash("sha256").update(parts).digest("hex").slice(0, 16);
}

function dirFor(kind) {
  return kind === "loop" ? LOOP_DIR : kind === "voice" ? VOICE_DIR : SFX_DIR;
}

async function renderOne(kind, name, body, headers, accept) {
  const file = path.join(dirFor(kind), `${name}.mp3`);
  if (!FORCE) {
    try {
      await fs.access(file);
      return { name, kept: true };
    } catch {
      /* missing */
    }
  }
  const url =
    kind === "voice"
      ? `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(VOICE_ID)}?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`
      : `https://api.elevenlabs.io/v1/sound-generation?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "xi-api-key": key, "Content-Type": "application/json", Accept: accept },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      if (attempt === RETRIES) throw new Error(`${name}: network (${err.name})`);
      await sleep(2_000 * 3 ** (attempt - 1));
      continue;
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 220).replace(/\s+/g, " ");
      if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
        await sleep(2_000 * 3 ** (attempt - 1));
        continue;
      }
      throw new Error(`${name}: HTTP ${res.status}${detail ? ` — ${detail}` : ""}`);
    }
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length < 100) throw new Error(`${name}: empty audio response`);
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, audio);
    await fs.rename(tmp, file);
    return { name, kept: false };
  }
  throw new Error(`${name}: exhausted retries`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const key = await readKey();
if (!key) {
  console.error("ELEVENLABS_API_KEY is not set. Pass it in the environment or with --key-file=/path.");
  process.exit(1);
}

await fs.mkdir(SFX_DIR, { recursive: true });
await fs.mkdir(LOOP_DIR, { recursive: true });
await fs.mkdir(VOICE_DIR, { recursive: true });

const jobs = [
  ...Object.entries(CUES).map(([name, [prompt, duration, kind]]) => ({
    name,
    kind,
    duration,
    hash: hashOf(`${MODEL}\n${duration}\n${kind === "loop"}\n${prompt}`),
    body: {
      text: `${kind === "loop" ? LOOP_STYLE : STYLE} ${prompt}`,
      duration_seconds: duration,
      prompt_influence: 0.62,
      loop: kind === "loop",
      model_id: MODEL,
    },
    headers: { Accept: "audio/mpeg" },
  })),
  ...Object.entries(LINES).map(([name, text]) => ({
    name,
    kind: "voice",
    duration: null,
    hash: hashOf(`${VOICE_MODEL}\n${VOICE_ID}\n${text}`),
    body: {
      text,
      model_id: VOICE_MODEL,
      voice_settings: { stability: 0.4, similarity_boost: 0.75, style: 0.35, use_speaker_boost: true },
    },
    headers: { Accept: "audio/mpeg" },
  })),
];

const queue = jobs.filter((job) => !only || only.has(job.name));
if (queue.length === 0) {
  console.error("--only matched no cue.");
  process.exit(1);
}
console.log(`${queue.length}/${jobs.length} cue(s) selected · model ${MODEL} · ${FORCE ? "forcing all" : "resuming missing files"}`);

const failures = [];
let done = 0;
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) return;
    try {
      const row = await renderOne(job.kind, job.name, job.body, job.headers, "audio/mpeg");
      done++;
      if (!row.kept && (done % 5 === 0 || done === jobs.length)) console.log(`  ${done} rendered (last: ${job.name})`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
      console.error(`  FAILED ${err instanceof Error ? err.message : err}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

// Rebuild the manifest from every cue so partial re-renders stay coherent; durations are the requested
// lengths and hashes fingerprint the prompt, matching the Raft Rush manifest format.
const manifest = { version: 1, model: MODEL, voiceModel: VOICE_MODEL, voiceId: VOICE_ID, generatedAt: new Date().toISOString(), sfx: {}, loops: {}, voices: {} };
for (const job of jobs) {
  const section = job.kind === "loop" ? manifest.loops : job.kind === "voice" ? manifest.voices : manifest.sfx;
  const file = `${job.kind === "loop" ? "loops" : job.kind === "voice" ? "voices" : "sfx"}/${job.name}.mp3`;
  let hash = job.hash;
  try {
    hash = crypto.createHash("sha256").update(await fs.readFile(path.join(OUT_ROOT, file))).digest("hex").slice(0, 16);
  } catch {
    /* keep the prompt hash if the file was not produced */
  }
  const entry = { file, hash };
  if (job.duration !== null) entry.duration = job.duration;
  if (job.kind === "voice") entry.text = LINES[job.name];
  section[job.name] = entry;
}
await fs.writeFile(path.join(OUT_ROOT, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`\nDone: ${done} processed, ${failures.length} failed.`);
console.log(`Assets: ${path.relative(ROOT, OUT_ROOT)}`);
if (failures.length) {
  console.error(`\nFailures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
