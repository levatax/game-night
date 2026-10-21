// Kirpi topları (puffer balls, game4.md §10/§16): a spiky yellow ball with pouty lips and googly eyes that
// rolls at you fast (its face tumbling around), hops over bumps, rights itself to glare when it stops, swells
// up before it pops on contact and wobbles dizzily when stunned. Drawn through the instanced puffer pool.
// Owner: client-characters.

import * as THREE from "three";
import { MONSTER_EMERGE_TICKS, MONSTERS } from "../../../../shared/constants";
import type { MonsterFrame } from "../../net/types";
import type { MonsterTrigger } from "../Characters";
import { alongMatrix, cachedGeometry, coneGeo, sphereGeo } from "../kit";
import { Clip, Googly, type InstancedPool, type MonsterEnv, type MonsterRig, neonEyeMaterial, type PartDef, PartBaker, pupilMaterial, Squash } from "./common";

const R = 0.4;
const SKIN = "#F2C66D";
const BELLY = "#FFF1C9";
const SPOT = "#B07A3A";
const SPIKE = "#8A5A24";
const LIPS = "#FF8A8A";
const EYE_R = 0.095;
const PUPIL_R = 0.05;

/** Outward spike directions: the icosahedron's vertices, minus the two facing the front (the face). */
function spikeDirs(): THREE.Vector3[] {
  const ico = new THREE.IcosahedronGeometry(1, 0);
  const pos = ico.getAttribute("position") as THREE.BufferAttribute;
  const dirs: THREE.Vector3[] = [];
  for (let i = 0; i < pos.count; i++) {
    const v = new THREE.Vector3().fromBufferAttribute(pos, i).normalize();
    if (v.z < -0.55 && Math.abs(v.y) < 0.6) continue;
    if (!dirs.some((d) => d.distanceTo(v) < 1e-3)) dirs.push(v);
  }
  ico.dispose();
  return dirs;
}

export function pufferPartDefs(): PartDef[] {
  const body = cachedGeometry("puffer-ico", () => new THREE.IcosahedronGeometry(1, 1));
  const b = new PartBaker()
    .put(body, SKIN, [0, 0, 0], R)
    .put(sphereGeo(7), BELLY, [0, -0.14, -0.12], [0.3, 0.24, 0.3], [0, 0, 0], false);
  for (const [x, y, z] of [[0.15, 0.3, 0.1], [-0.2, 0.25, 0.15], [0.05, 0.2, 0.33], [-0.3, 0.05, 0.22], [0.32, 0.1, 0.18]] as const) {
    const n = new THREE.Vector3(x, y, z).normalize();
    b.put(sphereGeo(5), SPOT, [n.x * R * 0.97, n.y * R * 0.97, n.z * R * 0.97], [0.05, 0.05, 0.05], [0, 0, 0], false);
  }
  for (const d of spikeDirs()) {
    const base: [number, number, number] = [d.x * R * 0.92, d.y * R * 0.92, d.z * R * 0.92];
    const tip: [number, number, number] = [d.x * R * 1.35, d.y * R * 1.35, d.z * R * 1.35];
    b.add(coneGeo(4), SPIKE, alongMatrix(base, tip, 0.045), false);
  }
  // Pouty lips, side fins, tail fin.
  b.put(sphereGeo(6), LIPS, [0, -0.1, -0.385], [0.07, 0.045, 0.04], [0, 0, 0], false);
  b.put(sphereGeo(5), "#6B2230", [0, -0.1, -0.41], [0.035, 0.025, 0.02], [0, 0, 0], false);
  for (const s of [1, -1]) b.put(sphereGeo(5), SKIN, [0.4 * s, -0.05, -0.05], [0.04, 0.09, 0.07], [0, 0, 0.4 * s], false);
  b.add(coneGeo(5), SKIN, alongMatrix([0, 0, 0.36], [0, 0.04, 0.55], 0.1), false);
  const baked = b.bake();
  const eye = new PartBaker().put(sphereGeo(7), "#FFFFFF", [0, 0, 0], EYE_R, [0, 0, 0], false).bake();
  const pupil = new PartBaker().put(sphereGeo(5), "#111111", [0, 0, 0], PUPIL_R, [0, 0, 0], false).bake();
  const outline = new PartBaker().put(body, SKIN, [0, 0, 0], R).bake();
  return [
    { name: "ball", geometry: baked.geometry, outline: outline.geometry, perMonster: 1, castShadow: true },
    { name: "eye", geometry: eye.geometry, outline: null, perMonster: 2, material: neonEyeMaterial() },
    { name: "pupil", geometry: pupil.geometry, outline: null, perMonster: 2, material: pupilMaterial() },
  ];
}

const UP = new THREE.Vector3(0, 1, 0);
const tmpAxis = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const faceQ = new THREE.Quaternion();

export class PufferRig implements MonsterRig {
  readonly id: string;
  readonly kind: MonsterFrame["kind"] = "puffer";
  readonly root = new THREE.Object3D();
  private readonly ball = new THREE.Object3D();
  private readonly eyes: { ball: THREE.Object3D; pupil: THREE.Object3D; googly: Googly }[] = [];
  private readonly roll = new THREE.Quaternion();
  private readonly squash = new Squash();
  private readonly swell = new Clip();
  private readonly spawnClip = new Clip();
  private yaw = 0;
  private hasYaw = false;
  private hop = Math.random() * 10;
  private time = Math.random() * 10;
  private mode: MonsterFrame["mode"] = "emerge";
  private modeTicks = 0;
  private death: { t: number; dur: number } | null = null;

  constructor(
    id: string,
    private readonly pool: InstancedPool,
  ) {
    this.id = id;
    this.root.name = `puffer:${id}`;
    this.root.add(this.ball);
    this.ball.position.y = R;
    for (const s of [1, -1]) {
      const ball = new THREE.Object3D();
      ball.position.set(0.16 * s, 0.11, -0.31);
      const pupil = new THREE.Object3D();
      ball.add(pupil);
      this.ball.add(ball);
      this.eyes.push({ ball, pupil, googly: new Googly() });
    }
  }

  update(f: MonsterFrame, dt: number, _env: MonsterEnv): void {
    this.time += dt;
    this.mode = f.mode;
    this.modeTicks = f.modeTicks;
    this.root.position.set(f.x, f.y, f.z);
    if (!this.hasYaw) {
      this.yaw = f.yaw;
      this.hasYaw = true;
      this.roll.setFromAxisAngle(UP, f.yaw);
    }
    this.yaw = f.yaw;
    this.swell.step(dt);
    this.spawnClip.step(dt);
    this.squash.step(dt);
    // Roll along the travel direction; stand up to glare when slow.
    const speed = f.speed;
    if (speed > 0.05 && this.mode !== "stunned") {
      tmpAxis.set(-Math.cos(this.yaw), 0, Math.sin(this.yaw));
      tmpQ.setFromAxisAngle(tmpAxis, (speed * dt) / R);
      this.roll.premultiply(tmpQ);
    }
    if (speed < 0.8 || this.mode === "bite") {
      faceQ.setFromAxisAngle(UP, this.yaw);
      this.roll.slerp(faceQ, 1 - Math.exp(-4 * dt));
    }
    this.roll.normalize();
    this.hop += dt * (6 + speed * 1.6);
    this.pose(dt, speed);
  }

  trigger(what: MonsterTrigger): void {
    switch (what) {
      case "spawn":
        this.spawnClip.start(0.5);
        break;
      case "hurt":
        this.squash.kick(-3);
        for (const e of this.eyes) e.googly.update(0.016, 40);
        break;
      case "attack":
        this.swell.start(0.35);
        this.squash.kick(2.5);
        break;
      default:
        this.squash.kick(1);
        break;
    }
  }

  writeInstances(): void {
    this.pool.part("ball").push(this.ball.matrixWorld);
    for (const e of this.eyes) {
      this.pool.part("eye").push(e.ball.matrixWorld);
      this.pool.part("pupil").push(e.pupil.matrixWorld);
    }
  }

  center(out: THREE.Vector3): void {
    this.ball.getWorldPosition(out);
  }

  beginDeath(): number {
    if (!this.death) this.death = { t: 0, dur: this.mode === "flee" ? 0.7 : 0.25 };
    return this.death.dur - this.death.t;
  }

  updateDeath(dt: number, _env: MonsterEnv): void {
    const d = this.death;
    if (!d) return;
    d.t += dt;
    this.time += dt;
    const u = Math.min(1, d.t / d.dur);
    if (this.mode === "flee") {
      this.ball.position.y = R - 1.1 * u * u;
    } else {
      // Pop: swell, then gone.
      this.ball.scale.setScalar(u < 0.6 ? 1 + 0.6 * (u / 0.6) : Math.max(0.001, 1.6 * (1 - (u - 0.6) / 0.4)));
    }
    this.root.updateMatrixWorld(true);
  }

  dispose(): void {
    this.root.removeFromParent();
  }

  private pose(dt: number, speed: number): void {
    const t = this.time;
    let scale = 1;
    let y = R;
    if (this.mode === "emerge") {
      const p = 1 - Math.min(1, this.modeTicks / MONSTER_EMERGE_TICKS);
      scale *= 0.35 + 0.65 * p;
      y -= 0.4 * (1 - p);
    }
    if (this.spawnClip.active) scale *= 0.3 + 0.7 * Math.min(1, this.spawnClip.u * 1.4);
    const moving = Math.min(1, speed / 2);
    y += 0.07 * Math.abs(Math.sin(this.hop)) * moving;
    if (this.mode === "bite") scale *= 1.08 + 0.1 * Math.abs(Math.sin(t * 12));
    if (this.swell.active) scale *= 1 + 0.35 * Math.sin(Math.PI * this.swell.u);
    const sq = this.squash.x;
    this.ball.position.set(0, y + (scale - 1) * R, 0);
    this.ball.quaternion.copy(this.roll);
    if (this.mode === "stunned") this.ball.quaternion.multiply(tmpQ.setFromAxisAngle(tmpAxis.set(0, 0, 1), 0.25 * Math.sin(t * 9)));
    this.ball.scale.set(scale * (1 - sq * 0.5), scale * (1 + sq), scale * (1 - sq * 0.5));
    const shake = moving * 2 + (this.mode === "bite" ? 3 : 0);
    for (let i = 0; i < this.eyes.length; i++) {
      const e = this.eyes[i]!;
      if (this.mode === "stunned") e.googly.spin(t * 8 + i * Math.PI);
      else e.googly.update(dt, shake);
      e.pupil.position.set(e.googly.off.x * EYE_R, e.googly.off.y * EYE_R, -EYE_R * 0.62);
    }
  }
}

export const PUFFER_RADIUS = MONSTERS.puffer.radius;
