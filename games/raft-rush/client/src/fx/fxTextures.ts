// Procedural canvas textures owned by fx: the particle atlas and a soft glow sprite. Owner: client-fx-audio.
// Adapted from games/bonk-brawl/client/src/fx/fxTextures.ts: same white-tile-with-ink-outline style (tinted per
// particle), extended with island tiles (leaf, berry, water drop, heart, splinter, smell wisp, shell, note).
// Every getter returns a lazily built cached texture shared by all fx objects (never dispose them).

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";

/** Particle atlas layout: 5×5 tiles of 128 px. */
export const ATLAS_GRID = 5;
const TILE_PX = 128;

export const TILE = {
  glow: 0,
  star: 1,
  puff: 2,
  feather: 3,
  confetti: 4,
  sparkle: 5,
  streak: 6,
  ring: 7,
  bubble: 8,
  crumb: 9,
  chip: 10,
  dust: 11,
  flash: 12,
  leaf: 13,
  berry: 14,
  drop: 15,
  heart: 16,
  splinter: 17,
  smell: 18,
  shell: 19,
  note: 20,
  ember: 21,
  coin: 22,
} as const;

export type TileId = (typeof TILE)[keyof typeof TILE];

const INK = PALETTE.ink;

let atlas: THREE.CanvasTexture | null = null;
let glow: THREE.CanvasTexture | null = null;

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
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/* ================================================================ particle atlas */

/** 640×640 atlas of particle shapes (see TILE). */
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

function inked(ctx: CanvasRenderingContext2D, width = 7): void {
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.lineWidth = width;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function paintStar(ctx: CanvasRenderingContext2D): void {
  starPath(ctx, C, C + 4, 52, 25, 5);
  inked(ctx, 8);
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
  inked(ctx, 6);
  ctx.beginPath();
  ctx.moveTo(0, -40);
  ctx.lineTo(0, 56);
  ctx.moveTo(0, -10);
  ctx.lineTo(16, -22);
  ctx.moveTo(0, 12);
  ctx.lineTo(-16, 0);
  ctx.lineWidth = 4;
  ctx.stroke();
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
  inked(ctx, 7);
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
  inked(ctx, 7);
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

/** A pointed tropical leaf with a midrib. */
function paintLeaf(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(C, C);
  ctx.rotate(-0.6);
  ctx.beginPath();
  ctx.moveTo(0, -56);
  ctx.quadraticCurveTo(36, -10, 0, 52);
  ctx.quadraticCurveTo(-36, -10, 0, -56);
  ctx.closePath();
  inked(ctx, 6);
  ctx.beginPath();
  ctx.moveTo(0, -46);
  ctx.lineTo(0, 46);
  ctx.moveTo(0, -12);
  ctx.lineTo(14, -24);
  ctx.moveTo(0, 8);
  ctx.lineTo(-14, -4);
  ctx.moveTo(0, 26);
  ctx.lineTo(12, 16);
  ctx.lineWidth = 4;
  ctx.stroke();
  ctx.restore();
}

/** A round berry with a shine dot and a tiny calyx. */
function paintBerry(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.arc(C, C + 6, 40, 0, Math.PI * 2);
  inked(ctx, 7);
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  ctx.beginPath();
  ctx.arc(C + 8, C + 18, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.ellipse(C - 14, C - 10, 9, 6, -0.6, 0, Math.PI * 2);
  ctx.fill();
  starPath(ctx, C, C - 34, 14, 6, 5);
  ctx.fillStyle = INK;
  ctx.fill();
}

/** A water droplet (tip up). */
function paintDrop(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(C, C - 54);
  ctx.bezierCurveTo(C + 16, C - 20, C + 38, C + 4, C + 36, C + 22);
  ctx.arc(C, C + 22, 36, 0, Math.PI);
  ctx.bezierCurveTo(C - 38, C + 4, C - 16, C - 20, C, C - 54);
  ctx.closePath();
  ctx.fillStyle = "#FFFFFF";
  ctx.fill();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(45,42,50,0.55)";
  ctx.stroke();
  ctx.fillStyle = "rgba(255,255,255,1)";
  ctx.beginPath();
  ctx.ellipse(C - 12, C + 12, 7, 12, 0.3, 0, Math.PI * 2);
  ctx.globalCompositeOperation = "destination-out";
  ctx.globalAlpha = 0.35;
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}

function paintHeart(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(C, C + 46);
  ctx.bezierCurveTo(C - 60, C + 4, C - 44, C - 52, C, C - 22);
  ctx.bezierCurveTo(C + 44, C - 52, C + 60, C + 4, C, C + 46);
  ctx.closePath();
  inked(ctx, 7);
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.ellipse(C - 22, C - 18, 9, 6, -0.7, 0, Math.PI * 2);
  ctx.fill();
}

/** A long wood splinter with a grain line. */
function paintSplinter(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.translate(C, C);
  ctx.rotate(0.5);
  ctx.beginPath();
  ctx.moveTo(-50, -6);
  ctx.lineTo(42, -14);
  ctx.lineTo(54, -2);
  ctx.lineTo(36, 12);
  ctx.lineTo(-46, 10);
  ctx.closePath();
  inked(ctx, 6);
  ctx.beginPath();
  ctx.moveTo(-36, 0);
  ctx.lineTo(30, -4);
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();
}

/** A wavy cartoon "smell" wisp (bait fish stink lines). */
function paintSmell(ctx: CanvasRenderingContext2D): void {
  ctx.lineCap = "round";
  ctx.lineWidth = 12;
  ctx.strokeStyle = "#FFFFFF";
  ctx.beginPath();
  for (let i = 0; i <= 24; i++) {
    const y = 116 - i * 4.5;
    const x = C + Math.sin(i * 0.55) * 18;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

/** A shell shard (crab bits). */
function paintShell(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.moveTo(C - 44, C + 26);
  ctx.quadraticCurveTo(C - 30, C - 44, C + 10, C - 40);
  ctx.quadraticCurveTo(C + 48, C - 20, C + 40, C + 30);
  ctx.closePath();
  inked(ctx, 7);
  ctx.fillStyle = "rgba(0,0,0,0.14)";
  ctx.beginPath();
  ctx.moveTo(C - 30, C + 24);
  ctx.quadraticCurveTo(C, C + 4, C + 34, C + 26);
  ctx.lineTo(C + 34, C + 30);
  ctx.lineTo(C - 30, C + 28);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.beginPath();
  ctx.ellipse(C - 4, C - 22, 10, 5, -0.3, 0, Math.PI * 2);
  ctx.fill();
}

/** An eighth note (radio / happy moments). */
function paintNote(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.ellipse(C - 14, C + 32, 22, 16, -0.4, 0, Math.PI * 2);
  inked(ctx, 7);
  ctx.beginPath();
  ctx.moveTo(C + 6, C + 28);
  ctx.lineTo(C + 6, C - 48);
  ctx.quadraticCurveTo(C + 40, C - 30, C + 34, C - 2);
  ctx.lineWidth = 10;
  ctx.strokeStyle = INK;
  ctx.stroke();
  ctx.lineWidth = 5;
  ctx.strokeStyle = "#FFFFFF";
  ctx.stroke();
}

/** Hot ember: a bright core with a soft halo (additive). */
function paintEmber(ctx: CanvasRenderingContext2D): void {
  const g = ctx.createRadialGradient(C, C, 0, C, C, 50);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.95)");
  g.addColorStop(0.4, "rgba(255,255,255,0.35)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, TILE_PX, TILE_PX);
}

/** A shiny coin disc (gold glints). */
function paintCoin(ctx: CanvasRenderingContext2D): void {
  ctx.beginPath();
  ctx.ellipse(C, C, 44, 48, 0, 0, Math.PI * 2);
  inked(ctx, 7);
  ctx.beginPath();
  ctx.ellipse(C, C, 30, 34, 0, 0, Math.PI * 2);
  ctx.lineWidth = 5;
  ctx.strokeStyle = "rgba(0,0,0,0.18)";
  ctx.stroke();
  starPath(ctx, C, C + 2, 16, 7, 5);
  ctx.fillStyle = "rgba(0,0,0,0.16)";
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.95)";
  ctx.beginPath();
  ctx.ellipse(C - 18, C - 20, 8, 5, -0.7, 0, Math.PI * 2);
  ctx.fill();
}

const TILE_PAINTERS: Readonly<Record<TileId, (c: CanvasRenderingContext2D) => void>> = {
  [TILE.glow]: paintGlow,
  [TILE.star]: paintStar,
  [TILE.puff]: paintPuff,
  [TILE.feather]: paintFeather,
  [TILE.confetti]: paintConfetti,
  [TILE.sparkle]: paintSparkle,
  [TILE.streak]: paintStreak,
  [TILE.ring]: paintRing,
  [TILE.bubble]: paintBubble,
  [TILE.crumb]: paintCrumb,
  [TILE.chip]: paintChip,
  [TILE.dust]: paintDust,
  [TILE.flash]: paintFlash,
  [TILE.leaf]: paintLeaf,
  [TILE.berry]: paintBerry,
  [TILE.drop]: paintDrop,
  [TILE.heart]: paintHeart,
  [TILE.splinter]: paintSplinter,
  [TILE.smell]: paintSmell,
  [TILE.shell]: paintShell,
  [TILE.note]: paintNote,
  [TILE.ember]: paintEmber,
  [TILE.coin]: paintCoin,
};

/* ======================================================================= sprites */

/** 128×128 soft radial glow (pickup halos, bobber glints). White; tint via material color. */
export function glowTexture(): THREE.CanvasTexture {
  if (glow) return glow;
  const [canvas, ctx] = makeCanvas(TILE_PX, TILE_PX);
  paintGlow(ctx);
  glow = toTexture(canvas);
  return glow;
}
