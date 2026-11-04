// FishingSystem against the fake WorldContext (server/world/life/testkit.ts). Owner: server-world-life.

import { beforeEach, describe, expect, it } from "vitest";
import {
  EYE_HEIGHT,
  FISH_BITE_TICKS,
  FISH_LAG_ALLOWANCE_MAX_TICKS,
  FISH_PITY,
  FISH_REEL_TICKS,
  FISH_STATE,
  FISH_WAIT_MAX_TICKS,
  FISH_WAIT_MIN_TICKS,
  MVP_POINTS,
  TREASURE_REEL_TICKS,
  WATER_Y,
} from "../../shared/constants.js";
import { mulberry32 } from "../../shared/island/noise.js";
import { FISH_LOOT_ITEM } from "../../shared/items.js";
import { yawFromDir } from "../../shared/sim/math.js";
import type { PlayerState } from "../schema.js";
import { FishingSystem } from "./fishing.js";
import { FakeWorld } from "./life/testkit.js";

/** Scripted rng: queued values first, then a seeded stream. */
function scripted(seed = 1): { rng: () => number; push: (...v: number[]) => void } {
  const q: number[] = [];
  const base = mulberry32(seed);
  return { rng: () => (q.length > 0 ? q.shift()! : base()), push: (...v: number[]) => q.push(...v) };
}

function aimAt(p: PlayerState, x: number, y: number, z: number): void {
  const dx = x - p.x;
  const dz = z - p.z;
  p.yaw = yawFromDir(dx, dz);
  p.pitch = Math.atan2(y - (p.y + EYE_HEIGHT), Math.hypot(dx, dz));
}

describe("FishingSystem", () => {
  let w: FakeWorld;
  let fish: FishingSystem;
  let p: PlayerState;
  let script: ReturnType<typeof scripted>;
  const spot = () => w.island.fishSpots[0]!;

  /** One server tick: optional LMB (players phase), then the fishing step. */
  const tick = (click = false) => {
    w.state.tick++;
    if (click) fish.use(p);
    fish.step();
  };

  /** Cast and wait for the bite; returns the ticks waited. */
  const castAndWait = (): number => {
    expect(fish.use(p)).toBe(true);
    let waited = 0;
    while (p.fishState === FISH_STATE.CAST) {
      tick();
      waited++;
      if (waited > FISH_WAIT_MAX_TICKS + 5) throw new Error("no bite");
    }
    expect(p.fishState).toBe(FISH_STATE.BITE);
    return waited;
  };

  beforeEach(() => {
    script = scripted(3);
    w = new FakeWorld({ rng: script.rng });
    fish = new FishingSystem(w);
    const s = w.island.fishSpots[0]!;
    // Stand on the beach 7 m from the spot, rod in hand, looking at the foam.
    const k = 24 / 31;
    p = w.addPlayer("ana", s.x * k, s.z * k);
    p.inv0 = "rod";
    p.cnt0 = 1;
    p.activeSlot = 0;
    aimAt(p, s.x, WATER_Y, s.z);
  });

  it("casts at the spot in view: fishCast with a bobber on the water, state CAST", () => {
    expect(fish.use(p)).toBe(true);
    expect(p.fishState).toBe(FISH_STATE.CAST);
    expect(p.fishSpot).toBe(spot().i);
    const ev = w.ofType("fishCast");
    expect(ev).toHaveLength(1);
    expect(ev[0]!.pos.y).toBe(WATER_Y);
    expect(Math.hypot(ev[0]!.pos.x - spot().x, ev[0]!.pos.z - spot().z)).toBeLessThan(2.6);
  });

  it("rejects noSpot when looking at the sky, and does nothing without a rod", () => {
    p.pitch = 1.2;
    expect(fish.use(p)).toBe(false);
    expect(w.ofType("reject")[0]).toMatchObject({ action: "fish", reason: "noSpot", playerId: "ana" });
    expect(p.fishState).toBe(FISH_STATE.NONE);
    w.clearEvents();
    aimAt(p, spot().x, WATER_Y, spot().z);
    p.inv0 = "wood";
    expect(fish.use(p)).toBe(false);
    expect(w.events).toHaveLength(0);
  });

  it("ignores spots beyond FISH_CAST_RANGE", () => {
    w.place(p, 0, 0);
    aimAt(p, spot().x, WATER_Y, spot().z);
    expect(fish.use(p)).toBe(false);
    expect(w.ofType("reject")[0]!.reason).toBe("noSpot");
  });

  it("the bite comes 2–6 s after the cast", () => {
    for (let k = 0; k < 25; k++) {
      const waited = castAndWait();
      expect(waited).toBeGreaterThanOrEqual(FISH_WAIT_MIN_TICKS);
      expect(waited).toBeLessThanOrEqual(FISH_WAIT_MAX_TICKS);
      const bite = w.ofType("fishBite").at(-1)!;
      expect(bite.windowTicks).toBe(FISH_BITE_TICKS);
      fish.cancel(p, "cancel");
      expect(p.fishState).toBe(FISH_STATE.NONE);
    }
  });

  it("a strike inside the window reels in: fishResult, then the item FISH_REEL_TICKS later", () => {
    castAndWait();
    tick(true);
    expect(p.fishState).toBe(FISH_STATE.REEL);
    const res = w.ofType("fishResult");
    expect(res).toHaveLength(1);
    expect(res[0]!.reel[res[0]!.stopIndex]).toBe(res[0]!.loot);
    expect(p.stats.fish).toBe(1);
    expect(p.score).toBe(MVP_POINTS.fish);
    // Clicking again while the reel spins does nothing.
    expect(fish.use(p)).toBe(true);
    for (let k = 0; k < FISH_REEL_TICKS - 1; k++) tick();
    expect(p.fishState).toBe(FISH_STATE.REEL);
    tick();
    expect(p.fishState).toBe(FISH_STATE.NONE);
    expect(p.fishSpot).toBe(-1);
    const item = FISH_LOOT_ITEM[res[0]!.loot];
    if (item) expect(w.ofType("pickup").at(-1)).toMatchObject({ playerId: "ana", kind: item, source: "fish" });
  });

  it("the window is exactly FISH_BITE_TICKS long with no lag", () => {
    expect(fish.biteWindowTicks(p)).toBe(FISH_BITE_TICKS);
    castAndWait();
    for (let k = 0; k < FISH_BITE_TICKS - 1; k++) tick();
    tick(true); // last tick of the window
    expect(w.ofType("fishResult")).toHaveLength(1);
  });

  it("missing the window is a late miss", () => {
    castAndWait();
    for (let k = 0; k < FISH_BITE_TICKS; k++) tick();
    expect(w.ofType("fishMiss").at(-1)).toMatchObject({ reason: "late", playerId: "ana" });
    expect(p.fishState).toBe(FISH_STATE.NONE);
    expect(w.ofType("fishResult")).toHaveLength(0);
  });

  it("adds a lag allowance of RTT/2, capped at 150 ms", () => {
    fish.setRtt("ana", 200);
    const lag = Math.round(100 / (1000 / 30));
    expect(fish.biteWindowTicks(p)).toBe(FISH_BITE_TICKS + lag);
    fish.setRtt("ana", 2000);
    expect(fish.biteWindowTicks(p)).toBe(FISH_BITE_TICKS + FISH_LAG_ALLOWANCE_MAX_TICKS);
    // A strike that would be late without the allowance still lands with it.
    castAndWait();
    for (let k = 0; k < FISH_BITE_TICKS + FISH_LAG_ALLOWANCE_MAX_TICKS - 1; k++) tick();
    tick(true);
    expect(w.ofType("fishResult")).toHaveLength(1);
  });

  it("falls back to the player's ping when no RTT was reported", () => {
    p.ping = 200;
    expect(fish.biteWindowTicks(p)).toBe(FISH_BITE_TICKS + 3);
  });

  it("clicking before the bite is an early miss", () => {
    fish.use(p);
    tick();
    tick(true);
    expect(w.ofType("fishMiss").at(-1)).toMatchObject({ reason: "early" });
    expect(p.fishState).toBe(FISH_STATE.NONE);
  });

  it("walking away or switching slots reels in (moved); getting downed cancels", () => {
    fish.use(p);
    w.place(p, p.x - 2.5, p.z);
    tick();
    expect(w.ofType("fishMiss").at(-1)!.reason).toBe("moved");

    w.place(p, (spot().x * 24) / 31, (spot().z * 24) / 31);
    aimAt(p, spot().x, WATER_Y, spot().z);
    fish.use(p);
    p.activeSlot = 1;
    tick();
    expect(w.ofType("fishMiss").at(-1)!.reason).toBe("moved");

    p.activeSlot = 0;
    fish.use(p);
    p.downed = true;
    tick();
    expect(w.ofType("fishMiss").at(-1)!.reason).toBe("cancel");
  });

  it("bad-luck protection: after FISH_PITY boots the next catch is at least a fish", () => {
    // Every rng value 0.6: the wait is fixed, every normal roll is a boot (base table), no reel tease.
    w.setRng(() => 0.6);
    for (let k = 0; k <= FISH_PITY; k++) {
      castAndWait();
      tick(true);
      const res = w.ofType("fishResult").at(-1)!;
      if (k < FISH_PITY) {
        expect(res.loot).toBe("boot");
        expect(res.pity).toBe(false);
      } else {
        expect(res.pity).toBe(true);
        expect(["boot", "jellyfish", "puffer"]).not.toContain(res.loot);
      }
      for (let t = 0; t < FISH_REEL_TICKS; t++) tick();
      p.inv1 = "";
      p.cnt1 = 0;
      p.inv2 = "";
      p.cnt2 = 0;
      p.inv3 = "";
      p.cnt3 = 0;
    }
  });

  it("a treasure catch spins a treasure reel when the fish reel ends and applies it after TREASURE_REEL_TICKS", () => {
    castAndWait();
    script.push(0.93); // lands on "treasure" in the base table
    tick(true);
    expect(w.ofType("fishResult").at(-1)!.loot).toBe("treasure");
    for (let k = 0; k < FISH_REEL_TICKS; k++) tick();
    const tr = w.ofType("treasure");
    expect(tr).toHaveLength(1);
    expect(tr[0]).toMatchObject({ playerId: "ana", source: "fish", team: 0 });
    expect(tr[0]!.reel[tr[0]!.stopIndex]).toBe(tr[0]!.treasure);
    expect(w.treasures).toHaveLength(0);
    for (let k = 0; k < TREASURE_REEL_TICKS - 1; k++) tick();
    expect(w.treasures).toHaveLength(0);
    tick();
    expect(w.treasures).toEqual([{ playerId: "ana", treasure: tr[0]!.treasure }]);
    expect(w.ofType("pickup")).toHaveLength(0);
  });

  it("a bottle applies when the reel ends", () => {
    castAndWait();
    script.push(0.875); // "bottle"
    tick(true);
    expect(w.ofType("fishResult").at(-1)!.loot).toBe("bottle");
    expect(w.bottles).toHaveLength(0);
    for (let k = 0; k < FISH_REEL_TICKS - 1; k++) tick();
    expect(w.bottles).toHaveLength(0);
    tick();
    expect(w.bottles).toEqual(["ana"]);
  });

  it("the secret chest's two reels run one after the other and never repeat", () => {
    fish.treasureReel(p, "secretChest");
    fish.treasureReel(p, "secretChest");
    expect(w.ofType("treasure")).toHaveLength(1);
    for (let k = 0; k < TREASURE_REEL_TICKS; k++) tick();
    expect(w.treasures).toHaveLength(1);
    expect(w.ofType("treasure")).toHaveLength(2);
    for (let k = 0; k < TREASURE_REEL_TICKS; k++) tick();
    expect(w.treasures).toHaveLength(2);
    expect(w.treasures[0]!.treasure).not.toBe(w.treasures[1]!.treasure);
  });

  it("does not hand out a useless treasure (old sail after the sail, a second flare)", () => {
    const team = w.team(0);
    team.stage = 4;
    team.flare = true;
    for (let k = 0; k < 40; k++) {
      fish.treasureReel(p, "waveGift");
      for (let t = 0; t < TREASURE_REEL_TICKS; t++) tick();
    }
    for (const t of w.treasures) expect(["old_sail", "flare"]).not.toContain(t.treasure);
  });

  it("startMatch builds the seeded table; clear() resets lines", () => {
    fish.startMatch(4471, "swamp");
    const a = fish.lootTable();
    fish.startMatch(4471, "swamp");
    expect(fish.lootTable()).toEqual(a);
    fish.use(p);
    fish.clear();
    expect(p.fishState).toBe(FISH_STATE.NONE);
    expect(p.fishSpot).toBe(-1);
    tick();
    expect(w.ofType("fishBite")).toHaveLength(0);
  });

  it("forget() drops a leaver's line, pity streak, RTT and reels; clear() keeps only the RTTs of players still here", () => {
    fish.setRtt("ana", 200);
    castAndWait();
    tick(true); // strike: REEL + a pity streak entry
    fish.treasureReel(p, "secretChest");
    expect(fish.trackedIds()).toEqual(["ana"]);
    fish.forget("ana");
    expect(fish.trackedIds()).toEqual([]);
    expect(p.fishState).toBe(FISH_STATE.NONE);
    p.ping = 0;
    expect(fish.biteWindowTicks(p)).toBe(FISH_BITE_TICKS);
    for (let k = 0; k < FISH_REEL_TICKS + TREASURE_REEL_TICKS; k++) tick();
    expect(w.ofType("pickup")).toHaveLength(0);
    expect(w.treasures).toHaveLength(0);
    fish.setRtt("ana", 120);
    fish.setRtt("ghost", 90);
    fish.clear();
    expect(fish.trackedIds()).toEqual(["ana"]);
  });
});
