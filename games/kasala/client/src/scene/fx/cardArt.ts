// Card faces and the card back, painted on canvas (§6): cream card stock, rarity-colored metallic border, a
// dark name band, drawn icon art per card (no emoji), a value pill and the one-line rule. The raid card is red
// with a police siren + badge. Textures are cached per (card, value line, cursed) and repainted once the web
// fonts are ready. Owner: client-cards-fx.

import * as THREE from "three";
import {
  CARD_BY_ID,
  FINAL_TABLE_MULT,
  PALETTE,
  RARITIES,
  WHEEL_SLICES,
  type CardDef,
  type CardId,
  type Rarity,
} from "../../../../shared/constants";
import { money, upperTr } from "../../app/ui";
import { fontsReady } from "../toon";
import { drawNazar, roundRectPath } from "./textures";
import { shade } from "./util";

export const CARD_PX_W = 256;
export const CARD_PX_H = 360;
/**
 * Canvas pixels per layout pixel. The faces are laid out on a 256 × 360 grid and painted at twice that, so
 * the revealed "hero" card (about a third of the screen height) stays crisp on high-DPI screens.
 */
const TEX_SCALE = 2;

const INK = PALETTE.ink;
const CREAM = PALETTE.cream;
const FONT = `Fredoka, "Arial Rounded MT Bold", "Arial Black", sans-serif`;
const GOLD = PALETTE.gold;
const MONEY = PALETTE.money;

type Ctx = CanvasRenderingContext2D;

// ------------------------------------------------------------------------------------------ value line

/** The value pill text for a card ("+50$", "POT ×2", "%20 HARAÇ", …). `value` = CardMsg.value. */
export function valueText(id: CardId, value: number): string {
  const def = CARD_BY_ID[id];
  switch (id) {
    case "bozukluk":
    case "tomar":
    case "canta":
    case "kulce":
      return money(value > 0 ? value : def.value, true);
    case "aklama":
      return `VİTRİN ×${def.value}`;
    case "harac":
      return `%${Math.round(def.value * 100)} HARAÇ`;
    case "haracTuru":
      return `HERKES ${money(def.value)}`;
    case "tuzak":
      return "SIRADAKİNE";
    case "lanet":
      return "NAZAR!";
    case "takas":
      return "KASA TAKASI";
    case "avukat":
      return "BASKIN İPTAL";
    case "rusvet":
      return `SİREN −${def.value}`;
    case "cark":
      return "ÇARK!";
    case "baskin":
      return "BASKIN!";
  }
}

// --------------------------------------------------------------------------------------- drawing kit

function fill(ctx: Ctx, color: string | CanvasGradient, lw = 5): void {
  ctx.fillStyle = color;
  ctx.fill();
  if (lw > 0) {
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    ctx.lineJoin = "round";
    ctx.stroke();
  }
}

function circle(ctx: Ctx, x: number, y: number, r: number, color: string | CanvasGradient, lw = 5): void {
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  fill(ctx, color, lw);
}

function rrect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number, color: string | CanvasGradient, lw = 5): void {
  roundRectPath(ctx, x, y, w, h, r);
  fill(ctx, color, lw);
}

function poly(ctx: Ctx, pts: number[], color: string | CanvasGradient, lw = 5): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!, pts[1]!);
  for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i]!, pts[i + 1]!);
  ctx.closePath();
  fill(ctx, color, lw);
}

function shine(ctx: Ctx, x: number, y: number, rx: number, ry: number, rot = -0.5, a = 0.75): void {
  ctx.fillStyle = `rgba(255,255,255,${a})`;
  ctx.beginPath();
  ctx.ellipse(x, y, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
}

function sparkle(ctx: Ctx, x: number, y: number, r: number, color = "#FFFFFF"): void {
  ctx.fillStyle = color;
  ctx.beginPath();
  const k = r * 0.18;
  ctx.moveTo(x, y - r);
  ctx.quadraticCurveTo(x + k, y - k, x + r, y);
  ctx.quadraticCurveTo(x + k, y + k, x, y + r);
  ctx.quadraticCurveTo(x - k, y + k, x - r, y);
  ctx.quadraticCurveTo(x - k, y - k, x, y - r);
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = INK;
  ctx.stroke();
}

function vgrad(ctx: Ctx, y0: number, y1: number, stops: [number, string][]): CanvasGradient {
  const g = ctx.createLinearGradient(0, y0, 0, y1);
  for (const [o, c] of stops) g.addColorStop(o, c);
  return g;
}

function text(ctx: Ctx, s: string, x: number, y: number, px: number, color: string, weight = 700, stroke = 0, strokeColor: string = INK): void {
  ctx.font = `${weight} ${px}px ${FONT}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  if (stroke > 0) {
    ctx.lineWidth = stroke;
    ctx.strokeStyle = strokeColor;
    ctx.lineJoin = "round";
    ctx.strokeText(s, x, y);
  }
  ctx.fillStyle = color;
  ctx.fillText(s, x, y);
}

/** Largest font size (≤ maxPx) at which `s` fits in `maxW`. */
function fitPx(ctx: Ctx, s: string, maxW: number, maxPx: number, minPx: number, weight = 700): number {
  let px = maxPx;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (px > minPx && ctx.measureText(s).width > maxW) {
    px -= 1;
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  return px;
}

function wrap(ctx: Ctx, s: string, maxW: number): string[] {
  const words = s.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) {
      lines.push(line);
      line = w;
    } else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

function bill(ctx: Ctx, x: number, y: number, w: number, h: number, rot: number): void {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  rrect(ctx, -w / 2, -h / 2, w, h, 4, "#8FDB97", 4);
  ctx.strokeStyle = "#3E9A55";
  ctx.lineWidth = 2.5;
  roundRectPath(ctx, -w / 2 + 5, -h / 2 + 5, w - 10, h - 10, 3);
  ctx.stroke();
  ctx.fillStyle = "#C9F0C4";
  ctx.beginPath();
  ctx.ellipse(0, 0, h * 0.32, h * 0.32, 0, 0, Math.PI * 2);
  ctx.fill();
  text(ctx, "$", 0, 1, h * 0.5, "#2F7A44");
  ctx.restore();
}

function coin(ctx: Ctx, x: number, y: number, r: number, mark = true): void {
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);
  g.addColorStop(0, "#FFF0A8");
  g.addColorStop(0.55, GOLD);
  g.addColorStop(1, "#D99A12");
  circle(ctx, x, y, r, g, 5);
  ctx.strokeStyle = "#C2860C";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(x, y, r * 0.74, 0, Math.PI * 2);
  ctx.stroke();
  if (mark) text(ctx, "$", x, y + r * 0.04, r * 1.05, "#B07408");
  shine(ctx, x - r * 0.38, y - r * 0.42, r * 0.28, r * 0.13, -0.7, 0.8);
}

// ------------------------------------------------------------------------------------------ icon art
// Every icon draws around (0, 0) in a ±64 px box.

function artCoins(ctx: Ctx): void {
  // a small stack
  for (let k = 0; k < 4; k++) {
    const y = 48 - k * 8;
    ctx.beginPath();
    ctx.ellipse(-30, y, 26, 9, 0, 0, Math.PI * 2);
    fill(ctx, k === 3 ? GOLD : "#E2A91F", 4);
  }
  coin(ctx, 34, 18, 24);
  coin(ctx, -4, -12, 36);
  sparkle(ctx, 40, -34, 10);
  sparkle(ctx, -46, -36, 7);
}

function artRoll(ctx: Ctx): void {
  bill(ctx, 6, -30, 92, 44, -0.25);
  // the roll: a fat cylinder of bills lying on its side
  const body = vgrad(ctx, -24, 30, [
    [0, "#A6E8AC"],
    [0.5, MONEY],
    [1, "#4FA562"],
  ]);
  rrect(ctx, -40, -22, 96, 52, 16, body, 5);
  ctx.strokeStyle = "rgba(47,122,68,0.55)";
  ctx.lineWidth = 2.5;
  for (const y of [-10, 4, 18]) {
    ctx.beginPath();
    ctx.moveTo(-28, y);
    ctx.lineTo(48, y);
    ctx.stroke();
  }
  // the spiral end
  ctx.beginPath();
  ctx.ellipse(-40, 4, 16, 26, 0, 0, Math.PI * 2);
  fill(ctx, "#C9F0C4", 5);
  ctx.strokeStyle = "#2F7A44";
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (let a = 0; a < Math.PI * 5; a += 0.2) {
    const r = 2 + a * 0.85;
    const px = -40 + Math.cos(a) * r * 0.6;
    const py = 4 + Math.sin(a) * r;
    if (a === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.stroke();
  // red rubber band
  rrect(ctx, 6, -26, 14, 60, 4, "#E5383B", 4);
  shine(ctx, 10, -12, 3, 9, 0, 0.6);
  sparkle(ctx, 50, -44, 9);
}

function artBriefcase(ctx: Ctx): void {
  // bills sticking out of the seam
  bill(ctx, 52, -2, 56, 26, 0.35);
  bill(ctx, -50, 6, 56, 26, -0.4);
  bill(ctx, 14, -36, 60, 28, -0.15);
  // handle
  rrect(ctx, -22, -46, 44, 22, 10, "#5A3524", 5);
  rrect(ctx, -12, -38, 24, 12, 5, "#F6E7C8", 0);
  // body
  const g = vgrad(ctx, -26, 48, [
    [0, "#A9703C"],
    [1, "#6E4120"],
  ]);
  rrect(ctx, -58, -26, 116, 74, 12, g, 5);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(-58, -2);
  ctx.lineTo(58, -2);
  ctx.stroke();
  // straps + gold latches
  rrect(ctx, -38, -26, 12, 74, 3, "#5A3524", 3);
  rrect(ctx, 26, -26, 12, 74, 3, "#5A3524", 3);
  rrect(ctx, -40, -10, 16, 14, 3, GOLD, 3);
  rrect(ctx, 24, -10, 16, 14, 3, GOLD, 3);
  shine(ctx, -44, -16, 9, 4, -0.2, 0.35);
}

function goldBar(ctx: Ctx, x: number, y: number, w: number, h: number): void {
  const inset = 12;
  const g = vgrad(ctx, y - h, y, [
    [0, "#FFF0A8"],
    [0.45, GOLD],
    [1, "#D18E0A"],
  ]);
  poly(ctx, [x - w / 2, y, x + w / 2, y, x + w / 2 - inset, y - h, x - w / 2 + inset, y - h], g, 5);
  poly(ctx, [x - w / 2 + inset, y - h, x + w / 2 - inset, y - h, x + w / 2 - inset - 6, y - h - 8, x - w / 2 + inset + 6, y - h - 8], "#FFE680", 4);
  text(ctx, "999", x, y - h / 2 + 1, 12, "#A86E06");
  shine(ctx, x - w / 4, y - h * 0.65, 9, 3, -0.15, 0.7);
}

function artGoldBars(ctx: Ctx): void {
  goldBar(ctx, -30, 50, 64, 30);
  goldBar(ctx, 34, 50, 64, 30);
  goldBar(ctx, 2, 12, 64, 30);
  sparkle(ctx, 40, -30, 13);
  sparkle(ctx, -40, -18, 9);
  sparkle(ctx, 14, -44, 7);
}

function artSoap(ctx: Ctx): void {
  bill(ctx, 0, 12, 92, 46, -0.18);
  // soap bar
  ctx.save();
  ctx.translate(-34, 44);
  ctx.rotate(0.2);
  rrect(ctx, -22, -12, 44, 24, 9, "#FF8BD1", 4);
  shine(ctx, -8, -5, 10, 3, 0, 0.7);
  ctx.restore();
  const bubbles: [number, number, number][] = [
    [-30, -32, 19],
    [18, -40, 25],
    [46, -4, 14],
    [-50, 6, 11],
    [8, -6, 10],
    [38, 34, 16],
    [-10, 46, 9],
  ];
  for (const [x, y, r] of bubbles) {
    const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
    g.addColorStop(0, "rgba(255,255,255,0.25)");
    g.addColorStop(0.75, "rgba(190,232,255,0.45)");
    g.addColorStop(1, "rgba(160,200,255,0.85)");
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    fill(ctx, g, 3);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = Math.max(2, r * 0.14);
    ctx.beginPath();
    ctx.arc(x, y, r * 0.66, Math.PI * 1.1, Math.PI * 1.45);
    ctx.stroke();
  }
}

function artGrab(ctx: Ctx): void {
  // the loot
  bill(ctx, -10, 32, 84, 40, -0.12);
  bill(ctx, -16, 24, 84, 40, -0.05);
  // pinstripe sleeve coming in from the top right
  ctx.save();
  ctx.translate(44, -44);
  ctx.rotate(0.78);
  rrect(ctx, -22, -50, 44, 62, 6, "#2E2836", 5);
  ctx.strokeStyle = "rgba(255,244,223,0.55)";
  ctx.lineWidth = 2;
  for (const x of [-12, 0, 12]) {
    ctx.beginPath();
    ctx.moveTo(x, -46);
    ctx.lineTo(x, 8);
    ctx.stroke();
  }
  rrect(ctx, -24, 4, 48, 14, 4, "#FFFFFF", 4);
  rrect(ctx, -6, 6, 12, 10, 3, GOLD, 2);
  ctx.restore();
  // white cartoon glove: palm + four curled fingers over the bills + thumb
  ctx.save();
  ctx.translate(8, 0);
  ctx.rotate(0.15);
  const glove = "#FFFFFF";
  ctx.beginPath();
  ctx.ellipse(10, -10, 30, 25, 0.6, 0, Math.PI * 2);
  fill(ctx, glove, 5);
  for (let k = 0; k < 4; k++) {
    ctx.save();
    ctx.translate(-22 + k * 13, 8 + k * 4);
    ctx.rotate(0.35);
    rrect(ctx, -7, -16, 14, 34, 7, glove, 4);
    ctx.restore();
  }
  ctx.save();
  ctx.translate(36, 6);
  ctx.rotate(-0.4);
  rrect(ctx, -7, -6, 14, 30, 7, glove, 4);
  ctx.restore();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  for (const dx of [-4, 6, 16]) {
    ctx.beginPath();
    ctx.moveTo(dx, -26);
    ctx.lineTo(dx + 6, -14);
    ctx.stroke();
  }
  ctx.restore();
  // motion swoosh
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const [x, y] of [
    [-54, -30],
    [-46, -46],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x!, y!);
    ctx.lineTo(x! + 16, y! + 10);
    ctx.stroke();
  }
}

function artTopHat(ctx: Ctx): void {
  // coins dropping in
  coin(ctx, -22, -52, 13);
  coin(ctx, 18, -60, 11);
  coin(ctx, 36, -36, 10, false);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  for (const [x, y] of [
    [-22, -74],
    [18, -78],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x!, y!);
    ctx.lineTo(x!, y! + 6);
    ctx.stroke();
  }
  // upside-down top hat: crown below, brim on top
  const crown = vgrad(ctx, -12, 54, [
    [0, "#4A4152"],
    [1, "#1E1A24"],
  ]);
  ctx.beginPath();
  ctx.moveTo(-40, -12);
  ctx.lineTo(40, -12);
  ctx.lineTo(34, 46);
  ctx.ellipse(0, 46, 34, 10, 0, 0, Math.PI);
  ctx.lineTo(-40, -12);
  fill(ctx, crown, 5);
  // red band near the brim
  ctx.beginPath();
  ctx.moveTo(-39, -2);
  ctx.lineTo(39, -2);
  ctx.lineTo(38, 10);
  ctx.lineTo(-38, 10);
  ctx.closePath();
  fill(ctx, "#E5383B", 3);
  // brim + opening
  ctx.beginPath();
  ctx.ellipse(0, -14, 58, 15, 0, 0, Math.PI * 2);
  fill(ctx, "#2E2836", 5);
  ctx.beginPath();
  ctx.ellipse(0, -15, 40, 9, 0, 0, Math.PI * 2);
  fill(ctx, "#0D0B10", 3);
  bill(ctx, 8, -24, 34, 20, 0.5);
  shine(ctx, -24, 24, 4, 14, 0, 0.25);
}

function artTrap(ctx: Ctx): void {
  // wooden base in 3/4 view
  poly(ctx, [-58, 18, 34, 18, 34, 34, -58, 34], "#B97836", 5);
  poly(ctx, [34, 18, 58, -10, 58, 6, 34, 34], "#8E5A2C", 5);
  poly(ctx, [-58, 18, 34, 18, 58, -10, -34, -10], "#E3AA66", 5);
  ctx.strokeStyle = "rgba(142,90,44,0.6)";
  ctx.lineWidth = 2;
  for (const t of [0.3, 0.6]) {
    ctx.beginPath();
    ctx.moveTo(-58 + t * 24, 18 - t * 28);
    ctx.lineTo(34 + t * 24, 18 - t * 28);
    ctx.stroke();
  }
  // cheese
  poly(ctx, [18, 4, 46, -4, 44, -24, 18, -12], "#FFD24A", 4);
  ctx.fillStyle = "#E0A21C";
  for (const [x, y, r] of [
    [30, -8, 3.5],
    [38, -16, 2.5],
    [24, -2, 2],
  ]) {
    ctx.beginPath();
    ctx.arc(x!, y!, r!, 0, Math.PI * 2);
    ctx.fill();
  }
  // spring coil + the raised snap bar
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const bar = () => {
    ctx.beginPath();
    ctx.moveTo(-26, 8);
    ctx.lineTo(-34, -44);
    ctx.lineTo(10, -54);
    ctx.lineTo(16, -6);
  };
  ctx.strokeStyle = INK;
  ctx.lineWidth = 12;
  bar();
  ctx.stroke();
  ctx.strokeStyle = "#D8DEE6";
  ctx.lineWidth = 6;
  bar();
  ctx.stroke();
  for (let k = 0; k < 3; k++) circle(ctx, -24 + k * 7, 6, 6, "#AEB7C2", 3);
  // danger marks
  ctx.strokeStyle = "#E5383B";
  ctx.lineWidth = 4;
  for (const [x, y, a] of [
    [-48, -40, -0.6],
    [-52, -20, 0],
    [28, -56, 0.6],
  ]) {
    ctx.beginPath();
    ctx.moveTo(x!, y!);
    ctx.lineTo(x! + Math.cos(a! + Math.PI) * 10, y! + Math.sin(a! + Math.PI) * 10);
    ctx.stroke();
  }
}

function artNazar(ctx: Ctx): void {
  // purple curse swirls
  ctx.strokeStyle = "#B05CFF";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  for (let k = 0; k < 3; k++) {
    const a0 = (k / 3) * Math.PI * 2 + 0.4;
    ctx.beginPath();
    for (let t = 0; t < 1; t += 0.05) {
      const a = a0 + t * 2.2;
      const r = 54 + t * 8 + Math.sin(t * 12) * 3;
      const x = Math.cos(a) * r;
      const y = Math.sin(a) * r;
      if (t === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  // string
  ctx.strokeStyle = "#C2860C";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(0, -46);
  ctx.quadraticCurveTo(-10, -66, 0, -70);
  ctx.quadraticCurveTo(10, -66, 0, -46);
  ctx.stroke();
  drawNazar(ctx, 0, 0, 48);
  sparkle(ctx, 44, -40, 9, "#E0B8FF");
  sparkle(ctx, -46, 40, 7, "#E0B8FF");
}

function arrowArc(ctx: Ctx, r: number, a0: number, a1: number, color: string): void {
  const draw = () => {
    ctx.beginPath();
    ctx.arc(0, 0, r, a0, a1, a1 < a0);
  };
  ctx.lineCap = "butt";
  ctx.strokeStyle = INK;
  ctx.lineWidth = 22;
  draw();
  ctx.stroke();
  ctx.strokeStyle = color;
  ctx.lineWidth = 13;
  draw();
  ctx.stroke();
  // arrow head at a1, pointing along the travel direction
  const dir = a1 > a0 ? 1 : -1;
  const ex = Math.cos(a1) * r;
  const ey = Math.sin(a1) * r;
  const tx = -Math.sin(a1) * dir;
  const ty = Math.cos(a1) * dir;
  const nx = Math.cos(a1);
  const ny = Math.sin(a1);
  poly(ctx, [ex + nx * 20, ey + ny * 20, ex + tx * 24, ey + ty * 24, ex - nx * 20, ey - ny * 20], color, 5);
}

function artSwap(ctx: Ctx): void {
  arrowArc(ctx, 44, Math.PI * 1.08, Math.PI * 1.85, GOLD);
  arrowArc(ctx, 44, Math.PI * 0.08, Math.PI * 0.85, "#FF3C8E");
  coin(ctx, -16, 0, 15);
  ctx.save();
  ctx.translate(16, 0);
  rrect(ctx, -14, -14, 28, 28, 5, "#7E8796", 4);
  circle(ctx, 0, 0, 6, "#C7D0DA", 3);
  ctx.restore();
}

function artScales(ctx: Ctx): void {
  const gold = vgrad(ctx, -60, 60, [
    [0, "#FFE680"],
    [1, "#D18E0A"],
  ]);
  // base + pole
  poly(ctx, [-30, 54, 30, 54, 18, 42, -18, 42], gold, 4);
  rrect(ctx, -5, -46, 10, 92, 3, gold, 4);
  circle(ctx, 0, -52, 8, gold, 4);
  // tilted beam
  ctx.save();
  ctx.translate(0, -38);
  ctx.rotate(-0.12);
  rrect(ctx, -56, -4, 112, 8, 4, gold, 4);
  ctx.restore();
  const ends: [number, number][] = [
    [-52, -32],
    [52, -45],
  ];
  const pans: [number, number][] = [
    [-46, 14],
    [46, 0],
  ];
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  for (let k = 0; k < 2; k++) {
    const [ex, ey] = ends[k]!;
    const [px, py] = pans[k]!;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(px - 20, py);
    ctx.moveTo(ex, ey);
    ctx.lineTo(px + 20, py);
    ctx.stroke();
  }
  // coins weigh down the left pan, a paper scroll on the right
  coin(ctx, -52, 4, 9, false);
  coin(ctx, -40, 6, 9, false);
  ctx.save();
  ctx.translate(46, -6);
  ctx.rotate(-0.2);
  rrect(ctx, -14, -6, 28, 12, 5, "#FFFDF6", 3);
  ctx.restore();
  for (const [px, py] of pans) {
    ctx.beginPath();
    ctx.ellipse(px, py, 24, 10, 0, 0, Math.PI);
    ctx.closePath();
    fill(ctx, gold, 4);
  }
}

function artEnvelope(ctx: Ctx): void {
  ctx.save();
  ctx.rotate(-0.12);
  poly(ctx, [-56, -20, 56, -20, 0, -62], "#E9DCC0", 5);
  bill(ctx, -14, -26, 60, 30, -0.25);
  bill(ctx, 14, -30, 60, 30, 0.2);
  rrect(ctx, -58, -22, 116, 66, 6, "#FFFDF6", 5);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(-56, 42);
  ctx.lineTo(0, 8);
  ctx.lineTo(56, 42);
  ctx.stroke();
  // wax seal
  ctx.beginPath();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    const r = k % 2 ? 13 : 16;
    if (k === 0) ctx.moveTo(Math.cos(a) * r, 8 + Math.sin(a) * r);
    else ctx.lineTo(Math.cos(a) * r, 8 + Math.sin(a) * r);
  }
  ctx.closePath();
  fill(ctx, "#C0262D", 3);
  text(ctx, "$", 0, 9, 16, "#FFD0D0");
  ctx.restore();
  sparkle(ctx, 50, -48, 8);
}

function artWheel(ctx: Ctx): void {
  // stand
  poly(ctx, [-10, 30, 10, 30, 26, 62, -26, 62], "#5A3524", 4);
  const n = WHEEL_SLICES.length;
  const R = 50;
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.arc(0, 0, R, a - Math.PI / n, a + Math.PI / n);
    ctx.closePath();
    ctx.fillStyle = WHEEL_SLICES[i]!.color;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  ctx.lineWidth = 9;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(0, 0, R + 3, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 6;
  ctx.strokeStyle = GOLD;
  ctx.stroke();
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2;
    circle(ctx, Math.cos(a) * (R + 3), Math.sin(a) * (R + 3), 3, "#FFF6C8", 1.5);
  }
  circle(ctx, 0, 0, 10, GOLD, 4);
  poly(ctx, [-9, -64, 9, -64, 0, -46], "#E5383B", 4);
}

function artRaid(ctx: Ctx): void {
  // light rays
  ctx.lineCap = "round";
  for (let k = 0; k < 9; k++) {
    const a = Math.PI + (k / 8) * Math.PI;
    ctx.strokeStyle = k < 4 ? "#FF6B6E" : k > 4 ? "#6FA0FF" : "#FFF4DF";
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(Math.cos(a) * 40, -30 + Math.sin(a) * 40);
    ctx.lineTo(Math.cos(a) * 58, -30 + Math.sin(a) * 58);
    ctx.stroke();
  }
  // siren dome: red | blue
  ctx.beginPath();
  ctx.arc(0, -30, 30, Math.PI, Math.PI * 1.5);
  ctx.lineTo(0, -30);
  ctx.closePath();
  fill(ctx, "#FF3B3E", 0);
  ctx.beginPath();
  ctx.arc(0, -30, 30, Math.PI * 1.5, Math.PI * 2);
  ctx.lineTo(0, -30);
  ctx.closePath();
  fill(ctx, "#2F6BFF", 0);
  ctx.beginPath();
  ctx.arc(0, -30, 30, Math.PI, 0);
  ctx.closePath();
  ctx.lineWidth = 5;
  ctx.strokeStyle = INK;
  ctx.stroke();
  shine(ctx, -12, -44, 8, 4, -0.5, 0.8);
  rrect(ctx, -38, -32, 76, 12, 3, "#3A3340", 4);
  // gold star badge
  const g = ctx.createRadialGradient(-8, 18, 4, 0, 28, 40);
  g.addColorStop(0, "#FFF0A8");
  g.addColorStop(1, "#D99A12");
  ctx.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k / 10) * Math.PI * 2;
    const r = k % 2 ? 17 : 38;
    const x = Math.cos(a) * r;
    const y = 30 + Math.sin(a) * r;
    if (k === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  fill(ctx, g, 5);
  circle(ctx, 0, 30, 13, "#2F6BFF", 3);
  sparkle(ctx, 0, 30, 7, "#FFFFFF");
  // ribbon
  rrect(ctx, -32, 48, 64, 16, 4, "#241F2B", 0);
  text(ctx, "POLİS", 0, 57, 13, GOLD);
}

const ART: Record<CardId, (ctx: Ctx) => void> = {
  bozukluk: artCoins,
  tomar: artRoll,
  canta: artBriefcase,
  kulce: artGoldBars,
  aklama: artSoap,
  harac: artGrab,
  haracTuru: artTopHat,
  tuzak: artTrap,
  lanet: artNazar,
  takas: artSwap,
  avukat: artScales,
  rusvet: artEnvelope,
  cark: artWheel,
  baskin: artRaid,
};

// ----------------------------------------------------------------------------------------- the face

const BORDER: Record<Rarity, [string, string, string]> = {
  common: ["#F0BF8A", RARITIES.common.color, "#8E5A2C"],
  uncommon: ["#FBFDFF", RARITIES.uncommon.color, "#7F8B99"],
  rare: ["#FFF0A8", RARITIES.rare.color, "#C38A08"],
  legendary: ["#F0D2FF", RARITIES.legendary.color, "#5E1CA8"],
  trouble: ["#FF9C9E", RARITIES.trouble.color, "#7E1219"],
};

const PILL: Record<string, string> = {
  money: MONEY,
  multiplier: GOLD,
  attack: "#FF8BD1",
  protection: "#7CC4FF",
  special: "#D6A6FF",
  raid: GOLD,
};

function paintFace(ctx: Ctx, def: CardDef, value: string, cursed: boolean): void {
  const W = CARD_PX_W;
  const H = CARD_PX_H;
  const raid = def.kind === "raid";
  const [hi, mid, lo] = BORDER[def.rarity];
  ctx.clearRect(0, 0, W, H);

  // ink outline + metallic rarity border
  rrect(ctx, 2, 2, W - 4, H - 4, 24, INK, 0);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, hi);
  bg.addColorStop(0.3, mid);
  bg.addColorStop(0.55, lo);
  bg.addColorStop(0.75, mid);
  bg.addColorStop(1, hi);
  rrect(ctx, 7, 7, W - 14, H - 14, 20, bg, 0);
  if (def.rarity === "legendary") {
    const pink = ctx.createLinearGradient(W, 0, 0, H);
    pink.addColorStop(0, "rgba(255,60,142,0.55)");
    pink.addColorStop(0.5, "rgba(255,60,142,0)");
    pink.addColorStop(1, "rgba(80,200,255,0.45)");
    rrect(ctx, 7, 7, W - 14, H - 14, 20, pink, 0);
  }

  // card stock
  const inner = raid ? "#5E0B12" : CREAM;
  rrect(ctx, 17, 17, W - 34, H - 34, 13, inner, 3);
  if (raid) {
    // hazard stripes along the bottom
    ctx.save();
    roundRectPath(ctx, 19, H - 66, W - 38, 47, 11);
    ctx.clip();
    ctx.fillStyle = "#1A1418";
    ctx.fillRect(0, H - 70, W, 60);
    ctx.fillStyle = GOLD;
    for (let x = -40; x < W + 40; x += 28) {
      ctx.beginPath();
      ctx.moveTo(x, H - 18);
      ctx.lineTo(x + 14, H - 18);
      ctx.lineTo(x + 44, H - 70);
      ctx.lineTo(x + 30, H - 70);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  } else {
    // paper speckle
    ctx.fillStyle = "rgba(201,135,75,0.12)";
    for (let k = 0; k < 40; k++) {
      const x = 24 + ((k * 73) % (W - 48));
      const y = 24 + ((k * 151) % (H - 48));
      ctx.fillRect(x, y, 2, 2);
    }
  }

  // corner gems
  for (const [x, y] of [
    [30, 98],
    [W - 30, 98],
  ]) {
    poly(ctx, [x!, y! - 7, x! + 6, y!, x!, y! + 7, x! - 6, y!], mid, 2);
  }

  // name band
  const name = upperTr(def.name);
  rrect(ctx, 22, 24, W - 44, 58, 10, raid ? "#120E14" : INK, 0);
  ctx.fillStyle = mid;
  ctx.fillRect(30, 28, W - 60, 3);
  ctx.fillRect(30, 75, W - 60, 3);
  const nameColor = raid ? GOLD : CREAM;
  let px = fitPx(ctx, name, W - 64, 30, 22);
  if (ctx.measureText(name).width > W - 64 && name.includes(" ")) {
    const words = name.split(" ");
    const half = Math.ceil(words.length / 2);
    const l1 = words.slice(0, half).join(" ");
    const l2 = words.slice(half).join(" ");
    px = Math.min(fitPx(ctx, l1, W - 64, 22, 12), fitPx(ctx, l2, W - 64, 22, 12));
    text(ctx, l1, W / 2, 43, px, nameColor);
    text(ctx, l2, W / 2, 64, px, nameColor);
  } else {
    text(ctx, name, W / 2, 54, fitPx(ctx, name, W - 64, 30, 12), nameColor);
  }

  // art medallion
  const cx = W / 2;
  const cy = 164;
  const halo = ctx.createRadialGradient(cx, cy - 10, 8, cx, cy, 76);
  if (raid) {
    halo.addColorStop(0, "#9E1B26");
    halo.addColorStop(1, "#3A060C");
  } else {
    halo.addColorStop(0, shade(mid, 0.82));
    halo.addColorStop(1, shade(mid, 0.38));
  }
  circle(ctx, cx, cy, 74, halo, 4);
  ctx.save();
  ctx.translate(cx, cy + 2);
  ART[def.id](ctx);
  ctx.restore();

  // value pill
  const pillPx = fitPx(ctx, value, W - 84, 30, 16);
  ctx.font = `700 ${pillPx}px ${FONT}`;
  const pw = Math.min(W - 48, ctx.measureText(value).width + 36);
  const ph = 44;
  const pxl = (W - pw) / 2;
  const py = 248;
  rrect(ctx, pxl, py, pw, ph, ph / 2, PILL[def.kind] ?? GOLD, 4);
  shine(ctx, pxl + 18, py + 11, 9, 4, -0.2, 0.55);
  text(ctx, value, W / 2, py + ph / 2 + 1, pillPx, INK);

  // rule line
  const descColor = raid ? CREAM : "rgba(36,31,43,0.82)";
  ctx.font = `600 16px ${FONT}`;
  const lines = wrap(ctx, def.desc, W - 52).slice(0, 2);
  const lineY = raid ? [H - 54, H - 36] : lines.length === 1 ? [318] : [309, 328];
  for (let k = 0; k < lines.length; k++) {
    if (raid) text(ctx, lines[k]!, W / 2, lineY[k]!, 15, CREAM, 700, 5, "#120E14");
    else text(ctx, lines[k]!, W / 2, lineY[k]!, 16, descColor, 600);
  }

  if (cursed) {
    // the curse ate the money: value crossed out, "0$" stamped
    ctx.lineCap = "round";
    ctx.strokeStyle = INK;
    ctx.lineWidth = 11;
    ctx.beginPath();
    ctx.moveTo(pxl - 6, py + ph - 6);
    ctx.lineTo(pxl + pw + 6, py + 6);
    ctx.stroke();
    ctx.strokeStyle = "#E5383B";
    ctx.lineWidth = 6;
    ctx.stroke();
    ctx.save();
    ctx.translate(W - 62, 216);
    ctx.rotate(-0.28);
    ctx.globalAlpha = 0.92;
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#E5383B";
    ctx.beginPath();
    ctx.arc(0, 0, 30, 0, Math.PI * 2);
    ctx.stroke();
    text(ctx, "0$", 0, 2, 28, "#E5383B");
    ctx.restore();
  }
}

function paintBack(ctx: Ctx): void {
  const W = CARD_PX_W;
  const H = CARD_PX_H;
  ctx.clearRect(0, 0, W, H);
  rrect(ctx, 2, 2, W - 4, H - 4, 24, INK, 0);
  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, "#9A1B2C");
  bg.addColorStop(1, "#5E0C18");
  rrect(ctx, 8, 8, W - 16, H - 16, 19, bg, 0);
  // diamond lattice
  ctx.save();
  roundRectPath(ctx, 22, 22, W - 44, H - 44, 12);
  ctx.clip();
  ctx.strokeStyle = "rgba(255,201,60,0.22)";
  ctx.lineWidth = 2;
  for (let k = -H; k < W + H; k += 22) {
    ctx.beginPath();
    ctx.moveTo(k, 0);
    ctx.lineTo(k + H, H);
    ctx.moveTo(k, H);
    ctx.lineTo(k + H, 0);
    ctx.stroke();
  }
  ctx.restore();
  ctx.strokeStyle = GOLD;
  ctx.lineWidth = 4;
  roundRectPath(ctx, 20, 20, W - 40, H - 40, 12);
  ctx.stroke();
  ctx.lineWidth = 1.5;
  roundRectPath(ctx, 28, 28, W - 56, H - 56, 9);
  ctx.stroke();
  // monogram medallion
  const g = ctx.createRadialGradient(W / 2 - 14, H / 2 - 16, 6, W / 2, H / 2, 60);
  g.addColorStop(0, "#FFF0A8");
  g.addColorStop(0.6, GOLD);
  g.addColorStop(1, "#C38A08");
  circle(ctx, W / 2, H / 2, 58, g, 5);
  circle(ctx, W / 2, H / 2, 46, "#7A1424", 3);
  text(ctx, "K", W / 2, H / 2 + 4, 66, GOLD, 700, 8, INK);
  for (const [x, y] of [
    [44, 46],
    [W - 44, 46],
    [44, H - 46],
    [W - 44, H - 46],
  ]) {
    text(ctx, "$", x!, y!, 22, GOLD, 700, 4, INK);
  }
  text(ctx, "KASALA!", W / 2, H / 2 + 86, 20, GOLD, 700, 5, INK);
}

// ------------------------------------------------------------------------------------- texture cache

interface Entry {
  tex: THREE.CanvasTexture;
  paint: (ctx: Ctx) => void;
}

const entries = new Map<string, Entry>();
let fontsHooked = false;

function paintScaled(ctx: Ctx, paint: (ctx: Ctx) => void): void {
  ctx.setTransform(TEX_SCALE, 0, 0, TEX_SCALE, 0, 0);
  paint(ctx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
}

function makeTexture(key: string, paint: (ctx: Ctx) => void): THREE.CanvasTexture {
  const hit = entries.get(key);
  if (hit) return hit.tex;
  const canvas = document.createElement("canvas");
  canvas.width = CARD_PX_W * TEX_SCALE;
  canvas.height = CARD_PX_H * TEX_SCALE;
  const ctx = canvas.getContext("2d")!;
  paintScaled(ctx, paint);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  entries.set(key, { tex, paint });
  if (!fontsHooked) {
    fontsHooked = true;
    void fontsReady().then(() => {
      for (const e of entries.values()) {
        const c = (e.tex.image as HTMLCanvasElement).getContext("2d")!;
        paintScaled(c, e.paint);
        e.tex.needsUpdate = true;
      }
    });
  }
  return tex;
}

/** Every card texture painted so far (Cards uploads them to the GPU ahead of the first flip). */
export function cardTextures(): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  for (const e of entries.values()) out.push(e.tex);
  return out;
}

/** Cached face texture for a card with its value line (and the cursed variant). */
export function faceTexture(id: CardId, value: string, cursed = false): THREE.CanvasTexture {
  const def = CARD_BY_ID[id];
  return makeTexture(`face|${id}|${value}|${cursed ? 1 : 0}`, (ctx) => paintFace(ctx, def, value, cursed));
}

export function backTexture(): THREE.CanvasTexture {
  return makeTexture("back", paintBack);
}

/** Paint every card face up front (no hitch on the first flip). */
export function warmCardTextures(): void {
  backTexture();
  for (const id of Object.keys(CARD_BY_ID) as CardId[]) {
    const def = CARD_BY_ID[id];
    faceTexture(id, valueText(id, 0));
    if (def.kind !== "money") continue;
    // a Lanet turns a money card into its crossed-out variant
    faceTexture(id, valueText(id, 0), true);
    // SON MASA pays money cards ×FINAL_TABLE_MULT (CardMsg.value), a value line of its own
    faceTexture(id, valueText(id, def.value * FINAL_TABLE_MULT));
  }
}

/** Thin striped card edges for the side of the deck tower. */
export function deckEdgeTexture(): THREE.CanvasTexture {
  return makeTexture("deckEdge", (ctx) => {
    ctx.fillStyle = "#EFE2C6";
    ctx.fillRect(0, 0, CARD_PX_W, CARD_PX_H);
    for (let y = 0; y < CARD_PX_H; y += 9) {
      ctx.fillStyle = (y / 9) % 3 === 0 ? "#7A1424" : "rgba(36,31,43,0.35)";
      ctx.fillRect(0, y, CARD_PX_W, 2);
    }
  });
}
