// Spectator camera (ARCHITECTURE §2.17): the camp orbit by default, steered by the free look, a click / Space
// follows the next teammate (by seat, back to the camp after the last), a vanished teammate hands over to the
// nearest one. Owner: client-app.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { NORMAL_TIMINGS } from "../../../shared/constants";
import { heightAt } from "../../../shared/island/heightfield";
import type { PlayerView } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import { FpCamera } from "../render/FpCamera";
import { CameraDirector, followableMates, nearestMate, stepFollow, type CameraInputs } from "./cinematics";
import { fakePlayer, fakeState, testIsland } from "./testkit";

function frameOf(view: PlayerView, over: Partial<PlayerFrame> = {}): PlayerFrame {
  return { ...view, isLocal: false, speed: 0, ...over };
}

describe("spectator follow helpers", () => {
  it("steps around the ring camp → teammates by seat → camp, both ways", () => {
    const ids = ["a", "b"];
    expect(stepFollow(null, ids, 1)).toBe("a");
    expect(stepFollow("a", ids, 1)).toBe("b");
    expect(stepFollow("b", ids, 1)).toBeNull();
    expect(stepFollow(null, ids, -1)).toBe("b");
    expect(stepFollow("a", ids, -1)).toBeNull();
    expect(stepFollow("gone", ids, 1)).toBe("a");
    expect(stepFollow(null, [], 1)).toBeNull();
  });

  it("follows teammates still in the match, by seat; picks the nearest one", () => {
    const remotes = [
      frameOf(fakePlayer("c", 30, 0, { seat: 3 })),
      frameOf(fakePlayer("a", 10, 0, { seat: 1 })),
      frameOf(fakePlayer("w", 0, 0, { seat: 2, washed: true, alive: false })),
      frameOf(fakePlayer("x", 0, 0, { seat: 4, team: 1 })),
    ];
    expect(followableMates(remotes, 0)).toEqual(["a", "c"]);
    expect(nearestMate(remotes, ["a", "c"], { x: 25, y: 0, z: 0 })?.id).toBe("c");
    expect(nearestMate(remotes, [], { x: 0, y: 0, z: 0 })).toBeNull();
  });
});

describe("CameraDirector spectating", () => {
  function rig() {
    const island = testIsland();
    const me = fakePlayer("me", 0, 0, { alive: false, washed: true, seat: 0 });
    const a = fakePlayer("a", 12, 4, { seat: 1 });
    const b = fakePlayer("b", -10, -6, { seat: 2 });
    const remotes = [frameOf(a), frameOf(b)];
    const cam = new THREE.PerspectiveCamera();
    const director = new CameraDirector(new FpCamera(cam));
    const freeLook = { yaw: 0, pitch: 0, cycle: 0 };
    const inputs: CameraInputs = {
      phase: "playing",
      state: fakeState([me, a, b], {}, island),
      me,
      local: null,
      look: { yaw: 0, pitch: 0 },
      island,
      timings: NORMAL_TIMINGS,
      raft: null,
      fov: 75,
      headBob: true,
      realDt: 1 / 60,
      nowMs: 0,
      remotes,
      freeLook,
    };
    const run = (sec: number): void => {
      for (let t = 0; t < sec; t += 1 / 60) {
        inputs.nowMs += 1000 / 60;
        director.update(inputs);
        freeLook.yaw = 0;
        freeLook.pitch = 0;
        freeLook.cycle = 0;
      }
    };
    const camp = island.sites[0]!.campfire;
    const campCenter = new THREE.Vector3(camp.x, Math.max(0, heightAt(island.grid, camp.x, camp.z)), camp.z);
    return { cam, director, freeLook, inputs, remotes, run, campCenter };
  }

  it("orbits the camp by default, follows teammates on a click and comes back after the last", () => {
    const r = rig();
    r.run(4);
    expect(r.director.mode).toBe("spectate");
    expect(r.director.following).toBeNull();
    expect(r.cam.position.distanceTo(r.campCenter)).toBeCloseTo(Math.hypot(16, 10), 0);

    r.freeLook.cycle = 1;
    r.run(5);
    expect(r.director.following).toBe("a");
    const a = r.remotes[0]!;
    expect(r.cam.position.distanceTo(new THREE.Vector3(a.x, a.y + 1.4, a.z))).toBeLessThan(10);

    r.freeLook.cycle = 1;
    r.run(0.1);
    expect(r.director.following).toBe("b");
    r.freeLook.cycle = 1;
    r.run(5);
    expect(r.director.following).toBeNull();
    expect(r.cam.position.distanceTo(r.campCenter)).toBeCloseTo(Math.hypot(16, 10), 0);
  });

  it("hands over to the nearest teammate when the followed one is washed ashore", () => {
    const r = rig();
    r.freeLook.cycle = -1; // RMB from the camp: the last seat
    r.run(3);
    expect(r.director.following).toBe("b");
    r.remotes[1] = { ...r.remotes[1]!, washed: true, alive: false };
    r.run(0.1);
    expect(r.director.following).toBe("a");
    r.remotes.length = 0;
    r.run(0.1);
    expect(r.director.following).toBeNull();
  });

  it("free look turns the orbit like mouse look", () => {
    const r = rig();
    r.run(4);
    const before = Math.atan2(r.cam.position.x - r.campCenter.x, r.cam.position.z - r.campCenter.z);
    r.freeLook.yaw = -0.5;
    r.run(1 / 60);
    const after = Math.atan2(r.cam.position.x - r.campCenter.x, r.cam.position.z - r.campCenter.z);
    expect(after - before).toBeCloseTo(-0.5, 1);
  });

  it("keeps the lens above the ground when steered low beside higher land", () => {
    const r = rig();
    // A pit around teammate "a" (12, 4) in a 4 m plateau.
    const island = testIsland({ height: 4 });
    const n = Math.round(Math.sqrt(island.grid.heights.length));
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (Math.hypot(-24 + col - 12, -24 + row - 4) <= 3) island.grid.heights[row * n + col] = 0;
      }
    }
    r.inputs.island = island;
    r.remotes[0] = { ...r.remotes[0]!, y: 0 };
    r.freeLook.cycle = 1;
    r.run(4);
    r.freeLook.pitch = 10; // look all the way up: the orbit drops to its lowest
    r.run(1);
    expect(r.director.following).toBe("a");
    expect(r.cam.position.y).toBeGreaterThanOrEqual(heightAt(island.grid, r.cam.position.x, r.cam.position.z) + 0.8 - 1e-6);
    expect(r.cam.position.y).toBeGreaterThan(4);
  });

  it("every new spell of spectating starts back over the camp", () => {
    const r = rig();
    r.freeLook.cycle = 1;
    r.run(1);
    expect(r.director.following).toBe("a");
    // Respawn (first person), then washed again.
    const me = r.inputs.me!;
    r.inputs.me = { ...me, alive: true, washed: false };
    r.inputs.local = frameOf(r.inputs.me, { isLocal: true });
    r.run(0.2);
    expect(r.director.mode).toBe("fp");
    expect(r.director.following).toBeNull();
    r.inputs.me = me;
    r.inputs.local = null;
    r.run(0.2);
    expect(r.director.mode).toBe("spectate");
    expect(r.director.following).toBeNull();
  });
});
