// Characters harness: the six animals through the real Characters manager with mock frames,
// buttons for every continuous state and trigger, the lobby preview, the menu crowd and the
// face sheets. Dev only (served by dev/vite.client-characters.config.ts, not in the build).
// Automation hook: window.charHarness (see the bottom of this file).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  BALL_RADIUS,
  BELLY_BOUNCE_TICKS,
  BELLY_SLIDE_TICKS,
  CHARACTER_IDS,
  CHARACTERS,
  CHARGE_FULL_TICKS,
  FLAP_DASH_TICKS,
  GRAVITY,
  HEADBUTT_KNOCK_H,
  HEADBUTT_KNOCK_UP,
  HEADBUTT_TICKS,
  HURT_INVULN_TICKS,
  JUMP_VELOCITY,
  KNOCK_MAX_SPEED,
  MAX_HEARTS,
  PALETTE,
  PLAYER_COLORS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  ROLL_TICKS,
  TICK_RATE,
  WHIFF_TICKS,
} from "../../shared/constants";
import { getArena } from "../../shared/maps";
import type { CharacterId, EmoteId } from "../../shared/types";
import { type AnimalBudget, countTriangles, measureBudget } from "../src/characters/Animal";
import { CharacterPreview } from "../src/characters/CharacterPreview";
import { Characters } from "../src/characters/Characters";
import { FACE_COLUMNS, FACE_SHEET_HEIGHT, FACE_SHEET_SIZE, getFaceSheetCanvas } from "../src/characters/faces";
import { createMenuCrowd } from "../src/characters/MenuCrowd";
import { createPuppetFrame } from "../src/characters/puppet";
import type { SpringBone } from "../src/characters/rigTypes";
import { FACE_EXPRESSIONS, type AnimTrigger, type TriggerOptions } from "../src/characters/types";
import type { PlayerFrame } from "../src/net/types";
import { createToonMaterial } from "../src/render/Toon";

/* ------------------------------------------------------------------ scene */

const container = document.getElementById("game") as HTMLElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.skyTop);
scene.fog = new THREE.Fog(PALETTE.skyBottom, 30, 80);
const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 300);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight("#FFF4D6", 2.4);
sun.position.set(4.5, 10, 3);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -16;
sc.right = sc.top = 16;
sc.far = 40;
scene.add(sun, sun.target, new THREE.HemisphereLight("#BFE6FF", "#7BD389", 1.1));

const ground = new THREE.Mesh(new THREE.CircleGeometry(16, 48), createToonMaterial(PALETTE.grass));
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

/** Picnic cover footprints (menu crowd mode). */
const coverGroup = new THREE.Group();
for (const c of getArena("picnic").cover) {
  const geometry =
    c.shape === "cylinder"
      ? new THREE.CylinderGeometry(c.radius, c.radius, c.height, 16)
      : new THREE.BoxGeometry(c.halfX * 2, c.height, c.halfZ * 2);
  const mesh = new THREE.Mesh(geometry, createToonMaterial(PALETTE.wood));
  mesh.position.set(c.x, c.height / 2, c.z);
  mesh.rotation.y = c.rotation;
  mesh.castShadow = mesh.receiveShadow = true;
  coverGroup.add(mesh);
}
coverGroup.visible = false;
scene.add(coverGroup);

/** Hitbox capsule overlay (fit check). */
const hitboxMaterial = new THREE.MeshBasicMaterial({ color: "#FF00AA", wireframe: true, transparent: true, opacity: 0.35 });
const hitboxGeometry = new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 4, 12);
hitboxGeometry.translate(0, PLAYER_HEIGHT / 2, 0);
const hitboxes = new THREE.Group();
hitboxes.visible = false;
scene.add(hitboxes);

/** Mock held balls placed at Characters.getHandPosition (hand anchor check). */
const ballMaterial = createToonMaterial(PALETTE.neutralBall);
const heldBalls = new THREE.Group();
heldBalls.visible = false;
scene.add(heldBalls);
for (let i = 0; i < CHARACTER_IDS.length; i++) {
  const ball = new THREE.Mesh(new THREE.SphereGeometry(BALL_RADIUS, 16, 12), ballMaterial);
  ball.castShadow = true;
  heldBalls.add(ball);
}

/* ------------------------------------------------------------------ mocks */

type Program =
  | "idle"
  | "run"
  | "strafe"
  | "hop"
  | "fall"
  | "charge"
  | "catch"
  | "whiff"
  | "roll"
  | "tumble"
  | "dazed"
  | "knockback"
  | "ability"
  | "skid"
  | "turnInPlace"
  | "longFall"
  | "megaKnockback"
  | "headbuttKnock"
  | "splat";

const PROGRAMS: Program[] = [
  "idle",
  "run",
  "strafe",
  "hop",
  "fall",
  "charge",
  "catch",
  "whiff",
  "roll",
  "tumble",
  "dazed",
  "knockback",
  "ability",
  "skid",
  "turnInPlace",
  "longFall",
  "megaKnockback",
  "headbuttKnock",
  "splat",
];

interface Mock {
  frame: PlayerFrame;
  program: Program;
  t: number;
  homeX: number;
  homeZ: number;
  flag: boolean;
}

const LINEUP_SPACING = 1.7;
const FACE_CAMERA_YAW = Math.PI;
const characters = new Characters(scene);
const mocks: Mock[] = CHARACTER_IDS.map((character, i) => {
  const frame = createPuppetFrame(character, `p${i}`, i % 4);
  frame.nickname = ["Deniz", "DuckFan", "Quackers99", "Mo", "Pippa", "GOAT"][i];
  const homeX = (i - (CHARACTER_IDS.length - 1) / 2) * LINEUP_SPACING;
  frame.x = homeX;
  frame.yaw = FACE_CAMERA_YAW;
  const box = new THREE.Mesh(hitboxGeometry, hitboxMaterial);
  hitboxes.add(box);
  return { frame, program: "idle", t: 0, homeX, homeZ: 0, flag: false };
});

let target: number | "all" = "all";
let crownId = "";
let localId = "";
let timeScale = 1;
let paused = false;
let crowd: ReturnType<typeof createMenuCrowd> | null = null;

const selected = (): Mock[] => (target === "all" ? mocks : [mocks[target]]);

function resetFrame(m: Mock): void {
  const f = m.frame;
  f.vx = f.vy = f.vz = 0;
  f.grounded = true;
  f.stunTicks = f.rollTicks = f.catchTicks = f.whiffTicks = f.chargeTicks = 0;
  f.abilityTicks = f.abilityPhase = 0;
  f.dirX = f.dirZ = 0;
  f.skid = false;
}

function forward(f: PlayerFrame, speed: number): void {
  f.vx = -Math.sin(f.yaw) * speed;
  f.vz = -Math.cos(f.yaw) * speed;
}

function setProgram(p: Program, who: Mock[] = selected()): void {
  for (const m of who) {
    m.program = p;
    m.t = 0;
    m.flag = false;
    m.frame.x = m.homeX;
    m.frame.z = m.homeZ;
    m.frame.y = 0;
    m.frame.alive = true;
  }
}

function trigger(anim: AnimTrigger, opts: TriggerOptions = {}, who: Mock[] = selected()): void {
  for (const m of who) {
    const f = m.frame;
    if (anim === "ko" || anim === "ringOut") {
      characters.trigger(f.id, anim, { pos: { x: f.x, y: f.y, z: f.z }, ...opts });
      f.alive = false;
      continue;
    }
    characters.trigger(f.id, anim, opts);
  }
}

function revive(who: Mock[] = selected()): void {
  for (const m of who) m.frame.alive = true;
}

/** Simple ballistic step used by hop / knockback / ground pound programs. */
function fly(m: Mock, dt: number): boolean {
  const f = m.frame;
  f.vy += GRAVITY * dt;
  f.y += f.vy * dt;
  if (f.y > 0) return false;
  f.y = 0;
  const impact = -f.vy;
  f.vy = 0;
  f.grounded = true;
  characters.trigger(f.id, "land", { strength: Math.min(1, impact / 12) });
  return true;
}

function stepProgram(m: Mock, dt: number): void {
  const f = m.frame;
  m.t += dt;
  if (!f.alive) {
    resetFrame(m);
    return;
  }
  const keepAir =
    m.program === "hop" ||
    m.program === "knockback" ||
    m.program === "ability" ||
    m.program === "longFall" ||
    m.program === "megaKnockback" ||
    m.program === "headbuttKnock" ||
    m.program === "splat";
  const y = f.y;
  const vy = f.vy;
  resetFrame(m);
  if (keepAir) {
    f.y = y;
    f.vy = vy;
    f.grounded = y <= 0 && vy <= 0;
  } else {
    f.y = 0;
  }
  const ticks = (sec: number): number => Math.max(0, Math.round(sec * TICK_RATE));
  switch (m.program) {
    case "idle":
      return;
    case "run":
      forward(f, 6);
      return;
    case "strafe":
      f.vx = Math.cos(f.yaw) * 5;
      f.vz = -Math.sin(f.yaw) * 5;
      return;
    case "hop":
      if (f.grounded && m.t > 0.45) {
        f.vy = JUMP_VELOCITY;
        f.grounded = false;
        m.t = 0;
      } else if (!f.grounded && fly(m, dt)) m.t = 0;
      return;
    case "fall":
      f.grounded = false;
      f.vy = -6;
      return;
    case "charge": {
      const cycle = m.t % 2.6;
      if (cycle < 1.6) {
        f.chargeTicks = Math.min(CHARGE_FULL_TICKS, ticks(cycle));
        m.flag = false;
      } else if (!m.flag) {
        m.flag = true;
        characters.trigger(f.id, "throw", { strength: 1 });
      }
      return;
    }
    case "catch":
      f.catchTicks = 8;
      return;
    case "whiff": {
      const cycle = m.t % 1.5;
      if (cycle < dt) characters.trigger(f.id, "whiff");
      f.whiffTicks = Math.max(0, WHIFF_TICKS - ticks(cycle));
      return;
    }
    case "roll": {
      const cycle = m.t % 1.1;
      f.rollTicks = Math.max(0, ROLL_TICKS - ticks(cycle));
      const a = f.yaw + Math.floor(m.t / 1.1) * (Math.PI / 2);
      f.dirX = -Math.sin(a);
      f.dirZ = -Math.cos(a);
      if (f.rollTicks > 0) {
        f.vx = f.dirX * 13;
        f.vz = f.dirZ * 13;
      }
      return;
    }
    case "tumble":
      f.stunTicks = 10;
      f.grounded = false;
      f.vy = 2;
      forward(f, -6);
      return;
    case "dazed":
      f.stunTicks = 10;
      forward(f, -1.5);
      return;
    case "knockback":
      knockbackProgram(m, dt);
      return;
    case "ability":
      abilityProgram(m, dt);
      return;
    case "skid": {
      // Run, then reverse every 1.2 s: the sim flags `skid` while braking against the new input.
      const phase = Math.floor(m.t / 1.2);
      const sign = phase % 2 === 0 ? 1 : -1;
      const since = m.t - phase * 1.2;
      const speed = since < 0.25 ? 6 * (1 - since / 0.125) : 6;
      forward(f, sign * Math.max(-6, Math.min(6, speed)));
      f.skid = since < 0.2 && phase > 0;
      return;
    }
    case "turnInPlace":
      f.yaw += dt * 3.5;
      return;
    case "longFall":
      // Step off a ledge every 2.4 s and fall ~1.4 s (well past the flail threshold).
      if (m.t > 2.4 || (!m.flag && f.grounded)) {
        m.flag = true;
        m.t = 0;
        f.y = 6;
        f.vy = 0;
        f.grounded = false;
      }
      if (!f.grounded) fly(m, dt);
      else if (m.t > 0.9) m.flag = false;
      return;
    case "megaKnockback":
      launchProgram(m, dt, 12, 8);
      return;
    case "headbuttKnock":
      launchProgram(m, dt, HEADBUTT_KNOCK_H * 1.33, HEADBUTT_KNOCK_UP);
      return;
    case "splat":
      launchProgram(m, dt, 4, 9);
      return;
  }
}

/** Launch backwards with (vh, vy), stunned while airborne + a short skid; repeat every 3 s. */
function launchProgram(m: Mock, dt: number, vh: number, vy: number): void {
  const f = m.frame;
  if (!m.flag) {
    m.flag = true;
    m.t = 0;
    f.vy = vy;
    f.y = 0.01;
    f.grounded = false;
    const strength = Math.min(1, Math.hypot(vh, vy) / KNOCK_MAX_SPEED);
    characters.trigger(f.id, "hit", { dir: { x: Math.sin(f.yaw), y: 0, z: Math.cos(f.yaw) }, strength });
  }
  const airborne = !f.grounded;
  if (airborne) {
    forward(f, -vh);
    f.stunTicks = 10;
    fly(m, dt);
    f.x = m.homeX + Math.sin(f.yaw) * vh * Math.min(m.t, 0.35);
  } else if (m.t < 1.6) {
    forward(f, -Math.max(0, vh * 0.3 * (1 - m.t)));
    f.stunTicks = m.t < 1.2 ? 4 : 0;
  }
  if (m.t > 3) {
    m.flag = false;
    f.y = 0;
    f.vy = 0;
    f.x = m.homeX;
  }
}

function knockbackProgram(m: Mock, dt: number): void {
  const f = m.frame;
  if (!m.flag) {
    m.flag = true;
    m.t = 0;
    f.vy = 5.5;
    f.grounded = false;
    f.y = 0.01;
    characters.trigger(f.id, "hit", { dir: { x: Math.sin(f.yaw), y: 0, z: Math.cos(f.yaw) }, strength: 1 });
  }
  if (m.t < 1.0) {
    forward(f, -5 * Math.max(0, 1 - m.t));
    f.stunTicks = 5;
    if (!f.grounded) fly(m, dt);
  }
  if (m.t > 2.2) {
    m.flag = false;
    f.y = 0;
    f.vy = 0;
  }
}

function abilityProgram(m: Mock, dt: number): void {
  const f = m.frame;
  const character = f.character;
  const cycle = 2.6;
  if (m.t >= cycle) m.flag = false;
  if (!m.flag) {
    m.flag = true;
    m.t = 0;
    characters.trigger(f.id, "ability");
    if (character === "hopsworth") {
      f.vy = 9;
      f.y = 0.01;
      f.grounded = false;
    }
  }
  const tick = Math.round(m.t * TICK_RATE);
  f.dirX = -Math.sin(f.yaw + 0.6);
  f.dirZ = -Math.cos(f.yaw + 0.6);
  switch (character) {
    case "quacky":
      f.abilityTicks = Math.max(0, FLAP_DASH_TICKS - tick);
      f.grounded = f.abilityTicks === 0;
      return;
    case "hopsworth": {
      if (f.grounded) return;
      f.abilityTicks = 30;
      f.abilityPhase = f.vy > 0 ? 1 : 2;
      if (f.abilityPhase === 2) f.vy = Math.min(f.vy, -26 * Math.min(1, m.t * 2));
      if (fly(m, dt)) {
        f.abilityTicks = 0;
        characters.trigger(f.id, "slam");
      }
      return;
    }
    case "mochi":
      f.abilityTicks = Math.max(0, BELLY_BOUNCE_TICKS - tick);
      if (tick === 20) characters.trigger(f.id, "ability");
      return;
    case "whiskers":
      return;
    case "pip":
      f.abilityTicks = Math.max(0, BELLY_SLIDE_TICKS - tick);
      return;
    case "gruff":
      f.abilityTicks = Math.max(0, HEADBUTT_TICKS - tick);
      return;
  }
}

/* --------------------------------------------------------------- cameras */

type View = "lineup" | "lineupBack" | "closeup" | "closeupBack" | "crowd" | "top" | "behind20";

function setView(v: View, who?: number): void {
  if (typeof who === "number") target = who;
  const crowdMode = v === "crowd";
  setCrowd(crowdMode);
  camera.fov = v === "behind20" ? 70 : 50;
  camera.updateProjectionMatrix();
  if (v === "behind20") {
    // Over-the-shoulder offsets from 20 m behind the lineup (the animals face +Z here).
    camera.position.set(0, 2.6, -20);
    controls.target.set(0, 0.9, 0);
  } else if (v === "lineup") {
    camera.position.set(0, 1.8, 8.2);
    controls.target.set(0, 0.75, 0);
  } else if (v === "lineupBack") {
    camera.position.set(0, 1.8, -8.2);
    controls.target.set(0, 0.75, 0);
  } else if (v === "closeupBack") {
    const m = mocks[typeof target === "number" ? target : 0];
    camera.position.set(m.homeX + 1.0, 1.5, -2.7);
    controls.target.set(m.homeX, 0.8, 0);
  } else if (v === "closeup") {
    const m = mocks[typeof target === "number" ? target : 0];
    camera.position.set(m.homeX + 1.0, 1.3, 2.7);
    controls.target.set(m.homeX, 0.72, 0);
  } else if (v === "top") {
    camera.position.set(0, 4.2, 6.4);
    controls.target.set(0, 0.5, 0);
  } else {
    camera.position.set(0, 9, 15);
    controls.target.set(0, 0.5, 0);
  }
  controls.update();
}

function setCrowd(on: boolean): void {
  coverGroup.visible = on;
  if (on && !crowd) {
    characters.clear();
    crowd = createMenuCrowd(scene, getArena("picnic"));
  } else if (!on && crowd) {
    crowd.dispose();
    crowd = null;
  }
}

/* --------------------------------------------------------------- preview */

const previewBox = document.getElementById("previewBox") as HTMLElement;
const previewCanvas = document.getElementById("previewCanvas") as HTMLCanvasElement;
const stage = document.getElementById("stage") as HTMLElement;
const preview = new CharacterPreview(previewCanvas);
let previewIndex = 0;

function showPreview(on: boolean): void {
  previewBox.style.display = on ? "block" : "none";
  if (on) {
    setPreviewCharacter(previewIndex);
    preview.start();
  } else {
    preview.stop();
  }
}

function setPreviewCharacter(index: number, slot = index % 4): void {
  previewIndex = ((index % CHARACTER_IDS.length) + CHARACTER_IDS.length) % CHARACTER_IDS.length;
  const color = PLAYER_COLORS[slot];
  stage.style.setProperty("--slot", color);
  preview.setCharacter(CHARACTER_IDS[previewIndex], color);
}

/* --------------------------------------------------------------- panel UI */

/* ------------------------------------------------- silhouette / springs */

const silhouetteMaterial = new THREE.MeshBasicMaterial({ color: "#000000" });
let silhouetteOn = false;
function setSilhouette(on: boolean): void {
  silhouetteOn = on;
  scene.overrideMaterial = on ? silhouetteMaterial : null;
  scene.background = new THREE.Color(on ? "#FFFFFF" : PALETTE.skyTop);
  ground.visible = !on;
  hitboxes.visible = hitboxes.visible && !on;
}

const springDots = new THREE.Group();
springDots.visible = false;
scene.add(springDots);
const springDotGeometry = new THREE.SphereGeometry(0.025, 6, 4);
const springDotMaterial = new THREE.MeshBasicMaterial({ color: "#FF2D95", depthTest: false });
const springTip = new THREE.Vector3();
function updateSpringDots(): void {
  if (!springDots.visible) return;
  let n = 0;
  scene.traverse((o) => {
    const bones = o.userData.springs as SpringBone[] | undefined;
    if (!bones) return;
    for (const bone of bones) {
      let dot = springDots.children[n] as THREE.Mesh | undefined;
      if (!dot) {
        dot = new THREE.Mesh(springDotGeometry, springDotMaterial);
        dot.renderOrder = 10;
        springDots.add(dot);
      }
      bone.pivot.localToWorld(springTip.set(bone.tip[0], bone.tip[1], bone.tip[2]));
      dot.position.copy(springTip);
      dot.visible = true;
      n++;
    }
  });
  for (let i = n; i < springDots.children.length; i++) springDots.children[i].visible = false;
}

/** Per-animal budget (character spec §5): hi targets. */
const BUDGET_HI = { meshes: 16, drawCalls: 28, triangles: 2400, casters: 5 };
function budgets(): Record<string, AnimalBudget & { over: boolean }> {
  const out: Record<string, AnimalBudget & { over: boolean }> = {};
  for (const id of CHARACTER_IDS) {
    const root = scene.getObjectByName(`animal:${id}`);
    if (!root) continue;
    const b = measureBudget(root);
    out[id] = {
      ...b,
      over: b.meshes > BUDGET_HI.meshes || b.drawCalls > BUDGET_HI.drawCalls || b.triangles > BUDGET_HI.triangles || b.casters > BUDGET_HI.casters,
    };
  }
  return out;
}

/** Eyes × mouth grid for one animal (independent face parts). */
function faceGrid(id: CharacterId): HTMLCanvasElement {
  const sheet = getFaceSheetCanvas(id);
  const cell = FACE_SHEET_SIZE / FACE_COLUMNS;
  const eyeH = 150;
  const mouthH = cell - eyeH;
  const s = 0.35;
  const n = FACE_EXPRESSIONS.length;
  const c = document.createElement("canvas");
  c.width = Math.round(n * cell * s);
  c.height = Math.round(n * cell * s);
  c.style.width = "560px";
  c.style.height = "auto";
  const ctx = c.getContext("2d");
  if (!ctx) return c;
  ctx.fillStyle = CHARACTERS[id].colors.body;
  ctx.fillRect(0, 0, c.width, c.height);
  const src = (i: number): [number, number] => [(i % FACE_COLUMNS) * cell, Math.floor(i / FACE_COLUMNS) * cell];
  for (let e = 0; e < n; e++) {
    for (let m = 0; m < n; m++) {
      const [ex, ey] = src(e);
      const [mx, my] = src(m);
      const dx = m * cell * s;
      const dy = e * cell * s;
      ctx.drawImage(sheet, ex, ey, cell, eyeH, dx, dy, cell * s, eyeH * s);
      ctx.drawImage(sheet, mx, my + eyeH, cell, mouthH, dx, dy + eyeH * s, cell * s, mouthH * s);
    }
  }
  void FACE_SHEET_HEIGHT;
  return c;
}

const panel = document.getElementById("panel") as HTMLElement;
const stats = document.getElementById("stats") as HTMLElement;
const facesBox = document.getElementById("faces") as HTMLElement;

function section(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.appendChild(h);
  const div = document.createElement("div");
  panel.appendChild(div);
  return div;
}

function addButton(parent: HTMLElement, label: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", onClick);
  parent.appendChild(b);
  return b;
}

const targetRow = section("Target");
const targetButtons: HTMLButtonElement[] = [];
const refreshTargets = (): void => {
  targetButtons.forEach((b, i) => b.classList.toggle("on", (i === 0 && target === "all") || target === i - 1));
};
targetButtons.push(addButton(targetRow, "All", () => ((target = "all"), refreshTargets())));
CHARACTER_IDS.forEach((id, i) =>
  targetButtons.push(addButton(targetRow, `${i + 1} ${CHARACTERS[id].name}`, () => ((target = i), refreshTargets()))),
);
refreshTargets();

const stateRow = section("Continuous state (loops)");
for (const p of PROGRAMS) addButton(stateRow, p, () => setProgram(p));

const triggerRow = section("Triggers");
const TRIGGERS: AnimTrigger[] = ["throw", "catch", "whiff", "hit", "land", "pickup", "ability", "slam", "victory", "ko", "ringOut"];
for (const t of TRIGGERS) {
  addButton(triggerRow, t, () => trigger(t, t === "land" ? { strength: 1 } : t === "throw" ? { strength: 1 } : {}));
}
for (const e of ["honk", "wave", "dance"] as EmoteId[]) addButton(triggerRow, `emote ${e}`, () => trigger("emote", { emote: e }));
addButton(triggerRow, "revive", () => revive());

const extrasRow = section("Player");
addButton(extrasRow, "crown", () => {
  const m = selected()[0];
  crownId = crownId === m.frame.id ? "" : m.frame.id;
});
addButton(extrasRow, "hearts −1", () => selected().forEach((m) => (m.frame.hearts = Math.max(0, m.frame.hearts - 1))));
addButton(extrasRow, "hearts reset", () => selected().forEach((m) => (m.frame.hearts = MAX_HEARTS)));
addButton(extrasRow, "hurt flash", () => selected().forEach((m) => (m.frame.hurtTicks = HURT_INVULN_TICKS)));
addButton(extrasRow, "disconnect", () => selected().forEach((m) => (m.frame.connected = !m.frame.connected)));
addButton(extrasRow, "spectator", () => selected().forEach((m) => (m.frame.spectator = !m.frame.spectator)));
addButton(extrasRow, "local (hide plate)", () => (localId = localId === selected()[0].frame.id ? "" : selected()[0].frame.id));
addButton(extrasRow, "slot +1", () => selected().forEach((m) => (m.frame.slot = (m.frame.slot + 1) % 4)));
addButton(extrasRow, "swap animal", () =>
  selected().forEach((m) => {
    const next = CHARACTER_IDS[(CHARACTER_IDS.indexOf(m.frame.character) + 1) % CHARACTER_IDS.length];
    m.frame.character = next;
  }),
);
addButton(extrasRow, "look up/down", () => selected().forEach((m) => (m.frame.pitch = m.frame.pitch === 0 ? 0.8 : m.frame.pitch > 0 ? -0.8 : 0)));
addButton(extrasRow, "turn 90°", () => selected().forEach((m) => (m.frame.yaw += Math.PI / 2)));

const viewRow = section("View");
addButton(viewRow, "lineup", () => setView("lineup"));
addButton(viewRow, "closeup", () => setView("closeup"));
addButton(viewRow, "lineup back", () => setView("lineupBack"));
addButton(viewRow, "closeup back", () => setView("closeupBack"));
addButton(viewRow, "top", () => setView("top"));
addButton(viewRow, "behind @20 m", () => setView("behind20"));
addButton(viewRow, "silhouette", () => setSilhouette(!silhouetteOn));
addButton(viewRow, "spring tips", () => (springDots.visible = !springDots.visible));
addButton(viewRow, "face parts grid", () => {
  const id = CHARACTER_IDS[typeof target === "number" ? target : 0];
  facesBox.replaceChildren(faceGrid(id));
  facesBox.style.display = "flex";
});
addButton(viewRow, "menu crowd", () => setView("crowd"));
addButton(viewRow, "hitboxes", () => (hitboxes.visible = !hitboxes.visible));
addButton(viewRow, "held balls", () => (heldBalls.visible = !heldBalls.visible));
addButton(viewRow, "face sheets", () => {
  showSheets();
  facesBox.style.display = facesBox.style.display === "flex" ? "none" : "flex";
});
addButton(viewRow, "preview", () => showPreview(previewBox.style.display !== "block"));
addButton(viewRow, "preview next", () => setPreviewCharacter(previewIndex + 1));
addButton(viewRow, "slow-mo", () => (timeScale = timeScale === 1 ? 0.25 : 1));
addButton(viewRow, "pause", () => (paused = !paused));

function showSheets(): void {
  facesBox.replaceChildren(
    ...CHARACTER_IDS.map((id) => {
      const c = getFaceSheetCanvas(id);
      c.title = id;
      return c;
    }),
  );
}
showSheets();

/* ------------------------------------------------------------------ loop */

const syncOpts = { crownId: "", localId: "", hideLocal: false };
let last = performance.now();
let elapsed = 0;
let fpsTime = 0;
let fpsFrames = 0;
let fps = 0;
const triangles = new Map<string, number>();

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

function loop(now: number): void {
  requestAnimationFrame(loop);
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  const dt = paused ? 0 : realDt * timeScale;
  elapsed += dt;
  fpsTime += realDt;
  fpsFrames++;
  if (fpsTime >= 0.5) {
    fps = fpsFrames / fpsTime;
    fpsTime = 0;
    fpsFrames = 0;
  }

  if (crowd) {
    crowd.update(dt, elapsed);
  } else {
    for (const m of mocks) {
      stepProgram(m, dt);
      if (m.frame.hurtTicks > 0) m.frame.hurtTicks = Math.max(0, m.frame.hurtTicks - dt * TICK_RATE);
    }
    syncOpts.crownId = crownId;
    syncOpts.localId = localId;
    characters.sync(
      mocks.map((m) => m.frame),
      syncOpts,
      dt,
    );
    mocks.forEach((m, i) => {
      hitboxes.children[i].position.set(m.frame.x, m.frame.y, m.frame.z);
      m.frame.heldCount = heldBalls.visible ? 1 : 0;
      if (heldBalls.visible) characters.getHandPosition(m.frame.id, heldBalls.children[i].position);
    });
  }
  controls.update();
  updateSpringDots();
  renderer.render(scene, camera);
  updateStats();
}

function updateStats(): void {
  const lines = [`fps ${fps.toFixed(0)}  calls ${renderer.info.render.calls}  tris ${renderer.info.render.triangles}`];
  if (!crowd) {
    const b = budgetCache && performance.now() - budgetStamp < 1000 ? budgetCache : ((budgetStamp = performance.now()), (budgetCache = budgets()));
    for (const m of mocks) {
      const info = characters.inspect(m.frame.id);
      const tris = triangleCount(m.frame.character);
      const x = b[m.frame.character];
      const budget = x ? ` ${x.meshes}m ${x.drawCalls}dc ${x.triangles}△ ${x.casters}sh${x.over ? " OVER" : ""}` : "";
      lines.push(
        `${m.frame.character.padEnd(9)} ${m.program.padEnd(9)} ${(info?.state ?? "-").padEnd(8)} ${(info?.expression ?? "-").padEnd(8)} ${tris}△${budget}`,
      );
    }
  } else {
    lines.push("menu crowd running");
  }
  stats.textContent = lines.join("\n");
}

let budgetCache: ReturnType<typeof budgets> | null = null;
let budgetStamp = 0;

function triangleCount(character: CharacterId): number {
  let n = triangles.get(character);
  if (n === undefined) {
    const root = scene.getObjectByName(`animal:${character}`);
    n = root ? countTriangles(root) : 0;
    if (n > 0) triangles.set(character, n);
  }
  return n;
}

requestAnimationFrame(loop);
{
  // URL hooks for headless captures: ?ui=0&view=behind20&target=2&silhouette=1&program=run&springs=1
  const q = new URLSearchParams(location.search);
  if (q.get("ui") === "0") queueMicrotask(() => setPanels(false));
  const t = q.get("target");
  if (t !== null) target = t === "all" ? "all" : Number(t);
  const v = q.get("view") as View | null;
  if (v) setView(v);
  if (q.get("silhouette") === "1") setSilhouette(true);
  if (q.get("springs") === "1") springDots.visible = true;
  if (q.get("hitboxes") === "1") hitboxes.visible = true;
  const p = q.get("program") as Program | null;
  if (p) setProgram(p);
  const yaw = q.get("yaw");
  if (yaw !== null) for (const m of mocks) m.frame.yaw = Number(yaw);
}

window.addEventListener("keydown", (e) => {
  if (e.key >= "1" && e.key <= "6") {
    target = Number(e.key) - 1;
    refreshTargets();
  } else if (e.key === "0") {
    target = "all";
    refreshTargets();
  } else if (e.key === "h") {
    setPanels(panel.style.display === "none");
  }
});

function setPanels(visible: boolean): void {
  panel.style.display = visible ? "" : "none";
  stats.style.display = visible ? "" : "none";
}

/* -------------------------------------------------------- automation hook */

declare global {
  interface Window {
    charHarness: unknown;
  }
}

const who = (index?: number): Mock[] => (index === undefined ? selected() : [mocks[index]]);

window.charHarness = {
  scene,
  previewInstance: preview,
  setProgram: (p: Program, index?: number) => setProgram(p, who(index)),
  trigger: (anim: AnimTrigger, opts?: TriggerOptions, index?: number) => trigger(anim, opts ?? {}, who(index)),
  revive: (index?: number) => revive(who(index)),
  view: (v: View, index?: number) => setView(v, index),
  target: (index: number | "all") => {
    target = index;
    refreshTargets();
  },
  crown: (index: number) => (crownId = mocks[index].frame.id),
  local: (index: number) => (localId = mocks[index]?.frame.id ?? ""),
  hearts: (index: number, hearts: number) => (mocks[index].frame.hearts = hearts),
  connected: (index: number, on: boolean) => (mocks[index].frame.connected = on),
  hurt: (index?: number) => who(index).forEach((m) => (m.frame.hurtTicks = HURT_INVULN_TICKS)),
  pitch: (index: number, pitch: number) => (mocks[index].frame.pitch = pitch),
  yaw: (index: number, yaw: number) => (mocks[index].frame.yaw = yaw),
  hitboxes: (on: boolean) => (hitboxes.visible = on),
  silhouette: (on: boolean) => setSilhouette(on),
  springs: (on: boolean) => (springDots.visible = on),
  budget: () => budgets(),
  faceGrid: (index: number) => {
    facesBox.replaceChildren(faceGrid(CHARACTER_IDS[index]));
    facesBox.style.display = "flex";
  },
  balls: (on: boolean) => (heldBalls.visible = on),
  faces: (on: boolean) => (facesBox.style.display = on ? "flex" : "none"),
  preview: (on: boolean, index?: number) => {
    if (index !== undefined) previewIndex = index;
    showPreview(on);
  },
  previewCharacter: (index: number, slot?: number) => setPreviewCharacter(index, slot),
  timeScale: (s: number) => (timeScale = s),
  panels: (visible: boolean) => setPanels(visible),
  pause: (on: boolean) => (paused = on),
  camera: (x: number, y: number, z: number, tx: number, ty: number, tz: number) => {
    camera.position.set(x, y, z);
    controls.target.set(tx, ty, tz);
    controls.update();
  },
  info: () =>
    mocks.map((m) => ({ id: m.frame.id, character: m.frame.character, program: m.program, ...characters.inspect(m.frame.id) })),
  triangles: () => Object.fromEntries(CHARACTER_IDS.map((c) => [c, triangleCount(c)])),
  /** Per geometry type: [meshes, triangles] (outlines excluded) for one animal. */
  breakdown: (character: CharacterId) => {
    const root = scene.getObjectByName(`animal:${character}`);
    const out: Record<string, [number, number]> = {};
    root?.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.userData.isOutline) return;
      const g = o.geometry as THREE.BufferGeometry;
      const tris = (g.index ? g.index.count : g.getAttribute("position").count) / 3;
      const key = `${g.type}`;
      const entry = out[key] ?? [0, 0];
      entry[0]++;
      entry[1] += tris;
      out[key] = entry;
    });
    return out;
  },
};
