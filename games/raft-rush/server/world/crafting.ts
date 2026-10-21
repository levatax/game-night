// Campfire workbench recipes and the shared camp chest (game4.md §7, docs/ARCHITECTURE.md §4.5). Owner:
// server-world.
//
// craft(p, recipe): within CRAFT_RANGE (+RANGE_SLACK) of the team fire, the fire lit (fuel > 0) except for the
// "fuel" recipe itself, not locked (coconut_ball needs team.ballRecipe), not duel-only in coop. Ingredients come
// from the inventory first, then the chest; the exact counts are consumed. Output: into the inventory, overflow
// dropped at the feet (`dropped`). fuel: +FIRE_WOOD_FUEL_TICKS; cook_kraken: every teammate +KRAKEN_TEAM_FOOD
// hunger. Rejects (`reject` action "craft"): missing, fireOut, tooFar, locked, full (fire already full), dead.
// chest(p, msg): ChestMsg put (the active slot, or `slot` — then a given `kind` must still be in it) / take /
// putAll within CHEST_RANGE (+RANGE_SLACK); `chestChanged` events. Rejects (action "chest"): tooFar, empty, full,
// dead. A malformed message (bad op, out-of-range slot) is ignored. Monkeys use steal / restock (WorldContext).

import {
  CHEST_RANGE,
  CRAFT_RANGE,
  FIRE_FUEL_MAX_TICKS,
  FIRE_WOOD_FUEL_TICKS,
  KRAKEN_TEAM_FOOD,
  SHELTER_RADIUS,
} from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { isItemKind, ITEMS, RECIPES, type RecipeDef } from "../../shared/items.js";
import type { ChestMsg } from "../../shared/protocol.js";
import { countOf, roomFor, slotCount, slotKind, SLOTS } from "../../shared/rules/inventory.js";
import { canAct } from "../../shared/sim/player.js";
import type { ItemKind, RecipeId } from "../../shared/types.js";
import type { PlayerState, TeamState } from "./context.js";
import type { WorldCore } from "./core.js";
import { dist2, point, posOf, RANGE_SLACK } from "./rules.js";

/** Item categories `putAll` stores (tools, raft parts, placeables and loot stay with you). */
const PUT_ALL_CATEGORIES: ReadonlySet<string> = new Set(["material", "food", "water"]);
/** Duel hut hp (game4.md §13: destroyed in 3 hits). */
const HUT_HP = 3;

export class CraftSystem {
  constructor(private readonly core: WorldCore) {}

  /* ---------------------------------------------------------------- recipes */

  /** CraftMsg (humans and bots). True when crafted. */
  craft(p: PlayerState, recipeId: RecipeId): boolean {
    const core = this.core;
    if (!this.active()) return false;
    const recipe: RecipeDef | undefined = RECIPES[recipeId];
    if (!recipe) return false;
    if (!canAct(p)) return this.fail(p, "dead");
    const site = core.site(p.team);
    const teamIdx = site.team;
    const team = core.team(teamIdx);
    if (recipe.duelOnly && core.state.layout !== "duel") return this.fail(p, "locked");
    if (recipe.locked && !team.ballRecipe) return this.fail(p, "locked");
    const reach = CRAFT_RANGE + RANGE_SLACK;
    if (dist2(p.x, p.z, site.campfire.x, site.campfire.z) > reach * reach) return this.fail(p, "tooFar");
    if (recipe.effect === "fuel") {
      if (team.fireFuel >= FIRE_FUEL_MAX_TICKS) return this.fail(p, "full");
    } else if (team.fireFuel <= 0) {
      return this.fail(p, "fireOut");
    }
    if (!this.affordable(p, team, recipe)) return this.fail(p, "missing");
    this.consume(p, team, teamIdx, recipe);

    let dropped = false;
    if (recipe.effect === "fuel") {
      core.addFireFuel(teamIdx, FIRE_WOOD_FUEL_TICKS, p.id, "wood");
    } else if (recipe.effect === "team") {
      for (const q of core.alivePlayers(teamIdx)) {
        if (q.downed) continue;
        const gained = core.survival.feed(q, KRAKEN_TEAM_FOOD, 0, 0);
        core.emit({ type: "eat", tick: core.tick(), playerId: q.id, kind: "kraken", hunger: gained.hunger, thirst: 0, pos: posOf(q) });
      }
    } else if (recipe.id === "hut" || recipe.id === "canoe") {
      dropped = !this.buildDuelStructure(p, team, recipe.id);
    } else if (recipe.out) {
      dropped = core.bag.give(p, recipe.out, recipe.outCount).added < recipe.outCount;
    }
    p.stats.crafted = Math.min(65535, p.stats.crafted + 1);
    core.emit({ type: "crafted", tick: core.tick(), playerId: p.id, recipe: recipe.id, item: recipe.out, dropped, pos: posOf(p) });
    return true;
  }

  /** Ingredients available in the inventory + the chest. */
  affordable(p: PlayerState, team: TeamState, recipe: RecipeDef): boolean {
    for (const [kind, n] of Object.entries(recipe.cost) as [ItemKind, number][]) {
      if (countOf(p, kind) + (team.chest.get(kind) ?? 0) < n) return false;
    }
    return true;
  }

  /** Take the exact ingredient counts: inventory first, then the chest (chestChanged "take" for the chest part). */
  private consume(p: PlayerState, team: TeamState, teamIdx: number, recipe: RecipeDef): void {
    const fromChest: { kind: ItemKind; count: number }[] = [];
    for (const [kind, n] of Object.entries(recipe.cost) as [ItemKind, number][]) {
      const left = n - this.core.bag.take(p, kind, n);
      if (left > 0) {
        this.takeFromChest(team, kind, left);
        fromChest.push({ kind, count: left });
      }
    }
    if (fromChest.length > 0) this.core.emit({ type: "chestChanged", tick: this.core.tick(), team: teamIdx, playerId: p.id, op: "take", items: fromChest });
  }

  /** Duel: the hut goes up next to the campfire, the canoe by the raft slip. */
  private buildDuelStructure(p: PlayerState, team: TeamState, kind: "hut" | "canoe"): boolean {
    const core = this.core;
    const site = core.site(p.team);
    const at = kind === "hut" ? { x: site.campfire.x + SHELTER_RADIUS * 0.5, z: site.campfire.z } : { x: site.raft.x + 2.5, z: site.raft.z };
    const s = core.structures.add(kind, point(at.x, heightAt(core.island.grid, at.x, at.z), at.z), 0, site.team, p.id, kind === "hut" ? HUT_HP : 1, 0, 0);
    if (s && kind === "hut") team.hutHp = HUT_HP;
    return s !== null;
  }

  private fail(p: PlayerState, reason: string): false {
    this.core.reject(p, "craft", reason);
    return false;
  }

  /* ------------------------------------------------------------------ chest */

  /** ChestMsg (humans and bots). True when something moved. */
  chest(p: PlayerState, msg: ChestMsg): boolean {
    const core = this.core;
    if (!this.active()) return false;
    if (!msg || (msg.op !== "put" && msg.op !== "take" && msg.op !== "putAll")) return false;
    if (msg.op === "put" && msg.slot !== undefined && !isSlot(msg.slot)) return false;
    if (!canAct(p)) return this.chestFail(p, "dead");
    const site = core.site(p.team);
    const teamIdx = site.team;
    const team = core.team(teamIdx);
    const reach = CHEST_RANGE + RANGE_SLACK;
    if (dist2(p.x, p.z, site.chest.x, site.chest.z) > reach * reach) return this.chestFail(p, "tooFar");
    const wanted = countArg(msg.count);

    if (msg.op === "put") {
      const slot = msg.slot ?? p.activeSlot;
      const kind = slotKind(p, slot);
      if (kind === "") return this.chestFail(p, "empty");
      // A put naming its pocket also names what the client saw there: a pocket that changed on the way is refused.
      if (msg.slot !== undefined && msg.kind !== undefined && msg.kind !== kind) return this.chestFail(p, "empty");
      const n = core.bag.takeFromSlot(p, slot, wanted ?? slotCount(p, slot));
      if (n <= 0) return this.chestFail(p, "empty");
      this.addToChest(team, kind, n);
      core.emit({ type: "chestChanged", tick: core.tick(), team: teamIdx, playerId: p.id, op: "put", items: [{ kind, count: n }] });
      return true;
    }

    if (msg.op === "take") {
      const kind = msg.kind;
      if (!isItemKind(kind) || (team.chest.get(kind) ?? 0) <= 0) return this.chestFail(p, "empty");
      const room = roomFor(p, kind);
      if (room <= 0) return this.chestFail(p, "full");
      const n = Math.min(room, team.chest.get(kind) ?? 0, wanted ?? room);
      const added = core.bag.stow(p, kind, n);
      if (added <= 0) return this.chestFail(p, "full");
      this.takeFromChest(team, kind, added);
      core.emit({ type: "chestChanged", tick: core.tick(), team: teamIdx, playerId: p.id, op: "take", items: [{ kind, count: added }] });
      return true;
    }

    // putAll: every material / food / water stack.
    const items: { kind: ItemKind; count: number }[] = [];
    for (let s = 0; s < SLOTS; s++) {
      const kind = slotKind(p, s);
      if (kind === "" || !PUT_ALL_CATEGORIES.has(ITEMS[kind].category)) continue;
      const n = core.bag.takeFromSlot(p, s, slotCount(p, s));
      if (n <= 0) continue;
      this.addToChest(team, kind, n);
      const same = items.find((it) => it.kind === kind);
      if (same) same.count += n;
      else items.push({ kind, count: n });
    }
    if (items.length === 0) return this.chestFail(p, "empty");
    core.emit({ type: "chestChanged", tick: core.tick(), team: teamIdx, playerId: p.id, op: "put", items });
    return true;
  }

  private chestFail(p: PlayerState, reason: string): false {
    this.core.reject(p, "chest", reason);
    return false;
  }

  /** WorldContext.stealFromChest: one unit of `kind` (or a random stocked kind). Emits chestChanged "steal". */
  steal(teamIdx: number, kind?: ItemKind): ItemKind | null {
    const core = this.core;
    const team = core.team(teamIdx);
    let pick: ItemKind | null = null;
    if (kind !== undefined) {
      if ((team.chest.get(kind) ?? 0) > 0) pick = kind;
    } else {
      const stocked: ItemKind[] = [];
      team.chest.forEach((n, k) => {
        if (n > 0 && isItemKind(k)) stocked.push(k);
      });
      stocked.sort();
      if (stocked.length > 0) pick = stocked[Math.min(stocked.length - 1, Math.floor(core.rng() * stocked.length))]!;
    }
    if (!pick) return null;
    this.takeFromChest(team, pick, 1);
    core.emit({ type: "chestChanged", tick: core.tick(), team: teamIdx, playerId: "", op: "steal", items: [{ kind: pick, count: 1 }] });
    return pick;
  }

  /** WorldContext.returnToChest. Emits chestChanged "return". */
  restock(teamIdx: number, kind: ItemKind, count: number): void {
    const n = Math.max(0, Math.floor(count));
    if (n <= 0) return;
    this.addToChest(this.core.team(teamIdx), kind, n);
    this.core.emit({ type: "chestChanged", tick: this.core.tick(), team: teamIdx, playerId: "", op: "return", items: [{ kind, count: n }] });
  }

  /** Raw chest write (no event): match start fills. */
  addToChest(team: TeamState, kind: ItemKind, count: number): void {
    if (count <= 0) return;
    team.chest.set(kind, Math.min(65535, (team.chest.get(kind) ?? 0) + count));
  }

  private takeFromChest(team: TeamState, kind: ItemKind, count: number): void {
    const left = (team.chest.get(kind) ?? 0) - count;
    if (left > 0) team.chest.set(kind, left);
    else team.chest.delete(kind);
  }

  /** Crafting and the chest work during the landing and play. */
  private active(): boolean {
    const phase = this.core.state.phase;
    return phase === "landing" || phase === "playing";
  }
}

/** A ChestMsg put `slot`: an integer pocket index 0..SLOTS-1. */
function isSlot(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v < SLOTS;
}

/** A ChestMsg count: a positive integer, or undefined for "all / as many as fit". */
function countArg(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 1 ? Math.floor(v) : undefined;
}
