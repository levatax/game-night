// Gruff: "stubborn block with big ram curls". Rounded-box goat with a boxy chewing muzzle, a
// springy beard, ram horns curling wide, floppy ears, a slot sweatband (tails at the back) and a
// brass bell on a leather collar. Owner: client-characters.

import * as THREE from "three";
import { MOUTH_BAND_ASPECT, EYE_BAND_ASPECT, type PrimOpts, UV_EYES, UV_MOUTH, type V3 } from "../parts";
import { buildBell } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

const HOOF = "#6E5F55";
const STRAP = "#8D5B3A";
const BEARD = "#E9E4D8";
const INNER_EAR = "#F2C4B8";
const RIDGE = new THREE.Color("#A8844C");

export const gruffSpec: BodySpec = {
  torso: { y: 0.44, r: [0.33, 0.29, 0.31], paint: "body", shape: "box", boxRadius: 0.16 },
  waistY: 0.3,
  neckY: 0.82,
  head: { at: [0, 1.01, -0.02], r: [0.3, 0.29, 0.31], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.35, 0.69, 0.0],
    length: 0.27,
    radius: 0.065,
    paint: "body",
    hand: [0.09, 0.09, 0.09],
    handPaint: HOOF,
    band: true,
    reach: [0.02, 0],
  },
  leg: {
    hip: [0.15, 0.18, 0.02],
    length: 0.1,
    radius: 0.075,
    paint: "body",
    foot: [0.11, 0.065, 0.12],
    footPaint: HOOF,
    footZ: -0.03,
    hoof: true,
  },
  extraAt: [0, 0.5, 0.33],
  topY: 1.42,
  ghostPaint: "body",
  gradient: 0.06,
};

/** Ram curl (right side; x mirrored): top of the head → back → around the ear → forward tip. */
const HORN: ReadonlyArray<V3> = [
  [0.15, 1.27, 0.02],
  [0.26, 1.34, 0.11],
  [0.38, 1.29, 0.17],
  [0.45, 1.15, 0.12],
  [0.43, 1.0, -0.01],
  [0.36, 0.99, -0.08],
  [0.33, 1.05, -0.08],
];
const HORN_RADII = [0.065, 0.06, 0.054, 0.048, 0.041, 0.035, 0.028];

const ridges =
  (side: 1 | -1): PrimOpts["vertexPaint"] =>
  (x, y, z, out) => {
    const d = Math.hypot(x - side * HORN[0][0], y - HORN[0][1], z - HORN[0][2]);
    if (Math.sin(d * 55) > 0.5) out.copy(RIDGE);
  };

// Level forehead band hugging the head (head r ≈ 0.257 × 0.265 at y 1.16): half the tube sinks in.
const BAND_AXIS: V3 = [0, 1, 0];
const BAND_AT: V3 = [0, 1.16, -0.02];
const BAND_BACK: V3 = [0, 1.15, 0.255];

export const buildGruff: CharacterBuilder = (b, s) => {
  const h = gruffSpec.head;
  b.facePatch(s.head, h.at, h.r, "eyes", { theta: 1.24, thetaLength: 0.78, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  // Boxy muzzle: upper half on the head, lower half on the chewing jaw.
  b.roundedBox(s.head, "secondary", [0, 0.955, -0.3], [0.24, 0.15, 0.24], 0.065, { detail: "mid" });
  b.facePatch(s.head, [0, 0.93, -0.3], [0.13, 0.11, 0.13], "mouth", {
    theta: 1.62,
    thetaLength: 1.25,
    aspect: MOUTH_BAND_ASPECT,
    uv: UV_MOUTH,
    lift: 1.0,
  });
  const jaw = b.group(s.head, [0, 0.9, -0.2], "jaw");
  b.sphere(jaw, "secondary", [0, 0.875, -0.29], [0.11, 0.045, 0.11], { detail: "lo" });

  // Beard hangs from the jaw.
  const beard = b.group(jaw, [0, 0.84, -0.33], "beard");
  b.cone(beard, BEARD, [0, 0.85, -0.33], [0, 0.68, -0.37], 0.06, { flair: true, segments: 6, scale: [1, 1, 0.75] });

  // Ram horns (merged into the head).
  for (const side of [1, -1] as const) {
    b.tube(
      s.head,
      "accent",
      HORN.map((p) => [p[0] * side, p[1], p[2]] as V3),
      HORN_RADII,
      { flair: true, vertexPaint: ridges(side), radial: 6 },
    );
  }

  // Floppy ears drooping sideways.
  const ears: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const ear = b.group(s.head, [side * 0.27, 1.06, -0.02], side > 0 ? "earR" : "earL");
    b.sphere(ear, "body", [side * 0.37, 1.02, -0.04], [0.14, 0.045, 0.07], { detail: "lo", flair: true, rot: [0, 0, -side * 0.45] });
    b.sphere(ear, INNER_EAR, [side * 0.37, 1.015, -0.085], [0.1, 0.03, 0.03], {
      detail: "xs",
      hiOnly: true,
      flair: true,
      outline: false,
      rot: [0, 0, -side * 0.45],
    });
    ears.push(ear);
  }

  // Slot sweatband (merged into the head) with two tails at the back knot.
  b.torus(s.head, "slot", BAND_AT, 0.262, 0.036, { axis: BAND_AXIS, tubular: 11, radial: 4, gradient: 0, accessory: true });
  b.sphere(s.head, "slot", BAND_BACK, [0.05, 0.04, 0.035], { detail: "xs", accessory: true, gradient: 0 });
  const bandTails: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const from: V3 = [side * 0.03, BAND_BACK[1] - 0.01, BAND_BACK[2] + 0.02];
    const tail = b.group(s.head, from, side > 0 ? "bandTailR" : "bandTailL");
    const to: V3 = [side * 0.08, from[1] - 0.15, from[2] + 0.07];
    // No hull: the bright slot strip reads against the white coat (keeps the draw budget).
    b.flatStrip(tail, "slot", from, to, 0.05, 0.014, [0, 0.3, 1], { accessory: true, flair: true, gradient: 0, outline: false });
    bandTails.push(tail);
  }

  // Leather collar + brass bell (KO accessory).
  b.torus(s.upper, STRAP, [0, 0.76, 0], 0.23, 0.032, { tubular: 14, accessory: true });
  const bell = b.group(s.upper, [0, 0.74, -0.37], "bell");
  buildBell(b, bell, [0, 0.74, -0.37], 0.08, "accessory");

  b.cone(s.extra, "body", [0, 0.5, 0.3], [0, 0.66, 0.44], 0.065, { flair: true, segments: 6, outline: false });

  const sp = s.springs;
  sp.add(beard, "beard", [0, 0.68, -0.37]);
  for (const ear of ears) {
    const side = ear.name === "earR" ? 1 : -1;
    sp.add(ear, "earFloppy", [side * 0.5, 0.97, -0.04]);
  }
  for (const tail of bandTails) {
    const side = tail.name === "bandTailR" ? 1 : -1;
    sp.add(tail, "ribbon", [side * 0.08, BAND_BACK[1] - 0.16, BAND_BACK[2] + 0.09]);
  }
  sp.add(bell, "bell", [0, 0.6, -0.37]);
  sp.add(s.extra, "tailStiff", [0, 0.66, 0.44]);

  return { jaw, sac: null, ears, tail: [], accessory: bell, headwear: null, cheeks: [], eyeBulbs: [] };
};

export const gruffMemento: MementoBuilder = (b, parent) => {
  b.torus(parent, STRAP, [0, 0.07, 0], 0.1, 0.025, { axis: [1, 0, 0], accessory: true });
  buildBell(b, parent, [0, 0.0, 0], 0.12, "accessory");
  b.torus(parent, "slot", [0, 0.2, 0], 0.13, 0.025, { axis: [0, 1, 0.3], accessory: true });
};
