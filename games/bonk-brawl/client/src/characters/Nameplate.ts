// Floating nameplate + gold crown. Owner: client-characters.

import * as THREE from "three";

/**
 * Canvas-texture sprite above the head: nickname in Fredoka bold on a rounded pill in the slot
 * color, small hearts row under it (♥♥♡). Size constant on screen-ish (sizeAttenuation false or
 * scaled by distance), depthTest false, renderOrder high. Hidden for the local player.
 */
export class Nameplate {
  readonly object = new THREE.Group();

  constructor(nickname: string, color: string) {
    void nickname;
    void color;
  }

  update(nickname: string, color: string, hearts: number): void {
    void nickname;
    void color;
    void hearts;
  }

  dispose(): void {}
}

/** Low-poly gold crown (PALETTE.crownGold, emissive so it blooms on high quality), slowly spinning/bobbing. */
export function createCrown(): THREE.Object3D {
  return new THREE.Group(); // TODO(client-characters)
}
