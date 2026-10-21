// Blob shadows under thrown / dropped items (a readable height cue while aiming and catching). Owner:
// client-fx-audio. Adapted from games/bonk-brawl/client/src/fx/Shadows.ts: same instanced analytic-blob shader;
// the ground comes from the island heightfield (Fx.setIsland) and shadows over water lie on the sea surface,
// lighter. Characters draw their own player shadows.

import * as THREE from "three";
import { PALETTE, WATER_Y } from "../../../shared/constants";
import type { GroundFn } from "./Chunks";

const MAX_CASTERS = 64;
/** Shadow fully shrunk/faded at this height above the ground. */
const FADE_HEIGHT = 8;
const MIN_SCALE = 0.35;
const MAX_ALPHA = 0.4;
/** Diameter relative to the caster's footprint radius. */
const SIZE_PER_RADIUS = 2.4;
const LIFT = 0.02;
const WATER_ALPHA = 0.45;

export interface ShadowCaster {
  x: number;
  y: number;
  z: number;
  radius: number;
  /** 0..1 extra fade (predicted projectiles fading out). */
  opacity?: number;
}

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

export class BlobShadows {
  private readonly mesh: THREE.InstancedMesh;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly material: THREE.ShaderMaterial;
  private ground: GroundFn | null = null;
  private readonly matrix = new THREE.Matrix4();
  private n = 0;

  constructor(parent: THREE.Object3D) {
    const geometry = new THREE.PlaneGeometry(2, 2);
    geometry.rotateX(-Math.PI / 2);
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
    this.mesh.raycast = () => {};
    parent.add(this.mesh);
  }

  setGround(fn: GroundFn | null): void {
    this.ground = fn;
  }

  /** Start a frame's shadow list. */
  begin(): void {
    this.n = 0;
  }

  /** Add one caster (no-op when full or too high). */
  add(c: ShadowCaster): void {
    if (this.n >= MAX_CASTERS) return;
    const terrain = this.ground ? this.ground(c.x, c.z) : WATER_Y;
    const onWater = terrain < WATER_Y;
    const ground = Math.max(terrain, WATER_Y);
    const height = Math.max(0, c.y - c.radius - ground);
    const k = 1 - Math.min(1, height / FADE_HEIGHT);
    if (k <= 0) return;
    const size = c.radius * SIZE_PER_RADIUS * (MIN_SCALE + (1 - MIN_SCALE) * k) * 0.5;
    this.matrix.makeScale(size, 1, size);
    this.matrix.setPosition(c.x, ground + LIFT, c.z);
    this.mesh.setMatrixAt(this.n, this.matrix);
    this.alpha.setX(this.n, MAX_ALPHA * (0.25 + 0.75 * k) * (onWater ? WATER_ALPHA : 1) * (c.opacity ?? 1));
    this.n++;
  }

  /** Upload the frame's shadows. */
  end(): void {
    this.mesh.count = this.n;
    if (this.n === 0) return;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, this.n * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.clearUpdateRanges();
    this.alpha.addUpdateRange(0, this.n);
    this.alpha.needsUpdate = true;
  }

  clear(): void {
    this.n = 0;
    this.mesh.count = 0;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.mesh.dispose();
  }
}
