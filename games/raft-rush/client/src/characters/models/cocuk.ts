// Kolluklu Çocuk (Floatie Kid): small, big-headed, yellow tee and blue swim shorts, orange inflatable
// armbands, a lemon duck ring around the waist, barefoot, freckles, a sunscreen-white nose and a propeller
// beanie whose propeller spins when he runs (the extra bone). Owner: client-characters.

import { BASE_SPEC, buildBody, buildFace, type ModelBuilder, TORSO_REGULAR, type TouristSpec } from "./common";

const SHORTS = "#3FB7D9";
const RING = "#FFF6B0";
const BEAK = "#FF9A2E";
const CAP_RED = "#E5383B";
const CAP_BLUE = "#3FA7F5";
const FRECKLE = "#C77B4E";

export const cocukSpec: TouristSpec = {
  ...BASE_SPEC,
  scale: 0.8,
  headAt: [0, 1.43, -0.01],
  headR: [0.3, 0.29, 0.28],
  neckY: 1.12,
  eyeAt: [0.1, 1.46, -0.262],
  eyeR: [0.046, 0.064, 0.026],
  mouthAt: [0, 1.32, -0.272],
  mouthW: 0.055,
  extra: { at: [0, 1.79, 0], parent: "head" },
  topY: 1.86,
};

export function buildCocuk(b: ModelBuilder): void {
  const s = b.spec;
  buildBody(b, {
    shirt: "outfit",
    sleeve: "outfit",
    sleeveLength: 0.3,
    legs: SHORTS,
    pantsLength: 0.34,
    shoes: "skin",
    hands: "skin",
    torso: TORSO_REGULAR,
    torsoKey: "regular",
    torsoDepth: 0.9,
  });
  buildFace(b);

  // An orange stripe on the tee.
  b.torus("upper", "accent", [0, 0.92, 0], 0.287, 0.02, [0, 1, 0], { outline: false, scale: [1, 1, 0.9], tubular: 9 });

  // Duck ring around the waist with its head at the front.
  b.torus("upper", RING, [0, 0.5, 0], 0.36, 0.1, [0, 1, 0], { scale: [1, 1, 0.92], radial: 5, tubular: 12 });
  b.sphere("upper", RING, [0, 0.6, -0.43], 0.1, 5);
  b.sphere("upper", RING, [0, 0.72, -0.44], 0.09, 6);
  b.cone("upper", BEAK, [0, 0.71, -0.51], [0, 0.7, -0.6], 0.04, 5);
  for (const side of [1, -1]) b.sphere("upper", "ink", [0.04 * side, 0.75, -0.515], 0.015, 4, { outline: false });

  // Inflatable armbands with a white valve.
  for (const side of [1, -1] as const) {
    const arm = side > 0 ? "armR" : "armL";
    const sx = s.shoulder[0] * side * 1.02;
    const y = s.shoulder[1] - 0.15;
    b.torus(arm, "accent", [sx, y, 0], s.armRadius * 1.55, 0.05, [0, 1, 0], { radial: 4, tubular: 9 });
    b.sphere(arm, "#FFFFFF", [sx + side * 0.09, y + 0.02, -0.04], 0.016, 4, { outline: false });
  }

  // Hair tufts under the beanie, freckles, sunscreen nose.
  for (const side of [1, -1]) {
    b.sphere("head", "hair", [0.26 * side, 1.43, 0.03], [0.06, 0.1, 0.11], 5);
    for (let i = 0; i < 2; i++) {
      b.sphere("head", FRECKLE, [(0.14 + i * 0.035) * side, 1.37 + i * 0.02, -0.25 + i * 0.012], 0.01, 4, { outline: false });
    }
  }
  b.sphere("head", "hair", [0.05, 1.6, -0.24], [0.08, 0.045, 0.05], 6, { rot: [0.6, 0, -0.3] });
  b.sphere("head", "#FFFFFF", [0, 1.395, -0.29], 0.046, 5, { outline: false });

  // Propeller beanie: red dome, blue brim band, yellow button; propeller on the extra bone.
  b.dome("head", CAP_RED, [0, 1.53, -0.005], [0.305, 0.25, 0.295], 9);
  b.torus("head", CAP_BLUE, [0, 1.535, -0.005], 0.3, 0.028, [0, 1, 0], { scale: [1, 1, 0.97], tubular: 10 });
  b.sphere("head", "accent", [0, 1.78, 0], 0.035, 4);
  b.cylinder("extra", "#7A7A80", [0, 1.76, 0], [0, 1.83, 0], 0.01, 1, 4, { outline: false, open: true });
  b.box("extra", "outfit", [0.1, 1.83, 0], [0.18, 0.012, 0.05], [0.25, 0, 0]);
  b.box("extra", CAP_BLUE, [-0.1, 1.83, 0], [0.18, 0.012, 0.05], [-0.25, 0, 0]);
}
