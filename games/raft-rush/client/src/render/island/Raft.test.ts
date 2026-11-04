// raftPieces: what the raft shows for each TeamView (game4.md §7: every delivered part shows; Long Tide: six
// build stages + the launch). Owner: client-render.

import { describe, expect, it } from "vitest";
import { NORMAL_TIMINGS, RAFT_LAUNCH_STAGE } from "../../../../shared/constants";
import type { TeamView } from "../../../../shared/types";
import { fakeTeam } from "../../app/testkit";
import { raftPieces, raftStageProgress } from "./Raft";

function team(patch: Partial<TeamView>): TeamView {
  return fakeTeam({ raftHave: [0, 0, 0], raftNeed: [2, 4, 0], raftWork: 0, raftWorkNeed: 750, ...patch });
}

describe("raftPieces", () => {
  it("a fresh raft is an empty slip; the lobby preview too", () => {
    const p = raftPieces(team({}), NORMAL_TIMINGS);
    expect(p.logs).toBe(0);
    expect(p.beams).toBe(false);
    expect(p.mast).toBe(0);
    expect(p.sail).toBe(false);
    expect(raftPieces(undefined, NORMAL_TIMINGS).logs).toBe(0);
  });

  it("keel logs grow with materials (first half) and assembly (second half)", () => {
    const mats = team({ raftHave: [2, 4, 0] });
    expect(raftStageProgress(mats, 0)).toBeCloseTo(0.5, 5);
    expect(raftPieces(mats, NORMAL_TIMINGS).logs).toBe(4);
    const half = team({ raftHave: [2, 4, 0], raftWork: 375 });
    expect(raftPieces(half, NORMAL_TIMINGS).logs).toBe(6);
  });

  it("deck assembled: full keel and beams; the mast pole follows the mast stage", () => {
    const p = raftPieces(team({ stage: 2, raftNeed: [1, 4, 5], raftHave: [1, 4, 5], raftWork: 0, raftWorkNeed: 900 }), NORMAL_TIMINGS);
    expect(p.logs).toBe(8);
    expect(p.beams).toBe(true);
    expect(p.mast).toBeCloseTo(0.5, 5);
    expect(p.yard).toBe(false);
    expect(p.sail).toBe(false);
  });

  it("sail rigged, provisions stack up on stage 5", () => {
    const p = raftPieces(team({ stage: 5, raftNeed: [5, 2, 0], raftHave: [3, 1, 0] }), NORMAL_TIMINGS);
    expect(p.mast).toBe(1);
    expect(p.yard).toBe(true);
    expect(p.sail).toBe(true);
    expect(p.ropes).toBe(4);
    expect(p.crates).toBe(3);
    expect(p.gourds).toBe(2);
    expect(p.ready).toBe(false);
  });

  it("the launch stage is READY", () => {
    expect(raftPieces(team({ stage: RAFT_LAUNCH_STAGE, raftNeed: [0, 0, 0], raftWorkNeed: 0 }), NORMAL_TIMINGS).ready).toBe(true);
  });
});
