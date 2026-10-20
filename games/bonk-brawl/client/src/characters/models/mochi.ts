// Mochi: round brown bear, tan muzzle and belly, pink cheeks, small round ears (+ a pink bow).
// Owner: client-characters.

import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, UV_EYES, UV_MOUTH } from "../parts";
import { buildBow } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

export const mochiSpec: BodySpec = {
  torso: { y: 0.5, r: [0.4, 0.37, 0.37], paint: "body" },
  belly: { at: [0, 0.46, -0.15], r: [0.3, 0.28, 0.26], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.84,
  head: { at: [0, 1.06, -0.01], r: [0.31, 0.29, 0.29], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.37, 0.72, 0.0],
    length: 0.27,
    radius: 0.075,
    paint: "body",
    hand: [0.11, 0.1, 0.11],
    handPaint: "secondary",
    band: true,
  },
  leg: {
    hip: [0.17, 0.2, 0.03],
    length: 0.14,
    radius: 0.08,
    paint: "body",
    foot: [0.12, 0.06, 0.15],
    footPaint: "body",
    footZ: -0.05,
  },
  extraAt: [0, 0.32, 0.34],
  topY: 1.42,
  ghostPaint: "body",
};

export const buildMochi: CharacterBuilder = (b, s, face) => {
  const eyes = b.facePatch(s.headMesh, face, { theta: 1.2, thetaLength: 0.82, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  const muzzle = b.sphere(s.head, "secondary", [0, 0.975, -0.255], [0.14, 0.1, 0.1], "mid");
  b.facePatch(muzzle, face, { theta: 1.86, thetaLength: 0.95, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH, lift: 1.03 });
  b.sphere(s.head, "ink", [0, 1.03, -0.345], [0.05, 0.035, 0.035], "lo");

  const ears = [1, -1].map((side) => {
    const ear = b.group(s.head, [side * 0.19, 1.24, 0.02], side > 0 ? "earR" : "earL");
    b.sphere(ear, "body", [side * 0.21, 1.3, 0.02], [0.095, 0.095, 0.06], "lo");
    b.sphere(ear, "accent", [side * 0.21, 1.295, -0.025], [0.055, 0.055, 0.03], "lo");
    return ear;
  });

  const bow = buildBow(b, ears[0], [0.275, 1.37, -0.02], 0.055, "accessory");
  bow.rotation.z = -0.5;

  b.sphere(s.extra, "body", [0, 0.33, 0.37], 0.075, "lo");

  return { face: eyes, jaw: null, sac: null, ears, tailTip: null, accessory: bow };
};

export const mochiMemento: MementoBuilder = (b, parent) => {
  buildBow(b, parent, [0, 0, 0], 0.13, "accessory");
};
