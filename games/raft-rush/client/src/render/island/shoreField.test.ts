// shoreField: depth and distance-to-coast encoding on a synthetic round island. Owner: client-render.

import { describe, expect, it } from "vitest";
import { createHeightfield } from "../../../../shared/island/heightfield";
import { buildShoreField, SHORE_DEPTH_MAX, SHORE_DIST_MAX } from "./shoreField";

/** 41 × 41 m grid, a flat disc of land (r = 8 m) at +1 m, sea floor at -3 m. */
function disc() {
  const hf = createHeightfield(41, 41, 1, -20, -20);
  for (let r = 0; r < 41; r++) {
    for (let c = 0; c < 41; c++) {
      const x = -20 + c;
      const z = -20 + r;
      hf.heights[r * 41 + c] = Math.fround(Math.hypot(x, z) <= 8 ? 1 : -3);
    }
  }
  return hf;
}

function texel(field: ReturnType<typeof buildShoreField>, x: number, z: number): { depth: number; dist: number; land: boolean } {
  const img = field.texture.image as { data: Uint8Array; width: number; height: number };
  const u = (x - field.rect.x) / field.rect.z;
  const v = (z - field.rect.y) / field.rect.w;
  const i = Math.round(u * (img.width - 1));
  const j = Math.round(v * (img.height - 1));
  const k = (j * img.width + i) * 4;
  return { depth: (img.data[k]! / 255) * SHORE_DEPTH_MAX, dist: (img.data[k + 1]! / 255) * SHORE_DIST_MAX, land: img.data[k + 2]! > 127 };
}

describe("shoreField", () => {
  const field = buildShoreField(disc());

  it("covers the heightfield extent", () => {
    expect(field.rect.x).toBe(-20);
    expect(field.rect.y).toBe(-20);
    expect(field.rect.z).toBe(40);
    expect(field.rect.w).toBe(40);
  });

  it("marks land with zero distance", () => {
    const t = texel(field, 0, 0);
    expect(t.land).toBe(true);
    expect(t.dist).toBe(0);
    expect(t.depth).toBe(0);
  });

  it("encodes the distance to the coast in the water (±0.8 m)", () => {
    for (const d of [2, 4, 7]) {
      const t = texel(field, 9 + d, 0);
      expect(t.land).toBe(false);
      expect(Math.abs(t.dist - (d + 0.5))).toBeLessThan(0.8);
    }
  });

  it("encodes the deep-water depth", () => {
    const t = texel(field, 18, 18);
    expect(t.depth).toBeCloseTo(3, 1);
  });
});
