import { describe, expect, it } from "vitest";
import { BTN } from "../protocol.js";
import { predictTumbleLanding } from "./landing.js";
import { createMotionCues, readMotionCues } from "./motion.js";
import { vec3 } from "./math.js";
import { copyPlayerSim, createPlayerSim, stepPlayer } from "./player.js";
import { cmd, simCtx, spawnPlayer } from "./testkit.js";

describe("predictTumbleLanding", () => {
  it("predicts where a launch comes down without touching the player", () => {
    const p = spawnPlayer(0, 0);
    p.vz = -6;
    p.vy = 4;
    p.grounded = false;
    p.stunTicks = 20;
    const before = copyPlayerSim(p, createPlayerSim());
    const out = vec3();
    const ticks = predictTumbleLanding(p, simCtx("quacky"), 45, out);
    expect(p).toEqual(before);
    expect(ticks).toBeGreaterThan(5);
    expect(ticks).toBeLessThan(45);
    expect(out.y).toBe(0);
    expect(out.z).toBeLessThan(-2);

    // Same as really stepping it with no input.
    const real = copyPlayerSim(p, createPlayerSim());
    for (let i = 0; i < ticks; i++) stepPlayer(real, cmd(), simCtx("quacky"));
    expect(real.z).toBeCloseTo(out.z, 12);
  });

  it("returns -1 for a launch off the island and maxTicks when still flying", () => {
    const p = spawnPlayer(13, 0);
    p.vx = 15;
    p.vy = 6;
    p.grounded = false;
    p.stunTicks = 30;
    expect(predictTumbleLanding(p, simCtx("quacky"), 90, vec3())).toBe(-1);
    expect(predictTumbleLanding(p, simCtx("quacky"), 3, vec3())).toBe(3);
  });
});

describe("readMotionCues", () => {
  it("reads tumble, skid and jump phases", () => {
    const cues = createMotionCues();
    const p = spawnPlayer();
    const ctx = simCtx("quacky");
    stepPlayer(p, cmd({ buttons: BTN.JUMP | BTN.JUMP_HELD }), ctx);
    expect(readMotionCues(p, cues)).toMatchObject({ jumpRising: true, apexHang: false, fastFalling: false, tumbling: false });
    let hang = 0;
    let fast = 0;
    for (let i = 0; i < 30 && !p.grounded; i++) {
      stepPlayer(p, cmd({ buttons: BTN.JUMP_HELD }), ctx);
      readMotionCues(p, cues);
      if (cues.apexHang) hang++;
      if (cues.fastFalling) fast++;
      expect(cues.apexHang && cues.fastFalling).toBe(false);
    }
    expect(hang).toBeGreaterThanOrEqual(3);
    expect(fast).toBeGreaterThan(0);

    const k = spawnPlayer();
    k.stunTicks = 10;
    k.vx = 5;
    expect(readMotionCues(k, cues)).toMatchObject({ tumbling: false, knockSliding: true, speed: 5 });
    k.grounded = false;
    expect(readMotionCues(k, cues).tumbling).toBe(true);
  });
});
