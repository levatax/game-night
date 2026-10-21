// Player-placed structures: fences, water collectors, planted torches, kraken tentacles (and the duel hut /
// canoe). Owner: server-world. game4.md §7, §10–§11, docs/ARCHITECTURE.md §2.3, §4.3 step 5.
//
// - LMB with a fence / collector / kraken places it PLACE_DISTANCE in front (fence yaw snapped to π/4 so the
//   cover posts are bit-exact on the client); Q with a torch plants it (a `torch` structure keeping its burn).
// - Life: planted torches burn down (`life`), krakens thrash for KRAKEN_TICKS slamming monsters every
//   KRAKEN_HIT_INTERVAL_TICKS (MonsterSystem.blast), collectors fill one use per COLLECTOR_FILL_TICKS of rain.
// - Fences / collectors / huts collide: the CoverIndex dynamic layer is re-synced whenever the set of colliding
//   structures changes (also when a monster breaks a fence: the life systems may delete structures).
// Ids are "s<n>" (the cover index orders dynamic colliders by that numeric suffix).

import {
  COLLECTOR_FILL_TICKS,
  COLLECTOR_HP,
  COLLECTOR_USES,
  FENCE_HP,
  FENCE_LENGTH,
  KRAKEN_HIT_INTERVAL_TICKS,
  KRAKEN_RADIUS,
  KRAKEN_TICKS,
  MAX_STRUCTURES,
  PLACE_DISTANCE,
  TORCH_BURN_TICKS,
  WATER_Y,
} from "../../shared/constants.js";
import { heightAt, normalAt } from "../../shared/island/heightfield.js";
import { ITEMS } from "../../shared/items.js";
import type { ClockInfo } from "../../shared/rules/schedule.js";
import { slotKind } from "../../shared/rules/inventory.js";
import { snapYaw8, type CoverCircle } from "../../shared/sim/cover.js";
import type { StructureKind, Vec3Like } from "../../shared/types.js";
import { StructureState } from "../schema.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";
import { dist2, KRAKEN_SLAM_DAMAGE, PLACE_MAX_DEPTH, PLACE_MIN_NORMAL_Y, point, posOf } from "./rules.js";

/** Keep placeables off the campfire and the raft slip. */
const CAMPFIRE_KEEP_OUT = 1.3;
const RAFT_KEEP_OUT = 2.2;
/** A planted torch fed with wood / jellyfish burns at most this long. */
const TORCH_FEED_CAP = TORCH_BURN_TICKS * 2;
/** Footprint checked against existing colliders. */
const FOOTPRINT = { fence: FENCE_LENGTH / 2, collector: 0.5, kraken: 0.4, torch: 0.2, hut: 2, canoe: 1 } as const;

export class StructureSystem {
  private nextId = 1;
  /** Ids of the colliding structures last pushed into the cover index. */
  private coverKey = "";
  /** Collector id → rain ticks toward the next use. */
  private readonly fill = new Map<string, number>();
  private readonly scratch: CoverCircle[] = [];

  constructor(private readonly core: WorldCore) {}

  /* ---------------------------------------------------------------- placing */

  /** Valid ground for a structure of `kind` at (x, z), or null (water, slope, colliders, sites, cap). */
  spotAt(x: number, z: number, kind: StructureKind): Vec3Like | null {
    const core = this.core;
    const b = core.island.bounds;
    if (x < b.minX || x > b.maxX || z < b.minZ || z > b.maxZ) return null;
    if (core.state.structures.size >= MAX_STRUCTURES) return null;
    const grid = core.island.grid;
    const ground = heightAt(grid, x, z);
    if (ground < WATER_Y - PLACE_MAX_DEPTH) return null;
    if (normalAt(grid, x, z).y < PLACE_MIN_NORMAL_Y) return null;
    if (core.cover.query(x, z, FOOTPRINT[kind], this.scratch) > 0) return null;
    for (const site of core.island.sites) {
      if (dist2(x, z, site.campfire.x, site.campfire.z) < CAMPFIRE_KEEP_OUT * CAMPFIRE_KEEP_OUT) return null;
      if (dist2(x, z, site.raft.x, site.raft.z) < RAFT_KEEP_OUT * RAFT_KEEP_OUT) return null;
    }
    return point(x, Math.max(ground, WATER_Y - PLACE_MAX_DEPTH), z);
  }

  /** The spot PLACE_DISTANCE in front of `p` (horizontal look direction). */
  spotInFront(p: PlayerState, kind: StructureKind, distance = PLACE_DISTANCE): Vec3Like | null {
    return this.spotAt(p.x - Math.sin(p.yaw) * distance, p.z - Math.cos(p.yaw) * distance, kind);
  }

  /** LMB with a placeable in `slot`: place it in front (reject "noRoom" when there's no valid ground). */
  place(p: PlayerState, slot: number): boolean {
    const item = slotKind(p, slot);
    const kind = item === "" ? null : ITEMS[item].places;
    if (!kind) return false;
    const spot = this.spotInFront(p, kind);
    if (!spot) {
      this.core.reject(p, "place", "noRoom");
      return false;
    }
    this.core.bag.takeFromSlot(p, slot, 1);
    const hp = kind === "fence" ? FENCE_HP : kind === "collector" ? COLLECTOR_HP : 1;
    const life = kind === "kraken" ? KRAKEN_TICKS : 0;
    const yaw = kind === "fence" ? snapYaw8(p.yaw) : p.yaw;
    const s = this.add(kind, spot, yaw, p.team, p.id, hp, life, 0);
    return s !== null;
  }

  /** Q with a torch: plant it in front (or at the feet), keeping its remaining burn. */
  plantTorch(p: PlayerState, slot: number): boolean {
    if (slotKind(p, slot) !== "torch") return false;
    const spot = this.spotInFront(p, "torch") ?? this.spotInFront(p, "torch", 0.6);
    if (!spot) {
      this.core.reject(p, "place", "noRoom");
      return false;
    }
    const burn = p.torchTicks > 0 ? p.torchTicks : TORCH_BURN_TICKS;
    // The planted torch takes the burning flame with it: a spare torch in the pockets starts fresh.
    p.torchTicks = 0;
    this.core.bag.takeFromSlot(p, slot, 1);
    return this.add("torch", spot, p.yaw, p.team, p.id, 1, burn, 0) !== null;
  }

  /** Create a structure (emits structurePlaced). Null at MAX_STRUCTURES. */
  add(kind: StructureKind, pos: Vec3Like, yaw: number, team: number, ownerId: string, hp: number, life: number, uses: number): StructureState | null {
    const core = this.core;
    if (core.state.structures.size >= MAX_STRUCTURES) return null;
    const s = new StructureState();
    s.id = `s${this.nextId++}`;
    s.kind = kind;
    s.x = pos.x;
    s.y = pos.y;
    s.z = pos.z;
    s.yaw = yaw;
    s.team = team;
    s.ownerId = ownerId;
    s.hp = hp;
    s.life = life;
    s.uses = uses;
    core.state.structures.set(s.id, s);
    core.emit({ type: "structurePlaced", tick: core.tick(), id: s.id, kind, playerId: ownerId, pos: posOf(s), yaw });
    this.syncCover();
    if (kind === "torch") core.lightsChanged();
    return s;
  }

  /** Remove a structure (emits structureDestroyed; byId "" = burned out / expired). */
  remove(id: string, byId: string): void {
    const core = this.core;
    const s = core.state.structures.get(id);
    if (!s) return;
    core.emit({ type: "structureDestroyed", tick: core.tick(), id, kind: s.kind, byId, pos: posOf(s) });
    core.state.structures.delete(id);
    this.fill.delete(id);
    this.syncCover();
    if (s.kind === "torch") core.lightsChanged();
  }

  /** A burning planted torch within `r` of (x, z), or null. */
  plantedTorchNear(x: number, z: number, r: number): StructureState | null {
    let found: StructureState | null = null;
    this.core.state.structures.forEach((s) => {
      if (!found && s.kind === "torch" && s.life > 0 && dist2(x, z, s.x, s.z) <= r * r) found = s;
    });
    return found;
  }

  /** Wood / jellyfish thrown at a planted torch. */
  feedTorch(s: StructureState, ticks: number): void {
    s.life = Math.min(TORCH_FEED_CAP, s.life + ticks);
  }

  /* ------------------------------------------------------------------- life */

  /** RaftWorld step 5: torch burn, kraken thrashing, collectors filling in the rain. Runs while the clock does. */
  step(clock: ClockInfo | null): void {
    const core = this.core;
    if (!clock) return;
    const raining = core.state.weather === "rain";
    for (const id of [...core.state.structures.keys()]) {
      const s = core.state.structures.get(id);
      if (!s) continue;
      if (s.kind === "torch") {
        if (s.life > 0) s.life--;
        if (s.life === 0) this.remove(id, "");
      } else if (s.kind === "kraken") {
        if (s.life > 0) {
          s.life--;
          const elapsed = KRAKEN_TICKS - s.life;
          if (elapsed > 0 && elapsed % KRAKEN_HIT_INTERVAL_TICKS === 0) core.monsters.blast(posOf(s), KRAKEN_RADIUS, KRAKEN_SLAM_DAMAGE, s.ownerId);
        }
        if (s.life === 0) this.remove(id, "");
      } else if (s.kind === "collector" && raining && s.uses < COLLECTOR_USES) {
        const t = (this.fill.get(id) ?? 0) + 1;
        if (t >= COLLECTOR_FILL_TICKS) {
          s.uses = Math.min(COLLECTOR_USES, s.uses + 1);
          this.fill.set(id, 0);
        } else {
          this.fill.set(id, t);
        }
      }
    }
  }

  /** Push the colliding structures into the cover index when that set changed (or always with `force`). */
  syncCover(force = false): void {
    let key = "";
    this.core.state.structures.forEach((s) => {
      if (s.kind === "fence" || s.kind === "collector" || s.kind === "hut") key += `${s.id},`;
    });
    if (!force && key === this.coverKey) return;
    this.coverKey = key;
    this.core.cover.setStructures(this.core.state.structures.values());
  }

  /** Match start / lobby / new island. */
  clear(): void {
    this.core.state.structures.clear();
    this.fill.clear();
    this.coverKey = "";
    this.core.cover.setStructures([]);
  }
}
