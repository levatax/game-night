// Pooled billboard particle bursts + continuous emitters. Owner: client-fx-audio.
// Copied from games/bonk-brawl/client/src/fx/Particles.ts (struct-of-arrays CPU pool drawn as two instanced
// billboard batches over one canvas atlas) and re-voiced for the island: wood splinters, leaves, berries,
// splashes and ripples, embers, smoke, gold coins, hearts, crab shell bits, bait smell lines. Chunky 3D debris
// (wood chips, stone chips, shell bits, puffer spikes) lives in Chunks.ts; Fx.burst() fires both.

import * as THREE from "three";
import { PALETTE, PLAYER_COLORS, PUFFER_BLAST_RADIUS } from "../../../shared/constants";
import type { Vec3Like } from "../../../shared/types";
import { BILLBOARD_FACING, BILLBOARD_FLAT, BillboardBatch, gridUv, type BillboardMode } from "./billboard";
import type { BurstKind, BurstOptions } from "./Fx";
import { ATLAS_GRID, TILE, particleAtlas, type TileId } from "./fxTextures";

/** Burst kinds plus fx-internal emitters (bait smell, pickup glints, full-charge sparks). */
export type ParticleKind = BurstKind | "smell" | "glint" | "chargeSpark";

/** Storage for live particles (the effective cap is lower, see setQualityScale). */
const CAPACITY = 1100;
const BASE_LIVE_CAP = 700;
/** A continuous emitter that isn't refreshed for this long stops. */
const EMITTER_TIMEOUT_SEC = 0.12;
/** Scale-in time of a new particle (s). */
const POP_IN_SEC = 0.06;

/** Size-over-life curves. */
const CURVE_LINEAR = 0;
const CURVE_EASE_OUT = 1;
const CURVE_TWINKLE = 2;
/** Width follows |cos| of a flip phase: confetti / coins tumbling in 3D. */
const CURVE_FLIP = 3;
/** Bubbles swell and vanish at the end. */
const CURVE_POP_END = 4;

/** Default tint per kind (BurstOptions.color overrides). */
export const PARTICLE_COLORS: Readonly<Record<ParticleKind, string>> = {
  woodChips: "#C98F57",
  stoneChips: "#A39E95",
  leaves: "#6CC35E",
  berries: "#6B2E9A",
  splash: "#DDF6FF",
  ripple: "#FFFFFF",
  hitStars: "#FFE14D",
  bonk: "#FFE14D",
  flip: "#FFE14D",
  blast: "#FFD23F",
  embers: "#FFB347",
  smoke: "#B9B4AE",
  sparkle: "#FFE27A",
  gold: "#FFC83D",
  dust: "#EADBC0",
  bubbles: "#DDF3FF",
  feathers: "#FFFFFF",
  crabBits: "#FF4D3A",
  confetti: "#FFFFFF",
  hearts: "#FF6F91",
  smell: "#BFE36B",
  glint: "#FFF4C2",
  chargeSpark: "#FFE27A",
};

/** Main-body particle count per burst at scale 1 (BurstOptions.count overrides). */
export const BURST_COUNT: Readonly<Record<ParticleKind, number>> = {
  woodChips: 9,
  stoneChips: 8,
  leaves: 10,
  berries: 7,
  splash: 14,
  ripple: 3,
  hitStars: 7,
  bonk: 10,
  flip: 6,
  blast: 12,
  embers: 14,
  smoke: 7,
  sparkle: 10,
  gold: 14,
  dust: 7,
  bubbles: 10,
  feathers: 12,
  crabBits: 8,
  confetti: 46,
  hearts: 6,
  smell: 1,
  glint: 1,
  chargeSpark: 1,
};

/** Particles per second for continuous emitters. */
export const EMIT_RATE: Readonly<Record<ParticleKind, number>> = {
  woodChips: 10,
  stoneChips: 10,
  leaves: 6,
  berries: 6,
  splash: 16,
  ripple: 2,
  hitStars: 6,
  bonk: 4,
  flip: 4,
  blast: 4,
  embers: 12,
  smoke: 5,
  sparkle: 14,
  gold: 12,
  dust: 14,
  bubbles: 8,
  feathers: 6,
  crabBits: 6,
  confetti: 30,
  hearts: 4,
  smell: 2.6,
  glint: 0.7,
  chargeSpark: 16,
};

const CONFETTI_COLORS: ReadonlyArray<string> = [...PLAYER_COLORS, "#FFFFFF", PALETTE.hud, PALETTE.sea, PALETTE.sunset, "#FF9EC8"];
const WHITE = "#FFFFFF";
const GOLD_LIGHT = "#FFF1A8";
const LEAF_SHADES: ReadonlyArray<string> = ["#6CC35E", "#4FA34A", "#8ED46B", "#3E8E52"];
const WOOD_SHADES: ReadonlyArray<string> = ["#C98F57", "#B07A45", "#E3B77E", "#8B5A2B"];
const SMOKE_DARK = "#7D7872";

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function pick<T>(list: ReadonlyArray<T>): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

/** Everything one new particle needs; reused for every spawn (no allocations). */
interface SpawnSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  /** Negative = delayed start. */
  age: number;
  life: number;
  size0: number;
  size1: number;
  /** Quad height / width. */
  aspect: number;
  rot: number;
  rotVel: number;
  gravity: number;
  drag: number;
  alpha: number;
  /** Fraction of life after which alpha fades to 0. */
  fadeFrom: number;
  /** Lateral sway amplitude (m) and frequency (rad/s). */
  sway: number;
  swayFreq: number;
  flipFreq: number;
  phase: number;
  /** Orbit around (x, y, z) with this radius (m) and angular speed (rad/s) instead of physics. */
  orbitR: number;
  orbitW: number;
  r: number;
  g: number;
  b: number;
  tile: TileId;
  mode: BillboardMode;
  additive: boolean;
  curve: number;
  ax: number;
  ay: number;
  az: number;
}

function blankSpec(): SpawnSpec {
  return {
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, age: 0, life: 1, size0: 0.3, size1: 0.3, aspect: 1,
    rot: 0, rotVel: 0, gravity: 0, drag: 0, alpha: 1, fadeFrom: 0.6, sway: 0, swayFreq: 0,
    flipFreq: 0, phase: 0, orbitR: 0, orbitW: 0, r: 1, g: 1, b: 1, tile: TILE.glow,
    mode: BILLBOARD_FACING, additive: false, curve: CURVE_LINEAR, ax: 0, ay: 0, az: 0,
  };
}

interface Emitter {
  kind: ParticleKind;
  x: number;
  y: number;
  z: number;
  color: string | undefined;
  scale: number;
  hasDir: boolean;
  dx: number;
  dy: number;
  dz: number;
  idle: number;
  carry: number;
}

export interface ParticleBurstOptions extends BurstOptions {
  /** Spawn delay (s), e.g. staggered ripples. */
  delay?: number;
}

/**
 * Cheap pooled instanced quads (procedural canvas atlas), alpha-blended or additive per kind, gravity / drag /
 * sway per kind. Hard cap ~700 live particles at quality 1 (half on low).
 */
export class Particles {
  private readonly normal: BillboardBatch;
  private readonly additive: BillboardBatch;
  private live = 0;
  private liveCap = BASE_LIVE_CAP;
  private quality = 1;
  private flashScale = 1;
  private readonly spec = blankSpec();
  private readonly emitters = new Map<string, Emitter>();
  private readonly colors = new Map<string, THREE.Color>();
  private readonly tileUv: THREE.Vector4[] = [];
  private readonly scratchColor = new THREE.Color();
  private readonly dir = new THREE.Vector3();
  private readonly side = new THREE.Vector3();

  // Struct-of-arrays particle state.
  private readonly px = new Float32Array(CAPACITY);
  private readonly py = new Float32Array(CAPACITY);
  private readonly pz = new Float32Array(CAPACITY);
  private readonly vx = new Float32Array(CAPACITY);
  private readonly vy = new Float32Array(CAPACITY);
  private readonly vz = new Float32Array(CAPACITY);
  private readonly age = new Float32Array(CAPACITY);
  private readonly life = new Float32Array(CAPACITY);
  private readonly size0 = new Float32Array(CAPACITY);
  private readonly size1 = new Float32Array(CAPACITY);
  private readonly aspect = new Float32Array(CAPACITY);
  private readonly rot = new Float32Array(CAPACITY);
  private readonly rotVel = new Float32Array(CAPACITY);
  private readonly gravity = new Float32Array(CAPACITY);
  private readonly drag = new Float32Array(CAPACITY);
  private readonly alpha = new Float32Array(CAPACITY);
  private readonly fadeFrom = new Float32Array(CAPACITY);
  private readonly sway = new Float32Array(CAPACITY);
  private readonly swayFreq = new Float32Array(CAPACITY);
  private readonly flipFreq = new Float32Array(CAPACITY);
  private readonly phase = new Float32Array(CAPACITY);
  private readonly orbitR = new Float32Array(CAPACITY);
  private readonly orbitW = new Float32Array(CAPACITY);
  private readonly cr = new Float32Array(CAPACITY);
  private readonly cg = new Float32Array(CAPACITY);
  private readonly cb = new Float32Array(CAPACITY);
  private readonly ax = new Float32Array(CAPACITY);
  private readonly ay = new Float32Array(CAPACITY);
  private readonly az = new Float32Array(CAPACITY);
  private readonly tile = new Uint8Array(CAPACITY);
  private readonly mode = new Uint8Array(CAPACITY);
  private readonly add = new Uint8Array(CAPACITY);
  private readonly curve = new Uint8Array(CAPACITY);
  private readonly arrays: ReadonlyArray<Float32Array | Uint8Array>;

  constructor(parent: THREE.Object3D) {
    const map = particleAtlas();
    this.normal = new BillboardBatch(parent, { name: "fx-particles", capacity: CAPACITY, map, renderOrder: 3 });
    this.additive = new BillboardBatch(parent, { name: "fx-particles-add", capacity: CAPACITY, map, additive: true, renderOrder: 4, fog: false });
    for (let i = 0; i < ATLAS_GRID * ATLAS_GRID; i++) this.tileUv.push(gridUv(i, ATLAS_GRID, new THREE.Vector4()));
    this.arrays = [
      this.px, this.py, this.pz, this.vx, this.vy, this.vz, this.age, this.life, this.size0,
      this.size1, this.aspect, this.rot, this.rotVel, this.gravity, this.drag, this.alpha,
      this.fadeFrom, this.sway, this.swayFreq, this.flipFreq, this.phase, this.orbitR, this.orbitW,
      this.cr, this.cg, this.cb, this.ax, this.ay, this.az, this.tile, this.mode, this.add, this.curve,
    ];
  }

  /** Live particle count (debug / harness). */
  get count(): number {
    return this.live;
  }

  burst(kind: ParticleKind, pos: Vec3Like, opts?: ParticleBurstOptions): void {
    const scale = Math.max(0.05, opts?.scale ?? 1);
    const color = opts?.color;
    const dir = opts?.dir;
    const hasDir = !!dir && dir.x * dir.x + dir.y * dir.y + dir.z * dir.z > 1e-8;
    if (hasDir) this.dir.set(dir.x, dir.y, dir.z).normalize();
    else this.dir.set(0, 0, 0);
    const delay = Math.max(0, opts?.delay ?? 0);
    const n = opts?.count !== undefined ? Math.max(0, Math.round(opts.count * this.quality)) : this.countFor(BURST_COUNT[kind], scale);
    for (let i = 0; i < n; i++) this.spawnMain(kind, pos.x, pos.y, pos.z, color, scale, hasDir, i, delay);
    this.burstExtras(kind, pos, scale, color, delay);
  }

  /**
   * Continuous emitter following a target (bait smell, pickup glints, charge sparks, embers over a fire). Call
   * every frame; stops when not refreshed for 0.12 s.
   */
  emit(key: string, kind: ParticleKind, pos: Vec3Like, opts?: BurstOptions): void {
    let e = this.emitters.get(key);
    if (!e) {
      e = { kind, x: 0, y: 0, z: 0, color: undefined, scale: 1, hasDir: false, dx: 0, dy: 0, dz: 0, idle: 0, carry: Math.random() };
      this.emitters.set(key, e);
    }
    e.kind = kind;
    e.x = pos.x;
    e.y = pos.y;
    e.z = pos.z;
    e.color = opts?.color;
    e.scale = Math.max(0.05, opts?.scale ?? 1);
    const d = opts?.dir;
    e.hasDir = !!d && d.x * d.x + d.y * d.y + d.z * d.z > 1e-8;
    if (d && e.hasDir) {
      const len = Math.hypot(d.x, d.y, d.z);
      e.dx = d.x / len;
      e.dy = d.y / len;
      e.dz = d.z / len;
    }
    e.idle = 0;
  }

  update(dt: number): void {
    if (dt > 0) {
      this.runEmitters(dt);
      this.simulate(Math.min(dt, 0.1));
    }
    this.draw();
  }

  setQualityScale(scale: number): void {
    this.quality = Math.min(1.5, Math.max(0.25, scale));
    this.liveCap = Math.min(CAPACITY, Math.round(BASE_LIVE_CAP * this.quality));
  }

  clear(): void {
    this.live = 0;
    this.emitters.clear();
    this.draw();
  }

  dispose(): void {
    this.normal.dispose();
    this.additive.dispose();
    this.emitters.clear();
  }

  /* ---------------------------------------------------------------- spawning */

  private countFor(base: number, scale: number): number {
    return Math.max(1, Math.round(base * this.quality * Math.min(3, scale)));
  }

  private tint(hex: string | undefined, kind: ParticleKind): THREE.Color {
    const key = hex ?? PARTICLE_COLORS[kind];
    let c = this.colors.get(key);
    if (!c) {
      c = new THREE.Color(key);
      this.colors.set(key, c);
    }
    return c;
  }

  /** Base color lightened (k > 0, toward white) or darkened (k < 0) into the spawn spec. */
  private setColor(base: THREE.Color, k = 0): void {
    const s = this.spec;
    if (k >= 0) {
      s.r = base.r + (1 - base.r) * k;
      s.g = base.g + (1 - base.g) * k;
      s.b = base.b + (1 - base.b) * k;
    } else {
      s.r = base.r * (1 + k);
      s.g = base.g * (1 + k);
      s.b = base.b * (1 + k);
    }
  }

  private resetSpec(x: number, y: number, z: number, delay = 0): SpawnSpec {
    const s = this.spec;
    s.x = x;
    s.y = y;
    s.z = z;
    s.vx = s.vy = s.vz = 0;
    s.age = -delay;
    s.life = 1;
    s.size0 = s.size1 = 0.3;
    s.aspect = 1;
    s.rot = Math.random() * Math.PI * 2;
    s.rotVel = 0;
    s.gravity = 0;
    s.drag = 0;
    s.alpha = 1;
    s.fadeFrom = 0.6;
    s.sway = s.swayFreq = s.flipFreq = 0;
    s.phase = Math.random() * Math.PI * 2;
    s.orbitR = s.orbitW = 0;
    s.r = s.g = s.b = 1;
    s.tile = TILE.glow;
    s.mode = BILLBOARD_FACING;
    s.additive = false;
    s.curve = CURVE_LINEAR;
    s.ax = s.ay = s.az = 0;
    return s;
  }

  /** Random unit vector into this.side (upward-biased by `up` 0..1). */
  private randomDir(up: number): THREE.Vector3 {
    const v = this.side;
    const theta = Math.random() * Math.PI * 2;
    const y = rnd(-1, 1) * (1 - up) + up * Math.random();
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return v.set(Math.cos(theta) * r, y, Math.sin(theta) * r);
  }

  private commit(): void {
    if (this.live >= this.liveCap) return;
    const s = this.spec;
    const i = this.live++;
    this.px[i] = s.x;
    this.py[i] = s.y;
    this.pz[i] = s.z;
    this.vx[i] = s.vx;
    this.vy[i] = s.vy;
    this.vz[i] = s.vz;
    this.age[i] = s.age;
    this.life[i] = s.life;
    this.size0[i] = s.size0;
    this.size1[i] = s.size1;
    this.aspect[i] = s.aspect;
    this.rot[i] = s.rot;
    this.rotVel[i] = s.rotVel;
    this.gravity[i] = s.gravity;
    this.drag[i] = s.drag;
    this.alpha[i] = s.alpha;
    this.fadeFrom[i] = s.fadeFrom;
    this.sway[i] = s.sway;
    this.swayFreq[i] = s.swayFreq;
    this.flipFreq[i] = s.flipFreq;
    this.phase[i] = s.phase;
    this.orbitR[i] = s.orbitR;
    this.orbitW[i] = s.orbitW;
    this.cr[i] = s.r;
    this.cg[i] = s.g;
    this.cb[i] = s.b;
    this.ax[i] = s.ax;
    this.ay[i] = s.ay;
    this.az[i] = s.az;
    this.tile[i] = s.tile;
    this.mode[i] = s.mode;
    this.add[i] = s.additive ? 1 : 0;
    this.curve[i] = s.curve;
  }

  /** One particle of a kind's main body (bursts spawn N of these, emitters 1 at a time). */
  private spawnMain(kind: ParticleKind, x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, index: number, delay = 0): void {
    switch (kind) {
      case "hitStars":
      case "bonk":
        return this.star(x, y, z, color, spread * (kind === "bonk" ? 1.25 : 1), hasDir, index, delay);
      case "flip":
        return this.star(x, y + 0.2, z, color, spread * 0.7, false, index, delay);
      case "smoke":
        return this.smokePuff(x, y, z, color, spread, delay);
      case "confetti":
        return this.confettiPiece(x, y, z, color, spread, delay);
      case "feathers":
        return this.feather(x, y, z, color, spread, index, delay);
      case "dust":
        return this.dustPuff(x, y, z, color, spread, hasDir, delay);
      case "woodChips":
        return this.splinter(x, y, z, color, spread, hasDir, delay);
      case "stoneChips":
        return this.chip(x, y, z, color, spread, hasDir, delay);
      case "crabBits":
        return this.shellBit(x, y, z, color, spread, delay);
      case "sparkle":
      case "chargeSpark":
        return this.sparkle(x, y, z, color, kind === "chargeSpark" ? spread * 0.5 : spread, delay);
      case "gold":
        return index % 2 === 0 ? this.coin(x, y, z, color, spread, delay) : this.sparkle(x, y, z, color ?? PARTICLE_COLORS.gold, spread * 1.2, delay);
      case "bubbles":
        return this.bubble(x, y, z, color, spread, delay);
      case "leaves":
        return this.leaf(x, y, z, color, spread, hasDir, delay);
      case "berries":
        return index % 2 === 0 ? this.berry(x, y, z, color, spread, delay) : this.drop(x, y, z, color ?? PARTICLE_COLORS.berries, spread * 0.8, delay, false);
      case "splash":
        return this.drop(x, y, z, color, spread, delay, true);
      case "ripple":
        return this.ring(x, y + 0.03, z, this.tint(color, kind), 0.3 * spread, 2.2 * spread, 0.9, delay + index * 0.2, true, 0.7);
      case "embers":
        return this.ember(x, y, z, color, spread, delay);
      case "blast":
        return this.blastPuff(x, y, z, color, spread, index, delay);
      case "hearts":
        return this.heart(x, y, z, color, spread, delay);
      case "smell":
        return this.smell(x, y, z, color, spread);
      case "glint":
        return this.glint(x, y, z, color, spread);
    }
  }

  private star(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, index: number, delay: number): void {
    const s = this.resetSpec(x, y, z, delay);
    const d = this.randomDir(0.55);
    const speed = rnd(3, 5.5) * spread;
    s.vx = d.x * speed + (hasDir ? this.dir.x * 2.5 : 0);
    s.vy = Math.abs(d.y) * speed + 1.5;
    s.vz = d.z * speed + (hasDir ? this.dir.z * 2.5 : 0);
    s.gravity = -11;
    s.drag = 2.2;
    s.life = rnd(0.5, 0.75);
    s.size0 = rnd(0.28, 0.4) * Math.sqrt(spread);
    s.size1 = 0.06;
    s.rotVel = rnd(-9, 9);
    s.fadeFrom = 0.65;
    s.tile = TILE.star;
    const pickIndex = index % 3;
    this.setColor(this.tint(pickIndex === 2 ? color : pickIndex === 1 ? WHITE : undefined, "hitStars"), pickIndex === 1 ? 0 : 0.05);
    this.commit();
  }

  private smokePuff(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.2, 0.2) * spread, y + rnd(0, 0.3), z + rnd(-0.2, 0.2) * spread, delay + rnd(0, 0.25));
    s.vx = rnd(-0.4, 0.4);
    s.vy = rnd(0.6, 1.3);
    s.vz = rnd(-0.4, 0.4);
    s.gravity = 0.5;
    s.drag = 1.2;
    s.life = rnd(1.4, 2.2);
    s.size0 = rnd(0.35, 0.5) * Math.sqrt(spread);
    s.size1 = s.size0 * 3;
    s.curve = CURVE_EASE_OUT;
    s.rotVel = rnd(-0.8, 0.8);
    s.alpha = 0.6;
    s.fadeFrom = 0.25;
    s.sway = rnd(0.1, 0.3);
    s.swayFreq = rnd(1, 2);
    s.tile = TILE.puff;
    this.setColor(this.tint(color ?? (Math.random() < 0.4 ? SMOKE_DARK : undefined), "smoke"), rnd(-0.05, 0.1));
    this.commit();
  }

  private puff(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.2, 0.2) * spread, y + rnd(0, 0.25), z + rnd(-0.2, 0.2) * spread, delay);
    const d = this.randomDir(0);
    const speed = rnd(1.2, 2.6) * spread;
    s.vx = d.x * speed;
    s.vy = rnd(0.4, 1.2);
    s.vz = d.z * speed;
    s.gravity = 0.8;
    s.drag = 4.5;
    s.life = rnd(0.5, 0.8);
    s.size0 = rnd(0.35, 0.5) * Math.sqrt(spread);
    s.size1 = s.size0 * 2.2;
    s.curve = CURVE_EASE_OUT;
    s.rotVel = rnd(-1.5, 1.5);
    s.fadeFrom = 0.35;
    s.tile = TILE.puff;
    this.setColor(this.tint(color ?? WHITE, "smoke"), color ? 0.35 : 0);
    this.commit();
  }

  private confettiPiece(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.3, 0.3), y, z + rnd(-0.3, 0.3), delay);
    const d = this.randomDir(0);
    const speed = rnd(1.5, 4) * spread;
    s.vx = d.x * speed;
    s.vy = rnd(5, 9) * Math.sqrt(spread);
    s.vz = d.z * speed;
    s.gravity = -7;
    s.drag = 1.6;
    s.life = rnd(2, 3);
    s.size0 = s.size1 = rnd(0.13, 0.2);
    s.aspect = 0.62;
    s.curve = CURVE_FLIP;
    s.flipFreq = rnd(6, 13);
    s.sway = rnd(0.2, 0.45);
    s.swayFreq = rnd(2.5, 4);
    s.rotVel = rnd(-6, 6);
    s.fadeFrom = 0.8;
    s.tile = TILE.confetti;
    this.setColor(this.tint(color && Math.random() < 0.4 ? color : pick(CONFETTI_COLORS), "confetti"));
    this.commit();
  }

  private feather(x: number, y: number, z: number, color: string | undefined, spread: number, index: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.15, 0.15), y + rnd(0, 0.4), z + rnd(-0.15, 0.15), delay);
    const d = this.randomDir(0.4);
    const speed = rnd(2.5, 5) * spread;
    s.vx = d.x * speed;
    s.vy = Math.abs(d.y) * speed + 2;
    s.vz = d.z * speed;
    s.gravity = -3.2;
    s.drag = 2.6;
    s.life = rnd(1.4, 2.1);
    s.size0 = rnd(0.24, 0.34);
    s.size1 = s.size0 * 0.85;
    s.sway = rnd(0.25, 0.45);
    s.swayFreq = rnd(2.2, 3.4);
    s.rotVel = rnd(-2, 2);
    s.fadeFrom = 0.7;
    s.tile = TILE.feather;
    this.setColor(this.tint(color ?? (index % 3 === 0 ? "#C9CED6" : WHITE), "feathers"), index % 2 === 0 ? 0 : 0.3);
    this.commit();
  }

  private dustPuff(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, delay: number): void {
    const a = Math.random() * Math.PI * 2;
    const r = rnd(0, 0.35) * spread;
    const s = this.resetSpec(x + Math.cos(a) * r, y + 0.12, z + Math.sin(a) * r, delay);
    const speed = rnd(1, 2.2) * spread;
    const push = hasDir ? rnd(1, 2) : 0;
    s.vx = Math.cos(a) * speed + this.dir.x * push;
    s.vy = rnd(0.3, 0.9);
    s.vz = Math.sin(a) * speed + this.dir.z * push;
    s.gravity = 0.4;
    s.drag = 3.8;
    s.life = rnd(0.45, 0.7);
    s.size0 = rnd(0.28, 0.4) * Math.sqrt(spread);
    s.size1 = s.size0 * 2.2;
    s.curve = CURVE_EASE_OUT;
    s.rotVel = rnd(-1, 1);
    s.alpha = 0.8;
    s.fadeFrom = 0.3;
    s.tile = TILE.dust;
    this.setColor(this.tint(color, "dust"), color ? 0.3 : 0);
    this.commit();
  }

  /** Thrown-out debris shared by splinters / chips / shell bits. */
  private debris(x: number, y: number, z: number, spread: number, hasDir: boolean, delay: number): SpawnSpec {
    const s = this.resetSpec(x + rnd(-0.12, 0.12) * spread, y + rnd(0, 0.2), z + rnd(-0.12, 0.12) * spread, delay);
    const d = this.randomDir(0.35);
    const speed = rnd(2, 4.5) * spread;
    s.vx = d.x * speed + (hasDir ? this.dir.x * 2.2 : 0);
    s.vy = rnd(2.5, 5) * Math.sqrt(spread);
    s.vz = d.z * speed + (hasDir ? this.dir.z * 2.2 : 0);
    s.gravity = -16;
    s.drag = 0.8;
    s.life = rnd(0.7, 1.1);
    s.rotVel = rnd(-12, 12);
    s.fadeFrom = 0.7;
    return s;
  }

  private splinter(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, delay: number): void {
    const s = this.debris(x, y, z, spread, hasDir, delay);
    s.size0 = s.size1 = rnd(0.14, 0.24);
    s.aspect = 0.55;
    s.tile = TILE.splinter;
    this.setColor(this.tint(color ?? pick(WOOD_SHADES), "woodChips"), rnd(-0.1, 0.1));
    this.commit();
  }

  private chip(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, delay: number): void {
    const s = this.debris(x, y, z, spread, hasDir, delay);
    s.size0 = s.size1 = rnd(0.08, 0.15);
    s.tile = Math.random() < 0.6 ? TILE.crumb : TILE.chip;
    this.setColor(this.tint(color, "stoneChips"), rnd(-0.2, 0.15));
    this.commit();
  }

  private shellBit(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.debris(x, y + 0.1, z, spread, false, delay);
    s.size0 = s.size1 = rnd(0.12, 0.2);
    s.tile = TILE.shell;
    this.setColor(this.tint(color, "crabBits"), rnd(-0.15, 0.1));
    this.commit();
  }

  private sparkle(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const d = this.randomDir(0);
    const r = rnd(0.1, 0.55) * spread;
    const s = this.resetSpec(x + d.x * r, y + d.y * r + 0.1, z + d.z * r, delay);
    s.vx = d.x * 0.6;
    s.vy = rnd(0.6, 1.6);
    s.vz = d.z * 0.6;
    s.gravity = 0.4;
    s.drag = 1.8;
    s.life = rnd(0.45, 0.9);
    s.size0 = s.size1 = rnd(0.18, 0.32) * Math.sqrt(Math.max(0.5, spread));
    s.curve = CURVE_TWINKLE;
    s.rotVel = rnd(-3, 3);
    s.fadeFrom = 0.55;
    s.tile = TILE.sparkle;
    s.additive = true;
    this.setColor(this.tint(color, "sparkle"), rnd(0, 0.5));
    this.commit();
  }

  private coin(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.2, 0.2), y + 0.1, z + rnd(-0.2, 0.2), delay);
    const d = this.randomDir(0);
    const speed = rnd(1, 2.8) * spread;
    s.vx = d.x * speed;
    s.vy = rnd(4, 6.5) * Math.sqrt(spread);
    s.vz = d.z * speed;
    s.gravity = -12;
    s.drag = 1;
    s.life = rnd(0.9, 1.3);
    s.size0 = s.size1 = rnd(0.16, 0.22);
    s.curve = CURVE_FLIP;
    s.flipFreq = rnd(9, 15);
    s.rotVel = rnd(-2, 2);
    s.fadeFrom = 0.75;
    s.tile = TILE.coin;
    this.setColor(this.tint(color, "gold"), rnd(0, 0.2));
    this.commit();
  }

  private bubble(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const d = this.randomDir(0);
    const r = rnd(0.1, 0.5) * spread;
    const s = this.resetSpec(x + d.x * r, y + d.y * r * 0.6 + 0.2, z + d.z * r, delay + rnd(0, 0.2));
    s.vx = d.x * 0.8;
    s.vy = rnd(0.8, 1.8);
    s.vz = d.z * 0.8;
    s.gravity = 1;
    s.drag = 1.4;
    s.sway = rnd(0.15, 0.3);
    s.swayFreq = rnd(3, 5);
    s.life = rnd(0.8, 1.4);
    s.size0 = s.size1 = rnd(0.1, 0.24);
    s.curve = CURVE_POP_END;
    s.alpha = 0.95;
    s.fadeFrom = 0.92;
    s.tile = TILE.bubble;
    this.setColor(this.tint(color, "bubbles"), color ? 0.5 : 0);
    this.commit();
  }

  private leaf(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.6, 0.6) * spread, y + rnd(-0.2, 0.4), z + rnd(-0.6, 0.6) * spread, delay + rnd(0, 0.15));
    const d = this.randomDir(0.3);
    const speed = rnd(0.8, 2.2) * spread;
    s.vx = d.x * speed + (hasDir ? this.dir.x : 0);
    s.vy = rnd(0.5, 2.2);
    s.vz = d.z * speed + (hasDir ? this.dir.z : 0);
    s.gravity = -2.6;
    s.drag = 2.4;
    s.life = rnd(1.4, 2.3);
    s.size0 = s.size1 = rnd(0.16, 0.28);
    s.sway = rnd(0.2, 0.45);
    s.swayFreq = rnd(2, 3.4);
    s.curve = CURVE_FLIP;
    s.flipFreq = rnd(2.5, 5);
    s.rotVel = rnd(-2.5, 2.5);
    s.fadeFrom = 0.75;
    s.tile = TILE.leaf;
    this.setColor(this.tint(color ?? pick(LEAF_SHADES), "leaves"), rnd(-0.08, 0.12));
    this.commit();
  }

  private berry(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.debris(x, y + 0.2, z, spread * 0.7, false, delay);
    s.size0 = s.size1 = rnd(0.1, 0.16);
    s.rotVel = rnd(-4, 4);
    s.tile = TILE.berry;
    this.setColor(this.tint(color, "berries"), rnd(-0.1, 0.25));
    this.commit();
  }

  /** Water / juice droplet flung up (splash crown when `crown`). */
  private drop(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number, crown: boolean): void {
    const a = Math.random() * Math.PI * 2;
    const r = rnd(0.05, 0.3) * spread;
    const s = this.resetSpec(x + Math.cos(a) * r, y + 0.05, z + Math.sin(a) * r, delay);
    const out = rnd(0.8, 2.4) * spread;
    s.vx = Math.cos(a) * out;
    s.vy = rnd(crown ? 3.5 : 2, crown ? 6.5 : 4) * Math.sqrt(spread);
    s.vz = Math.sin(a) * out;
    s.gravity = -15;
    s.drag = 0.6;
    s.life = rnd(0.5, 0.8);
    s.size0 = rnd(0.1, 0.17) * Math.sqrt(spread);
    s.size1 = s.size0 * 0.6;
    s.aspect = 1.25;
    s.rot = 0;
    s.alpha = 0.95;
    s.fadeFrom = 0.6;
    s.tile = TILE.drop;
    this.setColor(this.tint(color, "splash"), rnd(0, 0.25));
    this.commit();
  }

  private ember(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.3, 0.3) * spread, y + rnd(0, 0.3), z + rnd(-0.3, 0.3) * spread, delay + rnd(0, 0.3));
    s.vx = rnd(-0.6, 0.6);
    s.vy = rnd(1.2, 2.8) * Math.sqrt(spread);
    s.vz = rnd(-0.6, 0.6);
    s.gravity = 0.6;
    s.drag = 1.1;
    s.life = rnd(0.9, 1.7);
    s.size0 = rnd(0.07, 0.13);
    s.size1 = 0.02;
    s.sway = rnd(0.08, 0.25);
    s.swayFreq = rnd(4, 8);
    s.curve = CURVE_TWINKLE;
    s.fadeFrom = 0.5;
    s.tile = TILE.ember;
    s.additive = true;
    this.setColor(this.tint(color ?? (Math.random() < 0.3 ? "#FF7A2E" : undefined), "embers"), rnd(0, 0.35));
    this.commit();
  }

  private blastPuff(x: number, y: number, z: number, color: string | undefined, spread: number, index: number, delay: number): void {
    if (index % 3 === 0) {
      // Spiky yellow shards flung out.
      const s = this.debris(x, y, z, Math.max(1, spread * 0.6), false, delay);
      s.size0 = s.size1 = rnd(0.12, 0.2);
      s.aspect = 0.5;
      s.tile = TILE.splinter;
      this.setColor(this.tint(color, "blast"), rnd(-0.15, 0.1));
      this.commit();
      return;
    }
    const s = this.resetSpec(x, y + rnd(0, 0.3), z, delay);
    const d = this.randomDir(0.15);
    const speed = rnd(2.5, 4.5) * Math.sqrt(spread);
    s.vx = d.x * speed;
    s.vy = Math.abs(d.y) * speed * 0.6 + 0.6;
    s.vz = d.z * speed;
    s.gravity = 0.6;
    s.drag = 3.4;
    s.life = rnd(0.7, 1.1);
    s.size0 = rnd(0.5, 0.75) * Math.sqrt(spread);
    s.size1 = s.size0 * 2.2;
    s.curve = CURVE_EASE_OUT;
    s.rotVel = rnd(-1.5, 1.5);
    s.alpha = 0.85;
    s.fadeFrom = 0.3;
    s.tile = TILE.puff;
    this.setColor(this.tint(index % 2 === 0 ? "#FFF4DC" : "#E8D7A8", "smoke"), 0);
    this.commit();
  }

  private heart(x: number, y: number, z: number, color: string | undefined, spread: number, delay: number): void {
    const s = this.resetSpec(x + rnd(-0.3, 0.3) * spread, y + rnd(0, 0.3), z + rnd(-0.3, 0.3) * spread, delay + rnd(0, 0.3));
    s.vx = rnd(-0.4, 0.4);
    s.vy = rnd(1.2, 2);
    s.vz = rnd(-0.4, 0.4);
    s.gravity = 0.3;
    s.drag = 1.5;
    s.life = rnd(1, 1.5);
    s.size0 = s.size1 = rnd(0.22, 0.32) * Math.sqrt(spread);
    s.sway = rnd(0.1, 0.22);
    s.swayFreq = rnd(3, 5);
    s.rot = rnd(-0.3, 0.3);
    s.fadeFrom = 0.65;
    s.tile = TILE.heart;
    this.setColor(this.tint(color, "hearts"), rnd(0, 0.25));
    this.commit();
  }

  private smell(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const s = this.resetSpec(x + rnd(-0.12, 0.12), y + 0.1, z + rnd(-0.12, 0.12));
    s.vx = rnd(-0.1, 0.1);
    s.vy = rnd(0.5, 0.8);
    s.vz = rnd(-0.1, 0.1);
    s.drag = 0.5;
    s.life = rnd(1.1, 1.5);
    s.size0 = 0.22 * spread;
    s.size1 = 0.38 * spread;
    s.aspect = 1.6;
    s.rot = rnd(-0.25, 0.25);
    s.sway = rnd(0.06, 0.12);
    s.swayFreq = rnd(3, 4.5);
    s.alpha = 0.75;
    s.fadeFrom = 0.45;
    s.tile = TILE.smell;
    this.setColor(this.tint(color, "smell"), rnd(0, 0.15));
    this.commit();
  }

  private glint(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const d = this.randomDir(0.5);
    const r = 0.12 * spread;
    const s = this.resetSpec(x + d.x * r, y + Math.abs(d.y) * r + 0.05, z + d.z * r);
    s.life = 0.45;
    s.size0 = s.size1 = 0.22 * spread;
    s.curve = CURVE_TWINKLE;
    s.rotVel = rnd(-2, 2);
    s.fadeFrom = 0.5;
    s.tile = TILE.sparkle;
    s.additive = true;
    this.setColor(this.tint(color, "glint"), 0.2);
    this.commit();
  }

  /** Expanding ring (flat on the ground, or camera-facing). Diameter from d0 to d1 meters. */
  private ring(x: number, y: number, z: number, color: THREE.Color, d0: number, d1: number, life: number, delay: number, flat: boolean, alpha = 0.95): void {
    const s = this.resetSpec(x, y, z, delay);
    s.life = life;
    s.size0 = d0;
    s.size1 = d1;
    s.curve = CURVE_EASE_OUT;
    s.alpha = alpha;
    s.fadeFrom = 0.25;
    s.tile = TILE.ring;
    s.mode = flat ? BILLBOARD_FLAT : BILLBOARD_FACING;
    this.setColor(color);
    this.commit();
  }

  /** Tone flashes down (settings.reducedFlashing). */
  setReducedFlashing(on: boolean): void {
    this.flashScale = on ? 0.3 : 1;
  }

  /** Short additive flash (hit punctuation). */
  private flash(x: number, y: number, z: number, color: THREE.Color, tile: TileId, d0: number, d1: number, life: number, mode: BillboardMode = BILLBOARD_FACING, delay = 0): void {
    const s = this.resetSpec(x, y, z, delay);
    s.life = life;
    s.size0 = d0;
    s.size1 = d1;
    s.alpha = 0.9 * this.flashScale;
    s.fadeFrom = 0.2;
    s.tile = tile;
    s.additive = true;
    s.mode = mode;
    this.setColor(color, 0.4);
    this.commit();
  }

  private burstExtras(kind: ParticleKind, pos: Vec3Like, scale: number, color: string | undefined, delay: number): void {
    const white = this.tint(WHITE, "sparkle");
    switch (kind) {
      case "hitStars":
        this.flash(pos.x, pos.y, pos.z, white, TILE.flash, 1.1 * scale, 1.8 * scale, 0.13, BILLBOARD_FACING, delay);
        this.orbitingStars(pos, scale, color, delay);
        return;
      case "bonk":
        this.flash(pos.x, pos.y, pos.z, white, TILE.flash, 1.6 * scale, 2.6 * scale, 0.16, BILLBOARD_FACING, delay);
        this.ring(pos.x, pos.y, pos.z, this.tint(color ?? WHITE, "bonk"), 0.4 * scale, 2.2 * scale, 0.3, delay, false, 0.8);
        for (let i = 0; i < this.countFor(4, scale); i++) this.puff(pos.x, pos.y, pos.z, undefined, scale * 0.8, delay);
        this.orbitingStars(pos, scale * 1.1, color, delay);
        return;
      case "flip":
        this.ring(pos.x, pos.y + 0.05, pos.z, this.tint("#EADBC0", "dust"), 0.4 * scale, 1.8 * scale, 0.45, delay, true, 0.8);
        for (let i = 0; i < this.countFor(4, scale); i++) this.dustPuff(pos.x, pos.y, pos.z, undefined, scale * 0.8, false, delay);
        this.orbitingStars({ x: pos.x, y: pos.y + 0.25, z: pos.z }, scale * 0.9, color, delay);
        return;
      case "sparkle":
      case "gold": {
        const base = this.tint(color ?? (kind === "gold" ? GOLD_LIGHT : undefined), kind);
        this.flash(pos.x, pos.y, pos.z, base, TILE.flash, 0.9 * scale, 1.6 * scale, 0.16, BILLBOARD_FACING, delay);
        this.flash(pos.x, pos.y, pos.z, base, TILE.glow, 1.6 * scale, 0.5 * scale, 0.35, BILLBOARD_FACING, delay);
        return;
      }
      case "blast": {
        // Scale 1 = the puffer's real blast radius, so the ring shows exactly who got hit.
        const radius = PUFFER_BLAST_RADIUS * scale;
        const y = pos.y + 0.06;
        const flashColor = this.tint("#FFF1A8", "blast");
        this.flash(pos.x, pos.y + 0.3, pos.z, flashColor, TILE.flash, radius * 0.8, radius * 2.2, 0.2, BILLBOARD_FACING, delay);
        this.flash(pos.x, pos.y + 0.3, pos.z, flashColor, TILE.glow, radius * 1.6, radius * 0.6, 0.3, BILLBOARD_FACING, delay);
        this.ring(pos.x, y, pos.z, this.tint(color ?? "#FFE27A", "blast"), 0.5, radius * 2.1, 0.42, delay, true);
        this.ring(pos.x, y + 0.01, pos.z, this.tint(WHITE, "blast"), 0.3, radius * 1.6, 0.5, delay + 0.07, true, 0.6);
        for (let i = 0; i < this.countFor(6, 1); i++) this.sparkle(pos.x, pos.y + 0.3, pos.z, color ?? "#FFE27A", radius * 0.5, delay);
        return;
      }
      case "bubbles":
        this.ring(pos.x, pos.y + 0.4, pos.z, this.tint(color, kind), 0.4, 2 * scale, 0.32, delay, false, 0.75);
        return;
      case "splash":
        this.ring(pos.x, pos.y + 0.03, pos.z, this.tint(WHITE, "ripple"), 0.3 * scale, 1.9 * scale, 0.7, delay, true, 0.75);
        this.ring(pos.x, pos.y + 0.03, pos.z, this.tint(WHITE, "ripple"), 0.2 * scale, 1.2 * scale, 0.8, delay + 0.18, true, 0.5);
        for (let i = 0; i < this.countFor(3, scale); i++) this.puff(pos.x, pos.y, pos.z, "#F4FCFF", scale * 0.6, delay);
        return;
      case "embers":
        this.flash(pos.x, pos.y + 0.2, pos.z, this.tint("#FF9A3C", "embers"), TILE.glow, 1.2 * scale, 1.8 * scale, 0.35, BILLBOARD_FACING, delay);
        return;
      case "crabBits":
        for (let i = 0; i < this.countFor(4, scale); i++) this.puff(pos.x, pos.y + 0.1, pos.z, undefined, scale * 0.7, delay);
        return;
      case "hearts":
        this.flash(pos.x, pos.y + 0.3, pos.z, this.tint(color ?? "#FF9EC8", "hearts"), TILE.glow, 1 * scale, 1.6 * scale, 0.3, BILLBOARD_FACING, delay);
        return;
      case "woodChips":
      case "stoneChips":
        for (let i = 0; i < this.countFor(2, scale); i++) this.dustPuff(pos.x, pos.y - 0.1, pos.z, kind === "woodChips" ? "#E9D8B4" : undefined, scale * 0.6, false, delay);
        if (kind === "stoneChips") this.flash(pos.x, pos.y, pos.z, this.tint("#FFF4DC", "stoneChips"), TILE.flash, 0.4 * scale, 0.8 * scale, 0.08, BILLBOARD_FACING, delay);
        return;
      default:
        return;
    }
  }

  /** Cartoon "seeing stars": a few stars circling the hit point for a moment. */
  private orbitingStars(pos: Vec3Like, scale: number, color: string | undefined, delay: number): void {
    const n = 3;
    const base = this.tint(color, "hitStars");
    for (let i = 0; i < n; i++) {
      const s = this.resetSpec(pos.x, pos.y + 0.35, pos.z, delay);
      s.orbitR = 0.45 * scale;
      s.orbitW = 8;
      s.phase = (i / n) * Math.PI * 2;
      s.life = 0.9;
      s.size0 = s.size1 = 0.22;
      s.rotVel = 6;
      s.fadeFrom = 0.6;
      s.tile = TILE.star;
      this.setColor(base, 0.1);
      this.commit();
    }
  }

  /* -------------------------------------------------------------- simulation */

  private runEmitters(dt: number): void {
    for (const [key, e] of this.emitters) {
      e.idle += dt;
      if (e.idle > EMITTER_TIMEOUT_SEC) {
        this.emitters.delete(key);
        continue;
      }
      e.carry += EMIT_RATE[e.kind] * this.quality * Math.min(2, e.scale) * dt;
      if (e.carry < 1) continue;
      if (e.hasDir) this.dir.set(e.dx, e.dy, e.dz);
      else this.dir.set(0, 0, 0);
      while (e.carry >= 1) {
        e.carry -= 1;
        this.spawnMain(e.kind, e.x, e.y, e.z, e.color, e.scale, e.hasDir, Math.floor(Math.random() * 3));
      }
    }
  }

  private simulate(dt: number): void {
    let i = 0;
    while (i < this.live) {
      const age = this.age[i]! + dt;
      this.age[i] = age;
      if (age >= this.life[i]!) {
        this.removeAt(i);
        continue;
      }
      if (age >= 0) this.integrate(i, dt);
      i++;
    }
  }

  private integrate(i: number, dt: number): void {
    this.rot[i]! += this.rotVel[i]! * dt;
    if (this.orbitR[i]! > 0) return;
    const damp = Math.exp(-this.drag[i]! * dt);
    this.vy[i]! += this.gravity[i]! * dt;
    this.vx[i]! *= damp;
    this.vy[i]! *= damp;
    this.vz[i]! *= damp;
    this.px[i]! += this.vx[i]! * dt;
    this.py[i]! += this.vy[i]! * dt;
    this.pz[i]! += this.vz[i]! * dt;
  }

  private removeAt(i: number): void {
    const last = --this.live;
    if (i === last) return;
    for (const arr of this.arrays) arr[i] = arr[last]!;
  }

  /* -------------------------------------------------------------- rendering */

  private draw(): void {
    this.normal.begin();
    this.additive.begin();
    const c = this.scratchColor;
    for (let i = 0; i < this.live; i++) {
      const age = this.age[i]!;
      if (age < 0) continue;
      const t = age / this.life[i]!;
      const size = this.sizeAt(i, age, t);
      if (size <= 0.001) continue;
      const fade = this.fadeFrom[i]!;
      const a = this.alpha[i]! * (t <= fade ? 1 : 1 - (t - fade) / (1 - fade));
      let x = this.px[i]!;
      let y = this.py[i]!;
      let z = this.pz[i]!;
      let rot = this.rot[i]!;
      const orbit = this.orbitR[i]!;
      if (orbit > 0) {
        const ang = this.phase[i]! + this.orbitW[i]! * age;
        x += Math.cos(ang) * orbit;
        z += Math.sin(ang) * orbit;
        y += Math.sin(ang * 2) * 0.08;
      } else if (this.sway[i]! > 0) {
        const wave = Math.sin(this.phase[i]! + age * this.swayFreq[i]!);
        x += wave * this.sway[i]!;
        rot += wave * 0.6;
      }
      let w = size;
      if (this.curve[i] === CURVE_FLIP) w *= 0.25 + 0.75 * Math.abs(Math.cos(this.phase[i]! + age * this.flipFreq[i]!));
      c.setRGB(this.cr[i]!, this.cg[i]!, this.cb[i]!);
      const batch = this.add[i] ? this.additive : this.normal;
      const mode = this.mode[i] as BillboardMode;
      batch.push(x, y, z, w, size * this.aspect[i]!, rot, c, a, this.tileUv[this.tile[i]!]!, mode, this.ax[i], this.ay[i], this.az[i]);
    }
    this.normal.end();
    this.additive.end();
  }

  private sizeAt(i: number, age: number, t: number): number {
    const s0 = this.size0[i]!;
    const s1 = this.size1[i]!;
    switch (this.curve[i]) {
      case CURVE_EASE_OUT: {
        const e = 1 - (1 - t) * (1 - t) * (1 - t);
        return s0 + (s1 - s0) * e;
      }
      case CURVE_TWINKLE:
        return popIn(age) * s0 * (0.55 + 0.45 * Math.sin(this.phase[i]! + age * 22));
      case CURVE_POP_END:
        return popIn(age) * (t < 0.9 ? s0 : s0 * (1 + (t - 0.9) * 6));
      default:
        return popIn(age) * (s0 + (s1 - s0) * t);
    }
  }
}

/** Quick scale-in with a little overshoot so every particle "pops". */
function popIn(age: number): number {
  if (age >= POP_IN_SEC) return 1;
  const k = age / POP_IN_SEC;
  return 0.3 + 0.7 * (1 - (1 - k) * (1 - k)) * (1 + 0.15 * Math.sin(k * Math.PI));
}
