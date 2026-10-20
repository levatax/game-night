// Ball position history for lag-compensated catches (ARCHITECTURE §7.4).
// Keeps the last BALL_HISTORY_TICKS samples per ball; sample objects are recycled.

import { BALL_HISTORY_TICKS } from "../../shared/constants.js";
import type { Vec3Like } from "../../shared/types.js";

export interface BallSample extends Vec3Like {
  tick: number;
  /** The ball was live (catchable) at this tick. */
  live: boolean;
}

export class BallHistory {
  private readonly samples = new Map<string, BallSample[]>();

  constructor(private readonly capacity = BALL_HISTORY_TICKS) {}

  record(ballId: string, tick: number, pos: Vec3Like, live: boolean): void {
    let list = this.samples.get(ballId);
    if (!list) {
      list = [];
      this.samples.set(ballId, list);
    }
    const sample = list.length >= this.capacity ? (list.shift() as BallSample) : { tick: 0, x: 0, y: 0, z: 0, live: false };
    sample.tick = tick;
    sample.x = pos.x;
    sample.y = pos.y;
    sample.z = pos.z;
    sample.live = live;
    list.push(sample);
  }

  /** Samples with from <= tick <= to, oldest first (empty when nothing is recorded). */
  range(ballId: string, from: number, to: number): BallSample[] {
    const list = this.samples.get(ballId);
    if (!list) return [];
    return list.filter((s) => s.tick >= from && s.tick <= to);
  }

  delete(ballId: string): void {
    this.samples.delete(ballId);
  }

  clear(): void {
    this.samples.clear();
  }
}
