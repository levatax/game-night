import { describe, expect, it } from "vitest";
import { BALL_RADIUS, DT, PREDICTED_BALL_TIMEOUT_MS } from "../../../shared/constants";
import { copyBallSim, createBallSim, stepBall, type BallSim } from "../../../shared/sim/ball";
import type { FloorQuery } from "../../../shared/sim/context";
import { vec3, type Vec3 } from "../../../shared/sim/math";
import { ballCtx, openArena, solidRings } from "../../../shared/sim/testkit";
import type { BallView } from "../../../shared/types";
import { BallSync, type OwnerResolver } from "./BallSync";
import type { BallFrame } from "./types";

const arena = openArena();
const q: FloorQuery = { arena, rings: solidRings(arena) };
const noOwners: OwnerResolver = () => null;

function ball(fields: Partial<BallView> & { id: string }): BallView {
  return { ...createBallSim(), ownerId: "", holderId: "", throwSeq: 0, throwIndex: 0, charge: 0, ...fields };
}

function state(...balls: BallView[]): Map<string, BallView> {
  return new Map(balls.map((b) => [b.id, b]));
}

/** Straight stepBall run (the reference the dead reckoning must match). */
function simulate(start: BallSim, ticks: number): BallSim {
  const b = copyBallSim(start, createBallSim());
  const ctx = ballCtx(arena, q.rings);
  for (let i = 0; i < ticks; i++) stepBall(b, ctx);
  return b;
}

function frameOf(sync: BallSync, id: string, localId = "me", held = 0): BallFrame | undefined {
  return sync.getFrames(localId, held).find((f) => f.id === id);
}

function pos(f: BallFrame | undefined): Vec3 {
  if (!f) throw new Error("missing frame");
  return vec3(f.x, f.y, f.z);
}

function expectNear(a: Vec3, b: Vec3, digits = 6): void {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
}

/** Advance whole ticks of real time. */
function run(sync: BallSync, ticks: number, owners: OwnerResolver = noOwners): void {
  for (let i = 0; i < ticks; i++) sync.update(DT, q, owners);
}

const flying = (): BallView =>
  ball({ id: "b1", x: -2, y: 4, z: 1, vx: 3, vy: 2, vz: -4, state: "dead", ownerId: "x", ageTicks: 30 });

describe("BallSync dead reckoning", () => {
  it("fast-forwards a new server ball from its patch tick to the server's present", () => {
    const sync = new BallSync();
    const b = flying();
    sync.onServerState(state(b), 100, 103, q, noOwners);
    expectNear(pos(frameOf(sync, "b1")), simulate(b, 3));
  });

  it("caps the fast-forward at MAX_FAST_FORWARD_TICKS", () => {
    const sync = new BallSync();
    const b = flying();
    sync.onServerState(state(b), 100, 140, q, noOwners);
    expectNear(pos(frameOf(sync, "b1")), simulate(b, 6));
  });

  it("dead-reckons between patches exactly like stepBall", () => {
    const sync = new BallSync();
    const b = flying();
    sync.onServerState(state(b), 100, 100, q, noOwners);
    run(sync, 9);
    expectNear(pos(frameOf(sync, "b1")), simulate(b, 9), 5);
  });

  it("a consistent patch changes nothing on screen", () => {
    const sync = new BallSync();
    const b = flying();
    sync.onServerState(state(b), 100, 100, q, noOwners);
    run(sync, 6);
    const before = pos(frameOf(sync, "b1"));
    const server = ball({ ...simulate(b, 4), id: "b1", ownerId: "x" });
    sync.onServerState(state(server), 104, 106, q, noOwners);
    expectNear(pos(frameOf(sync, "b1")), before, 5);
  });

  it("blends a correction out instead of jumping, then follows the server", () => {
    const sync = new BallSync();
    const b = flying();
    sync.onServerState(state(b), 100, 100, q, noOwners);
    run(sync, 6);
    const before = pos(frameOf(sync, "b1"));
    const corrected = ball({ ...simulate(b, 4), id: "b1", ownerId: "x" });
    corrected.x += 0.8;
    sync.onServerState(state(corrected), 104, 106, q, noOwners);
    expectNear(pos(frameOf(sync, "b1")), before, 5);
    run(sync, 20);
    const truth = simulate({ ...corrected }, 22);
    expectNear(pos(frameOf(sync, "b1")), truth, 2);
  });

  it("snaps corrections larger than BALL_SNAP_DIST", () => {
    const sync = new BallSync();
    const b = flying();
    sync.onServerState(state(b), 100, 100, q, noOwners);
    run(sync, 3);
    const moved = ball({ ...simulate(b, 3), id: "b1", ownerId: "x" });
    moved.z += 5;
    sync.onServerState(state(moved), 103, 103, q, noOwners);
    expectNear(pos(frameOf(sync, "b1")), moved, 5);
  });

  it("removes balls that left the state", () => {
    const sync = new BallSync();
    sync.onServerState(state(flying()), 100, 100, q, noOwners);
    sync.onServerState(state(), 101, 101, q, noOwners);
    expect(sync.getFrames("me", 0)).toHaveLength(0);
  });

  it("doesn't simulate held balls and reports them at the server position", () => {
    const sync = new BallSync();
    const held = ball({ id: "h", x: 1, y: 1, z: 1, state: "held", holderId: "p2" });
    sync.onServerState(state(held), 100, 100, q, noOwners);
    run(sync, 10);
    expectNear(pos(frameOf(sync, "h")), held);
  });

  it("reports a bounce once, even when a late patch fast-forwards across it again", () => {
    const sync = new BallSync();
    const drop = ball({ id: "d", x: 0, y: 0.8, z: 0, vy: -6, state: "neutral" });
    sync.onServerState(state(drop), 100, 100, q, noOwners);
    let bounces = 0;
    for (let i = 0; i < 6; i++) {
      run(sync, 1);
      if (frameOf(sync, "d")?.bounced) bounces++;
    }
    expect(bounces).toBe(1);
    // The same pre-bounce snapshot arrives late and is replayed through the bounce.
    sync.onServerState(state(drop), 100, 106, q, noOwners);
    expect(frameOf(sync, "d")?.bounced).toBe(false);
  });

  it("passes the owner's chest so a returning boomerang keeps homing", () => {
    const boomerang = (): BallView =>
      ball({ id: "bm", x: 0, y: 2, z: -8, vz: -20, state: "live", kind: "boomerang", returning: true, ownerId: "o", ageTicks: 40 });
    const owner = { aim: vec3(0, 0, -1), chest: vec3(0, 1, 0), hand: vec3(0.3, 1, -0.5), alive: true };
    const homing = new BallSync();
    homing.onServerState(state(boomerang()), 100, 100, q, (id) => (id === "o" ? owner : null));
    run(homing, 4, (id) => (id === "o" ? owner : null));
    const f = frameOf(homing, "bm");
    expect(f?.state).toBe("live");
    expect(f?.vz).toBeGreaterThan(0);

    const orphan = new BallSync();
    orphan.onServerState(state(boomerang()), 100, 100, q, noOwners);
    run(orphan, 1);
    expect(frameOf(orphan, "bm")?.state).toBe("dead");
  });
});

describe("BallSync throws", () => {
  const hand = vec3(5, 1, 5);
  const owners: OwnerResolver = (id) => (id === "other" ? { aim: vec3(0, 0, -1), chest: vec3(5, 1, 5.5), hand, alive: true } : null);

  it("starts a remote throw at the thrower's rendered hand and catches up", () => {
    const sync = new BallSync();
    sync.setLocalId("me");
    const held = ball({ id: "t", x: 5.2, y: 1, z: 4.8, state: "held", holderId: "other" });
    sync.onServerState(state(held), 100, 100, q, owners);
    const thrown = ball({ id: "t", x: 6, y: 1.4, z: 3, vz: -12, vy: 3, state: "live", ownerId: "other", ageTicks: 2, throwSeq: 9 });
    sync.onServerState(state(thrown), 100, 100, q, owners);
    expectNear(pos(frameOf(sync, "t")), hand);
    // 2 × BALL_SMOOTH_MS time constant: after one second < 1% of the hand offset is left.
    run(sync, 30, owners);
    expectNear(pos(frameOf(sync, "t")), simulate(thrown, 30), 1);
  });

  it("does not drag the local player's own (unpredicted) throw back to a hand", () => {
    const sync = new BallSync();
    sync.setLocalId("me");
    const mine = ball({ id: "m", x: 1, y: 1.5, z: 1, vz: -10, state: "live", ownerId: "me", ageTicks: 2, throwSeq: 3 });
    sync.onServerState(state(mine), 100, 100, q, (id) => (id === "me" ? { aim: vec3(), chest: vec3(), hand, alive: true } : null));
    expectNear(pos(frameOf(sync, "m")), mine);
  });

  it("hides the local player's held balls beyond the predicted held count", () => {
    const sync = new BallSync();
    const mine = ball({ id: "h1", state: "held", holderId: "me" });
    const theirs = ball({ id: "h2", state: "held", holderId: "p2" });
    sync.onServerState(state(mine, theirs), 100, 100, q, noOwners);
    expect(sync.getFrames("me", 0).map((f) => f.id)).toEqual(["h2"]);
    expect(sync.getFrames("me", 1).map((f) => f.id)).toEqual(["h1", "h2"]);
    expect(sync.getFrames("me", Number.POSITIVE_INFINITY)).toHaveLength(2);
  });

  it("spawns predicted balls at once: index 0 gets the kind, the others are bonus", () => {
    const sync = new BallSync();
    sync.onServerState(state(), 100, 100, q, noOwners);
    sync.addPredictedThrow("me", 7, vec3(0, 1, 0), [vec3(0, 3, -6), vec3(-1, 3, -6), vec3(1, 3, -6)], "mega", 0.4, true);
    const frames = sync.getFrames("me", 0);
    expect(frames.map((f) => f.id)).toEqual(["pred:7:0", "pred:7:1", "pred:7:2"]);
    expect(frames.map((f) => f.kind)).toEqual(["mega", "bonus", "bonus"]);
    expect(frames[0].radius).toBeGreaterThan(BALL_RADIUS);
    expect(frames[1].radius).toBe(BALL_RADIUS);
    for (const f of frames) {
      expect(f).toMatchObject({ predicted: true, state: "live", ownerId: "me", charge: 0.4, curve: true, opacity: 1 });
      expectNear(pos(f), vec3(0, 1, 0));
    }
  });

  it("hands a predicted ball over to the matching server ball without a jump", () => {
    const sync = new BallSync();
    sync.setLocalId("me");
    const heldBall = ball({ id: "b9", state: "held", holderId: "me" });
    sync.onServerState(state(heldBall), 100, 100, q, noOwners);
    const origin = vec3(0, 1, 0);
    const velocity = vec3(0, 4, -8);
    sync.addPredictedThrow("me", 42, origin, [velocity], "normal", 0.2, false);
    run(sync, 5);
    const before = pos(frameOf(sync, "pred:42:0"));

    // The server released it a little later (RTT): its ball is behind the prediction.
    const server = ball({ id: "b9", x: origin.x, y: origin.y, z: origin.z, vx: velocity.x, vy: velocity.y, vz: velocity.z });
    Object.assign(server, { state: "live", ownerId: "me", throwSeq: 42, throwIndex: 0, ageTicks: 1, charge: 0.2 });
    sync.onServerState(state(server), 103, 105, q, noOwners);

    const frames = sync.getFrames("me", 0);
    expect(frames.map((f) => f.id)).toEqual(["b9"]);
    expect(frames[0].predicted).toBe(false);
    expectNear(pos(frames[0]), before, 5);
    run(sync, 30);
    expectNear(pos(frameOf(sync, "b9")), simulate(server, 32), 1);
  });

  it("matches Triple Shot balls by throwIndex", () => {
    const sync = new BallSync();
    sync.onServerState(state(), 100, 100, q, noOwners);
    sync.addPredictedThrow("me", 5, vec3(0, 1, 0), [vec3(0, 2, -5), vec3(-1, 2, -5), vec3(1, 2, -5)], "normal", 0, false);
    const side = ball({ id: "b20", x: -0.1, y: 1, z: -0.2, vx: -1, vy: 2, vz: -5, state: "live", kind: "bonus" });
    Object.assign(side, { ownerId: "me", throwSeq: 5, throwIndex: 2, ageTicks: 1 });
    sync.onServerState(state(side), 100, 100, q, noOwners);
    expect(sync.getFrames("me", 0).map((f) => f.id)).toEqual(["pred:5:0", "pred:5:1", "b20"]);
  });

  it("never matches another player's throw with the same seq", () => {
    const sync = new BallSync();
    sync.onServerState(state(), 100, 100, q, noOwners);
    sync.addPredictedThrow("me", 8, vec3(0, 1, 0), [vec3(0, 2, -5)], "normal", 0, false);
    const theirs = ball({ id: "b1", y: 1, vz: -5, state: "live", ownerId: "p2", throwSeq: 8, ageTicks: 1 });
    sync.onServerState(state(theirs), 100, 100, q, noOwners);
    expect(sync.getFrames("me", 0).map((f) => f.id)).toEqual(["pred:8:0", "b1"]);
  });

  it("fades an unmatched predicted ball after the timeout, then removes it", () => {
    const sync = new BallSync();
    sync.onServerState(state(), 100, 100, q, noOwners);
    sync.addPredictedThrow("me", 3, vec3(0, 1, 0), [vec3(0, 2, -2)], "normal", 0, false);
    const step = 1 / 100;
    const advance = (ms: number): void => {
      for (let t = 0; t < ms - 1e-6; t += 10) sync.update(step, q, noOwners);
    };
    advance(PREDICTED_BALL_TIMEOUT_MS);
    expect(frameOf(sync, "pred:3:0")?.opacity).toBe(1);
    advance(100);
    expect(frameOf(sync, "pred:3:0")?.opacity).toBeCloseTo(0.5, 5);
    advance(110);
    expect(frameOf(sync, "pred:3:0")).toBeUndefined();
    expect(sync.size).toBe(0);
  });

  it("still lets the server ball take over while the predicted one is fading", () => {
    const sync = new BallSync();
    sync.onServerState(state(), 100, 100, q, noOwners);
    sync.addPredictedThrow("me", 4, vec3(0, 1, 0), [vec3(0, 2, -2)], "normal", 0, false);
    for (let i = 0; i < 20; i++) sync.update(0.034, q, noOwners);
    const late = ball({ id: "b5", y: 1, vz: -2, vy: 2, state: "live", ownerId: "me", throwSeq: 4, ageTicks: 12 });
    sync.onServerState(state(late), 120, 120, q, noOwners);
    expect(sync.getFrames("me", 0).map((f) => f.id)).toEqual(["b5"]);
  });

  it("clear() forgets everything", () => {
    const sync = new BallSync();
    sync.onServerState(state(flying()), 100, 100, q, noOwners);
    sync.addPredictedThrow("me", 1, vec3(0, 1, 0), [vec3(0, 1, -1)], "normal", 0, false);
    sync.clear();
    expect(sync.size).toBe(0);
    expect(sync.getFrames("me", 0)).toHaveLength(0);
  });
});
