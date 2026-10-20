// Comic pop-up words (BONK! / CATCH! / OUT!). Owner: client-fx.

import * as THREE from "three";
import { BILLBOARD_FACING, BillboardBatch } from "./billboard";
import { popAtlas, popGlyph, type PopGlyph, type PopGlyphKey } from "./popAtlas";
import type { PopTextKind } from "./types";

const MAX_POPS = 32;
/** Scale-pop keyframes (s): 0 → OVERSHOOT at POP_PEAK, settle to 1 at POP_SETTLE. */
const POP_PEAK = 0.08;
const POP_SETTLE = 0.15;
const OVERSHOOT = 1.3;
const FADE_SEC = 0.3;
/** Pops spawn a little above the given point so they clear heads and balls. */
const SPAWN_LIFT = 0.35;

interface PopStyle {
  glyph: PopGlyphKey;
  fill: string;
  /** Starburst behind the word (color), or null. */
  burst: string | null;
  /** Word height in meters (before distance compensation). */
  height: number;
  life: number;
  rise: number;
  /** Springy squash-wobble instead of a plain pop. */
  springy: boolean;
}

const STYLES: Readonly<Record<PopTextKind, PopStyle>> = {
  bonk: { glyph: "bonk", fill: "#FFD93D", burst: "#FF5A5F", height: 0.75, life: 1.0, rise: 0.8, springy: false },
  catch: { glyph: "catch", fill: "#4FD8FF", burst: "#FFCF33", height: 0.7, life: 1.05, rise: 0.8, springy: false },
  out: { glyph: "out", fill: "#FF5A5F", burst: "#FFFFFF", height: 0.85, life: 1.15, rise: 0.7, springy: false },
  miss: { glyph: "miss", fill: "#C9CED6", burst: null, height: 0.45, life: 0.8, rise: 0.5, springy: false },
  boing: { glyph: "boing", fill: "#FF8FC4", burst: null, height: 0.6, life: 0.95, rise: 0.7, springy: true },
  ding: { glyph: "ding", fill: "#FFD24A", burst: null, height: 0.5, life: 0.85, rise: 0.6, springy: false },
};

const POINTS_GLYPHS: ReadonlyArray<PopGlyphKey> = ["plus1", "plus2", "plus3"];

interface Pop {
  active: boolean;
  glyph: PopGlyph;
  burst: PopGlyph | null;
  x: number;
  y: number;
  z: number;
  age: number;
  life: number;
  rise: number;
  height: number;
  springy: boolean;
  rot: number;
  fill: THREE.Color;
  burstColor: THREE.Color;
  /** Spawn order, to recycle the oldest when the pool is full. */
  serial: number;
}

/**
 * Canvas-lettered sprites (Fredoka 700, thick ink outline, slight rotation), scale-pop in
 * (0 → 1.3 → 1 over 0.15 s), float up 0.8 m, fade after 0.7 s. Colors: bonk = yellow/red,
 * catch = cyan, out = red, miss = grey, boing = pink, ding = gold.
 *
 * Drawn on top of the world (no depth test) and grown with distance so a BONK across the island
 * is still readable. `color` overrides the letter fill (e.g. the thrower's color).
 */
export class PopText {
  private readonly batch: BillboardBatch;
  private readonly pops: Pop[] = [];
  private serial = 0;
  private readonly scratch = new THREE.Color();

  constructor(scene: THREE.Scene) {
    this.batch = new BillboardBatch(scene, {
      name: "fx-pop-text",
      capacity: MAX_POPS * 2,
      map: popAtlas(),
      shading: "packed",
      depthTest: false,
      renderOrder: 10,
      distanceGrow: 1,
    });
    for (let i = 0; i < MAX_POPS; i++) {
      this.pops.push({
        active: false,
        glyph: popGlyph("bonk"),
        burst: null,
        x: 0,
        y: 0,
        z: 0,
        age: 0,
        life: 1,
        rise: 0,
        height: 1,
        springy: false,
        rot: 0,
        fill: new THREE.Color(),
        burstColor: new THREE.Color(),
        serial: 0,
      });
    }
  }

  show(kind: PopTextKind, pos: { x: number; y: number; z: number }, color?: string): void {
    const style = STYLES[kind];
    const pop = this.claim(pos, style.life, style.rise, style.height, style.springy);
    pop.glyph = popGlyph(style.glyph);
    pop.burst = style.burst ? popGlyph("burst") : null;
    pop.fill.set(color ?? style.fill);
    // A custom fill keeps the kind's own color for the burst so the two never blend together.
    pop.burstColor.set(color ? style.fill : (style.burst ?? style.fill));
  }

  /** Score pop ("+1" / "+2" / "+3") in the scorer's color. */
  showPoints(points: number, pos: { x: number; y: number; z: number }, color = "#FFFFFF"): void {
    const index = Math.max(1, Math.min(3, Math.round(points))) - 1;
    const pop = this.claim(pos, 1.1, 1.0, 0.55, false);
    pop.glyph = popGlyph(POINTS_GLYPHS[index]);
    pop.burst = null;
    pop.fill.set(color);
  }

  update(dt: number): void {
    this.batch.begin();
    // Bursts first so words always draw over them (no depth test).
    for (const pop of this.pops) {
      if (!pop.active) continue;
      pop.age += Math.max(0, dt);
      if (pop.age >= pop.life) {
        pop.active = false;
        continue;
      }
      if (pop.burst) this.drawBurst(pop);
    }
    for (const pop of this.pops) {
      if (pop.active) this.drawWord(pop);
    }
    this.batch.end();
  }

  clear(): void {
    for (const pop of this.pops) pop.active = false;
    this.batch.begin();
    this.batch.end();
  }

  dispose(): void {
    this.batch.dispose();
  }

  private claim(pos: { x: number; y: number; z: number }, life: number, rise: number, height: number, springy: boolean): Pop {
    let pop = this.pops.find((p) => !p.active);
    if (!pop) pop = this.pops.reduce((oldest, p) => (p.serial < oldest.serial ? p : oldest), this.pops[0]);
    pop.active = true;
    pop.serial = ++this.serial;
    pop.x = pos.x;
    pop.y = pos.y + SPAWN_LIFT;
    pop.z = pos.z;
    pop.age = 0;
    pop.life = life;
    pop.rise = rise;
    pop.height = height;
    pop.springy = springy;
    pop.rot = (Math.random() - 0.5) * 0.36;
    return pop;
  }

  private drawWord(pop: Pop): void {
    const t = pop.age;
    const scale = popScale(t) * (1 + 0.1 * fadeK(pop));
    let sx = scale;
    let sy = scale;
    if (pop.springy) {
      const k = 0.28 * Math.sin(t * 28) * Math.exp(-t * 5);
      sx *= 1 + k;
      sy *= 1 - k;
    }
    const h = pop.height * sy;
    const w = pop.height * pop.glyph.aspect * sx;
    const rot = pop.rot + 0.12 * Math.sin(t * 30) * Math.exp(-t * 7);
    const alpha = 1 - fadeK(pop);
    const y = pop.y + pop.rise * easeOutCubic(t / pop.life);
    this.batch.push(pop.x, y, pop.z, w, h, rot, pop.fill, alpha, pop.glyph.uv, BILLBOARD_FACING);
  }

  private drawBurst(pop: Pop): void {
    if (!pop.burst) return;
    const t = pop.age;
    const burstLife = Math.min(0.6, pop.life * 0.6);
    if (t >= burstLife) return;
    // Leads the word slightly and spins slowly, then shrinks away.
    const grow = popScale(t + 0.02) * (1 - 0.35 * (t / burstLife));
    const size = pop.height * 2.3 * grow;
    const alpha = t < burstLife * 0.6 ? 1 : 1 - (t - burstLife * 0.6) / (burstLife * 0.4);
    const y = pop.y + pop.rise * easeOutCubic(t / pop.life) * 0.8;
    this.scratch.copy(pop.burstColor);
    this.batch.push(pop.x, y, pop.z, size, size, pop.rot * 2 + t * 0.8, this.scratch, alpha, pop.burst.uv, BILLBOARD_FACING);
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
  const start = pop.life - FADE_SEC;
  return pop.age <= start ? 0 : Math.min(1, (pop.age - start) / FADE_SEC);
}

function easeOutCubic(x: number): number {
  const k = 1 - Math.min(1, Math.max(0, x));
  return 1 - k * k * k;
}
