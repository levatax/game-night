// stepProjectile tests (docs/ARCHITECTURE.md §5.2). Owner: sim.

import { describe, expect, it } from "vitest";
import { DT, PROJECTILE_MAX_SPEED, PROJECTILE_REST_TICKS, THROW_SPEED_MAX, WATER_Y } from "../constants.js";
import { heightAt, normalAt } from "../island/heightfield.js";
import { ITEMS } from "../items.js";
import type { ItemKind } from "../types.js";
import { buildCover } from "./cover.js";
import { vec3 } from "./math.js";
import {
  copyProjectileSim,
  createProjectileSim,
  emptyProjectileResult,
  stepProjectile,
  stepProjectileInto,
  type ProjectileSim,
  type StepProjectileResult,
} from "./projectile.js";
import {
  POOL,
  flatIsland,
  lcg,
  makeProjectileContext,
  node,
  poolIsland,
  projectile,
  runProjectile,
  slopeIsland,
} from "./testkit.js";
import { ballisticPoint } from "./throw.js";

const flat = flatIsland(1);
const flatCtx = makeProjectileContext(flat);

function runUntil(b: ProjectileSim, ctx: ReturnType<typeof makeProjectileContext>, maxTicks: number, done: (r: StepProjectileResult) => boolean): number {
  for (let i = 0; i < maxTicks; i++) if (done(stepProjectile(b, ctx))) return i;
  return -1;
}

function speed(b: ProjectileSim): number {
  return Math.hypot(b.vx, b.vy, b.vz);
}

describe("basics", () => {
  it("never moves resting or stuck projectiles", () => {
    for (const state of ["rest", "stuck"] as const) {
      const b = projectile("coconut", { state, x: 1, y: 5, z: 3, vx: 4 });
      const before = { ...b };
      expect(stepProjectile(b, flatCtx)).toEqual(emptyProjectileResult());
      expect(b).toEqual(before);
    }
  });

  it("creates at rest with the item radius, copies every field and reuses results", () => {
    const b = createProjectileSim("spear");
    expect(b).toMatchObject({ state: "rest", kind: "spear", radius: ITEMS.spear.radius, ageTicks: 0 });
    const src = projectile("boot", { x: 1, y: 2, z: 3, vx: 4, state: "live", bounces: 2, restTicks: 1, ageTicks: 9 });
    expect(copyProjectileSim(src, createProjectileSim("wood"))).toEqual(src);
    const out = emptyProjectileResult();
    expect(stepProjectileInto(src, flatCtx, out)).toBe(out);
    expect(src.ageTicks).toBe(10);
  });

  it("clamps absurd speeds", () => {
    const b = projectile("stone", { y: 8, vx: 200, state: "loose" });
    stepProjectile(b, flatCtx);
    expect(speed(b)).toBeLessThanOrEqual(PROJECTILE_MAX_SPEED + 1e-9);
  });
});

describe("flight", () => {
  it("follows the exact gravity parabola (with the item's gravity scale) until it touches something", () => {
    for (const kind of ["coconut", "stone", "spear"] as const) {
      const origin = vec3(0, 4, 0);
      const v = vec3(4, 6, -10);
      const b = projectile(kind, { ...origin, vx: v.x, vy: v.y, vz: v.z, state: "live" });
      for (let k = 1; k <= 20; k++) {
        stepProjectile(b, flatCtx);
        const expected = ballisticPoint(origin, v, k * DT, ITEMS[kind].gravityScale);
        expect(b.x).toBeCloseTo(expected.x, 9);
        expect(b.y).toBeCloseTo(expected.y, 9);
        expect(b.z).toBeCloseTo(expected.z, 9);
        expect(b.ageTicks).toBe(k);
        expect(b.state).toBe("live");
      }
    }
  });

  it("reflects off the world bounds and stays inside", () => {
    const b = projectile("coconut", { x: flat.bounds.maxX - 0.5, y: 6, vx: 20, state: "loose" });
    stepProjectile(b, flatCtx);
    expect(b.x).toBeLessThanOrEqual(flat.bounds.maxX);
    expect(b.vx).toBeLessThan(0);
  });
});

describe("ground", () => {
  it("turns a live projectile loose on its first ground bounce", () => {
    const b = projectile("coconut", { y: 3, vx: 3, state: "live" });
    const results = runProjectile(b, flatCtx, 30);
    const first = results.findIndex((r) => r.bounced);
    expect(first).toBeGreaterThan(8); // 1.8 m drop ≈ 0.42 s
    expect(first).toBeLessThan(15);
    expect(results[first]!.becameLoose).toBe(true);
    expect(results[first]!.bounceSpeed).toBeCloseTo(Math.sqrt(2 * 20 * 1.8), 0);
    expect(results.filter((r) => r.becameLoose)).toHaveLength(1);
    expect(b.state).not.toBe("live");
  });

  it("bounces a coconut twice, then it rolls to rest", () => {
    const b = projectile("coconut", { y: 4, vx: 6, vy: 4, state: "live" });
    const results = runProjectile(b, flatCtx, 240);
    expect(results.filter((r) => r.bounced)).toHaveLength(ITEMS.coconut.maxBounces);
    expect(b.bounces).toBe(2);
    const rest = results.findIndex((r) => r.cameToRest);
    expect(rest).toBeGreaterThan(0);
    expect(results.filter((r) => r.cameToRest)).toHaveLength(1);
    expect(b).toMatchObject({ state: "rest", vx: 0, vy: 0, vz: 0 });
    expect(b.y).toBeCloseTo(1 + ITEMS.coconut.radius, 9);
    expect(b.restTicks).toBeGreaterThanOrEqual(PROJECTILE_REST_TICKS);
  });

  it("doesn't bounce a stone; it skids to a quick stop", () => {
    const b = projectile("stone", { y: 3, vx: 12, vy: -2, state: "live" });
    const x0 = b.x;
    const results = runProjectile(b, flatCtx, 120);
    expect(results.some((r) => r.bounced)).toBe(false);
    expect(b.bounces).toBe(0);
    expect(b.state).toBe("rest");
    expect(b.x - x0).toBeLessThan(12); // flight ≈ 6.7 m, then a short skid
  });

  it("reflects off slopes along the surface normal", () => {
    const slope = slopeIsland(0.5, 2);
    const ctx = makeProjectileContext(slope);
    const b = projectile("coconut", { x: 0, y: 6, z: 0, state: "live" });
    let hit: StepProjectileResult | null = null;
    for (let i = 0; i < 60 && !hit; i++) {
      const r = stepProjectile(b, ctx);
      if (r.bounced) hit = r;
    }
    expect(hit).not.toBeNull();
    const n = normalAt(slope.grid, b.x, b.z);
    expect(n.x).toBeLessThan(0); // the slope rises along +x
    // Dropped straight down, it bounces off downhill (−x) and up.
    expect(b.vx).toBeLessThan(0);
    expect(b.vy).toBeGreaterThan(0);
    // Reflection: the normal component is impact × restitution.
    const vn = b.vx * n.x + b.vy * n.y + b.vz * n.z;
    expect(vn).toBeCloseTo(hit!.bounceSpeed * ITEMS.coconut.restitution, 1);
  });

  it("rolls down steep slopes but rests on gentle ones", () => {
    const steep = slopeIsland(0.6, 6);
    const b = projectile("coconut", { x: 0, y: heightAt(steep.grid, 0, 0) + 0.2, state: "loose" });
    runProjectile(b, makeProjectileContext(steep), 30);
    expect(b.x).toBeLessThan(-0.5);
    expect(b.state).toBe("loose");

    const gentle = slopeIsland(0.1, 6);
    const c = projectile("coconut", { x: 0, y: heightAt(gentle.grid, 0, 0) + 0.2, state: "loose" });
    expect(runUntil(c, makeProjectileContext(gentle), 60, (r) => r.cameToRest)).toBeGreaterThanOrEqual(0);
    expect(Math.abs(c.x)).toBeLessThan(0.2);
  });

  it("never ends a tick inside the terrain", () => {
    const slope = slopeIsland(0.4, 4);
    const ctx = makeProjectileContext(slope);
    const rand = lcg(3);
    for (let n = 0; n < 40; n++) {
      const b = projectile("coconut", { x: (rand() - 0.5) * 20, y: 12, z: (rand() - 0.5) * 20, vx: (rand() - 0.5) * 30, vy: rand() * 10, vz: (rand() - 0.5) * 30, state: "live" });
      for (let t = 0; t < 90; t++) {
        if (stepProjectile(b, ctx).sank) break; // the server removes it
        expect(b.y - b.radius).toBeGreaterThanOrEqual(heightAt(slope.grid, b.x, b.z) - 1e-9);
      }
    }
  });
});

describe("water", () => {
  const pool = poolIsland();
  const ctx = makeProjectileContext(pool);

  it("sinks in deep water", () => {
    const b = projectile("coconut", { x: 2, y: 3, vx: 2, state: "live" });
    const results = runProjectile(b, ctx, 40);
    const sank = results.findIndex((r) => r.sank);
    expect(sank).toBeGreaterThan(0);
    expect(results.slice(0, sank).some((r) => r.bounced)).toBe(false);
    expect(b.y).toBeLessThan(WATER_Y - b.radius);
  });

  it("sinks a spear in deep water instead of sticking into the seabed", () => {
    const b = projectile("spear", { x: 0, y: 4, vx: 3, state: "live" });
    const results = runProjectile(b, ctx, 60);
    expect(results.some((r) => r.sank)).toBe(true);
    expect(results.some((r) => r.stuck)).toBe(false);
  });

  it("rests in water shallower than its size, sinks in deeper water", () => {
    const shallow = makeProjectileContext(flatIsland(WATER_Y - 0.1));
    const b = projectile("coconut", { y: 2, vx: 1, state: "loose" });
    const results = runProjectile(b, shallow, 120);
    expect(results.some((r) => r.sank)).toBe(false);
    expect(b.state).toBe("rest");

    const deeper = makeProjectileContext(flatIsland(WATER_Y - 0.5));
    const c = projectile("coconut", { y: 2, state: "loose" });
    expect(runProjectile(c, deeper, 60).some((r) => r.sank)).toBe(true);
  });

  it("rolls down a submerged beach into deep water and sinks", () => {
    const b = projectile("coconut", { x: POOL.beachX + 1.5, y: 1, state: "loose" });
    expect(runProjectile(b, ctx, 240).some((r) => r.sank)).toBe(true);
  });
});

describe("spears", () => {
  it("stick into the ground where they land", () => {
    const b = projectile("spear", { y: 3, vx: 15, vy: 3, state: "live" });
    const results = runProjectile(b, flatCtx, 60);
    const at = results.findIndex((r) => r.stuck);
    expect(at).toBeGreaterThan(0);
    expect(results.filter((r) => r.stuck)).toHaveLength(1);
    expect(results.some((r) => r.bounced || r.becameLoose)).toBe(false);
    expect(b).toMatchObject({ state: "stuck", vx: 0, vy: 0, vz: 0 });
    expect(b.y).toBeCloseTo(1 + ITEMS.spear.radius, 9);
  });

  it("stick into trunks but glance off rocks", () => {
    const base = flatIsland(1);
    const island = flatIsland(1, [node(base.grid, "tree", 0, -5), node(base.grid, "rock", 6, -5, { radius: 0.8, height: 1.5 })]);
    const ctx = makeProjectileContext(island);
    const tree = buildCover(island).all()[0]!;

    const intoTree = projectile("spear", { x: 0, y: 2.5, z: 0, vz: -25, state: "live" });
    const results = runProjectile(intoTree, ctx, 10);
    const hit = results.find((r) => r.stuck);
    expect(hit?.hitCover).toMatchObject({ kind: "tree", node: tree.node });
    expect(intoTree.state).toBe("stuck");
    expect(intoTree.z).toBeCloseTo(-5 + tree.r + ITEMS.spear.radius, 6);

    const intoRock = projectile("spear", { x: 6, y: 1.5, z: 0, vz: -25, state: "live" });
    let glance: StepProjectileResult | null = null;
    for (let i = 0; i < 10 && !glance; i++) {
      const r = stepProjectile(intoRock, ctx);
      if (r.hitCover) glance = r;
    }
    expect(glance?.hitCover?.kind).toBe("rock");
    expect(glance?.becameLoose).toBe(true);
    expect(glance?.stuck).toBe(false);
    expect(intoRock.state).toBe("loose");
    expect(intoRock.vz).toBeGreaterThan(0);
  });
});

describe("cover", () => {
  const base = flatIsland(1);
  const palmNode = node(base.grid, "palm", 0, -6);
  const island = flatIsland(1, [palmNode, node(base.grid, "rock", 8, -6, { radius: 1, height: 1 })]);
  const ctx = makeProjectileContext(island);

  it("reports the palm it hit and bounces a live coconut off it", () => {
    const b = projectile("coconut", { x: 0, y: 2.4, z: 0, vz: -20, state: "live" });
    const results = runProjectile(b, ctx, 15);
    const hits = results.filter((r) => r.hitCover !== null);
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]!.hitCover).toMatchObject({ kind: "palm", node: 0 });
    expect(hits[0]!.becameLoose).toBe(true);
    expect(b.vz).toBeGreaterThan(0);
    expect(b.z).toBeGreaterThan(-6 + palmNode.radius);
  });

  it("doesn't tunnel through a 0.3 m trunk at full throw speed, centered or glancing", () => {
    for (const kind of ["coconut", "stone", "spear"] as ItemKind[]) {
      for (const offset of [0, 0.2, 0.4]) {
        const r = ITEMS[kind].radius;
        if (offset >= palmNode.radius + r) continue;
        const b = projectile(kind, { x: offset, y: 2.4, z: 2, vz: -THROW_SPEED_MAX, state: "live" });
        let hit: StepProjectileResult | null = null;
        for (let i = 0; i < 10 && !hit; i++) {
          const res = stepProjectile(b, ctx);
          if (res.hitCover) hit = res;
        }
        expect(hit?.hitCover?.kind).toBe("palm");
        if (hit?.stuck) {
          expect(b.z).toBeGreaterThan(-6);
        } else if (offset === 0) {
          expect(b.vz).toBeGreaterThan(0); // bounced straight back
          expect(b.z).toBeGreaterThan(-6 + palmNode.radius);
        } else {
          expect(b.vx).toBeGreaterThan(0); // glanced off to the side it hit
        }
        // Never inside the trunk.
        expect(Math.hypot(b.x, b.z + 6)).toBeGreaterThanOrEqual(palmNode.radius + r - 1e-9);
      }
    }
  });

  it("passes over a trunk top (the crown doesn't collide) and lands next to it", () => {
    const b = projectile("coconut", { x: 0, y: 6, z: -6, state: "loose" });
    const results = runProjectile(b, ctx, 90);
    expect(b.state).toBe("rest");
    expect(Math.hypot(b.x, b.z + 6)).toBeGreaterThanOrEqual(palmNode.radius + b.radius - 1e-9);
    expect(b.y).toBeCloseTo(1 + b.radius, 9);
    expect(results.some((r) => r.hitCover?.kind === "palm")).toBe(true);
  });

  it("lands and rests on a rock top", () => {
    const b = projectile("coconut", { x: 8, y: 5, z: -6, state: "loose" });
    const results = runProjectile(b, ctx, 120);
    expect(results.some((r) => r.bounced)).toBe(true);
    expect(b.state).toBe("rest");
    expect(b.y).toBeCloseTo(2 + b.radius, 9);
  });

  it("bounces off a rock side with the item's restitution", () => {
    const b = projectile("coconut", { x: 8, y: 1.9, z: -3, vz: -10, state: "live" });
    let hit: StepProjectileResult | null = null;
    for (let i = 0; i < 20 && !hit; i++) {
      const r = stepProjectile(b, ctx);
      if (r.hitCover) hit = r;
    }
    expect(hit?.hitCover?.kind).toBe("rock");
    expect(hit?.becameLoose).toBe(true);
    expect(b.vz).toBeCloseTo(10 * ITEMS.coconut.restitution, 1);
    expect(Math.abs(b.vx)).toBeLessThan(1e-9);
    expect(b.vy).toBeLessThan(0); // still falling: the tangential part is kept (× bounce friction)
  });
});

describe("determinism", () => {
  it("gives identical results for the same projectiles", () => {
    const base = flatIsland(1);
    const island = flatIsland(1, [node(base.grid, "palm", 1, -3), node(base.grid, "tree", -2, -6), node(base.grid, "rock", 3, -8)]);
    const kinds: ItemKind[] = ["coconut", "stone", "spear", "wood", "boot", "puffer", "fish_raw", "raft_part"];
    const spawn = (seed: number): ProjectileSim[] => {
      const rand = lcg(seed);
      return Array.from({ length: 40 }, (_, i) =>
        projectile(kinds[i % kinds.length]!, {
          x: (rand() - 0.5) * 6,
          y: 1.5 + rand() * 2,
          z: (rand() - 0.5) * 6,
          vx: (rand() - 0.5) * 40,
          vy: rand() * 12,
          vz: (rand() - 0.5) * 40,
          state: "live",
        }),
      );
    };
    const a = spawn(11);
    const b = spawn(11);
    const ctxA = makeProjectileContext(island);
    const ctxB = makeProjectileContext(island);
    const ra: StepProjectileResult[][] = [];
    const rb: StepProjectileResult[][] = [];
    for (let t = 0; t < 150; t++) {
      ra.push(a.map((p) => stepProjectile(p, ctxA)));
      rb.push(b.map((p) => stepProjectile(p, ctxB)));
    }
    expect(b).toEqual(a);
    expect(rb).toEqual(ra);
    expect(a.every((p) => p.state === "rest" || p.state === "stuck")).toBe(true);
  });
});
