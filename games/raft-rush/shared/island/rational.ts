// Trig-free directions and rotations for the island generator. Owner: island.
//
// Gameplay placement must be bit-identical on every JS engine, and Math.sin/cos/atan2 are not (engines may use
// different approximations). So the generator never derives a direction from an angle: rotations come from
// Pythagorean triples (exact rational cos/sin), unit directions are small integer vectors normalized with
// Math.sqrt (correctly rounded everywhere), and "which way around the island" uses the diamond angle (a
// monotonic stand-in for atan2 built from + − ÷ only).

/** A rotation by an angle whose cos/sin are exact rationals (c² + s² = 1 up to one rounding). */
export interface Rot {
  c: number;
  s: number;
}

/** Primitive Pythagorean triples (a, b, c) with angles atan(b/a) spread over [0°, 45°]. */
const TRIPLES: ReadonlyArray<readonly [number, number, number]> = [
  [84, 13, 85], // 8.8°
  [60, 11, 61], // 10.4°
  [40, 9, 41], // 12.7°
  [63, 16, 65], // 14.3°
  [24, 7, 25], // 16.3°
  [35, 12, 37], // 18.9°
  [12, 5, 13], // 22.6°
  [77, 36, 85], // 25.1°
  [15, 8, 17], // 28.1°
  [56, 33, 65], // 30.5°
  [45, 28, 53], // 31.9°
  [4, 3, 5], // 36.9°
  [55, 48, 73], // 41.1°
  [72, 65, 97], // 42.1°
  [21, 20, 29], // 43.6°
];

/**
 * Every rotation the island shape may use: identity, a quarter turn and each triple's angle mirrored into all
 * four of ±θ, ±(90° − θ). An ellipse looks the same after a half turn, so this covers every orientation.
 */
export const ISLAND_ROTATIONS: ReadonlyArray<Rot> = (() => {
  const out: Rot[] = [
    { c: 1, s: 0 },
    { c: 0, s: 1 },
  ];
  for (const [a, b, c] of TRIPLES) {
    out.push({ c: a / c, s: b / c }, { c: b / c, s: a / c }, { c: a / c, s: -b / c }, { c: b / c, s: -a / c });
  }
  return out;
})();

/** Rotate (x, z) by `rot` (counter-clockwise from +x toward +z). */
export function rotX(x: number, z: number, rot: Rot): number {
  return x * rot.c - z * rot.s;
}

/** z component of (x, z) rotated by `rot`. */
export function rotZ(x: number, z: number, rot: Rot): number {
  return x * rot.s + z * rot.c;
}

/** ≈ ±16.3° (7-24-25) and ≈ ±36.9° (3-4-5): used to fan rays around a direction. */
export const ROT_16: Rot = { c: 24 / 25, s: 7 / 25 };
export const ROT_37: Rot = { c: 4 / 5, s: 3 / 5 };
export const ROT_M16: Rot = { c: 24 / 25, s: -7 / 25 };
export const ROT_M37: Rot = { c: 4 / 5, s: -3 / 5 };

/** Integer vectors at ≈ 0°, 11.3°, 22.6°, 33.7°, 45°, 56.3°, 67.4°, 78.7° (one quadrant, ~11.25° steps). */
const QUADRANT: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [5, 1],
  [12, 5],
  [3, 2],
  [1, 1],
  [2, 3],
  [5, 12],
  [1, 5],
];

/** 32 unit directions around the circle (~11.25° apart), in increasing angle from +x toward +z. */
export const DIRS32: ReadonlyArray<{ x: number; z: number }> = (() => {
  const out: { x: number; z: number }[] = [];
  for (let q = 0; q < 4; q++) {
    for (const [a, b] of QUADRANT) {
      // Quarter turns of (a, b): (a, b) → (−b, a) → (−a, −b) → (b, −a).
      const x = q === 0 ? a : q === 1 ? -b : q === 2 ? -a : b;
      const z = q === 0 ? b : q === 1 ? a : q === 2 ? -b : -a;
      const len = Math.sqrt(x * x + z * z);
      out.push({ x: x / len, z: z / len });
    }
  }
  return out;
})();

/** Every other entry of DIRS32: 16 unit directions (~22.5° apart). */
export const DIRS16: ReadonlyArray<{ x: number; z: number }> = DIRS32.filter((_, k) => k % 2 === 0);

/** Every fourth entry of DIRS32: the 8 compass directions. */
export const DIRS8: ReadonlyArray<{ x: number; z: number }> = DIRS32.filter((_, k) => k % 4 === 0);

/**
 * Diamond angle of (dx, dz) in [0, 4): 0 = +x, 1 = +z, 2 = −x, 3 = −z. Monotonic in the true angle, so it
 * orders points around a center exactly like atan2 would, with + − ÷ only. (0, 0) maps to 0.
 */
export function diamondAngle(dx: number, dz: number): number {
  const ax = dx < 0 ? -dx : dx;
  const az = dz < 0 ? -dz : dz;
  const sum = ax + az;
  if (sum === 0) return 0;
  if (dz >= 0) return dx >= 0 ? dz / sum : 1 - dx / sum;
  return dx < 0 ? 2 - dz / sum : 3 + dx / sum;
}
