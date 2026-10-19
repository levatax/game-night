// Shared bag of client modules + small frame helpers for the game/ helpers. Owner: client-game.

import * as THREE from "three";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Controls } from "../input/Controls";
import type { Net } from "../net/Net";
import type { Chefs } from "../scene/Chefs";
import type { Fx } from "../scene/Fx";
import type { TowerView } from "../scene/Pieces";
import type { Stage } from "../scene/Stage";
import type { CaseReel } from "../ui/CaseReel";
import type { Hud } from "../ui/Hud";
import type { Menu } from "../ui/Menu";
import type { Overlays } from "../ui/Overlays";

export interface Ctx {
  net: Net;
  stage: Stage;
  tower: TowerView;
  chefs: Chefs;
  fx: Fx;
  audio: AudioEngine;
  menu: Menu;
  hud: Hud;
  reel: CaseReel;
  overlays: Overlays;
  controls: Controls;
}

/** Stand-local point → world point (the stand rotates, so this changes every frame). */
export function localToWorld(stage: Stage, x: number, y: number, z: number, out = new THREE.Vector3()): THREE.Vector3 {
  out.set(x, y, z);
  stage.standGroup.updateWorldMatrix(true, false);
  return stage.standGroup.localToWorld(out);
}

/** World point → screen pixels for pop text, or undefined when off screen (Fx then centers it). */
export function screenOf(stage: Stage, world: THREE.Vector3 | null): { x: number; y: number } | undefined {
  if (!world) return undefined;
  const s = stage.worldToScreen(world);
  return s.visible ? { x: s.x, y: s.y } : undefined;
}

/** Run fn after `ms`, unless the guard generation changed meanwhile (room left / reset). */
export class Later {
  private gen = 0;
  private timers = new Set<ReturnType<typeof setTimeout>>();
  run(ms: number, fn: () => void): void {
    const gen = this.gen;
    const t = setTimeout(() => {
      this.timers.delete(t);
      if (gen === this.gen) fn();
    }, ms);
    this.timers.add(t);
  }
  cancelAll(): void {
    this.gen++;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
  }
}
