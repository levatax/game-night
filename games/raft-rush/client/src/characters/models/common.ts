// The shared bean body every Ship Tourist is built on, and the builder the six character files use to place
// colored primitives. Primitives are authored in "feet space" (rest pose: feet at y = 0, facing −Z, +X = the
// character's right) and baked per BONE into one vertex-colored geometry (+ one smooth outline hull), so a
// tourist is ~8 meshes instead of ~80 and every instance of a character shares the same geometries.
// Owner: client-characters.
//
// Bone hierarchy (Tourist.ts builds the groups):
//   root (world position, yaw) > offset (lift / lean, pivot at the feet) > body (squash & stretch)
//   > spin (rolls / flips around SPIN_Y) > model > { legL, legR (hip pivots), upper (waist pivot: twist / bend)
//   > { head (neck pivot) > { eyes, mouth, extra? }, armL, armR (shoulder pivots), extra? } }

import * as THREE from "three";
import type { CharacterDef } from "../../../../shared/constants";
import {
  alongMatrix,
  aimMatrix,
  boxGeo,
  capsuleGeo,
  coneGeo,
  cylinderGeo,
  domeGeo,
  latheGeo,
  mergePrims,
  type Prim,
  sphereGeo,
  torusGeo,
  trs,
  type V3,
} from "../kit";

/** Center of mass pivot for rolls, tumbles and the crawl pose. */
export const SPIN_Y = 0.78;

export type BoneName = "upper" | "head" | "armL" | "armR" | "legL" | "legR" | "extra" | "eyes" | "mouthSmile" | "mouthOpen";
export const MESH_BONES: ReadonlyArray<BoneName> = ["upper", "head", "armL", "armR", "legL", "legR", "extra"];

/** A paint is a character color role, a fixed role or a literal "#RRGGBB". */
export type Paint = keyof CharacterDef["colors"] | "ink" | "white" | "cheek" | `#${string}`;

/** Proportions of one tourist (feet space, before `scale`). */
export interface TouristSpec {
  /** Overall scale (the Floatie Kid is small). */
  scale: number;
  /** Hip pivot (right side; mirrored) and leg radius / foot ellipsoid radii and forward offset. */
  hip: V3;
  legRadius: number;
  foot: V3;
  footZ: number;
  /** Waist pivot height (upper body). */
  waistY: number;
  /** Neck pivot height and the head ellipsoid. */
  neckY: number;
  headAt: V3;
  headR: V3;
  /** Shoulder pivot (right side; mirrored), arm length (to the hand center), sleeve and hand radii. */
  shoulder: V3;
  armLength: number;
  armRadius: number;
  handR: number;
  /** Eye centers (right eye; mirrored), eye ellipsoid radii, mouth center and width. */
  eyeAt: V3;
  eyeR: V3;
  mouthAt: V3;
  mouthW: number;
  /** Lip / mouth inside color. */
  mouthColor: string;
  /** Extra animated bone (veil, toque, propeller, duck head...): pivot and parent. null = none. */
  extra: { at: V3; parent: "head" | "upper" } | null;
  /** Top of the model incl. hats (nameplate anchor sits above). */
  topY: number;
  /** Hide the eyes mesh (sunglasses). */
  hideEyes: boolean;
}

/** One bone's bake output (shared by every instance of the character). */
export interface BoneBake {
  geometry: THREE.BufferGeometry;
  /** Only the outlined primitives (null: nothing outlined). */
  outline: THREE.BufferGeometry | null;
  /** Pivot in feet space. */
  pivot: THREE.Vector3;
}

export interface TouristBake {
  spec: TouristSpec;
  bones: Partial<Record<BoneName, BoneBake>>;
  /** Pivots in feet space of every bone (also the empty ones). */
  pivots: Record<BoneName, THREE.Vector3>;
  /** Right-hand grip (held items) and left-hand grip (signature props), feet space. */
  gripR: THREE.Vector3;
  gripL: THREE.Vector3;
  /** An emissive ring (Fenomen's ring light), feet space, or null. */
  glow: GlowSpec | null;
  /** Wristband (seat color) center + radius on the left wrist, feet space. */
  bandAt: THREE.Vector3;
  bandR: number;
}

/** Emissive torus attached to a bone (animated per instance: the selfie flash). */
export interface GlowSpec {
  bone: BoneName;
  at: THREE.Vector3;
  axis: THREE.Vector3;
  radius: number;
  tube: number;
  color: string;
}

export interface PrimOptions {
  /** Part of the outline hull (default true for bigger parts). */
  outline?: boolean;
}

interface BonePrims {
  pivot: THREE.Vector3;
  prims: Prim[];
  outlined: Prim[];
}

const BONE_PARENT: Record<BoneName, BoneName | "model"> = {
  upper: "model",
  head: "upper",
  armL: "upper",
  armR: "upper",
  legL: "model",
  legR: "model",
  extra: "head",
  eyes: "head",
  mouthSmile: "head",
  mouthOpen: "head",
};

export function boneParent(name: BoneName, spec: TouristSpec): BoneName | "model" {
  if (name === "extra") return spec.extra?.parent ?? "head";
  return BONE_PARENT[name];
}

/**
 * Places primitives in feet space and remembers which bone they belong to. `colors` resolves paints.
 * After the character's build function ran, `bake()` merges everything per bone.
 */
export class ModelBuilder {
  private readonly bones = new Map<BoneName, BonePrims>();
  readonly pivots: Record<BoneName, THREE.Vector3>;
  gripR = new THREE.Vector3();
  gripL = new THREE.Vector3();
  glow: GlowSpec | null = null;
  bandAt = new THREE.Vector3();
  bandR = 0.05;

  constructor(
    readonly spec: TouristSpec,
    private readonly colors: CharacterDef["colors"],
  ) {
    const s = spec;
    const v = (a: V3) => new THREE.Vector3(a[0], a[1], a[2]);
    this.pivots = {
      upper: new THREE.Vector3(0, s.waistY, 0),
      head: new THREE.Vector3(0, s.neckY, 0),
      armR: v(s.shoulder),
      armL: new THREE.Vector3(-s.shoulder[0], s.shoulder[1], s.shoulder[2]),
      legR: v(s.hip),
      legL: new THREE.Vector3(-s.hip[0], s.hip[1], s.hip[2]),
      extra: s.extra ? v(s.extra.at) : new THREE.Vector3(0, s.neckY, 0),
      eyes: new THREE.Vector3(0, s.eyeAt[1], s.eyeAt[2]),
      mouthSmile: v(s.mouthAt),
      mouthOpen: v(s.mouthAt),
    };
  }

  color(paint: Paint): THREE.Color {
    switch (paint) {
      case "ink":
        return new THREE.Color("#2D2A32");
      case "white":
        return new THREE.Color("#FFFFFF");
      case "cheek":
        return new THREE.Color("#FF8F8F");
      case "outfit":
      case "accent":
      case "skin":
      case "hair":
        return new THREE.Color(this.colors[paint]);
      default:
        return new THREE.Color(paint);
    }
  }

  /** Add a primitive given in feet space by `matrix`. */
  add(bone: BoneName, geometry: THREE.BufferGeometry, paint: Paint, matrix: THREE.Matrix4, opts: PrimOptions = {}): void {
    let entry = this.bones.get(bone);
    if (!entry) {
      entry = { pivot: this.pivots[bone], prims: [], outlined: [] };
      this.bones.set(bone, entry);
    }
    const local = new THREE.Matrix4().makeTranslation(-entry.pivot.x, -entry.pivot.y, -entry.pivot.z).multiply(matrix);
    const prim: Prim = { geometry, matrix: local, color: this.color(paint) };
    entry.prims.push(prim);
    if (opts.outline ?? true) entry.outlined.push(prim);
  }

  /** Ellipsoid at `at` with radii `r`, optional rotation (euler XYZ). */
  sphere(bone: BoneName, paint: Paint, at: V3, r: number | V3, detail = 10, opts?: PrimOptions & { rot?: V3 }): void {
    this.add(bone, sphereGeo(detail), paint, trs(at, opts?.rot ?? [0, 0, 0], r), opts);
  }

  /** Dome (half ellipsoid, flat side down) at `at`. */
  dome(bone: BoneName, paint: Paint, at: V3, r: number | V3, detail = 10, opts?: PrimOptions & { rot?: V3 }): void {
    this.add(bone, domeGeo(detail), paint, trs(at, opts?.rot ?? [0, 0, 0], r), opts);
  }

  /** Capsule between two cap centers. */
  capsule(bone: BoneName, paint: Paint, from: V3, to: V3, radius: number, radial = 7, opts?: PrimOptions): void {
    const len = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const mid: V3 = [(from[0] + to[0]) / 2, (from[1] + to[1]) / 2, (from[2] + to[2]) / 2];
    const axis: V3 = len > 1e-6 ? [to[0] - from[0], to[1] - from[1], to[2] - from[2]] : [0, 1, 0];
    this.add(bone, capsuleGeo(radius, Math.max(0.001, len), radial), paint, aimMatrix(mid, axis), opts);
  }

  /** Cylinder from `base` to `top` (top radius = radius · topRatio). */
  cylinder(bone: BoneName, paint: Paint, base: V3, top: V3, radius: number, topRatio = 1, radial = 8, opts?: PrimOptions & { open?: boolean }): void {
    this.add(bone, cylinderGeo(topRatio, radial, opts?.open ?? false), paint, alongMatrix(base, top, radius), opts);
  }

  /** Flattened cylinder ("disc") centered at `at` facing `axis`. */
  disc(bone: BoneName, paint: Paint, at: V3, axis: V3, radius: number, thickness: number, radial = 10, opts?: PrimOptions): void {
    const n = Math.hypot(axis[0], axis[1], axis[2]) || 1;
    const h = thickness / 2;
    const base: V3 = [at[0] - (axis[0] / n) * h, at[1] - (axis[1] / n) * h, at[2] - (axis[2] / n) * h];
    const top: V3 = [at[0] + (axis[0] / n) * h, at[1] + (axis[1] / n) * h, at[2] + (axis[2] / n) * h];
    this.cylinder(bone, paint, base, top, radius, 1, radial, opts);
  }

  cone(bone: BoneName, paint: Paint, base: V3, tip: V3, radius: number, radial = 6, opts?: PrimOptions): void {
    this.add(bone, coneGeo(radial), paint, alongMatrix(base, tip, radius), opts);
  }

  /** Ring around `axis` centered at `at` (radius, tube). `arc` < 2π for open curls; `spin` turns the gap. */
  torus(
    bone: BoneName,
    paint: Paint,
    at: V3,
    radius: number,
    tube: number,
    axis: V3 = [0, 1, 0],
    opts?: PrimOptions & { arc?: number; spin?: number; scale?: V3; radial?: number; tubular?: number },
  ): void {
    const geo = torusGeo(tube / radius, opts?.arc ?? Math.PI * 2, opts?.radial ?? 3, opts?.tubular ?? 10);
    const m = aimMatrix(at, axis, opts?.scale ? [radius * opts.scale[0], radius * opts.scale[1], radius * opts.scale[2]] : radius);
    if (opts?.spin) m.multiply(new THREE.Matrix4().makeRotationY(opts.spin));
    this.add(bone, geo, paint, m, opts);
  }

  box(bone: BoneName, paint: Paint, at: V3, size: V3, rot: V3 = [0, 0, 0], opts?: PrimOptions): void {
    this.add(bone, boxGeo(), paint, trs(at, rot, size), opts);
  }

  /** Lathe profile (radius, height) placed at `at`, scaled (sx, sy, sz). */
  lathe(bone: BoneName, paint: Paint, key: string, profile: ReadonlyArray<readonly [number, number]>, at: V3, scale: V3 = [1, 1, 1], segments = 12, opts?: PrimOptions & { rot?: V3 }): void {
    this.add(bone, latheGeo(key, profile, segments), paint, trs(at, opts?.rot ?? [0, 0, 0], scale), opts);
  }

  /** Merge every bone. */
  bake(): TouristBake {
    const bones: Partial<Record<BoneName, BoneBake>> = {};
    for (const [name, entry] of this.bones) {
      if (entry.prims.length === 0) continue;
      bones[name] = {
        geometry: mergePrims(entry.prims),
        outline: entry.outlined.length ? mergePrims(entry.outlined) : null,
        pivot: entry.pivot,
      };
    }
    return {
      spec: this.spec,
      bones,
      pivots: this.pivots,
      gripR: this.gripR,
      gripL: this.gripL,
      glow: this.glow,
      bandAt: this.bandAt,
      bandR: this.bandR,
    };
  }
}

/* ================================================================ shared body */

/** Paints for the shared parts of the bean body. */
export interface BodyLook {
  /** Upper body / sleeves. */
  shirt: Paint;
  sleeve: Paint;
  /** Sleeve ends this far down the arm (0 = sleeveless, 1 = full length to the wrist). */
  sleeveLength: number;
  /** Pants / skirt paint for the legs (skin = bare legs). */
  legs: Paint;
  /** Pants end this far down the leg (0..1; the rest is skin). */
  pantsLength: number;
  shoes: Paint;
  hands: Paint;
  /** Bare forearm below a short sleeve (default skin; opera gloves = white). */
  forearm?: Paint;
  /** Torso lathe profile (radius, height) from the hips up to the shoulders. */
  torso: ReadonlyArray<readonly [number, number]>;
  torsoKey: string;
  /** Torso depth relative to its width. */
  torsoDepth: number;
  /** Hide the feet (dresses / flippers draw their own). */
  noFeet?: boolean;
}

/** Bean torsos (radius, height) in feet space before the spec scale. */
export const TORSO_REGULAR: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.33],
  [0.2, 0.35],
  [0.27, 0.42],
  [0.3, 0.55],
  [0.3, 0.7],
  [0.285, 0.86],
  [0.25, 1.0],
  [0.19, 1.1],
  [0.1, 1.16],
  [0.0, 1.18],
];

/**
 * The common parts: bean torso, head ball, sleeves + hands, legs + feet, and the hand grips / wristband.
 * Character files add clothes, hair, hats, faces and props on top.
 */
export function buildBody(b: ModelBuilder, look: BodyLook): void {
  const s = b.spec;
  b.lathe("upper", look.shirt, look.torsoKey, look.torso, [0, 0, 0], [1, 1, look.torsoDepth], 10);
  b.sphere("head", "skin", s.headAt, s.headR, 10);

  for (const side of [1, -1] as const) {
    const arm: BoneName = side > 0 ? "armR" : "armL";
    const sx = s.shoulder[0] * side;
    const top: V3 = [sx, s.shoulder[1], s.shoulder[2]];
    const handY = s.shoulder[1] - s.armLength;
    const hand: V3 = [sx * 1.04, handY, s.shoulder[2]];
    const sleeveEnd = s.shoulder[1] - s.armLength * Math.max(0.12, look.sleeveLength) * 0.92;
    // Shoulder ball in the shirt color so the joint never opens; limbs are tubes whose ends hide in the balls.
    b.sphere(arm, look.sleeve, top, s.armRadius * 1.25, 5);
    b.cylinder(arm, look.sleeve, [sx * 1.02, sleeveEnd, s.shoulder[2]], top, s.armRadius * 1.04, 1.12, 6, { open: true });
    if (look.sleeveLength < 0.98) b.cylinder(arm, look.forearm ?? "skin", [sx * 1.04, handY + s.handR * 0.5, s.shoulder[2]], [sx * 1.02, sleeveEnd + 0.01, s.shoulder[2]], s.armRadius * 0.82, 1.1, 6, { open: true });
    b.sphere(arm, look.hands, hand, [s.handR, s.handR * 1.1, s.handR * 0.95], 6);
    // Thumb bump.
    b.sphere(arm, look.hands, [hand[0] - side * s.handR * 0.55, hand[1] + s.handR * 0.25, hand[2] - s.handR * 0.45], s.handR * 0.42, 4, { outline: false });
    const grip = new THREE.Vector3(hand[0], handY - s.handR * 0.35, hand[2] - s.handR * 0.4);
    if (side > 0) b.gripR.copy(grip);
    else {
      b.gripL.copy(grip);
      b.bandAt.set(hand[0], handY + s.handR * 1.25, hand[2]);
      b.bandR = s.armRadius * 0.95;
    }

    const leg: BoneName = side > 0 ? "legR" : "legL";
    const hx = s.hip[0] * side;
    const footY = s.foot[1];
    const kneeEnd = s.hip[1] - (s.hip[1] - footY) * Math.max(0.05, look.pantsLength);
    b.cylinder(leg, look.legs, [hx, Math.max(kneeEnd, footY + 0.06), s.hip[2]], [hx, s.hip[1] + 0.02, s.hip[2]], s.legRadius * (look.legs === "skin" ? 0.9 : 1.08), 1.08, 6, { open: true });
    if (look.pantsLength < 0.98) b.cylinder(leg, "skin", [hx, footY + s.foot[1] * 0.4, s.hip[2]], [hx, kneeEnd + 0.01, s.hip[2]], s.legRadius * 0.82, 1.1, 6, { open: true });
    if (!look.noFeet) b.sphere(leg, look.shoes, [hx, footY, s.hip[2] + s.footZ], s.foot, 6);
  }
}

/** Two ink eye ellipsoids with white glints (the "eyes" bone) + both mouth shapes. */
export function buildFace(b: ModelBuilder): void {
  const s = b.spec;
  for (const side of [1, -1]) {
    const at: V3 = [s.eyeAt[0] * side, s.eyeAt[1], s.eyeAt[2]];
    b.sphere("eyes", "ink", at, s.eyeR, 6, { outline: false, rot: [0, side * 0.32, 0] });
    b.sphere("eyes", "white", [at[0] + s.eyeR[0] * 0.3, at[1] + s.eyeR[1] * 0.38, at[2] - s.eyeR[2] * 0.75], s.eyeR[0] * 0.36, 4, { outline: false });
  }
  const m = s.mouthAt;
  // Smile: a half ring curving up, tilted onto the face.
  b.torus("mouthSmile", "ink", m, s.mouthW, s.mouthW * 0.22, [0, 0, 1], { outline: false, arc: Math.PI, spin: 0, tubular: 6 });
  // Open mouth: dark oval + tongue.
  b.sphere("mouthOpen", s.mouthColor as Paint, m, [s.mouthW * 0.75, s.mouthW * 0.7, s.mouthW * 0.35], 6, { outline: false });
  b.sphere("mouthOpen", "#FF7A8A", [m[0], m[1] - s.mouthW * 0.32, m[2] - s.mouthW * 0.12], [s.mouthW * 0.45, s.mouthW * 0.25, s.mouthW * 0.22], 4, { outline: false });
}

/** A point on the head ellipsoid surface at (yaw from the front, height fraction −1..1). */
export function onHead(spec: TouristSpec, yaw: number, up: number, lift = 1.0): V3 {
  const [cx, cy, cz] = spec.headAt;
  const [rx, ry, rz] = spec.headR;
  const c = Math.cos(Math.asin(Math.max(-1, Math.min(1, up))));
  return [cx + Math.sin(yaw) * c * rx * lift, cy + up * ry * lift, cz - Math.cos(yaw) * c * rz * lift];
}

/** Radius of a lathe profile at height `y` (linear between points). */
export function profileRadius(profile: ReadonlyArray<readonly [number, number]>, y: number): number {
  for (let i = 1; i < profile.length; i++) {
    const [r1, y1] = profile[i]!;
    const [r0, y0] = profile[i - 1]!;
    if (y <= y1) return y1 - y0 > 1e-6 ? r0 + ((r1 - r0) * (y - y0)) / (y1 - y0) : r1;
  }
  return profile[profile.length - 1]![0];
}

/** A point on the torso surface at yaw (0 = front) and height y, with its outward normal. */
export function onTorso(profile: ReadonlyArray<readonly [number, number]>, depth: number, yaw: number, y: number, lift = 1.004): { at: V3; normal: V3 } {
  const r = profileRadius(profile, y) * lift;
  const nx = Math.sin(yaw);
  const nz = -Math.cos(yaw);
  return { at: [nx * r, y, nz * r * depth], normal: [nx, 0, nz * depth] };
}

/** Matrix for a flat decal (unit, facing +Z) placed at a surface point with `normal`, size `r`, spin around the normal. */
export function decalMatrix(at: V3, normal: V3, r: number, spin = 0): THREE.Matrix4 {
  const n = new THREE.Vector3(normal[0], normal[1], normal[2]).normalize();
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), n);
  q.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), spin));
  return new THREE.Matrix4().compose(new THREE.Vector3(at[0], at[1], at[2]), q, new THREE.Vector3(r, r, r));
}

/** Default proportions; character files spread this and override. */
export const BASE_SPEC: TouristSpec = {
  scale: 1,
  hip: [0.13, 0.42, 0],
  legRadius: 0.085,
  foot: [0.1, 0.07, 0.15],
  footZ: -0.045,
  waistY: 0.62,
  neckY: 1.12,
  headAt: [0, 1.4, -0.01],
  headR: [0.255, 0.245, 0.24],
  shoulder: [0.29, 1.0, 0],
  armLength: 0.44,
  armRadius: 0.068,
  handR: 0.082,
  eyeAt: [0.085, 1.44, -0.225],
  eyeR: [0.034, 0.05, 0.022],
  mouthAt: [0, 1.31, -0.232],
  mouthW: 0.05,
  mouthColor: "#6B2230",
  extra: null,
  topY: 1.66,
  hideEyes: false,
};
