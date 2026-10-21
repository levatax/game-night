// Prediction tests over a hand-made island (terrain + cover ctx). Owner: client-net.
// Adapted from games/bonk-brawl/client/src/net/Prediction.test.ts: every case compares the predictor with a
// straight stepPlayer run, so it holds for whatever the sim's movement rules are.

import { describe, expect, it } from "vitest";
import { MAX_PENDING_INPUTS, PREDICTION_SMOOTH_MS } from "../../../shared/constants";
import { BTN, type InputCmd } from "../../../shared/protocol";
import type { SimContext } from "../../../shared/sim/context";
import { buildCover } from "../../../shared/sim/cover";
import { PLAYER_SIM_KEYS, copyPlayerSim, stepPlayer, type PlayerSim } from "../../../shared/sim/player";
import type { PlayerSimFields } from "../../../shared/types";
import { Prediction } from "./Prediction";
import { cmd, lcg, playerView, simCtx, spawnPlayer, structureView, testIsland, mapOf } from "./testkit";

const island = testIsland({ rocks: [{ x: 4, z: -6 }, { x: -5, z: 3 }] });

/** Varied but deterministic inputs: walking, sprinting, turning, jumps, charging a throw. */
function randomInputs(count: number, seed = 7): InputCmd[] {
  const rand = lcg(seed);
  const out: InputCmd[] = [];
  let yaw = 0;
  for (let i = 0; i < count; i++) {
    yaw += (rand() - 0.5) * 0.3;
    let buttons = 0;
    if (rand() < 0.08) buttons |= BTN.JUMP;
    if (rand() < 0.3) buttons |= BTN.SPRINT;
    if (rand() < 0.05) buttons |= BTN.SLOT_NEXT;
    if (rand() < 0.3) buttons |= BTN.THROW;
    out.push(cmd({ seq: i + 1, moveX: rand() * 2 - 1, moveZ: rand() * 2 - 1, yaw, pitch: rand() - 0.5, buttons }));
  }
  return out;
}

/** The reference: one straight stepPlayer run, returning the state after each input. */
function straightRun(start: PlayerSim, inputs: InputCmd[], ctx: SimContext): PlayerSim[] {
  const p = copyPlayerSim(start, spawnPlayer());
  const states = [copyPlayerSim(p, spawnPlayer())];
  for (const input of inputs) {
    stepPlayer(p, input, ctx);
    states.push(copyPlayerSim(p, spawnPlayer()));
  }
  return states;
}

function expectSameSim(actual: PlayerSimFields, expected: PlayerSimFields): void {
  for (const key of PLAYER_SIM_KEYS) expect([key, actual[key]]).toEqual([key, expected[key]]);
}

function armed(x = 0, z = 0, yaw = 0): PlayerSim {
  const p = spawnPlayer(x, z, yaw);
  p.inv0 = "coconut";
  p.inv1 = "stone";
  return p;
}

describe("Prediction", () => {
  it("is inactive until reset and ignores inputs while inactive", () => {
    const pred = new Prediction();
    expect(pred.active).toBe(false);
    const result = pred.predict(cmd({ seq: 1, moveZ: 1 }), simCtx(island));
    expect(result.throw).toBeNull();
    expect(pred.pendingCount).toBe(0);
  });

  it("predicts exactly like a straight stepPlayer run on the island", () => {
    const ctx = simCtx(island);
    const start = armed(1, 2, 0.3);
    const inputs = randomInputs(40);
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    expectSameSim(pred.current, states[40]!);
    expect(pred.pendingCount).toBe(40);
  });

  it("replays unacknowledged inputs on top of the server state (reconcile = straight run)", () => {
    const ctx = simCtx(island, "cocuk");
    const start = armed(-3, 4, 1.2);
    const inputs = randomInputs(50, 99);
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(playerView(start, 0, { character: "cocuk" }));
    for (const input of inputs) pred.predict(input, ctx);

    // The server has consumed the first 32 inputs.
    pred.reconcile(playerView(states[32]!, 32, { character: "cocuk" }), ctx);
    expectSameSim(pred.current, states[50]!);
    expect(pred.pendingCount).toBe(18);
    expect(pred.smoothingOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("collides with placed structures once the cover index knows them", () => {
    const cover = buildCover(island);
    const ctx = simCtx(island, "kaptan", false, cover);
    const start = spawnPlayer(0, 0, 0);
    // A fence 2 m ahead (yaw 0 faces -Z; the fence spans world x).
    cover.setStructures(mapOf(structureView({ id: "s1", kind: "fence", x: 0, y: 1, z: -2, yaw: 0 })).values());
    const inputs = Array.from({ length: 45 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const expected = straightRun(start, inputs, ctx)[45]!;
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    expectSameSim(pred.current, expected);
    pred.reconcile(playerView(start, 0), ctx);
    expectSameSim(pred.current, expected);
  });

  it("trims acknowledged inputs only", () => {
    const ctx = simCtx(island, "gelin");
    const start = spawnPlayer();
    const inputs = randomInputs(10, 3);
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(playerView(start, 0, { character: "gelin" }));
    for (const input of inputs) pred.predict(input, ctx);
    pred.reconcile(playerView(states[0]!, 0), ctx);
    expect(pred.pendingCount).toBe(10);
    pred.reconcile(playerView(states[4]!, 4), ctx);
    expect(pred.pendingCount).toBe(6);
    pred.reconcile(playerView(states[10]!, 10), ctx);
    expect(pred.pendingCount).toBe(0);
    expectSameSim(pred.current, states[10]!);
  });

  it("acknowledges by ackedSeq when given (stale lastSeq of a previous page)", () => {
    const ctx = simCtx(island);
    const start = spawnPlayer();
    const inputs = Array.from({ length: 6 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const expected = straightRun(start, inputs, ctx)[6]!;
    const pred = new Prediction();
    pred.reset(playerView(start, 9000));
    for (const input of inputs) pred.predict(input, ctx);
    pred.reconcile(playerView(start, 9000), ctx, { ackedSeq: 0 });
    expect(pred.pendingCount).toBe(6);
    expectSameSim(pred.current, expected);
  });

  it("caps the pending buffer at MAX_PENDING_INPUTS", () => {
    const ctx = simCtx(island);
    const pred = new Prediction();
    pred.reset(playerView(spawnPlayer(), 0));
    for (let seq = 1; seq <= MAX_PENDING_INPUTS + 25; seq++) pred.predict(cmd({ seq }), ctx);
    expect(pred.pendingCount).toBe(MAX_PENDING_INPUTS);
  });

  it("returns the first prediction's one-shots (a released throw)", () => {
    const ctx = simCtx(island);
    const pred = new Prediction();
    pred.reset(playerView(armed(), 0));
    for (let seq = 1; seq <= 10; seq++) expect(pred.predict(cmd({ seq, buttons: BTN.THROW }), ctx).throw).toBeNull();
    const release = pred.predict(cmd({ seq: 11 }), ctx);
    expect(release.throw).not.toBeNull();
    expect(release.throw?.kind).toBe("coconut");
    expect(release.throw?.toss).toBe(false);
    expect(release.throw?.charge).toBeGreaterThan(0);
  });

  it("turns a small server correction into a decaying visual offset", () => {
    const ctx = simCtx(island);
    const start = spawnPlayer();
    const inputs = randomInputs(20, 5).map((c) => ({ ...c, buttons: 0 }));
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    const before = { x: pred.current.x, z: pred.current.z };

    const server = copyPlayerSim(states[12]!, spawnPlayer());
    server.x += 0.5;
    pred.reconcile(playerView(server, 12), ctx);
    const out = spawnPlayer();
    pred.getRenderSim(1, 0, out);
    // Visually nothing jumps: render = corrected prediction + offset = the old prediction.
    expect(out.x).toBeCloseTo(before.x, 6);
    expect(out.z).toBeCloseTo(before.z, 6);
    expect(Math.abs(pred.smoothingOffset.x)).toBeGreaterThan(0.1);

    // One time constant later ~63% of the error is gone; after a second it is gone.
    const offset = pred.smoothingOffset.x;
    pred.getRenderSim(1, PREDICTION_SMOOTH_MS / 1000, out);
    expect(pred.smoothingOffset.x).toBeCloseTo(offset * Math.exp(-1), 6);
    pred.getRenderSim(1, 1, out);
    expect(Math.abs(pred.smoothingOffset.x)).toBeLessThan(1e-3);
  });

  it("snaps when the correction is larger than PREDICTION_SNAP_DIST", () => {
    const ctx = simCtx(island);
    const start = spawnPlayer();
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    for (let seq = 1; seq <= 5; seq++) pred.predict(cmd({ seq, moveZ: 1 }), ctx);
    const far = copyPlayerSim(start, spawnPlayer());
    far.x = 9;
    pred.reconcile(playerView(far, 0), ctx);
    expect(pred.smoothingOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("stops when the server says the player is not alive (washed ashore)", () => {
    const ctx = simCtx(island);
    const pred = new Prediction();
    pred.reset(playerView(spawnPlayer(), 0));
    pred.predict(cmd({ seq: 1 }), ctx);
    const washed = spawnPlayer();
    washed.alive = false;
    pred.reconcile(playerView(washed, 0, { washed: true }), ctx);
    expect(pred.active).toBe(false);
    expect(pred.pendingCount).toBe(0);
  });

  it("keeps the predicted lock of inputs during the landing wake-up", () => {
    const unlocked = simCtx(island);
    const locked = { ...unlocked, locked: true };
    const start = spawnPlayer();
    const inputs = Array.from({ length: 10 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    inputs.forEach((input, i) => pred.predict(input, i < 4 ? locked : unlocked));
    const expected = copyPlayerSim(start, spawnPlayer());
    inputs.forEach((input, i) => stepPlayer(expected, input, i < 4 ? locked : unlocked));
    expectSameSim(pred.current, expected);

    // Patch from the wake-up (lock still on there): each input keeps the lock it was predicted with.
    pred.reconcile(playerView(start, 0), locked);
    expectSameSim(pred.current, expected);

    // Patch after the unlock: every pending input is consumed after it, so all replay unlocked.
    pred.reconcile(playerView(start, 0), unlocked);
    expectSameSim(pred.current, straightRun(start, inputs, unlocked)[10]!);
  });

  it("replays everything locked when the lock won't end (launch / storm cinematics)", () => {
    const unlocked = simCtx(island);
    const locked = { ...unlocked, locked: true };
    const start = spawnPlayer();
    const inputs = Array.from({ length: 8 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    for (const input of inputs) pred.predict(input, unlocked);
    pred.reconcile(playerView(start, 0), locked, { trustPredictedLock: false });
    expectSameSim(pred.current, straightRun(start, inputs, locked)[8]!);
  });

  it("renders between the last two predicted ticks", () => {
    const ctx = simCtx(island);
    const pred = new Prediction();
    pred.reset(playerView(spawnPlayer(), 0));
    for (let seq = 1; seq <= 10; seq++) pred.predict(cmd({ seq, moveZ: 1 }), ctx);
    const a = copyPlayerSim(pred.current, spawnPlayer());
    pred.predict(cmd({ seq: 11, moveZ: 1 }), ctx);
    const b = pred.current;
    const out = spawnPlayer();
    pred.getRenderSim(0.25, 0, out);
    expect(out.z).toBeCloseTo(a.z + (b.z - a.z) * 0.25, 9);
    expect(out.vz).toBe(b.vz);
  });

  it("keeps `prev` one tick behind after a reconcile so rendering stays smooth", () => {
    const ctx = simCtx(island);
    const start = spawnPlayer();
    const inputs = Array.from({ length: 12 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(playerView(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    pred.reconcile(playerView(states[6]!, 6), ctx);
    const out = spawnPlayer();
    pred.getRenderSim(0.5, 0, out);
    expect(out.z).toBeCloseTo((states[11]!.z + states[12]!.z) / 2, 9);
  });

  it("takes read-only fields (inventory, bars, channel) from the server on reconcile", () => {
    const ctx = simCtx(island);
    const pred = new Prediction();
    pred.reset(playerView(spawnPlayer(), 0));
    pred.predict(cmd({ seq: 1 }), ctx);
    const server = armed();
    server.hunger = 12;
    pred.reconcile(playerView(server, 1), ctx);
    expect(pred.current.inv0).toBe("coconut");
    expect(pred.current.hunger).toBe(12);
  });
});
