// CameraRig kick springs, tumble follow and ring-out framing (node environment, no WebGL).
// Owner: client-render.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { CAMERA_FOV, CAMERA_OFFSET_BACK } from "../../../shared/constants";
import { CameraRig, type CameraUpdate } from "./CameraRig";

function rig() {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 600);
  const r = new CameraRig(camera);
  const target = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  const u: CameraUpdate = { mode: "follow", charge: 0, target };
  r.update(1 / 60, u);
  return { r, camera, u, target };
}

describe("CameraRig kicks", () => {
  it("an FOV kick peaks near the requested value and settles, at any frame rate", () => {
    for (const fps of [30, 60, 144]) {
      const { r, camera, u } = rig();
      r.kick({ fov: 6 });
      let peak = 0;
      for (let i = 0; i < fps; i++) {
        r.update(1 / fps, u);
        peak = Math.max(peak, camera.fov - CAMERA_FOV);
      }
      expect(peak).toBeGreaterThan(5.4);
      expect(peak).toBeLessThan(6.3);
      expect(Math.abs(camera.fov - CAMERA_FOV)).toBeLessThan(0.05);
    }
  });

  it("a dip lowers the camera briefly", () => {
    const { r, camera, u } = rig();
    const y0 = camera.position.y;
    r.kick({ dip: -0.1 });
    let low = y0;
    for (let i = 0; i < 20; i++) {
      r.update(1 / 60, u);
      low = Math.min(low, camera.position.y);
    }
    expect(y0 - low).toBeGreaterThan(0.08);
  });
});

describe("CameraRig tumble follow", () => {
  it("pulls back while tumbling and returns after", () => {
    const { r, camera, u, target } = rig();
    const dist = (): number => Math.hypot(camera.position.x - target.x, camera.position.z - target.z);
    const d0 = dist();
    expect(d0).toBeGreaterThan(CAMERA_OFFSET_BACK * 0.9);
    u.tumble = true;
    for (let i = 0; i < 60; i++) r.update(1 / 60, u);
    expect(dist() - d0).toBeGreaterThan(0.8);
    u.tumble = false;
    for (let i = 0; i < 60; i++) r.update(1 / 60, u);
    expect(Math.abs(dist() - d0)).toBeLessThan(0.05);
  });

  it("low-passes the pivot height while tumbling only", () => {
    const { r, camera, u, target } = rig();
    const y0 = camera.position.y;
    u.tumble = true;
    for (let i = 0; i < 30; i++) r.update(1 / 60, u);
    target.y = 2;
    r.update(1 / 60, u);
    expect(camera.position.y - y0).toBeLessThan(0.5);
    u.tumble = false;
    for (let i = 0; i < 60; i++) r.update(1 / 60, u);
    expect(camera.position.y - y0).toBeCloseTo(2, 2);
  });

  it("ring-out: never follows the body under the slab, and looks down at it", () => {
    const { r, camera, u, target } = rig();
    target.y = -1.2;
    r.update(1 / 60, u);
    const frozenY = camera.position.y;
    target.y = -5;
    for (let i = 0; i < 10; i++) r.update(1 / 60, u);
    expect(camera.position.y).toBeCloseTo(frozenY, 5);
    const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    expect(forward.y).toBeLessThan(-0.5);
  });
});
