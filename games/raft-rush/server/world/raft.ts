// The raft: day-locked delivery, assembly, raft hp / repair / stage loss, boarding and the push-off (Long Tide §3;
// game4.md §4, §7; docs/ARCHITECTURE.md §2.4–2.6). Owner: server-world.
//
// Stages are data (RAFT_STAGES): each has up to 3 requirement slots sized by seats × the difficulty raftCostMult
// (shared/items.ts raftStageNeeds), a minDay and an assembly time. A stage is done when its materials are
// delivered AND its assembly work is finished. The raft only takes materials for the CURRENT stage, only from its
// minDay on (stageDayLock; RAFT_TEST fast: day 1), straight from the deliverer's pockets (planRaftDelivery, surplus
// stays). Assembly: players hold E at the raft (CHANNEL.BUILD) once every material is in; each tick the team adds
// assemblyWorkPerTick(holders) work (hammer 1 / hand 0.5 per holder × CharacterDef.assemblyMult, × 1 / 1.2 / 1.4
// for 1 / 2 / 3+ holders, at most 4 count, nothing below the stage's minHolders: the mast needs 2). Work is kept
// when people let go. The per-stage progress (materials, work) lives here; the schema shows the current stage's
// (team.raftHave / raftNeed / raftWork / raftWorkNeed).
// Raft hp (team.raftHp) exists once the keel is assembled (100 the first time, RAFT_HP_AFTER_LOSS after a loss):
// gnawing / puffers / the boss lower it (WorldContext.damageRaft); a hammer + 1 plank (+20, Kaptan +30) or 2 wood
// (+10) repairs it. At 0 the highest assembled stage loses its assembly (work 0, materials kept, it becomes the
// current stage again), hp back to RAFT_HP_AFTER_LOSS; on the launch stage that also aborts the push-off.
// Boarding (stage RAFT_LAUNCH_STAGE, day ≥ launchDayFor, hp ≥ RAFT_HP_BOARD): E puts you on a raft seat. The first
// boarding starts the push-off (state.launchTicksLeft = timings.launchWait) and calls spawnLaunchWave(); the raft
// leaves once every required teammate (alive, not downed, not washed) is aboard and timings.launchMin has passed,
// or when the countdown runs out (with whoever is aboard; the living left behind cost LEFT_BEHIND_PENALTY each at
// scoring). The room turns launchRequest into the launch phase.

import {
  CHANNEL,
  CHARACTERS,
  ESCORT_RADIUS,
  MVP_POINTS,
  ASSEMBLY_POINT_TICKS,
  RAFT_HP_AFTER_LOSS,
  RAFT_HP_MAX,
  RAFT_LAUNCH_STAGE,
  RAFT_RANGE,
  RAFT_REPAIR_PLANK_HP,
  RAFT_REPAIR_WOOD_HP,
  RAFT_REQ_SLOTS,
  RAFT_STAGES,
  WATER_Y,
} from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { raftAssemblyTicks, raftSeatsClamp, raftStageNeeds } from "../../shared/items.js";
import {
  assemblyWorkPerTick,
  carriesRaftGoods,
  planRaftDelivery,
  planRaftRepair,
  raftBoardable,
  raftFinished,
  raftMaterialsDone,
  raftStageOpen,
  type AssemblyHolder,
} from "../../shared/rules/interact.js";
import { countOf } from "../../shared/rules/inventory.js";
import type { ClockInfo } from "../../shared/rules/schedule.js";
import type { Difficulty, ItemKind, RaftStage, Vec3Like } from "../../shared/types.js";
import type { PlayerState, TeamState } from "./context.js";
import type { WorldCore } from "./core.js";
import { dist2, point, RANGE_SLACK, RAFT_DECK_Y, RAFT_SEATS } from "./rules.js";

/** Materials delivered and assembly work done on one build stage. */
interface StageProgress {
  have: number[];
  work: number;
}

export class RaftSystem {
  /** Teams whose first-aboard bonus was paid this match. */
  private readonly firstAboardPaid = new Set<number>();
  /** Team whose push-off state.launchTicksLeft is counting (-1 none; the countdown is one shared schema field). */
  private pushOffTeam = -1;
  /** Teams whose launch was requested (once per match). */
  private readonly launched = new Set<number>();
  /** Per team: progress of every build stage (index = stage). */
  private readonly progress = new Map<number, StageProgress[]>();
  /** Teams whose keel was assembled at least once (a re-assembled keel comes back at RAFT_HP_AFTER_LOSS). */
  private readonly keelBuilt = new Set<number>();
  /** Per player: assembly ticks held while the raft advanced, not yet paid as MVP points. */
  private readonly heldTicks = new Map<string, number>();
  /** Per team: who held E on the current stage (credited in the raftStage event). */
  private readonly contributors = new Map<number, Set<string>>();
  /** Scratch for assemblyWorkPerTick. */
  private readonly holders: PlayerState[] = [];
  private readonly holderInfo: AssemblyHolder[] = [];

  constructor(private readonly core: WorldCore) {}

  private get cheap(): boolean {
    return this.core.timings.cheapRaft;
  }

  private get difficultyId(): Difficulty {
    return this.core.state.difficulty;
  }

  /** The day the locks compare against (the landing counts as day 1). */
  private day(): number {
    return this.core.dayClock?.day ?? Math.max(1, this.core.state.day);
  }

  /** Units each slot of `stage` needs for `team` (seats × raftCostMult; fast: 1). */
  needs(team: TeamState, stage: RaftStage): number[] {
    return raftStageNeeds(stage, team.seats, this.core.difficulty.raftCostMult, this.cheap);
  }

  /** Match start: a fresh raft (nothing built, no hp) for `seats` seats. */
  setup(team: TeamState, seats: number): void {
    team.seats = raftSeatsClamp(seats);
    const teamIdx = team.index;
    const prog: StageProgress[] = RAFT_STAGES.map(() => ({ have: new Array<number>(RAFT_REQ_SLOTS).fill(0), work: 0 }));
    this.progress.set(teamIdx, prog);
    this.keelBuilt.delete(teamIdx);
    this.contributors.delete(teamIdx);
    team.stage = 0;
    team.raftHp = 0;
    this.sync(team);
  }

  /** Forget per-match flags. */
  reset(): void {
    this.firstAboardPaid.clear();
    this.launched.clear();
    this.pushOffTeam = -1;
    this.progress.clear();
    this.keelBuilt.clear();
    this.heldTicks.clear();
    this.contributors.clear();
  }

  /** A player left the room: drop what is kept for them. */
  forget(id: string): void {
    this.heldTicks.delete(id);
  }

  /** A launch was requested this match (for any team). */
  hasLaunched(): boolean {
    return this.launched.size > 0;
  }

  /** Progress of `stage` (created on demand so a team set up outside setup() still works). */
  private stageProgress(teamIdx: number, stage: number): StageProgress | null {
    if (stage < 0 || stage >= RAFT_STAGES.length) return null;
    let prog = this.progress.get(teamIdx);
    if (!prog) {
      prog = RAFT_STAGES.map(() => ({ have: new Array<number>(RAFT_REQ_SLOTS).fill(0), work: 0 }));
      this.progress.set(teamIdx, prog);
    }
    return prog[stage]!;
  }

  /** Mirror the current stage's progress into the schema. */
  sync(team: TeamState): void {
    const stage = team.stage;
    const need = this.needs(team, stage);
    const prog = this.stageProgress(team.index, stage);
    for (let i = 0; i < RAFT_REQ_SLOTS; i++) {
      const n = Math.min(255, need[i] ?? 0);
      const h = Math.min(255, prog?.have[i] ?? 0);
      if (team.raftNeed[i] !== n) team.raftNeed[i] = n;
      if (team.raftHave[i] !== h) team.raftHave[i] = h;
    }
    const workNeed = raftAssemblyTicks(stage, this.cheap);
    const work = Math.min(workNeed, Math.floor(prog?.work ?? 0));
    if (team.raftWorkNeed !== workNeed) team.raftWorkNeed = workNeed;
    if (team.raftWork !== work) team.raftWork = work;
  }

  /**
   * Jump the raft of `teamIdx` to `stage` (tests, RAFT_TEST tooling): every earlier stage counts as delivered and
   * assembled, `stage` and the later ones as untouched; raft hp `hp` (default: RAFT_HP_MAX once the keel exists).
   */
  setStage(teamIdx: number, stage: number, hp?: number): void {
    const team = this.core.team(teamIdx);
    const s = Math.max(0, Math.min(RAFT_LAUNCH_STAGE, Math.floor(stage)));
    for (let k = 0; k < RAFT_STAGES.length; k++) {
      const prog = this.stageProgress(teamIdx, k)!;
      const done = k < s;
      const need = this.needs(team, k);
      for (let i = 0; i < RAFT_REQ_SLOTS; i++) prog.have[i] = done ? (need[i] ?? 0) : 0;
      prog.work = done ? raftAssemblyTicks(k, this.cheap) : 0;
    }
    team.stage = s;
    if (s > 0) this.keelBuilt.add(teamIdx);
    team.raftHp = s > 0 ? Math.max(0, Math.min(RAFT_HP_MAX, hp ?? RAFT_HP_MAX)) : 0;
    this.sync(team);
  }

  /** Stages assembled so far (loss score). */
  stagesAssembled(teamIdx: number): number {
    return Math.min(RAFT_LAUNCH_STAGE, this.core.team(teamIdx).stage);
  }

  /* --------------------------------------------------------------- delivery */

  /** E at the raft: deliver what the current stage still needs. Rejects notReady / stageLocked / wrongStage / nothingToDeliver. */
  deliver(p: PlayerState): boolean {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    if (raftFinished(team)) {
      core.reject(p, "deliver", "notReady", "deliver");
      return false;
    }
    if (!raftStageOpen(team, this.day(), this.cheap)) {
      core.reject(p, "deliver", "stageLocked", "deliver");
      return false;
    }
    const plan = planRaftDelivery(p, team);
    if (!plan) {
      core.reject(p, "deliver", carriesRaftGoods(p) ? "wrongStage" : "nothingToDeliver", "deliver");
      return false;
    }
    const prog = this.stageProgress(teamIdx, team.stage)!;
    for (const it of plan.items) core.bag.take(p, it.kind, it.count);
    for (let i = 0; i < RAFT_REQ_SLOTS; i++) prog.have[i] = (prog.have[i] ?? 0) + (plan.slots[i] ?? 0);
    this.sync(team);
    p.stats.delivered = Math.min(65535, p.stats.delivered + plan.units);
    core.addScore(p, MVP_POINTS.deliver * plan.units + MVP_POINTS.heavy * plan.heavy);
    if (plan.heavy > 0) this.payEscorts(p, plan.heavy);
    const items: { kind: ItemKind; count: number }[] = plan.items.map((it) => ({ kind: it.kind, count: it.count }));
    core.emit({
      type: "deliver",
      tick: core.tick(),
      playerId: p.id,
      team: teamIdx,
      stage: plan.stage,
      items,
      newStage: team.stage,
      materialsDone: raftMaterialsDone(team),
    });
    return true;
  }

  /** Teammates within ESCORT_RADIUS of a heavy delivery get MVP_POINTS.escort per heavy unit. */
  private payEscorts(carrier: PlayerState, heavy: number): void {
    const r2 = ESCORT_RADIUS * ESCORT_RADIUS;
    for (const q of this.core.alivePlayers(carrier.team)) {
      if (q === carrier || q.downed) continue;
      if (dist2(q.x, q.z, carrier.x, carrier.z) <= r2) this.core.addScore(q, MVP_POINTS.escort * heavy);
    }
  }

  /* --------------------------------------------------------------- assembly */

  /** The BUILD channel of `p` may go on: its team's stage has every material in, is open today, and `p` is at the raft. */
  canAssemble(p: PlayerState): boolean {
    const core = this.core;
    const site = core.site(p.team);
    const team = core.team(site.team);
    if (!raftMaterialsDone(team) || !raftStageOpen(team, this.day(), this.cheap)) return false;
    const reach = RAFT_RANGE + RANGE_SLACK;
    return dist2(p.x, p.z, site.raft.x, site.raft.z) <= reach * reach;
  }

  /** One tick of assembly for a team: everyone holding E at the raft adds work; a finished stage completes. */
  private stepAssembly(teamIdx: number): void {
    const core = this.core;
    const team = core.team(teamIdx);
    if (raftFinished(team) || !raftMaterialsDone(team) || !raftStageOpen(team, this.day(), this.cheap)) return;
    const def = RAFT_STAGES[team.stage]!;
    const site = core.site(teamIdx);
    const reach = RAFT_RANGE + RANGE_SLACK;
    const holders = this.holders;
    const info = this.holderInfo;
    holders.length = 0;
    info.length = 0;
    for (const q of core.participants(teamIdx)) {
      if (!q.alive || q.downed || q.boarded || q.channel !== CHANNEL.BUILD) continue;
      if (dist2(q.x, q.z, site.raft.x, site.raft.z) > reach * reach) continue;
      holders.push(q);
      info.push({ hammer: countOf(q, "hammer") > 0, character: q.character });
    }
    const work = assemblyWorkPerTick(info, def.minHolders);
    if (work <= 0) return;
    const prog = this.stageProgress(teamIdx, team.stage)!;
    prog.work += work;
    let who = this.contributors.get(teamIdx);
    if (!who) {
      who = new Set<string>();
      this.contributors.set(teamIdx, who);
    }
    for (const q of holders) {
      who.add(q.id);
      const held = (this.heldTicks.get(q.id) ?? 0) + 1;
      if (held >= ASSEMBLY_POINT_TICKS) {
        core.addScore(q, MVP_POINTS.assemble);
        this.heldTicks.set(q.id, held - ASSEMBLY_POINT_TICKS);
      } else this.heldTicks.set(q.id, held);
    }
    if (prog.work + 1e-9 < raftAssemblyTicks(team.stage, this.cheap)) {
      this.sync(team);
      return;
    }
    this.completeStage(teamIdx, holders);
  }

  private completeStage(teamIdx: number, holders: readonly PlayerState[]): void {
    const core = this.core;
    const team = core.team(teamIdx);
    const done = team.stage;
    const prog = this.stageProgress(teamIdx, done)!;
    prog.work = raftAssemblyTicks(done, this.cheap);
    team.stage = done + 1;
    if (done === 0) {
      team.raftHp = this.keelBuilt.has(teamIdx) ? Math.max(team.raftHp, RAFT_HP_AFTER_LOSS) : RAFT_HP_MAX;
      this.keelBuilt.add(teamIdx);
    }
    this.sync(team);
    // A clear beat: the holders let go (the next stage needs its own materials first).
    for (const q of holders) this.clearChannel(q);
    const ids = [...(this.contributors.get(teamIdx) ?? [])];
    this.contributors.delete(teamIdx);
    core.emit({ type: "raftStage", tick: core.tick(), team: teamIdx, stage: done, newStage: team.stage, lost: false, playerIds: ids });
    if (team.stage === RAFT_LAUNCH_STAGE) core.emit({ type: "raftReady", tick: core.tick(), team: teamIdx });
  }

  private clearChannel(q: PlayerState): void {
    if (q.channel !== CHANNEL.BUILD) return;
    q.channel = CHANNEL.NONE;
    q.channelTicks = 0;
    q.channelTarget = -1;
  }

  /* ------------------------------------------------------------- hp, repair */

  /** E at the raft with a hammer: one plank (+RAFT_REPAIR_PLANK_HP, + repairBonus) or 2 wood (+RAFT_REPAIR_WOOD_HP). */
  repair(p: PlayerState): boolean {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    const plan = planRaftRepair(p, team);
    if (!plan) {
      core.reject(p, "deliver", countOf(p, "hammer") > 0 ? "nothingToDeliver" : "needHammer", "repair");
      return false;
    }
    if (core.bag.take(p, plan.kind, plan.count) < plan.count) return false;
    const add = plan.kind === "raft_part" ? RAFT_REPAIR_PLANK_HP + CHARACTERS[p.character].repairBonus : RAFT_REPAIR_WOOD_HP;
    const before = team.raftHp;
    team.raftHp = Math.min(RAFT_HP_MAX, before + add);
    core.addScore(p, MVP_POINTS.repair);
    core.emit({ type: "raftRepair", tick: core.tick(), playerId: p.id, team: teamIdx, kind: plan.kind, added: team.raftHp - before, hp: team.raftHp });
    return true;
  }

  /** WorldContext.damageRaft: hp lost to gnawing / puffers / the boss; at 0 the highest assembled stage is lost. */
  damage(teamIdx: number, amount: number, byMonsterId: string, pos: Vec3Like): void {
    const core = this.core;
    const team = core.team(teamIdx);
    if (team.stage < 1 || team.raftHp <= 0) return;
    const lost = Math.min(team.raftHp, Math.max(0, Math.floor(amount)));
    if (lost <= 0) return;
    team.raftHp -= lost;
    // A wrecked raft (hp 0) keeps its assembled stages: it can't be boarded / pushed off until it is repaired to
    // RAFT_HP_BOARD. (Rolling a stage back on every lost night was a death spiral in the balance runs.)
    if (team.raftHp === 0 && team.stage === RAFT_LAUNCH_STAGE && core.state.launchTicksLeft > 0) this.loseStage(teamIdx);
    core.emit({ type: "raftDamage", tick: core.tick(), team: teamIdx, amount: lost, byMonsterId, pos: point(pos.x, pos.y, pos.z), hp: team.raftHp });
  }

  /** Raft hp hit 0: the highest assembled stage loses its assembly (materials kept); hp back to RAFT_HP_AFTER_LOSS. */
  private loseStage(teamIdx: number): void {
    const core = this.core;
    const team = core.team(teamIdx);
    const before = team.stage;
    if (before < 1) return;
    const lostStage = before - 1;
    const prog = this.stageProgress(teamIdx, lostStage);
    if (prog) prog.work = 0;
    team.stage = lostStage;
    team.raftHp = lostStage === 0 ? 0 : RAFT_HP_AFTER_LOSS;
    this.contributors.delete(teamIdx);
    if (before === RAFT_LAUNCH_STAGE) this.unboardAll(teamIdx);
    this.sync(team);
    core.emit({ type: "raftStage", tick: core.tick(), team: teamIdx, stage: lostStage, newStage: team.stage, lost: true, playerIds: [] });
  }

  /* ---------------------------------------------------------------- boarding */

  /** E on the finished raft (launch window open, hp ≥ RAFT_HP_BOARD, or the push-off already counting). */
  board(p: PlayerState): boolean {
    const core = this.core;
    const teamIdx = core.site(p.team).team;
    const team = core.team(teamIdx);
    const pushOff = core.state.launchTicksLeft > 0 && (this.pushOffTeam < 0 || this.pushOffTeam === teamIdx);
    const can = raftBoardable(team, this.day(), this.difficultyId, this.cheap, pushOff);
    if (!can.ok) {
      core.reject(p, "board", can.reason, "board");
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
    if (!pushOff) {
      this.pushOffTeam = teamIdx;
      core.state.launchTicksLeft = Math.max(1, core.timings.launchWait);
      this.spawnLaunchWave(teamIdx);
    }
    core.emit({ type: "board", tick: core.tick(), playerId: p.id, team: teamIdx, launchTicksLeft: core.state.launchTicksLeft });
    return true;
  }

  /** The push-off began: the launch wave comes for the raft (MonsterSystem.spawnLaunchWave, Long Tide §3.4). */
  private spawnLaunchWave(teamIdx: number): void {
    this.core.monsters.spawnLaunchWave(teamIdx);
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

  /** The push-off was aborted (the raft broke): everyone steps back onto the sand, the countdown stops. */
  private unboardAll(teamIdx: number): void {
    for (const q of this.core.participants(teamIdx)) {
      if (!q.boarded) continue;
      q.boarded = false;
      q.y = heightAt(this.core.island.grid, q.x, q.z);
      this.core.runtime.of(q).seat = -1;
    }
    this.core.state.launchTicksLeft = 0;
    this.pushOffTeam = -1;
  }

  /** Players the launch waits for: alive, not downed, not washed participants. */
  required(teamIdx: number): PlayerState[] {
    return this.core.participants(teamIdx).filter((q) => q.alive && !q.downed && !q.washed);
  }

  private everyoneAboard(teamIdx: number): boolean {
    const req = this.required(teamIdx);
    return req.length > 0 && req.every((q) => q.boarded);
  }

  /** RaftWorld step 8: assembly, then the push-off countdown and the launch condition. */
  step(clock: ClockInfo | null): void {
    const core = this.core;
    if (!clock) return;
    for (const site of core.island.sites) {
      const teamIdx = site.team;
      if (this.launched.has(teamIdx)) continue;
      const team = core.team(teamIdx);
      if (!raftFinished(team)) {
        this.stepAssembly(teamIdx);
        continue;
      }
      if (core.state.launchTicksLeft <= 0 || (this.pushOffTeam >= 0 && this.pushOffTeam !== teamIdx)) continue;
      const parts = core.participants(teamIdx);
      const aboard = parts.filter((q) => q.boarded);
      if (aboard.length === 0) {
        // Nobody left aboard (washed off the deck): the push-off stops until someone boards again.
        core.state.launchTicksLeft = 0;
        this.pushOffTeam = -1;
        continue;
      }
      core.state.launchTicksLeft--;
      const elapsed = core.timings.launchWait - core.state.launchTicksLeft;
      const go = core.state.launchTicksLeft === 0 || (elapsed >= core.timings.launchMin && this.everyoneAboard(teamIdx));
      if (!go) continue;
      this.launched.add(teamIdx);
      core.state.launchTicksLeft = 0;
      core.emit({
        type: "launchRequest",
        tick: core.tick(),
        team: teamIdx,
        aboard: aboard.map((q) => q.id),
        left: parts.filter((q) => !q.boarded).map((q) => q.id),
        leftBehind: parts.filter((q) => !q.boarded && q.alive && !q.washed).map((q) => q.id),
      });
    }
  }
}
