// Projectiles: thrown / tossed / dropped items flying, bouncing, resting and being caught (docs/ARCHITECTURE.md
// §4.3 step 3, game4.md §11). Owner: server-world.
//
// Motion goes exclusively through shared/sim stepProjectile so the client's dead-reckoning matches. Per tick and
// projectile (stable insertion order):
//   sank → splash + removed · open catch windows (RMB, any thrower, live or loose) → caught into the inventory or
//   bounced off a full one · live projectile vs players (capsule; not its thrower for OWNER_IMMUNE_TICKS; coop:
//   knockback × FRIENDLY_KNOCK_MULT, no damage) / monsters (cylinder → MonsterSystem.hitByProjectile) · puffers
//   explode on any contact (`blast`) · live cover contact → `hit` (a coconut / stone on a palm trunk knocks a
//   coconut loose) · spears stick (`stick`) · wood / jellyfish landing in a lit campfire (or by a planted torch)
//   burn as fuel · raw fish coming to rest becomes bait (BAIT_TICKS, MonsterSystem.onBait).
// Resting / stuck items are pickups (E); they despawn GROUND_ITEM_DESPAWN_TICKS after they came to rest, and the
// oldest one makes room when a spawn would exceed MAX_PROJECTILES — except the raft's key cargo (KEPT_KINDS: logs,
// barrels, the compass), which never despawns. A compass that sinks goes back to its team's chest.

import {
  BAIT_TICKS,
  DT,
  FIRE_WOOD_FUEL_TICKS,
  FRIENDLY_KNOCK_MULT,
  FUEL_CATCH_RADIUS,
  GROUND_ITEM_DESPAWN_TICKS,
  JELLYFISH_FUEL_TICKS,
  MAX_PROJECTILES,
  MONSTERS,
  MVP_POINTS,
  PUFFER_BLAST_DAMAGE,
  PUFFER_BLAST_RADIUS,
  PUFFER_KNOCK_H,
  PUFFER_KNOCK_UP,
  PUFFER_SELF_DAMAGE,
  WATER_Y,
} from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { ITEMS } from "../../shared/items.js";
import type { BlastEvent, HitTargetType } from "../../shared/protocol.js";
import type { CoverCircle } from "../../shared/sim/cover.js";
import type { ProjectileContext } from "../../shared/sim/context.js";
import { canAct, playerHeight, playerRadius } from "../../shared/sim/player.js";
import { emptyProjectileResult, stepProjectileInto } from "../../shared/sim/projectile.js";
import type { ItemKind, Vec3Like } from "../../shared/types.js";
import { ProjectileEntity } from "../schema.js";
import type { MonsterState, PlayerState, SpawnProjectileOptions } from "./context.js";
import type { WorldCore } from "./core.js";
import {
  BODY_BOUNCE_KEEP,
  BODY_BOUNCE_POP_VY,
  catchDistance,
  dist2,
  DUEL_PLAYER_DAMAGE_MULT,
  horizontalDir,
  OWN_CATCH_IMMUNE_TICKS,
  OWNER_IMMUNE_TICKS,
  posOf,
  projectileKnockback,
  radialKnockback,
  sphereCapsuleOverlap,
  sphereCylinderOverlap,
} from "./rules.js";

/** A fuel catch must land roughly at the fire's height (not fly over it). */
const FUEL_CATCH_MAX_DY = 1.5;
/** Blast reach in height around the explosion (players are 1.7 m tall). */
const BLAST_MAX_DY = 2.5;

/** Ground items that never despawn and are never evicted (heavy raft cargo, the one compass). */
const KEPT_KINDS: ReadonlySet<string> = new Set(["log", "barrel", "compass"]);

export class ProjectileSystem {
  private nextId = 1;
  /** Tick each resting / stuck projectile came to rest (despawn clock). */
  private readonly restSince = new Map<string, number>();
  /** Raw fish spawned at rest: become bait on the next projectile pass (not while a system is mid-iteration). */
  private readonly baitPending = new Set<string>();
  private readonly ctx: ProjectileContext;
  private readonly res = emptyProjectileResult();
  /** Players with an open catch window this pass (refilled every step). */
  private readonly catchers: PlayerState[] = [];

  constructor(private readonly core: WorldCore) {
    this.ctx = { terrain: core.island.grid, cover: core.cover, bounds: core.island.bounds, dt: DT };
  }

  /* ------------------------------------------------------------------ spawn */

  /** WorldContext.spawnProjectile: ids "p<n>" (never reused); null when the cap is full of flying items. */
  spawn(kind: ItemKind, pos: Vec3Like, vel: Vec3Like, opts: SpawnProjectileOptions = {}): ProjectileEntity | null {
    const st = this.core.state;
    if (st.projectiles.size >= MAX_PROJECTILES && !this.evictOldest()) return null;
    const b = new ProjectileEntity();
    b.id = `p${this.nextId++}`;
    b.kind = kind;
    b.radius = ITEMS[kind].radius;
    b.state = opts.state ?? "loose";
    b.x = pos.x;
    b.y = pos.y;
    b.z = pos.z;
    const resting = b.state === "rest" || b.state === "stuck";
    if (resting) {
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      const floor = Math.max(heightAt(this.core.island.grid, b.x, b.z), WATER_Y) + b.radius;
      if (b.y < floor) b.y = floor;
    } else {
      b.vx = vel.x;
      b.vy = vel.y;
      b.vz = vel.z;
    }
    b.ageTicks = 0;
    b.restTicks = 0;
    b.bounces = 0;
    b.ownerId = opts.ownerId ?? "";
    b.throwSeq = opts.throwSeq ?? 0;
    b.team = opts.team ?? -1;
    b.charge = opts.charge ?? 0;
    b.baitTicks = 0;
    st.projectiles.set(b.id, b);
    if (resting) {
      this.restSince.set(b.id, this.core.tick());
      if (b.state === "rest" && kind === "fish_raw") this.baitPending.add(b.id);
    }
    return b;
  }

  /** Remove a projectile (no event). */
  remove(id: string): void {
    this.core.state.projectiles.delete(id);
    this.restSince.delete(id);
    this.baitPending.delete(id);
  }

  /** Match start / lobby. */
  clear(): void {
    this.core.state.projectiles.clear();
    this.restSince.clear();
    this.baitPending.clear();
  }

  /** The oldest resting / stuck item makes room. False when everything is in flight. */
  private evictOldest(): boolean {
    let oldest = "";
    let since = Infinity;
    this.core.state.projectiles.forEach((b, id) => {
      if ((b.state !== "rest" && b.state !== "stuck") || KEPT_KINDS.has(b.kind)) return;
      const t = this.restSince.get(id) ?? -1;
      if (t < since) {
        since = t;
        oldest = id;
      }
    });
    if (!oldest) return false;
    this.remove(oldest);
    return true;
  }

  /* ------------------------------------------------------------------- step */

  /** RaftWorld step 3. */
  step(): void {
    const core = this.core;
    const st = core.state;
    const tick = core.tick();
    this.ctx.terrain = core.island.grid;
    this.ctx.cover = core.cover;
    this.ctx.bounds = core.island.bounds;
    this.collectCatchers();
    for (const id of [...st.projectiles.keys()]) {
      const b = st.projectiles.get(id);
      if (!b) continue;
      if (b.state === "rest" || b.state === "stuck") {
        this.stepResting(id, b, tick);
        continue;
      }
      const wasLive = b.state === "live";
      const res = stepProjectileInto(b, this.ctx, this.res);
      if (res.sank) {
        core.emit({ type: "splash", tick, projectileId: id, kind: b.kind, pos: posOf(b) });
        if (b.kind === "compass") core.returnToChest(core.site(Math.max(0, b.team)).team, "compass", 1);
        this.remove(id);
        continue;
      }
      if (this.tryCatch(id, b)) continue;
      if ((wasLive || b.kind === "puffer") && this.hitBodies(id, b, wasLive)) continue;
      const touched = res.bounced || res.becameLoose || res.cameToRest || res.stuck || res.hitCover !== null;
      if (b.kind === "puffer" && touched) {
        this.explode(id, b);
        continue;
      }
      if (wasLive && res.hitCover) this.hitCover(id, b, res.hitCover);
      if (res.stuck) {
        this.restSince.set(id, tick);
        core.emit({ type: "stick", tick, projectileId: id, pos: posOf(b) });
      }
      const landed = res.bounced || res.becameLoose || res.cameToRest;
      if (landed && (b.kind === "wood" || b.kind === "jellyfish") && this.burnAsFuel(id, b)) continue;
      if (res.cameToRest) {
        this.restSince.set(id, tick);
        if (b.kind === "fish_raw") this.startBait(b);
      }
    }
    this.catchers.length = 0;
  }

  private stepResting(id: string, b: ProjectileEntity, tick: number): void {
    let since = this.restSince.get(id);
    if (since === undefined) {
      since = tick;
      this.restSince.set(id, tick);
    }
    if (this.baitPending.delete(id)) this.startBait(b);
    else if (b.baitTicks > 0) b.baitTicks--;
    if (tick - since >= GROUND_ITEM_DESPAWN_TICKS && !KEPT_KINDS.has(b.kind)) this.remove(id);
  }

  private startBait(b: ProjectileEntity): void {
    b.baitTicks = BAIT_TICKS;
    this.core.monsters.onBait(b);
  }

  /* ---------------------------------------------------------------- catches */

  private collectCatchers(): void {
    this.catchers.length = 0;
    this.core.state.players.forEach((p) => {
      if (p.catchTicks > 0 && canAct(p) && this.core.runtime.of(p).catchOpen) this.catchers.push(p);
    });
  }

  private tryCatch(id: string, b: ProjectileEntity): boolean {
    if (this.catchers.length === 0) return false;
    let best: PlayerState | null = null;
    let bestD = Infinity;
    for (const p of this.catchers) {
      if (p.catchTicks <= 0 || !this.core.runtime.of(p).catchOpen) continue;
      if (b.ownerId === p.id && b.ageTicks < OWN_CATCH_IMMUNE_TICKS) continue;
      const d = catchDistance(p, b, b.radius);
      if (d >= 0 && d < bestD) {
        best = p;
        bestD = d;
      }
    }
    if (!best) return false;
    const kept = this.core.bag.stow(best, b.kind, 1) === 1;
    best.catchTicks = 0;
    this.core.runtime.of(best).catchOpen = false;
    this.core.emit({ type: "catch", tick: this.core.tick(), playerId: best.id, projectileId: id, kind: b.kind, throwerId: b.ownerId, pos: posOf(b), kept });
    if (kept) this.remove(id);
    else this.bounceOff(b, best);
    return true;
  }

  /* ------------------------------------------------------------------- hits */

  /** Contacts with players / monsters. Returns true when the projectile was used up or bounced off a body. */
  private hitBodies(id: string, b: ProjectileEntity, wasLive: boolean): boolean {
    const st = this.core.state;
    for (const p of st.players.values()) {
      if (!p.alive || p.boarded || p.spectator) continue;
      if (p.id === b.ownerId && b.ageTicks <= OWNER_IMMUNE_TICKS) continue;
      if (!sphereCapsuleOverlap(b, b.radius, p, playerRadius(p.character), playerHeight(p))) continue;
      if (b.kind === "puffer") {
        if (p.id === b.ownerId) continue;
        this.explode(id, b);
        return true;
      }
      if (!wasLive) continue;
      this.hitPlayer(id, b, p);
      return true;
    }
    for (const m of st.monsters.values()) {
      const def = MONSTERS[m.kind];
      if (!sphereCylinderOverlap(b, b.radius, m, def.radius, def.height)) continue;
      if (b.kind === "puffer") {
        this.explode(id, b);
        return true;
      }
      if (!wasLive) continue;
      this.hitMonster(id, b, m);
      return true;
    }
    return false;
  }

  private hitPlayer(id: string, b: ProjectileEntity, p: PlayerState): void {
    const core = this.core;
    const def = ITEMS[b.kind];
    const enemy = core.state.layout === "duel" && b.team >= 0 && b.team !== p.team;
    const knockback = projectileKnockback(b, p, def.knock, enemy ? 1 : FRIENDLY_KNOCK_MULT);
    const damage = enemy ? def.damage * DUEL_PLAYER_DAMAGE_MULT : 0;
    core.emit({
      type: "hit",
      tick: core.tick(),
      projectileId: id,
      kind: b.kind,
      throwerId: b.ownerId,
      targetType: "player",
      targetId: p.id,
      pos: posOf(b),
      damage,
      knockback,
      charge: b.charge,
    });
    core.knockPlayer(p, knockback);
    if (damage > 0) core.damagePlayer(p, damage, "friendly", b.ownerId);
    this.bounceOff(b, p);
  }

  private hitMonster(id: string, b: ProjectileEntity, m: MonsterState): void {
    const core = this.core;
    const def = ITEMS[b.kind];
    const knockback = projectileKnockback(b, m, def.knock);
    const at = posOf(m);
    core.emit({
      type: "hit",
      tick: core.tick(),
      projectileId: id,
      kind: b.kind,
      throwerId: b.ownerId,
      targetType: "monster",
      targetId: m.id,
      pos: posOf(b),
      damage: def.damage,
      knockback,
      charge: b.charge,
    });
    const thrower = b.ownerId ? core.state.players.get(b.ownerId) : undefined;
    if (thrower && def.damage > 0) {
      thrower.stats.hits = Math.min(65535, thrower.stats.hits + 1);
      core.addScore(thrower, MVP_POINTS.hit);
    }
    const outcome = core.monsters.hitByProjectile(m, b, def.damage, knockback, b.ownerId);
    if (outcome === "consume") {
      this.remove(id);
    } else if (outcome === "stick") {
      b.state = "stuck";
      b.vx = 0;
      b.vy = 0;
      b.vz = 0;
      b.x = at.x;
      b.z = at.z;
      b.y = Math.max(heightAt(core.island.grid, at.x, at.z), WATER_Y) + b.radius;
      this.restSince.set(id, core.tick());
      core.emit({ type: "stick", tick: core.tick(), projectileId: id, pos: posOf(b) });
    } else {
      this.bounceOff(b, m);
    }
  }

  /** First live contact with a collider: feedback `hit`; coconuts / stones knock a coconut off a palm. */
  private hitCover(id: string, b: ProjectileEntity, c: CoverCircle): void {
    const targetType: HitTargetType | null =
      c.kind === "palm" || c.kind === "tree" || c.kind === "rock"
        ? c.kind
        : c.kind === "fence" || c.kind === "collector" || c.kind === "hut"
          ? "structure"
          : null;
    if (!targetType) return;
    const core = this.core;
    core.emit({
      type: "hit",
      tick: core.tick(),
      projectileId: id,
      kind: b.kind,
      throwerId: b.ownerId,
      targetType,
      targetId: c.id !== "" ? c.id : String(c.node),
      pos: posOf(b),
      damage: 0,
      knockback: { x: 0, y: 0, z: 0 },
      charge: b.charge,
    });
    if (c.kind === "palm" && c.node >= 0 && (b.kind === "coconut" || b.kind === "stone")) core.nodes.palmHit(c.node, b.ownerId);
  }

  /** A body deflects the projectile: loose, bouncing away with half its speed and a little pop. */
  private bounceOff(b: ProjectileEntity, from: { x: number; z: number }): void {
    const dir = horizontalDir(b.x - from.x, b.z - from.z, -b.vx, -b.vz);
    const speed = Math.sqrt(b.vx * b.vx + b.vz * b.vz) * BODY_BOUNCE_KEEP;
    b.state = "loose";
    b.vx = dir.x * speed;
    b.vz = dir.z * speed;
    b.vy = Math.abs(b.vy) * BODY_BOUNCE_KEEP + BODY_BOUNCE_POP_VY;
    b.restTicks = 0;
  }

  /* ------------------------------------------------------------------ blasts */

  private explode(id: string, b: ProjectileEntity): void {
    const pos = posOf(b);
    const byId = b.ownerId;
    const team = b.team;
    this.remove(id);
    this.blast(pos, byId, team, false, null);
  }

  /**
   * Puffer explosion at `pos` (thrown on impact, or in `holder`'s hand when the fuse ran out): monsters within
   * PUFFER_BLAST_RADIUS take PUFFER_BLAST_DAMAGE and crabs flip (MonsterSystem.blast); every player in the radius,
   * friends included, is knocked back; the holder takes PUFFER_SELF_DAMAGE (duel: enemies too).
   */
  blast(pos: Vec3Like, byId: string, team: number, inHand: boolean, holder: PlayerState | null): void {
    const core = this.core;
    const st = core.state;
    const ev: { type: "blast" } & BlastEvent = { type: "blast", tick: core.tick(), pos, radius: PUFFER_BLAST_RADIUS, byId, inHand, monsters: [], players: [] };
    core.emit(ev);
    const back = holder ? { x: Math.sin(holder.yaw), z: Math.cos(holder.yaw) } : { x: 0, z: 1 };
    const r2 = PUFFER_BLAST_RADIUS * PUFFER_BLAST_RADIUS;
    for (const p of st.players.values()) {
      if (!p.alive || p.boarded || p.spectator) continue;
      if (dist2(p.x, p.z, pos.x, pos.z) > r2 || Math.abs(p.y + 1 - pos.y) > BLAST_MAX_DY) continue;
      ev.players.push(p.id);
      core.knockPlayer(p, radialKnockback(pos, p, back, PUFFER_KNOCK_H, PUFFER_KNOCK_UP));
      if (p === holder) core.damagePlayer(p, PUFFER_SELF_DAMAGE, "blast", p.id);
      else if (st.layout === "duel" && team >= 0 && p.team !== team) core.damagePlayer(p, PUFFER_SELF_DAMAGE, "blast", byId);
    }
    ev.monsters = core.monsters.blast(pos, PUFFER_BLAST_RADIUS, PUFFER_BLAST_DAMAGE, byId);
    const thrower = byId ? st.players.get(byId) : undefined;
    if (thrower && ev.monsters.length > 0) {
      thrower.stats.hits = Math.min(65535, thrower.stats.hits + ev.monsters.length);
      core.addScore(thrower, MVP_POINTS.hit * ev.monsters.length);
    }
  }

  /* -------------------------------------------------------------------- fuel */

  /** Wood / jellyfish landing in a lit campfire (or by a planted torch) burns. True when it was used up. */
  private burnAsFuel(id: string, b: ProjectileEntity): boolean {
    const core = this.core;
    const ticks = b.kind === "jellyfish" ? JELLYFISH_FUEL_TICKS : FIRE_WOOD_FUEL_TICKS;
    const r2 = FUEL_CATCH_RADIUS * FUEL_CATCH_RADIUS;
    for (const site of core.island.sites) {
      const team = core.team(site.team);
      if (team.fireFuel <= 0) continue;
      if (dist2(b.x, b.z, site.campfire.x, site.campfire.z) > r2) continue;
      if (Math.abs(b.y - heightAt(core.island.grid, site.campfire.x, site.campfire.z)) > FUEL_CATCH_MAX_DY) continue;
      this.remove(id);
      core.addFireFuel(site.team, ticks, b.ownerId, b.kind === "jellyfish" ? "jellyfish" : "throw");
      return true;
    }
    const torch = core.structures.plantedTorchNear(b.x, b.z, FUEL_CATCH_RADIUS);
    if (torch) {
      this.remove(id);
      core.structures.feedTorch(torch, ticks);
      return true;
    }
    return false;
  }
}
