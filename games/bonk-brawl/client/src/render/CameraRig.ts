// Over-the-shoulder camera, spectator ghost cam, KO cut, shake, FOV zoom. Owner: client-render.

import * as THREE from "three";
import {
  CAMERA_COLLISION_RADIUS,
  CAMERA_FOV,
  CAMERA_FOV_CHARGE,
  CAMERA_FOV_MAX,
  CAMERA_FOV_MIN,
  CAMERA_OFFSET_BACK,
  CAMERA_OFFSET_RIGHT,
  CAMERA_OFFSET_UP,
  GHOST_CAMERA_MAX_Y,
  GHOST_CAMERA_MIN_Y,
  GHOST_CAMERA_SPEED,
  PITCH_LIMIT,
} from "../../../shared/constants";
import type { FloorQuery } from "../../../shared/sim/context";
import { clamp, smoothFactor, TAU } from "../../../shared/sim/math";
import type { Vec3Like } from "../../../shared/types";
import { CameraShake } from "./camera/CameraShake";
import { rayClearance, sphereCastDistance } from "./camera/collision";

export type CameraMode = "follow" | "ghost" | "orbit";

export interface CameraUpdate {
  mode: CameraMode;
  /** follow: local player feet position + look (yaw/pitch from Input). */
  target?: { x: number; y: number; z: number; yaw: number; pitch: number };
  /** 0..1 charge: FOV lerps from base FOV to base × CAMERA_FOV_CHARGE / CAMERA_FOV. */
  charge: number;
  /** ghost: free-fly move (Input.ghostMove()) and look. */
  ghostMove?: Vec3Like;
  ghostLook?: { yaw: number; pitch: number };
  /** orbit: point to slowly circle (menu backdrop, round-end, match-end). */
  orbitCenter?: Vec3Like;
}

/* ---------------------------------------------------------------- tuning */

/** Closest the follow camera gets to the shoulder pivot when backed into cover (near plane stays clear). */
const MIN_FOLLOW_DIST = 0.25;
/** Collision pulls the camera in instantly; it eases back out with this time constant. */
const COLLISION_RELEASE_TAU = 0.22;
const FOV_TAU = 0.12;
/** Smooth hand-over between modes (follow → ghost, KO cut → follow, ...). */
const BLEND_SEC = 0.5;
/** If update() wasn't called for this long (menu backdrop owned the camera), snap instead of blending. */
const SNAP_GAP_MS = 250;
const MAX_DT = 0.1;

const GHOST_ACCEL_TAU = 0.18;
const GHOST_MAX_RADIUS = 25;
const GHOST_BOB = 0.06;
const GHOST_DEFAULT_PITCH = -0.35;

const ORBIT_RADIUS = 8.5;
const ORBIT_HEIGHT = 3.6;
const ORBIT_LOOK_UP = 1.0;
const ORBIT_SPEED = TAU / 40;

/** KO cut: low side angle, slow dolly in and a small sweep around the KO point. */
const KO_DIST_START = 4.4;
const KO_DIST_END = 3.3;
const KO_HEIGHT = 0.7;
const KO_LOOK_UP = 0.9;
const KO_SWEEP = 0.35;
const KO_FOV_SCALE = 0.85;

const UP = new THREE.Vector3(0, 1, 0);

interface Pose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

function makePose(): Pose {
  return { position: new THREE.Vector3(), quaternion: new THREE.Quaternion() };
}

function smoothstep01(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * follow (game1.md §11): pivot = feet + (0, CAMERA_OFFSET_UP, 0) + right(yaw) * CAMERA_OFFSET_RIGHT;
 * camera = pivot - aimDirection(yaw, pitch) * CAMERA_OFFSET_BACK; looks along aimDirection, so
 * the screen-center crosshair matches the throw aim (camera.rotation.set(pitch, yaw, 0, "YXZ")
 * looks exactly along aimDirection with the shared yaw convention). Cover collision: raycastWorld from pivot
 * toward the desired camera position; place the camera at hit distance - CAMERA_COLLISION_RADIUS
 * (min 0.6 m) and ease back out smoothly. Position is NOT smoothed against the player (prediction
 * already smooths), only the collision distance and FOV are eased.
 * ghost: free fly at GHOST_CAMERA_SPEED, y clamped GHOST_CAMERA_MIN_Y..MAX_Y, within 25 m of the center.
 * koCut(): for KO_CUT_SEC (scaled by real time, not slow-mo) look at the KO point from a dramatic
 * low side angle, then return to the current mode.
 * shake(): additive decaying noise offset (trauma model), independent of mode.
 *
 * Implementation notes: collision is a 5-ray sphere cast (radius CAMERA_COLLISION_RADIUS) against
 * the shared cover/floor shapes, and the shoulder offset itself shrinks when cover is right next
 * to the player, so the pivot never starts inside cover. The minimum distance is 0.25 m instead of
 * 0.6 m so the camera never clips into cover when the player backs into it (GameController hides
 * the local animal when the camera gets that close). Mode changes blend over 0.5 s; the KO cut is
 * a hard cut in and a blend out.
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  private floor: FloorQuery | null = null;
  private baseFov = CAMERA_FOV;
  private fov = CAMERA_FOV;
  private mode: CameraMode | null = null;
  private lastUpdateMs = 0;

  /** Pose computed this frame before blending and shake. */
  private readonly pose = makePose();
  /** Final pose of the previous frame before shake (blend start). */
  private readonly shown = makePose();
  private readonly blendFrom = makePose();
  private blendLeft = 0;

  private followDist = CAMERA_OFFSET_BACK;
  private shoulder = CAMERA_OFFSET_RIGHT;

  private readonly ghostPos = new THREE.Vector3(0, 9, 16);
  private readonly ghostVel = new THREE.Vector3();
  private ghostYaw = 0;
  private ghostEntered = false;
  private ghostTime = 0;

  private orbitAngle = 0;

  private koLeft = 0;
  private koDuration = 1;
  private readonly koPoint = new THREE.Vector3();
  private readonly koSide = new THREE.Vector3(1, 0, 0);

  private readonly shaker = new CameraShake();

  private readonly v1 = new THREE.Vector3();
  private readonly v2 = new THREE.Vector3();
  private readonly v3 = new THREE.Vector3();
  private readonly euler = new THREE.Euler(0, 0, 0, "YXZ");
  private readonly lookMatrix = new THREE.Matrix4();

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.shown.position.copy(camera.position);
    this.shown.quaternion.copy(camera.quaternion);
  }

  /** Arena + rings for cover collision (null disables collision). */
  setFloorQuery(q: FloorQuery | null): void {
    this.floor = q;
  }

  /** User FOV setting in degrees. */
  setBaseFov(deg: number): void {
    this.baseFov = clamp(Number.isFinite(deg) ? deg : CAMERA_FOV, CAMERA_FOV_MIN, CAMERA_FOV_MAX);
  }

  /** Start the ghost camera from this position (on the local player's KO / when spectating). */
  enterGhost(from: Vec3Like, yaw: number): void {
    this.ghostPos.set(from.x, from.y, from.z);
    this.clampGhost();
    this.ghostVel.set(0, 0, 0);
    this.ghostYaw = yaw;
    this.ghostEntered = true;
    if (this.mode === "ghost") this.startBlend();
  }

  update(realDt: number, u: CameraUpdate): void {
    const dt = clamp(Number.isFinite(realDt) ? realDt : 0, 0, MAX_DT);
    const now = performance.now();
    const resumed = this.lastUpdateMs > 0 && now - this.lastUpdateMs > SNAP_GAP_MS;
    const first = this.lastUpdateMs === 0;
    this.lastUpdateMs = now;
    if (resumed || first) this.resetEasing();
    if (u.mode !== this.mode) this.changeMode(u, resumed || first);

    this.computeModePose(u, dt);
    if (this.koLeft > 0) this.updateKoCut(dt);
    this.applyBlend(dt);
    this.updateFov(u, dt);

    this.shown.position.copy(this.camera.position);
    this.shown.quaternion.copy(this.camera.quaternion);
    this.shaker.update(dt);
    this.shaker.apply(this.camera);
    this.camera.updateMatrixWorld();
  }

  /** Screen shake. intensity 0..1 (0.3 = victim of a normal hit, 0.6 = mega/shockwave). */
  shake(intensity: number, durationSec: number): void {
    this.shaker.add(intensity, durationSec);
  }

  /** Cut to a KO point for durationSec (final KO of a round). */
  koCut(pos: Vec3Like, durationSec: number): void {
    if (!(durationSec > 0)) return;
    this.koPoint.set(pos.x, Math.max(pos.y, -1), pos.z);
    this.koDuration = durationSec;
    this.koLeft = durationSec;
    this.blendLeft = 0;
    this.chooseKoSide();
  }

  get cutting(): boolean {
    return this.koLeft > 0;
  }

  /* ------------------------------------------------------------- modes */

  private changeMode(u: CameraUpdate, snap: boolean): void {
    const previous = this.mode;
    this.mode = u.mode;
    if (u.mode === "orbit") {
      const c = u.orbitCenter;
      const dx = this.shown.position.x - (c?.x ?? 0);
      const dz = this.shown.position.z - (c?.z ?? 0);
      if (dx * dx + dz * dz > 1e-4) this.orbitAngle = Math.atan2(dx, dz);
    }
    if (u.mode === "ghost" && !this.ghostEntered) {
      // Ghost without enterGhost (shouldn't happen, but never jump to a stale spot).
      this.ghostPos.copy(this.shown.position);
      this.clampGhost();
      this.ghostEntered = true;
    }
    if (u.mode !== "ghost") this.ghostEntered = false;
    if (previous !== null && !snap) this.startBlend();
  }

  private computeModePose(u: CameraUpdate, dt: number): void {
    switch (u.mode) {
      case "follow":
        if (u.target) this.followPose(u.target, dt);
        else this.holdPose();
        return;
      case "ghost":
        this.ghostPose(u, dt);
        return;
      case "orbit":
        this.orbitPose(u.orbitCenter, dt);
        return;
    }
  }

  private holdPose(): void {
    this.pose.position.copy(this.shown.position);
    this.pose.quaternion.copy(this.shown.quaternion);
  }

  private followPose(t: NonNullable<CameraUpdate["target"]>, dt: number): void {
    const yaw = t.yaw;
    const pitch = clamp(t.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    const head = this.v1.set(t.x, t.y + CAMERA_OFFSET_UP, t.z);
    const right = this.v2.set(Math.cos(yaw), 0, -Math.sin(yaw));

    // Shoulder offset shrinks if cover sits right next to the player's head.
    const shoulderRoom = this.floor
      ? rayClearance(this.floor, head, right, CAMERA_OFFSET_RIGHT, CAMERA_COLLISION_RADIUS)
      : CAMERA_OFFSET_RIGHT;
    this.shoulder = this.easeDistance(this.shoulder, shoulderRoom, dt);
    const pivot = head.addScaledVector(right, this.shoulder);

    // back = -aimDirection(yaw, pitch)
    const cp = Math.cos(pitch);
    const back = this.v3.set(Math.sin(yaw) * cp, -Math.sin(pitch), Math.cos(yaw) * cp);
    const room = this.floor
      ? Math.max(MIN_FOLLOW_DIST, sphereCastDistance(this.floor, pivot, back, CAMERA_OFFSET_BACK, CAMERA_COLLISION_RADIUS))
      : CAMERA_OFFSET_BACK;
    this.followDist = this.easeDistance(this.followDist, room, dt);

    this.pose.position.copy(pivot).addScaledVector(back, this.followDist);
    this.pose.quaternion.setFromEuler(this.euler.set(pitch, yaw, 0, "YXZ"));
  }

  /** Pull in instantly (never clip), let out smoothly. */
  private easeDistance(current: number, target: number, dt: number): number {
    if (target <= current) return target;
    return current + (target - current) * smoothFactor(dt, COLLISION_RELEASE_TAU);
  }

  private ghostPose(u: CameraUpdate, dt: number): void {
    const yaw = u.ghostLook?.yaw ?? this.ghostYaw;
    const pitch = clamp(u.ghostLook?.pitch ?? GHOST_DEFAULT_PITCH, -PITCH_LIMIT, PITCH_LIMIT);
    this.ghostYaw = yaw;
    const move = u.ghostMove;
    const wish = this.v1.set(0, 0, 0);
    if (move) {
      // x = strafe right, z = forward (flat, camera yaw), y = up/down.
      const fx = -Math.sin(yaw);
      const fz = -Math.cos(yaw);
      wish.set(Math.cos(yaw) * move.x + fx * move.z, 0, -Math.sin(yaw) * move.x + fz * move.z);
      if (wish.lengthSq() > 1) wish.normalize();
      wish.y = clamp(move.y, -1, 1);
      wish.multiplyScalar(GHOST_CAMERA_SPEED);
    }
    this.ghostVel.lerp(wish, smoothFactor(dt, GHOST_ACCEL_TAU));
    this.ghostPos.addScaledVector(this.ghostVel, dt);
    this.clampGhost();
    this.ghostTime += dt;

    this.pose.position.copy(this.ghostPos);
    this.pose.position.y += Math.sin(this.ghostTime * 1.6) * GHOST_BOB;
    this.pose.quaternion.setFromEuler(this.euler.set(pitch, yaw, 0, "YXZ"));
  }

  private clampGhost(): void {
    const p = this.ghostPos;
    p.y = clamp(p.y, GHOST_CAMERA_MIN_Y, GHOST_CAMERA_MAX_Y);
    const r = Math.hypot(p.x, p.z);
    if (r > GHOST_MAX_RADIUS) {
      const k = GHOST_MAX_RADIUS / r;
      p.x *= k;
      p.z *= k;
      // Kill outward velocity so pushing against the bound doesn't feel sticky.
      const outward = (this.ghostVel.x * p.x + this.ghostVel.z * p.z) / GHOST_MAX_RADIUS;
      if (outward > 0) {
        this.ghostVel.x -= (p.x / GHOST_MAX_RADIUS) * outward;
        this.ghostVel.z -= (p.z / GHOST_MAX_RADIUS) * outward;
      }
    }
  }

  private orbitPose(center: Vec3Like | undefined, dt: number): void {
    this.orbitAngle += ORBIT_SPEED * dt;
    const cx = center?.x ?? 0;
    const cy = center?.y ?? 0;
    const cz = center?.z ?? 0;
    const a = this.orbitAngle;
    this.pose.position.set(cx + Math.sin(a) * ORBIT_RADIUS, Math.max(cy, 0) + ORBIT_HEIGHT, cz + Math.cos(a) * ORBIT_RADIUS);
    this.lookAt(this.v1.set(cx, Math.max(cy, 0) + ORBIT_LOOK_UP, cz));
  }

  /** pose.quaternion looking from pose.position at `target`. */
  private lookAt(target: THREE.Vector3): void {
    this.lookMatrix.lookAt(this.pose.position, target, UP);
    this.pose.quaternion.setFromRotationMatrix(this.lookMatrix);
  }

  /* ------------------------------------------------------------ KO cut */

  /** Side of the KO point to film from: perpendicular to the current view, preferring open space over the island. */
  private chooseKoSide(): void {
    const forward = this.v1.set(0, 0, -1).applyQuaternion(this.shown.quaternion);
    forward.y = 0;
    if (forward.lengthSq() < 1e-6) forward.set(0, 0, -1);
    forward.normalize();
    const eye = this.v2.copy(this.koPoint).setY(this.koPoint.y + KO_HEIGHT);
    let bestScore = -Infinity;
    for (const sign of [1, -1]) {
      const side = this.v3.set(forward.z * sign, 0, -forward.x * sign);
      const room = this.floor ? rayClearance(this.floor, eye, side, KO_DIST_START, CAMERA_COLLISION_RADIUS) : KO_DIST_START;
      const end = this.koPoint.clone().addScaledVector(side, KO_DIST_START);
      // Prefer the unobstructed side, then the one that keeps the island (not the void) behind the shot.
      const score = room * 10 - Math.hypot(end.x, end.z) * 0.1;
      if (score > bestScore) {
        bestScore = score;
        this.koSide.copy(side);
      }
    }
  }

  private updateKoCut(dt: number): void {
    this.koLeft = Math.max(0, this.koLeft - dt);
    const t = 1 - this.koLeft / this.koDuration;
    const ease = 1 - (1 - t) * (1 - t);
    const side = this.v2.copy(this.koSide).applyAxisAngle(UP, (t - 0.5) * KO_SWEEP);
    const wanted = KO_DIST_START + (KO_DIST_END - KO_DIST_START) * ease;
    // Cast at the camera's own (low) height so table tops etc. can't swallow it.
    const eye = this.v1.copy(this.koPoint).setY(this.koPoint.y + KO_HEIGHT);
    const room = this.floor
      ? Math.max(MIN_FOLLOW_DIST, rayClearance(this.floor, eye, side, wanted, CAMERA_COLLISION_RADIUS))
      : wanted;
    this.pose.position.copy(eye).addScaledVector(side, room);
    this.lookAt(this.v1.copy(this.koPoint).setY(this.koPoint.y + KO_LOOK_UP));
    // Last KO frame: blend from it back into the live mode (applyBlend shows it this frame).
    if (this.koLeft === 0) this.startBlendFrom(this.pose);
  }

  /* ------------------------------------------------------- blend + fov */

  private startBlend(): void {
    this.startBlendFrom(this.shown);
  }

  private startBlendFrom(pose: Pose): void {
    this.blendFrom.position.copy(pose.position);
    this.blendFrom.quaternion.copy(pose.quaternion);
    this.blendLeft = BLEND_SEC;
  }

  private applyBlend(dt: number): void {
    if (this.koLeft > 0 || this.blendLeft <= 0) {
      this.camera.position.copy(this.pose.position);
      this.camera.quaternion.copy(this.pose.quaternion);
      return;
    }
    this.blendLeft = Math.max(0, this.blendLeft - dt);
    const k = smoothstep01(1 - this.blendLeft / BLEND_SEC);
    this.camera.position.copy(this.blendFrom.position).lerp(this.pose.position, k);
    this.camera.quaternion.copy(this.blendFrom.quaternion).slerp(this.pose.quaternion, k);
  }

  private updateFov(u: CameraUpdate, dt: number): void {
    let target = this.baseFov;
    if (this.koLeft > 0) target = this.baseFov * KO_FOV_SCALE;
    else if (u.mode === "follow") target = this.baseFov * (1 + (CAMERA_FOV_CHARGE / CAMERA_FOV - 1) * clamp(u.charge, 0, 1));
    this.fov += (target - this.fov) * smoothFactor(dt, FOV_TAU);
    if (Math.abs(this.camera.fov - this.fov) > 1e-3) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }

  private resetEasing(): void {
    this.followDist = CAMERA_OFFSET_BACK;
    this.shoulder = CAMERA_OFFSET_RIGHT;
    this.fov = this.baseFov;
    this.blendLeft = 0;
    this.shaker.reset();
  }
}
