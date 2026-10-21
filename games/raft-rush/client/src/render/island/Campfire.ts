// The campfire's live part (game4.md §7/§16): a layered toon flame whose size follows TeamView.fireFuel
// (bigger when well fed, small and sputtering under FIRE_LOW_FRACTION, gone at 0 — then only smoke and a dull
// coal glow), rising embers, a smoke column, the glowing light-ring edge at night, and the point-light anchor
// the Renderer's light pool feeds from (`light`). Owner: client-render.

import * as THREE from "three";
import { FIRE_LIGHT_RADIUS, FIRE_LOW_FRACTION, FIRE_START_FUEL_TICKS, PALETTE } from "../../../../shared/constants";
import { heightAt } from "../../../../shared/island/heightfield";
import type { Heightfield, XZ } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { smoothing, wobble } from "../noise";
import { LightRing } from "./LightRing";
import { RisingPuffs } from "./particles";

/** A light the Renderer's pool should place this frame. */
export interface LightRequest {
  pos: THREE.Vector3;
  color: THREE.Color;
  /** 0..~1.4 strength (0 = off). */
  intensity: number;
  /** Gameplay radius the falloff should read as. */
  radius: number;
  /** Higher wins a pool slot first (campfires > planted torches > held torches). */
  priority: number;
}

export class Campfire {
  readonly group = new THREE.Group();
  readonly light: LightRequest;
  private readonly flames: THREE.Mesh[] = [];
  private readonly flameMats: THREE.MeshBasicMaterial[] = [];
  private readonly coals: THREE.MeshBasicMaterial;
  private readonly smoke: RisingPuffs;
  private readonly embers: RisingPuffs;
  private readonly ring: LightRing;
  private readonly base: THREE.Vector3;
  private size = 0;
  private out = 1;

  constructor(grid: Heightfield, fire: XZ, bank: MaterialBank) {
    this.group.name = "campfire";
    const y = heightAt(grid, fire.x, fire.z);
    this.base = new THREE.Vector3(fire.x, y, fire.z);
    // Flame layers: outer orange, mid gold, white-hot core (HDR so bloom catches it on high).
    const layers: Array<[string, number, number, number]> = [
      ["#FF6A2B", 0.5, 1.0, 0.85],
      [PALETTE.fire, 0.36, 0.82, 0.95],
      ["#FFF1A8", 0.2, 0.55, 1.0],
    ];
    layers.forEach(([color, r, h, opacity], i) => {
      const geo = bank.geo(new THREE.ConeGeometry(r, h, 6, 1, true));
      geo.translate(0, h / 2, 0);
      // Outer layers are solid toon-flat (readable on bright noon sand); the white-hot core is additive HDR.
      const core = i === layers.length - 1;
      const mat = bank.own(
        new THREE.MeshBasicMaterial({
          color: new THREE.Color(color).multiplyScalar(core ? 2 : 1.25),
          transparent: true,
          opacity,
          blending: core ? THREE.AdditiveBlending : THREE.NormalBlending,
          depthWrite: false,
          side: THREE.DoubleSide,
          toneMapped: false,
          fog: false,
        }),
      );
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(this.base).add(new THREE.Vector3(0, 0.08, 0));
      mesh.renderOrder = 4;
      mesh.frustumCulled = false;
      this.group.add(mesh);
      this.flames.push(mesh);
      this.flameMats.push(mat);
    });
    // Coal bed glow.
    const coalGeo = bank.geo(new THREE.CircleGeometry(0.5, 10));
    coalGeo.rotateX(-Math.PI / 2);
    this.coals = bank.own(new THREE.MeshBasicMaterial({ color: "#FF5A2A", transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false }));
    const coals = new THREE.Mesh(coalGeo, this.coals);
    coals.position.copy(this.base).add(new THREE.Vector3(0, 0.07, 0));
    coals.renderOrder = 3;
    this.group.add(coals);
    // Smoke + embers.
    this.smoke = new RisingPuffs(bank, { count: 16, x: fire.x, y: y + 0.5, z: fire.z, jitter: 0.25, color: "#8C8A8E", additive: false, rise: 6.5, spread: 0.9, size: 40, life: 4.2, fadeIn: 0.12 });
    this.smoke.points.name = "campfireSmoke";
    this.embers = new RisingPuffs(bank, { count: 14, x: fire.x, y: y + 0.35, z: fire.z, jitter: 0.35, color: "#FFB347", additive: true, rise: 3.2, spread: 0.6, size: 7, life: 1.6, fadeIn: 0.02 });
    this.embers.points.name = "campfireEmbers";
    this.group.add(this.smoke.points, this.embers.points);
    this.ring = new LightRing(grid, fire.x, fire.z, FIRE_LIGHT_RADIUS, PALETTE.fire, bank);
    this.group.add(this.ring.mesh);
    this.light = {
      pos: this.base.clone().add(new THREE.Vector3(0, 1.0, 0)),
      color: new THREE.Color(PALETTE.fire),
      intensity: 0,
      radius: FIRE_LIGHT_RADIUS,
      priority: 3,
    };
  }

  /** Per frame: flame size from `fuel` ticks, flicker, smoke / embers, ring and light. */
  update(dt: number, elapsed: number, fuel: number, dark: number, rain: number, pixelRatio: number): void {
    const lit = fuel > 0;
    const f = Math.max(0, fuel) / FIRE_START_FUEL_TICKS;
    const target = lit ? Math.min(1.45, 0.45 + Math.sqrt(f) * 0.55) : 0;
    this.size += (target - this.size) * smoothing(lit ? 4 : 7, dt);
    this.out += ((lit ? 0 : 1) - this.out) * smoothing(2, dt);
    const low = lit && f < FIRE_LOW_FRACTION;
    const sputter = low ? 0.55 + 0.45 * Math.max(0, wobble(elapsed * 7, 2.1)) : 1;
    const flick = 1 + wobble(elapsed * 9, 0.7) * 0.12;
    this.flames.forEach((m, i) => {
      const k = this.size * sputter * (1 - i * 0.06);
      const visible = k > 0.03;
      m.visible = visible;
      if (!visible) return;
      const sway = wobble(elapsed * (3 + i), i * 1.7) * 0.12;
      m.scale.set(k * (1 + wobble(elapsed * 6, i) * 0.08), k * flick * (1 + i * 0.05), k * (1 + wobble(elapsed * 5, i + 3) * 0.08));
      m.rotation.set(sway * 0.5, elapsed * (0.6 + i * 0.4), sway);
    });
    this.coals.opacity = 0.25 + 0.55 * Math.min(1, this.size) + (lit ? 0 : 0.12 * (1 - this.out));
    this.coals.color.setRGB(1.6, 0.5 + 0.25 * Math.min(1, this.size), 0.2);
    // Out = smoke only (thick for a while); lit = thin smoke + embers.
    this.smoke.update(elapsed, 0.16 + this.out * 0.4 + rain * 0.15, pixelRatio);
    this.embers.update(elapsed, Math.min(1, this.size) * (1 - rain * 0.6), pixelRatio);
    this.ring.setOpacity(Math.min(1, this.size) * smoothstep(0.35, 0.8, dark) * (0.3 + 0.05 * flick));
    this.light.intensity = Math.min(1.4, this.size) * sputter * flick;
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
