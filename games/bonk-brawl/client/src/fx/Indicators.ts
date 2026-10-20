// Off-screen incoming-ball indicator data. Owner: client-fx (UI renders the arrows).

import * as THREE from "three";
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

/** Look-ahead window and danger radius for "incoming". */
export const INDICATOR_HORIZON_SEC = 1.5;
export const INDICATOR_DANGER_DIST = 3;
/** Arrow inset from the screen edge (CSS px). */
export const INDICATOR_EDGE_MARGIN = 48;
/** Balls within this NDC box (and in front of the camera) count as on-screen. */
const ON_SCREEN_NDC = 0.92;

const view = new THREE.Vector3();
const clip = new THREE.Vector4();

/**
 * For every LIVE ball not owned by the local player that is approaching (velocity toward the
 * chest, closest approach < 3 m within the next 1.5 s) and is outside the view frustum (or
 * behind the camera): project its direction onto the screen and clamp to an edge margin (48 px),
 * angle pointing toward the ball; urgency = 1 - timeToClosest / 1.5. Pure function.
 */
export function computeOffscreenIndicators(input: IndicatorInput): OffscreenIndicator[] {
  const out: OffscreenIndicator[] = [];
  const { camera, viewport, chest } = input;
  if (viewport.width <= 0 || viewport.height <= 0) return out;
  for (const ball of input.balls) {
    if (ball.state !== "live" || ball.ownerId === input.localId || ball.predicted) continue;
    const timeToClosest = approachTime(ball, chest);
    if (timeToClosest < 0) continue;
    const indicator = edgeIndicator(ball, camera, viewport);
    if (!indicator) continue;
    indicator.color = input.colorOf(ball.ownerId);
    indicator.urgency = clamp01(1 - timeToClosest / INDICATOR_HORIZON_SEC);
    out.push(indicator);
  }
  return out;
}

/**
 * Seconds until the ball's straight-line closest approach to `chest` if it is incoming
 * (approaching, closest approach < INDICATOR_DANGER_DIST within the horizon), else -1.
 */
export function approachTime(ball: BallFrame, chest: { x: number; y: number; z: number }): number {
  const rx = ball.x - chest.x;
  const ry = ball.y - chest.y;
  const rz = ball.z - chest.z;
  const vv = ball.vx * ball.vx + ball.vy * ball.vy + ball.vz * ball.vz;
  if (vv < 1e-6) return -1;
  const rv = rx * ball.vx + ry * ball.vy + rz * ball.vz;
  if (rv >= 0) return -1;
  const t = -rv / vv;
  if (t > INDICATOR_HORIZON_SEC) return -1;
  const cx = rx + ball.vx * t;
  const cy = ry + ball.vy * t;
  const cz = rz + ball.vz * t;
  const closest = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return closest < INDICATOR_DANGER_DIST + ball.radius ? t : -1;
}

/** Screen-edge arrow for a ball outside the view, or null when it is visible. */
function edgeIndicator(
  ball: BallFrame,
  camera: THREE.PerspectiveCamera,
  viewport: { width: number; height: number },
): OffscreenIndicator | null {
  view.set(ball.x, ball.y, ball.z).applyMatrix4(camera.matrixWorldInverse);
  clip.set(view.x, view.y, view.z, 1).applyMatrix4(camera.projectionMatrix);
  const inFront = view.z < 0 && clip.w > 1e-6;
  if (inFront) {
    const nx = clip.x / clip.w;
    const ny = clip.y / clip.w;
    if (Math.abs(nx) <= ON_SCREEN_NDC && Math.abs(ny) <= ON_SCREEN_NDC) return null;
  }
  // Direction on screen (x right, y down). Using projected x/y without the perspective divide
  // keeps the sign right for points behind the camera too.
  let dx = clip.x * viewport.width * 0.5;
  let dy = -clip.y * viewport.height * 0.5;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // Straight behind (or dead ahead but culled): point down, "behind you".
    dx = 0;
    dy = 1;
  } else {
    dx /= len;
    dy /= len;
  }
  const cx = viewport.width / 2;
  const cy = viewport.height / 2;
  const hx = Math.max(1, cx - INDICATOR_EDGE_MARGIN);
  const hy = Math.max(1, cy - INDICATOR_EDGE_MARGIN);
  const reach = Math.min(Math.abs(dx) > 1e-6 ? hx / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? hy / Math.abs(dy) : Infinity);
  return {
    id: ball.id,
    x: cx + dx * reach,
    y: cy + dy * reach,
    angle: Math.atan2(dy, dx),
    color: "",
    urgency: 0,
  };
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
