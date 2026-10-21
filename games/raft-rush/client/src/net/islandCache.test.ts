// IslandCache / IslandSync tests (injected generator, so they don't depend on the procedural island). Owner: client-net.

import { describe, expect, it } from "vitest";
import type { IslandDef } from "../../../shared/island/types";
import type { CoverCircle } from "../../../shared/sim/cover";
import type { Layout } from "../../../shared/types";
import { IslandCache, IslandSync, islandKey, structureSignature } from "./islandCache";
import { mapOf, structureView, testIsland } from "./testkit";

/** Fake generator: a test island tagged with the seed; counts calls. */
function fakeGenerator(): { gen: (seed: number, layout: Layout) => IslandDef; calls: () => number } {
  let calls = 0;
  return {
    gen: (seed, layout) => {
      calls++;
      return { ...testIsland({ seed }), seed, layout };
    },
    calls: () => calls,
  };
}

function welcome(def: IslandDef, over: Partial<{ gridHash: number; defHash: number }> = {}) {
  return { seed: def.seed, layout: def.layout, gridHash: over.gridHash ?? def.gridHash, defHash: over.defHash ?? def.defHash };
}

describe("IslandCache", () => {
  it("generates once per seed + layout and evicts the least recently used", () => {
    const g = fakeGenerator();
    const cache = new IslandCache(g.gen, 2);
    const a = cache.get(1, "solo");
    expect(cache.get(1, "solo")).toBe(a);
    expect(g.calls()).toBe(1);
    cache.get(2, "solo");
    cache.get(1, "solo"); // 1 is now the most recent
    cache.get(3, "solo"); // evicts 2
    expect(cache.has(1, "solo")).toBe(true);
    expect(cache.has(2, "solo")).toBe(false);
    expect(cache.has(3, "solo")).toBe(true);
    expect(cache.get(1, "duel")).not.toBe(a);
    expect(cache.size).toBe(2);
  });

  it("keys by the unsigned seed", () => {
    expect(islandKey(-1, "solo")).toBe(islandKey(0xffffffff, "solo"));
  });
});

describe("IslandSync", () => {
  it("shows the welcome's island and reports no mismatch when the hashes agree", () => {
    const g = fakeGenerator();
    const sync = new IslandSync(g.gen);
    const reference = g.gen(77, "solo");
    expect(sync.welcome(welcome(reference))).toEqual({ seed: 77, layout: "solo", mismatch: false });
    expect(sync.island?.seed).toBe(77);
    expect(sync.cover).not.toBeNull();
    expect(sync.world?.terrain).toBe(sync.island?.grid);
    expect(sync.mismatch).toBe(false);
  });

  it("flags a mismatch when the server's hashes differ", () => {
    const g = fakeGenerator();
    const sync = new IslandSync(g.gen);
    const reference = g.gen(5, "solo");
    const warn = console.warn;
    console.warn = () => {};
    try {
      expect(sync.welcome(welcome(reference, { gridHash: reference.gridHash + 1 }))).toEqual({ seed: 5, layout: "solo", mismatch: true });
    } finally {
      console.warn = warn;
    }
    expect(sync.mismatch).toBe(true);
  });

  it("announces an island once, again only when it (or its mismatch flag) changes", () => {
    const g = fakeGenerator();
    const sync = new IslandSync(g.gen);
    const a = g.gen(1, "solo");
    expect(sync.welcome(welcome(a))).not.toBeNull();
    expect(sync.welcome(welcome(a))).toBeNull();
    expect(sync.matchStart(1, "solo")).toBeNull();
    expect(sync.matchStart(2, "solo")).toEqual({ seed: 2, layout: "solo", mismatch: false });
    sync.newSession();
    expect(sync.matchStart(2, "solo")).toEqual({ seed: 2, layout: "solo", mismatch: false });
  });

  it("follows changes of state.seed / layout but lets a session's first welcome win over its first patch", () => {
    const g = fakeGenerator();
    const sync = new IslandSync(g.gen);
    sync.welcome(welcome(g.gen(10, "solo")));
    // First patch disagrees (stale preview): the welcome is authoritative.
    expect(sync.onState(99, "solo")).toBeNull();
    expect(sync.island?.seed).toBe(10);
    // Same values again: nothing. A real change: load it.
    expect(sync.onState(99, "solo")).toBeNull();
    expect(sync.onState(11, "solo")).toEqual({ seed: 11, layout: "solo", mismatch: false });
    expect(sync.island?.seed).toBe(11);
  });

  it("loads from the first patch when no welcome came first", () => {
    const g = fakeGenerator();
    const sync = new IslandSync(g.gen);
    expect(sync.onState(42, "solo")).toEqual({ seed: 42, layout: "solo", mismatch: false });
    expect(sync.island?.seed).toBe(42);
    // The welcome then confirms it (same island, no mismatch): no second announcement.
    expect(sync.welcome(welcome(g.gen(42, "solo")))).toBeNull();
  });

  it("reuses cached islands while the host types a seed", () => {
    const g = fakeGenerator();
    const sync = new IslandSync(g.gen);
    for (const seed of [4, 44, 447, 4471, 447, 4471]) sync.onState(seed, "solo");
    expect(g.calls()).toBe(4);
  });

  it("rebuilds the dynamic cover only when the structures change, and fences collide", () => {
    const sync = new IslandSync(fakeGenerator().gen);
    sync.onState(3, "solo");
    const cover = sync.cover!;
    const out: CoverCircle[] = [];
    expect(cover.query(0, -2, 0.5, out)).toBe(0);

    const fence = structureView({ id: "s1", kind: "fence", x: 0, y: 1, z: -2 });
    const torch = structureView({ id: "s2", kind: "torch", x: 6, y: 1, z: 6 });
    expect(sync.syncStructures(mapOf(fence, torch))).toBe(true);
    expect(sync.syncStructures(mapOf(fence, torch))).toBe(false);
    expect(cover.query(0, -2, 0.5, out)).toBeGreaterThan(0);
    expect(out[0]?.kind).toBe("fence");
    expect(cover.query(6, 6, 0.3, out)).toBe(0); // torches don't collide

    expect(sync.syncStructures(mapOf(torch))).toBe(true);
    expect(cover.query(0, -2, 0.5, out)).toBe(0);
  });

  it("re-applies the structures to a newly shown island's cover", () => {
    const sync = new IslandSync(fakeGenerator().gen);
    const fences = mapOf(structureView({ id: "s1", kind: "fence", x: 0, y: 1, z: -2 }));
    sync.onState(3, "solo");
    sync.syncStructures(fences);
    sync.onState(4, "solo");
    expect(sync.syncStructures(fences)).toBe(true);
    expect(sync.cover!.query(0, -2, 0.5, [])).toBeGreaterThan(0);
  });

  it("clear() forgets the island", () => {
    const sync = new IslandSync(fakeGenerator().gen);
    sync.onState(3, "solo");
    sync.clear();
    expect(sync.island).toBeNull();
    expect(sync.cover).toBeNull();
    expect(sync.world).toBeNull();
  });
});

describe("structureSignature", () => {
  it("changes with the set and placement of structures", () => {
    const a = structureView({ id: "s1", x: 1, z: 2 });
    const b = structureView({ id: "s2", kind: "collector", x: 3, z: 4 });
    const base = structureSignature(mapOf(a, b));
    expect(structureSignature(mapOf(a, b))).toBe(base);
    expect(structureSignature(mapOf(a))).not.toBe(base);
    expect(structureSignature(mapOf(a, { ...b, x: 3.5 }))).not.toBe(base);
    expect(structureSignature(mapOf(a, { ...b, id: "s3" }))).not.toBe(base);
  });
});
