// The sim on real generated islands (generateIsland): random walkers and throws stay sane and replay exactly.
// Owner: sim. Integration guard for what the server world, client prediction and bots all run.

import { describe, expect, it } from "vitest";
import { BTN, type InputCmd } from "../protocol.js";
import { generateIsland } from "../island/generate.js";
import { heightAt } from "../island/heightfield.js";
import type { IslandDef } from "../island/types.js";
import type { ItemKind } from "../types.js";
import { buildCover, type CoverCircle, type CoverIndex } from "./cover.js";
import { copyPlayerSim, createPlayerSim, emptyStepResult, stepPlayerInto, type PlayerSim } from "./player.js";
import { copyProjectileSim, createProjectileSim, stepProjectile, type ProjectileSim } from "./projectile.js";
import { cmd, lcg, makeProjectileContext, makeSimContext, projectile, radiusOf } from "./testkit.js";
import { computeThrowVelocity, throwOrigin } from "./throw.js";

const SEEDS = [1, 77, 4471, 9023];

function walkerScript(seed: number, ticks: number): InputCmd[] {
  const rand = lcg(seed);
  let yaw = rand() * 6.28;
  const out: InputCmd[] = [];
  for (let t = 0; t < ticks; t++) {
    if (rand() < 0.02) yaw += (rand() - 0.5) * 3;
    out.push(cmd({ seq: t + 1, yaw, moveZ: 1, buttons: BTN.SPRINT | (rand() < 0.03 ? BTN.JUMP : 0) }));
  }
  return out;
}

function spawnAt(island: IslandDef, k: number): PlayerSim {
  const site = island.sites[0]!;
  const s = site.spawns[k % Math.max(1, site.spawns.length)] ?? site.wreck;
  const p = createPlayerSim();
  p.alive = true;
  p.x = s.x;
  p.z = s.z;
  p.y = heightAt(island.grid, s.x, s.z);
  return p;
}

describe("players on generated islands", () => {
  it("random walkers stay finite, inside the bounds, above the terrain and (nearly) out of cover", () => {
    const islands = [...SEEDS.map((seed) => generateIsland(seed)), generateIsland(2024, "duel")];
    for (const island of islands) {
      const seed = island.seed;
      const ctx = makeSimContext(island);
      const cover = ctx.cover as CoverIndex;
      const near: CoverCircle[] = [];
      const out = emptyStepResult();
      for (let k = 0; k < 3; k++) {
        const p = spawnAt(island, k);
        for (const c of walkerScript(seed * 13 + k, 900)) {
          stepPlayerInto(p, c, ctx, out);
          expect(Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz)).toBe(true);
          expect(p.x).toBeGreaterThanOrEqual(island.bounds.minX);
          expect(p.x).toBeLessThanOrEqual(island.bounds.maxX);
          expect(p.z).toBeGreaterThanOrEqual(island.bounds.minZ);
          expect(p.z).toBeLessThanOrEqual(island.bounds.maxZ);
          expect(p.y).toBeGreaterThanOrEqual(heightAt(island.grid, p.x, p.z) - 1e-9);
          const n = cover.query(p.x, p.z, radiusOf("kaptan"), near);
          for (let i = 0; i < n; i++) {
            const circle = near[i]!;
            if (circle.top <= p.y + 0.5 || circle.bottom >= p.y + 1.7) continue;
            // Falling into a gap narrower than the capsule can leave a few centimeters for one tick.
            expect(Math.hypot(p.x - circle.x, p.z - circle.z)).toBeGreaterThan(circle.r + radiusOf("kaptan") - 0.05);
          }
        }
      }
    }
  });

  it("replays bit-identically from a snapshot (server vs client prediction)", () => {
    for (const seed of SEEDS) {
      const island = generateIsland(seed);
      const server = makeSimContext(island, "gelin");
      const client = makeSimContext(generateIsland(seed), "gelin");
      const script = walkerScript(seed, 600);
      const p = spawnAt(island, 1);
      const out = emptyStepResult();
      let snap: PlayerSim | null = null;
      script.forEach((c, t) => {
        if (t === 300) snap = copyPlayerSim(p, createPlayerSim());
        stepPlayerInto(p, c, server, out);
      });
      const replay = copyPlayerSim(snap!, createPlayerSim());
      for (let t = 300; t < 600; t++) stepPlayerInto(replay, script[t]!, client, out);
      expect(replay).toEqual(p);
    }
  });
});

describe("projectiles on generated islands", () => {
  it("random throws from the camp settle (rest / stuck / sank) and replay identically", () => {
    const kinds: ItemKind[] = ["coconut", "stone", "spear", "wood", "fish_raw", "boot", "puffer"];
    for (const seed of SEEDS) {
      const island = generateIsland(seed);
      const cover = buildCover(island);
      const ctx = makeProjectileContext(island, cover);
      const rand = lcg(seed + 5);
      const camp = island.sites[0]!.campfire;
      const feet = { x: camp.x + 1.5, y: heightAt(island.grid, camp.x + 1.5, camp.z), z: camp.z, yaw: 0 };
      for (let n = 0; n < 40; n++) {
        feet.yaw = rand() * 6.28;
        const kind = kinds[n % kinds.length]!;
        const v = computeThrowVelocity(rand(), feet.yaw, (rand() - 0.3) * 1.2);
        const origin = throwOrigin(feet);
        const a = projectile(kind, { ...origin, vx: v.x, vy: v.y, vz: v.z, state: "live" });
        const b = copyProjectileSim(a, createProjectileSim(kind)) as ProjectileSim;
        let done = false;
        for (let t = 0; t < 600 && !done; t++) {
          const ra = stepProjectile(a, ctx);
          const rb = stepProjectile(b, ctx);
          expect(rb).toEqual(ra);
          expect(Number.isFinite(a.x + a.y + a.z)).toBe(true);
          if (ra.sank) done = true;
          else expect(a.y - a.radius).toBeGreaterThanOrEqual(heightAt(island.grid, a.x, a.z) - 1e-9);
          if (a.state === "rest" || a.state === "stuck") done = true;
        }
        expect(done).toBe(true);
        expect(b).toEqual(a);
      }
    }
  });
});
