// Shared skeleton for every animal: torso, belly, head, arms (arm / wing / flipper), legs, ghost
// tail. Character files add faces and accessories. Owner: client-characters.

import * as THREE from "three";
import type { CharacterId } from "../../../../shared/types";
import { type Paint, PartBuilder, type V3 } from "../parts";

/** Height of the spin pivot (center of mass) used for rolls, tumbles and flips. */
export const SPIN_PIVOT_Y = 0.66;

export interface ArmSpec {
  kind: "arm" | "wing" | "flipper";
  /** Shoulder pivot (right side; mirrored for the left). */
  shoulder: V3;
  length: number;
  radius: number;
  paint: Paint;
  /** Hand (arm) or tip blob (wing / flipper) radii. */
  hand: V3;
  handPaint: Paint;
  /** Slot-colored sweatband at the wrist. */
  band: boolean;
}

export interface LegSpec {
  /** Hip pivot (right side; mirrored for the left). */
  hip: V3;
  length: number;
  radius: number;
  paint: Paint;
  foot: V3;
  footPaint: Paint;
  /** Foot center offset forward (negative z = forward). */
  footZ: number;
}

export interface BodySpec {
  torso: { y: number; r: V3; paint: Paint };
  belly?: { at: V3; r: V3; paint: Paint };
  /** Upper-body pivot (waist). */
  waistY: number;
  /** Head pivot (neck) and head ellipsoid center/radii. */
  neckY: number;
  head: { at: V3; r: V3; paint: Paint };
  arm: ArmSpec;
  leg: LegSpec;
  /** Tail / scarf / sac pivot (feet space). */
  extraAt: V3;
  /** Top of the model incl. accessories (nameplate / pop text anchor sits a bit above). */
  topY: number;
  ghostPaint: Paint;
}

/** Everything a character file fills in and the Animal / Animator drive. */
export interface Skeleton {
  offset: THREE.Group;
  body: THREE.Group;
  spin: THREE.Group;
  model: THREE.Group;
  upper: THREE.Group;
  torso: THREE.Mesh;
  belly: THREE.Mesh | null;
  head: THREE.Group;
  headMesh: THREE.Mesh;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  extra: THREE.Group;
  hand: THREE.Object3D;
  headTop: THREE.Object3D;
  ghostTail: THREE.Group;
}

/** Optional parts a character adds (filled by its build function). */
export interface CharacterExtras {
  face: THREE.Mesh;
  /** Lower beak (duck, penguin): opens on honk / happy / hurt. */
  jaw: THREE.Object3D | null;
  /** Frog throat sac: inflates on honk. */
  sac: THREE.Object3D | null;
  /** Ears / floppy bits that wiggle with squash. */
  ears: THREE.Object3D[];
  /** Second tail segment (cat) that follows the first with extra curl. */
  tailTip: THREE.Object3D | null;
  /** The accessory that pops off and floats on a KO (also hidden then). */
  accessory: THREE.Object3D | null;
}

export type CharacterBuilder = (b: PartBuilder, s: Skeleton, face: THREE.Texture) => CharacterExtras;

export interface BuiltModel {
  root: THREE.Group;
  skeleton: Skeleton;
  extras: CharacterExtras;
  spec: BodySpec;
}

/**
 * Held-ball center relative to the hand center, in the arm's rest frame: just past the fingertips
 * and a little forward, so with the carry pose (arm swung forward and out) the ball sits in the
 * palm beside the belly.
 */
const HOLD_OFFSET: V3 = [0.02, -0.16, -0.08];

export function buildSkeleton(b: PartBuilder, spec: BodySpec): { root: THREE.Group; skeleton: Skeleton } {
  const root = new THREE.Group();
  const offset = b.group(root, [0, 0, 0], "offset");
  const body = b.group(offset, [0, 0, 0], "body");
  const spin = b.group(body, [0, SPIN_PIVOT_Y, 0], "spin");
  const model = b.group(spin, [0, 0, 0], "model");
  const upper = b.group(model, [0, spec.waistY, 0], "upper");

  const torso = b.sphere(upper, spec.torso.paint, [0, spec.torso.y, 0], spec.torso.r, "hi");
  const belly = spec.belly ? b.sphere(upper, spec.belly.paint, spec.belly.at, spec.belly.r, "mid") : null;

  const head = b.group(upper, [0, spec.neckY, 0], "head");
  const headMesh = b.sphere(head, spec.head.paint, spec.head.at, spec.head.r, "hi");
  const headTop = b.anchor(head, [0, spec.topY, 0], "headTop");

  const armR = buildArm(b, upper, spec.arm, 1);
  const armL = buildArm(b, upper, spec.arm, -1);
  const legR = buildLeg(b, model, spec.leg, 1);
  const legL = buildLeg(b, model, spec.leg, -1);
  legR.group.rotation.order = "YXZ";
  legL.group.rotation.order = "YXZ";

  const extra = b.group(upper, spec.extraAt, "extra");
  const ghostTail = buildGhostTail(b, model, spec);

  return {
    root,
    skeleton: {
      offset,
      body,
      spin,
      model,
      upper,
      torso,
      belly,
      head,
      headMesh,
      armL: armL.group,
      armR: armR.group,
      legL: legL.group,
      legR: legR.group,
      extra,
      hand: armR.hold,
      headTop,
      ghostTail,
    },
  };
}

function buildArm(
  b: PartBuilder,
  parent: THREE.Object3D,
  arm: ArmSpec,
  side: 1 | -1,
): { group: THREE.Group; hold: THREE.Object3D } {
  const [sx, sy, sz] = arm.shoulder;
  const x = sx * side;
  const group = b.group(parent, [x, sy, sz], side > 0 ? "armR" : "armL");
  const handY = sy - arm.length;
  if (arm.kind === "arm") {
    b.capsule(group, arm.paint, [x, sy, sz], [x, handY + arm.hand[1] * 0.4, sz], arm.radius, "lo");
    b.sphere(group, arm.handPaint, [x, handY, sz], arm.hand, "mid");
    if (arm.band) b.torus(group, "slot", [x, handY + arm.hand[1] * 0.95, sz], arm.radius * 1.15, arm.radius * 0.45);
  } else {
    // Wings and flippers are one big flattened blob hanging from the shoulder.
    const midY = sy - arm.length * 0.5;
    b.sphere(group, arm.paint, [x + side * 0.01, midY, sz], [arm.radius, arm.length * 0.62, arm.hand[2]], "mid");
    b.sphere(group, arm.handPaint, [x + side * 0.005, handY + arm.hand[1] * 0.5, sz], arm.hand, "lo");
    if (arm.band) {
      const band = b.torus(group, "slot", [x, handY + arm.length * 0.32, sz], 1, 0.22);
      band.scale.set(arm.radius * 1.05, arm.radius * 1.05, arm.hand[2] * 0.95);
    }
  }
  const hold = b.anchor(group, [x + HOLD_OFFSET[0] * side, handY + HOLD_OFFSET[1], sz + HOLD_OFFSET[2]], "hold");
  return { group, hold };
}

function buildLeg(b: PartBuilder, parent: THREE.Object3D, leg: LegSpec, side: 1 | -1): { group: THREE.Group } {
  const [hx, hy, hz] = leg.hip;
  const x = hx * side;
  const group = b.group(parent, [x, hy, hz], side > 0 ? "legR" : "legL");
  const footY = leg.foot[1];
  b.capsule(group, leg.paint, [x, hy, hz], [x, footY + leg.foot[1] * 0.3, hz], leg.radius, "lo");
  b.sphere(group, leg.footPaint, [x, footY, hz + leg.footZ], leg.foot, "mid");
  return { group };
}

/** Wispy tail that replaces the legs in ghost form (hidden otherwise). */
function buildGhostTail(b: PartBuilder, model: THREE.Group, spec: BodySpec): THREE.Group {
  const group = b.group(model, [0, spec.torso.y - spec.torso.r[1] * 0.4, 0], "ghostTail");
  const r = spec.torso.r[0] * 0.92;
  const top = spec.torso.y - spec.torso.r[1] * 0.4;
  b.cone(group, spec.ghostPaint, [0, top, 0.02], [0.05, top - 0.42, 0.14], r, 10);
  group.visible = false;
  return group;
}

/** Feet-space vector helper for mirrored parts. */
export function mirror(at: V3, side: 1 | -1): V3 {
  return [at[0] * side, at[1], at[2]];
}

export type ModelRegistry = Record<CharacterId, { spec: BodySpec; build: CharacterBuilder; memento: MementoBuilder }>;

/** Builds the floating KO memento (hat, bow tie, bell…) centered on its own origin. */
export type MementoBuilder = (b: PartBuilder, parent: THREE.Group) => void;
