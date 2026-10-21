// Tiny geometry kit for the low-poly item meshes: primitives transformed and painted with one flat vertex color
// each, merged into a single BufferGeometry so every item is ONE draw call (+ its outline) on the shared
// vertex-colored toon material. Owner: client-fx-audio.
//
// All parts are converted to non-indexed triangles with position + normal + color only, so any mix of three's
// primitives merges cleanly. A deterministic per-vertex brightness jitter gives the hand-painted look
// (game4.md §16 "hash tabanlı renk titremesi"); no Math.random, so every client builds identical meshes.

import * as THREE from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

/** Position / Euler rotation (radians, XYZ) / scale of a part. Omitted = identity. */
export interface PartTransform {
  p?: readonly [number, number, number];
  r?: readonly [number, number, number];
  s?: readonly [number, number, number] | number;
}

const matrix = new THREE.Matrix4();
const quat = new THREE.Quaternion();
const euler = new THREE.Euler();
const pos = new THREE.Vector3();
const scl = new THREE.Vector3();
const color = new THREE.Color();

/** Collects painted parts and merges them. */
export class PartBuilder {
  private readonly parts: THREE.BufferGeometry[] = [];

  constructor(
    /** Brightness jitter amplitude per vertex (0 = flat color). */
    private readonly jitter = 0.07,
  ) {}

  /** Add `geo` (consumed: it is transformed in place and disposed after the merge) painted `hex`. */
  add(geo: THREE.BufferGeometry, hex: string, t: PartTransform = {}): this {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (g !== geo) geo.dispose();
    for (const name of Object.keys(g.attributes)) if (name !== "position" && name !== "normal") g.deleteAttribute(name);
    g.applyMatrix4(composePart(t));
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    paint(g, hex, this.jitter);
    this.parts.push(g);
    return this;
  }

  /** Same as add() but mirrored across the YZ plane (left/right pairs: claws, eyes, fins). */
  addMirrored(make: () => THREE.BufferGeometry, hex: string, t: PartTransform): this {
    this.add(make(), hex, t);
    const p = t.p ?? [0, 0, 0];
    const r = t.r ?? [0, 0, 0];
    return this.add(make(), hex, { p: [-p[0], p[1], p[2]], r: [r[0], -r[1], -r[2]], s: t.s });
  }

  /** Merge every part. `center` moves the bounding-box center to the origin; returns the applied shift. */
  build(center = true): { geometry: THREE.BufferGeometry; shift: THREE.Vector3 } {
    const merged = mergeGeometries(this.parts, false);
    if (!merged) throw new Error("[fx] item part merge failed");
    for (const p of this.parts) p.dispose();
    this.parts.length = 0;
    merged.computeBoundingBox();
    const shift = new THREE.Vector3();
    if (center && merged.boundingBox) {
      merged.boundingBox.getCenter(shift).negate();
      merged.translate(shift.x, shift.y, shift.z);
    }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    return { geometry: merged, shift };
  }
}

function composePart(t: PartTransform): THREE.Matrix4 {
  const p = t.p ?? [0, 0, 0];
  const r = t.r ?? [0, 0, 0];
  const s = t.s ?? 1;
  pos.set(p[0], p[1], p[2]);
  quat.setFromEuler(euler.set(r[0], r[1], r[2]));
  if (typeof s === "number") scl.setScalar(s);
  else scl.set(s[0], s[1], s[2]);
  return matrix.compose(pos, quat, scl);
}

/** Deterministic 0..1 hash of a vertex position (cosmetic jitter only). */
export function vertexHash(x: number, y: number, z: number): number {
  let h = Math.imul(Math.round(x * 1000) | 0, 0x27d4eb2d) ^ Math.imul(Math.round(y * 1000) | 0, 0x165667b1) ^ Math.imul(Math.round(z * 1000) | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
}

function paint(g: THREE.BufferGeometry, hex: string, jitter: number): void {
  const position = g.getAttribute("position");
  const colors = new Float32Array(position.count * 3);
  color.set(hex);
  for (let i = 0; i < position.count; i++) {
    const k = 1 + (vertexHash(position.getX(i), position.getY(i), position.getZ(i)) * 2 - 1) * jitter;
    colors[i * 3] = Math.min(1, color.r * k);
    colors[i * 3 + 1] = Math.min(1, color.g * k);
    colors[i * 3 + 2] = Math.min(1, color.b * k);
  }
  g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
}

/* ------------------------------------------------------------------ primitives */

/** Segment multiplier for the primitives below (the first-person close-up variant builds at ×2). */
let detail = 1;

/** Run `build` with every primitive's segment counts multiplied by `k`. */
export function withDetail<T>(k: number, build: () => T): T {
  const prev = detail;
  detail = k;
  try {
    return build();
  } finally {
    detail = prev;
  }
}

const seg = (n: number): number => Math.max(n, Math.round(n * detail));

/** Low-poly cylinder (or cone frustum) along Y, centered. */
export function cylinder(rTop: number, rBottom: number, height: number, sides = 7, openEnded = false): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(rTop, rBottom, height, seg(sides), 1, openEnded);
}

/** Cylinder along X (logs, skewers, reel axles). */
export function cylinderX(r: number, length: number, sides = 7): THREE.BufferGeometry {
  return new THREE.CylinderGeometry(r, r, length, seg(sides), 1).rotateZ(Math.PI / 2);
}

export function cone(r: number, height: number, sides = 6): THREE.BufferGeometry {
  return new THREE.ConeGeometry(r, height, seg(sides), 1);
}

export function sphere(r: number, wSeg = 8, hSeg = 6): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg(wSeg), seg(hSeg));
}

export function hemisphere(r: number, wSeg = 8, hSeg = 4): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, seg(wSeg), seg(hSeg), 0, Math.PI * 2, 0, Math.PI / 2);
}

export function box(w: number, h: number, d: number): THREE.BufferGeometry {
  return new THREE.BoxGeometry(w, h, d);
}

export function torus(r: number, tube: number, radial = 4, tubular = 10): THREE.BufferGeometry {
  return new THREE.TorusGeometry(r, tube, seg(radial), seg(tubular));
}

/** Lumpy low-poly rock: an icosahedron whose vertices are nudged by a deterministic hash. */
export function lumpyRock(r: number, lump = 0.18): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(r, detail >= 2 ? 1 : 0);
  const p = g.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const k = 1 + (vertexHash(x * 7, y * 7, z * 7) * 2 - 1) * lump;
    p.setXYZ(i, x * k, y * k, z * k);
  }
  g.computeVertexNormals();
  return g;
}

/** Lathe around Y from (radius, y) profile points (bottom to top). */
export function lathe(profile: ReadonlyArray<readonly [number, number]>, segments = 8): THREE.BufferGeometry {
  return new THREE.LatheGeometry(
    profile.map(([r, y]) => new THREE.Vector2(r, y)),
    seg(segments),
  );
}

/** Flat triangle fin in the XY plane (thickness along Z), apex at +X. */
export function fin(length: number, height: number, thickness = 0.012): THREE.BufferGeometry {
  const shape = new THREE.Shape();
  shape.moveTo(0, -height / 2);
  shape.lineTo(length, 0);
  shape.lineTo(0, height / 2);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, steps: 1 });
  g.translate(0, 0, -thickness / 2);
  return g;
}

/**
 * Tapered tube along a quadratic Bézier (kraken tentacle, curled rope ends). `radius(t)` gives the ring radius
 * at t ∈ [0, 1]; both ends are capped.
 */
export function taperedTube(
  a: THREE.Vector3,
  ctrl: THREE.Vector3,
  b: THREE.Vector3,
  radius: (t: number) => number,
  ringCount = 9,
  sideCount = 6,
): THREE.BufferGeometry {
  const rings = seg(ringCount);
  const sides = seg(sideCount);
  const curve = new THREE.QuadraticBezierCurve3(a, ctrl, b);
  const frames = curve.computeFrenetFrames(rings, false);
  const positions: number[] = [];
  const indices: number[] = [];
  const point = new THREE.Vector3();
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    curve.getPoint(t, point);
    const r = Math.max(0.002, radius(t));
    const n = frames.normals[i]!;
    const bn = frames.binormals[i]!;
    for (let k = 0; k < sides; k++) {
      const ang = (k / sides) * Math.PI * 2;
      const c = Math.cos(ang) * r;
      const s = Math.sin(ang) * r;
      positions.push(point.x + n.x * c + bn.x * s, point.y + n.y * c + bn.y * s, point.z + n.z * c + bn.z * s);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < sides; k++) {
      const p0 = i * sides + k;
      const p1 = i * sides + ((k + 1) % sides);
      const p2 = (i + 1) * sides + k;
      const p3 = (i + 1) * sides + ((k + 1) % sides);
      indices.push(p0, p1, p2, p1, p3, p2);
    }
  }
  // Caps: fans around each end ring's centroid.
  for (const [ring, flip] of [
    [0, true],
    [rings, false],
  ] as const) {
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let k = 0; k < sides; k++) {
      cx += positions[(ring * sides + k) * 3]!;
      cy += positions[(ring * sides + k) * 3 + 1]!;
      cz += positions[(ring * sides + k) * 3 + 2]!;
    }
    const center = positions.length / 3;
    positions.push(cx / sides, cy / sides, cz / sides);
    for (let k = 0; k < sides; k++) {
      const p0 = ring * sides + k;
      const p1 = ring * sides + ((k + 1) % sides);
      if (flip) indices.push(center, p1, p0);
      else indices.push(center, p0, p1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  g.computeVertexNormals();
  return g;
}

/** Point `i` of `n` on a unit Fibonacci sphere (even spike / sucker placement). */
export function fibonacciPoint(i: number, n: number, out = new THREE.Vector3()): THREE.Vector3 {
  const y = 1 - ((i + 0.5) / n) * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const phi = i * Math.PI * (3 - Math.sqrt(5));
  return out.set(Math.cos(phi) * r, y, Math.sin(phi) * r);
}
