// Tiny non-indexed triangle soup builder: flat-shaded low-poly faces with per-face colors.
// Each triangle is oriented so its normal faces a given hint direction, which keeps the
// winding right no matter which order the caller lists the corners in.

import * as THREE from "three";

export interface P3 {
  x: number;
  y: number;
  z: number;
}

const tmpA = new THREE.Vector3();
const tmpB = new THREE.Vector3();
const tmpN = new THREE.Vector3();
const linear = new THREE.Color();

export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly colors: number[] = [];
  private readonly uvs: number[] = [];
  private readonly groups: Array<{ start: number; count: number; materialIndex: number }> = [];
  private groupStart = 0;
  private groupMaterial = 0;
  /** UV generator for subsequent triangles (default: world xz / uvScale). */
  uvScale = 1;

  /** Start a new material group; following triangles use materials[index]. */
  group(materialIndex: number): void {
    this.closeGroup();
    this.groupMaterial = materialIndex;
  }

  /** Triangle with a flat color, flipped if needed so its normal points along `hint`. */
  tri(a: P3, b: P3, c: P3, color: string | THREE.Color, hint: P3): void {
    tmpA.set(b.x - a.x, b.y - a.y, b.z - a.z);
    tmpB.set(c.x - a.x, c.y - a.y, c.z - a.z);
    tmpN.crossVectors(tmpA, tmpB);
    if (tmpN.lengthSq() < 1e-12) return;
    const flip = tmpN.x * hint.x + tmpN.y * hint.y + tmpN.z * hint.z < 0;
    const col = typeof color === "string" ? linear.set(color) : color;
    for (const p of flip ? [a, c, b] : [a, b, c]) {
      this.positions.push(p.x, p.y, p.z);
      this.colors.push(col.r, col.g, col.b);
      this.uvs.push(p.x / this.uvScale, -p.z / this.uvScale);
    }
  }

  /** Quad a-b-c-d (in order around its edge) as two triangles. */
  quad(a: P3, b: P3, c: P3, d: P3, color: string | THREE.Color, hint: P3): void {
    this.tri(a, b, c, color, hint);
    this.tri(a, c, d, color, hint);
  }

  get empty(): boolean {
    return this.positions.length === 0;
  }

  /** Build the geometry, optionally re-centered by subtracting `origin`. */
  build(origin: P3 = { x: 0, y: 0, z: 0 }): THREE.BufferGeometry {
    this.closeGroup();
    const pos = new Float32Array(this.positions.length);
    for (let i = 0; i < pos.length; i += 3) {
      pos[i] = this.positions[i] - origin.x;
      pos[i + 1] = this.positions[i + 1] - origin.y;
      pos[i + 2] = this.positions[i + 2] - origin.z;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setAttribute("color", new THREE.Float32BufferAttribute(this.colors, 3));
    geometry.setAttribute("uv", new THREE.Float32BufferAttribute(this.uvs, 2));
    for (const g of this.groups) geometry.addGroup(g.start, g.count, g.materialIndex);
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  private closeGroup(): void {
    const end = this.positions.length / 3;
    if (end > this.groupStart) {
      this.groups.push({ start: this.groupStart, count: end - this.groupStart, materialIndex: this.groupMaterial });
    }
    this.groupStart = end;
  }
}
