// Şef (The Chef): double-breasted white chef coat, red neckerchief and apron, black-and-white pants, a tall
// puffy toque that wobbles (the extra bone), a curly black mustache, and his ladle raised in the left hand
// like a scepter. Cooked food tastes better (+5) when he made it. Owner: client-characters.

import type { V3 } from "../kit";
import { BASE_SPEC, buildBody, buildFace, type ModelBuilder, onTorso, TORSO_REGULAR, type TouristSpec } from "./common";

const BUTTON = "#2B2B2B";
const PANTS = "#3A3A3A";
const SILVER = "#C9CED6";

const TORSO: ReadonlyArray<readonly [number, number]> = TORSO_REGULAR.map(([r, y]) => [y > 0.4 && y < 0.9 ? r * 1.06 : r, y] as const);

/** Ladle direction from the left grip at rest (normalized); the hold pose (Animator SIGNATURE_L) raises it. */
const LADLE_DIR: V3 = [-0.526, 0.042, -0.85];

export const sefSpec: TouristSpec = {
  ...BASE_SPEC,
  shoulder: [0.3, 1.0, 0],
  extra: { at: [0, 1.64, 0], parent: "head" },
  topY: 1.98,
};

export function buildSef(b: ModelBuilder): void {
  const s = b.spec;
  buildBody(b, {
    shirt: "outfit",
    sleeve: "outfit",
    sleeveLength: 0.78,
    legs: PANTS,
    pantsLength: 1,
    shoes: "#1E1E1E",
    hands: "skin",
    torso: TORSO,
    torsoKey: "sef",
    torsoDepth: 0.92,
  });
  buildFace(b);

  // Double-breasted buttons.
  for (const yaw of [0.3, -0.3]) {
    for (const y of [0.82, 0.96]) b.sphere("upper", BUTTON, onTorso(TORSO, 0.92, yaw, y, 1.01).at, 0.02, 4, { outline: false });
  }
  // Red apron over the belly with a white pocket.
  b.sphere("upper", "accent", [0, 0.6, -0.175], [0.27, 0.3, 0.15], 7);
  b.box("upper", "#FFFFFF", [0, 0.56, -0.318], [0.15, 0.09, 0.012], [0.2, 0, 0], { outline: false });
  // Neckerchief: a ring with a knot and two tails.
  b.torus("upper", "accent", [0, 1.1, -0.01], 0.145, 0.032, [0, 1, 0.15], { tubular: 9 });
  b.sphere("upper", "accent", [0, 1.07, -0.165], 0.04, 4);
  for (const side of [1, -1]) b.cone("upper", "accent", [0.02 * side, 1.06, -0.17], [0.06 * side, 0.96, -0.2], 0.03, 4, { outline: false });
  // Rolled-up sleeve cuffs.
  for (const side of [1, -1] as const) {
    const arm = side > 0 ? "armR" : "armL";
    const y = s.shoulder[1] - s.armLength * 0.72;
    b.torus(arm, "outfit", [s.shoulder[0] * side * 1.02, y, 0], s.armRadius * 1.15, 0.028, [0, 1, 0], { tubular: 8 });
    b.torus(arm, "accent", [s.shoulder[0] * side * 1.02, y - 0.02, 0], s.armRadius * 1.1, 0.007, [0, 1, 0], { outline: false, tubular: 8 });
    // Checkered hint: a white stripe down each trouser leg.
    const leg = side > 0 ? "legR" : "legL";
    b.box(leg, "#FFFFFF", [s.hip[0] * side * 1.0 + side * 0.08, 0.27, s.hip[2]], [0.008, 0.26, 0.04], [0, 0, 0], { outline: false });
  }

  // Hair under the toque, thick brows, curly mustache, rosy cheeks, round nose.
  for (const side of [1, -1]) {
    b.sphere("head", "hair", [0.22 * side, 1.4, 0.04], [0.05, 0.09, 0.1], 5);
    b.box("head", "hair", [0.087 * side, 1.512, -0.222], [0.075, 0.022, 0.02], [0, side * 0.3, -side * 0.18], { outline: false });
    b.torus("head", "hair", [0.062 * side, 1.335, -0.243], 0.035, 0.015, [0.25 * side, 0, -1], { outline: false, arc: Math.PI * 1.4, spin: side > 0 ? 3.6 : -0.4, tubular: 7 });
    b.sphere("head", "cheek", [0.14 * side, 1.34, -0.2], [0.035, 0.02, 0.01], 4, { outline: false, rot: [0, side * 0.55, 0] });
  }
  b.sphere("head", "hair", [0, 1.4, 0.12], [0.22, 0.14, 0.14], 6);
  b.sphere("head", "hair", [0, 1.34, -0.245], [0.03, 0.02, 0.02], 4, { outline: false });
  b.sphere("head", "#D9926F", [0, 1.378, -0.252], 0.042, 5, { outline: false });

  // Toque: band + puffy mushroom top, on the extra bone so it wobbles.
  b.cylinder("extra", "#FFFFFF", [0, 1.55, 0.005], [0, 1.67, 0.005], 0.212, 1.04, 10, { open: true });
  b.lathe(
    "extra",
    "#FFFFFF",
    "sef-toque",
    [
      [0.215, 1.66],
      [0.27, 1.72],
      [0.3, 1.8],
      [0.295, 1.88],
      [0.24, 1.94],
      [0.12, 1.97],
      [0, 1.975],
    ],
    [0, 0, 0.005],
    [1, 1, 1],
    10,
  );

  // The ladle, raised in the left fist like a scepter (the hold pose tips this rest direction up and out):
  // handle + bowl at the far end.
  const g = b.gripL;
  const d = LADLE_DIR;
  const len = 0.4;
  const base: V3 = [g.x - d[0] * 0.05, g.y - d[1] * 0.05, g.z - d[2] * 0.05];
  const top: V3 = [g.x + d[0] * len, g.y + d[1] * len, g.z + d[2] * len];
  b.cylinder("armL", SILVER, base, top, 0.013, 1, 5);
  b.sphere("armL", SILVER, [top[0] + d[0] * 0.04, top[1] + d[1] * 0.04, top[2] + d[2] * 0.04], [0.065, 0.065, 0.065], 6);
}
