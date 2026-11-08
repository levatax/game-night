// PlayerEffects physics feedback (tumble bounces, turn skids, tumble ribbons, off-island warning)
// against fake dependencies (node environment, no WebGL). Owner: client-app.

import { describe, expect, it } from "vitest";
import { getArena } from "../../../shared/maps";
import { createPlayerSim } from "../../../shared/sim/player";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Characters } from "../characters/Characters";
import type { Fx } from "../fx/Fx";
import type { PlayerFrame } from "../net/types";
import { PlayerEffects } from "./PlayerEffects";

function frame(id: string, isLocal: boolean, patch: Partial<PlayerFrame> = {}): PlayerFrame {
  return {
    ...createPlayerSim(),
    id,
    isLocal,
    character: "quacky",
    slot: 0,
    nickname: id,
    hearts: 3,
    connected: true,
    spectator: false,
    alive: true,
    grounded: true,
    ...patch,
  };
}

function setup(withFloor = true) {
  const sounds: Array<{ id: string; volume?: number; pitch?: number }> = [];
  const bursts: string[] = [];
  const pops: string[] = [];
  const feeds: Array<{ id: string; danger: boolean }> = [];
  const shakes: number[] = [];
  const fx = {
    balls: { setChargeGlow() {} },
    particles: {
      burst(kind: string) {
        bursts.push(kind);
      },
      emit(key: string) {
        bursts.push(`emit:${key}`);
      },
    },
    popText: {
      show(kind: string) {
        pops.push(kind);
      },
    },
    trails: {
      feed(id: string, _x: number, _y: number, _z: number, _c: string, _i: number, danger: boolean) {
        feeds.push({ id, danger });
      },
    },
  };
  const audio = {
    play(id: string, opts?: { volume?: number; pitch?: number }) {
      sounds.push({ id, volume: opts?.volume, pitch: opts?.pitch });
    },
    startLoop: () => ({ setParam() {}, setPosition() {}, stop() {} }),
  };
  const characters = { trigger() {}, getHandPosition: () => false };
  const arena = getArena("picnic");
  const floor = { arena, rings: arena.ringRadii.map(() => 0) };
  const effects = new PlayerEffects({
    characters: characters as unknown as Characters,
    fx: fx as unknown as Fx,
    audio: audio as unknown as AudioEngine,
    colorOf: () => "#FF8800",
    shake: (i) => shakes.push(i),
    floor: withFloor ? () => floor : undefined,
  });
  return { effects, sounds, bursts, pops, feeds, shakes };
}

describe("PlayerEffects physics feedback", () => {
  it("plays a remote tumble bounce once per knockBounces change, never for the local player", () => {
    const t = setup();
    t.effects.update([frame("foe", false, { knockBounces: 3 }), frame("me", true, { knockBounces: 7 })], 1 / 60);
    expect(t.sounds).toHaveLength(0);
    t.effects.update([frame("foe", false, { knockBounces: 4, vy: 4.2, grounded: false }), frame("me", true, { knockBounces: 8, grounded: false })], 1 / 60);
    const bounces = t.sounds.filter((s) => s.id === "bounce");
    expect(bounces).toHaveLength(1);
    // 4.2 / 0.42 = 10 m/s impact → 0.5 + 0.5 · 10/12.
    expect(bounces[0].volume).toBeCloseTo(0.5 + 0.5 * (10 / 12), 6);
    expect(t.bursts).toContain("stars");
    // Wrapping counter: 255 → 0 is still a change.
    t.effects.update([frame("foe", false, { knockBounces: 255, grounded: false })], 1 / 60);
    t.effects.update([frame("foe", false, { knockBounces: 0, grounded: false })], 1 / 60);
    expect(t.sounds.filter((s) => s.id === "bounce")).toHaveLength(3);
  });

  it("local bounces come from onBounce (prediction), with impact-scaled volume", () => {
    const t = setup();
    t.effects.update([frame("me", true)], 1 / 60);
    t.effects.onBounce("me", 12);
    expect(t.sounds.at(-1)).toMatchObject({ id: "bounce", volume: 1 });
  });

  it("turn skid: squeak on the remote rising edge, dust trail while skidding", () => {
    const t = setup();
    t.effects.update([frame("foe", false)], 1 / 60);
    t.effects.update([frame("foe", false, { skid: true, vx: 0, vz: 5 })], 1 / 60);
    t.effects.update([frame("foe", false, { skid: true, vx: 0, vz: 3 })], 1 / 60);
    const squeaks = t.sounds.filter((s) => s.id === "land");
    expect(squeaks).toHaveLength(1);
    expect(squeaks[0]).toMatchObject({ volume: 0.35, pitch: 1.4 });
    expect(t.bursts.filter((b) => b === "emit:skid:foe")).toHaveLength(2);
  });

  it("warns once per launch when the tumble lands off the island, with a red ribbon", () => {
    const t = setup();
    const arena = getArena("picnic");
    const edge = arena.ringRadii[arena.ringRadii.length - 1];
    // Just inside the edge, flying outward fast and stunned.
    const launched = frame("me", true, { x: edge - 0.5, y: 0.5, vx: 14, vy: 4, grounded: false, stunTicks: 30 });
    t.effects.update([frame("me", true, { x: edge - 0.5 })], 1 / 60);
    t.effects.update([launched], 1 / 60);
    t.effects.update([{ ...launched, x: edge - 0.2 }], 1 / 60);
    expect(t.pops).toEqual(["out"]);
    expect(t.shakes).toEqual([0.2]);
    expect(t.feeds.length).toBe(2);
    expect(t.feeds.every((f) => f.danger)).toBe(true);
  });

  it("a launch toward the center is safe: ribbon without warning", () => {
    const t = setup();
    t.effects.update([frame("foe", false)], 1 / 60);
    t.effects.update([frame("foe", false, { x: -2, y: 0.5, vx: 8, vy: 4, grounded: false, stunTicks: 20 })], 1 / 60);
    expect(t.pops).toEqual([]);
    expect(t.feeds).toEqual([{ id: "foe", danger: false }]);
  });
});
