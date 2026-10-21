// Trauma-style screen shake for the first-person camera: the strongest active request wins and decays
// quadratically, so small shakes never cut a big one short. Applied on top of whatever pose FpCamera computed.
// Owner: client-render. Copied from games/bonk-brawl/client/src/render/camera/CameraShake.ts and toned down
// for first person (small offsets, most of the feel comes from rotation).

import * as THREE from "three";
import { wobble } from "./noise";

/** Offset (m), pitch/yaw jitter (rad) and roll (rad) at intensity 1. */
const MAX_OFFSET = 0.07;
const MAX_ANGLE = 0.035;
const MAX_ROLL = 0.04;
/** Noise speed: wobble() mixes ~1.7–5.3 rad/unit, so this lands around 6–18 Hz. */
const FREQUENCY = 22;

const right = new THREE.Vector3();
const up = new THREE.Vector3();
const rot = new THREE.Quaternion();
const euler = new THREE.Euler(0, 0, 0, "YXZ");

export class CameraShake {
  private intensity = 0;
  private duration = 1;
  private left = 0;
  private time = 0;
  /** Global multiplier (reduced flashing / comfort: 0.3). */
  scale = 1;

  /** intensity 0..1, duration in real seconds. */
  add(intensity: number, durationSec: number): void {
    const next = THREE.MathUtils.clamp(intensity, 0, 1);
    if (next <= 0 || next < this.amplitude) return;
    this.intensity = next;
    this.duration = Math.max(0.05, durationSec);
    this.left = this.duration;
  }

  get amplitude(): number {
    if (this.left <= 0) return 0;
    const k = this.left / this.duration;
    return this.intensity * k * k;
  }

  update(dt: number): void {
    this.time += dt;
    if (this.left > 0) this.left = Math.max(0, this.left - dt);
  }

  /** Offset `camera` in its own right/up plane and jitter its rotation (call after the pose is set). */
  apply(camera: THREE.Camera): void {
    const amp = this.amplitude * this.scale;
    if (amp <= 0) return;
    const t = this.time * FREQUENCY;
    right.set(1, 0, 0).applyQuaternion(camera.quaternion);
    up.set(0, 1, 0).applyQuaternion(camera.quaternion);
    camera.position.addScaledVector(right, wobble(t, 1.3) * amp * MAX_OFFSET);
    camera.position.addScaledVector(up, wobble(t, 4.7) * amp * MAX_OFFSET * 0.8);
    euler.set(wobble(t, 2.2) * amp * MAX_ANGLE, wobble(t, 6.4) * amp * MAX_ANGLE, wobble(t, 8.1) * amp * MAX_ROLL);
    camera.quaternion.multiply(rot.setFromEuler(euler));
  }

  reset(): void {
    this.left = 0;
    this.intensity = 0;
  }
}
