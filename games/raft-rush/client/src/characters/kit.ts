// Shared building blocks for every character, monster and the first-person arms: cached unit geometries
// (built once, shared by every instance), a merger that bakes many colored primitives into ONE vertex-colored
// geometry (one draw call per animated part), and the few materials characters own (hit flash, unlit face
// details, transparent first-person variants). Owner: client-characters.
//
// Everything here is cached for the page lifetime and never disposed: the whole cast is a few hundred KB.

import * as THREE from "three";
import { createOutlineMaterial, createToonMaterial, getOutlineMaterial, INK, vertexColorToon } from "../render/Toon";
import { mixHex } from "../util/color";

export type V3 = readonly [number, number, number];

/* ============================================================== geometry */

const geometries = new Map<string, THREE.BufferGeometry>();

/** Geometry cached under `key` (made once, shared, never disposed). */
export function cachedGeometry(key: string, make: () => THREE.BufferGeometry): THREE.BufferGeometry {
  let g = geometries.get(key);
  if (!g) {
    g = make();
    geometries.set(key, g);
  }
  return g;
}

/** Unit sphere (radius 1). Detail = width segments; height segments ≈ 2/3 of that. */
export function sphereGeo(segments = 10): THREE.BufferGeometry {
  return cachedGeometry(`sphere:${segments}`, () => new THREE.SphereGeometry(1, segments, Math.max(3, Math.round(segments * 0.66))));
}

/** Upper half of a unit sphere (dome), flat side at y = 0. */
export function domeGeo(segments = 10): THREE.BufferGeometry {
  return cachedGeometry(`dome:${segments}`, () => new THREE.SphereGeometry(1, segments, Math.max(2, Math.round(segments * 0.4)), 0, Math.PI * 2, 0, Math.PI / 2));
}

/**
 * Unit superellipsoid ("pillow"): a sphere pushed toward a cube, |x|^(2/eps) + |y|^(2/eps) + |z|^(2/eps) = 1.
 * eps = 1 is a sphere, ≈ 0.6 a soft rounded block. Normals are analytic, so the seams stay smooth.
 */
export function superSphereGeo(eps: number, segments = 14): THREE.BufferGeometry {
  return cachedGeometry(`super:${eps.toFixed(3)}:${segments}`, () => {
    const g = new THREE.SphereGeometry(1, segments, Math.max(4, Math.round(segments * 0.75)));
    const pos = g.getAttribute("position") as THREE.BufferAttribute;
    const nor = g.getAttribute("normal") as THREE.BufferAttribute;
    const n = new THREE.Vector3();
    for (let i = 0; i < pos.count; i++) {
      const v = [pos.getX(i), pos.getY(i), pos.getZ(i)];
      const p = v.map((c) => Math.sign(c) * Math.abs(c) ** eps);
      n.set(...(v.map((c) => Math.sign(c) * Math.abs(c) ** (2 - eps)) as [number, number, number])).normalize();
      pos.setXYZ(i, p[0]!, p[1]!, p[2]!);
      nor.setXYZ(i, n.x, n.y, n.z);
    }
    g.deleteAttribute("uv");
    return g;
  });
}

/** Capsule along +Y centered on the origin: total length `length + 2·radius`. */
export function capsuleGeo(radius: number, length: number, radial = 7, caps = 2): THREE.BufferGeometry {
  return cachedGeometry(`capsule:${radius.toFixed(4)}:${length.toFixed(4)}:${radial}:${caps}`, () => new THREE.CapsuleGeometry(radius, length, caps, radial));
}

/** Unit cylinder from y = 0 (radius 1) to y = 1 (radius `top`). */
export function cylinderGeo(top = 1, radial = 8, open = false): THREE.BufferGeometry {
  return cachedGeometry(`cyl:${top.toFixed(3)}:${radial}:${open ? 1 : 0}`, () => {
    const g = new THREE.CylinderGeometry(top, 1, 1, radial, 1, open);
    g.translate(0, 0.5, 0);
    return g;
  });
}

/** Unit cone: base radius 1 at y = 0, tip at y = 1. */
export function coneGeo(radial = 6): THREE.BufferGeometry {
  return cachedGeometry(`cone:${radial}`, () => {
    const g = new THREE.ConeGeometry(1, 1, radial, 1);
    g.translate(0, 0.5, 0);
    return g;
  });
}

/** Ring around +Y (lying in the XZ plane), radius 1, tube `tubeRatio`. `arc` < 2π opens it. */
export function torusGeo(tubeRatio: number, arc = Math.PI * 2, radial = 3, tubular = 10): THREE.BufferGeometry {
  return cachedGeometry(`torus:${tubeRatio.toFixed(3)}:${arc.toFixed(3)}:${radial}:${tubular}`, () => {
    const g = new THREE.TorusGeometry(1, tubeRatio, radial, tubular, arc);
    g.rotateX(Math.PI / 2);
    return g;
  });
}

/** Unit box centered on the origin. */
export function boxGeo(): THREE.BufferGeometry {
  return cachedGeometry("box", () => new THREE.BoxGeometry(1, 1, 1));
}

/** Lathe around +Y from a 2D profile (x = radius, y = height), cached by `key`. List points bottom → top. */
export function latheGeo(key: string, profile: ReadonlyArray<readonly [number, number]>, segments = 12): THREE.BufferGeometry {
  return cachedGeometry(`lathe:${key}:${segments}`, () => {
    const pts = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
    return new THREE.LatheGeometry(pts, segments);
  });
}

/** Flat 5-petal flower in the XY plane facing +Z (unit radius), for shirt prints. */
export function flowerGeo(): THREE.BufferGeometry {
  return cachedGeometry("flower", () => {
    const shape = new THREE.Shape();
    const petals = 5;
    const steps = petals * 4;
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * Math.PI * 2;
      const r = 0.55 + 0.45 * Math.abs(Math.cos((a * petals) / 2));
      const x = Math.sin(a) * r;
      const y = Math.cos(a) * r;
      if (i === 0) shape.moveTo(x, y);
      else shape.lineTo(x, y);
    }
    return new THREE.ShapeGeometry(shape, 1);
  });
}

/* ================================================================= merge */

/** One colored primitive placed by `matrix` (bone-local space). */
export interface Prim {
  geometry: THREE.BufferGeometry;
  matrix: THREE.Matrix4;
  color: THREE.Color;
}

const tmpV = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const tmpNM = new THREE.Matrix3();

/**
 * Bake primitives into one non-indexed geometry with position / normal / color (sRGB → linear handled by
 * THREE.Color). Normals keep each primitive's own smoothing; mirrored matrices get their winding fixed.
 */
export function mergePrims(prims: ReadonlyArray<Prim>): THREE.BufferGeometry {
  let total = 0;
  for (const p of prims) total += p.geometry.index ? p.geometry.index.count : p.geometry.getAttribute("position").count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const p of prims) {
    const g = p.geometry;
    const pa = g.getAttribute("position") as THREE.BufferAttribute;
    const na = g.getAttribute("normal") as THREE.BufferAttribute | undefined;
    const index = g.index;
    const count = index ? index.count : pa.count;
    tmpNM.getNormalMatrix(p.matrix);
    const flip = p.matrix.determinant() < 0;
    for (let i = 0; i < count; i++) {
      // Swap the 2nd and 3rd corner of every triangle when the matrix mirrors.
      let k = i;
      if (flip) {
        const corner = i % 3;
        if (corner === 1) k = i + 1;
        else if (corner === 2) k = i - 1;
      }
      const vi = index ? index.getX(k) : k;
      tmpV.fromBufferAttribute(pa, vi).applyMatrix4(p.matrix);
      if (na) tmpN.fromBufferAttribute(na, vi).applyMatrix3(tmpNM).normalize();
      else tmpN.set(0, 1, 0);
      pos[o] = tmpV.x;
      pos[o + 1] = tmpV.y;
      pos[o + 2] = tmpV.z;
      nor[o] = tmpN.x;
      nor[o + 1] = tmpN.y;
      nor[o + 2] = tmpN.z;
      col[o] = p.color.r;
      col[o + 1] = p.color.g;
      col[o + 2] = p.color.b;
      o += 3;
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  out.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  out.setAttribute("color", new THREE.BufferAttribute(col, 3));
  out.computeBoundingSphere();
  out.computeBoundingBox();
  return out;
}

/* ============================================================ placement */

const UP = new THREE.Vector3(0, 1, 0);
const tA = new THREE.Vector3();
const tB = new THREE.Vector3();
const tQ = new THREE.Quaternion();
const tE = new THREE.Euler();
const tS = new THREE.Vector3();

/** T · R(euler XYZ) · S. */
export function trs(at: V3, rot: V3 = [0, 0, 0], scale: V3 | number = 1): THREE.Matrix4 {
  tQ.setFromEuler(tE.set(rot[0], rot[1], rot[2]));
  if (typeof scale === "number") tS.setScalar(scale);
  else tS.set(scale[0], scale[1], scale[2]);
  return new THREE.Matrix4().compose(tA.set(at[0], at[1], at[2]), tQ, tS);
}

/** Matrix that maps a unit +Y primitive (from y = 0 to y = 1) onto the segment from → to, scaled (r, len, r). */
export function alongMatrix(from: V3, to: V3, radius: number, spin = 0): THREE.Matrix4 {
  tA.set(from[0], from[1], from[2]);
  tB.set(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const len = Math.max(1e-6, tB.length());
  tB.divideScalar(len);
  tQ.setFromUnitVectors(UP, tB);
  if (spin !== 0) tQ.multiply(new THREE.Quaternion().setFromAxisAngle(UP, spin));
  return new THREE.Matrix4().compose(tA, tQ, tS.set(radius, len, radius));
}

/** Matrix that aims +Y along `axis` at `at`, uniform `scale`. */
export function aimMatrix(at: V3, axis: V3, scale: V3 | number = 1): THREE.Matrix4 {
  tB.set(axis[0], axis[1], axis[2]).normalize();
  tQ.setFromUnitVectors(UP, tB);
  if (typeof scale === "number") tS.setScalar(scale);
  else tS.set(scale[0], scale[1], scale[2]);
  return new THREE.Matrix4().compose(tA.set(at[0], at[1], at[2]), tQ, tS);
}

/* ============================================================ materials */

/** The shared vertex-colored toon material (render/Toon): every baked body part uses it. Never mutate. */
export function bodyMaterial(): THREE.MeshToonMaterial {
  return vertexColorToon(THREE.FrontSide);
}

let flashMat: THREE.MeshToonMaterial | null = null;
/** Hit flash: the same vertex colors lit up white (swapped in for a few frames). */
export function flashMaterial(): THREE.MeshToonMaterial {
  if (!flashMat) {
    flashMat = createToonMaterial(0xffffff, { vertexColors: true, emissive: "#FFFFFF", emissiveIntensity: 0.55 });
    flashMat.name = "characters-flash";
  }
  return flashMat;
}

let faceMat: THREE.MeshBasicMaterial | null = null;
/** Unlit vertex colors for eyes / mouths / glints (they stay readable in any light). */
export function faceMaterial(): THREE.MeshBasicMaterial {
  if (!faceMat) {
    faceMat = new THREE.MeshBasicMaterial({ vertexColors: true });
    faceMat.name = "characters-face";
  }
  return faceMat;
}

/** Ink outline tinted toward a seat color (still reads as ink, but tells players apart). Shared cached. */
export function seatOutline(thickness: number, seatColor: string | null): THREE.ShaderMaterial {
  return getOutlineMaterial(thickness, seatColor ? mixHex(INK, seatColor, 0.42) : INK);
}

/** Shared plain ink outline. */
export function inkOutline(thickness: number): THREE.ShaderMaterial {
  return getOutlineMaterial(thickness, INK);
}

/** A new outline material that renders in the transparent pass (first-person arms, see fpArms.ts). */
export function overlayOutline(thickness: number): THREE.ShaderMaterial {
  const m = createOutlineMaterial(thickness, INK);
  m.transparent = true;
  m.depthWrite = true;
  return m;
}

const overlayClones = new WeakMap<THREE.Material, THREE.Material>();
/**
 * Transparent-pass twin of a material (same look, opacity 1, depth write on), cached per source. Used for
 * meshes that must draw after the depth clear of the first-person overlay.
 */
export function overlayMaterial<M extends THREE.Material>(source: M): M {
  let clone = overlayClones.get(source) as M | undefined;
  if (!clone) {
    clone = source.clone() as M;
    if (!clone.transparent) {
      clone.transparent = true;
      clone.depthWrite = true;
    }
    overlayClones.set(source, clone);
  }
  return clone;
}

/** Count triangles under `root` (outline shells included when `outlines`), for budgets / the dev harness. */
export function countTriangles(root: THREE.Object3D, outlines = true): number {
  let n = 0;
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    if (!outlines && o.userData.isOutline) return;
    const g = m.geometry;
    const pos = g.getAttribute("position");
    if (!pos) return;
    const verts = g.index ? g.index.count : pos.count;
    const inst = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh).count : 1;
    n += (verts / 3) * inst;
  });
  return Math.round(n);
}
