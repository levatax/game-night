// KASALA's pooled 3D particles and screen-space game feel. Owner: client-cards-fx.
//
// - Particles: fixed instanced pools (bills, coins, chips, confetti, glass, moths) and spark billboards, all
//   built at construction (hidden) so Stage.prewarm compiles their programs before the first big moment.
//   Money, confetti and glass fall onto the felt (or the floor past the rim) and come to rest there: coins and
//   shards bounce, bills and confetti flutter down slowly and lie flat, then everything fades. In first person
//   nothing rains into the eye: rain near the eye spawns lower and away from it, and anything that drifts
//   into the eye's personal space fades out.
// - Chips: staggered tosses from A to B that land with a squash and a glint (§14 "fişler yığına uçar").
// - Screen layer: slam (the one big title for KASALA / BASKIN / JACKPOT-class moments — Game decides when;
//   one at a time, upper third, short, with a readable sub-line), float texts anchored to the world (a few at
//   a time, positioned before they are shown, kept inside a safe area with an edge arrow when their anchor is
//   off-screen or behind the camera), and a short color flash. Tints (siren vignette, final-table tint,
//   rarity edge glow) live in the tint layer under the HUD.
// - Reduced flashing (settings) calms the slam pop, flash, edge glow and siren pulse.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import { settings } from "../app/settings";
import { TABLE_RADIUS, TABLE_TOP_Y, type Stage } from "./Stage";
import { toon } from "./toon";
import { Pool } from "./fx/Pool";
import { SPARK_DOT, SPARK_GLOW, SPARK_SMOKE, SPARK_STAR, Sparks } from "./fx/Sparks";
import { banknoteTexture, chipTextures } from "./fx/textures";
import { clamp, clamp01, easeInOutSine, easeOutBack, rand, smoothstep, surfaceY } from "./fx/util";
import "./fx.css";

type ParticleKind = "bill" | "coin" | "chip" | "confetti" | "glass" | "moth";
const KINDS: readonly ParticleKind[] = ["bill", "coin", "chip", "confetti", "glass", "moth"];

/** Pool states: 1 flying free, 2 chip flight, 3 resting on a surface, 4 chip landing squash. */
const FLYING = 1;
const FLIGHT = 2;
const RESTING = 3;
const ARRIVED = 4;

const MAX_FLOATS = 5;
const FLOAT_SEC = 1.35;
const SLAM_SEC = 1.1;
const SLAM_SUB_EXTRA = 0.45;
const SLAM_OUT_SEC = 0.2;
/** A newer slam waits until the current one has been up this long. */
const SLAM_MIN_SEC = 0.55;
/** Safe area for floats, in NDC (clear of the top bar and the bottom action bar). */
const SAFE_X = 0.88;
const SAFE_TOP = 0.78;
const SAFE_BOTTOM = -0.6;
/** First person: particles fade out inside this radius around the eye (m). */
const KEEP_OUT = 0.5;
const CHIP_LAND_SEC = 0.14;

interface FloatSlot {
  el: HTMLDivElement;
  active: boolean;
  at: THREE.Vector3;
  getter: (() => THREE.Vector3 | null) | null;
  text: string;
  born: number;
  /** Extra lift (px) so floats spawned at the same spot stack instead of overlapping. */
  stack: number;
  x: number;
  y: number;
  edge: string;
  transform: string;
  opacity: string;
}

interface ScreenPoint {
  x: number;
  y: number;
  /** "" on screen, else the side of the screen the anchor is off toward ("l" | "r" | "t" | "b"). */
  edge: string;
}

interface SlamSpec {
  text: string;
  color: string;
  sub: string;
}

const now = () => performance.now() / 1000;
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _vel = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _pt: ScreenPoint = { x: 0, y: 0, edge: "" };

const POP_IN: Keyframe[] = [
  { opacity: 0, transform: "scale(1.55, 0.55)" },
  { opacity: 1, transform: "scale(0.94, 1.06)", offset: 0.6 },
  { opacity: 1, transform: "none" },
];
const CALM_IN: Keyframe[] = [
  { opacity: 0, transform: "scale(0.97)" },
  { opacity: 1, transform: "none" },
];
const SUB_IN: Keyframe[] = [
  { opacity: 0, transform: "translateY(0.5rem)" },
  { opacity: 1, transform: "none" },
];
const SLAM_OUT: Keyframe[] = [
  { opacity: 1, transform: "none" },
  { opacity: 0, transform: "translateY(-0.6rem) scale(0.96)" },
];

function node(tag: string, cls: string, parent: HTMLElement): HTMLDivElement {
  const el = document.createElement(tag) as HTMLDivElement;
  el.className = cls;
  parent.appendChild(el);
  return el;
}

export class Fx {
  private readonly stage: Stage;
  private readonly layer: HTMLElement;
  private readonly pools: Record<ParticleKind, Pool>;
  private readonly sparks: Sparks;
  private readonly soft: Sparks;
  private readonly flashEl: HTMLDivElement;
  private readonly edgeEl: HTMLDivElement;
  private readonly vignetteEl: HTMLDivElement;
  private readonly finalEl: HTMLDivElement;
  private readonly slamEl: HTMLDivElement;
  private readonly slamMain: HTMLDivElement;
  private readonly slamSub: HTMLDivElement;
  private readonly floats: FloatSlot[] = [];
  // chip flights, by chip-pool slot (no per-flight objects)
  private readonly flightFrom: Float32Array;
  private readonly flightTo: Float32Array;
  /** Absolute start time (s) of each chip's toss (64-bit: performance.now() grows large). */
  private readonly flightBorn: Float64Array;
  private readonly flightDur: Float32Array;
  private readonly flightArc: Float32Array;
  private freezeUntil = 0;
  private flashUntil = 0;
  private flashBorn = 0;
  private flashStrength = 0;
  private edgeUntil = 0;
  private edgeBorn = 0;
  private edgeDuration = 0;
  private edgePeak = 0;
  private siren = 0;
  private finalTable = false;
  private slamState: "idle" | "in" | "out" = "idle";
  private slamShownAt = 0;
  private slamUntil = 0;
  private slamPending: SlamSpec | null = null;
  private slamAnims: Animation[] = [];
  // last written DOM values (skip identical writes)
  /** OS "reduce motion" (the slam then fades in instead of popping, like reduced flashing). */
  private readonly reduceMotion: MediaQueryList | null =
    typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  private flashOp = "0";
  private edgeOp = "0";
  private vignetteOp = "0";
  private finalOp = "0";

  /** `tintLayer` (under the HUD) gets the vignette, final-table tint and edge glow; slams, floats and flashes stay in `layer`. */
  constructor(stage: Stage, layer: HTMLElement, tintLayer?: HTMLElement) {
    this.stage = stage;
    this.layer = layer;
    const tints = tintLayer ?? layer;
    const chipTexture = chipTextures();
    const make = (kind: ParticleKind, geo: THREE.BufferGeometry, mat: THREE.Material, count: number) =>
      new Pool(stage.world, geo, mat, count, `fx-${kind}`);
    const billGeo = new THREE.PlaneGeometry(0.13, 0.07);
    const noteMat = new THREE.MeshBasicMaterial({ map: banknoteTexture(), color: PALETTE.money, side: THREE.DoubleSide });
    const coinGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.006, 10);
    const chipGeo = new THREE.CylinderGeometry(0.045, 0.045, 0.012, 12);
    const confGeo = new THREE.PlaneGeometry(0.042, 0.025);
    const shardGeo = new THREE.TetrahedronGeometry(0.035, 0);
    const mothGeo = new THREE.PlaneGeometry(0.055, 0.03);
    this.pools = {
      bill: make("bill", billGeo, noteMat, 190),
      // toon, like the rest of the room (no one-off PBR program at the first money rain)
      coin: make("coin", coinGeo, toon(PALETTE.gold, { unique: true, emissive: "#6A4800", emissiveIntensity: 0.7 }), 130),
      chip: make("chip", chipGeo, new THREE.MeshBasicMaterial({ map: chipTexture.map, color: "#FFFFFF" }), 180),
      confetti: make("confetti", confGeo, new THREE.MeshBasicMaterial({ color: "#FFFFFF", side: THREE.DoubleSide }), 230),
      glass: make("glass", shardGeo, new THREE.MeshBasicMaterial({ color: "#A8D7DC", transparent: true, opacity: 0.7, side: THREE.DoubleSide }), 120),
      moth: make("moth", mothGeo, new THREE.MeshBasicMaterial({ color: "#C9BC9E", side: THREE.DoubleSide, transparent: true, opacity: 0.8 }), 50),
    };
    const cap = this.pools.chip.cap;
    this.flightFrom = new Float32Array(cap * 3);
    this.flightTo = new Float32Array(cap * 3);
    this.flightBorn = new Float64Array(cap);
    this.flightDur = new Float32Array(cap);
    this.flightArc = new Float32Array(cap);
    this.sparks = new Sparks(stage.world, 350, true, "fx-sparks");
    this.soft = new Sparks(stage.world, 180, false, "fx-soft");

    this.finalEl = node("div", "ks-fx-final", tints);
    this.vignetteEl = node("div", "ks-fx-vignette", tints);
    this.edgeEl = node("div", "ks-fx-edge", tints);
    for (let i = 0; i < MAX_FLOATS; i++) {
      const el = node("div", "ks-fx-float", layer);
      el.style.display = "none";
      this.floats.push({ el, active: false, at: new THREE.Vector3(), getter: null, text: "", born: 0, stack: 0, x: 0, y: 0, edge: "", transform: "", opacity: "" });
    }
    this.slamEl = node("div", "ks-fx-slam", layer);
    this.slamMain = node("div", "ks-fx-slam-main", this.slamEl);
    this.slamSub = node("div", "ks-fx-slam-sub", this.slamEl);
    this.flashEl = node("div", "ks-fx-flash", layer);
    this.flashEl.style.opacity = "0";
    this.edgeEl.style.opacity = "0";
    this.vignetteEl.style.opacity = "0";
    this.finalEl.style.opacity = "0";
    this.slamEl.style.display = "none";
  }

  timeScale(): number { return now() < this.freezeUntil ? 0 : 1; }
  freeze(sec: number): void { this.freezeUntil = Math.max(this.freezeUntil, now() + Math.max(0, sec)); }

  flash(color = "#FFFFFF", strength = 1): void {
    this.flashEl.style.background = color;
    this.flashStrength = clamp01(strength) * (settings.get().reducedFlashing ? 0.3 : 0.85);
    this.flashBorn = now();
    this.flashUntil = this.flashBorn + 0.32;
    this.flashOp = this.flashStrength.toFixed(3);
    this.flashEl.style.opacity = this.flashOp;
  }

  /** A soft frame of `color` around the scene (rare+ cards), fading over `sec`. */
  edgeGlow(color: string, sec: number): void {
    this.edgeEl.style.setProperty("--ks-fx-color", color);
    this.edgeBorn = now();
    this.edgeDuration = Math.max(0.1, sec);
    this.edgeUntil = this.edgeBorn + this.edgeDuration;
    this.edgePeak = settings.get().reducedFlashing ? 0.2 : 0.5;
  }

  setSirenPulse(level: number): void { this.siren = clamp01(level); }
  setFinalTable(on: boolean): void { this.finalTable = on; }

  /** The big title (one at a time; a newer one waits until the current has been readable for a moment). */
  slam(text: string, color: string, sub?: string): void {
    const spec: SlamSpec = { text, color, sub: sub ?? "" };
    if (this.slamState === "in" && now() - this.slamShownAt < SLAM_MIN_SEC) {
      this.slamPending = spec;
      return;
    }
    this.slamPending = null;
    this.showSlam(spec);
  }

  /** Float `text` at a world point (or a getter followed every frame, e.g. a walking character's head). */
  floatText(at: THREE.Vector3 | (() => THREE.Vector3 | null), text: string, color: string): void {
    const clock = now();
    const getter = typeof at === "function" ? at : null;
    const point = getter ? getter() : (at as THREE.Vector3);
    if (!point) return;
    this.syncCamera();
    this.project(point, _pt);
    // the same news twice at once is told once
    for (const f of this.floats) {
      if (f.active && f.text === text && clock - f.born < 0.35 && Math.abs(f.x - _pt.x) < 80 && Math.abs(f.y - _pt.y) < 80) return;
    }
    // a free slot, else retire the oldest
    let slot: FloatSlot | null = null;
    for (const f of this.floats) if (!f.active) { slot = f; break; }
    if (!slot) {
      slot = this.floats[0]!;
      for (const f of this.floats) if (f.born < slot.born) slot = f;
    }
    // stack over young floats that spawned near the same spot
    const h = this.stage.canvasRect().height || window.innerHeight;
    let stack = 0;
    for (const f of this.floats) {
      if (!f.active || f === slot || clock - f.born > 0.7) continue;
      if (Math.abs(f.x - _pt.x) < 110 && Math.abs(f.y - _pt.y) < 70) stack = Math.max(stack, f.stack + h * 0.05);
    }
    slot.active = true;
    slot.getter = getter;
    slot.at.copy(point);
    slot.text = text;
    slot.born = clock;
    slot.stack = stack;
    slot.x = _pt.x;
    slot.y = _pt.y;
    slot.transform = "";
    slot.opacity = "";
    const el = slot.el;
    // a reused slot (or a retired one still on screen) must not keep its previous anchor's edge arrow
    slot.edge = "";
    delete el.dataset.edge;
    el.textContent = text;
    el.style.color = color;
    // placed (and transparent) before it is shown: never a frame at 0,0
    this.placeFloat(slot, 0, h);
    el.style.display = "block";
  }

  private spawn(kind: ParticleKind, at: THREE.Vector3, velocity: THREE.Vector3, life: number, color: string, scale = 1): number {
    const p = this.pools[kind];
    const i = p.alloc();
    p.set(i, at.x, at.y, at.z, velocity.x, velocity.y, velocity.z, scale, scale, scale, life);
    p.spin(i, rand(-1, 1), rand(-1, 1), rand(-1, 1), rand(-7, 7), rand(-7, 7), rand(-7, 7));
    p.color(i, color);
    p.write(i, 1);
    return i;
  }

  /** Bills and coins raining onto (and settling on) the felt around `at`. */
  moneyRain(at: THREE.Vector3, amount: number): void {
    const near = this.nearEye(at);
    let n = clamp(Math.round(10 + Math.sqrt(Math.max(0, amount)) * 2.2), 12, 64);
    // center, spread and height (lower, smaller and pushed away from a first-person eye that is close by)
    let cx = at.x;
    let cz = at.z;
    let spread = 0.34;
    let low = 0.35;
    let top = 1.25;
    if (near > 0) {
      n = Math.round(n * (1 - 0.4 * near));
      _q.copy(at).sub(_eye).setY(0);
      if (_q.lengthSq() > 1e-6) _q.normalize();
      cx += _q.x * 0.3 * near;
      cz += _q.z * 0.3 * near;
      spread -= 0.12 * near;
      low = 0.22;
      top = Math.max(0.45, Math.min(top, _eye.y - at.y - 0.3));
    }
    for (let j = 0; j < n; j++) {
      const a = rand(0, Math.PI * 2);
      const r = Math.sqrt(Math.random()) * spread;
      _p.set(cx + Math.cos(a) * r, at.y + rand(low, top), cz + Math.sin(a) * r);
      this.keepOnTable(_p);
      _vel.set(rand(-0.25, 0.25), rand(0.15, near > 0 ? 0.5 : 0.9), rand(-0.25, 0.25));
      this.spawn(j % 4 === 0 ? "coin" : "bill", _p, _vel, rand(1.6, 2.8), "#FFFFFF", rand(0.75, 1.2));
    }
    this.burstSparks(at, Math.min(24, n / 2), PALETTE.gold);
  }

  /** `count` chips tossed one after another from `from` to `to`; resolves when the last one has landed. */
  chips(from: THREE.Vector3, to: THREE.Vector3, count: number, color: string): Promise<void> {
    const n = clamp(Math.round(count), 0, 40);
    if (!n) return Promise.resolve();
    const start = now();
    const p = this.pools.chip;
    const stagger = Math.min(0.03, 0.6 / n);
    let last = 0;
    for (let j = 0; j < n; j++) {
      const i = p.alloc();
      const k = i * 3;
      const ox = from.x + rand(-0.06, 0.06);
      const oy = from.y + rand(0, 0.06);
      const oz = from.z + rand(-0.06, 0.06);
      this.flightFrom[k] = ox;
      this.flightFrom[k + 1] = oy;
      this.flightFrom[k + 2] = oz;
      this.flightTo[k] = to.x + rand(-0.05, 0.05);
      this.flightTo[k + 1] = to.y + rand(0, 0.05);
      this.flightTo[k + 2] = to.z + rand(-0.05, 0.05);
      const delay = j * stagger;
      const dur = 0.46 + rand(0, 0.08);
      this.flightBorn[i] = start + delay;
      this.flightDur[i] = dur;
      this.flightArc[i] = rand(0.22, 0.42);
      last = Math.max(last, delay + dur);
      p.set(i, ox, oy, oz, 0, 0, 0, 1, 1, 1, 0);
      p.state[i] = FLIGHT;
      p.color(i, color);
      p.write(i, 0);
    }
    // Settlement choreography awaits this promise; resolve even when rendering is paused in a hidden tab.
    return new Promise((resolve) => setTimeout(resolve, Math.ceil((last + CHIP_LAND_SEC) * 1000)));
  }

  /** Celebration confetti over the table (`amount` 0..1). */
  confetti(amount: number): void {
    const n = Math.round(clamp01(amount) * 110);
    if (!n) return;
    const colors = [PALETTE.gold, PALETTE.neonPink, PALETTE.money, "#67C8FF", "#B988FF"];
    const fp = this.eyePosition();
    for (let j = 0; j < n; j++) {
      _p.set(rand(-1.25, 1.25), rand(1.5, 2.4), rand(-1.0, 1.0));
      // never born in a first-person eye's face
      if (fp && _p.distanceToSquared(_eye) < 0.8 * 0.8) _p.lerp(_q.set(0, _p.y, 0), 0.5);
      _vel.set(rand(-1.2, 1.2), rand(0.2, 1.2), rand(-0.9, 0.9));
      this.spawn("confetti", _p, _vel, rand(2.2, 3.6), colors[j % colors.length]!, rand(0.7, 1.4));
    }
  }

  glassBurst(at: THREE.Vector3): void {
    for (let j = 0; j < 48; j++) {
      const a = Math.random() * Math.PI * 2;
      _vel.set(Math.cos(a) * rand(0.6, 2.0), rand(0.8, 2.2), Math.sin(a) * rand(0.6, 2.0));
      this.spawn("glass", at, _vel, rand(1.4, 2.4), "#B8F5FF", rand(0.55, 1.4));
    }
    for (let j = 0; j < 22; j++) {
      _vel.set(rand(-1.4, 1.4), rand(1, 2.6), rand(-1.4, 1.4));
      this.spawn("coin", at, _vel, rand(1.6, 2.6), "#FFFFFF");
    }
    this.burstSparks(at, 30, "#D6FFFF");
  }

  smoke(at: THREE.Vector3): void {
    for (let j = 0; j < 22; j++) this.soft.spawn({ x: at.x + rand(-0.1, 0.1), y: at.y + rand(-0.1, 0.1), z: at.z + rand(-0.1, 0.1), vx: rand(-0.35, 0.35), vy: rand(0.15, 0.65), vz: rand(-0.35, 0.35), size: rand(0.13, 0.3), sizeEnd: rand(0.4, 0.7), life: rand(0.8, 1.7), color: "#C8B8B0", alpha: 0.6, frame: SPARK_SMOKE, drag: 0.8 });
  }

  moths(at: THREE.Vector3): void {
    for (let j = 0; j < 10; j++) {
      _vel.set(rand(-0.7, 0.7), rand(0.4, 1.0), rand(-0.7, 0.7));
      this.spawn("moth", at, _vel, rand(1.1, 2.1), "#DDCEAD", rand(0.8, 1.5));
    }
  }

  splash(at: THREE.Vector3): void {
    for (let j = 0; j < 55; j++) this.soft.spawn({ x: at.x, y: at.y + 0.05, z: at.z, vx: rand(-1.3, 1.3), vy: rand(0.7, 2.2), vz: rand(-1.3, 1.3), size: rand(0.045, 0.13), sizeEnd: 0.025, life: rand(0.55, 1.15), color: "#8CD8EE", frame: SPARK_DOT, gravity: 4.2, floor: 0 });
    this.burstSparks(at, 16, "#D1F7FF");
  }

  /** Drop every running effect at once (leaving a room, a new match, back to the menu). */
  clear(): void {
    for (const kind of KINDS) {
      this.pools[kind].clear();
      this.pools[kind].flush();
    }
    this.sparks.clear();
    this.soft.clear();
    for (const f of this.floats) this.hideFloat(f);
    for (const a of this.slamAnims) a.cancel();
    this.slamAnims.length = 0;
    this.slamPending = null;
    this.slamState = "idle";
    this.slamEl.style.display = "none";
    this.freezeUntil = 0;
    this.flashUntil = 0;
    this.edgeUntil = 0;
    this.flashOp = "0";
    this.edgeOp = "0";
    this.flashEl.style.opacity = "0";
    this.edgeEl.style.opacity = "0";
  }

  private burstSparks(at: THREE.Vector3, n: number, color: string): void {
    for (let j = 0; j < n; j++) this.sparks.spawn({ x: at.x, y: at.y, z: at.z, vx: rand(-1.4, 1.4), vy: rand(0.2, 1.6), vz: rand(-1.4, 1.4), size: rand(0.05, 0.13), sizeEnd: 0.02, life: rand(0.45, 1.0), color, frame: j % 3 ? SPARK_STAR : SPARK_GLOW, gravity: 1.3 });
  }

  update(dt: number, time: number): void {
    const clock = now();
    const reduced = settings.get().reducedFlashing;
    this.syncCamera();

    // ---- screen tints
    const flash = clock < this.flashUntil ? this.flashStrength * (1 - (clock - this.flashBorn) / (this.flashUntil - this.flashBorn)) : 0;
    this.write(this.flashEl, "flashOp", clamp01(flash).toFixed(3));
    const edge = clock < this.edgeUntil ? this.edgePeak * (1 - (clock - this.edgeBorn) / this.edgeDuration) : 0;
    this.write(this.edgeEl, "edgeOp", clamp01(edge).toFixed(3));
    const pulse = reduced ? 0.15 : 0.16 + 0.08 * Math.sin(time * (4 + this.siren * 7));
    this.write(this.vignetteEl, "vignetteOp", Math.max(0, this.siren * pulse).toFixed(3));
    this.write(this.finalEl, "finalOp", this.finalTable ? "0.16" : "0");

    // ---- slam
    if (this.slamState === "in") {
      if (this.slamPending && clock - this.slamShownAt >= SLAM_MIN_SEC) {
        const next = this.slamPending;
        this.slamPending = null;
        this.showSlam(next);
      } else if (clock >= this.slamUntil) {
        this.slamState = "out";
        this.slamUntil = clock + SLAM_OUT_SEC;
        this.slamAnims.push(this.slamEl.animate(SLAM_OUT, { duration: SLAM_OUT_SEC * 1000, easing: "ease-in", fill: "forwards" }));
      }
    } else if (this.slamState === "out" && clock >= this.slamUntil) {
      this.hideSlam();
      if (this.slamPending) {
        const next = this.slamPending;
        this.slamPending = null;
        this.showSlam(next);
      }
    }

    // ---- floats
    let rectH = 0;
    for (const f of this.floats) {
      if (!f.active) continue;
      const progress = (clock - f.born) / FLOAT_SEC;
      if (progress >= 1) {
        this.hideFloat(f);
        continue;
      }
      if (!rectH) rectH = this.stage.canvasRect().height || window.innerHeight;
      this.placeFloat(f, progress, rectH);
    }

    // ---- particles
    const fp = this.eyePosition();
    this.updateFlights(clock, dt);
    for (const kind of KINDS) {
      const p = this.pools[kind];
      if (p.live === 0) {
        p.flush();
        continue;
      }
      if (kind !== "chip") this.updatePool(kind, p, dt, time, fp);
      p.flush();
    }
    this.sparks.update(dt, this.stage.renderer, this.stage.camera);
    this.soft.update(dt, this.stage.renderer, this.stage.camera);
  }

  // ------------------------------------------------------------------------------------- particles

  private updatePool(kind: ParticleKind, p: Pool, dt: number, time: number, fp: boolean): void {
    if (dt <= 0) return;
    const paper = kind === "bill" || kind === "confetti";
    const hard = kind === "coin" || kind === "glass";
    const gravity = kind === "moth" ? -0.25 : paper ? (kind === "bill" ? 1.0 : 1.3) : 4.2;
    const terminal = kind === "bill" ? -0.6 : kind === "confetti" ? -0.75 : -6;
    const lift = kind === "coin" ? 0.004 : kind === "glass" ? 0.012 : 0.002;
    for (let i = 0; i < p.cap; i++) {
      const st = p.state[i];
      if (st !== FLYING && st !== RESTING) continue;
      const age = (p.life[i] += dt);
      const max = p.max[i]!;
      if (age >= max) {
        p.kill(i);
        continue;
      }
      const j = i * 3;
      if (st === RESTING) {
        // lying still; only the final fade needs new matrices
        const left = max - age;
        if (left < 0.6) p.write(i, Math.max(0.001, left / 0.6));
        continue;
      }
      const prevY = p.p[j + 1]!;
      if (kind === "moth") {
        // flutter up and away (a little drag so they don't rocket off)
        const k = Math.exp(-0.8 * dt);
        p.v[j] *= k;
        p.v[j + 2] *= k;
      }
      p.integrate(i, dt, gravity);
      if (p.v[j + 1]! < terminal) p.v[j + 1] = terminal;
      if (paper || kind === "moth") {
        const ph = p.phase[i]!;
        const amp = kind === "moth" ? 0.35 : 0.16;
        p.p[j] += Math.sin(time * 4 + ph) * dt * amp;
        p.p[j + 2] += Math.cos(time * 3.3 + ph) * dt * amp * 0.8;
        p.r[j + 1] += dt * 2;
      }
      // the felt (or the floor past the rim)
      const floor = surfaceY(p.p[j]!, p.p[j + 2]!, prevY) + lift;
      if (p.p[j + 1]! < floor) {
        p.p[j + 1] = floor;
        if (kind === "moth") {
          p.v[j + 1] = Math.abs(p.v[j + 1]!) * 0.5 + 0.2;
        } else if (hard && p.v[j + 1]! < -0.6) {
          // bounce, losing most of the energy
          p.v[j + 1] = -p.v[j + 1]! * 0.3;
          p.v[j] *= 0.55;
          p.v[j + 2] *= 0.55;
          p.w[j] *= 0.5;
          p.w[j + 1] *= 0.5;
          p.w[j + 2] *= 0.5;
        } else {
          this.rest(p, i, kind, floor, age);
          continue;
        }
      }
      let k = Math.min(1, (max - age) * 4);
      if (fp) k *= this.keepOut(p.p[j]!, p.p[j + 1]!, p.p[j + 2]!);
      p.write(i, Math.max(0.001, k));
    }
  }

  /** Comes to rest on a surface: flat (paper, coins) or as it fell (shards), then fades after a short while. */
  private rest(p: Pool, i: number, kind: ParticleKind, y: number, age: number): void {
    const j = i * 3;
    p.state[i] = RESTING;
    p.v[j] = p.v[j + 1] = p.v[j + 2] = 0;
    p.w[j] = p.w[j + 1] = p.w[j + 2] = 0;
    // tiny height jitter so overlapping bills don't z-fight
    p.p[j + 1] = y + Math.random() * 0.003;
    if (kind === "bill" || kind === "confetti") {
      p.r[j] = -Math.PI / 2;
      p.r[j + 1] = 0;
      p.r[j + 2] = Math.random() * Math.PI * 2;
    } else if (kind === "coin") {
      p.r[j] = 0;
      p.r[j + 1] = Math.random() * Math.PI * 2;
      p.r[j + 2] = 0;
    }
    p.max[i] = Math.min(p.max[i]!, age + (kind === "glass" ? 0.9 : 1.4));
    p.write(i, 1);
  }

  private updateFlights(clock: number, dt: number): void {
    const p = this.pools.chip;
    if (p.live === 0) return;
    for (let i = 0; i < p.cap; i++) {
      const st = p.state[i];
      if (st !== FLIGHT && st !== ARRIVED) continue;
      const j = i * 3;
      const t = (clock - this.flightBorn[i]!) / this.flightDur[i]!;
      if (st === FLIGHT) {
        if (t < 0) {
          p.write(i, 0.0001);
          continue;
        }
        if (t < 1) {
          const e = easeInOutSine(t);
          p.p[j] = this.flightFrom[j]! + (this.flightTo[j]! - this.flightFrom[j]!) * e;
          p.p[j + 1] = this.flightFrom[j + 1]! + (this.flightTo[j + 1]! - this.flightFrom[j + 1]!) * e + Math.sin(t * Math.PI) * this.flightArc[i]!;
          p.p[j + 2] = this.flightFrom[j + 2]! + (this.flightTo[j + 2]! - this.flightFrom[j + 2]!) * e;
          p.r[j] += dt * 10;
          p.r[j + 1] += dt * 7;
          p.write(i, Math.min(1, t * 6));
          continue;
        }
        // landed on the stack: flat, with a glint
        p.state[i] = ARRIVED;
        p.p[j] = this.flightTo[j]!;
        p.p[j + 1] = this.flightTo[j + 1]!;
        p.p[j + 2] = this.flightTo[j + 2]!;
        p.r[j] = 0;
        p.r[j + 2] = 0;
        if (Math.random() < 0.5) this.sparks.spawn({ x: p.p[j]!, y: p.p[j + 1]! + 0.02, z: p.p[j + 2]!, vy: rand(0.1, 0.4), size: rand(0.03, 0.05), sizeEnd: 0.005, life: rand(0.25, 0.4), color: "#FFF4C0", frame: SPARK_STAR, spin: rand(-6, 6) });
      }
      // squash into the stack, then gone (the stack itself shows the money)
      const k = clamp01((t - 1) * (this.flightDur[i]! / CHIP_LAND_SEC));
      if (k >= 1) {
        p.kill(i);
        continue;
      }
      const s = Math.sin(k * Math.PI);
      p.write(i, 1 - k * 0.3, 1 + 0.25 * s, 1 - 0.5 * s, 1 + 0.25 * s);
    }
  }

  /** Keep a spawn point over the felt (money rains on the table, not beside it). */
  private keepOnTable(at: THREE.Vector3): void {
    const r = Math.hypot(at.x, at.z);
    const max = TABLE_RADIUS - 0.08;
    if (r > max && at.y > TABLE_TOP_Y - 0.05) {
      at.x *= max / r;
      at.z *= max / r;
    }
  }

  /** First person: true (and _eye = the eye) while the camera is the seated eye. */
  private eyePosition(): boolean {
    const fp = this.stage.firstPerson;
    if (!fp.active || fp.blend < 0.5) return false;
    _eye.setFromMatrixPosition(this.stage.camera.matrixWorld);
    return true;
  }

  /** 0..1: how close `at` is to a first-person eye (1 = right under it). Sets _eye. */
  private nearEye(at: THREE.Vector3): number {
    if (!this.eyePosition()) return 0;
    const d = at.distanceTo(_eye);
    return 1 - smoothstep(1.2, 2.0, d);
  }

  /** Fade factor for a particle near the first-person eye (assumes _eye is current). */
  private keepOut(x: number, y: number, z: number): number {
    const dx = x - _eye.x;
    const dy = y - _eye.y;
    const dz = z - _eye.z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 >= KEEP_OUT * KEEP_OUT) return 1;
    return smoothstep(0.2 * 0.2, KEEP_OUT * KEEP_OUT, d2);
  }

  // ---------------------------------------------------------------------------------------- screen

  /** Camera matrices of this frame (floats are projected after the camera moved). */
  private syncCamera(): void {
    this.stage.camera.updateMatrixWorld();
  }

  /**
   * World point → layer pixels, clamped into the safe area. Off-screen (or behind the eye) anchors land on
   * the safe area's edge in their direction, with `edge` telling which side.
   */
  private project(world: THREE.Vector3, out: ScreenPoint): void {
    const cam = this.stage.camera;
    const rect = this.stage.canvasRect();
    _p.copy(world).applyMatrix4(cam.matrixWorldInverse);
    let nx: number;
    let ny: number;
    let off = false;
    if (_p.z > -cam.near * 2) {
      // behind the camera: toward its side (straight behind = below, e.g. your own seat in first person)
      const l = Math.hypot(_p.x, _p.y);
      nx = l > 1e-4 ? (_p.x / l) * 3 : 0;
      ny = l > 1e-4 ? (_p.y / l) * 3 : -3;
      if (ny > -0.5 && Math.abs(nx) < 0.5) ny = -3;
      off = true;
    } else {
      _p.applyMatrix4(cam.projectionMatrix);
      nx = _p.x;
      ny = _p.y;
      off = Math.abs(nx) > 1 || Math.abs(ny) > 1;
    }
    let edge = "";
    if (off) {
      // off-screen: slide toward the safe area's center until inside (keeps the direction), with an arrow
      const cy = (SAFE_TOP + SAFE_BOTTOM) / 2;
      const dx = nx;
      const dy = ny - cy;
      let k = 1;
      if (dx > SAFE_X) k = Math.min(k, SAFE_X / dx);
      if (dx < -SAFE_X) k = Math.min(k, -SAFE_X / dx);
      if (dy > SAFE_TOP - cy) k = Math.min(k, (SAFE_TOP - cy) / dy);
      if (dy < SAFE_BOTTOM - cy) k = Math.min(k, (SAFE_BOTTOM - cy) / dy);
      nx = dx * k;
      ny = cy + dy * k;
      edge = Math.abs(dx) * 0.7 > Math.abs(dy) ? (dx < 0 ? "l" : "r") : dy > 0 ? "t" : "b";
    } else {
      // on screen but under a HUD band: nudged inside, staying above / beside its anchor
      nx = clamp(nx, -SAFE_X, SAFE_X);
      ny = clamp(ny, SAFE_BOTTOM, SAFE_TOP);
    }
    out.x = rect.left + ((nx + 1) * rect.width) / 2;
    out.y = rect.top + ((1 - ny) * rect.height) / 2;
    out.edge = edge;
  }

  private placeFloat(f: FloatSlot, progress: number, h: number): void {
    if (f.getter) {
      const at = f.getter();
      if (at) f.at.copy(at);
    }
    this.project(f.at, _pt);
    // follow the anchor but glide (no jitter from camera shake)
    if (progress > 0) {
      f.x += (_pt.x - f.x) * 0.5;
      f.y += (_pt.y - f.y) * 0.5;
    } else {
      f.x = _pt.x;
      f.y = _pt.y;
    }
    if (_pt.edge !== f.edge) {
      f.edge = _pt.edge;
      if (f.edge) f.el.dataset.edge = f.edge;
      else delete f.el.dataset.edge;
    }
    const rise = (1 - (1 - progress) * (1 - progress)) * h * 0.06 + f.stack;
    const s = progress < 0.16 ? 0.7 + 0.32 * easeOutBack(progress / 0.16, 2.2) : 1.02;
    const transform = `translate(${Math.round(f.x)}px,${Math.round(f.y - rise)}px) translate(-50%,-50%) scale(${s.toFixed(2)})`;
    const op = progress < 0.06 ? progress / 0.06 : progress > 0.7 ? (1 - progress) / 0.3 : 1;
    const opacity = op.toFixed(2);
    if (transform !== f.transform) {
      f.transform = transform;
      f.el.style.transform = transform;
    }
    if (opacity !== f.opacity) {
      f.opacity = opacity;
      f.el.style.opacity = opacity;
    }
  }

  private hideFloat(f: FloatSlot): void {
    if (!f.active) return;
    f.active = false;
    f.getter = null;
    f.el.style.display = "none";
    f.edge = "";
    delete f.el.dataset.edge;
  }

  private showSlam(s: SlamSpec): void {
    for (const a of this.slamAnims) a.cancel();
    this.slamAnims.length = 0;
    const calm = settings.get().reducedFlashing || !!this.reduceMotion?.matches;
    this.slamMain.textContent = s.text;
    this.slamSub.textContent = s.sub;
    this.slamEl.style.setProperty("--ks-fx-color", s.color);
    this.slamEl.style.display = "block";
    this.slamAnims.push(
      this.slamMain.animate(calm ? CALM_IN : POP_IN, {
        duration: calm ? 220 : 360,
        easing: calm ? "ease-out" : "cubic-bezier(.2,1.25,.4,1)",
        fill: "both",
      }),
    );
    if (s.sub) this.slamAnims.push(this.slamSub.animate(SUB_IN, { duration: 260, delay: 90, easing: "ease-out", fill: "both" }));
    const t = now();
    this.slamState = "in";
    this.slamShownAt = t;
    this.slamUntil = t + SLAM_SEC + (s.sub ? SLAM_SUB_EXTRA : 0);
  }

  private hideSlam(): void {
    for (const a of this.slamAnims) a.cancel();
    this.slamAnims.length = 0;
    this.slamState = "idle";
    this.slamEl.style.display = "none";
  }

  /** Style opacity write, skipped when unchanged. */
  private write(el: HTMLElement, key: "flashOp" | "edgeOp" | "vignetteOp" | "finalOp", value: string): void {
    if (this[key] === value) return;
    this[key] = value;
    el.style.opacity = value;
  }
}
