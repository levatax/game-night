// Comic pop-up words over the island ("BONK!", "-2", "+1", "ALTIN BALIK!"). Owner: client-fx-audio.
// Adapted from games/bonk-brawl/client/src/fx/PopText.ts: same scale-pop / float / fade animation and starburst,
// but any (already translated) text with one of six styles, lettered on demand by popAtlas.PopWordAtlas.

import * as THREE from "three";
import type { Vec3Like } from "../../../shared/types";
import { BILLBOARD_FACING, BillboardBatch } from "./billboard";
import type { PopStyle } from "./Fx";
import { PopWordAtlas, burstTexture, type PopGlyph, type WordColors } from "./popAtlas";

const MAX_POPS = 32;
/** Scale-pop keyframes (s): 0 → OVERSHOOT at POP_PEAK, settle to 1 at POP_SETTLE. */
const POP_PEAK = 0.08;
const POP_SETTLE = 0.15;
const OVERSHOOT = 1.3;
const FADE_SEC = 0.3;
/** Pops spawn a little above the given point so they clear heads and items. */
const SPAWN_LIFT = 0.3;
const FULL_UV = new THREE.Vector4(0, 0, 1, 1);

export interface PopStyleDef {
  colors: WordColors;
  /** Starburst behind the word (color), or null. */
  burst: string | null;
  /** Word height in meters (before distance compensation). */
  height: number;
  life: number;
  rise: number;
  /** Springy squash-wobble instead of a plain pop. */
  springy: boolean;
  /** Shake sideways (bad news). */
  shake: boolean;
  /** Comic caps. */
  upper: boolean;
}

/** The six styles of Fx.popText (pure data, unit-tested for completeness). */
export const POP_STYLES: Readonly<Record<PopStyle, PopStyleDef>> = {
  hit: { colors: { top: "#FFF27A", bottom: "#FFB21E" }, burst: "#FF5A5F", height: 0.6, life: 0.95, rise: 0.8, springy: false, shake: false, upper: true },
  big: { colors: { top: "#FFB06B", bottom: "#FF4D3A" }, burst: "#FFD166", height: 0.95, life: 1.25, rise: 0.9, springy: true, shake: false, upper: true },
  good: { colors: { top: "#B8F5A0", bottom: "#4FC25B" }, burst: null, height: 0.42, life: 1.0, rise: 0.75, springy: false, shake: false, upper: false },
  bad: { colors: { top: "#FF9E9E", bottom: "#E0394B" }, burst: null, height: 0.45, life: 0.95, rise: 0.5, springy: false, shake: true, upper: true },
  info: { colors: { top: "#FFFFFF", bottom: "#FFE9C2" }, burst: null, height: 0.34, life: 1.1, rise: 0.55, springy: false, shake: false, upper: false },
  gold: { colors: { top: "#FFF6B8", bottom: "#FFB21E" }, burst: "#FFFFFF", height: 0.78, life: 1.5, rise: 1.0, springy: true, shake: false, upper: true },
};

interface Pop {
  active: boolean;
  glyph: PopGlyph | null;
  style: PopStyleDef;
  x: number;
  y: number;
  z: number;
  age: number;
  rot: number;
  burstColor: THREE.Color;
  /** Spawn order, to recycle the oldest when the pool is full. */
  serial: number;
}

/** Locale-aware upper case using the page language (Turkish dotted İ). */
function comicCaps(text: string): string {
  let lang: string | undefined;
  try {
    lang = document.documentElement.lang || undefined;
  } catch {
    lang = undefined;
  }
  return text.toLocaleUpperCase(lang);
}

/**
 * Canvas-lettered words (Fredoka 700, thick ink outline, slight rotation): scale-pop in (0 → 1.3 → 1 over
 * 0.15 s), float up, fade over the last 0.3 s. Drawn on top of the world (no depth test) and grown with distance
 * so a BONK across the island is still readable.
 */
export class PopText {
  private readonly words: BillboardBatch;
  private readonly bursts: BillboardBatch;
  private readonly atlas = new PopWordAtlas();
  private readonly pops: Pop[] = [];
  private serial = 0;
  private readonly white = new THREE.Color(1, 1, 1);

  constructor(parent: THREE.Object3D) {
    this.bursts = new BillboardBatch(parent, {
      name: "fx-pop-bursts",
      capacity: MAX_POPS,
      map: burstTexture(),
      depthTest: false,
      renderOrder: 10,
      distanceGrow: 1,
      fog: false,
    });
    this.words = new BillboardBatch(parent, {
      name: "fx-pop-text",
      capacity: MAX_POPS,
      map: this.atlas.texture,
      depthTest: false,
      renderOrder: 11,
      distanceGrow: 1,
      fog: false,
    });
    for (let i = 0; i < MAX_POPS; i++) {
      this.pops.push({ active: false, glyph: null, style: POP_STYLES.info, x: 0, y: 0, z: 0, age: 0, rot: 0, burstColor: new THREE.Color(), serial: 0 });
    }
  }

  get count(): number {
    return this.pops.reduce((n, p) => n + (p.active ? 1 : 0), 0);
  }

  show(text: string, pos: Vec3Like, style: PopStyle): void {
    const def = POP_STYLES[style];
    const label = def.upper ? comicCaps(text) : text;
    if (!label.trim()) return;
    let pop = this.pops.find((p) => !p.active);
    if (!pop) pop = this.pops.reduce((oldest, p) => (p.serial < oldest.serial ? p : oldest), this.pops[0]!);
    if (pop.glyph) this.atlas.release(pop.glyph);
    pop.glyph = this.atlas.acquire(label, def.colors);
    pop.active = true;
    pop.serial = ++this.serial;
    pop.style = def;
    pop.x = pos.x;
    pop.y = pos.y + SPAWN_LIFT;
    pop.z = pos.z;
    pop.age = 0;
    pop.rot = (Math.random() - 0.5) * 0.32;
    if (def.burst) pop.burstColor.set(def.burst);
  }

  update(dt: number): void {
    this.bursts.begin();
    this.words.begin();
    for (const pop of this.pops) {
      if (!pop.active) continue;
      pop.age += Math.max(0, dt);
      if (pop.age >= pop.style.life) {
        pop.active = false;
        if (pop.glyph) this.atlas.release(pop.glyph);
        pop.glyph = null;
        continue;
      }
      if (pop.style.burst) this.drawBurst(pop);
      this.drawWord(pop);
    }
    this.bursts.end();
    this.words.end();
  }

  clear(): void {
    for (const pop of this.pops) {
      if (pop.glyph) this.atlas.release(pop.glyph);
      pop.glyph = null;
      pop.active = false;
    }
    this.bursts.begin();
    this.bursts.end();
    this.words.begin();
    this.words.end();
  }

  dispose(): void {
    this.words.dispose();
    this.bursts.dispose();
    this.atlas.dispose();
  }

  private drawWord(pop: Pop): void {
    const glyph = pop.glyph;
    if (!glyph) return;
    const st = pop.style;
    const t = pop.age;
    const scale = popScale(t) * (1 + 0.1 * fadeK(pop));
    let sx = scale;
    let sy = scale;
    if (st.springy) {
      const k = 0.28 * Math.sin(t * 28) * Math.exp(-t * 5);
      sx *= 1 + k;
      sy *= 1 - k;
    }
    const h = st.height * sy;
    const w = st.height * glyph.aspect * sx;
    const rot = pop.rot + 0.12 * Math.sin(t * 30) * Math.exp(-t * 7);
    const alpha = 1 - fadeK(pop);
    const shake = st.shake ? 0.06 * Math.sin(t * 46) * Math.exp(-t * 4) : 0;
    const y = pop.y + st.rise * easeOutCubic(t / st.life);
    this.words.push(pop.x + shake, y, pop.z, w, h, rot, this.white, alpha, glyph.uv, BILLBOARD_FACING);
  }

  private drawBurst(pop: Pop): void {
    const st = pop.style;
    const t = pop.age;
    const burstLife = Math.min(0.6, st.life * 0.6);
    if (t >= burstLife) return;
    const grow = popScale(t + 0.02) * (1 - 0.35 * (t / burstLife));
    const size = st.height * 2.2 * grow;
    const alpha = t < burstLife * 0.6 ? 1 : 1 - (t - burstLife * 0.6) / (burstLife * 0.4);
    const y = pop.y + st.rise * easeOutCubic(t / st.life) * 0.8;
    this.bursts.push(pop.x, y, pop.z, size, size, pop.rot * 2 + t * 0.8, pop.burstColor, alpha, FULL_UV, BILLBOARD_FACING);
  }
}

/** 0 → 1.3 → 1 over the first 0.15 s, then a gentle settle. */
function popScale(t: number): number {
  if (t < POP_PEAK) return OVERSHOOT * easeOutCubic(t / POP_PEAK);
  if (t < POP_SETTLE) return OVERSHOOT + (1 - OVERSHOOT) * ((t - POP_PEAK) / (POP_SETTLE - POP_PEAK));
  return 1;
}

/** 0 until the last FADE_SEC of a pop's life, then 0 → 1. */
function fadeK(pop: Pop): number {
  const start = pop.style.life - FADE_SEC;
  return pop.age <= start ? 0 : Math.min(1, (pop.age - start) / FADE_SEC);
}

function easeOutCubic(x: number): number {
  const k = 1 - Math.min(1, Math.max(0, x));
  return 1 - k * k * k;
}
