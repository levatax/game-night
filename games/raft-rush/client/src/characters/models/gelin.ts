// Balayı Gelini (Honeymoon Bride): white wedding dress with a teal sash, opera gloves, an auburn bun with a
// veil that flutters behind her (the extra bone), a snorkel mask pushed up on the forehead with its tube,
// and big teal flippers instead of shoes: the fastest swimmer on the island. Owner: client-characters.

import * as THREE from "three";
import { coneGeo, alongMatrix, type V3 } from "../kit";
import { BASE_SPEC, buildBody, buildFace, type ModelBuilder, type TouristSpec } from "./common";

const VEIL = "#F2F6FF";
const GLASS = "#BDF2F0";
const TEAL_DARK = "#4FA79E";
const GOLD = "#F2C14E";

/** Only the bodice: the skirt hides everything below the waist. */
const TORSO: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.66],
  [0.24, 0.68],
  [0.26, 0.86],
  [0.24, 1.0],
  [0.18, 1.1],
  [0.09, 1.16],
  [0.0, 1.18],
];

/** The skirt flares from the waist to just above the flippers. */
const SKIRT: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.2],
  [0.4, 0.2],
  [0.415, 0.25],
  [0.37, 0.42],
  [0.31, 0.58],
  [0.265, 0.72],
  [0.0, 0.73],
];

export const gelinSpec: TouristSpec = {
  ...BASE_SPEC,
  shoulder: [0.27, 1.0, 0],
  eyeR: [0.037, 0.056, 0.022],
  mouthColor: "#D93A4A",
  extra: { at: [0, 1.6, 0.12], parent: "head" },
  topY: 1.74,
};

export function buildGelin(b: ModelBuilder): void {
  const s = b.spec;
  buildBody(b, {
    shirt: "outfit",
    sleeve: "outfit",
    sleeveLength: 0.25,
    legs: "skin",
    pantsLength: 0,
    shoes: "accent",
    hands: "white",
    forearm: "white",
    torso: TORSO,
    torsoKey: "gelin",
    torsoDepth: 0.88,
    noFeet: true,
  });
  buildFace(b);

  // Skirt, teal sash with a bow, pearl necklace, puffy sleeves.
  b.lathe("upper", "outfit", "gelin-skirt", SKIRT, [0, 0, 0], [1, 1, 0.92], 10);
  b.torus("upper", "accent", [0, 0.72, 0], 0.262, 0.03, [0, 1, 0], { scale: [1, 1, 0.9], tubular: 9 });
  for (const side of [1, -1]) b.sphere("upper", "accent", [0.06 * side, 0.72, 0.245], [0.06, 0.04, 0.025], 4, { rot: [0, 0, side * 0.5] });
  b.torus("upper", "#F4F1EA", [0, 1.1, -0.01], 0.13, 0.016, [0, 1, 0.25], { outline: false, tubular: 8 });
  for (const side of [1, -1] as const) {
    const arm = side > 0 ? "armR" : "armL";
    b.sphere(arm, "outfit", [s.shoulder[0] * side * 1.04, s.shoulder[1] - 0.04, 0], [0.1, 0.1, 0.1], 5);
    // Flippers: a big flat fin with a darker rim, over the foot.
    const leg = side > 0 ? "legR" : "legL";
    const hx = s.hip[0] * side;
    b.sphere(leg, "accent", [hx, 0.045, -0.14], [0.13, 0.035, 0.27], 7);
    b.sphere(leg, TEAL_DARK, [hx, 0.03, -0.3], [0.12, 0.018, 0.12], 5, { outline: false });
    b.sphere(leg, "accent", [hx, 0.08, 0.0], [0.09, 0.06, 0.1], 5);
  }

  // Hair: back cap, bun, side curls, tiara.
  b.sphere("head", "hair", [0, 1.455, 0.035], [0.266, 0.25, 0.25], 9);
  b.sphere("head", "hair", [0, 1.565, -0.17], [0.2, 0.062, 0.1], 6, { rot: [0.38, 0, 0] });
  b.sphere("head", "hair", [0, 1.63, 0.1], 0.11, 6);
  for (const side of [1, -1]) b.sphere("head", "hair", [0.225 * side, 1.33, -0.04], [0.045, 0.09, 0.045], 5);
  b.torus("head", GOLD, [0, 1.6, -0.08], 0.17, 0.01, [0, 1, -0.55], { outline: false, arc: Math.PI, spin: Math.PI, tubular: 6 });
  // Long lashes, blush.
  for (const side of [1, -1]) {
    b.box("head", "ink", [(s.eyeAt[0] + 0.03) * side, s.eyeAt[1] + 0.05, s.eyeAt[2] - 0.004], [0.026, 0.007, 0.006], [0, side * 0.3, side * 0.45], { outline: false });
    b.sphere("head", "cheek", [0.14 * side, 1.34, -0.198], [0.038, 0.02, 0.01], 4, { outline: false, rot: [0, side * 0.55, 0] });
  }
  b.sphere("head", "skin", [0, 1.38, -0.248], 0.03, 5, { outline: false });

  // Snorkel mask pushed up on the forehead and the tube on the left.
  const mask: V3 = [0, 1.585, -0.185];
  b.torus("head", "accent", mask, 0.105, 0.022, [0, 0.55, -1], { scale: [1.05, 1, 0.72], tubular: 9 });
  b.sphere("head", GLASS, [mask[0], mask[1], mask[2] - 0.012], [0.095, 0.055, 0.03], 6, { outline: false, rot: [-0.5, 0, 0] });
  b.cylinder("head", "accent", [-0.215, 1.33, -0.09], [-0.24, 1.76, 0.0], 0.019, 1, 5, { open: true });
  b.cylinder("head", "#FF7A3D", [-0.239, 1.74, -0.004], [-0.241, 1.79, 0.006], 0.022, 1, 5, { outline: false });

  // Veil: a flattened cone from the bun down her back (extra bone: it flutters when she runs).
  const veil = alongMatrix([0, 0.92, 0.27], [0, 1.66, 0.12], 0.3).multiply(new THREE.Matrix4().makeScale(1, 1, 0.32));
  b.add("extra", coneGeo(8), VEIL, veil);
}
