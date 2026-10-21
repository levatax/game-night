// LocalHandoff tests. Owner: client-net. Copied from games/bonk-brawl/client/src/net/LocalHandoff.test.ts.

import { describe, expect, it } from "vitest";
import { PREDICTION_SMOOTH_MS } from "../../../shared/constants";
import { LocalHandoff } from "./LocalHandoff";

describe("LocalHandoff", () => {
  it("starts the interpolated player where the predicted one was drawn, then blends in", () => {
    const h = new LocalHandoff();
    h.predicted({ x: 1, y: 0, z: -2 });
    const first = { x: 0.4, y: 0, z: -1.5 };
    h.interpolated(first, 0.016);
    expect(first).toEqual({ x: 1, y: 0, z: -2 });

    const next = { x: 0.4, y: 0, z: -1.5 };
    h.interpolated(next, PREDICTION_SMOOTH_MS / 1000);
    expect(next.x).toBeCloseTo(0.4 + 0.6 * Math.exp(-1), 9);
    expect(next.z).toBeCloseTo(-1.5 - 0.5 * Math.exp(-1), 9);

    const later = { x: 0.4, y: 0, z: -1.5 };
    h.interpolated(later, 2);
    expect(later.x).toBeCloseTo(0.4, 6);
  });

  it("snaps large differences (washed ashore, raft seat)", () => {
    const h = new LocalHandoff();
    h.predicted({ x: 0, y: -9, z: 0 });
    const frame = { x: 0, y: -6, z: 0 };
    h.interpolated(frame, 0.016);
    expect(frame.y).toBe(-6);
  });

  it("does nothing while predicting or after a reset", () => {
    const h = new LocalHandoff();
    const frame = { x: 3, y: 0, z: 3 };
    h.interpolated(frame, 0.016);
    expect(frame).toEqual({ x: 3, y: 0, z: 3 });
    h.predicted({ x: 4, y: 0, z: 3 });
    h.reset();
    h.interpolated(frame, 0.016);
    expect(frame).toEqual({ x: 3, y: 0, z: 3 });
  });
});
