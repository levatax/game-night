// The sea surface as one shared, CPU-evaluable model (the water shader is generated from the same numbers, so
// whatever floats can sample exactly the surface that is drawn): a few long directional swells with sharpened
// crests (vertex-displaced, sampled by waveHeightAt / seaSurfaceY) plus short chop that only bends the
// per-pixel normal. Swells lose height over the shallow shelf (waveAttenuation) and fade out far from the camera
// (that far, nothing samples them). `sea` is the live state Water.update publishes every frame (time, amplitude,
// depth sampler) for floating things elsewhere (raft, bobbers, resting items, the swim camera). No DOM, no three.
// Owner: client-render.

import { WATER_Y } from "../../../../shared/constants";

export interface WaveComponent {
  /** Unit travel direction on the XZ plane. */
  dirX: number;
  dirZ: number;
  /** Wavenumber 2π / wavelength (rad/m). */
  k: number;
  /** Angular speed (rad/s). */
  omega: number;
  /** Relative amplitude (the swells sum to ≈ 1 at a crest, so `amp` reads as meters). */
  amp: number;
  /** Crest sharpening 0..0.5: h = sin θ + q (sin² θ − ½), peaked crests and flat troughs, mean 0. */
  q: number;
  /** Phase offset (rad). */
  phase: number;
}

const G = 9.81;
/** Deep-water dispersion slowed a little: a lazy tropical swell, not a racing one. */
const SPEED = 0.8;

function wave(angleDeg: number, length: number, amp: number, q: number, phase: number): WaveComponent {
  const a = (angleDeg * Math.PI) / 180;
  const k = (Math.PI * 2) / length;
  return { dirX: Math.cos(a), dirZ: Math.sin(a), k, omega: Math.sqrt(G * k) * SPEED, amp, q, phase };
}

/** Prevailing wind / swell heading (degrees on XZ): wind.ts sends its gust fronts the same way. */
export const SWELL_HEADING_DEG = 24;

/** Vertex-displaced swells (long enough for the mesh's 1–4 m cells near the camera). */
export const SWELLS: ReadonlyArray<WaveComponent> = [
  wave(SWELL_HEADING_DEG, 31, 0.46, 0.32, 0),
  wave(SWELL_HEADING_DEG + 38, 18.5, 0.3, 0.26, 1.7),
  wave(SWELL_HEADING_DEG - 47, 12.5, 0.2, 0.2, 4.1),
];

/** Short chop: per-pixel normals only (slope amplitudes, unitless). */
export const CHOP: ReadonlyArray<WaveComponent> = [
  wave(SWELL_HEADING_DEG + 15, 5.3, 0.1, 0, 0.6),
  wave(SWELL_HEADING_DEG - 70, 3.1, 0.07, 0, 2.9),
  wave(SWELL_HEADING_DEG + 95, 1.9, 0.05, 0, 5.3),
  wave(SWELL_HEADING_DEG - 140, 1.15, 0.035, 0, 1.2),
];

/** Crest / trough normaliser: the sharpened profile peaks at 1 + q/2. */
function norm(w: WaveComponent): number {
  return w.amp / (1 + w.q * 0.5);
}

/**
 * Swell displacement (m) at world (x, z), time `t` (s), for a wave amplitude `amp` (Lighting.waveAmp: ~0.12 calm,
 * > 1 in the storm), before the shelf attenuation. Same formula as the water vertex shader.
 */
export function waveHeightAt(x: number, z: number, t: number, amp = sea.amp): number {
  let h = 0;
  for (let i = 0; i < SWELLS.length; i++) {
    const w = SWELLS[i]!;
    const s = Math.sin((x * w.dirX + z * w.dirZ) * w.k - t * w.omega + w.phase);
    h += norm(w) * (s + w.q * (s * s - 0.5));
  }
  return h * amp;
}

/** Swell slope (∂h/∂x, ∂h/∂z) at (x, z, t), written into `out` (no allocation). */
export function waveSlopeAt(x: number, z: number, t: number, amp: number, out: { x: number; z: number }): { x: number; z: number } {
  let dx = 0;
  let dz = 0;
  for (let i = 0; i < SWELLS.length; i++) {
    const w = SWELLS[i]!;
    const th = (x * w.dirX + z * w.dirZ) * w.k - t * w.omega + w.phase;
    const s = Math.sin(th);
    const d = norm(w) * Math.cos(th) * (1 + 2 * w.q * s) * w.k;
    dx += d * w.dirX;
    dz += d * w.dirZ;
  }
  out.x = dx * amp;
  out.z = dz * amp;
  return out;
}

/** Swell height kept at `depth` m of water: a small lap at the waterline, the full swell past the shelf. */
export function waveAttenuation(depth: number): number {
  return 0.22 + 0.78 * smoothstep(0.15, 3.2, depth);
}

/** Live sea state, published by Water.update every frame. */
export interface SeaState {
  /** Water clock (s): the same `elapsed` the shader animates with. */
  time: number;
  /** Wave amplitude (m) = Lighting.waveAmp. */
  amp: number;
  /** 0 calm .. 1 storm, from the amplitude. */
  storm: number;
  /** Water depth (m, ≤ 0 on land) at a world point; null before an island is loaded (= open sea). */
  depthAt: ((x: number, z: number) => number) | null;
}

export const sea: SeaState = { time: 0, amp: 0.12, storm: 0, depthAt: null };

export function setSeaState(time: number, amp: number, depthAt?: ((x: number, z: number) => number) | null): void {
  sea.time = time;
  sea.amp = amp;
  sea.storm = clamp01((amp - 0.25) / 0.85);
  if (depthAt !== undefined) sea.depthAt = depthAt;
}

/** Depth at (x, z) from the live sea state (open sea when no island is loaded). */
export function seaDepthAt(x: number, z: number): number {
  return sea.depthAt ? sea.depthAt(x, z) : 10;
}

/** The drawn water surface height (world y) at (x, z) right now: WATER_Y + the attenuated swell. */
export function seaSurfaceY(x: number, z: number): number {
  return WATER_Y + waveHeightAt(x, z, sea.time, sea.amp) * waveAttenuation(seaDepthAt(x, z));
}

function smoothstep(a: number, b: number, v: number): number {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function f(v: number): string {
  const s = v.toFixed(6);
  return s.includes(".") ? s : `${s}.0`;
}

function glslTerm(w: WaveComponent, body: (th: string, n: string, w: WaveComponent) => string): string {
  const th = `(dot(p, vec2(${f(w.dirX)}, ${f(w.dirZ)})) * ${f(w.k)} - t * ${f(w.omega)} + ${f(w.phase)})`;
  return body(th, f(norm(w)), w);
}

/**
 * GLSL for the shaders (generated from SWELLS / CHOP so CPU and GPU agree):
 *   float swellHeight(vec2 p, float t)   — unit-amplitude swell (× waveAmp × attenuation)
 *   vec2  swellSlope(vec2 p, float t)    — its gradient
 *   vec2  chopSlope(vec2 p, float t)     — short chop gradient (normals only)
 *   float waveAtten(float depth)
 */
export const WAVES_GLSL = /* glsl */ `
  float swellHeight(vec2 p, float t) {
    float h = 0.0;
    float s;
${SWELLS.map((w) => glslTerm(w, (th, n, c) => `    s = sin(${th});\n    h += ${n} * (s + ${f(c.q)} * (s * s - 0.5));`)).join("\n")}
    return h;
  }
  vec2 swellSlope(vec2 p, float t) {
    vec2 g = vec2(0.0);
    float th;
${SWELLS.map((w) => glslTerm(w, (th, n, c) => `    th = ${th};\n    g += vec2(${f(c.dirX)}, ${f(c.dirZ)}) * (${n} * cos(th) * (1.0 + ${f(2 * c.q)} * sin(th)) * ${f(c.k)});`)).join("\n")}
    return g;
  }
  vec2 chopSlope(vec2 p, float t) {
    vec2 g = vec2(0.0);
${CHOP.map((w) => glslTerm(w, (th, _n, c) => `    g += vec2(${f(c.dirX)}, ${f(c.dirZ)}) * (${f(c.amp)} * cos(${th}));`)).join("\n")}
    return g;
  }
  float waveAtten(float depth) {
    return 0.22 + 0.78 * smoothstep(0.15, 3.2, depth);
  }
`;
