// Renders Raft Rush's complete soundscape with ElevenLabs Sound Effects.
//
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-raft-sfx.mjs
//   ELEVENLABS_API_KEY=sk_... node scripts/generate-raft-sfx.mjs --force
//   node scripts/generate-raft-sfx.mjs --key-file=/secure/path --only=waves,bonk
//
// Writes games/raft-rush/client/public/audio/raft-rush/{sfx,loops}/<name>.mp3 and manifest.json.
// Existing files are kept unless --force is given, so an interrupted run resumes where it stopped.
// The key is read from the environment or --key-file and is never written to the repository.

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_ROOT = path.join(ROOT, "games", "raft-rush", "client", "public", "audio", "raft-rush");
const SFX_DIR = path.join(OUT_ROOT, "sfx");
const LOOP_DIR = path.join(OUT_ROOT, "loops");
const SFX_SOURCE = path.join(ROOT, "games", "raft-rush", "client", "src", "audio", "Sfx.ts");
const MODEL = process.env.ELEVENLABS_SFX_MODEL?.trim() || "eleven_text_to_sound_v3";
const OUTPUT_FORMAT = "mp3_44100_128";
const CONCURRENCY = 3;
const RETRIES = 3;

const STYLE =
  "Stylized cartoon tropical island survival game. One isolated, clean sound effect, close-mic foley, punchy and playful, natural dynamics, no music bed, no speech, no voice, no crowd, no long reverb tail.";

const LOOP_STYLE =
  "Stylized cartoon tropical island survival game ambience. Seamless loop, steady background bed, natural stereo field, no speech, no voices, no music, no sudden one-off spikes, clean loop point.";

/** name: [prompt, duration seconds, loop] */
const CUES = {
  // UI ---------------------------------------------------------------------------------------------------------
  uiClick: ["A soft wooden button click with a tiny paper tick, very short and satisfying", 0.55],
  uiHover: ["A barely audible bright UI tick, soft and rounded, very short", 0.5],
  uiOpen: ["A light wooden panel sliding open with a quick airy whoosh and a small latch click", 0.75],
  uiClose: ["A short soft whoosh as a wooden panel closes, ending in a gentle latch tap", 0.7],
  uiError: ["A friendly low two-note error buzz with a muted wooden knock, not harsh", 0.85],
  uiTick: ["A tiny clean countdown tick, crisp wooden clock click", 0.5],

  // Gathering and items ----------------------------------------------------------------------------------------
  chop: ["A single heavy machete chop biting into a palm trunk, woody crack and dull thunk", 0.7],
  chopDone: ["A palm tree trunk snapping and a leafy crown crashing down onto sand", 1.2],
  mine: ["A pickaxe striking a small island rock, sharp stone clack with gritty debris", 0.75],
  mineDone: ["A rock cracking apart and crumbling into a pile of stones", 1.25],
  rustle: ["Hands pushing through a leafy tropical bush, crisp foliage rustle", 1.0],
  berry: ["A ripe berry plucked from a bush with a soft wet pop and a tiny leaf shake", 0.65],
  pickup: ["A small item picked up from sand, quick wooden clatter and soft hand pat", 0.55],
  drop: ["A small crafted object set down on packed sand with a soft wooden clunk", 0.55],
  coconutFall: ["A coconut thumping down onto sand after falling from a palm, hollow knock and small bounce", 1.0],
  palmShake: ["A palm trunk shaken by hand, leaves rustling loudly overhead and a coconut wobbling", 1.15],
  craft: ["A small wooden item being assembled, two quick mallet taps, rope pull and final snug click", 1.0],
  hammer: ["A wooden mallet striking a plank, solid clean thwack", 0.55],
  place: ["A wooden plank placed and tapped into position, short structural thunk", 0.65],
  chestOpen: ["An old wooden chest lid creaking open with a soft latch pop", 1.0],
  chestClose: ["A wooden chest lid dropped shut with a hollow thud and latch click", 0.65],
  eat: ["A juicy tropical fruit bitten into, wet crunch and small satisfied chew", 0.8],
  drink: ["Two quick gulps of water from a coconut shell, liquid sloshing", 0.9],
  burp: ["A small comedic burp after eating, rounded and brief, not gross", 0.75],
  spring: ["A bouncy jungle plant releasing a cartoon boing spring", 0.8],

  // Throwing and melee ----------------------------------------------------------------------------------------
  chargeStart: ["A quick tense whoosh starting up, short wind-up of air through a hand throw", 0.75],
  throw: ["A light coconut whooshing through the air, fast underhand throw", 0.55],
  throwHeavy: ["A heavy object hurled with a deep powerful air whoosh", 0.7],
  toss: ["A gentle short toss of a small object through the air", 0.5],
  catch: ["A satisfying slap-catch of a thrown object into both hands", 0.5],
  bonk: ["A big cartoon coconut bonk on the head, hollow wooden impact with comic weight", 0.6],
  hit: ["A solid soft-body impact thump from a thrown object", 0.5],
  bootBonk: ["A boot kicking a shell with a rubbery thwack and quick skid", 0.55],
  splash: ["A small body or object splashing into shallow sea water, droplets scattering", 1.0],
  stick: ["A thrown object hitting wet clay with a sticky squelch and soft thud", 0.55],
  bounce: ["A small wooden object bouncing once on packed sand, light hollow tap", 0.5],
  swing: ["A fast melee swing through air, short cloth-and-air whoosh", 0.5],

  // Fire and raft ----------------------------------------------------------------------------------------------
  fireFeed: ["A piece of driftwood tossed onto a campfire, embers crackling and flaring up", 1.15],
  fireLow: ["A campfire sputtering low, weak crackle and a soft warning puff of smoke", 1.2],
  fireOut: ["A campfire being doused, sharp steam hiss and dying embers", 1.3],
  deliver: ["A raft supply bundle dropped onto a wooden raft deck, solid clunk and rope slap", 0.8],
  raftStage: ["A raft construction milestone, three heavy wooden planks locking together with a proud thunk", 1.2],
  raftReady: ["A bright readiness flourish of wooden clacks, a rope snap and a triumphant short ukulele strum", 2.0],
  raftGnaw: ["A sea creature gnawing and scraping wet wood with quick crunchy bites", 1.2],
  board: ["A person stepping onto a floating wooden raft, hollow creak and water lapping", 0.8],
  launch: ["A wooden survival raft launching from the beach, deep ship horn, wood scrape and big water rush", 3.0],
  fenceBreak: ["A wooden fence splintering and snapping apart under impact", 1.2],

  // Monsters ---------------------------------------------------------------------------------------------------
  crabEmerge: ["A sand crab bursting out of wet beach sand, gritty spray and rapid scuttle", 1.0],
  crabClick: ["A crab snapping its claw once, dry sharp click", 0.5],
  crabBite: ["A crab claw pinching hard with a sharp chitin snap", 0.5],
  crabFlip: ["A crab flipped onto its shell, hard shell tap and scrabbling legs", 0.9],
  crabDie: ["A crab shell cracking and popping, then collapsing into sand", 1.0],
  pufferPop: ["A spiky pufferfish inflating and popping with a rubbery underwater blast", 1.0],
  bossRoar: ["A giant sea monster roaring from the water, deep wet guttural roar with spray", 2.5],
  bossStomp: ["A huge monster foot stomping onto wet sand, deep booming impact and splash", 1.4],
  monkey: ["A small island monkey chattering and hooting excitedly, close and natural", 1.0],
  gull: ["A single seagull cry over the beach, natural and distant", 1.2],
  steal: ["A quick sneaky snatch, cloth rustle and a small item whisked away", 0.8],
  kraken: ["A giant kraken tentacle rising from deep water, low rumble and heavy splash", 2.2],

  // Player state -----------------------------------------------------------------------------------------------
  jump: ["A person jumping off sand, quick cloth swish and soft takeoff scuff", 0.6],
  land: ["A person landing on sand with a soft footfall and small skid", 0.55],
  footstep: ["One bare footstep on packed beach sand, soft and close", 0.5],
  swimStroke: ["One strong freestyle swim stroke churning shallow sea water", 0.75],
  waterIn: ["A swimmer ducking under the surface, water rushing in and muffling", 1.1],
  waterOut: ["A swimmer breaking the surface with a splash and a quick breath of air", 0.9],
  hurt: ["A short sharp impact on a person, breath knocked out, no words", 0.6],
  downed: ["A low descending thud and heartbeat as a player collapses into sand", 1.2],
  revive: ["A warm rising sparkle and gentle healing pulse, hopeful and soft", 1.4],
  washed: ["A wave shoving someone across wet sand, rushing water and sliding scrape", 1.5],
  respawn: ["A soft magical poof with wooden sparkles as a castaway reappears", 1.6],
  lowBar: ["A soft warning heartbeat with a tiny muted alarm tick, urgent but not harsh", 0.8],
  shiver: ["A cold castaway shivering, quick cloth tremble and small teeth chatter, no words", 1.0],
  blast: ["A big cartoon explosion of sand and water, punchy boom with debris", 1.8],
  jellyZap: ["A jellyfish electric zap, sharp crackling volts through water", 0.8],
  fuseTick: ["A short sizzling fuse spark and a tiny warning tick", 0.5],

  // Fishing and luck -------------------------------------------------------------------------------------------
  cast: ["A fishing rod whipping forward, line hissing out over water and a small plop", 0.8],
  bite: ["A fishing bobber dunked hard by a biting fish, water plop and line tug", 0.6],
  reelSpin: ["A fishing reel cranked fast, rapid mechanical ratchet whir", 0.8],
  reelTick: ["One crisp fishing reel ratchet click", 0.5],
  reelStop: ["A fishing reel stopping with a final metallic click and line snap", 0.5],
  catchFish: ["A fish caught and flopping on a wooden raft, wet slap and happy splash", 1.3],
  miss: ["A fishing line coming back empty, small sad plop and reel click", 0.9],
  treasure: ["A small treasure chest opening with a bright magical shimmer and coin clink", 1.6],
  golden: ["A rare golden fish catch, bright ascending sparkle and splash", 2.0],
  bottle: ["A glass message bottle clinking against wood and rolling once", 0.7],
  legendary: ["A legendary catch reveal, deep magical swell, bright chime and water burst", 2.2],

  // Flow and social --------------------------------------------------------------------------------------------
  marker: ["A friendly sonar ping for a map marker, clean and easy to locate", 0.8],
  emote: ["A cheerful little pop and wooden clack for an emote", 0.6],
  dayStart: ["A tropical morning arrives, rooster crow, distant birds and a warm soft chime", 2.5],
  duskDrums: ["A distant island drum hit and low shell thump signalling dusk", 2.0],
  nightStart: ["Night falls on the island, crickets rise and a soft low chime", 2.5],
  stormWarn: ["A storm warning horn over a low rolling rumble and rising wind", 2.0],
  thunder: ["A close tropical thunder crack with a long rolling rumble", 3.0],
  win: ["A short triumphant win sting with ukulele strum, wooden marimba and tambourine flourish", 2.5],
  lose: ["A short playful sad loss sting with a falling ukulele phrase and soft woodblock", 2.5],

  // Continuous loops -------------------------------------------------------------------------------------------
  charge: ["A seamless loop of a throw charging up, airy whoosh with a faint rising whistle and wobble", 3.0, true],
  fire: ["A seamless loop of a small beach campfire, steady crackle, tiny pops and soft flame flutter", 30.0, true],
  rain: ["A seamless loop of steady tropical rain on sand and palm leaves, full and even", 30.0, true],
  waves: ["A seamless loop of gentle ocean waves lapping a tropical beach, slow and natural", 30.0, true],
  crickets: ["A seamless loop of a tropical night jungle, dense crickets and tiny insects, no birds", 30.0, true],
  gulls: ["A seamless loop of distant seagulls over a calm beach, sparse natural cries", 30.0, true],
  wind: ["A seamless loop of warm island wind through palms, soft gusts and leaf rustle", 30.0, true],
  drums: ["A seamless loop of a distant island drum circle, hand drums and shell percussion, steady groove", 30.0, true],
  swim: ["A seamless loop of a swimmer churning through calm sea water, steady splashing strokes", 4.0, true],
  fuse: ["A seamless loop of a lit fuse sizzling and sparking, tense and close", 3.0, true],
  reel: ["A seamless loop of a fishing reel ratchet spinning, steady mechanical clicks", 3.0, true],
  channel: ["A seamless loop of focused gathering work, soft rising hum and rhythmic brush strokes", 3.0, true],
  storm: ["A seamless loop of a tropical storm at sea, howling wind, heavy rain and low rolling thunder", 30.0, true],
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
  return fs.readFile(SFX_SOURCE, "utf8").then((src) => {
    const list = (pattern) => {
      const body = src.match(pattern)?.[1] ?? "";
      return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    };
    return {
      sfx: list(/SFX_NAMES = \[([\s\S]*?)\] as const/),
      loops: list(/LOOP_NAMES = \[([\s\S]*?)\] as const/),
    };
  });
}

function promptHash(prompt, duration, loop) {
  return crypto.createHash("sha256").update(`${MODEL}\n${duration}\n${loop}\n${prompt}`).digest("hex").slice(0, 16);
}

async function renderOne(name, cue) {
  const [text, duration, loop = false] = cue;
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
    text: `${loop ? LOOP_STYLE : STYLE} ${text}`,
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

const names = await sourceNames();
const cueNames = Object.keys(CUES);
const expected = [...names.sfx, ...names.loops];
const missing = expected.filter((n) => !CUES[n]);
const extra = cueNames.filter((n) => !expected.includes(n));
if (missing.length || extra.length) {
  console.error(`Cue sheet does not match Sfx.ts.\n  missing: ${missing.join(", ") || "none"}\n  extra: ${extra.join(", ") || "none"}`);
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
      else if (done % 5 === 0 || done === results.length) console.log(`  ${done} rendered (last: ${name})`);
    } catch (err) {
      failures.push(err instanceof Error ? err.message : String(err));
      console.error(`  FAILED ${err instanceof Error ? err.message : err}`);
    }
  }
}

await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker));

// The manifest is rebuilt from every cue, not just this run, so partial re-renders stay coherent.
const files = {
  sfx: {},
  loops: {},
};
for (const name of names.sfx) {
  const cue = CUES[name];
  files.sfx[name] = {
    file: `sfx/${name}.mp3`,
    duration: cue[1],
    hash: promptHash(cue[0], cue[1], false),
  };
}
for (const name of names.loops) {
  const cue = CUES[name];
  files.loops[name] = {
    file: `loops/${name}.mp3`,
    duration: cue[1],
    hash: promptHash(cue[0], cue[1], true),
  };
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
