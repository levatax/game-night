// Deterministic pseudo-random helpers for procedural art (same seed → same island every load). Owner:
// client-render. Copied from games/bonk-brawl/client/src/render/noise.ts; adds the island's integer value noise
// (valueNoise2 / fbm2 / ridged2 from shared/island/noise.ts) for cosmetic jitter. Cosmetic code may use
// Math.sin & co. freely — nothing here feeds gameplay.

export { fbm2, ridged2, valueNoise2 } from "../../../shared/island/noise";

/** Mulberry32: tiny fast seeded PRNG returning floats in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stable hash of a string (FNV-1a) for seeding per-island / per-prop randomness. */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Hash of a 2D point in [0, 1). Positions are quantized to millimeters so vertices shared by
 * neighbouring faces (computed from the same coordinates) get identical jitter.
 */
export function hash2(x: number, z: number, seed = 0): number {
  const xi = Math.round(x * 1000);
  const zi = Math.round(z * 1000);
  let h = Math.imul(xi, 374761393) ^ Math.imul(zi, 668265263) ^ Math.imul(seed, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Smooth 1D noise in [-1, 1] built from incommensurate sines (cheap, continuous, no table). */
export function wobble(t: number, phase = 0): number {
  return Math.sin(t * 1.7 + phase) * 0.5 + Math.sin(t * 2.9 + phase * 1.3) * 0.3 + Math.sin(t * 5.3 + phase * 2.1) * 0.2;
}

export function randRange(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

export function pick<T>(rng: () => number, items: ReadonlyArray<T>): T {
  return items[Math.floor(rng() * items.length) % items.length]!;
}

/** Frame-rate independent exponential approach factor: lerp(a, b, smoothing(rate, dt)). */
export function smoothing(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}
