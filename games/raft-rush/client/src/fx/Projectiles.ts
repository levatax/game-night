// Thrown / dropped item visuals: one buildItemMesh() object per ProjectileFrame id. Owner: client-fx-audio.
// Adapted from games/bonk-brawl/client/src/fx/Balls.ts (pooled visuals keyed by id, predicted visuals adopted by
// the server projectile of the same throw, squash on bounce, trail while live, fade for timed-out predictions).
//
// - live: tumbles by `age` (so a predicted throw and its server twin spin identically); spears point along their
//   velocity; puffers pulse; a short white trail.
// - loose: round items roll along the ground, the rest keep tumbling and slow down.
// - rest: eases into a lying pose (tools flat, fish on their side), bobs slightly and glows so it can be found
//   (more at night: the halo is additive); occasional glints; bait fish emit green smell lines.
// - stuck: a spear keeps the angle it hit with.
// - bounced: squash along world up, by impact speed. opacity < 1: the item fades (per-visual material clones).
// - hand-off (first person): my own predicted throw is drawn leaving the first-person hand, not the simulated throw
//   origin, and eases onto its true path over HAND_OFF_SEC (render-only offset; the simulation never moves).

import * as THREE from "three";
import type { ItemKind, Vec3Like } from "../../../shared/types";
import type { ProjectileFrame } from "../net/types";
import { BILLBOARD_FACING, BillboardBatch } from "./billboard";
import { glowTexture } from "./fxTextures";
import { buildItemMesh, flickerFlame, itemInfo } from "./itemMeshes";
import type { Particles } from "./Particles";
import type { BlobShadows } from "./Shadows";
import { Trail } from "./Trail";

const TRAIL_SEC = 0.22;
const TRAIL_MIN_SPEED = 6;
const SQUASH_SEC = 0.24;
const REMOVE_SEC = 0.14;
const REST_EASE = 10;
const BOB_HEIGHT = 0.03;
const BOB_HZ = 0.45;
/** A predicted visual is adopted by a server projectile of the same owner + kind within this distance (m). */
const ADOPT_DIST = 3;
const HALO_SCALE = 4.4;
const MAX_HALOS = 64;
const FULL_UV = new THREE.Vector4(0, 0, 1, 1);
const HALO_COLOR = "#FFF1C2";
const BAIT_HALO_COLOR = "#C9F27A";
const GOLD_HALO_COLOR = "#FFD166";
/** First person: how long (s) my own throw's visual takes to blend from the drawn hand onto its simulated path. */
export const HAND_OFF_SEC = 0.08;
/** A hand further than this (m) from the spawn point is ignored (stale arms pose): the visual starts on its path. */
const HAND_OFF_MAX_DIST = 2;

/**
 * Weight (1 → 0) of the hand-off offset `t` seconds after the visual spawned: an ease-out, so the item leaves the
 * hand quickly and settles onto the simulated path without a kink at the end. 0 from HAND_OFF_SEC on.
 */
export function handOffWeight(t: number): number {
  if (!(t < HAND_OFF_SEC)) return 0;
  if (t <= 0) return 1;
  const u = 1 - t / HAND_OFF_SEC;
  return u * u;
}

/** Tumble rate in flight (rad/s) per kind; unlisted kinds use DEFAULT_SPIN. */
const SPIN_RATE: Partial<Record<ItemKind, number>> = {
  coconut: 9,
  coconut_ball: 7,
  stone: 11,
  wood: 8,
  boot: 10,
  fish_raw: 7,
  fish_cooked: 6,
  fish_golden: 7,
  crab_raw: 6,
  crab_cooked: 6,
  puffer: 8,
  jellyfish: 3,
  raft_part: 5,
  fence: 6,
  kraken: 5,
};
const DEFAULT_SPIN = 7;
/** Kinds that roll along the ground when loose (and keep their roll at rest). */
const ROUND: ReadonlySet<ItemKind> = new Set<ItemKind>(["coconut", "coconut_ball", "stone", "puffer", "water"]);
/** Fish-like kinds lie on their side. */
const ON_SIDE: ReadonlySet<ItemKind> = new Set<ItemKind>(["fish_raw", "fish_cooked", "fish_golden", "kraken"]);

const UP = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const LONG_TOOLS: ReadonlySet<ItemKind> = new Set<ItemKind>(["spear", "rod", "torch", "axe"]);
const restScratch = new THREE.Quaternion();

/** Lying pose of a kind on top of `base` (yaw): tools flat, fish on their side, fences face up. */
function restPoseFor(kind: ItemKind, base: THREE.Quaternion, out: THREE.Quaternion): THREE.Quaternion {
  out.copy(base);
  if (LONG_TOOLS.has(kind)) out.multiply(restScratch.setFromAxisAngle(Z_AXIS, Math.PI / 2));
  else if (ON_SIDE.has(kind)) out.multiply(restScratch.setFromAxisAngle(X_AXIS, Math.PI / 2));
  else if (kind === "fence") out.multiply(restScratch.setFromAxisAngle(X_AXIS, -Math.PI / 2));
  return out;
}

/** Deterministic 0..1 from a string id (cosmetic variety). */
function idHash(id: string, salt = 0): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 13;
  h = Math.imul(h, 0x5bd1e995);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

interface FadeState {
  originals: Array<[THREE.Mesh, THREE.Material | THREE.Material[]]>;
  clones: THREE.Material[];
  opacity: number;
}

interface Visual {
  id: string;
  ownerId: string;
  kind: ItemKind;
  stamp: number;
  root: THREE.Group;
  spin: THREE.Group;
  item: THREE.Object3D;
  trail: Trail;
  orient: THREE.Quaternion;
  restQuat: THREE.Quaternion;
  axis: THREE.Vector3;
  base: THREE.Quaternion;
  lastState: ProjectileFrame["state"] | "";
  restBlend: number;
  squashT: number;
  squashAmount: number;
  removing: number;
  phase: number;
  fade: FadeState | null;
  /** Rest pose: lift so the lying item touches the ground (computed per kind). */
  restLift: number;
  /** First-person hand-off: drawn hand − simulated position when the visual spawned (render-only offset). */
  handOff: THREE.Vector3;
  /** Seconds since the hand-off started (≥ HAND_OFF_SEC: no offset). */
  handOffT: number;
}

export class ProjectileVisuals {
  private readonly root = new THREE.Group();
  private readonly visuals = new Map<string, Visual>();
  private readonly pool: Visual[] = [];
  private readonly itemPool = new Map<ItemKind, THREE.Object3D[]>();
  private readonly restLiftCache = new Map<ItemKind, number>();
  private readonly unmatched: ProjectileFrame[] = [];
  private stamp = 0;
  private time = 0;
  private readonly tmpV = new THREE.Vector3();
  private readonly tmpV2 = new THREE.Vector3();
  private readonly tmpQ = new THREE.Quaternion();
  private readonly tmpQ2 = new THREE.Quaternion();
  private readonly white = new THREE.Color("#FFFFFF");
  private readonly box = new THREE.Box3();
  private readonly haloColor = new THREE.Color();
  /** Every pickup halo in one additive draw call. */
  private readonly halos: BillboardBatch;

  constructor(
    parent: THREE.Object3D,
    private readonly particles: Particles,
    private readonly shadows: BlobShadows,
  ) {
    this.root.name = "fx-projectiles";
    parent.add(this.root);
    this.halos = new BillboardBatch(this.root, {
      name: "fx-pickup-halos",
      capacity: MAX_HALOS,
      map: glowTexture(),
      additive: true,
      renderOrder: 3,
      fog: false,
    });
  }

  get count(): number {
    return this.visuals.size;
  }

  /** World position of a projectile visual (false if unknown). */
  getPosition(id: string, out: THREE.Vector3): boolean {
    const v = this.visuals.get(id);
    if (!v || !v.root.visible) return false;
    out.copy(v.root.position);
    return true;
  }

  /**
   * Per frame: create / move / remove a visual per frame id. `hand`: the first-person hand's world position this
   * frame (null outside first person): a predicted throw seen for the first time starts there (the hand-off).
   */
  sync(frames: ReadonlyArray<ProjectileFrame>, dt: number, hand: Vec3Like | null = null): void {
    this.stamp++;
    this.time += dt;
    this.halos.begin();
    this.unmatched.length = 0;
    for (const f of frames) {
      const v = this.visuals.get(f.id);
      if (v && v.kind === f.kind) v.stamp = this.stamp;
      else this.unmatched.push(f);
    }
    for (const f of this.unmatched) this.attach(f, hand).stamp = this.stamp;
    for (const f of frames) {
      const v = this.visuals.get(f.id);
      if (v) this.updateVisual(v, f, dt);
    }
    for (const v of [...this.visuals.values()]) {
      if (v.stamp !== this.stamp) this.updateRemoved(v, dt);
    }
    this.halos.end();
  }

  clear(): void {
    for (const v of [...this.visuals.values()]) this.release(v);
    this.halos.begin();
    this.halos.end();
  }

  dispose(): void {
    this.clear();
    for (const v of this.pool) v.trail.dispose();
    this.halos.dispose();
    this.pool.length = 0;
    this.itemPool.clear();
    this.root.removeFromParent();
  }

  /* ------------------------------------------------------------- lifecycle */

  private attach(f: ProjectileFrame, hand: Vec3Like | null): Visual {
    const existing = this.visuals.get(f.id);
    if (existing) this.release(existing);
    // An adopted visual keeps its running hand-off: the server twin continues the predicted throw seamlessly.
    const adopted = f.predicted ? null : this.adoptPredicted(f);
    if (adopted) return adopted;
    const v = this.pool.pop() ?? this.createVisual();
    v.id = f.id;
    v.ownerId = f.ownerId;
    v.kind = f.kind;
    v.item = this.takeItem(f.kind);
    v.spin.add(v.item);
    v.axis.set(idHash(f.id, 1) - 0.5, idHash(f.id, 2) - 0.5, idHash(f.id, 3) - 0.5);
    if (v.axis.lengthSq() < 1e-4) v.axis.set(1, 0.3, 0);
    v.axis.normalize();
    v.base.setFromAxisAngle(UP, idHash(f.id, 4) * Math.PI * 2);
    v.phase = idHash(f.id, 5) * Math.PI * 2;
    v.lastState = "";
    v.restBlend = f.state === "rest" || f.state === "stuck" ? 1 : 0;
    v.squashT = SQUASH_SEC;
    v.squashAmount = 0;
    v.removing = 0;
    v.restLift = this.restLiftFor(f.kind);
    v.orient.copy(v.base);
    if (f.state === "rest") restPoseFor(v.kind, v.base, v.orient);
    if (f.state === "stuck") v.orient.copy(this.stuckPose(v, f));
    v.restQuat.copy(v.orient);
    this.startHandOff(v, f, hand);
    v.root.position.set(f.x + v.handOff.x, f.y + v.handOff.y, f.z + v.handOff.z);
    v.root.scale.setScalar(1);
    v.root.visible = true;
    v.trail.reset();
    this.visuals.set(f.id, v);
    return v;
  }

  /**
   * A predicted live projectile (my own throw, just released) starts at the first-person hand: remember the offset
   * hand − simulated position, faded out by handOffWeight(). Anything else (or no hand) gets no offset.
   */
  private startHandOff(v: Visual, f: ProjectileFrame, hand: Vec3Like | null): void {
    const o = v.handOff;
    o.set(0, 0, 0);
    v.handOffT = HAND_OFF_SEC;
    if (!hand || !f.predicted || f.state !== "live") return;
    o.set(hand.x - f.x, hand.y - f.y, hand.z - f.z);
    const d2 = o.lengthSq();
    if (!(d2 <= HAND_OFF_MAX_DIST * HAND_OFF_MAX_DIST)) {
      o.set(0, 0, 0);
      return;
    }
    v.handOffT = 0;
  }

  private adoptPredicted(f: ProjectileFrame): Visual | null {
    let best: Visual | null = null;
    let bestDist = ADOPT_DIST * ADOPT_DIST;
    this.tmpV.set(f.x, f.y, f.z);
    for (const v of this.visuals.values()) {
      if (v.stamp === this.stamp || !v.id.startsWith("pred:") || v.ownerId !== f.ownerId || v.kind !== f.kind) continue;
      const d = v.root.position.distanceToSquared(this.tmpV);
      if (d < bestDist) {
        bestDist = d;
        best = v;
      }
    }
    if (!best) return null;
    this.visuals.delete(best.id);
    best.id = f.id;
    best.removing = 0;
    this.visuals.set(f.id, best);
    return best;
  }

  private createVisual(): Visual {
    const root = new THREE.Group();
    root.name = "fx-projectile";
    const spin = new THREE.Group();
    root.add(spin);
    this.root.add(root);
    return {
      id: "",
      ownerId: "",
      kind: "coconut",
      stamp: 0,
      root,
      spin,
      item: new THREE.Object3D(),
      trail: new Trail(this.root, TRAIL_SEC),
      orient: new THREE.Quaternion(),
      restQuat: new THREE.Quaternion(),
      axis: new THREE.Vector3(1, 0, 0),
      base: new THREE.Quaternion(),
      lastState: "",
      restBlend: 0,
      squashT: SQUASH_SEC,
      squashAmount: 0,
      removing: 0,
      phase: 0,
      fade: null,
      restLift: 0,
      handOff: new THREE.Vector3(),
      handOffT: HAND_OFF_SEC,
    };
  }

  private release(v: Visual): void {
    this.visuals.delete(v.id);
    this.restoreMaterials(v);
    v.item.removeFromParent();
    this.returnItem(v.kind, v.item);
    v.item = new THREE.Object3D();
    v.root.visible = false;
    v.trail.reset();
    this.pool.push(v);
  }

  private takeItem(kind: ItemKind): THREE.Object3D {
    const list = this.itemPool.get(kind);
    const obj = list?.pop() ?? buildItemMesh(kind);
    obj.position.set(0, 0, 0);
    obj.quaternion.identity();
    obj.scale.setScalar(1);
    obj.visible = true;
    return obj;
  }

  private returnItem(kind: ItemKind, obj: THREE.Object3D): void {
    if (!itemInfo(obj)) return;
    let list = this.itemPool.get(kind);
    if (!list) {
      list = [];
      this.itemPool.set(kind, list);
    }
    if (list.length < 12) list.push(obj);
  }

  /* --------------------------------------------------------------- update */

  private updateVisual(v: Visual, f: ProjectileFrame, dt: number): void {
    v.removing = 0;
    const entering = v.lastState !== f.state;
    if (entering) this.enterState(v, f);
    v.lastState = f.state;
    if (f.bounced) {
      v.squashT = 0;
      v.squashAmount = Math.min(0.42, Math.max(0.08, f.bounceSpeed / 14));
    }
    v.squashT = Math.min(SQUASH_SEC, v.squashT + dt);

    const speed = Math.hypot(f.vx, f.vy, f.vz);
    switch (f.state) {
      case "live":
        this.flightOrientation(v, f, v.orient);
        v.restBlend = 0;
        break;
      case "loose":
        this.looseOrientation(v, f, dt);
        v.restBlend = 0;
        break;
      case "rest":
        v.orient.slerp(v.restQuat, 1 - Math.exp(-REST_EASE * dt));
        v.restBlend = Math.min(1, v.restBlend + dt * 4);
        break;
      case "stuck":
        v.restBlend = 1;
        break;
    }
    v.spin.quaternion.copy(v.orient);

    // First-person hand-off: the drawn position eases from the hand onto the simulated one (render only).
    let ox = 0;
    let oy = 0;
    let oz = 0;
    if (v.handOffT < HAND_OFF_SEC) {
      const w = handOffWeight(v.handOffT);
      ox = v.handOff.x * w;
      oy = v.handOff.y * w;
      oz = v.handOff.z * w;
      v.handOffT += dt;
    }
    const x = f.x + ox;
    const z = f.z + oz;

    // Position: resting items settle to the ground and bob gently.
    let y = f.y + oy;
    if (f.state === "rest") {
      const bob = BOB_HEIGHT * (0.6 + 0.4 * Math.sin(this.time * BOB_HZ * Math.PI * 2 + v.phase));
      y += (v.restLift + bob) * v.restBlend;
    }
    v.root.position.set(x, y, z);

    // Squash along world up after a bounce; puffers swell in flight; jellyfish wobble.
    let sx = 1;
    let sy = 1;
    if (v.squashT < SQUASH_SEC) {
      const t = v.squashT / SQUASH_SEC;
      const e = Math.cos(t * Math.PI * 2.2) * (1 - t) * (1 - t);
      sy = 1 - v.squashAmount * e;
      sx = 1 + v.squashAmount * 0.55 * e;
    }
    if (f.kind === "puffer" && f.state === "live") {
      const k = 1 + 0.12 * Math.sin(this.time * 30 + v.phase);
      sx *= k;
      sy *= k;
    } else if (f.kind === "jellyfish") {
      const k = 0.08 * Math.sin(this.time * 9 + v.phase);
      sx *= 1 + k;
      sy *= 1 - k;
    }
    v.root.scale.set(sx, sy, sx);

    flickerFlame(v.item, this.time, true, v.phase);
    this.updateFade(v, f.opacity);
    this.updateGlow(v, f);
    this.updateTrail(v, f, dt, speed, x, f.y + oy, z);
    this.shadows.add({ x, y: f.y + oy, z, radius: Math.max(0.12, f.radius), opacity: f.opacity });
  }

  private updateRemoved(v: Visual, dt: number): void {
    v.removing += dt;
    if (v.removing >= REMOVE_SEC) {
      this.release(v);
      return;
    }
    const k = 1 - v.removing / REMOVE_SEC;
    v.root.scale.setScalar(Math.max(0.01, k));
    v.trail.rebuild(v.root.position.x, v.root.position.y, v.root.position.z);
  }

  private enterState(v: Visual, f: ProjectileFrame): void {
    if (f.state === "rest") {
      if (ROUND.has(v.kind)) v.restQuat.copy(v.orient);
      else restPoseFor(v.kind, v.base, v.restQuat);
      v.restBlend = 0;
    } else if (f.state === "stuck") {
      if (v.lastState === "live" || v.lastState === "loose") {
        // Keep the impact angle: point along the last flight direction, embedded a bit.
        v.restQuat.copy(v.orient);
      } else {
        v.orient.copy(this.stuckPose(v, f));
        v.restQuat.copy(v.orient);
      }
    }
  }

  /** Live orientation as a pure function of age (identical for a predicted throw and its server twin). */
  private flightOrientation(v: Visual, f: ProjectileFrame, out: THREE.Quaternion): void {
    if (v.kind === "spear") {
      this.tmpV.set(f.vx, f.vy, f.vz);
      if (this.tmpV.lengthSq() > 1e-6) {
        this.tmpV.normalize();
        out.setFromUnitVectors(UP, this.tmpV);
        // Slow roll around its own axis so the point catches the light.
        this.tmpQ.setFromAxisAngle(UP, f.age * 4 + v.phase);
        out.multiply(this.tmpQ);
      }
      return;
    }
    const rate = SPIN_RATE[v.kind] ?? DEFAULT_SPIN;
    out.setFromAxisAngle(v.axis, f.age * rate + v.phase);
    if (v.kind === "fish_raw" || v.kind === "fish_golden") {
      // Floppy fish: a side-to-side flap on top of the tumble.
      this.tmpQ.setFromAxisAngle(UP, Math.sin(f.age * 22) * 0.5);
      out.multiply(this.tmpQ);
    }
    out.premultiply(this.tmpQ2.copy(v.base));
  }

  private looseOrientation(v: Visual, f: ProjectileFrame, dt: number): void {
    const hs = Math.hypot(f.vx, f.vz);
    if (ROUND.has(v.kind)) {
      if (hs < 1e-3) return;
      // Roll: axis = up × velocity, angle = distance / radius.
      this.tmpV.set(f.vx / hs, 0, f.vz / hs);
      this.tmpV2.crossVectors(UP, this.tmpV).normalize();
      this.tmpQ.setFromAxisAngle(this.tmpV2, (hs * dt) / Math.max(0.08, f.radius));
      v.orient.premultiply(this.tmpQ);
      return;
    }
    const rate = (SPIN_RATE[v.kind] ?? DEFAULT_SPIN) * Math.min(1, Math.hypot(f.vx, f.vy, f.vz) / 8);
    if (rate < 1e-3) return;
    this.tmpQ.setFromAxisAngle(v.axis, rate * dt);
    v.orient.multiply(this.tmpQ);
  }

  /** A spear seen already stuck: leaning ~30° off vertical, point down. */
  private stuckPose(v: Visual, f: ProjectileFrame): THREE.Quaternion {
    const yaw = idHash(f.id, 6) * Math.PI * 2;
    this.tmpV.set(Math.sin(yaw) * 0.5, -0.87, Math.cos(yaw) * 0.5).normalize();
    return this.tmpQ.setFromUnitVectors(UP, this.tmpV).multiply(this.tmpQ2.copy(v.base));
  }

  /** Vertical offset (from the projectile center) that puts the lying item's lowest point on the ground. */
  private restLiftFor(kind: ItemKind): number {
    const hit = this.restLiftCache.get(kind);
    if (hit !== undefined) return hit;
    const probe = buildItemMesh(kind) as THREE.Mesh;
    restPoseFor(kind, this.tmpQ.identity(), probe.quaternion);
    probe.updateMatrixWorld(true);
    this.box.setFromBufferAttribute(probe.geometry.getAttribute("position") as THREE.BufferAttribute);
    this.box.applyMatrix4(probe.matrixWorld);
    // The sim keeps the center `radius` above the ground; the lying mesh needs `-box.min.y`.
    const lift = -this.box.min.y - (itemInfo(probe)?.radius ?? 0.2);
    this.restLiftCache.set(kind, lift);
    this.returnItem(kind, probe);
    return lift;
  }

  private updateGlow(v: Visual, f: ProjectileFrame): void {
    const pickup = f.state === "rest" || f.state === "stuck";
    if (!pickup && !f.bait) return;
    const golden = v.kind === "fish_golden";
    this.haloColor.set(f.bait ? BAIT_HALO_COLOR : golden ? GOLD_HALO_COLOR : HALO_COLOR);
    const pulse = 0.5 + 0.5 * Math.sin(this.time * (f.bait ? 6 : 2.6) + v.phase);
    const alpha = (f.bait ? 0.45 : 0.2 + 0.16 * pulse) * f.opacity * v.restBlend;
    if (alpha > 0.01) {
      const r = Math.max(0.14, f.radius) * HALO_SCALE * (0.9 + 0.15 * pulse);
      const p = v.root.position;
      this.halos.push(p.x, p.y, p.z, r, r, 0, this.haloColor, alpha, FULL_UV, BILLBOARD_FACING);
    }
    if (f.bait) this.particles.emit(`smell:${v.id}`, "smell", v.root.position);
    else if (pickup) this.particles.emit(`glint:${v.id}`, "glint", v.root.position, { color: golden ? "#FFD166" : undefined, scale: Math.max(0.6, f.radius * 5) });
  }

  /** Trail through the drawn position (x, y, z): the frame's plus any hand-off offset, bob excluded. */
  private updateTrail(v: Visual, f: ProjectileFrame, dt: number, speed: number, x: number, y: number, z: number): void {
    if (f.state === "live" && speed > TRAIL_MIN_SPEED) {
      v.trail.record(dt, x, y, z);
      v.trail.setStyle(this.white, Math.max(0.1, f.radius * 0.9), 0.5 * f.opacity * Math.min(1, (speed - TRAIL_MIN_SPEED) / 8 + 0.4));
    } else {
      v.trail.record(dt, x, y, z);
    }
    v.trail.rebuild(x, y, z);
  }

  /** Fade a visual's item (clones its materials on first use, restores the shared ones at full opacity). */
  private updateFade(v: Visual, opacity: number): void {
    const o = Math.min(1, Math.max(0, opacity));
    if (o >= 0.999) {
      if (v.fade) this.restoreMaterials(v);
      return;
    }
    if (!v.fade) {
      const fade: FadeState = { originals: [], clones: [], opacity: 1 };
      v.item.traverse((obj) => {
        if (!(obj instanceof THREE.Mesh)) return;
        const clone = (obj.material as THREE.Material).clone();
        clone.transparent = true;
        clone.depthWrite = false;
        fade.originals.push([obj, obj.material]);
        fade.clones.push(clone);
        obj.material = clone;
      });
      v.fade = fade;
    }
    if (Math.abs(v.fade.opacity - o) < 0.005) return;
    v.fade.opacity = o;
    for (const m of v.fade.clones) {
      if (m instanceof THREE.ShaderMaterial && m.uniforms.opacity) m.uniforms.opacity.value = o;
      else m.opacity = o;
    }
  }

  private restoreMaterials(v: Visual): void {
    if (!v.fade) return;
    for (const [mesh, material] of v.fade.originals) mesh.material = material;
    for (const m of v.fade.clones) m.dispose();
    v.fade = null;
  }
}
