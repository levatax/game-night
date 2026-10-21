// Emekli Amca (Retired Uncle): Hawaiian shirt with orange hibiscus prints over a proud belly, khaki shorts,
// white socks in brown sandals, a bald head with a white fringe, round glasses, a walrus mustache and his
// transistor radio (the island's music plays from it) in the left hand; the antenna wobbles (extra bone).
// Owner: client-characters.

import { flowerGeo, type V3 } from "../kit";
import { BASE_SPEC, buildBody, buildFace, decalMatrix, type ModelBuilder, onTorso, type TouristSpec } from "./common";

const KHAKI = "#CDBA8C";
const SANDAL = "#7A4A2A";
const FRAME = "#3A3A3A";
const RADIO = "#B5482E";
const CREAM = "#F3E3C0";
const CHROME = "#C9CED6";

/** Belly first. */
const TORSO: ReadonlyArray<readonly [number, number]> = [
  [0.0, 0.33],
  [0.22, 0.35],
  [0.3, 0.42],
  [0.345, 0.55],
  [0.345, 0.66],
  [0.31, 0.82],
  [0.26, 0.98],
  [0.2, 1.09],
  [0.1, 1.16],
  [0.0, 1.18],
];

/** Hibiscus prints: (yaw from the front, height). */
const PRINTS: ReadonlyArray<readonly [number, number]> = [
  [0.35, 0.82],
  [-0.45, 0.6],
  [1.2, 0.96],
  [-1.3, 0.78],
  [2.4, 0.86],
  [-2.2, 0.62],
  [3.1, 0.7],
];

export const amcaSpec: TouristSpec = {
  ...BASE_SPEC,
  shoulder: [0.3, 0.99, 0],
  mouthAt: [0, 1.3, -0.233],
  extra: null,
  topY: 1.66,
};

/** Where the radio hangs from the left grip, and its antenna base (feet space offsets from the grip). */
export const RADIO_OFFSET: V3 = [-0.02, -0.1, 0];

export function buildAmca(b: ModelBuilder): void {
  const s = b.spec;
  buildBody(b, {
    shirt: "outfit",
    sleeve: "outfit",
    sleeveLength: 0.42,
    legs: KHAKI,
    pantsLength: 0.42,
    shoes: SANDAL,
    hands: "skin",
    torso: TORSO,
    torsoKey: "amca",
    torsoDepth: 0.95,
  });
  buildFace(b);

  for (const [yaw, y] of PRINTS) {
    const p = onTorso(TORSO, 0.95, yaw, y, 1.012);
    b.add("upper", flowerGeo(), "accent", decalMatrix(p.at, p.normal, 0.06, yaw * 2), { outline: false });
  }
  // Open collar (two white-ish lapel flaps) and shirt buttons.
  for (const side of [1, -1]) {
    b.box("upper", "#2E9CC0", [0.075 * side, 1.07, -0.165], [0.1, 0.07, 0.02], [0.5, side * 0.3, side * 0.6], { outline: false });
  }
  for (const side of [1, -1] as const) {
    const arm = side > 0 ? "armR" : "armL";
    const sx = s.shoulder[0] * side;
    b.add(arm, flowerGeo(), "accent", decalMatrix([sx + side * 0.075, 0.9, -0.02], [side, 0, -0.2], 0.04, 1), { outline: false });
    const leg = side > 0 ? "legR" : "legL";
    const hx = s.hip[0] * side;
    // White socks pulled up, sandal strap.
    b.cylinder(leg, "#FFFFFF", [hx, 0.08, s.hip[2]], [hx, 0.24, s.hip[2]], s.legRadius * 0.92, 1, 6, { open: true });
    b.torus(leg, SANDAL, [hx, 0.09, s.hip[2] + s.footZ - 0.04], 0.07, 0.014, [0, 0.3, -1], { outline: false, scale: [1.2, 1, 0.8], tubular: 6 });
  }

  // Bald head with a white fringe and a lone comb-over strand.
  for (const side of [1, -1]) b.sphere("head", "hair", [0.205 * side, 1.37, 0.07], [0.075, 0.1, 0.13], 6);
  b.sphere("head", "hair", [0, 1.36, 0.17], [0.17, 0.1, 0.09], 6);
  b.torus("head", "hair", [0, 1.555, -0.02], 0.13, 0.009, [1, 0, 0], { outline: false, arc: Math.PI * 0.8, spin: 0.3, tubular: 6 });
  // Round glasses, walrus mustache, bushy white brows, big nose.
  for (const side of [1, -1]) {
    b.torus("head", FRAME, [0.088 * side, 1.443, -0.247], 0.052, 0.009, [0.3 * side, 0, -1], { outline: false, tubular: 8 });
    b.box("head", FRAME, [0.17 * side, 1.45, -0.19], [0.006, 0.008, 0.09], [0, side * 0.5, 0], { outline: false });
    b.box("head", "hair", [0.088 * side, 1.515, -0.222], [0.09, 0.03, 0.03], [0, side * 0.3, -side * 0.15], { outline: false });
  }
  b.box("head", FRAME, [0, 1.455, -0.262], [0.04, 0.008, 0.008], [0, 0, 0], { outline: false });
  b.sphere("head", "#F0F0F0", [0, 1.335, -0.24], [0.11, 0.034, 0.04], 6);
  b.sphere("head", "#E2A07F", [0, 1.375, -0.254], 0.048, 5, { outline: false });

  // Transistor radio in the left hand: body, cream speaker, dial, handle and the antenna.
  const g = b.gripL;
  const c: V3 = [g.x + RADIO_OFFSET[0], g.y + RADIO_OFFSET[1], g.z + RADIO_OFFSET[2]];
  b.box("armL", RADIO, c, [0.08, 0.14, 0.21]);
  b.disc("armL", CREAM, [c[0] - 0.042, c[1] - 0.01, c[2] + 0.03], [-1, 0, 0], 0.048, 0.008, 8, { outline: false });
  for (const dy of [-0.018, 0.018]) b.box("armL", "#8A3522", [c[0] - 0.047, c[1] - 0.01 + dy, c[2] + 0.03], [0.002, 0.006, 0.07], [0, 0, 0], { outline: false });
  b.disc("armL", CHROME, [c[0] - 0.042, c[1] + 0.035, c[2] - 0.065], [-1, 0, 0], 0.02, 0.012, 6, { outline: false });
  b.torus("armL", "#3A2A22", [c[0], c[1] + 0.07, c[2]], 0.06, 0.009, [1, 0, 0], { outline: false, arc: Math.PI, spin: 0, tubular: 6 });
  b.cylinder("armL", CHROME, [c[0], c[1] + 0.07, c[2] - 0.09], [c[0] + 0.02, c[1] + 0.36, c[2] - 0.02], 0.005, 0.7, 4, { outline: false });
  b.sphere("armL", CHROME, [c[0] + 0.02, c[1] + 0.365, c[2] - 0.02], 0.012, 4, { outline: false });
}
