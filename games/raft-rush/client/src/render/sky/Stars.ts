// Twinkling night stars: one Points draw with a tiny twinkle shader, faded in by DayNight (night, clear sky).
// Owner: client-render. Adapted from Stars in games/bonk-brawl/client/src/render/sky/backdrops.ts (upper
// hemisphere only, live opacity, follows the camera like the dome).

import * as THREE from "three";
import { createRng } from "../noise";

const VERTEX = /* glsl */ `
  attribute float phase;
  attribute float size;
  uniform float time;
  uniform float pixelRatio;
  varying float vAlpha;
  void main() {
    float tw = 0.5 + 0.5 * sin(time * (1.2 + fract(phase) * 1.8) + phase);
    vAlpha = 0.35 + 0.65 * tw;
    gl_PointSize = size * pixelRatio * (0.7 + 0.5 * tw);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    vec2 p = gl_PointCoord - 0.5;
    float d = length(p);
    // Soft core + a 4-point twinkle cross.
    float core = smoothstep(0.22, 0.0, d);
    float cross = max(smoothstep(0.06, 0.0, abs(p.x)), smoothstep(0.06, 0.0, abs(p.y))) * smoothstep(0.5, 0.0, d);
    float a = clamp(core + cross * 0.8, 0.0, 1.0) * vAlpha * opacity;
    if (a < 0.02) discard;
    gl_FragColor = vec4(color, a);
    #include <colorspace_fragment>
  }
`;

export class Stars {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(count: number, pixelRatio: number, radius = 330) {
    const rng = createRng(31337);
    const positions = new Float32Array(count * 3);
    const phases = new Float32Array(count);
    const sizes = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      // Uniform over the upper hemisphere, thinning toward the horizon haze.
      const elevation = 0.06 + Math.asin(rng()) * 0.95;
      const azimuth = rng() * Math.PI * 2;
      positions[i * 3] = Math.cos(azimuth) * Math.cos(elevation) * radius;
      positions[i * 3 + 1] = Math.sin(elevation) * radius;
      positions[i * 3 + 2] = Math.sin(azimuth) * Math.cos(elevation) * radius;
      phases[i] = rng() * 100;
      sizes[i] = 4 + rng() * rng() * 12;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("phase", new THREE.BufferAttribute(phases, 1));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 },
        pixelRatio: { value: pixelRatio },
        color: { value: new THREE.Color("#FFF6D6") },
        opacity: { value: 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    this.object = new THREE.Points(geo, this.material);
    this.object.name = "stars";
    this.object.frustumCulled = false;
    this.object.renderOrder = -8;
  }

  update(elapsed: number, opacity: number, cameraPos: THREE.Vector3): void {
    this.material.uniforms.time!.value = elapsed;
    this.material.uniforms.opacity!.value = opacity;
    this.object.visible = opacity > 0.01;
    this.object.position.copy(cameraPos);
  }

  setPixelRatio(ratio: number): void {
    this.material.uniforms.pixelRatio!.value = ratio;
  }

  dispose(): void {
    this.object.removeFromParent();
    this.object.geometry.dispose();
    this.material.dispose();
  }
}
