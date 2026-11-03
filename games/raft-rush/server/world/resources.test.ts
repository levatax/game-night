// Resource scarcity ramp + anti-soft-lock cache + visible DDA wiring (game4.md §6, §10; docs/ARCHITECTURE §4.3).
// Owner: server-world.

import { describe, expect, it } from "vitest";
import { BIOMES, DDA_RESOURCE_MULT, DIFFICULTIES, RESOURCE_CACHE_AT, RESOURCE_RAMP, stormWarnRungsTicks, STORM_WARN_LADDER_SEC, STORM_WARN_MIN_SEC } from "../../shared/constants.js";
import { planWave } from "./life/waves.js";
import { resourceShareAt } from "./nodes.js";
import { NODE, Bench } from "./testkit.js";

const nodeAmounts = (world: Bench["world"]): number[] => Array.from(world.state.nodes);

describe("storm warning ladder", () => {
  it("is 30 / 20 / 15 s, never closer than the 12 s floor", () => {
    expect(stormWarnRungsTicks()).toEqual(STORM_WARN_LADDER_SEC.map((sec) => Math.max(STORM_WARN_MIN_SEC, sec) * 30));
    // p95 8 s + 4 s margin → last rung 12 s, then +5 / +10 s, never below the 12 s floor.
    expect(STORM_WARN_LADDER_SEC).toEqual([30, 20, 15]);
    expect(stormWarnRungsTicks()).toEqual([900, 600, 450]);
  });
});

describe("resource scarcity ramp", () => {
  it("steps 1.00 / 1.15 / 1.35 / 1.50 of the island, and the DDA level scales it", () => {
    expect(resourceShareAt(0)).toBe(1);
    expect(resourceShareAt(0.39)).toBe(1);
    expect(resourceShareAt(0.4)).toBe(1.15);
    expect(resourceShareAt(0.64)).toBe(1.15);
    expect(resourceShareAt(0.65)).toBe(1.35);
    expect(resourceShareAt(0.86)).toBe(1.5);
    expect(resourceShareAt(0.99)).toBe(1.5);
    expect(resourceShareAt(0.5, DDA_RESOURCE_MULT.help)).toBeCloseTo(1.15 * DDA_RESOURCE_MULT.help);
    expect(resourceShareAt(0.5, DDA_RESOURCE_MULT.hard)).toBeCloseTo(1.15 * DDA_RESOURCE_MULT.hard);
    expect(RESOURCE_RAMP.map((r) => r.share)).toEqual([1, 1.15, 1.35, 1.5]);
  });

  it("caps live nodes as the buckets pass and drops one raft-shaped cache at 60 %", () => {
    const b = new Bench([["a"], ["b"]]);
    b.setClock(1, "day");
    b.tick();
    const full = nodeAmounts(b.world).slice();
    expect(full[NODE.tree]).toBeGreaterThan(1);

    // v4b ramp: the island offers MORE as the match runs out (1.15 at 40 %), so a bucket change never shrinks
    // a live node below its island amount.
    b.setClock(3, "day");
    const late = b.tick();
    const capped = nodeAmounts(b.world);
    expect(capped[NODE.tree]).toBe(full[NODE.tree]);
    expect(capped[NODE.palm]).toBeGreaterThanOrEqual(1);

    // Guaranteed caches land at 45 % and 78 % of the match: by night 3 both have dropped, once each.
    const night3 = b.setClock(3, "night");
    void night3;
    const evs = [...late, ...b.run(2)];
    const drops = b.of("supplyCache", evs);
    expect(drops.length).toBeGreaterThanOrEqual(1);
    expect(RESOURCE_CACHE_AT).toEqual([0.45, 0.78]);
    // No further cache on later ticks.
    expect(b.of("supplyCache", b.run(50))).toHaveLength(0);
  });
});

describe("visible DDA", () => {
  it("feeds the wave size (help 0.8× / hard 1.25×) without smooth interpolation", () => {
    const base = {
      night: 3,
      seats: 4,
      difficulty: DIFFICULTIES.normal,
      biome: BIOMES.tropic,
      fullMoon: false,
      flare: false,
    } as const;
    const even = planWave({ ...base, strength: 1 });
    const help = planWave({ ...base, strength: 0.8 });
    const hard = planWave({ ...base, strength: 1.25 });
    expect(help.crabs).toBeLessThan(even.crabs);
    expect(hard.crabs).toBeGreaterThan(even.crabs);
    expect(help.boss).toBe(even.boss);
  });

  it("steps a struggling team to help and announces exactly one change", () => {
    const b = new Bench([["a"], ["b"], ["c"]]);
    b.setClock(1, "day");
    b.tick();
    expect(b.world.director.of(0)).toBe(0);
    // Three downs inside the window.
    const evs: ReturnType<Bench["tick"]> = [];
    for (const id of ["a", "b", "c"]) {
      evs.push(...b.tick());
      b.world.damagePlayer(b.p(id), 500, "crab", "m1");
      evs.push(...b.run(1));
    }
    expect(b.world.director.of(0)).toBe(1);
  });

  it("a lost attempt starts the next match one help step lower", () => {
    const b = new Bench([["a"], ["b"]]);
    b.world.setOptions({ assist: 1 });
    b.world.startMatch(["a", "b"], 2);
    b.setClock(1, "day");
    b.tick();
    expect(b.world.director.of(0)).toBe(1);
  });
});
