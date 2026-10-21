// Inland landmarks baked into the static mesh: the fresh-water spring (mossy rock ring, basin, reeds, a lily
// pad, a bamboo spout) and the cave mouth (a rock overhang with a dark floor that conforms to the slope, opening
// downhill), plus the secret chest model (dark pirate chest half-buried under palm leaves, gold bands, a red X)
// whose lid Sites animates. World-space positions; `ground` samples the terrain. Owner: client-render.

import * as THREE from "three";
import { normalAt } from "../../../../../shared/island/heightfield";
import type { Heightfield, IslandSite } from "../../../../../shared/island/types";
import { Baker, composeMatrix } from "../../kit/Baker";
import { MeshBuilder } from "../../kit/MeshBuilder";
import { createRng, randRange } from "../../noise";
import type { WorldGround } from "./camp";

/** Spring pool radius (the water disc Sites draws on top). */
export const SPRING_POOL_RADIUS = 0.95;
/** Water surface above the basin's top at +0.03, leaving depth between the two meshes. */
export const SPRING_WATER_HEIGHT = 0.065;

function lumpy(g: THREE.BufferGeometry, amount: number, seed: number, squash = 1): THREE.BufferGeometry {
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = Math.sin(x * 23.1 + y * 51.7 + z * 11.3 + seed) * 43758.5453;
    const k = 1 + ((h - Math.floor(h)) * 2 - 1) * amount;
    pos.setXYZ(i, x * k, y * k * squash, z * k);
  }
  return g;
}

export function bakeSpring(out: Baker, spring: { x: number; z: number }, rock: string, grass: string, ground: WorldGround, seed: number): number {
  const rng = createRng(seed ^ 0x5b21);
  const y = ground(spring.x, spring.z);
  const b = new Baker();
  const moss = new THREE.Color(rock).lerp(new THREE.Color(grass), 0.35).getStyle();
  // Basin under the water.
  b.addAt(new THREE.CylinderGeometry(SPRING_POOL_RADIUS, SPRING_POOL_RADIUS * 0.7, 0.3, 12), "#2F5F73", new THREE.Vector3(0, -0.12, 0), null, 1, true);
  const count = 9;
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + rng() * 0.25;
    const r = randRange(rng, 0.22, 0.36);
    const d = SPRING_POOL_RADIUS + r * 0.45;
    const lx = Math.cos(a) * d;
    const lz = Math.sin(a) * d;
    const gy = ground(spring.x + lx, spring.z + lz) - y;
    b.addVaried(lumpy(new THREE.DodecahedronGeometry(r, 0), 0.2, i, 0.7), i % 3 === 0 ? moss : rock, composeMatrix(new THREE.Vector3(lx, gy + r * 0.3, lz), new THREE.Euler(rng(), rng() * 3, 0), 1), 0.1, i);
  }
  // Reeds.
  for (let i = 0; i < 7; i++) {
    const a = rng() * Math.PI * 2;
    const d = SPRING_POOL_RADIUS * randRange(rng, 0.65, 0.95);
    const h = randRange(rng, 0.5, 0.9);
    b.addAt(new THREE.ConeGeometry(0.03, h, 4), "#5C8F3A", new THREE.Vector3(Math.cos(a) * d, h / 2 - 0.05, Math.sin(a) * d), new THREE.Euler(rng() * 0.2, 0, rng() * 0.2), 1, true);
    if (i % 3 === 0) b.addAt(new THREE.CapsuleGeometry(0.035, 0.12, 1, 5), "#7A4E2D", new THREE.Vector3(Math.cos(a) * d, h - 0.05, Math.sin(a) * d), null, 1, true);
  }
  // Lily pad with a flower.
  b.addAt(new THREE.CylinderGeometry(0.2, 0.2, 0.02, 8, 1, false, 0.4, Math.PI * 1.8), "#4FA36B", new THREE.Vector3(0.3, SPRING_WATER_HEIGHT + 0.02, -0.2), null, 1, true);
  b.addAt(new THREE.ConeGeometry(0.07, 0.08, 5), "#FF8FB8", new THREE.Vector3(0.32, SPRING_WATER_HEIGHT + 0.07, -0.18), null, 1, true);
  // Bamboo spout trickling into the pool from the uphill side.
  const spout = new THREE.Vector3(-SPRING_POOL_RADIUS - 0.25, 0.55, 0);
  b.addAt(new THREE.CylinderGeometry(0.06, 0.06, 0.9, 6), "#B9C46A", spout, new THREE.Euler(0, 0, 1.25), 1, true);
  b.addAt(new THREE.CylinderGeometry(0.065, 0.065, 0.04, 6), "#8E9A45", spout.clone().add(new THREE.Vector3(0.2, -0.07, 0)), new THREE.Euler(0, 0, 1.25), 1, true);
  out.merge(b, composeMatrix(new THREE.Vector3(spring.x, y, spring.z), new THREE.Euler(0, rng() * Math.PI * 2, 0), 1));
  return y;
}

/** Rock overhang over the shelter circle, opening downhill. */
export function bakeCave(out: Baker, cave: NonNullable<IslandSite["cave"]>, grid: Heightfield, rock: string, ground: WorldGround, seed: number): void {
  const rng = createRng(seed ^ 0xca7e);
  const n = normalAt(grid, cave.x, cave.z);
  let dx = n.x;
  let dz = n.z;
  const len = Math.hypot(dx, dz);
  if (len < 0.05) {
    dx = 1;
    dz = 0;
  } else {
    dx /= len;
    dz /= len;
  }
  // Local frame: +Z = downhill (the mouth), +X = across.
  const yaw = Math.atan2(dx, dz);
  const r = Math.max(2, Math.min(4.5, cave.radius));
  const y = ground(cave.x, cave.z);
  const toWorld = (lx: number, lz: number) => {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return { x: cave.x + lx * c + lz * s, z: cave.z - lx * s + lz * c };
  };
  const b = new Baker();
  const dark = new THREE.Color(rock).multiplyScalar(0.55).getStyle();
  const place = (lx: number, lz: number, size: number, sy: number, color: string, k: number) => {
    const w = toWorld(lx, lz);
    const gy = ground(w.x, w.z) - y;
    const m = composeMatrix(new THREE.Vector3(lx, gy + size * sy * 0.45, lz), new THREE.Euler(rng() * 0.5, rng() * 3, rng() * 0.3), new THREE.Vector3(size, size * sy, size));
    b.addVaried(lumpy(new THREE.DodecahedronGeometry(1, 0), 0.2, k), color, m, 0.1, k);
  };
  // Back wall (uphill) and side walls, all outside the shelter circle so nobody walks through rock.
  for (let i = 0; i < 5; i++) {
    const t = (i / 4) * 2 - 1;
    place(t * r * 0.85, -r * 1.05 - Math.abs(t) * 0.25, randRange(rng, 1.0, 1.35), 1.5, rock, 10 + i);
  }
  for (const side of [-1, 1]) {
    place(side * r * 1.08, -r * 0.55, 0.85, 2.0, rock, 21 + side);
    place(side * r * 1.12, -r * 0.05, 0.7, 1.7, rock, 25 + side);
  }
  // Roof slab: a flattened boulder chain over the back half of the shelter at ~2.9 m (head room below).
  for (let i = 0; i < 4; i++) {
    const t = (i / 3) * 2 - 1;
    const m = composeMatrix(new THREE.Vector3(t * r * 0.6, 3.0 + rng() * 0.25, -r * 0.35 + rng() * 0.25), new THREE.Euler(rng() * 0.2, rng() * 3, rng() * 0.2), new THREE.Vector3(r * 0.6, 0.42, r * 0.72));
    b.addVaried(lumpy(new THREE.DodecahedronGeometry(1, 0), 0.15, 30 + i), i % 2 ? rock : dark, m, 0.08, 30 + i);
  }
  // A few hanging vines / moss at the lip of the roof.
  for (let i = 0; i < 5; i++) {
    const x = ((i / 4) * 2 - 1) * r * 0.75;
    const len = randRange(rng, 0.5, 1.0);
    b.addAt(new THREE.CylinderGeometry(0.03, 0.03, len, 3, 1, true), "#5C7F2C", new THREE.Vector3(x, 2.75 - len / 2, r * 0.25), null, 1, true);
  }
  // Dark floor that hugs the slope under the roof.
  const mb = new MeshBuilder();
  const N = 6;
  const floorColor = new THREE.Color(rock).multiplyScalar(0.35).getStyle();
  const pt = (i: number, j: number) => {
    const lx = ((i / N) * 2 - 1) * r * 0.8;
    const lz = ((j / N) * 2 - 1) * r * 0.75 - r * 0.15;
    const w = toWorld(lx, lz);
    return { x: lx, y: ground(w.x, w.z) - y + 0.04, z: lz };
  };
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < N; j++) {
      const ci = (i + 0.5) / N - 0.5;
      const cj = (j + 0.5) / N - 0.5;
      if (ci * ci + cj * cj > 0.27) continue;
      mb.quad(pt(i, j), pt(i + 1, j), pt(i + 1, j + 1), pt(i, j + 1), floorColor, { x: 0, y: 1, z: 0 });
    }
  }
  b.addVertexColored(mb.build(), new THREE.Matrix4(), true);
  out.merge(b, composeMatrix(new THREE.Vector3(cave.x, y, cave.z), new THREE.Euler(0, yaw, 0), 1));
}

/** Secret chest: body (with the X and leaf cover) and lid separately so the lid can open. Local space, origin on the sand. */
export function secretChestGeometries(): { body: THREE.BufferGeometry; lid: THREE.BufferGeometry; lidPivot: THREE.Vector3 } {
  const DARK = "#5A3A22";
  const GOLD = "#E8B84A";
  const body = new Baker();
  // Half buried: the box starts below the sand.
  body.addAt(new THREE.BoxGeometry(0.9, 0.5, 0.56), DARK, new THREE.Vector3(0, 0.12, 0), null, 1, true);
  for (const x of [-0.3, 0.3]) body.addAt(new THREE.BoxGeometry(0.08, 0.52, 0.58), GOLD, new THREE.Vector3(x, 0.12, 0), null, 1, true);
  body.addAt(new THREE.BoxGeometry(0.14, 0.16, 0.04), GOLD, new THREE.Vector3(0, 0.3, -0.3), null, 1, true);
  // Mound of sand around it.
  body.addAt(new THREE.SphereGeometry(0.75, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2), "#E6D3A0", new THREE.Vector3(0, -0.14, 0), null, new THREE.Vector3(1.2, 0.35, 1.0), true);
  // A red X painted on two planks in front of it.
  for (const a of [0.7, -0.7]) body.addAt(new THREE.BoxGeometry(0.9, 0.03, 0.12), "#D7263D", new THREE.Vector3(0, 0.02, -0.75), new THREE.Euler(0, a, 0), 1, true);
  // Palm-leaf cover leaning on the back.
  for (let i = 0; i < 3; i++) {
    body.addAt(new THREE.BoxGeometry(0.22, 0.02, 1.1), i % 2 ? "#6FBF5A" : "#4FA36B", new THREE.Vector3(-0.3 + i * 0.3, 0.32, 0.45), new THREE.Euler(0.9, (i - 1) * 0.3, 0), 1, true);
  }
  const lid = new Baker();
  // Lid geometry is built around its hinge (back top edge at the origin).
  lid.addAt(new THREE.CylinderGeometry(0.28, 0.28, 0.9, 8, 1, false, 0, Math.PI), DARK, new THREE.Vector3(0, 0, -0.28), new THREE.Euler(0, 0, Math.PI / 2), new THREE.Vector3(0.6, 1, 1), true);
  for (const x of [-0.3, 0.3]) {
    lid.addAt(new THREE.CylinderGeometry(0.285, 0.285, 0.08, 8, 1, false, 0, Math.PI), GOLD, new THREE.Vector3(x, 0, -0.28), new THREE.Euler(0, 0, Math.PI / 2), new THREE.Vector3(0.62, 1, 1.02), true);
  }
  return { body: body.build(), lid: lid.build(), lidPivot: new THREE.Vector3(0, 0.37, 0.28) };
}
