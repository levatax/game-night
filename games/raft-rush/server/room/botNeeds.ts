// Team economy for the bot brain (§7 raft stages, §21 tempo): what the raft still needs, what the team already
// holds, what is worth gathering next, and the raft pacing (ahead of / behind the schedule). Owner: server-bots.
// Pure functions over BotView data.

import { CHARACTERS, DAYS, FIRE_FUEL_MAX_TICKS, FIRE_WOOD_FUEL_TICKS, RAFT_PART_WOOD, TICK_RATE, WRECK_HULL_WOOD, secToTicks } from "../../shared/constants.js";
import { ITEMS, RECIPES } from "../../shared/items.js";
import type { BotRole, CharacterId, InvKind, ItemKind, RecipeId } from "../../shared/types.js";
import type { BotClock, BotSlot, BotTeam, BotView } from "./botTypes.js";

export type Resource = "wood" | "rope" | "stone" | "food" | "water";
export const RESOURCES: ReadonlyArray<Resource> = ["wood", "rope", "stone", "food", "water"];

/** Food the raft's provision stage accepts and bots eat (crab_raw is cooked first). */
const FOOD_KINDS: ReadonlyArray<ItemKind> = ["coconut", "fish_raw", "fish_cooked", "crab_cooked", "fish_golden"];

/* ------------------------------------------------------------ inventory */

/** Units of `kind` across the slots. */
export function countIn(slots: ReadonlyArray<BotSlot>, kind: ItemKind): number {
  let n = 0;
  for (const s of slots) if (s.kind === kind) n += s.count;
  return n;
}

/** First slot holding `kind`, -1 when none. */
export function slotOf(slots: ReadonlyArray<BotSlot>, kind: ItemKind): number {
  for (let i = 0; i < slots.length; i++) if (slots[i]!.kind === kind) return i;
  return -1;
}

export function emptySlotCount(slots: ReadonlyArray<BotSlot>): number {
  let n = 0;
  for (const s of slots) if (s.kind === "") n++;
  return n;
}

/** Units of `kind` that would still fit (partial stacks, then empty slots), like shared roomFor(). */
export function roomIn(slots: ReadonlyArray<BotSlot>, kind: ItemKind): number {
  const stack = ITEMS[kind].stack;
  let n = 0;
  for (const s of slots) {
    if (s.kind === kind) n += Math.max(0, stack - s.count);
    else if (s.kind === "") n += stack;
  }
  return n;
}

/**
 * A slot that makes LMB a palm "use" (shake): the axe (drops every coconut), an empty hand, or another
 * non-throwable that has its own LMB meaning neither (rod casts, torch swings, placeables place). -1 when none.
 */
export function palmHandSlot(slots: ReadonlyArray<BotSlot>): number {
  const axe = slotOf(slots, "axe");
  if (axe >= 0) return axe;
  for (let i = 0; i < slots.length; i++) if (slots[i]!.kind === "") return i;
  for (let i = 0; i < slots.length; i++) {
    const k = slots[i]!.kind;
    if (k !== "" && !ITEMS[k].throwable && k !== "rod" && k !== "torch" && k !== "jellyfish" && ITEMS[k].places === null) return i;
  }
  return -1;
}

/** Group of an item for supply / demand accounting. */
export function resourceOf(kind: InvKind): Resource | null {
  if (kind === "wood" || kind === "raft_part") return "wood";
  if (kind === "rope") return "rope";
  if (kind === "stone") return "stone";
  if (kind === "water") return "water";
  if (kind === "crab_raw" || (kind !== "" && FOOD_KINDS.includes(kind))) return "food";
  return null;
}

/** Wood a unit of `kind` is worth (raft part = RAFT_PART_WOOD, + the Kaptan's bonus when delivered). */
function woodValue(kind: InvKind, character: CharacterId | null): number {
  if (kind === "wood") return 1;
  if (kind === "raft_part") return RAFT_PART_WOOD + (character ? CHARACTERS[character].raftPartBonus : 0);
  return 0;
}

/* ------------------------------------------------------------------ raft */

export interface RaftRemaining {
  hull: number;
  mastWood: number;
  mastRope: number;
  food: number;
  water: number;
}

/** Units still missing per raft component (stage-independent). */
export function raftRemaining(team: BotTeam): RaftRemaining {
  return {
    hull: Math.max(0, team.cost.hullWood - team.hullWood),
    mastWood: team.sail ? 0 : Math.max(0, team.cost.mastWood - team.mastWood),
    mastRope: team.sail ? 0 : Math.max(0, team.cost.mastRope - team.mastRope),
    food: Math.max(0, team.cost.food - team.food),
    water: Math.max(0, team.cost.water - team.water),
  };
}

export interface StageWants {
  wood: number;
  rope: number;
  food: number;
  water: number;
}

/** What E at the raft accepts right now (only the current stage counts, §2.4). */
export function stageWants(team: BotTeam): StageWants {
  const r = raftRemaining(team);
  if (team.stage === 0) return { wood: r.hull, rope: 0, food: 0, water: 0 };
  if (team.stage === 1) return { wood: r.mastWood, rope: r.mastRope, food: 0, water: 0 };
  if (team.stage === 2) return { wood: 0, rope: 0, food: r.food, water: r.water };
  return { wood: 0, rope: 0, food: 0, water: 0 };
}

export function stageTotal(w: StageWants): number {
  return w.wood + w.rope + w.food + w.water;
}

/** Which current-stage bucket a unit of `kind` fills, or null. */
export function deliverBucket(kind: InvKind, stage: number): keyof StageWants | null {
  if (kind === "") return null;
  if (stage <= 1 && (kind === "wood" || kind === "raft_part")) return "wood";
  if (stage === 1 && kind === "rope") return "rope";
  if (stage === 2) {
    const p = ITEMS[kind].provision;
    if (p === "food") return "food";
    if (p === "water") return "water";
  }
  return null;
}

/** Units of the current stage's needs these slots would deliver. */
export function deliverableUnits(slots: ReadonlyArray<BotSlot>, team: BotTeam, character: CharacterId): number {
  const want = stageWants(team);
  const got: StageWants = { wood: 0, rope: 0, food: 0, water: 0 };
  for (const s of slots) {
    const b = deliverBucket(s.kind, team.stage);
    if (!b) continue;
    got[b] += b === "wood" ? woodValue(s.kind, character) * s.count : s.count;
  }
  return Math.min(got.wood, want.wood) + Math.min(got.rope, want.rope) + Math.min(got.food, want.food) + Math.min(got.water, want.water);
}

/* ----------------------------------------------------------------- pacing */

/**
 * Bots pace the raft so the nights still happen (game4.md §21 tempo: an efficient team is ready around the end
 * of day 2, a scattered one on day 3; the balance band for bot-only matches is 55–75 % wins on Normal). The
 * schedule reaches 100 % at PACE_FINISH_FRACTION of the match clock; while the team is more than PACE_SLACK
 * (+ PACE_SLACK_PER_HUMAN per human) ahead of it, bots stop feeding the raft and stock up / guard / rest
 * instead. Humans are never held back: their deliveries always count, so a keen team launches early.
 */
export const PACE_FINISH_FRACTION = 0.75;
export const PACE_SLACK = 0.06;

/** Fraction 0..1 of the raft's requirement units delivered by the team (the wreck's free hull wood excluded; stage 3 = 1). */
export function raftProgress(team: BotTeam): number {
  if (team.stage >= 3) return 1;
  const c = team.cost;
  const free = Math.min(WRECK_HULL_WOOD, c.hullWood);
  const mast = team.sail ? c.mastWood + c.mastRope : Math.min(team.mastWood, c.mastWood) + Math.min(team.mastRope, c.mastRope);
  const done = Math.min(team.hullWood, c.hullWood) + mast + Math.min(team.food, c.food) + Math.min(team.water, c.water);
  const total = c.hullWood + c.mastWood + c.mastRope + c.food + c.water;
  return total > free ? Math.max(0, done - free) / (total - free) : 1;
}

/**
 * Bots load the last provisions only this late in the match (seconds since playing began), so a finished hull and
 * mast do not turn into an early raft: the ready moment lands in the last night, after the boss has spawned.
 * A human's own deliveries are never held back.
 */
export const READY_TARGET_SEC = 448;

/** Seconds since playing began. */
export function raftElapsedSec(c: BotClock): number {
  const total = DAYS * (c.dayTicks + c.duskTicks + c.nightTicks);
  return Math.max(0, total - c.stormLeft) / TICK_RATE;
}

/** The hull and mast stand and it is time to load the provisions (stage 2 → 3). */
export function finalLoadDue(v: BotView): boolean {
  return v.team.stage === 2 && raftElapsedSec(v.clock) >= READY_TARGET_SEC;
}

/**
 * True when one more delivery press from these slots would complete the raft (stage 3), mirroring the server's
 * stage-by-stage plan: hull, then mast, then provisions. Used to hold only the finishing load.
 */
export function wouldFinishRaft(v: BotView): boolean {
  const t = v.team;
  if (t.stage >= 3) return true;
  let hull = t.hullWood;
  let mastWood = t.mastWood;
  let mastRope = t.mastRope;
  let food = t.food;
  let water = t.water;
  let wood = 0;
  let rope = 0;
  let foodUnits = 0;
  let waterUnits = 0;
  for (const s of v.self.slots) {
    if (s.kind === "wood" || s.kind === "raft_part") wood += woodValue(s.kind, v.self.character) * s.count;
    else if (s.kind === "rope") rope += s.count;
    else if (s.kind !== "" && ITEMS[s.kind].provision === "food") foodUnits += s.count;
    else if (s.kind !== "" && ITEMS[s.kind].provision === "water") waterUnits += s.count;
  }
  const c = t.cost;
  const take = (have: number, need: number): number => Math.min(have, Math.max(0, need));
  const hullUse = take(wood, c.hullWood - hull);
  hull += hullUse;
  wood -= hullUse;
  if (hull < c.hullWood) return false;
  const mastWoodUse = take(wood, c.mastWood - mastWood);
  mastWood += mastWoodUse;
  const mastRopeUse = take(rope, c.mastRope - mastRope);
  mastRope += mastRopeUse;
  if (mastWood < c.mastWood || mastRope < c.mastRope) return false;
  food += take(foodUnits, c.food - food);
  water += take(waterUnits, c.water - water);
  return food >= c.food && water >= c.water;
}

/** Where the raft "should" be by now (0..1). */
export function raftSchedule(c: BotClock): number {
  const total = DAYS * (c.dayTicks + c.duskTicks + c.nightTicks);
  const elapsed = Math.max(0, total - c.stormLeft);
  return Math.min(1, elapsed / (total * PACE_FINISH_FRACTION));
}

/**
 * A crab (or the boss) chewed hull wood off a raft that had already moved past the hull stage: the mast / provision
 * progress is still there but the hull count is short again. This is repair, not normal building, so the pacing
 * rules must not park it in the chest.
 */
export function raftHullDamaged(team: BotTeam): boolean {
  if (team.hullWood >= team.cost.hullWood) return false;
  return team.sail || team.mastWood > 0 || team.mastRope > 0 || team.food > 0 || team.water > 0;
}

/**
 * The raft is in trouble: clearly behind the schedule, damaged, or the last day began and it isn't ready. Every bot
 * then works on what the current stage needs, whatever its role.
 */
export function raftUrgent(v: BotView): boolean {
  if (v.team.stage >= 3) return false;
  if (raftHullDamaged(v.team)) return true;
  if (finalLoadDue(v)) return true;
  if (v.clock.day >= DAYS) return true;
  return raftSchedule(v.clock) - raftProgress(v.team) > 0.15;
}

/** Extra slack per connected human: bots keep helping a player who pushes the raft hard. */
export const PACE_SLACK_PER_HUMAN = 0.08;

/** The team is comfortably ahead of the schedule: bots ease off the raft. */
export function aheadOfSchedule(v: BotView): boolean {
  // Structure is paced; provisions are loaded as they come (their final completing load is held in botBrain).
  if (v.team.stage >= 2) return false;
  const humans = v.mates.filter((m) => m.human && m.alive && !m.washed).length;
  return raftProgress(v.team) - raftSchedule(v.clock) > PACE_SLACK + PACE_SLACK_PER_HUMAN * humans;
}

/* ------------------------------------------------------------------ fire */

/** Ticks until the next dawn (end of the coming / current night). */
export function ticksToDawn(c: BotClock): number {
  if (c.dayPhase === "day") return c.phaseLeft + c.duskTicks + c.nightTicks;
  if (c.dayPhase === "dusk") return c.phaseLeft + c.nightTicks;
  return c.phaseLeft;
}

/** Fuel ticks still missing for the fire to last through the coming night (0 when it will). */
export function fireShortfall(v: BotView): number {
  const c = v.clock;
  const dark = c.dayPhase === "day" ? c.duskTicks + c.nightTicks : ticksToDawn(c);
  const atDusk = c.dayPhase === "day" ? Math.max(0, v.team.fireFuel - c.phaseLeft) : v.team.fireFuel;
  return Math.max(0, Math.min(FIRE_FUEL_MAX_TICKS, dark + secToTicks(5)) - atDusk);
}

/** Wood (inventory + chest) the bot can use for a recipe right now. */
export function woodAt(v: BotView): number {
  return countIn(v.self.slots, "wood") + (v.team.chest.wood ?? 0);
}

/* ---------------------------------------------------------------- tools */

/** Tools a role wants to carry (crafted early, §12). */
export function roleTools(role: BotRole): RecipeId[] {
  if (role === "hamal") return ["axe"];
  if (role === "balikci") return ["rod"];
  if (role === "bekci") return ["spear"];
  return [];
}

/** Recipes of `roleTools` the slots don't hold yet. */
export function missingTools(role: BotRole, slots: ReadonlyArray<BotSlot>): RecipeId[] {
  return roleTools(role).filter((r) => {
    const out = RECIPES[r].out;
    return out !== null && countIn(slots, out) === 0;
  });
}

/** Ingredients `recipe` needs on top of what the inventory + chest hold (empty = craftable). */
export function missingFor(recipe: RecipeId, slots: ReadonlyArray<BotSlot>, chest: Partial<Record<ItemKind, number>>): Partial<Record<ItemKind, number>> {
  const out: Partial<Record<ItemKind, number>> = {};
  for (const [k, n] of Object.entries(RECIPES[recipe].cost) as [ItemKind, number][]) {
    const have = countIn(slots, k) + (chest[k] ?? 0);
    if (have < n) out[k] = n - have;
  }
  return out;
}

/* ---------------------------------------------------------- supply/demand */

export type ResourceCounts = Record<Resource, number>;

function zero(): ResourceCounts {
  return { wood: 0, rope: 0, stone: 0, food: 0, water: 0 };
}

function addSlots(into: ResourceCounts, slots: ReadonlyArray<BotSlot>): void {
  for (const s of slots) {
    const r = resourceOf(s.kind);
    if (r) into[r] += r === "wood" ? woodValue(s.kind, null) * s.count : s.count;
  }
}

/** What the whole team holds (every living teammate's inventory + the chest). */
export function teamSupply(v: BotView): ResourceCounts {
  const out = zero();
  addSlots(out, v.self.slots);
  for (const m of v.mates) if (m.alive && !m.washed) addSlots(out, m.slots);
  for (const [k, n] of Object.entries(v.team.chest) as [ItemKind, number][]) {
    const r = resourceOf(k);
    if (r && n > 0) out[r] += r === "wood" ? woodValue(k, null) * n : n;
  }
  return out;
}

/** What the team will need: the raft (current and later stages), fire fuel for the night, missing tools, a food / water reserve. */
export function teamDemand(v: BotView): ResourceCounts {
  const out = zero();
  const r = raftRemaining(v.team);
  const st = v.team.stage;
  const ahead = aheadOfSchedule(v) && !raftHullDamaged(v.team);
  if (!ahead) {
    if (st <= 0) out.wood += r.hull;
    if (st <= 1) {
      out.wood += r.mastWood;
      out.rope += r.mastRope;
    }
    if (st <= 2) {
      out.food += r.food;
      out.water += r.water;
    }
  }
  out.wood += Math.ceil(fireShortfall(v) / FIRE_WOOD_FUEL_TICKS);
  // Tools of every bot-driven seat (self included).
  const seats: { role: BotRole; slots: ReadonlyArray<BotSlot> }[] = [{ role: v.self.role, slots: v.self.slots }];
  for (const m of v.mates) if (m.driven && m.alive && !m.washed && m.role !== "") seats.push({ role: m.role, slots: m.slots });
  for (const s of seats) {
    for (const tool of missingTools(s.role, s.slots)) {
      for (const [k, n] of Object.entries(RECIPES[tool].cost) as [ItemKind, number][]) {
        const res = resourceOf(k);
        if (res) out[res] += n;
      }
    }
  }
  // A night torch for the guard (1 wood + 1 rope) and something to eat / drink for everyone.
  out.wood += 1;
  out.rope += 1;
  // Ahead of the schedule the spare time goes into the larder (chest food / water for the nights).
  const members = 1 + v.mates.filter((m) => m.alive && !m.washed).length;
  out.food += ahead ? members * 2 : members;
  out.water += ahead ? members : Math.ceil(members / 2);
  return out;
}

/** Demand minus supply per resource (≥ 0). */
export function teamWants(v: BotView): ResourceCounts {
  const d = teamDemand(v);
  const s = teamSupply(v);
  const out = zero();
  for (const r of RESOURCES) out[r] = Math.max(0, d[r] - s[r]);
  return out;
}
