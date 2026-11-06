// FX harness: the real Fx facade on a small hand-made beach (sand sloping into the sea) with buttons for every
// burst kind, pop-text style (EN / TR samples), item pop, all 22 item meshes (gallery + resting pickups), thrown
// projectiles through a tiny local ballistic sim (tumble, bounce squash, spear sticking, splash, bait smell,
// predicted fade-out), the dotted arc preview, ping balloons, fishing bobbers (bite!), charge glows, quality /
// reduced-flashing / night toggles and live counters. Double-click the ground to move the target. Dev only
// (served / built by dev/vite.fx.config.ts, never part of the game build). Owner: client-fx-audio.
// Automation hook: window.fxHarness (see the bottom of this file).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GRAVITY, MARKER_KINDS, MARKER_TICKS, PALETTE, PLAYER_COLORS, PUFFER_BLAST_RADIUS, TICK_RATE, WATER_Y } from "../../shared/constants";
import { createHeightfield, heightAt, normalAt } from "../../shared/island/heightfield";
import type { IslandDef } from "../../shared/island/types";
import { ITEMS, ITEM_KINDS } from "../../shared/items";
import type { ItemKind, MarkerKind, Vec3Like } from "../../shared/types";
import { BURST_KINDS, Fx, POP_STYLE_IDS, type Bobber, type BurstKind, type PopStyle } from "../src/fx/Fx";
import { buildBerryMesh, buildItemMesh, flickerFlame, itemTriangleCount, setItemGlow } from "../src/fx/itemMeshes";
import type { ProjectileFrame } from "../src/net/types";
import { createToonMaterial, OVERLAY_LAYER } from "../src/render/Toon";

/* ------------------------------------------------------------------ scene */

const container = document.getElementById("game") as HTMLElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const DAY_SKY = new THREE.Color("#7FD3F5");
const NIGHT_SKY = new THREE.Color("#0B1A33");
scene.background = DAY_SKY.clone();
scene.fog = new THREE.Fog(DAY_SKY.clone(), 40, 160);
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.05, 400);
camera.layers.enable(OVERLAY_LAYER); // marker labels / nameplates
camera.position.set(9, 7, -16);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 2);
controls.update();

const hemi = new THREE.HemisphereLight("#FFFFFF", "#C9B98A", 1.6);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#FFF4DC", 2.2);
sun.position.set(-10, 20, -6);
scene.add(sun);
const campLight = new THREE.PointLight("#FFB347", 0, 14, 1.6);
campLight.position.set(-4, 2, -3);
scene.add(campLight);

/* ---------------------------------------------------------------- terrain */

const SIZE = 64;
const grid = createHeightfield(SIZE + 1, SIZE + 1, 1, -SIZE / 2, -SIZE / 2);
for (let r = 0; r <= SIZE; r++) {
  for (let c = 0; c <= SIZE; c++) {
    const x = -SIZE / 2 + c;
    const z = -SIZE / 2 + r;
    const h = 1.1 - 0.075 * z + 0.18 * Math.sin(x * 0.31) * Math.cos(z * 0.23);
    grid.heights[r * (SIZE + 1) + c] = Math.fround(Math.max(-3, Math.min(2.6, h)));
  }
}
const island: IslandDef = {
  seed: 0,
  layout: "solo",
  biome: "tropic",
  grid,
  sites: [],
  nodes: [],
  fishSpots: [],
  bounds: { minX: -SIZE / 2 + 1, maxX: SIZE / 2 - 1, minZ: -SIZE / 2 + 1, maxZ: SIZE / 2 - 1 },
  gridHash: 0,
  defHash: 0,
};
const ground = (x: number, z: number): number => heightAt(grid, x, z);

{
  const geo = new THREE.PlaneGeometry(SIZE, SIZE, SIZE, SIZE).rotateX(-Math.PI / 2);
  const pos = geo.getAttribute("position") as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const sand = new THREE.Color(PALETTE.sand);
  const grass = new THREE.Color(PALETTE.grass);
  const wet = new THREE.Color("#C9B98A");
  const c = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const h = ground(pos.getX(i), pos.getZ(i));
    pos.setY(i, h);
    c.copy(h > 0.75 ? grass : h > 0.05 ? sand : wet);
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  scene.add(new THREE.Mesh(geo, createToonMaterial("#FFFFFF", { vertexColors: true, flatShading: true })));
  const water = new THREE.Mesh(
    new THREE.PlaneGeometry(240, 240).rotateX(-Math.PI / 2),
    createToonMaterial(PALETTE.sea, { transparent: true, opacity: 0.72, depthWrite: false }),
  );
  water.position.y = WATER_Y;
  water.renderOrder = 1;
  scene.add(water);
}

/* -------------------------------------------------------------------- fx */

const fx = new Fx(scene, camera);
fx.setIsland(island);

const ORIGIN = new THREE.Vector3(0, ground(0, -6) + 1.4, -6);
const target = new THREE.Vector3(0, ground(0, 4), 4);
const targetMarker = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.32, 24).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: "#FF5A5F" }));
scene.add(targetMarker);
function moveTarget(x: number, z: number): void {
  target.set(x, ground(x, z), z);
  targetMarker.position.set(x, Math.max(target.y, WATER_Y) + 0.03, z);
}
moveTarget(0, 4);

const raycaster = new THREE.Raycaster();
renderer.domElement.addEventListener("dblclick", (e) => {
  const rect = renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.5);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(plane, hit)) moveTarget(hit.x, hit.z);
});

/* ---------------------------------------------------- local projectile sim */

interface SimProjectile {
  frame: ProjectileFrame;
  bounces: number;
  restTicks: number;
  baitLeft: number;
  /** Predicted projectiles that never get confirmed fade out after this long. */
  fadeAfter: number;
}

const sims: SimProjectile[] = [];
let nextId = 1;

function spawnProjectile(kind: ItemKind, pos: Vec3Like, vel: Vec3Like, opts: { predicted?: boolean; state?: ProjectileFrame["state"]; charge?: number } = {}): SimProjectile {
  const def = ITEMS[kind];
  const predicted = opts.predicted ?? false;
  const sim: SimProjectile = {
    frame: {
      id: predicted ? `pred:${nextId++}:0` : `p${nextId++}`,
      x: pos.x,
      y: pos.y,
      z: pos.z,
      vx: vel.x,
      vy: vel.y,
      vz: vel.z,
      state: opts.state ?? "live",
      kind,
      radius: def.radius,
      ownerId: "harness",
      charge: opts.charge ?? 1,
      bait: false,
      predicted,
      bounced: false,
      bounceSpeed: 0,
      opacity: 1,
      age: 0,
    },
    bounces: 0,
    restTicks: 0,
    baitLeft: 0,
    fadeAfter: predicted ? 0.6 : Infinity,
  };
  sims.push(sim);
  return sim;
}

function removeSim(sim: SimProjectile): void {
  const i = sims.indexOf(sim);
  if (i >= 0) sims.splice(i, 1);
}

const tmpN = { x: 0, y: 1, z: 0 };

function stepSim(sim: SimProjectile, dt: number): void {
  const f = sim.frame;
  const def = ITEMS[f.kind];
  f.age += dt;
  if (f.predicted && f.age > sim.fadeAfter) {
    f.opacity = Math.max(0, f.opacity - dt / 0.25);
    if (f.opacity <= 0) removeSim(sim);
  }
  if (f.state === "rest" || f.state === "stuck") {
    if (sim.baitLeft > 0) {
      sim.baitLeft -= dt;
      f.bait = sim.baitLeft > 0;
    }
    return;
  }
  f.vy += GRAVITY * def.gravityScale * dt;
  f.x += f.vx * dt;
  f.y += f.vy * dt;
  f.z += f.vz * dt;
  const g = ground(f.x, f.z);
  if (g < WATER_Y && f.y < WATER_Y - 0.15) {
    fx.burst("splash", { x: f.x, y: WATER_Y, z: f.z }, { scale: Math.max(0.5, f.radius * 4) });
    removeSim(sim);
    return;
  }
  if (f.y - f.radius > g) return;
  f.y = g + f.radius;
  if (f.kind === "puffer") {
    fx.burst("blast", { x: f.x, y: g, z: f.z });
    fx.popText(lang === "tr" ? "PATLADI!" : "KABOOM!", { x: f.x, y: g + 1, z: f.z }, "big");
    removeSim(sim);
    return;
  }
  if (def.sticks && f.state === "live") {
    f.state = "stuck";
    f.vx = f.vy = f.vz = 0;
    fx.burst("dust", { x: f.x, y: g, z: f.z }, { scale: 0.6 });
    return;
  }
  normalAt(grid, f.x, f.z, tmpN);
  const vn = f.vx * tmpN.x + f.vy * tmpN.y + f.vz * tmpN.z;
  if (vn < 0) {
    const k = 1 + def.restitution;
    f.vx -= k * vn * tmpN.x;
    f.vy -= k * vn * tmpN.y;
    f.vz -= k * vn * tmpN.z;
    f.vx *= 0.8;
    f.vz *= 0.8;
    f.bounced = true;
    f.bounceSpeed = -vn;
    sim.bounces++;
    if (f.state === "live") fx.burst("dust", { x: f.x, y: g, z: f.z }, { scale: 0.5 });
    f.state = "loose";
    if (sim.bounces > def.maxBounces || -vn < 1.2) f.vy = 0;
  }
  const speed = Math.hypot(f.vx, f.vy, f.vz);
  if (f.vy === 0) {
    const decel = Math.max(0, 1 - 6 * dt / Math.max(0.01, speed));
    f.vx *= decel;
    f.vz *= decel;
  }
  if (speed < 0.5) {
    sim.restTicks++;
    if (sim.restTicks > 6) {
      f.state = "rest";
      f.vx = f.vy = f.vz = 0;
      if (f.kind === "fish_raw") sim.baitLeft = 8;
    }
  } else {
    sim.restTicks = 0;
  }
}

function frames(): ProjectileFrame[] {
  const out: ProjectileFrame[] = [];
  for (const s of sims) {
    out.push({ ...s.frame });
    s.frame.bounced = false;
  }
  return out;
}

/* ------------------------------------------------------------------ aim */

let charge = 1;
let pitch = 0.45;

function aimVelocity(spreadYaw = 0): THREE.Vector3 {
  const dx = target.x - ORIGIN.x;
  const dz = target.z - ORIGIN.z;
  const yaw = Math.atan2(dx, dz) + spreadYaw;
  const speed = 12 + 22 * charge;
  return new THREE.Vector3(Math.sin(yaw) * Math.cos(pitch) * speed, Math.sin(pitch) * speed, Math.cos(yaw) * Math.cos(pitch) * speed);
}

function throwKind(kind: ItemKind, predicted = false): void {
  if (kind === "coconut_ball") {
    for (const s of [-0.21, 0, 0.21]) spawnProjectile("coconut", ORIGIN, aimVelocity(s), { predicted });
    return;
  }
  spawnProjectile(kind, ORIGIN, aimVelocity(), { predicted, charge });
}

function arcPoints(): Vec3Like[] {
  const v = aimVelocity();
  const pts: Vec3Like[] = [];
  const g = ITEMS.coconut.gravityScale;
  let end = 3;
  for (let t = 0.02; t < 3; t += 0.02) {
    const y = ORIGIN.y + v.y * t + 0.5 * GRAVITY * g * t * t;
    if (y < Math.max(WATER_Y, ground(ORIGIN.x + v.x * t, ORIGIN.z + v.z * t))) {
      end = t;
      break;
    }
  }
  const span = end * 0.7;
  for (let i = 0; i < 32; i++) {
    const t = (span * i) / 31;
    pts.push({ x: ORIGIN.x + v.x * t, y: ORIGIN.y + v.y * t + 0.5 * GRAVITY * g * t * t, z: ORIGIN.z + v.z * t });
  }
  return pts;
}

/* ------------------------------------------------------------ gallery */

const gallery = new THREE.Group();
scene.add(gallery);
const galleryItems: THREE.Object3D[] = [];
[...ITEM_KINDS, "berry" as const].forEach((kind, i) => {
  const obj = kind === "berry" ? buildBerryMesh() : buildItemMesh(kind);
  const x = -11.5 + (i % 12) * 2.1;
  const z = -11 - Math.floor(i / 12) * 2.2;
  obj.position.set(x, ground(x, z) + 0.6, z);
  gallery.add(obj);
  galleryItems.push(obj);
  const post = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), createToonMaterial("#B07A45"));
  post.position.set(x, ground(x, z) + 0.2, z);
  gallery.add(post);
});

const heldItem = buildItemMesh("coconut");
heldItem.position.copy(ORIGIN);
scene.add(heldItem);

/* ---------------------------------------------------------------- state */

let lang: "en" | "tr" = "en";
let night = false;
let arcOn = true;
let glowCharge = 0;
let spinGallery = true;
let fishing = false;
let biteLeft = 0;
let autoChargeGlow = false;

const SAMPLE_TEXT: Readonly<Record<PopStyle, { en: string; tr: string }>> = {
  hit: { en: "BONK!", tr: "BONK!" },
  big: { en: "Kaptan Crab!", tr: "Kaptan Yengeç!" },
  good: { en: "Caught it!", tr: "Yakaladın!" },
  bad: { en: "Missed", tr: "Iska" },
  info: { en: "Wood needed", tr: "Odun lazım" },
  gold: { en: "Golden fish!", tr: "Altın balık!" },
};
const MARKER_LABELS: Readonly<Record<MarkerKind, { en: string; tr: string }>> = {
  here: { en: "Over here!", tr: "Buraya!" },
  help: { en: "Help!", tr: "Yardım!" },
  need: { en: "Wood needed", tr: "Odun lazım" },
  danger: { en: "Danger!", tr: "Tehlike!" },
};
const MARKER_COLORS: Readonly<Record<MarkerKind, string>> = { here: PLAYER_COLORS[1]!, help: "#FF5A5F", need: PALETTE.hud, danger: "#FF7A3D" };

function at(dy = 0.4): Vec3Like {
  return { x: target.x, y: Math.max(target.y, WATER_Y) + dy, z: target.z };
}

function burst(kind: BurstKind): void {
  const onWater = target.y < WATER_Y;
  const p = at(kind === "splash" || kind === "ripple" ? (onWater ? 0 : 0.05) : kind === "blast" ? 0.1 : 0.4);
  fx.burst(kind, p, { dir: { x: 0, y: 0, z: 1 } });
}

/* ---------------------------------------------------------------- panel */

const panel = document.getElementById("panel") as HTMLElement;

function section(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.appendChild(h);
  const div = document.createElement("div");
  panel.appendChild(div);
  return div;
}

function button(parent: HTMLElement, label: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", fn);
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

function slider(parent: HTMLElement, label: string, min: number, max: number, step: number, value: number, fn: (v: number) => void): void {
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
}

function hint(parent: HTMLElement, text: string): void {
  const p = document.createElement("div");
  p.className = "hint";
  p.textContent = text;
  parent.appendChild(p);
}

{
  const s = section("Bursts (at the target)");
  for (const kind of BURST_KINDS) button(s, kind, () => burst(kind));
  button(s, "all", () => BURST_KINDS.forEach((k, i) => setTimeout(() => burst(k), i * 140)));
  hint(s, "Double-click the ground to move the target (red ring).");
}
{
  const s = section("Pop text");
  for (const style of POP_STYLE_IDS) button(s, style, () => fx.popText(SAMPLE_TEXT[style][lang], at(0.9), style));
  button(s, "-2", () => fx.popText("-2", at(0.9), "hit"));
  button(s, "+20", () => fx.popText("+20", at(0.9), "good"));
  toggle(s, "TR samples", false, (on) => (lang = on ? "tr" : "en"));
}
{
  const s = section("Item pops");
  for (const kind of [...ITEM_KINDS, "berry" as const]) button(s, kind, () => fx.itemPop(kind, 1 + Math.floor(Math.random() * 3), at(0.6)));
}
{
  const s = section("Throw (from the blue hand to the target)");
  for (const kind of ITEM_KINDS.filter((k) => ITEMS[k].throwable)) button(s, kind, () => throwKind(kind));
  button(s, "predicted (fades)", () => throwKind("coconut", true));
  button(s, "volley ×6", () => {
    for (let i = 0; i < 6; i++) setTimeout(() => throwKind(i % 2 ? "stone" : "coconut"), i * 120);
  });
  slider(s, "charge", 0, 1, 0.01, charge, (v) => (charge = v));
  slider(s, "pitch", 0, 1.2, 0.01, pitch, (v) => (pitch = v));
  toggle(s, "arc preview", arcOn, (on) => (arcOn = on));
}
{
  const s = section("Ground items");
  button(s, "drop all 22 (resting)", () => {
    ITEM_KINDS.forEach((kind, i) => {
      const x = -9 + (i % 8) * 2.4;
      const z = -2 + Math.floor(i / 8) * 2.4;
      const sim = spawnProjectile(kind, { x, y: ground(x, z) + ITEMS[kind].radius, z }, { x: 0, y: 0, z: 0 }, { state: kind === "spear" ? "stuck" : "rest" });
      if (kind === "fish_raw") sim.baitLeft = 8;
    });
  });
  button(s, "toss each (Q)", () => {
    ITEM_KINDS.forEach((kind, i) => {
      setTimeout(() => spawnProjectile(kind, ORIGIN, aimVelocity((i - 11) * 0.05).multiplyScalar(0.35), { charge: 0 }), i * 60);
    });
  });
  button(s, "bait fish", () => {
    const sim = spawnProjectile("fish_raw", at(0.4), { x: 0, y: 0, z: 0 }, { state: "rest" });
    sim.baitLeft = 8;
  });
  button(s, "clear items", () => (sims.length = 0));
}
{
  const s = section("Ping balloons");
  for (const kind of MARKER_KINDS) {
    button(s, kind, () => fx.marker({ id: `p-${kind}`, kind, pos: at(0), color: MARKER_COLORS[kind], label: MARKER_LABELS[kind][lang], ttl: MARKER_TICKS / TICK_RATE }));
  }
  button(s, "far one", () => fx.marker({ id: "far", kind: "danger", pos: { x: 14, y: ground(14, 22), z: 22 }, color: "#FF7A3D", label: MARKER_LABELS.danger[lang], ttl: 8 }));
}
{
  const s = section("Fishing");
  toggle(s, "bobber", fishing, (on) => (fishing = on));
  button(s, "bite!", () => {
    fishing = true;
    biteLeft = 0.6;
  });
}
{
  const s = section("Charge glow");
  slider(s, "charge", 0, 1, 0.01, 0, (v) => (glowCharge = v));
  toggle(s, "auto wind-up", false, (on) => (autoChargeGlow = on));
}
{
  const s = section("Look");
  toggle(s, "night", night, (on) => {
    night = on;
    scene.background = (on ? NIGHT_SKY : DAY_SKY).clone();
    (scene.fog as THREE.Fog).color.copy(on ? NIGHT_SKY : DAY_SKY);
    hemi.intensity = on ? 0.25 : 1.6;
    sun.intensity = on ? 0.15 : 2.2;
    campLight.intensity = on ? 18 : 0;
  });
  toggle(s, "spin gallery", spinGallery, (on) => (spinGallery = on));
  toggle(s, "reduced flashing", false, (on) => fx.setReducedFlashing(on));
  for (const q of ["low", "medium", "high"] as const) button(s, `quality ${q}`, () => fx.setQuality(q));
  button(s, "clear all", () => {
    sims.length = 0;
    fx.clear();
  });
  hint(s, `Item triangles: ${ITEM_KINDS.map((k) => `${k} ${itemTriangleCount(k)}`).join(", ")}`);
}

/* ------------------------------------------------------------------ loop */

const stats = document.getElementById("stats") as HTMLElement;
let last = performance.now();
let elapsed = 0;
let fpsAcc = 0;
let fpsFrames = 0;
let fps = 0;

function frame(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  elapsed += dt;
  fpsAcc += dt;
  fpsFrames++;
  if (fpsAcc > 0.5) {
    fps = Math.round(fpsFrames / fpsAcc);
    fpsAcc = 0;
    fpsFrames = 0;
  }
  // Sim in small fixed steps so bounces stay stable.
  const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
  for (let i = 0; i < steps; i++) for (const s of [...sims]) stepSim(s, dt / steps);
  fx.syncProjectiles(frames(), dt);
  fx.setArc(arcOn && charge >= 0.5 ? arcPoints() : null, PLAYER_COLORS[1]!);

  if (fishing) {
    biteLeft = Math.max(0, biteLeft - dt);
    const bob: Bobber = { playerId: "harness", from: { x: ORIGIN.x + 0.3, y: ORIGIN.y + 0.9, z: ORIGIN.z + 0.8 }, pos: { x: 2, y: WATER_Y, z: 19 }, biting: biteLeft > 0 };
    fx.setBobbers([bob]);
  } else {
    fx.setBobbers([]);
  }

  const c = autoChargeGlow ? (elapsed % 1.6) / 0.6 : glowCharge;
  const chargeNow = Math.min(1, c);
  fx.setChargeGlow("harness", chargeNow > 0 ? ORIGIN : null, chargeNow, PLAYER_COLORS[1]!);
  setItemGlow(heldItem, chargeNow, PLAYER_COLORS[1]!, elapsed);
  heldItem.rotation.y = elapsed * 0.8;

  galleryItems.forEach((obj, i) => {
    if (spinGallery) obj.rotation.y = elapsed * 0.7 + i;
    flickerFlame(obj, elapsed, true, i);
  });

  fx.update(dt);
  controls.update();
  renderer.render(scene, camera);
  const info = renderer.info.render;
  stats.textContent =
    `${fps} fps · ${info.calls} draws · ${(info.triangles / 1000).toFixed(1)}k tris\n` +
    `particles ${fx.particles.count} · chunks ${fx.chunks.count} · projectiles ${fx.projectiles.count}\n` +
    `pops ${fx.popTexts.count} · item pops ${fx.itemPops.count} · markers ${fx.markers.count} · bobbers ${fx.bobbers.count}`;
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

window.addEventListener("resize", () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

/** Automation hook for scripted checks (e.g. a headless browser run). */
const harness = {
  fx,
  camera,
  controls,
  /** Frame the item gallery up close (row 0 or 1). */
  viewGallery: (row = 0, from = -6, to = 6): void => {
    const z = -11 - row * 2.2;
    controls.target.set((from + to) / 2, ground(0, z) + 0.6, z);
    camera.position.set((from + to) / 2, ground(0, z) + 2.2, z + 4.5);
    controls.update();
  },
  /** Stop / start the gallery turntable (yaw in radians when stopped). */
  setSpin: (on: boolean, yaw = 0): void => {
    spinGallery = on;
    if (!on) galleryItems.forEach((obj) => (obj.rotation.y = yaw));
  },
  /** Frame gallery item `i` (ITEM_KINDS order, then the berry) from `d` meters. */
  viewItem: (i: number, d = 1.3, side = 0.35): void => {
    const obj = galleryItems[i];
    if (!obj) return;
    controls.target.copy(obj.position);
    camera.position.set(obj.position.x + side * d, obj.position.y + 0.35 * d, obj.position.z + d);
    controls.update();
  },
  /** Frame the target point. */
  viewTarget: (distance = 7): void => {
    controls.target.set(target.x, Math.max(target.y, WATER_Y) + 0.6, target.z);
    camera.position.set(target.x + distance * 0.6, Math.max(target.y, WATER_Y) + distance * 0.55, target.z - distance);
    controls.update();
  },
  burst,
  burstAll: (): void => BURST_KINDS.forEach((k) => burst(k)),
  throwKind,
  moveTarget,
  blastRadius: PUFFER_BLAST_RADIUS,
};
(window as unknown as { fxHarness: typeof harness }).fxHarness = harness;
