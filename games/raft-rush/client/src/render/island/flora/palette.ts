// The island's ground + vegetation palette: a naturalistic, slightly desaturated tropical grade (muted beige
// sand, olive / sage lowland grass, deep muted forest green, warm grey-brown rock) per biome, shared by
// Terrain, Grass, the flora archetypes and the landmark props so the ground and what grows on it agree. The
// BIOMES colors in shared/constants.ts stay the gameplay / UI palette; the 3D island reads this one. Also a
// geometry-level grade (desaturate + darken baked vertex colors) for props that bake bright source colors.
// Owner: client-render.

import * as THREE from "three";
import type { Biome } from "../../../../../shared/types";

export interface GroundPalette {
  /** Under water: shallow seabed and the deep floor (mostly hidden by the water's own tint). */
  seabed: string;
  seabedDeep: string;
  /** Waterline band (wet, darker, slightly cool). */
  wetSand: string;
  /** Dry beach and its large-scale variation. */
  sand: string;
  sandLight: string;
  sandDark: string;
  /** Sun-dried lowland grass (beach fringe, exposed plateau). */
  grassDry: string;
  /** Olive-sage lowland grass. */
  grass: string;
  /** Lush grass in hollows / damp ground. */
  grassLush: string;
  /** Ground under the trees. */
  forestFloor: string;
  /** Canopy green (flora). */
  forest: string;
  rock: string;
  rockDark: string;
  /** Exposed soil on medium slopes and trodden paths. */
  dirt: string;
  mud: string;
  ash: string;
}

export const GROUND_PALETTES: Readonly<Record<Biome, GroundPalette>> = {
  tropic: {
    seabed: "#8d8063",
    seabedDeep: "#1f3c44",
    wetSand: "#9a8867",
    sand: "#c9b48a",
    sandLight: "#d2bf98",
    sandDark: "#b8a27a",
    grassDry: "#8a8a56",
    grass: "#6f7f45",
    grassLush: "#5b6b3a",
    forestFloor: "#465a33",
    forest: "#3f5530",
    rock: "#7a7166",
    rockDark: "#5e574f",
    dirt: "#86735a",
    mud: "#5e5138",
    ash: "#4d4744",
  },
  rocky: {
    seabed: "#837d6c",
    seabedDeep: "#1e3943",
    wetSand: "#8f8670",
    sand: "#bcae8e",
    sandLight: "#c7bb9e",
    sandDark: "#a99c7e",
    grassDry: "#868a5e",
    grass: "#6b7a4a",
    grassLush: "#58683e",
    forestFloor: "#465639",
    forest: "#425535",
    rock: "#77716a",
    rockDark: "#5a5550",
    dirt: "#7f7160",
    mud: "#5a5040",
    ash: "#4a4644",
  },
  swamp: {
    seabed: "#6f6a50",
    seabedDeep: "#1f3a3a",
    wetSand: "#7f7656",
    sand: "#a99d78",
    sandLight: "#b3a885",
    sandDark: "#988c69",
    grassDry: "#717347",
    grass: "#5b6a3c",
    grassLush: "#4b5a33",
    forestFloor: "#3a4a2c",
    forest: "#34462b",
    rock: "#6c6a5f",
    rockDark: "#54534a",
    dirt: "#6e624a",
    mud: "#4f4630",
    ash: "#454240",
  },
  volcanic: {
    seabed: "#5d564f",
    seabedDeep: "#1d333d",
    wetSand: "#5f5650",
    sand: "#8a7d6c",
    sandLight: "#968a79",
    sandDark: "#776b5d",
    grassDry: "#7a7a50",
    grass: "#66733f",
    grassLush: "#535f36",
    forestFloor: "#3f4a2f",
    forest: "#3b4d2e",
    rock: "#4f4849",
    rockDark: "#3c3638",
    dirt: "#6c5f50",
    mud: "#4e4336",
    ash: "#3e3a3b",
  },
};

export function groundPalette(biome: Biome): GroundPalette {
  return GROUND_PALETTES[biome] ?? GROUND_PALETTES.tropic;
}

/**
 * Desaturate (toward luminance) and scale the value of every vertex color of `geometry` in place. `saturation`
 * 1 = unchanged, 0 = grey; `value` multiplies the result (clamped to 1). Linear color space, as baked.
 */
export function gradeVertexColors(geometry: THREE.BufferGeometry, saturation: number, value: number): THREE.BufferGeometry {
  const color = geometry.getAttribute("color") as THREE.BufferAttribute | undefined;
  if (!color) return geometry;
  const a = color.array as Float32Array;
  for (let i = 0; i < a.length; i += 3) {
    const r = a[i]!;
    const g = a[i + 1]!;
    const b = a[i + 2]!;
    const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
    a[i] = Math.min(1, (l + (r - l) * saturation) * value);
    a[i + 1] = Math.min(1, (l + (g - l) * saturation) * value);
    a[i + 2] = Math.min(1, (l + (b - l) * saturation) * value);
  }
  color.needsUpdate = true;
  return geometry;
}

/** Same grade for one color (in place). */
export function gradeColor(c: THREE.Color, saturation: number, value: number): THREE.Color {
  const l = c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
  c.r = Math.min(1, (l + (c.r - l) * saturation) * value);
  c.g = Math.min(1, (l + (c.g - l) * saturation) * value);
  c.b = Math.min(1, (l + (c.b - l) * saturation) * value);
  return c;
}

/** Hex in, graded hex out (for constant prop colors). */
export function gradeHex(hex: string, saturation: number, value: number): string {
  return "#" + gradeColor(new THREE.Color(hex), saturation, value).getHexString();
}
