// Procedural canvas textures (no image downloads). Owner: client-render.
// Every function returns a cached THREE.CanvasTexture (same args → same instance; never dispose
// the cached ones). Tiling textures use RepeatWrapping + SRGBColorSpace + anisotropy 4.
// Keep them faint/low-contrast so balls stay readable (game1.md §10).

import * as THREE from "three";
import type { ArenaTheme } from "../../../shared/maps";

/** 512×512 stylized grass with soft noise and tiny flower dots (theme floor + detail colors). */
export function grassTexture(theme: ArenaTheme): THREE.CanvasTexture {
  void theme;
  return placeholder(theme.floorColor);
}

/** 512×512 white square tiles with grout lines (theme floor + floorDetailColor grout). */
export function tileTexture(theme: ArenaTheme): THREE.CanvasTexture {
  return placeholder(theme.floorColor);
}

/** 512×512 swirly pink frosting with sprinkles (theme floor + floorDetailColor sprinkles). */
export function frostingTexture(theme: ArenaTheme): THREE.CanvasTexture {
  return placeholder(theme.floorColor);
}

/** 512×512 hand-painted wood planks, 3 tones (PALETTE.wood / woodDark). */
export function woodTexture(): THREE.CanvasTexture {
  return placeholder("#C68B59");
}

/** 256×256 cream ball base (PALETTE.neutralBall) with a stitched seam stripe. Used by client-fx. */
export function ballTexture(): THREE.CanvasTexture {
  return placeholder("#FFF4DC");
}

/** 512×256 soft cartoon cloud with alpha (white + shadow tint). */
export function cloudTexture(color: string, shadow: string): THREE.CanvasTexture {
  void shadow;
  return placeholder(color);
}

/** 128×128 radial soft dot with alpha (blob shadows, glows, particles). White, tint via material color. */
export function softDotTexture(): THREE.CanvasTexture {
  return placeholder("#FFFFFF");
}

const placeholders = new Map<string, THREE.CanvasTexture>();

function placeholder(color: string): THREE.CanvasTexture {
  // TODO(client-render): replace every caller with a real painted texture.
  let tex = placeholders.get(color);
  if (!tex) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 4;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 4, 4);
    }
    tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    placeholders.set(color, tex);
  }
  return tex;
}
