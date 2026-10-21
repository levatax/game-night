// LightPool: a fixed number of point lights handed to the nearest requests (priority as a small bonus). Owner:
// client-render.

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import type { LightRequest } from "./island/Campfire";
import { LightPool } from "./LightPool";

function req(x: number, priority: number, intensity = 1, radius = 4): LightRequest {
  return { pos: new THREE.Vector3(x, 1, 0), color: new THREE.Color("#FFB347"), intensity, radius, priority };
}

function lights(pool: LightPool): THREE.PointLight[] {
  return pool.group.children as THREE.PointLight[];
}

describe("LightPool", () => {
  it("never changes its light count", () => {
    const pool = new LightPool(3);
    pool.assign([req(0, 1), req(1, 1), req(2, 1), req(3, 1), req(4, 1)], new THREE.Vector3(), 1);
    expect(lights(pool).length).toBe(3);
    pool.assign([], new THREE.Vector3(), 1);
    expect(lights(pool).length).toBe(3);
    for (const l of lights(pool)) expect(l.intensity).toBe(0);
  });

  it("the nearest lights win; priority only breaks near-ties; far lights are skipped", () => {
    const pool = new LightPool(2);
    // A held torch next to you beats a campfire 40 m away; a campfire 6 m out beats a torch 3 m out.
    pool.assign([req(1, 1), req(40, 3, 1, 5), req(6, 3, 1, 5), req(3, 1)], new THREE.Vector3(0, 0, 0), 1);
    expect(lights(pool).map((l) => l.position.x).sort((a, b) => a - b)).toEqual([1, 6]);
    // Your own torch in the jungle still gets a light while a whole camp burns 60 m away (the review's case).
    const low = new LightPool(3);
    low.assign([req(60, 3, 1, 5), req(61, 2), req(62, 2), req(0, 1)], new THREE.Vector3(0, 0, 0), 1);
    expect(lights(low).map((l) => l.position.x)).toContain(0);
    // Beyond reach (radius × cutoff + MAX_REACH): skipped entirely.
    const far = new LightPool(1);
    far.assign([req(200, 3, 1, 5)], new THREE.Vector3(0, 0, 0), 1);
    expect(lights(far)[0]!.intensity).toBe(0);
  });

  it("skips dead lights and scales by darkness and radius", () => {
    const pool = new LightPool(2);
    pool.assign([req(0, 1, 0), req(5, 1, 1)], new THREE.Vector3(), 1);
    const [a] = lights(pool);
    expect(a!.position.x).toBe(5);
    const night = a!.intensity;
    pool.assign([req(5, 1, 1)], new THREE.Vector3(), 0);
    expect(lights(pool)[0]!.intensity).toBeLessThan(night * 0.5);
    expect(lights(pool)[0]!.distance).toBeGreaterThan(4);
  });
});
