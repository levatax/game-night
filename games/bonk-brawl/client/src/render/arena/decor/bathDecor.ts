// Bath Time animated decor: bubbles rising from the foam piles, the dripping faucet and the
// floating towel rack.

import * as THREE from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { DecorItem } from "../../../../../shared/maps";
import type { Quality } from "../../../app/settings";
import { createBubbleMaterial } from "../../bubbleMaterial";
import { createRng, wobble } from "../../noise";
import { Baker, composeMatrix } from "../Baker";
import { qualityScale, type Animated, type ArenaKit } from "../kit";

const v3 = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const BUBBLES_PER_SOURCE = 7;
const CHROME = "#DCE6EE";
const CHROME_DARK = "#A9B9C6";

/* ========================================================== rising bubbles */

interface Bubble {
  source: number;
  x: number;
  z: number;
  y: number;
  speed: number;
  size: number;
  age: number;
  life: number;
  phase: number;
}

/**
 * Soap bubbles drifting up from every foam pile. One InstancedMesh for all piles; a pile on a
 * ring that is no longer solid stops emitting.
 */
export class BubbleRisers implements Animated {
  private readonly mesh: THREE.InstancedMesh;
  private readonly bubbles: Bubble[] = [];
  private readonly rng = createRng(77);
  private readonly matrix = new THREE.Matrix4();
  private readonly pos = new THREE.Vector3();

  constructor(
    private readonly kit: ArenaKit,
    private readonly sources: ReadonlyArray<DecorItem>,
  ) {
    const count = BUBBLES_PER_SOURCE * sources.length;
    const material = kit.bank.own(createBubbleMaterial("#F3FBFF", 0.85));
    this.mesh = new THREE.InstancedMesh(kit.bank.geo(new THREE.SphereGeometry(1, 16, 12)), material, count);
    this.mesh.name = "risingBubbles";
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;
    kit.backdrop.add(this.mesh);
    for (let i = 0; i < count; i++) {
      const b = this.spawn(i % sources.length);
      b.age = this.rng() * b.life;
      this.bubbles.push(b);
    }
    this.setQuality(kit.quality);
  }

  setQuality(quality: Quality): void {
    this.mesh.count = Math.max(1, Math.round(this.bubbles.length * qualityScale(quality)));
  }

  update(dt: number, elapsed: number): void {
    for (let i = 0; i < this.bubbles.length; i++) {
      const b = this.bubbles[i];
      b.age += dt;
      if (b.age >= b.life) {
        const fresh = this.spawn(b.source);
        Object.assign(b, fresh);
      }
      const src = this.sources[b.source];
      const segment = this.kit.floor.segmentAt(src.x, src.z);
      const emitting = !segment || segment.status === "solid" || b.y > 1;
      const t = b.age / b.life;
      // Pop: quick swell then vanish in the last 6% of life.
      const pop = t > 0.94 ? Math.max(0, 1 - (t - 0.94) / 0.06) * 1.25 : Math.min(1, b.age * 3);
      const size = emitting ? b.size * (0.7 + 0.3 * t) * pop : 0;
      this.pos.set(
        b.x + wobble(elapsed * 1.3 + b.phase, 1) * 0.35 * t,
        b.y + b.speed * b.age,
        b.z + wobble(elapsed * 1.1 + b.phase, 4) * 0.35 * t,
      );
      this.matrix.makeScale(size, size, size).setPosition(this.pos);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  private spawn(source: number): Bubble {
    const src = this.sources[source];
    const a = this.rng() * Math.PI * 2;
    const d = this.rng() * 0.6 * src.scale;
    return {
      source,
      x: src.x + Math.cos(a) * d,
      z: src.z + Math.sin(a) * d,
      y: 0.3,
      speed: 0.45 + this.rng() * 0.6,
      size: (0.08 + this.rng() * 0.16) * src.scale,
      age: 0,
      life: 4 + this.rng() * 4,
      phase: this.rng() * 50,
    };
  }
}

/* ================================================================== faucet */

/** Faucet model (local, before item.scale): wall plate at z = 0, spout reaching toward +Z. */
const NOZZLE_LOCAL = v3(0, -0.15, 1.02);

export function buildFaucet(kit: ArenaKit, item: DecorItem): void {
  const b = new Baker();
  b.add(new RoundedBoxGeometry(1.35, 0.8, 0.16, 3, 0.07), CHROME, composeMatrix(v3(0, 0, 0)));
  b.addAt(new THREE.CylinderGeometry(0.11, 0.12, 1.0, 14), CHROME, v3(0, 0.12, 0.55), new THREE.Euler(Math.PI / 2, 0, 0));
  b.addAt(new THREE.SphereGeometry(0.12, 14, 10), CHROME, v3(0, 0.12, 1.02));
  b.addAt(new THREE.CylinderGeometry(0.11, 0.11, 0.24, 14), CHROME, v3(0, 0.0, 1.02));
  b.addAt(new THREE.CylinderGeometry(0.14, 0.12, 0.07, 14), CHROME_DARK, v3(0, -0.12, 1.02));
  // Highlight streak along the spout (cartoon chrome).
  b.addAt(new THREE.BoxGeometry(0.03, 0.02, 0.8), "#FFFFFF", v3(-0.04, 0.23, 0.55));
  for (const side of [-1, 1]) {
    const x = side * 0.45;
    b.addAt(new THREE.CylinderGeometry(0.07, 0.07, 0.22, 10), CHROME_DARK, v3(x, 0.05, 0.16), new THREE.Euler(Math.PI / 2, 0, 0));
    b.addAt(new THREE.BoxGeometry(0.4, 0.07, 0.07), CHROME, v3(x, 0.05, 0.28), new THREE.Euler(0, 0, 0.3));
    b.addAt(new THREE.BoxGeometry(0.07, 0.4, 0.07), CHROME, v3(x, 0.05, 0.28), new THREE.Euler(0, 0, 0.3));
    b.addAt(new THREE.SphereGeometry(0.08, 12, 8), side < 0 ? "#FF5A5F" : "#3FA7FF", v3(x, 0.05, 0.33));
  }
  const baseY = item.y ?? 0;
  const matrix = composeMatrix(v3(item.x, baseY, item.z), new THREE.Euler(0, item.rotation, 0), item.scale);
  const mesh = new THREE.Mesh(kit.bank.geo(b.build()), kit.bakedMaterial());
  mesh.name = "faucet";
  mesh.applyMatrix4(matrix);
  kit.backdrop.add(mesh);
  const nozzle = NOZZLE_LOCAL.clone().applyMatrix4(matrix);
  kit.animate(new FaucetDrip(kit, nozzle, item.scale));
}

/** A drop swells at the nozzle, falls, and splashes a ring on the tub floor (or keeps falling). */
class FaucetDrip implements Animated {
  private readonly drop: THREE.Mesh;
  private readonly splash: THREE.Mesh;
  private readonly splashMat: THREE.MeshBasicMaterial;
  private t = 0;
  private y = 0;
  private vy = 0;
  private splashT = -1;
  private readonly floorBelow: boolean;

  constructor(
    private readonly kit: ArenaKit,
    private readonly nozzle: THREE.Vector3,
    private readonly scale: number,
  ) {
    const bank = kit.bank;
    const water = bank.own(new THREE.MeshToonMaterial({ color: "#7FD3F0", transparent: true, opacity: 0.85 }));
    const geo = bank.geo(new THREE.SphereGeometry(0.07 * scale, 12, 10));
    this.drop = new THREE.Mesh(geo, water);
    this.drop.name = "faucetDrop";
    this.splashMat = bank.own(new THREE.MeshBasicMaterial({ color: "#E6F7FD", transparent: true, depthWrite: false }));
    const ring = bank.geo(new THREE.RingGeometry(0.2, 0.28, 24));
    ring.rotateX(-Math.PI / 2);
    this.splash = new THREE.Mesh(ring, this.splashMat);
    this.splash.position.set(nozzle.x, 0.02, nozzle.z);
    this.splash.visible = false;
    this.floorBelow = kit.floor.segmentAt(nozzle.x, nozzle.z) !== null;
    kit.backdrop.add(this.drop, this.splash);
    this.reset();
  }

  update(dt: number): void {
    this.t += dt;
    if (this.t < 1.4) {
      // Swell at the nozzle.
      const s = 0.3 + 0.7 * (this.t / 1.4);
      this.drop.scale.set(s, s * 1.25, s);
      this.drop.position.set(this.nozzle.x, this.nozzle.y - 0.05 * this.scale * s, this.nozzle.z);
    } else {
      this.vy -= 20 * dt;
      this.y += this.vy * dt;
      this.drop.scale.set(0.85, 1.35, 0.85);
      this.drop.position.y = this.y;
      const segment = this.kit.floor.segmentAt(this.nozzle.x, this.nozzle.z);
      const solid = this.floorBelow && segment !== null && segment.status === "solid";
      if (solid && this.y <= 0.05) {
        this.splashT = 0;
        this.reset();
      } else if (this.y < -24) {
        this.reset();
      }
    }
    this.updateSplash(dt);
  }

  private updateSplash(dt: number): void {
    if (this.splashT < 0) {
      this.splash.visible = false;
      return;
    }
    this.splashT += dt;
    const k = this.splashT / 0.5;
    if (k >= 1) {
      this.splashT = -1;
      return;
    }
    this.splash.visible = true;
    this.splash.scale.setScalar(0.5 + k * 2.2);
    this.splashMat.opacity = 0.8 * (1 - k);
  }

  private reset(): void {
    this.t = 0;
    this.vy = 0;
    this.y = this.nozzle.y - 0.05 * this.scale;
  }
}

/* ============================================================= towel rack */

export function buildTowelRack(kit: ArenaKit, item: DecorItem): void {
  const b = new Baker();
  // Posts + bar.
  for (const side of [-1, 1]) {
    b.addAt(new THREE.CylinderGeometry(0.035, 0.035, 0.75, 8), CHROME, v3(side * 0.75, -0.25, 0));
    b.addAt(new THREE.SphereGeometry(0.06, 10, 8), CHROME_DARK, v3(side * 0.75, 0.13, 0));
    b.addAt(new THREE.CylinderGeometry(0.11, 0.11, 0.04, 12), CHROME_DARK, v3(side * 0.75, -0.62, 0));
  }
  b.addAt(new THREE.CylinderGeometry(0.035, 0.035, 1.5, 8), CHROME, v3(0, 0.1, 0), new THREE.Euler(0, 0, Math.PI / 2));
  // Towel draped over the bar: front and back flaps + a rounded fold over the top.
  const towel = "#7FD3E6";
  const stripe = "#FFFFFF";
  const coral = "#FF8FA3";
  const flap = (z: number, len: number) => {
    b.addAt(new THREE.BoxGeometry(1.1, len, 0.05), towel, v3(0, 0.1 - len / 2, z), null, 1, true);
    for (const [y, color] of [
      [0.1 - len + 0.12, stripe],
      [0.1 - len + 0.2, coral],
      [0.1 - len + 0.28, stripe],
    ] as const) {
      b.addAt(new THREE.BoxGeometry(1.104, 0.05, 0.054), color, v3(0, y, z), null, 1, true);
    }
  };
  flap(0.065, 0.95);
  flap(-0.065, 0.7);
  b.addAt(new THREE.CylinderGeometry(0.09, 0.09, 1.1, 10, 1, false, 0, Math.PI), towel, v3(0, 0.1, 0), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
  const mesh = new THREE.Mesh(kit.bank.geo(b.build()), kit.bakedMaterial());
  mesh.name = "towelRack";
  const base = composeMatrix(v3(item.x, item.y ?? 0, item.z), new THREE.Euler(0, item.rotation, 0), item.scale);
  mesh.applyMatrix4(base);
  kit.backdrop.add(mesh);
  kit.animate(new FloatBob(mesh, 0.18, 0.6, item.x));
}

/** Gentle floating bob + sway for backdrop props. */
export class FloatBob implements Animated {
  private readonly baseY: number;
  private readonly baseRotZ: number;

  constructor(
    private readonly object: THREE.Object3D,
    private readonly amplitude: number,
    private readonly speed: number,
    private readonly phase: number,
  ) {
    this.baseY = object.position.y;
    this.baseRotZ = object.rotation.z;
  }

  update(_dt: number, elapsed: number): void {
    const t = elapsed * this.speed + this.phase;
    this.object.position.y = this.baseY + Math.sin(t) * this.amplitude;
    this.object.rotation.z = this.baseRotZ + Math.sin(t * 0.7 + 1) * 0.04;
  }
}
