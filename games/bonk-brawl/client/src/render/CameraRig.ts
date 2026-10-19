// Over-the-shoulder camera, spectator ghost cam, KO cut, shake, FOV zoom. Owner: client-render.

import * as THREE from "three";
import type { FloorQuery } from "../../../shared/sim/context";
import type { Vec3Like } from "../../../shared/types";

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
 */
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;

  constructor(camera: THREE.PerspectiveCamera) {
    this.camera = camera;
  }

  /** Arena + rings for cover collision (null disables collision). */
  setFloorQuery(q: FloorQuery | null): void {
    void q;
  }

  /** User FOV setting in degrees. */
  setBaseFov(deg: number): void {
    void deg;
  }

  /** Start the ghost camera from this position (on the local player's KO / when spectating). */
  enterGhost(from: Vec3Like, yaw: number): void {
    void from;
    void yaw;
  }

  update(realDt: number, u: CameraUpdate): void {
    void realDt;
    void u;
  }

  /** Screen shake. intensity 0..1 (0.3 = victim of a normal hit, 0.6 = mega/shockwave). */
  shake(intensity: number, durationSec: number): void {
    void intensity;
    void durationSec;
  }

  /** Cut to a KO point for durationSec (final KO of a round). */
  koCut(pos: Vec3Like, durationSec: number): void {
    void pos;
    void durationSec;
  }

  get cutting(): boolean {
    return false;
  }
}
