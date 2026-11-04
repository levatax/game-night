// Builds the BotView snapshot the brain decides on (botTypes.ts) from the authoritative room state.
// Owner: server-bots. Read-only: bots never mutate state; they act through inputs and the host's craft / chest.
//
// Light rings are computed here from the state (lit campfire fireLightRadius while fireRepels, planted torches and held lit
// torches TORCH_LIGHT_RADIUS), the same rule the monsters obey (docs/ARCHITECTURE.md §2.10), so the brain
// doesn't depend on world internals.

import { BIOMES, DIFFICULTIES, fireLightRadius, fireRepels, RAFT_STAGES, TORCH_LIGHT_RADIUS, type Timings } from "../../shared/constants.js";
import { ITEMS, isItemKind, raftStageNeeds } from "../../shared/items.js";
import { raftBoardable, raftStageOpen } from "../../shared/rules/interact.js";
import type { IslandDef } from "../../shared/island/types.js";
import { slotsOf } from "../../shared/rules/inventory.js";
import { clockAt, inputLocked, matchTicks } from "../../shared/rules/schedule.js";
import type { WorldQuery } from "../../shared/sim/context.js";
import type { BotRole, ItemKind } from "../../shared/types.js";
import type { PlayerState, RaftState } from "../schema.js";
import { fishStandsFor } from "./botNav.js";
import type { BotClaims, BotClock, BotLight, BotMate, BotRaftRow, BotSlot, BotView, Goal } from "./botTypes.js";

export interface SenseInput {
  state: RaftState;
  island: IslandDef;
  timings: Readonly<Timings>;
  /** Terrain + cover (fish-spot stand points). */
  query: WorldQuery;
  id: string;
  role: BotRole;
  /** Every seat the desk drives → its role. */
  roles: ReadonlyMap<string, BotRole>;
  /** Driven seats that are reconnect stand-ins: seen as driven but with no role, so no team duty lands on them. */
  standIns?: ReadonlySet<string>;
  /** Monster ground velocities tracked by the desk. */
  velocity: ReadonlyMap<string, { vx: number; vz: number }>;
  claims: BotClaims;
  blocked: (key: string) => boolean;
  current: Goal | null;
  roll: number;
}

function slots(p: PlayerState): BotSlot[] {
  return slotsOf(p).map((s) => ({ kind: s.kind, count: s.count }));
}

/** Requirement rows of raft stage `stage` (empty past the last stage). */
export function raftRows(stage: number, have: (i: number) => number, need: (i: number) => number): BotRaftRow[] {
  const def = RAFT_STAGES[stage];
  if (!def) return [];
  return def.req.map((r, i) => ({ item: r.item, kinds: r.kinds, have: have(i), need: need(i) }));
}

/** The match clock as the brain needs it (the landing counts as the start of day 1). */
export function clockView(state: RaftState, timings: Readonly<Timings>, island: IslandDef): BotClock {
  const base = {
    phase: state.phase,
    locked: inputLocked(state.phase, state.phaseTicksLeft, timings),
    days: timings.days,
    dayTicks: timings.day,
    duskTicks: timings.dusk,
    nightTicks: timings.night,
    weather: state.weather,
    nightChill: BIOMES[island.biome].nightChill,
  };
  if (state.phase === "playing") {
    const c = clockAt(state.clockTicks, timings);
    return { ...base, day: c.day, dayPhase: c.dayPhase, phaseLeft: c.phaseLeft, phaseLength: c.phaseLength, stormLeft: c.stormLeft };
  }
  return {
    ...base,
    day: 1,
    dayPhase: "day",
    phaseLeft: timings.day + state.phaseTicksLeft,
    phaseLength: timings.day,
    stormLeft: matchTicks(timings) + state.phaseTicksLeft,
  };
}

/** Every light ring monsters avoid right now. */
export function lightsOf(state: RaftState, island: IslandDef): BotLight[] {
  const out: BotLight[] = [];
  state.teams.forEach((t, i) => {
    const site = island.sites[i];
    // The campfire's ring follows its fuel and stops keeping monsters out below the repel floor (Long Tide §6).
    if (site && fireRepels(t.fireFuel)) out.push({ x: site.campfire.x, z: site.campfire.z, r: fireLightRadius(t.fireFuel), kind: "fire" });
  });
  state.structures.forEach((s) => {
    if (s.kind === "torch" && s.life > 0) out.push({ x: s.x, z: s.z, r: TORCH_LIGHT_RADIUS, kind: "planted" });
  });
  state.players.forEach((p) => {
    if (!p.alive || p.downed || p.torchTicks <= 0) return;
    const held = slotsOf(p)[p.activeSlot]?.kind;
    if (held === "torch") out.push({ x: p.x, z: p.z, r: ITEMS.torch.lightRadius || TORCH_LIGHT_RADIUS, kind: "torch" });
  });
  return out;
}

/** Snapshot for one bot (null when the seat or its team doesn't exist, e.g. in the lobby). */
export function buildView(inp: SenseInput): BotView | null {
  const { state, island, timings } = inp;
  const p = state.players.get(inp.id);
  if (!p) return null;
  const team = state.teams[p.team] ?? state.teams[0];
  const site = island.sites[p.team] ?? island.sites[0];
  if (!team || !site) return null;
  const nextNeeds = raftStageNeeds(team.stage + 1, team.seats, (DIFFICULTIES[state.difficulty] ?? DIFFICULTIES.normal).raftCostMult, timings.cheapRaft);

  const mates: BotMate[] = [];
  state.players.forEach((m, id) => {
    if (id === inp.id || m.spectator || m.team !== p.team || (!m.alive && !m.washed)) return;
    const driven = inp.roles.has(id);
    mates.push({
      id,
      seat: m.seat,
      x: m.x,
      z: m.z,
      role: inp.standIns?.has(id) ? "" : (inp.roles.get(id) ?? (m.botRole || "")),
      driven: driven || m.bot,
      human: !m.bot && m.connected && !driven,
      alive: m.alive,
      downed: m.downed,
      downedTicks: m.downedTicks,
      washed: m.washed,
      boarded: m.boarded,
      hp: m.hp,
      hunger: m.hunger,
      thirst: m.thirst,
      slots: slots(m),
    });
  });

  const monsters: BotView["monsters"] = [];
  state.monsters.forEach((m) => {
    const vel = inp.velocity.get(m.id);
    monsters.push({ id: m.id, kind: m.kind, x: m.x, y: m.y, z: m.z, mode: m.mode, hp: m.hp, vx: vel?.vx ?? 0, vz: vel?.vz ?? 0, targetId: m.targetId, carry: m.carry });
  });

  const items: BotView["items"] = [];
  state.projectiles.forEach((pr) => {
    items.push({ id: pr.id, kind: pr.kind, x: pr.x, y: pr.y, z: pr.z, state: pr.state, ownerId: pr.ownerId, baitTicks: pr.baitTicks });
  });

  const nodes: BotView["nodes"] = [];
  for (const n of island.nodes) {
    const amount = state.nodes[n.i] ?? 0;
    if (amount <= 0 || (n.kind === "bush" && n.yield === "none")) continue;
    if (island.layout === "duel" && n.island !== p.team) continue;
    nodes.push({ i: n.i, kind: n.kind, yield: n.yield, x: n.x, z: n.z, amount, radius: n.radius });
  }

  const stands = fishStandsFor(island, inp.query);
  const fishSpots: BotView["fishSpots"] = [];
  for (const f of island.fishSpots) {
    const st = stands[f.i];
    if (!st || (island.layout === "duel" && f.island !== p.team)) continue;
    fishSpots.push({ i: f.i, x: f.x, z: f.z, standX: st.x, standZ: st.z });
  }

  const chest: Partial<Record<ItemKind, number>> = {};
  team.chest.forEach((n, k) => {
    if (isItemKind(k) && n > 0) chest[k] = n;
  });

  const torches: BotView["torches"] = [];
  state.structures.forEach((s) => {
    if (s.kind === "torch" && s.life > 0) torches.push({ x: s.x, z: s.z, life: s.life });
  });

  return {
    self: {
      id: inp.id,
      seat: p.seat,
      team: p.team,
      character: p.character,
      role: inp.role,
      x: p.x,
      y: p.y,
      z: p.z,
      yaw: p.yaw,
      hp: p.hp,
      hunger: p.hunger,
      thirst: p.thirst,
      warmth: p.warmth,
      downed: p.downed,
      boarded: p.boarded,
      swimming: p.swimming,
      slots: slots(p),
      activeSlot: p.activeSlot,
      fishState: p.fishState,
      fuseTicks: p.fuseTicks,
      torchTicks: p.torchTicks,
    },
    mates,
    monsters,
    items,
    nodes,
    fishSpots,
    site: {
      center: site.center,
      wreck: site.wreck,
      campfire: site.campfire,
      chest: site.chest,
      raft: site.raft,
      spring: site.spring,
    },
    team: {
      stage: team.stage,
      seats: team.seats,
      rows: raftRows(team.stage, (i) => team.raftHave[i] ?? 0, (i) => team.raftNeed[i] ?? 0),
      stageOpen: raftStageOpen(team, state.phase === "playing" ? state.day : 1, timings.cheapRaft),
      nextRows: raftRows(team.stage + 1, () => 0, (i) => nextNeeds[i] ?? 0),
      raftWork: team.raftWork,
      raftWorkNeed: team.raftWorkNeed,
      raftHp: team.raftHp,
      canBoard: raftBoardable(team, state.phase === "playing" ? state.day : 1, state.difficulty, timings.cheapRaft, state.launchTicksLeft > 0).ok,
      benchTier: team.benchTier,
      wreckScrap: team.wreckScrap,
      springCharges: team.springCharges,
      bossDown: team.bossDown,
      fireFuel: team.fireFuel,
      chest,
      launchTicksLeft: state.launchTicksLeft,
    },
    clock: clockView(state, timings, island),
    lights: lightsOf(state, island),
    torches,
    claims: inp.claims,
    blocked: inp.blocked,
    current: inp.current,
    roll: inp.roll,
  };
}
