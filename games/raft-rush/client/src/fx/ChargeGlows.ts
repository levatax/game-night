// Throw charge glow (§11): a warm additive halo around the hand of whoever is charging, growing with the charge
// and pulsing + throwing sparks at full charge. Keyed by player id; a glow not refreshed for a moment fades out.
// (Held item meshes can also glow themselves through itemMeshes.setItemGlow.) Owner: client-fx-audio.

import * as THREE from "three";
import type { Vec3Like } from "../../../shared/types";
import { glowTexture } from "./fxTextures";
import type { Particles } from "./Particles";

const TIMEOUT_SEC = 0.12;
const MAX_SIZE = 0.85;

interface Glow {
  sprite: THREE.Sprite;
  material: THREE.SpriteMaterial;
  charge: number;
  idle: number;
  color: string;
}

export class ChargeGlows {
  private readonly root = new THREE.Group();
  private readonly glows = new Map<string, Glow>();
  private time = 0;

  constructor(
    parent: THREE.Object3D,
    private readonly particles: Particles,
  ) {
    this.root.name = "fx-charge-glows";
    parent.add(this.root);
  }

  get count(): number {
    return this.glows.size;
  }

  /** Per frame while charging; pos null or charge 0 removes it. */
  set(id: string, pos: Vec3Like | null, charge: number, color: string): void {
    if (!pos || charge <= 0) {
      const g = this.glows.get(id);
      if (g) this.remove(id, g);
      return;
    }
    let g = this.glows.get(id);
    if (!g) {
      const material = new THREE.SpriteMaterial({
        map: glowTexture(),
        color: new THREE.Color(color),
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        fog: false,
        toneMapped: false,
      });
      const sprite = new THREE.Sprite(material);
      sprite.renderOrder = 6;
      sprite.raycast = () => {};
      this.root.add(sprite);
      g = { sprite, material, charge: 0, idle: 0, color };
      this.glows.set(id, g);
    }
    if (g.color !== color) {
      g.color = color;
      g.material.color.set(color);
    }
    g.charge = Math.min(1, charge);
    g.idle = 0;
    g.sprite.position.set(pos.x, pos.y, pos.z);
    if (g.charge >= 0.999) this.particles.emit(`charge:${id}`, "chargeSpark", pos, { color, scale: 0.8 });
  }

  update(dt: number): void {
    this.time += dt;
    for (const [id, g] of this.glows) {
      g.idle += dt;
      if (g.idle > TIMEOUT_SEC) {
        this.remove(id, g);
        continue;
      }
      const full = g.charge >= 0.999;
      const pulse = full ? 1 + 0.2 * Math.sin(this.time * 20) : 1;
      const size = MAX_SIZE * (0.3 + 0.7 * g.charge) * pulse;
      g.sprite.scale.set(size, size, size);
      g.material.opacity = 0.2 + 0.6 * g.charge;
    }
  }

  clear(): void {
    for (const [id, g] of this.glows) this.remove(id, g);
  }

  dispose(): void {
    this.clear();
    this.root.removeFromParent();
  }

  private remove(id: string, g: Glow): void {
    this.glows.delete(id);
    g.sprite.removeFromParent();
    g.material.dispose();
  }
}
