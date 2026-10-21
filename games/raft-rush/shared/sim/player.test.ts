// stepPlayer tests (docs/ARCHITECTURE.md §5.1). Owner: sim.

import { describe, expect, it } from "vitest";
import {
  CATCH_COOLDOWN_TICKS,
  CATCH_WINDOW_TICKS,
  CHANNEL,
  CHARACTER_IDS,
  CHARACTERS,
  CHARGE_FULL_TICKS,
  CHARGE_MOVE_MULT,
  COYOTE_TICKS,
  DOWNED_EYE_HEIGHT,
  DOWNED_MOVE_MULT,
  EYE_HEIGHT,
  FREEZING_MOVE_MULT,
  JUMP_HEIGHT,
  JUMP_VELOCITY,
  PITCH_LIMIT,
  PLAYER_HEIGHT,
  SPRINT_SPEED,
  STARVING_MOVE_MULT,
  SWIM_DEPTH,
  SWIM_FLOAT_DEPTH,
  SWIM_SPEED_MULT,
  THROW_RECOVER_TICKS,
  USE_RECOVER_TICKS,
  WALK_SPEED,
  WATER_Y,
} from "../constants.js";
import { heightAt } from "../island/heightfield.js";
import type { IslandDef } from "../island/types.js";
import { BTN, type InputCmd } from "../protocol.js";
import type { CharacterId } from "../types.js";
import { buildCover } from "./cover.js";
import {
  canAct,
  chargeFraction,
  copyPlayerSim,
  createPlayerSim,
  emptyStepResult,
  eyePosition,
  heldKind,
  playerHeight,
  stepPlayer,
  stepPlayerInto,
  type PlayerSim,
  type StepPlayerResult,
} from "./player.js";
import {
  CLIFF,
  POOL,
  cliffIsland,
  cmd,
  flatIsland,
  holding,
  horizontalSpeed,
  lcg,
  makeSimContext,
  node,
  poolIsland,
  radiusOf,
  runPlayer,
  slopeIsland,
  spawnPlayer,
} from "./testkit.js";
import { throwOrigin } from "./throw.js";

/** Yaw that faces +x (forward = (−sin yaw, −cos yaw)). */
const EAST = -Math.PI / 2;
/** Yaw that faces −x. */
const WEST = Math.PI / 2;
const FLOAT_Y = WATER_Y - SWIM_FLOAT_DEPTH;

const flat = flatIsland(1);
const flatCtx = makeSimContext(flat);

function forward(yaw = 0, buttons = 0): InputCmd {
  return cmd({ moveZ: 1, yaw, buttons });
}

describe("basics", () => {
  it("does nothing for players that aren't alive", () => {
    const p = createPlayerSim();
    const before = { ...p };
    const r = stepPlayer(p, cmd({ moveZ: 1, yaw: 1, buttons: BTN.JUMP | BTN.THROW }), flatCtx);
    expect(p).toEqual(before);
    expect(r).toEqual(emptyStepResult());
  });

  it("applies look every tick, wrapping yaw and clamping pitch, and ignores non-finite look", () => {
    const p = spawnPlayer(flat);
    stepPlayer(p, cmd({ yaw: 3 * Math.PI, pitch: 5 }), flatCtx);
    expect(p.yaw).toBeCloseTo(Math.PI, 12);
    expect(p.pitch).toBe(PITCH_LIMIT);
    stepPlayer(p, cmd({ yaw: Number.NaN, pitch: -Infinity, moveX: Number.NaN }), flatCtx);
    expect(p.yaw).toBeCloseTo(Math.PI, 12);
    expect(p.pitch).toBe(PITCH_LIMIT);
    expect(horizontalSpeed(p)).toBe(0);
  });

  it("copies every sim field", () => {
    const src = spawnPlayer(flat, 1, 2, 0.5);
    src.inv2 = "spear";
    src.channel = CHANNEL.REVIVE;
    src.channelTarget = 3;
    src.hunger = 12;
    const dst = copyPlayerSim(src, createPlayerSim());
    expect(dst).toEqual(src);
  });

  it("reuses the result object in stepPlayerInto", () => {
    const out = emptyStepResult();
    const p = spawnPlayer(flat);
    const r = stepPlayerInto(p, cmd({ buttons: BTN.JUMP }), flatCtx, out);
    expect(r).toBe(out);
    expect(out.jumped).toBe(true);
    stepPlayerInto(p, cmd(), flatCtx, out);
    expect(out.jumped).toBe(false);
  });

  it("has helpers for the eye, capsule, held item and charge", () => {
    const p = holding(spawnPlayer(flat, 2, 3), "coconut");
    expect(heldKind(p)).toBe("coconut");
    expect(eyePosition(p)).toEqual({ x: 2, y: 1 + EYE_HEIGHT, z: 3 });
    expect(playerHeight(p)).toBe(PLAYER_HEIGHT);
    p.downed = true;
    expect(eyePosition(p).y).toBeCloseTo(1 + DOWNED_EYE_HEIGHT, 12);
    expect(playerHeight(p)).toBeLessThan(1);
    expect(canAct(p)).toBe(false);
    p.chargeTicks = CHARGE_FULL_TICKS * 2;
    expect(chargeFraction(p)).toBe(1);
  });
});

describe("walking", () => {
  it("reaches walk speed along the camera forward on flat ground", () => {
    const p = spawnPlayer(flat);
    runPlayer(p, flatCtx, 30, forward());
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED, 9);
    expect(p.vz).toBeCloseTo(-WALK_SPEED, 9);
    expect(p.y).toBe(1);
    expect(p.grounded).toBe(true);
    expect(p.sprinting).toBe(false);
  });

  it("is camera-relative and normalizes diagonals", () => {
    const p = spawnPlayer(flat, 0, 0, WEST);
    runPlayer(p, flatCtx, 30, cmd({ yaw: WEST, moveX: 1, moveZ: 1 }));
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED, 9);
    // forward = −X, right = −Z → diagonal (−1, −1)/√2
    expect(p.vx).toBeCloseTo(-WALK_SPEED / Math.SQRT2, 9);
    expect(p.vz).toBeCloseTo(-WALK_SPEED / Math.SQRT2, 9);
  });

  it("sprints with SPRINT held while moving on land, not while charging or standing", () => {
    const p = spawnPlayer(flat);
    const results = runPlayer(p, flatCtx, 30, forward(0, BTN.SPRINT));
    expect(results.length).toBe(30);
    expect(p.sprinting).toBe(true);
    expect(horizontalSpeed(p)).toBeCloseTo(SPRINT_SPEED, 9);

    holding(p, "coconut");
    runPlayer(p, flatCtx, 30, forward(0, BTN.SPRINT | BTN.THROW));
    expect(p.sprinting).toBe(false);
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED * CHARGE_MOVE_MULT, 9);

    const q = spawnPlayer(flat);
    stepPlayer(q, cmd({ buttons: BTN.SPRINT }), flatCtx);
    expect(q.sprinting).toBe(false);
  });

  it("stacks the speed multipliers (charge, starving, freezing, downed)", () => {
    const p = spawnPlayer(flat);
    p.hunger = 0;
    runPlayer(p, flatCtx, 30, forward());
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED * STARVING_MOVE_MULT, 9);
    p.warmth = 0;
    runPlayer(p, flatCtx, 30, forward());
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED * STARVING_MOVE_MULT * FREEZING_MOVE_MULT, 9);
    p.downed = true;
    runPlayer(p, flatCtx, 30, forward(0, BTN.SPRINT));
    expect(p.sprinting).toBe(false);
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED * STARVING_MOVE_MULT * FREEZING_MOVE_MULT * DOWNED_MOVE_MULT, 9);
  });

  it("decelerates to a stop without input", () => {
    const p = spawnPlayer(flat);
    runPlayer(p, flatCtx, 20, forward());
    runPlayer(p, flatCtx, 20, cmd());
    expect(horizontalSpeed(p)).toBe(0);
  });

  it("has reduced air control", () => {
    const p = spawnPlayer(flat);
    expect(stepPlayer(p, cmd({ buttons: BTN.JUMP }), flatCtx).jumped).toBe(true);
    stepPlayer(p, forward(), flatCtx);
    // airborne: 50 · 0.4 · dt ≈ 0.667 m/s per tick
    expect(horizontalSpeed(p)).toBeCloseTo((50 * 0.4) / 30, 9);
  });

  it("is clamped to the island bounds", () => {
    const p = spawnPlayer(flat, 0, flat.bounds.minZ + 1);
    runPlayer(p, flatCtx, 60, forward());
    expect(p.z).toBe(flat.bounds.minZ);
    expect(p.vz).toBe(0);
  });
});

describe("jumping and falling", () => {
  it("jumps JUMP_HEIGHT high and lands with landed + landSpeed", () => {
    const p = spawnPlayer(flat);
    let apex = 0;
    const results: StepPlayerResult[] = [];
    for (let t = 0; t < 40; t++) {
      results.push(stepPlayer(p, cmd({ buttons: t === 0 ? BTN.JUMP : 0 }), flatCtx));
      apex = Math.max(apex, p.y - 1);
    }
    expect(results[0]!.jumped).toBe(true);
    expect(apex).toBeGreaterThan(JUMP_HEIGHT - 0.01);
    expect(apex).toBeLessThanOrEqual(JUMP_HEIGHT + 1e-9);
    const landing = results.findIndex((r) => r.landed);
    expect(landing).toBeGreaterThan(18); // 2·v/g ≈ 0.66 s ≈ 20 ticks
    expect(landing).toBeLessThan(23);
    expect(results[landing]!.landSpeed).toBeCloseTo(JUMP_VELOCITY, 0);
    expect(results.filter((r) => r.landed)).toHaveLength(1);
    expect(p.y).toBe(1);
    expect(p.grounded).toBe(true);
  });

  it("can't double jump", () => {
    const p = spawnPlayer(flat);
    stepPlayer(p, cmd({ buttons: BTN.JUMP }), flatCtx);
    for (let t = 0; t < 10; t++) expect(stepPlayer(p, cmd({ buttons: BTN.JUMP }), flatCtx).jumped).toBe(false);
  });

  it("allows a coyote jump just after walking off a ledge, but not later", () => {
    const island = cliffIsland();
    const ctx = makeSimContext(island);
    const offLedge = (extraTicks: number): boolean => {
      const p = spawnPlayer(island, CLIFF.cliffX + 1, 0, WEST);
      runPlayer(p, ctx, 3, forward(WEST)); // build up speed on the high terrace
      let guard = 0;
      while (p.grounded && guard++ < 60) stepPlayer(p, forward(WEST), ctx);
      expect(p.grounded).toBe(false);
      expect(p.airTicks).toBe(1);
      runPlayer(p, ctx, extraTicks, forward(WEST));
      return stepPlayer(p, forward(WEST, BTN.JUMP), ctx).jumped;
    };
    expect(offLedge(0)).toBe(true);
    expect(offLedge(COYOTE_TICKS - 2)).toBe(true);
    expect(offLedge(COYOTE_TICKS + 1)).toBe(false);
  });

  it("falls off a cliff and lands on the terrace below", () => {
    const island = cliffIsland();
    const ctx = makeSimContext(island);
    const p = spawnPlayer(island, CLIFF.cliffX + 1, 0, WEST);
    const results = runPlayer(p, ctx, 30, forward(WEST));
    const landed = results.filter((r) => r.landed);
    expect(landed).toHaveLength(1);
    expect(landed[0]!.landSpeed).toBeGreaterThan(4);
    expect(p.grounded).toBe(true);
    expect(p.y).toBeCloseTo(CLIFF.mid, 6);
    expect(p.x).toBeLessThan(CLIFF.cliffX);
  });
});

describe("terrain: steps, cliffs and slopes", () => {
  const island = cliffIsland();
  const ctx = makeSimContext(island);

  it("walks up a 0.3 m step", () => {
    const p = spawnPlayer(island, CLIFF.stepX - 2, 0, EAST);
    const results = runPlayer(p, ctx, 30, forward(EAST));
    expect(p.x).toBeGreaterThan(CLIFF.stepX + 1);
    expect(p.y).toBeCloseTo(CLIFF.mid, 6);
    expect(p.grounded).toBe(true);
    expect(results.some((r) => r.landed)).toBe(false);
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED, 6);
  });

  it("is blocked by a 2 m cliff, walking or jumping", () => {
    for (const buttons of [0, BTN.JUMP]) {
      const p = spawnPlayer(island, CLIFF.cliffX - 2, 0, EAST);
      let highest = 0;
      for (let t = 0; t < 90; t++) {
        stepPlayer(p, forward(EAST, t % 25 === 0 && t < 60 ? buttons : 0), ctx);
        highest = Math.max(highest, p.y);
        // Airborne above the face is fine; getting past it isn't.
        expect(p.x).toBeLessThan(CLIFF.cliffX + CLIFF.cell);
      }
      expect(highest).toBeLessThan(CLIFF.mid + 1.2);
      expect(p.y).toBeCloseTo(CLIFF.mid, 6);
      expect(p.grounded).toBe(true);
      expect(p.x).toBeLessThanOrEqual(CLIFF.cliffX + 1e-9);
      if (buttons === 0) {
        // Walking, the wall-lead probe keeps the camera off the face.
        expect(p.x).toBeLessThan(CLIFF.cliffX - radiusOf("kaptan") * 0.5);
        expect(p.x).toBeGreaterThan(CLIFF.cliffX - 0.6);
      }
    }
  });

  it("slides along a cliff when walking at it diagonally", () => {
    const p = spawnPlayer(island, CLIFF.cliffX - 1, 0, EAST);
    // forward (+x) and left (−z when facing +x… right = (cos yaw, −sin yaw) = (0, 1)) → moveX −1 = −z.
    runPlayer(p, ctx, 60, cmd({ yaw: EAST, moveZ: 1, moveX: -1 }));
    expect(p.x).toBeLessThanOrEqual(CLIFF.cliffX);
    expect(p.z).toBeLessThan(-3); // ≈ 2 s × 4.6/√2 along the contour minus the approach
    expect(Math.abs(p.vz)).toBeGreaterThan(2.5);
    expect(Math.abs(p.vx)).toBeLessThan(1e-9);
    expect(p.grounded).toBe(true);
  });

  it("walks up and down a walkable slope without leaving the ground", () => {
    const slope = slopeIsland(0.3);
    const sctx = makeSimContext(slope);
    const up = spawnPlayer(slope, -8, 0, EAST);
    const upResults = runPlayer(up, sctx, 60, forward(EAST));
    expect(up.x).toBeGreaterThan(-8 + 3.5);
    expect(up.grounded).toBe(true);
    expect(up.y).toBeCloseTo(heightAt(slope.grid, up.x, up.z), 5);
    expect(upResults.some((r) => r.landed)).toBe(false);

    const down = spawnPlayer(slope, 8, 0, WEST);
    const downResults = runPlayer(down, sctx, 60, forward(WEST, BTN.SPRINT));
    expect(downResults.every((r) => !r.landed)).toBe(true);
    expect(down.grounded).toBe(true);
    expect(down.x).toBeLessThan(8 - 5);
  });

  it("treats terrain steeper than ~56° as a wall you slide down", () => {
    const wall = slopeIsland(2, 0); // gradient 2: normal.y ≈ 0.45
    const wctx = makeSimContext(wall);
    const p = spawnPlayer(wall, 0, 0, EAST);
    const y0 = p.y;
    runPlayer(p, wctx, 30, forward(EAST));
    expect(p.y).toBeLessThan(y0); // slid down instead of climbing
    expect(p.x).toBeLessThan(0);
    expect(p.grounded).toBe(false);
  });

  it("never ends a tick below the terrain", () => {
    const rand = lcg(7);
    const p = spawnPlayer(island, 0, 0, 0);
    for (let t = 0; t < 600; t++) {
      stepPlayer(p, cmd({ yaw: rand() * 6.28, moveZ: 1, buttons: rand() < 0.1 ? BTN.JUMP | BTN.SPRINT : BTN.SPRINT }), ctx);
      expect(p.y).toBeGreaterThanOrEqual(heightAt(island.grid, p.x, p.z) - 1e-9);
    }
  });
});

describe("cover", () => {
  const base = flatIsland(1);
  const tree = node(base.grid, "tree", 0, -3);
  const lowRock = node(base.grid, "rock", 4, -3, { radius: 0.8, height: 0.4 });
  const tallRock = node(base.grid, "rock", -4, -3, { radius: 0.8, height: 1 });
  const island = flatIsland(1, [tree, lowRock, tallRock]);
  const ctx = makeSimContext(island);

  it("blocks walking into a trunk", () => {
    const p = spawnPlayer(island, 0, 0);
    runPlayer(p, ctx, 60, forward());
    expect(p.z).toBeCloseTo(-3 + tree.radius + radiusOf("kaptan"), 6);
    expect(p.vz).toBeCloseTo(0, 9);
  });

  it("lets the smaller kid capsule get closer", () => {
    const p = spawnPlayer(island, 0, 0);
    runPlayer(p, makeSimContext(island, "cocuk"), 60, forward());
    expect(p.z).toBeCloseTo(-3 + tree.radius + CHARACTERS.cocuk.radius, 6);
  });

  it("slides around a trunk when walking at it off-center", () => {
    const p = spawnPlayer(island, 0.3, 0);
    runPlayer(p, ctx, 60, forward());
    expect(p.z).toBeLessThan(-4);
    expect(p.x).toBeGreaterThan(0.3);
  });

  it("steps onto a low rock and stops at a tall one", () => {
    const low = spawnPlayer(island, 4, 0);
    runPlayer(low, ctx, 25, forward());
    expect(low.z).toBeLessThan(-3 + 0.5);
    expect(low.y).toBeCloseTo(1.4, 9);
    expect(low.grounded).toBe(true);

    const tall = spawnPlayer(island, -4, 0);
    runPlayer(tall, ctx, 40, forward());
    expect(tall.z).toBeCloseTo(-3 + 0.8 + radiusOf("kaptan"), 6);
    expect(tall.y).toBe(1);
  });

  it("can jump onto a 1 m rock and stand on it", () => {
    const p = spawnPlayer(island, -4, -1);
    runPlayer(p, ctx, 6, forward());
    expect(p.z).toBeCloseTo(-3 + 0.8 + radiusOf("kaptan"), 6);
    const results = runPlayer(p, ctx, 40, (t) => (t < 8 ? forward(0, t === 0 ? BTN.JUMP : 0) : cmd()));
    expect(results.filter((r) => r.landed)).toHaveLength(1);
    expect(Math.hypot(p.x + 4, p.z + 3)).toBeLessThan(0.8 + radiusOf("kaptan") * 0.6);
    expect(p.y).toBeCloseTo(2, 9);
    expect(p.grounded).toBe(true);
  });

  it("collides with fences from setStructures and stops when they're gone", () => {
    const cover = buildCover(base);
    const fctx = makeSimContext(base, "kaptan", { cover });
    cover.setStructures([{ id: "s1", kind: "fence", x: 0, y: 1, z: -3, yaw: 0 }]);
    const p = spawnPlayer(base, 0, 0);
    runPlayer(p, fctx, 60, forward());
    expect(p.z).toBeGreaterThan(-3);
    cover.setStructures([]);
    runPlayer(p, fctx, 30, forward());
    expect(p.z).toBeLessThan(-4);
  });
});

describe("water", () => {
  const pool = poolIsland();
  const ctx = makeSimContext(pool);
  const deepX = (POOL.rampEndX + POOL.wallX) / 2;

  it("wades in from the beach, then swims slowly: no sprint, no jump", () => {
    const p = spawnPlayer(pool, POOL.beachX - 1, 0, EAST);
    const results = runPlayer(p, ctx, 150, forward(EAST, BTN.SPRINT));
    expect(results.filter((r) => r.enteredWater)).toHaveLength(1);
    expect(p.swimming).toBe(true);
    expect(p.sprinting).toBe(false);
    expect(p.swimTicks).toBeGreaterThan(10);
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED * SWIM_SPEED_MULT, 6);
    expect(stepPlayer(p, forward(EAST, BTN.JUMP), ctx).jumped).toBe(false);
  });

  it("floats at the float depth over deep water", () => {
    const p = spawnPlayer(pool, deepX, 0);
    p.y = -0.7;
    p.swimming = true;
    p.grounded = false;
    const results = runPlayer(p, ctx, 90, cmd());
    expect(results.every((r) => !r.landed)).toBe(true);
    expect(p.y).toBeCloseTo(FLOAT_Y, 2);
    expect(Math.abs(p.vy)).toBeLessThan(0.05);
    expect(p.swimming).toBe(true);
    expect(p.grounded).toBe(false);
    expect(p.swimTicks).toBe(90);
  });

  it("catches a fall into deep water above the seabed and floats back up", () => {
    const p = spawnPlayer(pool, deepX, 0);
    p.y = 6;
    p.grounded = false;
    p.swimming = false;
    let lowest = Infinity;
    const results: StepPlayerResult[] = [];
    for (let t = 0; t < 150; t++) {
      results.push(stepPlayer(p, cmd(), ctx));
      lowest = Math.min(lowest, p.y);
    }
    expect(results.filter((r) => r.enteredWater)).toHaveLength(1);
    expect(results.some((r) => r.landed)).toBe(false);
    expect(lowest).toBeGreaterThan(POOL.seabed);
    expect(lowest).toBeLessThan(FLOAT_Y - 0.3);
    expect(p.y).toBeCloseTo(FLOAT_Y, 1);
  });

  it("swims faster as the bride", () => {
    const speedOf = (character: CharacterId): number => {
      const p = spawnPlayer(pool, deepX, 0);
      runPlayer(p, makeSimContext(pool, character), 30, forward());
      return horizontalSpeed(p);
    };
    expect(speedOf("kaptan")).toBeCloseTo(WALK_SPEED * SWIM_SPEED_MULT, 6);
    expect(speedOf("gelin")).toBeCloseTo(WALK_SPEED * SWIM_SPEED_MULT * CHARACTERS.gelin.swimMult, 6);
  });

  it("walks back out up the gentle beach", () => {
    const p = spawnPlayer(pool, POOL.rampEndX + 1, 0, WEST);
    expect(p.swimming).toBe(true);
    const results = runPlayer(p, ctx, 150, forward(WEST));
    expect(results.filter((r) => r.leftWater)).toHaveLength(1);
    expect(p.swimming).toBe(false);
    expect(p.swimTicks).toBe(0);
    expect(p.grounded).toBe(true);
    expect(p.x).toBeLessThan(POOL.beachX);
  });

  it("climbs a steep shore ledge with a jump, but not without one", () => {
    const stuck = spawnPlayer(pool, POOL.wallX - 1, 0, EAST);
    runPlayer(stuck, ctx, 90, forward(EAST));
    expect(stuck.swimming).toBe(true);
    expect(stuck.x).toBeLessThanOrEqual(POOL.wallX);

    const climber = spawnPlayer(pool, POOL.wallX - 1, 0, EAST);
    runPlayer(climber, ctx, 30, forward(EAST));
    const results = runPlayer(climber, ctx, 60, (t) => forward(EAST, t === 0 ? BTN.JUMP : 0));
    expect(results[0]!.jumped).toBe(true);
    expect(results.some((r) => r.leftWater)).toBe(true);
    expect(climber.swimming).toBe(false);
    expect(climber.grounded).toBe(true);
    expect(climber.x).toBeGreaterThan(POOL.wallX + POOL.cell);
    expect(climber.y).toBeCloseTo(POOL.ledge, 5);
  });

  it("has no climb in open water", () => {
    const p = spawnPlayer(pool, deepX, 0, EAST);
    runPlayer(p, ctx, 30, cmd());
    expect(stepPlayer(p, forward(EAST, BTN.JUMP), ctx).jumped).toBe(false);
    expect(p.y).toBeLessThan(WATER_Y - SWIM_DEPTH);
  });
});

describe("channel (hold E)", () => {
  it("freezes movement and counts while INTERACT is held, then clears on release", () => {
    const p = spawnPlayer(flat);
    runPlayer(p, flatCtx, 10, forward());
    p.channel = CHANNEL.GATHER;
    p.channelTarget = 5;
    const x = p.x;
    const z = p.z;
    const results = runPlayer(p, flatCtx, 20, forward(0, BTN.INTERACT | BTN.SPRINT));
    expect(p.x).toBe(x);
    expect(p.z).toBe(z);
    expect(p.channelTicks).toBe(20);
    expect(p.channel).toBe(CHANNEL.GATHER);
    expect(p.sprinting).toBe(false);
    expect(results.some((r) => r.channelCancelled)).toBe(false);

    const release = stepPlayer(p, forward(), flatCtx);
    expect(release.channelCancelled).toBe(true);
    expect(p).toMatchObject({ channel: CHANNEL.NONE, channelTicks: 0, channelTarget: -1 });
    runPlayer(p, flatCtx, 10, forward());
    expect(p.z).toBeLessThan(z);
  });

  it("still reports INTERACT_PRESS but no other edge actions while channeling", () => {
    const p = holding(spawnPlayer(flat), "coconut");
    p.channel = CHANNEL.REVIVE;
    const r = stepPlayer(p, cmd({ buttons: BTN.INTERACT | BTN.INTERACT_PRESS | BTN.EAT | BTN.JUMP | BTN.THROW | BTN.DROP }), flatCtx);
    expect(r.interactPressed).toBe(true);
    expect(r).toMatchObject({ eat: false, jumped: false, throw: null });
    expect(p.chargeTicks).toBe(0);
  });

  it("clears when input is locked or the player goes down", () => {
    const p = spawnPlayer(flat);
    p.channel = CHANNEL.GATHER;
    expect(stepPlayer(p, cmd({ buttons: BTN.INTERACT }), makeSimContext(flat, "kaptan", { locked: true, cover: flatCtx.cover })).channelCancelled).toBe(true);
    p.channel = CHANNEL.GATHER;
    p.downed = true;
    expect(stepPlayer(p, cmd({ buttons: BTN.INTERACT }), flatCtx).channelCancelled).toBe(true);
    expect(p.channel).toBe(CHANNEL.NONE);
  });
});

describe("charge, throw, toss, use and slots", () => {
  it("quick-throws on a 1-tick tap with the origin after movement", () => {
    const p = holding(spawnPlayer(flat), "coconut");
    expect(stepPlayer(p, forward(0.3, BTN.THROW | BTN.USE_PRESS), flatCtx).throw).toBeNull();
    expect(p.chargeTicks).toBe(1);
    const r = stepPlayer(p, cmd({ moveZ: 1, yaw: 0.3, pitch: 0.2 }), flatCtx);
    expect(r.throw).not.toBeNull();
    expect(r.throw).toMatchObject({ kind: "coconut", slot: 0, toss: false, yaw: 0.3, pitch: 0.2 });
    expect(r.throw!.charge).toBeCloseTo(1 / CHARGE_FULL_TICKS, 12);
    expect(r.throw!.origin).toEqual(throwOrigin(p));
    expect(p.chargeTicks).toBe(0);
    expect(p.throwTicks).toBe(THROW_RECOVER_TICKS);
  });

  it("caps the charge at full and releases at charge 1", () => {
    const p = holding(spawnPlayer(flat), "spear");
    runPlayer(p, flatCtx, CHARGE_FULL_TICKS + 10, cmd({ buttons: BTN.THROW }));
    expect(p.chargeTicks).toBe(CHARGE_FULL_TICKS);
    const r = stepPlayer(p, cmd(), flatCtx);
    expect(r.throw?.charge).toBe(1);
    expect(r.throw?.kind).toBe("spear");
  });

  it("waits for the recovery before charging again", () => {
    const p = holding(spawnPlayer(flat), "stone");
    stepPlayer(p, cmd({ buttons: BTN.THROW }), flatCtx);
    stepPlayer(p, cmd(), flatCtx);
    // throwTicks counts down at the start of each tick: THROW_RECOVER_TICKS − 1 ticks are blocked.
    const blocked = runPlayer(p, flatCtx, THROW_RECOVER_TICKS - 1, cmd({ buttons: BTN.THROW }));
    expect(blocked.every((r) => r.throw === null)).toBe(true);
    expect(p.chargeTicks).toBe(0);
    stepPlayer(p, cmd({ buttons: BTN.THROW }), flatCtx);
    expect(p.chargeTicks).toBe(1);
  });

  it("uses (LMB press) a non-throwable or an empty hand with its own recovery", () => {
    const p = holding(spawnPlayer(flat), "rod");
    const r = stepPlayer(p, cmd({ buttons: BTN.THROW | BTN.USE_PRESS }), flatCtx);
    expect(r.used).toBe(true);
    expect(r.throw).toBeNull();
    expect(p.chargeTicks).toBe(0);
    expect(p.throwTicks).toBe(USE_RECOVER_TICKS);
    expect(stepPlayer(p, cmd({ buttons: BTN.USE_PRESS }), flatCtx).used).toBe(false);

    const empty = spawnPlayer(flat);
    expect(stepPlayer(empty, cmd({ buttons: BTN.USE_PRESS }), flatCtx).used).toBe(true);
  });

  it("tosses one unit of anything with Q (but not an empty hand)", () => {
    const p = holding(spawnPlayer(flat), "torch");
    const r = stepPlayer(p, cmd({ yaw: 1, pitch: -0.2, buttons: BTN.DROP }), flatCtx);
    expect(r.throw).toMatchObject({ kind: "torch", slot: 0, toss: true, charge: 0, yaw: 1, pitch: -0.2 });
    expect(r.throw!.origin).toEqual(throwOrigin(p));
    expect(p.throwTicks).toBe(THROW_RECOVER_TICKS);

    const charging = holding(spawnPlayer(flat), "coconut");
    runPlayer(charging, flatCtx, 5, cmd({ buttons: BTN.THROW }));
    const toss = stepPlayer(charging, cmd({ buttons: BTN.THROW | BTN.DROP }), flatCtx);
    expect(toss.throw?.toss).toBe(true);
    expect(charging.chargeTicks).toBe(0);

    expect(stepPlayer(spawnPlayer(flat), cmd({ buttons: BTN.DROP }), flatCtx).throw).toBeNull();
  });

  it("cancels a charge without throwing when locked, stunned, catching or the item changes", () => {
    const locked = makeSimContext(flat, "kaptan", { locked: true, cover: flatCtx.cover });
    const p = holding(spawnPlayer(flat), "coconut");
    runPlayer(p, flatCtx, 5, cmd({ buttons: BTN.THROW }));
    const r = stepPlayer(p, cmd({ yaw: 1, buttons: BTN.THROW }), locked);
    expect(r.throw).toBeNull();
    expect(p.chargeTicks).toBe(0);
    expect(p.yaw).toBe(1);

    runPlayer(p, flatCtx, 5, cmd({ buttons: BTN.THROW }));
    p.stunTicks = 3;
    expect(stepPlayer(p, cmd(), flatCtx).throw).toBeNull();
    expect(p.chargeTicks).toBe(0);

    runPlayer(p, flatCtx, 5, cmd({ buttons: BTN.THROW }));
    const c = stepPlayer(p, cmd({ buttons: BTN.CATCH }), flatCtx);
    expect(c.catchStarted).toBe(true);
    expect(c.throw).toBeNull();
    expect(p.chargeTicks).toBe(0);

    runPlayer(p, flatCtx, CATCH_WINDOW_TICKS + 5, cmd({ buttons: BTN.THROW }));
    expect(p.chargeTicks).toBeGreaterThan(0);
    p.inv0 = "rope"; // the server took the coconut
    expect(stepPlayer(p, cmd(), flatCtx).throw).toBeNull();
    expect(p.chargeTicks).toBe(0);
  });

  it("opens a catch window with a cooldown", () => {
    const p = spawnPlayer(flat);
    const r = stepPlayer(p, cmd({ buttons: BTN.CATCH }), flatCtx);
    expect(r.catchStarted).toBe(true);
    expect(p.catchTicks).toBe(CATCH_WINDOW_TICKS);
    expect(p.catchCooldown).toBe(CATCH_COOLDOWN_TICKS);
    runPlayer(p, flatCtx, CATCH_WINDOW_TICKS, cmd());
    expect(p.catchTicks).toBe(0);
    expect(stepPlayer(p, cmd({ buttons: BTN.CATCH }), flatCtx).catchStarted).toBe(false);
    runPlayer(p, flatCtx, CATCH_COOLDOWN_TICKS, cmd());
    expect(stepPlayer(p, cmd({ buttons: BTN.CATCH }), flatCtx).catchStarted).toBe(true);
  });

  it("reports eat and interact edges", () => {
    const p = spawnPlayer(flat);
    expect(stepPlayer(p, cmd({ buttons: BTN.EAT | BTN.INTERACT_PRESS }), flatCtx)).toMatchObject({ eat: true, interactPressed: true });
    expect(stepPlayer(p, cmd({ buttons: BTN.INTERACT }), flatCtx)).toMatchObject({ eat: false, interactPressed: false });
  });

  it("selects slots with SLOT1–4 and cycles with next / prev, cancelling a charge", () => {
    const p = holding(spawnPlayer(flat), "coconut");
    runPlayer(p, flatCtx, 4, cmd({ buttons: BTN.THROW }));
    const r = stepPlayer(p, cmd({ buttons: BTN.THROW | BTN.SLOT3 }), flatCtx);
    expect(r.slotChanged).toBe(true);
    expect(r.throw).toBeNull();
    expect(p.activeSlot).toBe(2);
    expect(p.chargeTicks).toBe(0);
    expect(stepPlayer(p, cmd({ buttons: BTN.SLOT3 }), flatCtx).slotChanged).toBe(false);
    stepPlayer(p, cmd({ buttons: BTN.SLOT4 }), flatCtx);
    stepPlayer(p, cmd({ buttons: BTN.SLOT_NEXT }), flatCtx);
    expect(p.activeSlot).toBe(0);
    stepPlayer(p, cmd({ buttons: BTN.SLOT_PREV }), flatCtx);
    expect(p.activeSlot).toBe(3);
    stepPlayer(p, cmd({ buttons: BTN.SLOT2 | BTN.SLOT4 }), flatCtx);
    expect(p.activeSlot).toBe(1);
  });
});

describe("stun, downed and boarded", () => {
  it("removes control while stunned: slides to a stop on the ground, keeps the arc in the air", () => {
    const p = spawnPlayer(flat);
    p.vx = 5;
    p.stunTicks = 9;
    stepPlayer(p, forward(0, BTN.JUMP), flatCtx);
    expect(p.vx).toBeLessThan(5);
    expect(p.vz).toBe(0);
    expect(p.grounded).toBe(true);

    const air = spawnPlayer(flat);
    air.vx = 5;
    air.vy = 3;
    air.grounded = false;
    air.stunTicks = 9;
    stepPlayer(air, forward(), flatCtx);
    expect(air.vx).toBe(5);
    expect(air.vz).toBe(0);
  });

  it("crawls while downed with no actions but look", () => {
    const p = holding(spawnPlayer(flat), "coconut");
    p.downed = true;
    const results = runPlayer(p, flatCtx, 30, cmd({ moveZ: 1, yaw: 0.5, buttons: BTN.THROW | BTN.JUMP | BTN.EAT | BTN.CATCH }));
    results.push(stepPlayer(p, cmd({ moveZ: 1, yaw: 0.5, buttons: BTN.INTERACT_PRESS | BTN.DROP | BTN.USE_PRESS }), flatCtx));
    expect(results.every((r) => !r.jumped && !r.eat && !r.catchStarted && !r.interactPressed && !r.used && r.throw === null)).toBe(true);
    expect(p.chargeTicks).toBe(0);
    expect(p.yaw).toBe(0.5);
    expect(horizontalSpeed(p)).toBeCloseTo(WALK_SPEED * DOWNED_MOVE_MULT, 9);
  });

  it("doesn't move at all while boarded", () => {
    const p = holding(spawnPlayer(flat, 3, 4), "coconut");
    p.boarded = true;
    p.vx = 4;
    const results = runPlayer(p, flatCtx, 20, cmd({ moveZ: 1, yaw: -1, pitch: 0.3, buttons: BTN.JUMP | BTN.THROW | BTN.INTERACT_PRESS }));
    expect(p).toMatchObject({ x: 3, y: 1, z: 4, vx: 0, vy: 0, vz: 0, yaw: -1, pitch: 0.3, chargeTicks: 0 });
    expect(results.every((r) => !r.jumped && !r.interactPressed && r.throw === null)).toBe(true);
  });
});

describe("determinism", () => {
  type Script = InputCmd[];

  function randomScript(seed: number, ticks: number): Script {
    const rand = lcg(seed);
    const edges = [BTN.JUMP, BTN.CATCH, BTN.DROP, BTN.EAT, BTN.INTERACT_PRESS, BTN.USE_PRESS, BTN.SLOT_NEXT, BTN.SLOT1, BTN.SLOT2];
    let yaw = rand() * 6;
    let throwHeld = false;
    let sprint = false;
    const script: Script = [];
    for (let t = 0; t < ticks; t++) {
      yaw += (rand() - 0.5) * 0.5;
      if (rand() < 0.08) throwHeld = !throwHeld;
      if (rand() < 0.05) sprint = !sprint;
      let buttons = (throwHeld ? BTN.THROW : 0) | (sprint ? BTN.SPRINT : 0) | (rand() < 0.1 ? BTN.INTERACT : 0);
      for (const bit of edges) if (rand() < 0.03) buttons |= bit;
      script.push(
        cmd({
          seq: t + 1,
          moveX: Math.round((rand() * 2 - 1) * 4) / 4,
          moveZ: rand() < 0.7 ? 1 : Math.round((rand() * 2 - 1) * 4) / 4,
          yaw,
          pitch: (rand() - 0.5) * 2,
          buttons,
        }),
      );
    }
    return script;
  }

  const worlds: Array<{ name: string; island: IslandDef; start: [number, number] }> = (() => {
    const cliff = cliffIsland();
    const pool = poolIsland();
    const rocky = flatIsland(1);
    const withCover = flatIsland(1, [
      node(rocky.grid, "tree", 1, -2),
      node(rocky.grid, "palm", -2, 1),
      node(rocky.grid, "rock", 3, 3, { height: 0.4 }),
      node(rocky.grid, "rock", -3, -3, { radius: 1, height: 1.2 }),
    ]);
    return [
      { name: "cliff", island: cliff, start: [CLIFF.cliffX - 1, 0] },
      { name: "pool", island: pool, start: [POOL.beachX + 2, 0] },
      { name: "cover", island: withCover, start: [0, 0] },
    ];
  })();

  function freshPlayer(island: IslandDef, start: [number, number]): PlayerSim {
    const p = holding(spawnPlayer(island, start[0], start[1], 0.7), "coconut");
    p.inv1 = "rod";
    p.inv2 = "spear";
    return p;
  }

  it("gives identical results for the same inputs (every character, every island)", () => {
    for (const world of worlds) {
      for (const id of CHARACTER_IDS) {
        const script = randomScript(id.length * 7919 + world.name.length, 400);
        const ctxA = makeSimContext(world.island, id);
        const ctxB = makeSimContext(world.island, id);
        const a = freshPlayer(world.island, world.start);
        const b = freshPlayer(world.island, world.start);
        const ra = script.map((c) => stepPlayer(a, c, ctxA));
        const rb = script.map((c) => stepPlayer(b, c, ctxB));
        expect(b).toEqual(a);
        expect(rb).toEqual(ra);
        expect(Number.isFinite(a.x + a.y + a.z + a.vx + a.vy + a.vz)).toBe(true);
      }
    }
  });

  it("replays from a mid-run snapshot exactly, regardless of other sims stepped in between", () => {
    for (const world of worlds) {
      const ctx = makeSimContext(world.island, "gelin");
      const script = randomScript(1234 + world.name.length, 300);
      const p = freshPlayer(world.island, world.start);
      let snapshot: PlayerSim | null = null;
      script.forEach((c, t) => {
        if (t === 120) snapshot = copyPlayerSim(p, createPlayerSim());
        stepPlayer(p, c, ctx);
      });

      const replay = copyPlayerSim(snapshot!, createPlayerSim());
      const other = worlds[(worlds.indexOf(world) + 1) % worlds.length]!;
      const noise = freshPlayer(other.island, other.start);
      const noiseCtx = makeSimContext(other.island, "cocuk");
      const noiseScript = randomScript(99, 300);
      const out = emptyStepResult();
      for (let t = 120; t < 300; t++) {
        stepPlayer(noise, noiseScript[t]!, noiseCtx);
        stepPlayerInto(replay, script[t]!, ctx, out);
      }
      expect(replay).toEqual(p);
    }
  });

  it("keeps the capsule out of cover, above the terrain and finite through random play", () => {
    const world = worlds[2]!;
    const ctx = makeSimContext(world.island);
    const circles = (ctx.cover as ReturnType<typeof buildCover>).all();
    const rand = lcg(42);
    for (let run = 0; run < 6; run++) {
      const p = freshPlayer(world.island, [(rand() - 0.5) * 6, (rand() - 0.5) * 6]);
      for (const c of randomScript(Math.floor(rand() * 1e6), 300)) {
        stepPlayer(p, c, ctx);
        expect(Number.isFinite(p.x + p.y + p.z)).toBe(true);
        expect(p.y).toBeGreaterThanOrEqual(heightAt(world.island.grid, p.x, p.z) - 1e-9);
        for (const circle of circles) {
          if (circle.top > p.y + 0.5 + 1e-6) {
            expect(Math.hypot(p.x - circle.x, p.z - circle.z)).toBeGreaterThan(circle.r + radiusOf("kaptan") - 1e-3);
          }
        }
      }
    }
  });

  it("ends every random tick with consistent water flags", () => {
    const world = worlds[1]!;
    const ctx = makeSimContext(world.island);
    const p = freshPlayer(world.island, world.start);
    let swimming = p.swimming;
    for (const c of randomScript(5, 600)) {
      const r = stepPlayer(p, c, ctx);
      expect(p.swimming).toBe(p.y < WATER_Y - SWIM_DEPTH);
      expect(r.enteredWater).toBe(!swimming && p.swimming);
      expect(r.leftWater).toBe(swimming && !p.swimming);
      if (r.landed) expect(r.landSpeed).toBeGreaterThanOrEqual(0);
      swimming = p.swimming;
    }
  });
});
