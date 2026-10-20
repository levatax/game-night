// Static geometry batcher: collect primitives (geometry + material + transform), then build ONE merged mesh
// per material plus ONE merged inverted-hull outline mesh. Keeps the room to a handful of draw calls while
// keeping the toon outline look (each primitive's hull is scaled about its own origin before merging).
// Plain shared toon colors (toon(color) from the cache: no map, no emissive, opaque) are baked into vertex
// colors and all merge into ONE vertex-colored toon material per side, shared by every batch in the scene, so
// thirty little colored props cost one draw instead of thirty. Works inside moving groups too (door leaf,
// lamp shade, siren): build the batch in the group's local space and add it to that group.

import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "../../../../shared/constants";
import { isSharedToon, noShadow, toonRamp } from "../toon";

const outlineMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.BackSide });

const vertexColorMats = new Map<THREE.Side, THREE.MeshToonMaterial>();

/** The shared vertex-colored toon material (one per side) that baked plain colors merge into. */
export function vertexColorToon(side: THREE.Side = THREE.FrontSide): THREE.MeshToonMaterial {
  let mat = vertexColorMats.get(side);
  if (!mat) {
    mat = new THREE.MeshToonMaterial({ color: 0xffffff, gradientMap: toonRamp(), vertexColors: true, side });
    mat.name = "toon-vertex-color";
    vertexColorMats.set(side, mat);
  }
  return mat;
}

/** A cached, never-mutated plain toon color: safe to bake into vertex colors. */
function bakeable(mat: THREE.Material): mat is THREE.MeshToonMaterial {
  const t = mat as THREE.MeshToonMaterial;
  return (
    t.isMeshToonMaterial === true &&
    isSharedToon(t) &&
    !t.map &&
    !t.transparent &&
    t.opacity === 1 &&
    !t.alphaTest &&
    t.emissive.getHex() === 0 &&
    !(t.clippingPlanes && t.clippingPlanes.length)
  );
}

interface Part {
  geo: THREE.BufferGeometry;
  mat: THREE.Material;
}

export interface BatchOptions {
  /** Outline hull scale (0 = no outline). */
  outline?: number;
  castShadow?: boolean;
}

/** Normalize a geometry to non-indexed position/normal/uv so everything merges together. */
function normalize(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== "position" && name !== "normal" && name !== "uv") g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  if (!g.attributes.normal) g.computeVertexNormals();
  if (!g.attributes.uv) {
    const count = g.attributes.position!.count;
    g.setAttribute("uv", new THREE.Float32BufferAttribute(new Float32Array(count * 2), 2));
  }
  g.clearGroups();
  return g;
}

/** Paint a constant (linear) color into a `color` attribute. */
function paint(g: THREE.BufferGeometry, color: THREE.Color): void {
  const n = g.attributes.position!.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = color.r;
    arr[i * 3 + 1] = color.g;
    arr[i * 3 + 2] = color.b;
  }
  g.setAttribute("color", new THREE.Float32BufferAttribute(arr, 3));
}

export class StaticBatch {
  private parts: Part[] = [];
  private shadowParts: Part[] = [];
  private outlines: THREE.BufferGeometry[] = [];
  private m = new THREE.Matrix4();
  private s = new THREE.Matrix4();

  /** Add a primitive with a world (or batch-local) transform. */
  add(geo: THREE.BufferGeometry, mat: THREE.Material, matrix: THREE.Matrix4, opts: BatchOptions = {}): void {
    const g = normalize(geo).applyMatrix4(matrix);
    let use = mat;
    if (bakeable(mat)) {
      paint(g, mat.color);
      use = vertexColorToon(mat.side);
    }
    (opts.castShadow ? this.shadowParts : this.parts).push({ geo: g, mat: use });
    const thick = opts.outline ?? 0;
    if (thick > 0) {
      this.s.makeScale(thick, thick, thick);
      this.m.multiplyMatrices(matrix, this.s);
      const o = normalize(geo).applyMatrix4(this.m);
      o.deleteAttribute("uv");
      o.deleteAttribute("normal");
      this.outlines.push(o);
    }
  }

  /** Convenience: position / euler rotation / scale. */
  addAt(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    pos: THREE.Vector3Like,
    rot: THREE.Euler | null = null,
    scale: THREE.Vector3Like | number = 1,
    opts: BatchOptions = {},
  ): void {
    const q = new THREE.Quaternion();
    if (rot) q.setFromEuler(rot);
    const sc = typeof scale === "number" ? new THREE.Vector3(scale, scale, scale) : new THREE.Vector3(scale.x, scale.y, scale.z);
    const mtx = new THREE.Matrix4().compose(new THREE.Vector3(pos.x, pos.y, pos.z), q, sc);
    this.add(geo, mat, mtx, opts);
  }

  /**
   * Add every mesh under `root` (with its world transform relative to root). Outlines/shadows per options;
   * meshes with userData.noOutline or a transparent material get no hull, userData.castShadow forces a caster.
   */
  addObject(root: THREE.Object3D, opts: BatchOptions = {}): void {
    root.updateMatrixWorld(true);
    const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material) || mesh.name === "outline") return;
      const rel = new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld);
      const mat = mesh.material as THREE.Material;
      const outline = mesh.userData.noOutline || mat.transparent ? 0 : opts.outline;
      this.add(mesh.geometry, mat, rel, { outline, castShadow: opts.castShadow || mesh.userData.castShadow === true });
    });
  }

  /** Build merged meshes (receiveShadow on all, castShadow on the shadow group). */
  build(name = "batch"): THREE.Group {
    const group = new THREE.Group();
    group.name = name;
    const emit = (parts: Part[], cast: boolean) => {
      const byMat = new Map<THREE.Material, THREE.BufferGeometry[]>();
      for (const p of parts) {
        const list = byMat.get(p.mat);
        if (list) list.push(p.geo);
        else byMat.set(p.mat, [p.geo]);
      }
      for (const [mat, geos] of byMat) {
        const merged = geos.length === 1 ? geos[0]! : mergeGeometries(geos, false);
        if (geos.length > 1) for (const g of geos) g.dispose();
        if (!merged) continue;
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, mat);
        mesh.receiveShadow = true;
        mesh.castShadow = cast;
        mesh.matrixAutoUpdate = false;
        group.add(mesh);
      }
    };
    emit(this.parts, false);
    emit(this.shadowParts, true);
    if (this.outlines.length) {
      const merged = this.outlines.length === 1 ? this.outlines[0]! : mergeGeometries(this.outlines, false);
      if (this.outlines.length > 1) for (const g of this.outlines) g.dispose();
      if (merged) {
        merged.computeBoundingSphere();
        const mesh = new THREE.Mesh(merged, outlineMat);
        mesh.name = "outline";
        mesh.matrixAutoUpdate = false;
        mesh.raycast = () => {};
        noShadow(mesh);
        group.add(mesh);
      }
    }
    this.parts = [];
    this.shadowParts = [];
    this.outlines = [];
    return group;
  }
}

/** Shared ink outline material (for instanced / hand-built hulls). */
export function inkBackMaterial(): THREE.MeshBasicMaterial {
  return outlineMat;
}
