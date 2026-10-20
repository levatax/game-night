// Hand-lettered comic word atlas for pop text ("BONK!", "CATCH!", "OUT!", "+2", ...). Owner: client-fx.
//
// One 1024×1024 RGBA DataTexture with packed channels so every word can be tinted at runtime
// while keeping a fixed ink outline and a glossy highlight (see billboard.ts "packed" shading):
//   R = fill shade (top-lit gradient), G = fill coverage, B = highlight, A = coverage incl. ink.

import * as THREE from "three";

export const POP_ATLAS_SIZE = 1024;
const FONT_PX = 116;
const POINTS_FONT_PX = 110;
const FONT_STACK = `Fredoka, "Baloo 2", "Arial Rounded MT Bold", "Trebuchet MS", sans-serif`;
const INK_WIDTH = 23;
const SHADOW_X = 5;
const SHADOW_Y = 8;
const PAD = 24;
const BURST_PX = 256;

export type PopGlyphKey =
  | "bonk"
  | "catch"
  | "out"
  | "miss"
  | "boing"
  | "ding"
  | "plus1"
  | "plus2"
  | "plus3"
  | "burst";

const TEXTS: Readonly<Record<Exclude<PopGlyphKey, "burst">, string>> = {
  bonk: "BONK!",
  catch: "CATCH!",
  out: "OUT!",
  miss: "MISS",
  boing: "BOING!",
  ding: "DING!",
  plus1: "+1",
  plus2: "+2",
  plus3: "+3",
};

/** Where a glyph lives in the atlas (pixels, canvas orientation: y down). */
export interface PopGlyph {
  x: number;
  y: number;
  w: number;
  h: number;
  /** UV rect for billboard.ts: (u, vBottom, du, -dv) — the DataTexture's row 0 is the canvas top. */
  uv: THREE.Vector4;
  /** w / h. */
  aspect: number;
}

interface Layers {
  ink: CanvasRenderingContext2D;
  fill: CanvasRenderingContext2D;
  hi: CanvasRenderingContext2D;
}

let texture: THREE.DataTexture | null = null;
const glyphs = new Map<PopGlyphKey, PopGlyph>();
let fontRequested = false;

/** The packed atlas (built on first use, rebuilt once the Fredoka web font finishes loading). */
export function popAtlas(): THREE.DataTexture {
  if (!texture) {
    texture = new THREE.DataTexture(new Uint8Array(POP_ATLAS_SIZE * POP_ATLAS_SIZE * 4), POP_ATLAS_SIZE, POP_ATLAS_SIZE);
    texture.colorSpace = THREE.NoColorSpace;
    texture.generateMipmaps = true;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.anisotropy = 4;
    paintAtlas(texture);
    requestFont();
  }
  return texture;
}

export function popGlyph(key: PopGlyphKey): PopGlyph {
  popAtlas();
  const g = glyphs.get(key);
  if (!g) throw new Error(`pop glyph missing: ${key}`);
  return g;
}

function requestFont(): void {
  if (fontRequested || typeof document === "undefined" || !document.fonts) return;
  fontRequested = true;
  document.fonts
    .load(`700 ${FONT_PX}px Fredoka`)
    .then((faces) => {
      if (faces.length > 0 && texture) paintAtlas(texture);
    })
    .catch(() => {
      // Offline or blocked: the fallback rounded font stays.
    });
}

function makeLayer(): CanvasRenderingContext2D {
  const canvas = document.createElement("canvas");
  canvas.width = POP_ATLAS_SIZE;
  canvas.height = POP_ATLAS_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas unavailable");
  return ctx;
}

function paintAtlas(tex: THREE.DataTexture): void {
  const layers: Layers = { ink: makeLayer(), fill: makeLayer(), hi: makeLayer() };
  const items = layoutGlyphs(layers.ink);
  for (const [key, g] of items) {
    if (key === "burst") paintBurst(layers, g);
    else paintWord(layers, g, TEXTS[key], key.startsWith("plus") ? POINTS_FONT_PX : FONT_PX, seedFor(key));
    glyphs.set(key, g);
  }
  combine(layers, tex.image.data as Uint8Array);
  tex.needsUpdate = true;
}

function font(px: number): string {
  return `700 ${px}px ${FONT_STACK}`;
}

/** Per-letter jitter so words look hand-lettered (deterministic per word). */
function letterJitter(seed: number, i: number): { rot: number; dy: number; scale: number } {
  const a = Math.sin(seed * 12.9898 + i * 78.233) * 43758.5453;
  const b = Math.sin(seed * 39.3468 + i * 11.135) * 24634.6345;
  const r1 = a - Math.floor(a);
  const r2 = b - Math.floor(b);
  return {
    rot: (r1 - 0.5) * 0.22,
    dy: Math.sin(i * 1.7 + seed) * 7,
    scale: i === 0 ? 1.12 : 0.96 + r2 * 0.08,
  };
}

function seedFor(key: string): number {
  let h = 7;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) % 1000;
  return h / 10;
}

function measureWord(ctx: CanvasRenderingContext2D, text: string, px: number): number {
  ctx.font = font(px);
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width * 1.04;
  return w;
}

/** First-fit-decreasing shelf packing of every glyph into the atlas. */
function layoutGlyphs(measure: CanvasRenderingContext2D): Array<[PopGlyphKey, PopGlyph]> {
  const sizes: Array<[PopGlyphKey, number, number]> = [];
  for (const key of Object.keys(TEXTS) as Array<Exclude<PopGlyphKey, "burst">>) {
    const px = key.startsWith("plus") ? POINTS_FONT_PX : FONT_PX;
    const w = Math.ceil(measureWord(measure, TEXTS[key], px) * 1.12) + PAD * 2;
    sizes.push([key, Math.min(w, POP_ATLAS_SIZE), Math.ceil(px * 1.18) + PAD * 2]);
  }
  sizes.push(["burst", BURST_PX, BURST_PX]);
  sizes.sort((a, b) => b[1] - a[1]);
  const shelves: Array<{ y: number; used: number; h: number }> = [];
  const placed: Array<[PopGlyphKey, number, number, number, number]> = [];
  for (const [key, w, h] of sizes) {
    let shelf = shelves.find((sh) => sh.used + w <= POP_ATLAS_SIZE);
    if (!shelf) {
      shelf = { y: 0, used: 0, h: 0 };
      shelves.push(shelf);
    }
    placed.push([key, shelf.used, shelves.indexOf(shelf), w, h]);
    shelf.used += w;
    shelf.h = Math.max(shelf.h, h);
  }
  let y = 0;
  for (const sh of shelves) {
    sh.y = y;
    y += sh.h;
  }
  if (y > POP_ATLAS_SIZE) console.warn(`pop atlas overflow: ${y}px`);
  const s = POP_ATLAS_SIZE;
  return placed.map(([key, x, shelfIndex, w, h]): [PopGlyphKey, PopGlyph] => {
    const top = shelves[shelfIndex].y;
    return [key, { x, y: top, w, h, aspect: w / h, uv: new THREE.Vector4(x / s, (top + h) / s, w / s, -h / s) }];
  });
}

function eachLetter(
  ctx: CanvasRenderingContext2D,
  g: PopGlyph,
  text: string,
  px: number,
  seed: number,
  draw: (c: CanvasRenderingContext2D, ch: string) => void,
): void {
  ctx.font = font(px);
  ctx.textBaseline = "middle";
  ctx.textAlign = "center";
  const total = measureWord(ctx, text, px);
  let cursor = g.x + (g.w - total) / 2;
  const cy = g.y + g.h / 2 + px * 0.04;
  let i = 0;
  for (const ch of text) {
    const w = ctx.measureText(ch).width * 1.04;
    const j = letterJitter(seed, i++);
    ctx.save();
    ctx.translate(cursor + w / 2, cy + j.dy);
    ctx.rotate(j.rot);
    ctx.scale(j.scale, j.scale);
    draw(ctx, ch);
    ctx.restore();
    cursor += w;
  }
}

function paintWord(layers: Layers, g: PopGlyph, text: string, px: number, seed: number): void {
  const { ink, fill, hi } = layers;
  // Ink: drop shadow + thick rounded outline.
  ink.lineJoin = "round";
  ink.lineWidth = INK_WIDTH;
  ink.strokeStyle = "#fff";
  ink.fillStyle = "#fff";
  eachLetter(ink, g, text, px, seed, (c, ch) => {
    c.strokeText(ch, SHADOW_X, SHADOW_Y);
    c.fillText(ch, SHADOW_X, SHADOW_Y);
    c.strokeText(ch, 0, 0);
  });
  // Fill: top-lit shade gradient (R channel).
  eachLetter(fill, g, text, px, seed, (c, ch) => {
    const grad = c.createLinearGradient(0, -px * 0.45, 0, px * 0.45);
    grad.addColorStop(0, "rgb(255,255,255)");
    grad.addColorStop(0.55, "rgb(236,236,236)");
    grad.addColorStop(1, "rgb(176,176,176)");
    c.fillStyle = grad;
    c.fillText(ch, 0, 0);
  });
  // Highlight: a glossy crescent along the top edge of each letter.
  eachLetter(hi, g, text, px, seed, (c, ch) => {
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 0.75;
    c.fillStyle = "#fff";
    c.fillText(ch, 0, 0);
    c.globalAlpha = 1;
    c.globalCompositeOperation = "destination-out";
    c.fillText(ch, -px * 0.02, px * 0.075);
    c.globalCompositeOperation = "source-over";
  });
}

/** Spiky comic starburst drawn behind "BONK!" / "CATCH!". */
function paintBurst(layers: Layers, g: PopGlyph): void {
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  const spikes = 13;
  const outer = g.w / 2 - PAD;
  const path = (c: CanvasRenderingContext2D, grow: number): void => {
    c.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const a = (i / (spikes * 2)) * Math.PI * 2 - Math.PI / 2;
      const wobble = 0.9 + 0.1 * Math.sin(i * 2.3);
      const r = (i % 2 === 0 ? outer * wobble : outer * 0.62) + grow;
      const x = cx + Math.cos(a) * r;
      const y = cy + Math.sin(a) * r;
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.closePath();
  };
  const { ink, fill } = layers;
  ink.fillStyle = "#fff";
  ink.lineJoin = "round";
  ink.lineWidth = 18;
  ink.strokeStyle = "#fff";
  path(ink, 0);
  ink.fill();
  ink.stroke();
  const grad = fill.createRadialGradient(cx, cy, outer * 0.1, cx, cy, outer);
  grad.addColorStop(0, "rgb(255,255,255)");
  grad.addColorStop(1, "rgb(205,205,205)");
  fill.fillStyle = grad;
  path(fill, -4);
  fill.fill();
}

/** Merge the three canvas layers into the packed RGBA layout. */
function combine(layers: Layers, out: Uint8Array): void {
  const size = POP_ATLAS_SIZE;
  const ink = layers.ink.getImageData(0, 0, size, size).data;
  const fill = layers.fill.getImageData(0, 0, size, size).data;
  const hi = layers.hi.getImageData(0, 0, size, size).data;
  for (let i = 0; i < out.length; i += 4) {
    const fa = fill[i + 3];
    const ia = ink[i + 3];
    out[i] = fa > 0 ? fill[i] : 255;
    out[i + 1] = fa;
    out[i + 2] = Math.round((hi[i + 3] * fa) / 255);
    out[i + 3] = Math.max(fa, ia);
  }
}
