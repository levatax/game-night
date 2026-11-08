// Procedural low-poly animals. Owner: client-characters.

import * as THREE from "three";
import { CHARACTERS } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import { getFaceSheet, setFaceOffset } from "./faces";
import { buildAnimalModel } from "./models";
import { AnimalMaterials, type Detail, PartBuilder } from "./parts";
import type { SpringBone } from "./rigTypes";
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
  /** Every spring bone, parents first ([] if none). */
  springs: ReadonlyArray<SpringBone>;
  /** Same objects as ears[0] / ears[1] (ears stays [right, left]); null if the animal has no ears. */
  earR: THREE.Object3D | null;
  earL: THREE.Object3D | null;
  /** Tail segments AFTER rig.extra (extra = segment 0). tailTip === tail[tail.length − 1] ?? null. */
  tail: ReadonlyArray<THREE.Object3D>;
  /** Hat / nightcap root / headband / scarf (may equal accessory). */
  headwear: THREE.Object3D | null;
  /** Scale pivots (Mochi cheeks [R, L]). */
  cheeks: ReadonlyArray<THREE.Object3D>;
  /** Hopsworth eye bulbs [R, L] (scale-y blink / pop). */
  eyeBulbs: ReadonlyArray<THREE.Object3D>;
}

export interface AnimalOptions {
  /** Geometry detail: "hi" (players, lobby) or "mid" (menu crowd). */
  detail?: "hi" | "mid";
}

/**
 * Built only from Three.js primitives merged per pivot (one vertex-colored toon mesh + one
 * inverted-hull outline per joint, ≤ ~28 draw calls and ≤ 2.4k body triangles per animal at "hi").
 * Chibi "gumdrop" proportions (big head fused into the torso), per-animal silhouette hooks on top,
 * behind and at the side, a slot-colored element visible from behind (+ wrist bands + tinted
 * outline), spring-bone pivots for ears / tails / hats (parts.springs), independent eyes and mouth
 * face sheets. Only the torso, head, legs and one big accessory cast shadows.
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
  private readonly eyesTexture: THREE.Texture;
  private readonly mouthTexture: THREE.Texture;
  private readonly casters: THREE.Mesh[];
  private currentExpression: FaceExpression = "idle";
  private currentMouth: FaceExpression = "idle";
  private isGhost = false;
  private shadows = true;

  constructor(character: CharacterId, slotColor: string, opts: AnimalOptions = {}) {
    this.character = character;
    const detail: Detail = opts.detail ?? "hi";
    const sheet = getFaceSheet(character);
    this.eyesTexture = sheet.clone();
    this.mouthTexture = sheet.clone();
    this.materials = new AnimalMaterials(CHARACTERS[character].colors, slotColor, {
      eyes: this.eyesTexture,
      mouth: this.mouthTexture,
    });
    const builder = new PartBuilder(this.materials, { detail, cacheKey: `${character}:${detail}` });
    const { root, skeleton: s, extras, spec, springs, finished } = buildAnimalModel(character, builder);
    root.name = `animal:${character}`;
    // Debug hook (dev harness spring-tip overlay).
    root.userData.springs = springs;
    this.topY = spec.topY;
    this.materials.setRimStrength(spec.rim ?? 0.28);
    this.casters = finished.casters;

    const face = finished.faces.get(extras.facePivot ?? "head") ?? finished.faces.values().next().value;
    if (!face) throw new Error(`Animal ${character}: no face mesh`);

    const tail = extras.tail;
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
      face,
    };
    this.parts = {
      offset: s.offset,
      spin: s.spin,
      upper: s.upper,
      jaw: extras.jaw,
      sac: extras.sac,
      belly: s.belly,
      ears: extras.ears,
      tailTip: tail[tail.length - 1] ?? null,
      ghostTail: s.ghostTail,
      accessory: extras.accessory,
      springs,
      earR: extras.ears[0] ?? null,
      earL: extras.ears[1] ?? null,
      tail,
      headwear: extras.headwear,
      cheeks: extras.cheeks,
      eyeBulbs: extras.eyeBulbs,
    };
    if (extras.sac) {
      this.sacScale.copy(extras.sac.scale);
      extras.sac.scale.setScalar(1e-3);
      extras.sac.visible = false;
    }
    if (s.belly) this.bellyScale.copy(s.belly.scale);
    if (isDev()) checkRestPose(this);
    this.applyFace();
  }

  get expression(): FaceExpression {
    return this.currentExpression;
  }

  /** Current mouth expression (independent of the eyes). */
  get mouthExpression(): FaceExpression {
    return this.currentMouth;
  }

  get ghost(): boolean {
    return this.isGhost;
  }

  /** Change the slot tint (player color): a uniform write. */
  setSlotColor(color: string): void {
    this.materials.setSlotColor(color);
  }

  setExpression(expression: FaceExpression): void {
    this.setFaceParts(expression, expression);
  }

  /** Eyes and mouth expressions independently (blinks never touch the mouth). Allocation-free. */
  setFaceParts(eyes: FaceExpression, mouth: FaceExpression): void {
    if (eyes === this.currentExpression && mouth === this.currentMouth) return;
    this.currentExpression = eyes;
    this.currentMouth = mouth;
    this.applyFace();
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
    this.eyesTexture.dispose();
    this.mouthTexture.dispose();
  }

  private applyFace(): void {
    setFaceOffset(this.eyesTexture, this.currentExpression);
    setFaceOffset(this.mouthTexture, this.currentMouth);
  }

  private applyShadows(): void {
    const cast = this.shadows && !this.isGhost;
    for (const mesh of this.casters) mesh.castShadow = cast;
  }
}

function isDev(): boolean {
  const env = (import.meta as unknown as { env?: { DEV?: boolean } }).env;
  return env?.DEV === true;
}

/** Dev-only: every pivot the animator / springs drive must rest at identity rotation and scale 1. */
function checkRestPose(animal: Animal): void {
  const p = animal.parts;
  const pivots: THREE.Object3D[] = [...p.springs.map((s) => s.pivot), ...p.cheeks, ...p.eyeBulbs, ...p.tail, ...p.ears];
  if (p.jaw) pivots.push(p.jaw);
  for (const o of pivots) {
    const q = o.quaternion;
    const s = o.scale;
    const identity = Math.abs(q.w) > 0.99999 && Math.abs(s.x - 1) < 1e-6 && Math.abs(s.y - 1) < 1e-6 && Math.abs(s.z - 1) < 1e-6;
    if (!identity) console.warn(`[Animal ${animal.character}] pivot "${o.name}" is not at identity rest pose`);
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

export interface AnimalBudget {
  meshes: number;
  drawCalls: number;
  triangles: number;
  outlineTriangles: number;
  casters: number;
}

/** Visible meshes / draw calls (multi-material groups count per group) / triangles / casters. */
export function measureBudget(root: THREE.Object3D): AnimalBudget {
  const out: AnimalBudget = { meshes: 0, drawCalls: 0, triangles: 0, outlineTriangles: 0, casters: 0 };
  const visit = (o: THREE.Object3D): void => {
    if (!o.visible) return;
    if (o instanceof THREE.Mesh) {
      const g = o.geometry as THREE.BufferGeometry;
      const tris = (g.index ? g.index.count : g.getAttribute("position").count) / 3;
      const calls = Array.isArray(o.material) ? Math.max(1, g.groups.length) : 1;
      if (o.userData.isOutline) {
        out.outlineTriangles += tris;
        out.drawCalls += calls;
      } else {
        out.meshes++;
        out.triangles += tris;
        out.drawCalls += calls;
        if (o.castShadow) out.casters++;
      }
    }
    for (const c of o.children) visit(c);
  };
  visit(root);
  return out;
}
