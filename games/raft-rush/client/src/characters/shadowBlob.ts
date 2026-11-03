// Soft round contact shadow under tourists and monsters: grounds them at night and on low quality (no shadow
// maps), and in the portrait / dev scenes. Shrinks and fades with the height above the ground. Owner:
// client-characters. Adapted from games/bonk-brawl/client/src/characters/shadowBlob.ts.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";
import { cachedGeometry } from "./kit";

let blobTexture: THREE.CanvasTexture | null = null;

/** Shared radial-gradient texture (never disposed). */
function getBlobTexture(): THREE.CanvasTexture {
  if (!blobTexture) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      g.addColorStop(0, "rgba(255,255,255,1)");
      g.addColorStop(0.55, "rgba(255,255,255,0.7)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    blobTexture = new THREE.CanvasTexture(canvas);
  }
  return blobTexture;
}

/** Unit (2 × 2 m, scaled by the radius) ground quad of the blob shadow, shared. */
export function blobGeometry(): THREE.BufferGeometry {
  return cachedGeometry("blob-shadow", () => {
    const g = new THREE.PlaneGeometry(2, 2);
    g.rotateX(-Math.PI / 2);
    return g;
  });
}

let sharedBlob: THREE.MeshBasicMaterial | null = null;

/** One shared blob material (instanced monster shadows: constant opacity). */
export function sharedBlobMaterial(): THREE.MeshBasicMaterial {
  if (!sharedBlob) {
    sharedBlob = new THREE.MeshBasicMaterial({
      map: getBlobTexture(),
      color: PALETTE.ink,
      transparent: true,
      opacity: 0.3,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    sharedBlob.name = "blob-shadow-shared";
  }
  return sharedBlob;
}

export interface BlobShadow {
  mesh: THREE.Mesh;
  /** Place at the ground point under the caster; `height` = caster above the ground (shrinks + fades). */
  place(x: number, groundY: number, z: number, height: number): void;
  setVisible(v: boolean): void;
  dispose(): void;
}

const POOL_VERTEX = /* glsl */ `
  attribute float aAlpha;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    vUv = uv;
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;

const POOL_FRAGMENT = /* glsl */ `
  uniform sampler2D uMap;
  uniform vec3 uColor;
  varying vec2 vUv;
  varying float vAlpha;
  void main() {
    float a = texture2D(uMap, vUv).a * vAlpha;
    if (a < 0.004) discard;
    gl_FragColor = vec4(uColor, a);
    #include <colorspace_fragment>
  }
`;

/** Avatars a pool covers (6 seats + slack for leaving avatars). */
const POOL_CAPACITY = 8;

/**
 * All player contact shadows in ONE instanced draw instead of one quad per avatar. Each avatar owns a slot:
 * `place` writes its matrix + alpha, `hide` zeroes the alpha, `flush` uploads the frame once.
 */
export class AvatarShadowPool {
  readonly mesh: THREE.InstancedMesh;
  private readonly alpha: THREE.InstancedBufferAttribute;
  private readonly matrix = new THREE.Matrix4();
  private readonly free: number[] = [];
  private dirty = false;

  constructor(parent: THREE.Object3D) {
    const geometry = blobGeometry().clone();
    this.alpha = new THREE.InstancedBufferAttribute(new Float32Array(POOL_CAPACITY), 1);
    this.alpha.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute("aAlpha", this.alpha);
    const material = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: getBlobTexture() }, uColor: { value: new THREE.Color(PALETTE.ink) } },
      vertexShader: POOL_VERTEX,
      fragmentShader: POOL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    });
    this.mesh = new THREE.InstancedMesh(geometry, material, POOL_CAPACITY);
    this.mesh.name = "avatar-shadows";
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1;
    this.mesh.castShadow = false;
    this.mesh.receiveShadow = false;
    this.mesh.raycast = () => {};
    for (let i = POOL_CAPACITY - 1; i >= 0; i--) {
      this.free.push(i);
      this.matrix.makeScale(0, 0, 0);
      this.mesh.setMatrixAt(i, this.matrix);
    }
    parent.add(this.mesh);
  }

  /** Take a slot (-1 when the pool is full: the avatar then draws no contact shadow). */
  acquire(): number {
    const i = this.free.pop();
    return i === undefined ? -1 : i;
  }

  release(index: number): void {
    if (index < 0 || this.free.includes(index)) return;
    this.alpha.setX(index, 0);
    this.matrix.makeScale(0, 0, 0);
    this.mesh.setMatrixAt(index, this.matrix);
    this.free.push(index);
    this.dirty = true;
  }

  /** Ground point + size fade for one avatar (same curve as the old single-quad blob). */
  place(index: number, x: number, groundY: number, z: number, radius: number, height: number, opacity = 0.28): void {
    if (index < 0) return;
    const k = Math.max(0.4, 1 - Math.max(0, height) * 0.6);
    this.matrix.makeScale(radius * k, 1, radius * k);
    this.matrix.setPosition(x, groundY + 0.02, z);
    this.mesh.setMatrixAt(index, this.matrix);
    this.alpha.setX(index, opacity * k);
    this.dirty = true;
  }

  hide(index: number): void {
    if (index < 0) return;
    this.alpha.setX(index, 0);
    this.dirty = true;
  }

  /** Upload this frame's slots (one buffer update). */
  flush(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.alpha.needsUpdate = true;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
    this.mesh.dispose();
  }
}

/** A pool slot seen through the single-quad BlobShadow interface (place / hide / release). */
export function pooledBlobShadow(pool: AvatarShadowPool, index: number, radius: number, opacity: number): BlobShadow {
  let visible = true;
  return {
    mesh: pool.mesh,
    place(x, groundY, z, height) {
      if (visible) pool.place(index, x, groundY, z, radius, height, opacity);
    },
    setVisible(v) {
      visible = v;
      if (!v) pool.hide(index);
    },
    dispose() {
      pool.release(index);
    },
  };
}

export function createBlobShadow(radius: number, opacity: number): BlobShadow {
  const material = new THREE.MeshBasicMaterial({
    map: getBlobTexture(),
    color: PALETTE.ink,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.Mesh(blobGeometry(), material);
  mesh.name = "blobShadow";
  mesh.renderOrder = -1;
  mesh.scale.setScalar(radius);
  mesh.raycast = () => {};
  return {
    mesh,
    place(x, groundY, z, height) {
      const k = Math.max(0.4, 1 - Math.max(0, height) * 0.6);
      mesh.position.set(x, groundY + 0.02, z);
      mesh.scale.setScalar(radius * k);
      material.opacity = opacity * k;
    },
    setVisible(v) {
      mesh.visible = v;
    },
    dispose() {
      mesh.removeFromParent();
      material.dispose();
    },
  };
}
