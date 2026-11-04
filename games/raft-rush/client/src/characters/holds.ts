// How each item kind sits in a hand: the hold class the animation uses (palm / tool / torch / big two-handed
// carry), the hold scale (gameplay-sized items look huge in a cartoon fist) and the placement of the mesh from
// fx/itemMeshes (the one allowed characters → fx import) in the grip, using its conventions: long tools point
// along +Y (business end +Y), fish and logs lie along X, `userData.grip` is where a hand holds it and
// `userData.tip` the rod tip / spear point. Owner: client-characters.
//
// Grip frame (third person and first person alike): origin in the palm, −Z = the direction a held tool points
// (out of the fist on the thumb side), −Y = toward the fingertips, +X = across the palm.

import * as THREE from "three";
import type { ItemKind } from "../../../shared/types";
import { buildItemMesh, flickerFlame, itemInfo, releaseItemObject } from "../fx/itemMeshes";

export type HoldClass = "palm" | "tool" | "torch" | "big";

interface HoldDef {
  cls: HoldClass;
  /** Scale of the gameplay-sized mesh in a third-person hand / in the first-person hand. */
  third: number;
  fp: number;
}

const HOLDS: Record<ItemKind, HoldDef> = {
  wood: { cls: "palm", third: 0.8, fp: 0.44 },
  rope: { cls: "palm", third: 0.85, fp: 0.48 },
  stone: { cls: "palm", third: 0.9, fp: 0.48 },
  coconut: { cls: "palm", third: 0.75, fp: 0.42 },
  fish_raw: { cls: "palm", third: 0.85, fp: 0.48 },
  fish_cooked: { cls: "palm", third: 0.85, fp: 0.48 },
  crab_raw: { cls: "palm", third: 0.75, fp: 0.4 },
  crab_cooked: { cls: "palm", third: 0.75, fp: 0.4 },
  fish_golden: { cls: "palm", third: 0.9, fp: 0.5 },
  water: { cls: "palm", third: 0.8, fp: 0.44 },
  spear: { cls: "tool", third: 1, fp: 0.55 },
  rod: { cls: "tool", third: 1, fp: 0.6 },
  torch: { cls: "torch", third: 1, fp: 0.48 },
  axe: { cls: "tool", third: 1, fp: 0.52 },
  raft_part: { cls: "big", third: 0.9, fp: 0.5 },
  fence: { cls: "big", third: 0.8, fp: 0.45 },
  collector: { cls: "big", third: 0.8, fp: 0.5 },
  coconut_ball: { cls: "palm", third: 0.7, fp: 0.38 },
  boot: { cls: "palm", third: 0.85, fp: 0.48 },
  jellyfish: { cls: "palm", third: 0.85, fp: 0.48 },
  puffer: { cls: "palm", third: 0.8, fp: 0.44 },
  kraken: { cls: "big", third: 0.75, fp: 0.5 },
  log: { cls: "big", third: 0.9, fp: 0.5 },
  cloth: { cls: "palm", third: 0.85, fp: 0.48 },
  scrap: { cls: "palm", third: 0.9, fp: 0.48 },
  nails: { cls: "palm", third: 1, fp: 0.5 },
  barrel: { cls: "big", third: 0.8, fp: 0.5 },
  compass: { cls: "palm", third: 0.9, fp: 0.48 },
  hammer: { cls: "tool", third: 1, fp: 0.52 },
};

export function holdClass(kind: ItemKind): HoldClass {
  return HOLDS[kind].cls;
}

/** Long tools: their +Y onto the grip's −Z; the axe also turns its blade (+X) toward the fingertips (the chop). */
const TOOL_Q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, -1));
const AXE_Q = TOOL_Q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2));

/**
 * A new held-item object for `kind`: a holder group (scaled for the view) whose child is the item mesh, turned so
 * a long tool points out of the fist along the grip's −Z and moved so its `userData.grip` point sits in the palm
 * (logs, fish and planks keep lying along X, across the palm). The holder's `userData.tip` is the tool tip in
 * holder space (rod tip for the fishing line), or null.
 */
export function createHeldItem(kind: ItemKind, view: "third" | "fp"): THREE.Group {
  const def = HOLDS[kind];
  const holder = new THREE.Group();
  holder.name = `held:${kind}`;
  const item = buildItemMesh(kind);
  const info = itemInfo(item);
  if (info?.long) item.quaternion.copy(kind === "axe" || kind === "hammer" ? AXE_Q : TOOL_Q);
  const grip = info ? info.grip.clone() : new THREE.Vector3();
  item.position.copy(grip.applyQuaternion(item.quaternion)).negate();
  holder.add(item);
  holder.scale.setScalar(view === "fp" ? def.fp : def.third);
  holder.userData.kind = kind;
  holder.userData.tip = info?.tip ? info.tip.clone().applyQuaternion(item.quaternion).add(item.position) : null;
  return holder;
}

/** Animate (or hide, when unlit) the flame of a held torch. */
export function flickerHeld(held: THREE.Object3D, time: number, lit: boolean): void {
  const item = held.children[0];
  if (item) flickerFlame(item, time, lit);
}

/** World position of a held item's tip (rod tip / spear point); false when it has none. */
export function heldTipWorld(held: THREE.Object3D, out: THREE.Vector3): boolean {
  const tip = held.userData.tip as THREE.Vector3 | null | undefined;
  if (!tip) return false;
  held.localToWorld(out.copy(tip));
  return true;
}

/** Free the per-instance bits an item mesh may own (golden glow sprite); shared geometry stays. */
export function releaseHeld(held: THREE.Object3D): void {
  const item = held.children[0];
  if (item) releaseItemObject(item);
}
