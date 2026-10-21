// Daytime mini-events (game4.md §6; docs/ARCHITECTURE.md §2.14), one per day at DAY_EVENT_FRACTION.
// Owner: server-world-life.
//
// - gull: Şükrü goes for a player carrying a raw fish (else for a raw fish in the chest).
// - monkeys: 1–2 monkeys raid the chest (the first one goes for Fenomen when she's near camp with something).
// - waveGift: 3 resting items wash up on dry sand inland of a shore cell (2 random materials + a coconut); with
//   GIFT_TREASURE_CHANCE the first one picked up also spins a treasure reel for the picker.
// When today's event can't happen (no fish anywhere, empty chest) the next one in eventFallbacks() runs; the
// wave gift always can. The `dayEvent` event is emitted before the visitors spawn (feed line first).

import { PICKUP_RANGE } from "../../../shared/constants.js";
import { heightAt } from "../../../shared/island/heightfield.js";
import { ITEMS } from "../../../shared/items.js";
import { countOf } from "../../../shared/rules/inventory.js";
import type { DayEventKind, ItemKind, Vec3Like } from "../../../shared/types.js";
import type { MonsterSystem } from "../monsters.js";
import type { PlayerState, WorldContext } from "../context.js";
import { eventFallbacks } from "./forecast.js";
import type { TreasureReels } from "./treasure.js";
import { GIFT_MATERIALS, GIFT_NEAR_CAMP, GIFT_PICKUP_SLACK, GIFT_TREASURE_CHANCE, MONKEY_FENOMEN_RADIUS } from "./tuning.js";
import { d2, pick, vec } from "./util.js";
import { dryInland } from "./visitors.js";

/**
 * Run today's event (or the first possible fallback) for team `team`'s camp. Returns the kind that actually
 * happened.
 */
export function runDayEvent(ctx: WorldContext, monsters: MonsterSystem, gifts: WaveGifts, kind: DayEventKind, team = 0): DayEventKind {
  for (const k of eventFallbacks(kind)) {
    if (k === "gull" && tryGull(ctx, monsters, team)) return k;
    if (k === "monkeys" && tryMonkeys(ctx, monsters, team)) return k;
    if (k === "waveGift") {
      gifts.spawn(team);
      return k;
    }
  }
  gifts.spawn(team);
  return "waveGift";
}

function eligible(ctx: WorldContext): PlayerState[] {
  return ctx.alivePlayers().filter((p) => p.alive && !p.downed && !p.boarded && !p.washed && !p.spectator);
}

function tryGull(ctx: WorldContext, monsters: MonsterSystem, team: number): boolean {
  const holders = eligible(ctx).filter((p) => p.team === team && countOf(p, "fish_raw") > 0);
  const victim = pick(ctx.rng, holders) ?? null;
  const chest = ctx.site(team).chest;
  if (!victim && (ctx.team(team).chest.get("fish_raw") ?? 0) <= 0) return false;
  const pos = victim ? vec(victim.x, victim.y, victim.z) : vec(chest.x, heightAt(ctx.island.grid, chest.x, chest.z), chest.z);
  ctx.emit({ type: "dayEvent", tick: ctx.tick(), kind: "gull", pos, playerId: victim ? victim.id : "" });
  monsters.spawnVisitor("gull", victim);
  return true;
}

function tryMonkeys(ctx: WorldContext, monsters: MonsterSystem, team: number): boolean {
  const chest = ctx.site(team).chest;
  let units = 0;
  ctx.team(team).chest.forEach((n) => {
    units += n;
  });
  const r2 = MONKEY_FENOMEN_RADIUS * MONKEY_FENOMEN_RADIUS;
  const fenomen =
    eligible(ctx).find(
      (p) => p.team === team && p.character === "fenomen" && d2(p.x, p.z, chest.x, chest.z) <= r2 && p.cnt0 + p.cnt1 + p.cnt2 + p.cnt3 > 0,
    ) ?? null;
  if (units <= 0 && !fenomen) return false;
  ctx.emit({ type: "dayEvent", tick: ctx.tick(), kind: "monkeys", pos: vec(chest.x, heightAt(ctx.island.grid, chest.x, chest.z), chest.z), playerId: "" });
  monsters.spawnVisitor("monkey", fenomen);
  return true;
}

/** The wave gifts on the beach and who picks the first one up (for its treasure reel). */
export class WaveGifts {
  /** Gift projectile id → last seen position. */
  private items = new Map<string, Vec3Like>();
  /** The first pickup of the current gift spins a treasure reel. */
  private treasure = false;

  constructor(
    private readonly ctx: WorldContext,
    private readonly reels: TreasureReels,
  ) {}

  /** Wash 3 items up on dry sand near the camp; emits dayEvent. Returns where. */
  spawn(team: number): Vec3Like {
    const ctx = this.ctx;
    const site = ctx.site(team);
    const near = site.shore.filter((c) => d2(c.x, c.z, site.campfire.x, site.campfire.z) <= GIFT_NEAR_CAMP * GIFT_NEAR_CAMP);
    const cell = pick(ctx.rng, near.length > 0 ? near : site.shore) ?? site.raft;
    const spot = dryInland(ctx.island, site, cell);
    const pos = vec(spot.x, heightAt(ctx.island.grid, spot.x, spot.z), spot.z);
    ctx.emit({ type: "dayEvent", tick: ctx.tick(), kind: "waveGift", pos, playerId: "" });
    const kinds: ItemKind[] = [pick(ctx.rng, GIFT_MATERIALS) ?? "wood", pick(ctx.rng, GIFT_MATERIALS) ?? "rope", "coconut"];
    this.items.clear();
    this.treasure = ctx.rng() < GIFT_TREASURE_CHANCE;
    kinds.forEach((kind, k) => {
      const a = k * 2.1 + ctx.rng() * 0.5;
      const x = spot.x + Math.cos(a) * 0.7;
      const z = spot.z + Math.sin(a) * 0.7;
      const y = heightAt(ctx.island.grid, x, z) + ITEMS[kind].radius + 0.02;
      const proj = ctx.spawnProjectile(kind, { x, y, z }, { x: 0, y: 0, z: 0 }, { state: "rest", ownerId: "", team: -1 });
      if (proj) this.items.set(proj.id, vec(proj.x, proj.y, proj.z));
    });
    if (this.items.size === 0) this.treasure = false;
    return pos;
  }

  /** The gift carries a treasure reel for its first picker (tests / HUD). */
  hasTreasure(): boolean {
    return this.treasure;
  }

  /** Gift projectiles still on the beach. */
  ids(): string[] {
    return [...this.items.keys()];
  }

  /** RaftWorld reported a pickup (optional hook; step() detects pickups on its own otherwise). */
  onPickup(p: PlayerState, projectileId: string): void {
    if (!this.items.delete(projectileId)) return;
    this.picked(p);
  }

  /** Per tick: a gift item that vanished with a player right next to it was picked up by that player. */
  step(): void {
    if (this.items.size === 0) return;
    const range = PICKUP_RANGE + GIFT_PICKUP_SLACK;
    for (const [id, last] of [...this.items]) {
      const proj = this.ctx.state.projectiles.get(id);
      if (proj) {
        last.x = proj.x;
        last.y = proj.y;
        last.z = proj.z;
        continue;
      }
      this.items.delete(id);
      let picker: PlayerState | null = null;
      let best = range * range;
      for (const p of this.ctx.alivePlayers()) {
        if (p.spectator) continue;
        const dd = d2(p.x, p.z, last.x, last.z);
        if (dd <= best) {
          best = dd;
          picker = p;
        }
      }
      if (picker) this.picked(picker);
    }
    if (this.items.size === 0) this.treasure = false;
  }

  clear(): void {
    this.items.clear();
    this.treasure = false;
  }

  private picked(p: PlayerState): void {
    if (!this.treasure) return;
    this.treasure = false;
    this.reels.start(p, "waveGift");
  }
}
