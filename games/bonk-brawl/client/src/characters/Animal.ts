// Procedural low-poly animals. Owner: client-characters.

import * as THREE from "three";
import type { CharacterId } from "../../../shared/types";
import type { FaceExpression } from "./types";

/** Named parts the Animator drives. Every part is a Group pivoted at its joint. */
export interface AnimalRig {
  /** Root at the feet (y = 0), faces -Z (yaw 0). Scale 1 = PLAYER_HEIGHT tall. */
  root: THREE.Group;
  /** Squash & stretch container (scale around the feet). */
  body: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  /** Tail / wings / scarf end: extra flair part (may be an empty group). */
  extra: THREE.Group;
  /** Right-hand anchor where a held ball is placed (fx reads its world position). */
  hand: THREE.Object3D;
  /** Above-head anchor for nameplate, crown, emote bubbles, pop text. */
  headTop: THREE.Object3D;
  /** Face plane using the character's face sheet. */
  face: THREE.Mesh;
}

/**
 * Built only from Three.js primitives (spheres/capsules/cones/boxes, low segment counts) with
 * createToonMaterial colors from CHARACTERS[id].colors and addOutline (≈0.025). Big head
 * (~1:1.5 head-to-body), oversized hands/feet/wings, accessories from CharacterDef.look (sailor
 * hat, bow tie, pink cheeks, bell collar, red scarf, curly horns + bell). The player slot color
 * tints a small accessory band + the outline of the feet ring so players are identifiable.
 * Body meshes castShadow = true. Total < ~1.5k triangles per animal.
 */
export class Animal {
  readonly character: CharacterId;
  readonly rig: AnimalRig;

  constructor(character: CharacterId, slotColor: string) {
    this.character = character;
    void slotColor;
    const root = new THREE.Group();
    const g = () => new THREE.Group();
    this.rig = {
      root,
      body: g(),
      head: g(),
      armL: g(),
      armR: g(),
      legL: g(),
      legR: g(),
      extra: g(),
      hand: new THREE.Object3D(),
      headTop: new THREE.Object3D(),
      face: new THREE.Mesh(),
    };
    // TODO(client-characters): build the model.
  }

  /** Change the slot tint (player color). */
  setSlotColor(color: string): void {
    void color;
  }

  setExpression(expression: FaceExpression): void {
    void expression;
  }

  /** Ghost form: translucent, pale, no shadow, floating bob, ghost tail instead of legs. */
  setGhost(ghost: boolean): void {
    void ghost;
  }

  /** Damage flash (white blink) while hurtTicks > 0. */
  setFlash(on: boolean): void {
    void on;
  }

  dispose(): void {}
}
