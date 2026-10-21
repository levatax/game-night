// Deterministic integer-hash noise for island generation. Owner: island (written by the architect, complete).
//
// Bit-identical on every JS engine: only Math.imul, bit ops, + − × ÷ and Math.floor are used (no Math.sin/cos/
// pow/exp). Inputs are doubles; lattice coordinates are floored to int32.

/** 32-bit hash of an integer lattice point and a seed → uint32. */
export function hash2(ix: number, iz: number, seed: number): number {
  let h = (seed ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (ix | 0), 0x85ebca6b);
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h ^ (iz | 0), 0xc2b2ae35);
  h = (h ^ (h >>> 16)) >>> 0;
  h = Math.imul(h, 0x27d4eb2d);
  return (h ^ (h >>> 15)) >>> 0;
}

/** hash2 mapped to [0, 1). */
export function hash01(ix: number, iz: number, seed: number): number {
  return hash2(ix, iz, seed) / 4294967296;
}

/** 3t² − 2t³ on [0, 1] (clamped). */
export function smoothstep01(t: number): number {
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/** smoothstep(edge0, edge1, x) like GLSL (edge0 may be > edge1). */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  return smoothstep01((x - edge0) / (edge1 - edge0));
}

/** Value noise in [0, 1): bilinear between lattice hashes with smoothstep weights. */
export function valueNoise2(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = smoothstep01(x - ix);
  const fz = smoothstep01(z - iz);
  const a = hash01(ix, iz, seed);
  const b = hash01(ix + 1, iz, seed);
  const c = hash01(ix, iz + 1, seed);
  const d = hash01(ix + 1, iz + 1, seed);
  const ab = a + (b - a) * fx;
  const cd = c + (d - c) * fx;
  return ab + (cd - ab) * fz;
}

/**
 * Fractal sum of `octaves` value-noise layers (frequency ×2, amplitude ×0.5 per octave, each octave seeded
 * differently). Normalized to [0, 1).
 */
export function fbm2(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise2(x * f, z * f, (seed + Math.imul(o + 1, 0x632be5ab)) | 0) * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Ridged variant (1 − |2n − 1|) for cliffs / rocky biome, normalized to [0, 1]. */
export function ridged2(x: number, z: number, seed: number, octaves = 4): number {
  let sum = 0;
  let amp = 1;
  let norm = 0;
  let f = 1;
  for (let o = 0; o < octaves; o++) {
    const n = valueNoise2(x * f, z * f, (seed + Math.imul(o + 7, 0x5bd1e995)) | 0);
    const r = 1 - Math.abs(2 * n - 1);
    sum += r * r * amp;
    norm += amp;
    amp *= 0.5;
    f *= 2;
  }
  return sum / norm;
}

/** Mulberry32 PRNG: deterministic, uint32 seed → () => [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive an independent sub-seed (e.g. per generation stage) from a seed and a small salt. */
export function subSeed(seed: number, salt: number): number {
  return hash2(salt, 0x1234567, seed);
}

/** FNV-1a 32-bit over bytes. */
export function fnv1a(bytes: Uint8Array, h = 0x811c9dc5): number {
  let x = h >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    x ^= bytes[i]!;
    x = Math.imul(x, 0x01000193) >>> 0;
  }
  return x >>> 0;
}

/** FNV-1a 32-bit over a list of int32 values (little-endian bytes). */
export function fnv1aInts(values: ArrayLike<number>, h = 0x811c9dc5): number {
  let x = h >>> 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]! | 0;
    for (let b = 0; b < 4; b++) {
      x ^= (v >>> (b * 8)) & 0xff;
      x = Math.imul(x, 0x01000193) >>> 0;
    }
  }
  return x >>> 0;
}
