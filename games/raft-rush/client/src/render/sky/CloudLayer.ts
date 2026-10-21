// Camera-facing cloud billboards in ONE draw call (InstancedMesh + billboard shader). Alpha-tested so
// overlapping clouds need no sorting and keep crisp cartoon edges. Live `tint` (time of day / rain) and
// `grow` (storm clouds swell in from nothing) uniforms. Owner: client-render.
// Adapted from games/bonk-brawl/client/src/render/sky/CloudLayer.ts.

import * as THREE from "three";
import { cloudTexture } from "../textures";

const VERTEX = /* glsl */ `
  uniform float grow;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vUv = uv;
    vTint = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vTint = instanceColor;
    #endif
    vec4 center = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    vec2 size = vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz)) * grow;
    vec4 mv = viewMatrix * center;
    mv.xy += position.xy * size;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform vec3 tint;
  varying vec2 vUv;
  varying vec3 vTint;
  void main() {
    vec4 t = texture2D(map, vUv);
    if (t.a < 0.5) discard;
    gl_FragColor = vec4(t.rgb * vTint * tint, 1.0);
    #include <colorspace_fragment>
  }
`;

export interface CloudSpec {
  x: number;
  y: number;
  z: number;
  /** Width in meters (height = width / 2, matching the 512×256 texture). */
  width: number;
  /** Multiplied with the texture (fade distant clouds toward the sky color). */
  tint: THREE.Color;
}

export class CloudLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(clouds: ReadonlyArray<CloudSpec>, color: string, shadow: string, name: string) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: cloudTexture(color, shadow) },
        tint: { value: new THREE.Color(1, 1, 1) },
        grow: { value: 1 },
      },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      fog: false,
    });
    const geometry = new THREE.PlaneGeometry(1, 1);
    this.mesh = new THREE.InstancedMesh(geometry, this.material, Math.max(1, clouds.length));
    this.mesh.name = name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
    const m = new THREE.Matrix4();
    clouds.forEach((c, i) => {
      m.makeScale(c.width, c.width / 2, 1).setPosition(c.x, c.y, c.z);
      this.mesh.setMatrixAt(i, m);
      this.mesh.setColorAt(i, c.tint);
    });
    this.mesh.count = clouds.length;
  }

  /** Multiply every cloud by this (linear) color this frame. */
  setTint(color: THREE.Color): void {
    (this.material.uniforms.tint!.value as THREE.Color).copy(color);
  }

  /** Billboard size factor (0 hides the layer). */
  setGrow(grow: number): void {
    this.material.uniforms.grow!.value = grow;
    this.mesh.visible = grow > 0.01;
  }

  /** Frees the cached cloud texture's GPU copy too (it re-uploads transparently if reused). */
  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.material.uniforms.map!.value as THREE.Texture).dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
