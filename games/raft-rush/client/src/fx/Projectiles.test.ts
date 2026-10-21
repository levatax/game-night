// First-person throw hand-off: my own predicted throw is drawn leaving the first-person hand and eases onto its
// simulated path over HAND_OFF_SEC (render only); server projectiles and frames without a hand are never offset.
// Owner: client-fx-audio.

import * as THREE from "three";
import { describe, expect, it, vi } from "vitest";
import { emptyProjectileFrame } from "../net/ProjectileSync";
import type { ProjectileFrame } from "../net/types";
import type { Particles } from "./Particles";
import { HAND_OFF_SEC, ProjectileVisuals, handOffWeight } from "./Projectiles";
import type { BlobShadows } from "./Shadows";

// The pickup-halo batch's glow texture is drawn on a 2D canvas: no DOM under vitest.
vi.mock("./fxTextures", async (importOriginal) => {
  const three = await import("three");
  return { ...(await importOriginal<typeof import("./fxTextures")>()), glowTexture: () => new three.Texture() };
});

function visuals(): ProjectileVisuals {
  const particles = { emit: () => undefined } as unknown as Particles;
  const shadows = { add: () => undefined } as unknown as BlobShadows;
  return new ProjectileVisuals(new THREE.Group(), particles, shadows);
}

function liveFrame(id: string, predicted: boolean, x: number, y: number, z: number): ProjectileFrame {
  const f = emptyProjectileFrame(id, predicted, "coconut");
  f.x = x;
  f.y = y;
  f.z = z;
  f.vz = -12;
  f.ownerId = "me";
  return f;
}

const HAND = { x: 0.3, y: 1.2, z: -0.4 };
const STEP = HAND_OFF_SEC / 4;

describe("handOffWeight", () => {
  it("eases out from 1 to 0 over HAND_OFF_SEC", () => {
    expect(handOffWeight(0)).toBe(1);
    expect(handOffWeight(HAND_OFF_SEC)).toBe(0);
    expect(handOffWeight(1)).toBe(0);
    expect(handOffWeight(Number.NaN)).toBe(0);
    // Ease-out: more than half of the way onto the path at half time, strictly decreasing.
    expect(handOffWeight(HAND_OFF_SEC / 2)).toBeLessThan(0.5);
    let prev = 1;
    for (let i = 1; i <= 8; i++) {
      const w = handOffWeight((i / 8) * HAND_OFF_SEC);
      expect(w).toBeLessThan(prev);
      prev = w;
    }
  });
});

describe("ProjectileVisuals hand-off", () => {
  it("draws my predicted throw at the hand first, then blends onto its simulated position", () => {
    const fx = visuals();
    const f = liveFrame("pred:5:0", true, 0, 1.5, -0.6);
    const at = new THREE.Vector3();
    fx.sync([f], STEP, HAND);
    expect(fx.getPosition(f.id, at)).toBe(true);
    expect(at.x).toBeCloseTo(HAND.x);
    expect(at.y).toBeCloseTo(HAND.y);
    expect(at.z).toBeCloseTo(HAND.z);
    // Later frames: the offset is fixed at spawn (the hand moving on doesn't drag the item along) and shrinks.
    const sim = new THREE.Vector3(f.x, f.y, f.z);
    const spawnOffset = Math.hypot(HAND.x - f.x, HAND.y - f.y, HAND.z - f.z);
    let prevDist = at.distanceTo(sim);
    for (let i = 1; i < 4; i++) {
      fx.sync([f], STEP, { x: 5, y: 5, z: 5 });
      fx.getPosition(f.id, at);
      const dist = at.distanceTo(sim);
      expect(dist).toBeLessThan(prevDist);
      expect(dist).toBeCloseTo(spawnOffset * handOffWeight(i * STEP), 6);
      prevDist = dist;
    }
    fx.sync([f], STEP, null);
    fx.getPosition(f.id, at);
    expect(at.distanceTo(sim)).toBeLessThan(1e-9);
  });

  it("leaves server projectiles and hand-less frames on their path", () => {
    const fx = visuals();
    const server = liveFrame("p7", false, 4, 2, 4);
    const noHand = liveFrame("pred:9:0", true, -4, 2, -4);
    const at = new THREE.Vector3();
    fx.sync([server], STEP, HAND);
    fx.getPosition(server.id, at);
    expect(at.toArray()).toEqual([4, 2, 4]);
    fx.sync([server, noHand], STEP, null);
    fx.getPosition(noHand.id, at);
    expect(at.toArray()).toEqual([-4, 2, -4]);
  });
});
