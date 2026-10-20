// Render harness: Renderer, Sky, Arena (all 3 maps, sudden-death crumble), CameraRig (follow with
// cover collision, charge FOV, ghost, orbit, KO cut, shake) and MenuScene, driven by a mock
// player that runs the real shared movement sim. Dev only (served by dev/vite.client-render.config.ts).
// Automation hook: window.renderHarness (see the bottom of this file).

import * as THREE from "three";
import { DT, PALETTE, PLAYER_HEIGHT, PLAYER_RADIUS, RING_FALLEN, RING_OUT_Y, RING_SHAKING, RING_SOLID } from "../../shared/constants";
import { getArena, type CrumbleKind } from "../../shared/maps";
import { BTN, type InputCmd } from "../../shared/protocol";
import type { SimContext } from "../../shared/sim/context";
import { clamp, lerp, lerpAngle } from "../../shared/sim/math";
import { createPlayerSim, stepPlayer, type PlayerSim } from "../../shared/sim/player";
import type { MapId } from "../../shared/types";
import type { Quality } from "../src/app/settings";
import { createMenuCrowd } from "../src/characters/MenuCrowd";
import { CameraRig, type CameraMode, type CameraUpdate } from "../src/render/CameraRig";
import { MenuScene } from "../src/render/MenuScene";
import { Renderer } from "../src/render/Renderer";
import { addOutline, createToonMaterial } from "../src/render/Toon";

type ViewMode = CameraMode | "menu";

const MAPS: MapId[] = ["picnic", "bath", "cake"];
const QUALITIES: Quality[] = ["low", "medium", "high"];
const MOUSE_SENS = 0.0025;
const SD_INTERVAL_SEC = 2.5;
const SHAKE_SEC = 0.8;

/* ------------------------------------------------------------------ setup */

const container = document.getElementById("game") as HTMLElement;
const panel = document.getElementById("panel") as HTMLElement;
const stats = document.getElementById("stats") as HTMLElement;
const crosshair = document.getElementById("crosshair") as HTMLElement;

let quality: Quality = "medium";
const renderer = new Renderer(container, quality);
const rig = new CameraRig(renderer.camera);
const menu = new MenuScene(renderer, createMenuCrowd);

let mapId: MapId = "picnic";
let rings: number[] = [];
let view: ViewMode = "follow";
let elapsed = 0;
let lastLog = "";

const ctx: SimContext = { arena: getArena(mapId), rings, character: "quacky", dt: DT, locked: false };

/* ------------------------------------------------------------ mock player */

const player: PlayerSim = createPlayerSim();
const prev: PlayerSim = createPlayerSim();
const look = { yaw: 0, pitch: -0.15 };
let seq = 0;
let acc = 0;
let charge = 0;
let throwHeld = false;
let jumpLatch = false;
const keys = new Set<string>();

const avatar = buildAvatar(PALETTE.uiRed);
renderer.scene.add(avatar);

/** Capsule "animal" with eyes and a beak so facing reads; outlined and shadow-casting like a character. */
function buildAvatar(color: string): THREE.Group {
  const group = new THREE.Group();
  group.name = "mockPlayer";
  const bodyH = PLAYER_HEIGHT - PLAYER_RADIUS * 2;
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, bodyH, 6, 16), createToonMaterial(color));
  body.position.y = PLAYER_HEIGHT / 2;
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.34, 16, 12), createToonMaterial("#FFF1C9"));
  belly.scale.set(1, 1.2, 0.5);
  belly.position.set(0, 0.62, -0.26);
  const beak = new THREE.Mesh(new THREE.ConeGeometry(0.1, 0.24, 10), createToonMaterial("#FF9A2E"));
  beak.rotation.x = -Math.PI / 2;
  beak.position.set(0, 1.08, -0.5);
  group.add(body, belly, beak);
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.075, 12, 10), createToonMaterial(PALETTE.ink));
    eye.position.set(side * 0.17, 1.22, -0.39);
    eye.userData.noOutline = true;
    group.add(eye);
  }
  addOutline(group, 0.03);
  group.traverse((o) => {
    if (o instanceof THREE.Mesh && !o.userData.isOutline) o.castShadow = true;
  });
  return group;
}

function respawn(): void {
  const spawn = getArena(mapId).spawns[0];
  Object.assign(player, createPlayerSim(), { x: spawn.x, y: 0, z: spawn.z, yaw: spawn.yaw, alive: true });
  Object.assign(prev, player);
  look.yaw = spawn.yaw;
  look.pitch = -0.15;
}

function sampleInput(): InputCmd {
  const ghost = view === "ghost";
  const moveX = ghost ? 0 : axis("KeyD", "KeyA");
  const moveZ = ghost ? 0 : axis("KeyW", "KeyS");
  let buttons = 0;
  if (jumpLatch) buttons |= BTN.JUMP;
  jumpLatch = false;
  return { seq: ++seq, moveX, moveZ, yaw: look.yaw, pitch: look.pitch, buttons };
}

function axis(pos: string, neg: string): number {
  return (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
}

function stepSim(realDt: number): number {
  acc += Math.min(realDt, 0.25);
  while (acc >= DT) {
    Object.assign(prev, player);
    stepPlayer(player, sampleInput(), ctx);
    if (player.y < RING_OUT_Y) respawn();
    acc -= DT;
  }
  return acc / DT;
}

function placeAvatar(alpha: number): { x: number; y: number; z: number } {
  const x = lerp(prev.x, player.x, alpha);
  const y = lerp(prev.y, player.y, alpha);
  const z = lerp(prev.z, player.z, alpha);
  avatar.position.set(x, y, z);
  avatar.rotation.y = lerpAngle(prev.yaw, player.yaw, alpha);
  // Hide the avatar when the camera is pushed into the player's head (like GameController does).
  const cam = renderer.camera.position;
  avatar.visible = view !== "menu" && Math.hypot(cam.x - x, cam.y - (y + 1), cam.z - z) > 0.9;
  return { x, y, z };
}

/* ------------------------------------------------------------- the world */

function setMap(id: MapId): void {
  mapId = id;
  const arena = renderer.loadArena(id);
  rings = Array.from({ length: arena.def.ringRadii.length }, () => RING_SOLID);
  ctx.arena = arena.def;
  ctx.rings = rings;
  rig.setFloorQuery({ arena: arena.def, rings });
  arena.onRingFall = (ring: number, crumble: CrumbleKind) => log(`onRingFall(${ring}, "${crumble}")`);
  suddenDeath = null;
  respawn();
  refreshPanel();
}

function setQuality(q: Quality): void {
  quality = q;
  renderer.setQuality(q);
  refreshPanel();
}

function setView(next: ViewMode): void {
  if (next === view) return;
  if (view === "menu") menu.stop();
  view = next;
  if (next === "menu") {
    setMap("picnic");
    menu.start();
  } else if (next === "ghost") {
    rig.enterGhost({ x: player.x, y: player.y + 2.5, z: player.z }, look.yaw);
    look.pitch = -0.35;
  }
  crosshair.classList.toggle("hidden", next !== "follow");
  refreshPanel();
}

function setRing(index: number, state: number): void {
  if (index < 0 || index >= rings.length) return;
  rings[index] = state;
}

function resetRings(): void {
  rings.fill(RING_SOLID);
  suddenDeath = null;
}

/** Accelerated sudden death: shake the outermost solid ring, drop it 0.8 s later, repeat. */
let suddenDeath: { timer: number; shaking: number } | null = null;

function startSuddenDeath(): void {
  suddenDeath = { timer: 0, shaking: -1 };
}

function updateSuddenDeath(dt: number): void {
  const sd = suddenDeath;
  if (!sd) return;
  sd.timer -= dt;
  if (sd.shaking >= 0 && sd.timer <= SD_INTERVAL_SEC - SHAKE_SEC) {
    setRing(sd.shaking, RING_FALLEN);
    sd.shaking = -1;
  }
  if (sd.timer > 0) return;
  let outer = -1;
  for (let i = rings.length - 1; i >= 1; i--) {
    if (rings[i] === RING_SOLID) {
      outer = i;
      break;
    }
  }
  if (outer < 0) {
    suddenDeath = null;
    return;
  }
  setRing(outer, RING_SHAKING);
  sd.shaking = outer;
  sd.timer = SD_INTERVAL_SEC;
}

function koCut(): void {
  const a = getArena(mapId);
  const c = a.cover[0];
  rig.koCut({ x: c ? c.x + 1.2 : 2, y: 0, z: c ? c.z + 1.2 : 2 }, 1);
}

function log(text: string): void {
  lastLog = text;
  console.info(`[render-harness] ${text}`);
}

/* ------------------------------------------------------------------ input */

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  keys.add(e.code);
  switch (e.code) {
    case "Digit1":
    case "Digit2":
    case "Digit3":
      setMap(MAPS[Number(e.code.slice(5)) - 1]);
      break;
    case "Digit4":
    case "Digit5":
    case "Digit6":
      setQuality(QUALITIES[Number(e.code.slice(5)) - 4]);
      break;
    case "KeyF":
      setView("follow");
      break;
    case "KeyG":
      setView("ghost");
      break;
    case "KeyO":
      setView("orbit");
      break;
    case "KeyM":
      setView("menu");
      break;
    case "KeyK":
      koCut();
      break;
    case "KeyH":
      rig.shake(0.35, 0.35);
      break;
    case "KeyJ":
      rig.shake(0.6, 0.5);
      break;
    case "KeyT":
      startSuddenDeath();
      break;
    case "KeyR":
      resetRings();
      break;
    case "KeyP":
      panel.classList.toggle("hidden");
      break;
    case "Space":
      jumpLatch = true;
      break;
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

const canvas = renderer.webgl.domElement;
canvas.addEventListener("click", () => {
  if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
});
canvas.addEventListener("mousedown", (e) => {
  if (e.button === 0 && document.pointerLockElement === canvas) throwHeld = true;
});
window.addEventListener("mouseup", (e) => {
  if (e.button === 0) throwHeld = false;
});
window.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  look.yaw -= e.movementX * MOUSE_SENS;
  look.pitch = clamp(look.pitch - e.movementY * MOUSE_SENS, -1.2, 1.2);
});

/* ------------------------------------------------------------------ panel */

function button(label: string, on: boolean, action: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (on) b.classList.add("on");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
  });
  return b;
}

function section(title: string, buttons: HTMLButtonElement[]): void {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.append(h, ...buttons);
}

function refreshPanel(): void {
  panel.replaceChildren();
  section("Map (1-3)", MAPS.map((id) => button(getArena(id).name, id === mapId, () => setMap(id))));
  section("Quality (4-6)", QUALITIES.map((q) => button(q, q === quality, () => setQuality(q))));
  section("View", [
    button("Follow (F)", view === "follow", () => setView("follow")),
    button("Ghost (G)", view === "ghost", () => setView("ghost")),
    button("Orbit (O)", view === "orbit", () => setView("orbit")),
    button("Menu (M)", view === "menu", () => setView("menu")),
  ]);
  section("Camera", [
    button("KO cut (K)", false, koCut),
    button("Shake hit (H)", false, () => rig.shake(0.35, 0.35)),
    button("Shake big (J)", false, () => rig.shake(0.6, 0.5)),
    button("FOV base 70", false, () => rig.setBaseFov(70)),
    button("FOV base 90", false, () => rig.setBaseFov(90)),
  ]);
  const ringButtons: HTMLButtonElement[] = [];
  for (let i = rings.length - 1; i >= 1; i--) {
    ringButtons.push(button(`Shake ${i}`, false, () => setRing(i, RING_SHAKING)));
    ringButtons.push(button(`Drop ${i}`, false, () => setRing(i, RING_FALLEN)));
  }
  section("Rings", [
    button("Sudden death (T)", false, startSuddenDeath),
    button("Reset (R)", false, resetRings),
    ...ringButtons,
  ]);
  const keysHelp = document.createElement("div");
  keysHelp.className = "keys";
  keysHelp.textContent =
    "Click canvas = mouse look. WASD move, Space jump, hold LMB = charge (FOV zoom). Ghost: WASD + Space/Shift (Q/E) up/down. P hides this panel.";
  panel.append(keysHelp);
}

/* ------------------------------------------------------------------- loop */

let lastMs = 0;
let fps = 60;
const update: CameraUpdate = { mode: "follow", charge: 0 };
const ghostMove = { x: 0, y: 0, z: 0 };

function frame(now: number): void {
  requestAnimationFrame(frame);
  const realDt = lastMs > 0 ? Math.min(0.1, (now - lastMs) / 1000) : 0;
  lastMs = now;
  if (realDt > 0) fps = lerp(fps, 1 / realDt, 0.05);
  elapsed += realDt;

  if (view === "menu") {
    menu.update(realDt, elapsed);
    avatar.visible = false;
  } else {
    updateSuddenDeath(realDt);
    renderer.arena?.syncRings(rings);
    const alpha = stepSim(realDt);
    const pos = placeAvatar(alpha);
    charge = throwHeld ? Math.min(1, charge + realDt) : 0;
    update.mode = view;
    update.charge = charge;
    update.target = { ...pos, yaw: look.yaw, pitch: look.pitch };
    ghostMove.x = axis("KeyD", "KeyA");
    ghostMove.z = axis("KeyW", "KeyS");
    ghostMove.y = (keys.has("Space") || keys.has("KeyE") ? 1 : 0) - (keys.has("ShiftLeft") || keys.has("KeyQ") ? 1 : 0);
    update.ghostMove = ghostMove;
    update.ghostLook = look;
    update.orbitCenter = { x: 0, y: 0, z: 0 };
    rig.update(realDt, update);
    renderer.update(realDt, elapsed);
  }
  renderer.render();
  showStats();
}

function showStats(): void {
  const info = renderer.webgl.info.render;
  stats.textContent = [
    `${fps.toFixed(0)} fps · ${info.calls} calls · ${(info.triangles / 1000).toFixed(0)}k tris`,
    `${mapId} · ${quality} · ${view}${rig.cutting ? " · KO cut" : ""} · fov ${renderer.camera.fov.toFixed(1)}`,
    `rings [${rings.join(" ")}]${lastLog ? ` · ${lastLog}` : ""}`,
  ].join("\n");
}

/* ------------------------------------------------------------ automation */

declare global {
  interface Window {
    renderHarness: {
      setMap(id: MapId): void;
      setQuality(q: Quality): void;
      setView(v: ViewMode): void;
      setRing(index: number, state: number): void;
      resetRings(): void;
      suddenDeath(): void;
      koCut(): void;
      shake(intensity: number, sec: number): void;
      /** Teleport the mock player (feet) and set the look. */
      place(x: number, z: number, yaw: number, pitch: number): void;
      setLook(yaw: number, pitch: number): void;
      /** Switch to the ghost camera at a given spot and look. */
      ghostAt(x: number, y: number, z: number, yaw: number, pitch: number): void;
      setCharge(held: boolean): void;
      hidePanel(hidden: boolean): void;
      stats(): { fps: number; calls: number; triangles: number; geometries: number; textures: number; programs: number };
    };
  }
}

window.renderHarness = {
  setMap,
  setQuality,
  setView,
  setRing,
  resetRings,
  suddenDeath: startSuddenDeath,
  koCut,
  shake: (i, s) => rig.shake(i, s),
  place(x, z, yaw, pitch) {
    Object.assign(player, { x, y: 0, z, vx: 0, vy: 0, vz: 0, yaw });
    Object.assign(prev, player);
    look.yaw = yaw;
    look.pitch = pitch;
  },
  setLook(yaw, pitch) {
    look.yaw = yaw;
    look.pitch = pitch;
  },
  ghostAt(x, y, z, yaw, pitch) {
    setView("ghost");
    rig.enterGhost({ x, y, z }, yaw);
    look.yaw = yaw;
    look.pitch = pitch;
  },
  setCharge(held) {
    throwHeld = held;
  },
  hidePanel(hidden) {
    panel.classList.toggle("hidden", hidden);
  },
  stats() {
    const info = renderer.webgl.info;
    return {
      fps: Math.round(fps),
      calls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
    };
  },
};

setMap("picnic");
requestAnimationFrame(frame);
