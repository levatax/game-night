// Procedural canvas textures (no image downloads). Owner: client-render.
// Every function returns a cached THREE.CanvasTexture (same args → same instance; never dispose
// the cached ones). Tiling textures use RepeatWrapping + SRGBColorSpace + anisotropy 4.
// Keep them faint/low-contrast so balls stay readable (game1.md §10).

import * as THREE from "three";
import type { ArenaTheme } from "../../../shared/maps";
import { PALETTE } from "../../../shared/constants";
import { hexToRgba, mixHex, shadeHex } from "../util/color";
import { createRng, hashString, randRange } from "./noise";

type Ctx = CanvasRenderingContext2D;

const cache = new Map<string, THREE.CanvasTexture>();

/** 512×512 stylized grass with soft noise and tiny flower dots (theme floor + detail colors). */
export function grassTexture(theme: ArenaTheme): THREE.CanvasTexture {
  const key = `grass|${theme.floorColor}|${theme.floorShadeColor}|${theme.floorDetailColor}`;
  return cached(key, 512, 512, true, (ctx, size) => paintGrass(ctx, size, theme));
}

/** 512×512 white square tiles with grout lines (theme floor + floorDetailColor grout). */
export function tileTexture(theme: ArenaTheme): THREE.CanvasTexture {
  const key = `tile|${theme.floorColor}|${theme.floorShadeColor}|${theme.floorDetailColor}`;
  return cached(key, 512, 512, true, (ctx, size) => paintTiles(ctx, size, theme));
}

/** 512×512 swirly pink frosting with sprinkles (theme floor + floorDetailColor sprinkles). */
export function frostingTexture(theme: ArenaTheme): THREE.CanvasTexture {
  const key = `frosting|${theme.floorColor}|${theme.floorShadeColor}|${theme.floorDetailColor}`;
  return cached(key, 512, 512, true, (ctx, size) => paintFrosting(ctx, size, theme));
}

/** 512×512 hand-painted wood planks, 3 tones (PALETTE.wood / woodDark). */
export function woodTexture(): THREE.CanvasTexture {
  return cached("wood", 512, 512, true, paintWood);
}

/** 256×256 cream ball base (PALETTE.neutralBall) with a stitched seam stripe. Used by client-fx. */
export function ballTexture(): THREE.CanvasTexture {
  return cached("ball", 256, 256, true, paintBall);
}

/** 512×256 soft cartoon cloud with alpha (white + shadow tint). */
export function cloudTexture(color: string, shadow: string): THREE.CanvasTexture {
  return cached(`cloud|${color}|${shadow}`, 512, 256, false, (ctx, w, h) => paintCloud(ctx, w, h, color, shadow));
}

/** 128×128 radial soft dot with alpha (blob shadows, glows, particles). White, tint via material color. */
export function softDotTexture(): THREE.CanvasTexture {
  return cached("softDot", 128, 128, false, paintSoftDot);
}

/* ------------------------------------------------ extra textures (render-internal + others) */

/** 256×256 two-color checkerboard (picnic blanket, tablecloth). `cells` per side. */
export function checkerTexture(a: string, b: string, cells = 8): THREE.CanvasTexture {
  return cached(`checker|${a}|${b}|${cells}`, 256, 256, true, (ctx, size) => paintChecker(ctx, size, a, b, cells));
}

/** 256×256 woven wicker (picnic basket). */
export function wickerTexture(): THREE.CanvasTexture {
  return cached("wicker", 256, 256, true, paintWicker);
}

/** 256×256 diagonal stripes (candles, towels). Repeats seamlessly in both directions. */
export function stripeTexture(base: string, stripe: string, count = 4, diagonal = true): THREE.CanvasTexture {
  const key = `stripe|${base}|${stripe}|${count}|${diagonal}`;
  return cached(key, 256, 256, true, (ctx, size) => paintStripes(ctx, size, base, stripe, count, diagonal));
}

/** 512×256 shampoo bottle label (wraps around the bottle; bubbles + a wavy band). */
export function labelTexture(base: string, accent: string): THREE.CanvasTexture {
  return cached(`label|${base}|${accent}`, 512, 256, false, (ctx, w, h) => paintLabel(ctx, w, h, base, accent));
}

/** 256×256 strawberry skin: red with a soft gradient and staggered yellow seeds (tiles in u). */
export function strawberryTexture(): THREE.CanvasTexture {
  return cached("strawberry", 256, 256, true, paintStrawberry);
}

/**
 * 512×256 watermelon slice face for an extruded superellipse half-disc: the canvas spans the
 * shape's bounding box (u: -halfWidth..halfWidth, v: 0..height) with the same `exponent`, so the
 * rind bands follow the extruded outline exactly.
 */
export function melonSliceTexture(exponent: number): THREE.CanvasTexture {
  return cached(`melon|${exponent}`, 512, 256, false, (ctx, w, h) => paintMelonSlice(ctx, w, h, exponent));
}

/** 256×128 soap top: soft engraved oval with bubbles (tint via the material color). */
export function soapTopTexture(color: string): THREE.CanvasTexture {
  return cached(`soap|${color}`, 256, 128, false, (ctx, w, h) => paintSoapTop(ctx, w, h, color));
}

/** 256×256 square wall tiles (4×4) with grout, for the far bathroom walls. */
export function wallTileTexture(tile: string, grout: string): THREE.CanvasTexture {
  return cached(`wallTile|${tile}|${grout}`, 256, 256, true, (ctx, size) => paintWallTiles(ctx, size, tile, grout));
}

/** 512×512 drain water: swirling bands spiralling into a chrome drain at the center. */
export function drainWaterTexture(color: string): THREE.CanvasTexture {
  return cached(`drain|${color}`, 512, 512, false, (ctx, size) => paintDrainWater(ctx, size, color));
}

/** 256×256 tiling light ripple marks (alpha), drifted over the drain water. */
export function rippleTexture(): THREE.CanvasTexture {
  return cached("ripples", 256, 256, true, paintRipples);
}

/* ================================================================ plumbing */

function cached(
  key: string,
  width: number,
  height: number,
  tiling: boolean,
  paint: (ctx: Ctx, width: number, height: number) => void,
): THREE.CanvasTexture {
  let tex = cache.get(key);
  if (tex) return tex;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (ctx) paint(ctx, width, height);
  tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.name = key;
  if (tiling) {
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.anisotropy = 4;
  }
  cache.set(key, tex);
  return tex;
}

/** Calls `draw` at every wrapped copy of (x, y) that can touch the canvas, so tiles stay seamless. */
function wrapped(size: number, x: number, y: number, reach: number, draw: (x: number, y: number) => void): void {
  for (const ox of [-size, 0, size]) {
    for (const oy of [-size, 0, size]) {
      const px = x + ox;
      const py = y + oy;
      if (px + reach < 0 || px - reach > size || py + reach < 0 || py - reach > size) continue;
      draw(px, py);
    }
  }
}

function blob(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number): void {
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, hexToRgba(color, alpha));
  g.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, r * 2, r * 2);
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/* ================================================================ painters */

function paintGrass(ctx: Ctx, size: number, theme: ArenaTheme): void {
  const rng = createRng(hashString("grass" + theme.floorColor));
  ctx.fillStyle = theme.floorColor;
  ctx.fillRect(0, 0, size, size);

  // Soft light/dark patches: big and faint so the floor reads as one calm color.
  for (let i = 0; i < 26; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = randRange(rng, 40, 110);
    const light = rng() < 0.5;
    const color = light ? shadeHex(theme.floorColor, 0.35) : theme.floorShadeColor;
    wrapped(size, x, y, r, (px, py) => blob(ctx, px, py, r, color, light ? 0.16 : 0.12));
  }

  // Grass blade tufts: little "v" strokes in the shade color.
  ctx.lineCap = "round";
  ctx.lineWidth = 2;
  for (let i = 0; i < 260; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const h = randRange(rng, 5, 10);
    const light = rng() < 0.35;
    ctx.strokeStyle = hexToRgba(light ? shadeHex(theme.floorColor, 0.3) : theme.floorShadeColor, light ? 0.35 : 0.3);
    wrapped(size, x, y, 12, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px - 3, py - h);
      ctx.quadraticCurveTo(px - 1, py - h * 0.3, px, py);
      ctx.quadraticCurveTo(px + 1, py - h * 0.4, px + 3, py - h * 0.9);
      ctx.stroke();
    });
  }

  // Tiny flowers: 5-dot petals around a center, sparse and small.
  const petals = [theme.floorDetailColor, "#FFFFFF", "#FFC6DA"];
  for (let i = 0; i < 34; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const petal = petals[i % petals.length];
    const r = randRange(rng, 2.2, 3.2);
    wrapped(size, x, y, 10, (px, py) => {
      ctx.fillStyle = hexToRgba(petal, 0.85);
      for (let k = 0; k < 5; k++) {
        const a = (k / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.arc(px + Math.cos(a) * r, py + Math.sin(a) * r, r * 0.8, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = hexToRgba("#FFB43F", 0.9);
      ctx.beginPath();
      ctx.arc(px, py, r * 0.6, 0, Math.PI * 2);
      ctx.fill();
    });
  }
}

function paintTiles(ctx: Ctx, size: number, theme: ArenaTheme): void {
  const rng = createRng(hashString("tiles" + theme.floorColor));
  const tiles = 4;
  const cell = size / tiles;
  const grout = 7;
  ctx.fillStyle = theme.floorDetailColor;
  ctx.fillRect(0, 0, size, size);
  for (let ty = 0; ty < tiles; ty++) {
    for (let tx = 0; tx < tiles; tx++) {
      const x = tx * cell + grout / 2;
      const y = ty * cell + grout / 2;
      const w = cell - grout;
      const tint = mixHex(theme.floorColor, theme.floorShadeColor, rng() * 0.25);
      ctx.fillStyle = tint;
      roundRect(ctx, x, y, w, w, 8);
      ctx.fill();
      // Bevel: light top-left edge, soft shade along the bottom-right.
      const g = ctx.createLinearGradient(x, y, x + w, y + w);
      g.addColorStop(0, "rgba(255,255,255,0.55)");
      g.addColorStop(0.18, "rgba(255,255,255,0)");
      g.addColorStop(0.82, "rgba(0,0,0,0)");
      g.addColorStop(1, hexToRgba(theme.floorShadeColor, 0.45));
      ctx.fillStyle = g;
      roundRect(ctx, x, y, w, w, 8);
      ctx.fill();
      // Glossy shine streak (stands in for the normal map: cheap and toon-friendly).
      if (rng() < 0.7) {
        ctx.save();
        ctx.translate(x + w * 0.28, y + w * 0.26);
        ctx.rotate(-Math.PI / 4);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        roundRect(ctx, -w * 0.16, -4, w * 0.32, 8, 4);
        ctx.fill();
        ctx.fillStyle = "rgba(255,255,255,0.45)";
        ctx.beginPath();
        ctx.arc(w * 0.22, 0, 3.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }
  }
}

function paintFrosting(ctx: Ctx, size: number, theme: ArenaTheme): void {
  const rng = createRng(hashString("frosting" + theme.floorColor));
  ctx.fillStyle = theme.floorColor;
  ctx.fillRect(0, 0, size, size);

  // Piped swirls: concentric arcs, lighter on one side and shaded on the other.
  ctx.lineCap = "round";
  for (let i = 0; i < 22; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const r = randRange(rng, 22, 54);
    const start = rng() * Math.PI * 2;
    wrapped(size, x, y, r + 10, (px, py) => {
      for (let ring = 0; ring < 3; ring++) {
        const rr = r - ring * 11;
        if (rr < 6) break;
        ctx.lineWidth = 6;
        ctx.strokeStyle = hexToRgba(shadeHex(theme.floorColor, 0.45), 0.35);
        ctx.beginPath();
        ctx.arc(px, py, rr, start, start + Math.PI * 1.3);
        ctx.stroke();
        ctx.lineWidth = 3;
        ctx.strokeStyle = hexToRgba(theme.floorShadeColor, 0.22);
        ctx.beginPath();
        ctx.arc(px + 2, py + 3, rr, start + Math.PI * 0.2, start + Math.PI * 1.45);
        ctx.stroke();
      }
    });
  }

  // Sprinkles: little rounded capsules, sparse, soft colors (the 3D sprinkles add the pop).
  const colors = [theme.floorDetailColor, "#FFFFFF", "#9FE3FF", "#B9F5C8", "#FF8FB8", "#D7B8FF"];
  for (let i = 0; i < 90; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const angle = rng() * Math.PI;
    const color = colors[i % colors.length];
    wrapped(size, x, y, 12, (px, py) => {
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(angle);
      ctx.fillStyle = hexToRgba(color, 0.9);
      roundRect(ctx, -7, -2.2, 14, 4.4, 2.2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      roundRect(ctx, -5, -1.6, 7, 1.4, 0.7);
      ctx.fill();
      ctx.restore();
    });
  }
}

function paintWood(ctx: Ctx, size: number): void {
  const rng = createRng(hashString("wood"));
  const planks = 6;
  const h = size / planks;
  const tones = [PALETTE.wood, mixHex(PALETTE.wood, PALETTE.woodDark, 0.3), shadeHex(PALETTE.wood, 0.12)];
  for (let i = 0; i < planks; i++) {
    const y = i * h;
    ctx.fillStyle = tones[i % tones.length];
    ctx.fillRect(0, y, size, h);
    // Grain: long gentle wavy lines.
    ctx.lineWidth = 2;
    for (let g = 0; g < 5; g++) {
      const gy = y + randRange(rng, 8, h - 8);
      const amp = randRange(rng, 1.5, 4);
      const freq = randRange(rng, 1, 3);
      ctx.strokeStyle = hexToRgba(PALETTE.woodDark, randRange(rng, 0.18, 0.32));
      ctx.beginPath();
      for (let x = 0; x <= size; x += 16) {
        const yy = gy + Math.sin((x / size) * Math.PI * 2 * freq) * amp;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    // A knot or two.
    if (rng() < 0.7) {
      const kx = rng() * size;
      const ky = y + h * randRange(rng, 0.3, 0.7);
      ctx.fillStyle = hexToRgba(PALETTE.woodDark, 0.45);
      ctx.beginPath();
      ctx.ellipse(kx, ky, 9, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(PALETTE.woodDark, 0.3);
      ctx.beginPath();
      ctx.ellipse(kx, ky, 15, 8, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Plank seam + highlight.
    ctx.fillStyle = hexToRgba(PALETTE.woodDark, 0.85);
    ctx.fillRect(0, y, size, 3);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, y + 3, size, 2);
    // Butt joint + nails at a random spot along the plank.
    const jx = rng() * size;
    ctx.fillStyle = hexToRgba(PALETTE.woodDark, 0.8);
    ctx.fillRect(jx, y, 3, h);
    ctx.fillStyle = hexToRgba(PALETTE.ink, 0.5);
    for (const ny of [y + h * 0.3, y + h * 0.7]) {
      ctx.beginPath();
      ctx.arc(jx - 8, ny, 2.5, 0, Math.PI * 2);
      ctx.arc(jx + 11, ny, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function paintBall(ctx: Ctx, size: number): void {
  ctx.fillStyle = PALETTE.neutralBall;
  ctx.fillRect(0, 0, size, size);
  // Subtle mottling so a resting ball still reads as round.
  const rng = createRng(hashString("ball"));
  for (let i = 0; i < 18; i++) {
    blob(ctx, rng() * size, rng() * size, randRange(rng, 10, 30), "#F1E0BC", 0.25);
  }
  // Sinusoidal seam (equirect UVs → a tennis-ball curve on the sphere).
  const seam = (x: number) => size * 0.5 + Math.sin((x / size) * Math.PI * 4) * size * 0.16;
  ctx.lineCap = "round";
  ctx.strokeStyle = "#E9C995";
  ctx.lineWidth = 16;
  ctx.beginPath();
  for (let x = 0; x <= size; x += 4) {
    if (x === 0) ctx.moveTo(x, seam(x));
    else ctx.lineTo(x, seam(x));
  }
  ctx.stroke();
  // Stitches across the seam.
  ctx.strokeStyle = "#C2864E";
  ctx.lineWidth = 2.5;
  for (let x = 4; x < size; x += 11) {
    const y = seam(x);
    const slope = (seam(x + 1) - seam(x - 1)) / 2;
    const nx = -slope;
    const len = Math.hypot(nx, 1);
    const dx = (nx / len) * 7;
    const dy = (1 / len) * 7;
    ctx.beginPath();
    ctx.moveTo(x - dx, y - dy);
    ctx.lineTo(x + dx, y + dy);
    ctx.stroke();
  }
}

function paintCloud(ctx: Ctx, width: number, height: number, color: string, shadow: string): void {
  // A puffy cluster of circles; flat top color with a crisp shadow band underneath (toon look).
  const puffs: Array<[number, number, number]> = [
    [0.22, 0.66, 0.17],
    [0.36, 0.5, 0.25],
    [0.55, 0.42, 0.3],
    [0.74, 0.55, 0.22],
    [0.86, 0.68, 0.13],
    [0.46, 0.7, 0.2],
    [0.64, 0.7, 0.2],
  ];
  const bottom = height * 0.86;
  const drawPuffs = (fill: string | CanvasGradient, dy: number, grow: number) => {
    ctx.fillStyle = fill;
    ctx.beginPath();
    for (const [px, py, pr] of puffs) {
      const r = pr * height * grow;
      ctx.moveTo(px * width + r, py * height + dy);
      ctx.arc(px * width, py * height + dy, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillRect(width * 0.2, height * 0.66 + dy, width * 0.68, bottom - height * 0.66);
  };
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, width, bottom);
  ctx.clip();
  drawPuffs(shadow, 0, 1);
  const g = ctx.createLinearGradient(0, height * 0.15, 0, height * 0.8);
  g.addColorStop(0, color);
  g.addColorStop(0.75, color);
  g.addColorStop(1, mixHex(color, shadow, 0.6));
  ctx.save();
  ctx.translate(0, -height * 0.06);
  drawPuffs(g, 0, 0.94);
  ctx.restore();
  ctx.restore();
}

function paintSoftDot(ctx: Ctx, size: number): void {
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, 0, half, half, half);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.35, "rgba(255,255,255,0.75)");
  g.addColorStop(0.7, "rgba(255,255,255,0.25)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

function paintChecker(ctx: Ctx, size: number, a: string, b: string, cells: number): void {
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? a : b;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  // Gingham: half-tone where stripes cross for a woven look.
  ctx.fillStyle = hexToRgba(a, 0.35);
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      if ((x + y) % 2 === 1 && x % 2 === 0) ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
}

function paintWicker(ctx: Ctx, size: number): void {
  const light = "#E2B676";
  const mid = "#C8955A";
  const dark = "#8D5B3A";
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, size, size);
  const rows = 8;
  const cols = 8;
  const rh = size / rows;
  const cw = size / cols;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const over = (r + c) % 2 === 0;
      const x = c * cw;
      const y = r * rh;
      ctx.fillStyle = over ? light : mid;
      roundRect(ctx, x + 2, y + 3, cw - 4, rh - 6, (rh - 6) / 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.25)";
      roundRect(ctx, x + 6, y + 6, cw - 14, 4, 2);
      ctx.fill();
    }
  }
}

function paintStripes(ctx: Ctx, size: number, base: string, stripe: string, count: number, diagonal: boolean): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = stripe;
  const period = size / count;
  const w = period * 0.42;
  if (!diagonal) {
    for (let i = 0; i < count; i++) ctx.fillRect(0, i * period, size, w);
    return;
  }
  // 45° bands that wrap exactly at the canvas edges.
  for (let i = -count; i <= count; i++) {
    const x = i * period;
    ctx.beginPath();
    ctx.moveTo(x, size);
    ctx.lineTo(x + w, size);
    ctx.lineTo(x + w + size, 0);
    ctx.lineTo(x + size, 0);
    ctx.closePath();
    ctx.fill();
  }
}

function paintLabel(ctx: Ctx, width: number, height: number, base: string, accent: string): void {
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.moveTo(0, height * 0.72);
  for (let x = 0; x <= width; x += 8) {
    ctx.lineTo(x, height * 0.72 + Math.sin((x / width) * Math.PI * 6) * 10);
  }
  ctx.lineTo(width, height);
  ctx.lineTo(0, height);
  ctx.closePath();
  ctx.fill();
  // Bubble logo on the front half.
  const bubbles: Array<[number, number, number]> = [
    [0.25, 0.38, 34],
    [0.33, 0.24, 18],
    [0.17, 0.2, 12],
    [0.36, 0.48, 10],
  ];
  for (const [bx, by, br] of bubbles) {
    ctx.fillStyle = hexToRgba(accent, 0.35);
    ctx.beginPath();
    ctx.arc(bx * width, by * height, br, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = accent;
    ctx.stroke();
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.beginPath();
    ctx.arc(bx * width - br * 0.35, by * height - br * 0.35, br * 0.22, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintStrawberry(ctx: Ctx, size: number): void {
  const g = ctx.createLinearGradient(0, 0, 0, size);
  g.addColorStop(0, "#F04A5C");
  g.addColorStop(1, "#D9304A");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const rows = 6;
  const cols = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = ((c + (r % 2) * 0.5) / cols) * size;
      const y = ((r + 0.5) / rows) * size;
      wrapped(size, x, y, 14, (px, py) => {
        ctx.fillStyle = "rgba(150, 20, 40, 0.35)";
        ctx.beginPath();
        ctx.ellipse(px, py + 1, 7, 9, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#FFE27A";
        ctx.beginPath();
        ctx.moveTo(px, py - 6);
        ctx.quadraticCurveTo(px + 4, py + 1, px, py + 5);
        ctx.quadraticCurveTo(px - 4, py + 1, px, py - 6);
        ctx.fill();
      });
    }
  }
}

/** Superellipse half-disc path |x/a|^n + (y/b)^n = 1 (y >= 0), in canvas pixels. */
function halfSuperellipse(ctx: Ctx, cx: number, base: number, a: number, b: number, n: number): void {
  const steps = 64;
  ctx.beginPath();
  for (let i = 0; i <= steps; i++) {
    const t = Math.PI - (i / steps) * Math.PI;
    const c = Math.cos(t);
    const s = Math.sin(t);
    const x = Math.sign(c) * Math.pow(Math.abs(c), 2 / n) * a;
    const y = Math.pow(Math.abs(s), 2 / n) * b;
    if (i === 0) ctx.moveTo(cx + x, base - y);
    else ctx.lineTo(cx + x, base - y);
  }
  ctx.closePath();
}

function paintMelonSlice(ctx: Ctx, w: number, h: number, n: number): void {
  const cx = w / 2;
  ctx.fillStyle = "#3E9E4A";
  ctx.fillRect(0, 0, w, h);
  const bands: Array<[number, string]> = [
    [1, "#3E9E4A"],
    [0.93, "#7CCB62"],
    [0.89, "#E9F7D2"],
    [0.84, "#FF6B7A"],
  ];
  for (const [k, color] of bands) {
    ctx.fillStyle = color;
    halfSuperellipse(ctx, cx, h, (w / 2) * k, h * k, n);
    ctx.fill();
  }
  // Juicy lighter core and dark teardrop seeds in two arcs.
  ctx.fillStyle = hexToRgba("#FF8A95", 0.7);
  halfSuperellipse(ctx, cx, h, (w / 2) * 0.55, h * 0.55, n);
  ctx.fill();
  const rng = createRng(hashString("melon"));
  for (const [rk, count] of [
    [0.62, 9],
    [0.38, 5],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const t = Math.PI * ((i + 0.5) / count) * 0.9 + Math.PI * 0.05;
      const x = cx + Math.cos(t) * (w / 2) * rk;
      const y = h - Math.sin(t) * h * rk * 1.02;
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-t + Math.PI / 2 + (rng() - 0.5) * 0.4);
      ctx.fillStyle = "#2D2A32";
      ctx.beginPath();
      ctx.ellipse(0, 0, 4.5, 8, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.beginPath();
      ctx.ellipse(-1.2, -2.5, 1.2, 2.2, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }
}

function paintSoapTop(ctx: Ctx, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, w, h);
  // Engraved oval: dark lower-right edge, light upper-left edge.
  ctx.lineWidth = 7;
  ctx.strokeStyle = hexToRgba(shadeHex(color, -0.25), 0.7);
  ctx.beginPath();
  ctx.ellipse(w / 2 + 2, h / 2 + 2, w * 0.36, h * 0.3, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = hexToRgba(shadeHex(color, 0.5), 0.9);
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.ellipse(w / 2 - 1, h / 2 - 1, w * 0.36, h * 0.3, 0, 0, Math.PI * 2);
  ctx.stroke();
  const bubbles: Array<[number, number, number]> = [
    [0.44, 0.52, 15],
    [0.56, 0.42, 10],
    [0.6, 0.6, 7],
  ];
  for (const [bx, by, br] of bubbles) {
    ctx.lineWidth = 4;
    ctx.strokeStyle = hexToRgba(shadeHex(color, -0.2), 0.6);
    ctx.beginPath();
    ctx.arc(bx * w + 1.5, by * h + 1.5, br, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = hexToRgba(shadeHex(color, 0.55), 0.95);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(bx * w, by * h, br, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function paintWallTiles(ctx: Ctx, size: number, tile: string, grout: string): void {
  const tiles = 4;
  const cell = size / tiles;
  ctx.fillStyle = grout;
  ctx.fillRect(0, 0, size, size);
  for (let y = 0; y < tiles; y++) {
    for (let x = 0; x < tiles; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? tile : shadeHex(tile, 0.08);
      roundRect(ctx, x * cell + 3, y * cell + 3, cell - 6, cell - 6, 6);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      roundRect(ctx, x * cell + 9, y * cell + 9, cell * 0.3, 5, 2.5);
      ctx.fill();
    }
  }
}

function paintDrainWater(ctx: Ctx, size: number, color: string): void {
  const c = size / 2;
  const g = ctx.createRadialGradient(c, c, 0, c, c, c);
  g.addColorStop(0, shadeHex(color, -0.35));
  g.addColorStop(0.25, color);
  g.addColorStop(1, shadeHex(color, 0.18));
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  // Spiral bands swirling into the drain.
  ctx.lineCap = "round";
  for (let arm = 0; arm < 7; arm++) {
    const base = (arm / 7) * Math.PI * 2;
    ctx.beginPath();
    for (let i = 0; i <= 80; i++) {
      const f = i / 80;
      const r = c * (0.08 + f * 0.92);
      const a = base + f * 4.2;
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.lineWidth = 10;
    ctx.strokeStyle = hexToRgba(shadeHex(color, 0.45), 0.35);
    ctx.stroke();
    ctx.lineWidth = 3;
    ctx.strokeStyle = hexToRgba("#FFFFFF", 0.35);
    ctx.stroke();
  }
  // Chrome drain: ring + cross bars over a dark hole.
  const r = size * 0.045;
  ctx.fillStyle = "#1E3A4A";
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = "#DDE7EE";
  ctx.stroke();
  ctx.lineWidth = 3;
  for (const a of [0, Math.PI / 2]) {
    ctx.beginPath();
    ctx.moveTo(c + Math.cos(a) * r, c + Math.sin(a) * r);
    ctx.lineTo(c - Math.cos(a) * r, c - Math.sin(a) * r);
    ctx.stroke();
  }
}

function paintRipples(ctx: Ctx, size: number): void {
  ctx.clearRect(0, 0, size, size);
  const rng = createRng(hashString("ripples"));
  ctx.lineCap = "round";
  for (let i = 0; i < 26; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = randRange(rng, 14, 30);
    wrapped(size, x, y, len, (px, py) => {
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(px - len / 2, py);
      ctx.quadraticCurveTo(px, py - 6, px + len / 2, py);
      ctx.stroke();
    });
  }
}
