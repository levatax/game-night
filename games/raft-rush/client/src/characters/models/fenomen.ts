// Fenomen (The Influencer): pink crop top, yellow shorts, huge sunglasses, a high ponytail that swishes (the
// extra bone) and the selfie stick in the left hand with a phone and a glowing ring light at the tip.
// Owner: client-characters.

import * as THREE from "three";
import { boxGeo, flowerGeo, type V3 } from "../kit";
import { BASE_SPEC, buildBody, buildFace, decalMatrix, type ModelBuilder, onTorso, type TouristSpec } from "./common";

const GOLD = "#F2C14E";
const LENS = "#1B1B24";

/** Slim waist, narrower shoulders. */
const TORSO: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.33],
  [0.19, 0.35],
  [0.25, 0.42],
  [0.26, 0.55],
  [0.24, 0.7],
  [0.26, 0.86],
  [0.24, 1.0],
  [0.18, 1.1],
  [0.09, 1.16],
  [0.0, 1.18],
];

/** Selfie stick direction from the left grip at rest (arm hanging); the hold pose (Animator SIGNATURE_L) swings it
 * up and out to her left so the phone + ring light sit beside her head, facing her. */
export const SELFIE_STICK_DIR: V3 = [-0.576, 0.289, -0.764];
export const SELFIE_STICK_LENGTH = 0.66;

export const fenomenSpec: TouristSpec = {
  ...BASE_SPEC,
  shoulder: [0.27, 1.0, 0],
  mouthColor: "#E0457B",
  extra: { at: [0, 1.6, 0.13], parent: "head" },
  hideEyes: true,
  topY: 1.72,
};

export function buildFenomen(b: ModelBuilder): void {
  const s = b.spec;
  buildBody(b, {
    shirt: "outfit",
    sleeve: "outfit",
    sleeveLength: 0.3,
    legs: "accent",
    pantsLength: 0.32,
    shoes: "#FFFFFF",
    hands: "skin",
    torso: TORSO,
    torsoKey: "fenomen",
    torsoDepth: 0.88,
  });
  buildFace(b);

  // Bare midriff band, star print on the top, white sneaker soles.
  b.torus("upper", "skin", [0, 0.66, 0], 0.243, 0.035, [0, 1, 0], { scale: [1, 1, 0.88], tubular: 9 });
  const star = onTorso(TORSO, 0.88, 0, 0.88, 1.012);
  b.add("upper", flowerGeo(), "accent", decalMatrix(star.at, star.normal, 0.075), { outline: false });
  for (const side of [1, -1]) {
    b.sphere(side > 0 ? "legR" : "legL", "outfit", [s.hip[0] * side, 0.025, s.hip[2] + s.footZ], [0.102, 0.025, 0.152], 6, { outline: false });
  }

  // Hair: back cap, bangs, ponytail on the extra bone with a yellow scrunchie.
  b.sphere("head", "hair", [0, 1.455, 0.035], [0.268, 0.25, 0.25], 9);
  b.sphere("head", "hair", [0, 1.565, -0.17], [0.2, 0.065, 0.1], 6, { rot: [0.35, 0, 0] });
  for (const side of [1, -1]) b.sphere("head", "hair", [0.215 * side, 1.36, 0.0], [0.06, 0.13, 0.1], 5);
  b.torus("extra", "accent", [0, 1.6, 0.14], 0.055, 0.022, [0, 0.4, 1], { tubular: 8 });
  b.sphere("extra", "hair", [0, 1.56, 0.25], [0.09, 0.1, 0.09], 6);
  b.sphere("extra", "hair", [0, 1.44, 0.31], [0.075, 0.1, 0.07], 6);
  b.sphere("extra", "hair", [0, 1.32, 0.32], [0.05, 0.08, 0.05], 5);

  // Huge sunglasses with yellow frames.
  for (const side of [1, -1]) {
    const at: V3 = [0.092 * side, 1.445, -0.247];
    b.sphere("head", LENS, at, [0.078, 0.056, 0.024], 6, { rot: [0, side * 0.3, 0] });
    b.torus("head", "accent", at, 0.079, 0.012, [0.3 * side, 0, -1], { outline: false, scale: [1, 1, 0.72], tubular: 8 });
    b.sphere("head", "#FFFFFF", [at[0] - 0.03 * side, at[1] + 0.022, at[2] - 0.02], [0.018, 0.01, 0.005], 4, { outline: false });
    // Gold hoop earrings.
    b.torus("head", GOLD, [0.252 * side, 1.3, 0.0], 0.032, 0.007, [1, 0, 0], { outline: false, tubular: 6 });
  }
  b.box("head", "accent", [0, 1.458, -0.268], [0.04, 0.014, 0.014], [0, 0, 0], { outline: false });
  b.sphere("head", "cheek", [0.135, 1.34, -0.2], [0.035, 0.018, 0.01], 4, { outline: false, rot: [0, 0.55, 0] });
  b.sphere("head", "cheek", [-0.135, 1.34, -0.2], [0.035, 0.018, 0.01], 4, { outline: false, rot: [0, -0.55, 0] });

  // Selfie stick in the left hand: grip, telescopic pole, phone and ring light at the tip.
  const g = b.gripL;
  const d = new THREE.Vector3(SELFIE_STICK_DIR[0], SELFIE_STICK_DIR[1], SELFIE_STICK_DIR[2]).normalize();
  const from: V3 = [g.x - d.x * 0.06, g.y - d.y * 0.06, g.z - d.z * 0.06];
  const mid: V3 = [g.x + d.x * 0.28, g.y + d.y * 0.28, g.z + d.z * 0.28];
  const tip: V3 = [g.x + d.x * SELFIE_STICK_LENGTH, g.y + d.y * SELFIE_STICK_LENGTH, g.z + d.z * SELFIE_STICK_LENGTH];
  b.cylinder("armL", "#3A3A44", from, mid, 0.017, 1, 5);
  b.cylinder("armL", "#B9BFC8", mid, tip, 0.01, 0.8, 4, { outline: false, open: true });
  const phoneAt: V3 = [tip[0] + d.x * 0.02, tip[1] + d.y * 0.02, tip[2] + d.z * 0.02];
  b.add("armL", boxGeo(), "#22222A", phoneBoxMatrix(phoneAt, d, [0.075, 0.016, 0.14]));
  b.add("armL", boxGeo(), "#7FD3F5", phoneBoxMatrix([phoneAt[0] - d.x * 0.009, phoneAt[1] - d.y * 0.009, phoneAt[2] - d.z * 0.009], d, [0.064, 0.002, 0.124]), { outline: false });
  b.glow = { bone: "armL", at: new THREE.Vector3(...phoneAt), axis: d.clone(), radius: 0.115, tube: 0.016, color: "#FFF4DC" };
}

/** Box whose thin (local Y) axis runs along the stick. */
function phoneBoxMatrix(at: V3, axis: THREE.Vector3, size: V3): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  return new THREE.Matrix4().compose(new THREE.Vector3(at[0], at[1], at[2]), q, new THREE.Vector3(size[0], size[1], size[2]));
}
