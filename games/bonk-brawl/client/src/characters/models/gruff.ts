// Gruff: white goat, curly tan horns, little beard, brass bell on a collar. Owner: client-characters.

import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, UV_EYES, UV_MOUTH } from "../parts";
import { buildBell } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

const HOOF = "#6E5F55";
const STRAP = "#8D5B3A";

export const gruffSpec: BodySpec = {
  torso: { y: 0.5, r: [0.35, 0.35, 0.34], paint: "body" },
  belly: { at: [0, 0.6, -0.16], r: [0.22, 0.2, 0.19], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.82,
  head: { at: [0, 1.03, -0.02], r: [0.28, 0.28, 0.3], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.33, 0.72, 0.0],
    length: 0.27,
    radius: 0.065,
    paint: "body",
    hand: [0.1, 0.095, 0.1],
    handPaint: HOOF,
    band: true,
  },
  leg: {
    hip: [0.15, 0.2, 0.02],
    length: 0.12,
    radius: 0.07,
    paint: "body",
    foot: [0.1, 0.065, 0.12],
    footPaint: HOOF,
    footZ: -0.03,
  },
  extraAt: [0, 0.5, 0.3],
  topY: 1.42,
  ghostPaint: "body",
};

export const buildGruff: CharacterBuilder = (b, s, face) => {
  const eyes = b.facePatch(s.headMesh, face, { theta: 1.22, thetaLength: 0.8, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  const muzzle = b.sphere(s.head, "secondary", [0, 0.94, -0.25], [0.14, 0.12, 0.13], "mid");
  b.facePatch(muzzle, face, { theta: 1.62, thetaLength: 1.25, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH, lift: 1.025 });
  b.cone(s.head, "secondary", [0, 0.88, -0.29], [0, 0.79, -0.345], 0.05, 6);

  const ears = [1, -1].map((side) => {
    const ear = b.group(s.head, [side * 0.24, 1.04, -0.04], side > 0 ? "earR" : "earL");
    const flap = b.sphere(ear, "body", [side * 0.33, 1.01, -0.05], [0.13, 0.045, 0.07], "lo");
    flap.rotation.z = -side * 0.45;
    return ear;
  });

  // Ram curls: open rings beside the head whose plane leans in, so each horn grows from the top
  // of the head, sweeps back and down around the ear and curls forward (top → back → bottom → front).
  for (const side of [1, -1]) {
    b.torus(s.head, "accent", [side * 0.26, 1.19, 0.05], 0.115, 0.048, [-1, -0.45 * side, 0], Math.PI * 1.55);
  }

  b.torus(s.upper, STRAP, [0, 0.8, -0.01], 0.215, 0.03);
  const bell = buildBell(b, s.upper, [0, 0.735, -0.3], 0.072, "accessory");

  b.cone(s.extra, "body", [0, 0.5, 0.3], [0, 0.67, 0.43], 0.065, 6);

  return { face: eyes, jaw: null, sac: null, ears, tailTip: null, accessory: bell };
};

export const gruffMemento: MementoBuilder = (b, parent) => {
  b.torus(parent, STRAP, [0, 0.07, 0], 0.1, 0.025, [1, 0, 0]);
  buildBell(b, parent, [0, 0.0, 0], 0.12, "accessory");
};
