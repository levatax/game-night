// First-person holds: for every item kind, how the local tourist's right hand (or both hands) carries it —
// the hand anchor (the tunnel of the gripping fist, the cupped palm, the thumb–index pinch, or the two-handed
// carry), the hand pose, how the item mesh sits in the hand, its first-person scale, and where the hand rests on
// screen with it. The numbers were checked by projecting the real item meshes at 4:3, 16:10 and 21:9: one-handed
// items keep ≥ 0.25 NDC clear of the crosshair (tool heads up in the right third, palm items with their top
// below y −0.2), two-handed bundles stay in the bottom quarter, and every item shows its identifying side (the
// coconut's three eyes, the fish in profile, the crab's face, the gourd's water drop, the rope coil's hole).
// Third-person holds stay in holds.ts. Owner: client-characters.
//
// Hand space as in fpHand.ts, authored for the RIGHT hand: thumb side −X, fingertips −Z, back of the hand +Y,
// palm −Y. Item meshes follow fx/itemMeshes conventions (long tools along +Y with the business end +Y, fish and
// logs along X with the head +X, `userData.grip` = where a hand holds it).

import * as THREE from "three";
import type { ItemKind } from "../../../shared/types";
import { buildItemMesh, itemInfo } from "../fx/itemMeshes";
import { type HandPoseName, SHAFT_PSI } from "./fpHand";
import type { V3 } from "./kit";

/**
 * How the hand carries an item at rest:
 *   tool    fist around a shaft, the business end out of the thumb side (spear, axe, rod, torch)
 *   hang    fist around a neck with the item standing / hanging from it (the gourd, like a bottle)
 *   trophy  fist at one end, the item sticking up out of the fist (the cooked-fish skewer)
 *   cup     palm up, fingers curled around a round item (coconut, stone, puffer, log, golden fish)
 *   tray    palm up and flat, the item standing on it (crabs)
 *   dangle  hanging from a pinch or hooked fingers, swinging with gravity (raw fish by the tail, boot, jellyfish,
 *           rope coil, coconut bundle)
 *   big     both hands on a carried bundle (raft part, fence, collector, tentacle)
 */
export type FpStyle = "tool" | "hang" | "trophy" | "cup" | "tray" | "dangle" | "big";

/**
 * Where on the hand the item attaches (FpHand anchors): on the axis of the gripping fist (the hold point on the
 * shaft axis), on the cupped palm / the open palm (the item's top touches the palm, centered), at the pinch or
 * the hooked fingers (the hold point there), or the two-handed carry spot.
 */
export type FpAnchor = "grip" | "cup" | "tray" | "pinch" | "hook" | "big";

/** A hold's hand pose: a named pose, or a family solved for the item — grip / gripRod (handle radius), cup (ball size). */
export type FpPoseRef = HandPoseName | "grip" | "gripRod" | "cup";

/** A dangling item's pendulum: natural frequency (Hz), damping ratio, max swing (rad). */
export interface FpDangle {
  hz: number;
  zeta: number;
  max: number;
}

/** A two-handed carry, in camera space. */
export interface FpBig {
  /** Item center (camera space, m). */
  at: V3;
  /** Item axis [0] onto camera direction [1], then axis [2] toward [3]. */
  orient: readonly [V3, V3, V3, V3];
  /** Where each hand's anchor touches the item (item units, centered mesh): right, left. */
  contacts: readonly [V3, V3];
  /** Hand rotation per side (camera space Euler YXZ, the left one as it is, not mirrored). */
  rot: readonly [V3, V3];
  pose: readonly [FpPoseRef, FpPoseRef];
  /** Grip radius per hand (item units) for grip poses. */
  handle?: readonly [number, number];
}

export interface FpHold {
  style: FpStyle;
  anchor: FpAnchor;
  pose: FpPoseRef;
  /** Grip family: the thumb wrapped over the handle or lying along it; the handle's radius at the hold point (item units). */
  thumb?: "wrap" | "along";
  handle?: number;
  /** Cup family: the ball radius (auth units, see fpHand.ts); default from the item's size. */
  rs?: number;
  /** Pose tweaks: spread added to the fan (rad); bias added to the bend of [thumb, index, middle, ring, pinky]
   * (rad; negative straightens it — a pinky out). */
  spread?: number;
  bias?: readonly [number, number, number, number, number];
  /** Scale of the gameplay-sized mesh in the first-person hand. */
  scale: number;
  /**
   * Mesh orientation in hand space: item axis [0] onto hand direction [1], then item axis [2] as close as
   * possible to hand direction [3].
   */
  orient: readonly [V3, V3, V3, V3];
  /** Shift of the hold point from the mesh's `userData.grip` (item units, before scaling). */
  grip?: V3;
  /** Extra offset in hand space (m) after the item is placed. */
  at?: V3;
  /** Right-hand rest: offset from the rest spot (camera space, m). */
  hand: V3;
  /** Fist styles: where the held shaft points at rest, and where the knuckles face (sets the roll so the wrapped
   * fingers face the view), camera space. */
  dir?: V3;
  wrap?: V3;
  /** Open-hand / dangle styles: hand rotation at rest (camera space, Euler YXZ: pitch, yaw, roll). */
  rot?: V3;
  dangle?: FpDangle;
  big?: FpBig;
}

export function fpAnchor(h: FpHold): FpAnchor {
  return h.anchor;
}

/** Fist styles (the hand is a fist around the item, posed by its held-shaft direction). */
export function isFist(h: FpHold | null): boolean {
  return h !== null && (h.style === "tool" || h.style === "hang" || h.style === "trophy");
}

const FWD: V3 = [0, 0, -1];
const UP: V3 = [0, 1, 0];
const PY: V3 = [0, 1, 0];
const PX: V3 = [1, 0, 0];
const PZ: V3 = [0, 0, 1];
/** The held shaft in a right fist: across the palm, turned ψ = 0.28 toward the fingertips (fpHand SHAFT_PSI). */
export const SHAFT: V3 = [-Math.cos(SHAFT_PSI), 0, -Math.sin(SHAFT_PSI)];

/** Palm up, the fingers forward and in, tipped toward the view. */
const PALM: V3 = [0.36, 0.33, -2.71];
/** Palm down, the hand raised: dangling items hang below it. */
const DANGLE: V3 = [-0.2, 0.31, -0.41];
const HOOKED: V3 = [-0.15, 0.26, -0.47];

export const FP_HOLDS: Readonly<Record<ItemKind, FpHold>> = {
  // Tools: a low power grip, the head up in the right third, the palm side turned to the view so the wrap shows.
  spear: { style: "tool", anchor: "grip", pose: "grip", thumb: "wrap", handle: 0.034, scale: 0.5, orient: [PY, SHAFT, PX, FWD], hand: [0, -0.03, -0.02], dir: [0.2, 0.75, -0.63], wrap: [0, -0.63, -0.75] },
  rod: { style: "tool", anchor: "grip", pose: "gripRod", thumb: "along", handle: 0.032, scale: 0.55, orient: [PY, SHAFT, PX, [0, -0.82, 0.57]], hand: [0, -0.03, -0.02], dir: [0.2, 0.85, -0.48], wrap: [0, -0.48, -0.85] },
  torch: { style: "tool", anchor: "grip", pose: "grip", thumb: "wrap", handle: 0.034, scale: 0.5, orient: [PY, SHAFT, PX, FWD], hand: [0, -0.04, -0.02], dir: [0.05, 0.93, -0.36], wrap: [0, -0.36, -0.93] },
  axe: { style: "tool", anchor: "grip", pose: "grip", thumb: "wrap", handle: 0.034, scale: 0.56, orient: [PY, SHAFT, PX, FWD], hand: [0.02, -0.01, 0], dir: [0.05, 0.92, -0.38], wrap: [-0.2, -0.35, -0.9] },
  // The gourd by its neck like a bottle, the cork above the thumb and the water drop facing you.
  water: { style: "hang", anchor: "grip", pose: "grip", thumb: "wrap", handle: 0.055, scale: 0.42, orient: [PY, SHAFT, PZ, PZ], hand: [0, -0.045, 0], dir: [-0.12, 0.97, 0.2], wrap: [-0.2, -0.1, -0.97] },
  // The skewer like a lollipop.
  fish_cooked: { style: "trophy", anchor: "grip", pose: "grip", thumb: "wrap", handle: 0.02, scale: 0.42, orient: [PX, SHAFT, PY, UP], grip: [-0.01, 0, 0], hand: [0.01, -0.07, 0], dir: [-0.1, 0.92, -0.38], wrap: [0, -0.38, -0.92] },
  // Cupped on the palm.
  coconut: { style: "cup", anchor: "cup", pose: "cup", spread: 0.12, scale: 0.34, orient: [PY, [-0.21, -0.75, 0.63], PZ, [-0.42, -0.51, -0.75]], hand: [0.03, -0.07, 0.04], rot: PALM },
  stone: { style: "cup", anchor: "cup", pose: "cup", spread: 0.06, scale: 0.38, orient: [PY, [0, -0.98, -0.2], PZ, [0.13, -0.2, 0.97]], hand: [0.03, -0.06, 0.04], rot: PALM },
  puffer: { style: "cup", anchor: "cup", pose: "claw", spread: 0.2, at: [0, -0.017, 0], scale: 0.34, orient: [PZ, [0.42, -0.5, 0.76], PY, [-0.39, -0.85, -0.35]], hand: [0.06, -0.09, -0.04], rot: PALM },
  wood: { style: "cup", anchor: "cup", pose: "cup", rs: 0.045, spread: 0.04, scale: 0.42, orient: [PX, [0.15, 0.23, -0.96], PY, [0, -0.97, -0.23]], hand: [0.03, -0.06, 0.04], rot: [0.31, 0.38, -2.66] },
  fish_golden: { style: "cup", anchor: "cup", pose: "cup", rs: 0.045, spread: 0.06, scale: 0.44, orient: [PX, [0.92, -0.15, -0.37], PY, [-0.15, -0.99, 0.01]], hand: [0.03, -0.05, 0.01], rot: [0.2, 0.66, -2.76] },
  // Standing on the open palm, facing you.
  crab_raw: { style: "tray", anchor: "tray", pose: "tray", bias: [0, 0.15, 0.15, 0.18, 0.2], scale: 0.36, orient: [PY, [0, -1, 0.05], PZ, [0.66, 0.04, 0.75]], hand: [0.01, -0.045, 0], rot: [0.15, 0.36, -2.79] },
  crab_cooked: { style: "tray", anchor: "tray", pose: "tray", scale: 0.38, orient: [PY, [0, -1, 0.05], PZ, [0.61, 0.04, 0.79]], hand: [0.01, -0.045, 0], rot: [0.15, 0.36, -2.79] },
  // Dangling: the hand raised, the item swinging below on its pendulum (orient = its rest pose).
  fish_raw: {
    style: "dangle",
    anchor: "pinch",
    pose: "pinch",
    bias: [0, 0, 0, -0.2, -0.4],
    scale: 0.44,
    orient: [PX, [0.3, -0.93, -0.23], PZ, [-0.21, -0.3, 0.93]],
    grip: [-0.065, 0, 0],
    hand: [0.02, 0.095, -0.055],
    rot: DANGLE,
    dangle: { hz: 1.4, zeta: 0.18, max: 0.9 },
  },
  rope: {
    style: "dangle",
    anchor: "hook",
    pose: "hook",
    scale: 0.42,
    orient: [PY, [-0.2, -0.16, 0.97], PZ, [0.43, -0.9, -0.06]],
    grip: [0, 0, -0.083],
    hand: [0.02, 0.04, -0.02],
    rot: HOOKED,
    dangle: { hz: 1.1, zeta: 0.3, max: 0.6 },
  },
  coconut_ball: {
    style: "dangle",
    anchor: "hook",
    pose: "hook",
    scale: 0.34,
    orient: [PY, [-0.45, 0.88, 0.15], PZ, [-0.5, -0.39, 0.78]],
    grip: [0, 0.142, 0],
    hand: [0.02, 0.05, -0.02],
    rot: HOOKED,
    dangle: { hz: 1.0, zeta: 0.25, max: 0.5 },
  },
  boot: {
    style: "dangle",
    anchor: "pinch",
    pose: "pinch",
    bias: [0, 0, 0, -0.4, -0.6],
    scale: 0.42,
    orient: [PY, [-0.34, 0.91, 0.22], PZ, [-0.75, -0.13, -0.65]],
    grip: [0, 0.07, -0.065],
    hand: [0.03, 0.075, -0.055],
    rot: DANGLE,
    dangle: { hz: 1.2, zeta: 0.25, max: 0.7 },
  },
  jellyfish: {
    style: "dangle",
    anchor: "pinch",
    pose: "pinchFancy",
    bias: [0, 0, -0.27, -0.47, -0.6],
    scale: 0.4,
    orient: [PY, [-0.39, 0.9, 0.2], PZ, [-0.38, -0.35, 0.86]],
    grip: [0, 0.082, 0],
    hand: [0.03, 0.08, -0.06],
    rot: DANGLE,
    dangle: { hz: 0.9, zeta: 0.12, max: 0.8 },
  },
  // Two-handed carries, low in the view (the top edge in the bottom quarter, both hands visible).
  raft_part: {
    style: "big",
    anchor: "big",
    pose: "hook",
    scale: 0.6,
    orient: [PX, PX, PY, UP],
    hand: [0, 0, 0],
    big: {
      at: [0, -0.36, -0.56],
      orient: [PY, [0, 0.8, 0.6], PX, [1, 0, 0]],
      contacts: [
        [0.335, 0, 0],
        [-0.32, 0, 0],
      ],
      rot: [
        [-0.1, 0, -1.37],
        [-0.1, 0, 1.37],
      ],
      pose: ["hook", "hook"],
    },
  },
  fence: {
    style: "big",
    anchor: "big",
    pose: "grip",
    scale: 0.6,
    orient: [PX, PX, PY, UP],
    hand: [0, 0, 0],
    big: {
      at: [0, -0.32, -0.6],
      orient: [PY, [0, 0.25, -0.97], PZ, [0, 0.97, 0.25]],
      contacts: [
        [0.27, -0.105, 0.019],
        [-0.27, -0.105, 0.019],
      ],
      rot: [
        [-0.52, 0, 0],
        [-0.52, 0, 0],
      ],
      pose: ["grip", "grip"],
      handle: [0.02, 0.02],
    },
  },
  collector: {
    style: "big",
    anchor: "big",
    pose: "cup",
    scale: 0.46,
    orient: [PX, PX, PY, UP],
    hand: [0, 0, 0],
    big: {
      at: [0, -0.31, -0.55],
      orient: [PY, [0, 0.94, 0.34], PX, [1, 0, 0]],
      contacts: [
        [0.16, -0.076, 0],
        [-0.184, -0.076, 0],
      ],
      rot: [
        [0, 0.1, -1.57],
        [0, -0.1, 1.57],
      ],
      pose: ["cup", "cup"],
    },
  },
  kraken: {
    style: "big",
    anchor: "big",
    pose: "grip",
    scale: 0.5,
    orient: [PX, PX, PY, UP],
    hand: [0, 0, 0],
    big: {
      at: [0, -0.31, -0.55],
      orient: [PY, [0, 0.8, -0.6], PZ, [0, 0.6, 0.8]],
      contacts: [
        [0.145, -0.039, 0],
        [-0.185, -0.135, 0],
      ],
      rot: [
        [-0.53, 0.03, 0.41],
        [-0.52, -0.01, -0.08],
      ],
      pose: ["grip", "grip"],
      handle: [0.04, 0.075],
    },
  },
};

export function fpHold(kind: ItemKind): FpHold {
  return FP_HOLDS[kind];
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _A = new THREE.Vector3();
const _B = new THREE.Vector3();
const _C = new THREE.Vector3();
const _m1 = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();

/** Rotation taking item axis a onto A, and b as close as possible onto B. */
export function orientQ(o: readonly [V3, V3, V3, V3], out = new THREE.Quaternion()): THREE.Quaternion {
  _a.set(...o[0]).normalize();
  _b.set(...o[2]);
  _b.addScaledVector(_a, -_b.dot(_a)).normalize();
  _c.crossVectors(_a, _b);
  _A.set(...o[1]).normalize();
  _B.set(...o[3]);
  _B.addScaledVector(_A, -_B.dot(_A)).normalize();
  _C.crossVectors(_A, _B);
  _m1.makeBasis(_a, _b, _c).transpose();
  _m2.makeBasis(_A, _B, _C).multiply(_m1);
  return out.setFromRotationMatrix(_m2);
}

const _box = new THREE.Box3();

/**
 * A new first-person held object for `kind`: a holder (scaled) whose child is the close-up item mesh, oriented and
 * moved so its hold point sits at the holder origin. Put the holder at the hand anchor (fpAnchor), or for a big
 * carry at FpBig.at (the holder then carries the camera-space orientation). Open-palm items are lifted so their
 * top rests in the palm. userData: `tip` = the tool tip in holder space (rod tip for the fishing line) or null,
 * `hang` = the direction from the hold point down to the item's middle (holder space, dangles), `scale`.
 */
export function createFpHeldItem(kind: ItemKind): THREE.Group {
  const def = FP_HOLDS[kind];
  const holder = new THREE.Group();
  holder.name = `fpHeld:${kind}`;
  const item = buildItemMesh(kind, { closeUp: true });
  const info = itemInfo(item);
  const anchor = fpAnchor(def);
  item.quaternion.copy(orientQ(anchor === "big" && def.big ? def.big.orient : def.orient));
  const hold = info ? info.grip.clone() : new THREE.Vector3();
  if (def.grip) hold.add(_a.set(...def.grip));
  if (anchor === "big") hold.set(0, 0, 0);
  item.position.copy(hold.applyQuaternion(item.quaternion)).negate();
  holder.add(item);
  holder.scale.setScalar(def.scale);
  holder.updateMatrixWorld(true);
  // Precise: the corners of a rotated local box overshoot the mesh by centimetres.
  _box.setFromObject(item, true);
  if (anchor === "cup" || anchor === "tray") {
    // On the palm: the item's top (hand +Y = toward the palm) at the anchor, centered over it.
    _box.getCenter(_c);
    item.position.x -= _c.x / def.scale;
    item.position.z -= _c.z / def.scale;
    item.position.y -= _box.max.y / def.scale;
    holder.updateMatrixWorld(true);
    _box.setFromObject(item, true);
  }
  if (def.at) holder.userData.at = new THREE.Vector3(...def.at);
  holder.userData.kind = kind;
  holder.userData.scale = def.scale;
  // Handle radius (m) for grip poses; ball radius across the palm (m) for cup poses.
  holder.userData.handle = (def.handle ?? 0.022) * def.scale;
  holder.userData.ball = Math.max(_box.max.x - _box.min.x, _box.max.z - _box.min.z) / 2;
  holder.userData.center = _box.getCenter(new THREE.Vector3()).divideScalar(def.scale);
  holder.userData.hang = (holder.userData.center as THREE.Vector3).clone().normalize();
  holder.userData.tip = info?.tip ? info.tip.clone().applyQuaternion(item.quaternion).add(item.position) : null;
  return holder;
}
