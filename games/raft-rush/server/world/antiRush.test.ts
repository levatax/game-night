// Adversarial anti-rush checks (Long Tide §1, §3): a cheat-level team — unlimited materials refilled into its
// pockets every tick, every player a Kaptan with a hammer, standing at the raft spamming E from the first second —
// under NORMAL timings still cannot deliver a stage before its minDay, cannot finish the raft before day 6, and
// cannot sail before the launch day's dawn (day 7, 26:00). The day locks, not the labour, set the floor.
// Owner: server-world.

import { describe, expect, it } from "vitest";
import { DIFFICULTIES, RAFT_LAUNCH_STAGE, RAFT_STAGES } from "../../shared/constants.js";
import { stackLimit } from "../../shared/items.js";
import { BTN } from "../../shared/protocol.js";
import { cycleTicks } from "../../shared/rules/schedule.js";
import type { ItemKind } from "../../shared/types.js";
import { Bench } from "./testkit.js";

const IDS = ["a", "b", "c", "d"] as const;

/** Stages that can be complete on `day`: every stage whose minDay ≤ day. */
function maxStageOn(day: number): number {
  return RAFT_STAGES.filter((s) => s.minDay <= day).length;
}

/** Refill every cheater's pockets with what the current stage takes (a hammer in the last slot). */
function refill(b: Bench): void {
  const team = b.state.teams[0]!;
  const def = RAFT_STAGES[team.stage];
  const kinds: ItemKind[] = def ? def.req.map((r) => r.item) : [];
  for (const id of IDS) {
    for (let s = 0; s < 3; s++) {
      const k = kinds[s];
      if (k) b.give(id, k, stackLimit(k), s);
      else b.give(id, "", 0, s);
    }
    b.give(id, "hammer", 1, 3);
    b.topUp(id);
  }
}

function standAtRaft(b: Bench): void {
  const r = b.island.sites[0]!.raft;
  IDS.forEach((id, i) => b.placeFacing(id, r.x + (i - 1.5) * 0.7, r.z, 0, -2));
}

describe("anti-rush: a cheat-level team under normal timings", () => {
  it("each stage rejects delivery before its minDay, and nobody sails before the launch day's dawn", () => {
    const b = new Bench(IDS.map((id) => [id, "kaptan"] as [string, "kaptan"]), { seats: 3 });
    const team = b.state.teams[0]!;
    const cyc = cycleTicks(b.timings);
    const launchDay = DIFFICULTIES.normal.launchDay;
    const completedOn: number[] = [];
    let launchTick = -1;
    let launchClock = -1;
    // Each day: the first 90 s of daylight with the clock running, everyone spamming E at the raft.
    for (let day = 1; day <= b.timings.days && launchTick < 0; day++) {
      b.setClock(day, "day", 1);
      for (let t = 0; t < 90 * 30 && launchTick < 0; t++) {
        refill(b);
        standAtRaft(b);
        // Tap E every 15 ticks (delivery / boarding), hold it in between (assembly channel).
        for (const id of IDS) {
          const p = b.p(id);
          if (p.boarded) continue;
          b.send(id, { buttons: BTN.INTERACT | (t % 15 === 0 || p.channel === 0 ? BTN.INTERACT_PRESS : 0) });
        }
        const evs = b.tick();
        b.clockTicks = (b.clockTicks ?? 0) + 1;
        b.state.monsters.clear();
        for (const e of evs) {
          if (e.type === "raftStage" && !e.lost) completedOn[e.stage] = day;
          if (e.type === "launchRequest") {
            launchTick = e.tick;
            launchClock = b.clockTicks ?? 0;
          }
        }
        // The invariant: the raft is never further than the day allows.
        expect(team.stage, `day ${day} t ${t}`).toBeLessThanOrEqual(maxStageOn(day));
        if (day < launchDay) expect(IDS.some((id) => b.p(id).boarded), `boarded on day ${day}`).toBe(false);
      }
      // A stage whose minDay is still ahead rejected the deliveries with stageLocked.
      if (team.stage < RAFT_LAUNCH_STAGE && RAFT_STAGES[team.stage]!.minDay > day) {
        expect(b.of("reject").some((e) => e.reason === "stageLocked")).toBe(true);
        expect([...team.raftHave].every((h) => h === 0), `nothing delivered to stage ${team.stage} on day ${day}`).toBe(true);
      }
    }
    // Every stage completed on exactly its minDay (labour is never the bottleneck for this team)…
    RAFT_STAGES.forEach((s, i) => expect(completedOn[i], s.name).toBe(s.minDay));
    // …and the launch happens on the launch day, never before its dawn (26:00 on Normal).
    expect(launchTick).toBeGreaterThan(0);
    expect(launchClock).toBeGreaterThanOrEqual((launchDay - 1) * cyc);
    expect(launchClock / 30 / 60).toBeGreaterThanOrEqual(26);
  });

  it("fast-mode rafts never leak into normal timings", () => {
    const b = new Bench([["a"], ["b"]], { seats: 3 });
    expect(b.timings.cheapRaft).toBe(false);
    expect(b.timings.days).toBe(8);
    expect([...b.state.teams[0]!.raftNeed].slice(0, 2).every((n) => n > 1)).toBe(true);
  });
});
