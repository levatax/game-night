// Procedural canvas textures (no image downloads). Owner: client-render. Characters and fx may import it.
// Copied from games/bonk-brawl/client/src/render/textures.ts (soft dot, cloud, wood, stripes, checker) and
// extended for the island (sparkle, ring, sail, thatch, hull lettering). Every function returns a cached
// THREE.CanvasTexture (same args → same instance; never dispose the cached ones — MaterialBank.tex() may
// release their GPU copy, three re-uploads them transparently). Tiling textures use RepeatWrapping +
// SRGBColorSpace + anisotropy 4.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import { hexToRgba, mixHex, shadeHex } from "../util/color";
import { createRng, hashString, randRange } from "./noise";

type Ctx = CanvasRenderingContext2D;

/** Driftwood / raft log tones (weathered, muted: the 2026-11 calmer palette). */
export const WOOD = { light: "#BC9672", mid: "#9E7A56", dark: "#6C4F37" } as const;

const cache = new Map<string, THREE.CanvasTexture>();

/** 128×128 radial soft dot with alpha (blob shadows, glows, particles). White, tint via material color. */
export function softDotTexture(): THREE.CanvasTexture {
  return cached("softDot", 128, 128, false, paintSoftDot);
}

/** 512×256 soft cartoon cloud with alpha (white + shadow tint). */
export function cloudTexture(color: string, shadow: string): THREE.CanvasTexture {
  return cached(`cloud|${color}|${shadow}`, 512, 256, false, (ctx, w, h) => paintCloud(ctx, w, h, color, shadow));
}

/** 512×512 hand-painted driftwood planks, 3 tones (WOOD). */
export function woodTexture(): THREE.CanvasTexture {
  return cached("wood", 512, 512, true, paintWood);
}

/** 256×256 two-color checkerboard (towels, picnic cloth on the wreck). `cells` per side. */
export function checkerTexture(a: string, b: string, cells = 8): THREE.CanvasTexture {
  return cached(`checker|${a}|${b}|${cells}`, 256, 256, true, (ctx, size) => paintChecker(ctx, size, a, b, cells));
}

/** 256×256 stripes (sails, deck chairs, beach umbrella). Repeats seamlessly in both directions. */
export function stripeTexture(base: string, stripe: string, count = 4, diagonal = true): THREE.CanvasTexture {
  const key = `stripe|${base}|${stripe}|${count}|${diagonal}`;
  return cached(key, 256, 256, true, (ctx, size) => paintStripes(ctx, size, base, stripe, count, diagonal));
}

/** 128×128 four-point twinkle star with a soft core (water glints, READY sparkles, fireflies). White, alpha. */
export function sparkleTexture(): THREE.CanvasTexture {
  return cached("sparkle", 128, 128, false, paintSparkle);
}

/** 256×256 soft ring with alpha (READY halo, light-ring hints, ripples). White, tint via material color. */
export function ringTexture(): THREE.CanvasTexture {
  return cached("ring", 256, 256, false, paintRing);
}

/** 256×256 sail cloth: a cream sail with seams, or the "old sail" treasure with colorful patches. */
export function sailTexture(old: boolean): THREE.CanvasTexture {
  return cached(`sail|${old}`, 256, 256, false, (ctx, size) => paintSail(ctx, size, old));
}

/** 256×256 palm-leaf thatch (hut roofs, the secret chest's leaf cover). Tiles in both directions. */
export function thatchTexture(): THREE.CanvasTexture {
  return cached("thatch", 256, 256, true, paintThatch);
}

/**
 * Transparent banner with one line of hand-lettered text (the wreck's "MS NEŞE" name, life-ring print).
 * Width/height in px; the text auto-fits. Repaints once web fonts finish loading.
 */
export function letteringTexture(text: string, color: string, outline: string, width = 512, height = 128): THREE.CanvasTexture {
  const key = `letter|${text}|${color}|${outline}|${width}|${height}`;
  const tex = cached(key, width, height, false, (ctx, w, h) => paintLettering(ctx, w, h, text, color, outline));
  const fonts = typeof document !== "undefined" ? document.fonts : undefined;
  if (fonts && fonts.status !== "loaded" && !tex.userData.fontHooked) {
    tex.userData.fontHooked = true;
    void fonts.ready.then(() => {
      const canvas = tex.image as HTMLCanvasElement;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      paintLettering(ctx, canvas.width, canvas.height, text, color, outline);
      tex.needsUpdate = true;
    });
  }
  return tex;
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

/* ================================================================ painters */

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

function paintWood(ctx: Ctx, size: number): void {
  const rng = createRng(hashString("wood"));
  const planks = 6;
  const h = size / planks;
  const tones = [WOOD.mid, mixHex(WOOD.mid, WOOD.dark, 0.3), shadeHex(WOOD.mid, 0.12)];
  for (let i = 0; i < planks; i++) {
    const y = i * h;
    ctx.fillStyle = tones[i % tones.length]!;
    ctx.fillRect(0, y, size, h);
    // Grain: long gentle wavy lines.
    ctx.lineWidth = 2;
    for (let g = 0; g < 5; g++) {
      const gy = y + randRange(rng, 8, h - 8);
      const amp = randRange(rng, 1.5, 4);
      const freq = randRange(rng, 1, 3);
      ctx.strokeStyle = hexToRgba(WOOD.dark, randRange(rng, 0.18, 0.32));
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
      ctx.fillStyle = hexToRgba(WOOD.dark, 0.45);
      ctx.beginPath();
      ctx.ellipse(kx, ky, 9, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = hexToRgba(WOOD.dark, 0.3);
      ctx.beginPath();
      ctx.ellipse(kx, ky, 15, 8, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    // Plank seam + highlight.
    ctx.fillStyle = hexToRgba(WOOD.dark, 0.85);
    ctx.fillRect(0, y, size, 3);
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    ctx.fillRect(0, y + 3, size, 2);
  }
}

function paintChecker(ctx: Ctx, size: number, a: string, b: string, cells: number): void {
  const cell = size / cells;
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      ctx.fillStyle = (x + y) % 2 === 0 ? a : b;
      ctx.fillRect(x * cell, y * cell, cell, cell);
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

function paintSparkle(ctx: Ctx, size: number): void {
  const half = size / 2;
  const core = ctx.createRadialGradient(half, half, 0, half, half, half * 0.45);
  core.addColorStop(0, "rgba(255,255,255,1)");
  core.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, size, size);
  // Four tapered rays.
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  for (let k = 0; k < 4; k++) {
    ctx.save();
    ctx.translate(half, half);
    ctx.rotate((k * Math.PI) / 2);
    ctx.beginPath();
    ctx.moveTo(0, -half * 0.98);
    ctx.lineTo(half * 0.07, 0);
    ctx.lineTo(-half * 0.07, 0);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

function paintRing(ctx: Ctx, size: number): void {
  const half = size / 2;
  const g = ctx.createRadialGradient(half, half, half * 0.55, half, half, half);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.55, "rgba(255,255,255,0.9)");
  g.addColorStop(0.7, "rgba(255,255,255,0.6)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

function paintSail(ctx: Ctx, size: number, old: boolean): void {
  const rng = createRng(hashString(old ? "oldsail" : "sail"));
  const base = old ? "#E9D9B4" : PALETTE.cream;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  // Soft shading toward the edges (billow).
  const g = ctx.createLinearGradient(0, 0, size, 0);
  g.addColorStop(0, "rgba(0,0,0,0.12)");
  g.addColorStop(0.45, "rgba(255,255,255,0.08)");
  g.addColorStop(1, "rgba(0,0,0,0.16)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  if (old) {
    // Pirate-ish patches in faded colors, with stitches.
    const colors = ["#D9534F", "#5B8DD6", "#F2B84B", "#6BBF7A", "#B784D6"];
    for (let i = 0; i < 7; i++) {
      const w = randRange(rng, 34, 70);
      const h = randRange(rng, 30, 60);
      const x = rng() * (size - w);
      const y = rng() * (size - h);
      ctx.fillStyle = hexToRgba(colors[i % colors.length]!, 0.78);
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = hexToRgba(PALETTE.ink, 0.55);
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 2;
      ctx.strokeRect(x + 3, y + 3, w - 6, h - 6);
      ctx.setLineDash([]);
    }
    // A painted skull-ish smiley (goofy, not scary).
    ctx.fillStyle = hexToRgba(PALETTE.ink, 0.7);
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.46, 26, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = base;
    ctx.beginPath();
    ctx.arc(size * 0.44, size * 0.43, 6, 0, Math.PI * 2);
    ctx.arc(size * 0.56, size * 0.43, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = base;
    ctx.beginPath();
    ctx.arc(size * 0.5, size * 0.48, 12, 0.2, Math.PI - 0.2);
    ctx.stroke();
  } else {
    // A cheerful stripe band near the foot.
    ctx.fillStyle = hexToRgba(PALETTE.sunset, 0.85);
    ctx.fillRect(0, size * 0.72, size, size * 0.08);
    ctx.fillStyle = hexToRgba(PALETTE.sea, 0.85);
    ctx.fillRect(0, size * 0.82, size, size * 0.05);
  }
  // Vertical seams.
  ctx.strokeStyle = hexToRgba(PALETTE.ink, 0.18);
  ctx.lineWidth = 2;
  for (let x = size / 5; x < size; x += size / 5) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, size);
    ctx.stroke();
  }
}

function paintThatch(ctx: Ctx, size: number): void {
  const rng = createRng(hashString("thatch"));
  ctx.fillStyle = "#A99062";
  ctx.fillRect(0, 0, size, size);
  ctx.lineCap = "round";
  for (let i = 0; i < 420; i++) {
    const x = rng() * size;
    const y = rng() * size;
    const len = randRange(rng, 18, 46);
    const tone = rng();
    ctx.strokeStyle = tone < 0.33 ? "#82704A" : tone < 0.66 ? "#C2AC7E" : "#9A8455";
    ctx.lineWidth = randRange(rng, 1.5, 3.5);
    wrapped(size, x, y, len, (px, py) => {
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(px + randRange(rng, -3, 3), py + len);
      ctx.stroke();
    });
  }
  // Horizontal binding rows.
  ctx.fillStyle = hexToRgba("#54462C", 0.5);
  for (let y = 0; y < size; y += size / 4) ctx.fillRect(0, y, size, 4);
}

function paintLettering(ctx: Ctx, width: number, height: number, text: string, color: string, outline: string): void {
  ctx.clearRect(0, 0, width, height);
  let fontSize = Math.floor(height * 0.72);
  const family = '"Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif';
  ctx.font = `700 ${fontSize}px ${family}`;
  while (fontSize > 8 && ctx.measureText(text).width > width * 0.92) {
    fontSize -= 2;
    ctx.font = `700 ${fontSize}px ${family}`;
  }
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.lineWidth = Math.max(2, fontSize * 0.14);
  ctx.strokeStyle = outline;
  ctx.strokeText(text, width / 2, height / 2 + fontSize * 0.04);
  ctx.fillStyle = color;
  ctx.fillText(text, width / 2, height / 2 + fontSize * 0.04);
}
