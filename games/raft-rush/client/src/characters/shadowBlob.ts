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
