// Quacky: "plucky egg in a sailor hat". Forward-leaning yellow egg, wide flat bill, paddle wings,
// webbed feet, a tilted sailor hat whose slot ribbons stream behind. Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, UV_EYES, type V3 } from "../parts";
import { buildSailorHat } from "./accessories";
import { add, type BodySpec, type CharacterBuilder, type MementoBuilder } from "./common";

export const quackySpec: BodySpec = {
  torso: { y: 0.44, z: 0.02, r: [0.35, 0.32, 0.38], paint: "body", shape: "egg", egg: 0.08, pitch: -0.2 },
  belly: { at: [0, 0.4, -0.17], r: [0.27, 0.24, 0.2], paint: "secondary" },
  waistY: 0.3,
  neckY: 0.8,
  head: { at: [0, 1.05, -0.03], r: [0.34, 0.32, 0.33], paint: "body" },
  arm: {
    kind: "wing",
    shoulder: [0.33, 0.72, 0.04],
    length: 0.4,
    radius: 0.085,
    paint: "body",
    hand: [0.07, 0.07, 0.15],
    handPaint: "body",
    band: false,
  },
  leg: {
    hip: [0.15, 0.18, 0.03],
    length: 0.12,
    radius: 0.045,
    paint: "accent",
    foot: [0.13, 0.04, 0.19],
    footPaint: "accent",
    footZ: -0.09,
    toes: 3,
  },
  extraAt: [0, 0.48, 0.34],
  topY: 1.5,
  ghostPaint: "body",
};

const LOWER_BILL = "#E87A1A";
const HAT_AT: V3 = [0.06, 1.31, 0.0];
const HAT_TILT: V3 = [0.12, 0, -0.3];
const HAT_SCALE = 1.35;
const FLAIR = { flair: true } as const;
const FAN_TIPS: ReadonlyArray<V3> = [
  [-0.13, 0.72, 0.58],
  [0, 0.78, 0.62],
  [0.13, 0.72, 0.58],
];

export const buildQuacky: CharacterBuilder = (b, s) => {
  const h = quackySpec.head;
  b.facePatch(s.head, h.at, h.r, "eyes", { theta: 1.16, thetaLength: 0.95, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  // Cheek feather tufts at the back-sides of the head (side hook).
  for (const side of [1, -1]) {
    b.cone(s.head, "body", [side * 0.24, 1.0, 0.12], [side * 0.39, 1.07, 0.2], 0.075, {
      ...FLAIR,
      segments: 5,
      scale: [1, 1, 0.55],
    });
  }

  // Wide flat bill: the lower half hangs from a jaw pivot so it can open.
  b.sphere(s.head, "accent", [0, 0.99, -0.36], [0.18, 0.05, 0.17], { ...FLAIR, detail: "mid", gradient: 0.1 });
  const jaw = b.group(s.head, [0, 0.965, -0.22], "jaw");
  b.sphere(jaw, LOWER_BILL, [0, 0.95, -0.33], [0.15, 0.04, 0.14], { ...FLAIR, detail: "lo" });

  // Upturned 3-feather tail fan.
  const fanBase: V3 = [0, 0.5, 0.38];
  for (const [x, y, z] of FAN_TIPS) {
    b.cone(s.extra, "body", fanBase, [x, y, z], 0.075, { ...FLAIR, segments: 6, scale: [1, 1, 0.45] });
  }

  // Sailor hat (headwear + KO accessory) with two slot ribbons hanging from the back rim.
  const hat = b.group(s.head, HAT_AT, "hat");
  const back = buildSailorHat(b, hat, HAT_AT, HAT_SCALE, HAT_TILT);
  const ribbons: THREE.Group[] = [];
  for (const side of [1, -1]) {
    const from = add(back, side * 0.035, -0.005, 0.03);
    const ribbon = b.group(hat, from, side > 0 ? "ribbonR" : "ribbonL");
    // Hang down the back of the head, clear of the skull, splayed outward.
    const to = add(from, side * 0.06, -0.17, 0.15);
    b.flatStrip(ribbon, "slot", from, to, 0.042, 0.012, [0, 0.6, 1], { accessory: true, flair: true, gradient: 0 });
    ribbons.push(ribbon);
  }

  const sp = s.springs;
  sp.add(s.extra, "tailStiff", FAN_TIPS[1]);
  sp.add(hat, "hat", add(HAT_AT, 0, 0.14, 0));
  for (const ribbon of ribbons) {
    const side = ribbon.name === "ribbonR" ? 1 : -1;
    sp.add(ribbon, "ribbon", add(back, side * 0.095, -0.175, 0.18));
  }

  return { jaw, sac: null, ears: [], tail: [], accessory: hat, headwear: hat, cheeks: [], eyeBulbs: [] };
};

export const quackyMemento: MementoBuilder = (b, parent) => {
  const back = buildSailorHat(b, parent, [0, -0.05, 0], 1.3, [0.2, 0, -0.35]);
  for (const side of [1, -1]) {
    const from = add(back, side * 0.035, 0, 0);
    b.flatStrip(parent, "slot", from, add(from, side * 0.05, -0.16, 0.04), 0.034, 0.012, [0, 0, 1], { accessory: true });
  }
};
