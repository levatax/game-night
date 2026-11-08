// Canvas-drawn face sprite sheets: eyes + brows (eye band) and mouths (mouth band) for the 8
// expressions. Eyes and mouth are sampled by two texture clones with independent offsets, so any
// eyes expression combines with any mouth expression. Owner: client-characters.

import * as THREE from "three";
import { CHARACTERS, PALETTE } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { FACE_EXPRESSIONS, type FaceExpression } from "./types";

/** Sheet layout: 1024×512 canvas (width = FACE_SHEET_SIZE), 4 columns × 2 rows of 256×256 cells. */
export const FACE_SHEET_SIZE = 1024;
export const FACE_SHEET_HEIGHT = 512;
export const FACE_COLUMNS = 4;
export const FACE_ROWS = 2;

const CELL = 256;
/** The top 150 px of a cell are the eye band, the rest (106 px) the mouth band (parts.ts UV_*). */
const EYE_BAND_H = 150;
const CX = CELL / 2;

const INK = PALETTE.ink;
const WHITE = "#FFFFFF";
const TONGUE = "#FF7A8A";
const BLUSH = "#FF9EB5";

type EyeKind = "bead" | "frog" | "cat" | "goat";
type BrowKind = "none" | "tuft" | "soft" | "thin" | "feather" | "bar";
type MouthKind = "none" | "w" | "smirk" | "wide";
/** How the brows / lids sit for one expression. */
type BrowPose = "rest" | "angry" | "worried" | "happy" | "charging" | "none";

interface FaceStyle {
  eye: EyeKind;
  /** Horizontal distance from the band center to each eye center (px). */
  eyeX: number;
  eyeY: number;
  /** Eye radius (vertical). */
  eyeR: number;
  iris: string;
  /** Idle top lid cut (outer, inner) in units of r; null = wide open. */
  idleLid: readonly [number, number] | null;
  /** Lid fill (frog: green skin lid instead of an erased cut). */
  lidColor?: string;
  brow: BrowKind;
  /** Resting brow tilt: px the inner end sits lower than the outer end. */
  browTilt: number;
  /** Extra lift of the character's RIGHT brow on idle / charging (px). */
  browAsym?: number;
  /** Idle blush alpha (0 = only on happy). */
  blush: number;
  /** Extra sparkle star in each eye. */
  sparkle?: boolean;
  /** Tabby forehead stripes color. */
  stripes?: string;
  mouth: MouthKind;
  /** Mouth center y inside the mouth band (0..106) and half-width. */
  mouthY: number;
  mouthW: number;
  nostrils?: boolean;
}

const STYLES: Record<CharacterId, FaceStyle> = {
  quacky: {
    eye: "bead",
    eyeX: 54,
    eyeY: 88,
    eyeR: 32,
    iris: INK,
    idleLid: null,
    brow: "tuft",
    browTilt: 4,
    blush: 0,
    mouth: "none",
    mouthY: 0,
    mouthW: 0,
  },
  hopsworth: {
    eye: "frog",
    eyeX: 64,
    eyeY: 80,
    eyeR: 50,
    iris: INK,
    idleLid: [-0.62, -0.62],
    lidColor: CHARACTERS.hopsworth.colors.body,
    brow: "none",
    browTilt: 0,
    blush: 0,
    mouth: "wide",
    mouthY: 36,
    mouthW: 96,
  },
  mochi: {
    eye: "bead",
    eyeX: 58,
    eyeY: 90,
    eyeR: 24,
    iris: INK,
    idleLid: [-0.3, -0.3],
    brow: "soft",
    browTilt: -3,
    blush: 0,
    mouth: "w",
    mouthY: 40,
    mouthW: 30,
  },
  whiskers: {
    eye: "cat",
    eyeX: 54,
    eyeY: 90,
    eyeR: 30,
    iris: CHARACTERS.whiskers.colors.eye,
    idleLid: [-0.02, 0.1],
    brow: "thin",
    browTilt: 2,
    browAsym: 8,
    blush: 0,
    stripes: CHARACTERS.whiskers.colors.accent,
    mouth: "w",
    mouthY: 36,
    mouthW: 26,
  },
  pip: {
    eye: "bead",
    eyeX: 48,
    eyeY: 86,
    eyeR: 30,
    iris: INK,
    idleLid: null,
    brow: "feather",
    browTilt: 0,
    blush: 0.45,
    sparkle: true,
    mouth: "none",
    mouthY: 0,
    mouthW: 0,
  },
  gruff: {
    eye: "goat",
    eyeX: 56,
    eyeY: 90,
    eyeR: 28,
    iris: INK,
    idleLid: [-0.42, -0.36],
    brow: "bar",
    browTilt: 9,
    blush: 0,
    mouth: "smirk",
    mouthY: 58,
    mouthW: 30,
    nostrils: true,
  },
};

const sheets = new Map<CharacterId, THREE.CanvasTexture>();

/**
 * Cached per character (lazily drawn): 8 expressions (idle, blink, angry, hurt, dizzy, happy,
 * charging, ko) with brows. Transparent background; eye and mouth patches sample their bands.
 * Clone it per animal (clones share one GPU upload) and set offsets with setFaceOffset.
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

/** Allocation-free: point `texture` (a sheet clone) at `expression`. */
export function setFaceOffset(texture: THREE.Texture, expression: FaceExpression): void {
  const index = Math.max(0, FACE_EXPRESSIONS.indexOf(expression));
  const col = index % FACE_COLUMNS;
  const row = (index - col) / FACE_COLUMNS;
  texture.offset.set(col / FACE_COLUMNS, (FACE_ROWS - 1 - row) / FACE_ROWS);
}

/** The raw canvas of a sheet (dev tools / debugging). */
export function getFaceSheetCanvas(character: CharacterId): HTMLCanvasElement {
  return getFaceSheet(character).image as HTMLCanvasElement;
}

/* ============================================================== sheet */

function drawSheet(style: FaceStyle): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = FACE_SHEET_SIZE;
  canvas.height = FACE_SHEET_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  FACE_EXPRESSIONS.forEach((expression, index) => {
    const col = index % FACE_COLUMNS;
    const row = Math.floor(index / FACE_COLUMNS);
    ctx.save();
    ctx.translate(col * CELL, row * CELL);
    ctx.beginPath();
    ctx.rect(0, 0, CELL, CELL);
    ctx.clip();
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, CELL, EYE_BAND_H);
    ctx.clip();
    drawEyeBand(ctx, style, expression);
    ctx.restore();
    ctx.translate(0, EYE_BAND_H);
    drawMouthBand(ctx, style, expression);
    ctx.restore();
  });
  return canvas;
}

/* ========================================================== eye band */

function browPose(expression: FaceExpression): BrowPose {
  switch (expression) {
    case "idle":
    case "blink":
      return "rest";
    case "angry":
      return "angry";
    case "hurt":
      return "worried";
    case "happy":
      return "happy";
    case "charging":
      return "charging";
    default:
      return "none";
  }
}

function drawEyeBand(ctx: CanvasRenderingContext2D, style: FaceStyle, expression: FaceExpression): void {
  if (style.stripes) drawStripes(ctx, style.stripes);
  const blush = expression === "happy" ? 0.8 : style.blush;
  if (blush > 0 && expression !== "ko" && expression !== "dizzy") drawCheeks(ctx, style, blush, expression === "happy" ? 1.15 : 1);
  for (const side of [-1, 1] as const) {
    const cx = CX + side * style.eyeX;
    ctx.save();
    drawEye(ctx, style, expression, cx, style.eyeY, style.eyeR, side);
    ctx.restore();
    drawBrow(ctx, style, browPose(expression), expression, cx, style.eyeY, style.eyeR, side);
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
      drawOpenEye(ctx, style, cx, cy, r, inward, 1);
      if (style.idleLid) cutLid(ctx, style, cx, cy, r, inward, style.idleLid[0], style.idleLid[1]);
      return;
    case "blink":
      strokeArc(ctx, cx, cy - r * 0.55, r * 0.82, Math.PI * 0.18, Math.PI * 0.82, r * 0.26);
      return;
    case "angry":
      drawOpenEye(ctx, style, cx, cy, r, inward, 0.8);
      cutLid(ctx, style, cx, cy, r, inward, -1.0, -0.25);
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
      drawOpenEye(ctx, style, cx, cy, r, inward, 0.9);
      cutLid(ctx, style, cx, cy, r, inward, -0.42, -0.42);
      cutBelow(ctx, cx, cy + r * 0.62, r);
      strokePath(ctx, [[cx - r * 0.8, cy + r * 0.62], [cx + r * 0.8, cy + r * 0.62]], r * 0.12);
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
  pupil: number,
): void {
  switch (style.eye) {
    case "bead":
      fillEllipse(ctx, cx, cy, r * 0.72 * pupil, r * pupil, style.iris);
      highlights(ctx, cx, cy, r * pupil, inward);
      if (style.sparkle) drawSparkle(ctx, cx - inward * r * 0.25, cy + r * 0.05, r * 0.2);
      return;
    case "frog": {
      fillEllipse(ctx, cx, cy, r, r, WHITE, 6);
      const px = cx + inward * r * 0.14;
      const py = cy + r * 0.14;
      fillEllipse(ctx, px, py, r * 0.5 * pupil, r * 0.42 * pupil, style.iris);
      highlights(ctx, px, py, r * 0.42 * pupil, inward);
      return;
    }
    case "cat":
      fillEllipse(ctx, cx, cy, r * 0.8, r, style.iris, r * 0.14);
      fillEllipse(ctx, cx + inward * r * 0.08, cy, r * 0.2 * pupil, r * 0.72 * pupil, INK);
      highlights(ctx, cx, cy, r * 0.8, inward);
      return;
    case "goat":
      fillEllipse(ctx, cx, cy, r * 0.92, r * 0.82, "#F7EDB4", r * 0.13);
      fillRoundRect(ctx, cx - r * 0.52 * pupil + inward * r * 0.05, cy - r * 0.17, r * 1.04 * pupil, r * 0.34, r * 0.17, INK);
      highlights(ctx, cx, cy, r * 0.8, inward);
      return;
  }
}

/** Every open eye: a big highlight upper-outer (0.3r) and a small one lower-inner (0.13r). */
function highlights(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, inward: number): void {
  fillEllipse(ctx, cx - inward * r * 0.28, cy - r * 0.42, r * 0.3, r * 0.3, WHITE);
  fillEllipse(ctx, cx + inward * r * 0.25, cy + r * 0.42, r * 0.13, r * 0.13, WHITE);
}

function drawSparkle(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  ctx.save();
  ctx.fillStyle = WHITE;
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 - Math.PI / 2;
    const rr = i % 2 === 0 ? s : s * 0.35;
    const px = x + Math.cos(a) * rr;
    const py = y + Math.sin(a) * rr;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/**
 * Lowered top lid: everything above the line from the outer corner (outerY) to the inner corner
 * (innerY), relative to the eye center in units of r, is erased (or painted with the skin lid),
 * then the lid edge is inked.
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
): void {
  const w = r * (style.eye === "bead" ? 0.95 : 1.15);
  const outer: [number, number] = [cx - inward * w, cy + outerY * r];
  const inner: [number, number] = [cx + inward * w, cy + innerY * r];
  ctx.save();
  if (style.lidColor) {
    // Skin lid over the eye (frog): clip to the eye and paint above the lid line.
    ctx.beginPath();
    ctx.ellipse(cx, cy, r + 3, r + 3, 0, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = style.lidColor;
  } else {
    ctx.globalCompositeOperation = "destination-out";
  }
  ctx.beginPath();
  ctx.moveTo(outer[0], outer[1]);
  ctx.lineTo(inner[0], inner[1]);
  ctx.lineTo(inner[0], cy - r * 3);
  ctx.lineTo(outer[0], cy - r * 3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  strokePath(ctx, [outer, inner], r * (style.lidColor ? 0.12 : 0.16));
}

/** Raised lower lid (determined squint). */
function cutBelow(ctx: CanvasRenderingContext2D, cx: number, y: number, r: number): void {
  ctx.save();
  ctx.globalCompositeOperation = "destination-out";
  ctx.fillRect(cx - r * 1.5, y, r * 3, r * 2);
  ctx.restore();
}

/**
 * Brows: ink strokes ~16 px above the eye top, 0.9·r long (style-dependent shape). `side` −1 is
 * the viewer's left = the character's RIGHT eye.
 */
function drawBrow(
  ctx: CanvasRenderingContext2D,
  style: FaceStyle,
  pose: BrowPose,
  expression: FaceExpression,
  cx: number,
  cy: number,
  r: number,
  side: -1 | 1,
): void {
  if (style.brow === "none" || pose === "none") return;
  const inward = -side;
  const len = r * 0.9;
  let y = cy - r - 16;
  // Inner-end drop (px) relative to the outer end; arch bulge.
  let drop = style.browTilt;
  let arch = 0;
  switch (pose) {
    case "angry":
      drop = 14;
      y += 4;
      break;
    case "worried":
      drop = -12;
      y -= 2;
      break;
    case "happy":
      drop = -2;
      y -= 8;
      arch = 7;
      break;
    case "charging":
      drop = Math.tan((10 * Math.PI) / 180) * len * 2;
      y += 8;
      break;
    case "rest":
      break;
  }
  const asym = style.browAsym && side === -1 && (expression === "idle" || expression === "charging" || expression === "blink") ? style.browAsym : 0;
  y -= asym;
  const ox = cx - inward * len * 0.55;
  const ix = cx + inward * len * 0.55;
  const oy = y - drop / 2;
  const iy = y + drop / 2;
  const mx = (ox + ix) / 2;
  const my = (oy + iy) / 2 - arch;
  switch (style.brow) {
    case "bar":
      strokePath(ctx, [[ox, oy], [ix, iy]], 12);
      return;
    case "thin":
      strokeCurve(ctx, [ox, oy], [mx, my - 6], [ix, iy], 6);
      return;
    case "soft":
      strokeCurve(ctx, [ox, oy - 4], [mx, my - 8], [ix, iy - 4], 9);
      return;
    case "tuft": {
      // Short feather tuft: a thick stroke plus a flick at the outer end.
      strokeCurve(ctx, [ox, oy], [mx, my - 4], [ix, iy], 8);
      strokePath(ctx, [[ox, oy], [ox - inward * 8, oy - 9]], 6);
      return;
    }
    case "feather": {
      const fx = (ox + ix) / 2;
      strokePath(ctx, [[fx - inward * len * 0.3, my + 3], [fx + inward * len * 0.25, my - 2]], 7);
      return;
    }
    default:
      return;
  }
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

function drawCheeks(ctx: CanvasRenderingContext2D, style: FaceStyle, alpha: number, scale: number): void {
  ctx.save();
  ctx.globalAlpha = alpha;
  for (const side of [-1, 1]) {
    const x = CX + side * Math.min(CX - 24, style.eyeX + style.eyeR * 0.7);
    const y = Math.min(EYE_BAND_H - 14, style.eyeY + style.eyeR * 1.1);
    fillEllipse(ctx, x, y, 21 * scale, 12 * scale, BLUSH);
  }
  ctx.restore();
}

function drawStripes(ctx: CanvasRenderingContext2D, color: string): void {
  ctx.save();
  ctx.fillStyle = color;
  for (const dx of [-26, 0, 26]) {
    const top = dx === 0 ? 4 : 10;
    ctx.beginPath();
    ctx.moveTo(CX + dx - 8, top);
    ctx.lineTo(CX + dx + 8, top);
    ctx.lineTo(CX + dx * 1.08, top + 26);
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
      drawAngryMouth(ctx, style, y, w);
      return;
    case "hurt":
      drawWail(ctx, y, Math.max(16, w * 0.55));
      return;
    case "dizzy":
      drawWave(ctx, y, w, 6);
      drawTongue(ctx, CX + w * 0.45, y + 4, 0.8);
      return;
    case "charging":
      drawChargingMouth(ctx, style, y, w);
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
      // Whiskers' smirk tick on the character's right (viewer's left).
      if (style.browAsym) strokePath(ctx, [[CX - r * 2, y + 2], [CX - r * 2.6, y - r * 0.7]], 6);
      return;
    }
    case "smirk":
      strokePath(ctx, [[CX - w, y], [CX + w * 0.6, y]], 7);
      strokePath(ctx, [[CX + w * 0.6, y], [CX + w, y - 8]], 7);
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

function drawAngryMouth(ctx: CanvasRenderingContext2D, style: FaceStyle, y: number, w: number): void {
  switch (style.mouth) {
    case "wide": {
      // Down-curve + squiggle.
      strokeCurve(ctx, [CX - w * 0.8, y + 18], [CX, y - 14], [CX + w * 0.8, y + 18], 8);
      const pts: Array<[number, number]> = [];
      for (let i = 0; i <= 10; i++) pts.push([CX - 18 + i * 3.6, y + 26 + (i % 2 === 0 ? -3 : 3)]);
      strokePath(ctx, pts, 4);
      return;
    }
    case "smirk":
      // Flat bared teeth.
      drawTeeth(ctx, y - 10, w * 1.0, 20);
      return;
    default:
      drawTeeth(ctx, y - 4, w * 0.9, 22);
      // Frown corners.
      strokePath(ctx, [[CX - w * 0.9 - 10, y + 26], [CX - w * 0.9 + 2, y + 18]], 6);
      strokePath(ctx, [[CX + w * 0.9 + 10, y + 26], [CX + w * 0.9 - 2, y + 18]], 6);
      strokeCurve(ctx, [CX - w * 0.9, y - 10], [CX, y - 18], [CX + w * 0.9, y - 10], 6);
      return;
  }
}

function drawChargingMouth(ctx: CanvasRenderingContext2D, style: FaceStyle, y: number, w: number): void {
  switch (style.mouth) {
    case "wide":
      // One-corner smirk.
      strokeCurve(ctx, [CX - w * 0.7, y], [CX, y + 10], [CX + w * 0.8, y - 16], 8);
      strokePath(ctx, [[CX + w * 0.8 + 8, y - 22], [CX + w * 0.8 - 4, y - 12]], 7);
      return;
    case "w": {
      // ω + "=" clench below.
      const r = w * 0.42;
      strokeArc(ctx, CX - r, y - 4, r, 0.05 * Math.PI, 0.95 * Math.PI, 7);
      strokeArc(ctx, CX + r, y - 4, r, 0.05 * Math.PI, 0.95 * Math.PI, 7);
      strokePath(ctx, [[CX - w * 0.55, y + 18], [CX + w * 0.55, y + 18]], 5);
      strokePath(ctx, [[CX - w * 0.55, y + 27], [CX + w * 0.55, y + 27]], 5);
      if (style.browAsym) strokePath(ctx, [[CX - r * 2, y - 2], [CX - r * 2.6, y - r * 0.8]], 6);
      return;
    }
    default:
      // Confident clenched grin: corners up, teeth visible.
      drawGrin(ctx, y - 2, w * 0.95, 18);
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

/** Gritted teeth: white bar with tooth lines. */
function drawTeeth(ctx: CanvasRenderingContext2D, y: number, w: number, h: number): void {
  fillRoundRect(ctx, CX - w, y, w * 2, h, h * 0.45, WHITE, 6);
  strokePath(ctx, [[CX - w + 4, y + h / 2], [CX + w - 4, y + h / 2]], 4);
  for (const k of [-0.33, 0.33]) strokePath(ctx, [[CX + w * k, y + 3], [CX + w * k, y + h - 3]], 4);
}

/** Clenched grin: a smile-shaped white band with upturned corners and tooth lines. */
function drawGrin(ctx: CanvasRenderingContext2D, y: number, w: number, h: number): void {
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(CX - w, y - 8);
  ctx.quadraticCurveTo(CX, y + 4, CX + w, y - 8);
  ctx.quadraticCurveTo(CX + w * 0.8, y + h + 6, CX, y + h + 6);
  ctx.quadraticCurveTo(CX - w * 0.8, y + h + 6, CX - w, y - 8);
  ctx.closePath();
  ctx.fillStyle = WHITE;
  ctx.fill();
  ctx.lineWidth = 6;
  ctx.strokeStyle = INK;
  ctx.lineJoin = "round";
  ctx.stroke();
  ctx.clip();
  strokeCurve(ctx, [CX - w, y + 2], [CX, y + 14], [CX + w, y + 2], 4);
  for (const k of [-0.4, 0, 0.4]) strokePath(ctx, [[CX + w * k, y - 6], [CX + w * k, y + h + 6]], 3);
  ctx.restore();
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
  ctx.ellipse(x, y, Math.max(0.1, rx), Math.max(0.1, ry), 0, 0, Math.PI * 2);
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
