// Slow cigar-smoke sheets under the low ceiling: wide wispy planes that turn to face the camera around y
// (cylindrical billboards), drift sideways (UV scroll), bob and breathe. One shared texture per layer,
// unlit, tinted by the room mood (warm lamp, red siren, near black when the lights go out).
// Overdraw budget: the sheets hang high (y ≥ 2.6) and mostly behind the table, the list is ordered by
// importance so quality tiers just take the first 2 / 4 / 6, a sheet closer than ~2.6 m to the camera fades
// out (never a grey veil in the face), and in first person only the back-wall sheets stay.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { smokeTexture } from "./textures";

interface Sheet {
  mesh: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  base: THREE.Vector3;
  speed: number;
  phase: number;
  alpha: number;
  /** Stays in first person (behind the table, against the back wall). */
  back: boolean;
}

/** x, y, z, width, height, alpha — most important first (low quality keeps the first two). */
const LAYOUT: [x: number, y: number, z: number, w: number, h: number, alpha: number][] = [
  [-0.6, 2.95, -2.6, 6.5, 1.1, 0.5],
  [1.2, 2.75, -1.7, 5.2, 0.95, 0.5],
  [-1.4, 2.7, -1.1, 4.6, 0.85, 0.45],
  [0.6, 3.0, 0.4, 5.6, 0.9, 0.35],
  [0.3, 2.65, -2.2, 4.2, 0.7, 0.4],
  [-1.8, 3.02, 1.8, 4.8, 0.85, 0.3],
];

/** First person keeps sheets whose base is behind this z (the back half of the room). */
const BACK_Z = -0.8;

export class Smoke {
  readonly group = new THREE.Group();
  private sheets: Sheet[] = [];
  private tint = new THREE.Color(PALETTE.smoke);
  private visibleCount = LAYOUT.length;
  /** Overall opacity multiplier (moods). */
  amount = 1;

  constructor() {
    this.group.name = "smoke";
    const textures = [smokeTexture(101), smokeTexture(202), smokeTexture(303)];
    LAYOUT.forEach(([x, y, z, w, h, alpha], i) => {
      const map = textures[i % textures.length]!.clone();
      map.needsUpdate = true;
      map.repeat.set(1.2 + (i % 3) * 0.3, 1);
      const mat = new THREE.MeshBasicMaterial({
        map,
        color: this.tint,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        side: THREE.DoubleSide,
        fog: false,
      });
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
      mesh.position.set(x, y, z);
      mesh.renderOrder = 8;
      mesh.raycast = () => {};
      this.group.add(mesh);
      this.sheets.push({ mesh, mat, base: new THREE.Vector3(x, y, z), speed: (i % 2 ? -1 : 1) * (0.006 + (i % 4) * 0.003), phase: i * 1.7, alpha, back: z < BACK_Z });
    });
  }

  /** Quality: how many sheets are drawn (2 / 4 / 6). */
  setCount(n: number): void {
    this.visibleCount = Math.max(0, Math.min(this.sheets.length, n));
    this.sheets.forEach((s, i) => (s.mesh.visible = i < this.visibleCount));
  }

  /** Mood tint (already multiplied by brightness). */
  setTint(c: THREE.Color): void {
    this.tint.copy(c);
  }

  /** `firstPerson` 0..1: how far the camera is into the seated first-person view. */
  update(_dt: number, time: number, camera: THREE.Camera, firstPerson = 0): void {
    for (let i = 0; i < this.visibleCount; i++) {
      const s = this.sheets[i]!;
      const m = s.mesh;
      m.position.set(s.base.x + Math.sin(time * 0.05 + s.phase) * 0.4, s.base.y + Math.sin(time * 0.17 + s.phase) * 0.06, s.base.z + Math.cos(time * 0.07 + s.phase) * 0.25);
      // fade sheets that get close to the camera (no grey wall in the face) and, in first person, the ones
      // that are not against the back wall
      const d = m.position.distanceTo(camera.position);
      const near = THREE.MathUtils.smoothstep(d, 2.3, 3.4);
      const fp = s.back ? 1 : 1 - firstPerson;
      const opacity = s.alpha * (0.75 + Math.sin(time * 0.21 + s.phase) * 0.25) * this.amount * near * fp;
      m.visible = opacity > 0.004;
      if (!m.visible) continue;
      s.mat.opacity = opacity;
      s.mat.color.copy(this.tint);
      // cylindrical billboard: rotate around y toward the camera, then a slight lean
      m.rotation.set(0, Math.atan2(camera.position.x - m.position.x, camera.position.z - m.position.z), Math.sin(time * 0.09 + s.phase) * 0.03);
      const map = s.mat.map!;
      map.offset.x = (time * s.speed) % 1;
    }
  }
}
