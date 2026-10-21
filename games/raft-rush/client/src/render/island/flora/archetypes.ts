// Low-poly flora archetypes (game4.md §16): 4 trees (round broadleaf, tropical cone, umbrella acacia, vine
// tree), a stump, 2 palms (6-sided curved trunk + drooping frond planes) and a coconut, 2 rocks + pebbles,
// 2 bushes (each also with hanging vines for rope bushes), a bare bush and a berry cluster. Each is ONE baked
// vertex-colored geometry (kit/Baker) with its origin at the base, sized in meters at scale 1, colored from the
// biome palette. Flora.ts puts them all in one BatchedMesh. Adapted from bakeTree / bakeBush in
// games/bonk-brawl/client/src/render/arena/decor/staticDecor.ts. Owner: client-render.

import * as THREE from "three";
import { BIOMES } from "../../../../../shared/constants";
import type { Biome } from "../../../../../shared/types";
import { Baker, composeMatrix } from "../../kit/Baker";
import { createRng, randRange } from "../../noise";

export interface FloraColors {
  trunk: string;
  trunkDark: string;
  palmTrunk: string;
  palmRing: string;
  leaves: string[];
  palmLeaves: string[];
  rock: string;
  rockDark: string;
  vine: string;
  twig: string;
  berry: string[];
  flower: string[];
}

/** Every archetype geometry plus the local crown points coconuts hang from. */
export interface FloraArchetypes {
  trees: THREE.BufferGeometry[];
  stump: THREE.BufferGeometry;
  palms: THREE.BufferGeometry[];
  /** Per palm archetype: the two coconut spots (local, scale 1). */
  palmCoconuts: Array<[THREE.Vector3, THREE.Vector3]>;
  coconut: THREE.BufferGeometry;
  rocks: THREE.BufferGeometry[];
  pebbles: THREE.BufferGeometry;
  bushes: THREE.BufferGeometry[];
  vineBushes: THREE.BufferGeometry[];
  bareBush: THREE.BufferGeometry;
  berries: THREE.BufferGeometry;
  /** Triangles per geometry (budget bookkeeping), same order as `all`. */
  all: THREE.BufferGeometry[];
}

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const e3 = (x: number, y: number, z: number) => new THREE.Euler(x, y, z);
const UP = new THREE.Vector3(0, 1, 0);
/** Open-ended (cap-less) cylinder: the caps of trunks and stems are never seen, so don't pay for them. */
const tube = (rTop: number, rBottom: number, h: number, seg: number) => new THREE.CylinderGeometry(rTop, rBottom, h, seg, 1, true);
/** Open cone (no base disc). */
const cone = (r: number, h: number, seg: number) => new THREE.ConeGeometry(r, h, seg, 1, true);

export function floraColors(biome: Biome): FloraColors {
  const c = BIOMES[biome].colors;
  const forest = new THREE.Color(c.forest);
  const grass = new THREE.Color(c.grass);
  const mix = (t: number, k = 1) => "#" + forest.clone().lerp(grass, t).multiplyScalar(k).getHexString();
  const rock = new THREE.Color(c.rock);
  return {
    trunk: biome === "volcanic" ? "#5E4636" : "#8A5A3B",
    trunkDark: biome === "volcanic" ? "#47352A" : "#6E452C",
    palmTrunk: "#A57C52",
    palmRing: "#7E5B3A",
    leaves: [mix(0), mix(0.35), mix(0.65), mix(0.15, 0.85)],
    palmLeaves: [mix(0.55), mix(0.8), mix(0.4, 0.92)],
    rock: c.rock,
    rockDark: "#" + rock.clone().multiplyScalar(0.78).getHexString(),
    vine: biome === "swamp" ? "#4E6B2E" : "#5C7F2C",
    twig: "#7A5236",
    berry: biome === "volcanic" ? ["#B0305A", "#7E2A6B", "#D9485F"] : ["#E5383B", "#9B2C8E", "#FF5A7A"],
    flower: ["#FF8FB8", "#FFF4A3", "#FFFFFF", "#FFB347"],
  };
}

export function buildFloraArchetypes(biome: Biome, seed: number): FloraArchetypes {
  const col = floraColors(biome);
  const rng = createRng(seed ^ 0xf10a);
  const trees = [roundTree(col, rng), coneTree(col, rng), umbrellaTree(col, rng), vineTree(col, rng)];
  const stump = stumpGeo(col, rng);
  const palmA = palm(col, rng, 5.2, 0.9, 7);
  const palmB = palm(col, rng, 6.1, 1.4, 8);
  const coconut = coconutGeo(col);
  const rocks = [boulder(col, rng), rockCluster(col, rng)];
  const pebbles = pebblesGeo(col, rng);
  const bushA = roundBush(col, rng, false);
  const bushB = fernBush(col, rng, false);
  const vineA = roundBush(col, rng, true);
  const vineB = fernBush(col, rng, true);
  const bare = bareBushGeo(col, rng);
  const berries = berriesGeo(col, rng);
  const all = [...trees, stump, palmA.geo, palmB.geo, coconut, ...rocks, pebbles, bushA, bushB, vineA, vineB, bare, berries];
  return {
    trees,
    stump,
    palms: [palmA.geo, palmB.geo],
    palmCoconuts: [palmA.coconuts, palmB.coconuts],
    coconut,
    rocks,
    pebbles,
    bushes: [bushA, bushB],
    vineBushes: [vineA, vineB],
    bareBush: bare,
    berries,
    all,
  };
}

/* ================================================================== trees */

function trunk(b: Baker, col: FloraColors, height: number, rBottom: number, rTop: number, lean: number): void {
  b.addAt(tube(rTop, rBottom, height, 6), col.trunk, v3(lean * height * 0.5, height / 2, 0), e3(0, 0, -lean), 1, true);
  // Root flare so the trunk sits in the grass.
  b.addAt(cone(rBottom * 1.7, 0.4, 6), col.trunkDark, v3(0, 0.12, 0), e3(0, 0.4, 0), 1, true);
}

function blob(b: Baker, color: string, x: number, y: number, z: number, r: number, rng: () => number, squash = 1): void {
  const m = composeMatrix(v3(x, y, z), e3(rng() * 3, rng() * 3, rng() * 3), v3(r, r * squash, r));
  b.addVaried(new THREE.IcosahedronGeometry(1, 0), color, m, 0.09, Math.floor(rng() * 1e6));
}

function roundTree(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  trunk(b, col, 2.6, 0.3, 0.17, 0.04);
  const L = col.leaves;
  blob(b, L[0]!, 0.05, 3.3, 0, 1.4, rng);
  blob(b, L[1]!, 0.85, 2.9, 0.35, 0.95, rng);
  blob(b, L[2]!, -0.8, 3.0, -0.3, 1.0, rng);
  blob(b, L[1]!, 0.15, 4.15, -0.15, 0.85, rng);
  blob(b, L[3]!, -0.2, 2.75, 0.85, 0.8, rng);
  b.shadeBelow(2.4, 1.2, 0.18);
  return b.build();
}

function coneTree(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  trunk(b, col, 1.8, 0.26, 0.14, 0);
  const L = col.leaves;
  const tiers: Array<[number, number, number, string]> = [
    [1.55, 2.1, 2.0, L[0]!],
    [1.2, 1.9, 3.1, L[3]!],
    [0.82, 1.65, 4.1, L[1]!],
    [0.45, 1.2, 4.95, L[2]!],
  ];
  for (const [r, h, y, c] of tiers) {
    const m = composeMatrix(v3(0, y, 0), e3(0, rng() * 3, 0), 1);
    b.addVaried(cone(r, h, 7), c, m, 0.07, Math.floor(rng() * 1e6));
  }
  return b.build();
}

function umbrellaTree(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  // Two-segment bent trunk.
  b.addAt(tube(0.2, 0.3, 2.0, 6), col.trunk, v3(0.15, 1.0, 0), e3(0, 0, -0.15), 1, true);
  b.addAt(tube(0.14, 0.2, 1.7, 6), col.trunk, v3(0.55, 2.7, 0.05), e3(0.1, 0, -0.35), 1, true);
  b.addAt(tube(0.08, 0.12, 1.3, 5), col.trunk, v3(-0.1, 2.6, 0.2), e3(-0.3, 0, 0.55), 1, true);
  b.addAt(cone(0.5, 0.4, 6), col.trunkDark, v3(0, 0.12, 0), null, 1, true);
  const L = col.leaves;
  blob(b, L[1]!, 0.8, 3.6, 0, 1.9, rng, 0.38);
  blob(b, L[0]!, -0.4, 3.45, 0.5, 1.4, rng, 0.42);
  blob(b, L[2]!, 0.4, 3.95, -0.5, 1.2, rng, 0.4);
  blob(b, L[3]!, 1.6, 3.4, 0.6, 1.0, rng, 0.45);
  return b.build();
}

function vineTree(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  trunk(b, col, 2.8, 0.32, 0.18, -0.05);
  const L = col.leaves;
  blob(b, L[3]!, 0, 3.5, 0, 1.45, rng);
  blob(b, L[0]!, 0.9, 3.1, -0.3, 1.0, rng);
  blob(b, L[0]!, -0.85, 3.2, 0.35, 1.05, rng);
  blob(b, L[1]!, 0.1, 4.3, 0.1, 0.9, rng);
  // Hanging vines (the "sarmaşık" rope source) with little leaves.
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rng() * 0.4;
    const r = randRange(rng, 1.0, 1.35);
    const len = randRange(rng, 1.2, 2.0);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    const top = 3.0;
    b.addAt(tube(0.025, 0.035, len, 3), col.vine, v3(x, top - len / 2, z), e3(rng() * 0.2, 0, rng() * 0.2), 1, true);
    b.addAt(new THREE.TetrahedronGeometry(0.12, 0), L[2]!, v3(x + 0.05, top - len * 0.55, z), e3(0, a, 0.6), v3(1, 0.6, 1.5), true);
  }
  for (let i = 0; i < 4; i++) {
    const a = rng() * Math.PI * 2;
    b.addAt(new THREE.TetrahedronGeometry(0.12, 0), col.flower[i % col.flower.length]!, v3(Math.cos(a) * 1.3, 3.2 + rng() * 0.8, Math.sin(a) * 1.3), e3(rng(), rng(), 0), 1, true);
  }
  b.shadeBelow(2.6, 1.3, 0.16);
  return b.build();
}

function stumpGeo(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  b.addAt(tube(0.27, 0.34, 0.5, 7), col.trunk, v3(0, 0.25, 0), null, 1, true);
  b.addAt(new THREE.CircleGeometry(0.27, 7), "#E0B98A", v3(0, 0.5, 0), e3(-Math.PI / 2, 0, 0), 1, true);
  b.addAt(new THREE.CircleGeometry(0.12, 7), "#C99A66", v3(0, 0.505, 0), e3(-Math.PI / 2, 0, 0), 1, true);
  b.addAt(cone(0.55, 0.3, 7), col.trunkDark, v3(0, 0.1, 0), null, 1, true);
  for (let i = 0; i < 2; i++) {
    const a = rng() * Math.PI * 2;
    const d = randRange(rng, 0.5, 0.9);
    b.addAt(new THREE.BoxGeometry(0.16, 0.04, 0.08), "#E0B98A", v3(Math.cos(a) * d, 0.03, Math.sin(a) * d), e3(0, a, 0), 1, true);
  }
  return b.build();
}

/* ================================================================== palms */

/** A drooping, slightly folded frond along +X from the origin (open surface: drawn double-sided). */
function frondGeometry(length: number, width: number, droop: number, segments: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const pts: Array<{ m: THREE.Vector3; l: THREE.Vector3; r: THREE.Vector3 }> = [];
  for (let i = 0; i <= segments; i++) {
    const u = i / segments;
    const x = length * u;
    const y = -droop * u * u * length;
    const w = width * Math.sin(Math.PI * Math.min(1, u * 1.15 + 0.08)) * (1 - u * 0.35);
    const fold = 0.35 * w;
    pts.push({ m: v3(x, y, 0), l: v3(x, y + fold, w), r: v3(x, y + fold, -w) });
  }
  const push = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  for (let i = 0; i < segments; i++) {
    const p = pts[i]!;
    const q = pts[i + 1]!;
    push(p.m, q.m, q.l);
    push(p.m, q.l, p.l);
    push(p.m, q.r, q.m);
    push(p.m, p.r, q.r);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  return g;
}

function palm(col: FloraColors, rng: () => number, height: number, lean: number, leaves: number): { geo: THREE.BufferGeometry; coconuts: [THREE.Vector3, THREE.Vector3] } {
  const b = new Baker();
  const segs = 5;
  const pointAt = (u: number) => v3(lean * u * u, height * u, 0);
  for (let k = 0; k < segs; k++) {
    const u0 = k / segs;
    const u1 = (k + 1) / segs;
    const p0 = pointAt(u0);
    const p1 = pointAt(u1);
    const mid = p0.clone().add(p1).multiplyScalar(0.5);
    const dir = p1.clone().sub(p0);
    const len = dir.length();
    const tilt = Math.atan2(dir.x, dir.y);
    const r0 = 0.24 - u0 * 0.09;
    const r1 = 0.24 - u1 * 0.09;
    b.addAt(tube(r1, r0, len, 6), col.palmTrunk, mid, e3(0, 0, -tilt), 1, true);
    // Bark ring at every other joint.
    if (k % 2 === 0) b.addAt(tube(r1 * 1.14, r1 * 1.14, 0.1, 6), col.palmRing, p1, e3(0, 0, -tilt), 1, true);
  }
  const top = pointAt(1);
  b.addAt(cone(0.32, 0.5, 6), col.palmLeaves[2]!, top.clone().add(v3(0, 0.15, 0)), null, 1, true);
  for (let i = 0; i < leaves; i++) {
    const yaw = (i / leaves) * Math.PI * 2 + rng() * 0.35;
    const lift = randRange(rng, 0.15, 0.45);
    const leaf = frondGeometry(randRange(rng, 2.2, 2.7), randRange(rng, 0.32, 0.42), randRange(rng, 0.28, 0.4), 3);
    const m = composeMatrix(top.clone().add(v3(0, 0.1, 0)), new THREE.Euler(0, yaw, lift, "YZX"), 1);
    b.addVaried(leaf, col.palmLeaves[i % col.palmLeaves.length]!, m, 0.07, i * 31 + Math.floor(height * 10));
  }
  const c1 = top.clone().add(v3(0.18, -0.28, 0.12));
  const c2 = top.clone().add(v3(-0.14, -0.3, -0.16));
  return { geo: b.build(), coconuts: [c1, c2] };
}

function coconutGeo(col: FloraColors): THREE.BufferGeometry {
  const b = new Baker();
  b.addVaried(new THREE.IcosahedronGeometry(0.17, 0), "#6B4A2B", composeMatrix(v3(0, 0, 0), null, v3(1, 1.1, 1)), 0.08, 7);
  b.addAt(tube(0.02, 0.03, 0.12, 3), col.palmRing, v3(0, 0.2, 0), null, 1, true);
  return b.build();
}

/* =================================================================== rocks */

/** Jitter a geometry's vertices by a hash of their position (shared corners move together). */
function lumpy(g: THREE.BufferGeometry, amount: number, seed: number): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + seed) * 43758.5453;
    const k = 1 + ((h - Math.floor(h)) * 2 - 1) * amount;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  return g;
}

function boulder(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  const m = composeMatrix(v3(0, 0.38, 0), e3(rng() * 3, rng() * 3, 0), v3(1, 0.72, 0.92));
  b.addVaried(lumpy(new THREE.DodecahedronGeometry(1, 0), 0.16, 3), col.rock, m, 0.12, 11);
  return b.build();
}

function rockCluster(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  b.addVaried(lumpy(new THREE.IcosahedronGeometry(0.75, 0), 0.18, 7), col.rock, composeMatrix(v3(-0.2, 0.42, 0), e3(rng(), rng(), rng()), v3(1, 0.85, 1)), 0.1, 17);
  b.addVaried(lumpy(new THREE.IcosahedronGeometry(0.5, 0), 0.2, 9), col.rockDark, composeMatrix(v3(0.55, 0.28, 0.35), e3(rng(), rng(), 0), v3(1, 0.8, 1)), 0.1, 19);
  return b.build();
}

function pebblesGeo(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng() * 0.6;
    const d = randRange(rng, 0.15, 0.55);
    const r = randRange(rng, 0.12, 0.22);
    const m = composeMatrix(v3(Math.cos(a) * d, r * 0.4, Math.sin(a) * d), e3(rng() * 3, rng() * 3, 0), v3(r, r * 0.7, r));
    b.addVaried(lumpy(new THREE.OctahedronGeometry(1, 0), 0.15, i), i % 2 ? col.rock : col.rockDark, m, 0.1, 29 + i);
  }
  return b.build();
}

/* ================================================================== bushes */

function addVines(b: Baker, col: FloraColors, rng: () => number, radius: number, top: number): void {
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + rng() * 0.5;
    const x = Math.cos(a) * radius;
    const z = Math.sin(a) * radius;
    // A drooping vine strand with a leaf at its tip.
    b.addAt(tube(0.022, 0.03, 0.55, 4), col.vine, v3(x * 1.05, top - 0.24, z * 1.05), e3(Math.sin(a) * 0.35, 0, -Math.cos(a) * 0.35), 1, true);
    b.addAt(new THREE.TetrahedronGeometry(0.09, 0), col.leaves[2]!, v3(x * 1.18, top - 0.52, z * 1.18), e3(0, a, 0.5), v3(1, 0.6, 1.4), true);
  }
  // A coiled bundle so rope bushes read from afar.
  b.addAt(new THREE.TorusGeometry(0.16, 0.04, 3, 6), col.vine, v3(radius * 0.6, 0.22, radius * 0.4), e3(Math.PI / 2, 0, 0.3), 1, true);
}

function roundBush(col: FloraColors, rng: () => number, vines: boolean): THREE.BufferGeometry {
  const b = new Baker();
  const L = col.leaves;
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 + rng();
    const r = randRange(rng, 0.46, 0.6);
    blob(b, L[(i + 1) % L.length]!, Math.cos(a) * 0.32, r * 0.78, Math.sin(a) * 0.32, r, rng);
  }
  blob(b, L[1]!, 0, 0.8, 0, 0.48, rng);
  if (vines) addVines(b, col, rng, 0.62, 0.85);
  else {
    for (let i = 0; i < 3; i++) {
      const a = rng() * Math.PI * 2;
      b.addAt(new THREE.TetrahedronGeometry(0.08, 0), col.flower[i % col.flower.length]!, v3(Math.cos(a) * 0.62, 0.5 + rng() * 0.35, Math.sin(a) * 0.62), e3(rng(), rng(), 0), 1, true);
    }
  }
  b.shadeBelow(0.3, 0.3, 0.2);
  return b.build();
}

function fernBush(col: FloraColors, rng: () => number, vines: boolean): THREE.BufferGeometry {
  const b = new Baker();
  const L = col.leaves;
  const count = 7;
  for (let i = 0; i < count; i++) {
    const yaw = (i / count) * Math.PI * 2 + rng() * 0.3;
    const lift = randRange(rng, 0.55, 0.95);
    const leaf = frondGeometry(randRange(rng, 0.9, 1.2), randRange(rng, 0.16, 0.22), 0.35, 3);
    const m = composeMatrix(v3(0, 0.08, 0), new THREE.Euler(0, yaw, lift, "YZX"), 1);
    b.addVaried(leaf, L[i % L.length]!, m, 0.08, i * 13);
  }
  blob(b, L[0]!, 0, 0.18, 0, 0.26, rng);
  if (vines) addVines(b, col, rng, 0.5, 0.6);
  return b.build();
}

function bareBushGeo(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + rng() * 0.4;
    const len = randRange(rng, 0.45, 0.8);
    const tilt = randRange(rng, 0.35, 0.75);
    const dir = v3(Math.cos(a) * Math.sin(tilt), Math.cos(tilt), Math.sin(a) * Math.sin(tilt));
    const q = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const m = new THREE.Matrix4().compose(dir.clone().multiplyScalar(len * 0.5), q, v3(1, 1, 1));
    b.add(tube(0.018, 0.035, len, 3), col.twig, m, true);
  }
  b.addAt(cone(0.18, 0.15, 6), col.trunkDark, v3(0, 0.06, 0), null, 1, true);
  b.addAt(new THREE.OctahedronGeometry(0.06, 0), col.leaves[3]!, v3(0.2, 0.42, 0.1), e3(0, 1, 0.5), v3(1, 0.5, 1.5), true);
  return b.build();
}

function berriesGeo(col: FloraColors, rng: () => number): THREE.BufferGeometry {
  const b = new Baker();
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + rng() * 0.5;
    const r = randRange(rng, 0.55, 0.72);
    const y = randRange(rng, 0.35, 0.95);
    b.addAt(new THREE.OctahedronGeometry(0.085, 0), col.berry[i % col.berry.length]!, v3(Math.cos(a) * r, y, Math.sin(a) * r), e3(rng(), rng(), 0), 1, true);
  }
  return b.build();
}
