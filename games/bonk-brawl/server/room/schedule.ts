// Round scheduler: WHEN to respawn balls, spawn power-ups and crumble rings (the world executes).
// Times are absolute server ticks. Pure logic over a small world interface, so it unit-tests
// without a network or the full simulation.

import { ballsForPlayers, POWERUP_TYPES } from "../../shared/constants.js";
import type { PowerUpType } from "../../shared/types.js";
import type { RoomTimings } from "./timings.js";

/** The GameWorld operations the scheduler drives. */
export interface ScheduledWorld {
  countBalls(): number;
  spawnBall(): string;
  powerUpCount(): number;
  solidPedestals(): number[];
  spawnPowerUpWarning(pedestal: number, type: PowerUpType): string;
  activatePowerUp(id: string): void;
  outermostSolidRing(): number;
  shakeRing(index: number): void;
  dropRing(index: number): void;
}

const NEVER = Number.POSITIVE_INFINITY;
const MAX_PHASE_TICKS = 0xffff;

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.min(items.length - 1, Math.floor(random() * items.length))];
}

export class RoundSchedule {
  private participants = 0;
  private ballTarget = 0;
  private respawnAt: number[] = [];
  private powerUpsOn = false;
  private nextPowerUpAt = NEVER;
  private activation: { id: string; at: number } | null = null;
  private suddenDeath = false;
  private shakingRing = -1;
  private dropAt = NEVER;
  private nextShakeAt = NEVER;
  private stalemateAt = NEVER;

  constructor(
    private readonly timings: Readonly<RoomTimings>,
    private readonly random: () => number = Math.random,
  ) {}

  /** Arena ball target right now: max(2, players − 1) (+1 in sudden death). */
  get target(): number {
    return this.ballTarget;
  }

  /** Fight starts: ball target for `participants`, first power-up after powerUpFirstTicks. */
  startPlaying(tick: number, participants: number, powerUpsOn: boolean): void {
    this.clear();
    this.participants = participants;
    this.ballTarget = ballsForPlayers(participants, false);
    this.powerUpsOn = powerUpsOn;
    this.nextPowerUpAt = powerUpsOn ? tick + this.timings.powerUpFirstTicks : NEVER;
  }

  /** Sudden death: one extra ball drops now and the outermost ring starts shaking at once. */
  startSuddenDeath(tick: number, world: ScheduledWorld): void {
    this.suddenDeath = true;
    this.ballTarget = ballsForPlayers(this.participants, true);
    this.nextShakeAt = tick;
    this.updateRings(tick, world);
    // After the shake starts, so the random drop already avoids the crumbling ring.
    if (world.countBalls() < this.ballTarget) world.spawnBall();
  }

  /** A ball left play (and should be replaced): drop a new one at a random spot later. */
  onBallLost(tick: number): void {
    this.respawnAt.push(tick + this.timings.ballRespawnTicks);
  }

  /** Run everything due at `tick`. */
  update(tick: number, world: ScheduledWorld): void {
    this.updateRespawns(tick, world);
    this.updatePowerUps(tick, world);
    if (this.suddenDeath) this.updateRings(tick, world);
  }

  /** Ticks until the next ring drop; 0 when nothing is left to drop (state.phaseTicksLeft). */
  ticksToNextDrop(tick: number, world: ScheduledWorld): number {
    let left = 0;
    if (this.shakingRing >= 0) left = this.dropAt - tick;
    else if (this.nextShakeAt !== NEVER && world.outermostSolidRing() >= 1) left = this.nextShakeAt + this.timings.ringShakeTicks - tick;
    return Math.max(0, Math.min(MAX_PHASE_TICKS, left));
  }

  /** The stalemate guard fired: every droppable ring fell stalemateTicks ago. */
  stalemateDue(tick: number): boolean {
    return tick >= this.stalemateAt;
  }

  /** Forget everything (round over, lobby). */
  clear(): void {
    this.participants = 0;
    this.ballTarget = 0;
    this.respawnAt = [];
    this.powerUpsOn = false;
    this.nextPowerUpAt = NEVER;
    this.activation = null;
    this.suddenDeath = false;
    this.shakingRing = -1;
    this.dropAt = NEVER;
    this.nextShakeAt = NEVER;
    this.stalemateAt = NEVER;
  }

  private updateRespawns(tick: number, world: ScheduledWorld): void {
    if (this.respawnAt.length === 0) return;
    this.respawnAt = this.respawnAt.filter((at) => {
      if (at > tick) return true;
      if (world.countBalls() < this.ballTarget) world.spawnBall();
      return false;
    });
  }

  private updatePowerUps(tick: number, world: ScheduledWorld): void {
    if (this.activation && tick >= this.activation.at) {
      world.activatePowerUp(this.activation.id);
      this.activation = null;
    }
    if (tick < this.nextPowerUpAt) return;
    this.nextPowerUpAt = tick + this.timings.powerUpIntervalTicks;
    if (world.powerUpCount() > 0) return;
    const pedestals = world.solidPedestals();
    if (pedestals.length === 0) return;
    const id = world.spawnPowerUpWarning(pick(pedestals, this.random), pick(POWERUP_TYPES, this.random));
    this.activation = { id, at: tick + this.timings.powerUpWarningTicks };
  }

  private updateRings(tick: number, world: ScheduledWorld): void {
    if (this.shakingRing >= 0 && tick >= this.dropAt) {
      world.dropRing(this.shakingRing);
      this.shakingRing = -1;
      if (world.outermostSolidRing() < 1) this.startStalemateClock(tick);
    }
    if (this.shakingRing >= 0 || tick < this.nextShakeAt) return;
    const ring = world.outermostSolidRing();
    if (ring < 1) {
      this.nextShakeAt = NEVER;
      this.startStalemateClock(tick);
      return;
    }
    world.shakeRing(ring);
    this.shakingRing = ring;
    this.dropAt = tick + this.timings.ringShakeTicks;
    this.nextShakeAt = tick + this.timings.ringDropIntervalTicks;
  }

  private startStalemateClock(tick: number): void {
    if (this.stalemateAt === NEVER) this.stalemateAt = tick + this.timings.stalemateTicks;
  }
}
