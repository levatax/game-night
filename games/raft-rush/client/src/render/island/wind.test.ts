// wind: coherent gust fronts shared by the sway shader and CPU users (sails). Owner: client-render.

import { describe, expect, it } from "vitest";
import { GUST_SPEED, gustAt, WIND_DIR_X, WIND_DIR_Z } from "./wind";

describe("gustAt", () => {
  it("stays in 0..1 and is stronger on average in the storm", () => {
    let calm = 0;
    let storm = 0;
    for (let i = 0; i < 400; i++) {
      const x = (i * 7.3) % 90 - 45;
      const z = (i * 3.1) % 90 - 45;
      const a = gustAt(x, z, i * 0.37, 0.25);
      const b = gustAt(x, z, i * 0.37, 1);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a).toBeLessThanOrEqual(1);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
      calm += a;
      storm += b;
    }
    expect(storm / 400).toBeGreaterThan(0.25);
    expect(Math.abs(storm - calm) / 400).toBeLessThan(0.5);
  });

  it("fronts travel downwind at GUST_SPEED (coherent, not per-plant noise)", () => {
    const dt = 1.5;
    const dx = WIND_DIR_X * GUST_SPEED * dt;
    const dz = WIND_DIR_Z * GUST_SPEED * dt;
    expect(gustAt(3 + dx, -8 + dz, 10 + dt, 0.6)).toBeCloseTo(gustAt(3, -8, 10, 0.6), 9);
  });
});
