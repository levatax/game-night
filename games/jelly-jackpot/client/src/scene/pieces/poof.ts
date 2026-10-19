// Cartoon "poof" when a piece leaves the tower: white cloud puffs + a few bits in the piece's color.
// Pooled meshes on shared geometry / materials; no allocations after construction.

import * as THREE from "three";
import { G, M } from "./kit";

interface Puff {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
}

const POOL = 60;

export class Poofs {
  private readonly group = new THREE.Group();
  private readonly puffs: Puff[] = [];
  private next = 0;

  constructor(parent: THREE.Object3D) {
    this.group.name = "poofs";
    parent.add(this.group);
    const geo = G.sphere(1, 10, 8);
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(geo, M("#FFFFFF"));
      mesh.visible = false;
      mesh.raycast = () => {};
      this.group.add(mesh);
      this.puffs.push({ mesh, vel: new THREE.Vector3(), life: 0, max: 1, size: 0.02 });
    }
  }

  /** Burst at a stand-local position; `radius` ≈ the piece size; `color` tints the debris bits. */
  spawn(pos: THREE.Vector3, radius: number, color: string): void {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const p = this.puffs[this.next];
      this.next = (this.next + 1) % POOL;
      const bit = i >= 7;
      p.mesh.material = M(bit ? color : "#FFFFFF");
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const up = bit ? 0.9 + Math.random() * 0.6 : 0.15 + Math.random() * 0.3;
      const out = bit ? 0.5 + Math.random() * 0.4 : 0.35 + Math.random() * 0.3;
      p.vel.set(Math.cos(a) * out, up, Math.sin(a) * out);
      p.mesh.position.copy(pos);
      p.mesh.position.x += Math.cos(a) * radius * 0.4;
      p.mesh.position.z += Math.sin(a) * radius * 0.4;
      p.size = bit ? radius * 0.12 + 0.006 : radius * 0.35 + 0.015;
      p.life = 0;
      p.max = bit ? 0.7 : 0.45 + Math.random() * 0.15;
      p.mesh.visible = true;
      p.mesh.scale.setScalar(0.001);
    }
  }

  update(dt: number): void {
    for (const p of this.puffs) {
      if (!p.mesh.visible) continue;
      p.life += dt;
      const u = p.life / p.max;
      if (u >= 1) {
        p.mesh.visible = false;
        continue;
      }
      p.mesh.position.addScaledVector(p.vel, dt);
      p.vel.y -= (p.size < 0.02 ? 4 : 0.4) * dt;
      p.vel.multiplyScalar(Math.max(0, 1 - 2.5 * dt));
      // Pop up fast, shrink away.
      const s = u < 0.2 ? u / 0.2 : 1 - (u - 0.2) / 0.8;
      p.mesh.scale.setScalar(Math.max(0.001, p.size * (0.3 + 0.9 * s)));
    }
  }

  clear(): void {
    for (const p of this.puffs) p.mesh.visible = false;
  }
}
