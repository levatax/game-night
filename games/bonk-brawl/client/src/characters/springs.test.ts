import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { SpringBone, SpringKind } from "./rigTypes";
import { SpringRig } from "./springs";

interface TestRig {
  root: THREE.Group;
  bones: SpringBone[];
  rig: SpringRig;
}

function bone(
  name: string,
  kind: SpringKind,
  pivot: THREE.Object3D,
  tip: [number, number, number],
  freq: number,
  damping: number,
  gravity: number,
  limit: number,
  parent = -1,
  mode: "aim" | "scale" = "aim",
): SpringBone {
  pivot.name = name;
  return { name, kind, pivot, mode, tip, freq, damping, gravity, limit, parent };
}

/** A tiny rig: head (lag) → ear, a ribbon, a two-segment tail chain and a belly (scale). */
function makeRig(): TestRig {
  const root = new THREE.Group();
  const head = new THREE.Group();
  head.position.set(0, 1, 0);
  root.add(head);
  const ear = new THREE.Group();
  ear.position.set(0.2, 0.25, 0);
  head.add(ear);
  const ribbon = new THREE.Group();
  ribbon.position.set(0, 0.3, 0.2);
  head.add(ribbon);
  const tail0 = new THREE.Group();
  tail0.position.set(0, 0.4, 0.3);
  root.add(tail0);
  const tail1 = new THREE.Group();
  tail1.position.set(0, 0.25, 0.15);
  tail0.add(tail1);
  const belly = new THREE.Group();
  belly.position.set(0, 0.4, -0.2);
  root.add(belly);
  const bones = [
    bone("head", "head", head, [0, 0.3, 0], 5, 0.45, 0, 0.12),
    bone("earR", "ear", ear, [0.05, 0.2, 0], 6, 0.35, 1, 0.35),
    bone("ribbonR", "ribbon", ribbon, [0, -0.17, 0.05], 2.6, 0.22, 8, 1.2),
    bone("extra", "tail", tail0, [0, 0.25, 0.15], 4, 0.3, 2, 0.6),
    bone("tail1", "tail", tail1, [0, 0.25, 0.05], 3.4, 0.28, 2, 0.8, 3),
    bone("belly", "belly", belly, [0, 0.2, 0], 5, 0.2, 0, 0.18, -1, "scale"),
  ];
  return { root, bones, rig: new SpringRig(bones) };
}

/**
 * Analytic root path with smooth (C1) velocity, like the game's interpolated motion: accelerate to
 * 6 m/s in 0.35 s, cruise, stop hard (peak 60 m/s²) in 0.15 s, then a 180° turn in place in 0.25 s.
 */
function rootAt(t: number, out: { x: number; yaw: number }): void {
  const ramp = (u: number): number => u * u * u - (u * u * u * u) / 2; // ∫ smoothstep
  if (t < 0.35) out.x = 6 * 0.35 * ramp(t / 0.35);
  else if (t < 0.7) out.x = 1.05 + 6 * (t - 0.35);
  else if (t < 0.85) {
    const u = (t - 0.7) / 0.15;
    out.x = 3.15 + 6 * 0.15 * (u - ramp(u));
  } else out.x = 3.6;
  const u = Math.min(1, Math.max(0, (t - 1.0) / 0.25));
  out.yaw = Math.PI * u * u * (3 - 2 * u);
}

/** Reset pivots (as applyPose does), pose the root, update matrices and step the springs. */
function step(r: TestRig, t: number, dt: number): void {
  const at = { x: 0, yaw: 0 };
  rootAt(t, at);
  for (const b of r.bones) {
    b.pivot.quaternion.identity();
    b.pivot.scale.set(1, 1, 1);
  }
  r.root.position.set(at.x, 0, 0);
  r.root.rotation.y = at.yaw;
  r.root.updateMatrixWorld(true);
  r.rig.update(dt);
}

function sample(fps: number, until: number, every: number): number[][] {
  const r = makeRig();
  const dt = 1 / fps;
  const frames = Math.round(until * fps);
  const stride = Math.round(every * fps);
  const out: number[][] = [];
  const v = new THREE.Vector3();
  step(r, 0, dt);
  for (let f = 1; f <= frames; f++) {
    step(r, f * dt, dt);
    if (f % stride === 0) {
      const row: number[] = [];
      for (let i = 0; i < r.rig.count; i++) {
        r.rig.getTip(i, v);
        row.push(v.x, v.y, v.z);
      }
      out.push(row);
    }
  }
  return out;
}

/** Rotation angle of a pivot's (deflection-only) quaternion. */
function pivotAngle(b: SpringBone): number {
  return 2 * Math.acos(Math.min(1, Math.abs(b.pivot.quaternion.w)));
}

/** Pose the root at x (no yaw), reset pivots, step the springs by dt. */
function stepAt(r: TestRig, x: number, dt: number): void {
  for (const b of r.bones) {
    b.pivot.quaternion.identity();
    b.pivot.scale.set(1, 1, 1);
  }
  r.root.position.set(x, 0, 0);
  r.root.rotation.y = 0;
  r.root.updateMatrixWorld(true);
  r.rig.update(dt);
}

/** Run at a constant 6 m/s for 40 frames at 60 fps; returns each bone's settled pivot angle. */
function cruise(r: TestRig): number[] {
  stepAt(r, 0, 1 / 60);
  for (let f = 1; f <= 40; f++) stepAt(r, (6 * f) / 60, 1 / 60);
  return r.bones.map(pivotAngle);
}

describe("SpringRig", () => {
  it("looks the same at 30, 60 and 144 fps (tips within 1.5 cm at shared timestamps)", () => {
    const every = 1 / 6; // a multiple of 1/30, 1/60 and 1/144
    const a = sample(30, 2, every);
    const b = sample(60, 2, every);
    const c = sample(144, 2, every);
    expect(a.length).toBe(b.length);
    expect(a.length).toBe(c.length);
    let worst = 0;
    for (let s = 0; s < a.length; s++) {
      for (let k = 0; k < a[s].length; k += 3) {
        const dab = Math.hypot(a[s][k] - b[s][k], a[s][k + 1] - b[s][k + 1], a[s][k + 2] - b[s][k + 2]);
        const dcb = Math.hypot(c[s][k] - b[s][k], c[s][k + 1] - b[s][k + 1], c[s][k + 2] - b[s][k + 2]);
        worst = Math.max(worst, dab, dcb);
      }
    }
    // 1.5 cm: a chained child (tail1 under the deflected tail0) samples its parent's swing once per
    // frame, so 30 fps drifts ~1.3 cm from 60 fps during the 180° turn (144 fps stays under 2 mm).
    expect(worst).toBeLessThan(0.015);
  });

  it("actually lags behind the motion (the springs do something)", () => {
    const r = makeRig();
    const v = new THREE.Vector3();
    const tipWorld = new THREE.Vector3();
    step(r, 0, 1 / 60);
    for (let f = 1; f <= 45; f++) step(r, f / 60, 1 / 60); // stops hard at t 0.7 → 0.85
    // Ribbon tip (index 2) trails behind (−x) the posed tip while accelerating / cruising.
    const ribbon = r.bones[2];
    r.rig.getTip(2, v);
    tipWorld.set(...ribbon.tip);
    // Undo the deflection to get the posed target: identity pivot.
    ribbon.pivot.quaternion.identity();
    ribbon.pivot.updateMatrixWorld(true);
    tipWorld.applyMatrix4(ribbon.pivot.matrixWorld);
    expect(tipWorld.x - v.x).toBeGreaterThan(0.01);
  });

  it("actually rotates the aim pivots on a moving rig (not just the lagging point)", () => {
    const r = makeRig();
    const steady = cruise(r);
    // The ribbon streams behind a 6 m/s runner: its pivot really turns (aliasing regression guard).
    expect(steady[2]).toBeGreaterThan(0.2);
    expect(steady[2]).toBeLessThanOrEqual(r.bones[2].limit + 1e-4);
  });

  it("a teleport does not whip the bones", () => {
    const r = makeRig();
    const steady = cruise(r);
    // Round reset: jump 10 m to a spawn and stand there.
    const x = 6 * (40 / 60) + 10;
    let ribbon = 0;
    let ear = 0;
    for (let f = 0; f <= 20; f++) {
      stepAt(r, x, 1 / 60);
      ribbon = Math.max(ribbon, pivotAngle(r.bones[2]));
      ear = Math.max(ear, pivotAngle(r.bones[1]));
    }
    expect(ribbon).toBeLessThan(1.2 * steady[2]);
    expect(ear).toBeLessThan(0.1);
  });

  it("a 0.25 s frame hitch integrates instead of snapping (no overshoot)", () => {
    const r = makeRig();
    const steady = cruise(r);
    const t0 = 40 / 60;
    let peak = 0;
    let x = 6 * t0 + 6 * 0.25;
    stepAt(r, x, 0.25);
    for (const i of [1, 2]) peak = Math.max(peak, pivotAngle(r.bones[i]) / steady[i]);
    for (let f = 1; f <= 20; f++) {
      x += 6 / 60;
      stepAt(r, x, 1 / 60);
      for (const i of [1, 2]) peak = Math.max(peak, pivotAngle(r.bones[i]) / steady[i]);
    }
    expect(peak).toBeLessThan(1.2);
    expect(peak).toBeGreaterThan(0.5);
  });

  it("stays stable with a 0.1 s frame", () => {
    const r = makeRig();
    const v = new THREE.Vector3();
    step(r, 0, 0.1);
    for (let f = 1; f <= 30; f++) step(r, f * 0.1, 0.1);
    for (let i = 0; i < r.rig.count; i++) {
      r.rig.getTip(i, v);
      expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
      expect(Math.abs(v.x)).toBeLessThan(20);
      expect(Math.abs(v.y)).toBeLessThan(3);
    }
    for (const b of r.bones) expect(Number.isFinite(b.pivot.quaternion.w)).toBe(true);
  });

  it("dt = 0 (hit-stop) keeps the last deflection without integrating", () => {
    const r = makeRig();
    step(r, 0, 1 / 60);
    for (let f = 1; f <= 20; f++) step(r, f / 60, 1 / 60);
    const q = r.bones[2].pivot.quaternion.clone();
    const s = r.bones[5].pivot.scale.clone();
    const v = new THREE.Vector3();
    r.rig.getTip(2, v);
    const p = v.clone();
    step(r, 20 / 60, 0);
    step(r, 20 / 60, 0);
    r.rig.getTip(2, v);
    expect(v.distanceTo(p)).toBe(0);
    expect(r.bones[2].pivot.quaternion.angleTo(q)).toBeLessThan(1e-6);
    expect(r.bones[5].pivot.scale.distanceTo(s)).toBeLessThan(1e-6);
  });

  it("snaps to the target on a teleport", () => {
    const r = makeRig();
    step(r, 0, 1 / 60);
    r.root.position.set(50, 0, 0);
    for (const b of r.bones) b.pivot.quaternion.identity();
    r.root.updateMatrixWorld(true);
    r.rig.update(1 / 60);
    const v = new THREE.Vector3();
    r.rig.getTip(1, v);
    expect(v.x).toBeGreaterThan(49);
  });

  it("clamps aim deflection to the bone limit and keeps scale within its limit", () => {
    const r = makeRig();
    step(r, 0, 1 / 60);
    r.rig.kick(null, 30, 30, 30, 0);
    step(r, 1 / 60, 1 / 60);
    for (const b of r.bones) {
      if (b.mode === "aim") {
        const angle = 2 * Math.acos(Math.min(1, Math.abs(b.pivot.quaternion.w)));
        expect(angle).toBeLessThanOrEqual(b.limit + 1e-4);
      } else {
        expect(Math.abs(b.pivot.scale.y - 1)).toBeLessThanOrEqual(b.limit + 1e-4);
      }
    }
  });

  it("kick rotates the character-frame impulse by yaw", () => {
    const r = makeRig();
    step(r, 0, 1 / 60);
    // Facing +X (yaw −π/2): a forward kick (−Z in the character frame) pushes tips toward +X.
    const before = new THREE.Vector3();
    r.rig.getTip(2, before);
    r.rig.kick("ribbon", 0, 0, -3, -Math.PI / 2);
    r.root.updateMatrixWorld(true);
    for (const b of r.bones) b.pivot.quaternion.identity();
    r.root.updateMatrixWorld(true);
    r.rig.update(1 / 60);
    const after = new THREE.Vector3();
    r.rig.getTip(2, after);
    expect(after.x - before.x).toBeGreaterThan(0.02);
  });
});
