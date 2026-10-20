// Quacky: yellow duck, orange beak and feet, tiny white sailor hat. Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, UV_EYES } from "../parts";
import { buildSailorHat } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

export const quackySpec: BodySpec = {
  torso: { y: 0.5, r: [0.36, 0.34, 0.35], paint: "body" },
  belly: { at: [0, 0.45, -0.12], r: [0.28, 0.26, 0.25], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.8,
  head: { at: [0, 1.02, -0.02], r: [0.29, 0.28, 0.28], paint: "body" },
  arm: {
    kind: "wing",
    shoulder: [0.335, 0.74, 0.03],
    length: 0.4,
    radius: 0.075,
    paint: "body",
    hand: [0.07, 0.09, 0.15],
    handPaint: "body",
    band: false,
  },
  leg: {
    hip: [0.14, 0.2, 0.02],
    length: 0.15,
    radius: 0.045,
    paint: "accent",
    foot: [0.1, 0.045, 0.15],
    footPaint: "accent",
    footZ: -0.07,
  },
  extraAt: [0, 0.5, 0.3],
  topY: 1.42,
  ghostPaint: "body",
};

export const buildQuacky: CharacterBuilder = (b, s, face) => {
  const facePatch = b.facePatch(s.headMesh, face, {
    theta: 1.18,
    thetaLength: 0.95,
    aspect: EYE_BAND_ASPECT,
    uv: UV_EYES,
  });

  // Wide flat bill: the lower half hangs from a jaw pivot so it can open.
  b.sphere(s.head, "accent", [0, 0.985, -0.31], [0.15, 0.05, 0.14], "mid");
  const jaw = b.group(s.head, [0, 0.965, -0.2], "jaw");
  b.sphere(jaw, "accent", [0, 0.948, -0.29], [0.13, 0.04, 0.12], "lo");

  b.cone(s.extra, "body", [0, 0.5, 0.29], [0, 0.7, 0.47], 0.11, 7);

  const hat = buildSailorHat(b, s.head, [0.05, 1.255, -0.01]);
  hat.rotation.set(0.12, 0, -0.32);

  return { face: facePatch, jaw, sac: null, ears: [], tailTip: null, accessory: hat };
};

export const quackyMemento: MementoBuilder = (b, parent: THREE.Group) => {
  const hat = buildSailorHat(b, parent, [0, -0.05, 0], 1.3);
  hat.rotation.set(0.2, 0, -0.35);
};
