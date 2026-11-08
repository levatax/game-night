// Ribbon trails behind tumbling (knocked-back) players, pooled per player id. Owner: client-fx.

import * as THREE from "three";
import { Trail } from "./Trail";

/** Trail length (s) and how fast an unfed trail fades away. */
const TRAIL_SEC = 0.3;
const FADE_SEC = 0.25;
/** Ribbon width (m) at full intensity, and its base opacity. */
const WIDTH = 0.42;
const OPACITY = 0.75;
/** Tint used when the predicted landing is off the island. */
const DANGER_COLOR = "#FF3B30";

interface Slot {
  id: string;
  trail: Trail;
  color: THREE.Color;
  colorKey: string;
  danger: boolean;
  /** Fed this frame (feed() since the last update()). */
  fed: boolean;
  /** 0..1 visibility; fades out once the player stops being fed. */
  alpha: number;
  intensity: number;
  x: number;
  y: number;
  z: number;
}

/**
 * Usage per frame: feed(id, ...) for every player that should currently leave a trail, then
 * update(dt) once (Fx.update). Unfed trails fade over FADE_SEC and return to the pool.
 * Allocation-free after a slot exists (one Trail per concurrently tumbling player).
 */
export class PlayerTrails {
  private readonly slots = new Map<string, Slot>();
  private readonly pool: Slot[] = [];
  private readonly dangerColor = new THREE.Color(DANGER_COLOR);
  private readonly tmp = new THREE.Color();

  constructor(private readonly parent: THREE.Object3D) {}

  /**
   * Grow the trail of `id` at (x, y, z) this frame. `color` is the player color ("#RRGGBB"),
   * `intensity` 0..1 scales width/opacity, `danger` tints it red (launch lands off the island).
   */
  feed(id: string, x: number, y: number, z: number, color: string, intensity: number, danger: boolean): void {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = this.pool.pop() ?? this.create();
      slot.id = id;
      slot.alpha = 0;
      slot.trail.reset();
      this.slots.set(id, slot);
    }
    if (slot.colorKey !== color) {
      slot.colorKey = color;
      slot.color.set(color);
    }
    slot.fed = true;
    slot.danger = danger;
    slot.intensity = Math.min(1, Math.max(0, intensity));
    slot.x = x;
    slot.y = y;
    slot.z = z;
  }

  /** Per frame with the cosmetic dt (0 during hit-stop: trails freeze). */
  update(dt: number): void {
    for (const slot of this.slots.values()) {
      if (slot.fed) {
        slot.alpha = Math.min(1, slot.alpha + dt / 0.06);
        slot.trail.record(dt, slot.x, slot.y, slot.z);
      } else {
        slot.alpha = Math.max(0, slot.alpha - dt / FADE_SEC);
        if (slot.alpha <= 0) {
          this.release(slot);
          continue;
        }
      }
      slot.fed = false;
      this.tmp.copy(slot.color);
      if (slot.danger) this.tmp.lerp(this.dangerColor, 0.8);
      const k = 0.5 + 0.5 * slot.intensity;
      slot.trail.setStyle(this.tmp, WIDTH * k, OPACITY * k * slot.alpha);
      slot.trail.rebuild(slot.x, slot.y, slot.z);
    }
  }

  clear(): void {
    for (const slot of this.slots.values()) this.release(slot);
  }

  dispose(): void {
    this.clear();
    for (const slot of this.pool) slot.trail.dispose();
    this.pool.length = 0;
  }

  private create(): Slot {
    return {
      id: "",
      trail: new Trail(this.parent, TRAIL_SEC),
      color: new THREE.Color(),
      colorKey: "",
      danger: false,
      fed: false,
      alpha: 0,
      intensity: 0,
      x: 0,
      y: 0,
      z: 0,
    };
  }

  private release(slot: Slot): void {
    this.slots.delete(slot.id);
    slot.trail.reset();
    slot.fed = false;
    this.pool.push(slot);
  }
}
