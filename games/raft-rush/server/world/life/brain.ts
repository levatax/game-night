// Server-only memory of one monster (the schema MonsterState carries only what clients render). Owner:
// server-world-life. One MonsterBrain per state.monsters entry, keyed by id, created with the monster and
// dropped with it.

import type { MonsterKind } from "../../../shared/types.js";

/** What the monster is currently going for (MonsterState.targetId says which one). */
export type GoalKind = "none" | "player" | "bait" | "raft" | "chest" | "edge" | "camp" | "shore" | "visit";

/** Daytime thieves' little scripts. */
export type VisitPhase = "approach" | "grab" | "escape" | "perch" | "circle" | "toBeach" | "leave";

export interface VisitorMemory {
  phase: VisitPhase;
  /** Player being robbed ("" = the camp chest). */
  victimId: string;
  /** Where the loot came from: victim id or "chest" (StealEvent.fromId). */
  fromId: string;
  /** Ticks in the current phase (chase / approach timeouts). */
  phaseTicks: number;
  /** Monkey: escape tree node index (-1 none). */
  tree: number;
  /** Gull: circle center, current angle and total angle travelled while circling (radians). */
  cx: number;
  cz: number;
  angle: number;
  travel: number;
  /** Gull / monkey destination (beach drop point, escape point out at sea). */
  tx: number;
  tz: number;
}

export interface MonsterBrain {
  kind: MonsterKind;
  /** Night of the wave (0 = daytime visitor). */
  night: number;
  /** Stagger: think when (tick + phase) % MONSTER_THINK_TICKS === 0. */
  phase: number;
  /** Re-think on the next tick regardless of the stagger (bait landed, target lost…). */
  forceThink: boolean;
  goal: GoalKind;
  /** Fixed goal point (edge / camp / shore / visit); players and bait are re-read every tick. */
  gx: number;
  gz: number;
  /** Stop when this close to the goal point. */
  arrive: number;
  /** Bite cooldown and wind-up (ticks). */
  cooldown: number;
  windup: number;
  /** Raft gnaw progress (ticks toward RAFT_GNAW_TICKS). */
  gnaw: number;
  /** Fence being gnawed / snagged on ("" none) and progress ticks. */
  fenceId: string;
  fenceTicks: number;
  /** Knockback velocity (m/s), decays every tick. */
  kvx: number;
  kvz: number;
  /** Steering side memory (+1 / −1) and how long to keep it. */
  side: number;
  sideTicks: number;
  /** Stuck detector + random detour. */
  stuck: number;
  detour: number;
  dx: number;
  dz: number;
  /** Fleeing at dawn (flipped crabs flee once they get back up). */
  dawn: boolean;
  fleeTicks: number;
  /** Stunned by a torch: back away from here. */
  sx: number;
  sz: number;
  /** Boss: ticks spent on the current bait; baits it already fell for. */
  lureTicks: number;
  ignoreBait: Set<string>;
  /** Separation push accumulated this tick. */
  px: number;
  pz: number;
  visit: VisitorMemory | null;
}

export function createBrain(kind: MonsterKind, night: number, phase: number): MonsterBrain {
  return {
    kind,
    night,
    phase,
    forceThink: true,
    goal: "none",
    gx: 0,
    gz: 0,
    arrive: 0.5,
    cooldown: 0,
    windup: 0,
    gnaw: 0,
    fenceId: "",
    fenceTicks: 0,
    kvx: 0,
    kvz: 0,
    side: phase % 2 === 0 ? 1 : -1,
    sideTicks: 0,
    stuck: 0,
    detour: 0,
    dx: 0,
    dz: 0,
    dawn: false,
    fleeTicks: 0,
    sx: 0,
    sz: 0,
    lureTicks: 0,
    ignoreBait: new Set(),
    px: 0,
    pz: 0,
    visit: null,
  };
}

export function createVisit(victimId: string): VisitorMemory {
  return { phase: "approach", victimId, fromId: "", phaseTicks: 0, tree: -1, cx: 0, cz: 0, angle: 0, travel: 0, tx: 0, tz: 0 };
}
