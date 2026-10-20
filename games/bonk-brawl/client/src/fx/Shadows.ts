// Blob shadows under players and balls. Owner: client-fx.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import type { FloorQuery } from "../../../shared/sim/context";
import { groundHeightAt } from "../../../shared/sim/geometry";
import { flatQuadGeometry } from "./geometries";
import type { ShadowCaster } from "./types";

const MAX_CASTERS = 64;
/** Shadow fully shrunk/faded at this height above the ground. */
const FADE_HEIGHT = 7;
const MIN_SCALE = 0.35;
const MAX_ALPHA = 0.42;
/** Diameter relative to the caster's footprint radius. */
const SIZE_PER_RADIUS = 2.3;
const LIFT = 0.012;

const VERTEX = /* glsl */ `
  attribute float aAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

// Analytic blob: solid core with a soft toon-ish rim, no texture needed.
const FRAGMENT = /* glsl */ `
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = (1.0 - smoothstep(0.62, 1.0, d)) * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

/**
 * One soft dark disc (softDotTexture, multiply/alpha) per caster, projected straight down onto
 * groundHeightAt(q, x, z, radius, y) + 0.01; shrinks and fades with height above the ground
 * (readable height cue while aiming). Hidden when there's no ground below (over the void).
 * Instanced or pooled meshes; never cast/receive shadows themselves.
 *
 * Implementation: one InstancedMesh with an analytic blob shader (per-instance alpha), so the
 * look doesn't depend on a texture. With no FloorQuery the ground is a flat plane at y = 0.
 */
export class BlobShadows {
  private readonly mesh: THREE.InstancedMesh;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private floor: FloorQuery | null = null;
  private readonly matrix = new THREE.Matrix4();

  constructor(scene: THREE.Scene) {
    const geometry = flatQuadGeometry().clone();
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(MAX_CASTERS), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aAlpha", this.alpha);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(PALETTE.ink) } },
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.InstancedMesh(geometry, this.material, MAX_CASTERS);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.name = "fx-blob-shadows";
    scene.add(this.mesh);
  }

  setFloorQuery(q: FloorQuery | null): void {
    this.floor = q;
  }

  update(casters: readonly ShadowCaster[]): void {
    let n = 0;
    for (let i = 0; i < casters.length && n < MAX_CASTERS; i++) {
      if (this.place(casters[i], n)) n++;
    }
    this.mesh.count = n;
    if (n > 0) {
      this.mesh.instanceMatrix.clearUpdateRanges();
      this.mesh.instanceMatrix.addUpdateRange(0, n * 16);
      this.mesh.instanceMatrix.needsUpdate = true;
      this.alpha.clearUpdateRanges();
      this.alpha.addUpdateRange(0, n);
      this.alpha.needsUpdate = true;
    }
  }

  /** Hide every shadow until the next update. */
  clear(): void {
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }

  private place(c: ShadowCaster, index: number): boolean {
    const ground = this.groundBelow(c);
    if (!Number.isFinite(ground)) return false;
    const height = Math.max(0, c.y - ground);
    const k = 1 - Math.min(1, height / FADE_HEIGHT);
    if (k <= 0) return false;
    const size = c.radius * SIZE_PER_RADIUS * (MIN_SCALE + (1 - MIN_SCALE) * k) * 0.5;
    this.matrix.makeScale(size, 1, size);
    this.matrix.setPosition(c.x, ground + LIFT, c.z);
    this.mesh.setMatrixAt(index, this.matrix);
    this.alpha.setX(index, MAX_ALPHA * (0.25 + 0.75 * k));
    return true;
  }

  private groundBelow(c: ShadowCaster): number {
    if (!this.floor) return 0;
    // Cover tops count only below the caster; radius × 0.6 allows a slight overhang like players.
    return groundHeightAt(this.floor, c.x, c.z, c.radius * 0.6, c.y);
  }
}
