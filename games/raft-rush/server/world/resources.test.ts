// Resource scarcity ramp + anti-soft-lock cache + visible DDA wiring (game4.md §6, §10; docs/ARCHITECTURE §4.3).
// Owner: server-world.

import { describe, expect, it } from "vitest";
import { BIOMES, DDA_RESOURCE_MULT, DIFFICULTIES, RESOURCE_CACHE_AT, RESOURCE_RAMP, stormWarnRungsTicks, STORM_WARN_LADDER_SEC, STORM_WARN_MIN_SEC } from "../../shared/constants.js";
import { raftCost } from "../../shared/items.js";
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
  it("steps 100 / 75 / 50 / 35 % of the island, and the DDA level scales it", () => {
    expect(resourceShareAt(0)).toBe(1);
    expect(resourceShareAt(0.39)).toBe(1);
    expect(resourceShareAt(0.4)).toBe(0.75);
    expect(resourceShareAt(0.64)).toBe(0.75);
    expect(resourceShareAt(0.65)).toBe(0.5);
    expect(resourceShareAt(0.86)).toBe(0.35);
    expect(resourceShareAt(0.99)).toBe(0.35);
    expect(resourceShareAt(0.5, DDA_RESOURCE_MULT.help)).toBeCloseTo(0.75 * DDA_RESOURCE_MULT.help);
    expect(resourceShareAt(0.5, DDA_RESOURCE_MULT.hard)).toBeCloseTo(0.75 * DDA_RESOURCE_MULT.hard);
    expect(RESOURCE_RAMP.map((r) => r.share)).toEqual([1, 0.75, 0.5, 0.35]);
  });

  it("caps live nodes as the buckets pass and drops one raft-shaped cache at 60 %", () => {
    const b = new Bench([["a"], ["b"]]);
    b.setClock(1, "day");
    b.tick();
    const full = nodeAmounts(b.world).slice();
    expect(full[NODE.tree]).toBeGreaterThan(1);

    // Into the 50 % bucket (day 3 day ≈ 66 % of the match).
    b.setClock(3, "day");
    const late = b.tick();
    const capped = nodeAmounts(b.world);
    expect(capped[NODE.tree]).toBe(Math.max(1, Math.ceil(full[NODE.tree]! * 0.5)));
    // Palm / bush amounts never drop below the RESOURCE_MIN_UNITS floor.
    expect(capped[NODE.palm]).toBeGreaterThanOrEqual(1);

    // The supply cache: exactly what the raft still needs, once.
    const evs = [...late, ...b.run(2)];
    const drops = b.of("supplyCache", evs);
    expect(drops).toHaveLength(1);
    const cost = raftCost(b.world.state.teams[0]!.seats, b.world.state.fast);
    const team = b.world.state.teams[0]!;
    const wantWood = Math.max(0, cost.hullWood - team.hullWood) + Math.max(0, cost.mastWood - team.mastWood);
    if (wantWood > 0) expect(drops[0]!.items.wood).toBeGreaterThan(0);
    expect(RESOURCE_CACHE_AT).toBeGreaterThan(0);
    // No second cache on later ticks.
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
