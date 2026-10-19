// Visual effects: confetti, cake splat, frosting particles, flying coins, pop text, screen flashes,
// wind streaks, freeze frame. Owner: client-fx. PUBLIC API IS THE CONTRACT.
//
// 3D particles live in stage.world (pooled InstancedMesh / Points, no per-frame allocations). Pop text
// ("TIMBER!", "DING!", "+42", "*hic*", "RIGGED?!") and full-screen flashes are DOM elements in the
// `overlay` element passed to the constructor (absolutely positioned, pointer-events: none), styled by
// ./fx.css (create it; import it from this module). Chunky "Fredoka" font, thick ink outlines
// (-webkit-text-stroke / text-shadow), bouncy CSS keyframes. Honor reducedFlashing (no strobing,
// gentler flashes).
//
// Assumes the table center sits at the world origin with the tabletop at y = 0 (ARCHITECTURE "Frames").

import * as THREE from "three";
import type { Stage } from "./Stage";
import { toon } from "./toon";
import { t as tx } from "../i18n";
import { PALETTE, STAND_PLATE_RADIUS, STAND_PLATE_Y, TABLE_RADIUS, CAKE_TOP_Y, CAKE_RADIUS } from "../../../shared/constants";
import "./fx.css";

// ------------------------------------------------------------------------------------- small helpers

const rand = (a: number, b: number): number => a + Math.random() * (b - a);
const pick = <T>(arr: readonly T[]): T => arr[(Math.random() * arr.length) | 0]!;
const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
const easeOutBack = (t: number): number => {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

/** Height of whatever surface is under (x, z): cake top, stand plate, tablecloth, or the abyss (-Infinity). */
function floorY(x: number, z: number): number {
  const r2 = x * x + z * z;
  if (r2 < CAKE_RADIUS * CAKE_RADIUS) return CAKE_TOP_Y;
  if (r2 < STAND_PLATE_RADIUS * STAND_PLATE_RADIUS) return STAND_PLATE_Y;
  if (r2 < TABLE_RADIUS * TABLE_RADIUS) return 0;
  return -Infinity;
}

const CONFETTI_COLORS = ["#FF5A5F", "#FFCF33", "#7BE07B", "#3FA7FF", "#B07CFF", "#FF8BD1", "#FFFFFF", "#FF9F43"] as const;
const SPRINKLE_COLORS = ["#FF5A5F", "#FFCF33", "#7BE07B", "#3FA7FF", "#FFFFFF", "#B07CFF"] as const;
const FROSTING_COLORS = [PALETTE.frosting, PALETTE.frosting, PALETTE.frostingShadow, "#FFF6E5", "#FFF6E5", "#D7263D"] as const;
const CRUMB_COLORS = [PALETTE.sponge, PALETTE.sponge, "#E8B96A", "#C98B45"] as const;

// Shared scratch objects (no per-frame allocations).
const _obj = new THREE.Object3D();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();
const _white = new THREE.Color(0xffffff);

// ------------------------------------------------------------------------------------------ the pool

/** Fixed-capacity instanced particle pool. Fx drives the behaviour; the pool just stores + writes. */
class Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly cap: number;
  readonly p: Float32Array; // position xyz
  readonly v: Float32Array; // velocity xyz
  readonly r: Float32Array; // euler xyz
  readonly w: Float32Array; // angular velocity xyz
  readonly s: Float32Array; // base scale xyz
  readonly life: Float32Array;
  readonly max: Float32Array;
  readonly phase: Float32Array;
  readonly state: Uint8Array; // 0 dead, 1 flying, 2 landed (meaning per pool)
  live = 0;
  private readonly order: THREE.EulerOrder;
  private cursor = 0;
  private dirty = false;

  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material, cap: number, order: THREE.EulerOrder = "XYZ") {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = "fx-pool";
    for (let i = 0; i < cap; i++) {
      this.mesh.setMatrixAt(i, _hidden);
      this.mesh.setColorAt(i, _color.set(0xffffff));
    }
    this.p = new Float32Array(cap * 3);
    this.v = new Float32Array(cap * 3);
    this.r = new Float32Array(cap * 3);
    this.w = new Float32Array(cap * 3);
    this.s = new Float32Array(cap * 3);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.state = new Uint8Array(cap);
    this.order = order;
    parent.add(this.mesh);
  }

  /** A free slot (or the oldest one, recycled). */
  alloc(): number {
    for (let k = 0; k < this.cap; k++) {
      const i = (this.cursor + k) % this.cap;
      if (this.state[i] === 0) {
        this.cursor = (i + 1) % this.cap;
        this.live++;
        this.state[i] = 1;
        this.life[i] = 0;
        return i;
      }
    }
    const i = this.cursor;
    this.cursor = (i + 1) % this.cap;
    this.state[i] = 1;
    this.life[i] = 0;
    return i;
  }

  set(i: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, max: number): void {
    const j = i * 3;
    this.p[j] = px; this.p[j + 1] = py; this.p[j + 2] = pz;
    this.v[j] = vx; this.v[j + 1] = vy; this.v[j + 2] = vz;
    this.s[j] = sx; this.s[j + 1] = sy; this.s[j + 2] = sz;
    this.r[j] = 0; this.r[j + 1] = 0; this.r[j + 2] = 0;
    this.w[j] = 0; this.w[j + 1] = 0; this.w[j + 2] = 0;
    this.max[i] = max;
    this.phase[i] = Math.random() * Math.PI * 2;
  }

  color(i: number, c: THREE.ColorRepresentation): void {
    this.mesh.setColorAt(i, _color.set(c));
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  kill(i: number): void {
    if (this.state[i] === 0) return;
    this.state[i] = 0;
    this.live--;
    this.mesh.setMatrixAt(i, _hidden);
    this.dirty = true;
  }

  /** Writes instance i with its stored pose times a scale multiplier. */
  write(i: number, k: number, kx = 1, ky = 1, kz = 1): void {
    const j = i * 3;
    _obj.position.set(this.p[j]!, this.p[j + 1]!, this.p[j + 2]!);
    _obj.rotation.order = this.order;
    _obj.rotation.set(this.r[j]!, this.r[j + 1]!, this.r[j + 2]!);
    _obj.scale.set(Math.max(1e-5, this.s[j]! * k * kx), Math.max(1e-5, this.s[j + 1]! * k * ky), Math.max(1e-5, this.s[j + 2]! * k * kz));
    _obj.updateMatrix();
    this.mesh.setMatrixAt(i, _obj.matrix);
    this.dirty = true;
  }

  /** Integrates position + rotation for slot i. */
  integrate(i: number, dt: number, gravity: number): void {
    const j = i * 3;
    this.v[j + 1] -= gravity * dt;
    this.p[j] += this.v[j]! * dt;
    this.p[j + 1] += this.v[j + 1]! * dt;
    this.p[j + 2] += this.v[j + 2]! * dt;
    this.r[j] += this.w[j]! * dt;
    this.r[j + 1] += this.w[j + 1]! * dt;
    this.r[j + 2] += this.w[j + 2]! * dt;
  }

  flush(): void {
    if (this.dirty) this.mesh.instanceMatrix.needsUpdate = true;
    this.dirty = false;
    this.mesh.visible = this.live > 0;
  }
}

// ----------------------------------------------------------------------------- canvas texture bakery

/** A cartoon frosting splat (pink blob + drips + sprinkles + a silly face) for the tablecloth decal. */
function makeSplatTexture(face: "dizzy" | "googly"): THREE.CanvasTexture {
  const size = 512;
  const cv = document.createElement("canvas");
  cv.width = cv.height = size;
  const g = cv.getContext("2d")!;
  const c = size / 2;
  const blob = (r: number, lobes: number, jitter: number): Path2D => {
    const path = new Path2D();
    const n = lobes * 2;
    const pts: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const rr = r * (i % 2 === 0 ? rand(1 - jitter, 1 + jitter) : rand(0.72, 0.88));
      pts.push([c + Math.cos(a) * rr, c + Math.sin(a) * rr]);
    }
    const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const start = mid(pts[n - 1]!, pts[0]!);
    path.moveTo(start[0], start[1]);
    for (let i = 0; i < n; i++) {
      const m = mid(pts[i]!, pts[(i + 1) % n]!);
      path.quadraticCurveTo(pts[i]![0], pts[i]![1], m[0], m[1]);
    }
    path.closePath();
    return path;
  };
  // Flung droplets around the splat.
  const drops: [number, number, number][] = [];
  for (let i = 0; i < 14; i++) {
    const a = rand(0, Math.PI * 2);
    const d = rand(150, 225);
    drops.push([c + Math.cos(a) * d, c + Math.sin(a) * d, rand(8, 22)]);
  }
  const main = blob(130, 9, 0.28);
  g.lineJoin = "round";
  // Ink outline pass, then frosting fill, then shadow, then highlight.
  g.fillStyle = PALETTE.ink;
  g.save();
  g.lineWidth = 14;
  g.strokeStyle = PALETTE.ink;
  g.stroke(main);
  for (const [x, y, r] of drops) {
    g.beginPath();
    g.arc(x, y, r + 5, 0, Math.PI * 2);
    g.fill();
  }
  g.restore();
  g.fillStyle = PALETTE.frostingShadow;
  g.fill(main);
  for (const [x, y, r] of drops) {
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  }
  // Lighter top layer, nudged up-left so the darker rim reads as a shadow.
  g.save();
  g.translate(c - 8, c - 10);
  g.scale(0.9, 0.9);
  g.translate(-c, -c);
  g.fillStyle = PALETTE.frosting;
  g.fill(main);
  g.restore();
  // Glossy highlights.
  g.fillStyle = "rgba(255,255,255,0.75)";
  g.beginPath();
  g.ellipse(c - 55, c - 60, 34, 14, -0.6, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.arc(c - 92, c - 22, 8, 0, Math.PI * 2);
  g.fill();
  // Sprinkles.
  for (let i = 0; i < 26; i++) {
    const a = rand(0, Math.PI * 2);
    const d = rand(10, 105);
    g.save();
    g.translate(c + Math.cos(a) * d, c + Math.sin(a) * d);
    g.rotate(rand(0, Math.PI));
    g.fillStyle = pick(SPRINKLE_COLORS);
    g.beginPath();
    g.roundRect(-9, -3, 18, 6, 3);
    g.fill();
    g.restore();
  }
  // The face: a splatted cake has feelings too.
  const ex = 38;
  const ey = c + 4;
  g.lineCap = "round";
  if (face === "dizzy") {
    g.strokeStyle = PALETTE.ink;
    g.lineWidth = 9;
    for (const sx of [-1, 1]) {
      const x = c + sx * ex;
      g.beginPath();
      g.moveTo(x - 14, ey - 14);
      g.lineTo(x + 14, ey + 14);
      g.moveTo(x + 14, ey - 14);
      g.lineTo(x - 14, ey + 14);
      g.stroke();
    }
  } else {
    for (const sx of [-1, 1]) {
      const x = c + sx * ex;
      g.fillStyle = "#FFFFFF";
      g.strokeStyle = PALETTE.ink;
      g.lineWidth = 6;
      g.beginPath();
      g.arc(x, ey, 24, 0, Math.PI * 2);
      g.fill();
      g.stroke();
      g.fillStyle = PALETTE.ink;
      g.beginPath();
      g.arc(x + sx * 9, ey + 10, 10, 0, Math.PI * 2);
      g.fill();
    }
  }
  // Wobbly "oh no" mouth.
  g.strokeStyle = PALETTE.ink;
  g.lineWidth = 7;
  g.beginPath();
  g.moveTo(c - 26, c + 58);
  g.quadraticCurveTo(c - 13, c + 46, c, c + 58);
  g.quadraticCurveTo(c + 13, c + 70, c + 26, c + 58);
  g.stroke();
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** A cartoon wind swoosh: a tapered line that ends in a curl. */
function makeWindTexture(): THREE.CanvasTexture {
  const w = 512;
  const h = 128;
  const cv = document.createElement("canvas");
  cv.width = w;
  cv.height = h;
  const g = cv.getContext("2d")!;
  g.lineCap = "round";
  const path = (): void => {
    g.beginPath();
    g.moveTo(20, 80);
    g.bezierCurveTo(140, 70, 260, 92, 380, 74);
    // The curl at the leading end.
    g.bezierCurveTo(450, 64, 470, 24, 430, 22);
    g.bezierCurveTo(395, 20, 392, 58, 425, 56);
  };
  g.strokeStyle = "rgba(45,42,50,0.55)";
  g.lineWidth = 16;
  path();
  g.stroke();
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.lineWidth = 9;
  path();
  g.stroke();
  // Fade the tail with a horizontal alpha gradient.
  g.globalCompositeOperation = "destination-in";
  const grad = g.createLinearGradient(0, 0, w, 0);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(0.35, "rgba(0,0,0,0.8)");
  grad.addColorStop(1, "rgba(0,0,0,1)");
  g.fillStyle = grad;
  g.fillRect(0, 0, w, h);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ------------------------------------------------------------------------------------- DOM markup

const SLEEP_MASK_SVG = `
<svg viewBox="0 0 440 220" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M0 96 Q40 80 60 92" stroke="#2d2a32" stroke-width="14" fill="none" stroke-linecap="round"/>
  <path d="M440 96 Q400 80 380 92" stroke="#2d2a32" stroke-width="14" fill="none" stroke-linecap="round"/>
  <path d="M0 96 Q40 80 60 92" stroke="#ff8bd1" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M440 96 Q400 80 380 92" stroke="#ff8bd1" stroke-width="7" fill="none" stroke-linecap="round"/>
  <path d="M220 62 C170 20 70 30 56 88 C44 140 90 182 150 176 C190 172 205 150 220 150 C235 150 250 172 290 176 C350 182 396 140 384 88 C370 30 270 20 220 62 Z"
    fill="#b07cff" stroke="#2d2a32" stroke-width="10" stroke-linejoin="round"/>
  <path d="M220 74 C176 40 92 46 80 92 C70 132 104 160 150 156 C186 153 202 134 220 134 C238 134 254 153 290 156 C336 160 370 132 360 92 C348 46 264 40 220 74 Z"
    fill="none" stroke="#fff6e5" stroke-width="4" stroke-dasharray="10 9" opacity="0.7"/>
  <ellipse cx="128" cy="78" rx="26" ry="10" fill="#fff" opacity="0.35" transform="rotate(-14 128 78)"/>
  <g stroke="#2d2a32" stroke-width="8" fill="none" stroke-linecap="round">
    <path d="M110 108 Q145 134 180 108"/>
    <path d="M260 108 Q295 134 330 108"/>
    <path d="M118 117 l-10 14 M134 125 l-5 16 M152 127 l0 17 M170 121 l7 15"/>
    <path d="M268 121 l-7 15 M286 127 l0 17 M304 125 l5 16 M322 117 l10 14"/>
  </g>
  <ellipse cx="98" cy="146" rx="18" ry="9" fill="#ff8bd1" opacity="0.8"/>
  <ellipse cx="342" cy="146" rx="18" ry="9" fill="#ff8bd1" opacity="0.8"/>
</svg>`;

type PopStyle = "big" | "coin" | "bad" | "small";
const POP_MS: Record<PopStyle, number> = { big: 1700, coin: 1250, bad: 1400, small: 1150 };

// ------------------------------------------------------------------------------------------- Fx

export class Fx {
  private readonly root: THREE.Group;
  private readonly layer: HTMLDivElement;
  private reduced = false;

  // Particle pools.
  private readonly confettiPool: Pool;
  private readonly blobPool: Pool;
  private readonly crumbPool: Pool;
  private readonly coinPool: Pool;
  private readonly puffPool: Pool;
  private readonly sparklePool: Pool;
  private readonly windPool: Pool;
  private readonly windMat: THREE.MeshBasicMaterial;

  // Coin flight data (mode 1 = arc, 2 = shower).
  private readonly coinMode: Uint8Array;
  private readonly coinFrom: Float32Array;
  private readonly coinTo: Float32Array;
  private readonly coinDelay: Float32Array;
  private readonly coinApex: Float32Array;
  private readonly coinCalls: Uint16Array;
  private readonly coinCb: ((() => void) | undefined)[];
  private showerLeft = 0;
  private showerAcc = 0;

  // Splat decals on the tablecloth.
  private readonly decals: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t: number; alive: boolean; size: number }[] = [];
  private decalCursor = 0;

  // Wind.
  private windX = 0;
  private windZ = 0;
  private windStrength = 0;
  private windAcc = 0;

  // Time scale (freeze → slow-mo ramp).
  private freezeLeft = 0;
  private rampT = -1;
  private readonly rampDur = 1.1;
  private readonly rampFrom = 0.18;

  // DOM bits.
  private readonly edgeEl: HTMLDivElement;
  private readonly edgeRing: HTMLDivElement;
  private edgeAnim: Animation | null = null;
  private readonly flashEl: HTMLDivElement;
  private flashAnim: Animation | null = null;
  private readonly blindEl: HTMLDivElement;
  private readonly barsEl: HTMLDivElement;
  private readonly snapEl: HTMLDivElement;

  constructor(stage: Stage, overlay: HTMLElement) {
    this.root = new THREE.Group();
    this.root.name = "fx";
    stage.world.add(this.root);

    // --- 3D pools
    const paperMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
    this.confettiPool = new Pool(this.root, new THREE.PlaneGeometry(1, 1), paperMat, 720);

    const blobGeo = new THREE.IcosahedronGeometry(1, 1);
    this.blobPool = new Pool(this.root, blobGeo, toon(0xffffff, { unique: true }), 180);
    this.crumbPool = new Pool(this.root, new THREE.BoxGeometry(1, 1, 1), toon(0xffffff, { unique: true }), 180);

    const coinGeo = new THREE.CylinderGeometry(1, 1, 0.22, 18);
    const coinMat = toon(PALETTE.coin, { unique: true, emissive: 0x4a3000 });
    this.coinPool = new Pool(this.root, coinGeo, coinMat, 200, "YXZ");

    const puffMat = toon(0xffffff, { unique: true, transparent: true, opacity: 0.88 });
    puffMat.depthWrite = false;
    this.puffPool = new Pool(this.root, new THREE.IcosahedronGeometry(1, 1), puffMat, 140);

    const sparkleMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.sparklePool = new Pool(this.root, new THREE.OctahedronGeometry(1, 0), sparkleMat, 260);

    this.windMat = new THREE.MeshBasicMaterial({ map: makeWindTexture(), transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0.85 });
    this.windPool = new Pool(this.root, new THREE.PlaneGeometry(1, 0.25), this.windMat, 48, "YXZ");

    const cap = this.coinPool.cap;
    this.coinMode = new Uint8Array(cap);
    this.coinFrom = new Float32Array(cap * 3);
    this.coinTo = new Float32Array(cap * 3);
    this.coinDelay = new Float32Array(cap);
    this.coinApex = new Float32Array(cap);
    this.coinCalls = new Uint16Array(cap);
    this.coinCb = new Array<(() => void) | undefined>(cap).fill(undefined);

    // --- splat decals (small ring of reusable meshes, two silly faces)
    const textures = [makeSplatTexture("dizzy"), makeSplatTexture("googly")];
    const decalGeo = new THREE.PlaneGeometry(1, 1);
    decalGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 4; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: textures[i % 2]!,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(decalGeo, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.name = "fx-splat-decal";
      this.root.add(mesh);
      this.decals.push({ mesh, mat, t: 0, alive: false, size: 1 });
    }

    // --- DOM layer
    this.layer = document.createElement("div");
    this.layer.className = "jjfx-layer";
    overlay.appendChild(this.layer);

    this.edgeEl = this.div("jjfx-edge");
    this.edgeRing = document.createElement("div");
    this.edgeRing.className = "jjfx-edge-ring";
    this.edgeEl.appendChild(this.edgeRing);

    this.flashEl = this.div("jjfx-flash");
    this.snapEl = this.div("jjfx-snap");

    this.barsEl = this.div("jjfx-bars");
    this.barsEl.innerHTML = `<div class="jjfx-bar jjfx-bar--top"></div><div class="jjfx-bar jjfx-bar--bottom"></div>`;

    this.blindEl = this.div("jjfx-blind");
    this.blindEl.innerHTML = `
      <div class="jjfx-blind-stage">
        <div class="jjfx-mask">${SLEEP_MASK_SVG}</div>
        <div class="jjfx-zzz"><span>Z</span><span>z</span><span>Z</span><span>z</span></div>
        <div class="jjfx-blind-cap"></div>
      </div>`;
    this.blindEl.querySelector(".jjfx-blind-cap")!.textContent = tx("scene.blindCaption");
  }

  private div(cls: string): HTMLDivElement {
    const el = document.createElement("div");
    el.className = cls;
    this.layer.appendChild(el);
    return el;
  }

  setReducedFlashing(on: boolean): void {
    this.reduced = on;
    this.layer.classList.toggle("jjfx-reduced", on);
  }

  // ------------------------------------------------------------------------------------- confetti

  /** Confetti burst at a world point; amount 0..1+ (scaled by multiplier: amount = multiplier / 5). */
  confetti(world: THREE.Vector3, amount: number): void {
    const n = Math.round(clamp(30 + amount * 220, 20, 420));
    const pool = this.confettiPool;
    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      const a = rand(0, Math.PI * 2);
      const out = rand(0.3, 1.5) * (0.8 + Math.min(amount, 2) * 0.3);
      pool.set(
        i,
        world.x + rand(-0.05, 0.05), world.y + rand(-0.02, 0.05), world.z + rand(-0.05, 0.05),
        Math.cos(a) * out, rand(2.2, 4.2) * (0.85 + Math.min(amount, 2) * 0.15), Math.sin(a) * out,
        rand(0.022, 0.034), rand(0.03, 0.05), 1,
        rand(4, 6.5),
      );
      const j = i * 3;
      pool.r[j] = rand(0, 6.3); pool.r[j + 1] = rand(0, 6.3); pool.r[j + 2] = rand(0, 6.3);
      pool.w[j] = rand(-9, 9); pool.w[j + 1] = rand(-6, 6); pool.w[j + 2] = rand(-9, 9);
      pool.color(i, pick(CONFETTI_COLORS));
    }
  }

  /** Little sprinkle rods (reuse the confetti pool with skinny quads). */
  private sprinkles(world: THREE.Vector3, n: number): void {
    const pool = this.confettiPool;
    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      const a = rand(0, Math.PI * 2);
      const out = rand(0.6, 2.2);
      pool.set(i, world.x, world.y, world.z, Math.cos(a) * out, rand(1.5, 3.5), Math.sin(a) * out, 0.008, 0.026, 1, rand(3, 5));
      const j = i * 3;
      pool.w[j] = rand(-14, 14); pool.w[j + 2] = rand(-14, 14);
      pool.color(i, pick(SPRINKLE_COLORS));
    }
  }

  // ---------------------------------------------------------------------------------------- splat

  /** Big cake SPLAT: frosting blobs + sponge crumbs + a pink splat decal on the tablecloth. */
  splat(world: THREE.Vector3): void {
    // Frosting blobs: fat, squishy, they stick where they land.
    for (let k = 0; k < 34; k++) {
      const i = this.blobPool.alloc();
      const a = rand(0, Math.PI * 2);
      const out = rand(0.7, 2.6);
      const s = rand(0.022, 0.055);
      this.blobPool.set(i, world.x + rand(-0.06, 0.06), world.y + rand(0, 0.08), world.z + rand(-0.06, 0.06),
        Math.cos(a) * out, rand(1.2, 3.4), Math.sin(a) * out, s * rand(0.85, 1.2), s, s * rand(0.85, 1.2), rand(7, 9));
      const j = i * 3;
      this.blobPool.w[j] = rand(-6, 6); this.blobPool.w[j + 2] = rand(-6, 6);
      this.blobPool.color(i, pick(FROSTING_COLORS));
    }
    // Sponge crumbs: bouncy little cubes.
    for (let k = 0; k < 40; k++) {
      const i = this.crumbPool.alloc();
      const a = rand(0, Math.PI * 2);
      const out = rand(0.4, 2.0);
      const s = rand(0.012, 0.03);
      this.crumbPool.set(i, world.x, world.y + 0.04, world.z, Math.cos(a) * out, rand(1.0, 3.0), Math.sin(a) * out,
        s, s * rand(0.7, 1.1), s * rand(0.8, 1.3), rand(4, 6));
      const j = i * 3;
      this.crumbPool.w[j] = rand(-12, 12); this.crumbPool.w[j + 1] = rand(-12, 12); this.crumbPool.w[j + 2] = rand(-12, 12);
      this.crumbPool.color(i, pick(CRUMB_COLORS));
    }
    this.sprinkles(world, 60);
    this.puff(world, 2.2);

    // Decal on the tablecloth, under the splat point (clamped onto the table).
    const d = this.decals[this.decalCursor]!;
    this.decalCursor = (this.decalCursor + 1) % this.decals.length;
    let x = world.x;
    let z = world.z;
    const r = Math.hypot(x, z);
    const maxR = TABLE_RADIUS - 0.35;
    if (r > maxR) {
      x *= maxR / r;
      z *= maxR / r;
    }
    d.mesh.position.set(x, 0.004, z);
    d.mesh.rotation.y = rand(0, Math.PI * 2);
    d.size = rand(0.95, 1.2);
    d.t = 0;
    d.alive = true;
    d.mat.opacity = 1;
    d.mesh.scale.setScalar(0.001);
    d.mesh.visible = true;
  }

  // ---------------------------------------------------------------------------------------- coins

  /** Coins fly in an arc from `from` to `to` (world) with sparkle; `count` coins; calls onArrive per coin. */
  coins(from: THREE.Vector3, to: THREE.Vector3, count: number, onArrive?: () => void): void {
    if (count <= 0) return;
    const shown = Math.min(count, 40);
    const base = Math.floor(count / shown);
    let extra = count - base * shown;
    const dist = from.distanceTo(to);
    const pool = this.coinPool;
    for (let k = 0; k < shown; k++) {
      const i = this.allocCoin();
      const j = i * 3;
      this.coinMode[i] = 1;
      this.coinFrom[j] = from.x + rand(-0.05, 0.05);
      this.coinFrom[j + 1] = from.y + rand(-0.02, 0.05);
      this.coinFrom[j + 2] = from.z + rand(-0.05, 0.05);
      this.coinTo[j] = to.x + rand(-0.04, 0.04);
      this.coinTo[j + 1] = to.y;
      this.coinTo[j + 2] = to.z + rand(-0.04, 0.04);
      this.coinDelay[i] = k * 0.055 + rand(0, 0.03);
      this.coinApex[i] = 0.35 + dist * 0.35 + rand(0, 0.2);
      this.coinCalls[i] = base + (extra > 0 ? 1 : 0);
      if (extra > 0) extra--;
      this.coinCb[i] = onArrive;
      pool.set(i, this.coinFrom[j]!, this.coinFrom[j + 1]!, this.coinFrom[j + 2]!, 0, 0, 0, 0.032, 0.032, 0.032, rand(0.6, 0.85));
      pool.r[j] = Math.PI / 2;
      pool.w[j + 1] = rand(10, 16) * (Math.random() < 0.5 ? -1 : 1);
      pool.mesh.setMatrixAt(i, _hidden);
    }
  }

  /** Allocates a coin slot; a recycled in-flight coin pays out its callback first so nothing is lost. */
  private allocCoin(): number {
    const i = this.coinPool.alloc();
    this.payCoin(i);
    return i;
  }

  private payCoin(i: number): void {
    const cb = this.coinCb[i];
    const calls = this.coinCalls[i]!;
    this.coinCb[i] = undefined;
    this.coinCalls[i] = 0;
    if (!cb) return;
    for (let c = 0; c < calls; c++) {
      try {
        cb();
      } catch (err) {
        console.error("[fx] coin onArrive failed", err);
      }
    }
  }

  /** Coin shower from above (Legendary jackpot). */
  coinShower(seconds: number): void {
    this.showerLeft = Math.max(this.showerLeft, seconds);
  }

  private spawnShowerCoin(): void {
    const pool = this.coinPool;
    const i = this.allocCoin();
    const j = i * 3;
    this.coinMode[i] = 2;
    const a = rand(0, Math.PI * 2);
    const d = Math.sqrt(Math.random()) * 1.35;
    const s = rand(0.03, 0.045);
    pool.set(i, Math.cos(a) * d, rand(2.4, 3.4), Math.sin(a) * d, rand(-0.2, 0.2), rand(-1.2, 0), rand(-0.2, 0.2), s, s, s, rand(3.5, 5));
    pool.r[j] = rand(0, 6.3); pool.r[j + 1] = rand(0, 6.3);
    pool.w[j] = rand(-10, 10); pool.w[j + 1] = rand(-8, 8); pool.w[j + 2] = rand(-4, 4);
  }

  // ---------------------------------------------------------------------------------- puff + sparkle

  /** Little puff of dust/flour (impacts). */
  puff(world: THREE.Vector3, size: number): void {
    const sz = clamp(size, 0.15, 3);
    const n = Math.round(4 + sz * 4);
    const pool = this.puffPool;
    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      const a = (k / n) * Math.PI * 2 + rand(-0.3, 0.3);
      const out = rand(0.15, 0.45) * (0.6 + sz * 0.4);
      const s = 0.045 * sz * rand(0.6, 1.15);
      pool.set(i, world.x + Math.cos(a) * 0.02, world.y + rand(0, 0.02), world.z + Math.sin(a) * 0.02,
        Math.cos(a) * out, rand(0.15, 0.45), Math.sin(a) * out, s, s * rand(0.8, 1.0), s, rand(0.45, 0.8));
      _color.set("#FFF6E5").lerp(_white, Math.random());
      pool.mesh.setColorAt(i, _color);
      if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
    }
  }

  private sparkle(x: number, y: number, z: number, n: number, spread: number): void {
    const pool = this.sparklePool;
    const count = this.reduced ? Math.ceil(n * 0.5) : n;
    for (let k = 0; k < count; k++) {
      const i = pool.alloc();
      const s = rand(0.008, 0.02);
      pool.set(i, x + rand(-spread, spread), y + rand(-spread, spread), z + rand(-spread, spread),
        rand(-0.4, 0.4), rand(0.1, 0.7), rand(-0.4, 0.4), s, s * 1.6, s, rand(0.3, 0.6));
      const j = i * 3;
      pool.w[j + 1] = rand(-10, 10);
      pool.color(i, Math.random() < 0.6 ? "#FFF3A0" : "#FFFFFF");
    }
  }

  // -------------------------------------------------------------------------------------- pop text

  /**
   * Pop text at a screen position (or centered when omitted). style: "big" (TIMBER!/DING!), "coin" (+42
   * gold), "bad" (−20 red), "small" (*hic*).
   */
  popText(text: string, style: "big" | "coin" | "bad" | "small", screen?: { x: number; y: number }): void {
    // Keep the layer tidy if something spams pops.
    const pops = this.layer.querySelectorAll(".jjfx-pop");
    for (let k = 0; k < pops.length - 14; k++) pops[k]!.remove();

    const el = document.createElement("div");
    el.className = `jjfx-pop jjfx-pop--${style}`;
    if (screen) {
      const rect = this.layer.getBoundingClientRect();
      el.style.left = `${screen.x - rect.left}px`;
      el.style.top = `${screen.y - rect.top}px`;
    } else {
      el.style.left = "50%";
      el.style.top = style === "big" ? "40%" : "48%";
    }
    el.style.setProperty("--tilt", `${rand(-9, 9).toFixed(1)}deg`);
    el.style.setProperty("--drift", `${rand(-30, 30).toFixed(0)}px`);

    const inner = document.createElement("div");
    inner.className = "jjfx-pop-inner";
    if (style === "big") {
      const burst = document.createElement("div");
      burst.className = "jjfx-burst";
      inner.appendChild(burst);
    }
    const word = document.createElement("div");
    word.className = "jjfx-word";
    if (style === "coin") {
      const coin = document.createElement("span");
      coin.className = "jjfx-coin-icon";
      word.appendChild(coin);
    }
    // Letters as spans so each one can bounce in on its own beat.
    let idx = 0;
    for (const ch of text) {
      const span = document.createElement("span");
      span.className = ch === " " ? "jjfx-ch jjfx-sp" : "jjfx-ch";
      span.textContent = ch === " " ? " " : ch;
      span.style.setProperty("--i", String(idx++));
      word.appendChild(span);
    }
    inner.appendChild(word);
    el.appendChild(inner);
    this.layer.appendChild(el);
    window.setTimeout(() => el.remove(), POP_MS[style] + 120);
  }

  // ------------------------------------------------------------------------------------ screen fx

  /** Full-screen edge glow in a rarity color for `seconds` (Case result). */
  edgeGlow(color: string, seconds: number): void {
    this.edgeEl.style.setProperty("--glow", color);
    this.edgeRing.classList.toggle("jjfx-pulse", !this.reduced);
    this.edgeAnim?.cancel();
    const ms = Math.max(200, seconds * 1000);
    this.edgeAnim = this.edgeEl.animate(
      [{ opacity: 0 }, { opacity: 1, offset: Math.min(0.25, 180 / ms) }, { opacity: 1, offset: 0.75 }, { opacity: 0 }],
      { duration: ms, easing: "ease-out", fill: "forwards" },
    );
  }

  /** Quick full-screen flash (Cursed red flash). */
  flash(color: string, seconds: number): void {
    this.flashEl.style.setProperty("--flash", color);
    this.flashAnim?.cancel();
    const ms = Math.max(this.reduced ? 450 : 120, seconds * 1000);
    const peak = this.reduced ? 0.22 : 0.8;
    this.flashAnim = this.flashEl.animate([{ opacity: peak }, { opacity: 0 }], { duration: ms, easing: "cubic-bezier(.2,.7,.3,1)", fill: "forwards" });
  }

  /** Wind streak particles across the tower while strength > 0 (stand-local direction rotated by standAngle). */
  setWind(dx: number, dz: number, strength: number, standAngle: number): void {
    const len = Math.hypot(dx, dz);
    this.windStrength = len > 1e-4 ? clamp(strength, 0, 1.5) : 0;
    if (len <= 1e-4) return;
    const lx = dx / len;
    const lz = dz / len;
    // Rotate the stand-local vector about +Y by standAngle (same as Object3D.rotation.y).
    const c = Math.cos(standAngle);
    const s = Math.sin(standAngle);
    this.windX = lx * c + lz * s;
    this.windZ = -lx * s + lz * c;
  }

  private spawnWind(): void {
    const pool = this.windPool;
    const i = pool.alloc();
    const j = i * 3;
    const px = -this.windZ;
    const pz = this.windX;
    const side = rand(-0.55, 0.55);
    const back = rand(0.9, 1.2);
    const speed = rand(1.6, 2.4) * (0.7 + this.windStrength * 0.6);
    const len = rand(0.35, 0.6);
    pool.set(i,
      -this.windX * back + px * side, CAKE_TOP_Y + rand(-0.15, 0.9), -this.windZ * back + pz * side,
      this.windX * speed, 0, this.windZ * speed,
      len, len, 1, (back * 2) / speed);
    // Yaw so the plane's +X points along the wind; tiny random roll.
    pool.r[j + 1] = Math.atan2(-this.windZ, this.windX);
    pool.r[j + 2] = rand(-0.12, 0.12);
  }

  /** Blindfold: full-screen darkness with a cartoon sleep-mask shape and "Zzz" (on/off, fades). */
  setBlindfold(on: boolean): void {
    this.blindEl.classList.toggle("jjfx-on", on);
  }

  // ---------------------------------------------------------------------------------- time scaling

  /** Freeze frame: returns the time scale the Game should apply to visuals (0 during the freeze, then eases back to 1). Call each frame. */
  timeScale(dt: number): number {
    if (this.freezeLeft > 0) {
      this.freezeLeft -= dt;
      if (this.freezeLeft <= 0) this.rampT = 0;
      return 0;
    }
    if (this.rampT >= 0) {
      this.rampT += dt;
      const k = clamp(this.rampT / this.rampDur, 0, 1);
      if (k >= 1) {
        this.rampT = -1;
        this.barsEl.classList.remove("jjfx-on");
        return 1;
      }
      return this.rampFrom + (1 - this.rampFrom) * k * k;
    }
    return 1;
  }

  /** Start a freeze frame of `seconds` (topple: 0.3 s) followed by slow-mo ramp-up. */
  freeze(seconds: number): void {
    this.freezeLeft = Math.max(this.freezeLeft, seconds);
    this.rampT = -1;
    // Dramatic movie letterbox bars for the slow-mo, plus a camera-snap flash.
    this.barsEl.classList.add("jjfx-on");
    this.snapEl.getAnimations().forEach((a) => a.cancel());
    const peak = this.reduced ? 0.12 : 0.55;
    this.snapEl.animate([{ opacity: peak }, { opacity: 0 }], { duration: Math.max(250, seconds * 1000 + 150), easing: "ease-out", fill: "forwards" });
  }

  // ---------------------------------------------------------------------------------------- update

  update(dt: number, time: number): void {
    if (dt <= 0) {
      // Frozen: nothing moves (that's the joke), but keep the pools' draw state consistent.
      return;
    }
    this.updateConfetti(dt, time);
    this.updateBlobs(dt);
    this.updateCrumbs(dt);
    this.updateCoins(dt);
    this.updatePuffs(dt);
    this.updateSparkles(dt);
    this.updateWind(dt, time);
    this.updateDecals(dt);
  }

  private updateConfetti(dt: number, time: number): void {
    const pool = this.confettiPool;
    if (pool.live === 0) return pool.flush();
    const drag = Math.exp(-1.6 * dt);
    for (let i = 0; i < pool.cap; i++) {
      const st = pool.state[i];
      if (st === 0) continue;
      const life = (pool.life[i] += dt);
      const max = pool.max[i]!;
      if (life >= max) {
        pool.kill(i);
        continue;
      }
      const j = i * 3;
      if (st === 1) {
        pool.v[j] *= drag;
        pool.v[j + 2] *= drag;
        pool.integrate(i, dt, 9.0);
        // Paper flutter: low terminal velocity + a sideways sway.
        if (pool.v[j + 1]! < -0.55) pool.v[j + 1] += (-0.55 - pool.v[j + 1]!) * Math.min(1, 8 * dt);
        const ph = pool.phase[i]!;
        pool.p[j] += Math.sin(time * 5 + ph) * 0.25 * dt;
        pool.p[j + 2] += Math.cos(time * 4.3 + ph) * 0.25 * dt;
        const fy = floorY(pool.p[j]!, pool.p[j + 2]!);
        if (pool.p[j + 1]! < -3) {
          pool.kill(i);
          continue;
        }
        if (pool.v[j + 1]! < 0 && pool.p[j + 1]! <= fy + 0.003) {
          pool.state[i] = 2;
          pool.p[j + 1] = fy + 0.003 + Math.random() * 0.002;
          pool.r[j] = -Math.PI / 2;
          pool.r[j + 1] = 0;
          pool.r[j + 2] = rand(0, Math.PI * 2);
          if (max - life > 3) pool.max[i] = life + rand(2, 3);
        }
      }
      const tail = max - life;
      const k = (tail < 0.4 ? tail / 0.4 : 1) * (life < 0.08 ? life / 0.08 : 1);
      pool.write(i, k);
    }
    pool.flush();
  }

  private updateBlobs(dt: number): void {
    const pool = this.blobPool;
    if (pool.live === 0) return pool.flush();
    for (let i = 0; i < pool.cap; i++) {
      const st = pool.state[i];
      if (st === 0) continue;
      const life = (pool.life[i] += dt);
      const max = pool.max[i]!;
      if (life >= max) {
        pool.kill(i);
        continue;
      }
      const j = i * 3;
      let kx = 1;
      let ky = 1;
      if (st === 1) {
        pool.integrate(i, dt, 9.8);
        // Stretch along the fall like a cartoon droplet.
        const vy = pool.v[j + 1]!;
        const stretch = clamp(1 + Math.abs(vy) * 0.12, 1, 1.5);
        ky = stretch;
        kx = 1 / Math.sqrt(stretch);
        if (pool.p[j + 1]! < -3) {
          pool.kill(i);
          continue;
        }
        const fy = floorY(pool.p[j]!, pool.p[j + 2]!);
        if (vy < 0 && pool.p[j + 1]! <= fy + pool.s[j + 1]! * 0.3) {
          // SPLORT: flatten into a frosting puddle and stick.
          pool.state[i] = 2;
          pool.p[j + 1] = fy + pool.s[j + 1]! * 0.2;
          pool.r[j] = 0;
          pool.r[j + 2] = 0;
          pool.w[j] = 0; pool.w[j + 1] = 0; pool.w[j + 2] = 0;
          pool.phase[i] = 0; // reused as the landing wobble timer
        }
      } else {
        // Landed jiggle: a quick squash-wobble that settles.
        const t = (pool.phase[i] += dt);
        const wob = Math.exp(-6 * t) * Math.sin(t * 28);
        kx = 1.6 + wob * 0.3;
        ky = 0.32 - wob * 0.12;
      }
      const tail = max - life;
      const k = tail < 0.6 ? tail / 0.6 : 1;
      pool.write(i, k, kx, ky, kx);
    }
    pool.flush();
  }

  private updateCrumbs(dt: number): void {
    const pool = this.crumbPool;
    if (pool.live === 0) return pool.flush();
    for (let i = 0; i < pool.cap; i++) {
      const st = pool.state[i];
      if (st === 0) continue;
      const life = (pool.life[i] += dt);
      const max = pool.max[i]!;
      if (life >= max) {
        pool.kill(i);
        continue;
      }
      const j = i * 3;
      if (st === 1) {
        pool.integrate(i, dt, 9.8);
        if (pool.p[j + 1]! < -3) {
          pool.kill(i);
          continue;
        }
        const fy = floorY(pool.p[j]!, pool.p[j + 2]!);
        const half = pool.s[j + 1]! * 0.5;
        if (pool.v[j + 1]! < 0 && pool.p[j + 1]! <= fy + half) {
          pool.p[j + 1] = fy + half;
          if (pool.v[j + 1]! < -0.7) {
            pool.v[j + 1] *= -0.35;
            pool.v[j] *= 0.6;
            pool.v[j + 2] *= 0.6;
            pool.w[j] *= 0.5; pool.w[j + 1] *= 0.5; pool.w[j + 2] *= 0.5;
          } else {
            pool.state[i] = 2;
            pool.r[j] = Math.round(pool.r[j]! / (Math.PI / 2)) * (Math.PI / 2);
            pool.r[j + 2] = Math.round(pool.r[j + 2]! / (Math.PI / 2)) * (Math.PI / 2);
          }
        }
      }
      const tail = max - life;
      pool.write(i, tail < 0.4 ? tail / 0.4 : 1);
    }
    pool.flush();
  }

  private updateCoins(dt: number): void {
    // Shower spawner.
    if (this.showerLeft > 0) {
      this.showerLeft -= dt;
      this.showerAcc += dt * (this.reduced ? 35 : 55);
      while (this.showerAcc >= 1) {
        this.showerAcc -= 1;
        this.spawnShowerCoin();
      }
    } else {
      this.showerAcc = 0;
    }
    const pool = this.coinPool;
    if (pool.live === 0) return pool.flush();
    for (let i = 0; i < pool.cap; i++) {
      const st = pool.state[i];
      if (st === 0) continue;
      const j = i * 3;
      if (this.coinMode[i] === 1) {
        // Arc flight.
        if (this.coinDelay[i]! > 0) {
          this.coinDelay[i] -= dt;
          continue;
        }
        const t = (pool.life[i] += dt / pool.max[i]!);
        if (t >= 1) {
          this.sparkle(this.coinTo[j]!, this.coinTo[j + 1]!, this.coinTo[j + 2]!, 4, 0.03);
          pool.kill(i);
          this.payCoin(i);
          continue;
        }
        const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
        pool.p[j] = this.coinFrom[j]! + (this.coinTo[j]! - this.coinFrom[j]!) * e;
        pool.p[j + 1] = this.coinFrom[j + 1]! + (this.coinTo[j + 1]! - this.coinFrom[j + 1]!) * e + this.coinApex[i]! * 4 * t * (1 - t);
        pool.p[j + 2] = this.coinFrom[j + 2]! + (this.coinTo[j + 2]! - this.coinFrom[j + 2]!) * e;
        pool.r[j + 1] += pool.w[j + 1]! * dt;
        if (Math.random() < dt * 18) this.sparkle(pool.p[j]!, pool.p[j + 1]!, pool.p[j + 2]!, 1, 0.01);
        const k = t < 0.18 ? easeOutBack(t / 0.18) : t > 0.9 ? 1 - (t - 0.9) * 6 : 1;
        pool.write(i, k);
      } else {
        // Shower coin: tumble, bounce on the table, lie there glinting, then pop away.
        const life = (pool.life[i] += dt);
        const max = pool.max[i]!;
        if (life >= max) {
          pool.kill(i);
          continue;
        }
        if (st === 1) {
          pool.integrate(i, dt, 9.8);
          if (pool.p[j + 1]! < -3) {
            pool.kill(i);
            continue;
          }
          const fy = floorY(pool.p[j]!, pool.p[j + 2]!);
          const half = pool.s[j + 1]! * 0.11;
          if (pool.v[j + 1]! < 0 && pool.p[j + 1]! <= fy + half) {
            pool.p[j + 1] = fy + half;
            if (pool.v[j + 1]! < -1.2) {
              pool.v[j + 1] *= -0.38;
              pool.v[j] *= 0.5;
              pool.v[j + 2] *= 0.5;
              pool.w[j] *= 0.4; pool.w[j + 2] *= 0.4;
              if (Math.random() < 0.3) this.sparkle(pool.p[j]!, pool.p[j + 1]!, pool.p[j + 2]!, 2, 0.02);
            } else {
              pool.state[i] = 2;
              pool.r[j] = 0;
              pool.r[j + 2] = 0;
              pool.w[j] = 0; pool.w[j + 1] = 0; pool.w[j + 2] = 0;
            }
          }
        } else if (!this.reduced && Math.random() < dt * 0.6) {
          this.sparkle(pool.p[j]!, pool.p[j + 1]! + 0.01, pool.p[j + 2]!, 1, 0.015);
        }
        const tail = max - life;
        pool.write(i, tail < 0.35 ? tail / 0.35 : 1);
      }
    }
    pool.flush();
  }

  private updatePuffs(dt: number): void {
    const pool = this.puffPool;
    if (pool.live === 0) return pool.flush();
    const drag = Math.exp(-3.5 * dt);
    for (let i = 0; i < pool.cap; i++) {
      if (pool.state[i] === 0) continue;
      const life = (pool.life[i] += dt);
      const max = pool.max[i]!;
      if (life >= max) {
        pool.kill(i);
        continue;
      }
      const j = i * 3;
      pool.v[j] *= drag;
      pool.v[j + 2] *= drag;
      pool.v[j + 1] *= drag;
      pool.integrate(i, dt, -0.3);
      const t = life / max;
      // Pop up big with a cartoon overshoot, then shrink away.
      const k = t < 0.3 ? easeOutBack(t / 0.3) : 1 - Math.pow((t - 0.3) / 0.7, 1.6);
      pool.write(i, Math.max(0, k));
    }
    pool.flush();
  }

  private updateSparkles(dt: number): void {
    const pool = this.sparklePool;
    if (pool.live === 0) return pool.flush();
    for (let i = 0; i < pool.cap; i++) {
      if (pool.state[i] === 0) continue;
      const life = (pool.life[i] += dt);
      const max = pool.max[i]!;
      if (life >= max) {
        pool.kill(i);
        continue;
      }
      pool.integrate(i, dt, 0.5);
      const t = life / max;
      pool.write(i, t < 0.2 ? t / 0.2 : 1 - (t - 0.2) / 0.8);
    }
    pool.flush();
  }

  private updateWind(dt: number, time: number): void {
    if (this.windStrength > 0.01) {
      this.windAcc += dt * (5 + this.windStrength * 14);
      while (this.windAcc >= 1) {
        this.windAcc -= 1;
        this.spawnWind();
      }
    } else {
      this.windAcc = 0;
    }
    const pool = this.windPool;
    if (pool.live === 0) return pool.flush();
    for (let i = 0; i < pool.cap; i++) {
      if (pool.state[i] === 0) continue;
      const life = (pool.life[i] += dt);
      const max = pool.max[i]!;
      if (life >= max) {
        pool.kill(i);
        continue;
      }
      const j = i * 3;
      pool.integrate(i, dt, 0);
      // Gusty bob up and down.
      pool.p[j + 1] += Math.sin(time * 6 + pool.phase[i]!) * 0.12 * dt;
      const t = life / max;
      const k = Math.sin(Math.PI * t);
      pool.write(i, 1, 0.25 + k * 0.75, 0.6 + k * 0.4, 1);
    }
    pool.flush();
  }

  private updateDecals(dt: number): void {
    const HOLD = 9;
    const FADE = 1.5;
    for (const d of this.decals) {
      if (!d.alive) continue;
      d.t += dt;
      const t = d.t;
      // Slap down with a wobble, sit there shamefully, then fade away.
      const pop = t < 0.35 ? easeOutBack(t / 0.35) : 1 + Math.exp(-5 * (t - 0.35)) * Math.sin((t - 0.35) * 22) * 0.05;
      d.mesh.scale.set(d.size * pop, 1, d.size * pop * (1 + Math.max(0, 0.4 - t)));
      if (t > HOLD) d.mat.opacity = Math.max(0, 1 - (t - HOLD) / FADE);
      if (t > HOLD + FADE) {
        d.alive = false;
        d.mesh.visible = false;
      }
    }
  }

}
