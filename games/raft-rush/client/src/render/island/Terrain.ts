// Island terrain: the shared heightfield as vertex-colored chunks in ONE BatchedMesh (game4.md §16/§20). Colors
// are computed once per grid vertex from the muted island palette (flora/palette.ts) and interpolated across
// each triangle, so the low wide island reads as soft bands instead of a patchwork:
//   seabed → dark wet-sand band at the waterline (with a faint grazing-angle sheen in the shader) → dry sand with
//   large-scale tone drift → a noise-broken sand→grass fringe (never a hard height line) → olive / sage lowland
//   grass, lusher in damp hollows, deep green forest floor under the actual trees (splatted from the node list),
//   exposed soil on medium slopes and rock on steep faces / rugged peaks; swamp mud, volcanic ash, trodden paths
//   wreck ↔ camp ↔ raft and a camp clearing. Large-scale macro noise and a cavity term (hollows a little darker,
//   ridges a little lighter) keep the wide plateau from reading as one flat color.
// Normals are the heightfield's smooth (central-difference) normals blended with a little of each face normal,
// so gentle ground shades smoothly under the toon ramp while the low-poly facets still show on slopes. Deep-sea
// cells hidden under opaque water are skipped. Sizes come from the IslandDef grid (no hardcoded island size).
// Owner: client-render.

import * as THREE from "three";
import { BEACH_MAX_Y, BIOMES } from "../../../../shared/constants";
import type { IslandDef, XZ } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { fbm2, hash2, valueNoise2 } from "../noise";
import { createToonMaterial } from "../Toon";
import { groundPalette } from "./flora/palette";

/** Minimum cells per chunk side; big grids use ~3 chunks per side so per-chunk culling still pays. */
const CHUNK_MIN_CELLS = 48;
/** Cells whose four corners are all deeper than this are invisible under the opaque deep water. */
const SKIP_DEPTH = -2.4;
/** Half width of the trodden paths (m). */
export const PATH_HALF = 1.1;
export const CLEARING_RADIUS = 3.4;
/** Box-blur radius (cells) of the height used for the hollow / ridge (cavity) shading. */
const CAVITY_RADIUS = 3;
/** How much of the face normal is kept in the blended shading normal (0 = fully smooth). */
const FACET = 0.3;
/** Per-face value jitter (± fraction) for a faint low-poly texture. */
const FACE_JITTER = 0.035;

export interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

/** The trodden paths of every camp (wreck ↔ fire, wreck ↔ raft, fire ↔ chest) and the clearings (fires). */
export function campPaths(def: IslandDef): { paths: Segment[]; clearings: XZ[] } {
  const paths: Segment[] = [];
  const clearings: XZ[] = [];
  for (const s of def.sites) {
    paths.push({ ax: s.wreck.x, az: s.wreck.z, bx: s.campfire.x, bz: s.campfire.z });
    paths.push({ ax: s.wreck.x, az: s.wreck.z, bx: s.raft.x, bz: s.raft.z });
    paths.push({ ax: s.campfire.x, az: s.campfire.z, bx: s.chest.x, bz: s.chest.z });
    clearings.push(s.campfire);
  }
  return { paths, clearings };
}

export function segmentDistance(s: Segment, x: number, z: number): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
  const px = s.ax + dx * t - x;
  const pz = s.az + dz * t - z;
  return Math.sqrt(px * px + pz * pz);
}

interface Palette {
  seabed: THREE.Color;
  seabedDeep: THREE.Color;
  wetSand: THREE.Color;
  sandLight: THREE.Color;
  sandDark: THREE.Color;
  grassDry: THREE.Color;
  grass: THREE.Color;
  grassLush: THREE.Color;
  forestFloor: THREE.Color;
  rock: THREE.Color;
  rockDark: THREE.Color;
  dirt: THREE.Color;
  mud: THREE.Color;
  ash: THREE.Color;
}

interface ColorContext {
  pal: Palette;
  rugged: number;
  swamp: boolean;
  volcanic: boolean;
  seed: number;
  /** Highest terrain point (relative heights for peaks / ash). */
  peak: number;
}

/** Per-vertex fields over the whole grid (cols × rows). */
interface Fields {
  /** Smooth normal (central differences). */
  nx: Float32Array;
  ny: Float32Array;
  nz: Float32Array;
  /** Vertex color (linear). */
  r: Float32Array;
  g: Float32Array;
  b: Float32Array;
  /** 0..1 wet-sand sheen weight. */
  wet: Float32Array;
}

export class Terrain {
  readonly group = new THREE.Group();
  /** Triangles drawn (budget bookkeeping). */
  readonly triangles: number;

  /** One BatchedMesh for every chunk: per-chunk frustum culling, one draw call per island on multi-draw GPUs. */
  private readonly batch: THREE.BatchedMesh | null;

  constructor(def: IslandDef, bank: MaterialBank, batched = true) {
    this.group.name = "terrain";
    const grid = def.grid;
    const fields = buildFields(def);
    const cellsX = grid.cols - 1;
    const cellsZ = grid.rows - 1;
    const chunk = Math.max(CHUNK_MIN_CELLS, Math.ceil(Math.max(cellsX, cellsZ) / 3));
    const material = bank.own(terrainMaterial());
    const chunks: THREE.BufferGeometry[] = [];
    let verts = 0;
    let tris = 0;
    for (let cz0 = 0; cz0 < cellsZ; cz0 += chunk) {
      for (let cx0 = 0; cx0 < cellsX; cx0 += chunk) {
        const geometry = buildChunk(def, fields, cx0, cz0, Math.min(cellsX, cx0 + chunk), Math.min(cellsZ, cz0 + chunk));
        if (!geometry) continue;
        chunks.push(bank.geo(geometry));
        verts += geometry.getAttribute("position").count;
        tris += geometry.getAttribute("position").count / 3;
      }
    }
    this.triangles = tris;
    if (!batched) {
      // Dev/benchmark baseline: the pre-optimisation one-mesh-per-chunk path.
      this.batch = null;
      for (let i = 0; i < chunks.length; i++) {
        const mesh = new THREE.Mesh(chunks[i]!, material);
        mesh.name = `terrainChunk${i}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
      }
      return;
    }
    this.batch = new THREE.BatchedMesh(Math.max(1, chunks.length), Math.max(1, verts), 0, material);
    this.batch.name = "terrain";
    this.batch.receiveShadow = true;
    this.batch.castShadow = false;
    this.batch.sortObjects = false;
    this.batch.frustumCulled = false;
    const identity = new THREE.Matrix4();
    for (const geometry of chunks) {
      const id = this.batch.addGeometry(geometry);
      this.batch.setMatrixAt(this.batch.addInstance(id), identity);
    }
    this.group.add(this.batch);
  }

  /** Hills shadowing themselves (off: the ground receives, it does not need to cast). */
  setCastShadow(cast: boolean): void {
    if (this.batch) this.batch.castShadow = cast;
    else for (const c of this.group.children) c.castShadow = cast;
  }
}

/**
 * The terrain's own vertex-colored toon material: the shared ramp plus a faint view-dependent sheen on the wet
 * sand band (`wet` attribute), multiplied into the lit color so it vanishes at night like everything else.
 */
function terrainMaterial(): THREE.MeshToonMaterial {
  const material = createToonMaterial(0xffffff, { vertexColors: true });
  material.name = "terrain";
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nattribute float wet;\nvarying float vWet;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWet = wet;");
    shader.fragmentShader = shader.fragmentShader.replace("#include <common>", "#include <common>\nvarying float vWet;").replace(
      "#include <opaque_fragment>",
      /* glsl */ `{
        // Wet sand: a touch darker in the vertex color, plus a soft grazing-angle sheen (client/src/render/island/Terrain.ts).
        float wetFres = 1.0 - clamp( dot( normalize( normal ), normalize( vViewPosition ) ), 0.0, 1.0 );
        outgoingLight *= 1.0 + vWet * ( 0.04 + wetFres * wetFres * wetFres * 0.55 );
      }
      #include <opaque_fragment>`,
    );
  };
  material.customProgramCacheKey = () => "raft-terrain-wet";
  return material;
}

function colorContext(def: IslandDef): ColorContext {
  const p = groundPalette(def.biome);
  const c = (hex: string) => new THREE.Color(hex);
  let peak = 1;
  const hs = def.grid.heights;
  for (let i = 0; i < hs.length; i++) if (hs[i]! > peak) peak = hs[i]!;
  return {
    pal: {
      seabed: c(p.seabed),
      seabedDeep: c(p.seabedDeep),
      wetSand: c(p.wetSand),
      sandLight: c(p.sandLight),
      sandDark: c(p.sandDark),
      grassDry: c(p.grassDry),
      grass: c(p.grass),
      grassLush: c(p.grassLush),
      forestFloor: c(p.forestFloor),
      rock: c(p.rock),
      rockDark: c(p.rockDark),
      dirt: c(p.dirt),
      mud: c(p.mud),
      ash: c(p.ash),
    },
    rugged: BIOMES[def.biome].rugged,
    swamp: def.biome === "swamp",
    volcanic: def.biome === "volcanic",
    seed: def.seed | 0,
    peak,
  };
}

/** Smooth normals, cavity, canopy cover, trodden ground and the final color of every grid vertex. */
function buildFields(def: IslandDef): Fields {
  const g = def.grid;
  const cols = g.cols;
  const rows = g.rows;
  const total = cols * rows;
  const hs = g.heights;
  const at = (c: number, r: number) => hs[Math.min(rows - 1, Math.max(0, r)) * cols + Math.min(cols - 1, Math.max(0, c))]!;
  const f: Fields = {
    nx: new Float32Array(total),
    ny: new Float32Array(total),
    nz: new Float32Array(total),
    r: new Float32Array(total),
    g: new Float32Array(total),
    b: new Float32Array(total),
    wet: new Float32Array(total),
  };
  // Smooth normals.
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const dx = (at(c + 1, r) - at(c - 1, r)) / (2 * g.cell);
      const dz = (at(c, r + 1) - at(c, r - 1)) / (2 * g.cell);
      const inv = 1 / Math.sqrt(dx * dx + 1 + dz * dz);
      const i = r * cols + c;
      f.nx[i] = -dx * inv;
      f.ny[i] = inv;
      f.nz[i] = -dz * inv;
    }
  }
  const cavity = cavityField(hs, cols, rows, CAVITY_RADIUS);
  const canopy = canopyField(def);
  const { paths, clearings } = campPaths(def);
  const ctx = colorContext(def);
  const out = new THREE.Color();
  const sample: VertexSample = { x: 0, z: 0, h: 0, ny: 1, cavity: 0, canopy: 0, trod: 0, wet: 0 };
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const x = g.originX + c * g.cell;
      const z = g.originZ + r * g.cell;
      sample.x = x;
      sample.z = z;
      sample.h = hs[i]!;
      sample.ny = f.ny[i]!;
      sample.cavity = cavity[i]!;
      sample.canopy = canopy[i]!;
      sample.trod = trodden(paths, clearings, x, z, ctx.seed);
      vertexColor(ctx, sample, out);
      f.r[i] = out.r;
      f.g[i] = out.g;
      f.b[i] = out.b;
      f.wet[i] = sample.wet;
    }
  }
  return f;
}

/** Box-blurred height minus height: > 0 in hollows, < 0 on ridges (separable, O(n)). */
function cavityField(hs: Float32Array, cols: number, rows: number, radius: number): Float32Array {
  const tmp = new Float32Array(cols * rows);
  const blur = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += hs[r * cols + Math.min(cols - 1, Math.max(0, c + k))]!;
      tmp[r * cols + c] = sum / (2 * radius + 1);
    }
  }
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[Math.min(rows - 1, Math.max(0, r + k)) * cols + c]!;
      blur[r * cols + c] = sum / (2 * radius + 1) - hs[r * cols + c]!;
    }
  }
  return blur;
}

/** 0..1 canopy cover at every vertex, splatted from the tree / palm / bush nodes (the forest floor under them). */
function canopyField(def: IslandDef): Float32Array {
  const g = def.grid;
  const out = new Float32Array(g.cols * g.rows);
  for (const n of def.nodes) {
    const spec = n.kind === "tree" ? { r: 3.6, w: 0.55 } : n.kind === "palm" ? { r: 2.2, w: 0.22 } : n.kind === "bush" ? { r: 1.6, w: 0.18 } : null;
    if (!spec) continue;
    const s = Number.isFinite(n.scale) && n.scale > 0 ? Math.min(1.4, Math.max(0.7, n.scale)) : 1;
    const rad = spec.r * s;
    const c0 = Math.max(0, Math.floor((n.x - rad - g.originX) / g.cell));
    const c1 = Math.min(g.cols - 1, Math.ceil((n.x + rad - g.originX) / g.cell));
    const r0 = Math.max(0, Math.floor((n.z - rad - g.originZ) / g.cell));
    const r1 = Math.min(g.rows - 1, Math.ceil((n.z + rad - g.originZ) / g.cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const dx = g.originX + c * g.cell - n.x;
        const dz = g.originZ + r * g.cell - n.z;
        const d = Math.sqrt(dx * dx + dz * dz) / rad;
        if (d >= 1) continue;
        const k = (1 - d) * (1 - d) * spec.w;
        const i = r * g.cols + c;
        out[i] = Math.min(1, out[i]! + k);
      }
    }
  }
  return out;
}

/** 0..1 trodden ground (paths, clearing) with a noise-broken edge. */
function trodden(paths: ReadonlyArray<Segment>, clearings: ReadonlyArray<XZ>, x: number, z: number, seed: number): number {
  let d = Infinity;
  for (const s of paths) d = Math.min(d, segmentDistance(s, x, z));
  const edge = (valueNoise2(x * 0.6, z * 0.6, seed ^ 0x2a7) - 0.5) * 0.5;
  const path = 1 - smooth(PATH_HALF * 0.35, PATH_HALF + edge, d);
  let clear = 0;
  for (const c of clearings) {
    const dx = c.x - x;
    const dz = c.z - z;
    clear = Math.max(clear, 1 - smooth(CLEARING_RADIUS * 0.55, CLEARING_RADIUS + edge * 1.4, Math.sqrt(dx * dx + dz * dz)));
  }
  return Math.max(path * 0.72, clear * 0.85);
}

interface VertexSample {
  x: number;
  z: number;
  h: number;
  ny: number;
  cavity: number;
  canopy: number;
  trod: number;
  /** Out: wet-sand sheen weight. */
  wet: number;
}

const land = new THREE.Color();
const tmpC = new THREE.Color();

/** Ground color at one vertex. */
function vertexColor(ctx: ColorContext, s: VertexSample, out: THREE.Color): void {
  const p = ctx.pal;
  const seed = ctx.seed;
  const { x, z, h } = s;
  // Shared noises: fine ragged edge, medium patches, large-scale drift.
  const fine = valueNoise2(x * 0.35, z * 0.35, seed ^ 0x51ed) - 0.5;
  const patch = fbm2(x * 0.07, z * 0.07, seed ^ 0x2b17, 2) - 0.5;
  const macro = fbm2(x * 0.022, z * 0.022, seed ^ 0x6c3, 3);
  s.wet = 0;
  if (h < -0.05) {
    out.copy(p.seabed).lerp(p.seabedDeep, smooth(0.1, 3.2, -h));
    // Just under the surface the seabed is still wet sand.
    out.lerp(p.wetSand, smooth(-0.6, -0.05, h) * 0.5);
  } else {
    // Dry sand drifting between its light and dark tone.
    out.copy(p.sandDark).lerp(p.sandLight, smooth(0.28, 0.72, macro + patch * 0.35));
    // Wet band at the waterline (ragged top edge).
    const wetTop = 0.2 + fine * 0.14 + patch * 0.1;
    const wet = 1 - smooth(wetTop * 0.45, wetTop + 0.16, h);
    if (wet > 0) {
      out.lerp(p.wetSand, wet);
      s.wet = wet;
    }
    // Land cover above the beach: a wide, noise-broken fringe (never a hard height line).
    const beachLimit = BEACH_MAX_Y + fine * 0.26 + patch * 0.55;
    const cover = smooth(beachLimit - 0.08, beachLimit + 0.5, h);
    if (cover > 0) {
      // Dry olive near the beach / on exposed ground → sage lowland grass with large-scale drift.
      land.copy(p.grassDry).lerp(p.grass, smooth(0.25, 0.65, macro + (h - beachLimit) * 0.06 + patch * 0.3));
      // Damp hollows and noise patches go lush.
      const damp = Math.max(0, Math.min(1, s.cavity * 0.9 + patch * 0.9 + (0.5 - macro) * 0.4));
      if (damp > 0) land.lerp(p.grassLush, damp * 0.75);
      // Forest floor under the actual canopy, plus the old noise "woods" patches.
      const woods = Math.max(0, Math.min(1, (fbm2(x * 0.045, z * 0.045, seed ^ 0x7a11, 3) - 0.52) * 2.2)) * 0.45;
      const floor = Math.min(1, Math.max(s.canopy * 1.25, woods));
      if (floor > 0) land.lerp(p.forestFloor, floor);
      // Swamp mud in the damp lowland.
      if (ctx.swamp && h < BEACH_MAX_Y + 1.2) {
        const m = smooth(0.5, 0.65, valueNoise2(x * 0.12, z * 0.12, seed ^ 0x3d));
        if (m > 0) land.lerp(p.mud, m * 0.6);
      }
      // Exposed soil on medium slopes.
      const soil = smooth(0.97, 0.86, s.ny) * 0.55;
      if (soil > 0) land.lerp(p.dirt, soil);
      // Trodden paths and the camp clearing.
      if (s.trod > 0) land.lerp(p.dirt, s.trod);
      out.lerp(land, cover);
    }
    // Rock on steep faces (cliffs, beach bluffs) and on rugged peaks.
    const rel = h / ctx.peak;
    let rockiness = smooth(0.8, 0.6, s.ny);
    rockiness = Math.max(rockiness, smooth(0.7, 0.95, rel) * ctx.rugged * smooth(0.99, 0.9, s.ny + fine * 0.05));
    if (rockiness > 0) out.lerp(tmpC.copy(p.rock).lerp(p.rockDark, smooth(0.35, 0.75, valueNoise2(x * 0.25, z * 0.25, seed ^ 0x77))), rockiness);
    if (ctx.volcanic && rel > 0.68) out.lerp(p.ash, smooth(0.68, 0.95, rel));
  }
  // Hollows a little darker, ridges a little lighter, large-scale value drift.
  const occl = 1 - Math.min(0.14, Math.max(0, s.cavity * 0.16)) + Math.min(0.04, Math.max(0, -s.cavity * 0.06));
  const k = occl * (0.95 + macro * 0.1);
  out.r = Math.min(1, out.r * k);
  out.g = Math.min(1, out.g * k);
  out.b = Math.min(1, out.b * k);
}

const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const n = new THREE.Vector3();

function buildChunk(def: IslandDef, f: Fields, c0: number, r0: number, c1: number, r1: number): THREE.BufferGeometry | null {
  const g = def.grid;
  const cols = g.cols;
  const hs = g.heights;
  // Count visible cells first so the typed arrays are allocated once.
  let cells = 0;
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (!skipCell(hs, cols, c, r)) cells++;
    }
  }
  if (cells === 0) return null;
  const pos = new Float32Array(cells * 18);
  const nor = new Float32Array(cells * 18);
  const colr = new Float32Array(cells * 18);
  const wet = new Float32Array(cells * 6);
  let o = 0;
  const seed = def.seed | 0;
  // One triangle from three grid vertices (indices into the fields).
  const tri = (ia: number, ib: number, ic: number) => {
    va.set(vx(g, ia), hs[ia]!, vz(g, ia));
    vb.set(vx(g, ib), hs[ib]!, vz(g, ib));
    vc.set(vx(g, ic), hs[ic]!, vz(g, ic));
    e1.subVectors(vb, va);
    e2.subVectors(vc, va);
    n.crossVectors(e1, e2);
    const flip = n.y < 0;
    // Keep counter-clockwise seen from above.
    if (flip) n.negate();
    n.normalize();
    const jit = 1 + (hash2((va.x + vb.x + vc.x) / 3, (va.z + vb.z + vc.z) / 3, seed) - 0.5) * 2 * FACE_JITTER;
    emit(ia, jit);
    emit(flip ? ic : ib, jit);
    emit(flip ? ib : ic, jit);
  };
  const emit = (i: number, jit: number) => {
    pos[o * 3] = vx(g, i);
    pos[o * 3 + 1] = hs[i]!;
    pos[o * 3 + 2] = vz(g, i);
    let nx = f.nx[i]! * (1 - FACET) + n.x * FACET;
    let ny = f.ny[i]! * (1 - FACET) + n.y * FACET;
    let nz = f.nz[i]! * (1 - FACET) + n.z * FACET;
    const inv = 1 / Math.sqrt(nx * nx + ny * ny + nz * nz);
    nx *= inv;
    ny *= inv;
    nz *= inv;
    nor[o * 3] = nx;
    nor[o * 3 + 1] = ny;
    nor[o * 3 + 2] = nz;
    colr[o * 3] = Math.min(1, f.r[i]! * jit);
    colr[o * 3 + 1] = Math.min(1, f.g[i]! * jit);
    colr[o * 3 + 2] = Math.min(1, f.b[i]! * jit);
    wet[o] = f.wet[i]!;
    o++;
  };
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      if (skipCell(hs, cols, c, r)) continue;
      const i00 = r * cols + c;
      const i10 = i00 + 1;
      const i01 = i00 + cols;
      const i11 = i01 + 1;
      // Split along the diagonal with the smaller height difference (follows ridges / valleys).
      if (Math.abs(hs[i00]! - hs[i11]!) <= Math.abs(hs[i10]! - hs[i01]!)) {
        tri(i00, i10, i11);
        tri(i00, i11, i01);
      } else {
        tri(i00, i10, i01);
        tri(i10, i11, i01);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.BufferAttribute(nor, 3));
  geometry.setAttribute("color", new THREE.BufferAttribute(colr, 3));
  geometry.setAttribute("wet", new THREE.BufferAttribute(wet, 1));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function skipCell(hs: Float32Array, cols: number, c: number, r: number): boolean {
  const i = r * cols + c;
  return hs[i]! < SKIP_DEPTH && hs[i + 1]! < SKIP_DEPTH && hs[i + cols]! < SKIP_DEPTH && hs[i + cols + 1]! < SKIP_DEPTH;
}

function vx(g: IslandDef["grid"], i: number): number {
  return g.originX + (i % g.cols) * g.cell;
}

function vz(g: IslandDef["grid"], i: number): number {
  return g.originZ + Math.floor(i / g.cols) * g.cell;
}

function smooth(e0: number, e1v: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1v - e0)));
  return t * t * (3 - 2 * t);
}
