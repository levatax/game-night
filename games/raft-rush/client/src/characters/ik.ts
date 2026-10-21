// Critically damped followers, a two-bone arm IK solver and a reach limiter for the first-person arms.
// Owner: client-characters. Copied from games/kasala/client/src/scene/characters/util.ts.

import * as THREE from "three";

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

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
