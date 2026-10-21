// The first-person cartoon hand: a rigidly skinned mesh with one bone per phalanx (four fingers × 3 and a
// thumb × 3 under the wrist), a soft rounded palm with knuckle bumps, fleshy thenar / heel pads, fingernails, the
// character's little extras (rings, nail polish, glove stitches, a band-aid, a sticker), and an ink hull that
// shares the skeleton. Poses are joint angles (HandPose); named poses cover the gestures and the parametric ones
// the holds: grip(R) wraps a handle of radius R (the thumb wrapped over it or lying along it), cup(Rs) holds a
// ball of radius Rs. The pose tables were solved by forward kinematics on this exact geometry (fingertips on
// the palm in a fist, pads touching in a pinch, phalanges on the handle surface within a millimetre) — re-solve
// them if the finger layout changes. Owner: client-characters.
//
// Hand frame (as in fpArms.ts): origin at the wrist, fingers along −Z, back of the hand +Y, palm −Y. `inner`
// is the thumb side (−1 = −X for the right hand, +1 for the left). "auth" = authoring units: × HandLook.scale = m.

import * as THREE from "three";
import { capsuleGeo, flowerGeo, mergePrims, type Prim, sphereGeo, superSphereGeo, torusGeo, trs, type V3 } from "./kit";

/** Joint values of one hand: per finger (index, middle, ring, pinky) [spread, base, middle, tip] flexion, then
 * the thumb [swing across the palm, lift away from it, roll, base, tip]. Flexion is toward the palm (radians). */
export const HAND_DOF = 21;
export type HandPose = Float32Array;
/** Offset of the thumb values in a HandPose. */
const THUMB = 16;

export type HandPoseName =
  | "open"
  | "relaxed"
  | "fist"
  | "grip"
  | "gripWide"
  | "cup"
  | "pinch"
  | "pinchFancy"
  | "tray"
  | "point"
  | "splay"
  | "claw"
  | "hook"
  | "flat"
  | "aim"
  | "paddle";

type FingerVals = readonly [number, number, number, number];
type ThumbVals = readonly [number, number, number, number, number];

function makePose(fingers: readonly [FingerVals, FingerVals, FingerVals, FingerVals], thumb: ThumbVals): HandPose {
  const p = new Float32Array(HAND_DOF);
  fingers.forEach((f, i) => p.set(f, i * 4));
  p.set(thumb, THUMB);
  return p;
}

const FIST_I: FingerVals = [0, 1.24, 1.38, 1.0];
const FIST_M: FingerVals = [0, 1.34, 1.5, 0.8];
const FIST_R: FingerVals = [0, 1.3, 1.5, 0.8];
const FIST_P: FingerVals = [0, 1.1, 1.3, 0.95];
const FIST_T: ThumbVals = [0.91, -0.5, 1.69, 0.88, 0.11];
const PINCH_I: FingerVals = [0.02, 0.72, 0.82, 0.4];
const PINCH_T: ThumbVals = [0.23, 0.11, 0.66, 0.23, 0.32];

/* ---------------------------------------------------------------- parametric poses (FK-solved) */

/** grip(R) knots: handle radius (auth) → [mcp, pip, dip] of index, middle, ring, pinky (spread 0). */
const GRIP_R = [0.0081, 0.0101, 0.0113, 0.0145, 0.0178, 0.021] as const;
const GRIP_F: readonly (readonly [V3, V3, V3, V3])[] = [
  [
    [0.64, 1.04, 0.84],
    [1.0, 1.14, 0.92],
    [1.12, 1.08, 0.84],
    [1.08, 0.84, 0.68],
  ],
  [
    [0.6, 0.94, 0.76],
    [0.94, 1.04, 0.84],
    [1.06, 0.96, 0.8],
    [1.0, 0.76, 0.6],
  ],
  [
    [0.6, 0.86, 0.72],
    [0.9, 1.0, 0.76],
    [1.02, 0.92, 0.72],
    [0.98, 0.7, 0.56],
  ],
  [
    [0.56, 0.74, 0.6],
    [0.84, 0.86, 0.64],
    [0.96, 0.76, 0.64],
    [0.92, 0.54, 0.44],
  ],
  [
    [0.54, 0.62, 0.52],
    [0.8, 0.72, 0.6],
    [0.9, 0.64, 0.56],
    [0.86, 0.44, 0.36],
  ],
  [
    [0.52, 0.52, 0.44],
    [0.76, 0.62, 0.52],
    [0.84, 0.58, 0.48],
    [0.8, 0.4, 0.32],
  ],
];
/** The thumb wrapped over the handle where it leaves the fist (spear, axe, torch, gourd, skewer...). */
const WRAP_R = [0.0081, 0.0113, 0.0145, 0.021] as const;
const WRAP_T: readonly ThumbVals[] = [
  [0.53, 0.7, 0.76, 0.78, 0.77],
  [0.67, 0.54, 0.56, 0.5, 0.69],
  [0.71, 0.35, 0.45, 0.29, 0.57],
  [0.83, 0.13, 0.36, 0.27, 0.57],
];
/** The thumb lying along the handle, pointing up the tool (rod, spear aim). */
const ALONG_R = [0.0145, 0.021] as const;
const ALONG_T: readonly ThumbVals[] = [
  [0.14, 0.3, 0.76, -0.14, -0.6],
  [0.15, 0.34, 0.69, -0.42, -0.54],
];
/** cup(Rs) knots: ball radius (auth) → [spread, mcp, pip, dip] per finger; the thumb presses the side. */
const CUP_R = [0.036, 0.052] as const;
const CUP_F: readonly (readonly [FingerVals, FingerVals, FingerVals, FingerVals])[] = [
  [
    [0.1, 0.82, 0.2, 0],
    [0.03, 0.58, 0.42, 0.4],
    [0.03, 0.52, 0.42, 0.36],
    [0.1, 0.76, 0.02, 0],
  ],
  [
    [0.1, 0.6, 0.14, 0],
    [0.03, 0.42, 0.36, 0.28],
    [0.03, 0.38, 0.32, 0.32],
    [0.1, 0.52, 0.04, 0],
  ],
];
const CUP_T: ThumbVals = [0.5, 0.25, 0.35, 0.2, 0.25];

/** Index into knots and the blend toward the next one (clamped at the ends). */
function knot(ks: readonly number[], x: number): [number, number] {
  if (x <= ks[0]!) return [0, 0];
  for (let i = 1; i < ks.length; i++) if (x <= ks[i]!) return [i - 1, (x - ks[i - 1]!) / (ks[i]! - ks[i - 1]!)];
  return [ks.length - 2, 1];
}

const lerpN = (a: number, b: number, w: number): number => a + (b - a) * w;

/** Fingers around a handle of radius R (auth), the thumb wrapped over it or lying along it; `rod` lifts the index off. */
export function gripPose(out: HandPose, R: number, thumb: "wrap" | "along" = "wrap", rod = false): HandPose {
  const [i, w] = knot(GRIP_R, R);
  for (let f = 0; f < 4; f++) {
    const a = GRIP_F[i]![f]!;
    const b = GRIP_F[i + 1]![f]!;
    out[f * 4] = 0;
    for (let j = 0; j < 3; j++) out[f * 4 + 1 + j] = lerpN(a[j]!, b[j]!, w);
  }
  if (rod) out.set([0, 0.5, 0.6, 0.3], 0);
  if (thumb === "along") {
    const [ti, tw] = knot(ALONG_R, Math.max(R, ALONG_R[0]));
    for (let j = 0; j < 5; j++) out[THUMB + j] = lerpN(ALONG_T[ti]![j]!, ALONG_T[ti + 1]![j]!, tw);
  } else {
    const [ti, tw] = knot(WRAP_R, R);
    for (let j = 0; j < 5; j++) out[THUMB + j] = lerpN(WRAP_T[ti]![j]!, WRAP_T[ti + 1]![j]!, tw);
  }
  return out;
}

/** Fingers cupped under a ball of radius Rs (auth); the outer fingers stay straighter, as around a big ball. */
export function cupPose(out: HandPose, Rs: number): HandPose {
  const [i, w] = knot(CUP_R, Rs);
  for (let f = 0; f < 4; f++) for (let j = 0; j < 4; j++) out[f * 4 + j] = lerpN(CUP_F[i]![f]![j]!, CUP_F[i + 1]![f]![j]!, w);
  out.set(CUP_T, THUMB);
  return out;
}

const POSES: Record<HandPoseName, HandPose> = {
  open: makePose(
    [
      [0.14, 0.04, 0.06, 0.04],
      [0.06, 0.03, 0.05, 0.04],
      [0.08, 0.05, 0.06, 0.05],
      [0.16, 0.07, 0.08, 0.06],
    ],
    [0.0, 0.35, 0.0, 0.05, 0.08],
  ),
  relaxed: makePose(
    [
      [0.06, 0.22, 0.42, 0.24],
      [0.03, 0.32, 0.52, 0.3],
      [0.04, 0.42, 0.6, 0.34],
      [0.08, 0.52, 0.68, 0.38],
    ],
    [0.28, 0.12, 0.25, 0.2, 0.3],
  ),
  // Fingertips resting on the palm, the thumb pad pressed across the index and middle.
  fist: makePose([FIST_I, FIST_M, FIST_R, FIST_P], FIST_T),
  // A mid-size handle (≈ a 14 mm shaft for Kaptan) and a thick one (a gourd neck, a boot top).
  grip: gripPose(new Float32Array(HAND_DOF), 0.0113),
  gripWide: gripPose(new Float32Array(HAND_DOF), 0.021),
  cup: cupPose(new Float32Array(HAND_DOF), 0.044),
  // Thumb and index pads touching.
  pinch: makePose(
    [
      PINCH_I,
      [0, 1.0, 1.25, 0.62],
      [0, 1.2, 1.42, 0.7],
      [0.04, 1.32, 1.48, 0.72],
    ],
    PINCH_T,
  ),
  // The same with the other fingers fanned out, pinky up (holding something nasty, or very fancy).
  pinchFancy: makePose(
    [
      PINCH_I,
      [0.03, 0.45, 0.5, 0.25],
      [0.06, 0.3, 0.3, 0.15],
      [0.3, -0.1, 0.05, 0.05],
    ],
    PINCH_T,
  ),
  // Palm up, flat and a little curled at the tips (offering / carrying from below).
  tray: makePose(
    [
      [0.1, 0.12, 0.16, 0.1],
      [0.04, 0.1, 0.15, 0.1],
      [0.05, 0.13, 0.17, 0.11],
      [0.12, 0.17, 0.2, 0.13],
    ],
    [0.05, 0.45, 0.05, 0.05, 0.12],
  ),
  point: makePose([[0.02, 0.06, 0.06, 0.04], FIST_M, FIST_R, FIST_P], FIST_T),
  // Fingers flung wide (AAAH).
  splay: makePose(
    [
      [0.4, -0.12, -0.04, 0.02],
      [0.14, -0.1, -0.03, 0.02],
      [0.18, -0.1, -0.03, 0.02],
      [0.42, -0.08, -0.02, 0.03],
    ],
    [-0.25, 0.6, -0.1, -0.1, -0.05],
  ),
  // Tense grab (catching, the off hand bracing).
  claw: makePose(
    [
      [0.22, 0.55, 1.0, 0.75],
      [0.08, 0.6, 1.05, 0.78],
      [0.08, 0.62, 1.05, 0.78],
      [0.22, 0.65, 1.02, 0.74],
    ],
    [0.4, 0.35, 0.4, 0.4, 0.55],
  ),
  // Fingers hooked under an edge or through a loop (two-handed carry, a rope coil).
  hook: makePose(
    [
      [0.04, 0.85, 1.05, 0.55],
      [0.02, 0.9, 1.08, 0.56],
      [0.02, 0.94, 1.08, 0.55],
      [0.06, 0.98, 1.06, 0.52],
    ],
    [0.2, 0.45, 0.2, 0.15, 0.2],
  ),
  // Straight and together (place, push, clap, CPR).
  flat: makePose(
    [
      [0.0, 0.0, 0.035, 0.024],
      [0.0, 0.0, 0.035, 0.024],
      [0.0, 0.0, 0.035, 0.024],
      [0.0, 0.0, 0.035, 0.024],
    ],
    [0.12, 0.3, 0.1, 0.05, 0.05],
  ),
  // The off hand guiding a throw: open, a little cupped, fingers apart.
  aim: makePose(
    [
      [0.1, 0.16, 0.26, 0.12],
      [0.06, 0.16, 0.26, 0.12],
      [0.06, 0.18, 0.28, 0.13],
      [0.1, 0.2, 0.3, 0.14],
    ],
    [0.1, 0.32, 0.08, 0.08, 0.1],
  ),
  // Swim pull: slightly cupped, fingers together.
  paddle: makePose(
    [
      [-0.02, 0.19, 0.26, 0.12],
      [-0.02, 0.19, 0.26, 0.12],
      [-0.02, 0.2, 0.27, 0.13],
      [-0.02, 0.22, 0.28, 0.14],
    ],
    [0.25, 0.25, 0.2, 0.06, 0.08],
  ),
};

/** A named pose (shared, read-only). */
export function handPose(name: HandPoseName): HandPose {
  return POSES[name];
}

/** out = a + (b − a)·w. */
export function blendPose(out: HandPose, a: ArrayLike<number>, b: ArrayLike<number>, w: number): HandPose {
  for (let i = 0; i < HAND_DOF; i++) out[i] = a[i]! + (b[i]! - a[i]!) * w;
  return out;
}

/** Blend `out` toward pose `name` by w (in place). */
export function mixPose(out: HandPose, name: HandPoseName, w: number): HandPose {
  return blendPose(out, out, POSES[name], w);
}

/** Old-style single curl 0..1 (0 open, 0.5 relaxed, 1 fist) as a pose. */
export function curlPose(out: HandPose, c: number): HandPose {
  const k = c < 0 ? 0 : c > 1 ? 1 : c;
  return k < 0.5 ? blendPose(out, POSES.open, POSES.relaxed, k * 2) : blendPose(out, POSES.relaxed, POSES.fist, (k - 0.5) * 2);
}

/** Joint ranges (rad): per finger [spread, mcp, pip, dip], then the thumb's five values. */
const LO = Float32Array.from([...[0, 1, 2, 3].flatMap(() => [-0.2, -0.35, -0.05, -0.25]), -0.3, -0.6, -0.3, -0.2, -0.6]);
const HI = Float32Array.from([...[0, 1, 2, 3].flatMap(() => [0.5, 1.6, 1.75, 1.2]), 1.2, 0.9, 1.9, 1.1, 1.3]);

/** Keep every joint within its anatomical range (after springs and squeeze). */
export function clampPose(p: HandPose): HandPose {
  for (let i = 0; i < HAND_DOF; i++) p[i] = Math.min(HI[i]!, Math.max(LO[i]!, p[i]!));
  return p;
}

/* ============================================================ anatomy (base size, scaled by HandLook.scale) */

interface FingerDef {
  /** Knuckle (base joint) offset toward the thumb side, height and depth. */
  x: number;
  y: number;
  z: number;
  r: number;
  len: readonly [number, number, number];
  /** Spread direction: + fans toward the thumb side, − away from it. */
  fan: number;
}

const FINGERS: readonly FingerDef[] = [
  { x: 0.0292, y: 0.004, z: -0.088, r: 0.0104, len: [0.03, 0.02, 0.018], fan: 1 },
  { x: 0.0098, y: 0.005, z: -0.092, r: 0.0108, len: [0.033, 0.022, 0.019], fan: 0.25 },
  { x: -0.0098, y: 0.004, z: -0.09, r: 0.0103, len: [0.031, 0.021, 0.018], fan: -0.45 },
  { x: -0.0288, y: 0.001, z: -0.084, r: 0.0093, len: [0.024, 0.016, 0.015], fan: -1 },
];

const THUMB_BASE: V3 = [0.022, -0.01, -0.022];
const THUMB_DIR: V3 = [0.6, -0.34, -0.72];
const THUMB_NAIL: V3 = [0.7, 0.6, -0.05];
const THUMB_LEN: readonly [number, number, number] = [0.03, 0.024, 0.021];

/** Bones: 0 wrist, 1 + finger·3 + phalanx, 13..15 thumb. */
const THUMB_BONE = 13;

/** The oblique power grip: a held shaft runs across the palm turned ψ toward the fingertips on the thumb side. */
export const SHAFT_PSI = 0.28;

/** A ring on a finger (0 index … 3 pinky, phalanx 0..2), optionally with a gem on top. */
export interface HandRing {
  finger: number;
  phalanx: number;
  color: string;
  gem?: string;
}

export interface HandLook {
  /** Skin (or glove) color. */
  color: string;
  /** Fingernail color, or null (gloves). */
  nail: string | null;
  /** Nail length factor (polished nails reach past the tip). */
  nailLength?: number;
  /** Overall size (base hand × this), and finger length / thickness factors (the kid's pudgy hands). */
  scale: number;
  fingerLength?: number;
  fingerThickness?: number;
  /** Ink hull growth (m): palm and pads, fingers (thinner, so the gaps between open fingers read). */
  ink: { palm: number; finger: number };
  rings?: readonly HandRing[];
  /** Stitch lines on the back of a glove. */
  stitches?: string;
  /** A band-aid on a finger (finger, phalanx). */
  bandaid?: readonly [number, number];
  /** A star sticker on the back of the hand (color). */
  sticker?: string;
}

type Shape =
  | { kind: "ellipsoid"; size: V3; seg: number }
  | { kind: "super"; size: V3; eps: number }
  | { kind: "capsule"; r: number; len: number }
  | { kind: "ring"; r: number; tube: number }
  | { kind: "flower"; size: V3 };

interface HandPrim {
  bone: number;
  shape: Shape;
  at: V3;
  rot: V3;
  color: string;
  ink: boolean;
}

const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const _e = new THREE.Euler();
const _q = new THREE.Quaternion();

/** Rest orientation of the thumb's base bone: its −Z along the thumb, +Y out of the nail. */
function thumbRest(inner: number): THREE.Quaternion {
  _bz.set(-THUMB_DIR[0] * inner, -THUMB_DIR[1], -THUMB_DIR[2]).normalize();
  _by.set(THUMB_NAIL[0] * inner, THUMB_NAIL[1], THUMB_NAIL[2]);
  _by.addScaledVector(_bz, -_by.dot(_bz)).normalize();
  _bx.crossVectors(_by, _bz).normalize();
  return new THREE.Quaternion().setFromRotationMatrix(_bm.makeBasis(_bx, _by, _bz));
}

/** Phalanx lengths of finger f for a look. */
function fingerLen(f: FingerDef, look: HandLook): readonly [number, number, number] {
  const k = look.fingerLength ?? 1;
  return [f.len[0] * k, f.len[1] * k, f.len[2] * k];
}

/** Bone rest offsets (parent space, unscaled) and parents. */
function boneLayout(inner: number, look: HandLook): { parent: number; at: V3; rest: THREE.Quaternion }[] {
  const I = new THREE.Quaternion();
  const out: { parent: number; at: V3; rest: THREE.Quaternion }[] = [{ parent: -1, at: [0, 0, 0], rest: I }];
  for (const f of FINGERS) {
    const base = out.length;
    const len = fingerLen(f, look);
    out.push({ parent: 0, at: [f.x * inner, f.y, f.z], rest: I });
    out.push({ parent: base, at: [0, 0, -len[0]], rest: I });
    out.push({ parent: base + 1, at: [0, 0, -len[1]], rest: I });
  }
  out.push({ parent: 0, at: [THUMB_BASE[0] * inner, THUMB_BASE[1], THUMB_BASE[2]], rest: thumbRest(inner) });
  out.push({ parent: THUMB_BONE, at: [0, 0, -THUMB_LEN[0]], rest: I });
  out.push({ parent: THUMB_BONE + 1, at: [0, 0, -THUMB_LEN[1]], rest: I });
  return out;
}

/** The primitives in bone space (unscaled). */
function handPrims(look: HandLook, inner: number): HandPrim[] {
  const c = look.color;
  const out: HandPrim[] = [];
  const add = (bone: number, shape: Shape, at: V3, rot: V3 = [0, 0, 0], color = c, ink = true): void => {
    out.push({ bone, shape, at, rot, color, ink });
  };
  const thick = look.fingerThickness ?? 1;
  const nailLen = look.nailLength ?? 1;
  // Wrist (slim, so it never bulges past the forearm's neck), palm block, knuckle ridge and bumps, heel pad.
  add(0, { kind: "ellipsoid", size: [0.021, 0.0165, 0.02], seg: 10 }, [0, -0.001, -0.004]);
  add(0, { kind: "super", size: [0.039, 0.019, 0.046], eps: 0.62 }, [0, 0, -0.05], [0.04, 0, 0]);
  add(0, { kind: "ellipsoid", size: [0.04, 0.014, 0.012], seg: 12 }, [0, 0.003, -0.086], [0, 0, 0]);
  for (const f of FINGERS) add(0, { kind: "ellipsoid", size: [0.0085, 0.0085, 0.0085], seg: 8 }, [f.x * inner, 0.0085, f.z + 0.002], [0, 0, 0], c, false);
  add(0, { kind: "ellipsoid", size: [0.016, 0.012, 0.028], seg: 9 }, [inner * -0.021, -0.011, -0.032]);
  // Fingers: three capsules each (the caps overlap at the joints, so bends never open a gap) and a nail.
  FINGERS.forEach((f, i) => {
    const b = 1 + i * 3;
    const len = fingerLen(f, look);
    const r0 = f.r * thick;
    for (let k = 0; k < 3; k++) {
      const r = r0 * (1 - 0.035 * k);
      add(b + k, { kind: "capsule", r, len: len[k]! }, [0, 0, -len[k]! / 2], [-Math.PI / 2, 0, 0]);
    }
    if (look.nail) {
      const r = r0 * 0.94;
      add(b + 2, { kind: "ellipsoid", size: [r * 0.62, r * 0.28, r * 0.78 * nailLen], seg: 7 }, [0, r * 0.74, -len[2] * 0.66 - (nailLen - 1) * r * 0.6], [0.12, 0, 0], look.nail, false);
    }
  });
  // Thumb: the fleshy base (thenar pad) and two phalanges.
  add(THUMB_BONE, { kind: "ellipsoid", size: [0.0165, 0.0145, 0.027], seg: 10 }, [0, -0.001, -0.012]);
  add(THUMB_BONE + 1, { kind: "capsule", r: 0.0122 * thick, len: THUMB_LEN[1] }, [0, 0, -THUMB_LEN[1] / 2], [-Math.PI / 2, 0, 0]);
  add(THUMB_BONE + 2, { kind: "capsule", r: 0.0116 * thick, len: THUMB_LEN[2] }, [0, 0, -THUMB_LEN[2] / 2], [-Math.PI / 2, 0, 0]);
  if (look.nail) add(THUMB_BONE + 2, { kind: "ellipsoid", size: [0.0075, 0.0034, 0.009 * nailLen], seg: 7 }, [0, 0.0088, -THUMB_LEN[2] * 0.6], [0.12, 0, 0], look.nail, false);
  // Extras.
  for (const ring of look.rings ?? []) {
    const f = FINGERS[ring.finger]!;
    const len = fingerLen(f, look);
    const r = f.r * thick * (1 - 0.035 * ring.phalanx);
    const bone = 1 + ring.finger * 3 + ring.phalanx;
    add(bone, { kind: "ring", r: r * 1.08, tube: 0.24 }, [0, 0, -len[ring.phalanx]! * 0.55], [Math.PI / 2, 0, 0], ring.color, false);
    if (ring.gem) add(bone, { kind: "ellipsoid", size: [r * 0.42, r * 0.36, r * 0.42], seg: 8 }, [0, r * 1.25, -len[ring.phalanx]! * 0.55], [0, 0, 0], ring.gem, false);
  }
  if (look.stitches) {
    for (const x of [-0.012, 0, 0.012]) add(0, { kind: "ellipsoid", size: [0.0012, 0.0006, 0.02], seg: 6 }, [x * inner, 0.0195, -0.05], [0.04, 0, 0], look.stitches, false);
  }
  if (look.bandaid) {
    const [fi, ph] = look.bandaid;
    const f = FINGERS[fi]!;
    const len = fingerLen(f, look);
    const r = f.r * thick * (1 - 0.035 * ph);
    add(1 + fi * 3 + ph, { kind: "ellipsoid", size: [r * 1.12, r * 1.12, len[ph]! * 0.32], seg: 10 }, [0, 0, -len[ph]! * 0.5], [0, 0, 0], "#F1C9A0", false);
    add(1 + fi * 3 + ph, { kind: "ellipsoid", size: [r * 0.5, r * 0.25, len[ph]! * 0.2], seg: 8 }, [0, r * 1.05, -len[ph]! * 0.5], [0, 0, 0], "#E3B184", false);
  }
  if (look.sticker) add(0, { kind: "flower", size: [0.011, 0.011, 0.011] }, [0.004 * inner, 0.0198, -0.045], [-Math.PI / 2 + 0.04, 0, 0.3], look.sticker, false);
  return out;
}

function shapeGeometry(s: Shape, k: number, grow: number): { geo: THREE.BufferGeometry; scale: V3 } {
  switch (s.kind) {
    case "ellipsoid":
      return { geo: sphereGeo(s.seg), scale: [s.size[0] * k + grow, s.size[1] * k + grow, s.size[2] * k + grow] };
    case "super":
      return { geo: superSphereGeo(s.eps, 16), scale: [s.size[0] * k + grow, s.size[1] * k + grow, s.size[2] * k + grow] };
    case "capsule":
      return { geo: capsuleGeo(s.r * k + grow, s.len * k, 9, 3), scale: [1, 1, 1] };
    case "ring":
      return { geo: torusGeo(s.tube, Math.PI * 2, 6, 14), scale: [s.r * k, s.r * k, s.r * k] };
    case "flower":
      return { geo: flowerGeo(), scale: [s.size[0] * k, s.size[1] * k, s.size[2] * k] };
  }
}

interface HandGeometry {
  skin: THREE.BufferGeometry;
  ink: THREE.BufferGeometry;
}

const geometryCache = new Map<string, HandGeometry>();

/** Bind-pose (all joints zero) bone matrices in mesh space, scaled by k. */
function bindMatrices(inner: number, look: HandLook): THREE.Matrix4[] {
  const k = look.scale;
  const layout = boneLayout(inner, look);
  const out: THREE.Matrix4[] = [];
  const local = new THREE.Matrix4();
  const one = new THREE.Vector3(1, 1, 1);
  for (const b of layout) {
    local.compose(new THREE.Vector3(b.at[0] * k, b.at[1] * k, b.at[2] * k), b.rest, one);
    out.push(b.parent < 0 ? local.clone() : out[b.parent]!.clone().multiply(local));
  }
  return out;
}

/** Merge prims into one rigidly skinned geometry; `grow(prim)` > 0 builds the ink hull. */
function bake(prims: readonly HandPrim[], binds: readonly THREE.Matrix4[], k: number, grow: (p: HandPrim) => number): THREE.BufferGeometry {
  const list: Prim[] = [];
  const bones: number[] = [];
  for (const p of prims) {
    const { geo, scale } = shapeGeometry(p.shape, k, grow(p));
    const m = binds[p.bone]!.clone().multiply(trs([p.at[0] * k, p.at[1] * k, p.at[2] * k], p.rot, scale));
    list.push({ geometry: geo, matrix: m, color: new THREE.Color(p.color) });
    bones.push(p.bone);
  }
  const g = mergePrims(list);
  const n = g.getAttribute("position").count;
  const index = new Uint16Array(n * 4);
  const weight = new Float32Array(n * 4);
  let o = 0;
  list.forEach((p, i) => {
    const count = p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute("position").count;
    for (let v = 0; v < count; v++, o++) {
      index[o * 4] = bones[i]!;
      weight[o * 4] = 1;
    }
  });
  g.setAttribute("skinIndex", new THREE.Uint16BufferAttribute(index, 4));
  g.setAttribute("skinWeight", new THREE.Float32BufferAttribute(weight, 4));
  return g;
}

function handGeometry(key: string, look: HandLook, inner: number): HandGeometry {
  let g = geometryCache.get(key);
  if (!g) {
    const prims = handPrims(look, inner);
    const binds = bindMatrices(inner, look);
    g = {
      skin: bake(prims, binds, look.scale, () => 0),
      ink: bake(
        prims.filter((p) => p.ink),
        binds,
        look.scale,
        (p) => (p.shape.kind === "capsule" ? look.ink.finger : look.ink.palm),
      ),
    };
    geometryCache.set(key, g);
  }
  return g;
}

/* ============================================================ the rig */

/** Hand-space anchor points (m): where held items attach (see fpHolds.ts). */
export interface HandAnchors {
  /** Under the cupped palm: a ball's top touches it, centered over x / z. */
  cup: THREE.Vector3;
  /** On the open palm: an item's top touches it, centered over x / z. */
  tray: THREE.Vector3;
  /** Where the thumb and index pads meet in the pinch pose. */
  pinch: THREE.Vector3;
  /** Inside the hooked middle / ring fingers. */
  hook: THREE.Vector3;
}

/** One skinned hand (mesh + ink hull) under `root`; place `root` at the wrist in hand space. */
export class FpHand {
  readonly root = new THREE.Group();
  readonly mesh: THREE.SkinnedMesh;
  readonly ink: THREE.SkinnedMesh;
  readonly anchors: HandAnchors;
  /** Overall size (m per auth unit). */
  readonly scale: number;
  private readonly bones: THREE.Bone[] = [];
  private readonly rests: THREE.Quaternion[] = [];
  private readonly inner: number;
  private readonly fan: number[];

  constructor(key: string, look: HandLook, inner: number, skin: THREE.Material, ink: THREE.Material) {
    this.inner = inner;
    this.fan = FINGERS.map((f) => f.fan * -inner);
    const k = look.scale;
    this.scale = k;
    const layout = boneLayout(inner, look);
    for (const b of layout) {
      const bone = new THREE.Bone();
      bone.position.set(b.at[0] * k, b.at[1] * k, b.at[2] * k);
      bone.quaternion.copy(b.rest);
      this.rests.push(b.rest.clone());
      if (b.parent >= 0) this.bones[b.parent]!.add(bone);
      this.bones.push(bone);
    }
    const g = handGeometry(key, look, inner);
    this.mesh = new THREE.SkinnedMesh(g.skin, skin);
    this.ink = new THREE.SkinnedMesh(g.ink, ink);
    this.mesh.name = "fpHand";
    this.ink.name = "fpHandInk";
    this.root.add(this.bones[0]!, this.mesh, this.ink);
    this.root.updateMatrixWorld(true);
    const skeleton = new THREE.Skeleton(this.bones);
    const identity = new THREE.Matrix4();
    this.mesh.bind(skeleton, identity);
    this.ink.bind(skeleton, identity);
    this.anchors = {
      cup: new THREE.Vector3(0, -0.01, -0.088).multiplyScalar(k),
      tray: new THREE.Vector3(0, -0.016, -0.072).multiplyScalar(k),
      pinch: new THREE.Vector3(inner * 0.032, -0.049, -0.095).multiplyScalar(k),
      hook: new THREE.Vector3(0, -0.025, -0.093).multiplyScalar(k),
    };
  }

  /** Where a handle of radius R (m) sits in the gripping fist: its axis passes here (hand space, m). */
  gripPoint(R: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(0, -0.0161 * this.scale - R, -0.084 * this.scale);
  }

  /** Pose the joints. */
  apply(p: ArrayLike<number>): void {
    const b = this.bones;
    for (let f = 0; f < 4; f++) {
      const o = f * 4;
      const base = b[1 + f * 3]!;
      base.rotation.set(-p[o + 1]!, this.fan[f]! * p[o]!, 0, "YXZ");
      b[2 + f * 3]!.rotation.set(-p[o + 2]!, 0, 0);
      b[3 + f * 3]!.rotation.set(-p[o + 3]!, 0, 0);
    }
    const t = b[THUMB_BONE]!;
    _e.set(-p[THUMB]!, p[THUMB + 1]! * this.inner, p[THUMB + 2]! * -this.inner, "YXZ");
    t.quaternion.copy(this.rests[THUMB_BONE]!).multiply(_q.setFromEuler(_e));
    b[THUMB_BONE + 1]!.rotation.set(-p[THUMB + 3]!, 0, 0);
    b[THUMB_BONE + 2]!.rotation.set(-p[THUMB + 4]!, 0, 0);
  }
}
