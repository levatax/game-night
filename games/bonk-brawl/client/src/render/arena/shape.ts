// Geometry of the arena outline in its shape metric (circle or superellipse rounded square).

import type { ArenaShape } from "../../../../shared/maps";

/**
 * Euclidean distance from the center to the point at `angle` whose shape distance is `radius`.
 * Circle: radius. Rounded square ((|x|^4 + |z|^4)^(1/4) = r): r / (|cos|^4 + |sin|^4)^(1/4).
 */
export function boundaryRadius(shape: ArenaShape, radius: number, angle: number): number {
  if (shape === "circle") return radius;
  const c = Math.abs(Math.cos(angle));
  const s = Math.abs(Math.sin(angle));
  return radius / Math.pow(c * c * c * c + s * s * s * s, 0.25);
}

/** Point on the outline of shape-radius `radius` at `angle` (x = cos, z = sin). */
export function boundaryPoint(shape: ArenaShape, radius: number, angle: number): { x: number; z: number } {
  const r = boundaryRadius(shape, radius, angle);
  return { x: Math.cos(angle) * r, z: Math.sin(angle) * r };
}

/** Polar angle of (x, z) in the same convention as boundaryPoint, in [0, 2π). */
export function angleOf(x: number, z: number): number {
  const a = Math.atan2(z, x);
  return a < 0 ? a + Math.PI * 2 : a;
}
