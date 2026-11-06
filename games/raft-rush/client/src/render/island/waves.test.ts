// waves: the shared sea surface model (CPU twin of the water shader) and its live state. Owner: client-render.

import { describe, expect, it } from "vitest";
import { WATER_Y } from "../../../../shared/constants";
import { sea, seaSurfaceY, setSeaState, SWELLS, WAVES_GLSL, waveAttenuation, waveHeightAt, waveSlopeAt } from "./waves";

describe("waves", () => {
  it("swell height scales with the amplitude, averages ~0 and peaks near it", () => {
    let sum = 0;
    let max = 0;
    let n = 0;
    for (let x = -60; x <= 60; x += 1.7) {
      for (let z = -60; z <= 60; z += 2.3) {
        const h = waveHeightAt(x, z, 12.3, 1);
        sum += h;
        max = Math.max(max, Math.abs(h));
        n++;
      }
    }
    expect(Math.abs(sum / n)).toBeLessThan(0.08);
    expect(max).toBeGreaterThan(0.4);
    expect(max).toBeLessThan(1.15);
    expect(waveHeightAt(3, 4, 5, 0.5)).toBeCloseTo(waveHeightAt(3, 4, 5, 1) * 0.5, 9);
  });

  it("the slope matches the height's finite difference", () => {
    const out = { x: 0, z: 0 };
    for (const [x, z, t] of [[1.2, -3.4, 0.5], [17, 9, 31.7], [-40, 22, 8]] as const) {
      waveSlopeAt(x, z, t, 0.7, out);
      const e = 1e-4;
      expect(out.x).toBeCloseTo((waveHeightAt(x + e, z, t, 0.7) - waveHeightAt(x - e, z, t, 0.7)) / (2 * e), 4);
      expect(out.z).toBeCloseTo((waveHeightAt(x, z + e, t, 0.7) - waveHeightAt(x, z - e, t, 0.7)) / (2 * e), 4);
    }
  });

  it("the swell travels: the same crest moves downwind over time", () => {
    const w = SWELLS[0]!;
    const c = w.omega / w.k;
    const only = (x: number, z: number, t: number) => Math.sin((x * w.dirX + z * w.dirZ) * w.k - t * w.omega + w.phase);
    expect(only(5 + w.dirX * c * 2, 7 + w.dirZ * c * 2, 2)).toBeCloseTo(only(5, 7, 0), 9);
    expect(c).toBeGreaterThan(3);
    expect(c).toBeLessThan(10);
  });

  it("the shelf damps the swell to a lap at the waterline", () => {
    expect(waveAttenuation(0)).toBeCloseTo(0.22, 5);
    expect(waveAttenuation(1)).toBeGreaterThan(waveAttenuation(0.3));
    expect(waveAttenuation(5)).toBeCloseTo(1, 5);
  });

  it("seaSurfaceY follows the published sea state and its depth sampler", () => {
    setSeaState(4.2, 0.6, () => 10);
    try {
      expect(sea.storm).toBeGreaterThan(0.3);
      expect(seaSurfaceY(2, 3)).toBeCloseTo(WATER_Y + waveHeightAt(2, 3, 4.2, 0.6), 9);
      setSeaState(4.2, 0.6, () => 0);
      expect(seaSurfaceY(2, 3)).toBeCloseTo(WATER_Y + waveHeightAt(2, 3, 4.2, 0.6) * 0.22, 9);
    } finally {
      setSeaState(0, 0.12, null);
    }
  });

  it("emits GLSL for every swell and chop term (no NaN / bad literals)", () => {
    expect(WAVES_GLSL).toContain("float swellHeight(vec2 p, float t)");
    expect(WAVES_GLSL).toContain("vec2 chopSlope(vec2 p, float t)");
    expect(WAVES_GLSL).not.toMatch(/NaN|Infinity|\+ -/);
    expect(WAVES_GLSL.match(/h \+= /g)?.length).toBe(SWELLS.length);
  });
});
