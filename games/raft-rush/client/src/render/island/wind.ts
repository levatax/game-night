// Wind sway injected into toon materials (flora, grass tufts, sails): vertices above `from` meters bend with a
// height-weighted profile. The wind is coherent: gust fronts (bands of stronger wind built from a few traveling
// sines along the prevailing heading, the same heading the swell comes from) sweep across the island at
// GUST_SPEED, so a gust visibly rolls through the grass and then the palms instead of every plant shaking on its
// own. Each plant leans downwind with the local gust and flutters on top (phase from the instance / batch
// position, so neighbours never move in sync). Storm (uWind → 1) = stronger, gustier. gustAt() evaluates the same
// gust field on the CPU (sails, smoke drift). Owner: client-render.

import type * as THREE from "three";
import { SWELL_HEADING_DEG } from "./waves";

export interface WindUniforms {
  uTime: { value: number };
  /** 0 calm .. 1 storm. */
  uWind: { value: number };
}

export function createWindUniforms(): WindUniforms {
  return { uTime: { value: 0 }, uWind: { value: 0.3 } };
}

export interface WindOptions {
  /** Height (local, m) where bending starts. */
  from: number;
  /** Bend per m² of height above `from` in calm air and the extra at full wind. */
  calm: number;
  storm: number;
  /** "quadratic" (tall trees) or "linear" (short grass). */
  profile: "quadratic" | "linear";
  /** Program cache key (one per distinct option set). */
  key: string;
}

/** Prevailing wind heading (unit XZ vector the wind blows toward). */
export const WIND_DIR_X = Math.cos((SWELL_HEADING_DEG * Math.PI) / 180);
export const WIND_DIR_Z = Math.sin((SWELL_HEADING_DEG * Math.PI) / 180);
/** Gust fronts travel downwind at this speed (m/s). Constant so the fronts never jump when uWind changes. */
export const GUST_SPEED = 7;

/**
 * Gust strength 0..1 at world (x, z), time t (s), wind 0..1 (calm .. storm): traveling bands along the wind
 * heading, a little cross-wind variation so fronts are not ruler-straight. Mirrors the GLSL in injectWind.
 */
export function gustAt(x: number, z: number, t: number, wind: number): number {
  const along = x * WIND_DIR_X + z * WIND_DIR_Z - t * GUST_SPEED;
  const across = -x * WIND_DIR_Z + z * WIND_DIR_X;
  const g = 0.5 + 0.32 * Math.sin(along * 0.085 + Math.sin(across * 0.06) * 1.2) + 0.18 * Math.sin(along * 0.21 + across * 0.05 + 1.3);
  const gust = g < 0 ? 0 : g > 1 ? 1 : g;
  // Calm air: soft, mostly even; storm: sharper fronts.
  return gust ** (1 + wind * 1.5) * (0.6 + wind * 0.4) + (1 - wind) * 0.15;
}

const GUST_GLSL = /* glsl */ `
  float windGust(vec2 p, float t, float wind) {
    vec2 dir = vec2(${WIND_DIR_X.toFixed(5)}, ${WIND_DIR_Z.toFixed(5)});
    float along = dot(p, dir) - t * ${GUST_SPEED.toFixed(2)};
    float across = dot(p, vec2(-dir.y, dir.x));
    float g = 0.5 + 0.32 * sin(along * 0.085 + sin(across * 0.06) * 1.2) + 0.18 * sin(along * 0.21 + across * 0.05 + 1.3);
    g = clamp(g, 0.0, 1.0);
    return pow(g, 1.0 + wind * 1.5) * (0.6 + wind * 0.4) + (1.0 - wind) * 0.15;
  }
`;

/** Patch `material` so its vertices sway with `uniforms` (call once, before first render). */
export function injectWind(material: THREE.Material, uniforms: WindUniforms, opts: WindOptions): void {
  const height = opts.profile === "quadratic" ? "hgt * hgt" : "hgt";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\nuniform float uTime;\nuniform float uWind;\n${GUST_GLSL}`)
      .replace(
        "#include <begin_vertex>",
        /* glsl */ `#include <begin_vertex>
        {
          vec3 swayOrigin = vec3(0.0);
          #ifdef USE_BATCHING
            swayOrigin = batchingMatrix[3].xyz;
          #endif
          #ifdef USE_INSTANCING
            swayOrigin = instanceMatrix[3].xyz;
          #endif
          vec3 swayWorld = (modelMatrix * vec4(swayOrigin, 1.0)).xyz;
          float ph = swayWorld.x * 0.37 + swayWorld.z * 0.23;
          float hgt = max(0.0, transformed.y - ${opts.from.toFixed(3)});
          float k = ${height} * (${opts.calm.toFixed(5)} + uWind * ${opts.storm.toFixed(5)});
          float gust = windGust(swayWorld.xz, uTime, uWind);
          // Lean downwind with the gust (in the mesh's local frame: rotate the world wind by the instance yaw),
          // plus a flutter that grows with the gust.
          vec2 lean = vec2(${WIND_DIR_X.toFixed(5)}, ${WIND_DIR_Z.toFixed(5)});
          #ifdef USE_BATCHING
            vec2 bx = normalize(batchingMatrix[0].xz + vec2(1e-5, 0.0));
            lean = vec2(dot(lean, bx), dot(lean, vec2(-bx.y, bx.x)));
          #endif
          #ifdef USE_INSTANCING
            vec2 ax = normalize(instanceMatrix[0].xz + vec2(1e-5, 0.0));
            lean = vec2(dot(lean, ax), dot(lean, vec2(-ax.y, ax.x)));
          #endif
          float flutter = sin(uTime * 2.1 + ph) * 0.6 + sin(uTime * 3.7 + ph * 1.7) * 0.4;
          float bend = (0.25 + 0.95 * gust) * k;
          transformed.x += lean.x * bend + flutter * k * (0.3 + 0.5 * gust);
          transformed.z += lean.y * bend + cos(uTime * 1.7 + ph * 1.3) * k * (0.25 + 0.35 * gust);
        }`,
      );
  };
  material.customProgramCacheKey = () => opts.key;
}
