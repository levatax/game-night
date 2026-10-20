// Character-local particles in five instanced pools (≈5 draw calls total): puffs (cigar smoke, steam, dust,
// poofs), drops (tears, drips, sweat, splash, bubbles), banknotes, hearts and moths. Fx owns the big
// table-wide effects; these are the small ones that belong to a character's animation. Owner:
// client-characters.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { canvasTexture, toon } from "../toon";
import { G } from "./kit";
import { clamp } from "./util";

interface Particle {
  alive: boolean;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size: number;
  grow: number;
  grav: number;
  drag: number;
  rot: THREE.Euler;
  spin: THREE.Vector3;
  color: THREE.Color;
  wander: number;
  home: THREE.Vector3;
  hasHome: boolean;
  homeK: number;
  seed: number;
  /** Quadratic arc a → c (control b) over `max` seconds instead of physics (when hasArc). */
  arc: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  hasArc: boolean;
}

type ScaleFn = (p: Particle, k: number, time: number, out: THREE.Vector3) => void;

class Pool {
  readonly mesh: THREE.InstancedMesh;
  private items: Particle[] = [];
  private next = 0;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();

  constructor(
    geo: THREE.BufferGeometry,
    material: THREE.Material,
    readonly cap: number,
    private scale: ScaleFn,
    colored: boolean,
  ) {
    this.mesh = new THREE.InstancedMesh(geo, material, cap);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.mesh.castShadow = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (colored) {
      const white = new THREE.Color(1, 1, 1);
      for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, white);
      this.mesh.instanceColor!.setUsage(THREE.DynamicDrawUsage);
    }
    for (let i = 0; i < cap; i++) {
      this.items.push({
        alive: false,
        pos: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        life: 0,
        max: 1,
        size: 1,
        grow: 1,
        grav: 0,
        drag: 0,
        rot: new THREE.Euler(),
        spin: new THREE.Vector3(),
        color: new THREE.Color(),
        wander: 0,
        home: new THREE.Vector3(),
        hasHome: false,
        homeK: 0,
        seed: 0,
        arc: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()],
        hasArc: false,
      });
    }
  }

  spawn(at: THREE.Vector3, vel: THREE.Vector3, life: number, size: number): Particle {
    // Round-robin: when full, recycle the oldest slot.
    let p = this.items[this.next]!;
    for (let i = 0; i < this.cap; i++) {
      const c = this.items[(this.next + i) % this.cap]!;
      if (!c.alive) {
        p = c;
        this.next = (this.next + i + 1) % this.cap;
        break;
      }
    }
    if (p.alive) this.next = (this.next + 1) % this.cap;
    p.alive = true;
    p.pos.copy(at);
    p.vel.copy(vel);
    p.life = 0;
    p.max = life;
    p.size = size;
    p.grow = 1;
    p.grav = 0;
    p.drag = 0;
    p.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
    p.spin.set(0, 0, 0);
    p.color.setRGB(1, 1, 1);
    p.wander = 0;
    p.hasHome = false;
    p.homeK = 0;
    p.seed = Math.random() * 100;
    p.hasArc = false;
    return p;
  }

  update(dt: number, time: number): void {
    let n = 0;
    const mesh = this.mesh;
    for (const p of this.items) {
      if (!p.alive) continue;
      p.life += dt;
      if (p.life >= p.max) {
        p.alive = false;
        continue;
      }
      const k = p.life / p.max;
      if (p.hasArc) {
        const [a, b, c] = p.arc;
        const t = k;
        const u = 1 - t;
        p.pos.set(u * u * a.x + 2 * u * t * b.x + t * t * c.x, u * u * a.y + 2 * u * t * b.y + t * t * c.y, u * u * a.z + 2 * u * t * b.z + t * t * c.z);
      } else {
        p.vel.y -= p.grav * dt;
        if (p.drag) p.vel.multiplyScalar(Math.exp(-p.drag * dt));
        if (p.wander) {
          p.vel.x += Math.sin(time * 7 + p.seed) * p.wander * dt;
          p.vel.z += Math.cos(time * 6 + p.seed * 1.3) * p.wander * dt;
          p.vel.y += Math.sin(time * 9 + p.seed * 0.7) * p.wander * 0.6 * dt;
        }
        if (p.hasHome) p.vel.lerp(this.s.subVectors(p.home, p.pos).multiplyScalar(2.2), clamp(p.homeK * dt, 0, 1));
        p.pos.addScaledVector(p.vel, dt);
        if (p.pos.y < 0.01 && p.grav > 0) {
          p.pos.y = 0.01;
          p.vel.set(p.vel.x * 0.3, Math.abs(p.vel.y) * 0.15, p.vel.z * 0.3);
        }
      }
      p.rot.x += p.spin.x * dt;
      p.rot.y += p.spin.y * dt;
      p.rot.z += p.spin.z * dt;
      this.q.setFromEuler(p.rot);
      this.scale(p, k, time, this.s);
      this.m.compose(p.pos, this.q, this.s);
      mesh.setMatrixAt(n, this.m);
      if (mesh.instanceColor) mesh.setColorAt(n, p.color);
      n++;
    }
    mesh.count = n;
    if (n > 0) {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
  }
}

const _v = new THREE.Vector3();

export class Particles {
  readonly group = new THREE.Group();
  private puffs: Pool;
  private drops: Pool;
  private bills: Pool;
  private hearts: Pool;
  private moths: Pool;

  constructor(parent: THREE.Object3D) {
    const g = G();
    this.group.name = "charParticles";
    parent.add(this.group);

    const puffMat = toon("#FFFFFF", { unique: true, transparent: true, opacity: 0.62 });
    puffMat.depthWrite = false;
    this.puffs = new Pool(new THREE.IcosahedronGeometry(1, 1), puffMat, 220, (p, k, _t, out) => {
      const s = p.size * (0.35 + (p.grow - 0.35) * Math.sqrt(k)) * (k > 0.75 ? 1 - (k - 0.75) / 0.25 : 1);
      out.setScalar(Math.max(0.0001, s));
    }, true);

    this.drops = new Pool(g.sphereLo, toon("#FFFFFF", { unique: true }), 260, (p, k, _t, out) => {
      const s = p.size * (k > 0.8 ? 1 - (k - 0.8) / 0.2 : 1);
      const stretch = p.hasArc ? 1 : 1 + Math.min(1.2, p.vel.length() * 0.12);
      out.set(s, s * stretch, s);
    }, true);

    const billTex = canvasTexture(64, 32, (ctx, w, h) => {
      ctx.fillStyle = PALETTE.money;
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = "#3E8E4E";
      ctx.lineWidth = 3;
      ctx.strokeRect(3, 3, w - 6, h - 6);
      ctx.fillStyle = "#3E8E4E";
      ctx.beginPath();
      ctx.arc(w / 2, h / 2, 9, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = PALETTE.money;
      ctx.font = "700 14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("$", w / 2, h / 2 + 1);
    });
    const billMat = toon("#FFFFFF", { map: billTex, side: THREE.DoubleSide });
    const billGeo = new THREE.PlaneGeometry(0.13, 0.065);
    billGeo.rotateX(-Math.PI / 2);
    this.bills = new Pool(billGeo, billMat, 140, (p, k, time, out) => {
      const flutter = 1 + Math.sin(time * 14 + p.seed) * 0.15;
      out.set(p.size * flutter, p.size, p.size * (k > 0.85 ? 1 - (k - 0.85) / 0.15 : 1));
    }, false);

    const heartMat = toon("#FF4F8B", { emissive: "#C8105A", emissiveIntensity: 0.45 });
    this.hearts = new Pool(g.heart, heartMat, 30, (p, k, time, out) => {
      const pulse = 1 + Math.sin(time * 16 + p.seed) * 0.12;
      const s = p.size * pulse * (k < 0.12 ? k / 0.12 : 1) * (k > 0.88 ? 1 - (k - 0.88) / 0.12 : 1);
      out.setScalar(Math.max(0.0001, s));
    }, false);

    const mothGeo = new THREE.BufferGeometry();
    mothGeo.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0.02, -0.06, 0.0, 0.03, -0.05, 0, -0.03, 0, 0, 0.02, 0.05, 0, -0.03, 0.06, 0.0, 0.03, 0, 0.005, 0.03, -0.006, 0.0, -0.025, 0.006, 0, -0.025], 3),
    );
    mothGeo.computeVertexNormals();
    const mothMat = toon("#9C8F7E", { side: THREE.DoubleSide });
    this.moths = new Pool(mothGeo, mothMat, 40, (p, _k, time, out) => {
      out.set(p.size * (0.25 + Math.abs(Math.sin(time * 38 + p.seed)) * 0.95), p.size, p.size);
    }, false);

    for (const pool of [this.puffs, this.drops, this.bills, this.hearts, this.moths]) {
      pool.mesh.renderOrder = 4;
      this.group.add(pool.mesh);
    }
  }

  /** Smoke / steam / dust puff. */
  puff(at: THREE.Vector3, vel: THREE.Vector3, size: number, color: THREE.ColorRepresentation, life = 1.4, grow = 2.4, drag = 1.2): void {
    const p = this.puffs.spawn(at, vel, life, size);
    p.grow = grow;
    p.drag = drag;
    p.color.set(color);
    p.spin.set(0.4, 0.8, 0.3);
  }

  /** Ring of puffs (poof!). */
  poof(at: THREE.Vector3, size = 0.12, color: THREE.ColorRepresentation = "#E9E4F0", count = 10): void {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      _v.set(Math.cos(a) * 1.4, 0.4 + Math.random() * 0.5, Math.sin(a) * 1.4);
      this.puff(at, _v, size * (0.8 + Math.random() * 0.5), color, 0.7, 1.8, 3.5);
    }
  }

  /** Tear / drip / sweat / splash drop with gravity. */
  drop(at: THREE.Vector3, vel: THREE.Vector3, size: number, color: THREE.ColorRepresentation, life = 0.9, grav = 9): void {
    const p = this.drops.spawn(at, vel, life, size);
    p.grav = grav;
    p.color.set(color);
  }

  /** Drop that flies along an arc (tear fountains into buckets). */
  dropArc(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, size: number, color: THREE.ColorRepresentation, life: number): void {
    const p = this.drops.spawn(a, _v.set(0, 0, 0), life, size);
    p.arc[0].copy(a);
    p.arc[1].copy(b);
    p.arc[2].copy(c);
    p.hasArc = true;
    p.color.set(color);
  }

  /** Little gold chip / coin hopping off the table (fist on the felt). */
  chip(at: THREE.Vector3, vel: THREE.Vector3, size = 0.022): void {
    const p = this.drops.spawn(at, vel, 0.75, size);
    p.grav = 7;
    p.color.set(PALETTE.gold);
  }

  /** Rising bubble. */
  bubble(at: THREE.Vector3, size = 0.025): void {
    const p = this.drops.spawn(at, _v.set((Math.random() - 0.5) * 0.2, 0.5 + Math.random() * 0.4, (Math.random() - 0.5) * 0.2), 1.0, size);
    p.color.set("#CDEBFF");
    p.wander = 1.5;
  }

  /** Banknote fluttering down. */
  bill(at: THREE.Vector3, vel: THREE.Vector3, life = 2.2): void {
    const p = this.bills.spawn(at, vel, life, 1);
    p.grav = 2.2;
    p.drag = 1.6;
    p.wander = 3;
    p.spin.set((Math.random() - 0.5) * 9, (Math.random() - 0.5) * 6, (Math.random() - 0.5) * 9);
  }

  /** Heart flying from a to c over an arc (öpücük). */
  heart(a: THREE.Vector3, c: THREE.Vector3, size: number, life: number, lift = 0.5): void {
    const p = this.hearts.spawn(a, _v.set(0, 0, 0), life, size);
    p.arc[0].copy(a);
    p.arc[1].copy(a).lerp(c, 0.5);
    p.arc[1].y += lift;
    p.arc[2].copy(c);
    p.hasArc = true;
    p.rot.set(0, 0, 0);
    p.spin.set(0, 2.5, 0);
  }

  /** Little hearts popping up and floating (blush). */
  floatHeart(at: THREE.Vector3, size = 0.05): void {
    const p = this.hearts.spawn(at, _v.set((Math.random() - 0.5) * 0.4, 0.7, (Math.random() - 0.5) * 0.4), 1.1, size);
    p.drag = 1;
    p.rot.set(0, 0, 0);
    p.spin.set(0, 3, 0);
  }

  /** Moth fluttering out (empty wallet); `home` makes it buzz toward a point. */
  moth(at: THREE.Vector3, home: THREE.Vector3 | null = null, life = 2.4): void {
    const p = this.moths.spawn(at, _v.set((Math.random() - 0.5) * 0.8, 0.8 + Math.random() * 0.6, (Math.random() - 0.5) * 0.8), life, 1);
    p.wander = 14;
    p.drag = 1.5;
    if (home) {
      p.home.copy(home);
      p.hasHome = true;
      p.homeK = 1.8;
    }
    p.rot.set(0, Math.random() * 6, 0);
    p.spin.set(0, (Math.random() - 0.5) * 8, 0);
  }

  update(dt: number, time: number): void {
    this.puffs.update(dt, time);
    this.drops.update(dt, time);
    this.bills.update(dt, time);
    this.hearts.update(dt, time);
    this.moths.update(dt, time);
  }
}
