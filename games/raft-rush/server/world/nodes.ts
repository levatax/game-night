// Resource nodes: gathering units, palm shaking, regrowth (game4.md §6, docs/ARCHITECTURE.md §2.2–2.3).
// Owner: server-world.
//
// Node positions / kinds come from the IslandDef; the live amount is state.nodes[i]. A gather channel completes
// one unit at a time (wood / stone / rope into the inventory or dropped when it doesn't fit; berries are eaten
// on the spot, +BERRY_FOOD). Palms are shaken with LMB (one coconut, an axe in hand: all of them) or knocked by a
// thrown coconut / stone; coconuts fall from the crown as loose projectiles. Emptied palms regrow to full after
// PALM_REGROW_TICKS, emptied berry bushes after BERRY_REGROW_TICKS; trees, rocks and rope bushes don't.

import {
  BERRY_FOOD,
  BERRY_REGROW_TICKS,
  DDA_RESOURCE_MULT,
  COAST_WOOD_BY_BUCKET,
  RESOURCE_CACHE_AT,
  RESOURCE_CACHE_MAX,
  RESOURCE_MIN_UNITS,
  RESOURCE_RAMP,
  COCONUT_DROP_HEIGHT,
  EAT_HEAL,
  INTERACT_CONE_COS,
  MVP_POINTS,
  NODE_AMOUNT,
  PALM_HIT_RANGE,
  PALM_REGROW_TICKS,
  PALM_THROW_DROPS,
  PALM_TRUNK_RADIUS,
  type Timings,
} from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import type { NodeDef } from "../../shared/island/types.js";
import { raftCost } from "../../shared/items.js";
import { matchTicks, type ClockInfo } from "../../shared/rules/schedule.js";
import { gatherYield } from "../../shared/rules/interact.js";
import type { ItemKind } from "../../shared/types.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";
import { dist, point } from "./rules.js";

/** The share of the island's nodes still on offer at match progress `p` (0..1). Pure, unit-tested. */
export function resourceShareAt(p: number, ddaMult = 1): number {
  let share = RESOURCE_RAMP[0]!.share;
  for (const step of RESOURCE_RAMP) if (p >= step.from) share = step.share;
  return Math.max(0, share * ddaMult);
}

/** Match progress 0..1 on the day clock (0 before the clock exists). `stormLeft` counts down the whole match. */
function progressOf(clock: ClockInfo | null, timings: Timings): number {
  if (!clock) return 0;
  return Math.min(1, Math.max(0, 1 - clock.stormLeft / Math.max(1, matchTicks(timings))));
}

/** Fallen coconuts drift a little toward whoever knocked them loose. */
const COCONUT_SCATTER_SPEED = 0.9;
/** They appear just outside the trunk so they don't spawn inside its collider. */
const COCONUT_TRUNK_CLEARANCE = 0.35;

export class NodeSystem {
  /** Node index → tick at which it regrows to full. */
  private readonly regrowAt = new Map<number, number>();
  /** Last ramp bucket applied (-1 = none yet this match). */
  private bucket = -1;
  /** Current node share of the island (RESOURCE_RAMP × the visible DDA level). */
  private share = 1;
  /** The visible DDA level's resource multiplier (set by RaftWorld from the director). */
  private ddaMult: number = DDA_RESOURCE_MULT.even;
  /** Supply caches already dropped this match, keyed `team:threshold` (two per team: 45 % and 78 %). */
  private readonly cached = new Set<string>();

  constructor(private readonly core: WorldCore) {}

  /** RaftWorld: the visible DDA level's resource multiplier (help keeps a little more on the island). */
  setDda(level: number, assistSteps = 0): void {
    const next = level > 0
      ? assistSteps >= 2 ? DDA_RESOURCE_MULT.help2 : DDA_RESOURCE_MULT.help
      : level < 0
        ? DDA_RESOURCE_MULT.hard
        : DDA_RESOURCE_MULT.even;
    if (next === this.ddaMult) return;
    this.ddaMult = next;
    this.applyShare();
  }

  /** Match reset: full island, no cache, ramp bucket forgotten. */
  resetRamp(): void {
    this.bucket = -1;
    this.share = 1;
    this.ddaMult = DDA_RESOURCE_MULT.even;
    this.cached.clear();
  }

  /** The current share of the island's nodes (0..1). */
  currentShare(): number {
    return this.share;
  }

  /** Cap every node at `share` of its island amount (never raises a harvested node). */
  private applyShare(): void {
    const nodes = this.core.state.nodes;
    const defs = this.core.island.nodes;
    for (let i = 0; i < defs.length; i++) {
      const def = defs[i]!;
      if (def.amount <= 0) continue;
      const cap = Math.max(RESOURCE_MIN_UNITS, Math.ceil(def.amount * this.share));
      if (nodes[i]! > cap) nodes[i] = cap;
    }
  }

  /** The amount an emptied palm / bush regrows to under the current share. */
  private regrowAmount(base: number): number {
    return Math.max(RESOURCE_MIN_UNITS, Math.round(base * this.share));
  }

  /** Live amount of node `i`. */
  amount(i: number): number {
    return this.core.state.nodes[i] ?? 0;
  }

  /** Take up to `n` units from node `i` (schedules regrowth when a palm / berry bush empties). Returns units taken. */
  take(i: number, n: number): number {
    const nodes = this.core.state.nodes;
    const have = nodes[i] ?? 0;
    const taken = Math.max(0, Math.min(have, n));
    if (taken === 0) return 0;
    nodes[i] = have - taken;
    if (have - taken === 0) {
      const def = this.core.island.nodes[i];
      if (def?.kind === "palm") this.regrowAt.set(i, this.core.tick() + PALM_REGROW_TICKS);
      else if (def?.kind === "bush" && def.yield === "berry") this.regrowAt.set(i, this.core.tick() + BERRY_REGROW_TICKS);
    }
    return taken;
  }

  /** One finished gather unit of `node` for `p`: item / berry, stats, MVP, `gather` event. */
  gatherUnit(p: PlayerState, node: NodeDef): void {
    const core = this.core;
    const kind = gatherYield(node);
    if (kind === null || kind === "coconut") return;
    if (this.take(node.i, 1) === 0) return;
    let dropped = false;
    let eaten = false;
    if (kind === "berry") {
      core.survival.feed(p, BERRY_FOOD, 0, EAT_HEAL);
      p.stats.eaten = Math.min(65535, p.stats.eaten + 1);
      eaten = true;
    } else {
      dropped = core.bag.give(p, kind, 1).added < 1;
    }
    p.stats.gathered = Math.min(65535, p.stats.gathered + 1);
    core.addScore(p, MVP_POINTS.gather);
    core.emit({
      type: "gather",
      tick: core.tick(),
      playerId: p.id,
      node: node.i,
      kind,
      count: 1,
      depleted: this.amount(node.i) === 0,
      dropped,
      eaten,
      pos: point(node.x, node.y + 1, node.z),
    });
  }

  /** The palm `p` is looking at within PALM_HIT_RANGE (any amount: an empty one is a whiff), or null. */
  palmInReach(p: PlayerState): NodeDef | null {
    const fx = -Math.sin(p.yaw);
    const fz = -Math.cos(p.yaw);
    let best: NodeDef | null = null;
    let bestCos = -2;
    for (const n of this.core.island.nodes) {
      if (n.kind !== "palm") continue;
      const dx = n.x - p.x;
      const dz = n.z - p.z;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > PALM_HIT_RANGE + n.radius) continue;
      const cos = d > 1e-6 ? (dx * fx + dz * fz) / d : 1;
      if (d > n.radius + 0.6 && cos < INTERACT_CONE_COS) continue;
      if (cos > bestCos) {
        best = n;
        bestCos = cos;
      }
    }
    return best;
  }

  /** LMB on a palm: one coconut (axe: all of them) falls; an empty palm is a whiff. */
  shakePalm(p: PlayerState, palm: NodeDef, all: boolean): void {
    const have = this.amount(palm.i);
    if (have <= 0) {
      this.core.emit({ type: "use", tick: this.core.tick(), playerId: p.id, what: "whiffPalm", pos: point(palm.x, palm.y + 1.5, palm.z) });
      return;
    }
    this.dropCoconuts(palm, all ? have : 1, p.id, p.x, p.z);
  }

  /** A thrown coconut / stone hit palm `i`'s trunk: PALM_THROW_DROPS coconuts fall (if it has any). */
  palmHit(i: number, byId: string): void {
    const palm = this.core.island.nodes[i];
    if (!palm || palm.kind !== "palm" || this.amount(i) <= 0) return;
    const by = byId ? this.core.state.players.get(byId) : undefined;
    this.dropCoconuts(palm, PALM_THROW_DROPS, byId, by?.x ?? palm.x + 1, by?.z ?? palm.z);
  }

  private dropCoconuts(palm: NodeDef, n: number, byId: string, towardX: number, towardZ: number): void {
    const core = this.core;
    const count = this.take(palm.i, n);
    if (count === 0) return;
    const d = dist(towardX, towardZ, palm.x, palm.z);
    const ux = d > 1e-6 ? (towardX - palm.x) / d : 1;
    const uz = d > 1e-6 ? (towardZ - palm.z) / d : 0;
    const off = Math.max(palm.radius, PALM_TRUNK_RADIUS) + COCONUT_TRUNK_CLEARANCE;
    const ids: string[] = [];
    for (let k = 0; k < count; k++) {
      // Fan the coconuts out sideways around the direction toward the shaker.
      const side = (k - (count - 1) / 2) * 0.45;
      const x = palm.x + ux * off - uz * side;
      const z = palm.z + uz * off + ux * side;
      const jitter = (core.rng() - 0.5) * 0.4;
      const vel = point((ux + -uz * jitter) * COCONUT_SCATTER_SPEED, 0, (uz + ux * jitter) * COCONUT_SCATTER_SPEED);
      const b = core.spawnProjectile("coconut", point(x, palm.y + COCONUT_DROP_HEIGHT, z), vel, { state: "loose" });
      if (b) ids.push(b.id);
    }
    core.emit({ type: "palmShake", tick: core.tick(), playerId: byId, node: palm.i, projectileIds: ids, pos: point(palm.x, palm.y + COCONUT_DROP_HEIGHT, palm.z) });
  }

  /**
   * RaftWorld step 5: the scarcity ramp (100 → 75 → 50 → 35 % of the island as the match runs out) plus the
   * once-per-match anti-soft-lock supply cache, then regrowth of emptied palms / berry bushes whose timer is due.
   */
  step(clock: ClockInfo | null = null): void {
    if (clock) this.ramp(clock);
    if (this.regrowAt.size === 0) return;
    const now = this.core.tick();
    for (const [i, due] of this.regrowAt) {
      if (now < due) continue;
      this.regrowAt.delete(i);
      const def = this.core.island.nodes[i];
      if (def) this.core.state.nodes[i] = this.regrowAmount(def.kind === "palm" ? NODE_AMOUNT.palm : def.amount > 0 ? def.amount : NODE_AMOUNT.bush);
    }
  }

  /** Step the economy ramp on a bucket change and drop the guaranteed caches at 45 % / 78 %. */
  private ramp(clock: ClockInfo): void {
    const progress = progressOf(clock, this.core.timings);
    const share = resourceShareAt(progress, this.ddaMult);
    let bucket = 0;
    for (let i = 0; i < RESOURCE_RAMP.length; i++) if (progress >= RESOURCE_RAMP[i]!.from) bucket = i;
    if (bucket !== this.bucket) {
      this.bucket = bucket;
      this.share = share;
      this.applyShare();
    }
    for (const at of RESOURCE_CACHE_AT) if (progress >= at) this.dropCache(progress, at, bucket);
  }

  /**
   * Anti-soft-lock cache: exactly what the raft still needs, once per team, on the beach by the wreck. If the
   * team already has the materials the cache is skipped (no free lunch), and its total is capped.
   */
  private dropCache(progressForCache: number, threshold: number, bucket: number): void {
    const core = this.core;
    core.state.teams.forEach((team) => {
      const key = `${team.index}:${threshold}`;
      if (this.cached.has(key)) return;
      this.cached.add(key);
      const cost = raftCost(team.seats, core.state.fast);
      // Provisions are carried by real item kinds: a coconut counts as food, a gourd as water.
      const need: ReadonlyArray<{ item: ItemKind; n: number }> = [
        { item: "wood", n: Math.max(0, cost.hullWood - team.hullWood) + Math.max(0, cost.mastWood - team.mastWood) },
        { item: "rope", n: Math.max(0, cost.mastRope - team.mastRope) },
        { item: "coconut", n: Math.max(0, cost.food - team.food) },
        { item: "water", n: Math.max(0, cost.water - team.water) },
      ];
      const needWood = need.find((r) => r.item === "wood")?.n ?? 0;
      const needRope = need.find((r) => r.item === "rope")?.n ?? 0;
      // Soft-lock guard only: the cache lands when the island can no longer pay for the raft, not as a gift for
      // a team that is merely behind. Food / water are never a soft lock (fishing and the spring always exist).
      const nodeDefs = core.island.nodes;
      const nodes = core.state.nodes;
      let woodLeft = 0;
      let ropeLeft = 0;
      for (let i = 0; i < nodeDefs.length; i++) {
        const def = nodeDefs[i]!;
        if (def.kind === "tree") woodLeft += nodes[i] ?? 0;
        else if (def.kind === "bush" && def.yield === "rope") ropeLeft += nodes[i] ?? 0;
      }
      const chestWood = team.chest.get("wood") ?? 0;
      const chestRope = team.chest.get("rope") ?? 0;
      const short = needWood > woodLeft + chestWood || needRope > ropeLeft + chestRope;
      // Guaranteed caches (v4b): both land whatever the island still holds, sized by the coast-wood table; wood is
      // the resource the raft cannot do without, rope only rides along when the team is short of it.
      const coastWood = COAST_WOOD_BY_BUCKET[Math.min(bucket, COAST_WOOD_BY_BUCKET.length - 1)] ?? 0;
      const woodQuota = Math.max(short ? needWood : 0, coastWood);
      let left = RESOURCE_CACHE_MAX;
      const items: Array<{ item: ItemKind; n: number }> = [];
      for (const { item, n: wantRaw } of need) {
        const want = item === "wood" ? Math.max(wantRaw, woodQuota) : wantRaw;
        const n = Math.min(left, want);
        if (n > 0) items.push({ item, n });
        left -= n;
      }
      if (left === RESOURCE_CACHE_MAX) return;
      const site = core.site(team.index);
      const wreckY = heightAt(core.island.grid, site.wreck.x, site.wreck.z);
      const made: Record<string, number> = {};
      let k = 0;
      for (const { item, n } of items) {
        made[item] = n;
        for (let i = 0; i < n; i++) {
          const a = (k++ * 0.9) % (Math.PI * 2);
          const x = site.wreck.x + Math.cos(a) * (1.2 + 0.25 * k);
          const z = site.wreck.z + Math.sin(a) * (1.2 + 0.25 * k);
          core.spawnProjectile(item, point(x, wreckY + 0.6, z), point(0, 0, 0), { state: "loose" });
        }
      }
      core.emit({ type: "supplyCache", tick: core.tick(), team: team.index, pos: point(site.wreck.x, wreckY, site.wreck.z), items: made });
    });
  }

  /** Every node back to its initial amount, regrowth timers forgotten. */
  reset(): void {
    this.resetRamp();
    this.regrowAt.clear();
    const nodes = this.core.state.nodes;
    const defs = this.core.island.nodes;
    if (nodes.length !== defs.length) {
      nodes.clear();
      for (const n of defs) nodes.push(n.amount);
      return;
    }
    for (let i = 0; i < defs.length; i++) if (nodes[i] !== defs[i]!.amount) nodes[i] = defs[i]!.amount;
  }
}
