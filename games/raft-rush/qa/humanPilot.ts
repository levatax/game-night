// Deterministic human pilot policy for the QA harness. Owner: qa. This file changes no game logic: the pilot is a
// normal (non-bot) player seat driven through the same RaftWorld.queueInput / craft / chest calls a browser sends,
// with human imperfection layered on top (reaction latency, hesitation, mis-aim, fumbled craft/chest clicks).
//
// It reuses the server's BotDesk for decision making and steering only. The desk is a command source here; the
// seat is not a bot (p.bot = false), so the launch rule ("only a human may start the departure") applies, and the
// delivery rule ("bots never deliver on a human team") does not exempt this seat.
//
// Two skills:
//   expert — quick reactions (0.07–0.10 s input latency), no dropped inputs, no fumbled interactions, walks to the
//            raft as soon as the gate opens.
//   novice — slower start (looks around for 6–18 s), 0.23–0.40 s input latency, 6 % of inputs never pressed,
//            14 % of craft/chest clicks fumbled, occasional 1–2 s distractions, and 3–9 s of hesitation before
//            walking to the raft at the departure gate. Same brain, worse hands: the tempo difference is what is
//            measured.
//
// Every random pick comes from a mulberry32 seeded off the run seed, so a run is deterministic for
// (seed, scenario, skill).

import { secToTicks, TICK_RATE } from "../shared/constants.js";
import { mulberry32 } from "../shared/island/noise.js";
import { wrapAngle } from "../shared/sim/math.js";
import type { InputCmd, ChestMsg, EmoteMsg, MarkerMsg } from "../shared/protocol.js";
import type { BotRole, RecipeId } from "../shared/types.js";
import { BotDesk, type BotHost } from "../server/room/bots.js";
import { PlayerState, type RaftState } from "../server/schema.js";
import type { RaftWorld } from "../server/world/World.js";

export type PilotSkill = "expert" | "novice";

interface SkillProfile {
  /** Ticks with no input after the landing lock lifts (the player is still reading the screen). */
  startDelaySec: [number, number];
  /** Input latency in ticks: a command reaches the server this many ticks after the "keypress". */
  latencyTicks: [number, number];
  /** Chance an input is never pressed at all (missed key). */
  dropChance: number;
  /** Chance a craft / chest click is fumbled (wrong key, menu closed). */
  fumbleChance: number;
  /** Uniform yaw error in radians on every command (hand tremor / mouse slip). */
  yawNoise: number;
  /** Distraction pauses during the match: [min gap s, max gap s, min length s, max length s]. */
  distraction: [number, number, number, number] | null;
  /** Hesitation before walking to the raft once the board goal appears, in seconds. */
  boardHesitationSec: [number, number];
}

const PROFILES: Readonly<Record<PilotSkill, SkillProfile>> = {
  expert: {
    startDelaySec: [0.5, 2],
    latencyTicks: [2, 3],
    dropChance: 0,
    fumbleChance: 0,
    yawNoise: 0.015,
    distraction: null,
    boardHesitationSec: [0, 0],
  },
  novice: {
    startDelaySec: [6, 18],
    latencyTicks: [7, 12],
    dropChance: 0.06,
    fumbleChance: 0.14,
    yawNoise: 0.12,
    distraction: [35, 75, 1, 2.5],
    boardHesitationSec: [3, 9],
  },
};

/** Uniform integer in [lo, hi] (inclusive) from the pilot rng. */
function pickInt(rng: () => number, lo: number, hi: number): number {
  return lo + Math.floor(rng() * (hi - lo + 1));
}

function pickSec(rng: () => number, span: [number, number]): number {
  return span[0] + rng() * (span[1] - span[0]);
}

export interface PilotStats {
  /** Inputs the pilot never pressed (blackout / distraction / missed key). */
  dropped: number;
  /** Craft / chest clicks that failed because the pilot fumbled them. */
  fumbled: number;
  /** Ticks with no input because the player was "distracted" (start delay included). */
  blackoutTicks: number;
}

export class HumanPilot implements BotHost {
  readonly state: RaftState;
  readonly world: RaftWorld;
  private readonly desk: BotDesk;
  private readonly profile: SkillProfile;
  private readonly rand: () => number;
  private clock = 0;
  private pending: Array<{ at: number; cmd: InputCmd }> = [];
  private blackoutUntil = 0;
  private nextDistraction = Infinity;
  private boardHoldUntil = 0;
  private boardHoldSeen = false;
  private readonly stats: PilotStats = { dropped: 0, fumbled: 0, blackoutTicks: 0 };

  constructor(
    private readonly seatId: string,
    private readonly skill: PilotSkill,
    world: RaftWorld,
    state: RaftState,
    seed: number,
  ) {
    this.world = world;
    this.state = state;
    this.profile = PROFILES[skill];
    this.rand = mulberry32((seed ^ 0x9e3779b9) >>> 0);
    this.desk = new BotDesk(this);
    this.blackoutUntil = secToTicks(pickSec(this.rand, this.profile.startDelaySec));
    if (this.profile.distraction) {
      const [gapMin, gapMax] = this.profile.distraction;
      this.nextDistraction = this.blackoutUntil + secToTicks(this.rng() * (gapMax - gapMin) + gapMin);
    }
  }

  /** Start driving the human seat (after world.startMatch so the character is known). */
  attach(role: BotRole): void {
    this.desk.add(this.seatId, role);
    this.desk.reset();
  }

  /** Current goal key of the pilot seat (diagnostics only). */
  currentGoal(): string {
    return this.desk.goalOf(this.seatId);
  }

  get pilotStats(): PilotStats {
    return this.stats;
  }

  /** Called once per fixed tick BEFORE world.step(); same place BotDesk.tick runs for the bots. */
  tick(): void {
    this.clock++;
    this.maybeDistract();
    this.maybeHesitate();
    this.desk.tick();
    this.flush();
  }

  /* ============================================================ BotHost */

  rng(): number {
    return this.rand();
  }

  queueInput(_id: string, cmd: InputCmd): void {
    if (this.hesitating()) {
      this.stats.dropped++;
      return;
    }
    if (this.clock < this.blackoutUntil) {
      this.stats.dropped++;
      this.stats.blackoutTicks++;
      return;
    }
    if (this.profile.dropChance > 0 && this.rand() < this.profile.dropChance) {
      this.stats.dropped++;
      return;
    }
    const latency = pickInt(this.rand, this.profile.latencyTicks[0], this.profile.latencyTicks[1]);
    const yaw = wrapAngle(cmd.yaw + (this.rand() * 2 - 1) * this.profile.yawNoise);
    this.pending.push({ at: this.clock + latency, cmd: { ...cmd, yaw } });
  }

  craft(id: string, recipe: RecipeId): boolean {
    if (this.profile.fumbleChance > 0 && this.rand() < this.profile.fumbleChance) {
      this.stats.fumbled++;
      return false;
    }
    return this.world.craft(id, recipe);
  }

  chest(id: string, msg: ChestMsg): boolean {
    if (this.profile.fumbleChance > 0 && this.rand() < this.profile.fumbleChance) {
      this.stats.fumbled++;
      return false;
    }
    return this.world.chest(id, msg);
  }

  emote(_id: string, _msg: EmoteMsg): boolean {
    return true;
  }

  marker(_id: string, _msg: MarkerMsg): boolean {
    return true;
  }

  /* ============================================================ internals */

  private flush(): void {
    if (!this.pending.length) return;
    let i = 0;
    while (i < this.pending.length && this.pending[i]!.at <= this.clock) {
      this.world.queueInput(this.seatId, this.pending[i]!.cmd);
      i++;
    }
    if (i > 0) this.pending = this.pending.slice(i);
  }

  private maybeDistract(): void {
    const d = this.profile.distraction;
    if (!d) return;
    if (this.clock < this.nextDistraction) return;
    const [gapMin, gapMax, lenMin, lenMax] = d;
    this.blackoutUntil = Math.max(this.blackoutUntil, this.clock + secToTicks(lenMin + this.rng() * (lenMax - lenMin)));
    this.nextDistraction = this.blackoutUntil + secToTicks(gapMin + this.rng() * (gapMax - gapMin));
  }

  /**
   * Standing still for a few seconds when the raft says "board" models a player who did not notice the gate at
   * once. It is reset by any other goal, so a repair (stage drops) is followed by a fresh hesitation, not a stale
   * one. Only the novice profile has a non-zero span.
   */
  private maybeHesitate(): void {
    const span = this.profile.boardHesitationSec;
    if (span[1] <= 0) return;
    if (this.state.phase !== "playing") return;
    const goal = this.desk.goalOf(this.seatId);
    if (!goal.startsWith("board")) {
      this.boardHoldSeen = false;
      this.boardHoldUntil = 0;
      return;
    }
    if (this.boardHoldSeen) return;
    this.boardHoldSeen = true;
    this.boardHoldUntil = this.clock + secToTicks(pickSec(this.rand, span));
  }

  /** True while the pilot is hesitating before boarding (checked from the command source). */
  private hesitating(): boolean {
    return this.boardHoldUntil > this.clock;
  }
}

/** Seconds of match time that passed before the pilot's first real input (diagnostic). */
export function firstInputSec(droppedTicks: number): number {
  return Math.round((droppedTicks / TICK_RATE) * 10) / 10;
}

/** Role the pilot plays: a wood-first hauler for both skills, so the only difference is the hands. */
export const PILOT_ROLE: BotRole = "hamal";

/** Human seat player factory (p.bot stays false: the launch rule and the delivery rule both treat it as human). */
export function makePilotPlayer(id: string, nickname: string, character: PlayerState["character"], seat: number, state: RaftState): PlayerState {
  const p = new PlayerState();
  p.id = id;
  p.nickname = nickname;
  p.character = character;
  p.seat = seat;
  p.ready = true;
  state.players.set(p.id, p);
  return p;
}
