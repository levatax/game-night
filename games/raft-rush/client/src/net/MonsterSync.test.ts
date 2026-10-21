// Monster snapshot interpolation tests. Owner: client-net.

import { describe, expect, it } from "vitest";
import { MAX_EXTRAPOLATION_MS, TICK_RATE } from "../../../shared/constants";
import { MonsterSync, emptyMonsterFrame } from "./MonsterSync";
import { mapOf, monsterView } from "./testkit";

describe("MonsterSync", () => {
  it("returns false for unknown monsters and no frames when empty", () => {
    const sync = new MonsterSync();
    expect(sync.sample("m1", 10, emptyMonsterFrame("m1"))).toBe(false);
    expect(sync.frames(10)).toEqual([]);
  });

  it("lerps position and yaw between snapshots, speed from their distance", () => {
    const sync = new MonsterSync();
    sync.push("m1", 10, monsterView({ id: "m1", x: 0, z: 0, yaw: 3.0 }));
    sync.push("m1", 12, monsterView({ id: "m1", x: 0.2, z: 0, yaw: -3.0 }));
    const out = emptyMonsterFrame("m1");
    expect(sync.sample("m1", 11, out)).toBe(true);
    expect(out.x).toBeCloseTo(0.1);
    expect(Math.abs(out.yaw)).toBeCloseTo(Math.PI, 5);
    // 0.2 m over 2 ticks = 3 m/s (crab speed).
    expect(out.speed).toBeCloseTo((0.2 * TICK_RATE) / 2);
  });

  it("takes discrete fields from the older snapshot", () => {
    const sync = new MonsterSync();
    sync.push("m1", 10, monsterView({ id: "m1", mode: "hunt", hp: 2, targetId: "p1", carry: "" }));
    sync.push("m1", 12, monsterView({ id: "m1", mode: "flipped", hp: 0, targetId: "", carry: "fish_raw", modeTicks: 240 }));
    const out = emptyMonsterFrame("m1");
    sync.sample("m1", 11.9, out);
    expect(out).toMatchObject({ mode: "hunt", hp: 2, targetId: "p1", carry: "", modeTicks: 0, kind: "crab" });
    sync.sample("m1", 12, out);
    expect(out).toMatchObject({ mode: "flipped", hp: 0, carry: "fish_raw" });
  });

  it("extrapolates with the last snapshots' velocity for at most MAX_EXTRAPOLATION_MS", () => {
    const sync = new MonsterSync();
    sync.push("m1", 10, monsterView({ id: "m1", x: 0 }));
    sync.push("m1", 12, monsterView({ id: "m1", x: 0.4 }));
    const out = emptyMonsterFrame("m1");
    sync.sample("m1", 13, out);
    expect(out.x).toBeCloseTo(0.6);
    sync.sample("m1", 100, out);
    expect(out.x).toBeCloseTo(0.4 + 0.2 * ((MAX_EXTRAPOLATION_MS / 1000) * TICK_RATE));
  });

  it("holds a lone snapshot (no velocity known yet)", () => {
    const sync = new MonsterSync();
    sync.push("m1", 10, monsterView({ id: "m1", x: 2 }));
    const out = emptyMonsterFrame("m1");
    sync.sample("m1", 14, out);
    expect(out.x).toBe(2);
    expect(out.speed).toBe(0);
  });

  it("drops older snapshots on a teleport", () => {
    const sync = new MonsterSync();
    sync.push("m1", 10, monsterView({ id: "m1", x: -10 }));
    sync.push("m1", 12, monsterView({ id: "m1", x: 10 }));
    const out = emptyMonsterFrame("m1");
    sync.sample("m1", 11, out);
    expect(out.x).toBe(10);
  });

  it("follows the state: new monsters appear in state order, gone ones are forgotten", () => {
    const sync = new MonsterSync();
    sync.onServerState(mapOf(monsterView({ id: "m1", x: 1 }), monsterView({ id: "m2", kind: "boss", x: 2 })), 10);
    expect(sync.frames(10).map((f) => [f.id, f.kind])).toEqual([
      ["m1", "crab"],
      ["m2", "boss"],
    ]);
    sync.onServerState(mapOf(monsterView({ id: "m2", kind: "boss", x: 2.1 })), 12);
    expect(sync.frames(12).map((f) => f.id)).toEqual(["m2"]);
    expect(sync.size).toBe(1);
    sync.clear();
    expect(sync.frames(12)).toEqual([]);
  });

  it("reuses frame objects between calls", () => {
    const sync = new MonsterSync();
    sync.onServerState(mapOf(monsterView({ id: "m1" })), 10);
    const a = sync.frames(10)[0];
    sync.onServerState(mapOf(monsterView({ id: "m1", x: 0.1 })), 12);
    const b = sync.frames(11)[0];
    expect(b).toBe(a);
    expect(b?.x).toBeCloseTo(0.05);
  });
});
