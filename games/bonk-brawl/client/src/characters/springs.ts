// Spring-bone secondary motion (ears, tails, hats, ribbons, scarves, bells, bellies...).
// Owner: client-characters (MOTION).
//
// "Jiggle tip" springs: each bone tracks a lagging world-space point `p` that chases the posed tip
// T = pivot.matrixWorld × tip with a damped spring (+ gravity + a little air drag), then the pivot is
// rotated (aim) or scaled (scale) so its tip points at `p`. The target is interpolated linearly
// inside a frame and the spring is stepped in closed form over it, so the motion looks the same at
// 30 / 60 / 144 fps (stricter than fixed substeps, and cheaper).
// Allocation-free per frame: Float32Array state + per-rig scratch objects.

import * as THREE from "three";
import type { SpringBone, SpringKind } from "./rigTypes";

/**
 * Longest span the spring is integrated over in one frame (s). Only the integration span is capped:
 * target velocities (finite differences) always use the real frame time, so a frame hitch does not
 * overestimate them.
 */
const MAX_DT = 0.1;
/**
 * Lag guard: |T − p| above max(SNAP_MIN, SNAP_TIPS·|tip|) plus this frame's target move snaps the
 * spring to the target (a fast but legal move is integrated, not snapped).
 */
const SNAP_MIN = 0.75;
const SNAP_TIPS = 4;
/** Velocity a snapped tip may inherit at most (m/s): just above KNOCK_MAX_SPEED. */
const SNAP_MAX_SPEED = 25;
/**
 * Teleport: the target moved more than max(TELEPORT_MIN, TELEPORT_SPEED·dt) in one frame (faster
 * than anything legal: knockback, falls, turns). The spring snaps with zero velocity, no whip.
 */
const TELEPORT_MIN = 0.3;
const TELEPORT_SPEED = 40;

/**
 * Air drag on the tip's absolute velocity (1/s). Pure relative damping lets a spring catch up
 * fully at constant speed; a little drag makes ribbons, scarves and tails stream behind a runner.
 */
const AIR_DRAG: Record<SpringKind, number> = {
  head: 0,
  ear: 1.2,
  tail: 1.6,
  hat: 0.6,
  ribbon: 4.5,
  scarf: 4.5,
  cap: 3,
  pompom: 3,
  bell: 0.6,
  beard: 2,
  crest: 1.4,
  bulb: 0,
  wing: 0.8,
  cheek: 0,
  belly: 0,
  sac: 0,
};

const AXES: Record<"x" | "y" | "z", number> = { x: 0, y: 1, z: 2 };

export class SpringRig {
  private readonly bones: ReadonlyArray<SpringBone>;
  private readonly n: number;
  /** Per bone ×3: lagging tip position / velocity, the last two targets (world space). */
  private readonly p: Float64Array;
  private readonly v: Float64Array;
  private readonly tPrev: Float64Array;
  private readonly tPrev2: Float64Array;
  /** Per bone: tPrev2 is valid (two frames of history since the last snap). */
  private readonly hasPrev2: Uint8Array;
  /** Length of the previous frame (s). */
  private dtPrev = 0;
  /** Per bone: tip length, snap distance, air drag, axis index, needs-children-update flag. */
  private readonly tipLen: Float32Array;
  private readonly snapDist: Float32Array;
  private readonly drag: Float32Array;
  private readonly axis: Uint8Array;
  private readonly updatesChildren: Uint8Array;
  private readonly tipDir: Float32Array;
  private initialized = false;

  private readonly target = new THREE.Vector3();
  private readonly local = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly rest = new THREE.Vector3();
  private readonly inv = new THREE.Matrix4();
  private readonly q = new THREE.Quaternion();
  private readonly identity = new THREE.Quaternion();

  constructor(bones: ReadonlyArray<SpringBone>) {
    this.bones = bones;
    const n = bones.length;
    this.n = n;
    this.p = new Float64Array(n * 3);
    this.v = new Float64Array(n * 3);
    this.tPrev = new Float64Array(n * 3);
    this.tPrev2 = new Float64Array(n * 3);
    this.hasPrev2 = new Uint8Array(n);
    this.tipLen = new Float32Array(n);
    this.snapDist = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.axis = new Uint8Array(n);
    this.updatesChildren = new Uint8Array(n);
    this.tipDir = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const b = bones[i];
      const len = Math.hypot(b.tip[0], b.tip[1], b.tip[2]);
      this.tipLen[i] = Math.max(1e-3, len);
      this.snapDist[i] = Math.max(SNAP_MIN, SNAP_TIPS * len);
      this.drag[i] = AIR_DRAG[b.kind] ?? 0;
      this.axis[i] = AXES[b.axis ?? "y"];
      const inv = len > 1e-6 ? 1 / len : 0;
      this.tipDir[i * 3] = b.tip[0] * inv;
      this.tipDir[i * 3 + 1] = len > 1e-6 ? b.tip[1] * inv : 1;
      this.tipDir[i * 3 + 2] = b.tip[2] * inv;
    }
    // A bone whose pivot is an ancestor of a later bone's pivot must refresh its subtree's world
    // matrices after it is deflected, so the child's target follows the lagging parent.
    for (let j = 0; j < n; j++) {
      for (let o: THREE.Object3D | null = bones[j].pivot.parent; o; o = o.parent) {
        for (let i = 0; i < j; i++) if (bones[i].pivot === o) this.updatesChildren[i] = 1;
      }
    }
  }

  get count(): number {
    return this.n;
  }

  /** World-space lagging tip of bone `i` (dev harness debug points). */
  getTip(i: number, out: THREE.Vector3): THREE.Vector3 {
    return out.set(this.p[i * 3], this.p[i * 3 + 1], this.p[i * 3 + 2]);
  }

  /** Forget all motion: the next update snaps every tip to its target. */
  reset(): void {
    this.initialized = false;
    this.v.fill(0);
    this.hasPrev2.fill(0);
    this.dtPrev = 0;
  }

  /**
   * Integrate and deflect. Call after the pose is applied (spring pivots reset to their rest
   * transform first) and the rig's world matrices are up to date. dt ≤ 0 (hit-stop) re-applies
   * the last deflection without integrating.
   */
  update(dt: number, freqScale = 1): void {
    const n = this.n;
    if (n === 0) return;
    const span = Math.min(MAX_DT, dt);
    const integrate = dt > 0 && this.initialized;
    const first = !this.initialized;
    this.initialized = true;
    const P = this.p;
    const V = this.v;
    const TP = this.tPrev;
    const TP2 = this.tPrev2;
    for (let i = 0; i < n; i++) {
      const b = this.bones[i];
      const pivot = b.pivot;
      const i3 = i * 3;
      const T = this.target.set(b.tip[0], b.tip[1], b.tip[2]).applyMatrix4(pivot.matrixWorld);
      let snapped = first;
      if (first) {
        P[i3] = T.x;
        P[i3 + 1] = T.y;
        P[i3 + 2] = T.z;
        V[i3] = V[i3 + 1] = V[i3 + 2] = 0;
        this.hasPrev2[i] = 0;
      } else if (integrate) {
        const mx = T.x - TP[i3];
        const my = T.y - TP[i3 + 1];
        const mz = T.z - TP[i3 + 2];
        const move = Math.hypot(mx, my, mz);
        const gap = Math.hypot(T.x - P[i3], T.y - P[i3 + 1], T.z - P[i3 + 2]);
        const teleport = move > Math.max(TELEPORT_MIN, TELEPORT_SPEED * dt) || !Number.isFinite(move + gap);
        if (teleport || gap > this.snapDist[i] + move) {
          P[i3] = T.x;
          P[i3 + 1] = T.y;
          P[i3 + 2] = T.z;
          if (teleport) {
            V[i3] = V[i3 + 1] = V[i3 + 2] = 0;
          } else {
            // Inherit the target's real velocity (real frame dt), clamped to a plausible speed.
            const speed = move / dt;
            const f = speed > SNAP_MAX_SPEED ? SNAP_MAX_SPEED / speed : 1;
            V[i3] = (mx / dt) * f;
            V[i3 + 1] = (my / dt) * f;
            V[i3 + 2] = (mz / dt) * f;
          }
          snapped = true;
        } else {
          this.integrate(i, dt, span, freqScale, T);
        }
      }
      if (dt > 0 || first) {
        if (snapped) {
          this.hasPrev2[i] = 0;
        } else {
          TP2[i3] = TP[i3];
          TP2[i3 + 1] = TP[i3 + 1];
          TP2[i3 + 2] = TP[i3 + 2];
          this.hasPrev2[i] = 1;
        }
        TP[i3] = T.x;
        TP[i3 + 1] = T.y;
        TP[i3 + 2] = T.z;
      }
      if (b.mode === "aim") this.applyAim(i, pivot);
      else this.applyScale(i, pivot, T);
      if (this.updatesChildren[i]) pivot.updateMatrixWorld(true);
    }
    if (dt > 0) this.dtPrev = dt;
  }

  /**
   * Add a velocity impulse (m/s, character frame: +X right, +Y up, −Z forward) to the tips of the
   * bones of `kind` (null = every bone). `yaw` is the character's facing (player-yaw convention).
   */
  kick(kind: SpringKind | null, vx: number, vy: number, vz: number, yaw: number): void {
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    const wx = vx * c + vz * s;
    const wz = -vx * s + vz * c;
    for (let i = 0; i < this.n; i++) {
      if (kind !== null && this.bones[i].kind !== kind) continue;
      const i3 = i * 3;
      this.v[i3] += wx;
      this.v[i3 + 1] += vy;
      this.v[i3 + 2] += wz;
    }
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Exact step of the damped spring over the frame. Inside a frame the target follows the
   * parabola through the last three targets (T₋₁, T₀, T₁; linear right after a snap), so with
   * e = p − T(t) the motion is
   *   e'' + (c + drag)·e' + k·e = −(drag·T'(t) + g·ŷ + T'')
   * — a damped oscillator with forcing linear in t, solved in closed form. The result barely
   * depends on how a time span is split into frames (30 / 60 / 144 fps look the same).
   * `dt` is the real frame time (target finite differences); the error is evolved over `span`
   * (= dt, capped at MAX_DT for long hitches).
   */
  private integrate(i: number, dt: number, span: number, freqScale: number, T: THREE.Vector3): void {
    const b = this.bones[i];
    const i3 = i * 3;
    const w0 = 2 * Math.PI * b.freq * freqScale;
    const k = w0 * w0;
    const drag = this.drag[i];
    const C = 2 * b.damping * w0 + drag;
    const a = C / 2;
    // Homogeneous solution: y(t) = cyy·y0 + cyv·v0 ; y'(t) = cvy·y0 + cvv·v0.
    const disc = a * a - k;
    const ea = Math.exp(-a * span);
    if (disc < -1e-9) {
      const wd = Math.sqrt(-disc);
      const co = Math.cos(wd * span);
      const si = Math.sin(wd * span);
      this.cyy = ea * (co + (a / wd) * si);
      this.cyv = ea * (si / wd);
      this.cvy = ea * (-(k / wd) * si);
      this.cvv = ea * (co - (a / wd) * si);
    } else if (disc > 1e-9) {
      const sq = Math.sqrt(disc);
      const r1 = -a + sq;
      const r2 = -a - sq;
      const e1 = Math.exp(r1 * span);
      const e2 = Math.exp(r2 * span);
      const inv = 1 / (r1 - r2);
      this.cyy = (-r2 * e1 + r1 * e2) * inv;
      this.cyv = (e1 - e2) * inv;
      this.cvy = (-r2 * r1 * e1 + r1 * r2 * e2) * inv;
      this.cvv = (r1 * e1 - r2 * e2) * inv;
    } else {
      this.cyy = ea * (1 + a * span);
      this.cyv = ea * span;
      this.cvy = ea * (-a * a * span);
      this.cvv = ea * (1 - a * span);
    }
    const quad = this.hasPrev2[i] === 1 && this.dtPrev > 0;
    this.stepAxis(i3, dt, span, k, C, drag, T.x, 0, quad);
    this.stepAxis(i3 + 1, dt, span, k, C, drag, T.y, b.gravity, quad);
    this.stepAxis(i3 + 2, dt, span, k, C, drag, T.z, 0, quad);
  }

  /** Closed-form homogeneous coefficients of the current integrate() call. */
  private cyy = 0;
  private cyv = 0;
  private cvy = 0;
  private cvv = 0;

  private stepAxis(j: number, dt: number, span: number, k: number, C: number, drag: number, t1: number, g: number, quad: boolean): void {
    const t0 = this.tPrev[j];
    const d1 = (t1 - t0) / dt;
    let acc = 0;
    let v0 = d1;
    if (quad) {
      const h0 = this.dtPrev;
      const d0 = (t0 - this.tPrev2[j]) / h0;
      acc = (2 * (d1 - d0)) / (h0 + dt);
      v0 = d1 - 0.5 * acc * dt;
    }
    // Forcing F(t) = F0 + F1·t ; particular solution e_p = α + β·t.
    const F0 = drag * v0 + g + acc;
    const F1 = drag * acc;
    const beta = -F1 / k;
    const alpha = -(F0 + C * beta) / k;
    const y0 = this.p[j] - t0 - alpha;
    const yv0 = this.v[j] - v0 - beta;
    const y = this.cyy * y0 + this.cyv * yv0;
    const yv = this.cvy * y0 + this.cvv * yv0;
    this.p[j] = t1 + y + alpha + beta * span;
    this.v[j] = yv + beta + v0 + acc * dt;
  }

  /**
   * Rotate the pivot so its tip points at the lagging point. The angle saturates softly at the
   * limit (limit·tanh(angle/limit)): no hard stop, and chained children see a smooth target.
   */
  private applyAim(i: number, pivot: THREE.Object3D): void {
    const i3 = i * 3;
    const d = this.local.set(this.p[i3], this.p[i3 + 1], this.p[i3 + 2]).applyMatrix4(this.inv.copy(pivot.matrixWorld).invert());
    if (d.lengthSq() < 1e-12) return;
    d.normalize();
    const d0 = this.rest.set(this.tipDir[i3], this.tipDir[i3 + 1], this.tipDir[i3 + 2]);
    const q = this.q.setFromUnitVectors(d0, d);
    const limit = this.bones[i].limit;
    const angle = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
    // Not slerpQuaternions(identity, q, f): it copies identity into q before reading q (aliasing).
    if (angle > 1e-6 && limit > 0) q.slerp(this.identity, 1 - (limit * Math.tanh(angle / limit)) / angle);
    pivot.quaternion.multiply(q);
  }

  /** Volume-preserving stretch along the bone axis from the lag along that axis. */
  private applyScale(i: number, pivot: THREE.Object3D, T: THREE.Vector3): void {
    const i3 = i * 3;
    const e = pivot.matrixWorld.elements;
    const a = this.axis[i] * 4;
    const ax = this.dir.set(e[a], e[a + 1], e[a + 2]);
    const len = ax.length();
    if (len < 1e-9) return;
    const lag = ((this.p[i3] - T.x) * ax.x + (this.p[i3 + 1] - T.y) * ax.y + (this.p[i3 + 2] - T.z) * ax.z) / len;
    const limit = this.bones[i].limit;
    let d = lag / this.tipLen[i];
    d = limit > 0 ? limit * Math.tanh(d / limit) : 0;
    const s = 1 + d;
    const o = 1 / Math.sqrt(s);
    const sc = pivot.scale;
    const axis = this.axis[i];
    sc.x *= axis === 0 ? s : o;
    sc.y *= axis === 1 ? s : o;
    sc.z *= axis === 2 ? s : o;
  }
}
