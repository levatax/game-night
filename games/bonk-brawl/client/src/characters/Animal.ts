// Procedural low-poly animals. Owner: client-characters.

import * as THREE from "three";
import { CHARACTERS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { addOutline } from "../render/Toon";
import { faceOffset, getFaceSheet } from "./faces";
import { buildAnimalModel } from "./models";
import { AnimalMaterials, OUTLINE_THICKNESS, PartBuilder } from "./parts";
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

/** Extra pivots beyond the contract rig (see models/common.ts for the hierarchy). */
export interface AnimalParts {
  /** Lift / lean container between the root and the squash body (pivot at the feet). */
  offset: THREE.Group;
  /** Rolls, tumbles, flips and twirls around the center of mass. */
  spin: THREE.Group;
  /** Upper body (torso, head, arms, tail) pivoting at the waist: twist and bend. */
  upper: THREE.Group;
  jaw: THREE.Object3D | null;
  sac: THREE.Object3D | null;
  belly: THREE.Object3D | null;
  ears: THREE.Object3D[];
  tailTip: THREE.Object3D | null;
  ghostTail: THREE.Group;
  accessory: THREE.Object3D | null;
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
  readonly parts: AnimalParts;
  /** Height of the top of the model incl. accessories (feet space, rest pose). */
  readonly topY: number;
  /** Rest scales of the parts the animator inflates (sac, belly). */
  readonly sacScale = new THREE.Vector3(1, 1, 1);
  readonly bellyScale = new THREE.Vector3(1, 1, 1);
  private readonly materials: AnimalMaterials;
  private readonly faceTexture: THREE.Texture;
  private readonly casters: THREE.Mesh[] = [];
  private currentExpression: FaceExpression = "idle";
  private isGhost = false;
  private shadows = true;

  constructor(character: CharacterId, slotColor: string) {
    this.character = character;
    this.materials = new AnimalMaterials(CHARACTERS[character].colors, slotColor);
    this.faceTexture = getFaceSheet(character).clone();
    const { root, skeleton: s, extras, spec } = buildAnimalModel(character, new PartBuilder(this.materials), this.faceTexture);
    root.name = `animal:${character}`;
    this.topY = spec.topY;

    for (const outline of addOutline(s.model, OUTLINE_THICKNESS)) outline.material = this.materials.outline;
    root.traverse((o) => {
      if (o instanceof THREE.Mesh && o.castShadow) this.casters.push(o);
    });

    this.rig = {
      root,
      body: s.body,
      head: s.head,
      armL: s.armL,
      armR: s.armR,
      legL: s.legL,
      legR: s.legR,
      extra: s.extra,
      hand: s.hand,
      headTop: s.headTop,
      face: extras.face,
    };
    this.parts = {
      offset: s.offset,
      spin: s.spin,
      upper: s.upper,
      jaw: extras.jaw,
      sac: extras.sac,
      belly: s.belly,
      ears: extras.ears,
      tailTip: extras.tailTip,
      ghostTail: s.ghostTail,
      accessory: extras.accessory,
    };
    if (extras.sac) {
      this.sacScale.copy(extras.sac.scale);
      extras.sac.scale.setScalar(1e-3);
      extras.sac.visible = false;
    }
    if (s.belly) this.bellyScale.copy(s.belly.scale);
    this.setExpression("idle");
  }

  get expression(): FaceExpression {
    return this.currentExpression;
  }

  get ghost(): boolean {
    return this.isGhost;
  }

  /** Change the slot tint (player color). */
  setSlotColor(color: string): void {
    this.materials.setSlotColor(color);
  }

  setExpression(expression: FaceExpression): void {
    this.currentExpression = expression;
    const { u, v } = faceOffset(expression);
    this.faceTexture.offset.set(u, v);
  }

  /** Ghost form: translucent, pale, no shadow, floating bob, ghost tail instead of legs. */
  setGhost(ghost: boolean): void {
    if (ghost === this.isGhost) return;
    this.isGhost = ghost;
    this.materials.setGhost(ghost);
    this.rig.legL.visible = !ghost;
    this.rig.legR.visible = !ghost;
    this.parts.ghostTail.visible = ghost;
    this.applyShadows();
  }

  /** 0..1 visibility of the ghost form (fade-in). */
  setGhostFade(fade: number): void {
    this.materials.setGhostFade(fade);
  }

  /** Damage flash (white blink) while hurtTicks > 0. */
  setFlash(on: boolean): void {
    this.materials.setFlash(on);
  }

  /** Show / hide the signature accessory (it pops off and floats away on a KO). */
  setAccessoryVisible(visible: boolean): void {
    if (this.parts.accessory) this.parts.accessory.visible = visible;
  }

  /** Toggle shadow casting (off for ghosts, the lobby preview casts its own). */
  setCastShadows(on: boolean): void {
    this.shadows = on;
    this.applyShadows();
  }

  dispose(): void {
    this.rig.root.removeFromParent();
    this.materials.dispose();
    this.faceTexture.dispose();
  }

  private applyShadows(): void {
    const cast = this.shadows && !this.isGhost;
    for (const mesh of this.casters) mesh.castShadow = cast;
  }
}

/** Triangle count of everything under `root` (outlines included), for the dev harness. */
export function countTriangles(root: THREE.Object3D): number {
  let count = 0;
  root.traverse((o) => {
    if (!(o instanceof THREE.Mesh)) return;
    const g = o.geometry as THREE.BufferGeometry;
    count += (g.index ? g.index.count : g.getAttribute("position").count) / 3;
  });
  return Math.round(count);
}
