// Audio harness: the real AudioEngine with buttons for every SFX (grouped like Sfx.ts; flat or placed around the
// listener), every loop (param / pitch / positional), every tourist voice line, every music mood (with the island
// seed that composes the tune), Emekli Amca's radio at a distance / angle, the ambience beds (daylight, weather,
// sea, monsters, storm, underwater), a live output meter and an offline loudness probe for tuning the mix. Dev
// only (served / built by dev/vite.audio.config.ts, never part of the game build). Owner: client-fx-audio.
// Automation hook: window.audioHarness (see the bottom of this file).

import { CHARACTER_IDS } from "../../shared/constants";
import type { CharacterId, Vec3Like, Weather } from "../../shared/types";
import { SettingsStore } from "../src/app/settings";
import { AudioEngine, type AmbienceFrame } from "../src/audio/AudioEngine";
import { LOOP_NAMES, SFX_NAMES, type LoopName, type MusicMood, type SfxName, type VoiceKind } from "../src/audio/Sfx";
import { composeSongBook } from "../src/audio/music/songs";
import { Synth } from "../src/audio/synth/dsp";
import { LOOP_LEVEL, createLoop } from "../src/audio/synth/loops";
import { SFX_DEFS, SFX_RECIPES, sfxGain } from "../src/audio/synth/recipes";
import { VOICE_LEVEL, speakWord } from "../src/audio/voices";

const store = new SettingsStore("raft-rush.audio-harness.v1");
const engine = new AudioEngine(store);

const MOODS: ReadonlyArray<MusicMood> = ["off", "lobby", "day", "dusk", "night", "boss", "storm", "launch", "win", "lose"];
const VOICE_KINDS: ReadonlyArray<VoiceKind> = ["hurt", "throw", "eat", "panic", "laugh", "help", "yes", "cheer", "emote", "downed", "revived", "shiver"];
const WEATHERS: ReadonlyArray<Weather> = ["clear", "rain", "fog", "heatwave", "fullmoon"];
const PC = ["C", "C#", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];

/** SFX groups, by the first name of each block in Sfx.ts. */
const GROUPS: ReadonlyArray<[string, SfxName]> = [
  ["UI", "uiClick"],
  ["Gathering & items", "chop"],
  ["Throwing", "chargeStart"],
  ["Fire & raft", "fireFeed"],
  ["Monsters", "crabEmerge"],
  ["Player state", "jump"],
  ["Fishing & luck", "cast"],
  ["Flow & social", "marker"],
];

/* ------------------------------------------------------------------ dom */

const main = document.getElementById("main") as HTMLElement;

function section(title: string, wide = false): HTMLElement {
  const s = document.createElement("section");
  if (wide) s.className = "wide";
  const h = document.createElement("h2");
  h.textContent = title;
  s.appendChild(h);
  main.appendChild(s);
  return s;
}

function sub(parent: HTMLElement, title: string): HTMLElement {
  const h = document.createElement("h3");
  h.textContent = title;
  parent.appendChild(h);
  const div = document.createElement("div");
  parent.appendChild(div);
  return div;
}

function button(parent: HTMLElement, label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", () => {
    engine.unlock();
    fn();
  });
  parent.appendChild(b);
  return b;
}

function toggle(parent: HTMLElement, label: string, initial: boolean, fn: (on: boolean) => void): HTMLButtonElement {
  let on = initial;
  const b = button(parent, label, () => {
    on = !on;
    b.classList.toggle("on", on);
    fn(on);
  });
  b.classList.toggle("on", on);
  return b;
}

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, fn: (v: number) => void): HTMLInputElement {
  const l = document.createElement("label");
  l.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => fn(Number(input.value)));
  l.appendChild(input);
  parent.appendChild(l);
  return input;
}

function hint(parent: HTMLElement, text: string): HTMLElement {
  const p = document.createElement("div");
  p.className = "hint";
  p.textContent = text;
  parent.appendChild(p);
  return p;
}

/* ---------------------------------------------------------------- state */

const LISTENER: Vec3Like = { x: 0, y: 1.55, z: 0 };
let placed = false;
let placeAngle = 45;
let placeDistance = 6;
let sfxPitch = 1;
let sfxVolume = 1;
const loopsOn = new Set<LoopName>();
let loopParam = 0.5;
let loopPitch = 1;
let loopPlaced = false;
let radioOn = false;
let radioDistance = 3;
let radioAngle = 0;
let ambienceOn = true;
const ambience: AmbienceFrame = { daylight: 1, weather: "clear", sea: 0.5, monsters: 0, storm: 0, underwater: false };
let seed = 4471;

function around(angleDeg: number, distance: number): Vec3Like {
  const a = (angleDeg * Math.PI) / 180;
  // Listener faces -Z: angle 0 = straight ahead, 90 = right.
  return { x: LISTENER.x + Math.sin(a) * distance, y: LISTENER.y, z: LISTENER.z - Math.cos(a) * distance };
}

/* ------------------------------------------------------------- sections */

{
  const s = section("Mix");
  const v = store.get();
  slider(s, "master", 0, 1, 0.01, v.masterVolume, (x) => store.set({ masterVolume: x }));
  slider(s, "music", 0, 1, 0.01, v.musicVolume, (x) => store.set({ musicVolume: x }));
  slider(s, "sfx", 0, 1, 0.01, v.sfxVolume, (x) => store.set({ sfxVolume: x }));
  toggle(s, "muted", v.muted, (on) => store.set({ muted: on }));
  hint(s, "Settings go through a SettingsStore (harness storage key), exactly like the game's sliders.");
}

{
  const s = section("SFX", true);
  const opts = sub(s, "Options");
  toggle(opts, "positional", placed, (on) => (placed = on));
  slider(opts, "angle", -180, 180, 5, placeAngle, (x) => (placeAngle = x));
  slider(opts, "distance", 1, 50, 1, placeDistance, (x) => (placeDistance = x));
  slider(opts, "pitch", 0.5, 2, 0.01, sfxPitch, (x) => (sfxPitch = x));
  slider(opts, "volume", 0, 2, 0.01, sfxVolume, (x) => (sfxVolume = x));
  const starts = GROUPS.map(([, first]) => SFX_NAMES.indexOf(first));
  GROUPS.forEach(([title], gi) => {
    const box = sub(s, title);
    const end = gi + 1 < starts.length ? starts[gi + 1]! : SFX_NAMES.length;
    for (const name of SFX_NAMES.slice(starts[gi]!, end)) {
      const b = button(box, name, () => engine.play(name, { pos: placed ? around(placeAngle, placeDistance) : undefined, pitch: sfxPitch, volume: sfxVolume }));
      b.title = `${SFX_DEFS[name].bus} · vol ${SFX_DEFS[name].volume} · cap ${SFX_DEFS[name].cap}${SFX_DEFS[name].positional ? " · positional" : ""}`;
    }
  });
}

{
  const s = section("Loops");
  for (const name of LOOP_NAMES) {
    toggle(s, name, false, (on) => {
      if (on) loopsOn.add(name);
      else {
        loopsOn.delete(name);
        engine.stopLoop(`h:${name}`);
      }
    });
  }
  const o = sub(s, "Parameter");
  slider(o, "param", 0, 1, 0.01, loopParam, (x) => (loopParam = x));
  slider(o, "pitch", 0.5, 2, 0.01, loopPitch, (x) => (loopPitch = x));
  toggle(o, "positional (orbit)", loopPlaced, (on) => {
    loopPlaced = on;
    for (const name of loopsOn) engine.stopLoop(`h:${name}`);
  });
  hint(s, "param: charge · fire size · rain / waves / storm intensity · gull / cricket density · drum tempo · swim speed · fuse urgency · reel speed · channel progress. An explicit bed loop mutes the matching ambience bed.");
}

{
  const s = section("Tourist voices", true);
  for (const id of CHARACTER_IDS) {
    const row = sub(s, id);
    for (const kind of VOICE_KINDS) button(row, kind, () => engine.voice(id as CharacterId, kind, placed ? around(placeAngle, placeDistance) : undefined));
  }
}

let tuneInfo: HTMLElement;
function describeTune(): void {
  const book = composeSongBook(seed);
  const t = book.tune;
  tuneInfo.textContent =
    `seed ${seed} · key ${PC[t.key]} major / ${PC[t.key]} minor at night · A: ${t.progA.join(" ")} · B: ${t.progB.join(" ")}\n` +
    `bpm day ${book.songs.day.bpm} · night ${book.songs.night.bpm} · boss ${book.songs.boss.bpm} · storm ${book.songs.storm.bpm}\n` +
    `day bars: ${book.songs.day.bars.map((c) => c.name).join(" ")}\nnight bars: ${book.songs.night.bars.map((c) => c.name).join(" ")}`;
}

{
  const s = section("Music");
  const moods = sub(s, "Mood");
  for (const mood of MOODS) button(moods, mood, () => engine.setMusic(mood));
  const seedRow = sub(s, "Island seed (composes the tune)");
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(seed);
  input.style.width = "120px";
  input.addEventListener("change", () => {
    seed = Number(input.value) >>> 0;
    engine.setMusicSeed(seed);
    describeTune();
  });
  seedRow.appendChild(input);
  button(seedRow, "random seed", () => {
    seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    input.value = String(seed);
    engine.setMusicSeed(seed);
    describeTune();
  });
  button(seedRow, "duck 2 s", () => engine.duck(2));
  tuneInfo = document.createElement("pre");
  s.appendChild(tuneInfo);
  describeTune();
  engine.setMusicSeed(seed);
}

let radioLabel: HTMLElement;
{
  const s = section("Emekli Amca's radio");
  toggle(s, "radio (else flat)", radioOn, (on) => (radioOn = on));
  slider(s, "distance", 0, 60, 0.5, radioDistance, (x) => (radioDistance = x));
  slider(s, "angle", -180, 180, 5, radioAngle, (x) => (radioAngle = x));
  radioLabel = hint(s, "");
  hint(s, "Near: full and flat (you carry it). Far: quieter, tinny, from his direction.");
}

{
  const s = section("Ambience");
  toggle(s, "ambience on", ambienceOn, (on) => (ambienceOn = on));
  slider(s, "daylight", 0, 1, 0.01, ambience.daylight, (x) => (ambience.daylight = x));
  slider(s, "sea", 0, 1, 0.01, ambience.sea, (x) => (ambience.sea = x));
  slider(s, "monsters", 0, 16, 1, ambience.monsters, (x) => (ambience.monsters = x));
  slider(s, "storm", 0, 1, 0.01, ambience.storm, (x) => (ambience.storm = x));
  const w = sub(s, "Weather");
  for (const weather of WEATHERS) button(w, weather, () => (ambience.weather = weather));
  toggle(s, "underwater", false, (on) => (ambience.underwater = on));
  hint(s, "Drums play when the music mood is dusk / night / boss / storm; their tempo follows the monster count.");
}

{
  const s = section("Offline loudness probe", true);
  const out = document.createElement("div");
  button(s, "measure all SFX", () => void measureAll(out));
  button(s, "measure voices", () => void measureVoices(out));
  button(s, "measure loops", () => void measureLoops(out));
  hint(s, "Renders recipes / voice lines / 2 s of each loop in an OfflineAudioContext: raw peak / RMS (dBFS) and × mix gain. Aim: big hits ≈ −2 dB effective, everyday ≈ −8, footsteps / UI ≈ −14, voices ≈ −6, beds ≈ −20 RMS.");
  s.appendChild(out);
}

interface Measure {
  name: string;
  peak: number;
  rms: number;
  dur: number;
  gain: number;
}

const PROBE_RATE = 22050;

/** Render `seconds` of whatever `build` schedules into an offline context and measure it. */
async function render(name: string, gain: number, seconds: number, build: (ctx: OfflineAudioContext, out: AudioNode) => void): Promise<Measure> {
  const ctx = new OfflineAudioContext(1, Math.ceil(PROBE_RATE * seconds), PROBE_RATE);
  const out = ctx.createGain();
  out.connect(ctx.destination);
  build(ctx, out);
  const data = (await ctx.startRendering()).getChannelData(0);
  let peak = 0;
  let sum = 0;
  let lastLoud = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]!);
    if (a > peak) peak = a;
    sum += a * a;
    if (a > 0.003) lastLoud = i;
  }
  return { name, peak, rms: Math.sqrt(sum / Math.max(1, lastLoud)), dur: lastLoud / PROBE_RATE, gain };
}

function showTable(out: HTMLElement, rows: Measure[]): void {
  const db = (x: number): string => (x > 0 ? (20 * Math.log10(x)).toFixed(1) : "-inf");
  const table = document.createElement("table");
  table.innerHTML = "<tr><th>name</th><th>peak</th><th>rms</th><th>× gain (peak)</th><th>× gain (rms)</th><th>dur</th></tr>";
  for (const r of rows.sort((a, b) => b.peak * b.gain - a.peak * a.gain)) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td>${r.name}</td><td>${db(r.peak)}</td><td>${db(r.rms)}</td><td>${db(r.peak * r.gain)}</td><td>${db(r.rms * r.gain)}</td><td>${r.dur.toFixed(2)}s</td>`;
    table.appendChild(tr);
  }
  out.textContent = "";
  out.appendChild(table);
}

async function measureAll(out: HTMLElement): Promise<void> {
  out.textContent = "rendering…";
  const rows: Measure[] = [];
  for (const name of SFX_NAMES) rows.push(await render(name, sfxGain(name), 3.5, (ctx, dest) => SFX_RECIPES[name](new Synth(ctx, dest, 0.01, 1))));
  showTable(out, rows);
}

async function measureVoices(out: HTMLElement): Promise<void> {
  out.textContent = "rendering…";
  const rows: Measure[] = [];
  for (const id of CHARACTER_IDS) {
    for (const kind of VOICE_KINDS) rows.push(await render(`${id} ${kind}`, VOICE_LEVEL, 2, (ctx, dest) => void speakWord(new Synth(ctx, dest, 0.01, 1), id, kind)));
  }
  showTable(out, rows);
}

async function measureLoops(out: HTMLElement): Promise<void> {
  out.textContent = "rendering…";
  const rows: Measure[] = [];
  for (const name of LOOP_NAMES) {
    for (const param of [0.2, 0.8]) {
      rows.push(
        await render(`${name} @${param}`, LOOP_LEVEL[name], 3, (ctx, dest) => {
          const voice = createLoop(ctx, name, dest, 0.01, param);
          voice.tick(0, 3);
        }),
      );
    }
  }
  showTable(out, rows);
}

/* ---------------------------------------------------------------- header */

const status = document.getElementById("status") as HTMLElement;
const counts = document.getElementById("counts") as HTMLElement;
(document.getElementById("unlock") as HTMLButtonElement).addEventListener("click", () => engine.unlock());
window.addEventListener("pointerdown", () => engine.unlock(), { once: true });

const meter = document.getElementById("meter") as HTMLCanvasElement;
const meterCtx = meter.getContext("2d");
let analyser: AnalyserNode | null = null;
let samples: Float32Array<ArrayBuffer> = new Float32Array(1024);

function drawMeter(): void {
  if (!meterCtx) return;
  const ctx = engine.audioContext;
  const output = engine.outputNode;
  if (!analyser && ctx && output) {
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    samples = new Float32Array(analyser.fftSize);
    output.connect(analyser);
  }
  meterCtx.fillStyle = "#1c1a20";
  meterCtx.fillRect(0, 0, meter.width, meter.height);
  if (!analyser) return;
  analyser.getFloatTimeDomainData(samples);
  let peak = 0;
  meterCtx.strokeStyle = "#7ccb6b";
  meterCtx.beginPath();
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    peak = Math.max(peak, Math.abs(v));
    const x = (i / samples.length) * meter.width;
    const y = meter.height / 2 - v * (meter.height / 2);
    if (i === 0) meterCtx.moveTo(x, y);
    else meterCtx.lineTo(x, y);
  }
  meterCtx.stroke();
  meterCtx.fillStyle = peak > 0.98 ? "#ff5a5f" : "#ffd166";
  meterCtx.fillRect(meter.width - 6, meter.height * (1 - peak), 6, meter.height * peak);
}

/* ------------------------------------------------------------------ loop */

let last = performance.now();
let elapsed = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  elapsed += dt;
  engine.setListener(LISTENER, { x: 0, y: 0, z: -1 });
  engine.setRadio(radioOn ? around(radioAngle, radioDistance) : null);
  if (ambienceOn) engine.setAmbience({ ...ambience });
  for (const name of loopsOn) {
    const pos = loopPlaced ? around((elapsed * 40) % 360, 5) : undefined;
    engine.loop(`h:${name}`, name, { param: loopParam, pitch: loopPitch, pos });
  }
  engine.update(dt);
  drawMeter();
  status.textContent = engine.ready ? "running" : "locked — click anything";
  status.classList.toggle("on", engine.ready);
  counts.textContent = `voices ${engine.activeVoices} · loops ${engine.activeLoops} · mood ${engine.musicMood}`;
  if (radioLabel) radioLabel.textContent = `radio level ${engine.radioLevel.toFixed(2)}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/** Automation hook for scripted checks. */
const harness = {
  engine,
  store,
  measureAll: (): Promise<void> => measureAll(document.createElement("div")),
};
(window as unknown as { audioHarness: typeof harness }).audioHarness = harness;
