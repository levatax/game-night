import { describe, expect, it } from "vitest";
import { MAX_PENDING_INPUTS, PREDICTION_SMOOTH_MS } from "../../../shared/constants";
import { BTN, type InputCmd } from "../../../shared/protocol";
import type { SimContext } from "../../../shared/sim/context";
import { PLAYER_SIM_KEYS, copyPlayerSim, stepPlayer, type PlayerSim } from "../../../shared/sim/player";
import { cmd, lcg, simCtx, spawnPlayer } from "../../../shared/sim/testkit";
import type { CharacterId, PlayerSimFields, PlayerView } from "../../../shared/types";
import { Prediction } from "./Prediction";

function view(sim: PlayerSimFields, lastSeq: number, character: CharacterId = "quacky"): PlayerView {
  return {
    ...copyPlayerSim(sim, spawnPlayer()),
    id: "me",
    nickname: "Me",
    character,
    slot: 0,
    ready: false,
    connected: true,
    spectator: false,
    ping: 0,
    hearts: 3,
    points: 0,
    roundPoints: 0,
    place: 0,
    lastSeq,
    stats: { throws: 0, hits: 0, catches: 0, ringOuts: 0, kos: 0, roundWins: 0 },
  };
}

/** Varied but deterministic inputs: running, turning, jumps, rolls, charging. */
function randomInputs(count: number, seed = 7): InputCmd[] {
  const rand = lcg(seed);
  const out: InputCmd[] = [];
  let yaw = 0;
  for (let i = 0; i < count; i++) {
    yaw += (rand() - 0.5) * 0.3;
    let buttons = 0;
    if (rand() < 0.08) buttons |= BTN.JUMP;
    if (rand() < 0.04) buttons |= BTN.ROLL;
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

describe("Prediction", () => {
  it("is inactive until reset and ignores inputs while inactive", () => {
    const pred = new Prediction();
    expect(pred.active).toBe(false);
    const result = pred.predict(cmd({ seq: 1, moveZ: 1 }), simCtx("quacky"));
    expect(result.throw).toBeNull();
    expect(pred.pendingCount).toBe(0);
  });

  it("predicts exactly like a straight stepPlayer run", () => {
    const ctx = simCtx("quacky");
    const start = spawnPlayer(1, 2, 0.3);
    start.heldCount = 1;
    const inputs = randomInputs(40);
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(view(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    expectSameSim(pred.current, states[40]);
    expect(pred.pendingCount).toBe(40);
  });

  it("replays unacknowledged inputs on top of the server state (reconcile = straight run)", () => {
    const ctx = simCtx("hopsworth");
    const start = spawnPlayer(-3, 4, 1.2);
    start.heldCount = 1;
    const inputs = randomInputs(50, 99);
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(view(start, 0, "hopsworth"));
    for (const input of inputs) pred.predict(input, ctx);

    // The server has consumed the first 32 inputs.
    pred.reconcile(view(states[32], 32, "hopsworth"), ctx);
    expectSameSim(pred.current, states[50]);
    expect(pred.pendingCount).toBe(18);
    expect(pred.smoothingOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("trims acknowledged inputs only", () => {
    const ctx = simCtx("pip");
    const start = spawnPlayer();
    const inputs = randomInputs(10, 3);
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(view(start, 0, "pip"));
    for (const input of inputs) pred.predict(input, ctx);
    pred.reconcile(view(states[0], 0, "pip"), ctx);
    expect(pred.pendingCount).toBe(10);
    pred.reconcile(view(states[4], 4, "pip"), ctx);
    expect(pred.pendingCount).toBe(6);
    pred.reconcile(view(states[10], 10, "pip"), ctx);
    expect(pred.pendingCount).toBe(0);
    expectSameSim(pred.current, states[10]);
  });

  it("caps the pending buffer at MAX_PENDING_INPUTS", () => {
    const ctx = simCtx("quacky");
    const pred = new Prediction();
    pred.reset(view(spawnPlayer(), 0));
    for (let seq = 1; seq <= MAX_PENDING_INPUTS + 25; seq++) pred.predict(cmd({ seq }), ctx);
    expect(pred.pendingCount).toBe(MAX_PENDING_INPUTS);
  });

  it("turns a small server correction into a decaying visual offset", () => {
    const ctx = simCtx("quacky");
    const start = spawnPlayer();
    const inputs = randomInputs(20, 5).map((c) => ({ ...c, buttons: 0 }));
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(view(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    const before = { x: pred.current.x, z: pred.current.z };

    const server = copyPlayerSim(states[12], spawnPlayer());
    server.x += 0.5;
    pred.reconcile(view(server, 12), ctx);
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
    const ctx = simCtx("quacky");
    const start = spawnPlayer();
    const pred = new Prediction();
    pred.reset(view(start, 0));
    for (let seq = 1; seq <= 5; seq++) pred.predict(cmd({ seq, moveZ: 1 }), ctx);
    const far = copyPlayerSim(start, spawnPlayer());
    far.x = 6;
    pred.reconcile(view(far, 0), ctx);
    expect(pred.smoothingOffset).toEqual({ x: 0, y: 0, z: 0 });
  });

  it("stops when the server says the player is not alive", () => {
    const ctx = simCtx("quacky");
    const pred = new Prediction();
    pred.reset(view(spawnPlayer(), 0));
    pred.predict(cmd({ seq: 1 }), ctx);
    const dead = spawnPlayer();
    dead.alive = false;
    pred.reconcile(view(dead, 0), ctx);
    expect(pred.active).toBe(false);
    expect(pred.pendingCount).toBe(0);
  });

  it("replays inputs predicted as unlocked unlocked even while the server is still in countdown", () => {
    const unlocked = simCtx("quacky");
    const locked = simCtx("quacky", unlocked.arena, unlocked.rings, true);
    const start = spawnPlayer();
    const inputs = Array.from({ length: 10 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const pred = new Prediction();
    pred.reset(view(start, 0));
    inputs.forEach((input, i) => pred.predict(input, i < 4 ? locked : unlocked));
    const expected = copyPlayerSim(start, spawnPlayer());
    inputs.forEach((input, i) => stepPlayer(expected, input, i < 4 ? locked : unlocked));
    expectSameSim(pred.current, expected);

    // Patch from the countdown (naive lock = true): each input keeps the lock it was predicted with.
    pred.reconcile(view(start, 0), locked);
    expectSameSim(pred.current, expected);

    // Patch from "playing": every pending input is consumed after it, so all replay unlocked.
    pred.reconcile(view(start, 0), unlocked);
    const allUnlocked = straightRun(start, inputs, unlocked)[10];
    expectSameSim(pred.current, allUnlocked);
  });

  it("renders between the last two predicted ticks", () => {
    const ctx = simCtx("quacky");
    const pred = new Prediction();
    pred.reset(view(spawnPlayer(), 0));
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
    const ctx = simCtx("quacky");
    const start = spawnPlayer();
    const inputs = Array.from({ length: 12 }, (_, i) => cmd({ seq: i + 1, moveZ: 1 }));
    const states = straightRun(start, inputs, ctx);
    const pred = new Prediction();
    pred.reset(view(start, 0));
    for (const input of inputs) pred.predict(input, ctx);
    pred.reconcile(view(states[6], 6), ctx);
    const out = spawnPlayer();
    pred.getRenderSim(0.5, 0, out);
    expect(out.z).toBeCloseTo((states[11].z + states[12].z) / 2, 9);
  });
});
