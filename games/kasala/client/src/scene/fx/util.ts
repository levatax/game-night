// Math, easing and timing helpers shared by Cards, Wheel and Fx. Owner: client-cards-fx.

import { TABLE_RADIUS, TABLE_TOP_Y } from "../Stage";

export const TAU = Math.PI * 2;

export const rand = (a: number, b: number): number => a + Math.random() * (b - a);
export const pick = <T>(arr: readonly T[]): T => arr[(Math.random() * arr.length) | 0]!;
export const clamp = (v: number, a: number, b: number): number => (v < a ? a : v > b ? b : v);
export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const smoothstep = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
/** Frame-rate independent exponential approach of `cur` toward `target`. */
export const damp = (cur: number, target: number, lambda: number, dt: number): number =>
  lerp(cur, target, 1 - Math.exp(-lambda * dt));

export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - t, 3);
export const easeOutQuart = (t: number): number => 1 - Math.pow(1 - t, 4);
export const easeInCubic = (t: number): number => t * t * t;
export const easeInQuad = (t: number): number => t * t;
export const easeOutQuad = (t: number): number => 1 - (1 - t) * (1 - t);
export const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
export const easeInOutSine = (t: number): number => -(Math.cos(Math.PI * t) - 1) / 2;
export const easeInOutQuad = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeOutBack = (t: number, s = 1.70158): number => {
  const c3 = s + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + s * Math.pow(t - 1, 2);
};
export const easeInBack = (t: number, s = 1.70158): number => (s + 1) * t * t * t - s * t * t;
export const easeOutElastic = (t: number): number =>
  t <= 0 ? 0 : t >= 1 ? 1 : Math.pow(2, -10 * t) * Math.sin((t * 10 - 0.75) * (TAU / 3)) + 1;

/** Angle wrapped into (−π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Frame-rate independent approach of angle `cur` toward `target` along the shorter way round. */
export const dampAngle = (cur: number, target: number, lambda: number, dt: number): number =>
  cur + wrapAngle(target - cur) * (1 - Math.exp(-lambda * dt));

/** Wall clock in ms. Animations that must land on server time use this instead of the (scaled) visual dt. */
export const nowMs = (): number => performance.now();

/** Deterministic pseudo-random [0, 1) from a number (identical on every client). */
export function hash01(n: number): number {
  const x = Math.sin(n * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * Height of the surface under (x, z): the felt inside the table radius, else the floor. `fromY` is where the
 * falling thing was a moment ago: something already below the felt (it fell past the rim) lands on the floor.
 */
export function surfaceY(x: number, z: number, fromY = Infinity): number {
  return x * x + z * z < TABLE_RADIUS * TABLE_RADIUS && fromY >= TABLE_TOP_Y - 0.02 ? TABLE_TOP_Y : 0;
}

/** Relative luminance (0..1) of a #RRGGBB color, for picking readable text colors. */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace("#", ""), 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** #RRGGBB lightened (k > 0) toward white or darkened (k < 0) toward black. */
export function shade(hex: string, k: number): string {
  const n = parseInt(hex.replace("#", ""), 16);
  const ch = (v: number) => {
    const out = k >= 0 ? v + (255 - v) * k : v * (1 + k);
    return Math.round(clamp(out, 0, 255)).toString(16).padStart(2, "0");
  };
  return `#${ch((n >> 16) & 255)}${ch((n >> 8) & 255)}${ch(n & 255)}`;
}
