// Renders Kasala's complete soundscape with ElevenLabs Sound Effects (v3).
//
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-kasala-sfx.mjs
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-kasala-sfx.mjs --force
//   node scripts/generate-kasala-sfx.mjs --key-file=/secure/path --only=flip,kaching
//
// Writes games/kasala/client/public/audio/kasala/{sfx,loops}/<name>.mp3 and manifest.json.
// Existing files are kept unless --force is given, so an interrupted run resumes where it stopped.
// The key is read from the environment or --key-file and is never written to the repository.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.join(ROOT, "games", "kasala", "client", "public", "audio", "kasala");
const SFX_DIR = path.join(OUT_ROOT, "sfx");
const LOOP_DIR = path.join(OUT_ROOT, "loops");
const AUDIO_SOURCE = path.join(ROOT, "games", "kasala", "client", "src", "audio", "AudioEngine.ts");
const MODEL = process.env.ELEVENLABS_SFX_MODEL?.trim() || "eleven_text_to_sound_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const CONCURRENCY = 3;
const RETRIES = 3;

const STYLE =
  "Stylized Turkish noir gambling-den game. One isolated, clean sound effect, close-mic foley, punchy, darkly comic, natural dynamics, no music bed, no speech, no voice, no crowd, no long reverb tail.";

const HEAVY_STYLE =
  "Stylized Turkish noir gambling-den game. One isolated, clean sound effect, close-mic foley, heavy and cinematic, darkly comic, natural dynamics, no music bed, no speech bed, no long reverb tail.";

const LOOP_STYLE =
  "Stylized Turkish noir gambling-den game ambience. Seamless loop, steady background bed, natural stereo field, no intelligible speech, no music, no sudden one-off spikes, clean loop point.";

/** Extra ids that AudioEngine plays directly, beyond the SfxId union. */
const EXTRA_SFX = [
  "wheelTick",
  "tensionStep1",
  "tensionStep2",
  "tensionStep3",
  "tensionStep4",
  "tensionStep5",
  "tensionStep6",
  "phew",
  "heckleFlip",
  "heckleCash",
];

const LOOPS = ["room", "rain", "neon", "crowd"];

/** name: [prompt, duration seconds, loop?, style?] */
const CUES = {
  // Cards and table --------------------------------------------------------------------------------------------
  flip: ["A playing card flicked and flipped fast through the air, crisp paper snap and a quick flutter", 0.7],
  deal: ["A playing card slid across green felt toward a player, soft paper friction and a tiny tap", 0.8],
  bellCommon: ["A single soft warm bronze bell ding, short and mellow", 1.2],
  bellUncommon: ["Two bright silver bell dings ascending, short and clean", 1.4],
  bellRare: ["A rising three-note gold bell arpeggio with a small sparkle shimmer", 1.8],
  bellLegendary: [
    "A glittering legendary reveal: fast ascending chime arpeggio, shimmering high bells and a warm heavenly choir pad",
    3.0,
  ],
  choir: ["A short warm wordless heavenly choir chord, cinematic and soft, one sustained aah", 2.2],
  kaching: [
    "An old mechanical cash register: lever crank, drawer slams open, bright bell ka-ching, coins rattling in the tray",
    2.2,
  ],
  coins: ["A handful of coins pouring and tumbling onto a wooden table, bright metallic clatter", 1.3],
  chips: ["Several heavy clay poker chips clacking and stacking on a felt table", 0.9],
  chipCrack: ["A clay poker chip cracking and crumbling into dust with a sharp snap and a dry fizzle", 1.2],
  wheelStop: ["A heavy spinning wheel clacking to a stop: deep wooden clunk, metal latch, two settling ticks", 1.5],
  glassBreak: [
    "A ceramic piggy bank smashed on the floor: sharp glass smash, shards tinkling, a long avalanche of coins",
    3.0,
  ],

  // Raid and police --------------------------------------------------------------------------------------------
  siren: [
    "A distant police two-tone siren wailing through a rainy night street, muffled and ominous",
    2.6,
    false,
    HEAVY_STYLE,
  ],
  doorBreak: [
    "A boot kicking a cheap wooden door in: deep impact, splintering wood, the door slamming into the wall, hinges rattling",
    2.2,
    false,
    HEAVY_STYLE,
  ],
  cuffs: ["Steel handcuffs ratcheting shut twice with sharp metallic clicks and a short chain jingle", 1.8],
  sack: ["A rough burlap sack pulled over someone's head: cloth rush, muffled protest, a blind bump into a table", 2.0],
  moths: ["An old leather wallet opened: leather creak, moth wings fluttering out, a lazy fly buzzing past", 2.6],
  cameraFlash: ["A vintage camera flash: capacitor whine, sharp pop, shutter click, small fizzle", 1.2],
  splash: [
    "A body with cement shoes dropped into a river: heavy plop, big splash, droplets, a few sad bubbles",
    3.0,
    false,
    HEAVY_STYLE,
  ],
  stamp: ["A rubber stamp pressed onto paper: light tap then heavy ka-thunk, paper slap and inky squish", 1.0],
  paper: ["A lawyer's papers rustled, pages flipped, then slapped confidently on a table", 1.3],

  // Characters -------------------------------------------------------------------------------------------------
  heartbeat: ["Two close low heartbeat thumps, lub-dub, tense and intimate", 0.8],
  punchTable: [
    "A fist slamming a poker table: heavy wooden boom, chips and cards jumping, a glass clinking",
    1.3,
  ],
  kiss: ["A quick exaggerated mafia kiss on the cheek with a wet smack and a tiny sparkle ting", 1.0],
  cry: ["A comically pathetic man crying and sniffling, no words, small nose honk", 2.4],
  cigar: [
    "A Zippo lighter opens and strikes, flame whooshes up, cigar crackles, a slow smoky exhale",
    2.6,
  ],
  countMoney: ["A thick stack of banknotes riffled and counted fast, paper flicking, then slapped down", 1.6],
  ooh: ["A short impressed ooooh from a few gruff men, wordless, close", 1.2],
  yokArtik: [
    "A gruff Turkish man saying Yok artik in disbelief, short and comic, close and clear",
    1.2,
    false,
    "Stylized Turkish noir gambling-den game. One isolated close-mic male vocal reaction, rough gangster voice, darkly comic, natural dynamics, no music, no reverb tail.",
  ],
  hah: ["A short mocking male laugh hah, sharp and close", 0.8],
  boo: ["A small crowd of gruff men booing, low and disappointed", 1.8],
  laugh: ["A table of gruff men laughing, low rough laughter, a few voices", 2.2],
  // UI and stage -----------------------------------------------------------------------------------------------
  tick: ["A dry wooden countdown tock, short and crisp", 0.5],
  timeout: ["A cheesy game-show buzzer blaring then a small bell, time is up", 1.2],
  drumroll: ["A snare drum roll building to a final hit, tense and theatrical", 2.0],
  cymbal: ["A single crash cymbal hit with a bright metallic wash and long decay", 2.6],
  whoosh: ["A fast airy whoosh of something flying past, short and punchy", 0.8],
  click: ["A short woody UI click, soft and satisfying", 0.5],
  hover: ["A barely audible soft UI hover tick, very short and gentle", 0.5],
  pop: ["A small cartoon pop with a bright pitch rise", 0.6],
  deny: ["A muted two-note low buzz meaning not allowed, not harsh", 0.8],
  open: ["A panel opening: two soft rising vibraphone notes over a small airy swell", 0.9],
  close: ["A panel closing: two soft falling vibraphone notes with a short airy hush", 0.9],

  // Tension ladder and heckles ---------------------------------------------------------------------------------
  wheelTick: ["A wooden roulette wheel peg hitting the flapper, one crisp tick", 0.5],
  tensionStep1: ["A single low floor tom hit with a felt mallet, tense and short", 1.2],
  tensionStep2: ["A low floor tom hit with one quick snare pickup tap before it, tense", 1.3],
  tensionStep3: ["Two quick snare pickup taps then a low tom hit, rising card-table tension", 1.4],
  tensionStep4: ["Three quick snare taps then a low tom hit with a short airy riser", 1.5],
  tensionStep5: ["Four fast snare taps then a deeper tom hit and a rising string swell", 1.7],
  tensionStep6: ["A fast snare roll into a deep cinematic tom hit with a tense string riser", 1.9],
  phew: [
    "One or two men exhaling a relieved fyuuu through their teeth, wordless, close",
    1.6,
    false,
    "Stylized Turkish noir gambling-den game. Isolated close-mic male exhale, relieved and comic, natural dynamics, no music, no speech, no reverb tail.",
  ],
  heckleFlip: [
    "A few gruff Turkish gangsters shouting CEVIR together over fists pounding a wooden table",
    1.6,
    false,
    "Stylized Turkish noir gambling-den game. Isolated close-mic group shout in Turkish, rough male gangster voices, darkly comic, natural dynamics, no music.",
  ],
  heckleCash: [
    "A few gruff Turkish gangsters shouting KASALA together, with a palm slap on a wooden table",
    1.6,
    false,
    "Stylized Turkish noir gambling-den game. Isolated close-mic group shout in Turkish, rough male gangster voices, darkly comic, natural dynamics, no music.",
  ],

  // Background beds --------------------------------------------------------------------------------------------
  room: [
    "Seamless loop of a smoky underground gambling den room tone: soft low crowd murmur, occasional distant glass clink and chair creak, muffled bass from another room. No intelligible words, no music.",
    30.0,
    true,
  ],
  rain: [
    "Seamless loop of steady rain on a grimy back-room window, occasional soft distant thunder, water dripping into a bucket. No voices, no music.",
    30.0,
    true,
  ],
  neon: [
    "Seamless loop of a buzzing red neon sign and a tired ceiling fluorescent tube, faint electrical crackle and hum. No voices, no music.",
    30.0,
    true,
  ],
  crowd: [
    "Seamless loop of a tense card-table crowd murmur, low indistinct voices and nervous breathing, occasional chair shift. No intelligible words, no music.",
    30.0,
    true,
  ],
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

function sourceNames() {
  return fs.readFile(AUDIO_SOURCE, "utf8").then((src) => {
    const body = src.match(/export type SfxId =([\s\S]*?);/)?.[1] ?? "";
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  });
}

function promptHash(prompt, duration, loop) {
  return crypto.createHash("sha256").update(`${MODEL}\n${duration}\n${loop}\n${prompt}`).digest("hex").slice(0, 16);
}

async function renderOne(name, cue) {
  const [text, duration, loop = false, style] = cue;
  const dir = loop ? LOOP_DIR : SFX_DIR;
  const file = path.join(dir, `${name}.mp3`);
  const hash = promptHash(text, duration, loop);
  if (!FORCE) {
    try {
      await fs.access(file);
      return { name, file, hash, skipped: true };
    } catch {
      /* missing */
    }
  }

  const url = `https://api.elevenlabs.io/v1/sound-generation?output_format=${encodeURIComponent(OUTPUT_FORMAT)}`;
  const body = JSON.stringify({
    text: `${style || (loop ? LOOP_STYLE : STYLE)} ${text}`,
    duration_seconds: duration,
    prompt_influence: 0.62,
    loop,
    model_id: MODEL,
  });

  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json",
          Accept: "audio/mpeg",
        },
        body,
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
    return { name, file, hash, skipped: false, characters: res.headers.get("character-cost") ?? "?" };
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

const sfxNames = [...(await sourceNames()), ...EXTRA_SFX];
const expected = [...sfxNames, ...LOOPS];
const cueNames = Object.keys(CUES);
const missing = expected.filter((n) => !CUES[n]);
const extra = cueNames.filter((n) => !expected.includes(n));
if (missing.length || extra.length) {
  console.error(
    `Cue sheet does not match AudioEngine.ts.\n  missing: ${missing.join(", ") || "none"}\n  extra: ${extra.join(", ") || "none"}`,
  );
  process.exit(1);
}

await fs.mkdir(SFX_DIR, { recursive: true });
await fs.mkdir(LOOP_DIR, { recursive: true });

const queue = expected.filter((name) => !only || only.has(name));
const totalSeconds = queue.reduce((sum, name) => sum + CUES[name][1], 0);
console.log(
  `${queue.length}/${expected.length} cue(s) selected · ${Math.round(totalSeconds)}s of audio · ` +
    `model ${MODEL} · ${FORCE ? "forcing all" : "resuming missing files"}`,
);

const results = [];
const failures = [];
let done = 0;

async function worker() {
  for (;;) {
    const name = queue.shift();
    if (!name) return;
    try {
      const row = await renderOne(name, CUES[name]);
      results.push(row);
      done++;
      if (row.skipped) console.log(`  kept ${name}`);
      else console.log(`  rendered ${name} (${done}/${results.length + queue.length})`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
      console.error(`  FAILED ${err instanceof Error ? err.message : err}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

// The manifest is rebuilt from every cue, not just this run, so partial re-renders stay coherent.
const files = { sfx: {}, loops: {} };
for (const name of sfxNames) {
  const cue = CUES[name];
  files.sfx[name] = { file: `sfx/${name}.mp3`, duration: cue[1], hash: promptHash(cue[0], cue[1], false) };
}
for (const name of LOOPS) {
  const cue = CUES[name];
  files.loops[name] = { file: `loops/${name}.mp3`, duration: cue[1], hash: promptHash(cue[0], cue[1], true) };
}
await fs.writeFile(
  path.join(OUT_ROOT, "manifest.json"),
  `${JSON.stringify({ version: 1, model: MODEL, generatedAt: new Date().toISOString(), ...files }, null, 2)}\n`,
);

const rendered = results.filter((r) => !r.skipped).length;
console.log(`\nDone: ${rendered} rendered, ${results.length - rendered} kept, ${failures.length} failed.`);
console.log(`Assets: ${path.relative(ROOT, OUT_ROOT)}`);
if (failures.length) {
  console.error(`\nFailures:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
