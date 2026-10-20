// Pip: black and white penguin, orange beak and feet, long red scarf. Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, type PartBuilder, UV_EYES } from "../parts";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

export const pipSpec: BodySpec = {
  torso: { y: 0.54, r: [0.35, 0.41, 0.34], paint: "body" },
  belly: { at: [0, 0.5, -0.12], r: [0.29, 0.35, 0.26], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.9,
  head: { at: [0, 1.1, 0.0], r: [0.285, 0.27, 0.27], paint: "body" },
  arm: {
    kind: "flipper",
    shoulder: [0.32, 0.78, 0.02],
    length: 0.4,
    radius: 0.06,
    paint: "body",
    hand: [0.055, 0.075, 0.12],
    handPaint: "body",
    band: true,
  },
  leg: {
    hip: [0.14, 0.14, 0.02],
    length: 0.08,
    radius: 0.05,
    paint: "accent",
    foot: [0.11, 0.04, 0.16],
    footPaint: "accent",
    footZ: -0.07,
  },
  extraAt: [0.1, 0.9, 0.2],
  topY: 1.42,
  ghostPaint: "body",
};

function buildScarfRing(b: PartBuilder, parent: THREE.Object3D, y: number, z: number): THREE.Mesh {
  const ring = b.torus(parent, "accessory", [0, y, z], 0.205, 0.062);
  ring.scale.y *= 0.9;
  return ring;
}

export const buildPip: CharacterBuilder = (b, s, face) => {
  const mask = b.sphere(s.head, "secondary", [0, 1.065, -0.12], [0.225, 0.19, 0.17], "mid");
  const eyes = b.facePatch(mask, face, { theta: 1.18, thetaLength: 1.0, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  const upperBeak = b.cone(s.head, "accent", [0, 1.02, -0.27], [0, 1.0, -0.43], 0.062, 8);
  upperBeak.scale.z *= 0.75;
  const jaw = b.group(s.head, [0, 1.0, -0.26], "jaw");
  const lowerBeak = b.cone(jaw, "accent", [0, 0.99, -0.27], [0, 0.985, -0.38], 0.045, 8);
  lowerBeak.scale.z *= 0.7;

  const scarf = b.group(s.upper, [0, 0.9, 0], "scarf");
  buildScarfRing(b, scarf, 0.9, 0.0);
  b.capsule(s.extra, "accessory", [0.1, 0.88, 0.22], [0.15, 0.6, 0.3], 0.052, "lo");
  b.sphere(s.extra, "slot", [0.155, 0.56, 0.305], [0.06, 0.03, 0.06], "lo");

  return { face: eyes, jaw, sac: null, ears: [], tailTip: null, accessory: scarf };
};

export const pipMemento: MementoBuilder = (b, parent) => {
  buildScarfRing(b, parent, 0.0, 0.0);
  b.capsule(parent, "accessory", [0.12, -0.01, 0.17], [0.2, -0.26, 0.26], 0.052, "lo");
};
