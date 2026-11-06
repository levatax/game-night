// Frame helpers: crosshair ray vs terrain / sea, fish-spot and palm aiming (mirrors of the server rules), sea
// proximity, the ping board, the phase hint and the raft ride. Owner: client-app.

import { describe, expect, it } from "vitest";
import { MARKER_TICKS, TICK_MS, WATER_Y } from "../../../shared/constants";
import { dirFromYawPitch, yawFromDir } from "../../../shared/sim/math";
import { aimedFishSpot, crosshairHit, ease, LightBuffer, palmInReach, PhaseTracker, PingBoard, RaftRide, seaProximity } from "./frameHelpers";
import { testIsland } from "./testkit";

describe("crosshairHit", () => {
  it("hits flat land below the eye, the sea surface, or nothing", () => {
    const land = testIsland({ height: 1 });
    const out = { x: 0, y: 0, z: 0 };
    const eye = { x: 0, y: 2.55, z: 0 };
    expect(crosshairHit(land, eye, dirFromYawPitch(0, -Math.PI / 4), out)).toBe(true);
    expect(out.y).toBeCloseTo(1, 1);
    expect(out.z).toBeCloseTo(-1.55, 1);
    const sea = testIsland({ height: 1, seaFromX: 0, seaDepth: 3 });
    const fromShore = { x: -0.5, y: 2.55, z: 0 };
    expect(crosshairHit(sea, fromShore, dirFromYawPitch(-Math.PI / 2, -0.35), out)).toBe(true);
    expect(out.y).toBeCloseTo(WATER_Y, 3);
    expect(crosshairHit(land, eye, dirFromYawPitch(0, 0.5), out)).toBe(false);
  });
});

describe("aiming helpers", () => {
  it("finds the fish spot under the crosshair within cast range", () => {
    const def = testIsland({ height: 1, seaFromX: 2, seaDepth: 2 });
    def.fishSpots.push({ i: 0, x: 8, z: 0, island: 0 });
    const eye = { x: 0, y: 2.55, z: 0 };
    const look = dirFromYawPitch(yawFromDir(8, 0), Math.atan2(-2.55, 8));
    expect(aimedFishSpot(def, eye, look)).toBe(0);
    expect(aimedFishSpot(def, eye, dirFromYawPitch(0, -0.3))).toBe(-1);
  });

  it("finds a palm in reach inside the view cone", () => {
    const def = testIsland();
    def.nodes.push({ i: 0, kind: "palm", x: 0, z: -2, y: 1, radius: 0.3, height: 5, yield: "none", amount: 2, island: 0, yaw: 0, scale: 1, variant: 0 });
    expect(palmInReach(def, 0, 0, 0)?.i).toBe(0);
    expect(palmInReach(def, 0, 0, Math.PI)).toBeNull();
    expect(palmInReach(def, 0, 10, 0)).toBeNull();
  });

  it("sea proximity is 1 at the shore and fades inland", () => {
    const def = testIsland({ height: 1, seaFromX: 10 });
    def.sites[0]!.shore.push({ x: 10, z: 0 });
    expect(seaProximity(def, 9, 0, 1)).toBe(1);
    expect(seaProximity(def, -20, 0, 1)).toBe(0);
    const mid = seaProximity(def, -4, 0, 1);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(seaProximity(def, 12, 0, -0.5)).toBe(1);
  });
});

describe("small state helpers", () => {
  it("PingBoard keeps one mark per player for MARKER_TICKS", () => {
    const board = new PingBoard();
    board.add({ tick: 0, playerId: "a", kind: "here", pos: { x: 1, y: 0, z: 2 }, need: "" }, 0);
    board.add({ tick: 0, playerId: "a", kind: "danger", pos: { x: 3, y: 0, z: 4 }, need: "" }, 10);
    board.add({ tick: 0, playerId: "b", kind: "need", pos: { x: 0, y: 0, z: 0 }, need: "wood" }, 20);
    expect(board.active(100).map((m) => m.kind)).toEqual(["danger", "need"]);
    expect(board.active(MARKER_TICKS * TICK_MS + 15).map((m) => m.playerId)).toEqual(["b"]);
    expect(board.active(MARKER_TICKS * TICK_MS + 25)).toEqual([]);
  });

  it("PhaseTracker holds an announced phase until a newer patch arrives", () => {
    const p = new PhaseTracker();
    p.announce("landing", 100);
    expect(p.effective({ phase: "lobby", tick: 99 })).toBe("landing");
    expect(p.effective({ phase: "lobby", tick: 100 })).toBe("landing");
    expect(p.effective({ phase: "landing", tick: 101 })).toBe("landing");
    expect(p.effective({ phase: "playing", tick: 400 })).toBe("playing");
    p.announce("matchEnd", 500);
    expect(p.effective({ phase: "playing", tick: 501 })).toBe("playing");
  });

  it("RaftRide carries a seat along the sailing raft (translation + rotation)", () => {
    const ride = new RaftRide();
    ride.setRest({ x: 10, y: 0.5, z: 0, yaw: 0 });
    const seat = { x: 11, y: 0.9, z: 0, yaw: 0 };
    ride.carry(seat);
    expect(seat).toEqual({ x: 11, y: 0.9, z: 0, yaw: 0 }); // not sailing yet
    ride.setCurrent({ x: 30, y: 0.7, z: 0, yaw: Math.PI / 2 });
    ride.carry(seat);
    expect(seat.x).toBeCloseTo(30);
    expect(seat.z).toBeCloseTo(-1);
    expect(seat.y).toBeCloseTo(1.1);
    expect(seat.yaw).toBeCloseTo(Math.PI / 2);
  });

  it("RaftRide lifts a seat with the raft's pitch and roll", () => {
    const ride = new RaftRide();
    ride.setRest({ x: 0, y: 0, z: 0, yaw: 0 });
    // Bow seat (local −Z) rises with bow-up pitch; starboard seat (local +X) sinks with roll.
    ride.setCurrent({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0.1, roll: 0 });
    const bow = { x: 0, y: 1, z: -2 };
    ride.carry(bow);
    expect(bow.y).toBeCloseTo(1 + 2 * Math.sin(0.1));
    ride.setCurrent({ x: 0, y: 0, z: 0, yaw: 0, pitch: 0, roll: 0.1 });
    const star = { x: 1, y: 1, z: 0 };
    ride.carry(star);
    expect(star.y).toBeCloseTo(1 - Math.sin(0.1));
  });

  it("LightBuffer pools entries; ease clamps", () => {
    const l = new LightBuffer();
    l.add(1, 2, 3, 4, 1);
    const first = l.list[0];
    l.reset();
    l.add(5, 6, 7, 4, 0.5);
    expect(l.list).toHaveLength(1);
    expect(l.list[0]).toBe(first);
    expect(l.list[0]).toMatchObject({ x: 5, intensity: 0.5 });
    expect(ease(-1)).toBe(0);
    expect(ease(2)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
  });
});
