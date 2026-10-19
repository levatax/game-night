// World-space chef effects: the cream pie that arcs across the kitchen into a chef's face, the cream
// splatter on impact and the pie tin that peels off and clatters to the floor. Owner: client-chefs.

import * as THREE from "three";
import { toon } from "../toon";
import type { Chef } from "./Chef";
import { buildFlyingPie, chefGeometry } from "./model";

interface FlyingPie {
  obj: THREE.Group;
  chef: Chef;
  from: THREE.Vector3;
  t: number;
  dur: number;
  arc: number;
  spin: number;
}

interface Debris {
  obj: THREE.Object3D;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  floorY: number;
  life: number;
}

interface Drop {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
}

const UP = new THREE.Vector3(0, 1, 0);
const tmp = new THREE.Vector3();
const tmp2 = new THREE.Vector3();
const prev = new THREE.Vector3();

export class PieFx {
  private pies: FlyingPie[] = [];
  private debris: Debris[] = [];
  private drops: Drop[] = [];

  constructor(private parent: THREE.Group) {}

  /** Lob a pie from `from` (world) into the chef's face; calls chef.splat() on impact. */
  throwPie(chef: Chef, from: THREE.Vector3): void {
    const obj = buildFlyingPie();
    this.parent.updateWorldMatrix(true, false);
    const local = this.parent.worldToLocal(from.clone());
    obj.position.copy(local);
    this.parent.add(obj);
    this.pies.push({ obj, chef, from: local, t: 0, dur: 0.5, arc: 0.3 + Math.random() * 0.2, spin: (Math.random() - 0.5) * 20 });
  }

  /** Let a pie tin fall from where it is now (keeps its world transform). */
  dropTin(tin: THREE.Object3D, vel: THREE.Vector3, floorY: number): void {
    this.parent.attach(tin);
    this.debris.push({
      obj: tin,
      vel: vel.clone(),
      spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 14),
      floorY,
      life: 2.6,
    });
  }

  /** Cream droplets bursting out of an impact point, mostly back along -dir. */
  splatter(at: THREE.Vector3, dir: THREE.Vector3, count = 16): void {
    const G = chefGeometry();
    for (let i = 0; i < count; i++) {
      let d = this.drops.find((x) => x.life <= 0);
      if (!d) {
        const mesh = new THREE.Mesh(G.smallSphere, toon(i % 3 === 0 ? "#FFF4E2" : "#FFFFFF"));
        this.parent.add(mesh);
        d = { mesh, vel: new THREE.Vector3(), life: 0, max: 1, size: 0.03 };
        this.drops.push(d);
      }
      d.mesh.visible = true;
      d.mesh.position.copy(at);
      tmp.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize();
      d.vel.copy(dir).multiplyScalar(-0.8).addScaledVector(tmp, 1.4 + Math.random() * 1.2);
      d.vel.y += 0.8;
      d.max = d.life = 0.55 + Math.random() * 0.4;
      d.size = 0.018 + Math.random() * 0.03;
    }
  }

  /** Forget pies aimed at a chef that's leaving. */
  cancelFor(chef: Chef): void {
    this.pies = this.pies.filter((p) => {
      if (p.chef !== chef) return true;
      this.disposeObj(p.obj);
      return false;
    });
  }

  update(dt: number): void {
    this.parent.updateWorldMatrix(true, false);
    // Flying pies: lerp toward the (moving) face with a parabolic arc, cream side leading.
    for (let i = this.pies.length - 1; i >= 0; i--) {
      const p = this.pies[i]!;
      p.t += dt;
      const u = Math.min(1, p.t / p.dur);
      const end = this.parent.worldToLocal(p.chef.facePoint(tmp2));
      prev.copy(p.obj.position);
      p.obj.position.lerpVectors(p.from, end, u);
      p.obj.position.y += p.arc * 4 * u * (1 - u);
      tmp.subVectors(p.obj.position, prev);
      if (tmp.lengthSq() > 1e-8) {
        p.obj.quaternion.setFromUnitVectors(UP, tmp.normalize());
        p.obj.rotateY(p.t * p.spin);
      }
      const s = 0.9 + 0.25 * Math.sin(u * Math.PI); // gets bigger mid-air (closer to camera feel)
      p.obj.scale.set(s, s * (1 - 0.15 * Math.sin(p.t * 30)), s);
      if (u >= 1) {
        tmp.subVectors(end, p.from).normalize();
        p.chef.splat();
        this.splatter(end, tmp);
        this.disposeObj(p.obj);
        this.pies.splice(i, 1);
      }
    }

    // Falling tins: gravity, tumble, a couple of clanky bounces, then shrink away.
    for (let i = this.debris.length - 1; i >= 0; i--) {
      const d = this.debris[i]!;
      d.life -= dt;
      d.vel.y -= 9.8 * dt;
      d.obj.position.addScaledVector(d.vel, dt);
      d.obj.rotation.x += d.spin.x * dt;
      d.obj.rotation.y += d.spin.y * dt;
      d.obj.rotation.z += d.spin.z * dt;
      if (d.obj.position.y < d.floorY) {
        d.obj.position.y = d.floorY;
        d.vel.y = Math.abs(d.vel.y) * 0.4;
        d.vel.x *= 0.6;
        d.vel.z *= 0.6;
        d.spin.multiplyScalar(0.6);
      }
      if (d.life < 0.4) d.obj.scale.setScalar(Math.max(0.001, d.life / 0.4));
      if (d.life <= 0) {
        this.disposeObj(d.obj);
        this.debris.splice(i, 1);
      }
    }

    for (const d of this.drops) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vel.y -= 7 * dt;
      d.mesh.position.addScaledVector(d.vel, dt);
      const k = Math.min(1, (d.life / d.max) * 2.5);
      d.mesh.scale.set(d.size * k, d.size * k * 0.8, d.size * k);
      if (d.life <= 0) d.mesh.visible = false;
    }
  }

  dispose(): void {
    for (const p of this.pies) this.disposeObj(p.obj);
    for (const d of this.debris) this.disposeObj(d.obj);
    for (const d of this.drops) d.mesh.removeFromParent();
    this.pies = [];
    this.debris = [];
    this.drops = [];
  }

  private disposeObj(o: THREE.Object3D): void {
    o.removeFromParent();
    (o.userData.dispose as (() => void) | undefined)?.();
  }
}
