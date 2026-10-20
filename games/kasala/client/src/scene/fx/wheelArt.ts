// Patronun Çarkı painted on canvas (§7, §16.4): 8 equal slices in WHEEL_SLICES order (index 0 at the top,
// then clockwise as seen from the front), two-line labels written tangentially (readable when the slice sits
// under the pointer), gold separators, a dark outer band under the bulbs. Plus the "PATRONUN ÇARKI" marquee
// sign. Repainted once the web fonts are ready. Owner: client-cards-fx.

import * as THREE from "three";
import { PALETTE, WHEEL_SLICES } from "../../../../shared/constants";
import { upperTr } from "../../app/ui";
import { fontsReady } from "../toon";
import { roundRectPath } from "./textures";
import { shade } from "./util";

export const WHEEL_PX = 1024;
const FONT = `Fredoka, "Arial Rounded MT Bold", "Arial Black", sans-serif`;
const INK = PALETTE.ink;
const GOLD = PALETTE.gold;

/** Split a slice label into two lines: the first word, then the rest. */
export function labelLines(label: string): [string, string] {
  const words = upperTr(label).split(" ");
  if (words.length === 1) return ["", words[0]!];
  return [words[0]!, words.slice(1).join(" ")];
}

function fitPx(ctx: CanvasRenderingContext2D, s: string, maxW: number, maxPx: number, minPx: number): number {
  let px = maxPx;
  ctx.font = `700 ${px}px ${FONT}`;
  while (px > minPx && ctx.measureText(s).width > maxW) {
    px -= 2;
    ctx.font = `700 ${px}px ${FONT}`;
  }
  return px;
}

function paintWheel(ctx: CanvasRenderingContext2D): void {
  const S = WHEEL_PX;
  const c = S / 2;
  const R = S / 2 - 4;
  const n = WHEEL_SLICES.length;
  const half = Math.PI / n;
  ctx.clearRect(0, 0, S, S);

  for (let i = 0; i < n; i++) {
    const def = WHEEL_SLICES[i]!;
    const mid = -Math.PI / 2 + (i / n) * Math.PI * 2;
    const g = ctx.createRadialGradient(c, c, R * 0.12, c, c, R);
    g.addColorStop(0, shade(def.color, 0.35));
    g.addColorStop(0.7, def.color);
    g.addColorStop(1, shade(def.color, -0.25));
    ctx.beginPath();
    ctx.moveTo(c, c);
    ctx.arc(c, c, R, mid - half, mid + half);
    ctx.closePath();
    ctx.fillStyle = g;
    ctx.fill();
    // inner bevel stripe for a toy-like look
    ctx.save();
    ctx.clip();
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 14;
    ctx.beginPath();
    ctx.arc(c, c, R * 0.86, mid - half, mid + half);
    ctx.stroke();
    ctx.restore();
  }

  // gold separators with ink edges
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + ((i + 0.5) / n) * Math.PI * 2;
    const x0 = c + Math.cos(a) * R * 0.16;
    const y0 = c + Math.sin(a) * R * 0.16;
    const x1 = c + Math.cos(a) * R;
    const y1 = c + Math.sin(a) * R;
    ctx.lineCap = "round";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 16;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.strokeStyle = GOLD;
    ctx.lineWidth = 8;
    ctx.stroke();
  }

  // labels
  for (let i = 0; i < n; i++) {
    const def = WHEEL_SLICES[i]!;
    const [l1, l2] = labelLines(def.label);
    ctx.save();
    ctx.translate(c, c);
    ctx.rotate((i / n) * Math.PI * 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.lineJoin = "round";
    const r1 = R * 0.76;
    const r2 = l1 ? R * 0.58 : R * 0.66;
    const chord = (r: number) => 2 * r * Math.sin(half) * 0.84;
    const px2 = fitPx(ctx, l2, chord(r2 - 20), l1 ? 70 : 92, 26);
    const px1 = l1 ? Math.min(fitPx(ctx, l1, chord(r1 - 24), 66, 26), Math.max(px2, 44)) : 0;
    const draw = (s: string, r: number, px: number) => {
      ctx.font = `700 ${px}px ${FONT}`;
      ctx.lineWidth = Math.max(8, px * 0.2);
      ctx.strokeStyle = INK;
      ctx.strokeText(s, 0, -r);
      ctx.fillStyle = PALETTE.cream;
      ctx.fillText(s, 0, -r);
    };
    if (l1) draw(l1, r1, px1);
    draw(l2, r2, px2);
    ctx.restore();
  }

  // outer dark band (under the rim + bulbs) and the inner hub ring
  ctx.lineWidth = 26;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(c, c, R - 13, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 10;
  ctx.strokeStyle = shade(GOLD, -0.2);
  ctx.beginPath();
  ctx.arc(c, c, R - 32, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = INK;
  ctx.beginPath();
  ctx.arc(c, c, R * 0.17, 0, Math.PI * 2);
  ctx.fill();
}

function paintSign(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = INK;
  roundRectPath(ctx, 0, 0, w, h, 34);
  ctx.fill();
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, "#8E1B2C");
  g.addColorStop(1, "#4A0A16");
  ctx.fillStyle = g;
  roundRectPath(ctx, 10, 10, w - 20, h - 20, 26);
  ctx.fill();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 6;
  roundRectPath(ctx, 22, 22, w - 44, h - 44, 18);
  ctx.stroke();
  // marquee dots
  ctx.fillStyle = "#FFF1B5";
  const dots = 26;
  for (let k = 0; k < dots; k++) {
    const x = 40 + (k / (dots - 1)) * (w - 80);
    ctx.beginPath();
    ctx.arc(x, 16, 4, 0, Math.PI * 2);
    ctx.arc(x, h - 16, 4, 0, Math.PI * 2);
    ctx.fill();
  }
  const label = upperTr("Patronun Çarkı");
  const px = fitPx(ctx, label, w - 120, 112, 40);
  ctx.font = `700 ${px}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.shadowColor = GOLD;
  ctx.shadowBlur = 24;
  ctx.lineWidth = 14;
  ctx.strokeStyle = INK;
  ctx.strokeText(label, w / 2, h / 2 + 6);
  ctx.shadowBlur = 0;
  ctx.fillStyle = GOLD;
  ctx.fillText(label, w / 2, h / 2 + 6);
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.fillText(label, w / 2, h / 2 + 2);
}

function repaintable(w: number, h: number, paint: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  paint(ctx, w, h);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  void fontsReady().then(() => {
    paint(ctx, w, h);
    tex.needsUpdate = true;
  });
  return tex;
}

export function wheelFaceTexture(): THREE.CanvasTexture {
  return repaintable(WHEEL_PX, WHEEL_PX, (ctx) => paintWheel(ctx));
}

/**
 * The wheel face smeared around its center (motion blur for a fast spin): the face drawn `n` times rotated
 * across `span` radians as a running average. Laid over the face while it spins fast, so the repeating
 * slices and separators never strobe or seem to run backwards. Follows the face's font repaint.
 */
export function wheelBlurTexture(face: THREE.CanvasTexture, span: number, px = 512): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = px;
  canvas.height = px;
  const ctx = canvas.getContext("2d")!;
  const paint = () => {
    const src = face.image as HTMLCanvasElement;
    const n = 16;
    ctx.clearRect(0, 0, px, px);
    for (let k = 0; k < n; k++) {
      ctx.save();
      ctx.translate(px / 2, px / 2);
      ctx.rotate(-span / 2 + (span * k) / (n - 1));
      ctx.globalAlpha = 1 / (k + 1);
      ctx.drawImage(src, -px / 2, -px / 2, px, px);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  };
  paint();
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;
  // the face repaints itself once the fonts load (registered first, so it runs first)
  void fontsReady().then(() => {
    paint();
    tex.needsUpdate = true;
  });
  return tex;
}

export function wheelSignTexture(): THREE.CanvasTexture {
  return repaintable(1024, 220, paintSign);
}
