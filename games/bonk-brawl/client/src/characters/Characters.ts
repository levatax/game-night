// Manager of every player's animal in the scene. Owner: client-characters.

import type * as THREE from "three";
import type { PlayerFrame } from "../net/types";
import { Avatar } from "./Avatar";
import type { AnimTrigger, CharacterSyncOptions, TriggerOptions } from "./types";

/**
 * sync(): create an Animal (+ Animator, Nameplate) for each new id, rebuild when character or
 * slot changes, remove missing ids. Position root at frame x/y/z, yaw from frame.yaw. Visibility:
 * - frame.spectator → hidden (not in the match; its schema position is meaningless);
 * - !frame.alive → ghost form floating ~1.5 m above the anchor given by the "ko"/"ringOut"
 *   trigger (or the frame position if no trigger was seen, e.g. joined/reconnected mid-round);
 *   the frame position is ignored while a ghost (the server freezes eliminated bodies);
 * - otherwise normal (a player alive again leaves ghost form instantly).
 * Crown on opts.crownId. Damage flash while hurtTicks > 0. Nameplate: hidden for opts.localId,
 * dimmed with a "…" badge while !frame.connected.
 * Held balls are rendered by fx using getHandPosition().
 */
export class Characters {
  private readonly scene: THREE.Scene;
  private readonly avatars = new Map<string, Avatar>();
  private stamp = 0;

  constructor(scene: THREE.Scene) {
    this.scene = scene;
  }

  /** Per frame with cosmetic dt. Frames: local + remotes (Net.getLocalPlayer / getRemotePlayers). */
  sync(frames: readonly PlayerFrame[], opts: CharacterSyncOptions, dt: number): void {
    const stamp = ++this.stamp;
    for (const frame of frames) {
      let avatar = this.avatars.get(frame.id);
      if (avatar && avatar.character !== frame.character) {
        avatar.dispose();
        avatar = undefined;
      }
      if (!avatar) {
        avatar = new Avatar(this.scene, frame);
        this.avatars.set(frame.id, avatar);
      }
      avatar.stamp = stamp;
      avatar.sync(frame, opts, dt);
    }
    for (const [id, avatar] of this.avatars) {
      if (avatar.stamp === stamp) continue;
      avatar.dispose();
      this.avatars.delete(id);
    }
  }

  trigger(id: string, anim: AnimTrigger, opts?: TriggerOptions): void {
    this.avatars.get(id)?.trigger(anim, opts);
  }

  /** World position of the player's right hand (held ball). false if the id has no animal. */
  getHandPosition(id: string, out: THREE.Vector3): boolean {
    const avatar = this.avatars.get(id);
    if (!avatar) return false;
    avatar.getHandPosition(out);
    return true;
  }

  /** World position above the head (pop text / emote anchor). */
  getHeadTop(id: string, out: THREE.Vector3): boolean {
    const avatar = this.avatars.get(id);
    if (!avatar) return false;
    avatar.getHeadTop(out);
    return true;
  }

  /** Current animation state and face of a player (dev harness / debugging). */
  inspect(id: string): { state: string; expression: string } | null {
    const avatar = this.avatars.get(id);
    return avatar ? { state: avatar.animator.state, expression: avatar.animator.expression } : null;
  }

  /** Remove every animal (leaving a room). */
  clear(): void {
    for (const avatar of this.avatars.values()) avatar.dispose();
    this.avatars.clear();
  }

  dispose(): void {
    this.clear();
  }
}
