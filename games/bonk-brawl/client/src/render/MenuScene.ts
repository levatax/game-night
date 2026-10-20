// Home-screen backdrop: the Picnic Plateau with animals bouncing around, slow orbit. Owner: client-render.

import type * as THREE from "three";
import { TAU } from "../../../shared/sim/math";
import type { ArenaDef } from "../../../shared/maps";
import type { Renderer } from "./Renderer";

/** Supplied by client-characters (characters/MenuCrowd.ts createMenuCrowd). */
export type MenuCrowdFactory = (
  scene: THREE.Scene,
  arena: ArenaDef,
) => { update(dt: number, elapsed: number): void; dispose(): void };

/** One revolution every 40 s at ~14 m, high enough to see the whole island and the clouds below. */
const ORBIT_PERIOD_SEC = 40;
const ORBIT_RADIUS = 14;
const ORBIT_HEIGHT = 6.2;
/** Gentle vertical drift so the shot never feels locked off. */
const ORBIT_BOB = 0.6;
const LOOK_HEIGHT = 0.4;
/** A slightly longer lens than gameplay: calmer framing behind the menu UI. */
const MENU_FOV = 55;
const NO_RINGS: ArrayLike<number> = [];

/**
 * start(): renderer.loadArena("picnic"), spawn the crowd (6 animals idling/bouncing/throwing at
 * each other cosmetically), camera orbits the island slowly (~40 s per revolution) at ~14 m.
 * stop(): dispose the crowd (the arena stays until the next loadArena).
 * update(): drive the crowd + orbit; the App calls renderer.render() after it.
 * update() also advances renderer.update (sky drift, flames, ants), since the App only calls
 * renderer.render() while the menu runs.
 */
export class MenuScene {
  private readonly renderer: Renderer;
  private readonly crowdFactory: MenuCrowdFactory;
  private crowd: ReturnType<MenuCrowdFactory> | null = null;
  private runningFlag = false;
  private angle = 0;

  constructor(renderer: Renderer, crowd: MenuCrowdFactory) {
    this.renderer = renderer;
    this.crowdFactory = crowd;
  }

  start(): void {
    if (this.runningFlag) return;
    const arena = this.renderer.loadArena("picnic");
    // A finished match may have left sudden-death rings fallen on this map.
    arena.syncRings(NO_RINGS);
    this.runningFlag = true;
    // Resume the orbit where the camera already is, so returning from a match doesn't jump.
    const cam = this.renderer.camera.position;
    if (Math.hypot(cam.x, cam.z) > 1) this.angle = Math.atan2(cam.x, cam.z);
    this.placeCamera(0);
    this.crowd = this.crowdFactory(this.renderer.scene, arena.def);
  }

  stop(): void {
    if (!this.runningFlag) return;
    this.runningFlag = false;
    this.crowd?.dispose();
    this.crowd = null;
  }

  get running(): boolean {
    return this.runningFlag;
  }

  update(dt: number, elapsed: number): void {
    if (!this.runningFlag) return;
    this.angle += (TAU / ORBIT_PERIOD_SEC) * dt;
    this.placeCamera(elapsed);
    this.crowd?.update(dt, elapsed);
    this.renderer.update(dt, elapsed);
  }

  private placeCamera(elapsed: number): void {
    const camera = this.renderer.camera;
    const y = ORBIT_HEIGHT + Math.sin(elapsed * 0.21) * ORBIT_BOB;
    camera.position.set(Math.sin(this.angle) * ORBIT_RADIUS, y, Math.cos(this.angle) * ORBIT_RADIUS);
    camera.up.set(0, 1, 0);
    camera.lookAt(0, LOOK_HEIGHT, 0);
    if (camera.fov !== MENU_FOV) {
      camera.fov = MENU_FOV;
      camera.updateProjectionMatrix();
    }
    camera.updateMatrixWorld();
  }
}
