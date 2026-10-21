// The wreck of the cruise ship "MS Neşe" (game4.md §2): a broken-off bow section rammed into the beach, nose up
// and listing, white hull with a navy stripe, portholes, red antifouling, a jagged broken end showing the decks,
// a toppled funnel, deck railings, and tourist debris around it (life ring, suitcases, deck chair, beach
// umbrella, crate). Baked into the island's static landmark mesh; the hull lettering is a separate decal.
// Local space: origin at the wreck point on the sand, -Z faces inland (IslandSite.wreck.yaw). The bulk stays
// inside the WRECK_RADIUS collider; only the raised nose overhangs it above head height. Owner: client-render.

import * as THREE from "three";
import { PALETTE } from "../../../../../shared/constants";
import { Baker, composeMatrix, doubleSided } from "../../kit/Baker";
import { MeshBuilder, type P3 } from "../../kit/MeshBuilder";
import { createRng, randRange } from "../../noise";
import { WOOD } from "../../textures";

const HULL_WHITE = "#F7F4EC";
const HULL_STRIPE = "#1F3A68";
const HULL_RED = "#C8443A";
const DECK = "#D9C7A3";
const INSIDE = "#4A4248";
const FUNNEL = "#E5543F";

/** Ring of the hull cross-section at fraction s (0 = broken end, 1 = bow tip). */
function hullRing(s: number): P3[] {
  const w = 1.3 * (1 - Math.pow(s, 2.2)) + 0.06;
  const top = 2.7 + s * 0.45;
  const keel = -0.35 + s * 0.6;
  const z = -1.75 + s * 4.0;
  return [
    { x: -w, y: top, z },
    { x: -w, y: 1.55, z },
    { x: -w * 0.98, y: 0.8, z },
    { x: -w * 0.75, y: 0.1, z },
    { x: 0, y: keel, z },
    { x: w * 0.75, y: 0.1, z },
    { x: w * 0.98, y: 0.8, z },
    { x: w, y: 1.55, z },
    { x: w, y: top, z },
  ];
}

/** Color of the hull band between ring points k and k+1. */
const BAND = [HULL_WHITE, HULL_STRIPE, HULL_RED, HULL_RED, HULL_RED, HULL_RED, HULL_STRIPE, HULL_WHITE];

export interface WreckParts {
  /** Local transform of the hull (tilt + list + sink), for placing the lettering decal. */
  hullMatrix: THREE.Matrix4;
}

/** Terrain height relative to the wreck base at a local (x, z) (debris sits on the real sand). */
export type LocalGround = (x: number, z: number) => number;

/** Bake the wreck (local space, see header) into `out` with `matrix` (wreck position + yaw). */
export function bakeWreck(out: Baker, matrix: THREE.Matrix4, seed: number, ground: LocalGround): WreckParts {
  const rng = createRng(seed ^ 0x3e5e);
  const hull = new Baker();
  const mb = new MeshBuilder();
  const rings: P3[][] = [];
  const SEG = 7;
  for (let i = 0; i <= SEG; i++) rings.push(hullRing(i / SEG));
  // Hull skin.
  for (let i = 0; i < SEG; i++) {
    const a = rings[i]!;
    const b = rings[i + 1]!;
    for (let k = 0; k < a.length - 1; k++) {
      const out0 = { x: (a[k]!.x + a[k + 1]!.x) * 0.5, y: (a[k]!.y + a[k + 1]!.y) * 0.5 - 1.2, z: a[k]!.z };
      const hint = { x: out0.x, y: out0.y, z: 0 };
      mb.quad(a[k]!, b[k]!, b[k + 1]!, a[k + 1]!, BAND[k]!, hint);
    }
    // Deck.
    mb.quad(a[0]!, b[0]!, b[a.length - 1]!, a[a.length - 1]!, DECK, { x: 0, y: 1, z: 0 });
  }
  // Broken end: a dark jagged cap with torn deck plates.
  const end = rings[0]!;
  const c: P3 = { x: 0, y: 1.3, z: -1.75 };
  for (let k = 0; k < end.length - 1; k++) {
    const p = end[k]!;
    const q = end[k + 1]!;
    const jag = { x: (p.x + q.x) * 0.5 * 0.6, y: (p.y + q.y) * 0.5 * 0.7 + 0.25, z: -1.75 - randRange(rng, 0.05, 0.35) };
    mb.tri(p, q, jag, INSIDE, { x: 0, y: 0, z: -1 });
    mb.tri(p, jag, c, INSIDE, { x: 0, y: 0, z: -1 });
    mb.tri(q, c, jag, INSIDE, { x: 0, y: 0, z: -1 });
  }
  hull.addVertexColored(mb.build(), new THREE.Matrix4(), true);
  // Torn deck levels visible in the break.
  for (const y of [0.95, 1.9]) {
    hull.addAt(new THREE.BoxGeometry(2.3, 0.08, 0.6), DECK, new THREE.Vector3(0, y, -1.5), new THREE.Euler(0.08, 0, rng() * 0.1), 1, true);
  }
  // Portholes along both sides (upper white band), slightly proud of the skin.
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 6; i++) {
      const s = 0.1 + i * 0.13;
      const r = hullRing(s);
      const w = r[0]!.x * -side;
      const z = r[0]!.z;
      hull.addAt(new THREE.CylinderGeometry(0.13, 0.13, 0.06, 8), "#2D3A4A", new THREE.Vector3(w + side * 0.02, 1.84, z), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
      hull.addAt(new THREE.TorusGeometry(0.14, 0.03, 4, 8), "#C9CCD1", new THREE.Vector3(w + side * 0.04, 1.84, z), new THREE.Euler(0, Math.PI / 2, 0), 1, true);
    }
  }
  // Railing posts + top rail along the deck edges.
  for (let side = -1; side <= 1; side += 2) {
    for (let i = 0; i < 6; i++) {
      const s = i / 6;
      const r = hullRing(s);
      const w = r[0]!.x * -side * 0.95;
      hull.addAt(new THREE.CylinderGeometry(0.025, 0.025, 0.55, 4), "#E8E8E8", new THREE.Vector3(w, r[0]!.y + 0.27, r[0]!.z), null, 1, true);
    }
  }
  // Anchor hawse + an anchor hanging near the bow.
  const nose = hullRing(0.86);
  hull.addAt(new THREE.TorusGeometry(0.16, 0.05, 4, 8), "#5A5E66", new THREE.Vector3(nose[0]!.x - 0.02, 2.4, nose[0]!.z), new THREE.Euler(0, Math.PI / 2, 0), 1, true);

  // Tilt nose-up, list to one side, sink into the sand.
  const hullMatrix = composeMatrix(new THREE.Vector3(0.1, -0.6, 0.15), new THREE.Euler(-0.4, 0, 0.22, "XZY"), 1);
  out.merge(hull, new THREE.Matrix4().multiplyMatrices(matrix, hullMatrix));

  // Toppled funnel half-buried beside the break.
  const extra = new Baker();
  const fy = ground(-1.6, -2.1);
  const funnelM = composeMatrix(new THREE.Vector3(-1.6, fy + 0.3, -2.1), new THREE.Euler(0.2, 0.4, 1.3), 1);
  extra.add(new THREE.CylinderGeometry(0.5, 0.58, 1.7, 8), FUNNEL, funnelM, true);
  extra.add(new THREE.CylinderGeometry(0.52, 0.52, 0.28, 8).translate(0, 0.45, 0), HULL_WHITE, funnelM, true);
  extra.add(new THREE.CylinderGeometry(0.4, 0.4, 0.06, 8).translate(0, 0.86, 0), "#2D2A32", funnelM, true);
  bakeDebris(extra, rng, ground);
  out.merge(extra, matrix);
  return { hullMatrix };
}

/** Tourist flotsam around the wreck. */
function bakeDebris(b: Baker, rng: () => number, ground: LocalGround): void {
  // Life ring: alternating red / white segments.
  const ringM = composeMatrix(new THREE.Vector3(2.6, ground(2.6, -0.4) + 0.08, -0.4), new THREE.Euler(-Math.PI / 2 + 0.08, 0, 0.3), 1);
  for (let k = 0; k < 8; k++) {
    const seg = new THREE.TorusGeometry(0.42, 0.11, 5, 3, Math.PI / 4);
    seg.rotateZ((k * Math.PI) / 4);
    b.add(seg, k % 2 === 0 ? "#E5383B" : "#FFFFFF", ringM, true);
  }
  // Suitcases with straps.
  const cases: Array<[number, number, number, string]> = [
    [2.4, -1.9, 0.4, "#5B8DD6"],
    [-2.6, -0.9, -0.6, "#FF8FB8"],
  ];
  for (const [x, z, yaw, color] of cases) {
    const m = composeMatrix(new THREE.Vector3(x, ground(x, z) + 0.2, z), new THREE.Euler(0.15, yaw, 0.1), 1);
    b.add(new THREE.BoxGeometry(0.7, 0.45, 0.25), color, m, true);
    b.add(new THREE.BoxGeometry(0.72, 0.08, 0.27), "#6B4A2B", m, true);
    b.add(new THREE.BoxGeometry(0.2, 0.06, 0.05).translate(0, 0.26, 0), "#2D2A32", m, true);
  }
  // Deck chair (striped canvas on a wooden frame), fallen over.
  const chairM = composeMatrix(new THREE.Vector3(-2.3, ground(-2.3, 0.6) + 0.25, 0.6), new THREE.Euler(0, 0.9, 0.35), 1);
  b.add(new THREE.BoxGeometry(0.06, 0.06, 1.3).translate(-0.3, 0, 0), WOOD.mid, chairM, true);
  b.add(new THREE.BoxGeometry(0.06, 0.06, 1.3).translate(0.3, 0, 0), WOOD.mid, chairM, true);
  for (let i = 0; i < 4; i++) {
    b.add(new THREE.BoxGeometry(0.58, 0.02, 0.3).translate(0, 0.03, -0.45 + i * 0.3), i % 2 ? "#FFFFFF" : "#3FB7D9", chairM, true);
  }
  // Beach umbrella stuck in the sand at an angle.
  const umbM = composeMatrix(new THREE.Vector3(2.3, ground(2.3, 1.2) - 0.1, 1.2), new THREE.Euler(0.25, 0, -0.2), 1);
  b.add(new THREE.CylinderGeometry(0.03, 0.03, 2.0, 5).translate(0, 1.0, 0), "#E8E8E8", umbM, true);
  for (let k = 0; k < 8; k++) {
    const seg = doubleSided(new THREE.ConeGeometry(1.0, 0.4, 8, 1, true, (k * Math.PI) / 4, Math.PI / 4).translate(0, 2.0, 0));
    b.add(seg, k % 2 === 0 ? PALETTE.sunset : "#FFF4DC", umbM, true);
  }
  // A crate with a stenciled band.
  const crateM = composeMatrix(new THREE.Vector3(-2.2, ground(-2.2, 1.6) + 0.24, 1.6), new THREE.Euler(0, rng() * 3, 0.05), 1);
  b.add(new THREE.BoxGeometry(0.55, 0.55, 0.55), WOOD.light, crateM, true);
  b.add(new THREE.BoxGeometry(0.57, 0.1, 0.57), WOOD.dark, crateM, true);
}

/** Two decal quads (one per bow side) in hull space for the "MS NEŞE" lettering. */
export function wreckLetteringGeometry(): THREE.BufferGeometry {
  const pos: number[] = [];
  const uv: number[] = [];
  const nor: number[] = [];
  const s0 = 0.36;
  const s1 = 0.72;
  for (let side = -1; side <= 1; side += 2) {
    const r0 = hullRing(s0)[0]!;
    const r1 = hullRing(s1)[0]!;
    // Chord along the upper hull side, pushed out past the convex skin.
    const x0 = Math.abs(r0.x) * side;
    const x1 = Math.abs(r1.x) * side;
    const dx = x1 - x0;
    const dz = r1.z - r0.z;
    const len = Math.hypot(dx, dz);
    let nx = dz / len;
    let nz = -dx / len;
    if (nx * side < 0) {
      nx = -nx;
      nz = -nz;
    }
    const g = new THREE.PlaneGeometry(len * 0.98, 0.62);
    g.rotateY(Math.atan2(nx, nz));
    g.translate((x0 + x1) / 2 + nx * 0.07, 2.4, (r0.z + r1.z) / 2 + nz * 0.07);
    const ng = g.toNonIndexed();
    pos.push(...(ng.getAttribute("position").array as Float32Array));
    uv.push(...(ng.getAttribute("uv").array as Float32Array));
    nor.push(...(ng.getAttribute("normal").array as Float32Array));
    ng.dispose();
    g.dispose();
  }
  const merged = new THREE.BufferGeometry();
  merged.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  merged.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2));
  merged.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
  return merged;
}
