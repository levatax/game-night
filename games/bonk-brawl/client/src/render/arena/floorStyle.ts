// Per-floor-kind look of the island slab: top texture, wall color bands and underside profile.

import type * as THREE from "three";
import type { ArenaTheme, FloorKind } from "../../../../shared/maps";
import { mixHex, shadeHex } from "../../util/color";
import { frostingTexture, grassTexture, tileTexture } from "../textures";

/** A horizontal color band on the slab walls, from the previous band's bottom down to `to` m below the top. */
export interface WallBand {
  to: number;
  color: string;
}

export interface FloorStyle {
  texture: THREE.CanvasTexture;
  /** World meters covered by one repeat of the top texture. */
  textureMeters: number;
  bands: WallBand[];
  /** Underside depth (positive meters below y = 0) at distance r of an island of edge radius R. */
  depth(r: number, R: number): number;
  /** Extra hanging depth at the very center (stalactite tip). */
  centerDrop: number;
  /** Random vertical jitter on underside vertices (rocky look), meters. */
  jitter: number;
  /** Radial subdivisions of the underside per ring (more = rounder dome). */
  radialSteps: number;
  /** Face colors picked per underside triangle. */
  undersideColors: string[];
}

export function floorStyleFor(kind: FloorKind, theme: ArenaTheme): FloorStyle {
  switch (kind) {
    case "grass":
      return grassStyle(theme);
    case "tile":
      return tileStyle(theme);
    case "frosting":
      return frostingStyle(theme);
  }
}

function grassStyle(theme: ArenaTheme): FloorStyle {
  const dirt = theme.sideColor;
  return {
    texture: grassTexture(theme),
    textureMeters: 7,
    bands: [
      { to: 0.24, color: theme.rimColor },
      { to: 0.95, color: dirt },
      { to: 1.9, color: shadeHex(dirt, -0.12) },
      { to: 99, color: mixHex(shadeHex(dirt, -0.2), "#7A6E66", 0.35) },
    ],
    // Inverted dome: thin at the rim, a deep rocky root under the middle.
    depth: (r, R) => 1.2 + 7.6 * Math.pow(Math.max(0, 1 - r / R), 1.5),
    centerDrop: 2.6,
    jitter: 0.45,
    radialSteps: 3,
    undersideColors: [
      shadeHex(dirt, -0.1),
      shadeHex(dirt, -0.2),
      mixHex(dirt, "#7A6E66", 0.5),
      mixHex(shadeHex(dirt, -0.25), "#6E6A73", 0.4),
      shadeHex(dirt, 0.06),
    ],
  };
}

function tileStyle(theme: ArenaTheme): FloorStyle {
  return {
    texture: tileTexture(theme),
    textureMeters: 4,
    bands: [
      { to: 0.12, color: theme.rimColor },
      { to: 0.42, color: theme.floorShadeColor },
      { to: 99, color: theme.sideColor },
    ],
    // Tub bottom: flat in the middle with rounded edges.
    depth: (r, R) => 1.2 + 1.9 * Math.sqrt(Math.max(0, 1 - Math.pow(r / R, 4))),
    centerDrop: 0,
    jitter: 0,
    radialSteps: 3,
    undersideColors: [theme.sideColor, mixHex(theme.sideColor, "#DCE7EF", 0.5), mixHex(theme.sideColor, "#CFE0EA", 0.35)],
  };
}

function frostingStyle(theme: ArenaTheme): FloorStyle {
  const sponge = theme.sideColor;
  const cream = "#FFF8EE";
  const jam = "#E8506E";
  return {
    texture: frostingTexture(theme),
    textureMeters: 6,
    bands: [
      { to: 0.34, color: theme.floorColor },
      { to: 1.15, color: sponge },
      { to: 1.36, color: cream },
      { to: 1.52, color: jam },
      { to: 2.55, color: shadeHex(sponge, -0.03) },
      { to: 2.76, color: cream },
      { to: 99, color: sponge },
    ],
    depth: () => 3.6,
    centerDrop: 0,
    jitter: 0,
    radialSteps: 1,
    undersideColors: [shadeHex(sponge, -0.12), shadeHex(sponge, -0.16)],
  };
}
