// TowerSim sanity tests: stacking rests, round things roll off edges, the tower grows, clear() wipes it.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAKE_RADIUS, CAKE_TOP_Y, TICK_HZ } from "../../shared/constants.js";
import type { Pose } from "../../shared/protocol.js";
import { TowerSim, type SpawnMods } from "./TowerSim.js";

const PLAIN: SpawnMods = { scale: 1, massScale: 1, glue: false, card: "plain" };
const DT = 1 / TICK_HZ;

function pose(x: number, y: number, z: number): Pose {
  return { x, y, z, qx: 0, qy: 0, qz: 0, qw: 1 };
}

/** Steps until everything sleeps (or `maxSec`), returns whether it settled. */
function settle(sim: TowerSim, maxSec = 4): boolean {
  for (let t = 0; t < maxSec; t += DT) {
    sim.step(DT);
    if (t > 0.3 && sim.allAsleep()) return true;
  }
  return sim.allAsleep();
}

describe("TowerSim", () => {
  let sim: TowerSim;
  beforeEach(async () => {
    sim = await TowerSim.create();
  });
  afterEach(() => sim.dispose());

  it("rests a toaster dropped on the cake center", () => {
    sim.spawn("toaster", "a", pose(0, sim.minHoverY("toaster", 1), 0), PLAIN);
    const impacts: number[] = [];
    let settled = false;
    for (let t = 0; t < 4 && !settled; t += DT) {
      impacts.push(...sim.step(DT).map((i) => i.speed));
      settled = t > 0.3 && sim.allAsleep();
    }
    expect(settled).toBe(true);
    expect(sim.toppled()).toBeNull();
    expect(impacts.length).toBeGreaterThan(0); // CLANK
    const p = sim.pieces()[0];
    expect(p.pose.y).toBeGreaterThan(CAKE_TOP_Y);
    expect(p.pose.y).toBeLessThan(CAKE_TOP_Y + 0.1);
  });

  it("topples a watermelon dropped at the cake edge", () => {
    sim.spawn("watermelon", "a", pose(CAKE_RADIUS + 0.02, sim.minHoverY("watermelon", 1), 0), PLAIN);
    let toppled = false;
    for (let t = 0; t < 4 && !toppled; t += DT) {
      sim.step(DT);
      toppled = sim.toppled() !== null;
    }
    expect(toppled).toBe(true);
  });

  it("grows towerTop when stacking two pieces", () => {
    expect(sim.towerTop()).toBe(0);
    sim.spawn("toaster", "a", pose(0, sim.minHoverY("toaster", 1), 0), PLAIN);
    expect(settle(sim)).toBe(true);
    const one = sim.towerTop();
    expect(one).toBeGreaterThan(0.13);
    expect(one).toBeLessThan(0.17);
    sim.spawn("cheese", "b", pose(0, sim.minHoverY("cheese", 1), 0), PLAIN);
    expect(settle(sim)).toBe(true);
    expect(sim.toppled()).toBeNull();
    expect(sim.towerTop()).toBeGreaterThan(one + 0.06);
  });

  it("clear() empties the tower", () => {
    sim.spawn("toaster", "a", pose(0, sim.minHoverY("toaster", 1), 0), PLAIN);
    sim.spawn("donut", "b", pose(0.1, 0.9, 0), PLAIN);
    settle(sim, 1);
    sim.clear();
    expect(sim.pieces()).toHaveLength(0);
    expect(sim.towerTop()).toBe(0);
    expect(sim.allAsleep()).toBe(true);
    expect(sim.toppled()).toBeNull();
  });

  it("glues a Glue Gun piece to whatever it touches first", () => {
    sim.spawn("toaster", "a", pose(0, sim.minHoverY("toaster", 1), 0), PLAIN);
    settle(sim);
    sim.spawn("soap", "b", pose(0.05, sim.minHoverY("soap", 1), 0), { ...PLAIN, glue: true, card: "glueGun" });
    settle(sim);
    sim.quake(1);
    settle(sim);
    expect(sim.toppled()).toBeNull();
  });

  it("survives wind, moon gravity and a quake without crashing", () => {
    sim.spawn("pancakes", "a", pose(0, sim.minHoverY("pancakes", 1), 0), PLAIN);
    sim.setWind(1, 0, 1);
    sim.setGravityScale(0.4);
    sim.quake(1);
    for (let i = 0; i < TICK_HZ * 2; i++) sim.step(DT);
    sim.setWind(0, 0, 0);
    sim.setGravityScale(1);
    expect(Number.isFinite(sim.pieces()[0].pose.y)).toBe(true);
  });
});
