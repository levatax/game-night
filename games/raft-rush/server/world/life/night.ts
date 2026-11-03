// Night monster AI (game4.md §10, docs/ARCHITECTURE.md §2.10): crabs, puffer balls and Kaptan Yengeç.
// Owner: server-world-life.
//
// Think (every MONSTER_THINK_TICKS, staggered, or forced) picks the target by priority:
//   crab:   reachable player within MONSTER_AGGRO_RADIUS > bait fish (BAIT_RADIUS) > raft (its guard when one is
//           within RAFT_GUARD_RADIUS of it) > chest (only when not lit) > a lit player (wait at the ring edge,
//           "red eyes in the dark") > prowl the camp's light edge.
//   puffer: reachable player within PUFFER_AGGRO_RADIUS > raft (or its guard) > lit player edge > camp edge.
//   boss:   bait (at most BOSS_BAIT_TICKS per fish) > player within BOSS_PLAYER_AGGRO > raft (or its guard) > chest.
// Players inside a light ring are safe from crabs and puffers (no bites); the boss walks in, slowed.
// Act (every tick): move (steer.walk), then bite players (wind-up, cooldown, ctx.damagePlayer + knockPlayer),
// gnaw the unguarded raft (RAFT_GNAW_TICKS per wood), rummage at the chest, gnaw / snag on / smash fences.
// Modes: emerge → hunt / lured / bite; flipped (crabs, CRAB_FLIP_TICKS, then back up); stunned (torch scare,
// hit stagger, puffer snagged on a fence); flee (dawn: nearest shore cell, then despawn).

import {
  BAIT_RADIUS,
  BOSS_BAIT_TICKS,
  BOSS_LIGHT_SLOW,
  CRAB_FLIP_TICKS,
  FENCE_GNAW_TICKS,
  FENCE_HP,
  HIT_STUN_TICKS,
  MONSTER_AGGRO_RADIUS,
  MONSTERS,
  RAFT_GNAW_TICKS,
  RAFT_GUARD_RADIUS,
} from "../../../shared/constants.js";
import type { XZ } from "../../../shared/island/types.js";
import { playerRadius } from "../../../shared/sim/player.js";
import type { MonsterAttackEvent } from "../../../shared/protocol.js";
import type { MonsterKind, Vec3Like } from "../../../shared/types.js";
import type { StructureState } from "../../schema.js";
import type { MonsterState, PlayerState, ProjectileEntity } from "../context.js";
import type { MonsterBrain } from "./brain.js";
import type { LifeEnv } from "./env.js";
import { face, walk, type WalkResult, type WalkSpec } from "./steer.js";
import {
  AGGRO_KEEP_MULT,
  BITE_DY,
  BITE_REACH,
  BITE_SLACK,
  BITE_WINDUP_TICKS,
  BOSS_KNOCK_MULT,
  BOSS_PLAYER_AGGRO,
  BOSS_RAFT_GNAW,
  CHEST_REACH,
  CRAB_KNOCK_MULT,
  EDGE_SPREAD,
  EDGE_STANDOFF,
  EMERGE_SPEED_MULT,
  FENCE_GNAW_DOT,
  FLEE_SPEED_MULT,
  FLEE_TIMEOUT_TICKS,
  MONSTER_MIN_Y,
  PUFFER_AGGRO_RADIUS,
  PUFFER_RAFT_DAMAGE,
  PUFFER_SNAG_TICKS,
  RAFT_GNAW_REACH,
  RAFT_SPREAD,
  SCARED_SPEED_MULT,
} from "./tuning.js";
import { d2, dist2, ringAt, vec } from "./util.js";

export type NightKind = "crab" | "puffer" | "boss";

export function isNightKind(kind: MonsterKind): kind is NightKind {
  return kind === "crab" || kind === "puffer" || kind === "boss";
}

/** One tick of a night monster. `think` = its staggered decision tick. */
export function stepNight(env: LifeEnv, m: MonsterState, b: MonsterBrain, think: boolean): void {
  if (b.cooldown > 0) b.cooldown--;
  switch (m.mode) {
    case "emerge":
      stepEmerge(env, m, b);
      return;
    case "flipped":
      stepFlipped(env, m, b);
      return;
    case "stunned":
      stepStunned(env, m, b);
      return;
    case "flee":
      stepFlee(env, m, b);
      return;
    default:
      if (think || b.forceThink) thinkNight(env, m, b);
      pursue(env, m, b);
  }
}

/* ============================================================ decisions */

/** Pick the target (sets brain.goal, m.targetId, m.mode hunt / lured). */
export function thinkNight(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  b.forceThink = false;
  const team = teamOf(m);
  const site = env.ctx.site(team);
  const hull = env.ctx.team(team).hullWood;
  const kind = m.kind as NightKind;

  if (kind === "boss") {
    const keep = b.goal === "bait" ? activeBait(env, m.targetId) : null;
    if (keep && b.lureTicks < BOSS_BAIT_TICKS && !b.ignoreBait.has(keep.id)) return setGoal(m, b, "bait", keep.id, "lured");
    if (keep) b.ignoreBait.add(keep.id);
    const bait = nearestBait(env, m, (p) => !b.ignoreBait.has(p.id));
    if (bait) {
      b.lureTicks = 0;
      return setGoal(m, b, "bait", bait.id, "lured");
    }
    const near = nearestPlayer(env, m, BOSS_PLAYER_AGGRO, () => true);
    if (near) return setGoal(m, b, "player", near.id, "hunt");
    if (hull > 0) return raftOrGuard(env, m, b, site.raft, team);
    return setGoal(m, b, "chest", "chest", "hunt");
  }

  const aggro = kind === "puffer" ? PUFFER_AGGRO_RADIUS : MONSTER_AGGRO_RADIUS;
  const cur = b.goal === "player" ? env.player(m.targetId) : undefined;
  if (cur && targetable(env, cur) && !env.lit(cur.x, cur.z) && dist2(m.x, m.z, cur.x, cur.z) <= aggro * AGGRO_KEEP_MULT) {
    return setGoal(m, b, "player", cur.id, "hunt");
  }
  const reachable = nearestPlayer(env, m, aggro, (p) => !env.lit(p.x, p.z));
  if (reachable) return setGoal(m, b, "player", reachable.id, "hunt");
  if (kind === "crab") {
    const bait = nearestBait(env, m, () => true);
    if (bait) return setGoal(m, b, "bait", bait.id, "lured");
  }
  if (hull > 0) return raftOrGuard(env, m, b, site.raft, team);
  if (kind === "crab" && !env.lit(site.chest.x, site.chest.z)) return setGoal(m, b, "chest", "chest", "hunt");
  const lit = nearestPlayer(env, m, aggro, () => true);
  if (lit) return setGoal(m, b, "player", lit.id, "hunt");
  b.gx = site.campfire.x;
  b.gz = site.campfire.z;
  setGoal(m, b, "camp", "", "hunt");
}

function raftOrGuard(env: LifeEnv, m: MonsterState, b: MonsterBrain, raft: XZ, team: number): void {
  if (dist2(m.x, m.z, raft.x, raft.z) <= RAFT_GUARD_RADIUS + 3) {
    const guard = raftGuard(env, raft, team);
    if (guard) return setGoal(m, b, "player", guard.id, "hunt");
  }
  setGoal(m, b, "raft", "raft", "hunt");
}

function setGoal(m: MonsterState, b: MonsterBrain, goal: MonsterBrain["goal"], targetId: string, mode: "hunt" | "lured"): void {
  if (b.goal !== goal || m.targetId !== targetId) {
    b.windup = 0;
    if (goal !== "raft") b.gnaw = 0;
  }
  b.goal = goal;
  m.targetId = targetId;
  if (m.mode !== "bite" || mode === "lured") m.mode = mode;
  if (mode !== "lured") m.modeTicks = 0;
}

/** A player monsters may go for (cached per tick in env.targets). */
function targetable(env: LifeEnv, p: PlayerState): boolean {
  return env.targets.includes(p);
}

function nearestPlayer(env: LifeEnv, m: MonsterState, radius: number, ok: (p: PlayerState) => boolean): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = radius * radius;
  for (const p of env.targets) {
    const dd = d2(m.x, m.z, p.x, p.z);
    if (dd <= bestD && ok(p)) {
      bestD = dd;
      best = p;
    }
  }
  return best;
}

/** Someone is on the raft right now (a boarding seat counts as a guard: they sit on the hull). */
function crewAboard(env: LifeEnv, team: number): boolean {
  let found = false;
  env.ctx.state.players.forEach((p) => {
    if (found || p.team !== team) return;
    if (p.boarded && p.alive && !p.washed && !p.spectator) found = true;
  });
  return found;
}

/** The closest eligible player guarding the raft (within RAFT_GUARD_RADIUS of its center). */
export function raftGuard(env: LifeEnv, raft: XZ, team: number): PlayerState | null {
  let best: PlayerState | null = null;
  let bestD = RAFT_GUARD_RADIUS * RAFT_GUARD_RADIUS;
  for (const p of env.targets) {
    if (p.team !== team) continue;
    const dd = d2(raft.x, raft.z, p.x, p.z);
    if (dd <= bestD) {
      bestD = dd;
      best = p;
    }
  }
  return best;
}

function activeBait(env: LifeEnv, id: string): ProjectileEntity | null {
  const p = env.ctx.state.projectiles.get(id);
  return p && p.baitTicks > 0 ? p : null;
}

function nearestBait(env: LifeEnv, m: MonsterState, ok: (p: ProjectileEntity) => boolean): ProjectileEntity | null {
  let best: ProjectileEntity | null = null;
  let bestD = BAIT_RADIUS * BAIT_RADIUS;
  env.ctx.state.projectiles.forEach((p) => {
    if (p.baitTicks <= 0) return;
    const dd = d2(m.x, m.z, p.x, p.z);
    if (dd <= bestD && ok(p)) {
      bestD = dd;
      best = p;
    }
  });
  return best;
}

/* ============================================================== acting */

function spec(m: MonsterState, speedMult: number, env: LifeEnv): WalkSpec {
  const def = MONSTERS[m.kind];
  const boss = m.kind === "boss";
  const slow = boss && env.lit(m.x, m.z) ? BOSS_LIGHT_SLOW : 1;
  return { radius: def.radius, height: def.height, speed: def.speed * speedMult * slow, avoidLight: !boss, minY: MONSTER_MIN_Y, pushFences: true };
}

function pursue(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  const def = MONSTERS[m.kind];
  const team = teamOf(m);
  const site = env.ctx.site(team);
  const boss = m.kind === "boss";
  let gx = b.gx;
  let gz = b.gz;
  let arrive = 0.4;
  let player: PlayerState | null = null;

  switch (b.goal) {
    case "player": {
      const p = env.player(m.targetId);
      if (!p || !targetable(env, p)) {
        b.forceThink = true;
        b.windup = 0;
        m.mode = "hunt";
        return;
      }
      player = p;
      const reach = def.radius + playerRadius(p.character) + BITE_REACH;
      if (!boss && env.lit(p.x, p.z)) {
        const e = edgePoint(env, m, b, p.x, p.z);
        gx = e.x;
        gz = e.z;
        arrive = 0.3;
      } else {
        gx = p.x;
        gz = p.z;
        arrive = m.kind === "puffer" ? 0 : Math.max(0.2, reach - 0.15);
      }
      break;
    }
    case "bait": {
      const bait = activeBait(env, m.targetId);
      if (!bait) {
        b.forceThink = true;
        m.mode = "hunt";
        return;
      }
      m.mode = "lured";
      m.modeTicks = boss ? Math.max(0, Math.min(bait.baitTicks, BOSS_BAIT_TICKS - b.lureTicks)) : bait.baitTicks;
      if (boss && ++b.lureTicks >= BOSS_BAIT_TICKS) {
        b.ignoreBait.add(bait.id);
        b.forceThink = true;
      }
      const o = spreadOffset(b, 0.9);
      if (!boss && env.lit(bait.x, bait.z)) {
        const e = edgePoint(env, m, b, bait.x, bait.z);
        gx = e.x;
        gz = e.z;
      } else {
        gx = bait.x + o.x;
        gz = bait.z + o.z;
      }
      arrive = 0.3;
      break;
    }
    case "raft": {
      const o = spreadOffset(b, boss ? RAFT_SPREAD * 0.8 : RAFT_SPREAD);
      gx = site.raft.x + o.x;
      gz = site.raft.z + o.z;
      if (!boss && env.lit(gx, gz)) {
        const e = edgePoint(env, m, b, gx, gz);
        gx = e.x;
        gz = e.z;
      }
      arrive = 0.35;
      break;
    }
    case "chest": {
      const o = spreadOffset(b, CHEST_REACH - 0.2);
      gx = site.chest.x + o.x;
      gz = site.chest.z + o.z;
      arrive = 0.35;
      break;
    }
    case "camp":
    case "edge": {
      if (!boss && env.lit(b.gx, b.gz)) {
        const e = edgePoint(env, m, b, b.gx, b.gz);
        gx = e.x;
        gz = e.z;
      }
      arrive = 0.4;
      break;
    }
    default:
      b.forceThink = true;
      return;
  }

  // Stand still while winding up / gnawing (the bite has a commitment beat).
  const busy = b.windup > 0 || b.fenceId !== "";
  const ws = spec(m, busy ? 0 : 1, env);
  const res = walk(env, m, b, ws, gx, gz, arrive);
  if (handleFence(env, m, b, res, gx, gz)) return;

  if (player) {
    if (m.kind === "puffer") pufferContact(env, m, player);
    else bite(env, m, b, player);
    return;
  }
  if (b.goal === "raft") raftWork(env, m, b, site.raft, team);
  else if (b.goal === "chest") chestWork(env, m, b, site.chest);
  else if (m.mode === "bite") m.mode = "hunt";
}

/** Bite a player in reach: wind-up, then damage + knockback, then cooldown. Crabs never bite into light. */
function bite(env: LifeEnv, m: MonsterState, b: MonsterBrain, p: PlayerState): void {
  const def = MONSTERS[m.kind];
  const reach = def.radius + playerRadius(p.character) + BITE_REACH;
  const d = dist2(m.x, m.z, p.x, p.z);
  const safe = m.kind !== "boss" && env.lit(p.x, p.z);
  const inReach = d <= reach && Math.abs(p.y - m.y) < BITE_DY && !safe;
  if (b.windup > 0) {
    face(m, p.x, p.z);
    m.mode = "bite";
    if (--b.windup > 0) {
      m.modeTicks = b.windup;
      return;
    }
    b.cooldown = def.biteCooldownTicks;
    m.modeTicks = b.cooldown;
    if (d <= reach + BITE_SLACK && Math.abs(p.y - m.y) < BITE_DY && !safe) landHit(env, m, p);
    return;
  }
  if (!inReach) {
    if (m.mode === "bite") m.mode = "hunt";
    m.modeTicks = 0;
    return;
  }
  face(m, p.x, p.z);
  m.mode = "bite";
  if (b.cooldown === 0) {
    b.windup = BITE_WINDUP_TICKS;
    m.modeTicks = b.windup;
  } else m.modeTicks = b.cooldown;
}

/** A puffer rolling into a player: 20 damage + knockback, and it pops. */
function pufferContact(env: LifeEnv, m: MonsterState, p: PlayerState): void {
  const def = MONSTERS.puffer;
  if (env.lit(p.x, p.z)) return;
  const reach = def.radius + playerRadius(p.character) + 0.15;
  if (dist2(m.x, m.z, p.x, p.z) > reach || Math.abs(p.y - m.y) >= BITE_DY) return;
  landHit(env, m, p);
  env.remove(m, "", false);
}

function landHit(env: LifeEnv, m: MonsterState, p: PlayerState): void {
  const def = MONSTERS[m.kind];
  const cause = m.kind as NightKind;
  attackEvent(env, m, "player", p.id, def.damage);
  env.ctx.damagePlayer(p, def.damage, cause, m.id);
  const dx = p.x - m.x;
  const dz = p.z - m.z;
  const dl = Math.hypot(dx, dz) || 1;
  env.ctx.knockPlayer(p, { x: (dx / dl) * def.knockH, y: def.knockUp, z: (dz / dl) * def.knockH });
}

/** At the raft: gnaw it (unless someone guards it: then that player is the target). Puffers pop on it. */
function raftWork(env: LifeEnv, m: MonsterState, b: MonsterBrain, raft: XZ, team: number): void {
  if (dist2(m.x, m.z, raft.x, raft.z) > RAFT_GNAW_REACH) {
    b.gnaw = 0;
    if (m.mode === "bite") m.mode = "hunt";
    return;
  }
  // A crew already on the raft is a guard too: someone is sitting right on the hull and can shoo a crab off.
  // Without this, `board` parked the whole crew on the seats and crabs chewed the finished raft out from under
  // them (the stage dropped, everyone unboarded on the beach, and the gate found an empty, broken raft).
  if (crewAboard(env, team)) {
    b.gnaw = 0;
    if (m.mode === "bite") m.mode = "hunt";
    b.forceThink = true;
    return;
  }
  const guard = raftGuard(env, raft, team);
  if (guard) {
    b.gnaw = 0;
    setGoal(m, b, "player", guard.id, "hunt");
    m.mode = "hunt";
    return;
  }
  const t = env.ctx.team(team);
  if (t.hullWood <= 0) {
    b.gnaw = 0;
    b.forceThink = true;
    return;
  }
  const pos = vec(m.x, m.y, m.z);
  if (m.kind === "puffer") {
    attackEvent(env, m, "raft", "raft", PUFFER_RAFT_DAMAGE);
    env.ctx.damageRaft(team, PUFFER_RAFT_DAMAGE, m.id, pos);
    env.remove(m, "", false);
    return;
  }
  face(m, raft.x, raft.z);
  m.mode = "bite";
  b.gnaw++;
  m.modeTicks = Math.max(0, RAFT_GNAW_TICKS - b.gnaw);
  if (b.gnaw < RAFT_GNAW_TICKS) return;
  b.gnaw = 0;
  const amount = Math.min(t.hullWood, m.kind === "boss" ? BOSS_RAFT_GNAW : 1);
  attackEvent(env, m, "raft", "raft", amount);
  env.ctx.damageRaft(team, amount, m.id, pos);
}

/** At the chest: rummage (a harmless clack every cooldown — crabs don't steal, monkeys do). */
function chestWork(env: LifeEnv, m: MonsterState, b: MonsterBrain, chest: XZ): void {
  if (dist2(m.x, m.z, chest.x, chest.z) > CHEST_REACH) {
    if (m.mode === "bite") m.mode = "hunt";
    return;
  }
  face(m, chest.x, chest.z);
  m.mode = "bite";
  m.modeTicks = b.cooldown;
  if (b.cooldown > 0) return;
  b.cooldown = MONSTERS[m.kind].biteCooldownTicks;
  attackEvent(env, m, "chest", "chest", 0);
}

/**
 * A fence post in the way (walk reported contact and the goal lies beyond it): crabs gnaw it (FENCE_HP over
 * FENCE_GNAW_TICKS), the boss smashes it at once, puffers snag on it. Returns true when the fence took the tick.
 */
function handleFence(env: LifeEnv, m: MonsterState, b: MonsterBrain, res: WalkResult, gx: number, gz: number): boolean {
  const c = res.fence;
  if (!c) {
    if (b.fenceId) {
      b.fenceId = "";
      b.fenceTicks = 0;
    }
    return false;
  }
  const fx = c.x - m.x;
  const fz = c.z - m.z;
  const gxv = gx - m.x;
  const gzv = gz - m.z;
  const fl = Math.hypot(fx, fz) || 1;
  const gl = Math.hypot(gxv, gzv);
  if (gl < 0.3 || (fx * gxv + fz * gzv) / (fl * gl) < FENCE_GNAW_DOT) return false;
  const s = env.ctx.state.structures.get(c.id);
  if (!s) return false;
  if (m.kind === "boss") {
    attackEvent(env, m, "structure", s.id, s.hp);
    destroyStructure(env, s, m.id);
    return true;
  }
  if (m.kind === "puffer") {
    m.mode = "stunned";
    m.modeTicks = PUFFER_SNAG_TICKS;
    b.fenceId = s.id;
    return true;
  }
  if (b.fenceId !== s.id) {
    b.fenceId = s.id;
    b.fenceTicks = 0;
  }
  face(m, c.x, c.z);
  m.mode = "bite";
  const per = Math.max(1, Math.round(FENCE_GNAW_TICKS / FENCE_HP));
  b.fenceTicks++;
  m.modeTicks = per - (b.fenceTicks % per);
  if (b.fenceTicks % per === 0) {
    attackEvent(env, m, "structure", s.id, 1);
    damageStructure(env, s, 1, m.id);
  }
  return true;
}

/** monsterAttack feedback event (emitted before the damage it describes). */
function attackEvent(env: LifeEnv, m: MonsterState, targetType: MonsterAttackEvent["targetType"], targetId: string, damage: number): void {
  env.ctx.emit({ type: "monsterAttack", tick: env.tick(), id: m.id, kind: m.kind, targetType, targetId, damage, pos: vec(m.x, m.y, m.z) });
}

/** Structure −amount hp (structureHit); at 0 it breaks (structureDestroyed) and the cover index forgets it. */
export function damageStructure(env: LifeEnv, s: StructureState, amount: number, byId: string): void {
  s.hp = Math.max(0, s.hp - amount);
  env.ctx.emit({ type: "structureHit", tick: env.tick(), id: s.id, kind: s.kind, hp: s.hp, byId, pos: vec(s.x, s.y, s.z) });
  if (s.hp <= 0) destroyStructure(env, s, byId);
}

export function destroyStructure(env: LifeEnv, s: StructureState, byId: string): void {
  if (!env.ctx.state.structures.has(s.id)) return;
  env.ctx.state.structures.delete(s.id);
  env.ctx.emit({ type: "structureDestroyed", tick: env.tick(), id: s.id, kind: s.kind, byId, pos: vec(s.x, s.y, s.z) });
  env.ctx.cover.setStructures(env.ctx.state.structures.values());
}

/* =============================================================== modes */

function stepEmerge(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  const c = env.ctx.site(teamOf(m)).center;
  walk(env, m, b, spec(m, EMERGE_SPEED_MULT, env), c.x, c.z, 1);
  if (m.modeTicks > 0) m.modeTicks--;
  if (m.modeTicks <= 0) {
    m.mode = "hunt";
    m.modeTicks = 0;
    b.forceThink = true;
  }
}

function stepFlipped(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  // Helpless on its back (legs waving, client side); only knockback slides it.
  walk(env, m, b, spec(m, 0, env), m.x, m.z, 0);
  if (m.modeTicks > 0) m.modeTicks--;
  if (m.modeTicks > 0) return;
  m.hp = MONSTERS[m.kind].hp;
  m.mode = b.dawn ? "flee" : "hunt";
  b.goal = "none";
  b.forceThink = true;
  env.ctx.emit({ type: "monsterFlip", tick: env.tick(), id: m.id, flipped: false, byId: "", pos: vec(m.x, m.y, m.z) });
}

function stepStunned(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  if (b.fenceId) {
    // A puffer snagged on a fence: stuck until it pops on the spikes.
    walk(env, m, b, spec(m, 0, env), m.x, m.z, 0);
    if (m.modeTicks > 0) m.modeTicks--;
    if (m.modeTicks > 0) return;
    const s = env.ctx.state.structures.get(b.fenceId);
    b.fenceId = "";
    if (s) damageStructure(env, s, 1, m.id);
    env.remove(m, "", false);
    return;
  }
  // Scared / staggered: back away from (sx, sz).
  const ax = m.x - b.sx;
  const az = m.z - b.sz;
  const al = Math.hypot(ax, az) || 1;
  walk(env, m, b, spec(m, SCARED_SPEED_MULT, env), m.x + (ax / al) * 3, m.z + (az / al) * 3, 0.1);
  if (m.modeTicks > 0) m.modeTicks--;
  if (m.modeTicks <= 0) {
    m.mode = b.dawn ? "flee" : "hunt";
    m.modeTicks = 0;
    b.goal = b.dawn ? "none" : b.goal;
    b.forceThink = true;
  }
}

function stepFlee(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  b.fleeTicks++;
  if (b.goal !== "shore") {
    const cell = nearestShore(env, m);
    b.goal = "shore";
    b.gx = cell.x;
    b.gz = cell.z;
    m.targetId = "";
  }
  const res = walk(env, m, b, spec(m, FLEE_SPEED_MULT, env), b.gx, b.gz, 0.8);
  const wet = env.ground(m.x, m.z) < -0.35 && b.fleeTicks > 10;
  if (res.arrived || wet || b.fleeTicks >= FLEE_TIMEOUT_TICKS) env.remove(m, "", true);
}

function nearestShore(env: LifeEnv, m: MonsterState): XZ {
  const shore = env.ctx.site(teamOf(m)).shore;
  let best: XZ = { x: m.x, z: m.z };
  let bestD = Infinity;
  for (const c of shore) {
    const dd = d2(m.x, m.z, c.x, c.z);
    if (dd < bestD) {
      bestD = dd;
      best = c;
    }
  }
  return best;
}

/* ========================================================= hits & tools */

/** Flip a crab onto its back (credit the flipper). */
export function flipCrab(env: LifeEnv, m: MonsterState, b: MonsterBrain, byId: string): void {
  if (m.mode === "flipped") return;
  m.mode = "flipped";
  m.modeTicks = CRAB_FLIP_TICKS;
  m.hp = 0;
  m.targetId = "";
  b.windup = 0;
  b.gnaw = 0;
  b.fenceId = "";
  b.fenceTicks = 0;
  env.ctx.emit({ type: "monsterFlip", tick: env.tick(), id: m.id, flipped: true, byId, pos: vec(m.x, m.y, m.z) });
  env.creditKill(byId);
}

/**
 * Apply `damage` to a night monster: crabs flip at 0 hp (else stagger), puffers pop, the boss dies at 0.
 * Returns true when the monster is gone (popped / killed).
 */
export function damageNight(env: LifeEnv, m: MonsterState, b: MonsterBrain, damage: number, byId: string, knock: Vec3Like): boolean {
  const kind = m.kind as NightKind;
  if (kind === "crab" && m.mode === "flipped") {
    shove(b, knock, CRAB_KNOCK_MULT * 0.5);
    return false;
  }
  if (damage > 0) {
    m.hp = Math.max(0, m.hp - damage);
    env.ctx.emit({ type: "monsterHurt", tick: env.tick(), id: m.id, kind: m.kind, hp: m.hp, damage, byId, pos: vec(m.x, m.y, m.z) });
  }
  if (kind === "puffer") {
    if (damage <= 0) return false;
    env.remove(m, byId, false);
    env.creditKill(byId);
    return true;
  }
  if (kind === "boss") {
    shove(b, knock, BOSS_KNOCK_MULT);
    if (m.hp > 0) return false;
    env.remove(m, byId, false);
    env.creditKill(byId);
    return true;
  }
  shove(b, knock, CRAB_KNOCK_MULT);
  if (m.hp <= 0) flipCrab(env, m, b, byId);
  else if (damage > 0 && m.mode !== "emerge" && m.mode !== "flee") stagger(m, b, knock);
  return false;
}

/** Torch swing: crabs back off from `pos` for `ticks`. */
export function scareCrab(m: MonsterState, b: MonsterBrain, pos: Vec3Like, ticks: number): void {
  if (m.kind !== "crab" || m.mode === "flipped" || m.mode === "flee") return;
  m.mode = "stunned";
  m.modeTicks = Math.max(m.modeTicks, ticks);
  b.sx = pos.x;
  b.sz = pos.z;
  b.windup = 0;
  b.fenceId = "";
}

function stagger(m: MonsterState, b: MonsterBrain, knock: Vec3Like): void {
  m.mode = "stunned";
  m.modeTicks = HIT_STUN_TICKS;
  b.sx = m.x - knock.x;
  b.sz = m.z - knock.z;
  b.windup = 0;
}

/** Add a knockback velocity (horizontal part of `knock` × mult). */
export function shove(b: MonsterBrain, knock: Vec3Like, mult: number): void {
  b.kvx += knock.x * mult;
  b.kvz += knock.z * mult;
}

/* ============================================================== helpers */

function teamOf(m: MonsterState): number {
  return m.team >= 0 ? m.team : 0;
}

/** Per-monster offset on a ring around a target so a pack surrounds it instead of stacking. */
function spreadOffset(b: MonsterBrain, r: number): XZ {
  const a = b.phase * 1.2566 + (b.side > 0 ? 0 : 0.6);
  return { x: Math.cos(a) * r, z: Math.sin(a) * r };
}

/**
 * Where a night monster waits for a target inside a light ring: just outside the ring, on the monster's side,
 * fanned out by its stagger phase and drifting slowly (prowling eyes at the edge of the light).
 */
function edgePoint(env: LifeEnv, m: MonsterState, b: MonsterBrain, tx: number, tz: number): XZ {
  const ring = ringAt(env.rings, tx, tz);
  if (!ring) return { x: tx, z: tz };
  let ax = m.x - ring.x;
  let az = m.z - ring.z;
  const al = Math.hypot(ax, az);
  if (al < 1e-6) {
    ax = 1;
    az = 0;
  } else {
    ax /= al;
    az /= al;
  }
  const drift = Math.sin(env.tick() * 0.01 + b.phase * 1.7) * 0.5;
  const a = (b.phase - 2) * EDGE_SPREAD * 0.5 + drift * 0.3;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const ux = ax * c - az * s;
  const uz = ax * s + az * c;
  const r = ring.r + EDGE_STANDOFF;
  return { x: ring.x + ux * r, z: ring.z + uz * r };
}
