// The six "Ship Tourists" (bean-bodied, procedural low-poly toon), their animation, nameplates, the first-
// person arms, and the monsters (crabs with googly neon eyes, puffer balls, Kaptan Yengeç with a captain hat,
// monkeys, Şükrü the gull). Owner: client-characters. Signatures by the architect; keep them.
//
// Copy + adapt: games/bonk-brawl/client/src/characters/{Animator,clips,pose,rigPose,states,Nameplate,shadowBlob,
// puppet}.ts, games/kasala/client/src/scene/characters/fpArms.ts (outfit sleeves per character; hold / throw /
// rod / torch / eat / gather gestures), games/jelly-jackpot/client/src/scene/toon.ts (googlyEyes).
// New: models/{kaptan,fenomen,amca,gelin,sef,cocuk}.ts, monsters/*.ts, held-item meshes in hands.
//
// Layout of this folder:
//   Characters.ts   facades (Characters, FpArms, Monsters) and the cross-module types
//   Avatar.ts       one player: Tourist model + Animator + Nameplate + blob shadow + props
//   Tourist.ts      the baked bean-body model instance (bones, face, wristband, held item, flash)
//   models/         the six character builds (common.ts: builder + shared body)
//   Animator.ts     states.ts (continuous) + clips.ts (one-shots) + pose.ts / rigPose.ts
//   fpArms.ts       first-person arms: sleeves, springs, sway, the item swap, base poses (ik.ts: two-bone IK)
//   fpHand.ts       the skinned first-person hand (one bone per phalanx) and its poses (named + grip / cup)
//   fpHolds.ts      how every item sits in the first-person hand(s) (anchor, pose, orientation, rest spot)
//   fpMotion.ts     keyframed first-person clips (gestures with item variants, charge wind-ups, fidgets)
//   holds.ts        how item meshes (fx/itemMeshes) sit in a third-person hand
//   monsters/       crab, boss, puffer (instanced pools), monkey, gull, the manager (index.ts)
//   Nameplate.ts, shadowBlob.ts, portraits.ts, puppet.ts, kit.ts (geometry cache + merge + materials)

import * as THREE from "three";
import { CHANNEL, playerColor, REVIVE_TICKS } from "../../../shared/constants";
import type { CharacterId, EmoteId, InvKind, ItemKind, Vec3Like } from "../../../shared/types";
import type { MonsterFrame, PlayerFrame } from "../net/types";
import { Avatar } from "./Avatar";
import { AvatarShadowPool } from "./shadowBlob";
import { CharacterBatcher } from "./CharacterBatcher";
import { FpArmsRig } from "./fpArms";
import { MonsterHerd } from "./monsters";
import { portraitOf } from "./portraits";

/** One-shot animations triggered by events. */
export type CharacterTrigger =
  | "throw"
  | "toss"
  | "use"
  | "gather"
  | "eat"
  | "catch"
  | "hit"
  | "downed"
  | "revived"
  | "washed"
  | "respawn"
  | "land"
  | "cast"
  | "reel"
  | "emote"
  | "board"
  | "cheer"
  | "inflate";

export interface TriggerOptions {
  dir?: Vec3Like;
  emote?: EmoteId;
  item?: ItemKind;
}

export interface CharacterSyncOptions {
  localId: string;
  /** Hide the local body (first person); its FpArms are drawn instead. */
  firstPerson: boolean;
  /** 0 (day) .. 1 (night): nameplates brighten / outline at night. */
  dark: number;
}

export type MonsterTrigger = "spawn" | "hurt" | "flip" | "unflip" | "attack" | "die" | "flee" | "steal" | "drop";

/** What the first-person arms show this frame. */
export interface FpArmsFrame {
  character: CharacterId;
  held: InvKind;
  count: number;
  /** 0..1 throw charge. */
  charge: number;
  /** Hold-E channel progress 0..1 (gather swing / revive pump), -1 none. */
  channel: number;
  channelKind: number;
  speed: number;
  grounded: boolean;
  sprinting: boolean;
  swimming: boolean;
  downed: boolean;
  /** FISH_STATE.* */
  fishState: number;
  torchLit: boolean;
  /** 0..1 fuse left while holding a puffer (-1 none): shaking hands. */
  fuse: number;
  /** The camera's walk-bob phase (rad), so the arm bob rides the same stride; omitted = the rig keeps its own. */
  bobPhase?: number;
  /** The predicted look (rad): the look sway follows it, free of camera shake and recoil; omitted = from the camera. */
  yaw?: number;
  pitch?: number;
  /** What the hold-E gather yields ("berry", wood, rope, stone…) and how long the channel takes (s), when known. */
  channelItem?: InvKind | "berry" | "";
  channelSec?: number;
}

export type FpGesture = "throw" | "toss" | "use" | "eat" | "gather" | "catch" | "cast" | "reel" | "swing" | "hurt" | "place" | "deliver";

const tmpV = new THREE.Vector3();

/** First-person arms attached to the camera (rendered on top with their own small FOV feel). */
export class FpArms {
  private readonly rig = new FpArmsRig();

  update(dt: number, camera: THREE.PerspectiveCamera, frame: FpArmsFrame): void {
    this.rig.update(dt, camera, frame);
  }
  /** Play a gesture; `kinds` = what a delivery took from the pockets (the held item leaves only if among them). */
  play(gesture: FpGesture, kinds?: readonly InvKind[]): void {
    this.rig.play(gesture, kinds);
  }
  /** My catch succeeded (the catch event): the hands clap-cup onto the item, wherever it was stowed. */
  caught(): void {
    this.rig.caught();
  }
  /**
   * Attach the rig to the camera (hidden) and build what first person needs for `character` ahead of time — the
   * skinned hands now, one close-up item per call — so the renderer can prewarm its shaders before the first
   * first-person frame. Returns true while it still built something this call.
   */
  prepare(camera: THREE.Camera, character: CharacterId): boolean {
    return this.rig.prepare(camera, character);
  }
  setVisible(v: boolean): void {
    this.rig.setVisible(v);
  }
  /** Seat color of the all-inclusive wristband (Characters.sync sets it from the local frame). */
  setSeatColor(color: string): void {
    this.rig.setSeatColor(color);
  }
  /** World center of the held item (where a throw leaves from: the bundle between both hands, the cupped ball…),
   * or the right hand's grip with empty hands; false while hidden. */
  releasePosition(out: Vec3Like): boolean {
    if (!this.rig.isVisible) return false;
    this.rig.releaseWorld(tmpV);
    out.x = tmpV.x;
    out.y = tmpV.y;
    out.z = tmpV.z;
    return true;
  }
  /** World position of the right hand (or a held rod's tip); false while hidden. */
  handPosition(out: Vec3Like): boolean {
    if (!this.rig.isVisible) return false;
    this.rig.handWorld(tmpV);
    out.x = tmpV.x;
    out.y = tmpV.y;
    out.z = tmpV.z;
    return true;
  }
  /** Drop running gestures (respawn, new match). */
  clear(): void {
    this.rig.clear();
  }
  /** Charge glow on the held first-person item (0 = off), tinted `color`. */
  setChargeGlow(amount: number, color: string): void {
    this.rig.setChargeGlow(amount, color);
  }
  /** The camera-attached root (dev harness / debugging). */
  get object(): THREE.Object3D {
    return this.rig.root;
  }
}

/** Night monsters + daytime thieves. */
export class Monsters {
  private readonly herd = new MonsterHerd();

  sync(frames: MonsterFrame[], dt: number): void {
    this.herd.sync(frames, dt);
  }
  trigger(id: string, what: MonsterTrigger): void {
    this.herd.trigger(id, what);
  }
  /** World position of a monster's body center (fx anchors), false when unknown. */
  center(id: string, out: Vec3Like): boolean {
    if (!this.herd.center(id, tmpV)) return false;
    out.x = tmpV.x;
    out.y = tmpV.y;
    out.z = tmpV.z;
    return true;
  }
  clear(): void {
    this.herd.clear();
  }
  /** Night glow of the neon eyes (0 day .. 1 night); Characters.sync forwards CharacterSyncOptions.dark. */
  setDark(dark: number): void {
    this.herd.dark = dark;
  }
  /** Scene group of every monster (Characters adds it to the scene). */
  get object(): THREE.Object3D {
    return this.herd.root;
  }
  /** Live monster count (dev harness). */
  get count(): number {
    return this.herd.count;
  }
}

/** Triggers for players we don't have an avatar for yet are kept this long (respawn before the patch). */
const PENDING_SEC = 1.5;

export class Characters {
  readonly fpArms = new FpArms();
  readonly monsters = new Monsters();
  private readonly root = new THREE.Group();
  private readonly batcher: CharacterBatcher;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly shadows = new AvatarShadowPool(this.root);
  private readonly avatars = new Map<string, Avatar>();
  private readonly leaving = new Map<string, { avatar: Avatar; frame: PlayerFrame }>();
  private readonly lastFrames = new Map<string, PlayerFrame>();
  private readonly pending = new Map<string, { what: CharacterTrigger; opts?: TriggerOptions; age: number }[]>();
  private readonly revive = new Map<number, number>();
  private readonly cameraPos = new THREE.Vector3();
  private localId = "";
  private firstPerson = true;
  private stamp = 0;

  constructor(scene: THREE.Scene, camera: THREE.PerspectiveCamera) {
    this.camera = camera;
    this.root.name = "characters";
    this.batcher = new CharacterBatcher(this.root);
    scene.add(this.root, this.monsters.object);
    // The first-person arms are a child of the camera: the camera must be part of the scene graph.
    if (!camera.parent) scene.add(camera);
  }

  /** Per frame: create / update / remove avatars for `players` (spectators and washed players excluded by the caller). */
  sync(players: PlayerFrame[], opts: CharacterSyncOptions, dt: number): void {
    const stamp = ++this.stamp;
    this.localId = opts.localId;
    this.firstPerson = opts.firstPerson;
    this.monsters.setDark(opts.dark);
    this.camera.getWorldPosition(this.cameraPos);
    // Who is reviving whom (by seat).
    this.revive.clear();
    for (const f of players) {
      if (f.channel === CHANNEL.REVIVE && f.channelTarget >= 0) {
        const p = Math.min(1, f.channelTicks / REVIVE_TICKS);
        this.revive.set(f.channelTarget, Math.max(p, this.revive.get(f.channelTarget) ?? 0));
      }
    }
    for (const f of players) {
      if (f.id === opts.localId) this.fpArms.setSeatColor(playerColor(f.seat));
      let avatar = this.avatars.get(f.id);
      if (avatar && avatar.character !== f.character) {
        this.disposeAvatar(avatar);
        this.avatars.delete(f.id);
        avatar = undefined;
      }
      if (!avatar) {
        const back = this.leaving.get(f.id);
        let fresh = false;
        if (back && back.avatar.character === f.character) {
          avatar = back.avatar;
          avatar.cancelLeave();
        } else {
          if (back) this.disposeAvatar(back.avatar);
          avatar = new Avatar(this.root, f, this.shadows);
          fresh = true;
        }
        this.leaving.delete(f.id);
        this.avatars.set(f.id, avatar);
        if (fresh) this.batcher.register(avatar.tourist);
        const queued = this.pending.get(f.id);
        if (queued) {
          for (const q of queued) avatar.trigger(q.what, q.opts);
          this.pending.delete(f.id);
        }
      }
      avatar.stamp = stamp;
      this.lastFrames.set(f.id, f);
      avatar.sync(
        f,
        {
          hidden: opts.firstPerson && f.id === opts.localId,
          dark: opts.dark,
          camera: this.cameraPos,
          revive: f.downed ? (this.revive.get(f.seat) ?? -1) : -1,
        },
        dt,
      );
    }
    for (const [id, avatar] of this.avatars) {
      if (avatar.stamp === stamp) continue;
      this.avatars.delete(id);
      const last = this.lastFrames.get(id);
      if (!last) {
        this.disposeAvatar(avatar);
        continue;
      }
      avatar.beginLeave();
      this.leaving.set(id, { avatar, frame: { ...last } });
    }
    for (const [id, l] of this.leaving) {
      if (l.avatar.updateLeaving(l.frame, dt)) {
        this.disposeAvatar(l.avatar);
        this.leaving.delete(id);
        this.lastFrames.delete(id);
      }
    }
    for (const [id, list] of this.pending) {
      for (const q of list) q.age += dt;
      const keep = list.filter((q) => q.age < PENDING_SEC);
      if (keep.length) this.pending.set(id, keep);
      else this.pending.delete(id);
    }
    // All bone matrices are final now: push them into the batched meshes before the renderer runs.
    this.batcher.flush();
    this.shadows.flush();
  }

  /** Remove one avatar's batched instances before disposing its meshes. */
  private disposeAvatar(avatar: Avatar): void {
    this.batcher.unregister(avatar.tourist);
    avatar.dispose();
  }

  trigger(id: string, what: CharacterTrigger, opts?: TriggerOptions): void {
    const avatar = this.avatars.get(id) ?? this.leaving.get(id)?.avatar;
    if (avatar) {
      avatar.trigger(what, opts);
      return;
    }
    const list = this.pending.get(id) ?? [];
    list.push({ what, opts, age: 0 });
    if (list.length > 4) list.shift();
    this.pending.set(id, list);
  }

  /** World position of a player's right hand (projectile / bobber line origin). False when unknown. */
  handPosition(id: string, out: Vec3Like): boolean {
    if (id === this.localId && this.firstPerson && this.fpArms.handPosition(out)) return true;
    const avatar = this.avatars.get(id);
    if (!avatar) return false;
    avatar.handPosition(tmpV);
    out.x = tmpV.x;
    out.y = tmpV.y;
    out.z = tmpV.z;
    return true;
  }

  /** Lobby turntable / portraits: a PNG data URL per character (rendered once, cached). */
  portrait(character: CharacterId): string {
    return portraitOf(character);
  }

  /** World position above a player's head (pop text / emote anchors). False when unknown. */
  headTop(id: string, out: Vec3Like): boolean {
    const avatar = this.avatars.get(id);
    if (!avatar) return false;
    avatar.headTop(tmpV);
    out.x = tmpV.x;
    out.y = tmpV.y;
    out.z = tmpV.z;
    return true;
  }

  /** Current animation state and face of a player (dev harness / debugging). */
  inspect(id: string): { state: string; expression: string } | null {
    const avatar = this.avatars.get(id);
    return avatar ? { state: avatar.animator.state, expression: avatar.animator.currentExpression } : null;
  }

  clear(): void {
    for (const avatar of this.avatars.values()) this.disposeAvatar(avatar);
    for (const l of this.leaving.values()) this.disposeAvatar(l.avatar);
    this.avatars.clear();
    this.leaving.clear();
    this.lastFrames.clear();
    this.pending.clear();
    this.monsters.clear();
    this.fpArms.clear();
  }
}
