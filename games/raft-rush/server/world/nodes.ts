// Resource nodes: gathering units, palm shaking, regrowth (game4.md §6, docs/ARCHITECTURE.md §2.2–2.3).
// Owner: server-world.
//
// Node positions / kinds come from the IslandDef; the live amount is state.nodes[i]. A gather channel completes
// one unit at a time (wood / stone / rope into the inventory or dropped when it doesn't fit; berries are eaten
// on the spot, +BERRY_FOOD). Taking a tree's LAST unit with an axe in any slot fells it: a heavy `log` comes to
// rest at its foot (gather event `felled`); by hand a tree just runs out. Palms are shaken with LMB (one coconut,
// an axe in hand: all of them) or knocked by a thrown coconut / stone; coconuts fall from the crown as loose
// projectiles. Emptied palms regrow to full after PALM_REGROW_TICKS, berry bushes after BERRY_REGROW_TICKS, rope
// bushes after ROPE_REGROW_TICKS; trees and rocks don't.

import {
  BERRY_FOOD,
  BERRY_REGROW_TICKS,
  COCONUT_DROP_HEIGHT,
  EAT_HEAL,
  INTERACT_CONE_COS,
  MVP_POINTS,
  NODE_AMOUNT,
  PALM_HIT_RANGE,
  PALM_REGROW_TICKS,
  PALM_THROW_DROPS,
  PALM_TRUNK_RADIUS,
  ROPE_REGROW_TICKS,
  TREE_TRUNK_RADIUS,
} from "../../shared/constants.js";
import type { NodeDef } from "../../shared/island/types.js";
import { gatherYield } from "../../shared/rules/interact.js";
import { countOf } from "../../shared/rules/inventory.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";
import { dist, point } from "./rules.js";

/** Fallen coconuts drift a little toward whoever knocked them loose. */
const COCONUT_SCATTER_SPEED = 0.9;
/** They appear just outside the trunk so they don't spawn inside its collider. */
const COCONUT_TRUNK_CLEARANCE = 0.35;
/** A felled tree's log rests this far out from the trunk, toward the feller. */
const LOG_TRUNK_CLEARANCE = 0.7;

export class NodeSystem {
  /** Node index → tick at which it regrows to full. */
  private readonly regrowAt = new Map<number, number>();

  constructor(private readonly core: WorldCore) {}

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
      else if (def?.kind === "bush" && def.yield === "rope") this.regrowAt.set(i, this.core.tick() + ROPE_REGROW_TICKS);
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
    const depleted = this.amount(node.i) === 0;
    const felled = depleted && node.kind === "tree" && countOf(p, "axe") > 0 ? this.dropLog(p, node) : "";
    core.emit({
      type: "gather",
      tick: core.tick(),
      playerId: p.id,
      node: node.i,
      kind,
      count: 1,
      depleted,
      dropped,
      eaten,
      pos: point(node.x, node.y + 1, node.z),
      ...(felled ? { felled } : {}),
    });
  }

  /** A tree felled with an axe: one log comes to rest at its foot, toward the feller. Returns its id ("" if none). */
  private dropLog(p: PlayerState, tree: NodeDef): string {
    const d = dist(p.x, p.z, tree.x, tree.z);
    const ux = d > 1e-6 ? (p.x - tree.x) / d : 1;
    const uz = d > 1e-6 ? (p.z - tree.z) / d : 0;
    const off = Math.max(tree.radius, TREE_TRUNK_RADIUS) + LOG_TRUNK_CLEARANCE;
    const b = this.core.spawnProjectile("log", point(tree.x + ux * off, tree.y + 0.3, tree.z + uz * off), point(0, 0, 0), { state: "loose" });
    return b ? b.id : "";
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

  /** Regrow emptied palms / berry bushes whose timer is due. */
  step(): void {
    if (this.regrowAt.size === 0) return;
    const now = this.core.tick();
    for (const [i, due] of this.regrowAt) {
      if (now < due) continue;
      this.regrowAt.delete(i);
      const def = this.core.island.nodes[i];
      if (def) this.core.state.nodes[i] = def.kind === "palm" ? NODE_AMOUNT.palm : def.amount > 0 ? def.amount : NODE_AMOUNT.bush;
    }
  }

  /** Every node back to its initial amount, regrowth timers forgotten. */
  reset(): void {
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
