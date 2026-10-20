// Procedural canvas textures owned by fx: particle atlas, glow, ball skins, curveball swirl.
// Owner: client-fx. Every getter returns a lazily-built cached texture shared by all fx objects
// (never dispose the returned textures).

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";

/** Particle atlas layout: 4×4 tiles of 128 px. Tiles are white (tinted per particle) with ink outlines. */
export const ATLAS_GRID = 4;
const TILE_PX = 128;

export const TILE = {
  glow: 0,
  star: 1,
  puff: 2,
  feather: 3,
  fur: 4,
  confetti: 5,
  sparkle: 6,
  streak: 7,
  ring: 8,
  bubble: 9,
  crumb: 10,
  chip: 11,
  dust: 12,
  flash: 13,
} as const;

export type TileId = (typeof TILE)[keyof typeof TILE];

const INK = PALETTE.ink;

let atlas: THREE.CanvasTexture | null = null;
let glow: THREE.CanvasTexture | null = null;
let swirl: THREE.CanvasTexture | null = null;
let ballSkin: THREE.CanvasTexture | null = null;
let beachSkin: THREE.CanvasTexture | null = null;

function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  return [canvas, ctx];
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Deterministic pseudo-random sequence so procedural art is identical on every load. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ================================================================ particle atlas */

/** 512×512 atlas of particle shapes (see TILE). */
export function particleAtlas(): THREE.CanvasTexture {
  if (atlas) return atlas;
  const [canvas, ctx] = makeCanvas(TILE_PX * ATLAS_GRID, TILE_PX * ATLAS_GRID);
  for (const [id, paint] of Object.entries(TILE_PAINTERS)) {
    const tile = Number(id);
    ctx.save();
    ctx.translate((tile % ATLAS_GRID) * TILE_PX, Math.floor(tile / ATLAS_GRID) * TILE_PX);
    ctx.beginPath();
    ctx.rect(0, 0, TILE_PX, TILE_PX);
    ctx.clip();
    paint(ctx);
    ctx.restore();
  }
  atlas = toTexture(canvas);
  return atlas;
}

const C = TILE_PX / 2;

function paintGlow(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(C, C, 0, C, C, C - 4);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.75)");
  g.addColorStop(0.6, "rgba(255,255,255,0.2)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
}

function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number, inner: number, points: number): void {
  ctx.beginPath();
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = -Math.PI / 2 + (i * Math.PI) / points;
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

function paintStar(ctx: CanvasRenderingContext2D): void {
  ctx.lineJoin = "round";
  starPath(ctx, C, C + 4, 52, 25, 5);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.lineWidth = 8;
  ctx.strokeStyle = INK;
  ctx.stroke();
  // Glossy highlight: the star stays readable when tinted.
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.ellipse(C - 10, C - 8, 7, 4, -0.6, 0, Math.PI * 2);
  ctx.fill();
}

function paintPuff(ctx: CanvasRenderingContext2D): void {
  const blobs: ReadonlyArray<[number, number, number]> = [
    [C - 22, C + 8, 30],
    [C + 20, C + 10, 32],
    [C, C - 14, 36],
    [C - 6, C + 18, 30],
  ];
  ctx.fillStyle = "#FFFFFF";
  for (const [x, y, r] of blobs) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
  // Toon shade on the underside.
  ctx.save();
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = "#D6E2EE";
  ctx.beginPath();
  ctx.ellipse(C + 6, C + 46, 62, 30, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function paintFeather(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(C, C);
  ctx.rotate(-0.7);
  ctx.beginPath();
  ctx.moveTo(0, -54);
  ctx.bezierCurveTo(30, -34, 26, 22, 4, 44);
  ctx.lineTo(-4, 44);
  ctx.bezierCurveTo(-26, 22, -30, -34, 0, -54);
  ctx.closePath();
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.stroke();
  // Quill + barb notches.
  ctx.beginPath();
  ctx.moveTo(0, -40);
  ctx.lineTo(0, 56);
  ctx.moveTo(0, -10);
  ctx.lineTo(16, -22);
  ctx.moveTo(0, 12);
  ctx.lineTo(-16, 0);
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.restore();
}

function paintFur(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(C, C + 20);
  ctx.lineJoin = "round";
  for (const angle of [-0.55, 0, 0.5]) {
    ctx.save();
    ctx.rotate(angle);
    ctx.beginPath();
    ctx.moveTo(-12, 10);
    ctx.quadraticCurveTo(-18, -40, 6, -68);
    ctx.quadraticCurveTo(0, -36, 14, 10);
    ctx.closePath();
    ctx.fillStyle = "#FFFFFF";
    ctx.fill();
    ctx.lineWidth = 6;
    ctx.strokeStyle = INK;
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function paintConfetti(ctx: CanvasRenderingContext2D): void {
  roundRect(ctx, 14, 30, 100, 68, 10);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  roundRect(ctx, 14, 74, 100, 24, 10);
  ctx.fill();
}

function paintSparkle(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(C, C, 0, C, C, 40);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.moveTo(C, C - 60);
  ctx.quadraticCurveTo(C + 6, C - 6, C + 60, C);
  ctx.quadraticCurveTo(C + 6, C + 6, C, C + 60);
  ctx.quadraticCurveTo(C - 6, C + 6, C - 60, C);
  ctx.quadraticCurveTo(C - 6, C - 6, C, C - 60);
  ctx.fill();
}

function paintStreak(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createLinearGradient(6, 0, TILE_PX - 6, 0);
  g.addColorStop(0, "rgba(255,255,255,0)");
  g.addColorStop(0.7, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,1)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(6, C);
  ctx.quadraticCurveTo(C, C - 12, TILE_PX - 10, C - 9);
  ctx.arc(TILE_PX - 10, C, 9, -Math.PI / 2, Math.PI / 2);
  ctx.quadraticCurveTo(C, C + 12, 6, C);
  ctx.fill();
}

function paintRing(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(C, C, 52, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.arc(C, C, 42, 0, Math.PI * 2);
  ctx.stroke();
}

function paintBubble(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(C, C, 20, C, C, 54);
  g.addColorStop(0, "rgba(255,255,255,0.08)");
  g.addColorStop(0.85, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0.9)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(C, C, 54, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#FFFFFF";
  ctx.lineWidth = 5;
  ctx.stroke();
  ctx.fillStyle = "#FFFFFF";
  ctx.beginPath();
  ctx.ellipse(C - 20, C - 22, 13, 8, -0.7, 0, Math.PI * 2);
  ctx.fill();
}

function paintCrumb(ctx: CanvasRenderingContext2D): void {
  const rand = seeded(7);
  ctx.beginPath();
  const n = 7;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = 34 + rand() * 18;
    const x = C + Math.cos(a) * r;
    const y = C + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  ctx.beginPath();
  ctx.arc(C + 10, C + 12, 9, 0, Math.PI * 2);
  ctx.arc(C - 14, C + 4, 6, 0, Math.PI * 2);
  ctx.fill();
}

function paintChip(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(C, C);
  ctx.rotate(0.25);
  roundRect(ctx, -40, -40, 80, 80, 8);
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.fillStyle = "rgba(0,0,0,0.12)";
  roundRect(ctx, -40, 14, 80, 26, 8);
  ctx.fill();
  ctx.restore();
}

function paintDust(ctx: CanvasRenderingContext2D): void {
  const blobs: ReadonlyArray<[number, number, number]> = [
    [C - 14, C + 6, 40],
    [C + 16, C + 2, 38],
    [C, C - 12, 40],
  ];
  for (const [x, y, r] of blobs) {
    const g = ctx.createRadialGradient(x, y, r * 0.3, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.85)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function paintFlash(ctx: CanvasRenderingContext2D): void {
  const rays = 12;
  ctx.fillStyle = "rgba(255,255,255,0.85)";
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const r = i % 2 === 0 ? 62 : 46;
    ctx.beginPath();
    ctx.moveTo(C + Math.cos(a - 0.12) * 14, C + Math.sin(a - 0.12) * 14);
    ctx.lineTo(C + Math.cos(a) * r, C + Math.sin(a) * r);
    ctx.lineTo(C + Math.cos(a + 0.12) * 14, C + Math.sin(a + 0.12) * 14);
    ctx.fill();
  }
  const g = ctx.createRadialGradient(C, C, 0, C, C, 34);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(C, C, 34, 0, Math.PI * 2);
  ctx.fill();
}

const TILE_PAINTERS: Readonly<Record<TileId, (c: CanvasRenderingContext2D) => void>> = {
  [TILE.glow]: paintGlow,
  [TILE.star]: paintStar,
  [TILE.puff]: paintPuff,
  [TILE.feather]: paintFeather,
  [TILE.fur]: paintFur,
  [TILE.confetti]: paintConfetti,
  [TILE.sparkle]: paintSparkle,
  [TILE.streak]: paintStreak,
  [TILE.ring]: paintRing,
  [TILE.bubble]: paintBubble,
  [TILE.crumb]: paintCrumb,
  [TILE.chip]: paintChip,
  [TILE.dust]: paintDust,
  [TILE.flash]: paintFlash,
};

/* ======================================================================= sprites */

/** 128×128 soft radial glow (ball halos, power-up halos). White; tint via material color. */
export function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const [canvas, ctx] = makeCanvas(TILE_PX, TILE_PX);
  paintGlow(ctx);
  glow = toTexture(canvas);
  return glow;
}

const spriteCache = new Map<TileId, THREE.CanvasTexture>();

/** One particle-atlas tile as its own 128×128 texture (for THREE.Sprite effects). White; tint via material color. */
export function spriteTexture(tile: TileId): THREE.CanvasTexture {
  const cached = spriteCache.get(tile);
  if (cached) return cached;
  const [canvas, ctx] = makeCanvas(TILE_PX, TILE_PX);
  TILE_PAINTERS[tile](ctx);
  const tex = toTexture(canvas);
  spriteCache.set(tile, tex);
  return tex;
}

/** 128×128 two-arm spiral used as the Curveball swirl sprite. */
export function swirlTexture(): THREE.CanvasTexture {
  if (swirl) return swirl;
  const [canvas, ctx] = makeCanvas(TILE_PX, TILE_PX);
  ctx.lineCap = "round";
  for (let arm = 0; arm < 2; arm++) {
    ctx.beginPath();
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      const a = arm * Math.PI + t * Math.PI * 2.2;
      const r = 6 + t * 50;
      const x = C + Math.cos(a) * r;
      const y = C + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 9;
    ctx.stroke();
  }
  swirl = toTexture(canvas);
  return swirl;
}

/* ===================================================================== ball skins */

const SKIN_W = 512;
const SKIN_H = 256;

/**
 * Cream ball skin (PALETTE.neutralBall) with a wavy stitched seam around the equator, laid out
 * for THREE.SphereGeometry UVs. The seam makes rolling and spin readable.
 */
export function ballSkinTexture(): THREE.CanvasTexture {
  if (ballSkin) return ballSkin;
  const [canvas, ctx] = makeCanvas(SKIN_W, SKIN_H);
  ctx.fillStyle = PALETTE.neutralBall;
  ctx.fillRect(0, 0, SKIN_W, SKIN_H);
  // Faint panel tint on one half so the seam reads as two leather panels.
  ctx.fillStyle = "rgba(232, 214, 182, 0.35)";
  ctx.beginPath();
  seamPath(ctx, 0);
  ctx.lineTo(SKIN_W, SKIN_H);
  ctx.lineTo(0, SKIN_H);
  ctx.closePath();
  ctx.fill();
  // Seam groove.
  ctx.strokeStyle = "#D9BF94";
  ctx.lineWidth = 9;
  ctx.beginPath();
  seamPath(ctx, 0);
  ctx.stroke();
  // Red cross stitches along the groove.
  ctx.strokeStyle = "#E8384F";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  const stitches = 36;
  for (let i = 0; i < stitches; i++) {
    const x = ((i + 0.5) / stitches) * SKIN_W;
    const y = seamY(x);
    const slope = (seamY(x + 1) - seamY(x - 1)) / 2;
    const nx = -slope;
    const ny = 1;
    const len = Math.hypot(nx, ny);
    const ox = (nx / len) * 9;
    const oy = (ny / len) * 9;
    ctx.beginPath();
    ctx.moveTo(x - ox - 3, y - oy);
    ctx.lineTo(x + ox + 3, y + oy);
    ctx.stroke();
  }
  ballSkin = toTexture(canvas);
  return ballSkin;
}

function seamY(x: number): number {
  return SKIN_H * (0.5 + 0.13 * Math.sin((x / SKIN_W) * Math.PI * 4));
}

function seamPath(ctx: CanvasRenderingContext2D, offset: number): void {
  for (let x = 0; x <= SKIN_W; x += 4) {
    const y = seamY(x) + offset;
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
}

/** Giant red beach ball (Mega Ball): red/white gores with yellow pole caps. */
export function beachBallTexture(): THREE.CanvasTexture {
  if (beachSkin) return beachSkin;
  const [canvas, ctx] = makeCanvas(SKIN_W, SKIN_H);
  const gores = ["#FF4D4D", "#FFF8EC", "#FF4D4D", "#FFD23F", "#FF4D4D", "#FFF8EC"];
  const w = SKIN_W / gores.length;
  gores.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect(i * w, 0, w + 1, SKIN_H);
  });
  ctx.strokeStyle = "rgba(45, 42, 50, 0.25)";
  ctx.lineWidth = 3;
  for (let i = 0; i <= gores.length; i++) {
    ctx.beginPath();
    ctx.moveTo(i * w, 0);
    ctx.lineTo(i * w, SKIN_H);
    ctx.stroke();
  }
  // Pole caps (top/bottom rows of the equirect map).
  ctx.fillStyle = "#FFF8EC";
  ctx.fillRect(0, 0, SKIN_W, SKIN_H * 0.07);
  ctx.fillRect(0, SKIN_H * 0.93, SKIN_W, SKIN_H * 0.07);
  beachSkin = toTexture(canvas);
  return beachSkin;
}
