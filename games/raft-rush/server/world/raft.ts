// The raft: delivery, stages, gnawing, boarding and the launch (game4.md §4, §7; docs/ARCHITECTURE.md §2.4–2.6).
// Owner: server-world.
//
// Delivery executes shared/rules/interact.ts planRaftDelivery() exactly: E at the raft hands over what the
// CURRENT stage still needs (surplus stays with you); when that completes the stage, the next stage is planned
// in the same press (one `deliver` event per stage touched). Stage = first incomplete stage; the old-sail
// treasure completes the mast the moment the hull is done; gnawing (damage) removes hull wood and may drop a
// finished raft back to stage 0 (everyone aboard steps off, the countdown stops).
// Boarding (stage 3): E puts you on a raft seat (frozen, look only). Once every required teammate (alive, not
// downed, not washed) is aboard → launchRequest; otherwise the first boarding starts timings.launchWait
// (state.launchTicksLeft) and at 0 the raft leaves with whoever is aboard. The room turns launchRequest into the
// launch phase.

import { CHANNEL, MVP_POINTS, WATER_Y, WRECK_HULL_WOOD } from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import type { RaftCost } from "../../shared/items.js";
import { planRaftDelivery, raftPartValue, raftStageFor, teamRaftCost } from "../../shared/rules/interact.js";
import type { ClockInfo } from "../../shared/rules/schedule.js";
import type { ItemKind, RaftStage, Vec3Like } from "../../shared/types.js";
import type { PlayerState, TeamState } from "./context.js";
import type { WorldCore } from "./core.js";
import { point, RAFT_DECK_Y, RAFT_SEATS } from "./rules.js";

export class RaftSystem {
  /** Teams whose first-aboard bonus was paid this match. */
  private readonly firstAboardPaid = new Set<number>();
  /** Teams whose launch was requested (once per match). */
  private readonly launched = new Set<number>();

  constructor(private readonly core: WorldCore) {}

  /** Requirements of `team` (RAFT_COSTS by seats; RAFT_TEST fast timings: one of everything). */
  cost(team: TeamState): RaftCost {
    return teamRaftCost(team, this.core.timings.cheapRaft);
  }

  /** Match start: fresh raft for `seats` seats; the wreck counts WRECK_HULL_WOOD (never the whole hull). */
  setup(team: TeamState, seats: number): void {
    team.seats = Math.max(2, Math.min(6, Math.round(seats)));
    const cost = this.cost(team);
    team.hullWood = Math.min(WRECK_HULL_WOOD, Math.max(0, cost.hullWood - 1));
    team.mastWood = 0;
    team.mastRope = 0;
    team.food = 0;
    team.water = 0;
    team.sail = false;
    team.stage = raftStageFor(team, cost);
  }

  /** Forget per-match flags. */
  reset(): void {
    this.firstAboardPaid.clear();
    this.launched.clear();
  }

  /** A launch was requested this match (for any team). */
  hasLaunched(): boolean {
    return this.launched.size > 0;
  }

  /* --------------------------------------------------------------- delivery */

  /** E at the raft (stage < 3): deliver what the stage needs. Rejects "nothingToDeliver" / "wrongStage". */
  deliver(p: PlayerState): boolean {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    const cost = this.cost(team);
    const partValue = raftPartValue(p.character);
    let delivered = false;
    // At most one pass per stage (0, 1, 2).
    for (let pass = 0; pass < 3; pass++) {
      const plan = planRaftDelivery(p, team, cost, partValue);
      if (!plan) break;
      for (const it of plan.items) core.bag.take(p, it.kind, it.count);
      team.hullWood = Math.min(255, team.hullWood + plan.hullWood);
      team.mastWood = Math.min(255, team.mastWood + plan.mastWood);
      team.mastRope = Math.min(255, team.mastRope + plan.mastRope);
      team.food = Math.min(255, team.food + plan.food);
      team.water = Math.min(255, team.water + plan.water);
      p.stats.delivered = Math.min(65535, p.stats.delivered + plan.credited);
      core.addScore(p, MVP_POINTS.deliver * plan.credited);
      const newStage = this.refreshStage(teamIdx, false);
      const items: { kind: ItemKind; count: number }[] = plan.items.map((it) => ({ kind: it.kind, count: it.count }));
      core.emit({ type: "deliver", tick: core.tick(), playerId: p.id, team: teamIdx, stage: plan.stage, items, newStage });
      if (newStage === 3) core.emit({ type: "raftReady", tick: core.tick(), team: teamIdx });
      delivered = true;
      if (newStage === plan.stage) break;
    }
    if (!delivered) {
      core.reject(p, "deliver", team.stage >= 3 ? "notReady" : "nothingToDeliver", "deliver");
    }
    return delivered;
  }

  /**
   * Recompute the stage from the counts (old sail: the mast completes with the hull). Emits raftReady when it
   * became ready (when `emitReady`); unboards everyone when a ready raft lost its readiness. Returns the stage.
   */
  refreshStage(teamIdx: number, emitReady = true): RaftStage {
    const core = this.core;
    const team = core.team(teamIdx);
    const cost = this.cost(team);
    const before = team.stage;
    if (team.sail && team.hullWood >= cost.hullWood) {
      team.mastWood = Math.max(team.mastWood, cost.mastWood);
      team.mastRope = Math.max(team.mastRope, cost.mastRope);
      team.sail = false;
    }
    const stage = raftStageFor(team, cost);
    team.stage = stage;
    if (stage === 3 && before !== 3 && emitReady) core.emit({ type: "raftReady", tick: core.tick(), team: teamIdx });
    if (stage !== 3 && before === 3) this.unboardAll(teamIdx);
    return stage;
  }

  /** Old sail treasure: the mast stage completes now (hull done) or as soon as the hull is (§2.8). */
  applySail(teamIdx: number): void {
    const team = this.core.team(teamIdx);
    team.sail = true;
    this.refreshStage(teamIdx);
  }

  /** WorldContext.damageRaft: gnawing / fire removes hull wood. */
  damage(teamIdx: number, amount: number, byMonsterId: string, pos: Vec3Like): void {
    const core = this.core;
    const team = core.team(teamIdx);
    const lost = Math.min(team.hullWood, Math.max(0, Math.floor(amount)));
    if (lost <= 0) return;
    team.hullWood -= lost;
    core.emit({ type: "raftDamage", tick: core.tick(), team: teamIdx, amount: lost, byMonsterId, pos: point(pos.x, pos.y, pos.z), hullWood: team.hullWood });
    this.refreshStage(teamIdx);
  }

  /* ---------------------------------------------------------------- boarding */

  /** E on a ready raft. */
  board(p: PlayerState): boolean {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    if (team.stage < 3) {
      core.reject(p, "board", "notReady", "board");
      return false;
    }
    if (p.boarded || this.launched.has(teamIdx)) return false;
    core.fishing.cancel(p, "cancel");
    p.boarded = true;
    p.channel = CHANNEL.NONE;
    p.channelTicks = 0;
    p.channelTarget = -1;
    p.chargeTicks = 0;
    p.catchTicks = 0;
    const rt = core.runtime.of(p);
    rt.seat = this.freeSeat(teamIdx);
    this.pinSeat(p);
    if (!this.firstAboardPaid.has(teamIdx)) {
      this.firstAboardPaid.add(teamIdx);
      core.addScore(p, MVP_POINTS.firstAboard);
    }
    const everyone = this.everyoneAboard(teamIdx);
    if (!everyone && core.state.launchTicksLeft === 0) core.state.launchTicksLeft = Math.max(1, core.timings.launchWait);
    core.emit({ type: "board", tick: core.tick(), playerId: p.id, team: teamIdx, launchTicksLeft: everyone ? 0 : core.state.launchTicksLeft });
    return true;
  }

  /** Lowest free raft seat of the team. */
  private freeSeat(teamIdx: number): number {
    const taken = new Set<number>();
    for (const q of this.core.participants(teamIdx)) {
      if (q.boarded) taken.add(this.core.runtime.of(q).seat);
    }
    for (let s = 0; s < RAFT_SEATS.length; s++) if (!taken.has(s)) return s;
    return taken.size % RAFT_SEATS.length;
  }

  /** Hold a boarded player on their seat (the sim doesn't move boarded players). */
  pinSeat(p: PlayerState): void {
    const site = this.core.site(p.team);
    const seat = RAFT_SEATS[Math.max(0, this.core.runtime.of(p).seat) % RAFT_SEATS.length]!;
    const yaw = site.raft.yaw;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const rx = Math.cos(yaw);
    const rz = -Math.sin(yaw);
    p.x = site.raft.x + rx * seat[0] + fx * seat[1];
    p.z = site.raft.z + rz * seat[0] + fz * seat[1];
    p.y = Math.max(heightAt(this.core.island.grid, site.raft.x, site.raft.z), WATER_Y) + RAFT_DECK_Y;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    p.grounded = true;
  }

  /** The raft lost its readiness: everyone steps back onto the sand, the countdown stops. */
  private unboardAll(teamIdx: number): void {
    for (const q of this.core.participants(teamIdx)) {
      if (!q.boarded) continue;
      q.boarded = false;
      q.y = heightAt(this.core.island.grid, q.x, q.z);
      this.core.runtime.of(q).seat = -1;
    }
    this.core.state.launchTicksLeft = 0;
  }

  /** Players the launch waits for: alive, not downed, not washed participants. */
  required(teamIdx: number): PlayerState[] {
    return this.core.participants(teamIdx).filter((q) => q.alive && !q.downed && !q.washed);
  }

  private everyoneAboard(teamIdx: number): boolean {
    const req = this.required(teamIdx);
    return req.length > 0 && req.every((q) => q.boarded);
  }

  /** RaftWorld step 8: boarding countdown and the launch condition. */
  step(clock: ClockInfo | null): void {
    const core = this.core;
    if (!clock) return;
    for (const site of core.island.sites) {
      const teamIdx = site.team;
      if (this.launched.has(teamIdx)) continue;
      const team = core.team(teamIdx);
      if (team.stage < 3) continue;
      const parts = core.participants(teamIdx);
      const aboard = parts.filter((q) => q.boarded);
      if (aboard.length === 0) continue;
      let go = this.everyoneAboard(teamIdx);
      if (!go && core.state.launchTicksLeft > 0) {
        core.state.launchTicksLeft--;
        go = core.state.launchTicksLeft === 0;
      }
      if (!go) continue;
      this.launched.add(teamIdx);
      core.state.launchTicksLeft = 0;
      core.emit({
        type: "launchRequest",
        tick: core.tick(),
        team: teamIdx,
        aboard: aboard.map((q) => q.id),
        left: parts.filter((q) => !q.boarded).map((q) => q.id),
      });
    }
  }
}
