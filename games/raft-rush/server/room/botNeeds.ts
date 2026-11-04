// Team economy for the bot brain (Long Tide §3 raft stages, §7 bots): what the raft still needs, what the team
// already holds, what is worth gathering or crafting next. Owner: server-bots. Pure functions over BotView data.
//
// teamPlan() is a bill-of-materials expansion over RECIPES: the demand (the current stage's missing rows, the next
// stage's rows as chest prestock, the bot seats' role tools, fuel for the coming night, a small larder, planks for
// a raft repair) is matched against the team's supply (every living teammate's pockets + the chest); what is
// short and has a producing recipe becomes crafts of that recipe (plank → log, nails → scrap + stone, barrel →
// planks + rope + water, …, plus the bench tier the recipe needs and that bench's own ingredients); what is short
// and has no recipe becomes a raw want (wood, rope, stone, log, scrap, water, food to fish and cook; the compass
// only Captain Crab drops). The day locks pace the raft: there is no schedule brake any more — when the current
// stage is locked, its rows are still demanded and go into the chest (prestock).

import {
  FIRE_DAY_BURN_MULT,
  FIRE_FUEL_MAX_TICKS,
  FIRE_REPEL_MIN_FRACTION,
  FIRE_WOOD_FUEL_TICKS,
  HEAVY_MAX,
  RAIN_FIRE_DRAIN_MULT,
  RAFT_LAUNCH_STAGE,
  RAFT_REPAIR_PLANK_HP,
  secToTicks,
} from "../../shared/constants.js";
import { isCookRecipe, ITEMS, RECIPES } from "../../shared/items.js";
import type { BotRole, InvKind, ItemKind, RecipeId } from "../../shared/types.js";
import type { BotClock, BotRaftRow, BotSlot, BotTeam, BotView } from "./botTypes.js";

/** What bots gather: node / spring / fishing yields, logs (a tree felled with an axe) and scrap (the wreck, fishing). */
export type Resource = "wood" | "rope" | "stone" | "food" | "water" | "log" | "scrap";
export const RESOURCES: ReadonlyArray<Resource> = ["wood", "rope", "stone", "food", "water", "log", "scrap"];

/** Food bots eat and count as the team's food supply (crab_raw is cooked first). */
const FOOD_KINDS: ReadonlyArray<ItemKind> = ["coconut", "fish_raw", "fish_cooked", "crab_cooked", "fish_golden"];
/** What counts as provisions (RAFT_STAGES[5] cooked row), plus the raw catch that becomes it at the fire. */
const COOKED_KINDS: ReadonlyArray<ItemKind> = ["fish_cooked", "crab_cooked", "fish_golden"];
const COOKABLE_KINDS: ReadonlyArray<ItemKind> = ["fish_raw", "crab_raw"];

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

/** Heavy units (logs, barrels) in the slots. */
export function heavyIn(slots: ReadonlyArray<BotSlot>): number {
  let n = 0;
  for (const s of slots) if (s.kind !== "" && ITEMS[s.kind].heavy) n += s.count;
  return n;
}

/** The heavy kind carried ("" when none). */
export function heavyKindIn(slots: ReadonlyArray<BotSlot>): InvKind {
  for (const s of slots) if (s.kind !== "" && ITEMS[s.kind].heavy) return s.kind;
  return "";
}

export function emptySlotCount(slots: ReadonlyArray<BotSlot>): number {
  let n = 0;
  for (const s of slots) if (s.kind === "") n++;
  return n;
}

/** Units of `kind` that would still fit (partial stacks, then empty slots), like shared roomFor(). */
export function roomIn(slots: ReadonlyArray<BotSlot>, kind: ItemKind): number {
  const stack = ITEMS[kind].stack;
  if (ITEMS[kind].heavy) {
    // One heavy item at a time (shared heavyRoom), in an empty slot.
    if (heavyIn(slots) >= HEAVY_MAX) return 0;
    return slots.some((s) => s.kind === "") ? 1 : 0;
  }
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
  if (kind === "wood" || kind === "rope" || kind === "stone" || kind === "water" || kind === "log" || kind === "scrap") return kind;
  if (kind === "crab_raw" || (kind !== "" && FOOD_KINDS.includes(kind))) return "food";
  return null;
}

/* ------------------------------------------------------------------ raft */

/** Every build stage is assembled: the raft can be boarded (launch window and hp permitting). */
export function raftDone(team: Pick<BotTeam, "stage">): boolean {
  return team.stage >= RAFT_LAUNCH_STAGE;
}

/** Units still missing per requirement row of the current stage. */
export function raftRemaining(team: Pick<BotTeam, "rows">): number[] {
  return team.rows.map((r) => Math.max(0, r.need - r.have));
}

/** Units still missing on the current stage (0 when it isn't open today or the raft is finished). */
export function stageMissing(team: BotTeam): number {
  if (raftDone(team) || !team.stageOpen) return 0;
  let n = 0;
  for (const r of team.rows) n += Math.max(0, r.need - r.have);
  return n;
}

/** Every material of the current stage is in: the stage waits for assembly (holding E at the raft). */
export function stageAssembling(team: BotTeam): boolean {
  if (raftDone(team) || !team.stageOpen || team.rows.length === 0) return false;
  return team.rows.every((r) => r.have >= r.need);
}

/** The current stage (open today) still takes `kind`. */
export function deliverWanted(kind: InvKind, team: BotTeam): boolean {
  if (kind === "" || raftDone(team) || !team.stageOpen) return false;
  for (const r of team.rows) if (r.kinds.includes(kind) && r.have < r.need) return true;
  return false;
}

/** Some stage from the current one on takes `kind` (worth keeping / stocking rather than spending). */
export function raftGood(kind: InvKind, team: BotTeam): boolean {
  if (kind === "") return false;
  for (const r of team.rows) if (r.kinds.includes(kind)) return true;
  for (const r of team.nextRows) if (r.kinds.includes(kind)) return true;
  return false;
}

/** Units of the current stage's needs these slots would deliver. */
export function deliverableUnits(slots: ReadonlyArray<BotSlot>, team: BotTeam): number {
  if (raftDone(team) || !team.stageOpen) return 0;
  let n = 0;
  for (const r of team.rows) {
    let got = 0;
    for (const k of r.kinds) got += countIn(slots, k);
    n += Math.min(got, Math.max(0, r.need - r.have));
  }
  return n;
}

/** Fraction 0..1 of the raft built: assembled stages plus the current one's materials (70 %) and work (30 %). */
export function raftProgress(team: BotTeam): number {
  if (raftDone(team)) return 1;
  let need = 0;
  let have = 0;
  for (const r of team.rows) {
    need += r.need;
    have += Math.min(r.have, r.need);
  }
  const mats = need > 0 ? have / need : 1;
  const work = team.raftWorkNeed > 0 ? Math.min(1, team.raftWork / team.raftWorkNeed) : 0;
  return Math.min(1, (team.stage + 0.7 * mats + 0.3 * work) / RAFT_LAUNCH_STAGE);
}

/** The raft is in trouble: the last day began and it isn't finished. Every bot then works on the current stage. */
export function raftUrgent(v: BotView): boolean {
  if (raftDone(v.team)) return false;
  return v.clock.day >= v.clock.days;
}

/* ------------------------------------------------------------------ fire */

/** Ticks until the next dawn (end of the coming / current night). */
export function ticksToDawn(c: BotClock): number {
  if (c.dayPhase === "day") return c.phaseLeft + c.duskTicks + c.nightTicks;
  if (c.dayPhase === "dusk") return c.phaseLeft + c.nightTicks;
  return c.phaseLeft;
}

/**
 * Fuel ticks still missing for the fire to keep repelling through the coming night (0 when it will): the dark
 * hours plus the FIRE_REPEL_MIN_FRACTION floor below which the ring no longer keeps monsters out, against the fuel
 * left at dusk (the day burns at FIRE_DAY_BURN_MULT).
 */
export function fireShortfall(v: BotView): number {
  const c = v.clock;
  // Rain burns it RAIN_FIRE_DRAIN_MULT times faster (the weather lasts until the next dawn).
  const rain = c.weather === "rain" ? RAIN_FIRE_DRAIN_MULT : 1;
  const dark = (c.dayPhase === "day" ? c.duskTicks + c.nightTicks : ticksToDawn(c)) * rain;
  const atDusk = c.dayPhase === "day" ? Math.max(0, v.team.fireFuel - c.phaseLeft * FIRE_DAY_BURN_MULT * rain) : v.team.fireFuel;
  const floor = Math.ceil(FIRE_REPEL_MIN_FRACTION * FIRE_FUEL_MAX_TICKS);
  return Math.max(0, Math.min(FIRE_FUEL_MAX_TICKS, dark + floor + secToTicks(5)) - atDusk);
}

/** Wood (inventory + chest) the bot can use for a recipe right now. */
export function woodAt(v: BotView): number {
  return countIn(v.self.slots, "wood") + (v.team.chest.wood ?? 0);
}

/* ---------------------------------------------------------------- tools */

/**
 * Tools a role wants to carry (Long Tide §7: Hamal axe + hammer, Balıkçı and Aşçı a rod, Bekçi a spear — and an
 * axe too, so logs don't all wait for the Hamal; the night torch comes on top, botBrain guardTorchWant).
 */
export function roleTools(role: BotRole): RecipeId[] {
  if (role === "hamal") return ["axe", "hammer"];
  if (role === "balikci") return ["rod"];
  if (role === "bekci") return ["spear", "axe"];
  if (role === "asci") return ["rod"];
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

/* ------------------------------------------------------- the team plan (BOM) */

export type ResourceCounts = Record<Resource, number>;

function zero(): ResourceCounts {
  return { wood: 0, rope: 0, stone: 0, food: 0, water: 0, log: 0, scrap: 0 };
}

/** The recipe that makes `kind` (item recipes; cooking, duel and locked recipes left out). */
const PRODUCER: Readonly<Partial<Record<ItemKind, RecipeId>>> = (() => {
  const out: Partial<Record<ItemKind, RecipeId>> = {};
  for (const r of Object.values(RECIPES)) {
    if (r.effect !== "item" || !r.out || r.duelOnly || r.locked || isCookRecipe(r.id)) continue;
    if (!out[r.out]) out[r.out] = r.id;
  }
  return out;
})();

/** The bench recipe of each tier. */
const BENCH_RECIPE: Readonly<Record<number, RecipeId>> = (() => {
  const out: Record<number, RecipeId> = {};
  for (const r of Object.values(RECIPES)) if (r.effect === "bench") out[r.tier] = r.id;
  return out;
})();

export function producerOf(kind: ItemKind): RecipeId | null {
  return PRODUCER[kind] ?? null;
}

export interface TeamPlan {
  /** Raw units still to gather / fish / salvage (wood, rope, stone, log, scrap, water, food). */
  raw: ResourceCounts;
  /** Crafts of each recipe the plan needs (benches, tools, processed materials), most urgent first in craftOrder. */
  crafts: Partial<Record<RecipeId, number>>;
  /** Recipes of `crafts` in the order they were first needed (current stage → next stage → tools → upkeep). */
  craftOrder: RecipeId[];
  /** Units short per item kind after the supply (what is missing, before it is crafted / gathered). */
  short: Partial<Record<ItemKind, number>>;
}

/** Item counts the team holds: every living teammate's pockets (self included) and the chest. */
export function teamItems(v: BotView): Map<ItemKind, number> {
  const out = new Map<ItemKind, number>();
  const add = (k: InvKind, n: number) => {
    if (k !== "" && n > 0) out.set(k, (out.get(k) ?? 0) + n);
  };
  for (const s of v.self.slots) add(s.kind, s.count);
  for (const m of v.mates) if (m.alive && !m.washed) for (const s of m.slots) add(s.kind, s.count);
  for (const [k, n] of Object.entries(v.team.chest) as [ItemKind, number][]) add(k, n);
  return out;
}

/** Bot seats (self included) with their roles and slots. */
function botSeats(v: BotView): { role: BotRole; slots: ReadonlyArray<BotSlot> }[] {
  const out: { role: BotRole; slots: ReadonlyArray<BotSlot> }[] = [{ role: v.self.role, slots: v.self.slots }];
  for (const m of v.mates) if (m.driven && m.alive && !m.washed && m.role !== "") out.push({ role: m.role, slots: m.slots });
  return out;
}

/**
 * The team's bill of materials (see the file header). Pure; cheap (a handful of kinds, recursion depth ≤ 3).
 */
export function teamPlan(v: BotView): TeamPlan {
  const supply = teamItems(v);
  const plan: TeamPlan = { raw: zero(), crafts: {}, craftOrder: [], short: {} };
  const benchTier = v.team.benchTier;
  const benchNeeded = new Set<number>();
  const take = (kind: ItemKind, n: number): number => {
    const have = supply.get(kind) ?? 0;
    const used = Math.min(have, n);
    if (used > 0) supply.set(kind, have - used);
    return n - used;
  };
  const addCraft = (id: RecipeId, n: number) => {
    if (n <= 0) return;
    if (plan.crafts[id] === undefined) plan.craftOrder.push(id);
    plan.crafts[id] = (plan.crafts[id] ?? 0) + n;
  };
  const requireBench = (tier: number, depth: number) => {
    for (let t = 1; t <= tier; t++) {
      if (benchTier >= t || benchNeeded.has(t)) continue;
      benchNeeded.add(t);
      const id = BENCH_RECIPE[t];
      if (!id) continue;
      addCraft(id, 1);
      for (const [k, c] of Object.entries(RECIPES[id].cost) as [ItemKind, number][]) need(k, c, depth + 1);
    }
  };
  const need = (kind: ItemKind, n: number, depth = 0): void => {
    if (n <= 0) return;
    const short = take(kind, n);
    if (short <= 0) return;
    plan.short[kind] = (plan.short[kind] ?? 0) + short;
    const rid = depth < 4 ? PRODUCER[kind] : undefined;
    if (rid) {
      const r = RECIPES[rid];
      const crafts = Math.ceil(short / Math.max(1, r.outCount));
      addCraft(rid, crafts);
      requireBench(r.bench, depth);
      for (const [k, c] of Object.entries(r.cost) as [ItemKind, number][]) need(k, c * crafts, depth + 1);
      const spare = crafts * r.outCount - short;
      if (spare > 0) supply.set(kind, (supply.get(kind) ?? 0) + spare);
      return;
    }
    const res = resourceOf(kind);
    if (res) plan.raw[res] += short;
  };
  /** A raft row: any of its kinds (the cooked row also takes the raw catch the fire will cook). */
  const needRow = (row: BotRaftRow, n: number) => {
    let left = n;
    if (row.kinds.includes("fish_cooked")) {
      for (const k of [...COOKED_KINDS, ...COOKABLE_KINDS]) left = left > 0 ? take(k, left) : 0;
      if (left > 0) {
        plan.short.fish_cooked = (plan.short.fish_cooked ?? 0) + left;
        plan.raw.food += left;
      }
      return;
    }
    for (const k of row.kinds.slice(1)) left = left > 0 ? take(k, left) : 0;
    need(row.item, left);
  };
  // 1. The current stage (open or still locked: then it is prestock), 2. the next stage.
  if (!raftDone(v.team)) {
    for (const r of v.team.rows) needRow(r, Math.max(0, r.need - r.have));
    for (const r of v.team.nextRows) needRow(r, r.need);
  }
  // 3. Role tools of every bot seat.
  for (const seat of botSeats(v)) {
    for (const tool of missingTools(seat.role, seat.slots)) {
      const out = RECIPES[tool].out;
      if (out) need(out, 1);
    }
  }
  // 4. A raft repair: planks for the hp below RAFT_REPAIR_TARGET (the launch needs RAFT_HP_BOARD).
  if (v.team.stage >= 1 && v.team.raftHp < RAFT_REPAIR_TARGET) need("raft_part", Math.ceil((RAFT_REPAIR_TARGET - v.team.raftHp) / RAFT_REPAIR_PLANK_HP));
  // 5. Fuel for the coming night, the guard's torch, a larder of food and water.
  // Fuel: what the coming night still lacks, plus a reserve log's worth for the night after (the day burns half).
  need("wood", Math.ceil(fireShortfall(v) / FIRE_WOOD_FUEL_TICKS) + FUEL_RESERVE_WOOD);
  need("rope", 1);
  const members = 1 + v.mates.filter((m) => m.alive && !m.washed).length;
  let food = members;
  for (const k of FOOD_KINDS) food = food > 0 ? take(k, food) : 0;
  plan.raw.food += food;
  need("water", Math.ceil(members / 2));
  return plan;
}

/** Raw wants of the team plan (kept for callers that only need the gather side). */
export function teamWants(v: BotView): ResourceCounts {
  return teamPlan(v).raw;
}

/** Wood kept in reserve for the fire on top of the coming night's shortfall. */
export const FUEL_RESERVE_WOOD = 3;

/** Raft hp the bots repair up to (above RAFT_HP_BOARD so a launch wave bite doesn't ground the raft). */
export const RAFT_REPAIR_TARGET = 80;
