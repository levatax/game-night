// One Ship Tourist in the scene: the bone groups the Animator drives, one baked mesh (+ outline hull) per bone
// shared with every other instance of the character, the meshed face (eyes / smile / open mouth), the seat-
// colored all-inclusive wristband, the held item in the right fist and the hit flash. Owner: client-characters.

import * as THREE from "three";
import type { CharacterId, InvKind, ItemKind } from "../../../shared/types";
import { getSmoothOutlineGeometry, toonColor } from "../render/Toon";
import { COSMETIC_HEAD_R, createCosmetic } from "./cosmetics";
import { createHeldItem, flickerHeld, heldTipWorld, holdClass, type HoldClass, releaseHeld } from "./holds";
import { bodyMaterial, faceMaterial, flashMaterial, seatOutline, torusGeo } from "./kit";
import { type BoneName, getTouristBake, SPIN_Y, type TouristBake, type TouristSpec } from "./models";
import { boneParent, MESH_BONES } from "./models/common";
import type { FaceParams } from "./pose";

/** Outline thickness of tourists (view-space meters, grows with distance in the shader). */
export const TOURIST_OUTLINE = 0.022;

/** Every pivot the Animator writes. Groups are pivoted at their joint; meshes are their children. */
export interface TouristRig {
  /** World placement (feet, yaw) and the overall character scale. */
  root: THREE.Group;
  offset: THREE.Group;
  body: THREE.Group;
  spin: THREE.Group;
  model: THREE.Group;
  upper: THREE.Group;
  head: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  extra: THREE.Group | null;
  /** Baked torso mesh (puff inflates it). */
  torso: THREE.Mesh | null;
  eyes: THREE.Object3D | null;
  mouthSmile: THREE.Object3D | null;
  mouthOpen: THREE.Object3D | null;
  /** Right / left hand grips (held item, signature prop). */
  gripR: THREE.Object3D;
  gripL: THREE.Object3D;
  /** Above the head: a raft part balanced on the head. */
  carryTop: THREE.Object3D;
  /** Fenomen's ring light. */
  glow: THREE.Mesh | null;
}

export interface TouristOptions {
  /** Ink outlines (default on). */
  outlines?: boolean;
  /** Body meshes cast shadows (default on). */
  shadows?: boolean;
}

export class Tourist {
  readonly character: CharacterId;
  readonly spec: TouristSpec;
  readonly rig: TouristRig;
  /** Top of the model (world meters above the feet, scale applied). */
  readonly topY: number;
  private readonly bake: TouristBake;
  private readonly bodyMeshes: THREE.Mesh[] = [];
  private readonly outlines: THREE.Mesh[] = [];
  private readonly band: THREE.Mesh;
  private readonly glowMaterial: THREE.MeshBasicMaterial | null = null;
  private readonly heldCache = new Map<ItemKind, THREE.Group>();
  private held: THREE.Group | null = null;
  private heldKind: InvKind = "";
  private flash = false;
  private seatColor: string | null;
  private cosmeticKind = "";
  private cosmetic: THREE.Object3D | null = null;

  constructor(character: CharacterId, seatColor: string | null, opts: TouristOptions = {}) {
    this.character = character;
    this.bake = getTouristBake(character);
    this.spec = this.bake.spec;
    this.seatColor = seatColor;
    this.topY = this.spec.topY * this.spec.scale;
    const pv = this.bake.pivots;

    const root = new THREE.Group();
    root.name = `tourist:${character}`;
    root.scale.setScalar(this.spec.scale);
    const offset = new THREE.Group();
    const body = new THREE.Group();
    const spin = new THREE.Group();
    const model = new THREE.Group();
    offset.rotation.order = "YXZ";
    spin.rotation.order = "YXZ";
    spin.position.y = SPIN_Y;
    model.position.y = -SPIN_Y;
    root.add(offset);
    offset.add(body);
    body.add(spin);
    spin.add(model);

    const groups = new Map<BoneName | "model", THREE.Group>();
    groups.set("model", model);
    const order: BoneName[] = ["upper", "legL", "legR", "head", "armL", "armR", "extra", "eyes", "mouthSmile", "mouthOpen"];
    for (const name of order) {
      if (name === "extra" && !this.spec.extra) continue;
      const parentName = boneParent(name, this.spec);
      const parent = groups.get(parentName)!;
      const parentPivot = parentName === "model" ? new THREE.Vector3() : pv[parentName];
      const g = new THREE.Group();
      g.name = name;
      g.position.copy(pv[name]).sub(parentPivot);
      parent.add(g);
      groups.set(name, g);
    }
    const head = groups.get("head")!;
    head.rotation.order = "YXZ";
    groups.get("legL")!.rotation.order = "YXZ";
    groups.get("legR")!.rotation.order = "YXZ";

    const outlines = opts.outlines ?? true;
    const shadows = opts.shadows ?? true;
    let torso: THREE.Mesh | null = null;
    for (const [name, bone] of Object.entries(this.bake.bones) as [BoneName, NonNullable<TouristBake["bones"][BoneName]>][]) {
      const group = groups.get(name);
      if (!group) continue;
      const face = !MESH_BONES.includes(name);
      const mesh = new THREE.Mesh(bone.geometry, face ? faceMaterial() : bodyMaterial());
      mesh.name = `${name}-mesh`;
      mesh.castShadow = shadows && !face;
      mesh.receiveShadow = false;
      group.add(mesh);
      if (!face) this.bodyMeshes.push(mesh);
      if (name === "upper") torso = mesh;
      if (outlines && bone.outline) {
        const hull = new THREE.Mesh(getSmoothOutlineGeometry(bone.outline), seatOutline(TOURIST_OUTLINE, seatColor));
        hull.name = "outline";
        hull.userData.isOutline = true;
        hull.castShadow = false;
        hull.raycast = () => {};
        mesh.add(hull);
        this.outlines.push(hull);
      }
    }

    const armL = groups.get("armL")!;
    const armR = groups.get("armR")!;
    const gripR = new THREE.Object3D();
    gripR.name = "gripR";
    gripR.position.copy(this.bake.gripR).sub(pv.armR);
    armR.add(gripR);
    const gripL = new THREE.Object3D();
    gripL.name = "gripL";
    gripL.position.copy(this.bake.gripL).sub(pv.armL);
    armL.add(gripL);
    const carryTop = new THREE.Object3D();
    carryTop.name = "carryTop";
    carryTop.position.set(0, this.spec.headAt[1] + this.spec.headR[1] + 0.07 - pv.head.y, this.spec.headAt[2]);
    head.add(carryTop);

    // All-inclusive wristband in the seat color.
    this.band = new THREE.Mesh(torusGeo(0.34, Math.PI * 2, 3, 8), toonColor(seatColor ?? "#FFFFFF"));
    this.band.name = "wristband";
    this.band.position.copy(this.bake.bandAt).sub(pv.armL);
    this.band.scale.setScalar(this.bake.bandR * 1.2);
    this.band.visible = seatColor !== null;
    armL.add(this.band);

    let glow: THREE.Mesh | null = null;
    const g = this.bake.glow;
    if (g) {
      this.glowMaterial = new THREE.MeshBasicMaterial({ color: g.color, toneMapped: false });
      glow = new THREE.Mesh(torusGeo(g.tube / g.radius, Math.PI * 2, 4, 12), this.glowMaterial);
      glow.name = "ringLight";
      glow.position.copy(g.at).sub(pv[g.bone]);
      glow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), g.axis);
      glow.scale.setScalar(g.radius);
      groups.get(g.bone)!.add(glow);
    }

    this.rig = {
      root,
      offset,
      body,
      spin,
      model,
      upper: groups.get("upper")!,
      head,
      armL,
      armR,
      legL: groups.get("legL")!,
      legR: groups.get("legR")!,
      extra: groups.get("extra") ?? null,
      torso,
      eyes: groups.get("eyes") ?? null,
      mouthSmile: groups.get("mouthSmile") ?? null,
      mouthOpen: groups.get("mouthOpen") ?? null,
      gripR,
      gripL,
      carryTop,
      glow,
    };
    if (this.rig.eyes && this.spec.hideEyes) this.rig.eyes.visible = false;
  }

  /** Change the seat tint (outline + wristband). null = neutral ink, no band. */
  setSeatColor(color: string | null): void {
    if (color === this.seatColor) return;
    this.seatColor = color;
    const outline = seatOutline(TOURIST_OUTLINE, color);
    for (const o of this.outlines) o.material = outline;
    this.band.material = toonColor(color ?? "#FFFFFF");
    this.band.visible = color !== null;
  }

  /** White hit flash on the body meshes. */
  setFlash(on: boolean): void {
    if (on === this.flash) return;
    this.flash = on;
    const m = on ? flashMaterial() : bodyMaterial();
    for (const mesh of this.bodyMeshes) mesh.material = m;
  }

  /** Apply face parameters (eyes open / size, smile arc, open mouth). */
  setFace(f: FaceParams): void {
    const { eyes, mouthSmile, mouthOpen } = this.rig;
    if (eyes) eyes.scale.set(f.eyeSize, Math.max(0.04, f.eyeOpen) * f.eyeSize, f.eyeSize);
    const open = f.jaw > 0.12;
    if (mouthSmile) {
      mouthSmile.visible = !open && f.smile > 0.02;
      mouthSmile.scale.set(0.65 + 0.35 * f.smile, Math.max(0.05, f.smile), 1);
    }
    if (mouthOpen) {
      mouthOpen.visible = open;
      mouthOpen.scale.set(0.7 + 0.35 * f.jaw, 0.3 + 0.8 * f.jaw, 1);
    }
  }

  /** Show `kind` in the right fist (or nothing). Big items ride on the head (both hands up). */
  setHeld(kind: InvKind): void {
    if (kind === this.heldKind) return;
    this.heldKind = kind;
    if (this.held) this.held.visible = false;
    this.held = null;
    if (kind === "") return;
    let obj = this.heldCache.get(kind);
    if (!obj) {
      obj = createHeldItem(kind, "third");
      obj.traverse((o) => {
        o.castShadow = (o as THREE.Mesh).isMesh === true;
      });
      this.heldCache.set(kind, obj);
    }
    const cls = holdClass(kind);
    const anchor = cls === "big" ? this.rig.carryTop : this.rig.gripR;
    if (obj.parent !== anchor) anchor.add(obj);
    obj.visible = true;
    this.held = obj;
  }

  get heldItem(): InvKind {
    return this.heldKind;
  }

  get heldClass(): HoldClass | null {
    return this.heldKind === "" ? null : holdClass(this.heldKind);
  }

  /** The held item object (null when empty-handed). */
  get heldObject(): THREE.Object3D | null {
    return this.held;
  }

  /** Hide / show the held item without forgetting it (thrown this instant, eaten...). */
  setHeldVisible(v: boolean): void {
    if (this.held) this.held.visible = v;
  }

  /** Flicker a held lit torch's flame (hidden when burnt out). */
  setFlame(lit: boolean, time: number): void {
    if (this.held && this.heldKind === "torch") flickerHeld(this.held, time, lit);
  }

  /** World position of the held tool's tip (rod tip for the fishing line); false without one. */
  heldTip(out: THREE.Vector3): boolean {
    return this.held !== null && this.held.visible && heldTipWorld(this.held, out);
  }

  /** Worn cosmetic (PlayerView.cosmetic: "" | "pirate_hat"), sat just above the head. */
  setCosmetic(kind: string): void {
    if (kind === this.cosmeticKind) return;
    this.cosmeticKind = kind;
    this.cosmetic?.removeFromParent();
    this.cosmetic = createCosmetic(kind);
    if (!this.cosmetic) return;
    const headR = Math.max(this.spec.headR[0], this.spec.headR[2]);
    this.cosmetic.scale.setScalar(headR / COSMETIC_HEAD_R);
    // carryTop floats 7 cm above the crown: sink the brim onto the head.
    this.cosmetic.position.y = -0.07 - headR * 0.25;
    this.rig.carryTop.add(this.cosmetic);
  }

  /** Ring light intensity (selfie flash): 1 = normal, > 1 overexposed (blooms). */
  setGlow(intensity: number): void {
    if (!this.glowMaterial) return;
    this.glowMaterial.color.set(this.bake.glow?.color ?? "#FFFFFF").multiplyScalar(Math.max(0.2, intensity));
  }

  setCastShadows(on: boolean): void {
    for (const m of this.bodyMeshes) m.castShadow = on;
  }

  setOutlinesVisible(on: boolean): void {
    for (const o of this.outlines) o.visible = on;
  }

  dispose(): void {
    this.rig.root.removeFromParent();
    this.glowMaterial?.dispose();
    for (const h of this.heldCache.values()) releaseHeld(h);
    this.heldCache.clear();
  }
}
