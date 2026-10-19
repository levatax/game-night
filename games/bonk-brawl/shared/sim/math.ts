// Tiny vec3 / scalar helpers on plain {x, y, z} objects. Shared by server and client sim code.
// Owner: sim (written by the architect, complete). Pure functions; `out` params avoid allocation.
// Conventions (TECH_BRIEF §2): Y up, yaw 0 faces -Z, forward = (-sin yaw, 0, -cos yaw),
// right = (cos yaw, 0, -sin yaw), positive pitch looks up.

import type { Vec3Like } from "../types.js";

export type Vec3 = Vec3Like;

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function clone(a: Vec3): Vec3 {
  return { x: a.x, y: a.y, z: a.z };
}

export function set(out: Vec3, x: number, y: number, z: number): Vec3 {
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function copy(out: Vec3, a: Vec3): Vec3 {
  out.x = a.x;
  out.y = a.y;
  out.z = a.z;
  return out;
}

export function add(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x + b.x, a.y + b.y, a.z + b.z);
}

export function sub(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x - b.x, a.y - b.y, a.z - b.z);
}

export function scale(a: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x * s, a.y * s, a.z * s);
}

/** out = a + b * s */
export function addScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x + b.x * s, a.y + b.y * s, a.z + b.z * s);
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function cross(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3 {
  return set(out, a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
}

export function lengthSq(a: Vec3): number {
  return a.x * a.x + a.y * a.y + a.z * a.z;
}

export function length(a: Vec3): number {
  return Math.sqrt(lengthSq(a));
}

/** Horizontal (XZ) length. */
export function length2D(a: Vec3): number {
  return Math.hypot(a.x, a.z);
}

export function distSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function dist(a: Vec3, b: Vec3): number {
  return Math.sqrt(distSq(a, b));
}

/** Horizontal (XZ) distance. */
export function dist2D(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Unit vector; returns (0,0,0) for a zero vector. */
export function normalize(a: Vec3, out: Vec3 = vec3()): Vec3 {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len, out) : set(out, 0, 0, 0);
}

export function lerpVec(a: Vec3, b: Vec3, t: number, out: Vec3 = vec3()): Vec3 {
  return set(out, a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
}

/** Clamp the length of `a` to at most `max`. */
export function clampLength(a: Vec3, max: number, out: Vec3 = vec3()): Vec3 {
  const len = length(a);
  return len > max && len > 1e-9 ? scale(a, max / len, out) : copy(out, a);
}

/* ---------------------------------------------------------------- scalars */

export function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Move `current` toward `target` by at most `maxDelta`. */
export function approach(current: number, target: number, maxDelta: number): number {
  if (current < target) return Math.min(current + maxDelta, target);
  return Math.max(current - maxDelta, target);
}

export const TAU = Math.PI * 2;

/** Wrap an angle to (-PI, PI]. */
export function wrapAngle(a: number): number {
  let r = a % TAU;
  if (r <= -Math.PI) r += TAU;
  else if (r > Math.PI) r -= TAU;
  return r;
}

/** Shortest signed difference b - a in (-PI, PI]. */
export function angleDelta(a: number, b: number): number {
  return wrapAngle(b - a);
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return wrapAngle(a + angleDelta(a, b) * t);
}

/** Frame-rate independent exponential smoothing factor: 1 - exp(-dt / tau). */
export function smoothFactor(dt: number, tau: number): number {
  return tau <= 0 ? 1 : 1 - Math.exp(-dt / tau);
}

/* ------------------------------------------------------- yaw / pitch frame */

/** Horizontal forward unit vector for a yaw: (-sin yaw, 0, -cos yaw). */
export function forwardFromYaw(yaw: number, out: Vec3 = vec3()): Vec3 {
  return set(out, -Math.sin(yaw), 0, -Math.cos(yaw));
}

/** Horizontal right unit vector for a yaw: (cos yaw, 0, -sin yaw). */
export function rightFromYaw(yaw: number, out: Vec3 = vec3()): Vec3 {
  return set(out, Math.cos(yaw), 0, -Math.sin(yaw));
}

/** Look direction: (-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch)). */
export function dirFromYawPitch(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3 {
  const cp = Math.cos(pitch);
  return set(out, -Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

/** Yaw that looks along horizontal direction (dx, dz): atan2(-dx, -dz). */
export function yawFromDir(dx: number, dz: number): number {
  return Math.atan2(-dx, -dz);
}

/** Pitch of a direction vector. */
export function pitchFromDir(d: Vec3): number {
  return Math.atan2(d.y, Math.hypot(d.x, d.z));
}

/** Rotate a horizontal vector around Y by `angle` (same sense as yaw: positive turns left). */
export function rotateY(a: Vec3, angle: number, out: Vec3 = vec3()): Vec3 {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return set(out, a.x * c + a.z * s, a.y, -a.x * s + a.z * c);
}
