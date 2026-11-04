// Treasure-chest reels (game4.md §8): pick a treasure, emit `treasure` (the client spins the strip), apply it to
// the finder's team via ctx.applyTreasure when the reel ends (TREASURE_REEL_TICKS). A player's reels run one
// after another (the secret chest gives two). Owner: server-world-life. Used by FishingSystem (fishing loot,
// secret chest) and WeatherSystem (wave gifts) — each owns one instance, so neither needs the other.

import { TREASURE_REEL_TICKS } from "../../../shared/constants.js";
import type { TreasureEvent } from "../../../shared/protocol.js";
import type { TreasureId } from "../../../shared/types.js";
import type { PlayerState, WorldContext } from "../context.js";
import { rollTreasure, treasureReel } from "../loot.js";

export type TreasureSource = TreasureEvent["source"];

interface ActiveReel {
  treasure: TreasureId;
  /** Server tick the reel stops (the treasure applies on the step of that tick). */
  endAt: number;
}

export class TreasureReels {
  private active = new Map<string, ActiveReel>();
  private queued = new Map<string, TreasureSource[]>();
  /** Last treasure per player while a batch runs (the secret chest's two reels never repeat). */
  private lastPick = new Map<string, TreasureId>();

  constructor(private readonly ctx: WorldContext) {}

  /** Start (or queue behind the player's running reel) one treasure reel. */
  start(p: PlayerState, source: TreasureSource): void {
    if (this.active.has(p.id)) {
      const q = this.queued.get(p.id) ?? [];
      q.push(source);
      this.queued.set(p.id, q);
      return;
    }
    this.begin(p, source);
  }

  /** A reel is spinning or queued for this player. */
  busy(id: string): boolean {
    return this.active.has(id) || (this.queued.get(id)?.length ?? 0) > 0;
  }

  /** Per tick: apply finished reels, start queued ones. */
  step(): void {
    if (this.active.size === 0) return;
    const now = this.ctx.tick();
    for (const [id, reel] of [...this.active]) {
      if (now < reel.endAt) continue;
      this.active.delete(id);
      const p = this.ctx.state.players.get(id);
      if (p && !p.spectator) this.ctx.applyTreasure(p, reel.treasure);
      const next = this.queued.get(id)?.shift();
      if (next !== undefined && p) this.begin(p, next);
      else {
        this.queued.delete(id);
        this.lastPick.delete(id);
      }
    }
  }

  clear(): void {
    this.active.clear();
    this.queued.clear();
    this.lastPick.clear();
  }

  /** A player left: drop their running / queued reels (an unfinished treasure applies to nobody, as before). */
  forget(id: string): void {
    this.active.delete(id);
    this.queued.delete(id);
    this.lastPick.delete(id);
  }

  /** Ids with a running / queued reel or a remembered pick. */
  trackedIds(): string[] {
    return [...new Set([...this.active.keys(), ...this.queued.keys(), ...this.lastPick.keys()])];
  }

  private begin(p: PlayerState, source: TreasureSource): void {
    const treasure = rollTreasure(this.ctx.rng, this.exclusions(p));
    const { reel, stopIndex } = treasureReel(this.ctx.rng, treasure);
    this.active.set(p.id, { treasure, endAt: this.ctx.tick() + TREASURE_REEL_TICKS });
    this.lastPick.set(p.id, treasure);
    this.ctx.emit({ type: "treasure", tick: this.ctx.tick(), playerId: p.id, team: p.team, treasure, reel, stopIndex, source });
  }

  /** Treasures that would do nothing right now (an old sail once the sail is up, a second flare…). */
  private exclusions(p: PlayerState): Set<TreasureId> {
    const out = new Set<TreasureId>();
    const team = this.ctx.state.teams[p.team] ? this.ctx.team(p.team) : null;
    if (team) {
      if (team.stage > 3) out.add("old_sail");
      if (team.flare) out.add("flare");
      if (team.spyglassTicks > 0) out.add("spyglass");
    }
    const st = this.ctx.state;
    if (st.day >= this.ctx.timings.days && st.dayPhase === "night") out.add("flare");
    const last = this.lastPick.get(p.id);
    if (last) out.add(last);
    return out;
  }
}
