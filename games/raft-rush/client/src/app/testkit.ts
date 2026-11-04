// Test-only fixtures for the client-app vitest suites (app/*.test.ts). Owner: client-app.
// Never imported by runtime code (Vite only bundles what main.ts reaches). Builds plain-object stand-ins for the
// decoded room state (Map for MapSchema, arrays for ArraySchema) over the client-net test island.

import type { IslandDef } from "../../../shared/island/types";
import type { MonsterView, PlayerView, RaftStateView, TeamView } from "../../../shared/types";
import { playerView, spawnPlayer, testIsland } from "../net/testkit";

export { testIsland } from "../net/testkit";

/** A team on the raft's first stage with a lit fire and an empty chest. */
export function fakeTeam(over: Partial<TeamView> = {}): TeamView {
  return {
    index: 0,
    seats: 4,
    stage: 0,
    raftHave: [0, 0, 0],
    raftNeed: [3, 5, 0],
    raftWork: 0,
    raftWorkNeed: 750,
    raftHp: 0,
    benchTier: 0,
    wreckScrap: 6,
    springCharges: 12,
    bossDown: false,
    fireFuel: 1800,
    chest: new Map<string, number>(),
    flare: false,
    secretRevealed: false,
    secretOpened: false,
    springRevealed: false,
    ballRecipe: false,
    spyglassTicks: 0,
    hutHp: 0,
    score: 0,
    ...over,
  };
}

/** An alive player standing at (x, z) with full bars. */
export function fakePlayer(id: string, x = 0, z = 0, over: Partial<PlayerView> = {}): PlayerView {
  const sim = spawnPlayer(x, z, 0, 1);
  sim.hp = 100;
  sim.hunger = 100;
  sim.thirst = 100;
  sim.warmth = 100;
  return playerView(sim, 0, { id, nickname: id.toUpperCase(), ...over });
}

export function fakeMonster(id: string, over: Partial<MonsterView> = {}): MonsterView {
  return { id, kind: "crab", x: 0, y: 0, z: 0, yaw: 0, hp: 2, mode: "hunt", modeTicks: 0, targetId: "", team: 0, carry: "", ...over };
}

/** A decoded-state stand-in in the playing phase (day 1 morning) with the given players. */
export function fakeState(players: PlayerView[], over: Partial<RaftStateView> = {}, island: IslandDef = testIsland()): RaftStateView {
  return {
    phase: "playing",
    tick: 1000,
    phaseTicksLeft: 1000,
    clockTicks: 300,
    day: 1,
    dayPhase: "day",
    weather: "clear",
    seed: island.seed,
    layout: "solo",
    biome: "tropic",
    fast: false,
    difficulty: "normal",
    hostId: players[0]?.id ?? "",
    settings: { mode: "coop", difficulty: "normal", seed: 0 },
    players: new Map(players.map((p) => [p.id, p])),
    projectiles: new Map(),
    monsters: new Map(),
    structures: new Map(),
    nodes: island.nodes.map((n) => n.amount),
    teams: [fakeTeam()],
    launchTicksLeft: 0,
    winnerTeam: -1,
    winReason: "",
    ...over,
  };
}
