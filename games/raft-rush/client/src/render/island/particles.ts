// Looping rising puffs in one Points draw, animated entirely in the vertex shader (no per-frame CPU work):
// campfire smoke and embers, the volcano plume, torch sparks. Each point loops over `life` seconds on its own
// phase, rising `rise` meters, drifting with `spread`, growing as it rises and fading in / out. Owner:
// client-render.

import * as THREE from "three";
import type { MaterialBank } from "../kit/MaterialBank";
import { softDotTexture } from "../textures";

const VERTEX = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float phase;
  uniform float time;
  uniform float rise;
  uniform float spread;
  uniform float size;
  uniform float life;
  uniform float drift;
  uniform float pixelRatio;
  varying float vAge;
  void main() {
    float t = fract(time / life + phase);
    vAge = t;
    vec3 p = position;
    p.y += t * rise;
    p.x += sin(phase * 40.0 + time * 0.9) * spread * t + t * t * drift;
    p.z += cos(phase * 23.0 + time * 0.7) * spread * t;
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = size * pixelRatio * (0.4 + t * 1.2) * (10.0 / max(1.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D map;
  uniform vec3 color;
  uniform float opacity;
  uniform float fadeIn;
  varying float vAge;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    float a = t.a * opacity * smoothstep(0.0, fadeIn, vAge) * (1.0 - smoothstep(0.55, 1.0, vAge));
    if (a < 0.01) discard;
    gl_FragColor = vec4(color, a);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
    #include <fog_fragment>
  }
`;

export interface PuffOptions {
  count: number;
  /** Emitter position (world). */
  x: number;
  y: number;
  z: number;
  /** Emitter radius. */
  jitter: number;
  color: THREE.ColorRepresentation;
  additive: boolean;
  /** Meters risen over one life. */
  rise: number;
  spread: number;
  /** Point size (px at 10 m, before the pixel ratio). */
  size: number;
  /** Seconds per loop. */
  life: number;
  /** Fraction of the life spent fading in. */
  fadeIn: number;
  /** Sideways lean as it rises (wind), meters at the top. */
  drift?: number;
}

export class RisingPuffs {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(bank: MaterialBank, o: PuffOptions) {
    const pos = new Float32Array(o.count * 3);
    const phase = new Float32Array(o.count);
    for (let i = 0; i < o.count; i++) {
      const a = i * 2.399;
      const r = o.jitter * ((i % 3) / 3 + 0.15);
      pos[i * 3] = o.x + Math.cos(a) * r;
      pos[i * 3 + 1] = o.y;
      pos[i * 3 + 2] = o.z + Math.sin(a) * r;
      phase[i] = i / o.count;
    }
    const geo = bank.geo(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(o.x, o.y + o.rise * 0.5, o.z), o.rise * 0.6 + o.spread + 2);
    this.material = bank.own(
      new THREE.ShaderMaterial({
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          map: { value: softDotTexture() },
          color: { value: new THREE.Color(o.color) },
          opacity: { value: 0 },
          time: { value: 0 },
          rise: { value: o.rise },
          spread: { value: o.spread },
          size: { value: o.size },
          life: { value: o.life },
          fadeIn: { value: o.fadeIn },
          drift: { value: o.drift ?? 0.6 },
          pixelRatio: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
        fog: true,
      }),
    );
    this.points = new THREE.Points(geo, this.material);
    this.points.renderOrder = 5;
  }

  update(elapsed: number, opacity: number, pixelRatio: number, drift?: number): void {
    const u = this.material.uniforms;
    u.time!.value = elapsed;
    u.opacity!.value = opacity;
    u.pixelRatio!.value = pixelRatio;
    if (drift !== undefined) u.drift!.value = drift;
    this.points.visible = opacity > 0.01;
  }
}
