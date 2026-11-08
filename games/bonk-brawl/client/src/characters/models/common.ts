// Shared skeleton for every animal: gumdrop torso (sphere / egg / rounded box), head, arms (arm /
// wing / flipper with ball / pad / paw hands), legs (stub / frog), ghost tail, plus the spring-bone
// presets and helpers. Character files add faces and accessories. Owner: client-characters.

import * as THREE from "three";
import type { CharacterId } from "../../../../shared/types";
import type { FinishResult, Paint, PartBuilder, PrimOpts, V3 } from "../parts";
import type { SpringBone, SpringKind } from "../rigTypes";

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
  /** Hand shape (arms only): plain ball, frog pad + 3 finger blobs, bear paw with a pad. */
  handVariant?: "ball" | "pad3" | "paw";
  /** Paw pad / finger tip color. */
  padPaint?: Paint;
  /** Slot-colored sweatband at the wrist. */
  band: boolean;
  /** Hand center offset (x inward, z) from straight below the shoulder (right side). */
  reach?: readonly [number, number];
}

export interface LegSpec {
  variant?: "stub" | "frog";
  /** Hip pivot (right side; mirrored for the left). */
  hip: V3;
  length: number;
  radius: number;
  paint: Paint;
  foot: V3;
  footPaint: Paint;
  /** Foot center offset forward (negative z = forward). */
  footZ: number;
  /** Webbed toe scallops at the front of the foot. */
  toes?: number;
  /** Split hooves (goat). */
  hoof?: boolean;
  /** Paw pad color on the sole front (bear). */
  padPaint?: Paint;
  /** Frog legs: knee and ankle (right side, feet space) and the outward foot yaw. */
  knee?: V3;
  ankle?: V3;
  footYaw?: number;
}

export interface TorsoSpec {
  y: number;
  /** Forward offset of the torso center (+z = back). */
  z?: number;
  r: V3;
  paint: Paint;
  shape?: "sphere" | "egg" | "box";
  /** Egg factor (k < 0 = pear, wider at the bottom). */
  egg?: number;
  /** Bird posture: pitch (rad, negative = chest forward / rump up). */
  pitch?: number;
  /** Box torso: corner radius (size = 2·r). */
  boxRadius?: number;
  vertexPaint?: PrimOpts["vertexPaint"];
}

export interface BodySpec {
  torso: TorsoSpec;
  /** Belly patch; pivot: its own scale-spring group (Mochi). */
  belly?: { at: V3; r: V3; paint: Paint; pivot?: boolean; outline?: boolean; detail?: "mid" | "lo" };
  /** Upper-body pivot (waist). */
  waistY: number;
  /** Head pivot (neck) and head ellipsoid center/radii. */
  neckY: number;
  head: { at: V3; r: V3; paint: Paint; egg?: number; vertexPaint?: PrimOpts["vertexPaint"] };
  arm: ArmSpec;
  leg: LegSpec;
  /** Tail pivot (feet space). */
  extraAt: V3;
  /** Top of the model incl. flair (nameplate / pop text anchor sits a bit above). */
  topY: number;
  ghostPaint: Paint;
  /** Held-ball offset from the hand center (right arm rest frame). Default: below the palm. */
  holdOffset?: V3;
  /** Rim light strength (dark bodies want less). */
  rim?: number;
  /** Body gradient strength. */
  gradient?: number;
}

/** Everything a character file fills in and the Animal / Animator drive. */
export interface Skeleton {
  offset: THREE.Group;
  body: THREE.Group;
  spin: THREE.Group;
  model: THREE.Group;
  upper: THREE.Group;
  /** Belly scale pivot (Mochi) or null (belly merged into upper). */
  belly: THREE.Group | null;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  extra: THREE.Group;
  hand: THREE.Object3D;
  headTop: THREE.Object3D;
  ghostTail: THREE.Group;
  /** Spring list (the head lag bone is already in it). */
  springs: SpringList;
}

/** Optional parts a character adds (filled by its build function). */
export interface CharacterExtras {
  /** Name of the pivot whose face mesh is rig.face (default "head"). */
  facePivot?: string;
  /** Lower beak / muzzle (duck, penguin, goat): opens on honk / happy / hurt, chews. */
  jaw: THREE.Object3D | null;
  /** Frog throat sac: inflates on honk. */
  sac: THREE.Object3D | null;
  /** Ears [right, left]. */
  ears: THREE.Object3D[];
  /** Tail segments after rig.extra (cat tail1, tail2). */
  tail: THREE.Object3D[];
  /** The accessory that pops off and floats on a KO (also hidden then). */
  accessory: THREE.Object3D | null;
  /** Hat / nightcap root / headband / scarf. */
  headwear: THREE.Object3D | null;
  cheeks: THREE.Object3D[];
  eyeBulbs: THREE.Object3D[];
}

export type CharacterBuilder = (b: PartBuilder, s: Skeleton) => CharacterExtras;

export interface BuiltModel {
  root: THREE.Group;
  skeleton: Skeleton;
  extras: CharacterExtras;
  spec: BodySpec;
  springs: SpringBone[];
  finished: FinishResult;
}

/* ============================================================ springs */

type SpringPreset = Pick<SpringBone, "kind" | "mode" | "freq" | "damping" | "gravity" | "limit"> & { axis?: "x" | "y" | "z" };

/** Spring tuning per role (character spec §3.8). */
export const SPRING_PRESETS = {
  head: { kind: "head", mode: "aim", freq: 5.0, damping: 0.45, gravity: 0, limit: 0.12 },
  earUp: { kind: "ear", mode: "aim", freq: 6.0, damping: 0.35, gravity: 1, limit: 0.35 },
  earFloppy: { kind: "ear", mode: "aim", freq: 3.2, damping: 0.25, gravity: 6, limit: 0.7 },
  tailStiff: { kind: "tail", mode: "aim", freq: 6.0, damping: 0.3, gravity: 1, limit: 0.4 },
  tailBall: { kind: "tail", mode: "aim", freq: 6.0, damping: 0.3, gravity: 1, limit: 0.3 },
  tail1: { kind: "tail", mode: "aim", freq: 4.0, damping: 0.3, gravity: 2, limit: 0.6 },
  tail2: { kind: "tail", mode: "aim", freq: 3.4, damping: 0.28, gravity: 2, limit: 0.8 },
  hat: { kind: "hat", mode: "aim", freq: 7.0, damping: 0.4, gravity: 0.5, limit: 0.2 },
  ribbon: { kind: "ribbon", mode: "aim", freq: 2.6, damping: 0.22, gravity: 8, limit: 1.2 },
  scarfA0: { kind: "scarf", mode: "aim", freq: 2.4, damping: 0.25, gravity: 8, limit: 1.3 },
  scarfA1: { kind: "scarf", mode: "aim", freq: 2.0, damping: 0.22, gravity: 8, limit: 1.4 },
  cap: { kind: "cap", mode: "aim", freq: 2.8, damping: 0.25, gravity: 7, limit: 1.0 },
  pompom: { kind: "pompom", mode: "aim", freq: 3.5, damping: 0.2, gravity: 9, limit: 0.8 },
  bell: { kind: "bell", mode: "aim", freq: 3.0, damping: 0.15, gravity: 9, limit: 0.9 },
  beard: { kind: "beard", mode: "aim", freq: 4.0, damping: 0.3, gravity: 6, limit: 0.5 },
  crest: { kind: "crest", mode: "aim", freq: 6.5, damping: 0.25, gravity: 2, limit: 0.5 },
  bulb: { kind: "bulb", mode: "aim", freq: 7.0, damping: 0.3, gravity: 1, limit: 0.25 },
  wing: { kind: "wing", mode: "aim", freq: 4.0, damping: 0.35, gravity: 2, limit: 0.25 },
  cheek: { kind: "cheek", mode: "scale", freq: 7.0, damping: 0.25, gravity: 0, limit: 0.25, axis: "y" },
  belly: { kind: "belly", mode: "scale", freq: 5.0, damping: 0.2, gravity: 0, limit: 0.18, axis: "y" },
  sac: { kind: "sac", mode: "scale", freq: 6.0, damping: 0.25, gravity: 0, limit: 0.2, axis: "y" },
} as const satisfies Record<string, SpringPreset>;

export type SpringPresetName = keyof typeof SPRING_PRESETS;

const tmpW = new THREE.Vector3();

/** Collects spring descriptors in parents-first order. */
export class SpringList {
  readonly bones: SpringBone[] = [];

  /**
   * Add a spring on `pivot` with its lagging point at feet-space `tipFeet` (rest pose). The parent
   * is the nearest ancestor pivot already in the list.
   */
  add(pivot: THREE.Object3D, preset: SpringPresetName, tipFeet: V3, overrides: Partial<SpringPreset> = {}): SpringBone {
    const p = { ...SPRING_PRESETS[preset], ...overrides } as SpringPreset;
    pivot.updateWorldMatrix(true, false);
    const w = pivot.getWorldPosition(tmpW);
    let parent = -1;
    for (let o = pivot.parent; o && parent < 0; o = o.parent) {
      parent = this.bones.findIndex((bone) => bone.pivot === o);
    }
    const bone: SpringBone = {
      name: pivot.name,
      kind: p.kind as SpringKind,
      pivot,
      mode: p.mode,
      tip: [tipFeet[0] - w.x, tipFeet[1] - w.y, tipFeet[2] - w.z],
      freq: p.freq,
      damping: p.damping,
      gravity: p.gravity,
      limit: p.limit,
      parent,
    };
    if (p.mode === "scale") bone.axis = p.axis ?? "y";
    this.bones.push(bone);
    return bone;
  }
}

/* =========================================================== skeleton */

const DEFAULT_GRADIENT = 0.08;

export function buildSkeleton(b: PartBuilder, spec: BodySpec): { root: THREE.Group; skeleton: Skeleton } {
  const root = new THREE.Group();
  const offset = b.group(root, [0, 0, 0], "offset");
  const body = b.group(offset, [0, 0, 0], "body");
  const spin = b.group(body, [0, SPIN_PIVOT_Y, 0], "spin");
  const model = b.group(spin, [0, 0, 0], "model");
  const upper = b.group(model, [0, spec.waistY, 0], "upper");
  const g = spec.gradient ?? DEFAULT_GRADIENT;

  buildTorso(b, upper, spec, g);
  let belly: THREE.Group | null = null;
  if (spec.belly) {
    const target = spec.belly.pivot ? (belly = b.group(upper, spec.belly.at, "belly")) : upper;
    b.sphere(target, spec.belly.paint, spec.belly.at, spec.belly.r, { detail: spec.belly.detail ?? "mid", gradient: g * 0.6, outline: spec.belly.outline });
  }

  const head = b.group(upper, [0, spec.neckY, 0], "head");
  const h = spec.head;
  const headOpts = { detail: "hi", shadow: true, gradient: g, vertexPaint: h.vertexPaint } as const;
  if (h.egg) b.egg(head, h.paint, h.at, h.r, h.egg, headOpts);
  else b.sphere(head, h.paint, h.at, h.r, headOpts);
  const headTop = b.anchor(head, [0, spec.topY, 0], "headTop");

  const armR = buildArm(b, upper, spec, 1);
  const armL = buildArm(b, upper, spec, -1);
  const legR = buildLeg(b, model, spec.leg, 1);
  const legL = buildLeg(b, model, spec.leg, -1);
  legR.rotation.order = "YXZ";
  legL.rotation.order = "YXZ";

  const extra = b.group(upper, spec.extraAt, "extra");
  const ghostTail = buildGhostTail(b, model, spec);

  const springs = new SpringList();
  springs.add(head, "head", [h.at[0], h.at[1] + 0.3, h.at[2]]);
  if (spec.arm.kind !== "arm") {
    for (const arm of [armR, armL]) {
      const side = arm === armR ? 1 : -1;
      const [sx, sy, sz] = spec.arm.shoulder;
      springs.add(arm, "wing", [sx * side, sy - spec.arm.length, sz]);
    }
  }

  return {
    root,
    skeleton: {
      offset,
      body,
      spin,
      model,
      upper,
      belly,
      head,
      armL: armL,
      armR: armR,
      legL,
      legR,
      extra,
      hand: (armR.userData.hold as THREE.Object3D) ?? armR,
      headTop,
      ghostTail,
      springs,
    },
  };
}

function buildTorso(b: PartBuilder, upper: THREE.Group, spec: BodySpec, g: number): void {
  const t = spec.torso;
  const at: V3 = [0, t.y, t.z ?? 0];
  const vertexPaint = t.vertexPaint;
  const draw = (): void => {
    if (t.shape === "box") {
      b.roundedBox(upper, t.paint, at, [t.r[0] * 2, t.r[1] * 2, t.r[2] * 2], t.boxRadius ?? 0.16, {
        detail: "hi",
        shadow: true,
        gradient: g,
        vertexPaint,
      });
    } else if (t.shape === "egg") {
      b.egg(upper, t.paint, at, t.r, t.egg ?? -0.15, { detail: "hi", shadow: true, gradient: g, vertexPaint });
    } else {
      b.sphere(upper, t.paint, at, t.r, { detail: "hi", shadow: true, gradient: g, vertexPaint });
    }
  };
  if (t.pitch) b.frame(at, [t.pitch, 0, 0], draw);
  else draw();
}

function buildArm(b: PartBuilder, parent: THREE.Object3D, spec: BodySpec, side: 1 | -1): THREE.Group {
  const arm = spec.arm;
  const [sx, sy, sz] = arm.shoulder;
  const x = sx * side;
  const group = b.group(parent, [x, sy, sz], side > 0 ? "armR" : "armL");
  const reach = arm.reach ?? [0, 0];
  const hx = x - reach[0] * side;
  const hz = sz + reach[1];
  const handY = sy - arm.length;
  const g = spec.gradient ?? DEFAULT_GRADIENT;
  if (arm.kind === "arm") {
    const variant = arm.handVariant ?? "ball";
    b.capsule(group, arm.paint, [x, sy, sz], [hx, handY + arm.hand[1] * 0.5, hz], arm.radius, { gradient: g * 0.5 });
    b.sphere(group, arm.handPaint, [hx, handY, hz], arm.hand, { detail: variant === "pad3" ? "xs" : "lo", gradient: 0.05 });
    if (variant === "pad3") {
      for (const k of [-1, 0, 1]) {
        b.sphere(
          group,
          arm.padPaint ?? arm.handPaint,
          [hx + k * arm.hand[0] * 0.55, handY - arm.hand[1] * 0.75, hz - arm.hand[2] * 0.55 + Math.abs(k) * 0.02],
          [0.045, 0.04, 0.045],
          { detail: "xs", outline: false, hiOnly: k !== 0 },
        );
      }
    } else if (variant === "paw" && arm.padPaint) {
      b.sphere(group, arm.padPaint, [hx, handY - arm.hand[1] * 0.35, hz - arm.hand[2] * 0.72], [arm.hand[0] * 0.55, arm.hand[1] * 0.5, 0.03], {
        detail: "xs",
        outline: false,
        hiOnly: true,
      });
    }
    if (arm.band) {
      // A snug sweatband around the forearm, aligned with the arm (a 5-sided tube reads as a
      // rounded cuff; a 3-sided one rendered as a flat blade sticking out of the wrist).
      const bandY = handY + arm.hand[1] * 0.95;
      const bandT = (sy - bandY) / Math.max(1e-6, sy - handY);
      b.torus(group, "slot", [x + (hx - x) * bandT, bandY, sz + (hz - sz) * bandT], arm.radius * 0.98, arm.radius * 0.4, {
        axis: [hx - x, handY - sy, hz - sz],
        tubular: 5,
        radial: 5,
        gradient: 0,
      });
    }
  } else {
    // Wings and flippers: a flattened paddle hanging from the shoulder with a tip.
    const midY = sy - arm.length * 0.5;
    b.sphere(group, arm.paint, [x + side * 0.01, midY, sz], [arm.radius, arm.length * 0.6, arm.hand[2]], {
      detail: "mid",
      gradient: g,
      rot: [0, 0, side * 0.08],
    });
    if (arm.kind === "wing") {
      // Three feather scallops along the tip.
      for (const k of [-1, 0, 1]) {
        b.sphere(group, arm.handPaint, [x + side * 0.015, handY + 0.06 + Math.abs(k) * 0.025, sz + k * arm.hand[2] * 0.55], [arm.radius * 0.8, arm.hand[1], arm.hand[2] * 0.45], {
          detail: "xs",
          hiOnly: k !== 0,
        });
      }
    } else {
      b.sphere(group, arm.handPaint, [x + side * 0.005, handY + arm.hand[1] * 0.5, sz], arm.hand, { detail: "lo" });
    }
    if (arm.band) {
      b.torus(group, "slot", [x + side * 0.01, handY + arm.length * 0.3, sz], 1, 0.24, {
        scale: [arm.radius * 1.25, 0.55, arm.hand[2] * 1.05],
        tubular: 8,
        radial: 5,
        gradient: 0,
      });
    }
  }
  const off = spec.holdOffset ?? [0.02, -(arm.hand[1] + 0.065), -0.08];
  const hold = b.anchor(group, [hx + off[0] * side, handY + off[1], hz + off[2]], "hold");
  group.userData.hold = hold;
  return group;
}

function buildLeg(b: PartBuilder, parent: THREE.Object3D, leg: LegSpec, side: 1 | -1): THREE.Group {
  const [hx, hy, hz] = leg.hip;
  const x = hx * side;
  const group = b.group(parent, [x, hy, hz], side > 0 ? "legR" : "legL");
  const footY = leg.foot[1];
  if (leg.variant === "frog" && leg.knee && leg.ankle) {
    const knee: V3 = [leg.knee[0] * side, leg.knee[1], leg.knee[2]];
    const ankle: V3 = [leg.ankle[0] * side, leg.ankle[1], leg.ankle[2]];
    b.capsule(group, leg.paint, [x, hy, hz], knee, leg.radius * 1.25, { shadow: true });
    b.capsule(group, leg.paint, knee, ankle, leg.radius, { shadow: true });
    const a = -(leg.footYaw ?? 0) * side;
    const foot: V3 = [ankle[0], footY, ankle[2] + leg.footZ];
    b.sphere(group, leg.footPaint, foot, leg.foot, { rot: [0, a, 0], shadow: true, flair: true, detail: "lo" });
    const toes = leg.toes ?? 0;
    const c = Math.cos(a);
    const s = Math.sin(a);
    for (let i = 0; i < toes; i++) {
      const k = toes === 1 ? 0 : (i / (toes - 1)) * 2 - 1;
      const lx = k * leg.foot[0] * 0.75;
      const lz = -leg.foot[2] * 0.85 + Math.abs(k) * 0.04;
      const rx = lx * c + lz * s;
      const rz = -lx * s + lz * c;
      b.sphere(group, leg.padPaint ?? leg.footPaint, [foot[0] + rx, footY + 0.005, foot[2] + rz], [0.05, 0.03, 0.05], {
        detail: "xs",
        outline: false,
        flair: true,
        hiOnly: true,
      });
    }
    return group;
  }
  b.capsule(group, leg.paint, [x, hy, hz], [x, footY + leg.foot[1] * 0.6, hz], leg.radius, { shadow: true });
  const foot: V3 = [x, footY, hz + leg.footZ];
  if (leg.hoof) {
    for (const k of [-1, 1]) {
      b.sphere(group, leg.footPaint, [x + k * leg.foot[0] * 0.48, footY, hz + leg.footZ], [leg.foot[0] * 0.55, leg.foot[1], leg.foot[2]], {
        detail: "xs",
        shadow: true,
      });
    }
  } else {
    b.sphere(group, leg.footPaint, foot, leg.foot, { detail: "lo", shadow: true });
  }
  const toes = leg.toes ?? 0;
  for (let i = 0; i < toes; i++) {
    const k = toes === 1 ? 0 : (i / (toes - 1)) * 2 - 1;
    b.sphere(
      group,
      leg.footPaint,
      [x + k * leg.foot[0] * 0.62, footY + 0.004, hz + leg.footZ - leg.foot[2] * 0.82 + Math.abs(k) * 0.035],
      [leg.foot[0] * 0.36, leg.foot[1] * 0.85, leg.foot[0] * 0.36],
      { detail: "xs", outline: false, hiOnly: true },
    );
  }
  if (leg.padPaint && !leg.toes) {
    b.sphere(group, leg.padPaint, [x, footY - leg.foot[1] * 0.2, hz + leg.footZ - leg.foot[2] * 0.75], [leg.foot[0] * 0.6, leg.foot[1] * 0.55, 0.03], {
      detail: "xs",
      outline: false,
      hiOnly: true,
    });
  }
  return group;
}

/** Wispy tail that replaces the legs in ghost form (hidden otherwise). */
function buildGhostTail(b: PartBuilder, model: THREE.Group, spec: BodySpec): THREE.Group {
  const top = spec.torso.y - spec.torso.r[1] * 0.4;
  const group = b.group(model, [0, top, 0], "ghostTail");
  const r = spec.torso.r[0] * 0.92;
  b.cone(group, spec.ghostPaint, [0, top, 0.02], [0.05, top - 0.42, 0.14], r, { segments: 10, outline: false });
  group.visible = false;
  return group;
}

/** Feet-space vector helper for mirrored parts. */
export function mirror(at: V3, side: 1 | -1): V3 {
  return [at[0] * side, at[1], at[2]];
}

/** Feet-space offset helper. */
export function add(a: V3, x: number, y: number, z: number): V3 {
  return [a[0] + x, a[1] + y, a[2] + z];
}

export type ModelRegistry = Record<CharacterId, { spec: BodySpec; build: CharacterBuilder; memento: MementoBuilder }>;

/** Builds the floating KO memento (hat, bow tie, bell…) centered on its own origin. */
export type MementoBuilder = (b: PartBuilder, parent: THREE.Group) => void;
