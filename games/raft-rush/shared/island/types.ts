// Island data produced by generateIsland(seed, layout). FROZEN CONTRACT (see docs/ARCHITECTURE.md).
//
// Server and client both run generateIsland() on the same seed and MUST get bit-identical results (the server
// sends gridHash + defHash in WelcomeMsg; the client warns on a mismatch). Everything gameplay-relevant is
// produced with integer hashing (Math.imul), + − × ÷, Math.floor and Math.sqrt only — never Math.sin/cos/pow/exp/
// atan2 — and heights are rounded with Math.fround into a Float32Array. Cosmetic-only values (yaw, scale,
// variant, tint) may use anything.

import type { Biome, BushYield, Layout, NodeKind } from "../types.js";

/**
 * Regular grid of terrain heights. Vertex (c, r) sits at world (originX + c·cell, originZ + r·cell) with height
 * heights[r·cols + c]. Between vertices heights are bilinear (see heightfield.ts heightAt).
 */
export interface Heightfield {
  cols: number;
  rows: number;
  cell: number;
  originX: number;
  originZ: number;
  heights: Float32Array;
}

export interface XZ {
  x: number;
  z: number;
}

/** One team's camp on its island (coop: one site, team 0). */
export interface IslandSite {
  team: number;
  /** Island center (the mask's center). */
  center: XZ;
  /** Shipwreck on the beach: spawn area + starting chest. `yaw` faces inland (cosmetic). */
  wreck: XZ & { yaw: number };
  /** Up to 6 spawn points on sand around the wreck (≥ 1.5 m apart, walkable, dry). */
  spawns: XZ[];
  /** Campfire workbench (8–12 m from the wreck, dry, flat). */
  campfire: XZ;
  /** Shared camp chest (CHEST_FROM_FIRE from the fire). */
  chest: XZ;
  /**
   * Raft slip on the flattest beach cell: `x,z` is the raft center on the sand at the waterline; `yaw` faces the
   * open sea (the launch direction, cosmetic but stable).
   */
  raft: XZ & { yaw: number };
  /** Fresh-water spring (inland, usually up the hill). */
  spring: XZ;
  /** Rain / warmth shelter (null when the generator found no spot). */
  cave: (XZ & { radius: number }) | null;
  /** Hidden chest (only usable after a message in a bottle reveals it). */
  secretChest: XZ;
  /** Waterline cells monsters climb out of (≥ 24, spread around the coast, each 0.3–1.5 m deep water). */
  shore: XZ[];
}

/** A resource node. Its live amount is state.nodes[i]; position and kind never change. */
export interface NodeDef {
  /** Index in IslandDef.nodes (and state.nodes). */
  i: number;
  kind: NodeKind;
  x: number;
  z: number;
  /** Terrain height at (x, z). */
  y: number;
  /** Collider radius (0 for bushes: they don't collide). */
  radius: number;
  /** Collider height above y (trunk / boulder). */
  height: number;
  /** Bush yield ("none" for non-bushes). */
  yield: BushYield;
  /** Initial amount (NODE_AMOUNT, 0 for decorative bushes). */
  amount: number;
  /** Which island (duel: 0 left, 1 right; solo: 0). */
  island: number;
  /** Cosmetic: rotation, scale and archetype (0..3). */
  yaw: number;
  scale: number;
  variant: number;
}

/** Foamy water where the fishing rod works (FISH_SPOT_RADIUS). */
export interface FishSpotDef {
  i: number;
  x: number;
  z: number;
  island: number;
}

export interface IslandDef {
  seed: number;
  layout: Layout;
  biome: Biome;
  grid: Heightfield;
  /** One per team (coop: [team 0]; duel: [team 0 left island, team 1 right island]). */
  sites: IslandSite[];
  nodes: NodeDef[];
  fishSpots: FishSpotDef[];
  /** Walkable bounds (grid extent minus WORLD_EDGE_MARGIN). */
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  /** FNV-1a 32-bit of grid.heights' bytes (gridHash()). */
  gridHash: number;
  /** FNV-1a 32-bit over sites, nodes (kind, x, z, yield, amount) and fish spots, positions × 100 rounded. */
  defHash: number;
}
