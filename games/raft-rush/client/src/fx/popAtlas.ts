// Dynamic hand-lettered comic word atlas for pop text. Owner: client-fx-audio.
// Adapted from games/bonk-brawl/client/src/fx/popAtlas.ts: Bonk baked a fixed word list into a packed atlas;
// Raft Rush pops arbitrary translated text ("BONK!", "+2", "ÇAT!", "YAKALADIN!"), so words are painted on demand
// into 16 slots of a 1024×1024 canvas (fill gradient, thick ink outline, drop shadow, glossy highlight, per-letter
// jitter — colors baked per style) and recycled least-recently-used. The comic starburst lives in its own
// small texture (tinted per pop).

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";

export const POP_ATLAS_SIZE = 1024;
const SLOT_W = 512;
const SLOT_H = 128;
const COLS = POP_ATLAS_SIZE / SLOT_W;
const ROWS = POP_ATLAS_SIZE / SLOT_H;
export const POP_SLOTS = COLS * ROWS;
const FONT_PX = 92;
const MIN_FONT_PX = 40;
const FONT_STACK = `Fredoka, "Baloo 2", "Arial Rounded MT Bold", "Trebuchet MS", sans-serif`;
const INK_WIDTH = 18;
const SHADOW_X = 4;
const SHADOW_Y = 7;
const PAD = 22;
const BURST_PX = 256;

/** Baked colors of a word style. */
export interface WordColors {
  /** Gradient top → bottom of the letter fill. */
  top: string;
  bottom: string;
}

/** One painted word: where it lives in the atlas. */
export interface PopGlyph {
  readonly key: string;
  /** UV rect for billboard.ts (u, v, du, dv). */
  readonly uv: THREE.Vector4;
  /** Painted width / height of the word itself (the quad shows only the used part of the slot). */
  aspect: number;
  slot: number;
}

interface Slot {
  key: string;
  refs: number;
  stamp: number;
  glyph: PopGlyph | null;
  text: string;
  colors: WordColors;
}

/** Letters of a string as grapheme clusters (keeps "İ", emoji and combining marks whole). */
export function graphemes(text: string): string[] {
  const Seg = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(s: string): Iterable<{ segment: string }> } }).Segmenter;
  if (Seg) return Array.from(new Seg(undefined, { granularity: "grapheme" }).segment(text), (s) => s.segment);
  return Array.from(text);
}

/** Per-letter jitter so words look hand-lettered (deterministic per word). */
export function letterJitter(seed: number, i: number): { rot: number; dy: number; scale: number } {
  const a = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  const b = Math.sin(seed * 39.3468 + i * 11.135) * 24634.6345;
  const r1 = a - Math.floor(a);
  const r2 = b - Math.floor(b);
  return {
    rot: (r1 - 0.5) * 0.2,
    dy: Math.sin(i * 1.7 + seed) * 5,
    scale: i === 0 ? 1.1 : 0.96 + r2 * 0.08,
  };
}

function seedFor(text: string): number {
  let h = 7;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 1000;
  return h / 10;
}

function font(px: number): string {
  return `700 ${px}px ${FONT_STACK}`;
}

export class PopWordAtlas {
  readonly texture: THREE.CanvasTexture;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly slots: Slot[] = [];
  private readonly byKey = new Map<string, number>();
  private clock = 0;

  constructor() {
    this.canvas = document.createElement("canvas");
    this.canvas.width = POP_ATLAS_SIZE;
    this.canvas.height = POP_ATLAS_SIZE;
    const ctx = this.canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    this.ctx = ctx;
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.anisotropy = 4;
    this.texture.generateMipmaps = true;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    for (let i = 0; i < POP_SLOTS; i++) this.slots.push({ key: "", refs: 0, stamp: -1, glyph: null, text: "", colors: { top: "#fff", bottom: "#fff" } });
    requestFont(() => this.repaintAll());
  }

  /** The glyph for `text` in `colors` (painted now if needed). Call release() when the pop ends. */
  acquire(text: string, colors: WordColors): PopGlyph {
    const key = `${colors.top}|${colors.bottom}|${text}`;
    const hit = this.byKey.get(key);
    if (hit !== undefined) {
      const slot = this.slots[hit]!;
      slot.refs++;
      slot.stamp = ++this.clock;
      return slot.glyph!;
    }
    const index = this.victim();
    const slot = this.slots[index]!;
    if (slot.key) this.byKey.delete(slot.key);
    slot.key = key;
    slot.text = text;
    slot.colors = colors;
    slot.refs = 1;
    slot.stamp = ++this.clock;
    const glyph: PopGlyph = slot.glyph ?? { key, uv: new THREE.Vector4(), aspect: 1, slot: index };
    (glyph as { key: string }).key = key;
    slot.glyph = glyph;
    this.paintSlot(index);
    this.byKey.set(key, index);
    this.texture.needsUpdate = true;
    return glyph;
  }

  release(glyph: PopGlyph): void {
    const slot = this.slots[glyph.slot];
    if (slot && slot.key === glyph.key && slot.refs > 0) slot.refs--;
  }

  dispose(): void {
    this.texture.dispose();
  }

  /** A free slot (unused, oldest first), else the least recently used one. */
  private victim(): number {
    let best = -1;
    let bestStamp = Infinity;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.refs === 0 && s.stamp < bestStamp) {
        best = i;
        bestStamp = s.stamp;
      }
    }
    if (best >= 0) return best;
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i]!;
      if (s.stamp < bestStamp) {
        best = i;
        bestStamp = s.stamp;
      }
    }
    return Math.max(0, best);
  }

  private repaintAll(): void {
    let painted = false;
    for (let i = 0; i < this.slots.length; i++) {
      if (!this.slots[i]!.key) continue;
      this.paintSlot(i);
      painted = true;
    }
    if (painted) this.texture.needsUpdate = true;
  }

  private paintSlot(index: number): void {
    const slot = this.slots[index]!;
    const ctx = this.ctx;
    const x0 = (index % COLS) * SLOT_W;
    const y0 = Math.floor(index / COLS) * SLOT_H;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x0, y0, SLOT_W, SLOT_H);
    ctx.clip();
    ctx.clearRect(x0, y0, SLOT_W, SLOT_H);
    const letters = graphemes(slot.text);
    let px = FONT_PX;
    let width = this.measure(letters, px);
    const maxWidth = SLOT_W - PAD * 2;
    if (width > maxWidth) {
      px = Math.max(MIN_FONT_PX, Math.floor((px * maxWidth) / width));
      width = this.measure(letters, px);
    }
    const squeeze = width > maxWidth ? maxWidth / width : 1;
    const used = Math.min(SLOT_W, Math.ceil(width * squeeze) + PAD * 2);
    const cx = x0 + used / 2;
    const cy = y0 + SLOT_H / 2;
    const seed = seedFor(slot.text);
    const each = (draw: (ch: string) => void): void => {
      ctx.font = font(px);
      ctx.textBaseline = "middle";
      ctx.textAlign = "center";
      let cursor = cx - (width * squeeze) / 2;
      letters.forEach((ch, i) => {
        const w = ctx.measureText(ch).width * 1.04 * squeeze;
        const j = letterJitter(seed, i);
        ctx.save();
        ctx.translate(cursor + w / 2, cy + j.dy + px * 0.04);
        ctx.rotate(j.rot);
        ctx.scale(j.scale * squeeze, j.scale);
        draw(ch);
        ctx.restore();
        cursor += w;
      });
    };
    // Drop shadow + thick ink outline.
    ctx.lineJoin = "round";
    each((ch) => {
      ctx.lineWidth = INK_WIDTH;
      ctx.strokeStyle = PALETTE.ink;
      ctx.fillStyle = PALETTE.ink;
      ctx.strokeText(ch, SHADOW_X, SHADOW_Y);
      ctx.fillText(ch, SHADOW_X, SHADOW_Y);
      ctx.strokeText(ch, 0, 0);
    });
    // Fill: top-lit gradient in the style's colors.
    each((ch) => {
      const grad = ctx.createLinearGradient(0, -px * 0.45, 0, px * 0.45);
      grad.addColorStop(0, slot.colors.top);
      grad.addColorStop(1, slot.colors.bottom);
      ctx.fillStyle = grad;
      ctx.fillText(ch, 0, 0);
    });
    // Gloss: a light crescent on the upper part of each letter.
    each((ch) => {
      ctx.save();
      ctx.beginPath();
      ctx.rect(-px, -px, px * 2, px * 0.62);
      ctx.clip();
      ctx.globalAlpha = 0.35;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillText(ch, 0, 0);
      ctx.restore();
    });
    ctx.restore();
    const glyph = slot.glyph!;
    const s = POP_ATLAS_SIZE;
    // CanvasTexture uploads with flipY: canvas-top rows have high v.
    glyph.uv.set(x0 / s, 1 - (y0 + SLOT_H) / s, used / s, SLOT_H / s);
    glyph.aspect = used / SLOT_H;
    glyph.slot = index;
  }

  private measure(letters: ReadonlyArray<string>, px: number): number {
    this.ctx.font = font(px);
    let w = 0;
    for (const ch of letters) w += this.ctx.measureText(ch).width * 1.04;
    return w;
  }
}

let fontRequested = false;
const fontListeners: Array<() => void> = [];

function requestFont(onLoad: () => void): void {
  fontListeners.push(onLoad);
  if (fontRequested || typeof document === "undefined" || !document.fonts) return;
  fontRequested = true;
  document.fonts
    .load(`700 ${FONT_PX}px Fredoka`)
    .then((faces) => {
      if (faces.length > 0) for (const fn of fontListeners) fn();
    })
    .catch(() => {
      // Offline or blocked: the fallback rounded font stays.
    });
}

let burst: THREE.CanvasTexture | null = null;

/** 256×256 spiky comic starburst (white fill + ink outline), tinted per pop. */
export function burstTexture(): THREE.CanvasTexture {
  if (burst) return burst;
  const canvas = document.createElement("canvas");
  canvas.width = BURST_PX;
  canvas.height = BURST_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const c = BURST_PX / 2;
  const spikes = 13;
  const outer = c - 14;
  ctx.beginPath();
  for (let i = 0; i < spikes * 2; i++) {
    const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
    const wobble = 0.9 + 0.1 * Math.sin(i * 2.3);
    const r = i % 2 === 0 ? outer * wobble : outer * 0.62;
    const x = c + Math.cos(a) * r;
    const y = c + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  const grad = ctx.createRadialGradient(c, c, outer * 0.1, c, c, outer);
  grad.addColorStop(0, "#FFFFFF");
  grad.addColorStop(1, "#D2D2D2");
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.lineJoin = "round";
  ctx.lineWidth = 12;
  ctx.strokeStyle = PALETTE.ink;
  ctx.stroke();
  burst = new THREE.CanvasTexture(canvas);
  burst.colorSpace = THREE.SRGBColorSpace;
  burst.anisotropy = 4;
  return burst;
}
