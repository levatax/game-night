// Test fixtures for the bot brain / desk tests (server/room/bot*.test.ts). Owner: server-bots.
// Hand-made heightfields and islands, a synthetic BotView builder and a tiny kinematic walker that obeys the
// same cliff / wall / cover rules as stepPlayer, so steering tests don't depend on the sim's progress.

import { MAX_WALK_NORMAL_Y, PLAYER_RADIUS, STEP_MAX, TICK_RATE, WALK_SPEED, timingsFor } from "../../shared/constants.js";
import { raftCost } from "../../shared/items.js";
import { createHeightfield, gridHash, heightAt, normalAt } from "../../shared/island/heightfield.js";
import type { Heightfield, IslandDef, NodeDef } from "../../shared/island/types.js";
import type { WorldQuery } from "../../shared/sim/context.js";
import type { CoverCircle, CoverQuery } from "../../shared/sim/cover.js";
import type { BotView } from "./botTypes.js";

/** cols × rows heightfield (1 m cells) centered on the origin, every vertex at `h`. */
export function flatField(cols: number, rows: number, h: number): Heightfield {
  const hf = createHeightfield(cols, rows, 1, -((cols - 1) / 2), -((rows - 1) / 2));
  hf.heights.fill(h);
  return hf;
}

/** Set every vertex inside the axis-aligned box to height `h`. */
export function raise(hf: Heightfield, minX: number, maxX: number, minZ: number, maxZ: number, h: number): void {
  for (let r = 0; r < hf.rows; r++) {
    for (let c = 0; c < hf.cols; c++) {
      const x = hf.originX + c * hf.cell;
      const z = hf.originZ + r * hf.cell;
      if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) hf.heights[r * hf.cols + c] = h;
    }
  }
}

/** Linear-scan cover over a fixed list of cylinders. */
export function coverOf(circles: CoverCircle[]): CoverQuery & { all(): CoverCircle[] } {
  return {
    query(x, z, radius, out) {
      let n = 0;
      for (const c of circles) {
        const rr = c.r + radius;
        if ((c.x - x) ** 2 + (c.z - z) ** 2 < rr * rr) out[n++] = c;
      }
      return n;
    },
    all: () => circles,
  };
}

export function cylinder(x: number, z: number, r: number, y = 0): CoverCircle {
  return { x, z, r, bottom: y - 1, top: y + 3, kind: "rock", node: -1, id: "" };
}

export function query(terrain: Heightfield, circles: CoverCircle[] = [], margin = 1): WorldQuery {
  const maxX = terrain.originX + (terrain.cols - 1) * terrain.cell;
  const maxZ = terrain.originZ + (terrain.rows - 1) * terrain.cell;
  return {
    terrain,
    cover: coverOf(circles),
    bounds: { minX: terrain.originX + margin, maxX: maxX - margin, minZ: terrain.originZ + margin, maxZ: maxZ - margin },
  };
}

/**
 * Move a point `speed`·dt along (dirX, dirZ) with stepPlayer's rules in 0.25 m sub-steps: a rise above STEP_MAX
 * or a too-steep rising slope rejects the sub-step, cover circles push out. Returns the new position.
 */
export function walkStep(q: WorldQuery, x: number, z: number, dirX: number, dirZ: number, speed = WALK_SPEED): { x: number; z: number } {
  const total = speed / TICK_RATE;
  const n = Math.max(1, Math.ceil(total / 0.25));
  const buf: CoverCircle[] = [];
  const nrm = { x: 0, y: 1, z: 0 };
  for (let k = 0; k < n; k++) {
    const nx = x + (dirX * total) / n;
    const nz = z + (dirZ * total) / n;
    const h0 = heightAt(q.terrain, x, z);
    const h1 = heightAt(q.terrain, nx, nz);
    if (h1 - h0 > STEP_MAX) break;
    if (h1 > h0 + 0.01 && normalAt(q.terrain, nx, nz, nrm).y < MAX_WALK_NORMAL_Y) break;
    let px = nx;
    let pz = nz;
    const count = q.cover.query(px, pz, PLAYER_RADIUS, buf);
    for (let i = 0; i < count; i++) {
      const c = buf[i]!;
      const dx = px - c.x;
      const dz = pz - c.z;
      const d = Math.hypot(dx, dz) || 1e-6;
      const rr = c.r + PLAYER_RADIUS;
      if (d < rr) {
        px = c.x + (dx / d) * rr;
        pz = c.z + (dz / d) * rr;
      }
    }
    x = Math.min(q.bounds.maxX, Math.max(q.bounds.minX, px));
    z = Math.min(q.bounds.maxZ, Math.max(q.bounds.minZ, pz));
  }
  return { x, z };
}

/** A 33 × 33 m test island: flat land at 1 m, the sea along +z (z ≥ 12), one site, a tree. */
export function testIsland(extraNodes: Omit<NodeDef, "i">[] = []): IslandDef {
  const grid = flatField(33, 33, 1);
  raise(grid, -16, 16, 12, 16, -1.6);
  const tree: Omit<NodeDef, "i"> = { kind: "tree", x: 3, z: -3, y: 1, radius: 0.35, height: 4, yield: "none", amount: 3, island: 0, yaw: 0, scale: 1, variant: 0 };
  const nodes = [tree, ...extraNodes].map((n, i) => ({ ...n, i }));
  return {
    seed: 1,
    layout: "solo",
    biome: "tropic",
    grid,
    sites: [
      {
        team: 0,
        center: { x: 0, z: 0 },
        wreck: { x: -8, z: 9, yaw: 0 },
        spawns: [
          { x: 0, z: -1 },
          { x: 1.5, z: -1 },
          { x: -1.5, z: -1 },
        ],
        campfire: { x: -4, z: 2 },
        chest: { x: -6.2, z: 2 },
        raft: { x: 6, z: 11, yaw: Math.PI },
        spring: { x: -9, z: -9 },
        cave: null,
        secretChest: { x: 10, z: -10 },
        shore: [{ x: 0, z: 12.5 }],
      },
    ],
    nodes,
    fishSpots: [],
    bounds: { minX: -13, maxX: 13, minZ: -13, maxZ: 13 },
    gridHash: gridHash(grid),
    defHash: 0,
  };
}

/** A plain BotView with sensible defaults (hamal at the origin, full bars, day 1, raft stage 0); patch what a test needs. */
export function makeView(patch: (v: BotView) => void = () => {}): BotView {
  const t = timingsFor(false);
  const v: BotView = {
    self: {
      id: "bot-1",
      seat: 1,
      team: 0,
      character: "kaptan",
      role: "hamal",
      x: 0,
      y: 1,
      z: 0,
      yaw: 0,
      hp: 100,
      hunger: 100,
      thirst: 100,
      warmth: 100,
      downed: false,
      boarded: false,
      swimming: false,
      slots: [
        { kind: "", count: 0 },
        { kind: "", count: 0 },
        { kind: "", count: 0 },
        { kind: "", count: 0 },
      ],
      activeSlot: 0,
      fishState: 0,
      fuseTicks: 0,
      torchTicks: 0,
    },
    mates: [],
    monsters: [],
    items: [],
    nodes: [
      { i: 0, kind: "tree", yield: "none", x: 6, z: 0, amount: 3, radius: 0.35 },
      { i: 1, kind: "rock", yield: "none", x: -6, z: 4, amount: 2, radius: 0.7 },
      { i: 2, kind: "bush", yield: "rope", x: 0, z: 8, amount: 2, radius: 0 },
      { i: 3, kind: "bush", yield: "berry", x: 2, z: -8, amount: 2, radius: 0 },
      { i: 4, kind: "palm", yield: "none", x: 10, z: 10, amount: 2, radius: 0.3 },
    ],
    fishSpots: [{ i: 0, x: 0, z: 30, standX: 0, standZ: 22 }],
    site: {
      center: { x: 0, z: 0 },
      wreck: { x: -10, z: 15 },
      campfire: { x: -4, z: 2 },
      chest: { x: -6, z: 2 },
      raft: { x: 8, z: 18, yaw: 0 },
      spring: { x: -12, z: -12 },
    },
    team: {
      stage: 0,
      seats: 3,
      cost: raftCost(3),
      hullWood: 3,
      mastWood: 0,
      mastRope: 0,
      food: 0,
      water: 0,
      fireFuel: 1800,
      chest: {},
      launchTicksLeft: 0,
      sail: false,
    },
    clock: {
      phase: "playing",
      locked: false,
      day: 1,
      dayPhase: "day",
      phaseLeft: t.day - 300,
      phaseLength: t.day,
      stormLeft: 3 * (t.day + t.dusk + t.night) - 300,
      dayTicks: t.day,
      duskTicks: t.dusk,
      nightTicks: t.night,
      weather: "clear",
      nightChill: true,
    },
    lights: [{ x: -4, z: 2, r: 5, kind: "fire" }],
    torches: [],
    claims: { nodes: new Set(), items: new Set(), crabs: new Set(), spots: new Set() },
    blocked: () => false,
    current: null,
    roll: 0.5,
  };
  patch(v);
  return v;
}
