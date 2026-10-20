// Static, cosmetic decor baked into the per-segment vertex-colored mesh (no extra draw calls):
// trees, bushes, flowers, gingham blanket, sprinkles, cherries, soap-foam piles, tub feet, tufts.

import * as THREE from "three";
import { pointInCover } from "../../../../../shared/sim/geometry";
import { shapeDistance, type DecorItem } from "../../../../../shared/maps";
import { mixHex, shadeHex } from "../../../util/color";
import { pick, randRange } from "../../noise";
import { Baker, composeMatrix } from "../Baker";
import type { ArenaKit } from "../kit";
import { boundaryPoint } from "../shape";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** Item transform: floor position (+ optional base height), yaw, uniform scale. */
function itemMatrix(item: DecorItem): THREE.Matrix4 {
  return composeMatrix(v3(item.x, item.y ?? 0, item.z), new THREE.Euler(0, item.rotation, 0), item.scale);
}

/* =================================================================== trees */

export function bakeTree(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const b = new Baker();
  const lean = randRange(rng, -0.08, 0.08);
  b.addAt(new THREE.CylinderGeometry(0.15, 0.26, 1.5, 7), "#8D5B3A", v3(0, 0.72, 0), new THREE.Euler(lean, 0, lean * 0.5), 1, true);
  // Root flare so the trunk sits in the grass.
  b.addAt(new THREE.ConeGeometry(0.42, 0.3, 7), "#7A4E31", v3(0, 0.1, 0), null, 1, true);
  const greens = ["#5FBF73", "#4FA36B", "#7BD389", "#56B36A"];
  const blobs: Array<[number, number, number, number]> = [
    [0, 2.15, 0, 1.0],
    [0.55, 1.75, 0.2, 0.68],
    [-0.5, 1.85, -0.25, 0.72],
    [0.1, 2.75, -0.1, 0.62],
  ];
  blobs.forEach(([x, y, z, r], i) => {
    b.addAt(new THREE.IcosahedronGeometry(r, 1), greens[i % greens.length], v3(x, y, z), new THREE.Euler(rng(), rng(), rng()), 1, true);
  });
  for (let i = 0; i < 3; i++) {
    const a = rng() * Math.PI * 2;
    b.addAt(new THREE.SphereGeometry(0.11, 10, 8), "#FF5A5F", v3(Math.cos(a) * 0.85, 1.9 + rng() * 0.5, Math.sin(a) * 0.85));
  }
  kit.bakerAt(item.x, item.z).merge(b, itemMatrix(item));
}

export function bakeBush(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const b = new Baker();
  const greens = ["#5FBF73", "#4FA36B", "#6CCB7E"];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + rng();
    const r = randRange(rng, 0.38, 0.55);
    b.addAt(new THREE.IcosahedronGeometry(r, 1), greens[i % 3], v3(Math.cos(a) * 0.35, r * 0.75, Math.sin(a) * 0.35), new THREE.Euler(rng(), rng(), 0), 1, true);
  }
  for (let i = 0; i < 5; i++) {
    const a = rng() * Math.PI * 2;
    b.addAt(new THREE.SphereGeometry(0.07, 8, 6), pick(rng, ["#FFFFFF", "#FFC6DA", "#FFF6A8"]), v3(Math.cos(a) * 0.6, 0.45 + rng() * 0.35, Math.sin(a) * 0.6));
  }
  kit.bakerAt(item.x, item.z).merge(b, itemMatrix(item));
}

export function bakeFlowers(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const b = new Baker();
  const petals = ["#FFFFFF", "#FFC6DA", "#FFF6A8", "#C9B6FF"];
  const count = 6;
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const d = rng() * 0.55;
    const x = Math.cos(a) * d;
    const z = Math.sin(a) * d;
    const h = randRange(rng, 0.2, 0.38);
    const petal = petals[i % petals.length];
    b.addAt(new THREE.CylinderGeometry(0.015, 0.02, h, 4), "#4FA36B", v3(x, h / 2, z), null, 1, true);
    for (let k = 0; k < 5; k++) {
      const pa = (k / 5) * Math.PI * 2;
      b.addAt(new THREE.SphereGeometry(1, 8, 6), petal, v3(x + Math.cos(pa) * 0.06, h, z + Math.sin(pa) * 0.06), null, v3(0.05, 0.02, 0.05));
    }
    b.addAt(new THREE.SphereGeometry(0.035, 8, 6), "#FFB43F", v3(x, h + 0.01, z));
    b.addAt(new THREE.SphereGeometry(1, 6, 4), "#5FBF73", v3(x + 0.05, h * 0.35, z), new THREE.Euler(0, a, 0.6), v3(0.07, 0.015, 0.035), true);
  }
  kit.bakerAt(item.x, item.z).merge(b, itemMatrix(item));
}

/* ================================================================= blanket */

/**
 * Red gingham picnic blanket, `scale` meters square. Cut into cells, each baked into the segment
 * under it, so the part over a crumbling ring falls with that ring.
 */
export function bakeBlanket(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const size = item.scale;
  const cells = 10;
  const cell = size / cells;
  const red = "#E8505B";
  const white = "#FFF6EE";
  const pink = mixHex(red, white, 0.55);
  const m = composeMatrix(v3(item.x, 0, item.z), new THREE.Euler(0, item.rotation, 0), 1);
  const center = new THREE.Vector3();
  for (let i = 0; i < cells; i++) {
    for (let j = 0; j < cells; j++) {
      const stripes = (i % 2 === 0 ? 1 : 0) + (j % 2 === 0 ? 1 : 0);
      const color = stripes === 2 ? red : stripes === 1 ? pink : white;
      const cx = -size / 2 + (i + 0.5) * cell;
      const cz = -size / 2 + (j + 0.5) * cell;
      center.set(cx, 0, cz).applyMatrix4(m);
      const quad = new THREE.PlaneGeometry(cell, cell);
      quad.rotateX(-Math.PI / 2);
      // Slight rumple so it doesn't look like a decal.
      quad.translate(cx, 0.015 + rng() * 0.012, cz);
      kit.bakerAt(center.x, center.z).add(quad, color, m, true);
    }
  }
  // A little lunch on the blanket: a plate with a sandwich, and an apple.
  const lunch = new Baker();
  lunch.addAt(new THREE.CylinderGeometry(0.32, 0.26, 0.04, 18), "#FFFFFF", v3(size * 0.18, 0.04, -size * 0.12));
  lunch.merge(sandwich(), composeMatrix(v3(size * 0.18, 0.06, -size * 0.12), new THREE.Euler(0, 0.6, 0)));
  lunch.addAt(new THREE.SphereGeometry(0.13, 12, 10), "#FF5A5F", v3(-size * 0.22, 0.14, size * 0.18));
  lunch.addAt(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 4), "#8D5B3A", v3(-size * 0.22, 0.29, size * 0.18));
  kit.bakerAt(item.x, item.z).merge(lunch, m);
}

/** Triangle sandwich: bread / lettuce / tomato / bread. */
function sandwich(): Baker {
  const b = new Baker();
  const layer = (y: number, h: number, color: string, s: number) => {
    b.addAt(new THREE.CylinderGeometry(0.2 * s, 0.2 * s, h, 3), color, v3(0, y, 0), null, 1, true);
  };
  layer(0.02, 0.04, "#F2C98A", 1);
  layer(0.05, 0.02, "#7BD389", 1.08);
  layer(0.07, 0.02, "#FF8A6B", 1.02);
  layer(0.1, 0.04, "#F2C98A", 1);
  return b;
}

/* =============================================================== sprinkles */

const SPRINKLE_COLORS = ["#FFF4A3", "#FFFFFF", "#9FE3FF", "#B9F5C8", "#FF8FB8", "#D7B8FF"];

/** 3D sprinkles scattered over the cake top within `scale` m of (x, z), off cover and pedestals. */
export function bakeSprinkles(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const def = kit.def;
  const edge = def.ringRadii[def.ringRadii.length - 1] - 0.4;
  const count = 240;
  const geo = new THREE.CapsuleGeometry(0.035, 0.13, 1, 5);
  geo.rotateZ(Math.PI / 2);
  const m = new THREE.Matrix4();
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const r = Math.sqrt(rng()) * item.scale;
    const x = item.x + Math.cos(a) * r;
    const z = item.z + Math.sin(a) * r;
    if (shapeDistance(def.shape, x, z) > edge) continue;
    if (def.cover.some((c) => pointInCover(c, x, z, 0.3))) continue;
    if (def.pedestals.some((p) => Math.hypot(p.x - x, p.z - z) < 1.1)) continue;
    composeMatrix(v3(x, 0.035, z), new THREE.Euler(0, rng() * Math.PI, 0), 1, m);
    kit.bakerAt(x, z).add(geo.clone(), SPRINKLE_COLORS[i % SPRINKLE_COLORS.length], m);
  }
  geo.dispose();
}

/* ================================================================= cherry */

export function bakeCherry(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const b = new Baker();
  // Cream dollop the cherry sits on.
  b.addAt(new THREE.ConeGeometry(0.42, 0.34, 10), "#FFF8EE", v3(0, 0.17, 0), new THREE.Euler(0, rng(), 0), 1, true);
  b.addAt(new THREE.SphereGeometry(0.4, 12, 8), "#FFFFFF", v3(0, 0.12, 0), null, v3(1, 0.45, 1));
  b.addAt(new THREE.SphereGeometry(0.32, 18, 14), "#D7263D", v3(0, 0.5, 0));
  b.addAt(new THREE.SphereGeometry(1, 8, 6), "#FFFFFF", v3(-0.12, 0.62, 0.17), new THREE.Euler(0.4, 0.4, 0.5), v3(0.04, 0.08, 0.03));
  b.addAt(new THREE.CylinderGeometry(0.02, 0.025, 0.42, 5), "#5C8A2E", v3(0.07, 0.95, 0), new THREE.Euler(0, 0, -0.35), 1, true);
  b.addAt(new THREE.SphereGeometry(1, 6, 4), "#6CC24A", v3(0.2, 1.1, 0.04), new THREE.Euler(0.2, 0.3, -0.9), v3(0.12, 0.025, 0.06), true);
  kit.bakerAt(item.x, item.z).merge(b, itemMatrix(item));
}

/* ============================================================== foam piles */

export function bakeFoam(kit: ArenaKit, item: DecorItem, rng: () => number): void {
  const b = new Baker();
  const count = 9;
  for (let i = 0; i < count; i++) {
    const a = rng() * Math.PI * 2;
    const d = Math.sqrt(rng()) * 0.75;
    const r = randRange(rng, 0.12, 0.38) * (1 - d * 0.5);
    b.addAt(new THREE.SphereGeometry(r, 14, 10), i % 3 === 0 ? "#EAF6FB" : "#FFFFFF", v3(Math.cos(a) * d, r * 0.55, Math.sin(a) * d));
  }
  kit.bakerAt(item.x, item.z).merge(b, itemMatrix(item));
}

/* ============================================================ bathtub feet */

/** Golden claw feet under the tub's outer ring on the diagonals (they fall with their segment). */
export function bakeTubFeet(kit: ArenaKit): void {
  const def = kit.def;
  const edge = def.ringRadii[def.ringRadii.length - 1];
  const inner = def.ringRadii[def.ringRadii.length - 2];
  const gold = "#E8B84A";
  for (let k = 0; k < 4; k++) {
    const a = Math.PI / 4 + (k * Math.PI) / 2;
    const p = boundaryPoint(def.shape, (edge + inner) / 2, a);
    const top = -kit.floor.depthAt(p.x, p.z) + 0.15;
    const b = new Baker();
    b.addAt(new THREE.CylinderGeometry(0.42, 0.3, 0.6, 10), gold, v3(0, top - 0.3, 0), null, 1, true);
    b.addAt(new THREE.SphereGeometry(0.42, 14, 10), shadeHex(gold, 0.15), v3(0, top - 0.85, 0));
    for (let t = 0; t < 4; t++) {
      const ta = (t / 4) * Math.PI * 2 + a;
      b.addAt(new THREE.CapsuleGeometry(0.1, 0.3, 3, 6), shadeHex(gold, -0.12), v3(Math.cos(ta) * 0.36, top - 0.95, Math.sin(ta) * 0.36), new THREE.Euler(Math.sin(ta) * 0.6, 0, -Math.cos(ta) * 0.6));
    }
    kit.bakerAt(p.x, p.z).merge(b, composeMatrix(v3(p.x, 0, p.z)));
  }
}

/* ============================================================= grass tufts */

/** A light scatter of grass tufts on the picnic island, avoiding cover, pedestals and spawns. */
export function bakeGrassTufts(kit: ArenaKit, rng: () => number): void {
  const def = kit.def;
  const edge = def.ringRadii[def.ringRadii.length - 1] - 0.6;
  const colors = [def.theme.floorShadeColor, shadeHex(def.theme.floorColor, -0.08), def.theme.rimColor];
  const m = new THREE.Matrix4();
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2;
    const r = 2.5 + Math.sqrt(rng()) * (edge - 2.5);
    const x = Math.cos(a) * r;
    const z = Math.sin(a) * r;
    if (def.cover.some((c) => pointInCover(c, x, z, 0.5))) continue;
    if (def.pedestals.some((p) => Math.hypot(p.x - x, p.z - z) < 1.3)) continue;
    if (def.spawns.some((s) => Math.hypot(s.x - x, s.z - z) < 1.2)) continue;
    const tuft = new Baker();
    const color = pick(rng, colors);
    for (let k = 0; k < 3; k++) {
      const h = randRange(rng, 0.14, 0.26);
      tuft.addAt(new THREE.ConeGeometry(0.035, h, 3), color, v3((k - 1) * 0.05, h / 2, rng() * 0.04), new THREE.Euler(0, rng() * 3, (k - 1) * 0.35), 1, true);
    }
    composeMatrix(v3(x, 0, z), new THREE.Euler(0, rng() * Math.PI * 2, 0), randRange(rng, 0.8, 1.3), m);
    kit.bakerAt(x, z).merge(tuft, m);
  }
}
