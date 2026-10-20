// Hopsworth: green frog with huge eyes on top of the head and a red bow tie. Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, UV_EYE_LEFT, UV_EYE_RIGHT, UV_MOUTH } from "../parts";
import { buildBow } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

export const hopsworthSpec: BodySpec = {
  torso: { y: 0.46, r: [0.37, 0.33, 0.34], paint: "body" },
  belly: { at: [0, 0.42, -0.13], r: [0.3, 0.26, 0.24], paint: "secondary" },
  waistY: 0.28,
  neckY: 0.74,
  head: { at: [0, 0.95, -0.02], r: [0.36, 0.24, 0.31], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.34, 0.66, 0.0],
    length: 0.27,
    radius: 0.06,
    paint: "body",
    hand: [0.105, 0.085, 0.105],
    handPaint: "body",
    band: true,
  },
  leg: {
    hip: [0.17, 0.2, 0.04],
    length: 0.15,
    radius: 0.07,
    paint: "body",
    foot: [0.135, 0.05, 0.19],
    footPaint: "accent",
    footZ: -0.07,
  },
  extraAt: [0, 0.74, -0.2],
  topY: 1.38,
  ghostPaint: "body",
};

const BULB_R = 0.135;

export const buildHopsworth: CharacterBuilder = (b, s, face) => {
  // Huge eye bulbs on top of the head, each carrying half of the eye band.
  const eyeBulb = (side: 1 | -1): THREE.Mesh => {
    const bulb = b.sphere(s.head, "body", [side * 0.17, 1.14, -0.1], [BULB_R, BULB_R, BULB_R * 0.92], "mid");
    return b.facePatch(bulb, face, {
      theta: 1.3,
      thetaLength: 1.55,
      aspect: EYE_BAND_ASPECT / 2,
      turn: side * 0.22,
      uv: side > 0 ? UV_EYE_RIGHT : UV_EYE_LEFT,
      lift: 1.02,
    });
  };
  const rightEye = eyeBulb(1);
  eyeBulb(-1);
  b.facePatch(s.headMesh, face, { theta: 1.86, thetaLength: 0.78, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH });

  for (const spot of [
    [0.13, 0.6, 0.29],
    [-0.16, 0.47, 0.3],
    [0.04, 0.36, 0.33],
  ] as const) {
    b.sphere(s.upper, "accent", spot, [0.065, 0.065, 0.03], "lo");
  }
  b.sphere(s.head, "accent", [0.2, 1.02, 0.16], [0.05, 0.03, 0.05], "lo");
  b.sphere(s.head, "accent", [-0.12, 1.06, 0.19], [0.04, 0.025, 0.04], "lo");

  const bowTie = buildBow(b, s.upper, [0, 0.735, -0.255], 0.11, "accessory");

  // Throat sac: scaled from 0 (hidden) to 1 by the animator on honks.
  const sac = b.sphere(s.extra, "secondary", [0, 0.74, -0.25], [0.15, 0.12, 0.12], "mid");
  return { face: rightEye, jaw: null, sac, ears: [], tailTip: null, accessory: bowTie };
};

export const hopsworthMemento: MementoBuilder = (b, parent) => {
  buildBow(b, parent, [0, 0, 0], 0.16, "accessory");
};
