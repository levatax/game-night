// Island render harness (dev only, served by dev/vite.island.config.ts on port 5191): renders
// generateIsland(?seed=&layout=) with the real Renderer and a mock WorldFrame — no server. Free-fly camera,
// first-person walk (FpCamera head-bob / FOV / shake) and orbit; time-of-day slider (?t=0..1 of day 1's
// cycle), weather picker (?weather=), storm / launch sliders, raft stage + campfire fuel simulators, node
// depletion, placed structures, held torch, secret chest, quality tiers, reduced flashing, render stats.
// Automation hook: window.islandHarness (bottom of this file). Owner: client-render.

import * as THREE from "three";
import {
  CAMERA_FOV,
  EYE_HEIGHT,
  FIRE_FUEL_MAX_TICKS,
  FIRE_START_FUEL_TICKS,
  KRAKEN_TICKS,
  NORMAL_TIMINGS,
  SPRINT_SPEED,
  TORCH_BURN_TICKS,
  TORCH_LIGHT_RADIUS,
  RAFT_HP_MAX,
  RAFT_LAUNCH_STAGE,
  WALK_SPEED,
} from "../../shared/constants";
import { generateIsland } from "../../shared/island/generate";
import { heightAt } from "../../shared/island/heightfield";
import type { IslandDef } from "../../shared/island/types";
import { raftAssemblyTicks, raftStageNeeds } from "../../shared/items";
import { cycleTicks } from "../../shared/rules/schedule";
import type { Layout, RaftStage, StructureKind, StructureView, TeamView, Weather } from "../../shared/types";
import type { Quality } from "../src/app/settings";
import { Renderer } from "../src/render/Renderer";
import type { CameraFrame, LightSource, WorldFrame } from "../src/render/types";

type ViewMode = "fly" | "walk" | "orbit";

const QUALITIES: Quality[] = ["low", "medium", "high"];
const WEATHERS: Weather[] = ["clear", "rain", "fog", "heatwave", "fullmoon"];
const STRUCTURES: StructureKind[] = ["fence", "torch", "collector", "kraken", "hut", "canoe"];
const MOUSE_SENS = 0.0024;

/* ------------------------------------------------------------------ params */

const params = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => {
  const v = Number(params.get(key));
  return params.has(key) && Number.isFinite(v) ? v : fallback;
};
let seed = num("seed", 4471) >>> 0;
let layout: Layout = params.get("layout") === "duel" ? "duel" : "solo";
let timeOfDay = Math.min(0.999, Math.max(0, num("t", 0.3)));
let weather: Weather = WEATHERS.includes(params.get("weather") as Weather) ? (params.get("weather") as Weather) : "clear";
let quality: Quality = QUALITIES.includes(params.get("quality") as Quality) ? (params.get("quality") as Quality) : "medium";
let storm = Math.min(1, Math.max(0, num("storm", 0)));
let launch = Math.min(1, Math.max(0, num("launch", 0)));
let view: ViewMode = params.get("view") === "walk" ? "walk" : params.get("view") === "orbit" ? "orbit" : "fly";
let autoTime = params.get("auto") === "1";
let reducedFlashing = params.get("reduced") === "1";
/** ?cave=1: give site 0 a cave next to the spring when the generator placed none (render check only). */
const forceCave = params.get("cave") === "1";

/* ------------------------------------------------------------------- setup */

const container = document.getElementById("game") as HTMLElement;
const panel = document.getElementById("panel") as HTMLElement;
const statsEl = document.getElementById("stats") as HTMLElement;
if (params.get("panel") === "0") panel.classList.add("hidden");

const renderer = new Renderer(container, quality);
renderer.onLightning = (s, d) => {
  lastLog = `lightning ${s.toFixed(2)} @ ${d.toFixed(0)} m`;
  if (view === "walk") renderer.fp.shake(0.25 * s);
};
let def: IslandDef = generateIsland(seed, layout);
let genMs = 0;
let nodes: number[] = [];
let teams: TeamView[] = [];
const structures = new Map<string, StructureView>();
let structureSeq = 1;
const secretShown: boolean[] = [false, false];
let heldTorch = false;
let downed = false;
let lastLog = "";

const cam = { x: 0, y: 12, z: 30, yaw: 0, pitch: -0.3 };
const walk = { x: 0, z: 0, vx: 0, vz: 0, y: 0, grounded: true };
let orbitT = 0;
let elapsed = 0;

function makeTeam(index: number): TeamView {
  return {
    index,
    seats: 4,
    stage: 0,
    raftHave: [0, 0, 0],
    raftNeed: raftStageNeeds(0, 4),
    raftWork: 0,
    raftWorkNeed: raftAssemblyTicks(0),
    raftHp: 0,
    benchTier: 0,
    wreckScrap: 6,
    springCharges: 12,
    bossDown: false,
    fireFuel: FIRE_START_FUEL_TICKS,
    chest: new Map<string, number>(),
    flare: false,
    secretRevealed: false,
    secretOpened: false,
    springRevealed: false,
    ballRecipe: false,
    spyglassTicks: 0,
    hutHp: 0,
    score: 0,
  };
}

function loadIsland(nextSeed: number, nextLayout: Layout): void {
  seed = nextSeed >>> 0;
  layout = nextLayout;
  const t0 = performance.now();
  def = generateIsland(seed, layout);
  genMs = performance.now() - t0;
  const first = def.sites[0];
  if (forceCave && first && !first.cave) first.cave = { x: first.spring.x + 5, z: first.spring.z + 2, radius: 3.5 };
  const r0 = performance.now();
  renderer.loadIsland(def);
  lastLog = `generate ${genMs.toFixed(1)} ms · build ${(performance.now() - r0).toFixed(1)} ms`;
  nodes = def.nodes.map((n) => n.amount);
  teams = def.sites.map((_, i) => makeTeam(i));
  structures.clear();
  secretShown.fill(false);
  const site = def.sites[0]!;
  // Fly camera: above the wreck looking at the camp.
  const dx = site.campfire.x - site.wreck.x;
  const dz = site.campfire.z - site.wreck.z;
  cam.x = site.wreck.x - dx * 0.8;
  cam.z = site.wreck.z - dz * 0.8;
  cam.y = heightAt(def.grid, cam.x, cam.z) + 7;
  cam.yaw = Math.atan2(-dx, -dz);
  cam.pitch = -0.32;
  walk.x = site.spawns[0]?.x ?? site.wreck.x;
  walk.z = site.spawns[0]?.z ?? site.wreck.z;
  walk.vx = walk.vz = 0;
  updateUrl();
  refreshPanel();
}

function updateUrl(): void {
  const p = new URLSearchParams(location.search);
  p.set("seed", String(seed));
  p.set("layout", layout);
  p.set("t", timeOfDay.toFixed(3));
  p.set("weather", weather);
  p.set("quality", quality);
  history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
}

/* ---------------------------------------------------------- mock gameplay */

/** Point the mock team at raft stage `stage` (fresh materials / work), hp kept once the keel exists. */
function setRaftStage(team: TeamView, stage: RaftStage): void {
  team.stage = Math.max(0, Math.min(RAFT_LAUNCH_STAGE, stage));
  team.raftNeed = raftStageNeeds(team.stage, team.seats);
  team.raftHave = [0, 0, 0];
  team.raftWork = 0;
  team.raftWorkNeed = raftAssemblyTicks(team.stage);
  if (team.stage >= 1 && team.raftHp <= 0) team.raftHp = RAFT_HP_MAX;
  if (team.stage === 0) team.raftHp = 0;
}

/** Mock raft actions: "material" fills the current stage's first open slot, "assemble" adds work, "gnaw" hurts it. */
function deliver(kind: "material" | "assemble" | "gnaw", amount = 1): void {
  const team = teams[0];
  if (!team) return;
  const have = [...team.raftHave];
  if (kind === "material") {
    const slot = have.findIndex((h, i) => h < (team.raftNeed[i] ?? 0));
    if (slot >= 0) have[slot] = Math.min(team.raftNeed[slot] ?? 0, have[slot]! + amount);
    team.raftHave = have;
  } else if (kind === "assemble") {
    const done = have.every((h, i) => h >= (team.raftNeed[i] ?? 0));
    if (done && team.stage < RAFT_LAUNCH_STAGE) {
      team.raftWork = Math.min(team.raftWorkNeed, team.raftWork + Math.round(amount * team.raftWorkNeed * 0.25));
      if (team.raftWork >= team.raftWorkNeed) setRaftStage(team, team.stage + 1);
    }
  } else if (team.stage >= 1) {
    team.raftHp = Math.max(0, team.raftHp - 20 * amount);
    if (team.raftHp === 0) {
      setRaftStage(team, team.stage - 1);
      team.raftHave = [...team.raftNeed];
      if (team.stage >= 1) team.raftHp = 40;
    }
  }
  lastLog = `raft stage ${team.stage} · have ${[...team.raftHave].join("/")} of ${[...team.raftNeed].join("/")} · work ${team.raftWork}/${team.raftWorkNeed} · hp ${team.raftHp}`;
}

function finishRaft(): void {
  const team = teams[0];
  if (!team) return;
  setRaftStage(team, RAFT_LAUNCH_STAGE);
}

function resetRaft(): void {
  const t = teams[0];
  if (!t) return;
  setRaftStage(t, 0);
}

/** Decrement the node nearest to the camera's look point (like one gather). */
function chopNearest(): void {
  const p = lookPoint();
  let best = -1;
  let bestD = Infinity;
  def.nodes.forEach((n, i) => {
    if ((nodes[i] ?? 0) <= 0) return;
    const d = (n.x - p.x) ** 2 + (n.z - p.z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  });
  if (best < 0) return;
  nodes[best] = Math.max(0, (nodes[best] ?? 0) - 1);
  const n = def.nodes[best]!;
  lastLog = `${n.kind} #${best} (${n.yield}) → ${nodes[best]}`;
}

function depleteKind(kind: string): void {
  def.nodes.forEach((n, i) => {
    if (n.kind === kind) nodes[i] = 0;
  });
}

function resetNodes(): void {
  nodes = def.nodes.map((n) => n.amount);
}

function placeStructure(kind: StructureKind): void {
  const p = lookPoint(kind === "hut" ? 6 : 3.5);
  const id = `s${structureSeq++}`;
  const yaw = Math.round(cam.yaw / (Math.PI / 4)) * (Math.PI / 4);
  structures.set(id, {
    id,
    kind,
    x: p.x,
    y: heightAt(def.grid, p.x, p.z),
    z: p.z,
    yaw,
    team: 0,
    ownerId: "dev",
    hp: kind === "fence" ? 4 : 3,
    life: kind === "torch" ? TORCH_BURN_TICKS : kind === "kraken" ? KRAKEN_TICKS : 0,
    uses: 0,
  });
  lastLog = `placed ${kind} ${id}`;
}

/** A point on the ground in front of the active camera. */
function lookPoint(dist = 4): { x: number; z: number } {
  const src = view === "walk" ? { x: walk.x, z: walk.z } : { x: cam.x, z: cam.z };
  const yaw = cam.yaw;
  return { x: src.x - Math.sin(yaw) * dist, z: src.z - Math.cos(yaw) * dist };
}

/* -------------------------------------------------------------------- input */

const keys = new Set<string>();
window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).tagName === "INPUT") return;
  keys.add(e.code);
  if (e.repeat) return;
  switch (e.code) {
    case "KeyP":
      panel.classList.toggle("hidden");
      break;
    case "KeyF":
      setView("fly");
      break;
    case "KeyG":
      setView("walk");
      break;
    case "KeyO":
      setView("orbit");
      break;
    case "KeyC":
      chopNearest();
      break;
    case "KeyL":
      renderer.lightning(1);
      break;
    case "KeyN":
      loadIsland((seed + 1) >>> 0, layout);
      break;
    case "KeyB":
      loadIsland((seed + 0xffffffff) >>> 0, layout);
      break;
    case "KeyT":
      autoTime = !autoTime;
      refreshPanel();
      break;
  }
});
window.addEventListener("keyup", (e) => keys.delete(e.code));
window.addEventListener("blur", () => keys.clear());

const canvas = renderer.canvas;
canvas.addEventListener("click", () => {
  if (document.pointerLockElement !== canvas) void canvas.requestPointerLock();
});
window.addEventListener("mousemove", (e) => {
  if (document.pointerLockElement !== canvas) return;
  cam.yaw -= e.movementX * MOUSE_SENS;
  cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - e.movementY * MOUSE_SENS));
});
window.addEventListener("mousedown", (e) => {
  if (document.pointerLockElement !== canvas) return;
  if (e.button === 0) renderer.fp.recoil(0.8);
  if (e.button === 2) renderer.fp.punch(1);
});
window.addEventListener("contextmenu", (e) => e.preventDefault());

function axis(pos: string, neg: string): number {
  return (keys.has(pos) ? 1 : 0) - (keys.has(neg) ? 1 : 0);
}

function setView(next: ViewMode): void {
  if (next === "walk" && view !== "walk") {
    walk.x = cam.x;
    walk.z = cam.z;
  }
  view = next;
  refreshPanel();
}

/* -------------------------------------------------------------------- panel */

function button(label: string, on: boolean, action: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  if (on) b.classList.add("on");
  b.addEventListener("click", (e) => {
    e.stopPropagation();
    action();
    refreshPanel();
  });
  return b;
}

function slider(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void): HTMLLabelElement {
  const l = document.createElement("label");
  const s = document.createElement("span");
  s.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  input.addEventListener("input", () => onInput(Number(input.value)));
  l.append(s, input);
  return l;
}

function section(title: string, children: HTMLElement[]): void {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.append(h, ...children);
}

function refreshPanel(): void {
  panel.replaceChildren();
  const seedRow = document.createElement("label");
  const seedLabel = document.createElement("span");
  seedLabel.textContent = "Seed";
  const seedInput = document.createElement("input");
  seedInput.type = "number";
  seedInput.value = String(seed);
  seedInput.addEventListener("change", () => loadIsland(Number(seedInput.value) >>> 0, layout));
  seedRow.append(seedLabel, seedInput);
  section(`Island · ${def.biome}`, [
    seedRow,
    button("◀ (B)", false, () => loadIsland((seed + 0xffffffff) >>> 0, layout)),
    button("Next (N)", false, () => loadIsland((seed + 1) >>> 0, layout)),
    button("Random", false, () => loadIsland((Math.random() * 0xffffffff) >>> 0, layout)),
    button("Solo", layout === "solo", () => loadIsland(seed, "solo")),
    button("Duel", layout === "duel", () => loadIsland(seed, "duel")),
  ]);
  section("View", [
    button("Fly (F)", view === "fly", () => setView("fly")),
    button("Walk (G)", view === "walk", () => setView("walk")),
    button("Orbit (O)", view === "orbit", () => setView("orbit")),
    button("Downed", downed, () => (downed = !downed)),
    button("Shake", false, () => renderer.fp.shake(0.6)),
    button("Recoil", false, () => renderer.fp.recoil(1)),
    button("Punch", false, () => renderer.fp.punch(1)),
  ]);
  section("Time & weather", [
    slider("Time", timeOfDay, 0, 0.999, 0.001, (v) => {
      timeOfDay = v;
      updateUrl();
    }),
    button(autoTime ? "Auto ×8 (T)" : "Auto off (T)", autoTime, () => (autoTime = !autoTime)),
    button("Dawn", false, () => (timeOfDay = 0.02)),
    button("Noon", false, () => (timeOfDay = 0.3)),
    button("Sunset", false, () => (timeOfDay = 0.63)),
    button("Night", false, () => (timeOfDay = 0.82)),
    ...WEATHERS.map((w) =>
      button(w, w === weather, () => {
        weather = w;
        updateUrl();
      }),
    ),
    slider("Storm", storm, 0, 1, 0.01, (v) => (storm = v)),
    button("Lightning (L)", false, () => renderer.lightning(1)),
    button("Reduced flash", reducedFlashing, () => (reducedFlashing = !reducedFlashing)),
  ]);
  const team = teams[0];
  section(`Raft · stage ${team?.stage ?? 0}`, [
    button("+material", false, () => deliver("material", 1)),
    button("+5 material", false, () => deliver("material", 5)),
    button("assemble", false, () => deliver("assemble", 1)),
    button("gnaw", false, () => deliver("gnaw", 1)),
    button("Finish", false, finishRaft),
    button("Reset", false, resetRaft),
    slider("Launch", launch, 0, 1, 0.01, (v) => (launch = v)),
  ]);
  section("Camp", [
    slider("Fire fuel", (team?.fireFuel ?? 0) / FIRE_FUEL_MAX_TICKS, 0, 1, 0.005, (v) => {
      for (const t of teams) t.fireFuel = Math.round(v * FIRE_FUEL_MAX_TICKS);
    }),
    button("Secret chest", secretShown[0] === true, () => (secretShown[0] = !secretShown[0])),
    button("Open it", team?.secretOpened === true, () => {
      if (team) team.secretOpened = !team.secretOpened;
    }),
    button("Held torch", heldTorch, () => (heldTorch = !heldTorch)),
  ]);
  section("Nodes", [
    button("Chop nearest (C)", false, chopNearest),
    button("Fell trees", false, () => depleteKind("tree")),
    button("Pick palms", false, () => depleteKind("palm")),
    button("Mine rocks", false, () => depleteKind("rock")),
    button("Strip bushes", false, () => depleteKind("bush")),
    button("Regrow", false, resetNodes),
  ]);
  section("Structures", [
    ...STRUCTURES.map((k) => button(k, false, () => placeStructure(k))),
    button("Damage", false, () => {
      for (const s of structures.values()) s.hp = Math.max(0, s.hp - 1);
    }),
    button("+water", false, () => {
      for (const s of structures.values()) if (s.kind === "collector") s.uses = Math.min(3, s.uses + 1);
    }),
    button("Clear", false, () => structures.clear()),
  ]);
  section("Quality", QUALITIES.map((q) => button(q, q === quality, () => setQuality(q))));
  const help = document.createElement("div");
  help.className = "keys";
  help.textContent =
    "Click = mouse look. Fly: WASD + Space/Q up/down, Shift fast. Walk: WASD, Shift sprint. LMB recoil, RMB punch. C chop nearest node, L lightning, N/B next/prev seed, T auto time, P hide panel.";
  panel.append(help);
}

function setQuality(q: Quality): void {
  quality = q;
  renderer.setQuality(q);
  updateUrl();
}

/* --------------------------------------------------------------------- loop */

const cameraFrame: CameraFrame = {
  eye: { x: 0, y: 0, z: 0 },
  yaw: 0,
  pitch: 0,
  speed: 0,
  grounded: true,
  sprinting: false,
  swimming: false,
  downed: false,
  spectate: false,
  charge: 0,
  fov: CAMERA_FOV,
  headBob: true,
};
const lights: LightSource[] = [];
const world: WorldFrame = {
  phase: "playing",
  clockTicks: 0,
  timings: NORMAL_TIMINGS,
  weather: "clear",
  biome: def.biome,
  nodes,
  teams,
  structures: structures.values(),
  lights,
  focus: { x: 0, y: 0, z: 0 },
  launch: 0,
  storm: 0,
  secretShown,
  reducedFlashing: false,
};

let lastMs = 0;
let fps = 60;

function step(realDt: number): void {
  if (autoTime) timeOfDay = (timeOfDay + (realDt * 8) / (cycleTicks(NORMAL_TIMINGS) / 30)) % 1;
  // Tick life of lifetimed structures like the server would.
  for (const [id, s] of structures) {
    if (s.life > 0) {
      s.life = Math.max(0, s.life - realDt * 30);
      if (s.life <= 0) structures.delete(id);
    }
  }
  // Burn the fire slowly so the flame visibly shrinks.
  for (const t of teams) t.fireFuel = Math.max(0, t.fireFuel - realDt * 30 * 0.25);

  if (view === "fly") {
    const speed = keys.has("ShiftLeft") ? 30 : 10;
    const fx = -Math.sin(cam.yaw) * Math.cos(cam.pitch);
    const fy = Math.sin(cam.pitch);
    const fz = -Math.cos(cam.yaw) * Math.cos(cam.pitch);
    const rx = Math.cos(cam.yaw);
    const rz = -Math.sin(cam.yaw);
    const f = axis("KeyW", "KeyS");
    const r = axis("KeyD", "KeyA");
    const u = axis("Space", "KeyQ");
    cam.x += (fx * f + rx * r) * speed * realDt;
    cam.y += (fy * f + u) * speed * realDt;
    cam.z += (fz * f + rz * r) * speed * realDt;
  } else if (view === "walk") {
    const sprint = keys.has("ShiftLeft");
    const speed = downed ? WALK_SPEED * 0.25 : sprint ? SPRINT_SPEED : WALK_SPEED;
    const f = axis("KeyW", "KeyS");
    const r = axis("KeyD", "KeyA");
    const wx = (-Math.sin(cam.yaw) * f + Math.cos(cam.yaw) * r) * speed;
    const wz = (-Math.cos(cam.yaw) * f - Math.sin(cam.yaw) * r) * speed;
    const k = Math.min(1, realDt * 12);
    walk.vx += (wx - walk.vx) * k;
    walk.vz += (wz - walk.vz) * k;
    walk.x += walk.vx * realDt;
    walk.z += walk.vz * realDt;
    const ground = heightAt(def.grid, walk.x, walk.z);
    walk.y = Math.max(ground, -1.1);
  } else {
    orbitT += realDt * 0.12;
  }
}

function frame(now: number): void {
  requestAnimationFrame(frame);
  const realDt = lastMs > 0 ? Math.min(0.1, (now - lastMs) / 1000) : 0;
  lastMs = now;
  if (realDt > 0) fps += (1 / realDt - fps) * 0.05;
  elapsed += realDt;
  step(realDt);

  lights.length = 0;
  const eye = view === "walk" ? { x: walk.x, y: walk.y + (downed ? 0.45 : EYE_HEIGHT), z: walk.z } : { x: cam.x, y: cam.y, z: cam.z };
  if (heldTorch) {
    lights.push({ x: eye.x - Math.sin(cam.yaw) * 0.4 + Math.cos(cam.yaw) * 0.3, y: eye.y - 0.25, z: eye.z - Math.cos(cam.yaw) * 0.4 - Math.sin(cam.yaw) * 0.3, radius: TORCH_LIGHT_RADIUS, intensity: 1 });
  }
  world.clockTicks = timeOfDay * cycleTicks(NORMAL_TIMINGS);
  world.weather = weather;
  world.biome = def.biome;
  world.nodes = nodes;
  world.teams = teams;
  world.structures = structures.values();
  world.focus = eye;
  world.launch = launch;
  world.storm = storm;
  world.reducedFlashing = reducedFlashing;
  world.phase = launch > 0 ? "launch" : storm >= 1 ? "storm" : "playing";
  renderer.update(realDt, elapsed, world);

  if (view === "orbit") {
    const c = def.sites[0]!.center;
    renderer.fp.orbit({ x: c.x, y: 2, z: c.z }, 58, 30, orbitT);
  } else {
    cameraFrame.eye = eye;
    cameraFrame.yaw = cam.yaw;
    cameraFrame.pitch = cam.pitch;
    cameraFrame.speed = view === "walk" ? Math.hypot(walk.vx, walk.vz) : 0;
    cameraFrame.grounded = true;
    cameraFrame.sprinting = view === "walk" && keys.has("ShiftLeft");
    cameraFrame.swimming = view === "walk" && walk.y < -0.6;
    cameraFrame.downed = downed;
    cameraFrame.headBob = view === "walk";
    renderer.fp.update(realDt, cameraFrame);
  }
  renderer.render();
  showStats();
}

function showStats(): void {
  const s = renderer.stats();
  const t = teams[0];
  statsEl.textContent = [
    `${fps.toFixed(0)} fps · ${s.calls} calls · ${(s.triangles / 1000).toFixed(1)}k tris (island ${(s.islandTriangles / 1000).toFixed(1)}k) · dpr ${s.pixelRatio.toFixed(2)}`,
    `seed ${seed} · ${layout} · ${def.biome} · ${quality} · t ${timeOfDay.toFixed(3)} · ${weather}${storm > 0 ? ` · storm ${storm.toFixed(2)}` : ""} · dark ${renderer.darkness.toFixed(2)}`,
    `nodes ${def.nodes.length} · fish ${def.fishSpots.length} · raft ${t?.stage ?? 0} · fire ${((t?.fireFuel ?? 0) / 30).toFixed(0)} s · geo ${s.geometries} tex ${s.textures} prog ${s.programs}`,
    lastLog,
  ].join("\n");
}

/* --------------------------------------------------------------- automation */

declare global {
  interface Window {
    islandHarness: {
      load(seed: number, layout?: Layout): void;
      setTime(t: number): void;
      setWeather(w: Weather): void;
      setStorm(v: number): void;
      setLaunch(v: number): void;
      setQuality(q: Quality): void;
      setView(v: ViewMode): void;
      /** Fly camera pose. */
      flyTo(x: number, y: number, z: number, yaw: number, pitch: number): void;
      finishRaft(): void;
      deliver(kind: "material" | "assemble" | "gnaw", amount?: number): void;
      setFuel(ticks: number): void;
      place(kind: StructureKind): void;
      chop(): void;
      reveal(shown: boolean, opened?: boolean): void;
      heldTorch(on: boolean): void;
      downed(on: boolean): void;
      hidePanel(hidden: boolean): void;
      stats(): ReturnType<Renderer["stats"]> & { fps: number; seed: number; biome: string };
      island(): IslandDef;
      /** Terrain height at (x, z). */
      ground(x: number, z: number): number;
      /** The live Renderer (console poking). */
      renderer: Renderer;
    };
  }
}

window.islandHarness = {
  load: (s, l) => loadIsland(s >>> 0, l ?? layout),
  setTime: (t) => (timeOfDay = Math.min(0.999, Math.max(0, t))),
  setWeather: (w) => {
    weather = w;
    renderer.snapWeather();
  },
  setStorm: (v) => (storm = v),
  setLaunch: (v) => (launch = v),
  setQuality,
  setView,
  flyTo(x, y, z, yaw, pitch) {
    setView("fly");
    Object.assign(cam, { x, y, z, yaw, pitch });
  },
  finishRaft,
  deliver,
  setFuel: (ticks) => {
    for (const t of teams) t.fireFuel = ticks;
  },
  place: placeStructure,
  chop: chopNearest,
  reveal(shown, opened = false) {
    secretShown[0] = shown;
    if (teams[0]) teams[0].secretOpened = opened;
  },
  heldTorch: (on) => (heldTorch = on),
  downed: (on) => (downed = on),
  hidePanel: (hidden) => panel.classList.toggle("hidden", hidden),
  stats: () => ({ ...renderer.stats(), fps: Math.round(fps), seed, biome: def.biome }),
  island: () => def,
  ground: (x, z) => heightAt(def.grid, x, z),
  renderer,
};

loadIsland(seed, layout);
requestAnimationFrame(frame);
