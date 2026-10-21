// ProjectileSync tests: dead reckoning against straight stepProjectile runs, predicted throw matching, fades,
// coconut balls, sinking, rest / stuck items. Owner: client-net. Adapted from Bonk's BallSync.test.ts.

import { describe, expect, it } from "vitest";
import { DT, PREDICTED_PROJECTILE_TIMEOUT_MS } from "../../../shared/constants";
import { vec3, type Vec3 } from "../../../shared/sim/math";
import { copyProjectileSim, createProjectileSim, stepProjectile, type ProjectileSim } from "../../../shared/sim/projectile";
import { computeThrowVelocities } from "../../../shared/sim/throw";
import type { ProjectileView } from "../../../shared/types";
import { ProjectileSync, type HandResolver } from "./ProjectileSync";
import { mapOf, projectileCtx, projectileView, testIsland } from "./testkit";
import type { ProjectileFrame } from "./types";

// Plateau at 1 m, sea from x = 6 (3 m deep), a rock post far from every flight path.
const island = testIsland({ seaFromX: 6, rocks: [{ x: -15, z: 15 }] });
const q = projectileCtx(island);
const noHands: HandResolver = () => null;

function state(...items: ProjectileView[]): Map<string, ProjectileView> {
  return mapOf(...items);
}

/** Straight stepProjectile run (the reference the dead reckoning must match). */
function simulate(start: ProjectileSim, ticks: number): ProjectileSim {
  const p = copyProjectileSim(start, createProjectileSim(start.kind));
  for (let i = 0; i < ticks; i++) stepProjectile(p, q);
  return p;
}

function frameOf(sync: ProjectileSync, id: string): ProjectileFrame | undefined {
  return sync.getFrames().find((f) => f.id === id);
}

function pos(f: ProjectileFrame | undefined): Vec3 {
  if (!f) throw new Error("missing frame");
  return vec3(f.x, f.y, f.z);
}

function expectNear(a: Vec3, b: Vec3, digits = 6): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

/** Advance whole ticks of real time. */
function run(sync: ProjectileSync, ticks: number): void {
  for (let i = 0; i < ticks; i++) sync.update(DT, q);
}

/** A coconut flying high over the plateau (no contact for the first ~20 ticks). */
const flying = (): ProjectileView =>
  projectileView({ id: "p1", x: -8, y: 9, z: 1, vx: 3, vy: 2, vz: -4, state: "loose", kind: "coconut", ownerId: "x", ageTicks: 30 });

describe("ProjectileSync dead reckoning", () => {
  it("fast-forwards a new server projectile from its patch tick to the server's present", () => {
    const sync = new ProjectileSync();
    const p = flying();
    sync.onServerState(state(p), 100, 103, q, noHands);
    expectNear(pos(frameOf(sync, "p1")), simulate(p, 3));
  });

  it("caps the fast-forward at MAX_FAST_FORWARD_TICKS", () => {
    const sync = new ProjectileSync();
    const p = flying();
    sync.onServerState(state(p), 100, 140, q, noHands);
    expectNear(pos(frameOf(sync, "p1")), simulate(p, 6));
  });

  it("dead-reckons between patches exactly like stepProjectile", () => {
    const sync = new ProjectileSync();
    const p = flying();
    sync.onServerState(state(p), 100, 100, q, noHands);
    run(sync, 9);
    expectNear(pos(frameOf(sync, "p1")), simulate(p, 9), 5);
  });

  it("a consistent patch changes nothing on screen", () => {
    const sync = new ProjectileSync();
    const p = flying();
    sync.onServerState(state(p), 100, 100, q, noHands);
    run(sync, 6);
    const before = pos(frameOf(sync, "p1"));
    const server = projectileView({ ...simulate(p, 4), id: "p1", ownerId: "x" });
    sync.onServerState(state(server), 104, 106, q, noHands);
    expectNear(pos(frameOf(sync, "p1")), before, 5);
  });

  it("blends a correction out instead of jumping, then follows the server", () => {
    const sync = new ProjectileSync();
    const p = flying();
    sync.onServerState(state(p), 100, 100, q, noHands);
    run(sync, 6);
    const before = pos(frameOf(sync, "p1"));
    const corrected = projectileView({ ...simulate(p, 4), id: "p1", ownerId: "x" });
    corrected.x += 0.8;
    sync.onServerState(state(corrected), 104, 106, q, noHands);
    expectNear(pos(frameOf(sync, "p1")), before, 5);
    run(sync, 20);
    expectNear(pos(frameOf(sync, "p1")), simulate({ ...corrected }, 22), 2);
  });

  it("snaps corrections larger than PROJECTILE_SNAP_DIST", () => {
    const sync = new ProjectileSync();
    const p = flying();
    sync.onServerState(state(p), 100, 100, q, noHands);
    run(sync, 3);
    const moved = projectileView({ ...simulate(p, 3), id: "p1", ownerId: "x" });
    moved.z += 5;
    sync.onServerState(state(moved), 103, 103, q, noHands);
    expectNear(pos(frameOf(sync, "p1")), moved, 5);
  });

  it("removes projectiles that left the state", () => {
    const sync = new ProjectileSync();
    sync.onServerState(state(flying()), 100, 100, q, noHands);
    sync.onServerState(state(), 101, 101, q, noHands);
    expect(sync.getFrames()).toHaveLength(0);
    expect(sync.size).toBe(0);
  });

  it("renders rest and stuck projectiles at their server position without simulating them", () => {
    const sync = new ProjectileSync();
    const nut = projectileView({ id: "r", x: 1, y: 1.2, z: 1, state: "rest", kind: "coconut", ageTicks: 300 });
    const spear = projectileView({ id: "s", x: -2, y: 1.5, z: 0, vx: 4, vy: -2, state: "stuck", kind: "spear", ageTicks: 20 });
    sync.onServerState(state(nut, spear), 100, 102, q, noHands);
    run(sync, 10);
    expectNear(pos(frameOf(sync, "r")), nut);
    expectNear(pos(frameOf(sync, "s")), spear);
    expect(frameOf(sync, "s")?.state).toBe("stuck");
  });

  it("blends into the server's rest position instead of popping", () => {
    const sync = new ProjectileSync();
    const rolling = projectileView({ id: "c", x: 0, y: 1.2, z: 0, vx: 1, state: "loose", kind: "coconut", ageTicks: 50 });
    sync.onServerState(state(rolling), 100, 100, q, noHands);
    run(sync, 3);
    const before = pos(frameOf(sync, "c"));
    const rested = projectileView({ id: "c", x: before.x + 0.4, y: 1.2, z: 0, state: "rest", kind: "coconut", ageTicks: 60 });
    sync.onServerState(state(rested), 103, 103, q, noHands);
    expectNear(pos(frameOf(sync, "c")), before, 5);
    run(sync, 30);
    expectNear(pos(frameOf(sync, "c")), rested, 2);
  });

  it("reports a bounce once, even when a late patch fast-forwards across it again", () => {
    const sync = new ProjectileSync();
    const drop = projectileView({ id: "d", x: 0, y: 1.8, z: 0, vy: -6, state: "loose", kind: "coconut" });
    sync.onServerState(state(drop), 100, 100, q, noHands);
    let bounces = 0;
    for (let i = 0; i < 6; i++) {
      run(sync, 1);
      const f = frameOf(sync, "d");
      if (f?.bounced) {
        bounces++;
        expect(f.bounceSpeed).toBeGreaterThan(1);
      }
    }
    expect(bounces).toBe(1);
    // The same pre-bounce snapshot arrives late and is replayed through the bounce.
    sync.onServerState(state(drop), 100, 106, q, noHands);
    expect(frameOf(sync, "d")?.bounced).toBe(false);
  });

  it("hides a projectile that sank until the server removes it", () => {
    const sync = new ProjectileSync();
    const lob = projectileView({ id: "w", x: 4, y: 3, z: 0, vx: 8, state: "live", kind: "stone", ownerId: "x", throwSeq: 3, ageTicks: 12 });
    sync.onServerState(state(lob), 100, 100, q, noHands);
    run(sync, 30);
    expect(frameOf(sync, "w")).toBeUndefined();
    expect(sync.size).toBe(1);
    sync.onServerState(state(), 130, 130, q, noHands);
    expect(sync.size).toBe(0);
  });

  it("exposes bait, charge and age for rendering", () => {
    const sync = new ProjectileSync();
    const fish = projectileView({ id: "f", x: 0, y: 1.2, z: 0, state: "rest", kind: "fish_raw", baitTicks: 120, charge: 0.7, ageTicks: 45, ownerId: "p2" });
    sync.onServerState(state(fish), 100, 100, q, noHands);
    expect(frameOf(sync, "f")).toMatchObject({ bait: true, charge: 0.7, age: 1.5, kind: "fish_raw", ownerId: "p2", predicted: false, opacity: 1 });
  });
});

describe("ProjectileSync throws", () => {
  const hand = vec3(5, 2, 5);
  const hands: HandResolver = (id) => (id === "other" ? hand : null);

  it("starts a remote throw at the thrower's rendered hand and catches up", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    const thrown = projectileView({ id: "t", x: 4, y: 3.4, z: 3, vz: -12, vy: 3, state: "live", kind: "coconut", ownerId: "other", ageTicks: 2, throwSeq: 9 });
    sync.onServerState(state(thrown), 100, 100, q, hands);
    expectNear(pos(frameOf(sync, "t")), hand);
    // 2 × PROJECTILE_SMOOTH_MS time constant: after one second < 1% of the hand offset is left.
    run(sync, 30);
    expectNear(pos(frameOf(sync, "t")), simulate(thrown, 30), 1);
  });

  it("does not drag the local player's own (unpredicted) throw back to a hand", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    const mine = projectileView({ id: "m", x: 1, y: 2.5, z: 1, vz: -10, state: "live", kind: "stone", ownerId: "me", ageTicks: 2, throwSeq: 3 });
    sync.onServerState(state(mine), 100, 100, q, () => hand);
    expectNear(pos(frameOf(sync, "m")), mine);
  });

  it("predicts a coconut ball as three coconuts at once", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    const velocities = computeThrowVelocities({ kind: "coconut_ball", charge: 0.4, toss: false, yaw: 0, pitch: 0.2 });
    expect(velocities).toHaveLength(3);
    sync.addPredictedThrow("me", 7, vec3(0, 2.4, 0), velocities, "coconut", 0.4);
    const frames = sync.getFrames();
    expect(frames.map((f) => f.id)).toEqual(["pred:7:0", "pred:7:1", "pred:7:2"]);
    for (const f of frames) {
      expect(f).toMatchObject({ predicted: true, state: "live", kind: "coconut", ownerId: "me", charge: 0.4, opacity: 1 });
      expectNear(pos(f), vec3(0, 2.4, 0));
    }
  });

  it("hands a predicted projectile over to the matching server projectile without a jump", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    const origin = vec3(0, 2.4, 0);
    const velocity = vec3(0, 4, -8);
    sync.addPredictedThrow("me", 42, origin, [velocity], "coconut", 0.2);
    run(sync, 5);
    const before = pos(frameOf(sync, "pred:42:0"));

    // The server released it a little later (RTT): its projectile is behind the prediction.
    const server = projectileView({ id: "p9", x: origin.x, y: origin.y, z: origin.z, vx: velocity.x, vy: velocity.y, vz: velocity.z });
    Object.assign(server, { state: "live", kind: "coconut", ownerId: "me", throwSeq: 42, ageTicks: 1, charge: 0.2 });
    sync.noteThrow({ projectileIds: ["p9"] });
    sync.onServerState(state(server), 103, 105, q, noHands);

    const frames = sync.getFrames();
    expect(frames.map((f) => f.id)).toEqual(["p9"]);
    expect(frames[0]!.predicted).toBe(false);
    expectNear(pos(frames[0]), before, 5);
    run(sync, 30);
    expectNear(pos(frameOf(sync, "p9")), simulate(server, 32), 1);
  });

  it("matches coconut-ball projectiles by their index in the ThrowEvent", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    const velocities = computeThrowVelocities({ kind: "coconut_ball", charge: 0, toss: false, yaw: 0, pitch: 0.3 });
    sync.addPredictedThrow("me", 5, vec3(0, 2.4, 0), velocities, "coconut", 0);
    sync.noteThrow({ projectileIds: ["p20", "p21", "p22"] });
    const v2 = velocities[2]!;
    const side = projectileView({ id: "p22", x: 0, y: 2.4, z: 0, vx: v2.x, vy: v2.y, vz: v2.z, state: "live", kind: "coconut" });
    Object.assign(side, { ownerId: "me", throwSeq: 5, ageTicks: 1 });
    sync.onServerState(state(side), 100, 100, q, noHands);
    expect(sync.getFrames().map((f) => f.id)).toEqual(["pred:5:0", "pred:5:1", "p22"]);
  });

  it("falls back to the closest launch direction when the ThrowEvent hasn't arrived", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    const velocities = computeThrowVelocities({ kind: "coconut_ball", charge: 0.5, toss: false, yaw: 0.4, pitch: 0.3 });
    sync.addPredictedThrow("me", 6, vec3(0, 2.4, 0), velocities, "coconut", 0.5);
    const v1 = velocities[1]!;
    const left = projectileView({ id: "p30", x: 0, y: 2.4, z: 0, vx: v1.x, vy: v1.y, vz: v1.z, state: "live", kind: "coconut" });
    Object.assign(left, { ownerId: "me", throwSeq: 6, ageTicks: 1 });
    sync.onServerState(state(left), 100, 100, q, noHands);
    expect(sync.getFrames().map((f) => f.id)).toEqual(["pred:6:0", "pred:6:2", "p30"]);
  });

  it("matches a release the server stepped a tick apart (same kind, nearby seq)", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    sync.addPredictedThrow("me", 20, vec3(0, 2.4, 0), [vec3(0, 3, -9)], "spear", 1);
    const late = projectileView({ id: "p40", y: 2.4, vy: 3, vz: -9, state: "live", kind: "spear", ownerId: "me", throwSeq: 21, ageTicks: 1 });
    sync.noteThrow({ projectileIds: ["p40"] });
    sync.onServerState(state(late), 101, 101, q, noHands);
    expect(sync.getFrames().map((f) => f.id)).toEqual(["p40"]);
    // Far-off seqs or another kind never match.
    sync.addPredictedThrow("me", 40, vec3(0, 2.4, 0), [vec3(0, 3, -9)], "stone", 1);
    const other = projectileView({ id: "p41", y: 2.4, vy: 3, vz: -9, state: "live", kind: "coconut", ownerId: "me", throwSeq: 40, ageTicks: 1 });
    const far = projectileView({ id: "p42", y: 2.4, vy: 3, vz: -9, state: "live", kind: "stone", ownerId: "me", throwSeq: 48, ageTicks: 1 });
    sync.onServerState(state(late, other, far), 102, 102, q, noHands);
    expect(sync.getFrames().map((f) => f.id)).toEqual(["p40", "pred:40:0", "p41", "p42"]);
  });

  it("never matches another player's throw with the same seq", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    sync.addPredictedThrow("me", 8, vec3(0, 2.4, 0), [vec3(0, 2, -5)], "stone", 0);
    const theirs = projectileView({ id: "p1", y: 2.4, vz: -5, state: "live", kind: "stone", ownerId: "p2", throwSeq: 8, ageTicks: 1 });
    sync.noteThrow({ projectileIds: ["p1"] });
    sync.onServerState(state(theirs), 100, 100, q, noHands);
    expect(sync.getFrames().map((f) => f.id)).toEqual(["pred:8:0", "p1"]);
  });

  it("fades an unmatched predicted projectile after the timeout, then removes it", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    sync.addPredictedThrow("me", 3, vec3(0, 2.4, 0), [vec3(0, 2, -2)], "stone", 0);
    const step = 1 / 100;
    const advance = (ms: number): void => {
      for (let t = 0; t < ms - 1e-6; t += 10) sync.update(step, q);
    };
    advance(PREDICTED_PROJECTILE_TIMEOUT_MS);
    expect(frameOf(sync, "pred:3:0")?.opacity).toBe(1);
    advance(100);
    expect(frameOf(sync, "pred:3:0")?.opacity).toBeCloseTo(0.5, 5);
    advance(110);
    expect(frameOf(sync, "pred:3:0")).toBeUndefined();
    expect(sync.size).toBe(0);
  });

  it("still lets the server projectile take over while the predicted one is fading", () => {
    const sync = new ProjectileSync();
    sync.setLocalId("me");
    sync.onServerState(state(), 100, 100, q, noHands);
    sync.addPredictedThrow("me", 4, vec3(0, 2.4, 0), [vec3(0, 2, -2)], "stone", 0);
    for (let i = 0; i < 20; i++) sync.update(0.034, q);
    const late = projectileView({ id: "p5", y: 2.4, vz: -2, vy: 2, state: "live", kind: "stone", ownerId: "me", throwSeq: 4, ageTicks: 12 });
    sync.noteThrow({ projectileIds: ["p5"] });
    sync.onServerState(state(late), 120, 120, q, noHands);
    expect(sync.getFrames().map((f) => f.id)).toEqual(["p5"]);
  });

  it("clear() forgets everything", () => {
    const sync = new ProjectileSync();
    sync.onServerState(state(flying()), 100, 100, q, noHands);
    sync.addPredictedThrow("me", 1, vec3(0, 2.4, 0), [vec3(0, 1, -1)], "coconut", 0);
    sync.clear();
    expect(sync.size).toBe(0);
    expect(sync.getFrames()).toHaveLength(0);
  });
});
