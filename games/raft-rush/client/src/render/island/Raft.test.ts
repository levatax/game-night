// raftPieces: what the raft shows for each TeamView (game4.md §7: every delivered part shows). Owner:
// client-render.

import { describe, expect, it } from "vitest";
import { FAST_TIMINGS, NORMAL_TIMINGS, WRECK_HULL_WOOD } from "../../../../shared/constants";
import { raftCost } from "../../../../shared/items";
import type { TeamView } from "../../../../shared/types";
import { raftPieces } from "./Raft";

function team(patch: Partial<TeamView>): TeamView {
  return {
    index: 0,
    seats: 4,
    stage: 0,
    hullWood: WRECK_HULL_WOOD,
    mastWood: 0,
    mastRope: 0,
    food: 0,
    water: 0,
    fireFuel: 0,
    chest: new Map<string, number>(),
    flare: false,
    sail: false,
    secretRevealed: false,
    secretOpened: false,
    springRevealed: false,
    ballRecipe: false,
    spyglassTicks: 0,
    hutHp: 0,
    score: 0,
    ...patch,
  };
}

describe("raftPieces", () => {
  const cost = raftCost(4);

  it("the wreck's free part already shows a couple of logs", () => {
    const p = raftPieces(team({}), NORMAL_TIMINGS);
    expect(p.logs).toBeGreaterThanOrEqual(1);
    expect(p.logs).toBeLessThan(4);
    expect(p.beams).toBe(false);
    expect(p.mast).toBe(0);
    expect(p.sail).toBe(false);
  });

  it("the lobby preview (no team) shows the same slip", () => {
    expect(raftPieces(undefined, NORMAL_TIMINGS).logs).toBe(raftPieces(team({}), NORMAL_TIMINGS).logs);
  });

  it("logs grow with hull wood and gnawing removes them", () => {
    const half = raftPieces(team({ hullWood: cost.hullWood / 2 }), NORMAL_TIMINGS);
    const gnawed = raftPieces(team({ hullWood: cost.hullWood / 2 - 3 }), NORMAL_TIMINGS);
    expect(half.logs).toBe(4);
    expect(gnawed.logs).toBeLessThan(half.logs);
  });

  it("stage 1: full hull with beams; mast pole and ropes follow deliveries", () => {
    const p = raftPieces(team({ stage: 1, hullWood: cost.hullWood, mastWood: 2, mastRope: cost.mastRope }), NORMAL_TIMINGS);
    expect(p.logs).toBe(8);
    expect(p.beams).toBe(true);
    expect(p.mast).toBeCloseTo(0.5, 5);
    expect(p.yard).toBe(false);
    expect(p.ropes).toBe(4);
    expect(p.sail).toBe(false);
  });

  it("stage 2: sail set (old sail when found), provisions stack up", () => {
    const p = raftPieces(team({ stage: 2, hullWood: cost.hullWood, sail: true, food: 3, water: 1 }), NORMAL_TIMINGS);
    expect(p.mast).toBe(1);
    expect(p.yard).toBe(true);
    expect(p.sail).toBe(true);
    expect(p.oldSail).toBe(true);
    expect(p.crates).toBe(3);
    expect(p.gourds).toBe(1);
    expect(p.ready).toBe(false);
  });

  it("stage 3 is READY", () => {
    expect(raftPieces(team({ stage: 3, food: 4, water: 4 }), NORMAL_TIMINGS).ready).toBe(true);
  });

  it("cheap test rafts (fast timings) count against cost 1", () => {
    const p = raftPieces(team({ hullWood: 1 }), FAST_TIMINGS);
    expect(p.logs).toBe(8);
    expect(p.beams).toBe(true);
  });
});
