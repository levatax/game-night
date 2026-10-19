// Fog card: thick kitchen steam. One Points cloud of soft puffs swirling up around the table (positions
// updated in place, no allocations) + the scene fog density, both faded by `amount` (0..1).

import * as THREE from "three";
import { softDotTexture } from "./textures";

export class Steam {
  readonly points: THREE.Points;
  private mat: THREE.PointsMaterial;
  private seeds: Float32Array;
  private pos: Float32Array;
  private count: number;
  amount = 0;

  /** `count` = max puffs (see setCount). */
  constructor(count: number) {
    this.count = count;
    this.pos = new Float32Array(count * 3);
    this.seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.seeds[i * 3] = Math.random() * Math.PI * 2; // angle
      this.seeds[i * 3 + 1] = 0.3 + Math.sqrt(Math.random()) * 1.7; // radius
      this.seeds[i * 3 + 2] = Math.random(); // phase
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1, 0), 4);
    this.mat = new THREE.PointsMaterial({
      map: softDotTexture(),
      color: "#EDE6FF",
      size: 0.9,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      fog: false,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 10;
    this.points.visible = false;
  }

  /** Visible puff count (quality); never more than the constructor's max. */
  setCount(n: number): void {
    this.points.geometry.setDrawRange(0, Math.max(0, Math.min(this.count, n)));
  }

  update(time: number, centerY: number): void {
    this.mat.opacity = this.amount * 0.5;
    this.points.visible = this.amount > 0.01;
    if (!this.points.visible) return;
    for (let i = 0; i < this.count; i++) {
      const a0 = this.seeds[i * 3]!;
      const r = this.seeds[i * 3 + 1]!;
      const ph = this.seeds[i * 3 + 2]!;
      const life = (time * 0.12 + ph) % 1;
      const a = a0 + time * 0.25 + life * 1.5;
      this.pos[i * 3] = Math.cos(a) * r;
      this.pos[i * 3 + 1] = centerY - 0.6 + life * 1.8;
      this.pos[i * 3 + 2] = Math.sin(a) * r;
    }
    (this.points.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
  }
}
