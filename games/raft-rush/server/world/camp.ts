// The shared camp economy outside the raft (Long Tide §4.1, §5 T3): spring charges and the wreck's scrap.
// Owner: server-world.
//
// Spring: team.springCharges starts at its cap (SPRING_BASE_CHARGES + SPRING_CHARGES_PER_SEAT × seats); every gourd
// or drink uses one (ActionSystem.spring); below the cap one comes back every SPRING_RECHARGE_TICKS.
// Wreck: team.wreckScrap starts at WRECK_SCRAP_BASE + seats and gains WRECK_SCRAP_PER_DAWN at every dawn from
// day 2. Salvaging is a hold-E channel at the wreck with a hammer in any slot (CHANNEL.SALVAGE, salvageTicksFor);
// each completion takes one scrap (into the inventory, dropped at the feet when it doesn't fit; MVP_POINTS.salvage).

import {
  MVP_POINTS,
  SPRING_BASE_CHARGES,
  SPRING_CHARGES_PER_SEAT,
  SPRING_RECHARGE_TICKS,
  WRECK_SCRAP_BASE,
  WRECK_SCRAP_PER_DAWN,
} from "../../shared/constants.js";
import type { PlayerState, TeamState } from "./context.js";
import type { WorldCore } from "./core.js";

export class CampSystem {
  /** Team index → tick the next spring charge comes back (only while below the cap). */
  private readonly springAt = new Map<number, number>();

  constructor(private readonly core: WorldCore) {}

  /** The spring's cap for a team of `seats` seats. */
  springCap(team: Pick<TeamState, "seats">): number {
    return Math.min(255, SPRING_BASE_CHARGES + SPRING_CHARGES_PER_SEAT * team.seats);
  }

  /** Match start (after the raft set team.seats): full spring, a fresh wreck, no bench, the boss alive. */
  setup(team: TeamState): void {
    team.springCharges = this.springCap(team);
    team.wreckScrap = Math.min(255, WRECK_SCRAP_BASE + team.seats);
    team.benchTier = 0;
    team.bossDown = false;
    this.springAt.delete(team.index);
  }

  reset(): void {
    this.springAt.clear();
  }

  /** Use one spring charge of the team (false when dry). */
  useSpring(teamIdx: number): boolean {
    const team = this.core.team(teamIdx);
    if (team.springCharges <= 0) return false;
    team.springCharges--;
    if (!this.springAt.has(teamIdx)) this.springAt.set(teamIdx, this.core.tick() + SPRING_RECHARGE_TICKS);
    return true;
  }

  /** Dawn of `day`: the sea washes more scrap into the wreck (from day 2). */
  onDawn(day: number): void {
    if (day < 2) return;
    for (const site of this.core.island.sites) {
      const team = this.core.team(site.team);
      team.wreckScrap = Math.min(255, team.wreckScrap + WRECK_SCRAP_PER_DAWN);
    }
  }

  /** One finished salvage unit for `p` (the channel checked the hammer and the reach). False when the wreck is empty. */
  salvageUnit(p: PlayerState): boolean {
    const core = this.core;
    const team = core.team(core.site(p.team).team);
    if (team.wreckScrap <= 0) return false;
    team.wreckScrap--;
    core.giveItem(p, "scrap", 1, "salvage");
    p.stats.gathered = Math.min(65535, p.stats.gathered + 1);
    core.addScore(p, MVP_POINTS.salvage);
    return true;
  }

  /** Every playing tick: spring recharge. */
  step(): void {
    if (this.springAt.size === 0) return;
    const now = this.core.tick();
    for (const [teamIdx, due] of this.springAt) {
      if (now < due) continue;
      const team = this.core.team(teamIdx);
      const cap = this.springCap(team);
      if (team.springCharges < cap) team.springCharges++;
      if (team.springCharges < cap) this.springAt.set(teamIdx, now + SPRING_RECHARGE_TICKS);
      else this.springAt.delete(teamIdx);
    }
  }
}
