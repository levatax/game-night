// One player's tourist in the match: model + animator, nameplate (status bubble, revive ring, golden
// sparkle), blob shadow, hit flash, the held item / clip props in the hand, and the washed-away exit.
// Owner: client-characters.

import * as THREE from "three";
import { playerColor } from "../../../shared/constants";
import type { CharacterId, InvKind, ItemKind } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import { toonColor } from "../render/Toon";
import { Animator } from "./Animator";
import type { CharacterTrigger, TriggerOptions } from "./Characters";
import { createHeldItem, releaseHeld } from "./holds";
import { boxGeo } from "./kit";
import { Nameplate, type PlateStatus } from "./Nameplate";
import { heldKindOf } from "./puppet";
import { type AvatarShadowPool, type BlobShadow, createBlobShadow, pooledBlobShadow } from "./shadowBlob";
import { Tourist } from "./Tourist";

const NAMEPLATE_GAP = 0.32;
const FLASH_SEC = 0.16;
const FLASH_HZ = 16;
/** Washed-away exit length (the "washed" clip). */
const WASH_EXIT_SEC = 0.9;
/** A vanished avatar waits this long for a "washed" trigger before it is removed. */
const LEAVE_GRACE_SEC = 0.2;
/** Nameplates fade to this opacity between these distances. */
const FADE_NEAR = 20;
const FADE_FAR = 55;
const FADE_MIN = 0.5;

/** What Characters tells an avatar each frame besides its frame. */
export interface AvatarContext {
  /** Hide the body (the local player in first person). */
  hidden: boolean;
  dark: number;
  camera: THREE.Vector3;
  /** Revive progress 0..1 when someone revives this (downed) player, else −1. */
  revive: number;
}

let phoneParts: { geometry: THREE.BufferGeometry; body: THREE.Material; screen: THREE.Material } | null = null;

/** The small phone non-Fenomen tourists pull out for the selfie emote. */
function createPhone(): THREE.Group {
  if (!phoneParts) phoneParts = { geometry: boxGeo(), body: toonColor("#22222A"), screen: toonColor("#7FD3F5", { emissive: "#7FD3F5", emissiveIntensity: 0.6 }) };
  const g = new THREE.Group();
  g.name = "phone";
  const body = new THREE.Mesh(phoneParts.geometry, phoneParts.body);
  body.scale.set(0.075, 0.012, 0.14);
  const screen = new THREE.Mesh(phoneParts.geometry, phoneParts.screen);
  screen.scale.set(0.064, 0.002, 0.124);
  screen.position.y = 0.007;
  g.add(body, screen);
  g.rotation.x = -0.4;
  return g;
}

export class Avatar {
  readonly id: string;
  readonly character: CharacterId;
  readonly tourist: Tourist;
  readonly animator: Animator;
  private readonly nameplate: Nameplate;
  private readonly shadow: BlobShadow;
  private readonly scene: THREE.Object3D;
  private seat: number;
  private time = 0;
  private flashLeft = 0;
  private lastGroundY = 0;
  private heldNow: InvKind = "";
  private readonly propCache = new Map<string, THREE.Object3D>();
  private prop: THREE.Object3D | null = null;
  private leaving: { t: number; washed: boolean } | null = null;
  /** Sync stamp (Characters removes avatars it didn't see this frame). */
  stamp = 0;

  constructor(scene: THREE.Object3D, frame: PlayerFrame, shadows: AvatarShadowPool | null = null) {
    this.id = frame.id;
    this.character = frame.character;
    this.scene = scene;
    this.seat = frame.seat;
    this.tourist = new Tourist(frame.character, playerColor(frame.seat));
    this.animator = new Animator(this.tourist);
    this.nameplate = new Nameplate();
    const radius = 0.42 * this.tourist.spec.scale;
    const slot = shadows ? shadows.acquire() : -1;
    this.shadow = shadows && slot >= 0 ? pooledBlobShadow(shadows, slot, radius, 0.28) : createBlobShadow(radius, 0.28);
    this.tourist.rig.root.position.set(frame.x, frame.y, frame.z);
    this.lastGroundY = frame.y;
    scene.add(this.tourist.rig.root, this.nameplate.object);
    // The shared pool already lives under the characters root; only a fallback quad is added per avatar.
    if (!shadows || slot < 0) scene.add(this.shadow.mesh);
  }

  get isLeaving(): boolean {
    return this.leaving !== null;
  }

  sync(frame: PlayerFrame, ctx: AvatarContext, dt: number): void {
    this.time += dt;
    if (frame.seat !== this.seat) {
      this.seat = frame.seat;
      this.tourist.setSeatColor(playerColor(frame.seat));
    }
    const root = this.tourist.rig.root;
    root.position.set(frame.x, frame.y, frame.z);
    if (frame.grounded && !frame.swimming) this.lastGroundY = frame.y;
    this.tourist.setCosmetic(frame.cosmetic);
    const hidden = ctx.hidden || frame.spectator || frame.washed || !frame.alive;
    root.visible = !hidden;
    this.shadow.setVisible(!hidden && !frame.swimming);
    if (hidden) {
      this.nameplate.object.visible = false;
      root.rotation.y = frame.yaw;
      return;
    }

    const held = heldKindOf(frame);
    this.heldNow = held;
    this.tourist.setHeld(held);
    this.animator.update(frame, held, dt);
    this.updateProps(held);
    this.tourist.setFlame(held === "torch" && frame.torchTicks > 0, this.time);

    this.flashLeft = Math.max(0, this.flashLeft - dt);
    this.tourist.setFlash(this.flashLeft > 0 && Math.floor(this.time * FLASH_HZ) % 2 === 0);
    this.shadow.place(frame.x, Math.min(frame.y, this.lastGroundY), frame.z, frame.y - this.lastGroundY);
    this.updateNameplate(frame, ctx, dt);
  }

  trigger(what: CharacterTrigger, opts?: TriggerOptions): void {
    if (what === "washed" && this.leaving) {
      this.leaving.washed = true;
      this.leaving.t = 0;
    }
    if (what === "hit") this.flashLeft = FLASH_SEC;
    if (what === "respawn" || what === "revived") this.animator.reset();
    this.animator.trigger(what, opts ?? {}, this.heldNow);
  }

  /** The player vanished from the frames: keep the body a moment for the washed-away exit. */
  beginLeave(): void {
    if (this.leaving) return;
    this.leaving = { t: 0, washed: this.animator.hasClip("washed") };
    this.nameplate.object.visible = false;
    this.shadow.setVisible(false);
  }

  /** Revive a leaving avatar (the frame came back). */
  cancelLeave(): void {
    this.leaving = null;
  }

  /** Advance the exit; true when it is over (dispose). */
  updateLeaving(frame: PlayerFrame | null, dt: number): boolean {
    const l = this.leaving;
    if (!l) return false;
    l.t += dt;
    this.time += dt;
    if (frame && l.washed) this.animator.update(frame, this.heldNow, dt);
    return l.washed ? l.t >= WASH_EXIT_SEC : l.t >= LEAVE_GRACE_SEC;
  }

  /** World position of the right hand grip (projectile origin), or of a held rod's tip (bobber line). */
  handPosition(out: THREE.Vector3): void {
    if (this.heldNow === "rod" && this.tourist.heldTip(out)) return;
    this.tourist.rig.gripR.getWorldPosition(out);
  }

  /** Stable point above the head (doesn't follow squashes). */
  headTop(out: THREE.Vector3): void {
    const p = this.tourist.rig.root.position;
    out.set(p.x, p.y + this.tourist.topY, p.z);
  }

  dispose(): void {
    this.nameplate.dispose();
    this.shadow.dispose();
    this.tourist.dispose();
    for (const [key, obj] of this.propCache) if (key !== "phone") releaseHeld(obj);
    this.propCache.clear();
    this.scene.remove(this.tourist.rig.root);
  }

  /* ----------------------------------------------------------- internals */

  /** Hide the held item when it left the hand; show the clip's food / phone. */
  private updateProps(held: InvKind): void {
    const { prop, item } = this.animator.clipProp;
    let want: THREE.Object3D | null = null;
    if (prop === "phone") want = this.propObject("phone");
    else if (prop === "food" && item !== "") want = this.propObject(item);
    if (want !== this.prop) {
      if (this.prop) this.prop.visible = false;
      this.prop = want;
      if (want) {
        if (want.parent !== this.tourist.rig.gripR) this.tourist.rig.gripR.add(want);
        want.visible = true;
      }
    }
    const released = this.animator.heldReleased;
    this.tourist.setHeldVisible(held !== "" && !released && !(this.prop && prop === "food"));
  }

  private propObject(key: "phone" | ItemKind): THREE.Object3D {
    let obj = this.propCache.get(key);
    if (!obj) {
      obj = key === "phone" ? createPhone() : createHeldItem(key, "third");
      this.propCache.set(key, obj);
    }
    return obj;
  }

  private updateNameplate(frame: PlayerFrame, ctx: AvatarContext, dt: number): void {
    const plate = this.nameplate;
    plate.object.visible = true;
    const p = this.tourist.rig.root.position;
    const lift = frame.downed ? 0.75 * this.tourist.spec.scale : frame.boarded ? this.tourist.topY - 0.32 : frame.swimming ? this.tourist.topY - 0.75 : this.tourist.topY;
    plate.object.position.set(p.x, p.y + lift + NAMEPLATE_GAP, p.z);
    plate.setLook(frame.nickname, playerColor(frame.seat), frame.bot, frame.connected, frame.golden, ctx.dark);
    const status: PlateStatus = frame.downed ? "downed" : frame.boarded ? "boarded" : "none";
    plate.setStatus(status, ctx.revive);
    const d = p.distanceTo(ctx.camera);
    const fade = d <= FADE_NEAR ? 1 : d >= FADE_FAR ? FADE_MIN : 1 - ((d - FADE_NEAR) / (FADE_FAR - FADE_NEAR)) * (1 - FADE_MIN);
    plate.setOpacity(frame.downed ? 1 : fade);
    plate.update(dt);
  }
}
