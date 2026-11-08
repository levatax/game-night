// Whiskers: "smug, slim, tall ears, S-tail". Slim grey tabby with vertex-painted stripes, wide
// cheek fluff, tall pointed ears, a red collar with a gold bell and an S-tail (with a slot bow)
// rising above the shoulders. Owner: client-characters.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, type PrimOpts, UV_EYES, UV_MOUTH, type V3 } from "../parts";
import { buildBell, buildRibbonBow } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

const STRIPE = new THREE.Color("#6B717C");

/** Back vertices in bands of sin(y·28) get the tabby stripe color. */
const stripes: PrimOpts["vertexPaint"] = (_x, y, z, out) => {
  if (z > -0.05 && Math.sin(y * 28) > 0.55) out.copy(STRIPE);
};

export const whiskersSpec: BodySpec = {
  torso: { y: 0.44, r: [0.33, 0.36, 0.33], paint: "body", shape: "egg", egg: -0.1, vertexPaint: stripes },
  belly: { at: [0, 0.55, -0.22], r: [0.21, 0.21, 0.12], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.82,
  head: { at: [0, 1.04, -0.02], r: [0.36, 0.31, 0.32], paint: "body", vertexPaint: stripes },
  arm: {
    kind: "arm",
    shoulder: [0.32, 0.68, 0.0],
    length: 0.28,
    radius: 0.06,
    paint: "body",
    hand: [0.09, 0.085, 0.09],
    handPaint: "secondary",
    band: true,
    reach: [0.01, 0],
  },
  leg: {
    hip: [0.14, 0.18, 0.03],
    length: 0.12,
    radius: 0.065,
    paint: "body",
    foot: [0.1, 0.055, 0.14],
    footPaint: "secondary",
    footZ: -0.05,
  },
  extraAt: [0, 0.3, 0.29],
  topY: 1.54,
  ghostPaint: "body",
};

const INNER_EAR = "#FFB3C1";
const NOSE = "#FF8FA3";
const COLLAR = "#E8384F";
const BELL_GOLD = PALETTE.crownGold;

export const buildWhiskers: CharacterBuilder = (b, s) => {
  const h = whiskersSpec.head;
  b.facePatch(s.head, h.at, h.r, "eyes", { theta: 1.2, thetaLength: 0.86, aspect: EYE_BAND_ASPECT, uv: UV_EYES, lift: 1.025 });

  // Cheek fluff (side hook).
  for (const side of [1, -1]) {
    b.cone(s.head, "body", [side * 0.28, 0.95, -0.05], [side * 0.43, 0.9, -0.02], 0.075, {
      segments: 5,
      scale: [1, 1, 0.6],
    });
  }

  const muzzleAt: V3 = [0, 0.96, -0.27];
  const muzzleR: V3 = [0.12, 0.08, 0.08];
  b.sphere(s.head, "secondary", muzzleAt, muzzleR, { detail: "mid" });
  b.facePatch(s.head, muzzleAt, muzzleR, "mouth", { theta: 1.8, thetaLength: 1.0, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH, lift: 1.03 });
  b.sphere(s.head, NOSE, [0, 1.005, -0.345], [0.035, 0.025, 0.02], { detail: "xs" });
  // Whiskers: flat ink strips merged into the head, no outline.
  for (const side of [1, -1]) {
    for (const k of [-1, 0, 1]) {
      b.flatStrip(s.head, "ink", [side * 0.1, 0.965 + k * 0.014, -0.325], [side * 0.36, 0.975 + k * 0.05, -0.27], 0.013, 0.006, [0, 0, -1], {
        outline: false,
        gradient: 0,
        flair: true,
        detail: "xs",
      });
    }
  }

  const ears: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const ear = b.group(s.head, [side * 0.17, 1.27, 0], side > 0 ? "earR" : "earL");
    b.cone(ear, "body", [side * 0.17, 1.24, 0.0], [side * 0.25, 1.52, 0.04], 0.12, { segments: 4, flair: true, rot: [0, Math.PI / 4, 0] });
    b.cone(ear, INNER_EAR, [side * 0.175, 1.27, -0.045], [side * 0.235, 1.45, -0.01], 0.06, {
      segments: 4,
      flair: true,
      outline: false,
      rot: [0, Math.PI / 4, 0],
    });
    ears.push(ear);
  }

  // Collar + bell (KO accessory).
  b.torus(s.upper, COLLAR, [0, 0.77, -0.02], 0.2, 0.034, { axis: [0, 1, -0.15], tubular: 12, radial: 3, accessory: true });
  const bell = b.group(s.upper, [0, 0.76, -0.24], "bell");
  buildBell(b, bell, [0, 0.76, -0.235], 0.06, BELL_GOLD);

  // S-tail: extra (tail0) → tail1 → tail2 with an accent tip and a slot bow.
  const tailOpts = { flair: true, detail: "lo" } as const;
  b.capsule(s.extra, "body", [0, 0.3, 0.29], [0, 0.55, 0.48], 0.055, tailOpts);
  const tail1 = b.group(s.extra, [0, 0.55, 0.48], "tail1");
  b.capsule(tail1, "body", [0, 0.55, 0.48], [0, 0.85, 0.56], 0.05, tailOpts);
  const tail2 = b.group(tail1, [0, 0.85, 0.56], "tail2");
  b.capsule(tail2, "body", [0, 0.85, 0.56], [0, 1.02, 0.47], 0.045, tailOpts);
  b.sphere(tail2, "accent", [0, 1.03, 0.465], 0.05, { flair: true, detail: "xs" });
  buildRibbonBow(b, tail2, [0, 0.87, 0.6], 0.09, "slot");

  const sp = s.springs;
  for (const ear of ears) {
    const side = ear.name === "earR" ? 1 : -1;
    sp.add(ear, "earUp", [side * 0.25, 1.52, 0.04]);
  }
  sp.add(s.extra, "tailStiff", [0, 0.55, 0.48]);
  sp.add(tail1, "tail1", [0, 0.85, 0.56]);
  sp.add(tail2, "tail2", [0, 1.05, 0.46]);
  sp.add(bell, "bell", [0, 0.6, -0.235]);

  return { jaw: null, sac: null, ears, tail: [tail1, tail2], accessory: bell, headwear: null, cheeks: [], eyeBulbs: [] };
};

export const whiskersMemento: MementoBuilder = (b, parent) => {
  b.torus(parent, COLLAR, [0, 0.06, 0], 0.09, 0.025, { axis: [1, 0, 0], accessory: true });
  buildBell(b, parent, [0, 0.0, 0], 0.11, BELL_GOLD);
};
