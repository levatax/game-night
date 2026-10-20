// Instanced billboard batch shared by particles and pop text. Owner: client-fx.
// One draw call per batch: each instance is a quad that faces the camera, lies flat on the
// ground, or stretches along a world axis (speed lines). Filled from scratch every frame.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";

/** How an instance's quad is oriented. */
export const BILLBOARD_FACING = 0;
export const BILLBOARD_FLAT = 1;
export const BILLBOARD_STREAK = 2;

export type BillboardMode = typeof BILLBOARD_FACING | typeof BILLBOARD_FLAT | typeof BILLBOARD_STREAK;

/**
 * "tint": texture rgb × instance color (particle atlas, white tiles with ink outlines).
 * "packed": comic lettering atlas, R = fill shade, G = fill coverage, B = highlight, A = alpha;
 *           fill = instance color × shade over an ink outline, highlight mixes toward white.
 */
export type BillboardShading = "tint" | "packed";

export interface BillboardBatchOptions {
  name: string;
  capacity: number;
  map: THREE.Texture;
  additive?: boolean;
  shading?: BillboardShading;
  depthTest?: boolean;
  renderOrder?: number;
  /** Grow far-away quads (pop text stays readable across the island). 0 = off. */
  distanceGrow?: number;
}

const VERTEX = /* glsl */ `
  attribute vec3 aCenter;
  attribute vec3 aSizeRot;
  attribute vec4 aColor;
  attribute vec4 aUv;
  attribute vec4 aAxis;
  uniform float uDistanceGrow;
  varying vec2 vUv;
  varying vec4 vColor;

  void main() {
    vUv = aUv.xy + uv * aUv.zw;
    vColor = aColor;
    vec2 corner = position.xy * aSizeRot.xy;
    float c = cos(aSizeRot.z);
    float s = sin(aSizeRot.z);
    vec2 rc = vec2(c * corner.x - s * corner.y, s * corner.x + c * corner.y);
    vec4 mv;
    if (aAxis.w > 1.5) {
      mv = modelViewMatrix * vec4(aCenter, 1.0);
      vec2 d = (modelViewMatrix * vec4(aAxis.xyz, 0.0)).xy;
      float len = length(d);
      d = len > 1e-4 ? d / len : vec2(1.0, 0.0);
      mv.xy += d * corner.x + vec2(-d.y, d.x) * corner.y;
    } else if (aAxis.w > 0.5) {
      mv = modelViewMatrix * vec4(aCenter + vec3(rc.x, 0.0, rc.y), 1.0);
    } else {
      mv = modelViewMatrix * vec4(aCenter, 1.0);
      float grow = mix(1.0, clamp(-mv.z / 9.0, 1.0, 2.4), uDistanceGrow);
      mv.xy += rc * grow;
    }
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_TINT = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec4 vColor;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float a = tex.a * vColor.a;
    if (a < 0.008) discard;
    gl_FragColor = vec4(tex.rgb * vColor.rgb, a);
    #include <colorspace_fragment>
  }
`;

const FRAGMENT_PACKED = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uInk;
  varying vec2 vUv;
  varying vec4 vColor;

  void main() {
    vec4 tex = texture2D(uMap, vUv);
    float a = tex.a * vColor.a;
    if (a < 0.008) discard;
    float fill = clamp(tex.g / max(tex.a, 0.004), 0.0, 1.0);
    vec3 color = mix(uInk, vColor.rgb * tex.r, fill);
    color = mix(color, vec3(1.0), tex.b);
    gl_FragColor = vec4(color, a);
    #include <colorspace_fragment>
  }
`;

export class BillboardBatch {
  readonly mesh: THREE.Mesh;
  private readonly geometry = new THREE.InstancedBufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private readonly center: THREE.InstancedBufferAttribute;
  private readonly sizeRot: THREE.InstancedBufferAttribute;
  private readonly color: THREE.InstancedBufferAttribute;
  private readonly uvRect: THREE.InstancedBufferAttribute;
  private readonly axis: THREE.InstancedBufferAttribute;
  private readonly capacity: number;
  private n = 0;

  constructor(scene: THREE.Scene, opts: BillboardBatchOptions) {
    this.capacity = opts.capacity;
    // Own copy of the unit quad (−0.5..0.5): disposing a batch must not free another batch's buffers.
    const q = new THREE.PlaneGeometry(1, 1);
    this.geometry.index = q.index;
    this.geometry.setAttribute("position", q.getAttribute("position"));
    this.geometry.setAttribute("uv", q.getAttribute("uv"));
    this.center = this.attribute("aCenter", 3);
    this.sizeRot = this.attribute("aSizeRot", 3);
    this.color = this.attribute("aColor", 4);
    this.uvRect = this.attribute("aUv", 4);
    this.axis = this.attribute("aAxis", 4);
    this.geometry.instanceCount = 0;

    const packed = opts.shading === "packed";
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: opts.map },
        uInk: { value: new THREE.Color(PALETTE.ink) },
        uDistanceGrow: { value: opts.distanceGrow ?? 0 },
      },
      vertexShader: VERTEX,
      fragmentShader: packed ? FRAGMENT_PACKED : FRAGMENT_TINT,
      transparent: true,
      depthWrite: false,
      depthTest: opts.depthTest ?? true,
      blending: opts.additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.name = opts.name;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = opts.renderOrder ?? 3;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  get count(): number {
    return this.n;
  }

  get full(): boolean {
    return this.n >= this.capacity;
  }

  /** Start refilling the batch this frame. */
  begin(): void {
    this.n = 0;
  }

  /**
   * Append one quad. Size in meters (w along the quad's x / streak axis), rot in radians,
   * color in linear RGB, uv rect as (u, v, du, dv) (negative dv flips), axis for streak mode.
   */
  push(
    x: number,
    y: number,
    z: number,
    w: number,
    h: number,
    rot: number,
    color: THREE.Color,
    alpha: number,
    uv: Readonly<THREE.Vector4>,
    mode: BillboardMode,
    ax = 0,
    ay = 0,
    az = 0,
  ): void {
    if (this.n >= this.capacity) return;
    const i = this.n++;
    this.center.setXYZ(i, x, y, z);
    this.sizeRot.setXYZ(i, w, h, rot);
    this.color.setXYZW(i, color.r, color.g, color.b, alpha);
    this.uvRect.setXYZW(i, uv.x, uv.y, uv.z, uv.w);
    this.axis.setXYZW(i, ax, ay, az, mode);
  }

  /** Upload what was pushed since begin(). */
  end(): void {
    this.geometry.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n === 0) return;
    for (const attr of [this.center, this.sizeRot, this.color, this.uvRect, this.axis]) {
      attr.clearUpdateRanges();
      attr.addUpdateRange(0, this.n * attr.itemSize);
      attr.needsUpdate = true;
    }
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.geometry.dispose();
    this.material.dispose();
  }

  private attribute(name: string, size: number): THREE.InstancedBufferAttribute {
    const attr = new THREE.InstancedBufferAttribute(new Float32Array(this.capacity * size), size);
    attr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute(name, attr);
    return attr;
  }
}

/** UV rect of a cell in a square grid atlas whose canvas row 0 is the top (flipY texture). */
export function gridUv(tile: number, grid: number, out: THREE.Vector4): THREE.Vector4 {
  const col = tile % grid;
  const row = Math.floor(tile / grid);
  const size = 1 / grid;
  // CanvasTexture uploads with flipY, so canvas-top rows have high v.
  return out.set(col * size, 1 - (row + 1) * size, size, size);
}
