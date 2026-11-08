// Hopsworth: "dapper, widest and lowest". Wide squat frog with two eye domes on top, splayed
// M-legs, a red bow tie and slot-colored suspenders crossing in an X on the back.
// Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, type PartBuilder, UV_EYE_LEFT, UV_EYE_RIGHT, UV_MOUTH, type V3 } from "../parts";
import { buildBow } from "./accessories";
import type { BodySpec, CharacterBuilder, MementoBuilder } from "./common";

export const hopsworthSpec: BodySpec = {
  torso: { y: 0.42, r: [0.39, 0.31, 0.34], paint: "body" },
  belly: { at: [0, 0.38, -0.15], r: [0.32, 0.25, 0.22], paint: "secondary", detail: "lo" },
  waistY: 0.28,
  neckY: 0.74,
  head: { at: [0, 0.97, -0.02], r: [0.43, 0.27, 0.35], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.37, 0.62, 0.0],
    length: 0.27,
    radius: 0.055,
    paint: "body",
    hand: [0.085, 0.06, 0.085],
    handPaint: "body",
    handVariant: "pad3",
    padPaint: "#A6E07E",
    band: true,
    reach: [0.03, -0.02],
  },
  leg: {
    variant: "frog",
    hip: [0.2, 0.2, 0.06],
    length: 0.15,
    radius: 0.06,
    paint: "body",
    foot: [0.16, 0.035, 0.21],
    footPaint: "body",
    footZ: -0.1,
    knee: [0.36, 0.14, 0.05],
    ankle: [0.3, 0.06, -0.02],
    footYaw: 0.35,
    toes: 3,
    padPaint: "#A6E07E",
  },
  extraAt: [0, 0.42, 0.3],
  topY: 1.38,
  ghostPaint: "body",
};

const BULB_R = 0.155;
const BOW = "#E8384F";
const BOW_KNOT = "#B8263A";
const BUTTON = "#FFF4DC";
const T = hopsworthSpec.torso;

/** Point on the torso surface at (x, y), front (side −1) or back (+1), sunk by `sink`. */
function onTorso(x: number, y: number, side: 1 | -1, sink = 0.012): V3 {
  const [rx, ry, rz] = T.r;
  const u = Math.min(0.995, (x / rx) ** 2 + ((y - T.y) / ry) ** 2);
  const z = side * rz * Math.sqrt(1 - u);
  // Push in along the (approximate) normal by `sink`.
  const nx = x / (rx * rx);
  const ny = (y - T.y) / (ry * ry);
  const nz = z / (rz * rz);
  const len = Math.hypot(nx, ny, nz) || 1;
  return [x - (nx / len) * sink, y - (ny / len) * sink, z - (nz / len) * sink];
}

/** Point on the head ellipsoid surface at (x, y), back (+1) or front (−1). */
function onHead(x: number, y: number, side: 1 | -1): V3 {
  const h = hopsworthSpec.head;
  const u = Math.min(0.995, ((x - h.at[0]) / h.r[0]) ** 2 + ((y - h.at[1]) / h.r[1]) ** 2);
  return [x, y, h.at[2] + side * h.r[2] * Math.sqrt(1 - u)];
}

/** A flat painted dot (12-triangle cone) on a surface point, facing away from the body center. */
function paintDot(b: PartBuilder, pivot: THREE.Object3D, paint: "accent" | `#${string}`, at: V3, r: number): void {
  const c: V3 = [0, at[1] > 0.8 ? hopsworthSpec.head.at[1] : T.y, 0];
  const d = Math.hypot(at[0] - c[0], at[1] - c[1], at[2] - c[2]) || 1;
  const n: V3 = [(at[0] - c[0]) / d, (at[1] - c[1]) / d, (at[2] - c[2]) / d];
  const base: V3 = [at[0] - n[0] * 0.01, at[1] - n[1] * 0.01, at[2] - n[2] * 0.01];
  const tip: V3 = [at[0] + n[0] * 0.012, at[1] + n[1] * 0.012, at[2] + n[2] * 0.012];
  b.cone(pivot, paint, base, tip, r, { segments: 6, outline: false, gradient: 0, hiOnly: true });
}

/** Slot suspenders: front straps, over the shoulders, crossing in an X on the back. */
function buildSuspenders(b: PartBuilder, upper: THREE.Object3D): void {
  const opts = { outline: false, gradient: 0, radial: 4 } as const;
  // A 4-sided band sunk into the torso reads as a flat strap.
  for (const side of [1, -1] as const) {
    const pts: V3[] = [];
    for (const y of [0.22, 0.46, 0.64]) pts.push(onTorso(side * 0.15, y, -1));
    pts.push(onTorso(side * 0.155, 0.73, 1, 0.02));
    for (let i = 0; i <= 3; i++) {
      const t = i / 3;
      pts.push(onTorso(side * (0.15 - 0.33 * t), 0.7 - 0.46 * t, 1));
    }
    b.tube(upper, "slot", pts, pts.map(() => 0.03), opts);
    paintDot(b, upper, BUTTON, onTorso(side * 0.15, 0.24, -1, 0), 0.028);
  }
}

export const buildHopsworth: CharacterBuilder = (b, s) => {
  // Huge eye bulbs on top of the head (scale-y blink pivots), each carrying half of the eye band.
  const eyeBulbs: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const at: V3 = [side * 0.2, 1.2, -0.09];
    const bulb = b.group(s.head, [side * 0.2, 1.08, -0.09], side > 0 ? "eyeBulbR" : "eyeBulbL");
    const r: V3 = [BULB_R, BULB_R, BULB_R * 0.92];
    b.sphere(bulb, "body", at, r, { detail: "mid", flair: true, shadow: side > 0 });
    b.facePatch(bulb, at, r, "eyes", {
      theta: 1.3,
      thetaLength: 1.55,
      aspect: EYE_BAND_ASPECT / 2,
      turn: side * 0.22,
      uv: side > 0 ? UV_EYE_RIGHT : UV_EYE_LEFT,
      lift: 1.02,
    });
    eyeBulbs.push(bulb);
  }
  const h = hopsworthSpec.head;
  b.facePatch(s.head, h.at, h.r, "mouth", { theta: 1.85, thetaLength: 0.72, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH });

  // Painted spots (merged, no outline): low cones sitting on the skin.
  paintDot(b, s.upper, "accent", onTorso(0.16, 0.58, 1, 0), 0.07);
  paintDot(b, s.upper, "accent", onTorso(-0.2, 0.46, 1, 0), 0.06);
  paintDot(b, s.upper, "accent", onTorso(0.05, 0.32, 1, 0), 0.055);
  paintDot(b, s.head, "accent", onHead(0.24, 1.06, 1), 0.06);
  paintDot(b, s.head, "accent", onHead(-0.14, 1.12, 1), 0.05);

  buildSuspenders(b, s.upper);

  // Throat sac (scale pivot, hidden until a croak inflates it).
  const sac = b.group(s.upper, [0, 0.76, -0.24], "sac");
  b.sphere(sac, "secondary", [0, 0.76, -0.28], [0.17, 0.13, 0.13], { detail: "xs" });

  const bow = b.group(s.upper, [0, 0.68, -0.27], "bow");
  buildBow(b, bow, [0, 0.68, -0.27], 0.15, BOW, BOW_KNOT);

  const sp = s.springs;
  for (const bulb of eyeBulbs) {
    const side = bulb.name === "eyeBulbR" ? 1 : -1;
    sp.add(bulb, "bulb", [side * 0.2, 1.355, -0.09]);
  }
  sp.add(sac, "sac", [0, 0.76, -0.41]);

  return { facePivot: "eyeBulbR", jaw: null, sac, ears: [], tail: [], accessory: bow, headwear: null, cheeks: [], eyeBulbs };
};

export const hopsworthMemento: MementoBuilder = (b, parent) => {
  buildBow(b, parent, [0, 0, 0], 0.16, BOW, BOW_KNOT);
};
