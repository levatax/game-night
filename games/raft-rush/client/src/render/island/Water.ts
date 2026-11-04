// The sea (game4.md §16): one 220 m plane (48 × 48 segments ≈ 4.6k triangles) that follows the camera in
// whole-cell steps, vertex waves damped in the shallows (storm = big swell), faceted toon shading, depth color
// from the shore field (shallow turquoise → deep blue, opaque over the deep sea so hidden seabed cells can be
// skipped), an animated foam band by distance to the coast, foamy fish spots, rain ripples, sun sparkles by
// day and the moon path by night, day blue → night navy. One draw call. Owner: client-render.

import * as THREE from "three";
import { FISH_SPOT_RADIUS, WATER_Y } from "../../../../shared/constants";
import type { FishSpotDef } from "../../../../shared/island/types";
import type { Lighting } from "../sky/DayNight";
import type { MaterialBank } from "../kit/MaterialBank";
import { buildShoreField, SHORE_DEPTH_MAX, SHORE_DIST_MAX, type ShoreField } from "./shoreField";
import type { Heightfield } from "../../../../shared/island/types";

const SIZE = 220;
const SEGMENTS = 48;
const CELL = SIZE / SEGMENTS;
/** Fish spots the shader knows about (duel: two islands × up to 8). */
export const MAX_WATER_SPOTS = 16;

const VERTEX = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  uniform float time;
  uniform float waveAmp;
  uniform sampler2D shore;
  uniform vec4 shoreRect;
  varying vec3 vWorld;
  varying float vDepth;
  varying float vCoast;
  varying float vLand;

  float waves(vec2 p, float t) {
    return sin(dot(p, vec2(0.21, 0.13)) + t * 1.1) * 0.5
      + sin(dot(p, vec2(-0.12, 0.27)) + t * 1.6) * 0.3
      + sin(dot(p, vec2(0.33, -0.19)) + t * 2.3) * 0.2;
  }

  void main() {
    vec4 world = modelMatrix * vec4(position, 1.0);
    vec2 uv = (world.xz - shoreRect.xy) / shoreRect.zw;
    vec4 s = texture2D(shore, uv);
    float depth = s.r * ${SHORE_DEPTH_MAX.toFixed(1)};
    // Full swell offshore, a small lap at the waterline so the beach edge breathes.
    float atten = mix(0.25, 1.0, smoothstep(0.2, 2.5, depth));
    world.y += waveAmp * atten * waves(world.xz, time);
    vWorld = world.xyz;
    vDepth = depth;
    vCoast = s.g * ${SHORE_DIST_MAX.toFixed(1)};
    vLand = s.b;
    vec4 mvPosition = viewMatrix * world;
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform float time;
  uniform vec3 seaColor;
  uniform vec3 shallowColor;
  uniform vec3 deepColor;
  uniform vec3 foamColor;
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
  varying float vDepth;
  varying float vCoast;
  varying float vLand;

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
    // Per-pixel shore data (smoother than the per-vertex values on 4.6 m cells).
    vec4 s = texture2D(shore, (vWorld.xz - shoreRect.xy) / shoreRect.zw);
    float depth = s.r * ${SHORE_DEPTH_MAX.toFixed(1)};
    float coast = s.g * ${SHORE_DIST_MAX.toFixed(1)};

    vec3 n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (n.y < 0.0) n = -n;

    // Distance LOD: near the camera the faceted waves, foam breakup, fish bursts, rain ripples and glints
    // stay full detail; past ~60 m they fade to a flat, cheap sea (the far water is fogged anyway).
    float far = smoothstep(60.0, 100.0, distance(cameraPosition, vWorld));
    n = normalize(mix(n, vec3(0.0, 1.0, 0.0), far));

    vec3 col = mix(shallowColor, seaColor, smoothstep(0.15, 2.4, depth));
    col = mix(col, deepColor, smoothstep(2.4, 6.0, depth));
    float ndl = dot(n, keyDir);
    float band = ndl > 0.55 ? 1.0 : 0.86;
    col *= ambient + keyColor * keyIntensity * band * 0.22;

    // Foam band hugging the coast: a solid lip plus stripes rolling toward the beach.
    float breakup = 0.5;
    if (far < 1.0) breakup = vnoise(vWorld.xz * 0.55 + vec2(time * 0.15, 0.0));
    float roll = sin(coast * 3.0 - time * 2.1 + breakup * 3.0);
    float foam = (1.0 - smoothstep(0.18, 0.5, coast + breakup * 0.25));
    foam = max(foam, step(0.6, roll) * (1.0 - smoothstep(0.7, 2.3, coast)));
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
      foam = max(foam, ripple * 0.8);
    }

    // Sparkles: sun glints by day, the moon path by night (perturbed facet normals).
    vec3 v = normalize(cameraPosition - vWorld);
    float sparkle = 0.0;
    if (far < 0.95) {
      vec2 jitter = vec2(vnoise(vWorld.xz * 1.3 + time * 0.6), vnoise(vWorld.zx * 1.3 - time * 0.5)) - 0.5;
      vec3 gn = normalize(n + vec3(jitter.x, 0.0, jitter.y) * 0.35);
      float spec = dot(reflect(-v, gn), keyDir);
      sparkle = smoothstep(0.975, 0.985, spec) * glint;
    }

    float alpha = mix(0.55, 0.97, smoothstep(0.0, 2.2, depth));
    col = mix(col, foamColor, clamp(foam, 0.0, 1.0) * 0.92);
    alpha = max(alpha, foam);
    col += keyColor * sparkle * 1.4;
    alpha = max(alpha, sparkle);

    gl_FragColor = vec4(col, alpha);
    #include <fog_fragment>
    #ifdef USE_FOG
      // The far rim of the camera-following plane melts into the fog color (no visible edge).
      float rim = smoothstep(${(SIZE * 0.36).toFixed(1)}, ${(SIZE * 0.49).toFixed(1)}, distance(vWorld.xz, center));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, rim);
    #endif
    #include <colorspace_fragment>
  }
`;

export class Water {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;
  private readonly field: ShoreField;

  constructor(grid: Heightfield, spots: ReadonlyArray<FishSpotDef>, bank: MaterialBank) {
    this.field = buildShoreField(grid);
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
    const geometry = bank.geo(new THREE.PlaneGeometry(SIZE, SIZE, SEGMENTS, SEGMENTS));
    geometry.rotateX(-Math.PI / 2);
    this.mesh = new THREE.Mesh(geometry, this.material);
    this.mesh.name = "water";
    this.mesh.position.y = WATER_Y;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
  }

  /** Per frame: follow the camera in whole cells (waves are world-space, so nothing swims), push the look. */
  update(elapsed: number, light: Lighting, focus: THREE.Vector3): void {
    const u = this.material.uniforms;
    this.mesh.position.x = Math.round(focus.x / CELL) * CELL;
    this.mesh.position.z = Math.round(focus.z / CELL) * CELL;
    (u.center!.value as THREE.Vector2).set(this.mesh.position.x, this.mesh.position.z);
    u.time!.value = elapsed;
    u.waveAmp!.value = light.waveAmp;
    (u.seaColor!.value as THREE.Color).copy(light.sea);
    (u.shallowColor!.value as THREE.Color).copy(light.seaShallow);
    (u.deepColor!.value as THREE.Color).copy(light.seaDeep);
    (u.foamColor!.value as THREE.Color).copy(light.foam);
    (u.keyDir!.value as THREE.Vector3).copy(light.keyDir);
    (u.keyColor!.value as THREE.Color).copy(light.keyColor);
    u.keyIntensity!.value = light.keyIntensity;
    (u.ambient!.value as THREE.Color).copy(light.hemiSky).multiplyScalar(0.35 + light.hemiIntensity * 0.45);
    u.glint!.value = light.glint;
    u.rain!.value = light.rain;
  }
}
