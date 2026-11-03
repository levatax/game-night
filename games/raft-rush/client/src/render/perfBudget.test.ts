import { describe, expect, it } from "vitest";
import { formatBudget, readBudget, RENDER_BUDGET } from "./perfBudget";

describe("render budget", () => {
  it("is the acceptance budget (≤ 60 draw calls, ≤ 250k triangles)", () => {
    expect(RENDER_BUDGET).toEqual({ drawCalls: 60, triangles: 250_000 });
  });

  it("passes a frame on the limit and flags either counter above it", () => {
    expect(readBudget({ calls: 60, triangles: 250_000 })).toMatchObject({ overCalls: false, overTriangles: false, withinBudget: true });
    expect(readBudget({ calls: 61, triangles: 100 })).toMatchObject({ overCalls: true, withinBudget: false });
    expect(readBudget({ calls: 20, triangles: 250_001 })).toMatchObject({ overTriangles: true, withinBudget: false });
    expect(readBudget({ calls: 0, triangles: 0 }).withinBudget).toBe(true);
  });

  it("formats one readable line", () => {
    expect(formatBudget({ calls: 42, triangles: 78_123 })).toBe("42 / 60 draw calls · 78,123 / 250,000 triangles");
  });
});
