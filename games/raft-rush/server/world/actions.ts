// What a player DID this tick: the server side of every StepPlayerResult (docs/ARCHITECTURE.md §2.1–2.3, §4.3
// step 2, §4.4). Owner: server-world.
//
// Order per player (right after stepPlayer): E press (resolveInteraction: tap kinds execute, hold kinds start a
// channel; craft / chest are client panels) → channel completion (one gather unit / the revive) → LMB use (rod
// → FishingSystem.use, torch swing, place a structure, palm shake, punch) → throw / toss release (one unit of the
// slot; a tossed torch is planted; a coconut ball releases 3 coconuts) → eat (F) → catch window (RMB).
// The FishingSystem reels a line in by itself when the fisher walks away, switches slot or goes down (its
// step() runs right after the players), and emits its own fishing rejects.

import {
  BAR_MAX,
  CHANNEL,
  CHARACTERS,
  COLLECTOR_WATER,
  EAT_HEAL,
  INTERACT_RANGE,
  MVP_POINTS,
  REVIVE_RANGE,
  REVIVE_TICKS,
  SPRING_WATER,
  TORCH_SWING_RANGE,
  TORCH_SWING_SCARE_TICKS,
} from "../../shared/constants.js";
import { isCooked, ITEMS } from "../../shared/items.js";
import type { InputCmd } from "../../shared/protocol.js";
import { emptyInteraction, gatherTicksFor, resolveInteraction } from "../../shared/rules/interact.js";
import { countOf, roomFor, slotKind } from "../../shared/rules/inventory.js";
import { heldKind, type StepPlayerResult, type ThrowRequest } from "../../shared/sim/player.js";
import { computeThrowVelocities, projectileKindForThrow } from "../../shared/sim/throw.js";
import type { Vec3Like } from "../../shared/types.js";
import type { PlayerState } from "./context.js";
import type { WorldCore } from "./core.js";
import type { PlayerRuntime } from "./runtime.js";
import { dist2, point, posOf, RANGE_SLACK } from "./rules.js";

export class ActionSystem {
  private readonly it = emptyInteraction();

  constructor(private readonly core: WorldCore) {}

  /** Act on one player's step result. */
  handle(p: PlayerState, cmd: InputCmd, res: StepPlayerResult): void {
    const rt = this.core.runtime.of(p);
    if (res.interactPressed) this.interact(p, rt);
    this.channel(p, rt);
    if (res.used) this.use(p);
    if (res.throw) this.release(p, res.throw, cmd.seq);
    if (res.eat) this.eat(p);
    if (res.catchStarted) rt.catchOpen = true;
    else if (p.catchTicks === 0) rt.catchOpen = false;
  }

  /* ------------------------------------------------------------- E (press) */

  private interact(p: PlayerState, rt: PlayerRuntime): void {
    const core = this.core;
    // The sim reports a press even while channeling (a re-latched E): the running channel just continues.
    if (p.channel !== CHANNEL.NONE) return;
    const it = resolveInteraction({ island: core.island, state: core.state }, p, this.it);
    if (!it || it.kind === "craft" || it.kind === "chest") return;
    if (!it.ok) {
      // A greyed-out raft says why under the same action raft.deliver() / board() use.
      core.reject(p, it.kind === "deliver" || it.kind === "board" ? it.kind : "interact", it.reason, it.kind);
      return;
    }
    switch (it.kind) {
      case "revive": {
        const q = core.state.players.get(it.playerId);
        if (!q) return;
        this.startChannel(p, CHANNEL.REVIVE, q.seat);
        rt.reviveTarget = q.id;
        return;
      }
      case "gather":
        this.startChannel(p, CHANNEL.GATHER, it.node);
        rt.reviveTarget = "";
        return;
      case "pickup":
        this.pickup(p, it.projectileId);
        return;
      case "collectCrab":
        this.collectCrab(p, it.monsterId);
        return;
      case "board":
        core.raft.board(p);
        return;
      case "deliver":
        core.raft.deliver(p);
        return;
      case "spring":
        this.spring(p);
        return;
      case "collector":
        this.collector(p, it.structureId);
        return;
      case "secretChest":
        this.secretChest(p);
        return;
    }
  }

  private startChannel(p: PlayerState, channel: number, target: number): void {
    p.channel = channel;
    p.channelTicks = 0;
    p.channelTarget = target;
  }

  private clearChannel(p: PlayerState, rt: PlayerRuntime): void {
    p.channel = CHANNEL.NONE;
    p.channelTicks = 0;
    p.channelTarget = -1;
    rt.reviveTarget = "";
  }

  /** Hold-E channels: one gather unit per completion (restarts while the node lasts) / the revive. */
  private channel(p: PlayerState, rt: PlayerRuntime): void {
    const core = this.core;
    if (p.channel === CHANNEL.NONE) {
      rt.reviveTarget = "";
      return;
    }
    if (p.channel === CHANNEL.GATHER) {
      const node = core.island.nodes[p.channelTarget];
      const reach = node ? INTERACT_RANGE + node.radius + RANGE_SLACK : 0;
      if (!node || core.nodes.amount(node.i) <= 0 || dist2(p.x, p.z, node.x, node.z) > reach * reach) {
        this.clearChannel(p, rt);
        return;
      }
      if (p.channelTicks < gatherTicksFor(node, countOf(p, "axe") > 0)) return;
      core.nodes.gatherUnit(p, node);
      if (core.nodes.amount(node.i) > 0) p.channelTicks = 0;
      else this.clearChannel(p, rt);
      return;
    }
    if (p.channel === CHANNEL.REVIVE) {
      const q = rt.reviveTarget ? core.state.players.get(rt.reviveTarget) : undefined;
      const reach = REVIVE_RANGE + RANGE_SLACK;
      if (!q || !q.alive || !q.downed || dist2(p.x, p.z, q.x, q.z) > reach * reach) {
        this.clearChannel(p, rt);
        return;
      }
      if (p.channelTicks < REVIVE_TICKS) return;
      if (core.survival.revive(q, p.id)) {
        p.stats.revives = Math.min(65535, p.stats.revives + 1);
        core.addScore(p, MVP_POINTS.revive);
      }
      this.clearChannel(p, rt);
      return;
    }
    this.clearChannel(p, rt);
  }

  private pickup(p: PlayerState, id: string): void {
    const core = this.core;
    const b = core.state.projectiles.get(id);
    if (!b || (b.state !== "rest" && b.state !== "stuck")) return;
    if (core.bag.stow(p, b.kind, 1) < 1) {
      core.reject(p, "interact", "full", "pickup");
      return;
    }
    const pos = posOf(b);
    const kind = b.kind;
    core.projectiles.remove(id);
    core.emit({ type: "pickup", tick: core.tick(), playerId: p.id, kind, count: 1, pos, projectileId: id, source: "ground" });
    core.weather.onPickup(p, id);
  }

  /** MonsterSystem.collect removes the crab (monsterDie collected) and gives the raw crab (pickup "crab"). */
  private collectCrab(p: PlayerState, monsterId: string): void {
    const m = this.core.state.monsters.get(monsterId);
    if (m) this.core.monsters.collect(m, p);
  }

  /** The spring: a water gourd, or a drink when the pockets are full. */
  private spring(p: PlayerState): void {
    const core = this.core;
    if (roomFor(p, "water") > 0) {
      core.giveItem(p, "water", 1, "spring");
      return;
    }
    if (p.thirst >= BAR_MAX) {
      core.reject(p, "interact", "full", "spring");
      return;
    }
    const gained = core.survival.feed(p, 0, SPRING_WATER, 0);
    core.emit({ type: "eat", tick: core.tick(), playerId: p.id, kind: "spring", hunger: 0, thirst: gained.thirst, pos: posOf(p) });
  }

  private collector(p: PlayerState, id: string): void {
    const core = this.core;
    const s = core.state.structures.get(id);
    if (!s || s.kind !== "collector" || s.uses <= 0) {
      core.reject(p, "interact", "empty", "collector");
      return;
    }
    s.uses--;
    const gained = core.survival.feed(p, 0, COLLECTOR_WATER, 0);
    core.emit({ type: "eat", tick: core.tick(), playerId: p.id, kind: "collector", hunger: 0, thirst: gained.thirst, pos: posOf(p) });
  }

  /** The secret chest (revealed by a bottle): two treasure reels, once per match. */
  private secretChest(p: PlayerState): void {
    const core = this.core;
    const team = core.team(core.site(p.team).team);
    if (!team.secretRevealed || team.secretOpened) return;
    team.secretOpened = true;
    core.fishing.treasureReel(p, "secretChest");
    core.fishing.treasureReel(p, "secretChest");
  }

  /* ------------------------------------------------------------------ LMB use */

  private use(p: PlayerState): void {
    const core = this.core;
    const held = heldKind(p);
    if (held === "rod") {
      // Cast / strike / early miss; FishingSystem emits its own reject ("noSpot" / "busy") when it can't.
      core.fishing.use(p);
      return;
    }
    if (held === "torch" && p.torchTicks > 0) {
      const pos = point(p.x - Math.sin(p.yaw), p.y + 1, p.z - Math.cos(p.yaw));
      core.monsters.scare(pos, TORCH_SWING_RANGE, TORCH_SWING_SCARE_TICKS);
      core.emit({ type: "use", tick: core.tick(), playerId: p.id, what: "torchSwing", pos });
      return;
    }
    if (held !== "" && ITEMS[held].places) {
      core.structures.place(p, p.activeSlot);
      return;
    }
    const palm = core.nodes.palmInReach(p);
    if (palm) {
      core.nodes.shakePalm(p, palm, held === "axe");
      return;
    }
    core.emit({ type: "use", tick: core.tick(), playerId: p.id, what: "punch", pos: point(p.x - Math.sin(p.yaw) * 0.8, p.y + 1.2, p.z - Math.cos(p.yaw) * 0.8) });
  }

  /* --------------------------------------------------------- throws & tosses */

  private release(p: PlayerState, req: ThrowRequest, seq: number): void {
    const core = this.core;
    // The server's inventory is the truth: a release the prediction got wrong is dropped silently.
    if (slotKind(p, req.slot) !== req.kind) return;
    if (req.toss && req.kind === "torch") {
      core.structures.plantTorch(p, req.slot);
      return;
    }
    core.bag.takeFromSlot(p, req.slot, 1);
    const kind = projectileKindForThrow(req.kind);
    const ids: string[] = [];
    const velocities: Vec3Like[] = [];
    for (const v of computeThrowVelocities(req)) {
      const b = core.spawnProjectile(kind, req.origin, v, {
        ownerId: p.id,
        team: p.team,
        state: req.toss ? "loose" : "live",
        throwSeq: seq,
        charge: req.charge,
      });
      if (!b) continue;
      ids.push(b.id);
      velocities.push(posOf(v));
    }
    if (ids.length === 0) return;
    core.emit({
      type: "throw",
      tick: core.tick(),
      ownerId: p.id,
      throwSeq: seq,
      projectileIds: ids,
      kind: req.kind,
      charge: req.charge,
      toss: req.toss,
      origin: posOf(req.origin),
      velocities,
    });
  }

  /* ---------------------------------------------------------------------- F */

  private eat(p: PlayerState): void {
    const core = this.core;
    const held = heldKind(p);
    if (held === "") {
      core.reject(p, "eat", "empty");
      return;
    }
    const def = ITEMS[held];
    if (def.food <= 0 && def.water <= 0) return;
    core.bag.takeFromSlot(p, p.activeSlot, 1);
    const food = def.food > 0 ? def.food + (isCooked(held) ? CHARACTERS[p.character].cookedBonus : 0) : 0;
    const gained = core.survival.feed(p, food, def.water, food > 0 ? EAT_HEAL : 0);
    if (food > 0) p.stats.eaten = Math.min(65535, p.stats.eaten + 1);
    if (held === "coconut") p.stats.coconuts = Math.min(65535, p.stats.coconuts + 1);
    if (held === "fish_golden") {
      p.golden = true;
      core.addScore(p, MVP_POINTS.golden);
    }
    core.emit({ type: "eat", tick: core.tick(), playerId: p.id, kind: held, hunger: gained.hunger, thirst: gained.thirst, pos: posOf(p) });
  }
}
