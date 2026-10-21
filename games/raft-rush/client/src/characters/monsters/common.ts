// Shared pieces of the monster cast: the rig interface every kind implements, a baker for vertex-colored part
// geometries, the instanced part pool (every crab of the night is ~12 draw calls in total, however many
// there are), googly-eye springs (copied from games/jelly-jackpot/client/src/scene/toon.ts jiggleEyes) and the
// neon eye / pupil materials. Owner: client-characters.

import * as THREE from "three";
import type { MonsterTrigger } from "../Characters";
import type { MonsterFrame } from "../../net/types";
import { createToonMaterial, getSmoothOutlineGeometry } from "../../render/Toon";
import { bodyMaterial, inkOutline, mergePrims, type Prim, trs, type V3 } from "../kit";

/** Monster outlines (view-space meters). */
export const MONSTER_OUTLINE = 0.02;

/** Per-frame context Monsters passes to every rig. */
export interface MonsterEnv {
  /** 0 (day) .. 1 (night): neon eyes glow brighter. */
  dark: number;
  time: number;
}

/** One monster on screen. */
export interface MonsterRig {
  readonly id: string;
  readonly kind: MonsterFrame["kind"];
  /** World placement node (also the parent of regular-mesh accessories). */
  readonly root: THREE.Object3D;
  update(frame: MonsterFrame, dt: number, env: MonsterEnv): void;
  trigger(what: MonsterTrigger): void;
  /** Push this rig's part matrices into the instanced pools (after the scene matrices were updated). */
  writeInstances(): void;
  /** Body center in world space. */
  center(out: THREE.Vector3): void;
  /** Start the death / despawn animation; returns its length in seconds. */
  beginDeath(): number;
  /** Advance the death animation (no frame). */
  updateDeath(dt: number, env: MonsterEnv): void;
  dispose(): void;
}

/* ============================================================ part bake */

/** Accumulates colored primitives in a part's own space and bakes them into one geometry. */
export class PartBaker {
  private readonly prims: Prim[] = [];
  private readonly outlined: Prim[] = [];

  add(geometry: THREE.BufferGeometry, color: string, matrix: THREE.Matrix4, outline = true): this {
    const p: Prim = { geometry, matrix, color: new THREE.Color(color) };
    this.prims.push(p);
    if (outline) this.outlined.push(p);
    return this;
  }

  /** Primitive at `at` with rotation (euler XYZ) and size. */
  put(geometry: THREE.BufferGeometry, color: string, at: V3, size: V3 | number, rot: V3 = [0, 0, 0], outline = true): this {
    return this.add(geometry, color, trs(at, rot, size), outline);
  }

  bake(): { geometry: THREE.BufferGeometry; outline: THREE.BufferGeometry | null } {
    return { geometry: mergePrims(this.prims), outline: this.outlined.length ? mergePrims(this.outlined) : null };
  }
}

/* ======================================================== instanced pool */

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

/** One instanced part type (shared by every monster of the kinds that use it). */
export class InstancedPart {
  readonly mesh: THREE.InstancedMesh;
  readonly outline: THREE.InstancedMesh | null;
  private count = 0;

  constructor(
    parent: THREE.Object3D,
    name: string,
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    capacity: number,
    outlineGeometry: THREE.BufferGeometry | null,
    castShadow: boolean,
  ) {
    this.mesh = new THREE.InstancedMesh(geometry, material, capacity);
    this.mesh.name = `monster-${name}`;
    this.mesh.frustumCulled = false;
    this.mesh.castShadow = castShadow;
    this.mesh.receiveShadow = false;
    this.mesh.count = 0;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < capacity; i++) this.mesh.setMatrixAt(i, ZERO);
    parent.add(this.mesh);
    if (outlineGeometry) {
      const ol = new THREE.InstancedMesh(getSmoothOutlineGeometry(outlineGeometry), inkOutline(MONSTER_OUTLINE), capacity);
      ol.name = `monster-${name}-outline`;
      ol.userData.isOutline = true;
      ol.frustumCulled = false;
      ol.castShadow = false;
      ol.receiveShadow = false;
      // Same instance matrices as the body part.
      ol.instanceMatrix = this.mesh.instanceMatrix;
      ol.count = 0;
      parent.add(ol);
      this.outline = ol;
    } else {
      this.outline = null;
    }
  }

  begin(): void {
    this.count = 0;
  }

  /** Append one instance (world matrix). Over capacity → ignored. */
  push(matrix: THREE.Matrix4): void {
    if (this.count >= this.mesh.instanceMatrix.count) return;
    this.mesh.setMatrixAt(this.count++, matrix);
  }

  end(): void {
    this.mesh.count = this.count;
    if (this.outline) this.outline.count = this.count;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.outline?.removeFromParent();
    this.mesh.dispose();
    this.outline?.dispose();
  }
}

/** Part definition for a pool. */
export interface PartDef {
  name: string;
  geometry: THREE.BufferGeometry;
  outline: THREE.BufferGeometry | null;
  material?: THREE.Material;
  /** Instances per monster (legs: 6). */
  perMonster: number;
  castShadow?: boolean;
}

/** A named set of instanced parts for one or more monster kinds. */
export class InstancedPool {
  readonly parts = new Map<string, InstancedPart>();

  constructor(parent: THREE.Object3D, defs: ReadonlyArray<PartDef>, maxMonsters: number) {
    for (const d of defs) {
      this.parts.set(d.name, new InstancedPart(parent, d.name, d.geometry, d.material ?? bodyMaterial(), d.perMonster * maxMonsters, d.outline, d.castShadow ?? false));
    }
  }

  part(name: string): InstancedPart {
    const p = this.parts.get(name);
    if (!p) throw new Error(`no instanced part ${name}`);
    return p;
  }

  begin(): void {
    for (const p of this.parts.values()) p.begin();
  }

  end(): void {
    for (const p of this.parts.values()) p.end();
  }

  dispose(): void {
    for (const p of this.parts.values()) p.dispose();
    this.parts.clear();
  }
}

/* ============================================================== googly */

/** A googly pupil: a damped spring that rattles around in its eyeball (offset in eyeball radii, |off| ≤ 0.45). */
export class Googly {
  readonly off = new THREE.Vector2();
  private readonly vel = new THREE.Vector2();

  /** `shake` ≈ how violently the eye is being moved this frame (speed, hits). */
  update(dt: number, shake: number): void {
    const v = this.vel;
    const off = this.off;
    const step = Math.min(dt, 0.05);
    const kick = shake * 0.02 + 0.0004;
    v.x += (Math.random() - 0.5) * kick - off.x * 120 * step;
    v.y += (Math.random() - 0.5) * kick - off.y * 120 * step;
    v.multiplyScalar(Math.max(0, 1 - 6 * step));
    off.addScaledVector(v, step * 60);
    if (off.length() > 0.45) off.setLength(0.45);
  }

  /** Spin the pupil around the rim (dizzy). */
  spin(angle: number): void {
    this.off.set(Math.cos(angle) * 0.4, Math.sin(angle) * 0.4);
    this.vel.set(0, 0);
  }
}

/* ============================================================ materials */

let neonEye: THREE.MeshToonMaterial | null = null;
let pupilMat: THREE.MeshBasicMaterial | null = null;

/** Neon googly eyeballs (emissive: they glow in the dark). Owned here; intensity follows the night. */
export function neonEyeMaterial(): THREE.MeshToonMaterial {
  if (!neonEye) {
    neonEye = createToonMaterial("#F4FFB8", { emissive: "#C6FF3A", emissiveIntensity: 0.4 });
    neonEye.name = "monster-neon-eye";
  }
  return neonEye;
}

export function pupilMaterial(): THREE.MeshBasicMaterial {
  if (!pupilMat) {
    pupilMat = new THREE.MeshBasicMaterial({ color: "#1A1820" });
    pupilMat.name = "monster-pupil";
  }
  return pupilMat;
}

/** Night glow of the neon eyes (called once per frame by Monsters). */
export function setEyeGlow(dark: number): void {
  const m = neonEyeMaterial();
  m.emissiveIntensity = 0.35 + 1.4 * Math.max(0, Math.min(1, dark));
}

/* ============================================================== motion */

/** Smoothed yaw follower with the yaw rate (for banking / sideways scuttles). */
export class YawFollower {
  yaw = 0;
  rate = 0;
  private has = false;

  update(target: number, dt: number, speed = 10): number {
    if (!this.has) {
      this.yaw = target;
      this.has = true;
      return this.yaw;
    }
    const d = wrap(target - this.yaw);
    const step = d * (1 - Math.exp(-speed * dt));
    this.rate = dt > 0 ? step / dt : 0;
    this.yaw = wrap(this.yaw + step);
    return this.yaw;
  }
}

export function wrap(a: number): number {
  const TAU = Math.PI * 2;
  return ((((a + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
}

/** Underdamped squash spring (hits, landings), stepped at 1/120 s. */
export class Squash {
  x = 0;
  v = 0;
  kick(v: number): void {
    this.v += v;
  }
  step(dt: number): void {
    let left = Math.min(dt, 0.1);
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      this.v += (-260 * this.x - 9 * this.v) * h;
      this.x += this.v * h;
      left -= h;
    }
    this.x = Math.max(-0.4, Math.min(0.4, this.x));
  }
}

/** A one-shot timer (seconds left / total). */
export class Clip {
  t = 0;
  dur = 0;
  start(dur: number): void {
    this.t = 0;
    this.dur = dur;
  }
  step(dt: number): void {
    if (this.dur > 0) this.t += dt;
    if (this.t >= this.dur) this.dur = 0;
  }
  get active(): boolean {
    return this.dur > 0;
  }
  /** 0..1 progress (1 when inactive). */
  get u(): number {
    return this.dur > 0 ? Math.min(1, this.t / this.dur) : 1;
  }
}
