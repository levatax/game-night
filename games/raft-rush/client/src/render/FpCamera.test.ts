// FpCamera: FOV (sprint / charge / punch), head-bob, recoil, downed view and orbit (game4.md §16). Owner:
// client-render.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAMERA_FOV, CAMERA_FOV_SPRINT, SPRINT_SPEED, WALK_SPEED } from "../../../shared/constants";
import { FpCamera } from "./FpCamera";
import type { CameraFrame } from "./types";

function frame(patch: Partial<CameraFrame> = {}): CameraFrame {
  return {
    eye: { x: 0, y: 1.55, z: 0 },
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
    ...patch,
  };
}

function run(fp: FpCamera, f: CameraFrame, sec: number): void {
  for (let t = 0; t < sec; t += 1 / 60) fp.update(1 / 60, f);
}

describe("FpCamera", () => {
  it("sits at the eye looking along yaw / pitch at rest", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    run(fp, frame({ yaw: 0.5, pitch: -0.2 }), 0.5);
    expect(cam.position.x).toBeCloseTo(0, 3);
    expect(cam.position.y).toBeCloseTo(1.55, 3);
    expect(cam.rotation.y).toBeCloseTo(0.5, 3);
    expect(cam.rotation.x).toBeCloseTo(-0.2, 3);
    expect(cam.fov).toBeCloseTo(CAMERA_FOV, 1);
  });

  it("widens the FOV by +5 while sprinting and zooms in while charging", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    run(fp, frame({ sprinting: true, speed: SPRINT_SPEED }), 1.5);
    expect(cam.fov).toBeCloseTo(CAMERA_FOV + CAMERA_FOV_SPRINT, 0);
    run(fp, frame({ charge: 1 }), 1.5);
    expect(cam.fov).toBeLessThan(CAMERA_FOV - 3);
  });

  it("head-bobs with speed only when enabled", () => {
    const camA = new THREE.PerspectiveCamera();
    const bob = new FpCamera(camA);
    let minY = Infinity;
    for (let t = 0; t < 2; t += 1 / 60) {
      bob.update(1 / 60, frame({ speed: WALK_SPEED }));
      minY = Math.min(minY, camA.position.y);
    }
    expect(minY).toBeLessThan(1.55 - 0.02);
    const camB = new THREE.PerspectiveCamera();
    const still = new FpCamera(camB);
    let maxDev = 0;
    for (let t = 0; t < 2; t += 1 / 60) {
      still.update(1 / 60, frame({ speed: WALK_SPEED, headBob: false }));
      maxDev = Math.max(maxDev, Math.abs(camB.position.y - 1.55));
    }
    expect(maxDev).toBeLessThan(1e-6);
  });

  it("recoil kicks the view up and settles back", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    run(fp, frame(), 0.2);
    fp.recoil(1);
    fp.update(1 / 60, frame());
    fp.update(1 / 60, frame());
    expect(cam.rotation.x).toBeGreaterThan(0.005);
    run(fp, frame(), 1.5);
    expect(Math.abs(cam.rotation.x)).toBeLessThan(0.002);
  });

  it("punch narrows the FOV briefly", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    run(fp, frame(), 0.5);
    fp.punch(1);
    run(fp, frame(), 0.12);
    expect(cam.fov).toBeLessThan(CAMERA_FOV - 2);
    run(fp, frame(), 2);
    expect(cam.fov).toBeCloseTo(CAMERA_FOV, 0);
  });

  it("downed: tilted and desaturated; recovers when revived", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    run(fp, frame({ downed: true, eye: { x: 0, y: 0.45, z: 0 } }), 2);
    expect(fp.desaturation).toBeGreaterThan(0.5);
    expect(Math.abs(cam.rotation.z)).toBeGreaterThan(0.15);
    run(fp, frame(), 3);
    expect(fp.desaturation).toBeLessThan(0.02);
  });

  it("spectating orbits above the camp", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    fp.setSpectateCenter({ x: 10, y: 1, z: -5 });
    run(fp, frame({ spectate: true }), 4);
    expect(cam.position.y).toBeGreaterThan(8);
    expect(Math.hypot(cam.position.x - 10, cam.position.z + 5)).toBeGreaterThan(10);
  });

  it("spectating keeps the default framing: 16 m out, 10 m up, drifting slowly", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    fp.setSpectateCenter({ x: 0, y: 0, z: 0 });
    run(fp, frame({ spectate: true }), 6);
    expect(cam.position.y).toBeCloseTo(10, 1);
    expect(Math.hypot(cam.position.x, cam.position.z)).toBeCloseTo(16, 1);
    const a = Math.atan2(cam.position.x, cam.position.z);
    run(fp, frame({ spectate: true }), 1);
    expect(Math.atan2(cam.position.x, cam.position.z)).toBeGreaterThan(a);
  });

  it("steerSpectate turns the orbit like mouse look, clamps the elevation and stops the drift", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    fp.setSpectateCenter({ x: 0, y: 0, z: 0 });
    run(fp, frame({ spectate: true }), 6);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    const yawBefore = Math.atan2(-dir.x, -dir.z);
    fp.steerSpectate(-0.5, 0); // mouse right: the view turns right (yaw decreases)
    run(fp, frame({ spectate: true }), 0.1);
    cam.getWorldDirection(dir);
    const yawAfter = Math.atan2(-dir.x, -dir.z);
    expect(yawAfter - yawBefore).toBeCloseTo(-0.5, 1);
    // No more drift once steered.
    const settled = cam.position.clone();
    run(fp, frame({ spectate: true }), 2);
    expect(cam.position.distanceTo(settled)).toBeLessThan(1e-3);
    // Looking down raises the camera, up to the clamp; looking up lowers it to just above the sand.
    fp.steerSpectate(0, -10);
    run(fp, frame({ spectate: true }), 0.1);
    expect(cam.position.y).toBeGreaterThan(18);
    expect(cam.position.y).toBeLessThan(Math.hypot(16, 10));
    fp.steerSpectate(0, 10);
    run(fp, frame({ spectate: true }), 0.1);
    expect(cam.position.y).toBeGreaterThan(1);
    expect(cam.position.y).toBeLessThan(3.5);
  });

  it("eases to a closer follow distance and resetSpectate brings the camp framing back", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    fp.setSpectateCenter({ x: 5, y: 1, z: 5 }, 8);
    run(fp, frame({ spectate: true }), 4);
    expect(cam.position.distanceTo(new THREE.Vector3(5, 1, 5))).toBeCloseTo(8, 0);
    fp.steerSpectate(0.3, -0.4);
    fp.resetSpectate();
    run(fp, frame({ spectate: true }), 4);
    expect(cam.position.distanceTo(new THREE.Vector3(5, 1, 5))).toBeCloseTo(Math.hypot(16, 10), 0);
    expect(cam.position.y - 1).toBeCloseTo(10, 0);
  });

  it("orbit() places the camera around a center and looks at it", () => {
    const cam = new THREE.PerspectiveCamera();
    const fp = new FpCamera(cam);
    fp.orbit({ x: 0, y: 0, z: 0 }, 20, 10, 0);
    expect(cam.position.z).toBeCloseTo(20, 5);
    expect(cam.position.y).toBeCloseTo(10, 5);
    const dir = new THREE.Vector3();
    cam.getWorldDirection(dir);
    expect(dir.z).toBeLessThan(0);
  });

  it("shake moves the camera and is toned down by reduced flashing", () => {
    const camA = new THREE.PerspectiveCamera();
    const a = new FpCamera(camA);
    const camB = new THREE.PerspectiveCamera();
    const b = new FpCamera(camB);
    b.reducedFlashing = true;
    let devA = 0;
    let devB = 0;
    a.shake(1);
    b.shake(1);
    for (let t = 0; t < 0.3; t += 1 / 60) {
      a.update(1 / 60, frame({ headBob: false }));
      b.update(1 / 60, frame({ headBob: false }));
      devA = Math.max(devA, camA.position.distanceTo(new THREE.Vector3(0, 1.55, 0)));
      devB = Math.max(devB, camB.position.distanceTo(new THREE.Vector3(0, 1.55, 0)));
    }
    expect(devA).toBeGreaterThan(0.01);
    expect(devB).toBeLessThan(devA * 0.5);
  });
});
