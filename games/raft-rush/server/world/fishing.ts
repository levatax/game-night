// Fishing (§8): cast → bite → strike → reel, loot table per match (biome weights ± seed jitter), bad-luck
// protection, treasure / bottle effects when the reel ends. Owner: server-world-life. Signatures by the
// architect (RaftWorld calls them); keep them.
//
// Flow per fisher (PlayerState.fishState, FISH_STATE.*):
//   NONE --LMB with the rod, looking at a fish spot--> CAST (fishCast; bite after FISH_WAIT_MIN..MAX ticks)
//   CAST --bite--> BITE (fishBite; FISH_BITE_TICKS + lag allowance to click)
//   BITE --LMB--> REEL (fishResult with the reel strip; the item lands FISH_REEL_TICKS later via giveItem "fish")
//   CAST --LMB--> miss "early" · BITE --no click--> miss "late" · walked FISH_CANCEL_DIST away / other slot → "moved"
//   · downed / washed / boarded → "cancel" (all back to NONE).
// A treasure catch spins a second (treasure) reel when the fish reel ends; a bottle applies when it ends.
// MVP: every catch is stats.fish + MVP_POINTS.fish (the golden fish bonus is paid by RaftWorld when eaten).
// This system emits its own `reject` (action "fish": noSpot / busy) — RaftWorld must not add a second one.
// Per-player bookkeeping (line, pity streak, RTT, treasure reels) goes with the player: RaftWorld.removePlayer
// calls forget(); clear() (every match start / lobby) keeps only the RTTs of players still in the room.

import {
  CHARACTERS,
  FISH_BITE_TICKS,
  FISH_CANCEL_DIST,
  FISH_CAST_RANGE,
  FISH_LAG_ALLOWANCE_MAX_TICKS,
  FISH_REEL_TICKS,
  FISH_SPOT_RADIUS,
  FISH_STATE,
  FISH_WAIT_MAX_TICKS,
  FISH_WAIT_MIN_TICKS,
  MVP_POINTS,
  TICK_MS,
  WATER_Y,
} from "../../shared/constants.js";
import { FISH_LOOT_ITEM, type LootEntry } from "../../shared/items.js";
import type { FishMissEvent } from "../../shared/protocol.js";
import { aimDirection } from "../../shared/sim/throw.js";
import { canAct, eyePosition, heldKind } from "../../shared/sim/player.js";
import type { Biome, FishLoot, Vec3Like } from "../../shared/types.js";
import type { PlayerState, WorldContext } from "./context.js";
import { TreasureReels } from "./life/treasure.js";
import { randInt, vec } from "./life/util.js";
import { baseFishLootTable, fishLootTable, fishReel, nextJunkStreak, rollFish } from "./loot.js";

/** One player's line in the water. */
interface FishLine {
  spot: number;
  /** Where the fisher stood when casting (walking FISH_CANCEL_DIST away reels in). */
  castX: number;
  castZ: number;
  bobber: Vec3Like;
  /** CAST: server tick of the bite. */
  biteAt: number;
  /** BITE: last server tick a strike is accepted (the step of this tick turns it into a late miss). */
  windowEnd: number;
  /** REEL: server tick the catch lands. */
  landAt: number;
  loot: FishLoot | null;
}

export class FishingSystem {
  private table: LootEntry<FishLoot>[] = baseFishLootTable();
  private lines = new Map<string, FishLine>();
  /** Junk catches in a row per fisher (bad-luck protection). */
  private junk = new Map<string, number>();
  private rtt = new Map<string, number>();
  private treasure: TreasureReels;

  constructor(protected ctx: WorldContext) {
    this.treasure = new TreasureReels(ctx);
  }

  /** Match start: build this match's loot table from the seed + biome (fishLootFor + ±20% jitter), reset pity. */
  startMatch(seed: number, biome: Biome): void {
    this.table = fishLootTable(seed, biome);
    this.clear();
  }

  /**
   * LMB "use" with a rod (RaftWorld routes it here). Casts at the fish spot the player looks at (within
   * FISH_CAST_RANGE of the eye, ray toward the spot within FISH_SPOT_RADIUS), strikes during a bite, or misses
   * "early" while waiting. Returns false when there was nothing to do (no spot in view: reject "noSpot").
   */
  use(p: PlayerState): boolean {
    if (heldKind(p) !== "rod" || !canAct(p)) return false;
    const line = this.lines.get(p.id);
    if (!line || p.fishState === FISH_STATE.NONE) {
      if (line) this.lines.delete(p.id);
      return this.cast(p);
    }
    if (p.fishState === FISH_STATE.CAST) {
      this.miss(p, line, "early");
      return true;
    }
    if (p.fishState === FISH_STATE.BITE) {
      this.strike(p, line);
      return true;
    }
    // REEL: the result is already decided; nothing to do until it lands.
    return true;
  }

  /** Cancel a player's line (moved away / slot changed / downed / washed). */
  cancel(p: PlayerState, reason: "moved" | "cancel"): void {
    const line = this.lines.get(p.id);
    if (!line) return;
    if (p.fishState === FISH_STATE.CAST || p.fishState === FISH_STATE.BITE) this.miss(p, line, reason);
  }

  /** Fisher RTT for the bite latency allowance (≤ FISH_LAG_ALLOWANCE_MAX_TICKS). */
  setRtt(id: string, rttMs: number): void {
    if (Number.isFinite(rttMs) && rttMs >= 0) this.rtt.set(id, rttMs);
  }

  /** A player left the room for good: drop their line, pity streak, RTT and treasure reels (no events). */
  forget(id: string): void {
    const p = this.lines.has(id) ? this.ctx.state.players.get(id) : undefined;
    if (p) {
      p.fishState = FISH_STATE.NONE;
      p.fishSpot = -1;
    }
    this.lines.delete(id);
    this.junk.delete(id);
    this.rtt.delete(id);
    this.treasure.forget(id);
  }

  /** Ids this system keeps anything for (tests: nothing outlives its player). */
  trackedIds(): string[] {
    const ids = new Set([...this.lines.keys(), ...this.junk.keys(), ...this.rtt.keys(), ...this.treasure.trackedIds()]);
    return [...ids].sort();
  }

  /** RaftWorld step 2 (after players): bite timers, bite windows, pending reel results / treasure reels. */
  step(): void {
    for (const [id, line] of [...this.lines]) {
      const p = this.ctx.state.players.get(id);
      if (!p) {
        this.lines.delete(id);
        continue;
      }
      if (p.fishState === FISH_STATE.CAST || p.fishState === FISH_STATE.BITE) {
        const why = this.breakReason(p, line);
        if (why) {
          this.miss(p, line, why);
          continue;
        }
      }
      const now = this.ctx.tick();
      if (p.fishState === FISH_STATE.CAST) {
        if (now >= line.biteAt) this.bite(p, line);
      } else if (p.fishState === FISH_STATE.BITE) {
        if (now >= line.windowEnd) this.miss(p, line, "late");
      } else if (p.fishState === FISH_STATE.REEL) {
        if (now >= line.landAt) this.land(p, line);
      } else {
        this.lines.delete(id);
      }
    }
    this.treasure.step();
  }

  /** Treasure reel from a non-fishing source (secret chest, wave gift): picks, emits treasure, applies it when the reel ends. */
  treasureReel(p: PlayerState, source: "secretChest" | "waveGift"): void {
    this.treasure.start(p, source);
  }

  /** Match start / lobby: lines, pity and reels reset; RTTs kept for the players still in the room. */
  clear(): void {
    for (const id of this.lines.keys()) {
      const p = this.ctx.state.players.get(id);
      if (p) {
        p.fishState = FISH_STATE.NONE;
        p.fishSpot = -1;
      }
    }
    this.lines.clear();
    this.junk.clear();
    this.treasure.clear();
    for (const id of this.rtt.keys()) if (!this.ctx.state.players.has(id)) this.rtt.delete(id);
  }

  /** Bite window (server ticks) for a fisher: FISH_BITE_TICKS + min(RTT/2, FISH_LAG_ALLOWANCE_MAX_TICKS). */
  biteWindowTicks(p: PlayerState): number {
    const rtt = this.rtt.get(p.id) ?? p.ping ?? 0;
    const lag = Math.min(FISH_LAG_ALLOWANCE_MAX_TICKS, Math.max(0, Math.round(rtt / 2 / TICK_MS)));
    return FISH_BITE_TICKS + lag;
  }

  /** This match's loot table (legend / tests). */
  lootTable(): ReadonlyArray<LootEntry<FishLoot>> {
    return this.table;
  }

  /* ------------------------------------------------------------ internals */

  private cast(p: PlayerState): boolean {
    if (p.swimming) {
      this.reject(p, "busy");
      return false;
    }
    const aim = this.aimedSpot(p);
    if (!aim) {
      this.reject(p, "noSpot");
      return false;
    }
    // Gelin (the fisher, Long Tide T5) waits CharacterDef.biteWaitMult as long for a bite.
    const wait = Math.max(1, Math.round(randInt(this.ctx.rng, FISH_WAIT_MIN_TICKS, FISH_WAIT_MAX_TICKS) * CHARACTERS[p.character].biteWaitMult));
    const now = this.ctx.tick();
    this.lines.set(p.id, { spot: aim.spot, castX: p.x, castZ: p.z, bobber: aim.bobber, biteAt: now + wait, windowEnd: 0, landAt: 0, loot: null });
    p.fishState = FISH_STATE.CAST;
    p.fishSpot = aim.spot;
    this.ctx.emit({ type: "fishCast", tick: this.ctx.tick(), playerId: p.id, spot: aim.spot, pos: vec(aim.bobber.x, aim.bobber.y, aim.bobber.z) });
    return true;
  }

  private bite(p: PlayerState, line: FishLine): void {
    p.fishState = FISH_STATE.BITE;
    line.windowEnd = this.ctx.tick() + this.biteWindowTicks(p);
    this.ctx.emit({ type: "fishBite", tick: this.ctx.tick(), playerId: p.id, spot: line.spot, windowTicks: FISH_BITE_TICKS });
  }

  private strike(p: PlayerState, line: FishLine): void {
    const streak = this.junk.get(p.id) ?? 0;
    const roll = rollFish(this.table, this.ctx.rng, streak);
    this.junk.set(p.id, nextJunkStreak(streak, roll.loot));
    const { reel, stopIndex } = fishReel(this.ctx.rng, this.table, roll.loot);
    line.loot = roll.loot;
    line.landAt = this.ctx.tick() + FISH_REEL_TICKS;
    p.fishState = FISH_STATE.REEL;
    p.stats.fish++;
    this.ctx.addScore(p, MVP_POINTS.fish);
    this.ctx.emit({ type: "fishResult", tick: this.ctx.tick(), playerId: p.id, spot: line.spot, loot: roll.loot, reel, stopIndex, pity: roll.pity });
  }

  /** The reel stopped: deliver the item / start the treasure reel / apply the bottle. */
  private land(p: PlayerState, line: FishLine): void {
    this.lines.delete(p.id);
    p.fishState = FISH_STATE.NONE;
    p.fishSpot = -1;
    const loot = line.loot;
    if (!loot || !p.alive) return;
    const item = FISH_LOOT_ITEM[loot];
    if (item) this.ctx.giveItem(p, item, 1, "fish");
    else if (loot === "treasure") this.treasure.start(p, "fish");
    else if (loot === "bottle") this.ctx.applyBottle(p);
  }

  private miss(p: PlayerState, line: FishLine, reason: FishMissEvent["reason"]): void {
    this.lines.delete(p.id);
    p.fishState = FISH_STATE.NONE;
    p.fishSpot = -1;
    this.ctx.emit({ type: "fishMiss", tick: this.ctx.tick(), playerId: p.id, spot: line.spot, reason });
  }

  private breakReason(p: PlayerState, line: FishLine): FishMissEvent["reason"] | null {
    if (!p.alive || p.downed || p.boarded || p.washed) return "cancel";
    if (heldKind(p) !== "rod") return "moved";
    const dx = p.x - line.castX;
    const dz = p.z - line.castZ;
    if (dx * dx + dz * dz > FISH_CANCEL_DIST * FISH_CANCEL_DIST) return "moved";
    return null;
  }

  private reject(p: PlayerState, reason: "noSpot" | "busy"): void {
    this.ctx.emit({ type: "reject", tick: this.ctx.tick(), playerId: p.id, action: "fish", reason });
  }

  /**
   * The fish spot the player is looking at: within FISH_CAST_RANGE of the eye, and either the look ray passes
   * within FISH_SPOT_RADIUS of the spot center (at water level) or it meets the water inside the spot. The
   * closest match wins. The bobber lands where the ray meets the water (or on the spot when aiming above it).
   */
  private aimedSpot(p: PlayerState): { spot: number; bobber: Vec3Like } | null {
    const eye = eyePosition(p);
    const dir = aimDirection(p.yaw, p.pitch);
    let waterHit: Vec3Like | null = null;
    if (dir.y < -1e-4 && eye.y > WATER_Y) {
      const t = (WATER_Y - eye.y) / dir.y;
      waterHit = { x: eye.x + dir.x * t, y: WATER_Y, z: eye.z + dir.z * t };
    }
    let best = -1;
    let bestScore = Infinity;
    let bestBobber: Vec3Like | null = null;
    for (const spot of this.ctx.island.fishSpots) {
      const vx = spot.x - eye.x;
      const vy = WATER_Y - eye.y;
      const vz = spot.z - eye.z;
      const len2 = vx * vx + vy * vy + vz * vz;
      if (len2 > FISH_CAST_RANGE * FISH_CAST_RANGE) continue;
      let score = Infinity;
      let bobber: Vec3Like | null = null;
      if (waterHit) {
        const hd = Math.hypot(waterHit.x - spot.x, waterHit.z - spot.z);
        if (hd <= FISH_SPOT_RADIUS) {
          score = hd * 0.5;
          bobber = { x: waterHit.x, y: WATER_Y, z: waterHit.z };
        }
      }
      const t = vx * dir.x + vy * dir.y + vz * dir.z;
      if (t > 0) {
        const perp = Math.sqrt(Math.max(0, len2 - t * t));
        if (perp <= FISH_SPOT_RADIUS && perp < score) {
          score = perp;
          // Aiming over the spot: the bobber plops a little short of its center, toward the fisher.
          const hd = Math.hypot(vx, vz) || 1;
          const pull = Math.min(FISH_SPOT_RADIUS * 0.5, hd * 0.1);
          bobber = bobber ?? { x: spot.x - (vx / hd) * pull, y: WATER_Y, z: spot.z - (vz / hd) * pull };
        }
      }
      if (bobber && score < bestScore) {
        bestScore = score;
        best = spot.i;
        bestBobber = bobber;
      }
    }
    return best >= 0 && bestBobber ? { spot: best, bobber: bestBobber } : null;
  }
}
