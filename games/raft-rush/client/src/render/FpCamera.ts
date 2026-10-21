// First-person camera rig (game4.md §16): FOV 75° (+5 sprinting, slight zoom while charging, punch-in on a
// catch / golden fish), speed-based head-bob with a landing dip (settings.headBob), throw recoil, trauma
// shake (toned down by reduced flashing), a low tilted + desaturated view while downed, the spectator orbit
// (washed ashore / mid-match joiners: slowly circles the camp until steered with steerSpectate(); the app moves
// its center and distance to follow a teammate), and an explicit orbit for menus / the podium. Owner:
// client-render. Renderer.ts re-exports FpCamera (its public members are part of the frozen Renderer facade).

import * as THREE from "three";
import { CAMERA_FOV, CAMERA_FOV_SPRINT, HEAD_BOB_AMPLITUDE, HEAD_BOB_HZ, WALK_SPEED } from "../../../shared/constants";
import { CameraShake } from "./CameraShake";
import { smoothing } from "./noise";
import type { CameraFrame } from "./types";

/** FOV degrees removed at full charge and by a punch of 1. */
const CHARGE_ZOOM = 5;
const PUNCH_ZOOM = 9;
/** Recoil: pitch kick (rad) and backward push (m) per unit, spring stiffness. */
const RECOIL_PITCH = 0.045;
const RECOIL_PUSH = 0.06;
const RECOIL_RATE = 14;
/** Downed view. */
const DOWNED_ROLL = 0.24;
const DOWNED_DESAT = 0.6;
/** Spectator orbit over the camp (16 m out, 10 m up by default). */
const SPECTATE_RADIUS = 16;
const SPECTATE_HEIGHT = 10;
export const SPECTATE_DISTANCE = Math.hypot(SPECTATE_RADIUS, SPECTATE_HEIGHT);
const SPECTATE_ELEVATION = Math.atan2(SPECTATE_HEIGHT, SPECTATE_RADIUS);
/** Steering limits: from just above the sand to almost straight down (rad above the horizon). */
const SPECTATE_ELEVATION_MIN = 0.12;
const SPECTATE_ELEVATION_MAX = 1.3;
const SPECTATE_SPEED = 0.07;
const SPECTATE_BLEND_RATE = 2.5;
/** How fast the orbit distance eases to a new target (1/s). */
const SPECTATE_ZOOM_RATE = 3;

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const euler = new THREE.Euler(0, 0, 0, "YXZ");
const lookM = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

/** First-person camera rig: head-bob, FOV, shake, recoil (owned by the renderer). */
export class FpCamera {
  /** Reduced flashing (§17): shake ×0.3. Renderer sets it from WorldFrame.reducedFlashing. */
  reducedFlashing = false;

  private readonly shaker = new CameraShake();
  private time = 0;
  private fov = CAMERA_FOV;
  private baseFov = CAMERA_FOV;
  private punchAmt = 0;
  private recoilPitch = 0;
  private recoilPush = 0;
  private recoilVel = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private landDip = 0;
  private lastEyeY = Number.NaN;
  private eyeVy = 0;
  private wasGrounded = true;
  private roll = 0;
  private desat = 0;
  private spectateW = 0;
  private readonly spectateCenter = new THREE.Vector3();
  /** Spectator orbit: angle around the center (= the view yaw), elevation, distance (eased to its target). */
  private spectateAngle = 0;
  private spectateElevation = SPECTATE_ELEVATION;
  private spectateDist = SPECTATE_DISTANCE;
  private spectateDistTarget = SPECTATE_DISTANCE;
  /** Steered by the viewer: the slow automatic drift stops. */
  private spectateSteered = false;
  private lastOrbitMs = 0;

  constructor(readonly camera: THREE.PerspectiveCamera) {
    camera.rotation.order = "YXZ";
  }

  /** The walk-bob phase (rad): the first-person arms bob on the same stride. */
  get walkPhase(): number {
    return this.bobPhase;
  }

  /** 0..1 how desaturated the view should be (downed). The renderer applies it as a canvas filter. */
  get desaturation(): number {
    return this.desat;
  }

  /**
   * Center of the spectator orbit (the camp; Renderer.loadIsland sets it) and how far out the camera sits
   * (default: the camp framing; a followed teammate is closer). The distance eases over; the center snaps, so
   * the caller glides it.
   */
  setSpectateCenter(center: { x: number; y: number; z: number }, distance = SPECTATE_DISTANCE): void {
    this.spectateCenter.set(center.x, center.y, center.z);
    if (Number.isFinite(distance) && distance > 0) this.spectateDistTarget = distance;
  }

  /**
   * Steer the spectator orbit with look deltas (rad, same signs as Input's yaw / pitch: mouse right turns the
   * view right, mouse up looks up). Elevation is clamped; the first steer stops the automatic drift.
   */
  steerSpectate(dYaw: number, dPitch: number): void {
    if (!Number.isFinite(dYaw) || !Number.isFinite(dPitch) || (dYaw === 0 && dPitch === 0)) return;
    this.spectateSteered = true;
    this.spectateAngle += dYaw;
    this.spectateElevation = Math.max(SPECTATE_ELEVATION_MIN, Math.min(SPECTATE_ELEVATION_MAX, this.spectateElevation - dPitch));
  }

  /** Back to the default framing (camp distance and height, drifting again); the angle carries on. */
  resetSpectate(): void {
    this.spectateSteered = false;
    this.spectateElevation = SPECTATE_ELEVATION;
    this.spectateDistTarget = SPECTATE_DISTANCE;
  }

  /** Per frame, before render(). */
  update(dt: number, frame: CameraFrame): void {
    const step = Math.max(0, Math.min(dt, 0.1));
    this.time += step;
    this.shaker.scale = this.reducedFlashing ? 0.3 : 1;
    this.shaker.update(step);
    this.baseFov = frame.fov;

    // --- FOV: sprint widen, charge zoom, punch.
    this.punchAmt *= Math.exp(-6 * step);
    const sprinting = frame.sprinting && frame.speed > WALK_SPEED * 0.85 && !frame.swimming && !frame.downed;
    const fovTarget = frame.fov + (sprinting ? CAMERA_FOV_SPRINT : 0) - frame.charge * CHARGE_ZOOM - this.punchAmt * PUNCH_ZOOM;
    this.fov += (fovTarget - this.fov) * smoothing(10, step);

    // --- Head-bob (speed based) + landing dip + swim bob.
    const eyeY = frame.eye.y;
    if (Number.isFinite(this.lastEyeY) && step > 0) this.eyeVy = (eyeY - this.lastEyeY) / step;
    this.lastEyeY = eyeY;
    const bobOn = frame.headBob && frame.grounded && !frame.swimming && !frame.downed && !frame.spectate;
    const speedK = Math.min(1.6, Math.max(0, frame.speed / WALK_SPEED));
    const ampTarget = bobOn ? HEAD_BOB_AMPLITUDE * speedK : 0;
    this.bobAmp += (ampTarget - this.bobAmp) * smoothing(8, step);
    this.bobPhase += step * HEAD_BOB_HZ * Math.PI * 2 * (0.7 + 0.3 * Math.max(0.6, speedK));
    if (frame.grounded && !this.wasGrounded && frame.headBob && !frame.swimming) {
      this.landDip = Math.min(0.12, Math.max(this.landDip, -this.eyeVy * 0.012));
    }
    this.wasGrounded = frame.grounded;
    this.landDip *= Math.exp(-9 * step);
    let bobY = ((Math.cos(this.bobPhase * 2) - 1) * 0.5) * this.bobAmp - this.landDip;
    let bobX = Math.sin(this.bobPhase) * this.bobAmp * 0.5;
    let bobRoll = Math.sin(this.bobPhase) * this.bobAmp * 0.25;
    if (frame.swimming && frame.headBob) {
      bobY += Math.sin(this.time * 1.4) * 0.05;
      bobX += Math.sin(this.time * 0.8) * 0.02;
      bobRoll += Math.sin(this.time * 0.9) * 0.02;
    }

    // --- Downed: low, tilted, desaturated.
    const rollTarget = frame.downed ? DOWNED_ROLL + Math.sin(this.time * 0.7) * 0.03 : 0;
    this.roll += (rollTarget - this.roll) * smoothing(4, step);
    this.desat += ((frame.downed ? DOWNED_DESAT : 0) - this.desat) * smoothing(3, step);

    // --- Recoil spring (critically damped back to 0).
    const accel = -RECOIL_RATE * RECOIL_RATE * this.recoilPitch - 2 * RECOIL_RATE * this.recoilVel;
    this.recoilVel += accel * step;
    this.recoilPitch += this.recoilVel * step;
    this.recoilPush *= Math.exp(-10 * step);

    // --- Eye pose.
    const cam = this.camera;
    euler.set(frame.pitch + this.recoilPitch, frame.yaw, this.roll + bobRoll, "YXZ");
    cam.quaternion.setFromEuler(euler);
    tmpV.set(bobX, bobY, this.recoilPush).applyQuaternion(tmpQ.setFromAxisAngle(UP, frame.yaw));
    cam.position.set(frame.eye.x + tmpV.x, frame.eye.y + tmpV.y, frame.eye.z + tmpV.z);

    // --- Spectator orbit blend (drifts SPECTATE_SPEED rad/s until steered).
    if (!this.spectateSteered) this.spectateAngle += SPECTATE_SPEED * step;
    this.spectateDist += (this.spectateDistTarget - this.spectateDist) * smoothing(SPECTATE_ZOOM_RATE, step);
    this.spectateW += ((frame.spectate ? 1 : 0) - this.spectateW) * smoothing(SPECTATE_BLEND_RATE, step);
    if (this.spectateW > 0.001) {
      const a = this.spectateAngle;
      const c = this.spectateCenter;
      const flat = Math.cos(this.spectateElevation) * this.spectateDist;
      tmpV2.set(c.x + Math.sin(a) * flat, c.y + Math.sin(this.spectateElevation) * this.spectateDist, c.z + Math.cos(a) * flat);
      lookM.lookAt(tmpV2, tmpV.set(c.x, c.y + 1, c.z), UP);
      tmpQ2.setFromRotationMatrix(lookM);
      cam.position.lerp(tmpV2, this.spectateW);
      cam.quaternion.slerp(tmpQ2, this.spectateW);
    }

    this.shaker.apply(cam);
    this.applyFov();
  }

  /** Screen shake impulse 0..1 (hits, blasts, thunder). */
  shake(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    this.shaker.add(a, 0.22 + a * 0.45);
  }

  /** Throw recoil kick (0..1 = charge). */
  recoil(amount: number): void {
    const a = Math.max(0, Math.min(1, amount));
    this.recoilVel += RECOIL_PITCH * (0.4 + a) * RECOIL_RATE;
    this.recoilPush = Math.max(this.recoilPush, RECOIL_PUSH * (0.3 + a));
  }

  /** Quick FOV punch-in (catch, golden fish). */
  punch(amount: number): void {
    this.punchAmt = Math.max(this.punchAmt, Math.max(0, Math.min(1.5, amount)));
  }

  /** Orbit target for menus / the podium (lobby island preview, match end). */
  orbit(center: { x: number; y: number; z: number }, radius: number, height: number, t: number): void {
    const now = typeof performance !== "undefined" ? performance.now() : 0;
    const dt = this.lastOrbitMs > 0 ? Math.min(0.1, (now - this.lastOrbitMs) / 1000) : 0;
    this.lastOrbitMs = now;
    this.shaker.update(dt);
    this.roll = 0;
    this.desat += (0 - this.desat) * smoothing(3, dt);
    this.fov += (this.baseFov - this.fov) * smoothing(4, dt);
    this.camera.position.set(center.x + Math.sin(t) * radius, center.y + height, center.z + Math.cos(t) * radius);
    this.camera.lookAt(center.x, center.y, center.z);
    this.shaker.apply(this.camera);
    this.applyFov();
  }

  private applyFov(): void {
    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
  }
}
