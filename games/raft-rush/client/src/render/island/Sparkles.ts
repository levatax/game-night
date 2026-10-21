// Twinkling sparkle points (one Points draw): the spring's water glint, the secret chest's gold, the READY raft.
// Each point blinks on its own phase; the whole set fades with `setOpacity`. Owner: client-render.

import * as THREE from "three";
import type { MaterialBank } from "../kit/MaterialBank";
import { sparkleTexture } from "../textures";

const VERTEX = /* glsl */ `
  attribute float phase;
  uniform float time;
  uniform float size;
  uniform float pixelRatio;
  varying float vAlpha;
  void main() {
    float tw = pow(max(0.0, sin(time * (1.6 + fract(phase * 7.3)) + phase)), 6.0);
    vAlpha = tw;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_PointSize = size * pixelRatio * (0.5 + tw) * (8.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 color;
  uniform float opacity;
  varying float vAlpha;
  void main() {
    vec4 t = texture2D(map, gl_PointCoord);
    float a = t.a * vAlpha * opacity;
    if (a < 0.02) discard;
    gl_FragColor = vec4(color * 1.6, a);
    #include <colorspace_fragment>
  }
`;

export class Sparkles {
  readonly object: THREE.Points;
  private readonly material: THREE.ShaderMaterial;

  constructor(points: ReadonlyArray<THREE.Vector3Like>, color: THREE.ColorRepresentation, size: number, bank: MaterialBank, pixelRatio = 1) {
    const pos = new Float32Array(points.length * 3);
    const phase = new Float32Array(points.length);
    points.forEach((p, i) => {
      pos[i * 3] = p.x;
      pos[i * 3 + 1] = p.y;
      pos[i * 3 + 2] = p.z;
      phase[i] = i * 2.399 + p.x * 0.7;
    });
    const geo = bank.geo(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("phase", new THREE.BufferAttribute(phase, 1));
    geo.computeBoundingSphere();
    this.material = bank.own(
      new THREE.ShaderMaterial({
        uniforms: {
          map: { value: sparkleTexture() },
          color: { value: new THREE.Color(color) },
          time: { value: 0 },
          size: { value: size },
          pixelRatio: { value: pixelRatio },
          opacity: { value: 1 },
        },
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    );
    this.object = new THREE.Points(geo, this.material);
    this.object.name = "sparkles";
    this.object.renderOrder = 3;
  }

  update(elapsed: number, opacity = 1): void {
    this.material.uniforms.time!.value = elapsed;
    this.material.uniforms.opacity!.value = opacity;
    this.object.visible = opacity > 0.01;
  }

  setPixelRatio(ratio: number): void {
    this.material.uniforms.pixelRatio!.value = ratio;
  }
}
