// Sudden-death ring animation: shake (state 1), then a wobbly staggered fall (state 2), then the
// segments are hidden. Driven by state.rings every frame; idempotent.

import * as THREE from "three";
import { RING_FALLEN, RING_SHAKING, RING_SOLID } from "../../../../shared/constants";
import type { CrumbleKind } from "../../../../shared/maps";
import { createRng, wobble } from "../noise";
import type { RingSegment } from "./floor";

/** Gravity of falling segments (same as the game world, so it matches tumbling players). */
const FALL_GRAVITY = 20;
/** Small upward pop when a segment breaks loose. */
const FALL_POP = 1.1;
/** Outward drift so the island visibly breaks apart instead of sinking as a block. */
const FALL_DRIFT = 1.4;
/** Max random delay between segments of the same ring. */
const FALL_STAGGER = 0.22;
/** Hide a segment once it dropped this far or after this long. */
const FALL_HIDE_DEPTH = 28;
const FALL_HIDE_SEC = 2.4;
/** Shake ramps up over the server's 0.8 s shake. */
const SHAKE_RAMP_SEC = 0.8;
const SHAKE_MIN = 0.02;
const SHAKE_MAX = 0.075;

interface SegmentMotion {
  segment: RingSegment;
  /** Seconds in the current status (negative while waiting for its fall delay). */
  t: number;
  phase: number;
  vy: number;
  /** Horizontal tumble axis (tangent to the ring) and spin rates. */
  axis: THREE.Vector3;
  tumbleRate: number;
  wobbleRate: number;
  delay: number;
}

const tmpQuat = new THREE.Quaternion();
const wobbleQuat = new THREE.Quaternion();
const outwardAxis = new THREE.Vector3();

export class RingAnimator {
  /** Fired once per ring when it starts to fall. */
  onRingFall: ((ring: number, crumble: CrumbleKind) => void) | null = null;

  private readonly motions: SegmentMotion[][];
  private readonly applied: number[];
  private initialized = false;

  constructor(
    rings: RingSegment[][],
    private readonly crumble: CrumbleKind,
    seed: number,
  ) {
    const rng = createRng(seed);
    this.motions = rings.map((segments) =>
      segments.map((segment) => ({
        segment,
        t: 0,
        phase: rng() * 100,
        vy: 0,
        axis: new THREE.Vector3(-Math.sin(segment.midAngle), 0, Math.cos(segment.midAngle)),
        tumbleRate: 0.9 + rng() * 1.1,
        wobbleRate: 2.5 + rng() * 2,
        delay: rng() * FALL_STAGGER,
      })),
    );
    this.applied = rings.map(() => RING_SOLID);
  }

  /** Apply ring states (missing entries = solid). The first call after a reset applies instantly. */
  sync(rings: ArrayLike<number>): void {
    if (allSolid(rings, this.motions.length)) {
      if (this.applied.some((s) => s !== RING_SOLID)) this.restoreAll();
      this.initialized = true;
      return;
    }
    for (let i = 0; i < this.motions.length; i++) {
      const next = i < rings.length ? rings[i] : RING_SOLID;
      if (next === this.applied[i]) continue;
      if (!this.initialized) this.snapRing(i, next);
      else this.transitionRing(i, next);
      this.applied[i] = next;
    }
    this.initialized = true;
  }

  /** Forget everything and stand every segment back up (new arena / round reset). */
  restoreAll(): void {
    for (let i = 0; i < this.motions.length; i++) {
      for (const m of this.motions[i]) restore(m);
      this.applied[i] = RING_SOLID;
    }
  }

  update(dt: number): void {
    for (const ring of this.motions) {
      for (const m of ring) {
        const status = m.segment.status;
        if (status === "shaking") this.shake(m, dt);
        else if (status === "falling") this.fall(m, dt);
      }
    }
  }

  private transitionRing(ring: number, next: number): void {
    if (next === RING_SOLID) {
      for (const m of this.motions[ring]) restore(m);
      return;
    }
    if (next === RING_SHAKING) {
      for (const m of this.motions[ring]) {
        restore(m);
        m.segment.status = "shaking";
      }
      return;
    }
    if (next === RING_FALLEN) {
      for (const m of this.motions[ring]) {
        m.segment.status = "falling";
        m.t = -m.delay;
        m.vy = FALL_POP;
      }
      this.onRingFall?.(ring, this.crumble);
    }
  }

  /** Late join / reconnect: show the current state without replaying animations or events. */
  private snapRing(ring: number, next: number): void {
    for (const m of this.motions[ring]) {
      restore(m);
      if (next === RING_SHAKING) m.segment.status = "shaking";
      if (next === RING_FALLEN) {
        m.segment.status = "gone";
        m.segment.object.visible = false;
      }
    }
  }

  private shake(m: SegmentMotion, dt: number): void {
    m.t += dt;
    applyJitter(m, Math.min(1, m.t / SHAKE_RAMP_SEC), m.t);
  }

  private fall(m: SegmentMotion, dt: number): void {
    m.t += dt;
    if (m.t < 0) {
      // Still waiting for its staggered drop: keep rattling at full strength.
      applyJitter(m, 1, m.t);
      return;
    }
    const seg = m.segment;
    const o = seg.object;
    m.vy -= FALL_GRAVITY * dt;
    o.position.y += m.vy * dt;
    o.position.x += seg.outward.x * FALL_DRIFT * dt;
    o.position.z += seg.outward.z * FALL_DRIFT * dt;
    // Tumble outward around the ring tangent, plus a wobble around the outward axis.
    const tumble = m.tumbleRate * m.t * m.t * 0.9;
    tmpQuat.setFromAxisAngle(m.axis, tumble);
    outwardAxis.copy(seg.outward);
    wobbleQuat.setFromAxisAngle(outwardAxis, Math.sin(m.t * m.wobbleRate + m.phase) * 0.35 * Math.min(1, m.t * 2));
    o.quaternion.copy(tmpQuat).multiply(wobbleQuat);
    if (seg.centroid.y - o.position.y > FALL_HIDE_DEPTH || m.t > FALL_HIDE_SEC) {
      seg.status = "gone";
      o.visible = false;
    }
  }
}

/** Rattle in place around the rest pose; `ramp` 0..1 scales the amplitude. */
function applyJitter(m: SegmentMotion, ramp: number, time: number): void {
  const amp = SHAKE_MIN + (SHAKE_MAX - SHAKE_MIN) * ramp * ramp;
  const t = time * 38 + m.phase;
  const o = m.segment.object;
  const c = m.segment.centroid;
  o.position.set(c.x + wobble(t, 1) * amp, c.y - ramp * 0.04 + wobble(t, 7) * amp * 0.4, c.z + wobble(t, 13) * amp);
  o.rotation.set(wobble(t, 3) * amp * 0.35, 0, wobble(t, 5) * amp * 0.35);
}

function restore(m: SegmentMotion): void {
  const seg = m.segment;
  seg.status = "solid";
  seg.object.visible = true;
  seg.object.position.copy(seg.centroid);
  seg.object.quaternion.identity();
  m.t = 0;
  m.vy = 0;
}

function allSolid(rings: ArrayLike<number>, count: number): boolean {
  for (let i = 0; i < Math.min(rings.length, count); i++) {
    if (rings[i] !== RING_SOLID) return false;
  }
  return true;
}
