// 4-slot inventory helpers over the flat schema fields (inv0..inv3 / cnt0..cnt3). Owner: architect (complete).
// Mutating helpers are for the server world; the client and bots use the read-only ones.

import { ITEMS } from "../items.js";
import type { InvKind, ItemKind } from "../types.js";

/** The inventory part of a player (PlayerView / PlayerState satisfy it). */
export interface Inventory {
  inv0: InvKind;
  inv1: InvKind;
  inv2: InvKind;
  inv3: InvKind;
  cnt0: number;
  cnt1: number;
  cnt2: number;
  cnt3: number;
}

export const SLOTS = 4;

export function slotKind(inv: Inventory, slot: number): InvKind {
  return slot === 0 ? inv.inv0 : slot === 1 ? inv.inv1 : slot === 2 ? inv.inv2 : slot === 3 ? inv.inv3 : "";
}

export function slotCount(inv: Inventory, slot: number): number {
  return slot === 0 ? inv.cnt0 : slot === 1 ? inv.cnt1 : slot === 2 ? inv.cnt2 : slot === 3 ? inv.cnt3 : 0;
}

/** Overwrite a slot (count 0 or kind "" empties it). */
export function setSlot(inv: Inventory, slot: number, kind: InvKind, count: number): void {
  const k: InvKind = count > 0 ? kind : "";
  const c = k === "" ? 0 : count;
  if (slot === 0) {
    inv.inv0 = k;
    inv.cnt0 = c;
  } else if (slot === 1) {
    inv.inv1 = k;
    inv.cnt1 = c;
  } else if (slot === 2) {
    inv.inv2 = k;
    inv.cnt2 = c;
  } else if (slot === 3) {
    inv.inv3 = k;
    inv.cnt3 = c;
  }
}

export function slotsOf(inv: Inventory): { kind: InvKind; count: number }[] {
  const out: { kind: InvKind; count: number }[] = [];
  for (let s = 0; s < SLOTS; s++) out.push({ kind: slotKind(inv, s), count: slotCount(inv, s) });
  return out;
}

/** Total units of `kind` across all slots. */
export function countOf(inv: Inventory, kind: ItemKind): number {
  let n = 0;
  for (let s = 0; s < SLOTS; s++) if (slotKind(inv, s) === kind) n += slotCount(inv, s);
  return n;
}

/** How many units of `kind` would fit (topping up partial stacks first, then empty slots). */
export function roomFor(inv: Inventory, kind: ItemKind): number {
  const stack = ITEMS[kind].stack;
  let n = 0;
  for (let s = 0; s < SLOTS; s++) {
    const k = slotKind(inv, s);
    if (k === kind) n += Math.max(0, stack - slotCount(inv, s));
    else if (k === "") n += stack;
  }
  return n;
}

/** Add up to `count` units (partial stacks first, then the lowest empty slot). Returns how many were added. */
export function addItem(inv: Inventory, kind: ItemKind, count: number): number {
  const stack = ITEMS[kind].stack;
  let left = count;
  for (let s = 0; s < SLOTS && left > 0; s++) {
    if (slotKind(inv, s) !== kind) continue;
    const c = slotCount(inv, s);
    const put = Math.min(left, stack - c);
    if (put > 0) {
      setSlot(inv, s, kind, c + put);
      left -= put;
    }
  }
  for (let s = 0; s < SLOTS && left > 0; s++) {
    if (slotKind(inv, s) !== "") continue;
    const put = Math.min(left, stack);
    setSlot(inv, s, kind, put);
    left -= put;
  }
  return count - left;
}

/** Remove up to `count` units of `kind` (from the last slots first). Returns how many were removed. */
export function removeItem(inv: Inventory, kind: ItemKind, count: number): number {
  let left = count;
  for (let s = SLOTS - 1; s >= 0 && left > 0; s--) {
    if (slotKind(inv, s) !== kind) continue;
    const c = slotCount(inv, s);
    const take = Math.min(left, c);
    setSlot(inv, s, kind, c - take);
    left -= take;
  }
  return count - left;
}

/** Remove `count` units from one slot. Returns how many were removed. */
export function removeFromSlot(inv: Inventory, slot: number, count: number): number {
  const kind = slotKind(inv, slot);
  if (kind === "") return 0;
  const c = slotCount(inv, slot);
  const take = Math.min(count, c);
  setSlot(inv, slot, kind, c - take);
  return take;
}

export function clearInventory(inv: Inventory): void {
  for (let s = 0; s < SLOTS; s++) setSlot(inv, s, "", 0);
}

export function isEmpty(inv: Inventory): boolean {
  return inv.inv0 === "" && inv.inv1 === "" && inv.inv2 === "" && inv.inv3 === "";
}
