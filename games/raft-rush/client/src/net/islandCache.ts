// The island the client plays on: generated locally from the server's seed / layout (cached), checked against the
// server's gridHash / defHash, plus the collision index the prediction and the projectile dead-reckoning query
// (static island cover + the placed structures of the current state). Owner: client-net. Pure (no colyseus.js).

import { generateIsland } from "../../../shared/island/generate";
import type { IslandDef } from "../../../shared/island/types";
import type { WelcomeMsg } from "../../../shared/protocol";
import type { WorldQuery } from "../../../shared/sim/context";
import { buildCover, type CoverIndex } from "../../../shared/sim/cover";
import type { Layout, MapView, StructureView } from "../../../shared/types";

/** Generator signature (generateIsland; tests may inject a fake). */
export type IslandGenerator = (seed: number, layout: Layout) => IslandDef;

/** Islands kept in memory: the lobby preview while the host types a seed, the match island, a rematch. */
export const ISLAND_CACHE_SIZE = 4;

/** Cache key of an island. */
export function islandKey(seed: number, layout: Layout): string {
  return `${seed >>> 0}:${layout}`;
}

/** Small LRU of generated islands keyed by seed + layout (generation costs 10–40 ms). */
export class IslandCache {
  private readonly entries = new Map<string, IslandDef>();

  constructor(
    private readonly generate: IslandGenerator = generateIsland,
    private readonly capacity = ISLAND_CACHE_SIZE,
  ) {}

  /** The island for seed + layout, generated on a miss (most recently used moves to the back). */
  get(seed: number, layout: Layout): IslandDef {
    const key = islandKey(seed, layout);
    const hit = this.entries.get(key);
    if (hit) {
      this.entries.delete(key);
      this.entries.set(key, hit);
      return hit;
    }
    const def = this.generate(seed >>> 0, layout);
    this.entries.set(key, def);
    while (this.entries.size > Math.max(1, this.capacity)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return def;
  }

  has(seed: number, layout: Layout): boolean {
    return this.entries.has(islandKey(seed, layout));
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** Payload of Net's `island` event. */
export interface IslandChange {
  seed: number;
  layout: Layout;
  mismatch: boolean;
}

/** Server-side hashes of one island (WelcomeMsg). */
interface ServerHashes {
  gridHash: number;
  defHash: number;
}

/**
 * Tracks which island is shown and keeps its CoverIndex in sync with state.structures.
 *
 * Sources (game4.md §19, ARCHITECTURE §2.16):
 * - welcome(msg): the server says which island is loaded and its hashes → load it, compare (mismatch).
 * - matchStart / any CHANGE of state.seed or state.layout → load that island (mismatch only known when a welcome
 *   carried that island's hashes; else false). The first patch of a session only loads its island when no
 *   welcome came first (the welcome is authoritative for the session start).
 * Each method returns an IslandChange when Net should emit `island`: the shown island (or its mismatch flag)
 * changed, or it is the first island since newSession(). Otherwise null.
 */
export class IslandSync {
  private readonly cache: IslandCache;
  private def: IslandDef | null = null;
  private coverIndex: CoverIndex | null = null;
  private readonly hashes = new Map<string, ServerHashes>();
  private emittedKey: string | null = null;
  private emittedMismatch = false;
  private lastStateKey: string | null = null;
  private welcomed = false;
  private structureSig = Number.NaN;
  private query: WorldQuery | null = null;

  constructor(generate: IslandGenerator = generateIsland, capacity = ISLAND_CACHE_SIZE) {
    this.cache = new IslandCache(generate, capacity);
  }

  /** Island currently shown (null before the first welcome / patch). */
  get island(): IslandDef | null {
    return this.def;
  }

  /** Collision index of the shown island + current structures. */
  get cover(): CoverIndex | null {
    return this.coverIndex;
  }

  /** { terrain, cover, bounds } for stepPlayer / stepProjectile (null without an island). Stable object per island. */
  get world(): WorldQuery | null {
    return this.query;
  }

  /** The last welcome's island disagrees with the locally generated one. */
  get mismatch(): boolean {
    return this.def !== null && this.mismatchFor(this.def);
  }

  /** A new connection (join / reconnect): the next island is announced again and the first patch may load one. */
  newSession(): void {
    this.emittedKey = null;
    this.emittedMismatch = false;
    this.lastStateKey = null;
    this.welcomed = false;
  }

  /** WelcomeMsg: remember the server's hashes for its island and show it. */
  welcome(msg: Pick<WelcomeMsg, "seed" | "layout" | "gridHash" | "defHash">): IslandChange | null {
    this.welcomed = true;
    const seed = msg.seed >>> 0;
    this.hashes.set(islandKey(seed, msg.layout), { gridHash: msg.gridHash >>> 0, defHash: msg.defHash >>> 0 });
    const change = this.show(seed, msg.layout);
    if (this.def && this.mismatchFor(this.def)) {
      console.warn(
        `[net] island ${seed}/${msg.layout} differs from the server's (grid ${this.def.gridHash} vs ${msg.gridHash >>> 0}, ` +
          `def ${this.def.defHash} vs ${msg.defHash >>> 0}): movement will rubber-band`,
      );
    }
    return change;
  }

  /** MatchStartEvent (or any explicit "this is the island now"). */
  matchStart(seed: number, layout: Layout): IslandChange | null {
    return this.show(seed >>> 0, layout);
  }

  /** Every state patch: follow changes of state.seed / state.layout. */
  onState(seed: number, layout: Layout): IslandChange | null {
    const key = islandKey(seed, layout);
    if (key === this.lastStateKey) return null;
    const first = this.lastStateKey === null;
    this.lastStateKey = key;
    if (first && this.welcomed && this.def) return null;
    return this.show(seed >>> 0, layout);
  }

  /**
   * Rebuild the dynamic cover when the placed structures changed (fences / collectors / huts collide).
   * Returns true when it rebuilt.
   */
  syncStructures(structures: MapView<StructureView>): boolean {
    const cover = this.coverIndex;
    if (!cover) return false;
    const sig = structureSignature(structures);
    if (sig === this.structureSig) return false;
    this.structureSig = sig;
    cover.setStructures(structures.values());
    return true;
  }

  /** Forget everything (dispose). */
  clear(): void {
    this.cache.clear();
    this.hashes.clear();
    this.def = null;
    this.coverIndex = null;
    this.query = null;
    this.structureSig = Number.NaN;
    this.newSession();
  }

  private show(seed: number, layout: Layout): IslandChange | null {
    const def = this.cache.get(seed, layout);
    if (def !== this.def) {
      this.def = def;
      this.coverIndex = buildCover(def);
      this.query = { terrain: def.grid, cover: this.coverIndex, bounds: def.bounds };
      this.structureSig = Number.NaN;
    }
    const key = islandKey(seed, layout);
    const mismatch = this.mismatchFor(def);
    if (key === this.emittedKey && mismatch === this.emittedMismatch) return null;
    this.emittedKey = key;
    this.emittedMismatch = mismatch;
    return { seed, layout, mismatch };
  }

  private mismatchFor(def: IslandDef): boolean {
    const h = this.hashes.get(islandKey(def.seed, def.layout));
    return h !== undefined && (h.gridHash !== def.gridHash >>> 0 || h.defHash !== def.defHash >>> 0);
  }
}

/**
 * Order-sensitive FNV-1a over what the cover index needs from each structure (id, kind, position, yaw), so a
 * patch with the same structures costs one pass and no rebuild.
 */
export function structureSignature(structures: MapView<StructureView>): number {
  let h = 0x811c9dc5 ^ structures.size;
  const mix = (v: number): void => {
    h ^= v & 0xffffffff;
    h = Math.imul(h, 0x01000193);
  };
  structures.forEach((s) => {
    for (let i = 0; i < s.id.length; i++) mix(s.id.charCodeAt(i));
    for (let i = 0; i < s.kind.length; i++) mix(s.kind.charCodeAt(i));
    mix(Math.round(s.x * 100));
    mix(Math.round(s.y * 100));
    mix(Math.round(s.z * 100));
    mix(Math.round(s.yaw * 1000));
  });
  return h >>> 0;
}
