// Home-screen backdrop: the Picnic Plateau with animals bouncing around, slow orbit. Owner: client-render.

import type * as THREE from "three";
import type { ArenaDef } from "../../../shared/maps";
import type { Renderer } from "./Renderer";

/** Supplied by client-characters (characters/MenuCrowd.ts createMenuCrowd). */
export type MenuCrowdFactory = (
  scene: THREE.Scene,
  arena: ArenaDef,
) => { update(dt: number, elapsed: number): void; dispose(): void };

/**
 * start(): renderer.loadArena("picnic"), spawn the crowd (6 animals idling/bouncing/throwing at
 * each other cosmetically), camera orbits the island slowly (~40 s per revolution) at ~14 m.
 * stop(): dispose the crowd (the arena stays until the next loadArena).
 * update(): drive the crowd + orbit; the App calls renderer.render() after it.
 */
export class MenuScene {
  constructor(renderer: Renderer, crowd: MenuCrowdFactory) {
    void renderer;
    void crowd;
  }

  start(): void {}

  stop(): void {}

  get running(): boolean {
    return false;
  }

  update(dt: number, elapsed: number): void {
    void dt;
    void elapsed;
  }
}
