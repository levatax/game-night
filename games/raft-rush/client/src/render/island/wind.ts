// Wind sway injected into toon materials (flora, grass tufts, sails): vertices above `from` meters bend with a
// height-weighted sine whose phase comes from the instance / batch position, so neighbours never move in sync.
// Owner: client-render.

import type * as THREE from "three";

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

/** Patch `material` so its vertices sway with `uniforms` (call once, before first render). */
export function injectWind(material: THREE.Material, uniforms: WindUniforms, opts: WindOptions): void {
  const height = opts.profile === "quadratic" ? "hgt * hgt" : "hgt";
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uniforms.uTime;
    shader.uniforms.uWind = uniforms.uWind;
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;\nuniform float uWind;")
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
          float ph = swayOrigin.x * 0.37 + swayOrigin.z * 0.23;
          float hgt = max(0.0, transformed.y - ${opts.from.toFixed(3)});
          float k = ${height} * (${opts.calm.toFixed(5)} + uWind * ${opts.storm.toFixed(5)});
          transformed.x += (sin(uTime * 1.3 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.4) * k;
          transformed.z += cos(uTime * 1.1 + ph * 1.3) * k * 0.7;
        }`,
      );
  };
  material.customProgramCacheKey = () => opts.key;
}
