// Canvas-drawn face sprite sheets. Owner: client-characters.

import * as THREE from "three";
import { CHARACTERS, PALETTE } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { FACE_EXPRESSIONS, type FaceExpression } from "./types";

/** Sheet layout: 512×512 canvas, 4 columns × 2 rows of 128×256 cells, FACE_EXPRESSIONS order. */
export const FACE_SHEET_SIZE = 512;
export const FACE_COLUMNS = 4;
export const FACE_ROWS = 2;

const CELL_W = FACE_SHEET_SIZE / FACE_COLUMNS;
const CELL_H = FACE_SHEET_SIZE / FACE_ROWS;
/**
 * Each cell is drawn in a 256×256 logical space squeezed into 128×256 px: the decal patches on the
 * heads are wider than tall, so the horizontal squeeze is undone on the model. The top 150 logical
 * px are the eye band, the rest the mouth band (see parts.ts UV_EYES / UV_MOUTH).
 */
const LOGICAL = 256;
const EYE_BAND_H = 150;
const CX = LOGICAL / 2;

const INK = PALETTE.ink;
const WHITE = "#FFFFFF";
const TONGUE = "#FF7A8A";
const BLUSH = "#FF8FA8";

type EyeKind = "bead" | "frog" | "cat" | "goat";
type MouthKind = "none" | "w" | "smile" | "wide";

interface FaceStyle {
  eye: EyeKind;
  /** Horizontal distance from the band center to each eye center (logical px). */
  eyeX: number;
  eyeY: number;
  /** Eye radius (vertical). */
  eyeR: number;
  iris: string;
  /** Whiskers' smug half-lids on the idle face. */
  smug?: boolean;
  /** Gruff's sleepy top lids on the idle face. */
  sleepy?: boolean;
  /** Always-on cheek blush color. */
  cheeks?: string;
  /** Tabby forehead stripes color. */
  stripes?: string;
  mouth: MouthKind;
  /** Mouth center y inside the mouth band (0..106) and half-width. */
  mouthY: number;
  mouthW: number;
  nostrils?: boolean;
}

const STYLES: Record<CharacterId, FaceStyle> = {
  quacky: { eye: "bead", eyeX: 52, eyeY: 88, eyeR: 30, iris: INK, mouth: "none", mouthY: 0, mouthW: 0 },
  hopsworth: { eye: "frog", eyeX: 64, eyeY: 76, eyeR: 50, iris: INK, mouth: "wide", mouthY: 38, mouthW: 96 },
  mochi: {
    eye: "bead",
    eyeX: 50,
    eyeY: 84,
    eyeR: 25,
    iris: INK,
    cheeks: CHARACTERS.mochi.colors.accent,
    mouth: "w",
    mouthY: 40,
    mouthW: 30,
  },
  whiskers: {
    eye: "cat",
    eyeX: 54,
    eyeY: 88,
    eyeR: 30,
    iris: CHARACTERS.whiskers.colors.eye,
    smug: true,
    stripes: CHARACTERS.whiskers.colors.accent,
    mouth: "w",
    mouthY: 36,
    mouthW: 26,
  },
  pip: { eye: "bead", eyeX: 50, eyeY: 88, eyeR: 26, iris: INK, mouth: "none", mouthY: 0, mouthW: 0 },
  gruff: {
    eye: "goat",
    eyeX: 56,
    eyeY: 86,
    eyeR: 28,
    iris: INK,
    sleepy: true,
    mouth: "smile",
    mouthY: 58,
    mouthW: 30,
    nostrils: true,
  },
};

const sheets = new Map<CharacterId, THREE.CanvasTexture>();

/**
 * Cached per character: eyes + mouth (+ beak/muzzle cues where the face plane covers them) for
 * the 8 expressions: idle, blink, angry, hurt, dizzy (spirals), happy, charging (determined squint),
 * ko ("X X"). Transparent background; the face plane sits on the head. Character flavor: Whiskers
 * smug half-lids, Hopsworth huge eyes, Mochi pink cheeks, etc. Texture repeat = (1/4, 1/2).
 */
export function getFaceSheet(character: CharacterId): THREE.CanvasTexture {
  let texture = sheets.get(character);
  if (!texture) {
    texture = new THREE.CanvasTexture(drawSheet(STYLES[character]));
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.ClampToEdgeWrapping;
    texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.anisotropy = 4;
    texture.repeat.set(1 / FACE_COLUMNS, 1 / FACE_ROWS);
    texture.offset.set(0, 0.5);
    sheets.set(character, texture);
  }
  return texture;
}

/** UV offset for an expression on a sheet with repeat (1/4, 1/2). Note: canvas row 0 is the TOP (v offset 0.5). */
export function faceOffset(expression: FaceExpression): { u: number; v: number } {
  const index = Math.max(0, FACE_EXPRESSIONS.indexOf(expression));
  const col = index % FACE_COLUMNS;
  const row = Math.floor(index / FACE_COLUMNS);
  return { u: col / FACE_COLUMNS, v: (FACE_ROWS - 1 - row) / FACE_ROWS };
}

/** The raw canvas of a sheet (dev tools / debugging). */
export function getFaceSheetCanvas(character: CharacterId): HTMLCanvasElement {
  return getFaceSheet(character).image as HTMLCanvasElement;
}

/* ============================================================== sheet */

function drawSheet(style: FaceStyle): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_SHEET_SIZE;
  canvas.height = FACE_SHEET_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  FACE_EXPRESSIONS.forEach((expression, index) => {
    const col = index % FACE_COLUMNS;
    const row = Math.floor(index / FACE_COLUMNS);
    ctx.save();
    ctx.translate(col * CELL_W, row * CELL_H);
    ctx.beginPath();
    ctx.rect(0, 0, CELL_W, CELL_H);
    ctx.clip();
    ctx.scale(CELL_W / LOGICAL, CELL_H / LOGICAL);
    drawEyeBand(ctx, style, expression);
    ctx.translate(0, EYE_BAND_H);
    drawMouthBand(ctx, style, expression);
    ctx.restore();
  });
  return canvas;
}

/* ========================================================== eye band */

function drawEyeBand(ctx: CanvasRenderingContext2D, style: FaceStyle, expression: FaceExpression): void {
  if (style.stripes) drawStripes(ctx, style.stripes);
  const blush = style.cheeks ?? (expression === "happy" ? BLUSH : null);
  if (blush) drawCheeks(ctx, style, blush, expression === "happy" ? 1.15 : 1);
  for (const side of [-1, 1] as const) {
    ctx.save();
    drawEye(ctx, style, expression, CX + side * style.eyeX, style.eyeY, style.eyeR, side);
    ctx.restore();
  }
}

function drawEye(
  ctx: CanvasRenderingContext2D,
  style: FaceStyle,
  expression: FaceExpression,
  cx: number,
  cy: number,
  r: number,
  side: -1 | 1,
): void {
  /** +1 when the nose is to the right of this eye (viewer's view). */
  const inward = -side;
  switch (expression) {
    case "idle":
      drawOpenEye(ctx, style, cx, cy, r, inward);
      if (style.smug) cutLid(ctx, style, cx, cy, r, inward, -0.02, 0.1, true);
      else if (style.sleepy) cutLid(ctx, style, cx, cy, r, inward, -0.42, -0.36, false);
      return;
    case "blink":
      strokeArc(ctx, cx, cy - r * 0.55, r * 0.82, Math.PI * 0.18, Math.PI * 0.82, r * 0.26);
      return;
    case "angry":
      drawOpenEye(ctx, style, cx, cy, r, inward);
      cutLid(ctx, style, cx, cy, r, inward, -1.0, -0.25, true);
      return;
    case "hurt":
      strokePath(
        ctx,
        [
          [cx - inward * r * 0.55, cy - r * 0.62],
          [cx + inward * r * 0.5, cy],
          [cx - inward * r * 0.55, cy + r * 0.62],
        ],
        r * 0.27,
      );
      return;
    case "dizzy":
      drawSpiral(ctx, cx, cy, r * 0.9, inward);
      return;
    case "happy":
      strokeArc(ctx, cx, cy + r * 0.4, r * 0.72, Math.PI * 1.12, Math.PI * 1.88, r * 0.28);
      return;
    case "charging":
      drawOpenEye(ctx, style, cx, cy, r, inward);
      cutLid(ctx, style, cx, cy, r, inward, -0.3, -0.05, true);
      cutBelow(ctx, cx, cy + r * 0.7, r);
      return;
    case "ko": {
      const k = r * 0.58;
      strokePath(ctx, [[cx - k, cy - k], [cx + k, cy + k]], r * 0.27);
      strokePath(ctx, [[cx + k, cy - k], [cx - k, cy + k]], r * 0.27);
      return;
    }
  }
}

function drawOpenEye(
  ctx: CanvasRenderingContext2D,
  style: FaceStyle,
  cx: number,
  cy: number,
  r: number,
  inward: number,
): void {
  switch (style.eye) {
    case "bead":
      fillEllipse(ctx, cx, cy, r * 0.72, r, style.iris);
      fillEllipse(ctx, cx + r * 0.2, cy - r * 0.4, r * 0.3, r * 0.3, WHITE);
      fillEllipse(ctx, cx - r * 0.22, cy + r * 0.4, r * 0.13, r * 0.13, WHITE);
      return;
    case "frog":
      fillEllipse(ctx, cx, cy, r, r, WHITE, r * 0.12);
      fillEllipse(ctx, cx + inward * r * 0.14, cy + r * 0.1, r * 0.5, r * 0.56, style.iris);
      fillEllipse(ctx, cx + inward * r * 0.14 + r * 0.17, cy - r * 0.14, r * 0.17, r * 0.17, WHITE);
      return;
    case "cat":
      fillEllipse(ctx, cx, cy, r * 0.8, r, style.iris, r * 0.14);
      fillEllipse(ctx, cx + inward * r * 0.08, cy, r * 0.2, r * 0.72, INK);
      fillEllipse(ctx, cx + r * 0.26, cy - r * 0.4, r * 0.2, r * 0.2, WHITE);
      return;
    case "goat":
      fillEllipse(ctx, cx, cy, r * 0.92, r * 0.82, "#F7EDB4", r * 0.13);
      fillRoundRect(ctx, cx - r * 0.52 + inward * r * 0.05, cy - r * 0.17, r * 1.04, r * 0.34, r * 0.17, INK);
      fillEllipse(ctx, cx + r * 0.3, cy - r * 0.38, r * 0.16, r * 0.16, WHITE);
      return;
  }
}

/**
 * Lowered top lid: erase everything above a line from the outer corner (outerY) to the inner corner
 * (innerY), both relative to the eye center in units of r, then ink the lid edge.
 */
function cutLid(
  ctx: CanvasRenderingContext2D,
  style: FaceStyle,
  cx: number,
  cy: number,
  r: number,
  inward: number,
  outerY: number,
  innerY: number,
  brow: boolean,
): void {
  const w = r * (style.eye === "bead" ? 0.95 : 1.15);
  const outer: [number, number] = [cx - inward * w, cy + outerY * r];
  const inner: [number, number] = [cx + inward * w, cy + innerY * r];
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.beginPath();
  ctx.moveTo(outer[0], outer[1]);
  ctx.lineTo(inner[0], inner[1]);
  ctx.lineTo(inner[0], cy - r * 3);
  ctx.lineTo(outer[0], cy - r * 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  if (!brow) {
    strokePath(ctx, [outer, inner], r * 0.16);
    return;
  }
  // The lid edge doubles as a brow, extended past the eye so it reads at a distance.
  const ext = 0.18;
  strokePath(
    ctx,
    [
      [outer[0] + (outer[0] - inner[0]) * ext, outer[1] + (outer[1] - inner[1]) * ext],
      [inner[0] + (inner[0] - outer[0]) * ext, inner[1] + (inner[1] - outer[1]) * ext],
    ],
    r * 0.24,
  );
}

/** Raised lower lid (determined squint). */
function cutBelow(ctx: CanvasRenderingContext2D, cx: number, y: number, r: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillRect(cx - r * 1.5, y, r * 3, r * 2);
  ctx.restore();
}

function drawSpiral(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, inward: number): void {
  const turns = 2.4;
  const steps = 48;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const angle = t * turns * Math.PI * 2;
    const radius = r * (0.12 + 0.88 * t);
    pts.push([cx + Math.cos(angle) * radius * inward, cy + Math.sin(angle) * radius]);
  }
  strokePath(ctx, pts, r * 0.17);
}

function drawCheeks(ctx: CanvasRenderingContext2D, style: FaceStyle, color: string, scale: number): void {
  ctx.save();
  ctx.globalAlpha = 0.85;
  for (const side of [-1, 1]) {
    const x = CX + side * (style.eyeX + style.eyeR * 0.75);
    const y = style.eyeY + style.eyeR * 1.05;
    fillEllipse(ctx, x, y, 21 * scale, 12 * scale, color);
  }
  ctx.restore();
}

function drawStripes(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  for (const dx of [-26, 0, 26]) {
    const top = dx === 0 ? 6 : 12;
    ctx.beginPath();
    ctx.moveTo(CX + dx - 8, top);
    ctx.lineTo(CX + dx + 8, top);
    ctx.lineTo(CX + dx * 1.08, top + 34);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
}

/* ======================================================== mouth band */

function drawMouthBand(ctx: CanvasRenderingContext2D, style: FaceStyle, expression: FaceExpression): void {
  if (style.mouth === "none") return;
  if (style.nostrils) {
    fillEllipse(ctx, CX - 20, 16, 6, 8, INK);
    fillEllipse(ctx, CX + 20, 16, 6, 8, INK);
  }
  const y = style.mouthY;
  const w = style.mouthW;
  switch (expression) {
    case "idle":
    case "blink":
      drawNeutralMouth(ctx, style, y, w);
      return;
    case "happy":
      drawOpenMouth(ctx, y - 8, w * 1.15, Math.min(44, w * 0.9 + 10));
      return;
    case "angry":
      drawTeeth(ctx, y - 6, w * 0.9, 24, true);
      return;
    case "hurt":
      drawWail(ctx, y, Math.max(16, w * 0.55));
      return;
    case "dizzy":
      drawWave(ctx, y, w, 6);
      drawTongue(ctx, CX + w * 0.35, y + 4, 0.8);
      return;
    case "charging":
      drawTeeth(ctx, y - 4, w * 0.7, 16, false);
      return;
    case "ko":
      fillEllipse(ctx, CX, y + 4, Math.max(10, w * 0.32), Math.max(12, w * 0.36), INK);
      drawTongue(ctx, CX + Math.max(6, w * 0.18), y + 16, 1);
      return;
  }
}

function drawNeutralMouth(ctx: CanvasRenderingContext2D, style: FaceStyle, y: number, w: number): void {
  switch (style.mouth) {
    case "w": {
      const r = w * 0.48;
      strokeArc(ctx, CX - r, y, r, 0.05 * Math.PI, 0.95 * Math.PI, 7);
      strokeArc(ctx, CX + r, y, r, 0.05 * Math.PI, 0.95 * Math.PI, 7);
      if (style.smug) strokePath(ctx, [[CX + r * 2, y + 2], [CX + r * 2.6, y - r * 0.7]], 6);
      return;
    }
    case "smile":
      strokeArc(ctx, CX, y - w * 0.75, w, 0.22 * Math.PI, 0.78 * Math.PI, 7);
      return;
    case "wide":
      strokeCurve(ctx, [CX - w, y - 12], [CX, y + 34], [CX + w, y - 12], 8);
      strokePath(ctx, [[CX - w - 8, y - 18], [CX - w + 4, y - 8]], 7);
      strokePath(ctx, [[CX + w + 8, y - 18], [CX + w - 4, y - 8]], 7);
      return;
    case "none":
      return;
  }
}

/** Big open "D" smile with a tongue. */
function drawOpenMouth(ctx: CanvasRenderingContext2D, y: number, w: number, depth: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(CX - w, y);
  ctx.quadraticCurveTo(CX, y - 6, CX + w, y);
  ctx.quadraticCurveTo(CX + w * 0.9, y + depth * 1.3, CX, y + depth * 1.3);
  ctx.quadraticCurveTo(CX - w * 0.9, y + depth * 1.3, CX - w, y);
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.clip();
  fillEllipse(ctx, CX, y + depth * 1.15, w * 0.55, depth * 0.45, TONGUE);
  ctx.restore();
}

/** Gritted teeth: white bar with tooth lines (angry) or a tight determined grimace. */
function drawTeeth(ctx: CanvasRenderingContext2D, y: number, w: number, h: number, frown: boolean): void {
  fillRoundRect(ctx, CX - w, y, w * 2, h, h * 0.45, WHITE, 6);
  strokePath(ctx, [[CX - w + 4, y + h / 2], [CX + w - 4, y + h / 2]], 4);
  for (const k of [-0.33, 0.33]) strokePath(ctx, [[CX + w * k, y + 3], [CX + w * k, y + h - 3]], 4);
  if (frown) {
    strokePath(ctx, [[CX - w - 10, y + h + 6], [CX - w + 2, y + h - 2]], 6);
    strokePath(ctx, [[CX + w + 10, y + h + 6], [CX + w - 2, y + h - 2]], 6);
  }
}

/** Wobbly open "aaah" mouth. */
function drawWail(ctx: CanvasRenderingContext2D, y: number, r: number): void {
  ctx.save();
  ctx.beginPath();
  const steps = 18;
  for (let i = 0; i <= steps; i++) {
    const a = (i / steps) * Math.PI * 2;
    const wobble = 1 + 0.12 * Math.sin(a * 5);
    const px = CX + Math.cos(a) * r * 1.15 * wobble;
    const py = y + 6 + Math.sin(a) * r * 0.85 * wobble;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fillStyle = INK;
  ctx.fill();
  ctx.clip();
  fillEllipse(ctx, CX, y + 6 + r * 0.8, r * 0.7, r * 0.4, TONGUE);
  ctx.restore();
}

function drawWave(ctx: CanvasRenderingContext2D, y: number, w: number, amp: number): void {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    pts.push([CX - w + t * w * 2, y + Math.sin(t * Math.PI * 4) * amp]);
  }
  strokePath(ctx, pts, 6);
}

function drawTongue(ctx: CanvasRenderingContext2D, x: number, y: number, scale: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(0.25);
  fillRoundRect(ctx, -9 * scale, 0, 18 * scale, 22 * scale, 9 * scale, TONGUE, 5);
  strokePath(ctx, [[0, 4 * scale], [0, 14 * scale]], 3);
  ctx.restore();
}

/* ========================================================= primitives */

function fillEllipse(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  rx: number,
  ry: number,
  color: string,
  outline = 0,
): void {
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  if (outline > 0) {
    ctx.lineWidth = outline;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
}

function fillRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
  color: string,
  outline = 0,
): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = color;
  ctx.fill();
  if (outline > 0) {
    ctx.lineWidth = outline;
    ctx.strokeStyle = INK;
    ctx.stroke();
  }
}

function strokePath(ctx: CanvasRenderingContext2D, pts: ReadonlyArray<readonly [number, number]>, width: number): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function strokeArc(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  start: number,
  end: number,
  width: number,
): void {
  ctx.beginPath();
  ctx.arc(x, y, r, start, end);
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function strokeCurve(
  ctx: CanvasRenderingContext2D,
  from: readonly [number, number],
  control: readonly [number, number],
  to: readonly [number, number],
  width: number,
): void {
  ctx.beginPath();
  ctx.moveTo(from[0], from[1]);
  ctx.quadraticCurveTo(control[0], control[1], to[0], to[1]);
  ctx.lineWidth = width;
  ctx.lineCap = "round";
  ctx.strokeStyle = INK;
  ctx.stroke();
}

