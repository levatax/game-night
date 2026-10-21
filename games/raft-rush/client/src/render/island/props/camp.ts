// Camp props baked into the static landmark mesh: the campfire's stone ring, ash bed and charred teepee, a spare
// firewood stack, two seating logs and the "tezgah" workbench (plank table on stumps with rope and a stone),
// plus the shared camp chest (wooden, banded, facing the fire). The flame itself is animated by Campfire.ts.
// Positions are world-space; `ground` samples the terrain. Owner: client-render.

import * as THREE from "three";
import type { XZ } from "../../../../../shared/island/types";
import { Baker, composeMatrix } from "../../kit/Baker";
import { createRng, randRange } from "../../noise";
import { WOOD } from "../../textures";

export type WorldGround = (x: number, z: number) => number;

const STONE = "#8F8A84";
const STONE_DARK = "#6E6A66";
const ASH = "#3B3534";
const CHAR = "#3E2C22";
const BARK = "#6E452C";
const CUT = "#E0B98A";
const METAL = "#5A5E66";
const GOLD = "#E8B84A";

/** Yaw that makes local -Z point from `from` toward `to`. */
export function yawToward(from: XZ, to: XZ): number {
  return Math.atan2(-(to.x - from.x), -(to.z - from.z));
}

function lumpyStone(r: number, seed: number): THREE.BufferGeometry {
  const g = new THREE.DodecahedronGeometry(r, 0);
  const pos = g.getAttribute("position") as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const h = Math.sin(x * 41.3 + y * 17.1 + z * 29.7 + seed) * 43758.5453;
    const k = 1 + ((h - Math.floor(h)) * 2 - 1) * 0.18;
    pos.setXYZ(i, x * k, y * k * 0.75, z * k);
  }
  return g;
}

/** Stone ring, ash, charred logs, seating logs, workbench and firewood around `fire`. */
export function bakeCampfireBase(out: Baker, fire: XZ, chest: XZ, ground: WorldGround, seed: number): void {
  const rng = createRng(seed ^ 0xca39);
  const gy = ground(fire.x, fire.z);
  const base = composeMatrix(new THREE.Vector3(fire.x, gy, fire.z), new THREE.Euler(0, rng() * Math.PI, 0), 1);
  const b = new Baker();
  // Ash bed and a ring of stones.
  b.addAt(new THREE.CylinderGeometry(0.62, 0.7, 0.06, 10), ASH, new THREE.Vector3(0, 0.02, 0), null, 1, true);
  const stones = 10;
  for (let i = 0; i < stones; i++) {
    const a = (i / stones) * Math.PI * 2 + rng() * 0.2;
    const r = randRange(rng, 0.17, 0.24);
    b.addVaried(lumpyStone(r, i + seed), i % 2 ? STONE : STONE_DARK, composeMatrix(new THREE.Vector3(Math.cos(a) * 0.78, r * 0.45, Math.sin(a) * 0.78), new THREE.Euler(rng(), rng() * 3, 0), 1), 0.1, i);
  }
  // Charred teepee logs.
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const dir = new THREE.Vector3(-Math.cos(a) * 0.42, 0.9, -Math.sin(a) * 0.42).normalize();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    const m = new THREE.Matrix4().compose(new THREE.Vector3(Math.cos(a) * 0.26, 0.3, Math.sin(a) * 0.26), q, new THREE.Vector3(1, 1, 1));
    b.add(new THREE.CylinderGeometry(0.06, 0.08, 0.75, 5), i % 2 ? CHAR : BARK, m, true);
  }
  out.merge(b, base);

  // Seating logs and the workbench, arranged around the side away from the chest.
  const away = Math.atan2(fire.z - chest.z, fire.x - chest.x);
  const place = (angle: number, dist: number): THREE.Vector3 => {
    const x = fire.x + Math.cos(angle) * dist;
    const z = fire.z + Math.sin(angle) * dist;
    return new THREE.Vector3(x, ground(x, z), z);
  };
  for (const off of [-1.45, 1.45]) {
    const a = away + off;
    const p = place(a, 2.15);
    const m = composeMatrix(p, new THREE.Euler(0, -a + Math.PI / 2, 0), 1);
    const log = new Baker();
    log.addAt(new THREE.CylinderGeometry(0.2, 0.22, 1.4, 7), BARK, new THREE.Vector3(0, 0.2, 0), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
    log.addAt(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 7), CUT, new THREE.Vector3(0.71, 0.2, 0), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
    log.addAt(new THREE.CylinderGeometry(0.17, 0.17, 0.02, 7), CUT, new THREE.Vector3(-0.71, 0.2, 0), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
    out.merge(log, m);
  }
  {
    const p = place(away, 2.3);
    const m = composeMatrix(p, new THREE.Euler(0, -away + Math.PI / 2, 0), 1);
    const bench = new Baker();
    for (const sx of [-0.45, 0.45]) {
      bench.addAt(new THREE.CylinderGeometry(0.17, 0.2, 0.7, 7), BARK, new THREE.Vector3(sx, 0.35, 0), null, 1, true);
    }
    bench.addAt(new THREE.BoxGeometry(1.35, 0.08, 0.6), WOOD.light, new THREE.Vector3(0, 0.74, 0), new THREE.Euler(0, 0.04, 0), 1, true);
    bench.addAt(new THREE.BoxGeometry(1.35, 0.02, 0.04), WOOD.dark, new THREE.Vector3(0, 0.785, 0.1), null, 1, true);
    bench.addAt(new THREE.BoxGeometry(1.35, 0.02, 0.04), WOOD.dark, new THREE.Vector3(0, 0.785, -0.12), null, 1, true);
    bench.addAt(new THREE.TorusGeometry(0.13, 0.04, 4, 8), "#C9A15A", new THREE.Vector3(-0.35, 0.8, 0.05), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
    bench.addVaried(lumpyStone(0.12, 3), STONE, composeMatrix(new THREE.Vector3(0.3, 0.84, -0.05), null, 1), 0.1, 3);
    bench.addAt(new THREE.BoxGeometry(0.5, 0.06, 0.08), WOOD.mid, new THREE.Vector3(0.05, 0.81, 0.18), new THREE.Euler(0, 0.5, 0), 1, true);
    out.merge(bench, m);
  }
  // Spare firewood stack.
  {
    const p = place(away + Math.PI * 0.62, 1.7);
    const m = composeMatrix(p, new THREE.Euler(0, rng() * 3, 0), 1);
    const pile = new Baker();
    const rows: Array<[number, number]> = [
      [-0.16, 0.08],
      [0, 0.08],
      [0.16, 0.08],
      [-0.08, 0.22],
      [0.08, 0.22],
    ];
    for (const [x, y] of rows) {
      pile.addAt(new THREE.CylinderGeometry(0.075, 0.075, 0.7, 6), BARK, new THREE.Vector3(x, y, 0), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
    }
    out.merge(pile, m);
  }
}

/** The shared camp chest at `chest`, its front facing the fire. */
export function bakeCampChest(out: Baker, chest: XZ, fire: XZ, ground: WorldGround): void {
  const m = composeMatrix(new THREE.Vector3(chest.x, ground(chest.x, chest.z), chest.z), new THREE.Euler(0, yawToward(chest, fire), 0), 1);
  const b = new Baker();
  b.addAt(new THREE.BoxGeometry(1.0, 0.5, 0.62), WOOD.mid, new THREE.Vector3(0, 0.27, 0), null, 1, true);
  // Plank seams.
  for (const y of [0.17, 0.34]) b.addAt(new THREE.BoxGeometry(1.01, 0.02, 0.63), WOOD.dark, new THREE.Vector3(0, y, 0), null, 1, true);
  // Rounded lid.
  b.addAt(new THREE.CylinderGeometry(0.31, 0.31, 1.0, 8, 1, false, 0, Math.PI), WOOD.light, new THREE.Vector3(0, 0.52, 0), new THREE.Euler(0, 0, Math.PI / 2), new THREE.Vector3(0.72, 1, 1), true);
  // Metal bands and corners.
  for (const x of [-0.36, 0.36]) {
    b.addAt(new THREE.BoxGeometry(0.07, 0.52, 0.64), METAL, new THREE.Vector3(x, 0.27, 0), null, 1, true);
    b.addAt(new THREE.CylinderGeometry(0.315, 0.315, 0.07, 8, 1, false, 0, Math.PI), METAL, new THREE.Vector3(x, 0.52, 0), new THREE.Euler(0, 0, Math.PI / 2), new THREE.Vector3(0.74, 1, 1.02), true);
  }
  // Lock plate on the front (-Z).
  b.addAt(new THREE.BoxGeometry(0.16, 0.18, 0.04), GOLD, new THREE.Vector3(0, 0.48, -0.33), null, 1, true);
  b.addAt(new THREE.BoxGeometry(0.05, 0.06, 0.02), "#2D2A32", new THREE.Vector3(0, 0.46, -0.355), null, 1, true);
  out.merge(b, m);
}
