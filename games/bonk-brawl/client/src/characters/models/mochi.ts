// Mochi: "sleepy round mochi in a nightcap". The roundest of the cast: torso and head nearly one
// blob, round ears, a jiggly belly, squishy cheeks and a floppy slot-colored nightcap with a white
// pompom. Owner: client-characters.

import type * as THREE from "three";
import { EYE_BAND_ASPECT, MOUTH_BAND_ASPECT, type PartBuilder, UV_EYES, UV_MOUTH, type V3 } from "../parts";
import { rotateOffset } from "./accessories";
import { add, type BodySpec, type CharacterBuilder, type MementoBuilder } from "./common";

export const mochiSpec: BodySpec = {
  torso: { y: 0.43, r: [0.37, 0.35, 0.36], paint: "body", shape: "egg", egg: -0.06 },
  belly: { at: [0, 0.4, -0.18], r: [0.31, 0.28, 0.21], paint: "secondary", pivot: true, outline: false },
  waistY: 0.3,
  neckY: 0.82,
  head: { at: [0, 1.03, -0.02], r: [0.35, 0.3, 0.32], paint: "body" },
  arm: {
    kind: "arm",
    shoulder: [0.35, 0.68, 0.0],
    length: 0.26,
    radius: 0.085,
    paint: "body",
    hand: [0.11, 0.1, 0.11],
    handPaint: "body",
    handVariant: "paw",
    padPaint: "#F2B8C6",
    band: true,
    reach: [0.03, -0.03],
  },
  leg: {
    hip: [0.18, 0.18, 0.03],
    length: 0.1,
    radius: 0.09,
    paint: "body",
    foot: [0.13, 0.065, 0.16],
    footPaint: "body",
    footZ: -0.05,
    padPaint: "#F2B8C6",
  },
  extraAt: [0, 0.3, 0.36],
  topY: 1.55,
  ghostPaint: "body",
};

const PINK = "#FF9EB5";
const WHITE = "#FFFFFF";
const CAP_AT: V3 = [0.06, 1.26, 0.05];
const CAP_TILT: V3 = [0.42, 0, -0.25];

interface CapPivots {
  cap0: THREE.Group;
  cap1: THREE.Group;
  pompom: THREE.Group;
  tips: { cap1: V3; pompom: V3 };
}

/**
 * Nightcap chain on `parent`: cap0 (trim + slot cone, tilted back), cap1 (drooping tip), pompom.
 * `shadow` marks cap0 as a shadow caster.
 */
function buildNightcap(b: PartBuilder, parent: THREE.Object3D, at: V3, tilt: V3, shadow: boolean): CapPivots {
  const acc = { accessory: true, flair: true } as const;
  const cap0 = b.group(parent, at, "cap0");
  b.frame(at, tilt, () => {
    b.torus(cap0, WHITE, at, 0.21, 0.04, { ...acc, tubular: 14, shadow });
    b.cylinder(cap0, "slot", add(at, 0, 0.01, 0), add(at, 0, 0.215, 0), 0.2, { ...acc, topRatio: 0.5, segments: 12 });
  });
  const end0 = rotateOffset([0, 0.215, 0], tilt);
  const cap1At = add(at, end0[0], end0[1], end0[2]);
  const cap1 = b.group(cap0, cap1At, "cap1");
  const tip: V3 = add(cap1At, 0.07, -0.1, 0.2);
  b.sphere(cap1, "slot", cap1At, 0.09, { ...acc, detail: "lo" });
  b.cone(cap1, "slot", cap1At, tip, 0.09, { ...acc, segments: 8 });
  const pompom = b.group(cap1, tip, "pompom");
  b.sphere(pompom, WHITE, tip, 0.08, { ...acc, detail: "lo" });
  return { cap0, cap1, pompom, tips: { cap1: tip, pompom: add(tip, 0, -0.07, 0) } };
}

export const buildMochi: CharacterBuilder = (b, s) => {
  const h = mochiSpec.head;
  b.facePatch(s.head, h.at, h.r, "eyes", { theta: 1.2, thetaLength: 0.8, aspect: EYE_BAND_ASPECT, uv: UV_EYES });

  const muzzleAt: V3 = [0, 0.95, -0.28];
  const muzzleR: V3 = [0.17, 0.12, 0.11];
  b.sphere(s.head, "secondary", muzzleAt, muzzleR, { detail: "mid" });
  b.facePatch(s.head, muzzleAt, muzzleR, "mouth", { theta: 1.86, thetaLength: 0.95, aspect: MOUTH_BAND_ASPECT, uv: UV_MOUTH, lift: 1.03 });
  b.sphere(s.head, "ink", [0, 1.0, -0.385], [0.06, 0.04, 0.035], { detail: "xs", gradient: 0 });
  b.sphere(s.head, WHITE, [0.022, 1.018, -0.414], [0.016, 0.011, 0.008], { detail: "xs", outline: false, gradient: 0, hiOnly: true });

  const ears: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const ear = b.group(s.head, [side * 0.2, 1.22, 0.02], side > 0 ? "earR" : "earL");
    const at: V3 = [side * 0.24, 1.3, 0.02];
    b.sphere(ear, "body", at, [0.115, 0.115, 0.07], { detail: "lo", flair: true });
    b.sphere(ear, PINK, [side * 0.245, 1.295, -0.035], [0.065, 0.065, 0.025], { detail: "xs", outline: false, flair: true });
    ears.push(ear);
  }

  const cheeks: THREE.Group[] = [];
  for (const side of [1, -1] as const) {
    const at: V3 = [side * 0.22, 0.93, -0.258];
    const cheek = b.group(s.head, at, side > 0 ? "cheekR" : "cheekL");
    b.sphere(cheek, PINK, at, [0.075, 0.055, 0.03], { detail: "xs", outline: false, gradient: 0, rot: [0, -side * 0.6, 0] });
    cheeks.push(cheek);
  }

  b.sphere(s.extra, "body", [0, 0.3, 0.38], 0.08, { detail: "lo", outline: false, flair: true });

  const cap = buildNightcap(b, s.head, CAP_AT, CAP_TILT, true);

  const sp = s.springs;
  for (const ear of ears) {
    const side = ear.name === "earR" ? 1 : -1;
    sp.add(ear, "earUp", [side * 0.26, 1.41, 0.02]);
  }
  for (const cheek of cheeks) {
    const side = cheek.name === "cheekR" ? 1 : -1;
    sp.add(cheek, "cheek", [side * 0.22, 0.985, -0.258]);
  }
  if (s.belly) sp.add(s.belly, "belly", [0, 0.68, -0.18]);
  sp.add(s.extra, "tailBall", [0, 0.3, 0.46]);
  sp.add(cap.cap1, "cap", cap.tips.cap1);
  sp.add(cap.pompom, "pompom", cap.tips.pompom);

  return { jaw: null, sac: null, ears, tail: [], accessory: cap.cap0, headwear: cap.cap0, cheeks, eyeBulbs: [] };
};

export const mochiMemento: MementoBuilder = (b, parent) => {
  buildNightcap(b, parent, [0, -0.08, 0], [0.42, 0, -0.25], false);
};
