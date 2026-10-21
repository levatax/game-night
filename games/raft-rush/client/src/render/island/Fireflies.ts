// Night fireflies (game4.md §16): instanced glowing points (one Points draw) hovering around bushes and tree
// edges on the island, each looping its own little figure-eight and blinking, faded in by DayNight
// (`Lighting.fireflies`: night, no rain). Owner: client-render.

import * as THREE from "three";
import type { IslandDef } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";
import { createRng } from "../noise";
import { softDotTexture } from "../textures";

const VERTEX = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float phase;
  uniform float time;
  uniform float pixelRatio;
  varying float vBlink;
  void main() {
    float t = time * (0.35 + fract(phase * 3.7) * 0.3) + phase * 6.2831;
    vec3 p = position + vec3(sin(t) * 1.2, sin(t * 1.7) * 0.35, sin(t * 2.0) * 0.8);
    vBlink = smoothstep(0.2, 1.0, sin(time * (1.3 + fract(phase * 5.1)) + phase * 17.0));
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = pixelRatio * (16.0 + vBlink * 10.0) * (6.0 / max(1.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform sampler2D map;
  uniform float opacity;
  varying float vBlink;
  void main() {
    float a = texture2D(map, gl_PointCoord).a * opacity * (0.15 + 0.85 * vBlink);
    if (a < 0.02) discard;
    gl_FragColor = vec4(vec3(1.6, 2.0, 0.7), a);
    #include <fog_fragment>
  }
`;

export class Fireflies {
  readonly points: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(def: IslandDef, count: number, bank: MaterialBank) {
    const rng = createRng((def.seed ^ 0xf1ef) >>> 0);
    const hosts = def.nodes.filter((n) => n.kind === "bush" || n.kind === "tree");
    const pos = new Float32Array(count * 3);
    const phase = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const host = hosts.length > 0 ? hosts[Math.floor(rng() * hosts.length)]! : { x: 0, y: 1, z: 0 };
      const a = rng() * Math.PI * 2;
      const d = 0.8 + rng() * 2.2;
      pos[i * 3] = host.x + Math.cos(a) * d;
      pos[i * 3 + 1] = host.y + 0.6 + rng() * 1.6;
      pos[i * 3 + 2] = host.z + Math.sin(a) * d;
      phase[i] = rng();
    }
    const geo = bank.geo(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
    geo.computeBoundingSphere();
    this.material = bank.own(
      new THREE.ShaderMaterial({
        uniforms: {
          ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
          map: { value: softDotTexture() },
          opacity: { value: 0 },
          time: { value: 0 },
          pixelRatio: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      }),
    );
    this.points = new THREE.Points(geo, this.material);
    this.points.name = "fireflies";
    this.points.renderOrder = 5;
    this.points.visible = false;
  }

  update(elapsed: number, amount: number, pixelRatio: number): void {
    const u = this.material.uniforms;
    u.time!.value = elapsed;
    u.opacity!.value = amount;
    u.pixelRatio!.value = pixelRatio;
    this.points.visible = amount > 0.01;
  }
}
