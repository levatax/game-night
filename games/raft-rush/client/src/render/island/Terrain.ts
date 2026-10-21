// Island terrain: the shared heightfield as flat-shaded, vertex-colored chunks (4 on a solo island, game4.md
// §16/§20). Every triangle gets one face color from its height and slope — seabed, wet sand, sand
// (< BEACH_MAX_Y with a ragged edge), grass → forest by noise and altitude, rock on steep slopes and rugged
// peaks, swamp mud, volcanic ash — plus trodden paths wreck ↔ camp ↔ raft, a camp clearing and a hash jitter
// per face. Deep-sea cells hidden under opaque water are skipped. Owner: client-render.

import * as THREE from "three";
import { BEACH_MAX_Y, BIOMES, PEAK_MAX } from "../../../../shared/constants";
import { vertexHeight } from "../../../../shared/island/heightfield";
import type { IslandDef, XZ } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { fbm2, hash2, valueNoise2 } from "../noise";
import { vertexColorToon } from "../Toon";

/** Cells per chunk side (96-cell solo grid → 2 × 2 chunks). */
const CHUNK_CELLS = 48;
/** Cells whose four corners are all deeper than this are invisible under the opaque deep water. */
const SKIP_DEPTH = -2.4;
/** Half width of the trodden paths (m). */
const PATH_HALF = 1.1;
const CLEARING_RADIUS = 3.4;

interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

interface ColorContext {
  sand: THREE.Color;
  wetSand: THREE.Color;
  seabed: THREE.Color;
  seabedDeep: THREE.Color;
  grass: THREE.Color;
  forest: THREE.Color;
  rock: THREE.Color;
  dirt: THREE.Color;
  mud: THREE.Color;
  ash: THREE.Color;
  rugged: number;
  swamp: boolean;
  volcanic: boolean;
  seed: number;
  paths: Segment[];
  clearings: XZ[];
}

export class Terrain {
  readonly group = new THREE.Group();
  /** Triangles drawn (budget bookkeeping). */
  readonly triangles: number;

  constructor(def: IslandDef, bank: MaterialBank) {
    this.group.name = "terrain";
    const ctx = colorContext(def);
    const grid = def.grid;
    const cellsX = grid.cols - 1;
    const cellsZ = grid.rows - 1;
    const material = vertexColorToon(THREE.FrontSide, false);
    let tris = 0;
    for (let cz0 = 0; cz0 < cellsZ; cz0 += CHUNK_CELLS) {
      for (let cx0 = 0; cx0 < cellsX; cx0 += CHUNK_CELLS) {
        const geometry = buildChunk(def, ctx, cx0, cz0, Math.min(cellsX, cx0 + CHUNK_CELLS), Math.min(cellsZ, cz0 + CHUNK_CELLS));
        if (!geometry) continue;
        tris += geometry.getAttribute("position").count / 3;
        const mesh = new THREE.Mesh(bank.geo(geometry), material);
        mesh.name = `terrainChunk${cx0 / CHUNK_CELLS}_${cz0 / CHUNK_CELLS}`;
        mesh.receiveShadow = true;
        mesh.castShadow = false;
        mesh.matrixAutoUpdate = false;
        this.group.add(mesh);
      }
    }
    this.triangles = tris;
  }

  /** Hills shadowing themselves (high quality only: it doubles the terrain's cost in the shadow pass). */
  setCastShadow(cast: boolean): void {
    for (const c of this.group.children) c.castShadow = cast;
  }
}

function colorContext(def: IslandDef): ColorContext {
  const b = BIOMES[def.biome];
  const sand = new THREE.Color(b.colors.sand);
  const sea = new THREE.Color(b.colors.sea);
  const rock = new THREE.Color(b.colors.rock);
  const paths: Segment[] = [];
  const clearings: XZ[] = [];
  for (const s of def.sites) {
    paths.push({ ax: s.wreck.x, az: s.wreck.z, bx: s.campfire.x, bz: s.campfire.z });
    paths.push({ ax: s.wreck.x, az: s.wreck.z, bx: s.raft.x, bz: s.raft.z });
    paths.push({ ax: s.campfire.x, az: s.campfire.z, bx: s.chest.x, bz: s.chest.z });
    clearings.push(s.campfire);
  }
  return {
    sand,
    wetSand: sand.clone().multiplyScalar(0.8),
    seabed: sand.clone().multiplyScalar(0.78).lerp(sea, 0.25),
    seabedDeep: sea.clone().multiplyScalar(0.45),
    grass: new THREE.Color(b.colors.grass),
    forest: new THREE.Color(b.colors.forest),
    rock,
    dirt: sand.clone().lerp(rock, 0.3).multiplyScalar(0.92),
    mud: new THREE.Color("#6B5B3A"),
    ash: rock.clone().multiplyScalar(0.6),
    rugged: b.rugged,
    swamp: def.biome === "swamp",
    volcanic: def.biome === "volcanic",
    seed: def.seed | 0,
    paths,
    clearings,
  };
}

const va = new THREE.Vector3();
const vb = new THREE.Vector3();
const vc = new THREE.Vector3();
const e1 = new THREE.Vector3();
const e2 = new THREE.Vector3();
const n = new THREE.Vector3();
const col = new THREE.Color();
const tmpC = new THREE.Color();

function buildChunk(def: IslandDef, ctx: ColorContext, c0: number, r0: number, c1: number, r1: number): THREE.BufferGeometry | null {
  const g = def.grid;
  const pos: number[] = [];
  const nor: number[] = [];
  const colr: number[] = [];
  const tri = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => {
    e1.subVectors(b, a);
    e2.subVectors(c, a);
    n.crossVectors(e1, e2);
    if (n.y < 0) {
      // Keep counter-clockwise seen from above.
      n.negate();
      pos.push(a.x, a.y, a.z, c.x, c.y, c.z, b.x, b.y, b.z);
    } else {
      pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    }
    n.normalize();
    nor.push(n.x, n.y, n.z, n.x, n.y, n.z, n.x, n.y, n.z);
    faceColor(ctx, (a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3, (a.z + b.z + c.z) / 3, n.y, col);
    colr.push(col.r, col.g, col.b, col.r, col.g, col.b, col.r, col.g, col.b);
  };
  for (let r = r0; r < r1; r++) {
    for (let c = c0; c < c1; c++) {
      const h00 = vertexHeight(g, c, r);
      const h10 = vertexHeight(g, c + 1, r);
      const h01 = vertexHeight(g, c, r + 1);
      const h11 = vertexHeight(g, c + 1, r + 1);
      if (h00 < SKIP_DEPTH && h10 < SKIP_DEPTH && h01 < SKIP_DEPTH && h11 < SKIP_DEPTH) continue;
      const x0 = g.originX + c * g.cell;
      const z0 = g.originZ + r * g.cell;
      const x1 = x0 + g.cell;
      const z1 = z0 + g.cell;
      // Split along the diagonal with the smaller height difference (follows ridges / valleys).
      if (Math.abs(h00 - h11) <= Math.abs(h10 - h01)) {
        tri(va.set(x0, h00, z0), vb.set(x1, h10, z0), vc.set(x1, h11, z1));
        tri(va.set(x0, h00, z0), vb.set(x1, h11, z1), vc.set(x0, h01, z1));
      } else {
        tri(va.set(x0, h00, z0), vb.set(x1, h10, z0), vc.set(x0, h01, z1));
        tri(va.set(x1, h10, z0), vb.set(x1, h11, z1), vc.set(x0, h01, z1));
      }
    }
  }
  if (pos.length === 0) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  geometry.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  geometry.setAttribute("color", new THREE.Float32BufferAttribute(colr, 3));
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  return geometry;
}

function segmentDistance(s: Segment, x: number, z: number): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const len2 = dx * dx + dz * dz;
  const t = len2 > 1e-6 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (z - s.az) * dz) / len2)) : 0;
  const px = s.ax + dx * t - x;
  const pz = s.az + dz * t - z;
  return Math.sqrt(px * px + pz * pz);
}

function smooth(e0: number, e1v: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1v - e0)));
  return t * t * (3 - 2 * t);
}

/** Face color for a triangle centered at (x, h, z) with normal.y = ny. */
function faceColor(ctx: ColorContext, x: number, h: number, z: number, ny: number, out: THREE.Color): void {
  const seed = ctx.seed;
  const ragged = (valueNoise2(x * 0.35, z * 0.35, seed ^ 0x51ed) - 0.5) * 0.4;
  if (h < -0.05) {
    out.copy(ctx.seabed).lerp(ctx.seabedDeep, smooth(0.1, 3.2, -h));
  } else if (h < 0.16 + ragged * 0.2) {
    out.copy(ctx.wetSand);
  } else {
    const beachLimit = BEACH_MAX_Y + ragged;
    if (h < beachLimit) {
      out.copy(ctx.sand);
    } else {
      const f = Math.min(1, Math.max(0, (fbm2(x * 0.045, z * 0.045, seed ^ 0x7a11, 3) - 0.45) * 2.4 + (h - 2.8) * 0.12));
      out.copy(ctx.grass).lerp(ctx.forest, f);
      // Sandy grass fringe above the beach line.
      const fringe = smooth(beachLimit, beachLimit + 0.35, h);
      if (fringe < 1) out.lerp(tmpC.copy(ctx.sand), 1 - fringe);
      if (ctx.swamp && h < 1.6 && valueNoise2(x * 0.12, z * 0.12, seed ^ 0x3d) > 0.55) out.lerp(ctx.mud, 0.55);
      // Trodden paths and the camp clearing (only visible on grass).
      let d = Infinity;
      for (const s of ctx.paths) d = Math.min(d, segmentDistance(s, x, z));
      const path = 1 - smooth(PATH_HALF * 0.45, PATH_HALF, d);
      let clear = 0;
      for (const c of ctx.clearings) {
        const dx = c.x - x;
        const dz = c.z - z;
        clear = Math.max(clear, 1 - smooth(CLEARING_RADIUS * 0.6, CLEARING_RADIUS, Math.sqrt(dx * dx + dz * dz)));
      }
      const trod = Math.max(path * 0.7, clear * 0.85) * fringe;
      if (trod > 0) out.lerp(ctx.dirt, trod);
    }
    // Rock on steep faces and rugged peaks.
    let rockiness = smooth(0.84, 0.66, ny);
    rockiness = Math.max(rockiness, smooth(PEAK_MAX * 0.68, PEAK_MAX * 0.92, h) * ctx.rugged);
    if (rockiness > 0) out.lerp(ctx.rock, rockiness);
    if (ctx.volcanic && h > PEAK_MAX * 0.72) out.lerp(ctx.ash, smooth(PEAK_MAX * 0.72, PEAK_MAX * 0.95, h));
  }
  const k = 1 + (hash2(x, z, seed) - 0.5) * 0.09;
  out.r = Math.min(1, out.r * k);
  out.g = Math.min(1, out.g * k);
  out.b = Math.min(1, out.b * k);
}
