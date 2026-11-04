// Low-poly toon meshes for every item kind (projectiles in flight, ground pickups, items held in hands — both the
// third-person avatars and the first-person arms use these). Owner: client-fx-audio. Signature by the architect.
// Characters may import this file (the one allowed characters → fx import).
//
// Each kind is ONE merged, vertex-colored, flat-shaded geometry (50–300 triangles) built once and cached, drawn
// with the shared vertex-color toon material plus an ink outline child. buildItemMesh() only creates the light
// Object3D wrappers, so calling it per projectile / per hand is cheap. Never dispose what it returns' geometry or
// materials (shared).
//
// Conventions (read by characters / fx through `userData`):
// - Origin at the item's bounding-box center; compact items are sized to ITEMS[kind].radius.
// - Long tools (spear, rod, torch, axe) point along +Y: the business end (tip / head / flame) is +Y, the handle -Y.
//   Fish and logs lie along X (fish head at +X).
// - userData.kind: ItemKind · userData.grip: local THREE.Vector3 where a hand holds it · userData.tip: local
//   THREE.Vector3 of the rod tip / spear point / flame (null when meaningless) · userData.long: boolean ·
//   userData.radius: ITEMS radius. The torch has a child named "flame" (additive glow, no outline): hide it for an
//   unlit torch; flickerFlame() animates it.

import * as THREE from "three";
import { ITEMS } from "../../../shared/items";
import type { ItemKind } from "../../../shared/types";
import { addOutline, glowMaterial, toonColor, vertexColorToon } from "../render/Toon";
import {
  PartBuilder,
  box,
  cone,
  cylinder,
  cylinderX,
  fibonacciPoint,
  fin,
  hemisphere,
  lathe,
  lumpyRock,
  sphere,
  taperedTube,
  torus,
  withDetail,
} from "./itemParts";

/** Outline thickness (view-space meters) for items: thinner than characters'. */
export const ITEM_OUTLINE = 0.012;
/** The first-person close-up variant's outline: the same line weight as the first-person hands. */
export const FP_ITEM_OUTLINE = 0.0024;

/** buildItemMesh options. */
export interface ItemMeshOptions {
  /** First-person close-up: twice the segments, smooth shading, a thin outline (one variant per kind, cached). */
  closeUp?: boolean;
}

/** Item metadata stored on the root's userData. */
export interface ItemMeshInfo {
  kind: ItemKind | "berry";
  grip: THREE.Vector3;
  tip: THREE.Vector3 | null;
  long: boolean;
  radius: number;
}

type MaterialKind = "toon" | "golden" | "jelly";

interface ItemRecipe {
  build(b: PartBuilder): void;
  /** Hand grip in authoring coordinates (before centering). */
  grip?: readonly [number, number, number];
  tip?: readonly [number, number, number];
  long?: boolean;
  material?: MaterialKind;
  /** Extra child for the torch. */
  flame?: readonly [number, number, number];
}

interface CachedItem {
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  info: Omit<ItemMeshInfo, "grip" | "tip"> & { grip: THREE.Vector3; tip: THREE.Vector3 | null };
  flame: THREE.Vector3 | null;
}

/* ================================================================ palette */

const C = {
  bark: "#8B5A2B",
  barkDark: "#6B4423",
  woodEnd: "#E3B77E",
  woodLight: "#C98F57",
  woodMid: "#B07A45",
  rope: "#D2B071",
  ropeDark: "#A8874E",
  stone: "#9C968C",
  stoneDark: "#7C776F",
  coconut: "#7A4E2D",
  coconutDark: "#4A2E1A",
  coconutHair: "#9A6A40",
  fish: "#5FA8D3",
  fishBelly: "#DDF0F7",
  fishFin: "#3F7FB0",
  cooked: "#C9843E",
  cookedBelly: "#E9B76C",
  cookedFin: "#8A5225",
  grill: "#4A2E1A",
  crab: "#FF4D3A",
  crabDark: "#C8321F",
  crabCooked: "#FF8A3D",
  crabCookedDark: "#E0612A",
  gold: "#FFC83D",
  goldBelly: "#FFEBA0",
  goldFin: "#FFA41C",
  gourd: "#C9B46A",
  gourdDark: "#9C8A47",
  cork: "#8B5A2B",
  water: "#3FB7D9",
  leaf: "#5CB85C",
  leafDark: "#3E8E52",
  boot: "#6B4A2B",
  bootDark: "#3B2A20",
  seaweed: "#4C9A4C",
  jelly: "#FF8FD0",
  jellyArm: "#FFC2E8",
  puffer: "#F2C94C",
  pufferBelly: "#FFF1B8",
  pufferSpike: "#C99A22",
  fin: "#FF9A5A",
  kraken: "#A855C8",
  krakenTip: "#C77DE0",
  sucker: "#FFC3E6",
  white: "#FFFFFF",
  ink: "#2D2A32",
  metal: "#5A5A62",
  berry: "#5B2A86",
  berryLight: "#8E55C2",
  cloth: "#F1E9D2",
  clothDark: "#CFC3A2",
  scrap: "#8A8F96",
  scrapDark: "#5E636B",
  rust: "#A0623A",
  brass: "#D9A441",
  barrel: "#9A6738",
  hoop: "#4E4E56",
} as const;

/* ============================================================ recipes */

/** Ellipsoid helper: unit sphere scaled. */
function ellipsoid(sx: number, sy: number, sz: number, w = 8, h = 6): THREE.BufferGeometry {
  return sphere(1, w, h).scale(sx, sy, sz);
}

/** A googly cartoon eye (white + pupil), facing +X at (x, y, ±z). */
function eyes(b: PartBuilder, x: number, y: number, z: number, size: number): void {
  b.addMirrored(() => sphere(size, 5, 3), C.white, { p: [x, y, z] });
  b.addMirrored(() => sphere(size * 0.55, 4, 2), C.ink, { p: [x + size * 0.55, y + size * 0.1, z + Math.sign(z) * size * 0.35] });
}

/** The fish shape shared by raw / cooked / golden fish (length ~0.44 along X). */
function fishBody(b: PartBuilder, body: string, belly: string, finColor: string, eyeOn = true): void {
  b.add(ellipsoid(0.19, 0.085, 0.05, 9, 5), body);
  b.add(ellipsoid(0.15, 0.05, 0.042, 6, 4), belly, { p: [0.01, -0.035, 0] });
  // Tail: two fins in a V, pointing back (-X).
  b.add(fin(0.11, 0.1, 0.014), finColor, { p: [-0.29, 0, 0], r: [0, 0, 0] });
  b.add(fin(0.07, 0.05, 0.012), finColor, { p: [-0.03, 0.07, 0], r: [0, 0, 1.9] });
  b.add(fin(0.05, 0.035, 0.01), finColor, { p: [0.02, -0.06, 0.03], r: [0.4, 0, -2.1] });
  b.add(fin(0.05, 0.035, 0.01), finColor, { p: [0.02, -0.06, -0.03], r: [-0.4, 0, -2.1] });
  if (eyeOn) eyes(b, 0.12, 0.022, 0.034, 0.018);
}

/** A crab (body ~0.34 wide along X, claws forward +Z). */
function crabBody(b: PartBuilder, shell: string, dark: string, eyeOn: boolean): void {
  b.add(ellipsoid(0.16, 0.07, 0.12, 8, 5), shell);
  b.add(ellipsoid(0.13, 0.03, 0.1, 6, 3), dark, { p: [0, -0.04, 0] });
  // Claws: upper arm + pincer.
  b.addMirrored(() => cylinder(0.018, 0.022, 0.12, 4, true), dark, { p: [0.13, 0.0, 0.11], r: [1.2, 0, -0.5] });
  b.addMirrored(() => ellipsoid(0.065, 0.045, 0.05, 5, 3), shell, { p: [0.17, 0.02, 0.19] });
  b.addMirrored(() => cone(0.018, 0.07, 4), dark, { p: [0.15, 0.03, 0.25], r: [1.57, 0, 0] });
  // Legs: three per side, angled out and down.
  for (let i = 0; i < 3; i++) {
    const z = 0.04 - i * 0.06;
    b.addMirrored(() => cylinder(0.012, 0.016, 0.14, 3, true), dark, { p: [0.19, -0.05, z], r: [0, 0, 0.95] });
  }
  // Eye stalks.
  b.addMirrored(() => cylinder(0.009, 0.011, 0.07, 3, true), dark, { p: [0.04, 0.08, 0.08] });
  if (eyeOn) {
    b.addMirrored(() => sphere(0.022, 5, 3), C.white, { p: [0.04, 0.12, 0.08] });
    b.addMirrored(() => sphere(0.011, 4, 2), C.ink, { p: [0.045, 0.125, 0.098] });
  } else {
    // Cooked: little closed "x" eyes (flat dark caps).
    b.addMirrored(() => ellipsoid(0.022, 0.008, 0.018, 5, 3), C.ink, { p: [0.04, 0.115, 0.08] });
  }
}

/** Radius of the rope grip wrap on tool handles: the thickness first-person fingers visibly close around. */
const GRIP_WRAP_RADIUS = 0.034;
/** Length (along the handle) of the rope grip wrap. */
const GRIP_WRAP_LENGTH = 0.16;

/**
 * Rope binding where the hand holds a long tool (handle along Y): a cord sleeve centered on the recipe's grip
 * point `y`, with a darker tied-off band near each end so it reads as wrapped cord rather than a plain bulge.
 */
function gripWrap(b: PartBuilder, y: number): void {
  b.add(cylinder(GRIP_WRAP_RADIUS, GRIP_WRAP_RADIUS, GRIP_WRAP_LENGTH, 8), C.rope, { p: [0, y, 0] });
  const inset = GRIP_WRAP_LENGTH / 2 - 0.014;
  for (const side of [-1, 1]) {
    b.add(torus(GRIP_WRAP_RADIUS + 0.001, 0.0065, 3, 8), C.ropeDark, { p: [0, y + side * inset, 0], r: [Math.PI / 2, 0, 0] });
  }
}

/** One log along X (length l, radius r) with light end caps and a bark ring. */
function log(b: PartBuilder, l: number, r: number, p: readonly [number, number, number], rotY = 0): void {
  b.add(cylinder(r, r, l, 7, true).rotateZ(Math.PI / 2).rotateY(rotY), C.bark, { p });
  const cosY = Math.cos(rotY);
  const sinY = Math.sin(rotY);
  for (const side of [-1, 1]) {
    const dx = (side * l) / 2;
    b.add(cylinder(r * 0.96, r * 0.96, 0.012, 7).rotateZ(Math.PI / 2).rotateY(rotY), C.woodEnd, {
      p: [p[0] + dx * cosY, p[1], p[2] - dx * sinY],
    });
  }
}

const RECIPES: Readonly<Record<ItemKind, ItemRecipe>> = {
  wood: {
    build(b) {
      log(b, 0.4, 0.085, [0, 0, 0]);
      b.add(cylinder(0.022, 0.03, 0.09, 5), C.barkDark, { p: [0.06, 0.09, 0], r: [0, 0, -0.6] });
      b.add(box(0.05, 0.012, 0.03), C.leaf, { p: [0.1, 0.13, 0], r: [0, 0.4, -0.3] });
    },
    grip: [0, 0, 0],
  },
  rope: {
    build(b) {
      b.add(torus(0.085, 0.03, 4, 10), C.rope, { p: [0, -0.025, 0], r: [Math.PI / 2, 0, 0] });
      b.add(torus(0.08, 0.028, 4, 10), C.ropeDark, { p: [0, 0.028, 0], r: [Math.PI / 2, 0, 0.3] });
      b.add(cylinder(0.02, 0.02, 0.12, 4), C.rope, { p: [0.1, -0.06, 0.03], r: [0.3, 0, 0.9] });
    },
    grip: [0, 0, 0],
  },
  stone: {
    build(b) {
      b.add(lumpyRock(0.14, 0.22), C.stone, { s: [1, 0.72, 0.9] });
      b.add(lumpyRock(0.05, 0.3), C.stoneDark, { p: [0.06, 0.06, 0.04], s: [1, 0.6, 1] });
    },
    grip: [0, 0, 0],
  },
  coconut: {
    build(b) {
      b.add(sphere(0.19, 9, 7), C.coconut, { s: [1, 0.94, 1] });
      // Three dark "eyes" at the top pole and a hairy tuft.
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        b.add(sphere(0.022, 5, 3), C.coconutDark, { p: [Math.cos(a) * 0.045, 0.172, Math.sin(a) * 0.045] });
      }
      b.add(cone(0.05, 0.05, 5), C.coconutHair, { p: [0, -0.18, 0], r: [Math.PI, 0, 0] });
    },
    grip: [0, 0, 0],
  },
  fish_raw: {
    build(b) {
      fishBody(b, C.fish, C.fishBelly, C.fishFin);
    },
    grip: [-0.12, 0, 0],
  },
  fish_cooked: {
    build(b) {
      fishBody(b, C.cooked, C.cookedBelly, C.cookedFin, false);
      for (let i = 0; i < 3; i++) b.add(box(0.012, 0.11, 0.104), C.grill, { p: [-0.07 + i * 0.07, 0.005, 0], r: [0, 0, 0.5] });
      b.add(ellipsoid(0.018, 0.008, 0.012, 5, 3), C.ink, { p: [0.12, 0.022, 0.044] });
      b.add(ellipsoid(0.018, 0.008, 0.012, 5, 3), C.ink, { p: [0.12, 0.022, -0.044] });
      // Skewer through the fish (🍢), with a thicker handle stub past the tail (x −0.48..−0.36) so a fist holds the
      // stick, not the fish. The tip past the snout is kept short (to x 0.22) so the whole skewer stays inside the
      // compact-item size bound.
      b.add(cylinderX(0.009, 0.58, 5), C.woodEnd, { p: [-0.07, 0, 0] });
      b.add(cylinderX(0.02, 0.12, 6), C.woodLight, { p: [-0.42, 0, 0] });
    },
    grip: [-0.42, 0, 0],
  },
  crab_raw: {
    build(b) {
      crabBody(b, C.crab, C.crabDark, true);
    },
    grip: [0, 0, 0],
  },
  crab_cooked: {
    build(b) {
      crabBody(b, C.crabCooked, C.crabCookedDark, false);
      b.add(ellipsoid(0.22, 0.012, 0.16, 8, 3), C.leaf, { p: [0, -0.075, 0] });
    },
    grip: [0, 0, 0],
  },
  fish_golden: {
    build(b) {
      fishBody(b, C.gold, C.goldBelly, C.goldFin);
      // A tiny crown: golden fish are royalty.
      for (let i = 0; i < 3; i++) b.add(cone(0.016, 0.045, 4), C.goldFin, { p: [0.06 + i * 0.03, 0.1, 0], r: [0, 0, -0.2] });
      b.add(box(0.1, 0.018, 0.04), C.goldFin, { p: [0.09, 0.08, 0] });
    },
    grip: [-0.12, 0, 0],
    material: "golden",
  },
  water: {
    build(b) {
      b.add(
        lathe(
          [
            [0.001, -0.17],
            [0.08, -0.155],
            [0.12, -0.09],
            [0.11, -0.01],
            [0.05, 0.05],
            [0.075, 0.1],
            [0.06, 0.15],
            [0.028, 0.17],
          ],
          8,
        ),
        C.gourd,
      );
      b.add(torus(0.05, 0.012, 3, 9), C.ropeDark, { p: [0, 0.05, 0], r: [Math.PI / 2, 0, 0] });
      b.add(cylinder(0.026, 0.022, 0.05, 6), C.cork, { p: [0, 0.19, 0] });
      // A painted water drop so the gourd reads as "water" at a glance.
      b.add(ellipsoid(0.03, 0.045, 0.012, 6, 4), C.water, { p: [0, -0.07, 0.112] });
    },
    grip: [0, 0.05, 0],
  },
  spear: {
    build(b) {
      b.add(cylinder(0.02, 0.024, 1.0, 6), C.woodMid, { p: [0, -0.02, 0] });
      b.add(cone(0.05, 0.17, 4), C.stone, { p: [0, 0.56, 0] });
      b.add(cylinder(0.03, 0.03, 0.07, 6), C.rope, { p: [0, 0.46, 0] });
      b.add(cylinder(0.026, 0.026, 0.05, 6), C.ropeDark, { p: [0, -0.4, 0] });
      gripWrap(b, -0.12);
    },
    grip: [0, -0.12, 0],
    tip: [0, 0.645, 0],
    long: true,
  },
  rod: {
    build(b) {
      b.add(cylinder(0.01, 0.024, 1.1, 6), C.gourd, { p: [0, 0.02, 0] });
      for (const y of [-0.15, 0.15, 0.4]) b.add(cylinder(0.022 - (y + 0.5) * 0.008, 0.022 - (y + 0.5) * 0.008, 0.02, 6), C.gourdDark, { p: [0, y, 0] });
      b.add(cylinder(0.032, 0.032, 0.2, 6), C.coconut, { p: [0, -0.42, 0] });
      b.add(cylinder(0.045, 0.045, 0.03, 8).rotateZ(Math.PI / 2), C.metal, { p: [0.04, -0.28, 0] });
      b.add(cylinder(0.008, 0.008, 0.05, 4).rotateZ(Math.PI / 2), C.metal, { p: [0.07, -0.28, 0] });
      b.add(torus(0.012, 0.004, 3, 6), C.metal, { p: [0.018, 0.56, 0], r: [0, Math.PI / 2, 0] });
    },
    grip: [0, -0.42, 0],
    tip: [0, 0.57, 0],
    long: true,
  },
  torch: {
    build(b) {
      b.add(cylinder(0.026, 0.02, 0.48, 6), C.bark, { p: [0, -0.04, 0] });
      b.add(cylinder(0.05, 0.042, 0.11, 7), C.coconutDark, { p: [0, 0.24, 0] });
      b.add(torus(0.046, 0.01, 3, 8), C.rope, { p: [0, 0.2, 0], r: [Math.PI / 2, 0, 0] });
      b.add(torus(0.05, 0.01, 3, 8), C.rope, { p: [0, 0.27, 0], r: [Math.PI / 2, 0, 0] });
      // The wrap spans y −0.20..−0.04, well clear of the head (from y 0.185).
      gripWrap(b, -0.12);
    },
    grip: [0, -0.12, 0],
    tip: [0, 0.36, 0],
    long: true,
    flame: [0, 0.37, 0],
  },
  axe: {
    build(b) {
      b.add(cylinder(0.02, 0.024, 0.52, 6), C.woodMid, { p: [0, -0.02, 0] });
      // Wedge head: a squashed 4-sided cone lying sideways, edge facing +X.
      b.add(cone(0.075, 0.17, 4).rotateZ(-Math.PI / 2), C.stone, { p: [0.08, 0.17, 0], s: [1, 1, 0.38] });
      b.add(box(0.06, 0.07, 0.05), C.stoneDark, { p: [0.0, 0.17, 0] });
      b.add(torus(0.032, 0.01, 3, 8), C.rope, { p: [0, 0.12, 0], r: [Math.PI / 2, 0, 0] });
      b.add(torus(0.032, 0.01, 3, 8), C.rope, { p: [0, 0.22, 0], r: [Math.PI / 2, 0, 0] });
      gripWrap(b, -0.18);
    },
    grip: [0, -0.18, 0],
    tip: [0.17, 0.17, 0],
    long: true,
  },
  raft_part: {
    build(b) {
      for (let i = 0; i < 3; i++) log(b, 0.62, 0.07, [i === 1 ? 0.03 : 0, 0, -0.145 + i * 0.145]);
      for (const x of [-0.19, 0.19]) b.add(box(0.05, 0.16, 0.45), C.rope, { p: [x, 0, 0] });
    },
    grip: [0, 0, 0],
  },
  fence: {
    build(b) {
      for (const x of [-0.21, 0.21]) {
        b.add(cylinder(0.034, 0.038, 0.5, 6), C.woodMid, { p: [x, -0.02, 0] });
        b.add(cone(0.036, 0.09, 6), C.woodLight, { p: [x, 0.275, 0] });
      }
      b.add(box(0.6, 0.05, 0.032), C.woodLight, { p: [0, 0.12, 0.03] });
      b.add(box(0.6, 0.05, 0.032), C.woodLight, { p: [0, -0.08, 0.03], r: [0, 0, 0.04] });
      for (const x of [-0.21, 0.21]) b.add(box(0.075, 0.03, 0.08), C.rope, { p: [x, 0.12, 0.02] });
    },
    grip: [0, 0, 0],
  },
  collector: {
    build(b) {
      b.add(cylinder(0.19, 0.155, 0.26, 8), C.woodMid);
      for (const y of [-0.08, 0.08]) b.add(cylinder(0.185 - (0.08 - y) * 0.15, 0.18 - (0.08 - y) * 0.15, 0.025, 8), C.barkDark, { p: [0, y, 0] });
      b.add(cylinder(0.17, 0.17, 0.01, 8), C.water, { p: [0, 0.12, 0] });
      // A big leaf funnel tilted over the bucket.
      b.add(ellipsoid(0.2, 0.014, 0.11, 8, 3), C.leaf, { p: [0.05, 0.2, 0], r: [0, 0.3, 0.35] });
      b.add(cylinder(0.006, 0.006, 0.36, 4).rotateZ(Math.PI / 2), C.leafDark, { p: [0.05, 0.215, 0], r: [0, 0.3, 0.35] });
    },
    grip: [0, 0.12, 0],
  },
  coconut_ball: {
    build(b) {
      for (let i = 0; i < 3; i++) {
        const a = (i / 3) * Math.PI * 2;
        b.add(sphere(0.115, 7, 5), C.coconut, { p: [Math.cos(a) * 0.105, i === 0 ? 0.03 : -0.02, Math.sin(a) * 0.105] });
        b.add(sphere(0.016, 4, 3), C.coconutDark, { p: [Math.cos(a) * 0.12, 0.1, Math.sin(a) * 0.12] });
      }
      b.add(torus(0.13, 0.02, 3, 10), C.rope, { p: [0, 0, 0], r: [Math.PI / 2, 0, 0] });
      b.add(cylinder(0.018, 0.018, 0.08, 4), C.rope, { p: [0, 0.12, 0] });
    },
    grip: [0, 0, 0],
  },
  boot: {
    build(b) {
      b.add(box(0.13, 0.035, 0.3), C.bootDark, { p: [0, -0.12, 0.02] });
      b.add(ellipsoid(0.065, 0.06, 0.1, 7, 5), C.boot, { p: [0, -0.07, 0.08] });
      b.add(cylinder(0.065, 0.062, 0.22, 7), C.boot, { p: [0, 0.0, -0.07] });
      b.add(cylinder(0.055, 0.055, 0.012, 7), C.bootDark, { p: [0, 0.11, -0.07] });
      b.add(torus(0.064, 0.01, 3, 8), C.bootDark, { p: [0, -0.04, -0.07], r: [Math.PI / 2, 0, 0] });
      // Seaweed draped over the rim (it's been in the sea a while).
      b.add(box(0.03, 0.12, 0.012), C.seaweed, { p: [0.06, 0.07, -0.03], r: [0.2, 0, -0.3] });
      b.add(box(0.025, 0.09, 0.012), C.seaweed, { p: [-0.05, 0.08, -0.12], r: [-0.3, 0, 0.4] });
    },
    grip: [0, 0.04, -0.07],
  },
  jellyfish: {
    build(b) {
      b.add(hemisphere(0.15, 9, 4), C.jelly, { p: [0, 0.0, 0], s: [1, 0.8, 1] });
      b.add(cylinder(0.15, 0.13, 0.025, 9), C.jellyArm, { p: [0, -0.005, 0] });
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + 0.3;
        const r = 0.08;
        b.add(cone(0.016, 0.2 - (i % 2) * 0.05, 4), C.jellyArm, {
          p: [Math.cos(a) * r, -0.11 + (i % 2) * 0.025, Math.sin(a) * r],
          r: [Math.sin(a) * 0.25 + Math.PI, 0, Math.cos(a) * 0.25],
        });
      }
      b.add(sphere(0.016, 5, 3), C.ink, { p: [0.04, 0.06, 0.12] });
      b.add(sphere(0.016, 5, 3), C.ink, { p: [-0.04, 0.06, 0.12] });
    },
    grip: [0, 0.03, 0],
    material: "jelly",
  },
  puffer: {
    build(b) {
      b.add(sphere(0.16, 9, 6), C.puffer);
      b.add(sphere(0.13, 7, 4), C.pufferBelly, { p: [0, -0.04, 0.03] });
      const spikes = 16;
      const v = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0);
      const q = new THREE.Quaternion();
      const e = new THREE.Euler();
      for (let i = 0; i < spikes; i++) {
        fibonacciPoint(i, spikes, v);
        // Leave the face (front, +Z) clear for the eyes.
        if (v.z > 0.55 && Math.abs(v.y) < 0.6) continue;
        q.setFromUnitVectors(up, v);
        e.setFromQuaternion(q);
        b.add(new THREE.ConeGeometry(0.02, 0.07, 3, 1, true), C.pufferSpike, { p: [v.x * 0.175, v.y * 0.175, v.z * 0.175], r: [e.x, e.y, e.z] });
      }
      b.addMirrored(() => sphere(0.04, 5, 4), C.white, { p: [0.065, 0.05, 0.135] });
      b.addMirrored(() => sphere(0.02, 4, 2), C.ink, { p: [0.07, 0.055, 0.168] });
      b.add(torus(0.018, 0.008, 3, 5), C.crabDark, { p: [0, -0.02, 0.158] });
      b.addMirrored(() => fin(0.06, 0.06, 0.01), C.fin, { p: [0.16, -0.01, 0], r: [0, 0, -0.4] });
    },
    grip: [0, 0, 0],
  },
  log: {
    build(b) {
      log(b, 0.66, 0.13, [0, 0, 0]);
      b.add(torus(0.132, 0.012, 3, 9), C.barkDark, { p: [0.12, 0, 0], r: [0, Math.PI / 2, 0] });
      b.add(cylinder(0.03, 0.04, 0.1, 5), C.barkDark, { p: [-0.1, 0.13, 0.02], r: [0, 0, 0.5] });
    },
    grip: [0, 0, 0],
  },
  cloth: {
    build(b) {
      // A folded bolt of sailcloth tied with rope.
      b.add(box(0.26, 0.05, 0.2), C.cloth, { p: [0, -0.03, 0] });
      b.add(box(0.25, 0.045, 0.19), C.clothDark, { p: [0.005, 0.02, 0], r: [0, 0.08, 0] });
      b.add(box(0.03, 0.12, 0.21), C.rope, { p: [0.05, 0, 0] });
      b.add(torus(0.02, 0.008, 3, 6), C.ropeDark, { p: [0.05, 0.06, 0.06], r: [0, Math.PI / 2, 0] });
    },
    grip: [0, 0, 0],
  },
  scrap: {
    build(b) {
      // Bent plates and a bolt pulled off the wreck.
      b.add(box(0.2, 0.025, 0.14), C.scrap, { p: [0, -0.03, 0], r: [0.1, 0.3, 0.12] });
      b.add(box(0.14, 0.022, 0.1), C.scrapDark, { p: [0.03, 0.02, 0.02], r: [-0.25, -0.4, -0.2] });
      b.add(box(0.06, 0.02, 0.05), C.rust, { p: [-0.06, 0.0, 0.05], r: [0.2, 0.5, 0] });
      b.add(cylinder(0.014, 0.014, 0.14, 6), C.scrapDark, { p: [-0.02, 0.04, -0.04], r: [0, 0, 1.2] });
      b.add(cylinder(0.026, 0.026, 0.02, 6), C.scrap, { p: [0.045, 0.065, -0.04], r: [0, 0, 1.2] });
    },
    grip: [0, 0, 0],
  },
  nails: {
    build(b) {
      // A little bundle of nails, heads up.
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        const x = Math.cos(a) * 0.028;
        const z = Math.sin(a) * 0.028;
        b.add(cylinder(0.006, 0.004, 0.13, 4), C.scrap, { p: [x, -0.01, z], r: [z * 2, 0, -x * 2] });
        b.add(cylinder(0.016, 0.016, 0.008, 6), C.scrapDark, { p: [x * 1.2, 0.058, z * 1.2] });
      }
      b.add(torus(0.036, 0.007, 3, 8), C.rope, { p: [0, 0, 0], r: [Math.PI / 2, 0, 0] });
    },
    grip: [0, 0, 0],
  },
  barrel: {
    build(b) {
      b.add(
        lathe(
          [
            [0.001, -0.21],
            [0.15, -0.21],
            [0.19, -0.1],
            [0.2, 0],
            [0.19, 0.1],
            [0.15, 0.21],
            [0.001, 0.21],
          ],
          9,
        ),
        C.barrel,
      );
      for (const y of [-0.14, 0.14]) b.add(torus(0.18, 0.012, 3, 10), C.hoop, { p: [0, y, 0], r: [Math.PI / 2, 0, 0] });
      b.add(cylinder(0.025, 0.025, 0.04, 6), C.cork, { p: [0, 0.22, 0.05] });
      b.add(ellipsoid(0.035, 0.05, 0.012, 6, 4), C.water, { p: [0, 0, 0.198] });
    },
    grip: [0, 0, 0],
  },
  compass: {
    build(b) {
      b.add(cylinder(0.12, 0.12, 0.045, 12), C.brass);
      b.add(cylinder(0.1, 0.1, 0.01, 12), C.white, { p: [0, 0.025, 0] });
      b.add(cone(0.018, 0.09, 4).rotateZ(-Math.PI / 2), C.crab, { p: [0.045, 0.034, 0], s: [1, 0.4, 1] });
      b.add(cone(0.018, 0.09, 4).rotateZ(Math.PI / 2), C.ink, { p: [-0.045, 0.034, 0], s: [1, 0.4, 1] });
      b.add(torus(0.016, 0.006, 3, 6), C.brass, { p: [0, 0, 0.13], r: [0, 0, 0] });
    },
    grip: [0, 0, 0],
    material: "golden",
  },
  hammer: {
    build(b) {
      b.add(cylinder(0.02, 0.024, 0.5, 6), C.woodMid, { p: [0, -0.03, 0] });
      b.add(box(0.2, 0.07, 0.07), C.metal, { p: [0.02, 0.2, 0] });
      b.add(box(0.04, 0.08, 0.08), C.stoneDark, { p: [0.11, 0.2, 0] });
      b.add(torus(0.03, 0.009, 3, 8), C.rope, { p: [0, 0.14, 0], r: [Math.PI / 2, 0, 0] });
      gripWrap(b, -0.18);
    },
    grip: [0, -0.18, 0],
    tip: [0.12, 0.2, 0],
    long: true,
  },
  kraken: {
    build(b) {
      const a = new THREE.Vector3(-0.26, -0.12, 0);
      const ctrl = new THREE.Vector3(0.18, -0.16, 0);
      const end = new THREE.Vector3(0.18, 0.2, 0);
      b.add(
        taperedTube(a, ctrl, end, (t) => 0.075 * (1 - t) + 0.012, 10, 6),
        C.kraken,
      );
      // Suckers along the inner curve.
      const curve = new THREE.QuadraticBezierCurve3(a, ctrl, end);
      const p = new THREE.Vector3();
      for (let i = 0; i < 5; i++) {
        const t = 0.12 + i * 0.16;
        curve.getPoint(t, p);
        const r = 0.075 * (1 - t) + 0.012;
        b.add(ellipsoid(r * 0.55, r * 0.55, r * 0.25, 6, 3), C.sucker, { p: [p.x, p.y, p.z + r * 0.9] });
      }
      b.add(sphere(0.02, 4, 3), C.krakenTip, { p: [0.18, 0.205, 0] });
    },
    grip: [-0.22, -0.12, 0],
  },
};

/** Extra: a bramble-berry cluster (berries are eaten on the spot, so they never become items; used by item pops). */
const BERRY_RECIPE: ItemRecipe = {
  build(b) {
    const spots: ReadonlyArray<readonly [number, number, number]> = [
      [0, 0, 0],
      [0.045, 0.01, 0.02],
      [-0.04, 0.012, 0.025],
      [0.01, 0.01, -0.045],
      [0.005, 0.05, 0.005],
    ];
    spots.forEach((p, i) => b.add(sphere(0.035, 6, 4), i % 2 === 0 ? C.berry : C.berryLight, { p }));
    b.add(ellipsoid(0.05, 0.008, 0.025, 6, 3), C.leaf, { p: [0.02, 0.085, 0], r: [0, 0.5, 0.3] });
  },
  grip: [0, 0, 0],
};

/* ============================================================== cache */

const cache = new Map<string, CachedItem>();

function materialFor(kind: MaterialKind, flat: boolean): THREE.Material {
  switch (kind) {
    case "golden":
      return toonColor(0xffffff, { vertexColors: true, flatShading: flat, emissive: "#6B4300", emissiveIntensity: 1 });
    case "jelly":
      return toonColor(0xffffff, { vertexColors: true, flatShading: flat, transparent: true, opacity: 0.82, emissive: "#7A1E5A", emissiveIntensity: 0.6 });
    default:
      return vertexColorToon(THREE.FrontSide, flat);
  }
}

function v3(t: readonly [number, number, number] | undefined, shift: THREE.Vector3): THREE.Vector3 {
  return t ? new THREE.Vector3(t[0] + shift.x, t[1] + shift.y, t[2] + shift.z) : shift.clone();
}

function cachedItem(kind: ItemKind | "berry", closeUp = false): CachedItem {
  const key = closeUp ? `${kind}:fp` : kind;
  const hit = cache.get(key);
  if (hit) return hit;
  const recipe = kind === "berry" ? BERRY_RECIPE : RECIPES[kind];
  const builder = new PartBuilder();
  withDetail(closeUp ? 2 : 1, () => recipe.build(builder));
  const { geometry, shift } = builder.build(true);
  geometry.name = `item-${kind}`;
  const entry: CachedItem = {
    geometry,
    material: materialFor(recipe.material ?? "toon", !closeUp),
    info: {
      kind,
      grip: v3(recipe.grip, shift),
      tip: recipe.tip ? v3(recipe.tip, shift) : null,
      long: recipe.long ?? false,
      radius: kind === "berry" ? 0.09 : ITEMS[kind].radius,
    },
    flame: recipe.flame ? v3(recipe.flame, shift) : null,
  };
  cache.set(key, entry);
  return entry;
}

/* ================================================================ flame */

let flameGeometry: THREE.BufferGeometry | null = null;
let flameCoreGeometry: THREE.BufferGeometry | null = null;

function flameGeometries(): [THREE.BufferGeometry, THREE.BufferGeometry] {
  if (!flameGeometry || !flameCoreGeometry) {
    const teardrop: Array<[number, number]> = [
      [0.001, -0.05],
      [0.04, -0.035],
      [0.05, 0.0],
      [0.038, 0.05],
      [0.018, 0.1],
      [0.001, 0.14],
    ];
    flameGeometry = new THREE.LatheGeometry(
      teardrop.map(([r, y]) => new THREE.Vector2(r, y)),
      7,
    );
    flameCoreGeometry = new THREE.LatheGeometry(
      teardrop.map(([r, y]) => new THREE.Vector2(r * 0.55, y * 0.62 - 0.01)),
      6,
    );
  }
  return [flameGeometry, flameCoreGeometry];
}

let flameMat: THREE.MeshBasicMaterial | null = null;

function flameMaterial(): THREE.MeshBasicMaterial {
  flameMat ??= new THREE.MeshBasicMaterial({ color: "#FF8A2A", transparent: true, opacity: 0.92, depthWrite: false, fog: false, toneMapped: false });
  return flameMat;
}

function buildFlame(at: THREE.Vector3): THREE.Group {
  const [outer, core] = flameGeometries();
  const flame = new THREE.Group();
  flame.name = "flame";
  flame.position.copy(at);
  // Outer flame: normal blending so it stays orange against a bright sky; the core glows additively.
  const glow = new THREE.Mesh(outer, flameMaterial());
  glow.userData.noOutline = true;
  glow.castShadow = false;
  glow.renderOrder = 5;
  const inner = new THREE.Mesh(core, glowMaterial("#FFF1A8", 1));
  inner.userData.noOutline = true;
  inner.castShadow = false;
  inner.renderOrder = 6;
  flame.add(glow, inner);
  flame.userData.noOutline = true;
  return flame;
}

/* ================================================================ public */

/** A new Object3D for `kind` (shares geometry / materials across calls). Dispose nothing: geometries are cached. */
export function buildItemMesh(kind: ItemKind, opts: ItemMeshOptions = {}): THREE.Object3D {
  return instantiate(kind, opts.closeUp ?? false);
}

/** The berry cluster (not an ItemKind): item pops for berries eaten from a bush. */
export function buildBerryMesh(): THREE.Object3D {
  return instantiate("berry");
}

function instantiate(kind: ItemKind | "berry", closeUp = false): THREE.Object3D {
  const entry = cachedItem(kind, closeUp);
  const mesh = new THREE.Mesh(entry.geometry, entry.material);
  mesh.name = `item-${kind}`;
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  addOutline(mesh, closeUp ? FP_ITEM_OUTLINE : ITEM_OUTLINE);
  if (entry.flame) mesh.add(buildFlame(entry.flame));
  const info: ItemMeshInfo = {
    kind: entry.info.kind,
    grip: entry.info.grip.clone(),
    tip: entry.info.tip ? entry.info.tip.clone() : null,
    long: entry.info.long,
    radius: entry.info.radius,
  };
  mesh.userData = { ...info, item: true };
  return mesh;
}

/** Metadata of a buildItemMesh() root (null for other objects). */
export function itemInfo(obj: THREE.Object3D): ItemMeshInfo | null {
  const d = obj.userData as Partial<ItemMeshInfo> & { item?: boolean };
  return d.item && d.grip ? (d as ItemMeshInfo) : null;
}

/** Triangle count of an item's shared geometry (budget checks / dev harness). */
export function itemTriangleCount(kind: ItemKind | "berry"): number {
  const g = cachedItem(kind).geometry;
  return (g.index ? g.index.count : g.getAttribute("position").count) / 3;
}

/**
 * Flicker a torch flame child (no-op for other items). `time` in seconds, `lit` false hides it. `seed` keeps
 * several torches out of phase.
 */
export function flickerFlame(obj: THREE.Object3D, time: number, lit = true, seed = 0): void {
  const flame = obj.getObjectByName("flame");
  if (!flame) return;
  flame.visible = lit;
  if (!lit) return;
  const t = time * 9 + seed * 7.3;
  const k = 1 + 0.12 * Math.sin(t) + 0.08 * Math.sin(t * 2.7 + 1.3) + 0.05 * Math.sin(t * 5.1 + 0.4);
  flame.scale.set(1 + 0.08 * Math.sin(t * 1.9 + 2), k, 1 + 0.08 * Math.sin(t * 2.3));
  flame.rotation.z = 0.06 * Math.sin(t * 1.3);
}

const glowTextureCache: { tex: THREE.Texture | null } = { tex: null };

function softGlowTexture(): THREE.Texture {
  if (glowTextureCache.tex) return glowTextureCache.tex;
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const d = Math.min(1, Math.sqrt(dx * dx + dy * dy) * 2);
      const a = Math.pow(1 - d, 2.2);
      const i = (y * size + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = 255;
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  glowTextureCache.tex = tex;
  return tex;
}

/**
 * Charge / highlight glow on a buildItemMesh() object (held item while charging a throw, a golden fish…):
 * a child additive sprite named "glow", created on first use. `amount` 0 hides it; 1 = full (pulses).
 * Call every frame while it changes; `time` in seconds drives the full-charge pulse.
 */
export function setItemGlow(obj: THREE.Object3D, amount: number, color: THREE.ColorRepresentation = "#FFE27A", time = 0): void {
  let sprite = obj.getObjectByName("glow") as THREE.Sprite | undefined;
  if (amount <= 0.001) {
    if (sprite) sprite.visible = false;
    return;
  }
  if (!sprite) {
    const material = new THREE.SpriteMaterial({
      map: softGlowTexture(),
      color: new THREE.Color(color),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    });
    sprite = new THREE.Sprite(material);
    sprite.name = "glow";
    sprite.userData.noOutline = true;
    sprite.renderOrder = 4;
    sprite.raycast = () => {};
    obj.add(sprite);
  }
  const material = sprite.material;
  material.color.set(color);
  const a = Math.min(1, amount);
  const full = a >= 0.999;
  const pulse = full ? 1 + 0.18 * Math.sin(time * 18) : 1;
  const r = (itemInfo(obj)?.radius ?? 0.2) * (2.2 + 2.6 * a) * pulse;
  sprite.scale.set(r, r, r);
  material.opacity = (0.25 + 0.6 * a) * (full ? 1 : 0.85);
  sprite.visible = true;
}

/** Dispose the per-object glow sprite material made by setItemGlow (call before dropping an item object). */
export function releaseItemObject(obj: THREE.Object3D): void {
  const sprite = obj.getObjectByName("glow") as THREE.Sprite | undefined;
  if (sprite) {
    sprite.material.dispose();
    sprite.removeFromParent();
  }
}
