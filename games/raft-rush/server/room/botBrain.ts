// Pure decision functions for the helper bots (§12 roles, §19 "Botlar"). Owner: server-bots.
//
// chooseGoal(view) walks a fixed priority list and returns the first goal that applies (game4.md §19:
// flee → attack → eat/drink → deliver → gather → fish → ammo → camp, with the survival / co-op duties of
// docs/ARCHITECTURE.md §4.6 slotted in):
//   0. puffer in the inventory → throw it away (it explodes in hand)
//   1. flee        hp low and a monster close, outside a light ring
//   2. revive      a downed teammate we can reach in time (the two closest bots go)
//   3. board       the raft is ready and the humans are close (or aboard / nobody to wait for / storm close)
//   4. attack      monsters threatening the raft, the camp, a downed mate or us; daytime thieves
//   5. self-care   eat / drink / warm up / rest at the fire / fetch food or water; Aşçı passes food to mates
//   6. raft ready  wait at the raft
//   7. evening     keep the fire fuelled through the night; the guard plants a torch at the raft
//   8. deliver     carry what the current raft stage needs
//   9. craft       cook catches, tools for the role (axe / rod / spear), raft parts from chest wood
//  10. housekeep   burn jellyfish, stock surplus in the camp chest
//  11. work        gather / fish / water / chest fetch / ammo, scored by team needs × role affinity
//  12. pickups     useful items on the ground; flipped crabs
//  13. camp / night post
// At night the bot stays inside light rings (tiers 8–12 only run where it is lit). The current goal is kept
// while it stays valid (stickiness), so a bot doesn't flip between two equally good trees. Team duties (night
// guard + torch, fire, water) are spread over the bot seats by role (dutyOwner). Raft pacing (botNeeds.ts): far
// ahead of the schedule the bots stock the chest instead of the raft so the nights still happen; behind it, or
// on the last day, every role works on what the current raft stage needs.
//
// chooseStandInGoal(view) is the much shorter menu of a reconnect stand-in (BotDesk.add with standIn: a bot
// keeping a dropped human's character alive for RECONNECT_GRACE_SEC): it moves, never spends. Every goal it
// returns is in STAND_IN_GOALS, the set the desk also filters by.
//
// steer (botSteer.ts) and aimAt (botAim.ts) are the other two pure functions of the brain; they are
// re-exported here so callers have one import.

import {
  BOT_AIM_NOISE_DEG,
  DAYS,
  DEPARTURE_GATE_TICKS,
  FIRE_FUEL_MAX_TICKS,
  FIRE_LIGHT_RADIUS,
  FIRE_WOOD_FUEL_TICKS,
  REVIVE_TICKS,
  TICK_RATE,
  WATER_Y,
  secToTicks,
} from "../../shared/constants.js";
import { RECIPES } from "../../shared/items.js";
import type { XZ } from "../../shared/island/types.js";
import type { BotRole, InvKind, ItemKind, MonsterKind, RecipeId } from "../../shared/types.js";
import {
  aheadOfSchedule,
  countIn,
  deliverBucket,
  deliverableUnits,
  emptySlotCount,
  finalLoadDue,
  wouldFinishRaft,
  fireShortfall,
  missingFor,
  missingTools,
  palmHandSlot,
  raftHullDamaged,
  raftRemaining,
  raftUrgent,
  RESOURCES,
  roomIn,
  slotOf,
  stageTotal,
  stageWants,
  teamWants,
  ticksToDawn,
  woodAt,
  type Resource,
} from "./botNeeds.js";
import type { BotGroundItem, BotMate, BotMonster, BotNode, BotView, Goal, GoalKind } from "./botTypes.js";

export { aimAt, aimFromPlayer, solveAim, type AimSolution } from "./botAim.js";
export { newSteerMemory, steer, type SteerMemory, type SteerOutput } from "./botSteer.js";
export { goalKey, type BotView, type Goal } from "./botTypes.js";

/* ============================================================== tuning */

export const HUNGRY = 45;
export const THIRSTY = 45;
export const STARVING = 18;
/** Flee below this hp when a monster is within FLEE_RADIUS (the boss: FLEE_RADIUS_BOSS). */
export const FLEE_HP = 30;
export const FLEE_RADIUS = 6;
export const FLEE_RADIUS_BOSS = 9;
/** Rest at the fire below this hp (inside its light ring; not while the boss prowls there). */
export const REST_HP = 40;
/** Warm up at the fire below this warmth (night / rain). */
export const COLD = 35;
/** Throw at monsters within this range (the sharp-eyed Bekçi further): beyond it the aim noise wastes ammo. */
export const ENGAGE_RANGE = 16;
export const ENGAGE_RANGE_BEKCI = 22;
/** Seconds before dusk the evening duties start. */
export const EVENING_SEC = 14;
/** With a ready raft, bots keep the camp going until this long before the departure gate, then walk to the raft. */
export const BOARD_APPROACH_SEC = 20;
/** Sprint speed assumed when judging whether a revive can be reached in time (m/s). */
const RESCUE_SPEED = 6.2;
/** Night: a flipped crab is worth collecting when it lies this close to a light ring. */
const NIGHT_CRAB_REACH = 4;
const HOSTILE: ReadonlySet<MonsterKind> = new Set(["crab", "puffer", "boss"]);

/** How much each role likes each kind of work (§12 table). */
export const AFFINITY: Readonly<Record<BotRole, Readonly<Record<Resource, number>>>> = {
  hamal: { wood: 1, rope: 0.85, stone: 0.7, food: 0.35, water: 0.35 },
  balikci: { wood: 0.45, rope: 0.6, stone: 0.4, food: 1, water: 0.55 },
  bekci: { wood: 0.7, rope: 0.55, stone: 0.8, food: 0.9, water: 0.5 },
  asci: { wood: 0.55, rope: 0.5, stone: 0.35, food: 0.85, water: 1 },
};

export type Duty = "fire" | "guard" | "water";
const DUTY_ORDER: Readonly<Record<Duty, ReadonlyArray<BotRole>>> = {
  fire: ["asci", "hamal", "bekci", "balikci"],
  guard: ["bekci", "hamal", "asci", "balikci"],
  water: ["asci", "balikci", "bekci", "hamal"],
};

/* ============================================================ geometry */

function d2(ax: number, az: number, bx: number, bz: number): number {
  return Math.hypot(ax - bx, az - bz);
}
function distTo(v: BotView, p: XZ): number {
  return d2(v.self.x, v.self.z, p.x, p.z);
}

/** (x, z) is inside a light ring (by `margin` meters at least). */
export function lit(v: BotView, x: number, z: number, margin = 0.6): boolean {
  for (const l of v.lights) if (d2(x, z, l.x, l.z) <= l.r - margin) return true;
  return false;
}

/** Distance from (x, z) to the nearest light ring edge (0 inside one, Infinity when there is no light). */
function lightGap(v: BotView, x: number, z: number): number {
  let best = Infinity;
  for (const l of v.lights) best = Math.min(best, Math.max(0, d2(x, z, l.x, l.z) - l.r));
  return best;
}

function fireLit(v: BotView): boolean {
  return v.team.fireFuel > 0;
}

/** Spot next to the raft on the land side (deliver / board / guard). */
export function raftStand(v: BotView, dist = 2.4): XZ {
  const r = v.site.raft;
  const dx = v.site.campfire.x - r.x;
  const dz = v.site.campfire.z - r.z;
  const l = Math.hypot(dx, dz) || 1;
  return { x: r.x + (dx / l) * dist, z: r.z + (dz / l) * dist };
}

/** Each bot gets its own spot around a center (seat-spread), so they don't stack up. */
export function spreadSpot(center: XZ, seat: number, radius: number): XZ {
  const a = (seat * Math.PI * 2) / 6 + 0.4;
  return { x: center.x + Math.cos(a) * radius, z: center.z + Math.sin(a) * radius };
}

/* ============================================================ predicates */

export function isHostile(m: Pick<BotMonster, "kind" | "mode">): boolean {
  return HOSTILE.has(m.kind) && m.mode !== "flipped" && m.mode !== "flee";
}

export function isThief(m: BotMonster): boolean {
  return (m.kind === "monkey" || m.kind === "gull") && m.carry !== "";
}

/** Dusk, or the last EVENING_SEC of the day. */
export function isEvening(v: BotView): boolean {
  const c = v.clock;
  return c.dayPhase === "dusk" || (c.dayPhase === "day" && c.phaseLeft <= secToTicks(EVENING_SEC));
}

function isNight(v: BotView): boolean {
  return v.clock.dayPhase === "night";
}

/** Duties are handed out in this order, each to the best free candidate (so two bots don't share all of them). */
const DUTY_ASSIGN_ORDER: ReadonlyArray<Duty> = ["guard", "fire", "water"];

/**
 * The bot-driven seat (self included) that owns a team duty. Duties are assigned in DUTY_ASSIGN_ORDER, each to
 * the candidate with the best role preference (then the lowest seat) among those without a duty yet; when every
 * candidate already has one, the best overall takes it too. Every bot computes the same answer.
 */
export function dutyOwner(v: BotView, duty: Duty): string {
  const seats: { id: string; role: BotRole; seat: number }[] = [{ id: v.self.id, role: v.self.role, seat: v.self.seat }];
  for (const m of v.mates) {
    if (!m.driven || !m.alive || m.washed || m.downed || m.boarded || m.role === "") continue;
    seats.push({ id: m.id, role: m.role, seat: m.seat });
  }
  const taken = new Set<string>();
  for (const d of DUTY_ASSIGN_ORDER) {
    const order = DUTY_ORDER[d];
    const rank = (c: { role: BotRole; seat: number }): number => order.indexOf(c.role) * 10 + c.seat;
    const free = seats.filter((c) => !taken.has(c.id));
    const pool = free.length ? free : seats;
    let best = pool[0]!;
    for (const c of pool) if (rank(c) < rank(best)) best = c;
    if (d === duty) return best.id;
    taken.add(best.id);
  }
  return v.self.id;
}

function owns(v: BotView, duty: Duty): boolean {
  return dutyOwner(v, duty) === v.self.id;
}

/** Ingredients for `recipe` are in reach (inventory + chest), plus a wood to relight the fire when it is out. */
export function canCraft(v: BotView, recipe: RecipeId): boolean {
  const def = RECIPES[recipe];
  if (def.duelOnly || def.locked || v.blocked(`craft:${recipe}`)) return false;
  if (Object.keys(missingFor(recipe, v.self.slots, v.team.chest)).length) return false;
  if (recipe === "fuel" || fireLit(v)) return true;
  // Relight first: one wood beyond the recipe's own wood.
  return woodAt(v) >= 1 + (def.cost.wood ?? 0);
}

/** The last stretch of the day (night prep: torch, ammo). */
function afternoon(v: BotView): boolean {
  return v.clock.dayPhase === "day" && v.clock.phaseLeft < secToTicks(50);
}

/** A torch exists for tonight: planted at the raft, in the chest, or in a teammate's / our pockets. */
function torchAround(v: BotView): boolean {
  if (raftTorchLife(v) > 0 || (v.team.chest.torch ?? 0) > 0 || countIn(v.self.slots, "torch") > 0) return true;
  return v.mates.some((m) => m.alive && countIn(m.slots, "torch") > 0);
}

/** Planted torch burning at the raft: the longest life within 3.5 m of the raft center (0 when none). */
export function raftTorchLife(v: BotView): number {
  let best = 0;
  for (const t of v.torches) if (d2(t.x, t.z, v.site.raft.x, v.site.raft.z) <= 3.5) best = Math.max(best, t.life);
  return best;
}

/* =============================================================== items */

/** Best throwable to use on `target`: spears for the boss, stones before coconuts (coconuts are food) otherwise. */
export function ammoSlot(v: BotView, target: MonsterKind, close: boolean): number {
  const slots = v.self.slots;
  const order: ItemKind[] =
    target === "boss" ? ["spear", "stone", "coconut_ball", "coconut", "boot"] : ["stone", "boot", "coconut_ball", "coconut", "spear"];
  for (const k of order) {
    const i = slotOf(slots, k);
    if (i < 0) continue;
    // Coconuts are food: only the Bekçi (ammo is its job) or a bot in trouble throws them, and nobody throws
    // the one it was about to eat.
    if (k === "coconut" && !close) {
      const hungry = v.self.hunger < HUNGRY + 5 || v.self.thirst < THIRSTY + 5;
      if (hungry && countIn(slots, "coconut") < 2) continue;
      if (v.self.role !== "bekci" && countIn(slots, "coconut") < 2) continue;
    }
    return i;
  }
  return -1;
}

const EAT_ORDER: ReadonlyArray<ItemKind> = ["fish_cooked", "crab_cooked", "coconut", "fish_raw", "fish_golden"];
const DRINK_ORDER: ReadonlyArray<ItemKind> = ["water", "coconut", "fish_golden"];

/** Slot to eat for hunger (golden fish first when really hungry), -1 when none. */
export function foodSlot(v: BotView): number {
  const s = v.self;
  const order = s.hunger < 35 ? (["fish_golden", ...EAT_ORDER] as ItemKind[]) : EAT_ORDER;
  for (const k of order) {
    const i = slotOf(s.slots, k);
    if (i >= 0) return i;
  }
  return s.hunger < STARVING ? slotOf(s.slots, "crab_raw") : -1;
}

export function drinkSlot(v: BotView): number {
  for (const k of DRINK_ORDER) {
    const i = slotOf(v.self.slots, k);
    if (i >= 0) return i;
  }
  return -1;
}

/** How much the bot would like a ground item (0 = leave it). */
function itemValue(v: BotView, kind: ItemKind): number {
  const s = v.self;
  const role = s.role;
  switch (kind) {
    case "spear":
      return countIn(s.slots, "spear") ? 1 : 3;
    case "raft_part":
      return v.team.stage <= 1 ? 2.6 : 0;
    case "coconut":
      return 2.2;
    case "fish_cooked":
    case "crab_cooked":
    case "fish_golden":
      return 2.5;
    case "water":
      return 2;
    case "fish_raw":
      return 1.8;
    case "crab_raw":
      return 1.4;
    case "wood":
      return role === "hamal" || v.team.stage <= 1 ? 1.7 : 1;
    case "stone":
      return role === "bekci" || owns(v, "guard") ? 2.2 : 1.2;
    case "rope":
      return 1.4;
    case "axe":
      return countIn(s.slots, "axe") ? 0 : 2;
    case "rod":
      return countIn(s.slots, "rod") ? 0 : role === "balikci" ? 3 : 0.6;
    case "torch":
      return countIn(s.slots, "torch") ? 0 : owns(v, "guard") ? 2.4 : 0.8;
    case "boot":
      return role === "bekci" ? 0.8 : 0;
    case "coconut_ball":
      return 2;
    default:
      return 0;
  }
}

/* ================================================================ tiers */

function puffer(v: BotView): Goal | null {
  const slot = slotOf(v.self.slots, "puffer");
  if (slot < 0) return null;
  // Lob it at the nearest monster in reach (it flips crabs), else just far away from everyone.
  let target = "";
  let best = 26;
  for (const m of v.monsters) {
    if (!isHostile(m)) continue;
    const d = d2(v.self.x, v.self.z, m.x, m.z);
    if (d < best && d > 4) {
      best = d;
      target = m.id;
    }
  }
  return { kind: "throwAway", slot, monsterId: target };
}

function flee(v: BotView): Goal | null {
  return fleeAt(v, FLEE_HP);
}

/** Run from the closest hostile monster in flee range when hp ≤ `hpLimit` (a stand-in, which can't fight: always). */
function fleeAt(v: BotView, hpLimit: number): Goal | null {
  const s = v.self;
  if (s.hp > hpLimit) return null;
  let threat: BotMonster | null = null;
  let best = Infinity;
  for (const m of v.monsters) {
    if (!isHostile(m) || m.mode === "emerge") continue;
    const d = d2(s.x, s.z, m.x, m.z);
    if (d <= (m.kind === "boss" ? FLEE_RADIUS_BOSS : FLEE_RADIUS) && d < best) {
      best = d;
      threat = m;
    }
  }
  if (!threat) return null;
  if (threat.kind !== "boss" && lit(v, s.x, s.z, 0.8)) return null;
  // Nearest light ring that isn't behind the threat; else straight away from it toward the camp.
  let to: XZ | null = null;
  let toD = 30;
  for (const l of v.lights) {
    const d = d2(s.x, s.z, l.x, l.z);
    if (d < toD && d2(threat.x, threat.z, l.x, l.z) > 2) {
      toD = d;
      to = { x: l.x, z: l.z };
    }
  }
  if (!to) {
    const ax = s.x - threat.x;
    const az = s.z - threat.z;
    const al = Math.hypot(ax, az) || 1;
    const cx = v.site.campfire.x - s.x;
    const cz = v.site.campfire.z - s.z;
    const cl = Math.hypot(cx, cz) || 1;
    to = { x: s.x + (ax / al) * 7 + (cx / cl) * 3, z: s.z + (az / al) * 7 + (cz / cl) * 3 };
  }
  return { kind: "flee", to, from: threat.id };
}

function revive(v: BotView): Goal | null {
  const s = v.self;
  let target: BotMate | null = null;
  let targetD = Infinity;
  for (const m of v.mates) {
    if (!m.alive || !m.downed || m.washed || v.blocked(`revive:${m.id}`)) continue;
    const d = d2(s.x, s.z, m.x, m.z);
    const secsLeft = m.downedTicks / TICK_RATE;
    if (d / RESCUE_SPEED + REVIVE_TICKS / TICK_RATE + 0.4 > secsLeft) continue;
    // Only the two closest able helpers go (a human standing right next to them counts as one).
    let closer = 0;
    for (const o of v.mates) {
      if (o.id === m.id || !o.alive || o.downed || o.washed || o.boarded) continue;
      const od = d2(o.x, o.z, m.x, m.z);
      if (od < d && (o.driven || od < 3)) closer++;
    }
    if (closer >= 2) continue;
    if (d < targetD) {
      targetD = d;
      target = m;
    }
  }
  return target ? { kind: "revive", playerId: target.id } : null;
}

/**
 * The two bots that hold the raft watch while the rest take their seats: the guard-owner first, then the next
 * bot in the same role preference order. With two watchers one can be lured or bitten while the other still
 * keeps crabs off the hull; a single guard was not enough on the last night.
 */
export function raftWatch(v: BotView): ReadonlySet<string> {
  const candidates: { id: string; role: BotRole; seat: number }[] = [{ id: v.self.id, role: v.self.role, seat: v.self.seat }];
  for (const m of v.mates) {
    if (!m.driven || !m.alive || m.washed || m.downed || m.boarded || m.role === "") continue;
    candidates.push({ id: m.id, role: m.role, seat: m.seat });
  }
  const order = DUTY_ORDER.guard;
  const rank = (c: { role: BotRole; seat: number }): number => order.indexOf(c.role) * 10 + c.seat;
  candidates.sort((a, b) => rank(a) - rank(b));
  const out = new Set<string>();
  const owner = dutyOwner(v, "guard");
  out.add(owner);
  for (const c of candidates) {
    if (out.size >= 2) break;
    out.add(c.id);
  }
  return out;
}

/**
 * Board now, or wait so the humans aren't stranded on the beach (§2.5 boarding countdown).
 *
 * The raft cannot leave before the departure gate (DEPARTURE_GATE_TICKS, the same window RaftSystem.step uses),
 * and a bot on a seat is no longer a monster target. The crew therefore splits: the two raft watchers stay on the
 * sand until the gate, while everyone else boards as soon as the raft is ready and sits out the last night's
 * waves. The watchers are what keep crabs from chewing the hull for free; if the hull is damaged anyway, the
 * stage drop unboards everyone and the team leads the repair before boarding again.
 */
export function shouldBoard(v: BotView): boolean {
  if (v.team.stage !== 3) return false;
  // The raft only leaves on the last night; before that there is nothing to board for.
  if (v.clock.day !== DAYS || v.clock.dayPhase !== "night") return false;
  // The guard stays ashore until the gate; the second watcher joins the approach window (one seat filled keeps
  // the hull safe while the guard still covers the sand). Everyone else may take a seat early.
  if (v.clock.stormLeft > DEPARTURE_GATE_TICKS) {
    if (dutyOwner(v, "guard") === v.self.id) return false;
    if (v.clock.stormLeft > DEPARTURE_GATE_TICKS + secToTicks(BOARD_APPROACH_SEC) && raftWatch(v).has(v.self.id)) return false;
  }
  // Inside the gate a running countdown means someone is already aboard: the rest follow before it leaves.
  if (v.team.launchTicksLeft > 0) return true;
  const humans = v.mates.filter((m) => m.human && m.alive && !m.washed);
  if (!humans.length || humans.some((h) => h.boarded)) return true;
  const raft = v.site.raft;
  return humans.every((h) => h.downed || d2(h.x, h.z, raft.x, raft.z) <= 14);
}

function board(v: BotView): Goal | null {
  if (v.team.stage !== 3 || v.blocked("board")) return null;
  return shouldBoard(v) ? { kind: "board" } : null;
}

/**
 * The gate is open and a ready raft is within reach: take the seat before anything else. A last-second repair
 * that restores stage 3 must be followed by a boarding, not by a fight on the sand, or the same wave simply
 * chews the hull back down in the seconds that are left.
 */
function boardNow(v: BotView): Goal | null {
  if (v.team.stage !== 3 || v.clock.stormLeft > DEPARTURE_GATE_TICKS) return null;
  const raft = v.site.raft;
  return d2(v.self.x, v.self.z, raft.x, raft.z) <= 5 ? { kind: "board" } : null;
}

/**
 * Repair is urgent only once the last day has begun: before that a chewed hull can wait for daylight and the
 * normal pacing, and rushing every bot to the raft in the dark is how a night wave picks the team off.
 */
function urgentRepair(v: BotView): boolean {
  return v.clock.day >= DAYS && raftHullDamaged(v.team);
}

/** A chewed hull on the last day: deliver the wood / parts we already carry before the next chore or fight. */
function repair(v: BotView): Goal | null {
  if (!urgentRepair(v)) return null;
  return deliver(v);
}

function attack(v: BotView): Goal | null {
  const s = v.self;
  const raft = v.site.raft;
  const fire = v.site.campfire;
  const raftSafe = lit(v, raft.x, raft.z, 1);
  const guardPush = isNight(v) && !raftSafe && owns(v, "guard") && s.hp > 55;
  const baseRange = s.role === "bekci" ? ENGAGE_RANGE_BEKCI : ENGAGE_RANGE;
  const current = v.current?.kind === "attack" ? v.current.monsterId : "";
  let best: BotMonster | null = null;
  let bestScore = 0;
  let bestClose = false;
  for (const m of v.monsters) {
    const hostile = isHostile(m);
    if (!hostile && !isThief(m)) continue;
    if (v.blocked(`attack:${m.id}`)) continue;
    const d = d2(s.x, s.z, m.x, m.z);
    const range = guardPush && d2(m.x, m.z, raft.x, raft.z) < 5 ? 45 : baseRange;
    if (d > range) continue;
    // Still in the surf: a throw would just sink. Wait until it's on the beach (unless it's right here).
    if (m.y < WATER_Y - 0.25 && d > 6) continue;
    if (m.mode === "emerge" && d > 8) continue;
    let score = 1;
    let close = d < 10;
    if (hostile) {
      const dRaft = d2(m.x, m.z, raft.x, raft.z);
      if (dRaft < 7 && !raftSafe) score += 3;
      if (m.targetId === "raft") score += 2;
      if (d < 9) score += 2.5;
      if (m.targetId === s.id) score += 2;
      for (const o of v.mates) {
        if (o.alive && o.downed && d2(o.x, o.z, m.x, m.z) < 7) {
          score += 3;
          close = true;
        }
      }
      if (d2(m.x, m.z, fire.x, fire.z) < FIRE_LIGHT_RADIUS + 4) score += 1;
      if (m.kind === "boss") score += 2;
      if (m.kind === "puffer") score += 1.5;
      if (m.mode === "emerge") score -= 0.5;
    } else {
      // A thief up in a tree is only worth a lob from close by.
      if (m.y > s.y + 3 && d > 9) continue;
      score += 2;
    }
    if (m.id === current) score += 1.5;
    score /= 1 + d / 18;
    if (score > bestScore) {
      bestScore = score;
      best = m;
      bestClose = close;
    }
  }
  if (!best) return null;
  const slot = ammoSlot(v, best.kind, bestClose);
  if (slot < 0) return null;
  // Night, the raft is dark and something chews on it: a healthy guard walks out to deal with it.
  const atRaft = d2(best.x, best.z, raft.x, raft.z) < 5 && !raftSafe;
  const push = atRaft && isNight(v) && owns(v, "guard") && s.hp > 55;
  return push ? { kind: "attack", monsterId: best.id, slot, push } : { kind: "attack", monsterId: best.id, slot };
}

function selfCare(v: BotView): Goal | null {
  const s = v.self;
  if (s.swimming) return { kind: "camp", at: spreadSpot(v.site.campfire, s.seat, 2.4) };
  // Eat / drink what we carry.
  if (s.thirst < THIRSTY) {
    const slot = drinkSlot(v);
    if (slot >= 0 && !v.blocked(`eat:${slot}`)) return { kind: "eat", slot };
  }
  if (s.hunger < HUNGRY) {
    const slot = foodSlot(v);
    if (slot >= 0 && !v.blocked(`eat:${slot}`)) return { kind: "eat", slot };
  }
  if (s.hp < 60 && s.hunger < 85) {
    const slot = foodSlot(v);
    if (slot >= 0 && !v.blocked(`eat:${slot}`) && v.team.stage !== 2) return { kind: "eat", slot };
  }
  // Warm up / heal at the fire.
  if (needsFire(v)) return { kind: "warm" };
  // Fetch something to eat / drink.
  if (s.thirst < THIRSTY) {
    const fetch = fetchDrink(v);
    if (fetch) return fetch;
  }
  if (s.hunger < HUNGRY) {
    const fetch = fetchFood(v);
    if (fetch) return fetch;
  }
  return null;
}

/** Warm up / heal at the lit fire: cold, hurt, or still warming up from the last think. */
function needsFire(v: BotView): boolean {
  const s = v.self;
  const night = isNight(v);
  const fire = v.site.campfire;
  // Warmth drops at night (unless the ground is volcanic), in the rain and in the water (survival rules).
  const chilly = (night && v.clock.nightChill) || v.clock.weather === "rain";
  const cold = chilly && s.warmth < COLD;
  // The fire's light ring keeps crabs out, so it's the place to heal even at night (the boss excepted).
  const hurt = s.hp < REST_HP && !v.monsters.some((m) => m.kind === "boss" && isHostile(m) && d2(m.x, m.z, fire.x, fire.z) < 10);
  const keepWarming = v.current?.kind === "warm" && ((night && s.warmth < 85) || s.hp < 75);
  return fireLit(v) && (cold || hurt || keepWarming);
}

function chestHas(v: BotView, kind: ItemKind): boolean {
  return (v.team.chest[kind] ?? 0) > 0;
}

function fetchDrink(v: BotView): Goal | null {
  const s = v.self;
  const night = isNight(v);
  const chestD = distTo(v, v.site.chest);
  const springD = distTo(v, v.site.spring);
  if (chestHas(v, "water") && roomIn(s.slots, "water") > 0 && (chestD < springD + 10 || night) && !v.blocked("chestTake:water")) {
    return { kind: "chestTake", items: [{ kind: "water", count: 1 }] };
  }
  if (night && s.thirst > STARVING && !lit(v, v.site.spring.x, v.site.spring.z, 0)) return null;
  if (v.blocked("spring")) return null;
  return { kind: "spring", uses: roomIn(s.slots, "water") > 0 ? 2 : 1 };
}

function fetchFood(v: BotView): Goal | null {
  const s = v.self;
  const night = isNight(v);
  for (const k of ["fish_cooked", "crab_cooked", "coconut", "fish_raw"] as ItemKind[]) {
    if (chestHas(v, k) && roomIn(s.slots, k) > 0 && !v.blocked(`chestTake:${k}`) && (distTo(v, v.site.chest) < 40 || night)) {
      return { kind: "chestTake", items: [{ kind: k, count: 1 }] };
    }
  }
  if (night) return null;
  const berry = nearestNode(v, (n) => n.kind === "bush" && n.yield === "berry", 30);
  if (berry) return { kind: "gather", node: berry.i };
  const palm = handFreeForPalm(v) ? nearestNode(v, (n) => n.kind === "palm", 30) : null;
  if (palm) return { kind: "shake", node: palm.i };
  return null;
}

/** Aşçı: toss food / water to a teammate whose bar is low (humans first). */
function pass(v: BotView): Goal | null {
  const s = v.self;
  if (s.role !== "asci" || isNight(v)) return null;
  let best: { mate: BotMate; slot: number; score: number } | null = null;
  for (const m of v.mates) {
    if (!m.alive || m.downed || m.washed || m.boarded || v.blocked(`pass:${m.id}`)) continue;
    const d = d2(s.x, s.z, m.x, m.z);
    if (d > 30) continue;
    let slot = -1;
    if (m.thirst < 40) slot = slotOf(s.slots, "water");
    if (slot < 0 && (m.hunger < 40 || m.thirst < 40)) slot = slotOf(s.slots, "coconut");
    if (slot < 0 && m.hunger < 40) {
      for (const k of ["fish_cooked", "crab_cooked", "fish_raw"] as ItemKind[]) {
        slot = slotOf(s.slots, k);
        if (slot >= 0) break;
      }
    }
    if (slot < 0) continue;
    // Keep our own last bite when we're hungry ourselves.
    const kind = s.slots[slot]!.kind as ItemKind;
    if (countIn(s.slots, kind) < 2 && (s.hunger < 50 || s.thirst < 50)) continue;
    const score = (m.human ? 2 : 1) * (100 - Math.min(m.hunger, m.thirst)) - d;
    if (!best || score > best.score) best = { mate: m, slot, score };
  }
  return best ? { kind: "pass", playerId: best.mate.id, slot: best.slot } : null;
}

function evening(v: BotView): Goal | null {
  const night = isNight(v);
  if (!night && !isEvening(v)) return null;
  const s = v.self;
  // Keep the campfire burning through the night.
  const short = fireShortfall(v);
  if (short > 0) {
    const wood = woodAt(v);
    const nearFire = distTo(v, v.site.campfire) < 8;
    const emergency = v.team.fireFuel < secToTicks(6);
    if (wood > 0 && (owns(v, "fire") || nearFire || emergency) && !v.blocked("craft:fuel")) {
      const room = Math.floor((FIRE_FUEL_MAX_TICKS - v.team.fireFuel) / FIRE_WOOD_FUEL_TICKS);
      const count = Math.max(1, Math.min(Math.ceil(short / FIRE_WOOD_FUEL_TICKS), wood, room));
      return { kind: "craft", recipe: "fuel", count };
    }
    if (wood === 0 && owns(v, "fire") && !night && roomIn(s.slots, "wood") > 0) {
      const tree = nearestNode(v, (n) => n.kind === "tree", 25, v.site.campfire);
      if (tree) return { kind: "gather", node: tree.i };
    }
  }
  // A bot carrying a torch while the guard has none plants it itself.
  const myTorch = slotOf(s.slots, "torch");
  if (myTorch >= 0 && !owns(v, "guard") && raftTorchLife(v) < ticksToDawn(v.clock) * 0.6 && !v.blocked("plantTorch")) {
    const guard = v.mates.find((m) => m.id === dutyOwner(v, "guard"));
    if (!guard || countIn(guard.slots, "torch") === 0) return { kind: "plantTorch", slot: myTorch };
  }
  // The guard lights up the raft.
  if (owns(v, "guard") && raftTorchLife(v) < ticksToDawn(v.clock) * 0.6) {
    const t = slotOf(s.slots, "torch");
    if (t >= 0 && !v.blocked("plantTorch")) return { kind: "plantTorch", slot: t };
    if (chestHas(v, "torch") && roomIn(s.slots, "torch") > 0 && !v.blocked("chestTake:torch")) return { kind: "chestTake", items: [{ kind: "torch", count: 1 }] };
    if (canCraft(v, "torch")) return { kind: "craft", recipe: "torch", count: 1 };
    if (!night && countIn(s.slots, "rope") + (v.team.chest.rope ?? 0) === 0 && roomIn(s.slots, "rope") > 0) {
      const bush = nearestNode(v, (n) => n.kind === "bush" && n.yield === "rope", 25);
      if (bush) return { kind: "gather", node: bush.i };
    }
  }
  return null;
}

function deliver(v: BotView): Goal | null {
  const s = v.self;
  if (v.team.stage >= 3 || v.blocked("deliver")) return null;
  // Hull repair outranks the pacing plan: a gnawed raft must be fed again even when the team is "ahead".
  if (aheadOfSchedule(v) && !raftHullDamaged(v.team)) return null;
  const units = deliverableUnits(s.slots, v.team, s.character);
  if (units <= 0) return null;
  // A finished hull and mast wait for the provisioning window: the last load that would complete the raft is
  // held until READY_TARGET_SEC. Partial larder loads still go in, so the final delivery is one short press.
  if (!finalLoadDue(v) && wouldFinishRaft(v)) return null;
  const stand = raftStand(v);
  // Ordinary night work keeps to the light. Repair is the exception: a chewed hull left until dawn is not ready
  // at the gate, so a bot carrying wood walks to the raft even when the torch is out.
  if (isNight(v) && !lit(v, stand.x, stand.z, 0) && !urgentRepair(v)) return null;
  const want = stageTotal(stageWants(v.team));
  if (units >= want) return { kind: "deliver" };
  if (isEvening(v) || distTo(v, v.site.raft) < 10) return { kind: "deliver" };
  if (raftUrgent(v) && units >= Math.min(want, 3)) return { kind: "deliver" };
  if (v.team.stage === 2 && units >= Math.min(want, 2)) return { kind: "deliver" };
  if (units >= 10) return { kind: "deliver" };
  // Can't carry any more of what we're carrying.
  for (const slot of s.slots) {
    if (slot.kind !== "" && deliverBucket(slot.kind, v.team.stage) && roomIn(s.slots, slot.kind) === 0) return { kind: "deliver" };
  }
  return null;
}

function craft(v: BotView): Goal | null {
  const s = v.self;
  const nearFire = distTo(v, v.site.campfire) < 9;
  const crabs = countIn(s.slots, "crab_raw");
  if (crabs > 0 && canCraft(v, "cook_crab")) return { kind: "craft", recipe: "cook_crab", count: crabs };
  const raw = countIn(s.slots, "fish_raw");
  const stageFood = v.team.stage === 2 && stageWants(v.team).food > 0;
  if (raw > 0 && !stageFood && (raw >= 2 || nearFire || isEvening(v)) && canCraft(v, "cook_fish")) {
    return { kind: "craft", recipe: "cook_fish", count: raw };
  }
  if (countIn(s.slots, "kraken") > 0 && canCraft(v, "cook_kraken")) return { kind: "craft", recipe: "cook_kraken", count: 1 };
  if (isNight(v) && !nearFire) return null;
  for (const tool of missingTools(s.role, s.slots)) {
    const out = RECIPES[tool].out!;
    if (roomIn(s.slots, out) <= 0) continue;
    if (chestHas(v, out) && !v.blocked(`chestTake:${out}`)) return { kind: "chestTake", items: [{ kind: out, count: 1 }] };
    if (canCraft(v, tool)) return { kind: "craft", recipe: tool, count: 1 };
  }
  // Hamal turns chest wood into raft parts it can carry (it doesn't carry wood of its own).
  if (s.role === "hamal" && v.team.stage <= 1 && countIn(s.slots, "wood") === 0 && (!aheadOfSchedule(v) || raftHullDamaged(v.team))) {
    const r = raftRemaining(v.team);
    const need = v.team.stage === 0 ? r.hull : r.mastWood;
    const chestWood = v.team.chest.wood ?? 0;
    const parts = Math.min(Math.floor(chestWood / 3), Math.floor(need / 3), emptySlotCount(s.slots));
    if (parts > 0 && canCraft(v, "raft_part")) return { kind: "craft", recipe: "raft_part", count: parts };
  }
  // The guard makes the night torch in the afternoon (unless someone already carries one).
  if (owns(v, "guard") && afternoon(v) && !torchAround(v) && canCraft(v, "torch") && roomIn(s.slots, "torch") > 0) {
    return { kind: "craft", recipe: "torch", count: 1 };
  }
  // Daytime upkeep: whoever owns the fire keeps a little fuel in it while working at camp.
  if (owns(v, "fire") && nearFire && v.team.fireFuel < secToTicks(20) && woodAt(v) > 0 && !v.blocked("craft:fuel")) {
    return { kind: "craft", recipe: "fuel", count: 1 };
  }
  return null;
}

/** How many units of `kind` the bot keeps (the rest goes into the chest). */
function keepCount(v: BotView, kind: ItemKind): number {
  const s = v.self;
  const guard = s.role === "bekci" || owns(v, "guard");
  // Raft goods are carried to the raft — unless the team is ahead of the schedule, then they wait in the chest.
  if (deliverBucket(kind, v.team.stage) && (!aheadOfSchedule(v) || raftHullDamaged(v.team))) return Infinity;
  switch (kind) {
    case "rod":
      return s.role === "balikci" || !v.mates.some((m) => m.driven && m.role === "balikci") ? Infinity : 0;
    case "torch":
      return guard || isEvening(v) || isNight(v) ? Infinity : 0;
    case "axe":
    case "spear":
    case "coconut_ball":
    case "fish_raw":
    case "crab_raw":
    case "kraken":
    case "puffer":
      return Infinity;
    case "wood":
      return s.role === "hamal" || owns(v, "fire") ? (aheadOfSchedule(v) && !raftHullDamaged(v.team) ? 5 : Infinity) : 0;
    case "rope":
      if (guard && isEvening(v)) return 1;
      return s.role === "hamal" && (!aheadOfSchedule(v) || raftHullDamaged(v.team)) ? Infinity : missingTools(s.role, s.slots).length ? 1 : 0;
    case "stone":
      return guard ? 3 : missingTools(s.role, s.slots).length ? 1 : 0;
    case "coconut":
      return guard ? 3 : 2;
    case "fish_cooked":
    case "crab_cooked":
    case "fish_golden":
      return 1;
    case "water":
      return s.role === "asci" ? 2 : 1;
    case "boot":
      return guard ? 1 : 0;
    default:
      return 0;
  }
}

function housekeep(v: BotView): Goal | null {
  const s = v.self;
  const jelly = slotOf(s.slots, "jellyfish");
  if (jelly >= 0) {
    if (fireLit(v) && !v.blocked("burn")) return { kind: "burn", slot: jelly };
    if (!v.blocked("chestPut:jellyfish")) return { kind: "chestPut", items: [{ kind: "jellyfish", count: 1 }] };
  }
  const items: { kind: ItemKind; count: number }[] = [];
  const seen = new Set<InvKind>();
  for (const slot of s.slots) {
    if (slot.kind === "" || seen.has(slot.kind)) continue;
    seen.add(slot.kind);
    const extra = countIn(s.slots, slot.kind) - keepCount(v, slot.kind);
    if (extra > 0) items.push({ kind: slot.kind, count: extra });
  }
  if (!items.length) return null;
  const goal: Goal = { kind: "chestPut", items };
  if (v.blocked(`chestPut:${items.map((i) => i.kind).join(",")}`)) return null;
  const chestD = distTo(v, v.site.chest);
  if (chestD < 7) return goal;
  if (emptySlotCount(s.slots) === 0 && chestD < 45) return goal;
  return null;
}

/* --------------------------------------------------------------- work */

function nearestNode(v: BotView, test: (n: BotNode) => boolean, maxD: number, from: XZ = v.self, bias: XZ | null = null): BotNode | null {
  let best: BotNode | null = null;
  let bestCost = Infinity;
  for (const n of v.nodes) {
    if (!test(n) || v.claims.nodes.has(n.i)) continue;
    const key = n.kind === "palm" ? `shake:${n.i}` : `gather:${n.i}`;
    if (v.blocked(key)) continue;
    const d = d2(from.x, from.z, n.x, n.z);
    if (d > maxD) continue;
    const cost = d + (bias ? 0.35 * d2(n.x, n.z, bias.x, bias.z) : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = n;
    }
  }
  return best;
}

function handFreeForPalm(v: BotView): boolean {
  return palmHandSlot(v.self.slots) >= 0 && roomIn(v.self.slots, "coconut") > 0;
}

function nearestFishSpot(v: BotView): number {
  let best = -1;
  let bestD = Infinity;
  for (const f of v.fishSpots) {
    if (v.claims.spots.has(f.i) || v.blocked(`fish:${f.i}`)) continue;
    const d = d2(v.self.x, v.self.z, f.standX, f.standZ);
    if (d < bestD) {
      bestD = d;
      best = f.i;
    }
  }
  return best;
}

/** Concrete goal that produces `res`, or null when there is no source in reach / no room. */
function sourceFor(v: BotView, res: Resource): Goal | null {
  const s = v.self;
  const raft = v.site.raft;
  switch (res) {
    case "wood": {
      if (roomIn(s.slots, "wood") <= 0) return null;
      const n = nearestNode(v, (x) => x.kind === "tree", 70, s, v.team.stage <= 1 ? raft : v.site.campfire);
      return n ? { kind: "gather", node: n.i } : null;
    }
    case "rope": {
      if (roomIn(s.slots, "rope") <= 0) return null;
      const n = nearestNode(v, (x) => x.kind === "bush" && x.yield === "rope", 70);
      return n ? { kind: "gather", node: n.i } : null;
    }
    case "stone": {
      if (roomIn(s.slots, "stone") <= 0) return null;
      const n = nearestNode(v, (x) => x.kind === "rock", 70);
      return n ? { kind: "gather", node: n.i } : null;
    }
    case "food": {
      if (countIn(s.slots, "rod") > 0) {
        const spot = nearestFishSpot(v);
        if (spot >= 0 && (emptySlotCount(s.slots) > 0 || roomIn(s.slots, "fish_raw") > 0)) return { kind: "fish", spot };
      }
      if (handFreeForPalm(v)) {
        const n = nearestNode(v, (x) => x.kind === "palm", 70);
        if (n) return { kind: "shake", node: n.i };
      }
      return null;
    }
    case "water":
      if (roomIn(s.slots, "water") <= 0 || v.blocked("spring")) return null;
      return { kind: "spring", uses: Math.min(roomIn(s.slots, "water"), 3) };
  }
}

/** Current-stage needs the chest could cover right now, as a chestTake for this bot. */
function chestFetch(v: BotView): Goal | null {
  if (aheadOfSchedule(v) && !raftHullDamaged(v.team)) return null;
  const want = stageWants(v.team);
  if (stageTotal(want) === 0) return null;
  const items: { kind: ItemKind; count: number }[] = [];
  const add = (kind: ItemKind, need: number): void => {
    const have = v.team.chest[kind] ?? 0;
    const n = Math.min(have, need, roomIn(v.self.slots, kind));
    if (n > 0) items.push({ kind, count: n });
  };
  if (want.wood > 0) add("raft_part", Math.ceil(want.wood / 3));
  if (want.wood > 0) add("wood", want.wood);
  if (want.rope > 0) add("rope", want.rope);
  if (want.water > 0) add("water", want.water);
  if (want.food > 0) for (const k of ["fish_cooked", "crab_cooked", "fish_raw", "coconut", "fish_golden"] as ItemKind[]) add(k, want.food);
  if (!items.length) return null;
  const goal: Goal = { kind: "chestTake", items };
  return v.blocked(`chestTake:${items.map((i) => i.kind).join(",")}`) ? null : goal;
}

/** Stillness: the current work goal is still worth finishing. */
function workStillValid(v: BotView, g: Goal): boolean {
  const s = v.self;
  switch (g.kind) {
    case "gather": {
      const n = v.nodes.find((x) => x.i === g.node);
      if (!n) return false;
      if (n.kind === "bush" && n.yield === "berry") return s.hunger < 92;
      const y: ItemKind = n.kind === "tree" ? "wood" : n.kind === "rock" ? "stone" : "rope";
      return roomIn(s.slots, y) > 0;
    }
    case "shake":
      return v.nodes.some((x) => x.i === g.node) && handFreeForPalm(v);
    case "fish":
      return countIn(s.slots, "rod") > 0 && (emptySlotCount(s.slots) > 0 || roomIn(s.slots, "fish_raw") > 0 || s.fishState !== 0);
    case "spring":
      return true;
    default:
      return false;
  }
}

/** Personal extras on top of the team wants: tool ingredients, the guard's ammo. */
function personalWants(v: BotView): Partial<Record<Resource | "ammo", number>> {
  const s = v.self;
  const out: Partial<Record<Resource | "ammo", number>> = {};
  for (const tool of missingTools(s.role, s.slots)) {
    for (const [k, n] of Object.entries(missingFor(tool, s.slots, v.team.chest)) as [ItemKind, number][]) {
      const r = k === "wood" ? "wood" : k === "rope" ? "rope" : k === "stone" ? "stone" : null;
      if (r) out[r] = (out[r] ?? 0) + n;
    }
  }
  // The guard needs a torch for the night: its rope / wood become personal wants in the afternoon.
  if (owns(v, "guard") && afternoon(v) && !torchAround(v)) {
    for (const [k, n] of Object.entries(missingFor("torch", s.slots, v.team.chest)) as [ItemKind, number][]) {
      const r = k === "wood" ? "wood" : k === "rope" ? "rope" : null;
      if (r) out[r] = (out[r] ?? 0) + n;
    }
  }
  // Ammo for the night: the Bekçi's job all day; another guard only stocks up in the afternoon.
  if (s.role === "bekci" || (owns(v, "guard") && afternoon(v))) {
    const ammo = countIn(s.slots, "stone") + countIn(s.slots, "coconut") + countIn(s.slots, "spear") + countIn(s.slots, "boot");
    if (ammo < 4) out.ammo = 4 - ammo;
  }
  return out;
}

function work(v: BotView): Goal | null {
  const s = v.self;
  if (v.current && workStillValid(v, v.current) && !(raftUrgent(v) && v.current.kind === "fish" && stageWants(v.team).food === 0)) return v.current;
  const wants = teamWants(v);
  const personal = personalWants(v);
  const aff = AFFINITY[s.role];
  // Raft in trouble: whatever the current stage needs comes first, for every role.
  const urgent = raftUrgent(v);
  const stage = stageWants(v.team);
  const stageNeeds: Partial<Record<Resource, number>> = { wood: stage.wood, rope: stage.rope, food: stage.food, water: stage.water };
  const options: { score: number; goal: Goal }[] = [];
  for (const res of RESOURCES) {
    const need = Math.min(wants[res], 6) + (personal[res] ?? 0) * 6;
    if (need <= 0) continue;
    const critical = urgent && (stageNeeds[res] ?? 0) > 0;
    let score = (critical ? Math.max(aff[res], 0.9) * 2.5 : aff[res]) * need;
    // A fisher with a rod catches food much better than anyone shaking palms.
    if (res === "food" && s.role === "balikci" && countIn(s.slots, "rod") > 0) score *= 1.4;
    const goal = sourceFor(v, res);
    if (goal) options.push({ score, goal });
  }
  if (personal.ammo) {
    const coconut = handFreeForPalm(v) ? nearestNode(v, (n) => n.kind === "palm", 50) : null;
    const rock = roomIn(s.slots, "stone") > 0 ? nearestNode(v, (n) => n.kind === "rock", 50) : null;
    const score = (s.role === "bekci" ? 2.5 : 2) + personal.ammo * 0.6;
    if (coconut) options.push({ score, goal: { kind: "shake", node: coconut.i } });
    else if (rock) options.push({ score: score * 0.9, goal: { kind: "gather", node: rock.i } });
  }
  const fetch = chestFetch(v);
  if (fetch) options.push({ score: s.role === "hamal" || s.role === "asci" ? 6 : 3.5, goal: fetch });
  if (!options.length) {
    // Nothing the team lacks: the Balıkçı keeps fishing, the rest stockpile wood (fuel, later stages).
    const fallback = s.role === "balikci" ? sourceFor(v, "food") : sourceFor(v, s.role === "asci" ? "water" : "wood");
    return fallback;
  }
  // Small random tie-break so identical bots don't all pick the same resource.
  let best = options[0]!;
  let bestScore = -Infinity;
  options.forEach((o, i) => {
    const score = o.score + (((i + 1) * 0.6180339 + v.roll) % 1) * 0.25;
    if (score > bestScore) {
      bestScore = score;
      best = o;
    }
  });
  return best.goal;
}

/* ------------------------------------------------------------- pickups */

function pickup(v: BotView, maxD: number): Goal | null {
  const s = v.self;
  const night = isNight(v);
  let best: BotGroundItem | null = null;
  let bestScore = 0;
  for (const it of v.items) {
    // E only takes items that lie still (resting on the ground or stuck in something).
    if ((it.state !== "rest" && it.state !== "stuck") || v.claims.items.has(it.id) || v.blocked(`pickup:${it.id}`)) continue;
    const value = itemValue(v, it.kind);
    if (value <= 0 || roomIn(s.slots, it.kind) <= 0) continue;
    const d = d2(s.x, s.z, it.x, it.z);
    if (d > maxD) continue;
    if (night && (!lit(v, it.x, it.z, 0.4) || v.monsters.some((m) => isHostile(m) && d2(m.x, m.z, it.x, it.z) < 5))) continue;
    const score = value / (1 + d / 6);
    if (score > bestScore) {
      bestScore = score;
      best = it;
    }
  }
  return best ? { kind: "pickup", projectileId: best.id } : null;
}

function collectCrab(v: BotView): Goal | null {
  const s = v.self;
  if (roomIn(s.slots, "crab_raw") <= 0) return null;
  const night = isNight(v);
  let best: BotMonster | null = null;
  let bestD = night ? 12 : 18;
  for (const m of v.monsters) {
    if (m.kind !== "crab" || m.mode !== "flipped" || v.claims.crabs.has(m.id) || v.blocked(`collectCrab:${m.id}`)) continue;
    const d = d2(s.x, s.z, m.x, m.z);
    if (d >= bestD) continue;
    if (night && lightGap(v, m.x, m.z) > NIGHT_CRAB_REACH) continue;
    if (v.monsters.some((o) => o.id !== m.id && isHostile(o) && o.mode !== "emerge" && d2(o.x, o.z, m.x, m.z) < 5)) continue;
    bestD = d;
    best = m;
  }
  return best ? { kind: "collectCrab", monsterId: best.id } : null;
}

/* ================================================================ main */

function campOrPost(v: BotView): Goal {
  const s = v.self;
  const raft = v.site.raft;
  if (isNight(v) || isEvening(v)) {
    // Night watch: the designated guard holds the sand next to the raft, inside RAFT_GUARD_RADIUS, so a crab or
    // the boss has to deal with a person instead of chewing the hull for free. A planted torch is what makes the
    // post survivable (crabs stay out of the light); on the last night it holds the post even when the torch is
    // out, because a hull chewed below cost is no longer ready at the gate. The rest warm up at the fire.
    const lastNightWatch = isNight(v) && v.clock.day >= DAYS && v.team.stage >= 2;
    if (owns(v, "guard") && (raftTorchLife(v) > 0 || lastNightWatch)) {
      return { kind: "guard", at: spreadSpot(raftStand(v, 2.2), s.seat, 1.2) };
    }
    return { kind: "camp", at: spreadSpot(v.site.campfire, s.seat, 2.2) };
  }
  // Daytime idle: near the fire, or by the raft when it's close to done.
  if (v.team.stage >= 2 && d2(raft.x, raft.z, v.site.campfire.x, v.site.campfire.z) < 30) return { kind: "camp", at: spreadSpot(raftStand(v, 3), s.seat, 1.5) };
  return { kind: "camp", at: spreadSpot(v.site.campfire, s.seat, 2.6) };
}

/** Downed: crawl toward the nearest teammate who can revive us (else the campfire). */
function crawl(v: BotView): Goal {
  const s = v.self;
  let to: XZ = v.site.campfire;
  let best = Infinity;
  for (const m of v.mates) {
    if (!m.alive || m.downed || m.washed || m.boarded) continue;
    const d = d2(s.x, s.z, m.x, m.z);
    if (d < best) {
      best = d;
      to = { x: m.x, z: m.z };
    }
  }
  return { kind: "crawl", to };
}

/**
 * The bot's next goal (see the priority list in the file header). Pure: same view → same goal.
 */
export function chooseGoal(v: BotView): Goal {
  const s = v.self;
  const phase = v.clock.phase;
  if ((phase !== "playing" && phase !== "landing") || v.clock.locked || s.boarded) return { kind: "idle" };
  if (s.downed) return crawl(v);
  const starving = s.hunger < STARVING || s.thirst < STARVING;
  const night = isNight(v);
  const tiers: ((v: BotView) => Goal | null)[] = [
    boardNow,
    puffer,
    flee,
    revive,
    board,
    repair,
    ...(starving ? [selfCare, attack] : [attack, selfCare]),
    pass,
  ];
  for (const tier of tiers) {
    const g = tier(v);
    if (g) return g;
  }
  // A ready raft still waits for the departure gate. Until the approach window opens, keep the camp running
  // (fire, food, ammo) instead of standing on the exposed beach for minutes: only the last few seconds belong to
  // boarding. Inside the window the whole crew waits by the raft, then boards as soon as the gate opens.
  if (v.team.stage === 3 && v.clock.stormLeft <= DEPARTURE_GATE_TICKS + secToTicks(BOARD_APPROACH_SEC)) {
    return { kind: "wait", at: spreadSpot(raftStand(v, 3), s.seat, 1.4) };
  }
  // A damaged hull goes in before the camp chores; otherwise the fire and cooking come first.
  const late: ((v: BotView) => Goal | null)[] = urgentRepair(v)
    ? [deliver, evening, craft, housekeep]
    : [evening, deliver, craft, housekeep];
  for (const tier of late) {
    const g = tier(v);
    if (g) return g;
  }
  const near = pickup(v, 5);
  if (near) return near;
  // Night repair: fetch the chest's spare wood / parts (the chest sits at the lit camp) and carry it to the raft.
  if (night && urgentRepair(v)) {
    const fetch = chestFetch(v);
    if (fetch) return fetch;
  }
  if (!night || urgentRepair(v)) {
    const w = work(v);
    if (w) return w;
  }
  return collectCrab(v) ?? pickup(v, night ? 30 : 16) ?? campOrPost(v);
}

/* ============================================================ stand-in */

/**
 * Goals a reconnect stand-in may run: walking and looking around, plus E on a downed teammate (revive) or on the
 * ready raft (board). Eating, drinking, throwing, tossing, delivering, crafting, the chest, fishing, gathering,
 * pickups, placing and planting are left out on purpose: those spend or change the absent player's inventory.
 */
export const STAND_IN_GOALS: ReadonlySet<GoalKind> = new Set<GoalKind>(["idle", "crawl", "flee", "revive", "board", "warm", "camp", "wait", "follow"]);

/**
 * The next goal of a reconnect stand-in: keep the dropped player's character safe until they're back and spend
 * nothing of theirs. In order: crawl when downed; flee a hostile monster that comes close (at any hp: it can't
 * fight back); revive a downed teammate (the same reach / two-helpers rule as every bot); board the ready raft
 * when the bots would (shouldBoard) — the seat still counts as a required passenger (§2.5), so staying ashore
 * would only hold the raft for the whole boarding countdown and then leave the player behind ("Wilson finale"),
 * and boarding hands nothing over; get out of the water; rest at the lit fire when hurt or cold; wait by the
 * ready raft (after dark only where it is lit); at dusk and night keep to the light — the fire's ring, else the
 * nearest planted torch or teammate's torch, else the nearest teammate; by day wait at the camp. Every result is
 * in STAND_IN_GOALS. Pure.
 */
export function chooseStandInGoal(v: BotView): Goal {
  const s = v.self;
  const phase = v.clock.phase;
  if ((phase !== "playing" && phase !== "landing") || v.clock.locked || s.boarded) return { kind: "idle" };
  if (s.downed) return crawl(v);
  const urgent = fleeAt(v, Infinity) ?? revive(v) ?? board(v);
  if (urgent) return urgent;
  const fire = v.site.campfire;
  if (s.swimming) return { kind: "camp", at: spreadSpot(fire, s.seat, 2.4) };
  if (needsFire(v)) return { kind: "warm" };
  const dark = isNight(v) || isEvening(v);
  if (v.team.stage === 3) {
    const at = spreadSpot(raftStand(v, 3), s.seat, 1.4);
    if (!dark || lit(v, at.x, at.z)) return { kind: "wait", at };
  }
  if (!dark) return { kind: "camp", at: spreadSpot(fire, s.seat, 2.6) };
  if (fireLit(v)) return { kind: "camp", at: spreadSpot(fire, s.seat, 2.2) };
  // The fire is out: the nearest other light (a planted torch, a teammate's torch), else the nearest teammate.
  let best: Goal | null = null;
  let bestD = Infinity;
  for (const l of v.lights) {
    const d = d2(s.x, s.z, l.x, l.z);
    if (l.kind === "fire" || d >= bestD) continue;
    if (l.kind === "planted") {
      best = { kind: "camp", at: spreadSpot(l, s.seat, 1.2) };
      bestD = d;
      continue;
    }
    // A held torch: follow whoever carries it (our own torch, if we hold one, has no holder among the mates).
    const holder = v.mates.find((m) => m.alive && !m.downed && d2(m.x, m.z, l.x, l.z) < 0.5);
    if (holder) {
      best = { kind: "follow", playerId: holder.id };
      bestD = d;
    }
  }
  if (best) return best;
  for (const m of v.mates) {
    if (!m.alive || m.downed || m.washed || m.boarded) continue;
    const d = d2(s.x, s.z, m.x, m.z);
    if (d < bestD) {
      bestD = d;
      best = { kind: "follow", playerId: m.id };
    }
  }
  return best ?? { kind: "camp", at: spreadSpot(fire, s.seat, 2.2) };
}

/** Aim noise (degrees) for a role; a rare wild throw ("bazen yanlış yere ceviz atar") multiplies it. */
export function aimNoiseFor(role: BotRole, roll: number): number {
  const base = BOT_AIM_NOISE_DEG[role];
  return roll < 0.05 ? base * 5 : base;
}
