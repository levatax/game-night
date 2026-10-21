// Chunky 3D debris that tumbles, bounces once on the terrain and shrinks away: wood splinters, stone chips, crab
// shell bits, berries and puffer spikes. One instanced Pool per shape (5 draw calls total), toon-shaded with
// per-instance colors so it sits in the same flat cartoon world as the items. Owner: client-fx-audio.

import * as THREE from "three";
import type { Vec3Like } from "../../../shared/types";
import { createToonMaterial } from "../render/Toon";
import { Pool } from "./Pool";

export type ChunkKind = "splinter" | "chip" | "shell" | "berry" | "spike";

/** Ground height under (x, z) for bounces (fx supplies the island heightfield, else a flat plane). */
export type GroundFn = (x: number, z: number) => number;

const CAPS: Readonly<Record<ChunkKind, number>> = { splinter: 96, chip: 72, shell: 64, berry: 48, spike: 48 };
const GRAVITY = 17;
const RESTITUTION = 0.32;
const FRICTION = 0.55;
const SHRINK_SEC = 0.35;

function geometryFor(kind: ChunkKind): THREE.BufferGeometry {
  switch (kind) {
    case "splinter":
      return new THREE.BoxGeometry(1, 0.32, 0.32);
    case "chip":
      return new THREE.TetrahedronGeometry(0.7, 0);
    case "shell":
      return new THREE.SphereGeometry(0.6, 5, 3, 0, Math.PI * 2, 0, Math.PI / 2);
    case "berry":
      return new THREE.IcosahedronGeometry(0.55, 0);
    case "spike":
      return new THREE.ConeGeometry(0.35, 1, 4, 1);
  }
}

export interface ChunkBurst {
  count: number;
  /** One color or a palette (random pick per chunk). */
  colors: ReadonlyArray<string>;
  /** Chunk size (m). */
  size: number;
  speed: number;
  dir?: Vec3Like;
}

export class Chunks {
  private readonly root = new THREE.Group();
  private readonly pools: Record<ChunkKind, Pool>;
  private readonly materials: THREE.Material[] = [];
  private readonly geometries: THREE.BufferGeometry[] = [];
  private ground: GroundFn = () => 0;
  private quality = 1;
  private readonly kinds: ChunkKind[] = ["splinter", "chip", "shell", "berry", "spike"];

  constructor(parent: THREE.Object3D) {
    this.root.name = "fx-chunks";
    parent.add(this.root);
    const pools = {} as Record<ChunkKind, Pool>;
    for (const kind of this.kinds) {
      const geo = geometryFor(kind);
      const mat = createToonMaterial("#FFFFFF", { flatShading: true, side: kind === "shell" ? THREE.DoubleSide : THREE.FrontSide });
      this.geometries.push(geo);
      this.materials.push(mat);
      const pool = new Pool(this.root, geo, mat, CAPS[kind], `fx-chunks-${kind}`);
      pool.mesh.castShadow = false;
      pool.mesh.receiveShadow = false;
      pools[kind] = pool;
    }
    this.pools = pools;
  }

  setGround(fn: GroundFn | null): void {
    this.ground = fn ?? (() => 0);
  }

  setQualityScale(scale: number): void {
    this.quality = Math.min(1.5, Math.max(0.25, scale));
  }

  get count(): number {
    let n = 0;
    for (const kind of this.kinds) n += this.pools[kind].live;
    return n;
  }

  burst(kind: ChunkKind, pos: Vec3Like, b: ChunkBurst): void {
    const pool = this.pools[kind];
    const n = Math.max(0, Math.round(b.count * this.quality));
    const floor = this.ground(pos.x, pos.z);
    let dx = 0;
    let dz = 0;
    if (b.dir) {
      const len = Math.hypot(b.dir.x, b.dir.z);
      if (len > 1e-4) {
        dx = b.dir.x / len;
        dz = b.dir.z / len;
      }
    }
    for (let k = 0; k < n; k++) {
      const i = pool.alloc();
      const a = Math.random() * Math.PI * 2;
      const out = b.speed * (0.45 + Math.random() * 0.75);
      const s = b.size * (0.6 + Math.random() * 0.7);
      const sx = kind === "splinter" ? s * (1.2 + Math.random()) : s;
      pool.set(
        i,
        pos.x + (Math.random() - 0.5) * 0.15,
        pos.y + Math.random() * 0.15,
        pos.z + (Math.random() - 0.5) * 0.15,
        Math.cos(a) * out + dx * b.speed * 0.8,
        b.speed * (0.7 + Math.random() * 0.8),
        Math.sin(a) * out + dz * b.speed * 0.8,
        sx,
        s,
        s,
        1.1 + Math.random() * 0.7,
      );
      pool.spin(i, Math.random() * 6, Math.random() * 6, Math.random() * 6, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22, (Math.random() - 0.5) * 22);
      pool.aux[i * 4] = Math.min(floor, pos.y - 0.05);
      pool.aux[i * 4 + 1] = 0;
      pool.color(i, b.colors[Math.floor(Math.random() * b.colors.length)] ?? "#FFFFFF");
      pool.write(i, 1);
    }
    pool.flush();
  }

  update(dt: number): void {
    const step = Math.min(dt, 0.05);
    for (const kind of this.kinds) {
      const pool = this.pools[kind];
      if (pool.live === 0) {
        pool.flush();
        continue;
      }
      for (let i = 0; i < pool.cap; i++) {
        if (pool.state[i] === 0) continue;
        pool.life[i]! += step;
        if (pool.life[i]! >= pool.max[i]!) {
          pool.kill(i);
          continue;
        }
        if (pool.state[i] === 1) {
          pool.integrate(i, step, GRAVITY);
          const j = i * 3;
          const floor = pool.aux[i * 4]! + pool.s[j + 1]! * 0.3;
          if (pool.p[j + 1]! < floor && pool.v[j + 1]! < 0) {
            pool.p[j + 1] = floor;
            const bounces = pool.aux[i * 4 + 1]!;
            if (bounces >= 1 || -pool.v[j + 1]! < 1.5) {
              pool.state[i] = 2;
              pool.v[j] = pool.v[j + 1] = pool.v[j + 2] = 0;
              pool.w[j]! *= 0.1;
              pool.w[j + 1]! *= 0.1;
              pool.w[j + 2]! *= 0.1;
            } else {
              pool.v[j + 1] = -pool.v[j + 1]! * RESTITUTION;
              pool.v[j]! *= FRICTION;
              pool.v[j + 2]! *= FRICTION;
              pool.w[j]! *= 0.5;
              pool.w[j + 1]! *= 0.5;
              pool.w[j + 2]! *= 0.5;
              pool.aux[i * 4 + 1] = bounces + 1;
            }
          }
        }
        const left = pool.max[i]! - pool.life[i]!;
        const k = left < SHRINK_SEC ? Math.max(0.001, left / SHRINK_SEC) : Math.min(1, pool.life[i]! / 0.05 + 0.2);
        pool.write(i, k);
      }
      pool.flush();
    }
  }

  clear(): void {
    for (const kind of this.kinds) {
      this.pools[kind].clear();
      this.pools[kind].flush();
    }
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    for (const kind of this.kinds) this.pools[kind].mesh.dispose();
  }
}
