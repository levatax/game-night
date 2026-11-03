// Visible dynamic difficulty. Owner: server-world.
//
// One integer level per team: -1 "sert", 0 "dengeli", +1 "yardım". There is no hidden smoothing: the level only
// changes when one of the discrete triggers below fires. The setting is internal only: no notice, no HUD, no
// wire field (team decision: visible DDA is not shipped).
//
// Triggers (a team that is drowning gets help; a team that is coasting gets pressure):
//   help  when DDA_HELP_DOWNS downs land inside DDA_DOWN_WINDOW_TICKS, or DDA_HELP_WASHED teammates are washed,
//         or the match is half over and the raft is still at stage 0.
//   hard  when no down landed for DDA_HARD_QUIET_TICKS and the raft is at stage ≥ 2 before DDA_HARD_PROGRESS.
//   even  otherwise.
// A lost match carries one saved help step into the next attempt (DDA_MAX_ATTEMPT_ASSIST), so a room that keeps
// failing visibly gets easier instead of silently rubber-banding mid-match.

import { DDA_DOWN_WINDOW_TICKS, DDA_HARD_PROGRESS, DDA_HELP_DOWNS, DDA_HELP_WASHED, DDA_LEVELS, DDA_MAX_ATTEMPT_ASSIST } from "../../shared/constants.js";
import { matchTicks, type ClockInfo } from "../../shared/rules/schedule.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";

/** Downs newer than this many ticks count toward the help trigger. */
const WINDOW = DDA_DOWN_WINDOW_TICKS;

export class DifficultyDirector {
  private readonly level = new Map<number, number>();
  private readonly downTicks: number[] = [];
  private lastDowns = 0;
  /** Saved help steps from previous lost attempts (0..DDA_MAX_ATTEMPT_ASSIST). */
  private assist = 0;

  constructor(private readonly core: WorldCore) {}

  /** Match start: every team begins at `assist` (0 = the first run's "dengeli"). */
  reset(assist = 0): void {
    this.assist = Math.max(0, Math.min(DDA_MAX_ATTEMPT_ASSIST, Math.round(assist)));
    this.level.clear();
    this.downTicks.length = 0;
    this.lastDowns = 0;
    // Attempt 1 starts at the neutral level ("dengeli"); each lost attempt buys a visible help step ("yardım").
    // The starting level is announced like every later step: visible DDA, never a silent head start.
    this.core.state.teams.forEach((t) => {
      const level = this.assist > 0 ? DDA_LEVELS.help : DDA_LEVELS.even;
      this.level.set(t.index, level);
    });
  }

  /** Current level of a team (-1..+1). */
  of(team: number): number {
    return this.level.get(team) ?? 0;
  }

  /** Saved help steps from lost attempts (0..DDA_MAX_ATTEMPT_ASSIST); deeper steps ease the match further. */
  assistSteps(): number {
    return this.assist;
  }

  /** RaftWorld step 1b: fold this tick's downs in and re-evaluate each team. */
  step(clock: ClockInfo): void {
    const st = this.core.state;
    let downs = 0;
    let washed = 0;
    st.players.forEach((p: PlayerState) => {
      if (p.spectator) return;
      downs += p.stats.downs;
      if (p.washed) washed++;
    });
    if (downs !== this.lastDowns) {
      const now = this.core.tick();
      for (let i = this.lastDowns; i < downs; i++) this.downTicks.push(now);
      this.lastDowns = downs;
    }
    while (this.downTicks.length > 0 && this.downTicks[0]! < this.core.tick() - WINDOW) this.downTicks.shift();

    const total = Math.max(1, matchTicks(this.core.timings));
    const progress = 1 - clock.stormLeft / total;
    st.teams.forEach((team) => {
      const prev = this.of(team.index);
      const next = this.evaluate(prev, progress, washed, team.stage);
      if (next === prev) return;
      this.level.set(team.index, next);
    });
    // Coop: the single team's level is the room's level. (Duel would index per team.)
  }

  private evaluate(prev: number, progress: number, washed: number, stage: number): number {
    // A saved help step from a lost attempt is a FLOOR for the whole match: the next run stays easier until it
    // is won (the room then resets the ladder). In-match triggers may still step further up from there.
    const floor = this.assist > 0 ? DDA_LEVELS.help : Number.NEGATIVE_INFINITY;
    const struggling = this.downTicks.length >= DDA_HELP_DOWNS || washed >= DDA_HELP_WASHED || (progress >= 0.5 && stage < 1);
    if (struggling) return Math.max(floor, DDA_LEVELS.help);
    const quiet = this.downTicks.length === 0;
    if (quiet && stage >= 2 && progress < DDA_HARD_PROGRESS && prev !== DDA_LEVELS.help) return Math.max(floor, DDA_LEVELS.hard);
    // Leave "help" only when nothing is wrong anymore; leave "hard" as soon as the schedule slips.
    return Math.max(floor, DDA_LEVELS.even);
  }


}
