// The sea (game4.md §16): one camera-following 440 m plane whose grid is dense under the camera (~1 m cells) and
// coarse toward the fogged rim (88 × 88 segments ≈ 15.5k triangles, one draw call). The surface is the shared
// wave model of waves.ts: three long directional swells with sharpened crests displace the vertices (the same
// height floating things sample with seaSurfaceY), short chop only bends the per-pixel normal. Swells lose height
// over the shallow shelf and fade out far from the camera. Depth color from the shore field (muted turquoise over
// the shelf → teal → deep teal-navy, opaque over the deep sea), crest lightening, a horizon-tinted fresnel,
// a soft broad sun / moon highlight plus a few glints, an off-white foam lip that laps up and down the beach,
// broken foam lines rolling in over the long shallow shelves, storm whitecaps, foamy fish spots and rain ripples.
// Lighting colors are capped in saturation so the sea stays naturalistic whatever the grade does. Owner:
// client-render.

import * as THREE from "three";
import { BIOME_IDS, BIOMES, FISH_SPOT_RADIUS, FISH_SPOTS_MAX, WATER_Y } from "../../../../shared/constants";
import { heightAt } from "../../../../shared/island/heightfield";
import type { FishSpotDef, Heightfield } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import type { Lighting } from "../sky/DayNight";
import { buildShoreField, SHORE_DEPTH_MAX, SHORE_DIST_MAX, type ShoreField } from "./shoreField";
import { setSeaState, WAVES_GLSL } from "./waves";

export { seaSurfaceY, waveHeightAt, waveSlopeAt } from "./waves";

/** Plane size (m): its rim (fogged out from ~0.36 × SIZE) sits past the clearest day fog (FOG_DAY 200 m). */
const SIZE = 440;
const SEGMENTS = 88;
/** Grid warp: x = HALF (a u + (1 − a) u³), u ∈ [−1, 1]. a = 0.18 gives ~0.9 m cells under the camera. */
const WARP_LINEAR = 0.18;
/** The plane follows the camera in steps of this many meters (the waves are world-space: nothing swims). */
const FOLLOW_STEP = 2;
/** Swell displacement fades out between these distances from the camera (m): beyond, a flat cheap sea. */
const SWELL_FADE_NEAR = 60;
const SWELL_FADE_FAR = 125;
/** Fish spots the shader knows about (duel: two islands × the richest biome's max, 2 × (7 + 2) = 18). */
export const MAX_WATER_SPOTS = 2 * (FISH_SPOTS_MAX + Math.max(...BIOME_IDS.map((b) => BIOMES[b].extraFishSpots)));

const FADE_GLSL = `(1.0 - smoothstep(${SWELL_FADE_NEAR.toFixed(1)}, ${SWELL_FADE_FAR.toFixed(1)}, distance(world.xz, center)))`;

const VERTEX = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  uniform float time;
  uniform float waveAmp;
  uniform vec2 center;
  uniform sampler2D shore;
  uniform vec4 shoreRect;
  varying vec3 vWorld;
  varying float vSwell;
  varying float vAmp;
  ${WAVES_GLSL}

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec4 s = texture2D(shore, (world.xz - shoreRect.xy) / shoreRect.zw);
    float depth = s.r * ${SHORE_DEPTH_MAX.toFixed(1)};
    float amp = waveAmp * waveAtten(depth) * ${FADE_GLSL};
    float h = swellHeight(world.xz, time);
    world.y += amp * h;
    vWorld = world.xyz;
    vSwell = h;
    vAmp = amp;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float time;
  uniform float waveAmp;
  uniform vec3 seaColor;
  uniform vec3 shallowColor;
  uniform vec3 deepColor;
  uniform vec3 foamColor;
  uniform vec3 horizonColor;
  uniform vec3 keyDir;
  uniform vec3 keyColor;
  uniform float keyIntensity;
  uniform vec3 ambient;
  uniform float glint;
  uniform float rain;
  uniform vec2 center;
  uniform sampler2D shore;
  uniform vec4 shoreRect;
  uniform vec3 spots[${MAX_WATER_SPOTS}];
  uniform int spotCount;
  varying vec3 vWorld;
  varying float vSwell;
  varying float vAmp;
  ${WAVES_GLSL}

  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x), mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
  }

  void main() {
    // Per-pixel shore data (smoother than per-vertex on the coarse outer cells).
    vec4 s = texture2D(shore, (vWorld.xz - shoreRect.xy) / shoreRect.zw);
    float depth = s.r * ${SHORE_DEPTH_MAX.toFixed(1)};
    float coast = s.g * ${SHORE_DIST_MAX.toFixed(1)};

    // Distance LOD: near the camera chop, foam breakup, fish bursts, ripples and glints; past ~70 m they fade to
    // a flat, cheap sea (the far water is fogged anyway).
    float camDist = distance(cameraPosition, vWorld);
    float far = smoothstep(70.0, 130.0, camDist);

    // Normal: the displaced swell's analytic slope (same amplitude as the vertex) + short chop.
    vec2 g = swellSlope(vWorld.xz, time) * vAmp;
    if (far < 1.0) {
      float chopK = (0.5 + min(waveAmp, 1.2) * 0.55 + rain * 0.25) * (1.0 - far) * mix(0.45, 1.0, smoothstep(0.1, 1.5, depth));
      g += chopSlope(vWorld.xz, time) * chopK;
    }
    vec3 n = normalize(vec3(-g.x, 1.0, -g.y));
    vec3 v = normalize(cameraPosition - vWorld);

    // Depth color: shallow over the shelf → sea → deep, crests a touch lighter (light through the wave).
    vec3 col = mix(shallowColor, seaColor, smoothstep(0.1, 2.6, depth));
    col = mix(col, deepColor, smoothstep(2.6, 5.6, depth));
    col *= 0.94 + 0.1 * clamp(vSwell * 0.7 + 0.45, 0.0, 1.0);
    float ndl = max(dot(n, keyDir), 0.0);
    float band = mix(0.87, 1.0, smoothstep(0.45, 0.62, ndl));
    col *= ambient + keyColor * keyIntensity * band * 0.2;
    // Grazing angles reflect the haze at the horizon.
    float fres = pow(1.0 - max(dot(n, v), 0.0), 4.0);
    col = mix(col, horizonColor, fres * 0.32);

    // Foam lip lapping up and down the beach.
    float breakup = 0.5;
    if (far < 1.0) breakup = vnoise(vWorld.xz * 0.55 + vec2(time * 0.13, 0.0));
    float lap = 0.5 + 0.5 * sin(time * 0.85 + breakup * 2.0 + vWorld.x * 0.05);
    float foam = 1.0 - smoothstep(0.12 + lap * 0.3, 0.45 + lap * 0.45, coast + breakup * 0.22);
    // Broken foam lines rolling in over the shallow shelf (thin bands travelling toward the coast).
    float shoal = (1.0 - smoothstep(0.35, 1.7, depth)) * (1.0 - smoothstep(1.2, 6.5, coast));
    if (shoal > 0.001 && far < 1.0) {
      float roll = fract(coast * 0.38 + time * 0.22 + breakup * 0.3);
      float line = smoothstep(0.0, 0.035, roll) * (1.0 - smoothstep(0.06, 0.2, roll));
      float patchy = smoothstep(0.3, 0.6, vnoise(vWorld.xz * vec2(0.9, 0.7) + vec2(0.0, time * 0.2)));
      foam = max(foam, line * patchy * shoal * 0.8);
    }
    // Storm whitecaps on the swell crests.
    float caps = smoothstep(0.78, 1.05, vSwell) * smoothstep(0.35, 1.0, waveAmp) * step(0.45, breakup);
    foam = max(foam, caps * 0.75);
    foam *= 1.0 - far;

    // Fish spots: bubbling foam patches with a pulsing ring.
    if (far < 0.85) {
      for (int i = 0; i < ${MAX_WATER_SPOTS}; i++) {
        if (i >= spotCount) break;
        vec3 sp = spots[i];
        float d = distance(vWorld.xz, sp.xy);
        float r = ${FISH_SPOT_RADIUS.toFixed(2)};
        if (d < r * 1.3) {
          float bub = step(0.7, vnoise(vWorld.xz * 2.6 + vec2(time * 1.7, -time * 1.3)));
          float inner = 1.0 - smoothstep(r * 0.45, r * 0.95, d);
          float pulse = fract(time * 0.45 + sp.z);
          float ring = 1.0 - smoothstep(0.0, 0.12, abs(d - r * (0.35 + 0.75 * pulse)));
          foam = max(foam, max(bub * inner, ring * (1.0 - pulse) * 0.9));
        }
      }
    }

    // Rain ripples: expanding rings on a 1.6 m jittered lattice.
    if (rain > 0.01 && far < 0.9) {
      vec2 cell = floor(vWorld.xz / 1.6);
      vec2 local = fract(vWorld.xz / 1.6) - 0.5;
      float ph = hash12(cell);
      float t = fract(time * 1.3 + ph);
      vec2 off = vec2(hash12(cell + 7.1), hash12(cell + 3.7)) - 0.5;
      float rr = length(local - off * 0.5) * 1.6;
      float ripple = (1.0 - smoothstep(0.0, 0.05, abs(rr - t * 0.55))) * (1.0 - t) * step(ph, rain);
      foam = max(foam, ripple * 0.7);
    }

    // Soft broad highlight + a few glints (sun by day, the moon path by night).
    vec3 refl = reflect(-v, n);
    float spec = pow(max(dot(refl, keyDir), 0.0), 90.0) * 0.16 * glint;
    float sparkle = 0.0;
    if (far < 0.95) {
      vec2 jitter = vec2(vnoise(vWorld.xz * 1.3 + time * 0.6), vnoise(vWorld.zx * 1.3 - time * 0.5)) - 0.5;
      vec3 gn = normalize(n + vec3(jitter.x, 0.0, jitter.y) * 0.3);
      sparkle = smoothstep(0.984, 0.992, dot(reflect(-v, gn), keyDir)) * glint * (1.0 - far);
    }

    // Opaque past 2.2 m: Terrain skips seabed cells deeper than 2.4 m, and any see-through there shows the
    // jagged edge of the skipped cells against the clear color.
    float alpha = mix(0.5, 1.0, smoothstep(0.0, 2.2, depth));
    col = mix(col, foamColor * 0.92, clamp(foam, 0.0, 1.0) * 0.88);
    alpha = max(alpha, foam);
    col += keyColor * (spec + sparkle * 0.75);
    alpha = max(alpha, sparkle);

    gl_FragColor = vec4(col, alpha);
    // three's order (tone map → output color space → fog): fogColor arrives in the output space on the direct path.
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
    #ifdef USE_FOG
      // The far rim of the camera-following plane melts into the fog color (no visible edge).
      float rim = smoothstep(${(SIZE * 0.36).toFixed(1)}, ${(SIZE * 0.49).toFixed(1)}, distance(vWorld.xz, center));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, rim);
    #endif
  }
`;

/** Saturation / lightness caps (sRGB HSL) on the Lighting sea colors: muted turquoise → teal-navy, never cyan. */
const CAP_SHALLOW = { s: 0.36, l: 0.5 };
const CAP_SEA = { s: 0.46, l: 0.4 };
const CAP_DEEP = { s: 0.52, l: 0.26 };
const CAP_FOAM = { s: 0.12, l: 0.9 };
const hsl = { h: 0, s: 0, l: 0 };

function capColor(target: THREE.Color, source: THREE.Color, cap: { s: number; l: number }): void {
  target.copy(source).getHSL(hsl, THREE.SRGBColorSpace);
  if (hsl.s <= cap.s && hsl.l <= cap.l) return;
  target.setHSL(hsl.h, Math.min(hsl.s, cap.s), Math.min(hsl.l, cap.l), THREE.SRGBColorSpace);
}

/** Plane geometry: a uniform grid warped so cells are small under the camera and grow toward the rim. */
function seaGeometry(): THREE.BufferGeometry {
  const geometry = new THREE.PlaneGeometry(2, 2, SEGMENTS, SEGMENTS);
  const pos = geometry.getAttribute("position") as THREE.BufferAttribute;
  const half = SIZE / 2;
  const warp = (u: number) => Math.sign(u) * half * (WARP_LINEAR * Math.abs(u) + (1 - WARP_LINEAR) * Math.abs(u) ** 3);
  for (let i = 0; i < pos.count; i++) pos.setXY(i, warp(pos.getX(i)), warp(pos.getY(i)));
  geometry.rotateX(-Math.PI / 2);
  geometry.computeBoundingSphere();
  return geometry;
}

export class Water {
  readonly mesh: THREE.Mesh;
  /** Triangles in the sea plane (budget readout). */
  static readonly triangles = SEGMENTS * SEGMENTS * 2;
  private readonly material: THREE.ShaderMaterial;
  private readonly field: ShoreField;
  private readonly depthAt: (x: number, z: number) => number;

  constructor(grid: Heightfield, spots: ReadonlyArray<FishSpotDef>, bank: MaterialBank) {
    this.field = buildShoreField(grid);
    this.depthAt = (x, z) => WATER_Y - heightAt(grid, x, z);
    setSeaState(0, 0.12, this.depthAt);
    bank.tex(this.field.texture);
    const spotValues: THREE.Vector3[] = [];
    for (let i = 0; i < MAX_WATER_SPOTS; i++) {
      const s = spots[i];
      spotValues.push(s ? new THREE.Vector3(s.x, s.z, (i * 0.37) % 1) : new THREE.Vector3(1e5, 1e5, 0));
    }
    this.material = bank.own(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([
          THREE.UniformsLib.fog,
          {
            time: { value: 0 },
            waveAmp: { value: 0.12 },
            seaColor: { value: new THREE.Color() },
            shallowColor: { value: new THREE.Color() },
            deepColor: { value: new THREE.Color() },
            foamColor: { value: new THREE.Color() },
            horizonColor: { value: new THREE.Color() },
            keyDir: { value: new THREE.Vector3(0, 1, 0) },
            keyColor: { value: new THREE.Color() },
            keyIntensity: { value: 1 },
            ambient: { value: new THREE.Color(0.8, 0.8, 0.8) },
            glint: { value: 1 },
            rain: { value: 0 },
            center: { value: new THREE.Vector2() },
            shoreRect: { value: this.field.rect },
            spotCount: { value: Math.min(MAX_WATER_SPOTS, spots.length) },
          },
        ]),
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        fog: true,
        side: THREE.DoubleSide,
      }),
    );
    // Textures and vector arrays must not go through UniformsUtils.merge (it clones them).
    this.material.uniforms.shore = { value: this.field.texture };
    this.material.uniforms.spots = { value: spotValues };
    this.material.name = "water";
    this.mesh = new THREE.Mesh(bank.geo(seaGeometry()), this.material);
    this.mesh.name = "water";
    this.mesh.position.y = WATER_Y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Water depth (m, ≤ 0 on land) at a world point. */
  depth(x: number, z: number): number {
    return this.depthAt(x, z);
  }

  /** Per frame: follow the camera, push the look and publish the sea state (waves.ts `sea`) for floating things. */
  update(elapsed: number, light: Lighting, focus: THREE.Vector3): void {
    const u = this.material.uniforms;
    this.mesh.position.x = Math.round(focus.x / FOLLOW_STEP) * FOLLOW_STEP;
    this.mesh.position.z = Math.round(focus.z / FOLLOW_STEP) * FOLLOW_STEP;
    (u.center!.value as THREE.Vector2).set(this.mesh.position.x, this.mesh.position.z);
    u.time!.value = elapsed;
    u.waveAmp!.value = light.waveAmp;
    setSeaState(elapsed, light.waveAmp, this.depthAt);
    capColor(u.seaColor!.value as THREE.Color, light.sea, CAP_SEA);
    capColor(u.shallowColor!.value as THREE.Color, light.seaShallow, CAP_SHALLOW);
    capColor(u.deepColor!.value as THREE.Color, light.seaDeep, CAP_DEEP);
    capColor(u.foamColor!.value as THREE.Color, light.foam, CAP_FOAM);
    (u.horizonColor!.value as THREE.Color).copy(light.fogColor);
    (u.keyDir!.value as THREE.Vector3).copy(light.keyDir);
    (u.keyColor!.value as THREE.Color).copy(light.keyColor);
    u.keyIntensity!.value = light.keyIntensity;
    (u.ambient!.value as THREE.Color).copy(light.hemiSky).multiplyScalar(0.35 + light.hemiIntensity * 0.45);
    u.glint!.value = light.glint;
    u.rain!.value = light.rain;
  }
}
