// Inventory operations of the server world: the 4-slot helpers of shared/rules/inventory.ts plus the item
// timers that live on the player (torch burn, puffer fuse) and overflow drops. Owner: server-world.
//
// Every server-side inventory change goes through Bag so the timers stay right:
// - torchTicks: burn of the torch you carry. The first torch you get starts at TORCH_BURN_TICKS; spares wait
//   (when the burning one runs out, the next one starts fresh); no torch → 0.
// - fuseTicks: the puffer fuse starts at PUFFER_FUSE_TICKS when a puffer enters an inventory that had none, and
//   clears when the last puffer leaves (thrown, tossed, put in the chest, exploded).
// A full inventory never destroys gathered / crafted / caught items: they drop at the feet as resting pickups
// (docs/ARCHITECTURE.md §2.2).

import { PUFFER_FUSE_TICKS, TORCH_BURN_TICKS, WATER_Y } from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { ITEMS } from "../../shared/items.js";
import { addItem, clearInventory, countOf, removeFromSlot, removeItem } from "../../shared/rules/inventory.js";
import type { ItemKind } from "../../shared/types.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";

/** Golden-angle spiral for overflow drops (cosmetic spread around the feet). */
const DROP_ANGLE = 2.39996;
const DROP_RADIUS = 0.35;
const DROP_RADIUS_STEP = 0.12;

export interface GiveResult {
  /** Units that went into the inventory. */
  added: number;
  /** Projectile ids of the units dropped at the feet. */
  dropped: string[];
}

export class Bag {
  constructor(private readonly core: WorldCore) {}

  /** Add `count` units of `kind`; what doesn't fit drops at the feet. No event (callers emit their own). */
  give(p: PlayerState, kind: ItemKind, count: number): GiveResult {
    const n = Math.max(0, Math.floor(count));
    const added = n > 0 ? addItem(p, kind, n) : 0;
    if (added > 0) this.sync(p);
    const dropped = added < n ? this.drop(p, kind, n - added) : [];
    return { added, dropped };
  }

  /** Add what fits (nothing is dropped). Returns the units added. */
  stow(p: PlayerState, kind: ItemKind, count: number): number {
    const added = count > 0 ? addItem(p, kind, Math.floor(count)) : 0;
    if (added > 0) this.sync(p);
    return added;
  }

  /** Remove up to `count` units from one slot. Returns the units removed. */
  takeFromSlot(p: PlayerState, slot: number, count: number): number {
    const n = removeFromSlot(p, slot, count);
    if (n > 0) this.sync(p);
    return n;
  }

  /** Remove up to `count` units of `kind` (last slots first). Returns the units removed. */
  take(p: PlayerState, kind: ItemKind, count: number): number {
    const n = removeItem(p, kind, count);
    if (n > 0) this.sync(p);
    return n;
  }

  /** Empty the inventory (washed ashore, lobby). */
  clear(p: PlayerState): void {
    clearInventory(p);
    this.sync(p);
  }

  /** Re-derive torchTicks / fuseTicks from what the inventory holds. */
  sync(p: PlayerState): void {
    const torches = countOf(p, "torch");
    const torchBefore = p.torchTicks;
    if (torches === 0) p.torchTicks = 0;
    else if (p.torchTicks === 0) p.torchTicks = TORCH_BURN_TICKS;
    if ((torchBefore > 0) !== (p.torchTicks > 0)) this.core.lightsChanged();
    if (countOf(p, "puffer") === 0) p.fuseTicks = 0;
    else if (p.fuseTicks === 0) p.fuseTicks = PUFFER_FUSE_TICKS;
  }

  /** Drop `count` units of `kind` at the feet of `p` as resting pickups. Returns their projectile ids. */
  drop(p: PlayerState, kind: ItemKind, count: number): string[] {
    const ids: string[] = [];
    const grid = this.core.island.grid;
    const r = ITEMS[kind].radius;
    for (let k = 0; k < count; k++) {
      const a = k * DROP_ANGLE + p.yaw;
      const d = DROP_RADIUS + k * DROP_RADIUS_STEP;
      const x = p.x + Math.cos(a) * d;
      const z = p.z + Math.sin(a) * d;
      const y = Math.max(heightAt(grid, x, z), WATER_Y) + r;
      const b = this.core.spawnProjectile(kind, { x, y, z }, { x: 0, y: 0, z: 0 }, { state: "rest", ownerId: "", team: p.team });
      if (b) ids.push(b.id);
    }
    return ids;
  }
}
