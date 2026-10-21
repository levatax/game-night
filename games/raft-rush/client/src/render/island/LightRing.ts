// The edge of a light ring made visible at night: a thin additive ribbon draped over the terrain at the
// gameplay radius (FIRE_LIGHT_RADIUS / TORCH_LIGHT_RADIUS) so players can read "crabs won't come past this".
// It breathes slightly with the flame. One draw. Owner: client-render.

import * as THREE from "three";
import { heightAt } from "../../../../shared/island/heightfield";
import type { Heightfield } from "../../../../shared/island/types";
import type { MaterialBank } from "../kit/MaterialBank";

const SEGMENTS = 56;
const WIDTH = 0.42;

const VERTEX = /* glsl */ `
  #include <common>
  #include <fog_pars_vertex>
  attribute float across;
  varying float vAcross;
  void main() {
    vAcross = across;
    vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FRAGMENT = /* glsl */ `
  #include <common>
  #include <fog_pars_fragment>
  uniform vec3 color;
  uniform float opacity;
  varying float vAcross;
  void main() {
    float a = (1.0 - abs(vAcross * 2.0 - 1.0));
    a = a * a * opacity;
    if (a < 0.01) discard;
    gl_FragColor = vec4(color, a);
    #include <fog_fragment>
    #include <colorspace_fragment>
  }
`;

export class LightRing {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.ShaderMaterial;

  constructor(grid: Heightfield, cx: number, cz: number, radius: number, color: THREE.ColorRepresentation, bank: MaterialBank) {
    const pos: number[] = [];
    const across: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= SEGMENTS; i++) {
      const a = (i / SEGMENTS) * Math.PI * 2;
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      for (const k of [0, 1]) {
        const r = radius + (k - 0.5) * WIDTH;
        const x = cx + ca * r;
        const z = cz + sa * r;
        pos.push(x, Math.max(heightAt(grid, x, z), 0) + 0.07, z);
        across.push(k);
      }
      if (i < SEGMENTS) {
        const b = i * 2;
        idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
      }
    }
    const geo = bank.geo(new THREE.BufferGeometry());
    geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute("across", new THREE.Float32BufferAttribute(across, 1));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    this.material = bank.own(
      new THREE.ShaderMaterial({
        uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { color: { value: new THREE.Color(color) }, opacity: { value: 0 } }]),
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        side: THREE.DoubleSide,
        fog: true,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1,
      }),
    );
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.name = "lightRing";
    this.mesh.renderOrder = 2;
    this.mesh.visible = false;
  }

  setOpacity(opacity: number): void {
    this.material.uniforms.opacity!.value = opacity;
    this.mesh.visible = opacity > 0.01;
  }
}
