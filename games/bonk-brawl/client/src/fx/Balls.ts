// Ball visuals. Owner: client-fx.

import type * as THREE from "three";
import type { BallFrame } from "../net/types";
import type { BallVisualContext } from "./types";

/**
 * One pooled visual per BallFrame.id. When a predicted "pred:*" ball is replaced by its server
 * ball, the server id appears at (nearly) the same position because BallSync blends, so plain
 * create/remove by id works; reusing the predicted visual (same ownerId) keeps the trail intact.
 * - neutral: cream (ballTexture), subtle bob (+0.05 m sine) when resting, outline.
 * - held: placed at ctx.handOf(holderId) (hidden if false); small idle spin; glows in the holder's
 *   color while charging (handled by GameController via setChargeGlow).
 * - live: emissive glow in the owner's color (intensity grows with charge), colored ribbon trail
 *   (last ~0.25 s of positions), slight stretch along velocity.
 * - dead: glow + trail fade out over 0.3 s.
 * - kinds: mega = radius 0.5 red beach-ball stripes; boomerang = banana-shaped mesh spinning;
 *   bonus = smaller/faded variant of normal; curve = swirl sprite on the trail.
 * - bounced: squash along the impact normal for ~0.12 s.
 * - opacity < 1 for fading predicted balls. castShadow on.
 */
export class BallVisuals {
  constructor(scene: THREE.Scene) {
    void scene;
  }

  /** Per frame with cosmetic dt. */
  sync(balls: readonly BallFrame[], dt: number, ctx: BallVisualContext): void {
    void balls;
    void dt;
    void ctx;
  }

  /** Held-ball charge glow for a player (0 = off, 1 = full). */
  setChargeGlow(playerId: string, charge: number): void {
    void playerId;
    void charge;
  }

  clear(): void {}

  dispose(): void {}
}
