// Off-screen incoming-ball indicator data. Owner: client-fx (UI renders the arrows).

import type * as THREE from "three";
import type { BallFrame } from "../net/types";
import type { OffscreenIndicator } from "../ui/models";

export interface IndicatorInput {
  camera: THREE.PerspectiveCamera;
  viewport: { width: number; height: number };
  balls: readonly BallFrame[];
  /** Local player chest position (danger is measured against it). */
  chest: { x: number; y: number; z: number };
  localId: string;
  colorOf(playerId: string): string;
}

/**
 * For every LIVE ball not owned by the local player that is approaching (velocity toward the
 * chest, closest approach < 3 m within the next 1.5 s) and is outside the view frustum (or
 * behind the camera): project its direction onto the screen and clamp to an edge margin (48 px),
 * angle pointing toward the ball; urgency = 1 - timeToClosest / 1.5. Pure function.
 */
export function computeOffscreenIndicators(input: IndicatorInput): OffscreenIndicator[] {
  void input;
  return [];
}
