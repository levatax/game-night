// Island floor: one mesh per ring segment (ring 0 = one disc) with textured top, banded walls,
// a chunky underside and, on the outermost ring, the theme's rim trim. Every segment is its own
// group pivoting at its centroid so the sudden-death crumble can shake and drop it alone.

import * as THREE from "three";
import { shapeDistance, type ArenaDef, type FloorKind } from "../../../../shared/maps";
import { mixHex, shadeHex } from "../../util/color";
import { hash2 } from "../noise";
import { angleOf, boundaryPoint } from "./shape";
import type { MaterialBank } from "./MaterialBank";
import { MeshBuilder, type P3 } from "./MeshBuilder";
import { floorStyleFor, type FloorStyle } from "./floorStyle";

/** Angular segments per falling ring (ring 0 never falls and is a single disc). */
export const SEGMENTS_PER_RING = 8;
/** Edge subdivisions per segment (8 × 8 = 64 sides around: low-poly but round). */
const EDGE_STEPS = 8;

/** Crumble lifecycle of one segment (driven by RingAnimator). */
export type SegmentStatus = "solid" | "shaking" | "falling" | "gone";

export interface RingSegment {
  ring: number;
  index: number;
  /** Pivot group at the segment centroid (y = 0); decor on this segment is parented here. */
  object: THREE.Group;
  centroid: THREE.Vector3;
  /** Horizontal unit vector from the island center toward the segment. */
  outward: THREE.Vector3;
  /** Mid angle of the segment (boundaryPoint convention), for the crumble tumble axis. */
  midAngle: number;
  status: SegmentStatus;
}

export interface FloorBuild {
  rings: RingSegment[][];
  /** Segment under (x, z), or null beyond the island edge. */
  segmentAt(x: number, z: number): RingSegment | null;
  /** Underside depth (positive) at (x, z) for hanging things below the island. */
  depthAt(x: number, z: number): number;
}

/** Angular offset per ring so segment seams don't line up like pizza slices. */
function ringOffset(ring: number): number {
  return ring * 0.37;
}

function wrapPositive(a: number): number {
  const tau = Math.PI * 2;
  return ((a % tau) + tau) % tau;
}

export function buildFloor(def: ArenaDef, bank: MaterialBank): FloorBuild {
  const style = floorStyleFor(def.theme.floorKind, def.theme);
  const topMat = bank.toonColor("#FFFFFF", { map: bank.tex(style.texture) });
  const sideMat = bank.toonColor("#FFFFFF", { vertexColors: true });
  const materials = [topMat, sideMat];
  const radii = def.ringRadii;
  const edge = radii[radii.length - 1];

  const depthAt = (x: number, z: number): number => {
    const r = shapeDistance(def.shape, x, z);
    const base = style.depth(r, edge);
    const jitter = style.jitter * (hash2(x, z, 11) - 0.5) * 2;
    return Math.max(0.6, base + jitter + (r < 1e-6 ? style.centerDrop : 0));
  };

  const rings: RingSegment[][] = radii.map((rOut, ring) => {
    const count = ring === 0 ? 1 : SEGMENTS_PER_RING;
    const span = (Math.PI * 2) / count;
    const segments: RingSegment[] = [];
    for (let index = 0; index < count; index++) {
      const a0 = ringOffset(ring) + index * span;
      const segment = buildSegment(def, style, materials, bank, {
        ring,
        index,
        a0,
        a1: a0 + span,
        rIn: ring === 0 ? 0 : radii[ring - 1],
        rOut,
        isEdge: ring === radii.length - 1,
        depthAt,
      });
      segments.push(segment);
    }
    return segments;
  });

  const segmentAt = (x: number, z: number): RingSegment | null => {
    const d = shapeDistance(def.shape, x, z);
    const ring = radii.findIndex((r) => d <= r);
    if (ring < 0) return null;
    const list = rings[ring];
    if (list.length === 1) return list[0];
    const span = (Math.PI * 2) / list.length;
    const a = wrapPositive(angleOf(x, z) - ringOffset(ring));
    return list[Math.min(list.length - 1, Math.floor(a / span))];
  };

  return { rings, segmentAt, depthAt };
}

interface SegmentSpec {
  ring: number;
  index: number;
  a0: number;
  a1: number;
  rIn: number;
  rOut: number;
  isEdge: boolean;
  depthAt(x: number, z: number): number;
}

function buildSegment(def: ArenaDef, style: FloorStyle, materials: THREE.Material[], bank: MaterialBank, spec: SegmentSpec): RingSegment {
  const { a0, a1, rIn, rOut } = spec;
  const shape = def.shape;
  const steps = spec.ring === 0 ? EDGE_STEPS * SEGMENTS_PER_RING : EDGE_STEPS;
  const radial = Math.max(1, style.radialSteps);
  const angles = Array.from({ length: steps + 1 }, (_, k) => a0 + ((a1 - a0) * k) / steps);
  const radiiSteps = Array.from({ length: radial + 1 }, (_, j) => rIn + ((rOut - rIn) * j) / radial);

  const at = (r: number, t: number, y = 0): P3 => {
    const p = boundaryPoint(shape, r, t);
    return { x: p.x, y, z: p.z };
  };
  const under = (r: number, t: number): P3 => {
    const p = at(r, t);
    p.y = -spec.depthAt(p.x, p.z);
    return p;
  };

  const mb = new MeshBuilder();
  mb.uvScale = style.textureMeters;

  // Top (textured).
  mb.group(0);
  const up = { x: 0, y: 1, z: 0 };
  for (let k = 0; k < steps; k++) {
    const t0 = angles[k];
    const t1 = angles[k + 1];
    if (rIn <= 0) mb.tri({ x: 0, y: 0, z: 0 }, at(rOut, t0), at(rOut, t1), "#FFFFFF", up);
    else mb.quad(at(rIn, t0), at(rOut, t0), at(rOut, t1), at(rIn, t1), "#FFFFFF", up);
  }

  // Walls, caps, underside (vertex colored).
  mb.group(1);
  for (let k = 0; k < steps; k++) {
    const t0 = angles[k];
    const t1 = angles[k + 1];
    const mid = (t0 + t1) / 2;
    const out = { x: Math.cos(mid), y: 0, z: Math.sin(mid) };
    wallStrip(mb, style, at(rOut, t0), at(rOut, t1), under(rOut, t0).y, under(rOut, t1).y, out);
    if (rIn > 0) {
      const inward = { x: -out.x, y: 0, z: -out.z };
      wallStrip(mb, style, at(rIn, t0), at(rIn, t1), under(rIn, t0).y, under(rIn, t1).y, inward);
    }
    for (let j = 0; j < radial; j++) {
      const ra = radiiSteps[j];
      const rb = radiiSteps[j + 1];
      const p00 = under(ra, t0);
      const p10 = under(rb, t0);
      const p11 = under(rb, t1);
      const p01 = under(ra, t1);
      const cx = (p00.x + p11.x) / 2;
      const cz = (p00.z + p11.z) / 2;
      const color = style.undersideColors[Math.floor(hash2(cx, cz, 7) * style.undersideColors.length)];
      mb.quad(p00, p10, p11, p01, color, { x: 0, y: -1, z: 0 });
    }
  }
  if (rIn > 0) {
    for (const [t, sign] of [
      [a0, -1],
      [a1, 1],
    ] as const) {
      const hint = { x: -Math.sin(t) * sign, y: 0, z: Math.cos(t) * sign };
      for (let j = 0; j < radial; j++) {
        const ra = radiiSteps[j];
        const rb = radiiSteps[j + 1];
        wallStrip(mb, style, at(ra, t), at(rb, t), under(ra, t).y, under(rb, t).y, hint);
      }
    }
  }
  if (spec.isEdge) addRimTrim(mb, def, def.theme.floorKind, a0, a1, rOut);
  else addRingSeam(mb, def, a0, a1, rOut, steps);

  const centroid = segmentCentroid(def, spec);
  const mesh = new THREE.Mesh(bank.geo(mb.build(centroid)), materials);
  mesh.name = `ring${spec.ring}:${spec.index}`;
  mesh.receiveShadow = true;

  const object = new THREE.Group();
  object.name = `segment${spec.ring}:${spec.index}`;
  object.position.copy(centroid);
  object.add(mesh);
  const outward = new THREE.Vector3(centroid.x, 0, centroid.z);
  if (outward.lengthSq() < 1e-6) outward.set(1, 0, 0);
  outward.normalize();
  const midAngle = (a0 + a1) / 2;
  return { ring: spec.ring, index: spec.index, object, centroid, outward, midAngle, status: "solid" };
}

function segmentCentroid(def: ArenaDef, spec: SegmentSpec): THREE.Vector3 {
  if (spec.rIn <= 0) return new THREE.Vector3(0, 0, 0);
  const mid = (spec.a0 + spec.a1) / 2;
  const p = boundaryPoint(def.shape, (spec.rIn + spec.rOut) / 2, mid);
  return new THREE.Vector3(p.x, 0, p.z);
}

/** Vertical strip p0→p1 from y = 0 down to y0/y1 (negative), split into the style's color bands. */
function wallStrip(mb: MeshBuilder, style: FloorStyle, p0: P3, p1: P3, y0: number, y1: number, hint: P3): void {
  const d0 = -y0;
  const d1 = -y1;
  let top = 0;
  const vary = (hash2(p0.x + p1.x, p0.z + p1.z, 3) - 0.5) * 0.06;
  for (const band of style.bands) {
    const bottom = band.to;
    const a0 = Math.min(top, d0);
    const b0 = Math.min(bottom, d0);
    const a1 = Math.min(top, d1);
    const b1 = Math.min(bottom, d1);
    if (b0 - a0 > 1e-4 || b1 - a1 > 1e-4) {
      const color = shadeHex(band.color, vary);
      mb.quad(
        { x: p0.x, y: -a0, z: p0.z },
        { x: p1.x, y: -a1, z: p1.z },
        { x: p1.x, y: -b1, z: p1.z },
        { x: p0.x, y: -b0, z: p0.z },
        color,
        hint,
      );
    }
    top = bottom;
    if (top >= Math.max(d0, d1)) break;
  }
}

/**
 * Faint groove just inside a ring's outer boundary, so players can read where the island will
 * crumble next during sudden death. Low contrast on purpose (balls must stay readable).
 */
function addRingSeam(mb: MeshBuilder, def: ArenaDef, a0: number, a1: number, r: number, steps: number): void {
  const theme = def.theme;
  const color = mixHex(theme.floorColor, theme.floorShadeColor, 0.42);
  const up = { x: 0, y: 1, z: 0 };
  const y = 0.012;
  const width = 0.06;
  for (let k = 0; k < steps; k++) {
    const t0 = a0 + ((a1 - a0) * k) / steps;
    const t1 = a0 + ((a1 - a0) * (k + 1)) / steps;
    const p = (rr: number, t: number): P3 => {
      const b = boundaryPoint(def.shape, rr, t);
      return { x: b.x, y, z: b.z };
    };
    mb.quad(p(r - width, t0), p(r, t0), p(r, t1), p(r - width, t1), color, up);
  }
}

/* ------------------------------------------------------------- rim trims */

function addRimTrim(mb: MeshBuilder, def: ArenaDef, kind: FloorKind, a0: number, a1: number, edge: number): void {
  const arc = (a1 - a0) * edge;
  const steps = Math.max(8, Math.ceil(arc / 0.22));
  const theme = def.theme;
  const pt = (r: number, t: number, y: number): P3 => {
    const p = boundaryPoint(def.shape, r, t);
    return { x: p.x, y, z: p.z };
  };
  for (let k = 0; k < steps; k++) {
    const t0 = a0 + ((a1 - a0) * k) / steps;
    const t1 = a0 + ((a1 - a0) * (k + 1)) / steps;
    const mid = (t0 + t1) / 2;
    const out = { x: Math.cos(mid), y: 0, z: Math.sin(mid) };
    if (kind === "grass") grassLip(mb, pt, edge, t0, t1, out, theme.rimColor);
    else if (kind === "tile") tubRim(mb, pt, edge, t0, t1, out, theme.rimColor);
    else frostingDrips(mb, pt, edge, t0, t1, out, theme.rimColor);
  }
}

type PointAt = (r: number, t: number, y: number) => P3;

function grassLip(mb: MeshBuilder, pt: PointAt, edge: number, t0: number, t1: number, out: P3, color: string): void {
  const top = 0.035;
  const drop = (t: number) => {
    const p = pt(edge, t, 0);
    return 0.2 + hash2(p.x, p.z, 5) * 0.22;
  };
  const d0 = drop(t0);
  const d1 = drop(t1);
  const up = { x: 0, y: 1, z: 0 };
  mb.quad(pt(edge - 0.16, t0, top), pt(edge + 0.14, t0, top), pt(edge + 0.14, t1, top), pt(edge - 0.16, t1, top), color, up);
  mb.quad(pt(edge + 0.14, t0, top), pt(edge + 0.14, t1, top), pt(edge + 0.08, t1, -d1), pt(edge + 0.08, t0, -d0), shadeHex(color, -0.08), out);
  mb.quad(pt(edge + 0.08, t0, -d0), pt(edge + 0.08, t1, -d1), pt(edge, t1, -d1 - 0.05), pt(edge, t0, -d0 - 0.05), shadeHex(color, -0.25), { x: 0, y: -1, z: 0 });
}

/** Rolled bathtub rim: a faceted half-round profile hugging the edge. */
const TUB_PROFILE: ReadonlyArray<[number, number]> = [
  [-0.22, 0.0],
  [-0.14, 0.07],
  [0.0, 0.1],
  [0.13, 0.06],
  [0.2, -0.06],
  [0.17, -0.2],
  [0.07, -0.29],
  [0.0, -0.31],
];

function tubRim(mb: MeshBuilder, pt: PointAt, edge: number, t0: number, t1: number, out: P3, color: string): void {
  for (let i = 0; i < TUB_PROFILE.length - 1; i++) {
    const [ra, ya] = TUB_PROFILE[i];
    const [rb, yb] = TUB_PROFILE[i + 1];
    // Outward normal of this profile edge (rotate the profile tangent by -90°).
    const nr = yb - ya;
    const ny = -(rb - ra);
    const hint = { x: out.x * nr, y: ny, z: out.z * nr };
    const shade = ny > 0.5 ? 0.15 : ny < -0.3 ? -0.12 : 0;
    mb.quad(pt(edge + ra, t0, ya), pt(edge + rb, t0, yb), pt(edge + rb, t1, yb), pt(edge + ra, t1, ya), shadeHex(color, shade), hint);
  }
}

function frostingDrips(mb: MeshBuilder, pt: PointAt, edge: number, t0: number, t1: number, out: P3, color: string): void {
  const top = 0.04;
  // ~61 drips around the cake, each with its own length.
  const drip = (t: number) => {
    const phase = t * 61 + 0.6;
    const wave = Math.max(0, Math.sin(phase));
    const length = 0.3 + hash2(Math.floor(phase / (Math.PI * 2)), 0, 9) * 0.55;
    return 0.16 + Math.pow(wave, 3) * length;
  };
  const up = { x: 0, y: 1, z: 0 };
  mb.quad(pt(edge - 0.14, t0, top), pt(edge + 0.06, t0, top), pt(edge + 0.06, t1, top), pt(edge - 0.14, t1, top), color, up);
  const d0 = drip(t0);
  const d1 = drip(t1);
  mb.quad(pt(edge + 0.06, t0, top), pt(edge + 0.06, t1, top), pt(edge + 0.06, t1, -d1), pt(edge + 0.06, t0, -d0), color, out);
  mb.quad(pt(edge + 0.06, t0, -d0), pt(edge + 0.06, t1, -d1), pt(edge, t1, -d1 - 0.02), pt(edge, t0, -d0 - 0.02), shadeHex(color, -0.12), { x: 0, y: -1, z: 0 });
}
