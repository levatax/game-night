// Survival: hunger / thirst / warmth / hp, the campfire's fuel, item timers, downed → washed → respawn
// (game4.md §4.6, §5, §7; docs/ARCHITECTURE.md §2.7, §2.11, §4.3 steps 6–7). Owner: server-world.
//
// Bars are floats in the runtime store (they drain by fractions per tick) and are written to the schema rounded
// up. They only run while the day clock does (not during the landing / cinematics), and freeze for downed and
// boarded players.
// - Hunger 25/min (sprinting ×1.5), thirst 33/min (heat wave ×2 outside tree shade), both × difficulty bars ×
//   timings.barMult.
// - Warmth: +5/s within FIRE_WARM_RADIUS of a lit fire; cold (night on a nightChill biome, rain outside the cave /
//   a hut, swimming unless Kolluklu Çocuk) −2/s, −1/s with a lit torch in hand; otherwise the day sun +1/s.
// - Hp: lit fire +3/s nearby; once per second every empty bar −2, drowning (swimTicks > DROWN_TICKS) −10, a
//   jellyfish as the active item −3; damagePlayer from monsters / blasts at any time. hp 0 → downed.
// - Item timers per tick: a lit torch in hand burns (gone at 0; a spare starts fresh), a puffer's fuse counts
//   down and explodes in hand (`blast` inHand, PUFFER_SELF_DAMAGE).
// - Fire: −1 fuel per tick always (rain ×RAIN_FIRE_DRAIN_MULT unless a duel hut shelters it); 0 = out (`fireFuel`
//   "out"). addFuel relights it. Spyglass countdown.
// - Downed: DOWNED_TICKS crawl, then washed ashore (inventory lost); washed players respawn at the next dawn at
//   the wreck with RESPAWN_BARS / RESPAWN_HP. Everyone washed with no dawn coming (day 3) → `teamWiped`.

import {
  BAR_MAX,
  BIOMES,
  CHANNEL,
  CHARACTERS,
  DAYS,
  DOWNED_TICKS,
  DROWN_DAMAGE_PER_SEC,
  DROWN_TICKS,
  DT,
  EMPTY_BAR_DAMAGE_PER_SEC,
  FIRE_FUEL_MAX_TICKS,
  FIRE_HEAL_PER_SEC,
  FIRE_WARM_RADIUS,
  JELLYFISH_DAMAGE_PER_SEC,
  LOW_BAR_FRACTION,
  MAX_HP,
  RAIN_FIRE_DRAIN_MULT,
  RESPAWN_BARS,
  RESPAWN_HP,
  REVIVE_HP,
  SHADE_RADIUS,
  SHELTER_RADIUS,
  TICK_RATE,
} from "../../shared/constants.js";
import type { IslandSite } from "../../shared/island/types.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { countOf } from "../../shared/rules/inventory.js";
import type { ClockInfo } from "../../shared/rules/schedule.js";
import type { CoverCircle } from "../../shared/sim/cover.js";
import { yawFromDir } from "../../shared/sim/math.js";
import { copyPlayerSim, createPlayerSim, heldKind } from "../../shared/sim/player.js";
import type { FireFuelEvent } from "../../shared/protocol.js";
import type { HurtCause } from "../../shared/types.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";
import type { LowBarKind, PlayerRuntime } from "./runtime.js";
import { dist2, hungerDrainPerTick, LOW_BAR_REARM_FRACTION, point, posOf, thirstDrainPerTick, warmthPerSec } from "./rules.js";

const LOW_BARS: ReadonlyArray<LowBarKind> = ["hunger", "thirst", "warmth", "hp"];

/** Schema value of a float bar: rounded up so 0 means really empty. */
function barValue(v: number, max: number): number {
  return v <= 0 ? 0 : v >= max ? max : Math.ceil(v);
}

export class SurvivalSystem {
  /** Teams already reported as wiped this match. */
  private readonly wiped = new Set<number>();
  private readonly scratch: CoverCircle[] = [];

  constructor(private readonly core: WorldCore) {}

  /** Forget per-match flags. */
  reset(): void {
    this.wiped.clear();
  }

  /* ------------------------------------------------------------ float bars */

  /** Take over any bar another system wrote into the schema since our last write. */
  adopt(p: PlayerState, rt: PlayerRuntime): void {
    if (p.hp !== barValue(rt.hp, MAX_HP)) rt.hp = p.hp;
    if (p.hunger !== barValue(rt.hunger, BAR_MAX)) rt.hunger = p.hunger;
    if (p.thirst !== barValue(rt.thirst, BAR_MAX)) rt.thirst = p.thirst;
    if (p.warmth !== barValue(rt.warmth, BAR_MAX)) rt.warmth = p.warmth;
  }

  /** Clamp the floats and write them to the schema. */
  write(p: PlayerState, rt: PlayerRuntime): void {
    rt.hp = Math.max(0, Math.min(MAX_HP, rt.hp));
    rt.hunger = Math.max(0, Math.min(BAR_MAX, rt.hunger));
    rt.thirst = Math.max(0, Math.min(BAR_MAX, rt.thirst));
    rt.warmth = Math.max(0, Math.min(BAR_MAX, rt.warmth));
    p.hp = barValue(rt.hp, MAX_HP);
    p.hunger = barValue(rt.hunger, BAR_MAX);
    p.thirst = barValue(rt.thirst, BAR_MAX);
    p.warmth = barValue(rt.warmth, BAR_MAX);
  }

  /** Set every bar (match start, respawn). */
  setBars(p: PlayerState, hp: number, bars: number): void {
    const rt = this.core.runtime.reset(p);
    rt.hp = hp;
    rt.hunger = bars;
    rt.thirst = bars;
    rt.warmth = bars;
    this.write(p, rt);
  }

  /** Eat / drink: add hunger, thirst and hp (capped). Returns what was actually gained. */
  feed(p: PlayerState, hunger: number, thirst: number, heal: number): { hunger: number; thirst: number } {
    const rt = this.core.runtime.of(p);
    this.adopt(p, rt);
    const h0 = rt.hunger;
    const t0 = rt.thirst;
    rt.hunger = Math.min(BAR_MAX, rt.hunger + Math.max(0, hunger));
    rt.thirst = Math.min(BAR_MAX, rt.thirst + Math.max(0, thirst));
    if (!p.downed) rt.hp = Math.min(MAX_HP, rt.hp + Math.max(0, heal));
    this.write(p, rt);
    return { hunger: Math.round(rt.hunger - h0), thirst: Math.round(rt.thirst - t0) };
  }

  /* ------------------------------------------------------------ damage */

  /** WorldContext.damagePlayer: no-op on downed / washed / boarded players; hp 0 → downed. */
  damage(p: PlayerState, amount: number, cause: HurtCause, byId: string): void {
    if (!p.alive || p.downed || p.boarded || p.spectator || !(amount > 0)) return;
    const core = this.core;
    const rt = core.runtime.of(p);
    this.adopt(p, rt);
    rt.hp = Math.max(0, rt.hp - amount);
    this.write(p, rt);
    core.emit({ type: "playerHurt", tick: core.tick(), playerId: p.id, amount, hp: p.hp, cause, byId, pos: posOf(p) });
    if (rt.hp <= 0) this.down(p, cause);
  }

  /** hp reached 0: downed (crawl, waits DOWNED_TICKS for a revive). */
  private down(p: PlayerState, cause: HurtCause): void {
    const core = this.core;
    core.fishing.cancel(p, "cancel");
    p.downed = true;
    p.downedTicks = DOWNED_TICKS;
    p.hp = 0;
    p.channel = CHANNEL.NONE;
    p.channelTicks = 0;
    p.channelTarget = -1;
    p.chargeTicks = 0;
    p.catchTicks = 0;
    p.sprinting = false;
    const rt = core.runtime.of(p);
    rt.hp = 0;
    rt.reviveTarget = "";
    rt.catchOpen = false;
    p.stats.downs = Math.min(65535, p.stats.downs + 1);
    core.emit({ type: "playerDowned", tick: core.tick(), playerId: p.id, cause, pos: posOf(p) });
  }

  /** A teammate finished the revive channel: back up with REVIVE_HP. False when `p` wasn't downed. */
  revive(p: PlayerState, byId: string): boolean {
    if (!p.alive || !p.downed) return false;
    const core = this.core;
    p.downed = false;
    p.downedTicks = 0;
    const rt = core.runtime.of(p);
    this.adopt(p, rt);
    rt.hp = REVIVE_HP;
    this.write(p, rt);
    core.emit({ type: "playerRevived", tick: core.tick(), playerId: p.id, byId, pos: posOf(p) });
    return true;
  }

  /* -------------------------------------------------------------- the tick */

  /** RaftWorld step 6 (only while the day clock runs). */
  step(clock: ClockInfo): void {
    const core = this.core;
    core.state.players.forEach((p) => {
      if (!p.alive || p.spectator) return;
      this.itemTimers(p);
      if (!p.alive || p.downed || p.boarded) return;
      this.bars(p, clock);
    });
    this.fires();
    for (const team of core.state.teams) if (team.spyglassTicks > 0) team.spyglassTicks--;
  }

  /** Torch burn and puffer fuse of the items a player carries. */
  private itemTimers(p: PlayerState): void {
    const core = this.core;
    if (heldKind(p) === "torch" && p.torchTicks > 0) {
      p.torchTicks--;
      if (p.torchTicks === 0) {
        core.bag.takeFromSlot(p, p.activeSlot, 1);
        core.lightsChanged();
      }
    }
    if (p.fuseTicks > 0) {
      if (countOf(p, "puffer") === 0) {
        core.bag.sync(p);
      } else if (--p.fuseTicks === 0) {
        core.bag.take(p, "puffer", 1);
        core.projectiles.blast(point(p.x, p.y + 1.2, p.z), p.id, p.team, true, p);
      }
    }
  }

  private bars(p: PlayerState, clock: ClockInfo): void {
    const core = this.core;
    const rt = core.runtime.of(p);
    this.adopt(p, rt);
    const site = core.site(p.team);
    const team = core.team(site.team);
    const weather = core.state.weather;
    const nearFire = team.fireFuel > 0 && dist2(p.x, p.z, site.campfire.x, site.campfire.z) <= FIRE_WARM_RADIUS * FIRE_WARM_RADIUS;
    const heatwave = weather === "heatwave";

    rt.hunger -= hungerDrainPerTick(core.difficulty, core.timings.barMult, p.sprinting);
    rt.thirst -= thirstDrainPerTick(core.difficulty, core.timings.barMult, heatwave, heatwave && this.inShade(p));
    rt.warmth +=
      warmthPerSec({
        nearFire,
        nightChill: clock.dayPhase === "night" && BIOMES[core.state.biome].nightChill,
        rainChill: weather === "rain" && !this.sheltered(p, site),
        waterChill: p.swimming && CHARACTERS[p.character].waterChill,
        litTorch: heldKind(p) === "torch" && p.torchTicks > 0,
        daylight: clock.dayPhase === "day",
      }) * DT;
    if (nearFire) rt.hp += FIRE_HEAL_PER_SEC * DT;
    this.write(p, rt);

    rt.secTicks++;
    if (rt.secTicks >= TICK_RATE) {
      rt.secTicks = 0;
      if (rt.hunger <= 0) this.damage(p, EMPTY_BAR_DAMAGE_PER_SEC, "hunger", "");
      if (rt.thirst <= 0) this.damage(p, EMPTY_BAR_DAMAGE_PER_SEC, "thirst", "");
      if (rt.warmth <= 0) this.damage(p, EMPTY_BAR_DAMAGE_PER_SEC, "cold", "");
      if (p.swimTicks > DROWN_TICKS) this.damage(p, DROWN_DAMAGE_PER_SEC, "drown", "");
      if (heldKind(p) === "jellyfish") this.damage(p, JELLYFISH_DAMAGE_PER_SEC, "jellyfish", "");
    }
    if (!p.downed) this.lowBars(p, rt);
  }

  /** One `lowBar` line per dip below LOW_BAR_FRACTION (re-armed above LOW_BAR_REARM_FRACTION). */
  private lowBars(p: PlayerState, rt: PlayerRuntime): void {
    for (const bar of LOW_BARS) {
      const max = bar === "hp" ? MAX_HP : BAR_MAX;
      const v = rt[bar] / max;
      if (rt.lowArmed[bar] && v < LOW_BAR_FRACTION) {
        rt.lowArmed[bar] = false;
        this.core.emit({ type: "lowBar", tick: this.core.tick(), playerId: p.id, bar });
      } else if (!rt.lowArmed[bar] && v >= LOW_BAR_REARM_FRACTION) {
        rt.lowArmed[bar] = true;
      }
    }
  }

  /** Under a tree / palm crown (heat wave shade). */
  private inShade(p: PlayerState): boolean {
    const n = this.core.cover.query(p.x, p.z, SHADE_RADIUS, this.scratch);
    for (let i = 0; i < n; i++) {
      const k = this.scratch[i]!.kind;
      if (k === "tree" || k === "palm") return true;
    }
    return false;
  }

  /** Out of the rain: inside the cave or by a hut of the player's team. */
  sheltered(p: { x: number; z: number; team: number }, site: IslandSite): boolean {
    const cave = site.cave;
    if (cave && dist2(p.x, p.z, cave.x, cave.z) <= (cave.radius > 0 ? cave.radius : SHELTER_RADIUS) ** 2) return true;
    return this.hutNear(p.x, p.z, p.team);
  }

  private hutNear(x: number, z: number, team: number): boolean {
    let found = false;
    this.core.state.structures.forEach((s) => {
      if (!found && s.kind === "hut" && s.team === team && dist2(x, z, s.x, s.z) <= SHELTER_RADIUS * SHELTER_RADIUS) found = true;
    });
    return found;
  }

  /* ----------------------------------------------------------------- fire */

  private fires(): void {
    const core = this.core;
    const raining = core.state.weather === "rain";
    for (const site of core.island.sites) {
      const team = core.team(site.team);
      if (team.fireFuel <= 0) continue;
      // Only a (duel) hut keeps the rain off the campfire (§2.7: not in coop).
      const drain = raining && !this.hutNear(site.campfire.x, site.campfire.z, site.team) ? RAIN_FIRE_DRAIN_MULT : 1;
      const before = team.fireFuel;
      team.fireFuel = Math.max(0, before - drain);
      if (team.fireFuel === 0) {
        core.emit({ type: "fireFuel", tick: core.tick(), team: site.team, playerId: "", added: -before, fuel: 0, source: "out" });
        core.lightsChanged();
      }
    }
  }

  /** WorldContext.addFireFuel: capped at FIRE_FUEL_MAX_TICKS; feeding a dead fire relights it ("relit"). */
  addFuel(teamIdx: number, ticks: number, byId: string, source: FireFuelEvent["source"]): void {
    const core = this.core;
    const team = core.team(teamIdx);
    const before = team.fireFuel;
    const after = Math.min(FIRE_FUEL_MAX_TICKS, before + Math.max(0, Math.floor(ticks)));
    team.fireFuel = after;
    const relit = before === 0 && after > 0;
    core.emit({ type: "fireFuel", tick: core.tick(), team: teamIdx, playerId: byId, added: after - before, fuel: after, source: relit ? "relit" : source });
    if (relit) core.lightsChanged();
  }

  /* ---------------------------------------------------- downed & washed */

  /** RaftWorld step 7: downed timers run out → washed ashore; everyone washed with no dawn coming → teamWiped. */
  stepDowned(clock: ClockInfo): void {
    const core = this.core;
    core.state.players.forEach((p) => {
      if (!p.alive || !p.downed) return;
      if (p.downedTicks > 0) p.downedTicks--;
      if (p.downedTicks === 0) this.wash(p, clock);
    });
    if (clock.day < DAYS) return;
    for (const site of core.island.sites) {
      if (this.wiped.has(site.team)) continue;
      const parts = core.participants(site.team);
      if (parts.length === 0 || !parts.every((q) => q.washed && !q.alive)) continue;
      this.wiped.add(site.team);
      core.emit({ type: "teamWiped", tick: core.tick(), team: site.team });
    }
  }

  /** "Dalgalar seni kıyıya attı": inventory lost, out until the next dawn. */
  wash(p: PlayerState, clock: ClockInfo | null): void {
    const core = this.core;
    core.fishing.cancel(p, "cancel");
    core.bag.clear(p);
    p.alive = false;
    p.washed = true;
    p.downed = false;
    p.downedTicks = 0;
    p.boarded = false;
    p.channel = CHANNEL.NONE;
    p.channelTicks = 0;
    p.channelTarget = -1;
    p.chargeTicks = 0;
    p.catchTicks = 0;
    p.vx = 0;
    p.vy = 0;
    p.vz = 0;
    core.lightsChanged();
    const day = clock?.day ?? core.state.day;
    core.emit({ type: "playerWashed", tick: core.tick(), playerId: p.id, pos: posOf(p), willRespawn: day < DAYS });
  }

  /** Dawn: every washed participant wakes up at the wreck. */
  respawnWashed(): void {
    this.core.state.players.forEach((p) => {
      if (p.washed && !p.spectator) this.respawn(p);
    });
  }

  /** Put `p` back at its spawn by the wreck with RESPAWN_BARS (emits playerRespawn). */
  respawn(p: PlayerState): void {
    const core = this.core;
    this.placeAtSpawn(p);
    p.washed = false;
    p.alive = true;
    this.setBars(p, RESPAWN_HP, RESPAWN_BARS);
    core.emit({ type: "playerRespawn", tick: core.tick(), playerId: p.id, pos: posOf(p) });
  }

  /** Fresh sim state at the player's spawn point, facing the campfire (alive is left false). */
  placeAtSpawn(p: PlayerState): void {
    const core = this.core;
    const site = core.site(p.team);
    copyPlayerSim(createPlayerSim(), p);
    core.bag.clear(p);
    const spawns = site.spawns.length > 0 ? site.spawns : [site.wreck];
    const sp = spawns[((p.seat % spawns.length) + spawns.length) % spawns.length]!;
    p.x = sp.x;
    p.z = sp.z;
    p.y = heightAt(core.island.grid, sp.x, sp.z);
    p.yaw = yawFromDir(site.campfire.x - sp.x, site.campfire.z - sp.z);
    p.pitch = 0;
    p.grounded = true;
    p.downedTicks = 0;
    p.fishState = 0;
    p.fishSpot = -1;
    core.runtime.reset(p);
  }
}
