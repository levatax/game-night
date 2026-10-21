// The internal contract between RaftWorld (server-world, "core") and its life systems — monsters, fishing,
// weather / day events (server-world-life). Owner: architect (complete; both sides may ADD members by appending
// a line to docs/CONTRACT_CHANGES.md, never change existing ones).
//
// RaftWorld implements WorldContext and owns one instance of each system:
//   monsters = new MonsterSystem(ctx), fishing = new FishingSystem(ctx), weather = new WeatherSystem(ctx, monsters)
// and calls them at the documented points of step() (docs/ARCHITECTURE.md §4.3).

import type { DifficultyDef, Timings } from "../../shared/constants.js";
import type { IslandDef, IslandSite } from "../../shared/island/types.js";
import type { PickupEvent } from "../../shared/protocol.js";
import type { CoverIndex } from "../../shared/sim/cover.js";
import type { HurtCause, ItemKind, ProjectileState, TreasureId, Vec3Like } from "../../shared/types.js";
import type { MonsterState, PlayerState, ProjectileEntity, RaftState, TeamState } from "../schema.js";
import type { GameEvent } from "./events.js";

export interface LightRing {
  x: number;
  z: number;
  r: number;
  /** "fire" | "torch" (held) | "planted". */
  kind: "fire" | "torch" | "planted";
  team: number;
}

export interface SpawnProjectileOptions {
  ownerId?: string;
  team?: number;
  state?: ProjectileState;
  throwSeq?: number;
  charge?: number;
}

export interface WorldContext {
  readonly state: RaftState;
  readonly island: IslandDef;
  readonly cover: CoverIndex;
  readonly timings: Readonly<Timings>;
  readonly difficulty: Readonly<DifficultyDef>;
  /** Gameplay rng [0, 1). */
  rng(): number;
  /** Current server tick (state.tick). */
  tick(): number;
  emit(ev: GameEvent): void;

  /* ---------------------------------------------------------- players */
  /** Alive (not washed, not spectator) players, optionally of one team. */
  alivePlayers(team?: number): PlayerState[];
  /** Apply damage (no-op on downed / washed / boarded; hp 0 → downed). Emits playerHurt (+ playerDowned). */
  damagePlayer(p: PlayerState, amount: number, cause: HurtCause, byId: string): void;
  /** Knockback velocity + stun (HIT_STUN_TICKS when omitted). */
  knockPlayer(p: PlayerState, knock: Vec3Like, stunTicks?: number): void;
  /** Give items: into the inventory, overflow dropped as resting projectiles at the player's feet. Emits pickup. Returns units that went into the inventory. */
  giveItem(p: PlayerState, kind: ItemKind, count: number, source: PickupEvent["source"]): number;
  /** Add MVP points (MVP_POINTS.*). */
  addScore(p: PlayerState, points: number): void;

  /* ------------------------------------------------------- projectiles */
  /** Spawn a projectile (null when the cap is reached and nothing could be despawned). */
  spawnProjectile(kind: ItemKind, pos: Vec3Like, vel: Vec3Like, opts?: SpawnProjectileOptions): ProjectileEntity | null;
  removeProjectile(id: string): void;

  /* ------------------------------------------------------------- sites */
  site(team: number): IslandSite;
  team(team: number): TeamState;
  /** Every current light ring (lit campfires, held lit torches, planted torches). */
  lights(): LightRing[];
  /** (x, z) is inside any light ring (optionally ignoring rings smaller than `minR`). */
  inLight(x: number, z: number): boolean;
  /** Remove hull wood (gnawing / fire); updates the stage; emits raftDamage. */
  damageRaft(team: number, amount: number, byMonsterId: string, pos: Vec3Like): void;
  /** Take one item (a random kind, or `kind`) out of the team chest; null when empty. Emits chestChanged "steal". */
  stealFromChest(team: number, kind?: ItemKind): ItemKind | null;
  /** Put items back into the team chest. Emits chestChanged "return". */
  returnToChest(team: number, kind: ItemKind, count: number): void;
  /** Add campfire fuel (capped); relights it. Emits fireFuel. */
  addFireFuel(team: number, ticks: number, byId: string, source: "wood" | "throw" | "jellyfish" | "fuelCan"): void;
  /** Apply a treasure to the finder's team (flare / sail / hat / spyglass / fuel can). */
  applyTreasure(p: PlayerState, treasure: TreasureId): void;
  /** Mark something as seen by a bottle (see ARCHITECTURE §2.8) and emit bottle. */
  applyBottle(p: PlayerState): void;
}

/* --------------------------------------------------------------- systems */

export type { MonsterState, PlayerState, ProjectileEntity, TeamState };
