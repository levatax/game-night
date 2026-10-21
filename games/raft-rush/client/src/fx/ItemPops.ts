// "+1 🪵" item pops: a little copy of the gathered item (the real low-poly mesh, not an emoji) hops out of the
// node, spins up and shrinks away, with a "+N" pop word beside it. Owner: client-fx-audio.

import * as THREE from "three";
import type { ItemKind, Vec3Like } from "../../../shared/types";
import { buildBerryMesh, buildItemMesh, itemInfo } from "./itemMeshes";
import type { PopText } from "./PopText";

const MAX_POPS = 16;
const LIFE = 1.15;
const RISE = 0.95;
const POP_IN = 0.2;
const SHRINK = 0.3;
/** Every pop shows its item at about this radius (m), whatever the item's real size. */
const SHOW_RADIUS = 0.15;
const TEXT_OFFSET = 0.3;

type PopKind = ItemKind | "berry";

interface ItemPop {
  kind: PopKind;
  obj: THREE.Object3D;
  base: number;
  age: number;
  x: number;
  y: number;
  z: number;
  spin: number;
}

export class ItemPops {
  private readonly root = new THREE.Group();
  private readonly active: ItemPop[] = [];
  private readonly pool = new Map<PopKind, THREE.Object3D[]>();
  private readonly right = new THREE.Vector3();

  constructor(
    parent: THREE.Object3D,
    private readonly camera: THREE.Camera,
    private readonly text: PopText,
  ) {
    this.root.name = "fx-item-pops";
    parent.add(this.root);
  }

  get count(): number {
    return this.active.length;
  }

  show(kind: PopKind, count: number, pos: Vec3Like): void {
    if (this.active.length >= MAX_POPS) this.recycle(this.active.shift()!);
    const obj = this.take(kind);
    const radius = itemInfo(obj)?.radius ?? 0.2;
    const base = Math.min(1.2, Math.max(0.35, SHOW_RADIUS / radius));
    obj.scale.setScalar(0.001);
    obj.position.set(pos.x, pos.y, pos.z);
    this.root.add(obj);
    this.active.push({ kind, obj, base, age: 0, x: pos.x, y: pos.y, z: pos.z, spin: (Math.random() < 0.5 ? -1 : 1) * (3 + Math.random() * 2) });
    if (count !== 0) {
      this.camera.updateMatrixWorld();
      this.right.setFromMatrixColumn(this.camera.matrixWorld, 0).setY(0);
      if (this.right.lengthSq() < 1e-6) this.right.set(1, 0, 0);
      this.right.normalize().multiplyScalar(TEXT_OFFSET);
      const label = count > 0 ? `+${count}` : `${count}`;
      this.text.show(label, { x: pos.x + this.right.x, y: pos.y + 0.05, z: pos.z + this.right.z }, count > 0 ? "good" : "bad");
    }
  }

  update(dt: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i]!;
      p.age += dt;
      if (p.age >= LIFE) {
        this.active.splice(i, 1);
        this.recycle(p);
        continue;
      }
      const t = p.age;
      let s: number;
      if (t < POP_IN) {
        const k = t / POP_IN;
        s = k < 0.65 ? 1.25 * easeOut(k / 0.65) : 1.25 - 0.25 * ((k - 0.65) / 0.35);
      } else if (t > LIFE - SHRINK) {
        s = Math.max(0.001, (LIFE - t) / SHRINK);
      } else {
        s = 1;
      }
      // A little hop up and out, then a steady float.
      const hop = Math.sin(Math.min(1, t / 0.35) * Math.PI) * 0.12;
      p.obj.position.set(p.x, p.y + RISE * easeOut(t / LIFE) + hop, p.z);
      p.obj.rotation.set(0.25 * Math.sin(t * 5), t * p.spin, 0.2 * Math.sin(t * 4));
      p.obj.scale.setScalar(p.base * s);
    }
  }

  clear(): void {
    for (const p of this.active) this.recycle(p);
    this.active.length = 0;
  }

  dispose(): void {
    this.clear();
    this.pool.clear();
    this.root.removeFromParent();
  }

  private take(kind: PopKind): THREE.Object3D {
    const list = this.pool.get(kind);
    const obj = list?.pop() ?? (kind === "berry" ? buildBerryMesh() : buildItemMesh(kind));
    obj.traverse((o) => {
      o.castShadow = false;
    });
    obj.visible = true;
    return obj;
  }

  private recycle(p: ItemPop): void {
    p.obj.removeFromParent();
    let list = this.pool.get(p.kind);
    if (!list) {
      list = [];
      this.pool.set(p.kind, list);
    }
    if (list.length < 4) list.push(p.obj);
  }
}

function easeOut(x: number): number {
  const k = 1 - Math.min(1, Math.max(0, x));
  return 1 - k * k * k;
}
