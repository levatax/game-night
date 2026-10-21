// Bakes many small primitive parts into ONE vertex-colored geometry (one draw call per prop, landmark or
// flora archetype). Parts keep their own normals (smooth spheres stay smooth), or get faceted face normals
// when added with `flat` for the low-poly look. Owner: client-render. Copied from
// games/bonk-brawl/client/src/render/arena/Baker.ts (zero imports besides three; characters may use it).

import * as THREE from "three";

const tmpNormal = new THREE.Matrix3();
const tmpV = new THREE.Vector3();
const tmpColor = new THREE.Color();
const ab = new THREE.Vector3();
const ac = new THREE.Vector3();
const faceN = new THREE.Vector3();
const IDENTITY = new THREE.Matrix4();

export class Baker {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly colors: number[] = [];

  /**
   * Append `geometry` transformed by `matrix` in a flat color. CONSUMES the geometry (it is
   * disposed after copying), so always pass a freshly created one.
   */
  add(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, matrix: THREE.Matrix4 = IDENTITY, flat = false): void {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const pos = source.getAttribute("position");
    if (!flat && !source.getAttribute("normal")) source.computeVertexNormals();
    const nor = flat ? null : source.getAttribute("normal");
    tmpNormal.getNormalMatrix(matrix);
    tmpColor.set(color);
    const start = this.positions.length;
    for (let i = 0; i < pos.count; i++) {
      tmpV.fromBufferAttribute(pos, i).applyMatrix4(matrix);
      this.positions.push(tmpV.x, tmpV.y, tmpV.z);
      this.colors.push(tmpColor.r, tmpColor.g, tmpColor.b);
      if (nor) {
        tmpV.fromBufferAttribute(nor, i).applyMatrix3(tmpNormal).normalize();
        this.normals.push(tmpV.x, tmpV.y, tmpV.z);
      }
    }
    if (flat) this.pushFaceNormals(start);
    if (source !== geometry) source.dispose();
    geometry.dispose();
  }

  /**
   * Like add() but keeps the geometry's own `color` attribute (e.g. a MeshBuilder soup with per-face colors);
   * falls back to white when it has none. CONSUMES the geometry.
   */
  addVertexColored(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4 = IDENTITY, flat = false): void {
    const source = geometry.index ? geometry.toNonIndexed() : geometry;
    const colors = source.getAttribute("color");
    const start = this.colors.length;
    this.add(source === geometry ? geometry : source.clone(), 0xffffff, matrix, flat);
    if (colors) {
      for (let i = 0; i < colors.count; i++) {
        this.colors[start + i * 3] = colors.getX(i);
        this.colors[start + i * 3 + 1] = colors.getY(i);
        this.colors[start + i * 3 + 2] = colors.getZ(i);
      }
    }
    if (source !== geometry) {
      source.dispose();
      geometry.dispose();
    }
  }

  /** Same as add() with a TRS built from position / Y-rotation-free euler / scale. */
  addAt(
    geometry: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    position: THREE.Vector3Like,
    rotation: THREE.Euler | null = null,
    scale: THREE.Vector3Like | number = 1,
    flat = false,
  ): void {
    this.add(geometry, color, composeMatrix(position, rotation, scale), flat);
  }

  /** Append another baker's triangles transformed by `matrix` (used to place a pre-baked item). */
  merge(other: Baker, matrix: THREE.Matrix4 = IDENTITY): void {
    tmpNormal.getNormalMatrix(matrix);
    for (let i = 0; i < other.positions.length; i += 3) {
      tmpV.set(other.positions[i], other.positions[i + 1], other.positions[i + 2]).applyMatrix4(matrix);
      this.positions.push(tmpV.x, tmpV.y, tmpV.z);
      tmpV.set(other.normals[i], other.normals[i + 1], other.normals[i + 2]).applyMatrix3(tmpNormal).normalize();
      this.normals.push(tmpV.x, tmpV.y, tmpV.z);
      this.colors.push(other.colors[i], other.colors[i + 1], other.colors[i + 2]);
    }
  }

  /**
   * Like add() (always faceted) but every triangle's color is jittered in lightness by up to ±`jitter`
   * (0..0.3) from a hash of its centroid, so low-poly foliage / rocks read as many facets. CONSUMES the geometry.
   */
  addVaried(
    geometry: THREE.BufferGeometry,
    color: THREE.ColorRepresentation,
    matrix: THREE.Matrix4 = IDENTITY,
    jitter = 0.08,
    seed = 0,
  ): void {
    const start = this.positions.length;
    this.add(geometry, color, matrix, true);
    const p = this.positions;
    const c = this.colors;
    for (let i = start; i < p.length; i += 9) {
      const cx = (p[i] + p[i + 3] + p[i + 6]) / 3;
      const cy = (p[i + 1] + p[i + 4] + p[i + 7]) / 3;
      const cz = (p[i + 2] + p[i + 5] + p[i + 8]) / 3;
      const k = 1 + (faceHash(cx, cy, cz, seed) * 2 - 1) * jitter;
      for (let v = 0; v < 9; v++) c[i + v] = Math.min(1, c[i + v] * k);
    }
  }

  /** Multiply the colors of every vertex below `y` (in baked space) toward `shade` (ambient-occlusion-ish base). */
  shadeBelow(y: number, falloff: number, amount: number): void {
    const p = this.positions;
    const c = this.colors;
    for (let i = 0; i < p.length; i += 3) {
      const t = Math.max(0, Math.min(1, (y - p[i + 1]) / Math.max(1e-3, falloff)));
      const k = 1 - t * amount;
      c[i] *= k;
      c[i + 1] *= k;
      c[i + 2] *= k;
    }
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  /** Triangles baked so far (render budget bookkeeping). */
  get triangles(): number {
    return this.positions.length / 9;
  }

  /** Build the geometry with positions re-centered by subtracting `origin`. */
  build(origin: THREE.Vector3Like = { x: 0, y: 0, z: 0 }): THREE.BufferGeometry {
    const pos = new Float32Array(this.positions.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = this.positions[i] - origin.x;
      pos[i + 1] = this.positions[i + 1] - origin.y;
      pos[i + 2] = this.positions[i + 2] - origin.z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("normal", new THREE.Float32BufferAttribute(this.normals, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.computeBoundingSphere();
    return geometry;
  }

  private pushFaceNormals(start: number): void {
    const p = this.positions;
    for (let i = start; i < p.length; i += 9) {
      ab.set(p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]);
      ac.set(p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]);
      faceN.crossVectors(ab, ac).normalize();
      for (let k = 0; k < 3; k++) this.normals.push(faceN.x, faceN.y, faceN.z);
    }
  }
}

/**
 * Turn an open surface (funnel, umbrella, hull skin) into a thin closed shell: every triangle plus a copy in
 * reverse winding pushed `thickness` behind it, so it bakes visibly from both sides into a FrontSide material
 * and inverted-hull outlines (which need distinct front / back vertices) still work. CONSUMES the geometry.
 */
export function doubleSided(geometry: THREE.BufferGeometry, thickness = 0.02): THREE.BufferGeometry {
  const src = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = src.getAttribute("position");
  const out = new Float32Array(pos.count * 6);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const base = pos.count * 3;
  for (let t = 0; t + 2 < pos.count; t += 3) {
    a.fromBufferAttribute(pos, t);
    b.fromBufferAttribute(pos, t + 1);
    c.fromBufferAttribute(pos, t + 2);
    n.subVectors(b, a).cross(c.clone().sub(a));
    if (n.lengthSq() > 0) n.normalize();
    const verts = [a, b, c];
    for (let k = 0; k < 3; k++) {
      const v = verts[k]!;
      out[(t + k) * 3] = v.x;
      out[(t + k) * 3 + 1] = v.y;
      out[(t + k) * 3 + 2] = v.z;
      // Reverse winding: a, c, b — pushed behind the face.
      const r = verts[k === 0 ? 0 : k === 1 ? 2 : 1]!;
      out[base + (t + k) * 3] = r.x - n.x * thickness;
      out[base + (t + k) * 3 + 1] = r.y - n.y * thickness;
      out[base + (t + k) * 3 + 2] = r.z - n.z * thickness;
    }
  }
  if (src !== geometry) src.dispose();
  geometry.dispose();
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(out, 3));
  return g;
}

/** Hash of a point in [0, 1) (cosmetic facet jitter). */
function faceHash(x: number, y: number, z: number, seed: number): number {
  let h = Math.imul(Math.round(x * 997), 374761393) ^ Math.imul(Math.round(y * 991), 668265263) ^ Math.imul(Math.round(z * 983), 1274126177) ^ seed;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const tmpQuat = new THREE.Quaternion();
const tmpPos = new THREE.Vector3();
const tmpScale = new THREE.Vector3();

/** Matrix from position + optional euler + uniform or per-axis scale. */
export function composeMatrix(
  position: THREE.Vector3Like,
  rotation: THREE.Euler | null = null,
  scale: THREE.Vector3Like | number = 1,
  out: THREE.Matrix4 = new THREE.Matrix4(),
): THREE.Matrix4 {
  tmpPos.set(position.x, position.y, position.z);
  if (rotation) tmpQuat.setFromEuler(rotation);
  else tmpQuat.identity();
  if (typeof scale === "number") tmpScale.setScalar(scale);
  else tmpScale.set(scale.x, scale.y, scale.z);
  return out.compose(tmpPos, tmpQuat, tmpScale);
}
