// Pip: "speedy egg with a crest and a streaming scarf". Tall bullet-egg penguin with no neck, a
// heart-shaped white mask, a feather crest and a red scarf whose tails (slot band + fringe) trail
// behind on the run. Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, type PartBuilder, UV_EYES, type V3 } from "../parts";
import { add, type BodySpec, type CharacterBuilder, type MementoBuilder } from "./common";

export const pipSpec: BodySpec = {
  torso: { y: 0.5, r: [0.36, 0.42, 0.35], paint: "body", shape: "egg", egg: -0.12 },
  belly: { at: [0, 0.48, -0.15], r: [0.3, 0.36, 0.22], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.86,
  head: { at: [0, 1.06, 0.0], r: [0.32, 0.29, 0.31], paint: "body" },
  arm: {
    kind: "flipper",
    shoulder: [0.34, 0.8, 0.02],
    length: 0.44,
    radius: 0.065,
    paint: "body",
    hand: [0.055, 0.075, 0.12],
    handPaint: "body",
    band: true,
  },
  leg: {
    hip: [0.14, 0.13, 0.02],
    length: 0.06,
    radius: 0.05,
    paint: "accent",
    foot: [0.12, 0.04, 0.18],
    footPaint: "accent",
    footZ: -0.08,
    toes: 3,
  },
  extraAt: [0, 0.3, 0.33],
  topY: 1.5,
  ghostPaint: "body",
  rim: 0.18,
  gradient: 0.12,
};

const SCARF = "#E8384F";
const WHITE = "#FFFFFF";
const SCARF_Y = 0.84;
const KNOT: V3 = [0.1, 0.84, 0.24];
const ACC = { accessory: true, flair: true } as const;

/** Scarf ring + knot on `pivot` (centered at `at`), slot stripes across the front. */
function buildScarfRing(b: PartBuilder, pivot: THREE.Object3D, at: V3, knot: V3, shadow: boolean): void {
  b.torus(pivot, SCARF, at, 0.22, 0.07, { accessory: true, tubular: 12, radial: 5, shadow, scale: [1, 0.9, 1] });
  for (const start of [-Math.PI / 2 - 0.55, -Math.PI / 2 + 0.3]) {
    b.torus(pivot, "slot", at, 0.22, 0.073, { accessory: true, outline: false, arc: 0.25, start, tubular: 2, radial: 5, gradient: 0 });
  }
  b.sphere(pivot, SCARF, knot, [0.085, 0.075, 0.07], { ...ACC, detail: "lo" });
}

/** One flat scarf tail segment from→to (slot = slot-colored strip, fringe = white tassels). */
function scarfSegment(b: PartBuilder, pivot: THREE.Object3D, from: V3, to: V3, paint: "slot" | `#${string}`, fringe: boolean): void {
  b.flatStrip(pivot, paint, from, to, 0.08, 0.022, [0, 0.2, 1], { ...ACC, gradient: 0.05 });
  if (!fringe) return;
  for (const k of [-1, 0, 1]) {
    b.cylinder(pivot, WHITE, add(to, k * 0.024, 0.0, 0), add(to, k * 0.03, -0.05, 0.01), 0.011, { ...ACC, outline: false, segments: 4 });
  }
}

export const buildPip: CharacterBuilder = (b, s) => {
  // Heart-shaped white mask (two merged ellipsoids) carrying the eye band.
  for (const side of [1, -1]) {
    b.sphere(s.head, "secondary", [side * 0.09, 1.07, -0.19], [0.17, 0.17, 0.14], { detail: "lo", gradient: 0.03 });
  }
  b.facePatch(s.head, [0, 1.07, -0.19], [0.245, 0.17, 0.145], "eyes", {
    theta: 1.18,
    thetaLength: 1.0,
    aspect: EYE_BAND_ASPECT,
    uv: UV_EYES,
    lift: 1.02,
  });

  // Beak: upper cone + lower half on the jaw.
  b.cone(s.head, "accent", [0, 1.02, -0.27], [0, 1.0, -0.45], 0.065, { flair: true, segments: 8, scale: [1, 1, 0.75] });
  const jaw = b.group(s.head, [0, 1.0, -0.27], "jaw");
  b.cone(jaw, "accent", [0, 0.99, -0.28], [0, 0.985, -0.4], 0.045, { flair: true, segments: 8, scale: [1, 1, 0.7] });

  // Crest: three fanned feathers up and back.
  const crest = b.group(s.head, [0, 1.33, -0.02], "crest");
  for (const [x, y, z] of [
    [-0.08, 1.45, 0.08],
    [0, 1.5, 0.05],
    [0.08, 1.45, 0.08],
  ] as const) {
    b.cone(crest, "body", [0, 1.3, -0.02], [x, y, z], 0.05, { flair: true, segments: 5, scale: [1, 1, 0.5], shadow: false });
  }

  b.cone(s.extra, "body", [0, 0.3, 0.3], [0, 0.26, 0.45], 0.07, { flair: true, segments: 6, outline: true });

  // Scarf (headwear + KO accessory) with a two-segment tail A and a short tail B, all springs.
  const scarf = b.group(s.upper, [0, SCARF_Y, 0], "scarf");
  buildScarfRing(b, scarf, [0, SCARF_Y, 0], KNOT, true);
  const a0 = b.group(scarf, KNOT, "scarfA0");
  const a0End: V3 = add(KNOT, 0.03, -0.16, 0.08);
  scarfSegment(b, a0, KNOT, a0End, SCARF, false);
  const a1 = b.group(a0, a0End, "scarfA1");
  const a1End: V3 = add(a0End, 0.02, -0.165, 0.07);
  scarfSegment(b, a1, a0End, a1End, "slot", true);
  const b0 = b.group(scarf, add(KNOT, -0.03, 0, 0), "scarfB0");
  const b0End: V3 = add(KNOT, -0.1, -0.12, 0.08);
  scarfSegment(b, b0, add(KNOT, -0.03, 0, 0), b0End, "slot", true);

  const sp = s.springs;
  sp.add(crest, "crest", [0, 1.5, 0.05]);
  sp.add(s.extra, "tailStiff", [0, 0.26, 0.45]);
  sp.add(a0, "scarfA0", a0End);
  sp.add(a1, "scarfA1", a1End);
  sp.add(b0, "scarfA0", b0End);

  return { jaw, sac: null, ears: [], tail: [], accessory: scarf, headwear: scarf, cheeks: [], eyeBulbs: [] };
};

export const pipMemento: MementoBuilder = (b, parent) => {
  const knot: V3 = [0.1, 0, 0.24];
  buildScarfRing(b, parent, [0, 0, 0], knot, false);
  scarfSegment(b, parent, knot, add(knot, 0.04, -0.2, 0.08), "slot", true);
  scarfSegment(b, parent, add(knot, -0.03, 0, 0), add(knot, -0.1, -0.13, 0.08), SCARF, false);
};
