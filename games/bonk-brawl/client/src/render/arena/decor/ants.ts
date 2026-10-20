// Marching ants (picnic): a line of ants carrying crumbs from a dropped cookie at (x, z) to their
// anthill at `to`, looping forever. One InstancedMesh. Ants ride their ring segment when it shakes
// or falls and vanish once it is gone.

import * as THREE from "three";
import type { DecorItem } from "../../../../../shared/maps";
import { Baker, composeMatrix } from "../Baker";
import type { Animated, ArenaKit } from "../kit";

const INK = "#2D2A32";
const ANT_SPEED = 0.55;
const ANT_SPACING = 0.42;
/** Ants leave from the cookie's rim and disappear into the anthill's mouth. */
const COOKIE_CLEARANCE = 0.5;
const HILL_CLEARANCE = 0.3;

export function buildAnts(kit: ArenaKit, item: DecorItem): void {
  const to = item.to ?? { x: item.x + 3, z: item.z };
  bakeCookie(kit, item.x, item.z);
  bakeAnthill(kit, to.x, to.z);
  kit.animate(new AntLine(kit, { x: item.x, z: item.z }, to, item.scale));
}

class AntLine implements Animated {
  private readonly mesh: THREE.InstancedMesh;
  private readonly count: number;
  private readonly length: number;
  private readonly dir: THREE.Vector2;
  private readonly start: { x: number; z: number };
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();
  private readonly euler = new THREE.Euler();
  private readonly hidden = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(
    private readonly kit: ArenaKit,
    from: { x: number; z: number },
    to: { x: number; z: number },
    private readonly scale: number,
  ) {
    this.dir = new THREE.Vector2(to.x - from.x, to.z - from.z);
    const full = this.dir.length();
    this.dir.normalize();
    this.start = { x: from.x + this.dir.x * COOKIE_CLEARANCE, z: from.z + this.dir.y * COOKIE_CLEARANCE };
    this.length = Math.max(0.5, full - COOKIE_CLEARANCE - HILL_CLEARANCE);
    this.count = Math.max(4, Math.floor(this.length / ANT_SPACING));
    const geometry = kit.bank.geo(antGeometry());
    this.mesh = new THREE.InstancedMesh(geometry, kit.bakedMaterial(), this.count);
    this.mesh.name = "ants";
    this.mesh.frustumCulled = false;
    this.mesh.receiveShadow = true;
    kit.backdrop.add(this.mesh);
  }

  update(_dt: number, elapsed: number): void {
    const yaw = Math.atan2(this.dir.x, this.dir.y);
    for (let i = 0; i < this.count; i++) {
      const s = (((i * this.length) / this.count + elapsed * ANT_SPEED) % this.length + this.length) % this.length;
      const side = Math.sin(s * 3.1 + i * 1.7) * 0.09;
      const x = this.start.x + this.dir.x * s - this.dir.y * side;
      const z = this.start.z + this.dir.y * s + this.dir.x * side;
      const segment = this.kit.floor.segmentAt(x, z);
      if (segment && segment.status === "gone") {
        this.mesh.setMatrixAt(i, this.hidden);
        continue;
      }
      const drop = segment ? segment.object.position.y - segment.centroid.y : 0;
      const bob = Math.abs(Math.sin(elapsed * 14 + i * 2.3)) * 0.018;
      this.pos.set(x, drop + bob, z);
      this.euler.set(0, yaw + Math.cos(s * 3.1 + i * 1.7) * 0.25, Math.sin(elapsed * 14 + i) * 0.06);
      composeMatrix(this.pos, this.euler, this.scale, this.matrix);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

/** ~0.2 m cartoon ant (3 body beads, legs, antennae) facing +Z, holding a sugar crumb overhead. */
function antGeometry(): THREE.BufferGeometry {
  const b = new Baker();
  const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  b.addAt(new THREE.SphereGeometry(0.035, 8, 6), INK, v(0, 0.05, -0.06), null, v(1, 0.9, 1.3));
  b.addAt(new THREE.SphereGeometry(0.025, 8, 6), INK, v(0, 0.05, 0));
  b.addAt(new THREE.SphereGeometry(0.03, 8, 6), INK, v(0, 0.06, 0.05));
  for (const side of [-1, 1]) {
    for (let k = -1; k <= 1; k++) {
      b.addAt(new THREE.CylinderGeometry(0.005, 0.005, 0.09, 3), INK, v(side * 0.035, 0.025, k * 0.025), new THREE.Euler(0, 0, side * 1.0), 1, true);
    }
    b.addAt(new THREE.CylinderGeometry(0.004, 0.004, 0.07, 3), INK, v(side * 0.018, 0.1, 0.08), new THREE.Euler(0.8, 0, side * 0.5), 1, true);
  }
  b.addAt(new THREE.BoxGeometry(0.06, 0.05, 0.06), "#FFF1C9", v(0, 0.12, 0.01), new THREE.Euler(0.3, 0.5, 0.2), 1, true);
  return b.build();
}

function bakeCookie(kit: ArenaKit, x: number, z: number): void {
  const b = new Baker();
  const v = (px: number, py: number, pz: number) => new THREE.Vector3(px, py, pz);
  b.addAt(new THREE.CylinderGeometry(0.42, 0.44, 0.09, 16), "#D9A066", v(0, 0.045, 0), null, 1, true);
  const chips: Array<[number, number]> = [
    [0.15, 0.1],
    [-0.18, 0.12],
    [0.02, -0.2],
    [-0.12, -0.08],
    [0.22, -0.12],
  ];
  for (const [cx, cz] of chips) b.addAt(new THREE.DodecahedronGeometry(0.05), "#5A3825", v(cx, 0.095, cz), null, 1, true);
  for (let i = 0; i < 6; i++) {
    const a = i * 1.1;
    b.addAt(new THREE.BoxGeometry(0.05, 0.04, 0.05), "#E3B37A", v(Math.cos(a) * 0.55, 0.02, Math.sin(a) * 0.55), new THREE.Euler(0, a, 0.3), 1, true);
  }
  kit.bakerAt(x, z).merge(b, composeMatrix(v(x, 0, z)));
}

function bakeAnthill(kit: ArenaKit, x: number, z: number): void {
  const b = new Baker();
  const v = (px: number, py: number, pz: number) => new THREE.Vector3(px, py, pz);
  b.addAt(new THREE.ConeGeometry(0.55, 0.38, 9, 2), "#B07A4E", v(0, 0.19, 0), null, 1, true);
  b.addAt(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 8), "#3B2A22", v(0, 0.36, 0), null, 1, true);
  for (let i = 0; i < 7; i++) {
    const a = i * 0.9;
    b.addAt(new THREE.DodecahedronGeometry(0.06), "#9C6A42", v(Math.cos(a) * 0.62, 0.03, Math.sin(a) * 0.62), null, 1, true);
  }
  kit.bakerAt(x, z).merge(b, composeMatrix(v(x, 0, z)));
}
