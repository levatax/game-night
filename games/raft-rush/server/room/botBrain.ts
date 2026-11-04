// Pure decision functions for the helper bots (§12 roles, §19 "Botlar", Long Tide §7). Owner: server-bots.
//
// chooseGoal(view) walks a fixed priority list and returns the first goal that applies:
//   0. puffer in the inventory → throw it away (it explodes in hand)
//   1. flee        hp low and a monster close, outside a light ring
//   2. revive      a downed teammate we can reach in time (the two closest bots go)
//   3. board       only while the push-off counts (a human starts it; with no human on the team, or the storm
//                  close, a bot may start it)
//   4. attack      monsters threatening the raft, the camp, a downed mate or us (spear holders go for Captain
//                  Crab); daytime thieves
//   5. self-care   eat / drink / warm up / rest at the fire / fetch food or water; Aşçı passes food to mates
//   6. evening     keep the fire fuelled (and repelling) through the night; the guard plants a torch at the raft
//   7. deliver     carry what the current raft stage needs (heavy cargo straight away)
//   8. assemble    hold E at the raft once the stage's materials are in (every bot within ASSEMBLE_RADIUS; the
//                  mast needs two holders, so the bots go together)
//   9. repair      a bot with a hammer patches the raft (plank / 2 wood) when its hp is low
//  10. craft       cook catches, role tools (axe + hammer, rod, spear), then the team plan's crafts: bench tiers,
//                  planks, nails, sailcloth, barrels (bench / minDay / a lit fire respected)
//  11. housekeep   burn jellyfish, stock surplus (and next-stage prestock, heavy cargo) in the camp chest
//  12. escort      the nearest free bot walks beside a teammate carrying a log / barrel
//  13. work        gather / fell / salvage / fish / water / chest fetch / ammo, scored by the team plan × role
//  14. pickups     useful items on the ground; flipped crabs
//  15. camp / night post (the guard and a second guard at the raft once the keel exists)
// At night the bot stays inside light rings (tiers 7–14 only run where it is lit, the raft guards excepted). The
// current goal is kept while it stays valid (stickiness). Team duties (night guards + torch, fire, water) are
// spread over the bot seats by role (dutyOwner). The economy (what to gather / craft) comes from the team plan's
// bill of materials (botNeeds.ts teamPlan); the day locks pace the raft, there is no schedule brake.
//
// chooseStandInGoal(view) is the much shorter menu of a reconnect stand-in (BotDesk.add with standIn: a bot
// keeping a dropped human's character alive for RECONNECT_GRACE_SEC): it moves, never spends. Every goal it
// returns is in STAND_IN_GOALS, the set the desk also filters by.
//
// steer (botSteer.ts) and aimAt (botAim.ts) are the other two pure functions of the brain; they are
// re-exported here so callers have one import.

import {
  BOT_AIM_NOISE_DEG,
  ESCORT_RADIUS,
  FIRE_FUEL_MAX_TICKS,
  FIRE_LIGHT_RADIUS,
  FIRE_WOOD_FUEL_TICKS,
  RAFT_HP_BOARD,
  RAFT_REPAIR_WOOD_COST,
  REVIVE_TICKS,
  TICK_RATE,
  WATER_Y,
  secToTicks,
} from "../../shared/constants.js";
import { ITEMS, RECIPES } from "../../shared/items.js";
import type { XZ } from "../../shared/island/types.js";
import type { BotRole, InvKind, ItemKind, MonsterKind, RecipeId } from "../../shared/types.js";
import {
  countIn,
  deliverableUnits,
  deliverWanted,
  emptySlotCount,
  fireShortfall,
  heavyIn,
  missingFor,
  missingTools,
  palmHandSlot,
  FUEL_RESERVE_WOOD,
  RAFT_REPAIR_TARGET,
  raftDone,
  raftGood,
  raftUrgent,
  RESOURCES,
  roomIn,
  slotOf,
  stageAssembling,
  stageMissing,
  teamPlan,
  ticksToDawn,
  woodAt,
  type Resource,
  type TeamPlan,
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
/** Everyone (but a posted guard) keeps this far from Captain Crab. */
export const BOSS_KEEP_AWAY = 5;
/** Rest at the fire below this hp (inside its light ring; not while the boss prowls there); a raft guard below GUARD_REST_HP. */
export const REST_HP = 40;
export const GUARD_REST_HP = 60;
/** Warm up at the fire below this warmth (night / rain); a posted raft guard holds out to GUARD_COLD. */
export const COLD = 35;
export const GUARD_COLD = 12;
/** Throw at monsters within this range (the sharp-eyed Bekçi further): beyond it the aim noise wastes ammo. */
export const ENGAGE_RANGE = 16;
export const ENGAGE_RANGE_BEKCI = 22;
/** By day the fire keeper tops the campfire up to this (the ring shrinks with the fuel and fails below 20 %). */
export const FIRE_KEEP_TICKS = secToTicks(200);
/** Seconds before dusk the evening duties start. */
export const EVENING_SEC = 14;
/** Sprint speed assumed when judging whether a revive can be reached in time (m/s). */
const RESCUE_SPEED = 6.2;
/** Night: a flipped crab is worth collecting when it lies this close to a light ring. */
const NIGHT_CRAB_REACH = 4;
const HOSTILE: ReadonlySet<MonsterKind> = new Set(["crab", "puffer", "boss"]);

/** How much each role likes each kind of work (§12 table; logs and scrap: Long Tide §7). */
export const AFFINITY: Readonly<Record<BotRole, Readonly<Record<Resource, number>>>> = {
  hamal: { wood: 1, rope: 0.85, stone: 0.7, food: 0.35, water: 0.35, log: 1.25, scrap: 0.9 },
  balikci: { wood: 0.45, rope: 0.7, stone: 0.4, food: 1, water: 0.55, log: 0.5, scrap: 0.7 },
  bekci: { wood: 0.7, rope: 0.75, stone: 0.8, food: 0.8, water: 0.5, log: 0.8, scrap: 0.8 },
  asci: { wood: 0.55, rope: 0.6, stone: 0.35, food: 0.85, water: 1, log: 0.5, scrap: 0.6 },
};

/** Bots within this of the raft come and hold E when a stage's materials are in. */
export const ASSEMBLE_RADIUS = 60;
/** A free bot within this of a heavy carrier escorts it. */
export const ESCORT_REACH = 18;
/** By day the bots patch the raft below this hp (the launch: below RAFT_REPAIR_TARGET). */
export const REPAIR_BELOW = 60;

/** Team duties. "guard2": the second raft guard at night (Long Tide §7: the Bekçi plus one more). */
export type Duty = "fire" | "guard" | "guard2" | "water";
const DUTY_ORDER: Readonly<Record<Duty, ReadonlyArray<BotRole>>> = {
  fire: ["asci", "balikci", "hamal", "bekci"],
  guard: ["bekci", "hamal", "asci", "balikci"],
  guard2: ["hamal", "bekci", "balikci", "asci"],
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
const DUTY_ASSIGN_ORDER: ReadonlyArray<Duty> = ["guard", "fire", "guard2", "water"];

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

/** One of the two night raft guards, once there is a raft to guard (the keel assembled), and no solo bot left. */
function raftGuardDuty(v: BotView): boolean {
  if (v.team.stage < 1 || v.team.raftHp <= 0) return false;
  if (owns(v, "guard")) return true;
  // The second guard only when there are at least 3 bot seats (else it would also be the fire keeper).
  const bots = 1 + v.mates.filter((m) => m.driven && m.alive && !m.washed && m.role !== "").length;
  return bots >= 3 && owns(v, "guard2");
}

/** The raft lies inside the campfire's ring (torches don't keep raft-bound crabs off it). */
function raftFireLit(v: BotView): boolean {
  const r = v.site.raft;
  for (const l of v.lights) if (l.kind === "fire" && d2(r.x, r.z, l.x, l.z) <= l.r - 1) return true;
  return false;
}

/** Ingredients for `recipe` are in reach (inventory + chest), plus a wood to relight the fire when it is out. */
export function canCraft(v: BotView, recipe: RecipeId): boolean {
  const def = RECIPES[recipe];
  if (def.duelOnly || def.locked || v.blocked(`craft:${recipe}`)) return false;
  if (def.bench > v.team.benchTier || def.minDay > v.clock.day) return false;
  if (def.effect === "bench" && v.team.benchTier >= def.tier) return false;
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
      return deliverWanted("raft_part", v.team) ? 2.8 : 1.8;
    case "log":
      return deliverWanted("log", v.team) || raftGood("log", v.team) || raftGood("raft_part", v.team) ? 3.5 : 1.5;
    case "barrel":
      return 3;
    case "compass":
      return 10;
    case "scrap":
    case "nails":
    case "cloth":
      return 2.4;
    case "hammer":
      return countIn(s.slots, "hammer") ? 0 : role === "hamal" ? 3 : 1.2;
    case "coconut":
      // The Hamal's hands are for tools and cargo; the others pick coconuts up (food, ammo).
      return role === "hamal" ? (s.hunger < HUNGRY ? 1.5 : 0) : 2.2;
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
      return role === "hamal" ? 1.7 : 1;
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
  return fleeBoss(v) ?? fleeAt(v, FLEE_HP);
}

/**
 * Captain Crab bites for 35 and light only slows him: whoever he comes for walks away at any hp (he is slower,
 * at half speed in the light) and throws from a distance. A posted raft guard kites him itself (botMotor guard).
 */
function fleeBoss(v: BotView): Goal | null {
  const s = v.self;
  if (isNight(v) && guardPosted(v)) return null;
  for (const m of v.monsters) {
    if (m.kind !== "boss" || !isHostile(m) || m.mode === "emerge") continue;
    const d = d2(s.x, s.z, m.x, m.z);
    if (d > BOSS_KEEP_AWAY && !(m.targetId === s.id && d < FLEE_RADIUS_BOSS)) continue;
    // Inside the fire's ring on the far side from him (he is slowed there, the crabs can't come in) when that is
    // out of his reach; else straight away from him.
    const fire = v.lights.find((l) => l.kind === "fire");
    if (fire) {
      const fx = fire.x - m.x;
      const fz = fire.z - m.z;
      const fl = Math.hypot(fx, fz) || 1;
      const to = { x: fire.x + (fx / fl) * Math.max(0.5, fire.r - 1), z: fire.z + (fz / fl) * Math.max(0.5, fire.r - 1) };
      if (d2(to.x, to.z, m.x, m.z) > BOSS_KEEP_AWAY + 0.5) return { kind: "flee", to, from: m.id };
    }
    const ax = s.x - m.x;
    const az = s.z - m.z;
    const al = Math.hypot(ax, az) || 1;
    return { kind: "flee", to: { x: s.x + (ax / al) * 8, z: s.z + (az / al) * 8 }, from: m.id };
  }
  return null;
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

/** Threat around (x, z): hostile crabs / puffers within 5 m count 1, Captain Crab within 7 m counts 2. */
function dangerAt(v: BotView, x: number, z: number): number {
  let n = 0;
  for (const m of v.monsters) {
    if (!isHostile(m) || m.mode === "emerge") continue;
    const d = d2(m.x, m.z, x, z);
    if (m.kind === "boss" ? d < 7 : d < 5) n += m.kind === "boss" ? 2 : 1;
  }
  return n;
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
    // Don't walk into the pack that downed them (they stay down DOWNED_TICKS: wait until it moves on).
    const danger = dangerAt(v, m.x, m.z);
    const boss = v.monsters.some((o) => o.kind === "boss" && isHostile(o) && d2(o.x, o.z, m.x, m.z) < 7);
    if ((boss || (!lit(v, m.x, m.z, 0) && danger >= 2)) && secsLeft > REVIVE_TICKS / TICK_RATE + d / RESCUE_SPEED + 3) continue;
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

/** With the storm this close a bot starts the push-off itself (a finished raft never waits for the storm). */
export const BOT_PUSH_OFF_STORM_SEC = 90;

/**
 * Board now (Long Tide §7.8): bots board only while the push-off counts; a human starts it. With no living human
 * on the team (bot-only matches, every human gone) or the storm less than BOT_PUSH_OFF_STORM_SEC away, a bot may
 * start it.
 */
export function shouldBoard(v: BotView): boolean {
  if (!raftDone(v.team) || !v.team.canBoard) return false;
  if (v.team.launchTicksLeft > 0) return true;
  if (v.clock.stormLeft <= secToTicks(BOT_PUSH_OFF_STORM_SEC)) return true;
  return !v.mates.some((m) => m.human && m.alive && !m.washed);
}

function board(v: BotView): Goal | null {
  if (!raftDone(v.team) || !v.team.canBoard || v.blocked("board")) return null;
  return shouldBoard(v) ? { kind: "board" } : null;
}

function attack(v: BotView): Goal | null {
  const s = v.self;
  const raft = v.site.raft;
  const fire = v.site.campfire;
  const raftSafe = raftFireLit(v);
  const guard = guardPosted(v);
  const guardPush = isNight(v) && !raftSafe && guard && s.hp > 55;
  // A posted guard swings its torch at the crabs (botMotor guard) instead of throwing its ammo away at them.
  const swinger = isNight(v) && guard;
  const spear = countIn(s.slots, "spear") > 0;
  const baseRange = s.role === "bekci" ? ENGAGE_RANGE_BEKCI : ENGAGE_RANGE;
  const current = v.current?.kind === "attack" ? v.current.monsterId : "";
  let best: BotMonster | null = null;
  let bestScore = 0;
  let bestClose = false;
  for (const m of v.monsters) {
    const hostile = isHostile(m);
    if (!hostile && !isThief(m)) continue;
    if (v.blocked(`attack:${m.id}`)) continue;
    if (swinger && m.kind === "crab") continue;
    const d = d2(s.x, s.z, m.x, m.z);
    const range = guardPush && d2(m.x, m.z, raft.x, raft.z) < 5 ? 45 : m.kind === "boss" ? Math.max(baseRange, spear ? 30 : 26) : baseRange;
    if (d > range) continue;
    // Still in the surf: a throw would just sink. Wait until it's on the beach (unless it's right here). Captain
    // Crab stands tall: he can be hit in the shallows by the raft slip.
    if (m.y < WATER_Y - (m.kind === "boss" ? 1 : 0.25) && d > 6) continue;
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
      // Every bot with a spear goes for Captain Crab (the compass, Long Tide §7.6); the others throw what they have.
      if (m.kind === "boss") score += spear ? 6 : 3.5;
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
  if (slot < 0) {
    // Out of ammo with Captain Crab about: restock stones from the camp chest (he takes many hits).
    if (best.kind === "boss" && (v.team.chest.stone ?? 0) > 0 && roomIn(s.slots, "stone") > 0 && distTo(v, v.site.chest) < 25 && !v.blocked("chestTake:stone")) {
      return { kind: "chestTake", items: [{ kind: "stone", count: Math.min(3, v.team.chest.stone ?? 0, roomIn(s.slots, "stone")) }] };
    }
    return null;
  }
  // Night, the raft is dark and something chews on it: a healthy guard walks out to deal with it. Captain Crab
  // (the compass): a healthy bot closes to throwing range (fleeBoss keeps it out of his reach).
  const atRaft = d2(best.x, best.z, raft.x, raft.z) < 5 && !raftSafe;
  const push = (atRaft && isNight(v) && guard && s.hp > 55) || (best.kind === "boss" && s.hp > 50 && !guard);
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
    const kind = slot >= 0 ? s.slots[slot]!.kind : "";
    if (slot >= 0 && !v.blocked(`eat:${slot}`) && !deliverWanted(kind, v.team)) return { kind: "eat", slot };
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
  // A raft guard with a torch in hand loses warmth slowly: it holds out longer before leaving its post.
  const cold = chilly && s.warmth < (night && guardPosted(v) ? GUARD_COLD : COLD);
  // The fire's light ring keeps crabs out, so it's the place to heal even at night (the boss excepted). A raft
  // guard leaves its post earlier: alone in the dark a second bite would down it.
  const restBelow = night && guardPosted(v) ? GUARD_REST_HP : REST_HP;
  const hurt = s.hp < restBelow && !v.monsters.some((m) => m.kind === "boss" && isHostile(m) && d2(m.x, m.z, fire.x, fire.z) < 10);
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
  // Torches for the raft guards (Long Tide §3.3: crabs going for the raft walk through torch light, so the guards
  // swing a lit torch at them; a torch planted by the raft keeps the puffers off it and lights the deck).
  const want = guardTorchWant(v);
  const mine = countIn(s.slots, "torch");
  if (want > 0) {
    const planter = !raftGuardDuty(v);
    if ((mine >= 2 || (planter && mine >= 1)) && raftTorchLife(v) < ticksToDawn(v.clock) * 0.6 && !v.blocked("plantTorch")) {
      // Only by light: the raft in the dark is no place for the fire keeper once the crabs are out.
      const stand = raftStand(v);
      if (!isNight(v) || lit(v, stand.x, stand.z, 0) || !v.monsters.some((m) => isHostile(m) && d2(m.x, m.z, stand.x, stand.z) < 10)) return { kind: "plantTorch", slot: slotOf(s.slots, "torch") };
    }
    if (mine < want) {
      if (chestHas(v, "torch") && roomIn(s.slots, "torch") > 0 && !v.blocked("chestTake:torch")) return { kind: "chestTake", items: [{ kind: "torch", count: 1 }] };
      if (canCraft(v, "torch") && roomIn(s.slots, "torch") > 0) return { kind: "craft", recipe: "torch", count: 1 };
      if (!night && countIn(s.slots, "rope") + (v.team.chest.rope ?? 0) === 0 && roomIn(s.slots, "rope") > 0) {
        const bush = nearestNode(v, (n) => n.kind === "bush" && n.yield === "rope", 25);
        if (bush) return { kind: "gather", node: bush.i };
      }
    }
    return null;
  }
  // A bot carrying a torch while no guard can light the raft plants it itself.
  const myTorch = slotOf(s.slots, "torch");
  if (myTorch >= 0 && v.team.stage >= 1 && raftTorchLife(v) < ticksToDawn(v.clock) * 0.6 && !v.blocked("plantTorch")) {
    const guard = v.mates.find((m) => m.id === dutyOwner(v, "guard"));
    if (!guard || countIn(guard.slots, "torch") === 0) return { kind: "plantTorch", slot: myTorch };
  }
  return null;
}

/**
 * Torches a bot wants for the night: a raft guard one to swing; the fire keeper one to plant by the raft (it keeps
 * the puffers off the deck).
 */
function guardTorchWant(v: BotView): number {
  // Only from the afternoon on: by day a slot is worth more for cargo (the torch waits in the chest).
  if (!afternoon(v) && !isEvening(v) && !isNight(v)) return 0;
  if (raftGuardDuty(v)) return 1;
  return owns(v, "fire") && v.team.stage >= 1 ? 1 : 0;
}

/** On raft watch tonight: a raft guard holding a torch to swing (without one it stays in the fire's ring). */
function guardPosted(v: BotView): boolean {
  return raftGuardDuty(v) && countIn(v.self.slots, "torch") > 0;
}

function deliver(v: BotView): Goal | null {
  const s = v.self;
  if (raftDone(v.team) || v.blocked("deliver")) return null;
  const units = deliverableUnits(s.slots, v.team);
  if (units <= 0) return null;
  const stand = raftStand(v);
  if (isNight(v) && !lit(v, stand.x, stand.z, 0) && !guardPosted(v)) return null;
  // Heavy cargo goes straight to the raft (it slows us down while we carry it).
  for (const slot of s.slots) if (slot.kind !== "" && ITEMS[slot.kind].heavy && deliverWanted(slot.kind, v.team)) return { kind: "deliver" };
  const want = stageMissing(v.team);
  if (units >= want) return { kind: "deliver" };
  if (isEvening(v) || distTo(v, v.site.raft) < 12) return { kind: "deliver" };
  if (raftUrgent(v) && units >= Math.min(want, 3)) return { kind: "deliver" };
  if (units >= 6) return { kind: "deliver" };
  // Can't carry any more of what we're carrying.
  for (const slot of s.slots) {
    if (slot.kind !== "" && deliverWanted(slot.kind, v.team) && roomIn(s.slots, slot.kind) === 0) return { kind: "deliver" };
  }
  return null;
}

/** Hold E at the raft once the current stage's materials are all in (Long Tide T2). */
function assemble(v: BotView): Goal | null {
  if (!stageAssembling(v.team) || v.blocked("assemble")) return null;
  if (isNight(v) && !guardPosted(v) && !raftFireLit(v)) return null;
  if (distTo(v, v.site.raft) > ASSEMBLE_RADIUS && !raftUrgent(v)) return null;
  return { kind: "assemble" };
}

/** Raft hp the bots want now: RAFT_REPAIR_TARGET on the launch stage (boarding needs RAFT_HP_BOARD), else REPAIR_BELOW. */
function repairBelow(v: BotView): number {
  return raftDone(v.team) ? RAFT_REPAIR_TARGET : REPAIR_BELOW;
}

/** A bot with a hammer patches the raft (Long Tide §3.3): a plank (+20) or 2 wood (+10) per E. */
function repair(v: BotView): Goal | null {
  const s = v.self;
  const team = v.team;
  if (team.stage < 1 || team.raftHp >= repairBelow(v) || v.blocked("repair")) return null;
  if (countIn(s.slots, "hammer") === 0) return null;
  const urgent = raftDone(team) && team.raftHp < RAFT_HP_BOARD;
  if (isNight(v) && !urgent && !guardPosted(v) && !raftFireLit(v)) return null;
  // E at the raft would deliver / assemble first.
  if (deliverableUnits(s.slots, team) > 0 || stageAssembling(team)) return null;
  // Only one repairer at a time (the closest bot with a hammer), unless the launch is at stake.
  if (!urgent) {
    const me = distTo(v, v.site.raft);
    for (const m of v.mates) {
      if (!m.driven || !m.alive || m.downed || m.role === "" || countIn(m.slots, "hammer") === 0) continue;
      if (d2(m.x, m.z, v.site.raft.x, v.site.raft.z) < me - 0.5) return null;
    }
  }
  if (countIn(s.slots, "raft_part") > 0 || countIn(s.slots, "wood") >= RAFT_REPAIR_WOOD_COST) return { kind: "repair" };
  const chest = v.team.chest;
  if ((chest.raft_part ?? 0) > 0 && roomIn(s.slots, "raft_part") > 0 && !v.blocked("chestTake:raft_part")) {
    const n = Math.min(chest.raft_part ?? 0, roomIn(s.slots, "raft_part"), Math.ceil((RAFT_REPAIR_TARGET - team.raftHp) / 20));
    return { kind: "chestTake", items: [{ kind: "raft_part", count: Math.max(1, n) }] };
  }
  if ((chest.wood ?? 0) >= RAFT_REPAIR_WOOD_COST && roomIn(s.slots, "wood") >= RAFT_REPAIR_WOOD_COST && !v.blocked("chestTake:wood")) {
    return { kind: "chestTake", items: [{ kind: "wood", count: Math.min(chest.wood ?? 0, roomIn(s.slots, "wood"), 4) }] };
  }
  return null;
}

/** The nearest free bot walks beside a teammate carrying a log / barrel (Long Tide T1: 85 % instead of 55 %). */
function escort(v: BotView): Goal | null {
  const s = v.self;
  if (isNight(v) || heavyIn(s.slots) > 0) return null;
  let best: BotMate | null = null;
  let bestD = ESCORT_REACH;
  for (const c of v.mates) {
    if (!c.alive || c.downed || c.washed || c.boarded || heavyIn(c.slots) === 0 || v.blocked(`escort:${c.id}`)) continue;
    const d = d2(s.x, s.z, c.x, c.z);
    if (d > bestD) continue;
    // Someone else already walks with them, or a free bot is closer.
    const mine = v.current?.kind === "escort" && v.current.playerId === c.id;
    let taken = false;
    for (const o of v.mates) {
      if (o.id === c.id || !o.alive || o.downed || o.boarded) continue;
      const od = d2(o.x, o.z, c.x, c.z);
      if (!mine && od <= ESCORT_RADIUS - 0.3) taken = true;
      else if (o.driven && o.role !== "" && heavyIn(o.slots) === 0 && od < d - 2) taken = true;
    }
    if (taken) continue;
    bestD = d;
    best = c;
  }
  return best ? { kind: "escort", playerId: best.id } : null;
}

/** Recipes a bot crafts for itself (role tools); the plan's other crafts are team materials. */
const TOOL_RECIPES: ReadonlySet<RecipeId> = new Set<RecipeId>(["axe", "hammer", "rod", "spear", "torch"]);
/** Plan crafts in priority order (Long Tide §7.4: benches, then processed materials). */
const CRAFT_PRIORITY: ReadonlyArray<RecipeId> = ["bench_1", "bench_2", "raft_part", "nails", "cloth", "barrel"];

/** How many times `recipe` can be made from the inventory + chest right now. */
function craftableTimes(v: BotView, recipe: RecipeId): number {
  let n = Infinity;
  for (const [k, c] of Object.entries(RECIPES[recipe].cost) as [ItemKind, number][]) {
    n = Math.min(n, Math.floor((countIn(v.self.slots, k) + (v.team.chest[k] ?? 0)) / c));
  }
  return Number.isFinite(n) ? n : 0;
}

function craft(v: BotView, plan: TeamPlan): Goal | null {
  const s = v.self;
  const nearFire = distTo(v, v.site.campfire) < 9;
  const crabs = countIn(s.slots, "crab_raw");
  if (crabs > 0 && canCraft(v, "cook_crab")) return { kind: "craft", recipe: "cook_crab", count: crabs };
  const raw = countIn(s.slots, "fish_raw");
  if (raw > 0 && (raw >= 2 || nearFire || isEvening(v) || deliverWanted("fish_cooked", v.team)) && canCraft(v, "cook_fish")) {
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
  // The team plan's crafts: the Hamal / Aşçı walk to the fire for them, anyone already by the fire helps.
  const hamal = v.mates.some((m) => m.driven && m.alive && !m.washed && m.role === "hamal");
  const crafter = s.role === "hamal" || s.role === "asci" || distTo(v, v.site.campfire) < 14 || !hamal;
  if (crafter) {
    for (const id of CRAFT_PRIORITY) {
      const want = plan.crafts[id] ?? 0;
      if (want <= 0 || TOOL_RECIPES.has(id) || !canCraft(v, id)) continue;
      const def = RECIPES[id];
      let count = Math.min(want, craftableTimes(v, id));
      if (def.out) count = Math.min(count, Math.floor(roomIn(s.slots, def.out) / Math.max(1, def.outCount)));
      if (count <= 0) continue;
      return { kind: "craft", recipe: id, count };
    }
  }
  // The raft guards make their night torches (they keep them: a torch only burns while it is in hand).
  if (countIn(s.slots, "torch") < guardTorchWant(v) && roomIn(s.slots, "torch") > 0) {
    if (chestHas(v, "torch") && !v.blocked("chestTake:torch")) return { kind: "chestTake", items: [{ kind: "torch", count: 1 }] };
    if (canCraft(v, "torch")) return { kind: "craft", recipe: "torch", count: 1 };
  }
  // Daytime upkeep: the fire keeper keeps it well fed while there is wood to spare; anyone by a dying fire feeds it.
  const keeper = owns(v, "fire") && distTo(v, v.site.campfire) < 14;
  if ((keeper || (nearFire && v.team.fireFuel < secToTicks(40))) && v.team.fireFuel < FIRE_KEEP_TICKS && woodAt(v) > 0 && !v.blocked("craft:fuel")) {
    const room = Math.floor((FIRE_FUEL_MAX_TICKS - v.team.fireFuel) / FIRE_WOOD_FUEL_TICKS);
    const count = Math.max(1, Math.min(room, woodAt(v), Math.ceil((FIRE_KEEP_TICKS - v.team.fireFuel) / FIRE_WOOD_FUEL_TICKS)));
    return { kind: "craft", recipe: "fuel", count };
  }
  return null;
}

/** How many units of `kind` the bot keeps (the rest goes into the chest). */
function keepCount(v: BotView, kind: ItemKind): number {
  const s = v.self;
  const guard = s.role === "bekci" || owns(v, "guard");
  // What the current stage takes is carried to the raft.
  if (deliverWanted(kind, v.team)) return Infinity;
  switch (kind) {
    case "rod":
      return s.role === "balikci" || s.role === "asci" || !v.mates.some((m) => m.driven && (m.role === "balikci" || m.role === "asci")) ? Infinity : 0;
    case "torch":
      return guardTorchWant(v) > 0 || isEvening(v) || isNight(v) ? Infinity : 0;
    case "axe":
    case "hammer":
    case "spear":
    case "coconut_ball":
    case "fish_raw":
    case "crab_raw":
    case "kraken":
    case "puffer":
      return Infinity;
    case "wood":
      // Into the chest, where every recipe (and the fire keeper) can reach it; hands stay free for cargo.
      return 0;
    case "raft_part":
      // The repairer keeps a couple of planks once there is a raft.
      return countIn(s.slots, "hammer") > 0 && v.team.stage >= 1 ? 2 : 0;
    case "rope":
      if (guard && isEvening(v)) return 1;
      return missingTools(s.role, s.slots).length ? 1 : 0;
    case "stone":
      // Ammo for the nights (Captain Crab takes many hits): everyone but the Hamal (full hands) keeps a stack.
      return s.role !== "hamal" ? 3 : missingTools(s.role, s.slots).length ? 1 : 0;
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
      // Logs, barrels, scrap, nails, sailcloth, the compass: into the chest (crafting reads it; prestock).
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
  // Heavy cargo (a log for planks, a barrel waiting for its stage) goes to the chest at once: it slows us down.
  if (items.some((i) => ITEMS[i.kind].heavy)) return goal;
  if (emptySlotCount(s.slots) === 0 && chestD < 60) return goal;
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

/** A tree worth felling with an axe: the fewer units left the sooner its log drops (cost ≈ walk + chop time). */
function treeToFell(v: BotView): BotNode | null {
  let best: BotNode | null = null;
  let bestCost = Infinity;
  for (const n of v.nodes) {
    if (n.kind !== "tree" || v.claims.nodes.has(n.i) || v.blocked(`fell:${n.i}`) || v.blocked(`gather:${n.i}`)) continue;
    const d = distTo(v, n);
    if (d > 80) continue;
    const cost = d + n.amount * 4 + 0.3 * d2(n.x, n.z, v.site.campfire.x, v.site.campfire.z);
    if (cost < bestCost) {
      bestCost = cost;
      best = n;
    }
  }
  return best;
}

/** Concrete goal that produces `res`, or null when there is no source in reach / no room / no tool. */
function sourceFor(v: BotView, res: Resource): Goal | null {
  const s = v.self;
  switch (res) {
    case "wood": {
      if (roomIn(s.slots, "wood") <= 0) return null;
      const n = nearestNode(v, (x) => x.kind === "tree", 70, s, v.site.campfire);
      return n ? { kind: "gather", node: n.i } : null;
    }
    case "log": {
      // Only an axe fells a tree (Long Tide §4.1), and one heavy item at a time.
      if (countIn(s.slots, "axe") === 0 || roomIn(s.slots, "log") <= 0) return null;
      const n = treeToFell(v);
      return n ? { kind: "fell", node: n.i } : null;
    }
    case "scrap": {
      if (roomIn(s.slots, "scrap") <= 0) return null;
      if (countIn(s.slots, "hammer") > 0 && v.team.wreckScrap > 0 && !v.blocked("salvage")) return { kind: "salvage" };
      if (countIn(s.slots, "rod") > 0) {
        const spot = nearestFishSpot(v);
        if (spot >= 0 && emptySlotCount(s.slots) > 0) return { kind: "fish", spot };
      }
      return null;
    }
    case "rope": {
      if (roomIn(s.slots, "rope") <= 0) return null;
      const n = nearestNode(v, (x) => x.kind === "bush" && x.yield === "rope", 80);
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
      if (roomIn(s.slots, "water") <= 0 || v.blocked("spring") || v.team.springCharges <= 0) return null;
      return { kind: "spring", uses: Math.min(roomIn(s.slots, "water"), 3, v.team.springCharges) };
  }
}

/** Current-stage needs the chest could cover right now, as a chestTake for this bot. */
function chestFetch(v: BotView): Goal | null {
  if (stageMissing(v.team) === 0) return null;
  const items: { kind: ItemKind; count: number }[] = [];
  for (const r of v.team.rows) {
    let need = Math.max(0, r.need - r.have);
    for (const kind of r.kinds) {
      if (need <= 0) break;
      const n = Math.min(v.team.chest[kind] ?? 0, need, roomIn(v.self.slots, kind));
      if (n <= 0) continue;
      items.push({ kind, count: n });
      need -= n;
    }
  }
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
    case "fell":
      return v.nodes.some((x) => x.i === g.node) && countIn(s.slots, "axe") > 0 && heavyIn(s.slots) === 0;
    case "salvage":
      return v.team.wreckScrap > 0 && countIn(s.slots, "hammer") > 0 && roomIn(s.slots, "scrap") > 0;
    case "shake":
      return v.nodes.some((x) => x.i === g.node) && handFreeForPalm(v);
    case "fish":
      return countIn(s.slots, "rod") > 0 && (emptySlotCount(s.slots) > 0 || roomIn(s.slots, "fish_raw") > 0 || s.fishState !== 0);
    case "spring":
      return v.team.springCharges > 0;
    default:
      return false;
  }
}

/** Personal extras on top of the team plan: tool ingredients, the guard's torch and ammo. */
function personalWants(v: BotView): Partial<Record<Resource | "ammo", number>> {
  const s = v.self;
  const out: Partial<Record<Resource | "ammo", number>> = {};
  for (const tool of missingTools(s.role, s.slots)) {
    if (RECIPES[tool].bench > v.team.benchTier) continue;
    for (const [k, n] of Object.entries(missingFor(tool, s.slots, v.team.chest)) as [ItemKind, number][]) {
      const r = k === "wood" ? "wood" : k === "rope" ? "rope" : k === "stone" ? "stone" : null;
      if (r) out[r] = (out[r] ?? 0) + n;
    }
  }
  // The fire keeper makes sure tonight's fuel (and a reserve) is in the chest or its pockets.
  if (owns(v, "fire")) {
    const want = Math.ceil(fireShortfall(v) / FIRE_WOOD_FUEL_TICKS) + FUEL_RESERVE_WOOD;
    const have = woodAt(v);
    if (have < want) out.wood = (out.wood ?? 0) + (want - have);
  }
  // The raft guards need torches for the night: their rope / wood become personal wants.
  if (countIn(s.slots, "torch") < guardTorchWant(v)) {
    for (const [k, n] of Object.entries(missingFor("torch", s.slots, v.team.chest)) as [ItemKind, number][]) {
      const r = k === "wood" ? "wood" : k === "rope" ? "rope" : null;
      if (r) out[r] = (out[r] ?? 0) + n;
    }
  }
  // Ammo for the night: the Bekçi's job all day; the other bots (not the Hamal, whose hands are full of tools)
  // stock up in the afternoon.
  if (s.role === "bekci" || (s.role !== "hamal" && afternoon(v))) {
    const ammo = countIn(s.slots, "stone") + countIn(s.slots, "coconut") + countIn(s.slots, "spear") + countIn(s.slots, "boot");
    if (ammo < 4) out.ammo = 4 - ammo;
  }
  return out;
}

/** The plan's raw wants spread over the bots: how much of `res` this bot should still go for. */
function work(v: BotView, plan: TeamPlan): Goal | null {
  const s = v.self;
  if (v.current && workStillValid(v, v.current) && !(raftUrgent(v) && v.current.kind === "fish" && !deliverWanted("fish_cooked", v.team))) return v.current;
  const wants = plan.raw;
  const personal = personalWants(v);
  const aff = AFFINITY[s.role];
  const urgent = raftUrgent(v);
  const options: { score: number; goal: Goal }[] = [];
  for (const res of RESOURCES) {
    // A log becomes 3 planks and a scrap 3 nails: weigh them by what they unlock, or one gating log (the anvil's
    // planks) loses to a pile of rope forever.
    const leverage = res === "log" ? 3 : res === "scrap" ? 2 : 1;
    const need = Math.min(wants[res] * leverage, 6) + (personal[res] ?? 0) * 6;
    if (need <= 0) continue;
    let score = aff[res] * need;
    if (urgent) score *= 1.5;
    // A fisher with a rod catches food much better than anyone shaking palms.
    if (res === "food" && (s.role === "balikci" || s.role === "asci") && countIn(s.slots, "rod") > 0) score *= 1.4;
    // Logs gate the most (keel, planks, mast): an axe holder goes for them first. Scrap only comes from the wreck
    // to a hammer (or rarely off a fishing line): its holder goes when the plan needs it.
    if (res === "log") score *= 1.3;
    if (res === "scrap" && countIn(s.slots, "hammer") > 0) score *= 1.8;
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
  if (fetch) options.push({ score: s.role === "hamal" || s.role === "asci" ? 7 : 4, goal: fetch });
  if (!options.length) {
    // Nothing the team lacks right now: stock what the later stages eat most (rope, logs), the fishers fish.
    const order: Resource[] = s.role === "balikci" || s.role === "asci" ? ["food", "rope", "wood"] : s.role === "hamal" ? ["log", "wood", "rope"] : ["rope", "stone", "wood"];
    for (const res of order) {
      const g = sourceFor(v, res);
      if (g) return g;
    }
    return null;
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
    // The two raft guards stand by the raft once there is one (Long Tide §7.6), the others in the fire's ring.
    if (guardPosted(v)) return { kind: "guard", at: spreadSpot(raftStand(v, 2.2), s.seat, 1.2) };
    return { kind: "camp", at: spreadSpot(v.site.campfire, s.seat, 2) };
  }
  // Daytime idle: by the raft when it's finished or close to it, else near the fire.
  if (raftDone(v.team) || (v.team.stage >= 4 && d2(raft.x, raft.z, v.site.campfire.x, v.site.campfire.z) < 30)) return { kind: "wait", at: spreadSpot(raftStand(v, 3), s.seat, 1.4) };
  return { kind: "camp", at: spreadSpot(v.site.campfire, s.seat, 2.6) };
}

/** Downed: crawl toward the nearest teammate who can revive us (else the campfire); at night into the fire's ring. */
function crawl(v: BotView): Goal {
  const s = v.self;
  let to: XZ = v.site.campfire;
  // In the dark the crabs follow whoever comes to help: crawl into the fire's light instead, where they can't.
  if ((isNight(v) || isEvening(v)) && fireLit(v) && v.lights.some((l) => l.kind === "fire")) return { kind: "crawl", to };
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
  const tiers: ((v: BotView) => Goal | null)[] = [puffer, flee, revive, board, ...(starving ? [selfCare, attack] : [attack, selfCare]), pass];
  for (const tier of tiers) {
    const g = tier(v);
    if (g) return g;
  }
  const plan = teamPlan(v);
  const late: ((v: BotView) => Goal | null)[] = [evening, deliver, assemble, repair, (x) => craft(x, plan), housekeep, escort];
  for (const tier of late) {
    const g = tier(v);
    if (g) return g;
  }
  const near = pickup(v, 5);
  if (near) return near;
  if (!night) {
    const w = work(v, plan);
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
  if (raftDone(v.team)) {
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
