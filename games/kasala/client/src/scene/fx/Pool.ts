// Fixed-capacity instanced particle pool (one InstancedMesh, struct-of-arrays state, no per-frame
// allocations). Callers drive the behaviour; the pool stores, integrates and writes matrices. When full, the
// oldest slot is recycled. Owner: client-cards-fx.

import * as THREE from "three";

const _obj = new THREE.Object3D();
const _hidden = new THREE.Matrix4().makeScale(0, 0, 0);
const _color = new THREE.Color();

export class Pool {
  readonly mesh: THREE.InstancedMesh;
  readonly cap: number;
  /** Position xyz. */
  readonly p: Float32Array;
  /** Velocity xyz. */
  readonly v: Float32Array;
  /** Euler rotation xyz. */
  readonly r: Float32Array;
  /** Angular velocity xyz. */
  readonly w: Float32Array;
  /** Base scale xyz. */
  readonly s: Float32Array;
  /** Generic per-particle scratch (targets, delays…), 4 floats each. */
  readonly aux: Float32Array;
  readonly life: Float32Array;
  readonly max: Float32Array;
  readonly phase: Float32Array;
  /** 0 dead, 1+ alive (meaning per pool: flying, landed…). */
  readonly state: Uint8Array;
  live = 0;
  private cursor = 0;
  private dirty = false;
  private colorDirty = false;

  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, mat: THREE.Material | THREE.Material[], cap: number, name: string) {
    this.cap = cap;
    this.mesh = new THREE.InstancedMesh(geo, mat, cap);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.name = name;
    this.mesh.raycast = () => {};
    for (let i = 0; i < cap; i++) {
      this.mesh.setMatrixAt(i, _hidden);
      this.mesh.setColorAt(i, _color.set(0xffffff));
    }
    this.p = new Float32Array(cap * 3);
    this.v = new Float32Array(cap * 3);
    this.r = new Float32Array(cap * 3);
    this.w = new Float32Array(cap * 3);
    this.s = new Float32Array(cap * 3);
    this.aux = new Float32Array(cap * 4);
    this.life = new Float32Array(cap);
    this.max = new Float32Array(cap);
    this.phase = new Float32Array(cap);
    this.state = new Uint8Array(cap);
    parent.add(this.mesh);
  }

  /** A free slot (or the oldest one, recycled). The slot starts in state 1 with life 0. */
  alloc(): number {
    for (let k = 0; k < this.cap; k++) {
      const i = (this.cursor + k) % this.cap;
      if (this.state[i] === 0) {
        this.cursor = (i + 1) % this.cap;
        this.live++;
        this.state[i] = 1;
        this.life[i] = 0;
        return i;
      }
    }
    const i = this.cursor;
    this.cursor = (i + 1) % this.cap;
    this.state[i] = 1;
    this.life[i] = 0;
    return i;
  }

  set(i: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number, sx: number, sy: number, sz: number, max: number): void {
    const j = i * 3;
    this.p[j] = px;
    this.p[j + 1] = py;
    this.p[j + 2] = pz;
    this.v[j] = vx;
    this.v[j + 1] = vy;
    this.v[j + 2] = vz;
    this.s[j] = sx;
    this.s[j + 1] = sy;
    this.s[j + 2] = sz;
    this.r[j] = 0;
    this.r[j + 1] = 0;
    this.r[j + 2] = 0;
    this.w[j] = 0;
    this.w[j + 1] = 0;
    this.w[j + 2] = 0;
    this.max[i] = max;
    this.phase[i] = Math.random() * Math.PI * 2;
    const a = i * 4;
    this.aux[a] = 0;
    this.aux[a + 1] = 0;
    this.aux[a + 2] = 0;
    this.aux[a + 3] = 0;
  }

  spin(i: number, rx: number, ry: number, rz: number, wx: number, wy: number, wz: number): void {
    const j = i * 3;
    this.r[j] = rx;
    this.r[j + 1] = ry;
    this.r[j + 2] = rz;
    this.w[j] = wx;
    this.w[j + 1] = wy;
    this.w[j + 2] = wz;
  }

  color(i: number, c: THREE.ColorRepresentation): void {
    this.mesh.setColorAt(i, _color.set(c));
    this.colorDirty = true;
  }

  kill(i: number): void {
    if (this.state[i] === 0) return;
    this.state[i] = 0;
    this.live--;
    this.mesh.setMatrixAt(i, _hidden);
    this.dirty = true;
  }

  clear(): void {
    for (let i = 0; i < this.cap; i++) if (this.state[i] !== 0) this.kill(i);
  }

  /** Writes instance i with its stored pose, scale multiplied by k (and per-axis kx/ky/kz). */
  write(i: number, k: number, kx = 1, ky = 1, kz = 1): void {
    const j = i * 3;
    _obj.position.set(this.p[j]!, this.p[j + 1]!, this.p[j + 2]!);
    _obj.rotation.set(this.r[j]!, this.r[j + 1]!, this.r[j + 2]!);
    _obj.scale.set(
      Math.max(1e-5, this.s[j]! * k * kx),
      Math.max(1e-5, this.s[j + 1]! * k * ky),
      Math.max(1e-5, this.s[j + 2]! * k * kz),
    );
    _obj.updateMatrix();
    this.mesh.setMatrixAt(i, _obj.matrix);
    this.dirty = true;
  }

  /** Integrates position (with gravity) and rotation of slot i. */
  integrate(i: number, dt: number, gravity: number): void {
    const j = i * 3;
    this.v[j + 1] -= gravity * dt;
    this.p[j] += this.v[j]! * dt;
    this.p[j + 1] += this.v[j + 1]! * dt;
    this.p[j + 2] += this.v[j + 2]! * dt;
    this.r[j] += this.w[j]! * dt;
    this.r[j + 1] += this.w[j + 1]! * dt;
    this.r[j + 2] += this.w[j + 2]! * dt;
  }

  flush(): void {
    if (this.dirty) this.mesh.instanceMatrix.needsUpdate = true;
    if (this.colorDirty && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.dirty = false;
    this.colorDirty = false;
    this.mesh.visible = this.live > 0;
  }
}
