// Piece-building kit: shared geometry / material caches, the PieceRig shape, and the silly face parts
// (googly eyes with their own pupil list, eyebrows, smiles, mouths, mustaches, sprinkles).
// Everything here is cached: building a second toaster allocates Object3Ds only, never new geometry.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { PieceType } from "../../../../shared/constants";
import { PALETTE } from "../../../../shared/constants";
import { toon, toonRamp } from "../toon";

// ------------------------------------------------------------------ rig
export type RigAnim = (rig: PieceRig, dt: number, time: number, speed: number) => void;
export type RigHit = (rig: PieceRig, intensity: number) => void;

/** Everything TowerView / PiecePreview need to animate one piece mesh. Lives in root.userData.rig. */
export interface PieceRig {
  type: PieceType;
  card: string;
  /** Positioned / rotated / scaled by the owner. */
  root: THREE.Group;
  /** Squash & stretch target (child of root). */
  body: THREE.Group;
  /** Googly pupils to jiggle. */
  pupils: THREE.Mesh[];
  /** Soft, long-lasting wobble (jelly type or Jelly Mode card). */
  jelly: boolean;
  anims: RigAnim[];
  hits: RigHit[];
  /** Named parts for anims. */
  parts: Record<string, THREE.Object3D>;
  /** Per-piece anim scratch numbers. */
  vars: Record<string, number>;
  /** 0..1 random per mesh (desyncs idle anims). */
  seed: number;
  /** Lowest local y of the mesh (squash pivots here). */
  bottom: number;
  /** Squash spring state. */
  sq: number;
  sqV: number;
}

export function newRig(type: PieceType, card: string): PieceRig {
  const root = new THREE.Group();
  root.name = `piece:${type}`;
  const body = new THREE.Group();
  body.name = "body";
  root.add(body);
  const rig: PieceRig = {
    type, card, root, body, pupils: [], jelly: false, anims: [], hits: [], parts: {}, vars: {},
    seed: Math.random(), bottom: 0, sq: 0, sqV: 0,
  };
  root.userData.rig = rig;
  return rig;
}

// ------------------------------------------------------------------ caches
const geos = new Map<string, THREE.BufferGeometry>();
/** Cached geometry by key (never disposed: shared by every mesh of every piece). */
export function geo<T extends THREE.BufferGeometry>(key: string, make: () => T): T {
  let g = geos.get(key) as T | undefined;
  if (!g) {
    g = make();
    geos.set(key, g);
  }
  return g;
}

export const G = {
  sphere: (r: number, w = 16, h = 12) => geo(`sph|${r}|${w}|${h}`, () => new THREE.SphereGeometry(r, w, h)),
  box: (x: number, y: number, z: number) => geo(`box|${x}|${y}|${z}`, () => new THREE.BoxGeometry(x, y, z)),
  rbox: (x: number, y: number, z: number, r: number) => geo(`rbox|${x}|${y}|${z}|${r}`, () => new RoundedBoxGeometry(x, y, z, 3, r)),
  cyl: (rt: number, rb: number, h: number, seg = 20) => geo(`cyl|${rt}|${rb}|${h}|${seg}`, () => new THREE.CylinderGeometry(rt, rb, h, seg)),
  capsule: (r: number, len: number, rad = 12) => geo(`cap|${r}|${len}|${rad}`, () => new THREE.CapsuleGeometry(r, len, 5, rad)),
  cone: (r: number, h: number, seg = 12) => geo(`cone|${r}|${h}|${seg}`, () => new THREE.ConeGeometry(r, h, seg)),
  torus: (R: number, t: number, arc = Math.PI * 2, ts = 24) => geo(`tor|${R}|${t}|${arc}|${ts}`, () => new THREE.TorusGeometry(R, t, 8, ts, arc)),
  lathe: (key: string, pts: [number, number][], seg = 24) => geo(`lathe|${key}`, () => new THREE.LatheGeometry(pts.map(([x, y]) => new THREE.Vector2(x, y)), seg)),
  /** Unit sphere: scale the mesh for blobs (cheap ellipsoids). */
  blob: () => G.sphere(1, 14, 10),
};

const mats = new Map<string, THREE.Material>();
export function cachedMat<T extends THREE.Material>(key: string, make: () => T): T {
  let m = mats.get(key) as T | undefined;
  if (!m) {
    m = make();
    mats.set(key, m);
  }
  return m;
}
/** Shared toon material for a color. */
export const M = (color: THREE.ColorRepresentation) => toon(color);
export const INK = new THREE.MeshBasicMaterial({ color: PALETTE.ink });
export const WHITE = "#FFFFFF";
export const PINK = "#FF7FA8";
/** Faceted copy of a geometry (flat normals: pleated cupcake wrappers). */
export function faceted(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  return geo(`facet|${key}`, () => {
    const g = make().toNonIndexed();
    g.computeVertexNormals();
    return g;
  });
}
/** Transparent, unlit-ish fluff (bubbles, steam). Not outlined (addOutlines skips transparent). */
export function softMat(color: string, opacity: number): THREE.MeshBasicMaterial {
  return cachedMat(`soft|${color}|${opacity}`, () => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
}

// ------------------------------------------------------------------ mesh helpers
export function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
  const me = new THREE.Mesh(g, m);
  me.position.set(x, y, z);
  me.castShadow = true;
  me.receiveShadow = true;
  parent.add(me);
  return me;
}
/** Mesh that should not get an outline nor a Jelly-Mode material swap (faces, tiny details). */
export function detail(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0): THREE.Mesh {
  const me = mesh(g, m, parent, x, y, z);
  me.castShadow = false;
  me.userData.noOutline = true;
  me.userData.face = true;
  return me;
}
/** Ellipsoid blob from the shared unit sphere. */
export function blob(m: THREE.Material, parent: THREE.Object3D, pos: [number, number, number], scale: [number, number, number], outline = false): THREE.Mesh {
  const me = outline ? mesh(G.blob(), m, parent, ...pos) : detail(G.blob(), m, parent, ...pos);
  me.scale.set(...scale);
  return me;
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
/** Place `obj` at `pos` with its +Z pointing along `normal` and its +Y as close to `up` as possible. */
export function orient(obj: THREE.Object3D, pos: [number, number, number], normal: [number, number, number], up: [number, number, number] = [0, 1, 0]): THREE.Object3D {
  _z.set(...normal).normalize();
  _y.set(...up).normalize();
  if (Math.abs(_y.dot(_z)) > 0.999) _y.set(0, 0, -1);
  _x.crossVectors(_y, _z).normalize();
  _y.crossVectors(_z, _x).normalize();
  _m.makeBasis(_x, _y, _z);
  obj.quaternion.setFromRotationMatrix(_m);
  obj.position.set(...pos);
  return obj;
}
/** A group that faces along `normal` (face parts are authored facing +Z). */
export function facePlate(parent: THREE.Object3D, pos: [number, number, number], normal: [number, number, number], up?: [number, number, number]): THREE.Group {
  const g = new THREE.Group();
  orient(g, pos, normal, up);
  parent.add(g);
  return g;
}

// ------------------------------------------------------------------ googly eyes
/** One googly eye facing +Z of `parent` at (x, y, z). Pupil is registered on the rig. */
export function eye(rig: PieceRig, parent: THREE.Object3D, size: number, x = 0, y = 0, z = 0): THREE.Mesh {
  const white = mesh(G.sphere(size, 14, 10), M(WHITE), parent, x, y, z);
  white.castShadow = false;
  white.userData.face = true;
  const pupil = detail(G.sphere(size * 0.52, 10, 8), INK, white, 0, 0, size * 0.7);
  pupil.name = "pupil";
  pupil.userData.vel = new THREE.Vector2();
  pupil.userData.off = new THREE.Vector2((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.4);
  pupil.userData.r = size;
  rig.pupils.push(pupil);
  return white;
}

export type BrowStyle = "none" | "angry" | "worried" | "smug" | "posh";
export interface EyesOpts {
  size?: number;
  spacing?: number;
  /** Per-eye sizes (derpy mismatched eyes). */
  sizes?: [number, number];
  /** 0..1 eyelid droop (smug / sleepy). */
  lids?: number;
  lidColor?: string;
  brows?: BrowStyle;
  /** Brow color (default ink; use something light on dark pieces). */
  browColor?: string;
}
/** Two googly eyes on a face plate (+Z facing). Returns the plate. */
export function eyes(rig: PieceRig, plate: THREE.Object3D, o: EyesOpts = {}): THREE.Object3D {
  const size = o.size ?? 0.02;
  const spacing = o.spacing ?? size * 1.25;
  [-1, 1].forEach((side, i) => {
    const s = o.sizes ? o.sizes[i] : size;
    const w = eye(rig, plate, s, side * spacing, 0, 0);
    if (o.lids && o.lids > 0) {
      const lid = detail(geo(`lid|${s}`, () => new THREE.SphereGeometry(s * 1.12, 14, 6, 0, Math.PI * 2, 0, Math.PI / 2)), M(o.lidColor ?? WHITE), w);
      lid.rotation.x = 0.25 + o.lids * 1.0;
    }
    const style = o.brows ?? "none";
    if (style !== "none") {
      const brow = detail(G.box(s * 1.5, s * 0.3, s * 0.35), o.browColor ? M(o.browColor) : INK, plate, side * spacing, s * 1.35, s * 0.4);
      // side -1 = viewer's left eye; its inner end is +x.
      const tilt = style === "angry" ? 0.5 : style === "worried" ? -0.45 : style === "posh" ? 0.12 * -side : 0;
      brow.rotation.z = side * tilt;
      if (style === "smug" && side === 1) {
        brow.position.y += s * 0.45;
        brow.rotation.z = 0.25;
      } else if (style === "smug") {
        brow.rotation.z = 0.12;
      }
    }
  });
  return plate;
}

/** Spring the pupils around; `shake` = how much the piece moves (m/s-ish). Allocation-free. */
export function jigglePupils(rig: PieceRig, dt: number, shake: number): void {
  const kick = Math.min(shake, 4) * 0.02 + 0.0004;
  for (const p of rig.pupils) {
    const v = p.userData.vel as THREE.Vector2;
    const off = p.userData.off as THREE.Vector2;
    v.x += (Math.random() - 0.5) * kick - off.x * 120 * dt;
    v.y += (Math.random() - 0.5) * kick - (off.y + 0.12) * 120 * dt; // gravity-ish: pupils sag a bit
    v.multiplyScalar(Math.max(0, 1 - 6 * dt));
    off.x += v.x * dt * 60;
    off.y += v.y * dt * 60;
    const len = Math.hypot(off.x, off.y);
    if (len > 0.45) off.multiplyScalar(0.45 / len);
    const r = p.userData.r as number;
    p.position.set(off.x * r, off.y * r, r * 0.7);
  }
}

// ------------------------------------------------------------------ mouths
/** Torus-arc smile (or frown) centered at (x, y) on a +Z face plate. */
export function smile(plate: THREE.Object3D, width: number, o: { arc?: number; thick?: number; frown?: boolean; x?: number; y?: number; tilt?: number; mat?: THREE.Material } = {}): THREE.Mesh {
  const arc = o.arc ?? Math.PI * 0.7;
  const R = width / 2 / Math.sin(arc / 2);
  const t = o.thick ?? width * 0.09;
  const holder = new THREE.Group();
  holder.position.set(o.x ?? 0, o.y ?? 0, t * 0.5);
  holder.rotation.z = o.tilt ?? 0;
  plate.add(holder);
  const m = detail(G.torus(R, t, arc, 16), o.mat ?? INK, holder);
  const mid = (R * (1 + Math.cos(arc / 2))) / 2;
  if (o.frown) {
    m.rotation.z = Math.PI / 2 - arc / 2;
    m.position.y = -mid;
  } else {
    m.rotation.z = -Math.PI / 2 - arc / 2;
    m.position.y = mid;
  }
  return m;
}

/** Open "O" / grin mouth: dark oval + optional pink tongue + teeth. */
export function openMouth(plate: THREE.Object3D, w: number, h: number, o: { x?: number; y?: number; tongue?: boolean; teeth?: number; buck?: boolean } = {}): THREE.Group {
  const g = new THREE.Group();
  g.position.set(o.x ?? 0, o.y ?? 0, 0);
  plate.add(g);
  blob(INK, g, [0, 0, 0], [w / 2, h / 2, Math.min(w, h) * 0.25]);
  if (o.tongue) blob(M(PINK), g, [0, -h * 0.22, Math.min(w, h) * 0.12], [w * 0.3, h * 0.22, Math.min(w, h) * 0.18]);
  const n = o.teeth ?? 0;
  for (let i = 0; i < n; i++) {
    const tw = (w * 0.8) / n;
    detail(G.box(tw * 0.85, h * 0.3, h * 0.12), M(WHITE), g, -w * 0.4 + tw * (i + 0.5), h * 0.3, Math.min(w, h) * 0.2);
  }
  if (o.buck) {
    for (const s of [-1, 1]) detail(G.box(w * 0.2, h * 0.55, h * 0.15), M(WHITE), g, s * w * 0.11, h * 0.25, Math.min(w, h) * 0.22);
  }
  return g;
}

/** Curly mustache (two torus arcs) on a +Z face plate. */
export function mustache(plate: THREE.Object3D, width: number, color: string, y = 0): THREE.Group {
  const g = new THREE.Group();
  g.position.y = y;
  plate.add(g);
  const R = width * 0.28;
  for (const side of [-1, 1]) {
    // Mirror in a holder so the left half is the true mirror image of the right one.
    const holder = new THREE.Group();
    holder.position.set(side * R * 0.95, R * 0.55, R * 0.2);
    holder.scale.x = side;
    g.add(holder);
    const m = detail(G.torus(R, R * 0.32, Math.PI * 1.25, 14), M(color), holder);
    // A U-shaped arc whose outer end curls up.
    m.rotation.z = -Math.PI / 2 - (Math.PI * 1.25) / 2 + 0.35;
  }
  return g;
}

/** Rosy cheeks. */
export function cheeks(plate: THREE.Object3D, spacing: number, size: number, y = 0): void {
  for (const s of [-1, 1]) blob(softMat("#FF6F91", 0.55), plate, [s * spacing, y, size * 0.2], [size, size * 0.6, size * 0.2]);
}

// ------------------------------------------------------------------ sprinkles
const SPRINKLE_COLORS = ["#FF5A5F", "#3FA7FF", "#7BE07B", "#FFC23F", "#B07CFF", "#FFFFFF", "#FF8BD1"];
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** One merged vertex-colored geometry of `count` sprinkles; `place` returns [x, y, z, yaw, tilt]. */
export function sprinkleGeo(key: string, count: number, place: (r: () => number) => [number, number, number, number, number]): THREE.BufferGeometry {
  return geo(`sprinkles|${key}`, () => {
    const r = rng(count * 7919 + key.length * 31);
    const parts: THREE.BufferGeometry[] = [];
    const m4 = new THREE.Matrix4();
    const e = new THREE.Euler();
    const q = new THREE.Quaternion();
    const c = new THREE.Color();
    for (let i = 0; i < count; i++) {
      const g = new THREE.CapsuleGeometry(0.0022, 0.008, 2, 5);
      const [x, y, z, yaw, tilt] = place(r);
      e.set(Math.PI / 2 + tilt, yaw, 0, "YXZ");
      q.setFromEuler(e);
      m4.compose(new THREE.Vector3(x, y, z), q, new THREE.Vector3(1, 1, 1));
      g.applyMatrix4(m4);
      c.set(SPRINKLE_COLORS[i % SPRINKLE_COLORS.length]);
      const n = g.getAttribute("position").count;
      const col = new Float32Array(n * 3);
      for (let k = 0; k < n; k++) col.set([c.r, c.g, c.b], k * 3);
      g.setAttribute("color", new THREE.BufferAttribute(col, 3));
      parts.push(g.index ? g.toNonIndexed() : g);
    }
    const merged = mergeGeometries(parts, false) ?? new THREE.BufferGeometry();
    for (const p of parts) p.dispose();
    return merged;
  });
}
export function sprinkleMat(): THREE.MeshToonMaterial {
  return cachedMat("sprinkles", () => new THREE.MeshToonMaterial({ color: "#FFFFFF", vertexColors: true, gradientMap: toonRamp() }));
}

// ------------------------------------------------------------------ canvas textures
const texs = new Map<string, THREE.Texture>();
export function canvasTex(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void): THREE.Texture {
  let t = texs.get(key);
  if (t) return t;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  if (ctx) draw(ctx);
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  texs.set(key, t);
  return t;
}
/** 4-point cartoon sparkle (for sprites). */
export function sparkleTex(): THREE.Texture {
  return canvasTex("sparkle", 64, 64, (ctx) => {
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.25, "rgba(255,245,180,0.9)");
    g.addColorStop(1, "rgba(255,220,80,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const r = i % 2 === 0 ? 31 : 7;
      ctx.lineTo(32 + Math.cos(a) * r, 32 + Math.sin(a) * r);
    }
    ctx.closePath();
    ctx.fill();
  });
}
export function sparkleMat(color = "#FFF6B0"): THREE.SpriteMaterial {
  return cachedMat(`sparkle|${color}`, () => new THREE.SpriteMaterial({ map: sparkleTex(), color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
}
/** Sprite that other modules' raycasts ignore (Sprite.raycast needs a camera). */
export function sprite(m: THREE.SpriteMaterial, parent: THREE.Object3D, size: number, x = 0, y = 0, z = 0): THREE.Sprite {
  const s = new THREE.Sprite(m);
  s.scale.set(size, size, 1);
  s.position.set(x, y, z);
  s.raycast = () => {};
  s.userData.face = true;
  parent.add(s);
  return s;
}
