// Pooled particle bursts. Owner: client-fx.

import * as THREE from "three";
import { CHARACTERS, PLAYER_COLORS, POWERUPS } from "../../../shared/constants";
import type { AnimalKind } from "../../../shared/types";
import {
  BILLBOARD_FACING,
  BILLBOARD_FLAT,
  BILLBOARD_STREAK,
  BillboardBatch,
  gridUv,
  type BillboardMode,
} from "./billboard";
import { ATLAS_GRID, TILE, particleAtlas, type TileId } from "./fxTextures";
import type { BurstOptions, ParticleKind } from "./types";

/** Storage for live particles (the effective cap is lower, see setQualityScale). */
const CAPACITY = 900;
/** game1-sized cap at quality scale 1. */
const BASE_LIVE_CAP = 600;
/** A continuous emitter that isn't refreshed for this long stops. */
const EMITTER_TIMEOUT_SEC = 0.1;
/** Scale-in time of a new particle (s). */
const POP_IN_SEC = 0.06;

/** Size-over-life curves. */
const CURVE_LINEAR = 0;
const CURVE_EASE_OUT = 1;
const CURVE_TWINKLE = 2;
/** Width follows |cos| of a flip phase: confetti tumbling in 3D. */
const CURVE_FLIP = 3;
/** Bubbles swell and vanish at the end. */
const CURVE_POP_END = 4;

const DEFAULT_COLORS: Readonly<Record<ParticleKind, string>> = {
  stars: "#FFE14D",
  puff: "#FFFFFF",
  confetti: "#FFFFFF",
  speedLines: "#FFFFFF",
  feathers: "#FFFFFF",
  dust: "#EADBC0",
  crumbs: "#B98A5E",
  sparkles: "#FFE27A",
  shockwave: "#FFFFFF",
  bubbles: "#DDF3FF",
};

/** Particles per second for continuous emitters. */
const EMIT_RATE: Readonly<Record<ParticleKind, number>> = {
  stars: 6,
  puff: 10,
  confetti: 30,
  speedLines: 28,
  feathers: 8,
  dust: 16,
  crumbs: 12,
  sparkles: 14,
  shockwave: 3,
  bubbles: 8,
};

const CONFETTI_COLORS: ReadonlyArray<string> = [...PLAYER_COLORS, "#FFFFFF", POWERUPS.triple.color, POWERUPS.zoomies.color, "#FF9EC8"];
const STAR_WHITE = "#FFFFFF";
const PEBBLE_COLOR = "#9C8A73";

/** Body/secondary colors → animal, so a "feathers" burst can pick feathers (birds) or fur tufts. */
const ANIMAL_BY_COLOR: ReadonlyMap<string, AnimalKind> = (() => {
  const map = new Map<string, AnimalKind>();
  for (const def of Object.values(CHARACTERS)) {
    for (const c of [def.colors.body, def.colors.secondary]) {
      if (!map.has(c.toUpperCase())) map.set(c.toUpperCase(), def.animal);
    }
  }
  return map;
})();

function featherTileFor(color: string | undefined): TileId {
  if (!color) return TILE.feather;
  const animal = ANIMAL_BY_COLOR.get(color.toUpperCase());
  return animal === undefined || animal === "duck" || animal === "penguin" ? TILE.feather : TILE.fur;
}

function rnd(min: number, max: number): number {
  return min + Math.random() * (max - min);
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

/**
 * Cheap pooled sprites/instanced quads (softDotTexture + simple procedural star/feather/confetti
 * shapes drawn on canvas), additive or alpha-blended per kind, gravity/drag per kind. Hard cap
 * ~600 live particles (fewer on low quality).
 *
 * Implementation: struct-of-arrays pool simulated on the CPU, drawn as two instanced billboard
 * batches (alpha-blended and additive) over one canvas atlas (fxTextures.particleAtlas).
 */
export class Particles {
  private readonly normal: BillboardBatch;
  private readonly additive: BillboardBatch;
  private live = 0;
  private liveCap = BASE_LIVE_CAP;
  private quality = 1;
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

  constructor(scene: THREE.Scene) {
    const map = particleAtlas();
    this.normal = new BillboardBatch(scene, { name: "fx-particles", capacity: CAPACITY, map, renderOrder: 3 });
    this.additive = new BillboardBatch(scene, {
      name: "fx-particles-add",
      capacity: CAPACITY,
      map,
      additive: true,
      renderOrder: 4,
    });
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

  burst(kind: ParticleKind, pos: { x: number; y: number; z: number }, opts?: BurstOptions): void {
    const scale = Math.max(0.05, opts?.scale ?? 1);
    const color = opts?.color;
    const dir = opts?.dir;
    const hasDir = !!dir && dir.x * dir.x + dir.y * dir.y + dir.z * dir.z > 1e-8;
    if (hasDir) this.dir.set(dir.x, dir.y, dir.z).normalize();
    else this.dir.set(0, 0, 0);
    if (kind === "shockwave") {
      this.shockwave(pos, scale, color);
      return;
    }
    const n = this.countFor(BURST_COUNT[kind], scale);
    for (let i = 0; i < n; i++) this.spawnMain(kind, pos.x, pos.y, pos.z, color, scale, hasDir, i);
    this.burstExtras(kind, pos, scale, color);
  }

  /**
   * Continuous emitter following a target (speed lines while zoomies/dashing, dust skid while
   * stunned on the ground). Call every frame with on = true; stops when not refreshed for 0.1 s.
   */
  emit(key: string, kind: ParticleKind, pos: { x: number; y: number; z: number }, opts?: BurstOptions): void {
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
    const key = hex ?? DEFAULT_COLORS[kind];
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

  private resetSpec(x: number, y: number, z: number): SpawnSpec {
    const s = this.spec;
    s.x = x;
    s.y = y;
    s.z = z;
    s.vx = s.vy = s.vz = 0;
    s.age = 0;
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
  private spawnMain(kind: ParticleKind, x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, index: number): void {
    switch (kind) {
      case "stars":
        return this.star(x, y, z, color, spread, hasDir, index);
      case "puff":
        return this.puff(x, y, z, color, spread);
      case "confetti":
        return this.confettiPiece(x, y, z, color, spread);
      case "speedLines":
        return this.speedLine(x, y, z, color, spread, hasDir);
      case "feathers":
        return this.feather(x, y, z, color, spread, index);
      case "dust":
        return this.dustPuff(x, y, z, color, spread, hasDir);
      case "crumbs":
        return this.crumb(x, y, z, color, spread);
      case "sparkles":
        return this.sparkle(x, y, z, color, spread);
      case "shockwave":
        return this.ring(x, y + 0.06, z, this.tint(color, kind), 0.4, spread * 2, 0.4, 0, true);
      case "bubbles":
        return this.bubble(x, y, z, color, spread);
    }
  }

  private star(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean, index: number): void {
    const s = this.resetSpec(x, y, z);
    const d = this.randomDir(0.55);
    const speed = rnd(3, 5.5) * spread;
    s.vx = d.x * speed + (hasDir ? this.dir.x * 2.5 : 0);
    s.vy = Math.abs(d.y) * speed + 1.5;
    s.vz = d.z * speed + (hasDir ? this.dir.z * 2.5 : 0);
    s.gravity = -11;
    s.drag = 2.2;
    s.life = rnd(0.5, 0.75);
    s.size0 = rnd(0.3, 0.42);
    s.size1 = 0.06;
    s.rotVel = rnd(-9, 9);
    s.fadeFrom = 0.65;
    s.tile = TILE.star;
    const pick = index % 3;
    this.setColor(this.tint(pick === 2 ? color : pick === 1 ? STAR_WHITE : undefined, "stars"), pick === 1 ? 0 : 0.05);
    this.commit();
  }

  private puff(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const s = this.resetSpec(x + rnd(-0.2, 0.2) * spread, y + rnd(0, 0.25), z + rnd(-0.2, 0.2) * spread);
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
    this.setColor(this.tint(color, "puff"), color ? 0.35 : 0);
    this.commit();
  }

  private confettiPiece(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const s = this.resetSpec(x + rnd(-0.3, 0.3), y, z + rnd(-0.3, 0.3));
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
    const pick = color && Math.random() < 0.4 ? color : CONFETTI_COLORS[Math.floor(Math.random() * CONFETTI_COLORS.length)];
    this.setColor(this.tint(pick, "confetti"));
    this.commit();
  }

  private speedLine(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean): void {
    const dx = hasDir ? this.dir.x : 0;
    const dy = hasDir ? this.dir.y : 0;
    const dz = hasDir ? this.dir.z : 1;
    // Random offset in the plane perpendicular to the trail direction.
    const r = this.randomDir(0);
    const along = r.x * dx + r.y * dy + r.z * dz;
    r.set(r.x - along * dx, r.y - along * dy, r.z - along * dz);
    if (r.lengthSq() < 1e-6) r.set(0, 1, 0);
    r.normalize().multiplyScalar(rnd(0.25, 0.7) * spread);
    const back = rnd(-0.3, 0.3);
    const s = this.resetSpec(x + r.x + dx * back, y + r.y * 0.8 + dy * back, z + r.z + dz * back);
    const speed = rnd(6, 9);
    s.vx = dx * speed;
    s.vy = dy * speed;
    s.vz = dz * speed;
    s.life = rnd(0.16, 0.26);
    s.size0 = rnd(0.6, 1.1);
    s.size1 = s.size0 * 0.6;
    s.aspect = rnd(0.05, 0.09) / s.size0;
    s.rot = 0;
    s.alpha = 0.9;
    s.fadeFrom = 0.3;
    s.tile = TILE.streak;
    s.mode = BILLBOARD_STREAK;
    // The streak's bright head points along the motion (opposite the trail).
    s.ax = -dx;
    s.ay = -dy;
    s.az = -dz;
    this.setColor(this.tint(color, "speedLines"), color ? 0.45 : 0);
    this.commit();
  }

  private feather(x: number, y: number, z: number, color: string | undefined, spread: number, index: number): void {
    const s = this.resetSpec(x + rnd(-0.15, 0.15), y + rnd(0, 0.4), z + rnd(-0.15, 0.15));
    const d = this.randomDir(0.4);
    const speed = rnd(2.5, 5) * spread;
    s.vx = d.x * speed;
    s.vy = Math.abs(d.y) * speed + 2;
    s.vz = d.z * speed;
    s.gravity = -3.2;
    s.drag = 2.6;
    s.life = rnd(1.4, 2.1);
    s.size0 = rnd(0.26, 0.36);
    s.size1 = s.size0 * 0.85;
    s.sway = rnd(0.25, 0.45);
    s.swayFreq = rnd(2.2, 3.4);
    s.rotVel = rnd(-2, 2);
    s.fadeFrom = 0.7;
    s.tile = featherTileFor(color);
    this.setColor(this.tint(color, "feathers"), index % 2 === 0 ? 0 : 0.35);
    this.commit();
  }

  private dustPuff(x: number, y: number, z: number, color: string | undefined, spread: number, hasDir: boolean): void {
    const a = Math.random() * Math.PI * 2;
    const r = rnd(0, 0.35) * spread;
    const s = this.resetSpec(x + Math.cos(a) * r, y + 0.12, z + Math.sin(a) * r);
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

  private crumb(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const s = this.resetSpec(x + rnd(-0.3, 0.3) * spread, y + rnd(0, 0.2), z + rnd(-0.3, 0.3) * spread);
    const d = this.randomDir(0);
    const speed = rnd(1, 3) * spread;
    s.vx = d.x * speed;
    s.vy = rnd(2, 4.5);
    s.vz = d.z * speed;
    s.gravity = -18;
    s.drag = 0.6;
    s.life = rnd(0.9, 1.4);
    s.size0 = s.size1 = rnd(0.13, 0.24) * Math.sqrt(spread);
    s.rotVel = rnd(-10, 10);
    s.fadeFrom = 0.7;
    s.tile = Math.random() < 0.7 ? TILE.crumb : TILE.chip;
    this.setColor(this.tint(color, "crumbs"), rnd(-0.18, 0.15));
    this.commit();
  }

  private sparkle(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const d = this.randomDir(0);
    const r = rnd(0.1, 0.55) * spread;
    const s = this.resetSpec(x + d.x * r, y + d.y * r + 0.1, z + d.z * r);
    s.vx = d.x * 0.6;
    s.vy = rnd(0.6, 1.6);
    s.vz = d.z * 0.6;
    s.gravity = 0.4;
    s.drag = 1.8;
    s.life = rnd(0.45, 0.9);
    s.size0 = s.size1 = rnd(0.2, 0.34);
    s.curve = CURVE_TWINKLE;
    s.rotVel = rnd(-3, 3);
    s.fadeFrom = 0.55;
    s.tile = TILE.sparkle;
    s.additive = true;
    this.setColor(this.tint(color, "sparkles"), rnd(0, 0.5));
    this.commit();
  }

  private bubble(x: number, y: number, z: number, color: string | undefined, spread: number): void {
    const d = this.randomDir(0);
    const r = rnd(0.1, 0.5) * spread;
    const s = this.resetSpec(x + d.x * r, y + d.y * r * 0.6 + 0.2, z + d.z * r);
    s.vx = d.x * 0.8;
    s.vy = rnd(0.8, 1.8);
    s.vz = d.z * 0.8;
    s.gravity = 1;
    s.drag = 1.4;
    s.sway = rnd(0.15, 0.3);
    s.swayFreq = rnd(3, 5);
    s.life = rnd(0.8, 1.4);
    s.size0 = s.size1 = rnd(0.12, 0.28);
    s.curve = CURVE_POP_END;
    s.alpha = 0.95;
    s.fadeFrom = 0.92;
    s.tile = TILE.bubble;
    this.setColor(this.tint(color, "bubbles"), color ? 0.5 : 0);
    this.commit();
  }

  /** Expanding ring (flat on the ground, or camera-facing). Diameter from d0 to d1 meters. */
  private ring(x: number, y: number, z: number, color: THREE.Color, d0: number, d1: number, life: number, delay: number, flat: boolean, alpha = 0.95): void {
    const s = this.resetSpec(x, y, z);
    s.age = -delay;
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

  /** Short additive flash (hit/catch punctuation). */
  private flash(x: number, y: number, z: number, color: THREE.Color, tile: TileId, d0: number, d1: number, life: number, mode: BillboardMode = BILLBOARD_FACING): void {
    const s = this.resetSpec(x, y, z);
    s.life = life;
    s.size0 = d0;
    s.size1 = d1;
    s.alpha = 0.9;
    s.fadeFrom = 0.2;
    s.tile = tile;
    s.additive = true;
    s.mode = mode;
    this.setColor(color, 0.4);
    this.commit();
  }

  private burstExtras(kind: ParticleKind, pos: { x: number; y: number; z: number }, scale: number, color: string | undefined): void {
    const white = this.tint(STAR_WHITE, kind);
    if (kind === "stars") {
      this.flash(pos.x, pos.y, pos.z, white, TILE.flash, 1.2 * scale, 1.9 * scale, 0.13);
      this.orbitingStars(pos, scale, color);
    } else if (kind === "sparkles") {
      const base = this.tint(color, kind);
      this.flash(pos.x, pos.y, pos.z, base, TILE.flash, 0.9 * scale, 1.5 * scale, 0.15);
      this.flash(pos.x, pos.y, pos.z, base, TILE.glow, 1.5 * scale, 0.5 * scale, 0.3);
    } else if (kind === "bubbles") {
      this.ring(pos.x, pos.y + 0.6, pos.z, this.tint(color, kind), 0.5, 2.6 * scale, 0.32, 0, false, 0.85);
    } else if (kind === "puff") {
      this.flash(pos.x, pos.y + 0.2, pos.z, white, TILE.glow, 1.4 * scale, 0.4, 0.2);
    }
  }

  /** Cartoon "seeing stars": a few stars circling the hit point for a moment. */
  private orbitingStars(pos: { x: number; y: number; z: number }, scale: number, color: string | undefined): void {
    const n = 3;
    const base = this.tint(color, "stars");
    for (let i = 0; i < n; i++) {
      const s = this.resetSpec(pos.x, pos.y + 0.35, pos.z);
      s.orbitR = 0.5 * scale;
      s.orbitW = 8;
      s.phase = (i / n) * Math.PI * 2;
      s.life = 0.85;
      s.size0 = s.size1 = 0.24;
      s.rotVel = 6;
      s.fadeFrom = 0.6;
      s.tile = TILE.star;
      this.setColor(base, 0.1);
      this.commit();
    }
  }

  /** Ground Pound: flat expanding rings + dust thrown outward + pebbles. `radius` in meters. */
  private shockwave(pos: { x: number; y: number; z: number }, radius: number, color: string | undefined): void {
    const ringColor = this.tint(color, "shockwave");
    const y = pos.y + 0.06;
    this.ring(pos.x, y, pos.z, ringColor, 0.6, radius * 2.15, 0.42, 0, true);
    this.ring(pos.x, y + 0.01, pos.z, ringColor, 0.3, radius * 1.7, 0.5, 0.07, true, 0.6);
    this.flash(pos.x, y + 0.02, pos.z, ringColor, TILE.glow, radius * 1.2, radius * 0.6, 0.18, BILLBOARD_FLAT);
    const dustColor = this.tint(undefined, "dust");
    const puffs = this.countFor(14, 1);
    for (let i = 0; i < puffs; i++) {
      const a = (i / puffs) * Math.PI * 2 + rnd(-0.15, 0.15);
      const s = this.resetSpec(pos.x + Math.cos(a) * 0.4, y + 0.1, pos.z + Math.sin(a) * 0.4);
      const speed = (radius / 0.4) * rnd(0.8, 1.1);
      s.vx = Math.cos(a) * speed;
      s.vy = rnd(0.4, 1.2);
      s.vz = Math.sin(a) * speed;
      s.drag = 3;
      s.gravity = 0.4;
      s.life = rnd(0.45, 0.6);
      s.size0 = 0.35;
      s.size1 = 0.9;
      s.curve = CURVE_EASE_OUT;
      s.alpha = 0.85;
      s.fadeFrom = 0.3;
      s.tile = TILE.dust;
      this.setColor(dustColor);
      this.commit();
    }
    const pebbles = this.countFor(8, 1);
    for (let i = 0; i < pebbles; i++) this.crumb(pos.x, pos.y, pos.z, PEBBLE_COLOR, radius / 3);
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
      const age = this.age[i] + dt;
      this.age[i] = age;
      if (age >= this.life[i]) {
        this.removeAt(i);
        continue;
      }
      if (age >= 0) this.integrate(i, dt);
      i++;
    }
  }

  private integrate(i: number, dt: number): void {
    this.rot[i] += this.rotVel[i] * dt;
    // Orbiting particles are placed analytically in draw().
    if (this.orbitR[i] > 0) return;
    const damp = Math.exp(-this.drag[i] * dt);
    this.vy[i] += this.gravity[i] * dt;
    this.vx[i] *= damp;
    this.vy[i] *= damp;
    this.vz[i] *= damp;
    this.px[i] += this.vx[i] * dt;
    this.py[i] += this.vy[i] * dt;
    this.pz[i] += this.vz[i] * dt;
  }

  private removeAt(i: number): void {
    const last = --this.live;
    if (i === last) return;
    for (const arr of this.arrays) arr[i] = arr[last];
  }

  /* -------------------------------------------------------------- rendering */

  private draw(): void {
    this.normal.begin();
    this.additive.begin();
    const c = this.scratchColor;
    for (let i = 0; i < this.live; i++) {
      const age = this.age[i];
      if (age < 0) continue;
      const t = age / this.life[i];
      const size = this.sizeAt(i, age, t);
      if (size <= 0.001) continue;
      const fade = this.fadeFrom[i];
      const a = this.alpha[i] * (t <= fade ? 1 : 1 - (t - fade) / (1 - fade));
      let x = this.px[i];
      let y = this.py[i];
      let z = this.pz[i];
      let rot = this.rot[i];
      const orbit = this.orbitR[i];
      if (orbit > 0) {
        const ang = this.phase[i] + this.orbitW[i] * age;
        x += Math.cos(ang) * orbit;
        z += Math.sin(ang) * orbit;
        y += Math.sin(ang * 2) * 0.08;
      } else if (this.sway[i] > 0) {
        const wave = Math.sin(this.phase[i] + age * this.swayFreq[i]);
        x += wave * this.sway[i];
        rot += wave * 0.6;
      }
      let w = size;
      if (this.curve[i] === CURVE_FLIP) w *= 0.25 + 0.75 * Math.abs(Math.cos(this.phase[i] + age * this.flipFreq[i]));
      c.setRGB(this.cr[i], this.cg[i], this.cb[i]);
      const batch = this.add[i] ? this.additive : this.normal;
      const mode = this.mode[i] as BillboardMode;
      batch.push(x, y, z, w, size * this.aspect[i], rot, c, a, this.tileUv[this.tile[i]], mode, this.ax[i], this.ay[i], this.az[i]);
    }
    this.normal.end();
    this.additive.end();
  }

  private sizeAt(i: number, age: number, t: number): number {
    const s0 = this.size0[i];
    const s1 = this.size1[i];
    switch (this.curve[i]) {
      case CURVE_EASE_OUT: {
        const e = 1 - (1 - t) * (1 - t) * (1 - t);
        return s0 + (s1 - s0) * e;
      }
      case CURVE_TWINKLE:
        return popIn(age) * s0 * (0.55 + 0.45 * Math.sin(this.phase[i] + age * 22));
      case CURVE_POP_END:
        return popIn(age) * (t < 0.9 ? s0 : s0 * (1 + (t - 0.9) * 6));
      default:
        return popIn(age) * (s0 + (s1 - s0) * t);
    }
  }
}

/** Main-body particle count per burst at scale 1. */
const BURST_COUNT: Readonly<Record<ParticleKind, number>> = {
  stars: 7,
  puff: 8,
  confetti: 46,
  speedLines: 10,
  feathers: 14,
  dust: 7,
  crumbs: 16,
  sparkles: 10,
  shockwave: 1,
  bubbles: 10,
};

/** Quick scale-in with a little overshoot so every particle "pops". */
function popIn(age: number): number {
  if (age >= POP_IN_SEC) return 1;
  const k = age / POP_IN_SEC;
  return 0.3 + 0.7 * (1 - (1 - k) * (1 - k)) * (1 + 0.15 * Math.sin(k * Math.PI));
}
