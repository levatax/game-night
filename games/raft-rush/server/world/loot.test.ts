// Loot tables, pity and reel strips (server/world/loot.ts). Owner: server-world-life.

import { describe, expect, it } from "vitest";
import { BIOMES, FISH_PITY } from "../../shared/constants.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { FISH_JUNK, FISH_LOOT, TREASURE_LOOT, fishLootFor } from "../../shared/items.js";
import type { Biome, FishLoot, TreasureId } from "../../shared/types.js";
import {
  FISH_REEL_LENGTH,
  LOOT_JITTER,
  PITY_EXCLUDE,
  TREASURE_REEL_LENGTH,
  baseFishLootTable,
  fishLootTable,
  fishReel,
  isJunk,
  lootChances,
  nextJunkStreak,
  rollFish,
  rollTreasure,
  treasureReel,
} from "./loot.js";

const BIOME_LIST: Biome[] = ["tropic", "rocky", "swamp", "volcanic"];

describe("fishLootTable", () => {
  it("is the same table for the same seed and biome, different for another seed", () => {
    expect(fishLootTable(4471, "swamp")).toEqual(fishLootTable(4471, "swamp"));
    expect(fishLootTable(4471, "swamp")).not.toEqual(fishLootTable(9023, "swamp"));
  });

  it("keeps every weight within ±20% of the biome-adjusted base weight", () => {
    for (const biome of BIOME_LIST) {
      const base = fishLootFor(BIOMES[biome].loot);
      for (let seed = 1; seed < 200; seed++) {
        const table = fishLootTable(seed * 7919, biome);
        expect(table.map((e) => e.id)).toEqual(FISH_LOOT.map((e) => e.id));
        table.forEach((e, i) => {
          const w = base[i]!.weight;
          expect(e.weight).toBeGreaterThanOrEqual(w * (1 - LOOT_JITTER) - 1e-9);
          expect(e.weight).toBeLessThanOrEqual(w * (1 + LOOT_JITTER) + 1e-9);
        });
      }
    }
  });

  it("applies the biome multipliers (swamp jellyfish ×2, rocky treasure ×1.5)", () => {
    const base = baseFishLootTable();
    const swamp = fishLootFor(BIOMES.swamp.loot);
    const rocky = fishLootFor(BIOMES.rocky.loot);
    const w = (t: { id: FishLoot; weight: number }[], id: FishLoot) => t.find((e) => e.id === id)!.weight;
    expect(w(swamp, "jellyfish")).toBe(w(base, "jellyfish") * 2);
    expect(w(rocky, "treasure")).toBe(w(base, "treasure") * 1.5);
    expect(w(rocky, "fish")).toBe(w(base, "fish"));
  });
});

describe("rollFish distribution", () => {
  for (const biome of ["tropic", "swamp", "rocky"] as Biome[]) {
    it(`matches the ${biome} table's weights over 10k rolls`, () => {
      const table = fishLootTable(2024, biome);
      const chances = lootChances(table);
      const rng = mulberry32(99);
      const counts = new Map<FishLoot, number>();
      const N = 10_000;
      for (let k = 0; k < N; k++) {
        const r = rollFish(table, rng, 0);
        expect(r.pity).toBe(false);
        counts.set(r.loot, (counts.get(r.loot) ?? 0) + 1);
      }
      for (const e of table) {
        const p = chances[e.id];
        const got = (counts.get(e.id) ?? 0) / N;
        // 4 standard deviations of a binomial proportion (plus a hair for the rarest entries).
        const tol = 4 * Math.sqrt((p * (1 - p)) / N) + 0.002;
        expect(Math.abs(got - p)).toBeLessThan(tol);
      }
    });
  }

  it("swamp catches about twice the jellyfish share of tropic", () => {
    const share = (biome: Biome) => {
      const t = fishLootFor(BIOMES[biome].loot);
      const total = t.reduce((s, e) => s + e.weight, 0);
      return t.find((e) => e.id === "jellyfish")!.weight / total;
    };
    expect(share("swamp") / share("tropic")).toBeGreaterThan(1.8);
  });
});

describe("bad-luck protection", () => {
  it(`guarantees at least a fish after ${FISH_PITY} junk catches in a row`, () => {
    const table = baseFishLootTable();
    // r = 0.65 lands on "boot" in the base table (fish 45 + crab 12 = 57 < 62.4 < 67).
    const rigged = () => 0.65;
    let streak = 0;
    const seen: FishLoot[] = [];
    for (let k = 0; k < FISH_PITY; k++) {
      const r = rollFish(table, rigged, streak);
      expect(r.loot).toBe("boot");
      expect(r.pity).toBe(false);
      streak = nextJunkStreak(streak, r.loot);
      seen.push(r.loot);
    }
    expect(streak).toBe(FISH_PITY);
    const saved = rollFish(table, rigged, streak);
    expect(saved.pity).toBe(true);
    expect(PITY_EXCLUDE.has(saved.loot)).toBe(false);
    expect(isJunk(saved.loot)).toBe(false);
    expect(nextJunkStreak(streak, saved.loot)).toBe(0);
  });

  it("never lets more than FISH_PITY junk catches happen in a row (10k random casts)", () => {
    const table = fishLootTable(5, "swamp");
    const rng = mulberry32(3);
    let streak = 0;
    let longest = 0;
    for (let k = 0; k < 10_000; k++) {
      const r = rollFish(table, rng, streak);
      if (r.pity) expect(FISH_JUNK.includes(r.loot)).toBe(false);
      streak = nextJunkStreak(streak, r.loot);
      longest = Math.max(longest, streak);
    }
    expect(longest).toBeLessThanOrEqual(FISH_PITY);
  });

  it("pity never hands out a puffer (it would explode in your hand)", () => {
    const rng = mulberry32(11);
    for (let k = 0; k < 2000; k++) expect(rollFish(baseFishLootTable(), rng, FISH_PITY).loot).not.toBe("puffer");
  });
});

describe("reel strips", () => {
  it("the fish reel stops at the catch", () => {
    const table = fishLootTable(77, "rocky");
    const rng = mulberry32(8);
    for (let k = 0; k < 500; k++) {
      const { loot } = rollFish(table, rng, 0);
      const { reel, stopIndex } = fishReel(rng, table, loot);
      expect(reel).toHaveLength(FISH_REEL_LENGTH);
      expect(reel[stopIndex]).toBe(loot);
      for (const id of reel) expect(FISH_LOOT.some((e) => e.id === id)).toBe(true);
    }
  });

  it("sometimes parks a shiny catch next to a plain one (the near miss)", () => {
    const table = baseFishLootTable();
    const rng = mulberry32(21);
    let teases = 0;
    for (let k = 0; k < 400; k++) {
      const { reel, stopIndex } = fishReel(rng, table, "boot");
      const n = [reel[stopIndex - 1], reel[stopIndex + 1]];
      if (n.includes("golden") || n.includes("treasure") || n.includes("kraken")) teases++;
    }
    expect(teases).toBeGreaterThan(60);
    expect(teases).toBeLessThan(300);
  });

  it("the treasure reel stops at the treasure with distinct neighbours", () => {
    const rng = mulberry32(5);
    for (let k = 0; k < 300; k++) {
      const t = rollTreasure(rng);
      const { reel, stopIndex } = treasureReel(rng, t);
      expect(reel).toHaveLength(TREASURE_REEL_LENGTH);
      expect(reel[stopIndex]).toBe(t);
      expect(reel[stopIndex - 1]).not.toBe(t);
      expect(reel[stopIndex + 1]).not.toBe(t);
    }
  });
});

describe("treasure table", () => {
  it("rolls every treasure about equally", () => {
    const rng = mulberry32(13);
    const counts = new Map<TreasureId, number>();
    for (let k = 0; k < 5000; k++) {
      const t = rollTreasure(rng);
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    for (const e of TREASURE_LOOT) expect((counts.get(e.id) ?? 0) / 5000).toBeGreaterThan(0.15);
  });

  it("skips excluded treasures, but still rolls something when all are excluded", () => {
    const rng = mulberry32(17);
    const ex = new Set<TreasureId>(["flare", "old_sail"]);
    for (let k = 0; k < 500; k++) expect(ex.has(rollTreasure(rng, ex))).toBe(false);
    const all = new Set<TreasureId>(TREASURE_LOOT.map((e) => e.id));
    expect(TREASURE_LOOT.map((e) => e.id)).toContain(rollTreasure(rng, all));
  });
});
