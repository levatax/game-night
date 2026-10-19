// Home-screen crowd of bouncing animals for render/MenuScene. Owner: client-characters.

import type { MenuCrowdFactory } from "../render/MenuScene";

/**
 * Spawns all 6 animals (slot colors cycling) on the arena, wandering between random points,
 * hopping, emoting and occasionally "throwing" at each other (cosmetic only, no balls needed).
 */
export const createMenuCrowd: MenuCrowdFactory = (scene, arena) => {
  void scene;
  void arena;
  return {
    update(dt: number, elapsed: number) {
      void dt;
      void elapsed;
    },
    dispose() {},
  };
};
