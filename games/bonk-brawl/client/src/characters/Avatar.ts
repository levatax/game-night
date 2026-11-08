// One player's animal in the match: animator, nameplate, crown, damage flash and the KO /
// ring-out → ghost sequence. Owner: client-characters.

import * as THREE from "three";
import { GRAVITY, MAX_FALL_SPEED, playerColor } from "../../../shared/constants";
import type { CharacterId, Vec3Like } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import { Animal } from "./Animal";
import { Animator } from "./Animator";
import { KO_POP_SEC } from "./clips";
import { KoMemento } from "./Memento";
import { createCrown, Nameplate, updateCrown } from "./Nameplate";
import type { AnimTrigger, CharacterSyncOptions, TriggerOptions } from "./types";

/** Ghost floats this high above its anchor (the KO spot / last grounded position). */
const GHOST_HEIGHT = 1.5;
/** KO: the ghost fades in this long after the pop. Ring-out: after the body tumbled away. */
const KO_GHOST_DELAY = KO_POP_SEC + 0.45;
const RING_OUT_GHOST_DELAY = 0.9;
const RING_OUT_FALL_SEC = 1.3;
const GHOST_FADE_SEC = 0.5;
/** The local ghost is hidden while the camera is closer than this to it. */
const LOCAL_GHOST_HIDE_DIST = 2.5;
/** Give up waiting for frame.alive to go false after a KO trigger (missed patch). */
const REVIVE_TIMEOUT = 4;
/** topY includes the tallest flair (ears, hats), so the gap above it is smaller. */
const NAMEPLATE_GAP = 0.36;
const CROWN_GAP = 0.05;
const FLASH_HZ = 14;

type EliminationKind = "ko" | "ringOut" | "silent";

interface Elimination {
  kind: EliminationKind;
  anchor: THREE.Vector3;
  t: number;
  /** frame.alive was seen false since the trigger (so a later alive=true is a real revive). */
  sawDead: boolean;
  /** Ring-out cosmetic fall. */
  fallPos: THREE.Vector3;
  fallVel: THREE.Vector3;
  ghostShown: boolean;
}

export class Avatar {
  readonly id: string;
  readonly character: CharacterId;
  readonly animal: Animal;
  readonly animator: Animator;
  private readonly nameplate: Nameplate;
  private readonly scene: THREE.Object3D;
  private crown: THREE.Object3D | null = null;
  private memento: KoMemento | null = null;
  private elimination: Elimination | null = null;
  /** Latest velocity while alive (the ring-out fall continues it). */
  private readonly lastVelocity = new THREE.Vector3();
  private slot: number;
  private time = 0;
  /** Sync stamp (Characters removes avatars it didn't see this frame). */
  stamp = 0;

  constructor(scene: THREE.Object3D, frame: PlayerFrame) {
    this.id = frame.id;
    this.character = frame.character;
    this.scene = scene;
    this.slot = frame.slot;
    const color = playerColor(frame.slot);
    this.animal = new Animal(frame.character, color);
    this.animator = new Animator(this.animal, frame.character);
    this.nameplate = new Nameplate(frame.nickname, color);
    this.animal.rig.root.position.set(frame.x, frame.y, frame.z);
    scene.add(this.animal.rig.root, this.nameplate.object);
  }

  sync(frame: PlayerFrame, opts: CharacterSyncOptions, dt: number): void {
    this.time += dt;
    if (frame.slot !== this.slot) this.setSlot(frame.slot);
    const root = this.animal.rig.root;
    if (frame.spectator) {
      root.visible = false;
      this.nameplate.object.visible = false;
      if (this.memento) this.memento.object.visible = false;
      return;
    }
    this.trackLife(frame);
    const elim = this.elimination;
    if (elim) this.updateElimination(elim, frame, dt, opts);
    else this.updateAlive(frame, dt, opts);
    this.updateCrown(opts.crownId === this.id);
    this.updateNameplate(frame, opts);
    this.memento?.update(dt);
  }

  trigger(anim: AnimTrigger, opts?: TriggerOptions): void {
    if (anim === "ko" || anim === "ringOut") {
      this.eliminate(anim, opts?.pos ?? null);
      return;
    }
    // A popped / fallen body doesn't react (ghosts may still emote and dance).
    if (this.elimination && !this.elimination.ghostShown) return;
    this.animator.trigger(anim, opts);
  }

  getHandPosition(out: THREE.Vector3): void {
    this.animal.rig.hand.getWorldPosition(out);
  }

  /** Stable point above the head (doesn't follow flips and squashes). */
  getHeadTop(out: THREE.Vector3): void {
    const root = this.animal.rig.root.position;
    out.set(root.x, root.y + this.animal.topY, root.z);
  }

  dispose(): void {
    this.memento?.dispose();
    this.memento = null;
    this.crown?.removeFromParent();
    this.crown = null;
    this.nameplate.dispose();
    this.animal.dispose();
  }

  /* ------------------------------------------------------------- alive */

  private updateAlive(frame: PlayerFrame, dt: number, opts: CharacterSyncOptions): void {
    const root = this.animal.rig.root;
    root.position.set(frame.x, frame.y, frame.z);
    root.visible = !(opts.hideLocal && frame.id === opts.localId);
    this.lastVelocity.set(frame.vx, frame.vy, frame.vz);
    this.animator.update(frame, dt);
    this.animal.setFlash(frame.hurtTicks > 0 && Math.floor(this.time * FLASH_HZ) % 2 === 0);
  }

  /** Start / leave ghost form from frame.alive (handles missed triggers and revives). */
  private trackLife(frame: PlayerFrame): void {
    const elim = this.elimination;
    if (!frame.alive) {
      if (!elim) this.eliminate("silent", null, frame);
      else elim.sawDead = true;
      return;
    }
    if (elim && (elim.sawDead || elim.t > REVIVE_TIMEOUT)) this.revive();
  }

  private revive(): void {
    this.elimination = null;
    this.memento?.dispose();
    this.memento = null;
    this.animal.setGhost(false);
    this.animal.setGhostFade(1);
    this.animal.setAccessoryVisible(true);
    this.animal.rig.root.visible = true;
    this.animator.reset();
    this.nameplate.setOpacity(1);
  }

  /* -------------------------------------------------------- elimination */

  private eliminate(kind: EliminationKind, pos: Vec3Like | null, frame?: PlayerFrame): void {
    const current = this.elimination;
    // A trigger upgrades a silent ghost (state arrived first) but never restarts a sequence.
    if (current && (current.kind !== "silent" || kind === "silent")) return;
    const root = this.animal.rig.root;
    const anchor = new THREE.Vector3();
    if (pos) anchor.set(pos.x, pos.y, pos.z);
    else if (frame) anchor.set(frame.x, Math.max(0, frame.y), frame.z);
    else anchor.copy(root.position);

    const elim: Elimination = {
      kind,
      anchor,
      t: 0,
      sawDead: current?.sawDead ?? false,
      fallPos: root.position.clone(),
      fallVel: this.lastVelocity.clone(),
      ghostShown: false,
    };
    this.elimination = elim;
    this.animal.setFlash(false);
    if (current) {
      // The state said "dead" before the event arrived: pop / fall from the event position.
      this.leaveGhost();
      root.position.copy(anchor);
      elim.fallPos.copy(anchor);
    }
    if (kind === "ko") {
      this.animator.trigger("ko");
    } else if (kind === "ringOut") {
      this.animator.trigger("ringOut");
      elim.fallVel.y = Math.min(elim.fallVel.y, 1);
    } else {
      this.showGhost(elim, 1);
    }
  }

  private updateElimination(elim: Elimination, frame: PlayerFrame, dt: number, opts: CharacterSyncOptions): void {
    elim.t += dt;
    const root = this.animal.rig.root;
    if (elim.ghostShown) {
      root.position.set(elim.anchor.x, elim.anchor.y + GHOST_HEIGHT, elim.anchor.z);
      this.animal.setGhostFade(Math.min(1, elim.t / GHOST_FADE_SEC));
      const cam = frame.id === opts.localId ? opts.cameraPos : undefined;
      root.visible = !cam || root.position.distanceTo(cam as THREE.Vector3Like) > LOCAL_GHOST_HIDE_DIST;
      this.animator.update(frame, dt);
      return;
    }
    if (elim.kind === "ko") this.updatePop(elim, frame, dt);
    else this.updateFall(elim, frame, dt);
  }

  /** KO: the pop clip plays on the spot, then the body vanishes (fx puffs) and the hat floats. */
  private updatePop(elim: Elimination, frame: PlayerFrame, dt: number): void {
    const root = this.animal.rig.root;
    if (elim.t < KO_POP_SEC) {
      root.visible = true;
      this.animator.update(frame, dt);
      return;
    }
    if (root.visible) {
      root.visible = false;
      this.dropMemento(elim.anchor);
    }
    if (elim.t >= KO_GHOST_DELAY) this.showGhost(elim, 0);
  }

  /** Ring-out: keep tumbling down out of view, then the ghost appears over the island. */
  private updateFall(elim: Elimination, frame: PlayerFrame, dt: number): void {
    const root = this.animal.rig.root;
    elim.fallVel.y = Math.max(-MAX_FALL_SPEED, elim.fallVel.y + GRAVITY * dt);
    elim.fallPos.addScaledVector(elim.fallVel, dt);
    root.position.copy(elim.fallPos);
    root.visible = elim.t < RING_OUT_FALL_SEC;
    this.animator.update(frame, dt);
    if (elim.t >= RING_OUT_GHOST_DELAY) this.showGhost(elim, 0);
  }

  private showGhost(elim: Elimination, fade: number): void {
    elim.ghostShown = true;
    elim.t = fade * GHOST_FADE_SEC;
    this.animator.reset();
    this.animator.setGhostMode(true);
    this.animal.setGhost(true);
    this.animal.setGhostFade(fade);
    this.animal.setAccessoryVisible(!this.memento);
    const root = this.animal.rig.root;
    root.position.set(elim.anchor.x, elim.anchor.y + GHOST_HEIGHT, elim.anchor.z);
    root.visible = true;
  }

  private leaveGhost(): void {
    this.animal.setGhost(false);
    this.animal.setGhostFade(1);
    this.animator.reset();
  }

  private dropMemento(at: THREE.Vector3): void {
    if (this.memento) return;
    this.memento = new KoMemento(this.character, playerColor(this.slot), at);
    this.scene.add(this.memento.object);
    this.animal.setAccessoryVisible(false);
  }

  /* ---------------------------------------------------- crown, nameplate */

  private updateCrown(crowned: boolean): void {
    if (crowned && !this.crown) {
      this.crown = createCrown();
      this.crown.position.set(0, CROWN_GAP, 0);
      this.animal.rig.headTop.add(this.crown);
    }
    if (!this.crown) return;
    this.crown.visible = crowned;
    if (crowned) updateCrown(this.crown, this.time);
  }

  private updateNameplate(frame: PlayerFrame, opts: CharacterSyncOptions): void {
    const plate = this.nameplate;
    const root = this.animal.rig.root;
    const hidden = frame.id === opts.localId || !root.visible;
    plate.object.visible = !hidden;
    if (hidden) return;
    const ghost = this.elimination?.ghostShown ?? false;
    const crownLift = this.crown?.visible ? 0.28 : 0;
    plate.object.position.set(root.position.x, root.position.y + this.animal.topY + NAMEPLATE_GAP + crownLift, root.position.z);
    plate.update(frame.nickname, playerColor(frame.slot), ghost ? 0 : frame.hearts);
    plate.setConnected(frame.connected);
    plate.setOpacity(ghost ? 0.65 : 1);
  }

  private setSlot(slot: number): void {
    this.slot = slot;
    this.animal.setSlotColor(playerColor(slot));
  }
}
