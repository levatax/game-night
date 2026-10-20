// Soft round contact shadow for scenes without fx blob shadows (lobby preview, menu crowd).
// Owner: client-characters.

import * as THREE from "three";
import { PALETTE } from "../../../shared/constants";

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
      g.addColorStop(0.55, "rgba(255,255,255,0.75)");
      g.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, 64, 64);
    }
    blobTexture = new THREE.CanvasTexture(canvas);
  }
  return blobTexture;
}

export interface BlobShadow {
  mesh: THREE.Mesh;
  /** Shrink and fade with the height of the caster above the ground. */
  setLift(height: number): void;
  dispose(): void;
}

export function createBlobShadow(radius: number, opacity: number): BlobShadow {
  const geometry = new THREE.PlaneGeometry(radius * 2, radius * 2);
  geometry.rotateX(-Math.PI / 2);
  const material = new THREE.MeshBasicMaterial({
    map: getBlobTexture(),
    color: PALETTE.ink,
    transparent: true,
    opacity,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0.003;
  mesh.renderOrder = -1;
  return {
    mesh,
    setLift(height: number) {
      const k = Math.max(0.45, 1 - Math.max(0, height) * 0.9);
      mesh.scale.setScalar(k);
      material.opacity = opacity * k;
    },
    dispose() {
      mesh.removeFromParent();
      geometry.dispose();
      material.dispose();
    },
  };
}
