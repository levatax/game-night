// Small math / animation helpers for the cast: easing, envelopes, keyframe tracks, critically damped followers,
// pop springs, a two-bone arm IK solver, a constant-speed walk path and table-avoiding route planning.
// Owner: client-characters.

import * as THREE from "three";

export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Frame-rate independent smoothing factor. */
export function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}
export function approach(cur: number, target: number, rate: number, dt: number): number {
  return cur + (target - cur) * damp(rate, dt);
}
export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}
export function approachAngle(cur: number, target: number, rate: number, dt: number): number {
  return cur + wrapAngle(target - cur) * damp(rate, dt);
}
/** Progress of t through [a, b], clamped to 0..1. */
export function seg(t: number, a: number, b: number): number {
  return b <= a ? (t >= b ? 1 : 0) : clamp((t - a) / (b - a), 0, 1);
}
/** 0 → 1 → 0 hump over [a, b]. */
export function bump(t: number, a: number, b: number): number {
  const s = seg(t, a, b);
  return s <= 0 || s >= 1 ? 0 : Math.sin(Math.PI * s);
}
export function smooth(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}
export function easeOut(t: number): number {
  const x = clamp(t, 0, 1);
  return 1 - (1 - x) * (1 - x);
}
export function easeIn(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x;
}
export function easeInCubic(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * x;
}
export function easeOutCubic(t: number): number {
  const x = 1 - clamp(t, 0, 1);
  return 1 - x * x * x;
}
export function easeInOut(t: number): number {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
export function elasticOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;
}
export function backOut(t: number): number {
  const x = clamp(t, 0, 1) - 1;
  return 1 + 2.4 * x * x * x + 1.4 * x * x;
}
/** Pull back first, then go (anticipation). */
export function backIn(t: number): number {
  const x = clamp(t, 0, 1);
  return 2.4 * x * x * x - 1.4 * x * x;
}
export function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  let x = clamp(t, 0, 1);
  if (x < 1 / d) return n * x * x;
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75;
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375;
  return n * (x -= 2.625 / d) * x + 0.984375;
}
/** Smooth 0→1→0 envelope for an effect of length `dur` with fade-in / fade-out times (ease in-out edges). */
export function envelope(t: number, dur: number, inT: number, outT: number): number {
  if (t <= 0 || t >= dur) return 0;
  if (t < inT) return smooth(t / inT);
  if (t > dur - outT) return smooth((dur - t) / outT);
  return 1;
}
/**
 * Normalized distance along a move with a trapezoid speed profile: accelerates over the first `r` of the time,
 * cruises, decelerates over the last `r` (no instant starts, so feet never pop).
 */
export function ramp(u: number, r = 0.18): number {
  const x = clamp(u, 0, 1);
  const rr = clamp(r, 0.001, 0.5);
  const v = 1 / (1 - rr);
  if (x < rr) return (v * x * x) / (2 * rr);
  if (x > 1 - rr) {
    const y = 1 - x;
    return 1 - (v * y * y) / (2 * rr);
  }
  return v * (x - rr / 2);
}
export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}
export function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}
/** Cheap smooth 1D noise (sum of sines), roughly in -1..1. */
export function wobble(t: number, seed: number): number {
  return Math.sin(t * 1.7 + seed) * 0.55 + Math.sin(t * 2.9 + seed * 1.7) * 0.3 + Math.sin(t * 5.3 + seed * 3.1) * 0.15;
}
/** Yaw (around +y) that turns a +z-facing model at `from` toward `to`. */
export function yawTo(from: THREE.Vector3, to: THREE.Vector3): number {
  return Math.atan2(to.x - from.x, to.z - from.z);
}

// ------------------------------------------------------------- keyframe tracks
/** Easing of a keyframe segment (applied on the way INTO the key): 0 in-out, 1 out, 2 in, 3 linear, 4 back-out. */
export const Ease = { InOut: 0, Out: 1, In: 2, Linear: 3, Back: 4 } as const;
function ease(kind: number, s: number): number {
  switch (kind) {
    case 1: return easeOutCubic(s);
    case 2: return easeInCubic(s);
    case 3: return s;
    case 4: return backOut(s);
    default: return easeInOut(s);
  }
}
/** Scalar keyframes: [time, value, ease?] (ease of the segment that ends at that key). */
export function track(t: number, keys: readonly (readonly number[])[]): number {
  const n = keys.length;
  if (t <= keys[0]![0]!) return keys[0]![1]!;
  for (let i = 1; i < n; i++) {
    const b = keys[i]!;
    if (t < b[0]!) {
      const a = keys[i - 1]!;
      return lerp(a[1]!, b[1]!, ease(b[2] ?? 0, (t - a[0]!) / (b[0]! - a[0]!)));
    }
  }
  return keys[n - 1]![1]!;
}
/** Vector keyframes: [time, x, y, z, ease?]. Writes into `out`. */
export function trackV(out: THREE.Vector3, t: number, keys: readonly (readonly number[])[]): THREE.Vector3 {
  const n = keys.length;
  const first = keys[0]!;
  if (t <= first[0]!) return out.set(first[1]!, first[2]!, first[3]!);
  for (let i = 1; i < n; i++) {
    const b = keys[i]!;
    if (t < b[0]!) {
      const a = keys[i - 1]!;
      const s = ease(b[4] ?? 0, (t - a[0]!) / (b[0]! - a[0]!));
      return out.set(lerp(a[1]!, b[1]!, s), lerp(a[2]!, b[2]!, s), lerp(a[3]!, b[3]!, s));
    }
  }
  const last = keys[n - 1]!;
  return out.set(last[1]!, last[2]!, last[3]!);
}

// ----------------------------------------------------------------- followers
/**
 * Critically damped follow (SmoothDamp): eases in from rest and settles without overshoot at any frame rate.
 * `omega` ≈ 4 / settle time. The velocity lives in `vel[i]`.
 */
export function follow(cur: number, target: number, vel: Float32Array | number[], i: number, omega: number, dt: number): number {
  if (dt <= 0) return cur;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const change = cur - target;
  const temp = (vel[i]! + omega * change) * dt;
  vel[i] = (vel[i]! - omega * temp) * exp;
  return target + (change + temp) * exp;
}
/** Vector version of `follow`. */
export function followV(cur: THREE.Vector3, target: THREE.Vector3, vel: THREE.Vector3, omega: number, dt: number): void {
  if (dt <= 0) return;
  const x = omega * dt;
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
  const cx = cur.x - target.x;
  const cy = cur.y - target.y;
  const cz = cur.z - target.z;
  const tx = (vel.x + omega * cx) * dt;
  const ty = (vel.y + omega * cy) * dt;
  const tz = (vel.z + omega * cz) * dt;
  vel.set((vel.x - omega * tx) * exp, (vel.y - omega * ty) * exp, (vel.z - omega * tz) * exp);
  cur.set(target.x + (cx + tx) * exp, target.y + (cy + ty) * exp, target.z + (cz + tz) * exp);
}

/** Damped spring around 0 (squash / wobble), stepped at a fixed 1/120 s so it feels the same at any fps. */
export class Spring {
  x = 0;
  v = 0;
  constructor(
    private k: number,
    private c: number,
    private lo = -Infinity,
    private hi = Infinity,
  ) {}
  kick(v: number): void {
    this.v += v;
  }
  step(dt: number): void {
    let left = Math.min(dt, 0.1);
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      this.v += (-this.k * this.x - this.c * this.v) * h;
      this.x += this.v * h;
      left -= h;
    }
    if (this.x < this.lo || this.x > this.hi) {
      this.x = clamp(this.x, this.lo, this.hi);
      this.v *= 0.4;
    }
  }
}

/** Under-damped 0..1 spring for props that pop in / out (slight overshoot = back-out feel). */
export class Pop {
  x = 0;
  v = 0;
  target = 0;
  constructor(
    private k = 320,
    private c = 23,
  ) {}
  step(dt: number): void {
    let left = Math.min(dt, 0.1);
    while (left > 1e-6) {
      const h = Math.min(left, 1 / 120);
      this.v += (this.k * (this.target - this.x) - this.c * this.v) * h;
      this.x += this.v * h;
      left -= h;
    }
    if (this.target === 0 && this.x < 0.004 && Math.abs(this.v) < 0.05) {
      this.x = 0;
      this.v = 0;
    }
  }
  snap(v: number): void {
    this.x = this.target = v;
    this.v = 0;
  }
}

// ------------------------------------------------------------------ arm IK
const _dir = new THREE.Vector3();
const _perp = new THREE.Vector3();
const _u = new THREE.Vector3();
const _f = new THREE.Vector3();
const _e = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();

/**
 * Two-bone IK in the parent space of the shoulder. The arm hangs along local −Y; the elbow bends around its
 * local +X. Writes the shoulder rotation into `outQ` and returns the elbow angle. `pole` hints where the
 * elbow points.
 */
export function solveArm(shoulder: THREE.Vector3, target: THREE.Vector3, pole: THREE.Vector3, a: number, b: number, outQ: THREE.Quaternion): number {
  _dir.subVectors(target, shoulder);
  let d = _dir.length();
  if (d < 1e-5) {
    _dir.set(0, -1, 0);
    d = 1e-5;
  } else _dir.divideScalar(d);
  d = clamp(d, Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const alpha = Math.acos(clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1));
  _perp.copy(pole).addScaledVector(_dir, -pole.dot(_dir));
  if (_perp.lengthSq() < 1e-8) {
    _perp.set(0, 0, -1).addScaledVector(_dir, -_dir.z);
    if (_perp.lengthSq() < 1e-8) _perp.set(1, 0, 0);
  }
  _perp.normalize();
  _u.copy(_dir).multiplyScalar(Math.cos(alpha)).addScaledVector(_perp, Math.sin(alpha));
  _e.copy(shoulder).addScaledVector(_u, a);
  _f.copy(shoulder).addScaledVector(_dir, d).sub(_e).normalize();
  _y.copy(_u).negate();
  _z.copy(_f).addScaledVector(_u, -_f.dot(_u));
  if (_z.lengthSq() < 1e-8) _z.copy(_perp);
  else _z.negate();
  _z.normalize();
  _x.crossVectors(_y, _z).normalize();
  _z.crossVectors(_x, _y);
  _m.makeBasis(_x, _y, _z);
  outQ.setFromRotationMatrix(_m);
  return Math.acos(clamp(_u.dot(_f), -1, 1));
}

/** Keep an IK target within `maxFrac` of the arm's full reach so the elbow always keeps a visible bend. */
export function limitReach(shoulder: THREE.Vector3, target: THREE.Vector3, reach: number, maxFrac = 0.93, minDist = 0.07): void {
  _dir.subVectors(target, shoulder);
  const d = _dir.length();
  const max = reach * maxFrac;
  if (d > max) target.copy(shoulder).addScaledVector(_dir, max / d);
  else if (d < minDist && d > 1e-6) target.copy(shoulder).addScaledVector(_dir, minDist / d);
}

// --------------------------------------------------------------- walk path
/** A polyline walked at constant speed: `at(d)` gives the point d meters along it and the walking yaw. */
export class Path {
  readonly points: THREE.Vector3[];
  private cum: number[] = [0];
  readonly length: number;

  constructor(points: THREE.Vector3[]) {
    this.points = points.length ? points : [new THREE.Vector3()];
    for (let i = 1; i < this.points.length; i++) {
      this.cum.push(this.cum[i - 1]! + this.points[i]!.distanceTo(this.points[i - 1]!));
    }
    this.length = this.cum[this.cum.length - 1]!;
  }

  /** Point at distance `d` (clamped). Returns the yaw of the segment. */
  at(d: number, out: THREE.Vector3): number {
    const n = this.points.length;
    if (n === 1 || this.length < 1e-6) {
      out.copy(this.points[0]!);
      return 0;
    }
    const dd = clamp(d, 0, this.length);
    let i = 1;
    while (i < n - 1 && this.cum[i]! < dd) i++;
    const a = this.points[i - 1]!;
    const b = this.points[i]!;
    const segLen = this.cum[i]! - this.cum[i - 1]!;
    const t = segLen > 1e-6 ? (dd - this.cum[i - 1]!) / segLen : 1;
    out.lerpVectors(a, b, t);
    return Math.atan2(b.x - a.x, b.z - a.z);
  }

  /** Distance along the path of point index i. */
  distOf(i: number): number {
    return this.cum[clamp(i, 0, this.cum.length - 1)]!;
  }

  reversed(): Path {
    return new Path(this.points.slice().reverse());
  }

  /** This path followed by `other` (joined end-to-start). */
  concat(other: Path): Path {
    return new Path([...this.points, ...other.points.slice(1)]);
  }
}

/**
 * Walking route on the floor from `from` to `to` that stays out of a circle of radius `ringR` around the
 * table center: straight when clear, otherwise out to the ring, around it the short way, then in.
 */
export function planPath(from: THREE.Vector3, to: THREE.Vector3, ringR: number): Path {
  return new Path(planPoints(from, to, ringR));
}

/** The points of `planPath` (floor level). */
export function planPoints(from: THREE.Vector3, to: THREE.Vector3, ringR: number): THREE.Vector3[] {
  const a = new THREE.Vector3(from.x, 0, from.z);
  const b = new THREE.Vector3(to.x, 0, to.z);
  if (segmentClear(a, b, ringR - 0.15)) return [a, b];
  const pts: THREE.Vector3[] = [a];
  const ra = Math.hypot(a.x, a.z);
  const rb = Math.hypot(b.x, b.z);
  const angA = Math.atan2(a.z, a.x);
  const angB = Math.atan2(b.z, b.x);
  const startR = Math.max(ringR, Math.min(ra, ringR + 0.6));
  const endR = Math.max(ringR, Math.min(rb, ringR + 0.6));
  if (ra < ringR - 0.05) pts.push(new THREE.Vector3(Math.cos(angA) * ringR, 0, Math.sin(angA) * ringR));
  const delta = wrapAngle(angB - angA);
  const steps = Math.max(1, Math.ceil(Math.abs(delta) / 0.22));
  for (let i = ra < ringR - 0.05 ? 1 : 0; i <= steps; i++) {
    const t = i / steps;
    const ang = angA + delta * t;
    const r = lerp(startR, endR, t);
    const p = new THREE.Vector3(Math.cos(ang) * r, 0, Math.sin(ang) * r);
    if (p.distanceToSquared(pts[pts.length - 1]!) > 0.0025) pts.push(p);
  }
  if (b.distanceToSquared(pts[pts.length - 1]!) > 0.0004) pts.push(b);
  return pts;
}

/** Signed angular direction (+1 = counter-clockwise seen from above in x/z math angles) of the short way a → b. */
export function arcSide(from: THREE.Vector3, to: THREE.Vector3): number {
  return wrapAngle(Math.atan2(to.z, to.x) - Math.atan2(from.z, from.x)) >= 0 ? 1 : -1;
}

function segmentClear(a: THREE.Vector3, b: THREE.Vector3, r: number): boolean {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  const t = len2 > 1e-9 ? clamp(-(a.x * abx + a.z * abz) / len2, 0, 1) : 0;
  const px = a.x + abx * t;
  const pz = a.z + abz * t;
  return px * px + pz * pz >= r * r;
}
