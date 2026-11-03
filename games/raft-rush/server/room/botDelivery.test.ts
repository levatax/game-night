// Integration test for material delivery on a team with a human: the bots' raft goods must reach the camp chest
// (the humans load the raft), while the objective itself stays the humans' (botDelivers). Owner: server-bots.
// Run: npx vitest run games/raft-rush/server/room/botDelivery.test.ts

import { describe, expect, it } from "vitest";
import { mulberry32 } from "../../shared/island/noise.js";
import { Bench } from "../world/testkit.js";
import { BotDesk, type BotHost } from "./bots.js";

function host(b: Bench, seed = 11): BotHost {
  return {
    state: b.state,
    world: b.world,
    rng: mulberry32(seed),
    queueInput: (id, cmd) => b.world.queueInput(id, cmd),
    craft: (id, recipe) => b.world.craft(id, recipe),
    chest: (id, msg) => b.world.chest(id, msg),
    emote: () => true,
    marker: () => true,
  };
}

describe("bots stock the chest instead of the raft on a human team", () => {
  it("puts raft wood in the camp chest and never starts the objective", () => {
    const b = new Bench([["h1"], ["bot-2"], ["bot-3"]], { fast: true });
    b.p("bot-2").bot = true;
    b.p("bot-3").bot = true;
    // Both bots start at camp carrying part of the hull load; the human stays idle.
    b.give("bot-2", "wood", 5);
    b.give("bot-3", "wood", 5, 0);
    const site = b.island.sites[0]!;
    b.place("bot-2", site.chest.x + 1.2, site.chest.z);
    b.place("bot-3", site.chest.x - 1.2, site.chest.z);
    b.place("h1", site.campfire.x, site.campfire.z + 1.5);
    const desk = new BotDesk(host(b));
    desk.add("bot-2", "hamal");
    desk.add("bot-3", "balikci");
    desk.reset();
    b.world.drainEvents();
    const hullBefore = b.state.teams[0]!.hullWood;

    const events = [];
    // Well under a day: a bot standing at the chest stocks it on its first housekeeping goal.
    for (let t = 0; t < 180; t++) {
      desk.tick();
      events.push(...b.tick());
    }

    const team = b.state.teams[0]!;
    expect(team.chest.get("wood") ?? 0).toBeGreaterThan(0);
    expect(team.hullWood).toBe(hullBefore);
    expect(team.stage).toBe(0);
    expect(events.filter((e) => e.type === "deliver")).toHaveLength(0);
    expect(events.filter((e) => e.type === "launchRequest")).toHaveLength(0);
    expect(b.p("bot-2").stats.delivered).toBe(0);
    expect(b.p("bot-3").stats.delivered).toBe(0);
  });

});
