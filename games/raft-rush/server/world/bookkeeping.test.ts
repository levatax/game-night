// What RaftWorld keeps between ticks stays bounded and exact: per-player data goes with the player (removePlayer,
// match resets), the light rings are reused while their sources stay the same, the separation scratch never
// leaks a body into the next pass. Owner: server-world.

import { describe, expect, it } from "vitest";
import { DAY_EVENT_FRACTION, FISH_BITE_TICKS, PLAYER_SEPARATION, TICK_MS, TREASURE_REEL_TICKS } from "../../shared/constants.js";
import { BTN } from "../../shared/protocol.js";
import { playerRadius } from "../../shared/sim/player.js";
import { Bench } from "./testkit.js";

/** Players a and b, b spinning the treasure reel of day 1's wave gift (WeatherSystem's own reels). */
function benchWithGiftReel(): Bench {
  for (let seed = 1; seed < 100; seed++) {
    const b = new Bench([["a"], ["b"]], { seed });
    b.state.teams[0]!.chest.clear(); // no fish, no chest stock: the day event falls back to a wave gift
    b.setClock(1, "day", Math.ceil(b.timings.day * DAY_EVENT_FRACTION));
    b.tick();
    for (const id of [...b.state.projectiles.keys()]) b.world.weather.onPickup(b.p("b"), id);
    if (b.world.weather.trackedIds().length > 0) return b;
  }
  throw new Error("no seed below 100 gives a wave gift with a treasure reel");
}

describe("RaftWorld: per-player bookkeeping", () => {
  it("removePlayer leaves nothing behind for the leaver (fishing, treasure reels, runtime bars, input queue)", () => {
    const b = benchWithGiftReel();
    b.world.setRtt("a", 90);
    b.world.setRtt("b", 250);
    b.world.fishing.treasureReel(b.p("b"), "secretChest");
    b.world.fishing.treasureReel(b.p("b"), "secretChest");
    b.send("b", { moveZ: 1 });
    b.tick();
    expect(b.world.fishing.trackedIds()).toEqual(["a", "b"]);
    expect(b.world.weather.trackedIds()).toEqual(["b"]);
    expect(b.world.runtime.has("b")).toBe(true);
    expect(b.world.inputIds()).toEqual(["b"]);

    b.world.removePlayer("b");
    b.state.players.delete("b");
    expect(b.world.fishing.trackedIds()).toEqual(["a"]);
    expect(b.world.weather.trackedIds()).toEqual([]);
    expect(b.world.runtime.has("b")).toBe(false);
    expect(b.world.inputIds()).toEqual([]);
    // The unfinished reels apply to nobody, and nothing comes back for "b".
    const evs = b.run(2 * TREASURE_REEL_TICKS + 2);
    expect(b.of("treasure", evs)).toHaveLength(0);
    expect(b.world.fishing.trackedIds()).toEqual(["a"]);
    expect(b.world.runtime.has("b")).toBe(false);
  });

  it("a new match and the lobby keep the RTT and input queue of everyone still in the room and forget the rest", () => {
    const b = new Bench([["a"], ["b"], ["c"]]);
    b.world.setRtt("a", 120);
    b.world.setRtt("ghost", 300); // a seat that vanished without removePlayer
    b.send("a");
    b.send("b");
    b.send("c");
    b.state.players.delete("b"); // b and c vanish without removePlayer too (c before the lobby reset)
    b.world.startMatch(["a", "c"], 2);
    expect(b.world.fishing.trackedIds()).toEqual(["a"]);
    expect(b.world.inputIds()).toEqual(["a", "c"]);
    const a = b.p("a");
    a.ping = 0;
    expect(b.world.fishing.biteWindowTicks(a)).toBe(FISH_BITE_TICKS + Math.round(60 / TICK_MS));
    b.world.setRtt("ghost", 300);
    b.state.players.delete("c");
    b.world.resetToLobby();
    expect(b.world.fishing.trackedIds()).toEqual(["a"]);
    expect(b.world.inputIds()).toEqual(["a"]);
  });
});

describe("RaftWorld: light rings", () => {
  it("one array while the sources stay the same (a held torch follows its holder), a new one when the set changes", () => {
    const b = new Bench([["a"], ["b"]]);
    const a = b.place("a", -12, -12, 0);
    b.give("a", "torch", 1);
    a.torchTicks = 1000;
    b.place("b", 12, -12, 0);
    b.tick();
    const first = b.world.lights();
    expect(first.map((l) => l.kind)).toEqual(["fire", "torch"]);

    b.run(10, () => b.send("a", { moveZ: 1 }));
    expect(a.z).toBeLessThan(-12.5);
    const walked = b.world.lights();
    expect(walked).toBe(first);
    expect(walked[1]).toMatchObject({ x: a.x, z: a.z, kind: "torch", team: 0 });

    // b lights a torch too: a new array, the fire first, then the holders in player order.
    b.give("b", "torch", 1);
    b.p("b").torchTicks = 1000;
    b.tick();
    const two = b.world.lights();
    expect(two).not.toBe(first);
    expect(two.map((l) => [l.kind, l.x, l.z])).toEqual([
      ["fire", b.island.sites[0]!.campfire.x, b.island.sites[0]!.campfire.z],
      ["torch", a.x, a.z],
      ["torch", b.p("b").x, b.p("b").z],
    ]);
    // a puts the torch away (slot 2), the fire goes out: only b's torch is left.
    b.send("a", { buttons: BTN.SLOT2 });
    b.state.teams[0]!.fireFuel = 0;
    b.tick();
    expect(b.world.lights().map((l) => [l.kind, l.x])).toEqual([["torch", b.p("b").x]]);
    expect(b.world.inLight(a.x, a.z)).toBe(false);
    expect(b.world.inLight(b.p("b").x, b.p("b").z)).toBe(true);
  });
});

describe("RaftWorld: player separation", () => {
  it("pushes overlapping players apart every tick and only moves the bodies of the current pass", () => {
    const b = new Bench([["a"], ["b"], ["c"]]);
    const a = b.place("a", 0, 0, 0);
    const p2 = b.place("b", 0.3, 0, 0);
    const c = b.place("c", 6, 6, 0);
    const min = Math.min(PLAYER_SEPARATION, playerRadius(a.character) + playerRadius(p2.character));
    b.tick();
    expect(Math.hypot(a.x - p2.x, a.z - p2.z)).toBeCloseTo(min, 6);
    expect(c.x).toBe(6);
    // c, the last body of that pass, washes ashore right next to a: its scratch slot now lies past this pass's
    // count and must stay out of it. b steps right next to a again.
    c.alive = false;
    c.washed = true;
    b.place("c", a.x + 0.2, a.z, 0);
    const [cx, cz] = [c.x, c.z];
    b.place("b", a.x, a.z + 0.2, 0);
    b.tick();
    expect(Math.hypot(a.x - p2.x, a.z - p2.z)).toBeCloseTo(min, 6);
    expect([c.x, c.z]).toEqual([cx, cz]);
  });

  it("two players on the very same point part the full distance along a fixed direction", () => {
    const run = (): number[] => {
      const b = new Bench([["a"], ["b"]]);
      const a = b.place("a", 1.5, -2, 0);
      const p2 = b.place("b", 1.5, -2, 0);
      const min = Math.min(PLAYER_SEPARATION, playerRadius(a.character) + playerRadius(p2.character));
      b.tick();
      expect(Math.hypot(a.x - p2.x, a.z - p2.z)).toBeGreaterThanOrEqual(min - 1e-9);
      // Half each, a (the first body) to −x and b to +x; nothing along z.
      expect(a.x).toBeCloseTo(1.5 - min / 2, 6);
      expect(p2.x).toBeCloseTo(1.5 + min / 2, 6);
      expect([a.z, p2.z]).toEqual([-2, -2]);
      return [a.x, a.z, p2.x, p2.z];
    };
    expect(run()).toEqual(run()); // deterministic
  });
});
