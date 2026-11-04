// Daytime thieves (game4.md §6, §14; docs/ARCHITECTURE.md §2.14). Owner: server-world-life.
//
// Monkeys: come down from a tree near the camp, run to the chest (the first one goes for Fenomen when she has
// something on her — the selfie-stick gag), grab one item (ctx.stealFromChest / her inventory), escape up
// another tree and sit there (mode carry, y up in the crown, modeTicks counting down MONKEY_TREE_TICKS) until
// someone hits them — then they drop it (a hit at the chest puts it straight back) and flee. Left alone they
// vanish with the loot. Şükrü the gull: flies in from the sea at its victim (or the chest), snatches a raw fish,
// circles GULL_CIRCLES times over GULL_CARRY_TICKS (mode carry, modeTicks = carry ticks left), then drops it on
// the beach and flies off; any projectile hit makes it drop the fish at once. Visitors ignore light rings and
// leave at dusk (the gull drops its fish first; a monkey keeps its loot).

import { CHEST_RANGE, DT, GULL_CARRY_TICKS, GULL_CIRCLES, ISLAND_RADIUS, MONSTERS } from "../../../shared/constants.js";
import { heightAt } from "../../../shared/island/heightfield.js";
import type { IslandDef, IslandSite, NodeDef, XZ } from "../../../shared/island/types.js";
import { removeFromSlot, removeItem, slotCount, slotKind, SLOTS } from "../../../shared/rules/inventory.js";
import { approach, yawFromDir } from "../../../shared/sim/math.js";
import type { InvKind, ItemKind } from "../../../shared/types.js";
import type { MonsterState, PlayerState } from "../context.js";
import { createVisit, type MonsterBrain, type VisitorMemory } from "./brain.js";
import type { LifeEnv } from "./env.js";
import { face, fly, walk, type WalkSpec } from "./steer.js";
import {
  GIFT_MIN_Y,
  GULL_APPROACH_TICKS,
  GULL_CIRCLE_RADIUS,
  GULL_FLY_HEIGHT,
  GULL_SPAWN_DIST,
  GULL_SWOOP_TICKS,
  MONKEY_CHASE_TICKS,
  MONKEY_MIN_Y,
  MONKEY_STEAL_TICKS,
  MONKEY_TREE_HEIGHT,
  MONKEY_TREE_MAX,
  MONKEY_TREE_MIN,
  MONKEY_TREE_TICKS,
  VISITOR_ARRIVE,
  VISITOR_FLEE_TICKS,
} from "./tuning.js";
import { d2, dist2, pick, pickBy, vec } from "./util.js";

/** A monkey robbing a player must be this close when the grab ends. */
const MONKEY_GRAB_REACH = 2;
/** Gull climb rate after the swoop (m/s). */
const GULL_CLIMB_SPEED = 4;

/* ================================================================ spawning */

/** 2 monkeys (1 when there is only one thing to take) from a tree near the chest; the first goes for `victim` (Fenomen) when given. */
export function spawnMonkeys(env: LifeEnv, victim: PlayerState | null, team: number): string[] {
  const site = env.ctx.site(team);
  const plans: string[] = [];
  if (victim && hasLoot(victim)) plans.push(victim.id);
  const chestUnits = chestCount(env, team);
  if (chestUnits > 0) plans.push("");
  // Long Tide §6: a monkey raid takes 2 items (a second monkey whenever the chest holds 2 or more).
  if (plans.length === 1 && chestUnits >= 2) plans.push("");
  const ids: string[] = [];
  const used = new Set<number>();
  for (const victimId of plans.slice(0, 2)) {
    const tree = pickTree(env, site.chest, used, null);
    let x = site.chest.x + 12;
    let z = site.chest.z;
    if (tree) {
      used.add(tree.i);
      const dx = site.chest.x - tree.x;
      const dz = site.chest.z - tree.z;
      const dl = Math.hypot(dx, dz) || 1;
      x = tree.x + (dx / dl) * (tree.radius + 0.6);
      z = tree.z + (dz / dl) * (tree.radius + 0.6);
    } else {
      const p = inlandPoint(env.ctx.island, site, 12);
      x = p.x;
      z = p.z;
    }
    const m = env.spawn("monkey", x, z, { night: 0, team, mode: "hunt", modeTicks: 0 });
    m.targetId = victimId || "chest";
    const b = env.brain(m);
    b.visit = createVisit(victimId);
    ids.push(m.id);
  }
  return ids;
}

/** Şükrü: flies in from the sea toward `victim` (or the team chest when null). */
export function spawnGull(env: LifeEnv, victim: PlayerState | null, team: number): string[] {
  const site = env.ctx.site(team);
  const tx = victim ? victim.x : site.chest.x;
  const tz = victim ? victim.z : site.chest.z;
  let ox = tx - site.center.x;
  let oz = tz - site.center.z;
  const ol = Math.hypot(ox, oz);
  if (ol < 1e-3) {
    ox = 0;
    oz = 1;
  } else {
    ox /= ol;
    oz /= ol;
  }
  const bd = env.ctx.island.bounds;
  const x = Math.max(bd.minX, Math.min(bd.maxX, tx + ox * GULL_SPAWN_DIST));
  const z = Math.max(bd.minZ, Math.min(bd.maxZ, tz + oz * GULL_SPAWN_DIST));
  const m = env.spawn("gull", x, z, { night: 0, team, mode: "hunt", modeTicks: 0, y: flyHeight(env, x, z) });
  m.targetId = victim ? victim.id : "chest";
  env.brain(m).visit = createVisit(victim ? victim.id : "");
  return [m.id];
}

/* ================================================================== stepping */

export function stepVisitor(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  const v = b.visit;
  if (!v) return;
  v.phaseTicks++;
  if (m.kind === "gull") stepGull(env, m, v);
  else stepMonkey(env, m, b, v);
}

const MONKEY_SPEC: WalkSpec = {
  radius: MONSTERS.monkey.radius,
  height: MONSTERS.monkey.height,
  speed: MONSTERS.monkey.speed,
  avoidLight: false,
  minY: MONKEY_MIN_Y,
  pushFences: false,
};

function stepMonkey(env: LifeEnv, m: MonsterState, b: MonsterBrain, v: VisitorMemory): void {
  const team = m.team >= 0 ? m.team : 0;
  const site = env.ctx.site(team);
  switch (v.phase) {
    case "approach": {
      if (v.victimId) {
        const p = env.player(v.victimId);
        if (!p || !env.targets.includes(p) || !hasLoot(p) || v.phaseTicks > MONKEY_CHASE_TICKS) {
          // Lost her: try the chest instead (or give up when it's empty).
          v.victimId = "";
          v.phaseTicks = 0;
          m.targetId = "chest";
          if (chestCount(env, team) === 0) leave(env, m, v);
          return;
        }
        const res = walk(env, m, b, MONKEY_SPEC, p.x, p.z, MONSTERS.monkey.radius + 0.6);
        if (res.arrived) startGrab(m, v);
        return;
      }
      const res = walk(env, m, b, MONKEY_SPEC, site.chest.x, site.chest.z, 1.1);
      if (res.arrived) startGrab(m, v);
      else if (v.phaseTicks > MONKEY_CHASE_TICKS) leave(env, m, v);
      return;
    }
    case "grab": {
      const p = v.victimId ? env.player(v.victimId) : undefined;
      // Hang on to a victim who walks off; the chest doesn't move.
      if (p) walk(env, m, b, MONKEY_SPEC, p.x, p.z, MONSTERS.monkey.radius + 0.4);
      else face(m, site.chest.x, site.chest.z);
      if (m.modeTicks > 0) m.modeTicks--;
      if (m.modeTicks > 0) return;
      let item: ItemKind | null = null;
      if (v.victimId) item = p && dist2(m.x, m.z, p.x, p.z) < MONKEY_GRAB_REACH ? takeFromPlayer(p) : null;
      else item = env.ctx.stealFromChest(team);
      if (!item) return leave(env, m, v);
      m.carry = item;
      v.fromId = v.victimId || "chest";
      env.ctx.emit({ type: "steal", tick: env.tick(), monsterId: m.id, kind: "monkey", item, fromId: v.fromId, dropped: false, pos: vec(m.x, m.y, m.z) });
      const tree = pickTree(env, site.chest, new Set(), env.targets);
      v.tree = tree ? tree.i : -1;
      if (tree) {
        v.tx = tree.x;
        v.tz = tree.z;
      } else {
        const out = inlandPoint(env.ctx.island, site, 18);
        v.tx = out.x;
        v.tz = out.z;
      }
      v.phase = "escape";
      v.phaseTicks = 0;
      m.mode = "carry";
      m.modeTicks = 0;
      m.targetId = "";
      return;
    }
    case "escape": {
      const node = v.tree >= 0 ? env.ctx.island.nodes[v.tree] : undefined;
      const arrive = node ? node.radius + MONSTERS.monkey.radius + 0.3 : VISITOR_ARRIVE;
      const res = walk(env, m, b, MONKEY_SPEC, v.tx, v.tz, arrive);
      if (!res.arrived && v.phaseTicks < MONKEY_CHASE_TICKS) return;
      // No tree, or it never got there: it slips away into the bush with the loot.
      if (!node || (!res.arrived && dist2(m.x, m.z, node.x, node.z) > arrive + 2)) {
        env.remove(m, "", true);
        return;
      }
      // Up the tree it goes (the client sees it sitting in the crown with the loot).
      const dx = m.x - node.x;
      const dz = m.z - node.z;
      const dl = Math.hypot(dx, dz) || 1;
      m.x = node.x + (dx / dl) * (node.radius + 0.25);
      m.z = node.z + (dz / dl) * (node.radius + 0.25);
      m.y = node.y + MONKEY_TREE_HEIGHT * Math.max(0.6, node.scale);
      v.phase = "perch";
      v.phaseTicks = 0;
      m.modeTicks = MONKEY_TREE_TICKS;
      return;
    }
    case "perch": {
      if (m.modeTicks > 0) m.modeTicks--;
      if (m.modeTicks <= 0) env.remove(m, "", true);
      return;
    }
    default: {
      // leave
      m.mode = "flee";
      if (m.y > env.ground(m.x, m.z) + 0.05) m.y = env.ground(m.x, m.z);
      walk(env, m, b, { ...MONKEY_SPEC, speed: MONSTERS.monkey.speed * 1.2 }, v.tx, v.tz, VISITOR_ARRIVE);
      if (v.phaseTicks >= VISITOR_FLEE_TICKS) env.remove(m, "", true);
    }
  }
}

function stepGull(env: LifeEnv, m: MonsterState, v: VisitorMemory): void {
  const team = m.team >= 0 ? m.team : 0;
  const site = env.ctx.site(team);
  const def = MONSTERS.gull;
  switch (v.phase) {
    case "approach": {
      const t = gullTarget(env, v, site);
      if (!t || v.phaseTicks > GULL_APPROACH_TICKS) return leave(env, m, v);
      const horiz = dist2(m.x, m.z, t.x, t.z);
      const close = horiz < 4;
      // Cruise high, dive at the end (a bit faster than a sprinting tourist).
      const speed = horiz < 10 ? def.speed * 1.4 : def.speed;
      fly(env, m, t.x, close ? t.y : Math.max(t.y, flyHeight(env, m.x, m.z)), t.z, speed);
      if (horiz <= VISITOR_ARRIVE && Math.abs(m.y - t.y) <= 1.2) {
        m.mode = "steal";
        m.modeTicks = GULL_SWOOP_TICKS;
        v.phase = "grab";
        v.phaseTicks = 0;
      }
      return;
    }
    case "grab": {
      const t = gullTarget(env, v, site);
      if (t) fly(env, m, t.x, t.y, t.z, def.speed * 1.4);
      if (m.modeTicks > 0) m.modeTicks--;
      if (m.modeTicks > 0) return;
      let got = false;
      if (v.victimId) {
        const p = env.player(v.victimId);
        got = !!p && dist2(m.x, m.z, p.x, p.z) < 2 && removeItem(p, "fish_raw", 1) === 1;
      } else got = env.ctx.stealFromChest(team, "fish_raw") === "fish_raw";
      if (!got) return leave(env, m, v);
      m.carry = "fish_raw";
      v.fromId = v.victimId || "chest";
      const pos = vec(m.x, m.y, m.z);
      env.ctx.emit({ type: "steal", tick: env.tick(), monsterId: m.id, kind: "gull", item: "fish_raw", fromId: v.fromId, dropped: false, pos });
      // Circle around a center chosen so the gull is already on the circle (no teleport).
      v.angle = env.ctx.rng() * Math.PI * 2;
      v.cx = m.x - Math.cos(v.angle) * GULL_CIRCLE_RADIUS;
      v.cz = m.z - Math.sin(v.angle) * GULL_CIRCLE_RADIUS;
      v.travel = 0;
      v.phase = "circle";
      v.phaseTicks = 0;
      m.mode = "carry";
      m.modeTicks = GULL_CARRY_TICKS;
      m.targetId = "";
      return;
    }
    case "circle": {
      const omega = (GULL_CIRCLES * Math.PI * 2) / GULL_CARRY_TICKS;
      v.angle += omega;
      v.travel += omega;
      const x = v.cx + Math.cos(v.angle) * GULL_CIRCLE_RADIUS;
      const z = v.cz + Math.sin(v.angle) * GULL_CIRCLE_RADIUS;
      // Climb back up from the swoop (no vertical pop), then bob along the circle.
      const y = flyHeight(env, x, z) - 1 + Math.sin(v.angle * 2) * 0.4;
      m.yaw = yawFromDir(-Math.sin(v.angle), Math.cos(v.angle));
      m.x = x;
      m.z = z;
      m.y = approach(m.y, y, GULL_CLIMB_SPEED * DT);
      if (m.modeTicks > 0) m.modeTicks--;
      if (m.modeTicks > 0) return;
      const drop = beachDropPoint(env.ctx.island, site, v.cx, v.cz);
      v.tx = drop.x;
      v.tz = drop.z;
      v.phase = "toBeach";
      v.phaseTicks = 0;
      return;
    }
    case "toBeach": {
      const gy = env.ground(v.tx, v.tz) + 2.5;
      const there = fly(env, m, v.tx, gy, v.tz, def.speed);
      if (!there && v.phaseTicks < GULL_APPROACH_TICKS) return;
      dropCarry(env, m, v, false);
      return leave(env, m, v);
    }
    default: {
      // leave: out to sea, then gone.
      m.mode = "flee";
      const arrived = fly(env, m, v.tx, flyHeight(env, m.x, m.z) + 2, v.tz, def.speed);
      if (arrived || v.phaseTicks >= VISITOR_FLEE_TICKS) env.remove(m, "", true);
    }
  }
}

/* ====================================================== hits, dusk, drops */

/** Any projectile hit / blast: drop the loot (at the chest: straight back in), then run / fly away. */
export function hitVisitor(env: LifeEnv, m: MonsterState, b: MonsterBrain, byId: string): void {
  const v = b.visit;
  if (!v) return;
  env.ctx.emit({ type: "monsterHurt", tick: env.tick(), id: m.id, kind: m.kind, hp: m.hp, damage: 0, byId, pos: vec(m.x, m.y, m.z) });
  if (v.phase === "leave") return;
  dropCarry(env, m, v, true);
  leave(env, m, v);
}

/** Dusk: thieves call it a day (the gull lets go of its fish, a monkey keeps whatever it has). */
export function dismissVisitor(env: LifeEnv, m: MonsterState, b: MonsterBrain): void {
  const v = b.visit;
  if (v && m.kind === "gull") dropCarry(env, m, v, false);
  env.remove(m, "", true);
}

function dropCarry(env: LifeEnv, m: MonsterState, v: VisitorMemory, hit: boolean): void {
  const item = m.carry;
  if (item === "") return;
  m.carry = "";
  const team = m.team >= 0 ? m.team : 0;
  const chest = env.ctx.site(team).chest;
  const pos = vec(m.x, m.y, m.z);
  if (hit && m.kind === "monkey" && v.fromId === "chest" && dist2(m.x, m.z, chest.x, chest.z) <= CHEST_RANGE + 1) {
    env.ctx.returnToChest(team, item, 1);
  } else {
    const vx = (env.ctx.rng() - 0.5) * 1.2;
    const vz = (env.ctx.rng() - 0.5) * 1.2;
    env.ctx.spawnProjectile(item, { x: m.x, y: m.y + 0.3, z: m.z }, { x: vx, y: hit ? 2 : -0.5, z: vz }, { state: "loose" });
  }
  env.ctx.emit({ type: "steal", tick: env.tick(), monsterId: m.id, kind: m.kind, item, fromId: v.fromId || "chest", dropped: true, pos });
}

function leave(env: LifeEnv, m: MonsterState, v: VisitorMemory): void {
  const team = m.team >= 0 ? m.team : 0;
  const site = env.ctx.site(team);
  v.phase = "leave";
  v.phaseTicks = 0;
  m.mode = "flee";
  m.modeTicks = 0;
  m.targetId = "";
  if (m.kind === "gull") {
    let ox = m.x - site.center.x;
    let oz = m.z - site.center.z;
    const ol = Math.hypot(ox, oz) || 1;
    ox /= ol;
    oz /= ol;
    const bd = env.ctx.island.bounds;
    v.tx = Math.max(bd.minX, Math.min(bd.maxX, site.center.x + ox * (ISLAND_RADIUS + 20)));
    v.tz = Math.max(bd.minZ, Math.min(bd.maxZ, site.center.z + oz * (ISLAND_RADIUS + 20)));
  } else {
    const tree = pickTree(env, { x: m.x, z: m.z }, new Set(), env.targets);
    const out = tree ?? inlandPoint(env.ctx.island, site, 16);
    v.tx = out.x;
    v.tz = out.z;
    m.y = env.ground(m.x, m.z);
  }
}

function startGrab(m: MonsterState, v: VisitorMemory): void {
  v.phase = "grab";
  v.phaseTicks = 0;
  m.mode = "steal";
  m.modeTicks = MONKEY_STEAL_TICKS;
}

/* ================================================================= helpers */

function gullTarget(env: LifeEnv, v: VisitorMemory, site: IslandSite): { x: number; y: number; z: number } | null {
  if (v.victimId) {
    const p = env.player(v.victimId);
    if (!p || !env.targets.includes(p) || !hasItem(p, "fish_raw")) return null;
    return { x: p.x, y: p.y + 1.4, z: p.z };
  }
  return { x: site.chest.x, y: env.ground(site.chest.x, site.chest.z) + 1.1, z: site.chest.z };
}

function flyHeight(env: LifeEnv, x: number, z: number): number {
  return Math.max(0, env.ground(x, z)) + GULL_FLY_HEIGHT;
}

function hasItem(p: PlayerState, kind: ItemKind): boolean {
  for (let s = 0; s < SLOTS; s++) if (slotKind(p, s) === kind && slotCount(p, s) > 0) return true;
  return false;
}

function hasLoot(p: PlayerState): boolean {
  for (let s = 0; s < SLOTS; s++) if (slotKind(p, s) !== "" && slotCount(p, s) > 0) return true;
  return false;
}

/** One unit from a player: the active slot first, else a random filled slot. */
function takeFromPlayer(p: PlayerState): ItemKind | null {
  const slots: number[] = [];
  for (let s = 0; s < SLOTS; s++) if (slotKind(p, s) !== "" && slotCount(p, s) > 0) slots.push(s);
  if (slots.length === 0) return null;
  const slot = slots.includes(p.activeSlot) ? p.activeSlot : slots[0]!;
  const kind: InvKind = slotKind(p, slot);
  if (kind === "" || removeFromSlot(p, slot, 1) !== 1) return null;
  return kind;
}

function chestCount(env: LifeEnv, team: number): number {
  let n = 0;
  env.ctx.team(team).chest.forEach((c) => {
    n += c;
  });
  return n;
}

/**
 * A tree / palm MONKEY_TREE_MIN..MAX from `from` on the same island, not in `used`; with `players`, trees far
 * from everyone are likelier (the escape tree).
 */
function pickTree(env: LifeEnv, from: XZ, used: ReadonlySet<number>, players: ReadonlyArray<PlayerState> | null): NodeDef | null {
  const island = env.ctx.island;
  const min2 = MONKEY_TREE_MIN * MONKEY_TREE_MIN;
  const max2 = MONKEY_TREE_MAX * MONKEY_TREE_MAX;
  const cands = island.nodes.filter((n) => {
    if ((n.kind !== "tree" && n.kind !== "palm") || used.has(n.i)) return false;
    const dd = d2(n.x, n.z, from.x, from.z);
    return dd >= min2 && dd <= max2;
  });
  if (cands.length === 0) return null;
  if (!players || players.length === 0) return pick(env.ctx.rng, cands) ?? null;
  return (
    pickBy(env.ctx.rng, cands, (n) => {
      let near = Infinity;
      for (const p of players) near = Math.min(near, dist2(n.x, n.z, p.x, p.z));
      return Math.min(30, near) ** 2 + 1;
    }) ?? null
  );
}

/**
 * A point `dist` m from the chest toward (and past) the island center — inland, away from the beach (fallback
 * when there are no trees). Clamped to the walkable bounds.
 */
function inlandPoint(island: IslandDef, site: IslandSite, dist: number): XZ {
  const dx = site.chest.x - site.center.x;
  const dz = site.chest.z - site.center.z;
  const dl = Math.hypot(dx, dz) || 1;
  const bd = island.bounds;
  return {
    x: Math.max(bd.minX, Math.min(bd.maxX, site.chest.x - (dx / dl) * dist)),
    z: Math.max(bd.minZ, Math.min(bd.maxZ, site.chest.z - (dz / dl) * dist)),
  };
}

/**
 * Dry sand just inland of the shore cell nearest to (x, z): walk from the cell toward the site center until the
 * terrain is at least GIFT_MIN_Y (items dropped there don't roll into the sea).
 */
export function beachDropPoint(island: IslandDef, site: IslandSite, x: number, z: number): XZ {
  let best: XZ | null = null;
  let bestD = Infinity;
  for (const c of site.shore) {
    const dd = d2(c.x, c.z, x, z);
    if (dd < bestD) {
      bestD = dd;
      best = c;
    }
  }
  return dryInland(island, site, best ?? { x, z });
}

/** From `cell` toward the site center in 0.5 m steps until dry (≥ GIFT_MIN_Y), at most 20 m. */
export function dryInland(island: IslandDef, site: IslandSite, cell: XZ): XZ {
  let dx = site.center.x - cell.x;
  let dz = site.center.z - cell.z;
  const dl = Math.hypot(dx, dz) || 1;
  dx /= dl;
  dz /= dl;
  for (let t = 0; t <= 20; t += 0.5) {
    const px = cell.x + dx * t;
    const pz = cell.z + dz * t;
    if (heightAt(island.grid, px, pz) >= GIFT_MIN_Y) return { x: px + dx * 0.8, z: pz + dz * 0.8 };
  }
  return { x: cell.x + dx * 20, z: cell.z + dz * 20 };
}
