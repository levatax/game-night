// FX harness: every fx subsystem in isolation with mock players, real shared ball physics and
// buttons/keys for every state. Dev only (served by dev/vite.fx.config.ts, not in the build).
// Automation hook: window.fxHarness (see the bottom of this file).

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import {
  ARC_PREVIEW_FRACTION,
  ARC_PREVIEW_MAX_POINTS,
  BALL_RADIUS,
  BALL_SPAWN_HEIGHT,
  CATCH_SLOWMO_MS,
  CATCH_SLOWMO_SCALE,
  CHARACTER_IDS,
  CHARACTERS,
  CHEST_HEIGHT,
  DT,
  FLOOR_THICKNESS,
  HIT_STOP_MS,
  MEGA_BALL_RADIUS,
  PALETTE,
  PEDESTAL_HEIGHT,
  PLAYER_COLORS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  POWERUP_TYPES,
  SHOCKWAVE_RADIUS,
  ticksToSec,
  POWERUP_WARNING_TICKS,
} from "../../shared/constants";
import { getArena, type ArenaDef } from "../../shared/maps";
import { createBallSim, stepBall, type BallSim } from "../../shared/sim/ball";
import type { BallContext, FloorQuery } from "../../shared/sim/context";
import { dirFromYawPitch, yawFromDir, vec3, type Vec3 } from "../../shared/sim/math";
import { ballKindForPowerUp, computeThrowVelocities, sampleTrajectory, throwOrigin } from "../../shared/sim/throw";
import type { CharacterId, HeldPowerUp, PowerUpType, PowerUpView } from "../../shared/types";
import { Fx } from "../src/fx/Fx";
import { computeOffscreenIndicators } from "../src/fx/Indicators";
import type { ParticleKind, PopTextKind, ShadowCaster } from "../src/fx/types";
import type { BallFrame } from "../src/net/types";
import { addOutline, createToonMaterial } from "../src/render/Toon";

/* ------------------------------------------------------------------ scene */

const container = document.getElementById("game") as HTMLElement;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(PALETTE.skyTop);
scene.fog = new THREE.Fog(PALETTE.skyBottom, 40, 90);
const camera = new THREE.PerspectiveCamera(70, 1, 0.1, 400);
camera.position.set(0, 9, 17);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1, 0);
controls.enableDamping = true;

const sun = new THREE.DirectionalLight("#FFF6E0", 2.4);
sun.position.set(8, 16, 6);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
const sc = sun.shadow.camera;
sc.left = sc.bottom = -17;
sc.right = sc.top = 17;
scene.add(sun, new THREE.HemisphereLight("#CFEFFF", "#4FA36B", 1.1));

let arena: ArenaDef = getArena("picnic");
const rings: number[] = arena.ringRadii.map(() => 0);
const floor: FloorQuery = { arena, rings };
const world = new THREE.Group();
scene.add(world);
buildArena();

function buildArena(): void {
  world.clear();
  const edge = arena.ringRadii[arena.ringRadii.length - 1];
  const island = new THREE.Mesh(
    new THREE.CylinderGeometry(edge, edge * 0.82, FLOOR_THICKNESS, 64),
    createToonMaterial(arena.theme.floorColor),
  );
  island.position.y = -FLOOR_THICKNESS / 2;
  island.receiveShadow = true;
  world.add(island);
  for (const c of arena.cover) {
    const mat = createToonMaterial(PALETTE.wood);
    const mesh =
      c.shape === "cylinder"
        ? new THREE.Mesh(new THREE.CylinderGeometry(c.radius, c.radius, c.height, 20), mat)
        : new THREE.Mesh(new THREE.BoxGeometry(c.halfX * 2, c.height, c.halfZ * 2), mat);
    mesh.position.set(c.x, c.height / 2, c.z);
    mesh.rotation.y = c.rotation;
    mesh.castShadow = mesh.receiveShadow = true;
    addOutline(mesh, 0.03);
    world.add(mesh);
  }
  for (const p of arena.pedestals) {
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, PEDESTAL_HEIGHT, 24), createToonMaterial("#F2E6D0"));
    ped.position.set(p.x, PEDESTAL_HEIGHT / 2, p.z);
    ped.receiveShadow = true;
    addOutline(ped, 0.03);
    world.add(ped);
  }
}

/* ---------------------------------------------------------------- players */

interface MockPlayer {
  id: string;
  slot: number;
  character: CharacterId;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  mesh: THREE.Group;
  hand: THREE.Mesh;
}

const players: MockPlayer[] = [
  makePlayer(0, "quacky", 0, 8),
  makePlayer(1, "hopsworth", -7, -3),
  makePlayer(2, "pip", 5, 0),
  makePlayer(3, "gruff", 6, -5),
];
const me = players[0];
const runner = players[2];

function makePlayer(slot: number, character: CharacterId, x: number, z: number): MockPlayer {
  const mesh = new THREE.Group();
  const bodyMat = createToonMaterial(CHARACTERS[character].colors.body);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER_RADIUS, PLAYER_HEIGHT - PLAYER_RADIUS * 2, 6, 16), bodyMat);
  body.position.y = PLAYER_HEIGHT / 2;
  body.castShadow = true;
  const band = new THREE.Mesh(new THREE.TorusGeometry(PLAYER_RADIUS * 1.02, 0.06, 8, 24), createToonMaterial(PLAYER_COLORS[slot]));
  band.rotation.x = Math.PI / 2;
  band.position.y = 0.95;
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.3, 10), createToonMaterial(CHARACTERS[character].colors.accent));
  nose.rotation.x = -Math.PI / 2;
  nose.position.set(0, 1.15, -0.45);
  const hand = new THREE.Mesh(new THREE.SphereGeometry(0.11, 10, 8), bodyMat);
  mesh.add(body, band, nose);
  addOutline(mesh, 0.03);
  scene.add(mesh, hand);
  const p: MockPlayer = { id: `p${slot}`, slot, character, x, y: 0, z, yaw: Math.atan2(x, z), pitch: 0.08, mesh, hand };
  placePlayer(p);
  return p;
}

function placePlayer(p: MockPlayer): void {
  p.mesh.position.set(p.x, p.y, p.z);
  p.mesh.rotation.y = p.yaw;
  const h = throwOrigin(p);
  p.hand.position.set(h.x, h.y, h.z);
}

function playerById(id: string): MockPlayer | undefined {
  return players.find((p) => p.id === id);
}

function chest(p: MockPlayer): Vec3 {
  return vec3(p.x, p.y + CHEST_HEIGHT, p.z);
}

/** Aim from p toward a target chest with a slight upward lob. */
function aimAt(p: MockPlayer, target: MockPlayer): void {
  p.yaw = yawFromDir(target.x - p.x, target.z - p.z);
  const d = Math.hypot(target.x - p.x, target.z - p.z);
  p.pitch = Math.min(0.5, 0.02 + d * 0.012);
  placePlayer(p);
}

/* ------------------------------------------------------------------ balls */

interface HarnessBall {
  id: string;
  sim: BallSim;
  px: number;
  py: number;
  pz: number;
  ownerId: string;
  holderId: string;
  charge: number;
  bounced: boolean;
  bounceSpeed: number;
  predicted: boolean;
  opacity: number;
}

const balls: HarnessBall[] = [];
let ballSerial = 0;

function addBall(state: BallSim["state"], x: number, y: number, z: number): HarnessBall {
  const sim = createBallSim();
  sim.state = state;
  sim.x = x;
  sim.y = y;
  sim.z = z;
  const b: HarnessBall = { id: `b${++ballSerial}`, sim, px: x, py: y, pz: z, ownerId: "", holderId: "", charge: 0, bounced: false, bounceSpeed: 0, predicted: false, opacity: 1 };
  balls.push(b);
  return b;
}

function dropBall(): void {
  addBall("neutral", (Math.random() - 0.5) * 6, BALL_SPAWN_HEIGHT, (Math.random() - 0.5) * 6);
}

function giveBall(p: MockPlayer): HarnessBall {
  const b = addBall("held", p.x, p.y + 1, p.z);
  b.holderId = p.id;
  return b;
}

function throwFrom(p: MockPlayer, target: MockPlayer, charge: number, powerUp: HeldPowerUp, curve = false): void {
  aimAt(p, target);
  const held = balls.filter((b) => b.holderId === p.id);
  for (const b of held) balls.splice(balls.indexOf(b), 1);
  const origin = throwOrigin(p);
  const velocities = computeThrowVelocities(charge, p.yaw, p.pitch, powerUp);
  velocities.forEach((v, i) => {
    const b = addBall("live", origin.x, origin.y, origin.z);
    b.ownerId = p.id;
    b.charge = charge;
    b.sim.kind = i === 0 ? ballKindForPowerUp(powerUp) : "bonus";
    b.sim.radius = b.sim.kind === "mega" ? MEGA_BALL_RADIUS : BALL_RADIUS;
    b.sim.vx = v.x;
    b.sim.vy = v.y;
    b.sim.vz = v.z;
    b.sim.curve = curve && i === 0;
  });
  fx.balls.setChargeGlow(p.id, 0);
}

const ballCtx: BallContext = { arena, rings, dt: DT, steer: null, returnTarget: null };

function stepBalls(): void {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.px = b.sim.x;
    b.py = b.sim.y;
    b.pz = b.sim.z;
    if (b.sim.state === "held") continue;
    const owner = playerById(b.ownerId);
    ballCtx.steer = owner && b.sim.curve ? dirFromYawPitch(owner.yaw + Math.sin(time * 2) * 0.4, owner.pitch) : null;
    ballCtx.returnTarget = owner ? chest(owner) : null;
    const r = stepBall(b.sim, ballCtx);
    if (r.bounced) {
      b.bounced = true;
      b.bounceSpeed = Math.max(b.bounceSpeed, r.impactSpeed);
    }
    if (r.lost || (b.sim.kind === "bonus" && b.sim.state === "neutral")) balls.splice(i, 1);
    else if (r.becameNeutral) b.ownerId = "";
    // A returning boomerang that reaches its owner is caught.
    if (owner && b.sim.returning && Math.hypot(b.sim.x - owner.x, b.sim.y - owner.y - CHEST_HEIGHT, b.sim.z - owner.z) < 1) {
      balls.splice(balls.indexOf(b), 1);
      giveBall(owner);
    }
  }
}

function ballFrames(alpha: number): BallFrame[] {
  return balls.map((b) => {
    const s = b.sim;
    const frame: BallFrame = {
      id: b.id,
      x: b.px + (s.x - b.px) * alpha,
      y: b.py + (s.y - b.py) * alpha,
      z: b.pz + (s.z - b.pz) * alpha,
      vx: s.vx,
      vy: s.vy,
      vz: s.vz,
      state: s.state,
      kind: s.kind,
      radius: s.radius,
      ownerId: b.ownerId,
      holderId: b.holderId,
      charge: b.charge,
      curve: s.curve,
      returning: s.returning,
      predicted: b.predicted,
      bounced: b.bounced,
      bounceSpeed: b.bounceSpeed,
      opacity: b.opacity,
    };
    b.bounced = false;
    b.bounceSpeed = 0;
    return frame;
  });
}

/* ---------------------------------------------------------------- fx + ui */

const fx = new Fx(scene);
fx.setArena(arena, floor);

const powerUps = new Map<string, PowerUpView & { readyAt: number }>();
let powerUpSerial = 0;

function spawnPowerUp(type: PowerUpType): string {
  const pedestal = powerUpSerial % arena.pedestals.length;
  for (const [id, pu] of powerUps) if (pu.pedestal === pedestal) powerUps.delete(id);
  const id = `pu${++powerUpSerial}`;
  const p = arena.pedestals[pedestal];
  powerUps.set(id, { id, type, pedestal, phase: "warning", x: p.x, z: p.z, readyAt: time + ticksToSec(POWERUP_WARNING_TICKS) });
  return id;
}

function pickUpPowerUps(): void {
  for (const [id, pu] of powerUps) {
    if (pu.phase === "ready") {
      powerUps.delete(id);
      fx.particles.burst("sparkles", { x: pu.x, y: PEDESTAL_HEIGHT + 1, z: pu.z }, { color: "#FFFFFF" });
    }
  }
}

let charging = false;
let charge = 0;
let showArc = true;
let zoomies = false;
let skid = false;
let frozen = false;

const focus = { x: 0, y: 1, z: 3 };

function burst(kind: ParticleKind): void {
  const pos = { ...focus };
  if (kind === "shockwave" || kind === "dust" || kind === "crumbs") pos.y = 0;
  const opts =
    kind === "shockwave"
      ? { scale: SHOCKWAVE_RADIUS }
      : kind === "feathers"
        ? { color: CHARACTERS.quacky.colors.body }
        : kind === "speedLines"
          ? { dir: { x: 1, y: 0, z: 0 } }
          : kind === "bubbles"
            ? { color: "#FF9EC8" }
            : undefined;
  fx.particles.burst(kind, pos, opts);
}

function pop(kind: PopTextKind): void {
  fx.popText.show(kind, focus);
}

const panel = document.getElementById("panel") as HTMLElement;

function section(title: string): HTMLElement {
  const h = document.createElement("h2");
  h.textContent = title;
  panel.appendChild(h);
  const div = document.createElement("div");
  panel.appendChild(div);
  return div;
}

function button(parent: HTMLElement, label: string, fn: () => void): void {
  const b = document.createElement("button");
  b.textContent = label;
  b.addEventListener("click", fn);
  parent.appendChild(b);
}

function toggle(parent: HTMLElement, label: string, initial: boolean, fn: (on: boolean) => void): void {
  const l = document.createElement("label");
  const c = document.createElement("input");
  c.type = "checkbox";
  c.checked = initial;
  c.addEventListener("change", () => fn(c.checked));
  l.append(c, label);
  parent.appendChild(l);
}

const ballsUi = section("Balls (keys 1-7)");
button(ballsUi, "1 drop neutral", dropBall);
button(ballsUi, "2 quick throw", () => throwFrom(players[1], me, 0.1, ""));
button(ballsUi, "3 full charge", () => throwFrom(players[1], me, 1, ""));
button(ballsUi, "4 mega", () => throwFrom(players[3], players[1], 1, "mega"));
button(ballsUi, "5 triple", () => throwFrom(players[1], players[3], 0.7, "triple"));
button(ballsUi, "6 boomerang", () => throwFrom(players[3], players[1], 0.6, "boomerang"));
button(ballsUi, "7 curveball", () => throwFrom(me, players[3], 0.8, "", true));
button(ballsUi, "give me a ball", () => giveBall(me));
button(ballsUi, "volley!", () => {
  throwFrom(players[1], me, 1, "");
  throwFrom(players[3], players[1], 0.9, "mega");
  throwFrom(runner, players[3], 0.6, "triple");
});
button(ballsUi, "clear balls", () => (balls.length = 0));
toggle(ballsUi, "charge (hold)", false, (on) => {
  charging = on;
  charge = 0;
  if (on && !balls.some((b) => b.holderId === me.id)) giveBall(me);
});
toggle(ballsUi, "arc preview", true, (on) => (showArc = on));
button(ballsUi, "release", () => {
  throwFrom(me, players[1], Math.max(0.05, charge), "");
  charging = false;
});

const partUi = section("Particles (Q/W)");
for (const kind of ["stars", "puff", "confetti", "speedLines", "feathers", "dust", "crumbs", "sparkles", "shockwave", "bubbles"] as ParticleKind[]) {
  button(partUi, kind, () => burst(kind));
}
toggle(partUi, "zoomies lines", false, (on) => (zoomies = on));
toggle(partUi, "skid dust", false, (on) => (skid = on));

const popUi = section("Pop text (E)");
for (const kind of ["bonk", "catch", "out", "miss", "boing", "ding"] as PopTextKind[]) button(popUi, kind, () => pop(kind));
for (const n of [1, 2, 3]) button(popUi, `+${n}`, () => fx.popText.showPoints(n, focus, PLAYER_COLORS[n]));

const puUi = section("Power-ups (R)");
for (const type of POWERUP_TYPES) button(puUi, type, () => spawnPowerUp(type));
button(puUi, "pick up", pickUpPowerUps);
button(puUi, "cancel all", () => powerUps.clear());

const moreUi = section("Moments");
for (const c of CHARACTER_IDS) button(moreUi, `KO ${c}`, () => fx.koPop({ x: focus.x, y: 0, z: focus.z }, c));
button(moreUi, "catch flash", () => fx.catchFlash(focus, PLAYER_COLORS[1]));
button(moreUi, "ring crumble", () => fx.ringCrumble(arena.ringRadii.length - 1));
button(moreUi, "hit-stop", () => fx.feel.hitStop(HIT_STOP_MS));
button(moreUi, "catch slow-mo", () => fx.feel.slowMo(CATCH_SLOWMO_SCALE, CATCH_SLOWMO_MS));
button(moreUi, "shake 0.35", () => fx.feel.addTrauma(0.35));
button(moreUi, "shake 0.6", () => fx.feel.addTrauma(0.6));
button(moreUi, "BONK combo", bonkCombo);
toggle(moreUi, "freeze time", false, (on) => (frozen = on));

const camUi = section("Camera");
button(camUi, "overview", () => setCamera("overview"));
button(camUi, "shoulder", () => setCamera("shoulder"));
button(camUi, "close", () => setCamera("close"));
button(camUi, "look away (indicators)", () => setCamera("away"));
for (const id of ["picnic", "bath", "cake"] as const) button(camUi, id, () => setArena(id));

function setPanel(visible: boolean): void {
  panel.style.display = visible ? "" : "none";
}

function bonkCombo(): void {
  const pos = { x: focus.x, y: 1.1, z: focus.z };
  fx.feel.hitStop(HIT_STOP_MS);
  fx.feel.addTrauma(0.35);
  fx.particles.burst("stars", pos);
  fx.popText.show("bonk", pos);
}

function setCamera(name: "overview" | "shoulder" | "close" | "away"): void {
  if (name === "overview") {
    camera.position.set(0, 12, 19);
    controls.target.set(0, 0.5, 0);
  } else if (name === "shoulder") {
    const back = dirFromYawPitch(me.yaw, 0);
    camera.position.set(me.x - back.x * 4.5 + 0.6, 1.6 + 0.9, me.z - back.z * 4.5);
    controls.target.set(me.x + back.x * 6, 1.2, me.z + back.z * 6);
  } else if (name === "close") {
    camera.position.set(focus.x + 2.5, 2.2, focus.z + 4.5);
    controls.target.set(focus.x, 1, focus.z);
  } else {
    camera.position.set(me.x, 2.6, me.z - 3);
    controls.target.set(me.x, 2, me.z + 10);
  }
  controls.update();
}

function setArena(id: "picnic" | "bath" | "cake"): void {
  arena = getArena(id);
  rings.length = 0;
  for (const _ of arena.ringRadii) rings.push(0);
  floor.arena = arena;
  ballCtx.arena = arena;
  buildArena();
  fx.setArena(arena, floor);
}

window.addEventListener("keydown", (e) => {
  const actions: Record<string, () => void> = {
    "1": dropBall,
    "2": () => throwFrom(players[1], me, 0.1, ""),
    "3": () => throwFrom(players[1], me, 1, ""),
    "4": () => throwFrom(players[3], players[1], 1, "mega"),
    "5": () => throwFrom(players[1], players[3], 0.7, "triple"),
    "6": () => throwFrom(players[3], players[1], 0.6, "boomerang"),
    "7": () => throwFrom(me, players[3], 0.8, "", true),
    q: () => burst("stars"),
    w: () => burst("confetti"),
    e: () => pop("bonk"),
    r: () => spawnPowerUp(POWERUP_TYPES[powerUpSerial % POWERUP_TYPES.length]),
    b: bonkCombo,
    h: () => setPanel(panel.style.display === "none"),
  };
  actions[e.key]?.();
});

/* ------------------------------------------------------------- indicators */

const indicatorRoot = document.getElementById("indicators") as HTMLElement;
const arrows = new Map<string, HTMLElement>();

function drawIndicators(frames: readonly BallFrame[]): void {
  const list = computeOffscreenIndicators({
    camera,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    balls: frames,
    chest: chest(me),
    localId: me.id,
    colorOf: (id) => PLAYER_COLORS[playerById(id)?.slot ?? 0],
  });
  const seen = new Set<string>();
  for (const ind of list) {
    seen.add(ind.id);
    let el = arrows.get(ind.id);
    if (!el) {
      el = document.createElement("div");
      el.className = "arrow";
      indicatorRoot.appendChild(el);
      arrows.set(ind.id, el);
    }
    el.style.color = ind.color;
    el.style.left = `${ind.x}px`;
    el.style.top = `${ind.y - 14}px`;
    el.style.transform = `rotate(${ind.angle}rad) scale(${0.8 + ind.urgency * 0.6})`;
  }
  for (const [id, el] of arrows) {
    if (!seen.has(id)) {
      el.remove();
      arrows.delete(id);
    }
  }
}

/* ------------------------------------------------------------------- loop */

const stats = document.getElementById("stats") as HTMLElement;
const shake = { x: 0, y: 0, z: 0, roll: 0 };
const handVec = new THREE.Vector3();
let time = 0;
let acc = 0;
let last = performance.now();
let fps = 60;

function resize(): void {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener("resize", resize);
resize();

function updatePlayers(dt: number): void {
  const a = time * 0.7;
  const r = 5;
  const prevX = runner.x;
  const prevZ = runner.z;
  runner.x = Math.cos(a) * r;
  runner.z = Math.sin(a) * r - 1;
  runner.yaw = yawFromDir(runner.x - prevX, runner.z - prevZ);
  placePlayer(runner);
  const speed = Math.hypot(runner.x - prevX, runner.z - prevZ) / Math.max(1e-4, dt);
  const dir = { x: -(runner.x - prevX) / Math.max(1e-6, speed * dt), y: 0, z: -(runner.z - prevZ) / Math.max(1e-6, speed * dt) };
  if (zoomies) fx.particles.emit("speed:runner", "speedLines", { x: runner.x, y: runner.y + 1, z: runner.z }, { dir, color: "#3FD6C6" });
  if (skid) fx.particles.emit("dust:runner", "dust", { x: runner.x, y: 0, z: runner.z }, { dir, scale: 0.6 });
}

function frame(now: number): void {
  const realDt = Math.min(0.1, (now - last) / 1000);
  last = now;
  fps = fps * 0.95 + (1 / Math.max(1e-3, realDt)) * 0.05;
  const dt = frozen ? 0 : fx.feel.update(realDt);
  time += dt;

  if (!frozen) {
    acc += dt;
    while (acc >= DT) {
      stepBalls();
      acc -= DT;
    }
    updatePlayers(dt);
    for (const pu of powerUps.values()) if (pu.phase === "warning" && time >= pu.readyAt) pu.phase = "ready";
  }

  if (charging) charge = Math.min(1, charge + realDt);
  fx.balls.setChargeGlow(me.id, charging ? charge : 0);

  const frames = ballFrames(acc / DT);
  fx.balls.sync(frames, dt, {
    handOf: (id, out) => {
      const p = playerById(id);
      if (!p) return false;
      out.copy(p.hand.position);
      return true;
    },
    colorOf: (id) => PLAYER_COLORS[playerById(id)?.slot ?? 0] ?? PALETTE.neutralBall,
  });
  fx.powerUps.sync([...powerUps.values()], dt, time);

  const casters: ShadowCaster[] = players.map((p) => ({ x: p.x, y: p.y, z: p.z, radius: PLAYER_RADIUS }));
  for (const f of frames) if (f.state !== "held") casters.push({ x: f.x, y: f.y - f.radius, z: f.z, radius: f.radius });
  fx.shadows.update(casters);

  if (charging && showArc && charge >= 0.999) {
    aimAt(me, players[1]);
    handVec.copy(me.hand.position);
    const v = computeThrowVelocities(1, me.yaw, me.pitch, "")[0];
    fx.arc.update(sampleTrajectory(floor, vec3(handVec.x, handVec.y, handVec.z), v, { radius: BALL_RADIUS, fraction: ARC_PREVIEW_FRACTION, maxPoints: ARC_PREVIEW_MAX_POINTS }), PLAYER_COLORS[me.slot]);
  } else {
    fx.arc.update(null, PLAYER_COLORS[me.slot]);
  }

  fx.update(dt);
  controls.update();
  camera.updateMatrixWorld();
  drawIndicators(frames);

  fx.feel.shakeOffset(shake);
  camera.position.x += shake.x;
  camera.position.y += shake.y;
  camera.position.z += shake.z;
  camera.rotateZ(shake.roll);
  renderer.render(scene, camera);
  camera.rotateZ(-shake.roll);
  camera.position.x -= shake.x;
  camera.position.y -= shake.y;
  camera.position.z -= shake.z;

  const info = renderer.info.render;
  stats.textContent = `${fps.toFixed(0)} fps · ${info.calls} calls · ${fx.particles.count} particles · ${balls.length} balls · scale ${fx.feel.timeScale.toFixed(2)}`;
  requestAnimationFrame(frame);
}

for (let i = 0; i < 3; i++) dropBall();
requestAnimationFrame(frame);

/* ------------------------------------------------------------- automation */

declare global {
  interface Window {
    fxHarness: unknown;
  }
}

window.fxHarness = {
  fx,
  dropBall,
  burst,
  pop,
  points: (n: number) => fx.popText.showPoints(n, focus, PLAYER_COLORS[n % 4]),
  spawnPowerUp,
  pickUpPowerUps,
  bonkCombo,
  setCamera,
  setArena,
  setPanel,
  /** Point the camera: from (fx, fy, fz) looking at (tx, ty, tz). */
  look: (fx: number, fy: number, fz: number, tx: number, ty: number, tz: number) => {
    camera.position.set(fx, fy, fz);
    controls.target.set(tx, ty, tz);
    controls.update();
  },
  freeze: (on: boolean) => (frozen = on),
  charge: (on: boolean) => {
    charging = on;
    charge = on ? 1 : 0;
    if (on && !balls.some((b) => b.holderId === me.id)) giveBall(me);
  },
  throwAtMe: (c = 1) => throwFrom(players[1], me, c, ""),
  throwMega: () => throwFrom(players[3], players[1], 1, "mega"),
  throwTriple: () => throwFrom(players[1], players[3], 0.7, "triple"),
  throwBoomerang: () => throwFrom(players[3], players[1], 0.6, "boomerang"),
  throwCurve: () => throwFrom(me, players[3], 0.8, "", true),
  setZoomies: (on: boolean) => (zoomies = on),
  setSkid: (on: boolean) => (skid = on),
  koPop: (c: CharacterId) => fx.koPop({ x: focus.x, y: 0, z: focus.z }, c),
  stats: () => ({ particles: fx.particles.count, calls: renderer.info.render.calls, balls: balls.length, fps }),
};
