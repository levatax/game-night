import { describe, expect, it } from "vitest";
import {
  BELLY_BOUNCE_TICKS,
  BELLY_SLIDE_SPEED,
  BELLY_SLIDE_TICKS,
  BELLY_SLIDE_TURN_RATE,
  CATCH_WINDOW_TICKS,
  CHARACTERS,
  CHARACTER_IDS,
  CHARGE_FULL_TICKS,
  DT,
  FLAP_DASH_END_SPEED,
  FLAP_DASH_END_VY,
  FLAP_DASH_TICKS,
  GROUND_POUND_SLAM_VY,
  HEADBUTT_TICKS,
  JUMP_HEIGHT,
  JUMP_VELOCITY,
  KNOCKBACK_STUN_TICKS,
  MAX_HEARTS,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RING_OUT_Y,
  ROLL_COOLDOWN_TICKS,
  ROLL_IFRAME_TICKS,
  ROLL_TICKS,
  SLIDE_HEIGHT,
  THROW_RECOVER_TICKS,
  WHIFF_TICKS,
  ZOOMIES_TICKS,
} from "../constants.js";
import { getArena, type CoverCylinder } from "../maps.js";
import { BTN } from "../protocol.js";
import type { CharacterId } from "../types.js";
import { pointInCover } from "./geometry.js";
import {
  copyPlayerSim,
  createPlayerSim,
  emptyStepResult,
  hasRollIFrames,
  isBouncy,
  isInvulnerable,
  playerHeight,
  stepPlayer,
  stepPlayerInto,
  type PlayerSim,
} from "./player.js";
import { throwOrigin } from "./throw.js";
import { cmd, horizontalSpeed, lcg, openArena, runPlayer, simCtx, solidRings, spawnPlayer } from "./testkit.js";

const forward = cmd({ moveZ: 1 });

function lastOf<T>(list: T[]): T {
  return list[list.length - 1];
}

describe("basics", () => {
  it("does nothing for dead players", () => {
    const p = createPlayerSim();
    const before = { ...p };
    const r = stepPlayer(p, cmd({ moveZ: 1, yaw: 1, buttons: BTN.JUMP }), simCtx("quacky"));
    expect(p).toEqual(before);
    expect(r).toEqual(emptyStepResult());
  });

  it("applies look every tick, wrapping yaw and clamping pitch", () => {
    const p = spawnPlayer();
    stepPlayer(p, cmd({ yaw: 3 * Math.PI, pitch: 5 }), simCtx("quacky"));
    expect(p.yaw).toBeCloseTo(Math.PI, 12);
    expect(p.pitch).toBe(1.2);
    stepPlayer(p, cmd({ yaw: Number.NaN, pitch: -Infinity }), simCtx("quacky"));
    expect(p.yaw).toBeCloseTo(Math.PI, 12);
    expect(p.pitch).toBe(1.2);
  });

  it("copies every sim field", () => {
    const src = spawnPlayer(1, 2, 0.5);
    src.powerUp = "mega";
    src.heldCount = 1;
    const dst = copyPlayerSim(src, createPlayerSim());
    expect(dst).toEqual(src);
  });

  it("reuses the result object in stepPlayerInto", () => {
    const out = emptyStepResult();
    const p = spawnPlayer();
    const r = stepPlayerInto(p, cmd({ buttons: BTN.JUMP }), simCtx("quacky"), out);
    expect(r).toBe(out);
    expect(out.jumped).toBe(true);
    stepPlayerInto(p, cmd(), simCtx("quacky"), out);
    expect(out.jumped).toBe(false);
  });
});

describe("walking", () => {
  it("reaches 6 m/s on flat ground along the camera forward", () => {
    const p = spawnPlayer();
    runPlayer(p, simCtx("quacky"), 30, forward);
    expect(horizontalSpeed(p)).toBeCloseTo(6, 9);
    expect(p.vz).toBeCloseTo(-6, 9);
    expect(p.y).toBe(0);
    expect(p.grounded).toBe(true);
  });

  it("is camera-relative and normalizes diagonals", () => {
    const p = spawnPlayer(0, 0, Math.PI / 2); // facing -X
    runPlayer(p, simCtx("quacky"), 30, cmd({ yaw: Math.PI / 2, moveX: 1, moveZ: 1 }));
    expect(horizontalSpeed(p)).toBeCloseTo(6, 9);
    // forward = -X, right = -Z → diagonal (-1, -1)/√2
    expect(p.vx).toBeCloseTo(-6 / Math.SQRT2, 9);
    expect(p.vz).toBeCloseTo(-6 / Math.SQRT2, 9);
  });

  it("slows to 3.6 m/s while charging", () => {
    const p = spawnPlayer();
    p.heldCount = 1;
    runPlayer(p, simCtx("quacky"), 25, cmd({ moveZ: 1, buttons: BTN.THROW }));
    expect(p.chargeTicks).toBe(25);
    expect(horizontalSpeed(p)).toBeCloseTo(3.6, 9);
  });

  it("runs 40% faster with zoomies", () => {
    const p = spawnPlayer();
    p.zoomiesTicks = ZOOMIES_TICKS;
    runPlayer(p, simCtx("quacky"), 30, forward);
    expect(horizontalSpeed(p)).toBeCloseTo(8.4, 9);
    expect(p.zoomiesTicks).toBe(ZOOMIES_TICKS - 30);
  });

  it("decelerates to a stop without input", () => {
    const p = spawnPlayer();
    runPlayer(p, simCtx("quacky"), 20, forward);
    const z0 = p.z;
    runPlayer(p, simCtx("quacky"), 20, cmd());
    expect(horizontalSpeed(p)).toBe(0);
    // Discrete coasting: v²/2a − v·dt/2 = 0.4 − 0.1 = 0.3 m
    expect(z0 - p.z).toBeCloseTo(0.3, 9);
  });

  it("slides much further on slippery Bath Time tiles", () => {
    const coast = (arenaId: "picnic" | "bath"): { ticksToFull: number; slide: number } => {
      const ctx = simCtx("quacky", openArena(arenaId));
      const p = spawnPlayer();
      let ticksToFull = 0;
      while (horizontalSpeed(p) < 6 - 1e-9) {
        stepPlayer(p, forward, ctx);
        ticksToFull++;
      }
      runPlayer(p, ctx, 30, forward);
      const z0 = p.z;
      runPlayer(p, ctx, 90, cmd());
      expect(horizontalSpeed(p)).toBe(0);
      return { ticksToFull, slide: z0 - p.z };
    };
    const grass = coast("picnic");
    const tiles = coast("bath");
    expect(grass.ticksToFull).toBe(3); // 60 m/s²
    expect(tiles.ticksToFull).toBe(9); // 22 m/s²
    expect(grass.slide).toBeCloseTo(0.3, 9); // 36 / (2·45) − 6·dt/2
    expect(tiles.slide).toBeGreaterThan(2.3); // 36 / (2·7) − 0.1 ≈ 2.47
    expect(tiles.slide).toBeLessThan(2.6);
  });

  it("has reduced air control", () => {
    const p = spawnPlayer();
    const results = runPlayer(p, simCtx("quacky"), 2, (t) => cmd({ buttons: t === 0 ? BTN.JUMP : 0 }));
    expect(results[0].jumped).toBe(true);
    stepPlayer(p, forward, simCtx("quacky"));
    // airborne: 60 · 0.45 · dt = 0.9 m/s per tick
    expect(horizontalSpeed(p)).toBeCloseTo(0.9, 9);
  });
});

describe("jumping and falling", () => {
  it("jumps 1.2 m high and lands", () => {
    const p = spawnPlayer();
    const ctx = simCtx("quacky");
    let apex = 0;
    const results = [];
    for (let t = 0; t < 40; t++) {
      results.push(stepPlayer(p, cmd({ buttons: t === 0 ? BTN.JUMP : 0 }), ctx));
      apex = Math.max(apex, p.y);
    }
    expect(results[0].jumped).toBe(true);
    expect(apex).toBeGreaterThan(JUMP_HEIGHT - 0.01);
    expect(apex).toBeLessThanOrEqual(JUMP_HEIGHT + 1e-9);
    const landing = results.findIndex((res) => res.landed);
    expect(landing).toBeGreaterThan(18); // ≈ 2·v/g = 0.69 s ≈ 21 ticks
    expect(landing).toBeLessThan(23);
    expect(results[landing].landSpeed).toBeCloseTo(JUMP_VELOCITY, 0);
    expect(p.y).toBe(0);
    expect(p.grounded).toBe(true);
  });

  it("can't double jump but allows a coyote jump just after walking off a ledge", () => {
    const p = spawnPlayer();
    const ctx = simCtx("quacky");
    stepPlayer(p, cmd({ buttons: BTN.JUMP }), ctx);
    const vy = p.vy;
    expect(stepPlayer(p, cmd({ buttons: BTN.JUMP }), ctx).jumped).toBe(false);
    expect(p.vy).toBeLessThan(vy);

    // Walk off the island edge (no floor beyond r = 15), then jump within the coyote window.
    const edge = spawnPlayer(14.9, 0, -Math.PI / 2); // facing +X
    edge.vx = 6;
    const lookX = cmd({ yaw: -Math.PI / 2, moveZ: 1 });
    let offTicks = 0;
    while (edge.grounded) {
      stepPlayer(edge, lookX, ctx);
      offTicks++;
      expect(offTicks).toBeLessThan(10);
    }
    stepPlayer(edge, lookX, ctx);
    expect(stepPlayer(edge, cmd({ yaw: -Math.PI / 2, moveZ: 1, buttons: BTN.JUMP }), ctx).jumped).toBe(true);
  });

  it("falls through a fallen ring and rings out below y = -6", () => {
    const arena = openArena();
    const rings = [0, 0, 0, 0, 2];
    const p = spawnPlayer(13.5, 0);
    const results = runPlayer(p, simCtx("quacky", arena, rings), 40, cmd());
    const out = results.findIndex((r) => r.fellOut);
    expect(out).toBeGreaterThan(20); // sqrt(2·6/20) = 0.77 s ≈ 23 ticks
    expect(out).toBeLessThan(30);
    expect(p.y).toBeLessThan(RING_OUT_Y);

    const safe = spawnPlayer(13.5, 0);
    runPlayer(safe, simCtx("quacky", arena, [0, 0, 0, 1, 0]), 40, cmd());
    expect(safe.y).toBe(0);
  });

  it("walks off the island edge and never snaps back up once below the top", () => {
    const p = spawnPlayer(14, 0, -Math.PI / 2);
    const results = runPlayer(p, simCtx("quacky"), 60, cmd({ yaw: -Math.PI / 2, moveZ: 1 }));
    expect(results.some((r) => r.fellOut)).toBe(true);

    const under = spawnPlayer(0, 0, 0, -0.5);
    under.grounded = false;
    runPlayer(under, simCtx("quacky"), 5, cmd());
    expect(under.y).toBeLessThan(-0.5);
    expect(under.grounded).toBe(false);
  });
});

describe("cover", () => {
  const picnic = getArena("picnic");
  const basket = picnic.cover[2] as CoverCylinder;

  it("blocks walking into cover", () => {
    const p = spawnPlayer(basket.x, 0); // walking -Z straight at the basket
    runPlayer(p, simCtx("quacky", picnic), 60, forward);
    expect(p.z).toBeCloseTo(basket.z + basket.radius + PLAYER_RADIUS, 6);
    expect(p.x).toBeCloseTo(basket.x, 6);
    expect(p.y).toBe(0);
  });

  it("slides along cover when walking at it diagonally", () => {
    const p = spawnPlayer(basket.x - 0.3, 0);
    runPlayer(p, simCtx("quacky", picnic), 60, forward);
    expect(p.z).toBeLessThan(basket.z); // went around
    expect(pointInCover(basket, p.x, p.z, PLAYER_RADIUS - 1e-6)).toBe(false);
  });

  it("blocks every cover piece from every direction", () => {
    for (const id of ["picnic", "bath", "cake"] as const) {
      const arena = getArena(id);
      const ctx = simCtx("quacky", arena);
      for (const c of arena.cover) {
        for (let k = 0; k < 8; k++) {
          const angle = (k / 8) * Math.PI * 2;
          const p = spawnPlayer(c.x + Math.sin(angle) * 3.5, c.z + Math.cos(angle) * 3.5, angle);
          runPlayer(p, ctx, 45, cmd({ yaw: angle, moveZ: 1 }));
          expect(pointInCover(c, p.x, p.z, PLAYER_RADIUS - 1e-3)).toBe(false);
        }
      }
    }
  });

  it("can be stood on", () => {
    const p = spawnPlayer(basket.x, basket.z, 0, 3);
    const results = runPlayer(p, simCtx("quacky", picnic), 30, cmd());
    expect(results.some((r) => r.landed)).toBe(true);
    expect(p.y).toBe(basket.height);
    expect(p.grounded).toBe(true);

    // Walking off the top drops back to the floor.
    runPlayer(p, simCtx("quacky", picnic), 40, cmd({ moveX: 1 }));
    expect(p.y).toBe(0);
  });

  it("can be jumped onto", () => {
    const p = spawnPlayer(basket.x, basket.z + 1.6);
    runPlayer(p, simCtx("quacky", picnic), 30, (t) => cmd({ moveZ: t < 10 ? 1 : 0, buttons: t === 0 ? BTN.JUMP : 0 }));
    expect(p.grounded).toBe(true);
    expect(p.y).toBe(basket.height);
  });

  it("lands on a cover top even when falling fast", () => {
    const p = spawnPlayer(basket.x, basket.z, 0, 8);
    p.vy = -30;
    runPlayer(p, simCtx("quacky", picnic), 10, cmd());
    expect(p.y).toBe(basket.height);
  });
});

describe("dodge roll", () => {
  it("covers 4 m with i-frames for the first 0.2 s, then hands over at walk speed", () => {
    const p = spawnPlayer();
    const ctx = simCtx("quacky");
    const first = stepPlayer(p, cmd({ moveX: 1, buttons: BTN.ROLL }), ctx);
    expect(first.rollStarted).toBe(true);
    let iframeTicks = hasRollIFrames(p) ? 1 : 0;
    for (let t = 1; t < ROLL_TICKS; t++) {
      stepPlayer(p, cmd({ moveX: 1 }), ctx);
      if (hasRollIFrames(p)) iframeTicks++;
    }
    expect(iframeTicks).toBe(ROLL_IFRAME_TICKS);
    expect(p.rollTicks).toBe(0);
    expect(p.x).toBeCloseTo(4, 9); // moveX = strafe right = +X at yaw 0
    expect(p.z).toBeCloseTo(0, 9);
    expect(horizontalSpeed(p)).toBeCloseTo(6, 9);

    runPlayer(p, ctx, 30, cmd());
    expect(p.x).toBeGreaterThan(4.3); // short coast out of the roll
    expect(p.x).toBeLessThan(4.5);
  });

  it("rolls forward without move input, keeps the ball and respects the cooldown", () => {
    const p = spawnPlayer();
    p.heldCount = 1;
    const ctx = simCtx("quacky");
    runPlayer(p, ctx, 10, cmd({ buttons: BTN.THROW }));
    expect(p.chargeTicks).toBe(10);
    stepPlayer(p, cmd({ buttons: BTN.ROLL | BTN.THROW }), ctx);
    expect(p.chargeTicks).toBe(0);
    expect(p.heldCount).toBe(1);
    expect(p.dirZ).toBeCloseTo(-1, 12);
    runPlayer(p, ctx, ROLL_TICKS, cmd());
    expect(stepPlayer(p, cmd({ buttons: BTN.ROLL }), ctx).rollStarted).toBe(false);
    runPlayer(p, ctx, ROLL_COOLDOWN_TICKS - ROLL_TICKS - 2, cmd());
    expect(stepPlayer(p, cmd({ buttons: BTN.ROLL }), ctx).rollStarted).toBe(true);
  });

  it("needs the ground", () => {
    const p = spawnPlayer();
    const ctx = simCtx("quacky");
    stepPlayer(p, cmd({ buttons: BTN.JUMP }), ctx);
    stepPlayer(p, cmd(), ctx);
    expect(stepPlayer(p, cmd({ buttons: BTN.ROLL }), ctx).rollStarted).toBe(false);
  });
});

describe("catch window", () => {
  it("opens for 0.25 s, then whiffs into a slow 0.6 s recovery", () => {
    const p = spawnPlayer();
    const ctx = simCtx("quacky");
    expect(stepPlayer(p, cmd({ buttons: BTN.CATCH }), ctx).catchStarted).toBe(true);
    expect(p.catchTicks).toBe(CATCH_WINDOW_TICKS);
    const results = runPlayer(p, ctx, CATCH_WINDOW_TICKS, cmd());
    expect(results.findIndex((r) => r.whiffStarted)).toBe(CATCH_WINDOW_TICKS - 1);
    expect(p.whiffTicks).toBe(WHIFF_TICKS);

    // Whiff: no jumping, slowed walking.
    expect(stepPlayer(p, cmd({ buttons: BTN.JUMP, moveZ: 1 }), ctx).jumped).toBe(false);
    runPlayer(p, ctx, 5, forward);
    expect(horizontalSpeed(p)).toBeCloseTo(6 * 0.35, 9);
    runPlayer(p, ctx, WHIFF_TICKS, forward);
    expect(p.whiffTicks).toBe(0);
    expect(horizontalSpeed(p)).toBeCloseTo(6, 9);
  });

  it("cancels a charge without throwing", () => {
    const p = spawnPlayer();
    p.heldCount = 1;
    const ctx = simCtx("quacky");
    runPlayer(p, ctx, 5, cmd({ buttons: BTN.THROW }));
    const r = stepPlayer(p, cmd({ buttons: BTN.CATCH }), ctx);
    expect(r.catchStarted).toBe(true);
    expect(r.throw).toBeNull();
    expect(p.chargeTicks).toBe(0);
    expect(p.heldCount).toBe(1);
  });
});

describe("charge and throw", () => {
  it("quick-throws on a 1-tick tap", () => {
    const p = spawnPlayer();
    p.heldCount = 1;
    const ctx = simCtx("quacky");
    expect(stepPlayer(p, cmd({ buttons: BTN.THROW }), ctx).throw).toBeNull();
    const r = stepPlayer(p, cmd({ yaw: 0.3, pitch: 0.2 }), ctx);
    expect(r.throw).not.toBeNull();
    expect(r.throw!.charge).toBeCloseTo(1 / CHARGE_FULL_TICKS, 12);
    expect(r.throw!.yaw).toBe(0.3);
    expect(r.throw!.pitch).toBe(0.2);
    expect(r.throw!.origin).toEqual(throwOrigin(p));
    expect(p.heldCount).toBe(0);
    expect(p.throwTicks).toBe(THROW_RECOVER_TICKS);
  });

  it("caps the charge at 1.0 s and consumes the power-up and curve", () => {
    const p = spawnPlayer();
    p.heldCount = 2;
    p.powerUp = "triple";
    p.curveArmed = true;
    const ctx = simCtx("whiskers");
    runPlayer(p, ctx, 45, cmd({ buttons: BTN.THROW }));
    expect(p.chargeTicks).toBe(CHARGE_FULL_TICKS);
    const r = stepPlayer(p, cmd(), ctx);
    expect(r.throw).toMatchObject({ charge: 1, powerUp: "triple", curve: true });
    expect(p.powerUp).toBe("");
    expect(p.curveArmed).toBe(false);
    expect(p.heldCount).toBe(1);

    // Recovery: holding THROW again doesn't charge until throwTicks runs out.
    runPlayer(p, ctx, THROW_RECOVER_TICKS - 1, cmd({ buttons: BTN.THROW }));
    expect(p.chargeTicks).toBe(0);
    stepPlayer(p, cmd({ buttons: BTN.THROW }), ctx);
    expect(p.chargeTicks).toBe(1);
  });

  it("doesn't charge without a ball", () => {
    const p = spawnPlayer();
    runPlayer(p, simCtx("quacky"), 10, cmd({ buttons: BTN.THROW }));
    expect(p.chargeTicks).toBe(0);
  });

  it("locked input applies look only and cancels a charge without throwing", () => {
    const p = spawnPlayer();
    p.heldCount = 1;
    runPlayer(p, simCtx("quacky"), 10, cmd({ buttons: BTN.THROW }));
    const locked = simCtx("quacky", openArena(), solidRings(openArena()), true);
    const r = stepPlayer(p, cmd({ yaw: 1, moveZ: 1, buttons: BTN.JUMP }), locked);
    expect(r.throw).toBeNull();
    expect(r.jumped).toBe(false);
    expect(p.chargeTicks).toBe(0);
    expect(p.heldCount).toBe(1);
    expect(p.yaw).toBe(1);
    expect(horizontalSpeed(p)).toBe(0);
  });
});

describe("knockback stun", () => {
  it("removes control and slides to a stop on the ground", () => {
    const p = spawnPlayer();
    p.vx = 6;
    p.stunTicks = KNOCKBACK_STUN_TICKS;
    const ctx = simCtx("quacky");
    const r = stepPlayer(p, cmd({ moveZ: 1, buttons: BTN.JUMP }), ctx);
    expect(r.jumped).toBe(false);
    expect(p.vx).toBeCloseTo(6 - 18 * DT, 9);
    expect(p.vz).toBe(0);
  });

  it("keeps the knockback arc in the air and cancels dashes", () => {
    const p = spawnPlayer();
    const ctx = simCtx("gruff");
    stepPlayer(p, cmd({ buttons: BTN.ABILITY }), ctx);
    expect(p.abilityTicks).toBeGreaterThan(0);
    p.vx = 9;
    p.vz = 0;
    p.vy = 4;
    p.grounded = false;
    p.stunTicks = KNOCKBACK_STUN_TICKS;
    stepPlayer(p, cmd(), ctx);
    expect(p.abilityTicks).toBe(0);
    expect(p.vx).toBe(9);
    expect(p.grounded).toBe(false);
  });
});

describe("abilities", () => {
  it("Quacky's Flap Dash covers 5 m and works mid-air without gravity", () => {
    const ctx = simCtx("quacky");
    const p = spawnPlayer();
    const r = stepPlayer(p, cmd({ buttons: BTN.ABILITY }), ctx);
    expect(r.abilityStarted).toBe(true);
    expect(p.abilityCooldown).toBe(CHARACTERS.quacky.ability.cooldownTicks);
    runPlayer(p, ctx, FLAP_DASH_TICKS - 1, cmd());
    expect(p.abilityTicks).toBe(0);
    expect(-p.z).toBeCloseTo(5, 9);
    expect(-p.vz).toBeCloseTo(FLAP_DASH_END_SPEED, 9);
    expect(p.vy).toBe(FLAP_DASH_END_VY);

    const air = spawnPlayer();
    runPlayer(air, ctx, 8, (t) => cmd({ buttons: t === 0 ? BTN.JUMP : 0 }));
    const y0 = air.y;
    const x0 = air.x;
    runPlayer(air, ctx, FLAP_DASH_TICKS, (t) => cmd({ moveX: 1, buttons: t === 0 ? BTN.ABILITY : 0 }));
    expect(air.y).toBeCloseTo(y0, 9);
    expect(air.x - x0).toBeCloseTo(5, 9);
  });

  it("Hopsworth's Ground Pound leaps then slams down", () => {
    const ctx = simCtx("hopsworth");
    const p = spawnPlayer();
    let apex = 0;
    let slamTick = -1;
    let slamSpeed = 0;
    for (let t = 0; t < 40; t++) {
      const r = stepPlayer(p, cmd({ buttons: t === 0 ? BTN.ABILITY : 0 }), ctx);
      apex = Math.max(apex, p.y);
      if (t === 0) expect(r.abilityStarted).toBe(true);
      if (r.slamLanded) {
        expect(slamTick).toBe(-1);
        slamTick = t;
        slamSpeed = r.landSpeed;
      }
    }
    expect(apex).toBeGreaterThan(1.5);
    expect(apex).toBeLessThan(2.2);
    expect(slamTick).toBeGreaterThan(9);
    expect(slamTick).toBeLessThan(16);
    expect(slamSpeed).toBeCloseTo(-GROUND_POUND_SLAM_VY, 9);
    expect(p.abilityPhase).toBe(0);
    expect(p.abilityTicks).toBe(0);
    expect(p.grounded).toBe(true);
  });

  it("Mochi's Belly Bounce lasts 1.5 s and doesn't change movement", () => {
    const ctx = simCtx("mochi");
    const p = spawnPlayer();
    let bouncyTicks = 0;
    for (let t = 0; t < 60; t++) {
      stepPlayer(p, cmd({ moveZ: 1, buttons: t === 0 ? BTN.ABILITY : 0 }), ctx);
      if (isBouncy(p, "mochi")) bouncyTicks++;
      if (t === 0) expect(isBouncy(p, "quacky")).toBe(false);
      if (t === 29) expect(horizontalSpeed(p)).toBeCloseTo(6, 9);
    }
    expect(bouncyTicks).toBe(BELLY_BOUNCE_TICKS);
    expect(isBouncy(p, "mochi")).toBe(false);
    // Can still jump and charge during the bounce.
    const q = spawnPlayer();
    q.heldCount = 1;
    stepPlayer(q, cmd({ buttons: BTN.ABILITY }), ctx);
    expect(stepPlayer(q, cmd({ buttons: BTN.JUMP | BTN.THROW }), ctx).jumped).toBe(true);
    expect(q.chargeTicks).toBe(1);
  });

  it("Whiskers' Curveball arms the next throw", () => {
    const ctx = simCtx("whiskers");
    const p = spawnPlayer();
    p.heldCount = 1;
    expect(stepPlayer(p, cmd({ buttons: BTN.ABILITY }), ctx).abilityStarted).toBe(true);
    expect(p.curveArmed).toBe(true);
    expect(p.abilityTicks).toBe(0);
    runPlayer(p, ctx, 3, cmd({ buttons: BTN.THROW }));
    const r = stepPlayer(p, cmd(), ctx);
    expect(r.throw?.curve).toBe(true);
    expect(p.curveArmed).toBe(false);
  });

  it("Pip's Belly Slide is a fast low 2 s slide that steers toward the camera", () => {
    const ctx = simCtx("pip");
    const p = spawnPlayer(0, 9);
    p.heldCount = 1;
    runPlayer(p, ctx, 3, cmd({ buttons: BTN.THROW }));
    expect(stepPlayer(p, cmd({ buttons: BTN.ABILITY | BTN.THROW }), ctx).abilityStarted).toBe(true);
    expect(p.chargeTicks).toBe(0);
    expect(playerHeight(p, "pip")).toBe(SLIDE_HEIGHT);
    expect(horizontalSpeed(p)).toBeCloseTo(BELLY_SLIDE_SPEED, 9);
    runPlayer(p, ctx, BELLY_SLIDE_TICKS - 1, cmd({ buttons: BTN.THROW }));
    expect(p.abilityTicks).toBe(0);
    expect(p.chargeTicks).toBe(0); // no charging while sliding
    expect(9 - p.z).toBeCloseTo(BELLY_SLIDE_SPEED * BELLY_SLIDE_TICKS * DT, 6); // 20 m
    expect(playerHeight(p, "pip")).toBe(PLAYER_HEIGHT);
    expect(horizontalSpeed(p)).toBeCloseTo(6, 9);

    const turn = spawnPlayer();
    stepPlayer(turn, cmd({ buttons: BTN.ABILITY }), ctx);
    const before = Math.atan2(-turn.dirX, -turn.dirZ);
    stepPlayer(turn, cmd({ yaw: Math.PI / 2 }), ctx);
    const after = Math.atan2(-turn.dirX, -turn.dirZ);
    expect(after - before).toBeCloseTo(BELLY_SLIDE_TURN_RATE * DT, 9);
  });

  it("Pip can't start a slide in the air and stops sliding off a ledge", () => {
    const ctx = simCtx("pip");
    const air = spawnPlayer();
    stepPlayer(air, cmd({ buttons: BTN.JUMP }), ctx);
    const r = stepPlayer(air, cmd({ buttons: BTN.ABILITY }), ctx);
    expect(r.abilityStarted).toBe(false);
    expect(air.abilityCooldown).toBe(0);

    const edge = spawnPlayer(13, 0, -Math.PI / 2); // slide toward +X off the edge
    stepPlayer(edge, cmd({ yaw: -Math.PI / 2, buttons: BTN.ABILITY }), ctx);
    runPlayer(edge, ctx, 20, cmd({ yaw: -Math.PI / 2 }));
    expect(edge.grounded).toBe(false);
    expect(edge.abilityTicks).toBe(0);
  });

  it("Gruff's Headbutt lunges 3 m forward", () => {
    const ctx = simCtx("gruff");
    const p = spawnPlayer(0, 0, Math.PI); // facing +Z
    stepPlayer(p, cmd({ yaw: Math.PI, buttons: BTN.ABILITY }), ctx);
    runPlayer(p, ctx, HEADBUTT_TICKS - 1, cmd({ yaw: Math.PI }));
    expect(p.abilityTicks).toBe(0);
    expect(p.z).toBeCloseTo(3, 9);
    expect(horizontalSpeed(p)).toBeCloseTo(6, 9);
  });

  it("respects ability cooldowns for every character", () => {
    for (const id of CHARACTER_IDS) {
      const ctx = simCtx(id);
      const p = spawnPlayer(0, 9); // room for Pip's 20 m slide toward -Z
      expect(stepPlayer(p, cmd({ buttons: BTN.ABILITY }), ctx).abilityStarted, id).toBe(true);
      runPlayer(p, ctx, 60, cmd());
      expect(stepPlayer(p, cmd({ buttons: BTN.ABILITY }), ctx).abilityStarted, id).toBe(false);
      runPlayer(p, ctx, CHARACTERS[id].ability.cooldownTicks, cmd());
      expect(p.grounded, id).toBe(true);
      expect(stepPlayer(p, cmd({ buttons: BTN.ABILITY }), ctx).abilityStarted, id).toBe(true);
    }
  });
});

describe("invulnerability helpers", () => {
  it("combines roll i-frames and hurt mercy", () => {
    const p = spawnPlayer();
    expect(isInvulnerable(p)).toBe(false);
    p.hurtTicks = 3;
    expect(isInvulnerable(p)).toBe(true);
    p.hurtTicks = 0;
    p.rollTicks = ROLL_TICKS - 1;
    expect(isInvulnerable(p)).toBe(true);
    p.rollTicks = 1;
    expect(isInvulnerable(p)).toBe(false);
  });
});

describe("determinism", () => {
  type Script = Array<ReturnType<typeof cmd>>;

  function randomScript(seed: number, ticks: number): Script {
    const rand = lcg(seed);
    const bits = [BTN.THROW, BTN.CATCH, BTN.JUMP, BTN.ROLL, BTN.ABILITY];
    let yaw = 0;
    let throwHeld = false;
    const script: Script = [];
    for (let t = 0; t < ticks; t++) {
      yaw += (rand() - 0.5) * 0.4;
      if (rand() < 0.08) throwHeld = !throwHeld;
      let buttons = throwHeld ? BTN.THROW : 0;
      for (const bit of bits.slice(1)) if (rand() < 0.03) buttons |= bit;
      script.push(
        cmd({
          seq: t + 1,
          moveX: Math.round((rand() * 2 - 1) * 4) / 4,
          moveZ: Math.round((rand() * 2 - 1) * 4) / 4,
          yaw,
          pitch: (rand() - 0.5) * 1.6,
          buttons,
        }),
      );
    }
    return script;
  }

  function freshPlayer(): PlayerSim {
    const p = spawnPlayer(-7.5, 7.5, 2.3);
    p.heldCount = 1;
    p.powerUp = "boomerang";
    p.hurtTicks = MAX_HEARTS;
    return p;
  }

  it("gives bit-identical results for the same inputs (every character, every map)", () => {
    for (const mapId of ["picnic", "bath", "cake"] as const) {
      for (const id of CHARACTER_IDS) {
        const arena = getArena(mapId);
        const script = randomScript(id.length * 7919 + mapId.length, 300);
        const a = freshPlayer();
        const b = freshPlayer();
        const ra = script.map((c) => stepPlayer(a, c, simCtx(id, arena)));
        const rb = script.map((c) => stepPlayer(b, c, simCtx(id, arena)));
        expect(b).toStrictEqual(a);
        expect(rb).toStrictEqual(ra);
      }
    }
  });

  it("replays from a mid-run snapshot exactly, regardless of other sims stepped in between", () => {
    const arena = getArena("picnic");
    for (const id of CHARACTER_IDS) {
      const script = randomScript(1234 + id.length, 300);
      const p = freshPlayer();
      let snapshot: PlayerSim | null = null;
      script.forEach((c, t) => {
        if (t === 120) snapshot = copyPlayerSim(p, createPlayerSim());
        stepPlayer(p, c, simCtx(id, arena));
      });

      const replay = copyPlayerSim(snapshot!, createPlayerSim());
      const noise = freshPlayer();
      const noiseScript = randomScript(99, 300);
      for (let t = 120; t < 300; t++) {
        stepPlayer(noise, noiseScript[t], simCtx("hopsworth", getArena("bath")));
        stepPlayerInto(replay, script[t], simCtx(id, arena), emptyStepResult());
      }
      expect(replay).toStrictEqual(p);
    }
  });

  it("keeps the player out of cover and finite through random play", () => {
    const rand = lcg(42);
    for (const mapId of ["picnic", "bath", "cake"] as const) {
      const arena = getArena(mapId);
      for (const id of CHARACTER_IDS) {
        const p = spawnPlayer((rand() - 0.5) * 8, (rand() - 0.5) * 8, 0);
        p.heldCount = 1;
        for (const c of randomScript(Math.floor(rand() * 1e6), 300)) {
          stepPlayer(p, c, simCtx(id as CharacterId, arena));
          expect(Number.isFinite(p.x + p.y + p.z + p.vx + p.vy + p.vz)).toBe(true);
          if (p.y < -1) break;
          for (const cover of arena.cover) {
            if (p.y + 0.3 < cover.height && p.y > -1) {
              expect(pointInCover(cover, p.x, p.z, PLAYER_RADIUS - 1e-3)).toBe(false);
            }
          }
        }
      }
    }
  });
});
