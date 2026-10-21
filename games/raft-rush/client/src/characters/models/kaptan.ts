// Kaptan (The Captain): white uniform with navy shoulder boards and gold buttons, a proper captain's cap, a
// grey mustache + chin beard and a pipe that never comes out of his mouth ("the ship didn't sink, it
// anchored"). Owner: client-characters.

import type { V3 } from "../kit";
import { BASE_SPEC, buildBody, buildFace, type ModelBuilder, onTorso, TORSO_REGULAR, type TouristSpec } from "./common";

const GOLD = "#F2C14E";
const NAVY_DARK = "#1E2430";
const BEARD = "#E4E4E0";

/** A slightly portly captain. */
const TORSO: ReadonlyArray<readonly [number, number]> = TORSO_REGULAR.map(([r, y]) => [y > 0.45 && y < 0.8 ? r * 1.04 : r, y] as const);

export const kaptanSpec: TouristSpec = {
  ...BASE_SPEC,
  topY: 1.8,
};

export function buildKaptan(b: ModelBuilder): void {
  const s = b.spec;
  buildBody(b, {
    shirt: "outfit",
    sleeve: "outfit",
    sleeveLength: 1,
    legs: "outfit",
    pantsLength: 1,
    shoes: NAVY_DARK,
    hands: "skin",
    torso: TORSO,
    torsoKey: "kaptan",
    torsoDepth: 0.9,
  });
  buildFace(b);

  // Navy belt with a gold buckle, gold buttons and a navy tie.
  b.torus("upper", "accent", [0, 0.6, 0], 0.318, 0.03, [0, 1, 0], { scale: [1, 1, 0.9] });
  b.box("upper", GOLD, [0, 0.6, -0.29], [0.08, 0.06, 0.02], [0, 0, 0], { outline: false });
  for (const y of [0.74, 0.86, 0.98]) {
    const p = onTorso(TORSO, 0.9, 0.2, y, 1.01);
    b.sphere("upper", GOLD, p.at, 0.021, 4, { outline: false });
  }
  b.cone("upper", "accent", [0, 0.97, -0.252], [0, 0.82, -0.268], 0.04, 4, { outline: false });
  b.sphere("upper", "accent", [0, 1.07, -0.205], [0.035, 0.03, 0.02], 4, { outline: false });
  // Collar.
  b.torus("upper", "outfit", [0, 1.1, -0.01], 0.15, 0.03, [0, 1, 0.12]);

  for (const side of [1, -1] as const) {
    const arm = side > 0 ? "armR" : "armL";
    const sx = s.shoulder[0] * side;
    // Shoulder boards with gold stripes.
    b.box(arm, "accent", [sx, s.shoulder[1] + 0.075, 0], [0.13, 0.03, 0.12], [0, 0, -side * 0.25]);
    b.box(arm, GOLD, [sx, s.shoulder[1] + 0.093, 0], [0.11, 0.008, 0.02], [0, 0, -side * 0.25], { outline: false });
    // Navy cuff with a gold ring.
    const cuffY = s.shoulder[1] - s.armLength + s.handR * 1.3;
    b.torus(arm, "accent", [sx * 1.03, cuffY, 0], s.armRadius * 1.15, 0.022, [0, 1, 0], { tubular: 8 });
    b.torus(arm, GOLD, [sx * 1.03, cuffY + 0.03, 0], s.armRadius * 1.1, 0.007, [0, 1, 0], { outline: false, tubular: 8 });
  }

  // Hair: grey sideburns and the back of the head under the cap.
  for (const side of [1, -1]) b.sphere("head", "hair", [0.225 * side, 1.38, 0.02], [0.055, 0.1, 0.09], 5);
  b.sphere("head", "hair", [0, 1.4, 0.1], [0.23, 0.16, 0.16], 6);
  // Mustache, chin beard, bushy brows, nose.
  for (const side of [1, -1]) {
    b.sphere("head", BEARD, [0.05 * side, 1.338, -0.238], [0.058, 0.024, 0.026], 5, { rot: [0, 0, side * 0.32] });
    b.box("head", "hair", [0.088 * side, 1.51, -0.222], [0.085, 0.026, 0.026], [0, side * 0.3, side * 0.18], { outline: false });
  }
  b.sphere("head", BEARD, [0, 1.2, -0.17], [0.12, 0.07, 0.085], 6);
  b.sphere("head", "#F0A88A", [0, 1.375, -0.252], 0.038, 5, { outline: false });

  // Captain's cap: navy band, white crown, black visor, gold badge.
  b.cylinder("head", "accent", [0, 1.545, 0.005], [0, 1.625, 0.005], 0.214, 1.03, 10, { open: true });
  b.lathe(
    "head",
    "outfit",
    "kaptan-cap",
    [
      [0.21, 1.615],
      [0.262, 1.68],
      [0.278, 1.725],
      [0.24, 1.76],
      [0.12, 1.775],
      [0, 1.78],
    ],
    [0, 0, 0.012],
    [1, 1, 1],
    9,
  );
  b.sphere("head", NAVY_DARK, [0, 1.548, -0.205], [0.17, 0.022, 0.12], 6, { rot: [-0.22, 0, 0] });
  b.disc("head", GOLD, [0, 1.6, -0.218], [0, 0, -1], 0.034, 0.012, 6, { outline: false });
  b.sphere("head", "outfit", [0, 1.6, -0.226], 0.012, 4, { outline: false });

  // Pipe: stem from the right mouth corner, bowl with an ember.
  const stemFrom: V3 = [0.035, 1.3, -0.236];
  const bowl: V3 = [0.12, 1.255, -0.33];
  b.cylinder("head", "#4A2E1C", stemFrom, [bowl[0], bowl[1] + 0.01, bowl[2]], 0.009, 1, 4, { outline: false, open: true });
  b.cylinder("head", "#7A4A2A", [bowl[0], bowl[1] - 0.025, bowl[2]], [bowl[0], bowl[1] + 0.05, bowl[2]], 0.029, 1.12, 6);
  b.sphere("head", "#FF7A2E", [bowl[0], bowl[1] + 0.05, bowl[2]], [0.024, 0.008, 0.024], 4, { outline: false });
}
