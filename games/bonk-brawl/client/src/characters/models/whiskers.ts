// Whiskers: grey tabby with darker stripes, smug half-lidded eyes, red collar with a gold bell.
// Owner: client-characters.

import type * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, type PartBuilder, UV_EYES, UV_MOUTH, type V3 } from "../parts";
import { buildBell } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

export const whiskersSpec: BodySpec = {
  torso: { y: 0.5, r: [0.34, 0.35, 0.33], paint: "body" },
  belly: { at: [0, 0.46, -0.12], r: [0.24, 0.27, 0.24], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.84,
  head: { at: [0, 1.06, -0.01], r: [0.33, 0.29, 0.29], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.33, 0.72, 0.0],
    length: 0.27,
    radius: 0.065,
    paint: "body",
    hand: [0.1, 0.095, 0.1],
    handPaint: "secondary",
    band: true,
  },
  leg: {
    hip: [0.15, 0.2, 0.03],
    length: 0.15,
    radius: 0.07,
    paint: "body",
    foot: [0.1, 0.055, 0.14],
    footPaint: "secondary",
    footZ: -0.05,
  },
  extraAt: [0, 0.32, 0.3],
  topY: 1.44,
  ghostPaint: "body",
};

const INNER_EAR = "#FFB3C1";
const BELL_GOLD = PALETTE.crownGold;

/** A tabby stripe: an arc of a ring hugging the body, centered on the back. */
function stripe(b: PartBuilder, parent: THREE.Object3D, at: V3, radius: number, arc: number): void {
  const ring = b.torus(parent, "accent", at, radius, 0.024, [0, 1, 0], arc);
  ring.rotation.y = arc / 2 - Math.PI / 2;
  // Painted-on markings: no ink outline of their own.
  ring.userData.noOutline = true;
  ring.castShadow = false;
}

export const buildWhiskers: CharacterBuilder = (b, s, face) => {
  const eyes = b.facePatch(s.headMesh, face, { theta: 1.2, thetaLength: 0.86, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  const muzzle = b.sphere(s.head, "secondary", [0, 0.975, -0.25], [0.13, 0.088, 0.09], "mid");
  b.facePatch(muzzle, face, { theta: 1.8, thetaLength: 1.0, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH, lift: 1.03 });
  b.sphere(s.head, "#FF8FA3", [0, 1.035, -0.335], [0.038, 0.026, 0.022], "lo");
  for (const side of [1, -1]) {
    for (const k of [-1, 0, 1]) {
      const whisker = b.cylinder(
        s.head,
        "ink",
        [side * 0.1, 0.99 + k * 0.012, -0.31],
        [side * 0.33, 1.0 + k * 0.05, -0.27],
        0.007,
        1,
        3,
      );
      whisker.userData.noOutline = true;
      whisker.castShadow = false;
    }
  }

  const ears = [1, -1].map((side) => {
    const ear = b.group(s.head, [side * 0.17, 1.24, 0.0], side > 0 ? "earR" : "earL");
    b.cone(ear, "body", [side * 0.17, 1.25, 0.01], [side * 0.245, 1.43, 0.03], 0.105, 4);
    b.cone(ear, INNER_EAR, [side * 0.175, 1.27, -0.035], [side * 0.235, 1.39, -0.02], 0.055, 4);
    return ear;
  });

  stripe(b, s.upper, [0, 0.64, 0.0], 0.305, 1.7);
  stripe(b, s.upper, [0, 0.5, 0.0], 0.335, 1.5);
  stripe(b, s.upper, [0, 0.36, 0.0], 0.3, 1.3);
  stripe(b, s.head, [0, 1.2, -0.01], 0.27, 1.4);

  b.torus(s.upper, "accessory", [0, 0.815, -0.01], 0.225, 0.036);
  const bell = buildBell(b, s.upper, [0, 0.815, -0.265], 0.058, BELL_GOLD);

  const tailTip = b.group(s.extra, [0, 0.43, 0.53], "tailTip");
  b.capsule(s.extra, "body", [0, 0.32, 0.3], [0, 0.43, 0.53], 0.05, "lo");
  b.capsule(tailTip, "body", [0, 0.43, 0.53], [0, 0.66, 0.62], 0.05, "lo");
  b.torus(tailTip, "accent", [0, 0.6, 0.6], 0.052, 0.018, [0, 0.95, 0.35]);
  b.torus(tailTip, "accent", [0, 0.5, 0.56], 0.052, 0.018, [0, 0.9, 0.42]);

  return { face: eyes, jaw: null, sac: null, ears, tailTip, accessory: bell };
};

export const whiskersMemento: MementoBuilder = (b, parent) => {
  const strap = b.torus(parent, "accessory", [0, 0.06, 0], 0.09, 0.025, [1, 0, 0]);
  strap.scale.multiplyScalar(1);
  buildBell(b, parent, [0, 0.0, 0], 0.11, BELL_GOLD);
};
