// Ball dead-reckoning + predicted throws. Owner: client-net.

import type { FloorQuery } from "../../../shared/sim/context";
import type { Vec3 } from "../../../shared/sim/math";
import type { BallKind, BallView, MapView } from "../../../shared/types";
import type { BallFrame } from "./types";

/**
 * Owner info BallSync needs to dead-reckon curveballs and boomerangs like the server does, built by
 * Net from the RENDERED players (predicted local player, interpolated remotes):
 * aim = aimDirection(yaw, pitch) (BallContext.steer for live curve balls), chest = chestPosition
 * (BallContext.returnTarget for boomerangs), hand = throwOrigin of the rendered player.
 * Returns null for unknown ids; alive = false → steer/returnTarget null (like the server).
 */
export type OwnerResolver = (ownerId: string) => { aim: Vec3; chest: Vec3; hand: Vec3; alive: boolean } | null;

/**
 * Algorithm (TECH_BRIEF §3):
 * - Every tracked ball keeps a local BallSim stepped with the shared stepBall in fixed DT
 *   substeps of real time (accumulator), so motion between 20 Hz patches is smooth & ballistic.
 *   BallContext per step: { arena, rings, dt: DT, steer, returnTarget } from `owners` (never pass
 *   returnTarget = null for a returning boomerang whose owner is alive, or it turns dead locally).
 * - onServerState(): for each server ball, take its fields at patchTick and fast-forward a copy by
 *   k = clamp(round(serverTickNow - patchTick), 0, 6) stepBall ticks → target. New ball → start at
 *   target. Known ball → offset = local - target (snap if > BALL_SNAP_DIST); local = target; the
 *   render position adds the offset decaying with BALL_SMOOTH_MS. Held balls are not simulated.
 *   Balls missing from state are removed.
 * - Remote throws: a NEW live ball (ageTicks <= 10) owned by someone other than the local player
 *   starts with offset = owners(ownerId).hand - target (no snap limit up to 10 m), so it visibly
 *   leaves the thrower's rendered hand (remote players are drawn ~RTT/2 + 100 ms in the past)
 *   and catches up to its true position over 2 × BALL_SMOOTH_MS.
 * - Predicted throws: addPredictedThrow creates balls with id "pred:<seq>:<index>" simulated the
 *   same way: index 0 gets `kind`, indices 1/2 kind "bonus"; all share charge/curve. When a server
 *   ball with ownerId === local id, throwSeq === seq and the same throwIndex appears, it takes over:
 *   offset = predicted pos - server target (blends out), predicted removed.
 *   Unmatched after PREDICTED_BALL_TIMEOUT_MS → fade out (opacity) and remove.
 * - Bounces reported by stepBall set BallFrame.bounced/bounceSpeed until the next getFrames().
 */
export class BallSync {
  onServerState(
    balls: MapView<BallView>,
    patchTick: number,
    serverTickNow: number,
    q: FloorQuery,
    owners: OwnerResolver,
  ): void {
    void balls;
    void patchTick;
    void serverTickNow;
    void q;
    void owners;
  }

  addPredictedThrow(
    ownerId: string,
    seq: number,
    origin: Vec3,
    velocities: Vec3[],
    kind: BallKind,
    charge: number,
    curve: boolean,
  ): void {
    void ownerId;
    void seq;
    void origin;
    void velocities;
    void kind;
    void charge;
    void curve;
  }

  /** Advance by real frame time (dtSec), smoothing and predicted-ball timeouts. */
  update(dtSec: number, q: FloorQuery, owners: OwnerResolver): void {
    void dtSec;
    void q;
    void owners;
  }

  /**
   * Render list. Server balls held by `localId` beyond `localHeldCount` (the predicted count) are
   * omitted, so a just-thrown ball never shows both in hand and in flight. Clears `bounced` flags.
   */
  getFrames(localId: string, localHeldCount: number): BallFrame[] {
    void localId;
    void localHeldCount;
    return [];
  }

  clear(): void {}
}
