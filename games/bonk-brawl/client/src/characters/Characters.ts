// Manager of every player's animal in the scene. Owner: client-characters.

import type * as THREE from "three";
import type { PlayerFrame } from "../net/types";
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
  constructor(scene: THREE.Scene) {
    void scene;
  }

  /** Per frame with cosmetic dt. Frames: local + remotes (Net.getLocalPlayer / getRemotePlayers). */
  sync(frames: readonly PlayerFrame[], opts: CharacterSyncOptions, dt: number): void {
    void frames;
    void opts;
    void dt;
  }

  trigger(id: string, anim: AnimTrigger, opts?: TriggerOptions): void {
    void id;
    void anim;
    void opts;
  }

  /** World position of the player's right hand (held ball). false if the id has no animal. */
  getHandPosition(id: string, out: THREE.Vector3): boolean {
    void id;
    void out;
    return false;
  }

  /** World position above the head (pop text / emote anchor). */
  getHeadTop(id: string, out: THREE.Vector3): boolean {
    void id;
    void out;
    return false;
  }

  /** Remove every animal (leaving a room). */
  clear(): void {}

  dispose(): void {}
}
