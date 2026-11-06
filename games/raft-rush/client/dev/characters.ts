// Characters harness: the six Ship Tourists through the real Characters manager with mock PlayerFrames, every
// continuous state + trigger + emote, held items, nameplate flags (bot / golden / reconnecting / downed /
// boarded / night), the monsters in every MonsterMode with their triggers, the first-person arms (character,
// item, gestures, continuous states, drag to look) and the lobby portraits. Dev only (served / built by
// dev/vite.characters.config.ts, never part of the game build). Owner: client-characters.
// Automation hook: window.raftCharHarness (see the bottom of this file).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  CHANNEL,
  CHARACTER_IDS,
  CHARGE_FULL_TICKS,
  CRAB_FLIP_TICKS,
  EMOTE_IDS,
  FISH_STATE,
  JUMP_VELOCITY,
  GRAVITY,
  MONSTER_EMERGE_TICKS,
  PALETTE,
  PUFFER_FUSE_TICKS,
  REVIVE_TICKS,
  SPRINT_SPEED,
  TICK_RATE,
  TORCH_BURN_TICKS,
  WALK_SPEED,
} from "../../shared/constants";
import { ITEM_KINDS } from "../../shared/items";
import type { CharacterId, EmoteId, InvKind, MonsterKind, MonsterMode } from "../../shared/types";
import { Characters, type CharacterTrigger, type FpArmsFrame, type FpGesture, type MonsterTrigger } from "../src/characters/Characters";
import { countTriangles } from "../src/characters/kit";
import { createPuppetFrame } from "../src/characters/puppet";
import type { MonsterFrame, PlayerFrame } from "../src/net/types";
import { createToonMaterial, OVERLAY_LAYER } from "../src/render/Toon";

/* ------------------------------------------------------------------ scene */

const container = document.getElementById("game") as HTMLElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const DAY_SKY = new THREE.Color("#7FD3F5");
const NIGHT_SKY = new THREE.Color("#0B1A33");
scene.background = DAY_SKY.clone();
scene.fog = new THREE.Fog("#BFE9F7", 40, 120);
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 300);
camera.layers.enable(OVERLAY_LAYER); // marker labels / nameplates
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight("#FFF4D6", 2.4);
sun.position.set(5, 10, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -14;
sc.right = sc.top = 14;
sc.far = 40;
const hemi = new THREE.HemisphereLight("#CFEFFF", "#E9D7A5", 1.2);
const fire = new THREE.PointLight(PALETTE.fire, 0, 14, 1.6);
fire.position.set(0, 1.2, 2.2);
scene.add(sun, sun.target, hemi, fire);

const ground = new THREE.Mesh(new THREE.CircleGeometry(24, 48), createToonMaterial(PALETTE.sand));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
const sea = new THREE.Mesh(new THREE.RingGeometry(24, 140, 48), createToonMaterial(PALETTE.sea));
sea.rotation.x = -Math.PI / 2;
sea.position.y = -0.02;
scene.add(sea);
/** A water box for the swim program (the tourist floats in it). */
const pool = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.2, 1.4), createToonMaterial(PALETTE.sea, { transparent: true, opacity: 0.55 }));
pool.position.y = -0.6;
pool.visible = false;
scene.add(pool);

const characters = new Characters(scene, camera);

/* ------------------------------------------------------------------ tourists */

type Program =
  | "idle"
  | "walk"
  | "strafe"
  | "sprint"
  | "jump"
  | "swim"
  | "charge"
  | "catch"
  | "stunned"
  | "crawl"
  | "downed"
  | "boarded"
  | "gather"
  | "revive"
  | "fish"
  | "cold"
  | "puffer";

const PROGRAMS: Program[] = ["idle", "walk", "strafe", "sprint", "jump", "swim", "charge", "catch", "stunned", "crawl", "downed", "boarded", "gather", "revive", "fish", "cold", "puffer"];

interface Mock {
  frame: PlayerFrame;
  program: Program;
  t: number;
  homeX: number;
  flag: boolean;
}

const SPACING = 1.7;
const NAMES = ["Kaptan Deniz", "Selin ✨", "Amca", "Gelin Ayşe", "Şef Rıza", "Minik"];
const mocks: Mock[] = CHARACTER_IDS.map((character, i) => {
  const frame = createPuppetFrame(character, `p${i}`, i);
  frame.nickname = NAMES[i] ?? character;
  const homeX = (i - (CHARACTER_IDS.length - 1) / 2) * SPACING;
  frame.x = homeX;
  frame.yaw = Math.PI;
  return { frame, program: "idle", t: 0, homeX, flag: false };
});

let target: number | "all" = "all";
let dark = 0;
let timeScale = 1;
const selected = (): Mock[] => (target === "all" ? mocks : [mocks[target]!]);

function setHeld(kind: InvKind, who: Mock[] = selected()): void {
  for (const m of who) {
    m.frame.inv0 = kind;
    m.frame.cnt0 = kind === "" ? 0 : 1;
    m.frame.activeSlot = 0;
    m.frame.torchTicks = kind === "torch" ? TORCH_BURN_TICKS : 0;
    m.frame.fuseTicks = kind === "puffer" ? PUFFER_FUSE_TICKS : 0;
  }
}

function setProgram(p: Program, who: Mock[] = selected()): void {
  for (const m of who) {
    m.program = p;
    m.t = 0;
    m.flag = false;
    const f = m.frame;
    f.x = m.homeX;
    f.z = 0;
    f.y = 0;
    f.vy = 0;
    f.grounded = true;
    if (p === "fish") setHeld("rod", [m]);
    if (p === "puffer") setHeld("puffer", [m]);
  }
  pool.visible = mocks.some((m) => m.program === "swim");
}

function trigger(what: CharacterTrigger, opts: { emote?: EmoteId } = {}, who: Mock[] = selected()): void {
  for (const m of who) {
    const f = m.frame;
    const item = f.inv0 === "" ? undefined : f.inv0;
    if (what === "eat") characters.trigger(f.id, what, { item: item ?? "coconut" });
    else characters.trigger(f.id, what, { ...opts, item, dir: { x: 1, y: 0, z: 0 } });
    if (what === "washed") f.washed = true;
    if (what === "respawn") f.washed = false;
  }
}

function forward(f: PlayerFrame, speed: number): void {
  f.vx = -Math.sin(f.yaw) * speed;
  f.vz = -Math.cos(f.yaw) * speed;
}

/** Fill the mock's frame for its program (treadmill: positions stay home so the lineup stays readable). */
function stepProgram(m: Mock, dt: number): void {
  const f = m.frame;
  m.t += dt;
  const keepAir = m.program === "jump";
  f.vx = f.vz = 0;
  f.chargeTicks = f.catchTicks = f.stunTicks = 0;
  f.channel = CHANNEL.NONE;
  f.channelTicks = 0;
  f.channelTarget = -1;
  f.swimming = f.downed = f.boarded = f.sprinting = false;
  f.fishState = FISH_STATE.NONE;
  f.warmth = 100;
  f.hunger = 100;
  if (!keepAir) {
    f.y = 0;
    f.grounded = true;
    f.airTicks = 0;
  }
  const ticks = (sec: number): number => Math.max(0, Math.round(sec * TICK_RATE));
  switch (m.program) {
    case "idle":
      break;
    case "walk":
      forward(f, WALK_SPEED);
      break;
    case "strafe":
      f.vx = Math.cos(f.yaw) * 3.5;
      f.vz = -Math.sin(f.yaw) * 3.5;
      break;
    case "sprint":
      forward(f, SPRINT_SPEED);
      f.sprinting = true;
      break;
    case "jump":
      if (f.grounded && m.t > 0.5) {
        f.vy = JUMP_VELOCITY;
        f.grounded = false;
        f.y = 0.01;
        m.t = 0;
      } else if (!f.grounded) {
        f.vy += GRAVITY * dt;
        f.y += f.vy * dt;
        f.airTicks = Math.min(255, f.airTicks + 1);
        if (f.y <= 0) {
          f.y = 0;
          f.vy = 0;
          f.grounded = true;
          f.airTicks = 0;
        }
      }
      break;
    case "swim":
      f.swimming = true;
      f.y = -1.1;
      f.grounded = false;
      forward(f, 1.6 + Math.sin(m.t * 0.7) * 1.4);
      break;
    case "charge": {
      const cycle = m.t % 2.4;
      if (cycle < 1.4) {
        f.chargeTicks = Math.min(CHARGE_FULL_TICKS, ticks(cycle));
        m.flag = false;
      } else if (!m.flag) {
        m.flag = true;
        characters.trigger(f.id, "throw", { item: f.inv0 === "" ? undefined : f.inv0 });
      }
      break;
    }
    case "catch":
      f.catchTicks = 6;
      break;
    case "stunned":
      f.stunTicks = 6;
      break;
    case "crawl":
      f.downed = true;
      forward(f, 0.9);
      break;
    case "downed":
      f.downed = true;
      break;
    case "boarded":
      f.boarded = true;
      break;
    case "gather":
      f.channel = CHANNEL.GATHER;
      f.channelTicks = ticks(m.t % 2.5);
      if (m.t % 1 < dt) characters.trigger(f.id, "gather");
      break;
    case "revive":
      f.channel = CHANNEL.REVIVE;
      f.channelTicks = ticks(m.t % 3);
      break;
    case "fish": {
      const cycle = m.t % 6;
      if (cycle < dt) characters.trigger(f.id, "cast");
      if (cycle > 3.4 && cycle - dt <= 3.4) characters.trigger(f.id, "reel");
      f.fishState = cycle < 0.7 ? FISH_STATE.NONE : cycle < 2.8 ? FISH_STATE.CAST : cycle < 3.4 ? FISH_STATE.BITE : cycle < 5.6 ? FISH_STATE.REEL : FISH_STATE.NONE;
      break;
    }
    case "cold":
      f.warmth = 5;
      f.hunger = 8;
      break;
    case "puffer":
      f.fuseTicks = Math.max(1, PUFFER_FUSE_TICKS - ticks(m.t % 5.5));
      if (m.t % 5.5 > 5.45) characters.trigger(f.id, "inflate");
      break;
  }
  f.speed = Math.hypot(f.vx, f.vz);
}

/* ------------------------------------------------------------------ revive pairing (nameplate ring) */

/** While a mock runs "revive", the next mock lies downed and shows the progress ring. */
function pairRevives(): void {
  for (let i = 0; i < mocks.length; i++) {
    const m = mocks[i]!;
    if (m.program !== "revive") continue;
    const next = mocks[(i + 1) % mocks.length]!;
    m.frame.channelTarget = next.frame.seat;
    m.frame.channelTicks = Math.round((m.t % 3) * TICK_RATE) % REVIVE_TICKS;
    if (next.program !== "revive") next.frame.downed = true;
  }
}

/* ------------------------------------------------------------------ monsters */

interface MonsterMock {
  frame: MonsterFrame;
  home: THREE.Vector3;
  mode: MonsterMode;
  t: number;
}

const MONSTER_ROW: { kind: MonsterKind; x: number; mode: MonsterMode; carry?: InvKind }[] = [
  { kind: "crab", x: -6, mode: "hunt" },
  { kind: "crab", x: -4, mode: "flipped" },
  { kind: "puffer", x: -2, mode: "hunt" },
  { kind: "boss", x: 1, mode: "hunt" },
  { kind: "monkey", x: 4, mode: "carry", carry: "coconut" },
  { kind: "gull", x: 6.5, mode: "carry", carry: "fish_raw" },
];

let monsterSeq = 0;
function makeMonster(spec: (typeof MONSTER_ROW)[number]): MonsterMock {
  const frame: MonsterFrame = {
    id: `m${++monsterSeq}`,
    kind: spec.kind,
    x: spec.x,
    y: 0,
    z: -4,
    yaw: Math.PI,
    hp: 2,
    mode: spec.mode,
    modeTicks: 0,
    targetId: "",
    carry: spec.carry ?? "",
    speed: 0,
  };
  return { frame, home: new THREE.Vector3(spec.x, 0, -4), mode: spec.mode, t: Math.random() * 3 };
}

let monsterMocks: MonsterMock[] = MONSTER_ROW.map(makeMonster);
let monsterKindFilter: MonsterKind | "all" = "all";
let monstersWalk = true;

function setMonsterMode(mode: MonsterMode): void {
  for (const m of monsterMocks) {
    if (monsterKindFilter !== "all" && m.frame.kind !== monsterKindFilter) continue;
    m.mode = mode;
    m.t = 0;
    if (mode === "flipped") characters.monsters.trigger(m.frame.id, "flip");
  }
}

function monsterTrigger(what: MonsterTrigger): void {
  for (const m of monsterMocks) {
    if (monsterKindFilter !== "all" && m.frame.kind !== monsterKindFilter) continue;
    characters.monsters.trigger(m.frame.id, what);
  }
  if (what === "die") {
    // They come back fresh (new ids) after the pop.
    const keep = monsterMocks;
    monsterMocks = keep.filter((m) => monsterKindFilter !== "all" && m.frame.kind !== monsterKindFilter);
    setTimeout(() => {
      for (const spec of MONSTER_ROW) {
        if (monsterKindFilter !== "all" && spec.kind !== monsterKindFilter) continue;
        const m = makeMonster(spec);
        m.mode = "emerge";
        m.frame.modeTicks = MONSTER_EMERGE_TICKS;
        monsterMocks.push(m);
        characters.monsters.trigger(m.frame.id, "spawn");
      }
    }, 900);
  }
}

function stepMonster(m: MonsterMock, dt: number): void {
  m.t += dt;
  const f = m.frame;
  f.mode = m.mode;
  f.x = m.home.x;
  f.z = m.home.z;
  f.y = 0;
  f.speed = 0;
  f.yaw = Math.PI;
  switch (m.mode) {
    case "emerge":
      f.modeTicks = Math.max(0, f.modeTicks - 1);
      if (f.modeTicks === 0) m.mode = "hunt";
      break;
    case "flipped":
      f.modeTicks = CRAB_FLIP_TICKS - (Math.round(m.t * TICK_RATE) % CRAB_FLIP_TICKS);
      break;
    case "hunt":
    case "flee":
    case "lured":
    case "carry":
      if (monstersWalk) {
        // Walk a small circle so legs, rolls and banking show.
        const r = f.kind === "gull" ? 2.2 : 0.9;
        const w = (f.kind === "gull" ? 0.9 : f.kind === "boss" ? 0.5 : 1.2) * (m.mode === "flee" ? 1.8 : 1);
        const a = m.t * w;
        f.x = m.home.x + Math.cos(a) * r;
        f.z = m.home.z + Math.sin(a) * r;
        f.yaw = Math.atan2(Math.sin(a), -Math.cos(a));
        f.speed = r * w;
      }
      break;
    default:
      break;
  }
  if (f.kind === "gull") f.y = m.mode === "steal" ? 1.2 : 2.6 + Math.sin(m.t) * 0.3;
}

/* ------------------------------------------------------------------ first-person arms */

interface FpState {
  on: boolean;
  character: CharacterId;
  held: InvKind;
  walk: boolean;
  sprint: boolean;
  swim: boolean;
  downed: boolean;
  charge: boolean;
  channel: number;
  fishState: number;
  torchLit: boolean;
  fuse: boolean;
  yaw: number;
  pitch: number;
  chargeT: number;
  fuseT: number;
}

const fp: FpState = {
  on: false,
  character: "kaptan",
  held: "",
  walk: false,
  sprint: false,
  swim: false,
  downed: false,
  charge: false,
  channel: CHANNEL.NONE,
  fishState: FISH_STATE.NONE,
  torchLit: true,
  fuse: false,
  yaw: 0,
  pitch: -0.05,
  chargeT: 0,
  fuseT: 0,
};
const FP_EYE = new THREE.Vector3(0, 1.55, 4.2);
const FP_ID = "fp-local";
let dragging = false;
renderer.domElement.addEventListener("pointerdown", () => (dragging = fp.on));
window.addEventListener("pointerup", () => (dragging = false));
window.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  fp.yaw -= e.movementX * 0.004;
  fp.pitch = Math.max(-1.4, Math.min(1.4, fp.pitch - e.movementY * 0.004));
});

function setFp(on: boolean): void {
  fp.on = on;
  controls.enabled = !on;
  camera.fov = on ? 75 : 50;
  camera.updateProjectionMatrix();
  characters.fpArms.setVisible(on);
  if (!on) setView("lineup");
}

function fpFrame(dt: number): FpArmsFrame {
  fp.chargeT = fp.charge ? Math.min(1, fp.chargeT + dt / (CHARGE_FULL_TICKS / TICK_RATE)) : 0;
  fp.fuseT = fp.fuse ? (fp.fuseT + dt / 5) % 1 : 0;
  const speed = fp.downed ? (fp.walk ? 1 : 0) : fp.sprint ? SPRINT_SPEED : fp.walk ? WALK_SPEED : fp.swim ? 1.5 : 0;
  return {
    character: fp.character,
    held: fp.held,
    count: fp.held === "" ? 0 : 1,
    charge: fp.chargeT,
    channel: fp.channel === CHANNEL.NONE ? -1 : (performance.now() / 2500) % 1,
    channelKind: fp.channel,
    speed,
    grounded: !fp.swim,
    sprinting: fp.sprint,
    swimming: fp.swim,
    downed: fp.downed,
    fishState: fp.held === "rod" ? fp.fishState : FISH_STATE.NONE,
    torchLit: fp.torchLit,
    fuse: fp.fuse && fp.held === "puffer" ? 1 - fp.fuseT : -1,
  };
}

/* ------------------------------------------------------------------ cameras */

type View = "lineup" | "closeup" | "monsters" | "top";

function setView(v: View, who?: number): void {
  if (typeof who === "number") target = who;
  if (fp.on) setFp(false);
  if (v === "lineup") {
    camera.position.set(0, 2.2, 8.5);
    controls.target.set(0, 0.9, 0);
  } else if (v === "closeup") {
    const m = mocks[typeof target === "number" ? target : 0]!;
    camera.position.set(m.homeX + 0.9, 1.5, 2.6);
    controls.target.set(m.homeX, 1.05, 0);
  } else if (v === "monsters") {
    camera.position.set(0, 3.4, 2.2);
    controls.target.set(0, 0.4, -4.5);
  } else {
    camera.position.set(0, 9, 12);
    controls.target.set(0, 0.5, -1.5);
  }
  controls.update();
}

/* ------------------------------------------------------------------ panel */

const panel = document.getElementById("panel") as HTMLElement;

function section(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.appendChild(h);
  const div = document.createElement("div");
  panel.appendChild(div);
  return div;
}

function button(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  parent.appendChild(b);
  return b;
}

function select<T extends string>(parent: HTMLElement, options: readonly T[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = document.createElement("select");
  for (const o of options) {
    const opt = document.createElement("option");
    opt.value = o;
    opt.textContent = o === "" ? "(empty hands)" : o;
    s.appendChild(opt);
  }
  s.value = value;
  s.addEventListener("change", () => onChange(s.value as T));
  parent.appendChild(s);
  return s;
}

function toggle(parent: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void): void {
  const b = button(parent, label, () => {
    set(!get());
    b.classList.toggle("on", get());
  });
  b.classList.toggle("on", get());
}

const views = section("View");
for (const v of ["lineup", "closeup", "monsters", "top"] as const) button(views, v, () => setView(v));
toggle(views, "night", () => dark > 0.5, (v) => setNight(v));
toggle(views, "slow-mo", () => timeScale < 1, (v) => (timeScale = v ? 0.25 : 1));

const who = section("Target");
select(who, ["all", ...CHARACTER_IDS] as const, "all", (v) => (target = v === "all" ? "all" : CHARACTER_IDS.indexOf(v as CharacterId)));

const states = section("States");
for (const p of PROGRAMS) button(states, p, () => setProgram(p));

const items = section("Held item");
select(items, ["", ...ITEM_KINDS] as const, "", (v) => setHeld(v as InvKind));

const trig = section("Triggers");
const TRIGGERS: CharacterTrigger[] = ["throw", "toss", "use", "gather", "eat", "catch", "hit", "downed", "revived", "washed", "respawn", "land", "cast", "reel", "board", "cheer", "inflate"];
for (const t of TRIGGERS) button(trig, t, () => trigger(t));

const emotes = section("Emotes");
for (const e of EMOTE_IDS) button(emotes, e, () => trigger("emote", { emote: e }));

const plates = section("Nameplates");
toggle(plates, "bot", () => selected()[0]!.frame.bot, (v) => selected().forEach((m) => (m.frame.bot = v)));
toggle(plates, "golden", () => selected()[0]!.frame.golden, (v) => selected().forEach((m) => (m.frame.golden = v)));
toggle(plates, "reconnecting", () => !selected()[0]!.frame.connected, (v) => selected().forEach((m) => (m.frame.connected = !v)));
button(plates, "seat +1", () => selected().forEach((m) => (m.frame.seat = (m.frame.seat + 1) % 6)));

const mons = section("Monsters");
select(mons, ["all", "crab", "puffer", "boss", "monkey", "gull"] as const, "all", (v) => (monsterKindFilter = v));
toggle(mons, "walk", () => monstersWalk, (v) => (monstersWalk = v));
const MODES: MonsterMode[] = ["emerge", "hunt", "bite", "flipped", "flee", "stunned", "lured", "steal", "carry"];
const modeRow = document.createElement("div");
mons.appendChild(modeRow);
for (const mode of MODES) {
  button(modeRow, mode, () => {
    if (mode === "emerge") for (const m of monsterMocks) m.frame.modeTicks = MONSTER_EMERGE_TICKS;
    setMonsterMode(mode);
  });
}
const mtrig = document.createElement("div");
mons.appendChild(mtrig);
const MTRIGGERS: MonsterTrigger[] = ["spawn", "hurt", "flip", "unflip", "attack", "die", "flee", "steal", "drop"];
for (const t of MTRIGGERS) button(mtrig, `⚡${t}`, () => monsterTrigger(t));

const fpSec = section("First-person arms");
toggle(fpSec, "FP view", () => fp.on, (v) => setFp(v));
select(fpSec, CHARACTER_IDS, fp.character, (v) => (fp.character = v));
select(fpSec, ["", ...ITEM_KINDS] as const, "", (v) => (fp.held = v as InvKind));
const fpToggles = document.createElement("div");
fpSec.appendChild(fpToggles);
toggle(fpToggles, "walk", () => fp.walk, (v) => (fp.walk = v));
toggle(fpToggles, "sprint", () => fp.sprint, (v) => (fp.sprint = v));
toggle(fpToggles, "swim", () => fp.swim, (v) => (fp.swim = v));
toggle(fpToggles, "downed", () => fp.downed, (v) => (fp.downed = v));
toggle(fpToggles, "charge", () => fp.charge, (v) => (fp.charge = v));
toggle(fpToggles, "gather", () => fp.channel === CHANNEL.GATHER, (v) => (fp.channel = v ? CHANNEL.GATHER : CHANNEL.NONE));
toggle(fpToggles, "revive", () => fp.channel === CHANNEL.REVIVE, (v) => (fp.channel = v ? CHANNEL.REVIVE : CHANNEL.NONE));
toggle(fpToggles, "torch lit", () => fp.torchLit, (v) => (fp.torchLit = v));
toggle(fpToggles, "fuse", () => fp.fuse, (v) => (fp.fuse = v));
const fish = document.createElement("div");
fpSec.appendChild(fish);
for (const [label, st] of [["no line", FISH_STATE.NONE], ["cast", FISH_STATE.CAST], ["bite!", FISH_STATE.BITE], ["reel", FISH_STATE.REEL]] as const) {
  button(fish, label, () => (fp.fishState = st));
}
const fpGestures = document.createElement("div");
fpSec.appendChild(fpGestures);
const GESTURES: FpGesture[] = ["throw", "toss", "use", "swing", "eat", "gather", "catch", "cast", "reel", "hurt", "place", "deliver"];
for (const g of GESTURES) button(fpGestures, g, () => characters.fpArms.play(g));

function setNight(on: boolean): void {
  dark = on ? 1 : 0;
  (scene.background as THREE.Color).copy(on ? NIGHT_SKY : DAY_SKY);
  (scene.fog as THREE.Fog).color.set(on ? "#0B1A33" : "#BFE9F7");
  sun.intensity = on ? 0.35 : 2.4;
  sun.color.set(on ? "#9DB7FF" : "#FFF4D6");
  hemi.intensity = on ? 0.35 : 1.2;
  fire.intensity = on ? 9 : 0;
}

/* ------------------------------------------------------------------ portraits */

const portraits = document.getElementById("portraits") as HTMLElement;
for (const id of CHARACTER_IDS) {
  const img = document.createElement("img");
  img.alt = id;
  img.title = id;
  img.src = characters.portrait(id);
  portraits.appendChild(img);
}

/* ------------------------------------------------------------------ loop */

const stats = document.getElementById("stats") as HTMLElement;
const clock = new THREE.Clock();
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 0;
let triReport = "";

function tourTris(): string {
  const lines: string[] = [];
  for (const m of mocks) {
    const root = scene.getObjectByName(`tourist:${m.frame.character}`);
    if (!root) continue;
    lines.push(`${m.frame.character.padEnd(8)} ${String(countTriangles(root, false)).padStart(5)} / ${countTriangles(root, true)} tris`);
  }
  const mroot = characters.monsters.object;
  lines.push(`monsters  ${countTriangles(mroot, false)} / ${countTriangles(mroot, true)} tris (${characters.monsters.count})`);
  lines.push(`fp arms   ${countTriangles(characters.fpArms.object, true)} tris`);
  return lines.join("\n");
}

function resize(): void {
  const w = container.clientWidth;
  const h = container.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(1, h);
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();
setView("lineup");

let simAcc = 0;

/** One harness frame with a real-time step `raw` (seconds). */
function tick(raw: number, render = true): void {
  const dt = raw * timeScale;
  // Mock programs run at the sim rate (tick counters), animation at the frame rate.
  simAcc += dt;
  while (simAcc >= 1 / TICK_RATE) {
    simAcc -= 1 / TICK_RATE;
    for (const m of mocks) stepProgram(m, 1 / TICK_RATE);
    pairRevives();
    for (const m of monsterMocks) stepMonster(m, 1 / TICK_RATE);
  }
  const swimmer = mocks.find((m) => m.program === "swim");
  if (swimmer) pool.position.x = swimmer.homeX;
  const frames = mocks.filter((m) => !m.frame.washed).map((m) => m.frame);
  if (fp.on) {
    const local = createPuppetFrame(fp.character, FP_ID, 0);
    local.x = FP_EYE.x;
    local.z = FP_EYE.z;
    local.isLocal = true;
    frames.push(local);
  }
  characters.sync(frames, { localId: FP_ID, firstPerson: true, dark }, dt);
  characters.monsters.sync(
    monsterMocks.map((m) => m.frame),
    dt,
  );
  if (fp.on) {
    camera.position.copy(FP_EYE);
    if (fp.downed) camera.position.y = 0.45;
    if (fp.swim) camera.position.y = 0.35;
    camera.rotation.set(fp.pitch, fp.yaw, 0, "YXZ");
    camera.updateMatrixWorld();
    characters.fpArms.update(dt, camera, fpFrame(dt));
  } else {
    controls.update();
  }
  if (!render) return;
  renderer.render(scene, camera);

  fpsAcc += raw;
  fpsFrames++;
  if (fpsAcc >= 0.5) {
    fps = fpsFrames / fpsAcc;
    fpsAcc = 0;
    fpsFrames = 0;
    triReport = tourTris();
  }
  const info = renderer.info.render;
  const insp = characters.inspect(mocks[typeof target === "number" ? target : 0]!.frame.id);
  stats.textContent = `fps ${fps.toFixed(0)}  calls ${info.calls}  tris ${info.triangles}\n${insp ? `state ${insp.state} · face ${insp.expression}\n` : ""}${triReport}`;
}

function frame(): void {
  requestAnimationFrame(frame);
  tick(Math.min(0.1, clock.getDelta()));
}
frame();

/* ------------------------------------------------------------------ automation */

declare global {
  interface Window {
    raftCharHarness: {
      program(p: Program, who?: number | "all"): void;
      item(kind: InvKind, who?: number | "all"): void;
      trigger(what: CharacterTrigger, who?: number | "all"): void;
      emote(e: EmoteId, who?: number | "all"): void;
      view(v: View, who?: number): void;
      night(on: boolean): void;
      monsterMode(mode: MonsterMode, kind?: MonsterKind | "all"): void;
      monsterTrigger(what: MonsterTrigger, kind?: MonsterKind | "all"): void;
      fp(on: boolean, character?: CharacterId, held?: InvKind): void;
      fpState(patch: Partial<FpState>): void;
      fpGesture(g: FpGesture): void;
      plate(patch: { bot?: boolean; golden?: boolean; connected?: boolean }, who?: number | "all"): void;
      /** Run `sec` seconds of frames at 60 fps right now (works while the tab is in the background), then render. */
      advance(sec: number): void;
      /** Raw access for debugging from the console. */
      debug: { scene: THREE.Scene; camera: THREE.PerspectiveCamera; characters: Characters; renderer: THREE.WebGLRenderer };
    };
  }
}

function withTarget(w: number | "all" | undefined, fn: () => void): void {
  const prev = target;
  if (w !== undefined) target = w;
  fn();
  target = prev;
}

window.raftCharHarness = {
  program: (p, w) => withTarget(w, () => setProgram(p)),
  item: (k, w) => withTarget(w, () => setHeld(k)),
  trigger: (t, w) => withTarget(w, () => trigger(t)),
  emote: (e, w) => withTarget(w, () => trigger("emote", { emote: e })),
  view: setView,
  night: setNight,
  monsterMode: (mode, kind = "all") => {
    monsterKindFilter = kind;
    setMonsterMode(mode);
  },
  monsterTrigger: (t, kind = "all") => {
    monsterKindFilter = kind;
    monsterTrigger(t);
  },
  fp: (on, character, held) => {
    if (character) fp.character = character;
    if (held !== undefined) fp.held = held;
    setFp(on);
  },
  fpState: (patch) => Object.assign(fp, patch),
  fpGesture: (g) => characters.fpArms.play(g),
  plate: (patch, w) =>
    withTarget(w, () => {
      for (const m of selected()) Object.assign(m.frame, patch);
    }),
  advance: (sec) => {
    const n = Math.max(1, Math.round(sec * 60));
    for (let i = 0; i < n; i++) tick(1 / 60, i === n - 1);
    triReport = tourTris();
  },
  debug: { scene, camera, characters, renderer },
};
