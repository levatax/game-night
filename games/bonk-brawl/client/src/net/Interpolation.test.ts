import { describe, expect, it } from "vitest";
import { MAX_EXTRAPOLATION_MS, TICK_RATE } from "../../../shared/constants";
import { createPlayerSim, type PlayerSim } from "../../../shared/sim/player";
import { Interpolation } from "./Interpolation";

function snap(fields: Partial<PlayerSim>): PlayerSim {
  return { ...createPlayerSim(), alive: true, ...fields };
}

describe("Interpolation", () => {
  it("returns false for unknown players", () => {
    const interp = new Interpolation();
    expect(interp.sample("nobody", 10, createPlayerSim())).toBe(false);
  });

  it("lerps positions and velocities between the surrounding snapshots", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 0, y: 0, z: 0, vx: 2 }));
    interp.push("a", 12, snap({ x: 1.2, y: 0.4, z: -0.8, vx: 4 }));
    const out = createPlayerSim();
    expect(interp.sample("a", 11.5, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.9);
    expect(out.y).toBeCloseTo(0.3);
    expect(out.z).toBeCloseTo(-0.6);
    expect(out.vx).toBeCloseTo(3.5);
  });

  it("takes discrete fields from the older snapshot", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ chargeTicks: 5, grounded: true, heldCount: 1, powerUp: "mega" }));
    interp.push("a", 12, snap({ chargeTicks: 7, grounded: false, heldCount: 0, powerUp: "" }));
    const out = createPlayerSim();
    interp.sample("a", 11.9, out);
    expect(out.chargeTicks).toBe(5);
    expect(out.grounded).toBe(true);
    expect(out.heldCount).toBe(1);
    expect(out.powerUp).toBe("mega");
  });

  it("interpolates yaw along the shortest arc across ±PI", () => {
    const interp = new Interpolation();
    interp.push("a", 0, snap({ yaw: 3.0 }));
    interp.push("a", 2, snap({ yaw: -3.0 }));
    const out = createPlayerSim();
    interp.sample("a", 1, out);
    // Halfway between 3.0 and -3.0 the short way is ±PI, not 0.
    expect(Math.abs(out.yaw)).toBeCloseTo(Math.PI, 5);
    interp.sample("a", 0.5, out);
    expect(out.yaw).toBeCloseTo(3.0 + (2 * Math.PI - 6) / 4, 5);
  });

  it("holds the oldest snapshot before the buffer starts", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 1 }));
    interp.push("a", 12, snap({ x: 3 }));
    const out = createPlayerSim();
    interp.sample("a", 5, out);
    expect(out.x).toBe(1);
  });

  it("extrapolates past the newest snapshot for at most MAX_EXTRAPOLATION_MS", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 0, vx: 6, vz: -3 }));
    const out = createPlayerSim();
    interp.sample("a", 11, out);
    expect(out.x).toBeCloseTo(6 / TICK_RATE);
    expect(out.z).toBeCloseTo(-3 / TICK_RATE);
    interp.sample("a", 100, out);
    expect(out.x).toBeCloseTo((6 * MAX_EXTRAPOLATION_MS) / 1000);
  });

  it("never extrapolates ghosts", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 4, vx: 6, alive: false }));
    const out = createPlayerSim();
    interp.sample("a", 13, out);
    expect(out.x).toBe(4);
  });

  it("ignores snapshots that are not newer than the newest", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 1 }));
    interp.push("a", 10, snap({ x: 50 }));
    interp.push("a", 8, snap({ x: 60 }));
    const out = createPlayerSim();
    interp.sample("a", 10, out);
    expect(out.x).toBe(1);
    expect(interp.newestTick("a")).toBe(10);
  });

  it("drops older snapshots on a respawn (alive false → true)", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 0, alive: false }));
    interp.push("a", 12, snap({ x: 1, alive: true }));
    const out = createPlayerSim();
    interp.sample("a", 11, out);
    expect(out.x).toBe(1);
  });

  it("drops older snapshots on a teleport instead of sliding across the island", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: -10 }));
    interp.push("a", 12, snap({ x: 10 }));
    const out = createPlayerSim();
    interp.sample("a", 11, out);
    expect(out.x).toBe(10);
  });

  it("keeps sliding normally over a legal distance", () => {
    const interp = new Interpolation();
    interp.push("a", 10, snap({ x: 0 }));
    interp.push("a", 12, snap({ x: 1.5 }));
    const out = createPlayerSim();
    interp.sample("a", 11, out);
    expect(out.x).toBeCloseTo(0.75);
  });

  it("keeps about one second of history", () => {
    const interp = new Interpolation();
    for (let tick = 0; tick <= 120; tick += 2) interp.push("a", tick, snap({ x: tick * 0.01 }));
    const out = createPlayerSim();
    // Ticks older than ~1 s were trimmed: sampling far back clamps to the oldest kept snapshot.
    interp.sample("a", 0, out);
    expect(out.x).toBeGreaterThanOrEqual((120 - TICK_RATE) * 0.01 - 1e-9);
  });

  it("forgets removed players and everything on clear", () => {
    const interp = new Interpolation();
    interp.push("a", 1, snap({}));
    interp.push("b", 1, snap({}));
    interp.remove("a");
    const out = createPlayerSim();
    expect(interp.sample("a", 1, out)).toBe(false);
    expect(interp.sample("b", 1, out)).toBe(true);
    interp.clear();
    expect(interp.sample("b", 1, out)).toBe(false);
  });
});
