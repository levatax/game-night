// Server-side helper bots (§12): real player seats (bot = true) driven by synthesized InputCmds through the
// exact same input queue, stepPlayer, collisions and rules as humans, plus the same craft / chest actions a
// human's messages trigger. Owner: server-bots.
//
// BotDesk (this file) decides WHEN a bot thinks (BOT_THINK_MIN_SEC..BOT_THINK_MAX_SEC per decision, sooner when
// something happens to it: a finished goal, damage, a puffer in the pocket, a monster closing in, dusk) and keeps
// one Motor per seat that turns the current Goal into exactly one InputCmd per tick (botMotor.ts: steering,
// aiming, holding E, charging throws). The DECISIONS are pure functions in botBrain.ts (chooseGoal, steer,
// aimAt), unit-tested; botSense.ts builds their input view from the state. Every random pick uses the host's bot
// rng (never Math.random) and the desk clock is the number of ticks seen (never Date.now), so seeded tests stay
// deterministic. The desk also drives a disconnected human's seat during the reconnect window (role picked from
// the character, roleForCharacter) and hands it back on reconnection, and takes over seats of players who left
// mid-match for good; input seqs continue from the seat's lastSeq so they stay strictly increasing.
//
// A reconnect stand-in (add(id, role, { standIn: true })) keeps the absent player's character safe and spends
// nothing of theirs. The desk enforces it on three levels, not only by goal choice: the goal comes from the
// stand-in menu (chooseStandInGoal, filtered by STAND_IN_GOALS), the motor's craft / chest calls are refused, and
// every queued InputCmd is masked (standInButtons: movement, plus E only where it revives or boards once the
// server has turned and moved the seat with that command, standInE). Stand-ins take no team duty, send no
// emotes / markers, and are re-planned from scratch when a later add() turns the seat into a full bot (takeOver)
// or back.
//
// Flavor (§14): a downed bot pings "Yardım!", the first bot to spot Kaptan Yengeç pings "Tehlike!" and may
// panic, someone dances when the raft is ready, a revive earns a clap, a Fenomen at camp sometimes takes a selfie.
//
// Memory stays bounded over a match (monster, projectile and node ids come and go every night): expired goal
// blocks are pruned on every think, monster tracks and bosses seen are dropped once their monster is gone, and
// everything is cleared on reset() / when the last seat leaves.

import { BOT_THINK_MAX_SEC, BOT_THINK_MIN_SEC, CHANNEL, DT, NORMAL_TIMINGS, PITCH_LIMIT, secToTicks } from "../../shared/constants.js";
import { BTN, BUTTON_MASK, type ChestMsg, type EmoteMsg, type InputCmd, type MarkerMsg } from "../../shared/protocol.js";
import { emptyInteraction, resolveInteraction, type InteractWorld } from "../../shared/rules/interact.js";
import { slotKind } from "../../shared/rules/inventory.js";
import { inputLocked, simulatedPhase } from "../../shared/rules/schedule.js";
import type { SimContext, WorldQuery } from "../../shared/sim/context.js";
import { clamp, wrapAngle } from "../../shared/sim/math.js";
import { copyPlayerSim, createPlayerSim, emptyStepResult, stepPlayerInto } from "../../shared/sim/player.js";
import type { BotRole, CharacterId, EmoteId, RecipeId } from "../../shared/types.js";
import type { PlayerState, RaftState } from "../schema.js";
import type { RaftWorld } from "../world/World.js";
import { chooseGoal, chooseStandInGoal, isHostile, STAND_IN_GOALS } from "./botBrain.js";
import { Motor, posed, type MotorCtx, type MotorFrame } from "./botMotor.js";
import { fishStandsFor, navFor } from "./botNav.js";
import { buildView } from "./botSense.js";
import { newSteerMemory, type SteerMemory, type SteerWorld } from "./botSteer.js";
import { goalKey, type BotClaims, type BotView, type Goal } from "./botTypes.js";

/** What the desk may see and do. Every action is validated like a human message. */
export interface BotHost {
  readonly state: RaftState;
  readonly world: RaftWorld;
  /** The room's bot rng (re-seeded per match; separate from the gameplay rng). */
  rng(): number;
  queueInput(id: string, cmd: InputCmd): void;
  craft(id: string, recipe: RecipeId): boolean;
  chest(id: string, msg: ChestMsg): boolean;
  emote(id: string, msg: EmoteMsg): boolean;
  marker(id: string, msg: MarkerMsg): boolean;
}

/** How BotDesk.add drives a seat. */
export interface BotSeatOptions {
  /**
   * Reconnect stand-in for a dropped human (RECONNECT_GRACE_SEC): the bot only moves, flees, keeps to the light,
   * revives and boards. It never spends, tosses, delivers or crafts the absent player's inventory.
   */
  standIn?: boolean;
}

/**
 * Role a bot plays when it drives a human's seat (reconnect stand-in or a leaver's seat), by character: the only
 * character → role table (the room imports it). game4.md §12 names the four roles but pairs none with a tourist,
 * so the tourists with a working perk (§14) get the role it helps: Kaptan's raft delivery bonus → Hamal, Şef's
 * cooking → Aşçı, Gelin, the fastest swimmer → Balıkçı (the fish spots lie off the coast). The cosmetic ones fill
 * the rest: Amca guards (Bekçi), Fenomen cooks (Aşçı), Çocuk hauls (Hamal).
 */
export const ROLE_BY_CHARACTER: Readonly<Record<CharacterId, BotRole>> = {
  kaptan: "hamal",
  fenomen: "asci",
  amca: "bekci",
  gelin: "balikci",
  sef: "asci",
  cocuk: "hamal",
};

/** ROLE_BY_CHARACTER lookup (Hamal for anything unknown). */
export function roleForCharacter(character: CharacterId): BotRole {
  return ROLE_BY_CHARACTER[character] ?? "hamal";
}

/** How long a failed goal stays off the menu, by failure reason (seconds). */
const BLOCK_SEC: Readonly<Record<string, number>> = {
  unreachable: 20,
  blocked: 10,
  refused: 6,
  outOfRange: 1.5,
  full: 4,
  gone: 2,
  noChannel: 8,
  nothingDelivered: 12,
  station: 5,
  noShot: 1.5,
};
const DEFAULT_BLOCK_SEC = 8;
/** No two bot emotes / pings within this many ticks (they shouldn't chatter over each other). */
const CHATTER_GAP_TICKS = secToTicks(3);

/** Buttons a reconnect stand-in's motor may pass through: movement, and E (checked again by standInButtons). */
const STAND_IN_KEEP = BTN.JUMP | BTN.SPRINT | BTN.INTERACT | BTN.INTERACT_PRESS;

/**
 * The buttons a reconnect stand-in may send for seat `p`, from what its motor asked for (`buttons`) and whether E
 * would revive a teammate or board the raft (`eOk`, standInE). Everything that spends, moves or adds an item is
 * dropped (THROW, USE_PRESS, CATCH, DROP, EAT, the slot keys); INTERACT only keeps a revive channel going (a
 * gather the player started is let go, even when E is pressed for something else: the server ignores a press
 * during a channel, and holding E would chop on). The desk adds one slot press of its own: a stinging jellyfish
 * leaves the hand, and a charge the player held when they dropped is cancelled by a slot change (just letting go
 * of THROW would throw it) — to an empty slot first, never onto a torch (a held torch burns down); with no such
 * slot THROW stays held so the charge never releases.
 */
export function standInButtons(buttons: number, p: PlayerState, eOk: boolean): number {
  let b = buttons & STAND_IN_KEEP;
  if (b & BTN.INTERACT_PRESS) {
    if (!eOk || p.channel === CHANNEL.GATHER) b &= ~(BTN.INTERACT_PRESS | BTN.INTERACT);
  } else if (p.channel !== CHANNEL.REVIVE) b &= ~BTN.INTERACT;
  const held = slotKind(p, p.activeSlot);
  if (held !== "jellyfish" && p.chargeTicks === 0) return b;
  let to = -1;
  for (let i = 0; i < 4; i++) {
    if (i === p.activeSlot) continue;
    const kind = slotKind(p, i);
    if (kind === "") {
      to = i;
      break;
    }
    if (to < 0 && kind !== "jellyfish" && kind !== "torch") to = i;
  }
  if (to >= 0) return b | (BTN.SLOT1 << to);
  return p.chargeTicks > 0 ? b | BTN.THROW : b;
}

/** Scratch for standInE: one tick's look-ahead of a seat. */
const ahead = { sim: createPlayerSim(), step: emptyStepResult(), it: emptyInteraction() };

/**
 * E in command `cmd` would revive a teammate or board the raft for seat `p`. The server applies the command first
 * (stepPlayer: the new look, this tick's movement) and resolves E after, so this steps a copy of the seat's sim
 * state with `cmd` and resolves E from where that leaves it. Judged from the state's own pose instead, an item
 * that comes into the view cone during the last turn step would be picked up (pickup outranks board). `query` is
 * the world's terrain / cover / bounds; input is never locked here (the desk sends no buttons while it is).
 */
export function standInE(w: InteractWorld, query: WorldQuery, p: PlayerState, cmd: InputCmd): boolean {
  const sim = copyPlayerSim(p, ahead.sim);
  const ctx: SimContext = { terrain: query.terrain, cover: query.cover, bounds: query.bounds, character: p.character, dt: DT, locked: false };
  stepPlayerInto(sim, cmd, ctx, ahead.step);
  const it = resolveInteraction(w, posed(p, sim.x, sim.y, sim.z, sim.yaw), ahead.it);
  return !!it && it.ok && (it.kind === "revive" || it.kind === "board");
}

/** A stand-in's goal: chooseStandInGoal, filtered by STAND_IN_GOALS (anything else idles). */
function standInGoal(view: BotView): Goal {
  const goal = chooseStandInGoal(view);
  return STAND_IN_GOALS.has(goal.kind) ? goal : { kind: "idle" };
}

interface Seat {
  id: string;
  role: BotRole;
  /** Reconnect stand-in (BotSeatOptions.standIn): moves, never spends. */
  standIn: boolean;
  /** Last InputCmd seq sent (strictly increasing). */
  seq: number;
  goal: Goal | null;
  key: string;
  motor: Motor | null;
  /** The motor's end (done / failed) was handled. */
  settled: boolean;
  mem: SteerMemory;
  /** Desk tick of the next decision. */
  nextThink: number;
  /** Goal key → desk tick it stays blocked until. */
  blocked: Map<string, number>;
  lastHp: number;
  lastPhase: string;
  lastStage: number;
  helpPinged: boolean;
}

export class BotDesk {
  private seats = new Map<string, Seat>();
  /** Desk clock: ticks seen. */
  private clock = 0;
  /** Monster tracking for leading throws: last position + smoothed ground velocity. */
  private tracks = new Map<string, { x: number; z: number; vx: number; vz: number }>();
  private lastChatter = -Infinity;
  /** Bosses some bot already called out ("Tehlike!"), by monster id. */
  private bossSpotted = new Set<string>();
  private cheeredRaft = false;

  constructor(private host: BotHost) {}

  get size(): number {
    return this.seats.size;
  }

  /**
   * Start driving seat `id` with personality `role` (lobby bot, reconnect stand-in or a leaver's seat). Adding a
   * seat the desk already drives with another role or another `standIn` (a stand-in becoming the leaver's bot)
   * drops its plan and memory; the input seq carries on.
   */
  add(id: string, role: BotRole, opts: BotSeatOptions = {}): void {
    const standIn = opts.standIn === true;
    const existing = this.seats.get(id);
    if (existing) {
      if (existing.role !== role || existing.standIn !== standIn) {
        existing.role = role;
        existing.standIn = standIn;
        this.forget(existing, this.host.state.players.get(id)?.hp ?? 100);
      }
      return;
    }
    const p = this.host.state.players.get(id);
    this.seats.set(id, {
      id,
      role,
      standIn,
      seq: p ? p.lastSeq : 0,
      goal: null,
      key: "",
      motor: null,
      settled: true,
      mem: newSteerMemory(),
      nextThink: this.clock + 1 + Math.floor(this.host.rng() * 10),
      blocked: new Map(),
      lastHp: p ? p.hp : 100,
      lastPhase: "",
      lastStage: -1,
      helpPinged: false,
    });
  }

  /** Stop driving `id` (human reconnected, bot removed in the lobby). */
  remove(id: string): void {
    this.seats.delete(id);
    if (!this.seats.size) {
      this.tracks.clear();
      this.bossSpotted.clear();
    }
  }

  has(id: string): boolean {
    return this.seats.has(id);
  }

  /** Personality of a driven seat (undefined when the desk doesn't drive it). */
  roleOf(id: string): BotRole | undefined {
    return this.seats.get(id)?.role;
  }

  /** The desk drives `id` as a reconnect stand-in (BotSeatOptions.standIn). */
  isStandIn(id: string): boolean {
    return this.seats.get(id)?.standIn === true;
  }

  /** Sizes of the desk's memory: goal blocks (all seats), monster tracks, bosses seen (tests: nothing piles up). */
  footprint(): { blocked: number; tracks: number; bossSpotted: number } {
    let blocked = 0;
    for (const s of this.seats.values()) blocked += s.blocked.size;
    return { blocked, tracks: this.tracks.size, bossSpotted: this.bossSpotted.size };
  }

  /** Current goal key of a driven seat ("" when none), for debugging and the balance harness. */
  goalOf(id: string): string {
    const s = this.seats.get(id);
    return s && s.motor && s.motor.status === "running" ? s.key : "";
  }

  /** New match: forget plans and memory, keep seats (seqs keep increasing). */
  reset(): void {
    this.tracks.clear();
    this.bossSpotted.clear();
    this.cheeredRaft = false;
    this.lastChatter = -Infinity;
    for (const s of this.seats.values()) this.forget(s, 100);
  }

  /** Drop a seat's plan and memory (it thinks again within 10 ticks); its seq and mandate stay. */
  private forget(s: Seat, hp: number): void {
    s.goal = null;
    s.key = "";
    s.motor = null;
    s.settled = true;
    s.mem = newSteerMemory();
    s.nextThink = this.clock + 1 + Math.floor(this.host.rng() * 10);
    s.blocked.clear();
    s.lastHp = hp;
    s.lastPhase = "";
    s.lastStage = -1;
    s.helpPinged = false;
  }

  /** Called once per fixed tick BEFORE world.step(): queue one InputCmd per driven seat. */
  tick(): void {
    this.clock++;
    const state = this.host.state;
    if (!this.seats.size || !simulatedPhase(state.phase)) return;
    this.trackMonsters();
    const w = this.host.world;
    const query = { terrain: w.island.grid, cover: w.cover, bounds: w.island.bounds };
    const sw: SteerWorld = { ...query, nav: navFor(w.island, query) };
    for (const seat of this.seats.values()) {
      const p = state.players.get(seat.id);
      if (!p || !p.alive) continue;
      seat.seq = Math.max(seat.seq, p.lastSeq) + 1;
      const f = this.drive(seat, p, sw);
      const cmd: InputCmd = {
        seq: seat.seq,
        moveX: clamp(f.moveX, -1, 1),
        moveZ: clamp(f.moveZ, -1, 1),
        yaw: wrapAngle(f.yaw),
        pitch: clamp(f.pitch, -PITCH_LIMIT, PITCH_LIMIT),
        buttons: f.buttons & BUTTON_MASK,
      };
      if (seat.standIn) {
        // A stand-in's input is masked whatever its goal asked for (see standInButtons); E is judged on the
        // command as it will be sent with it.
        cmd.buttons = standInButtons(f.buttons, p, true) & BUTTON_MASK;
        if (cmd.buttons & BTN.INTERACT_PRESS && !standInE({ island: w.island, state }, sw, p, cmd)) {
          cmd.buttons = standInButtons(f.buttons, p, false) & BUTTON_MASK;
        }
      }
      this.host.queueInput(seat.id, cmd);
    }
  }

  /* ============================================================ driving */

  private drive(seat: Seat, p: PlayerState, sw: SteerWorld): MotorFrame {
    const state = this.host.state;
    const out: MotorFrame = { moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0 };
    if (inputLocked(state.phase, state.phaseTicksLeft, this.host.world.timings) || p.boarded) return out;
    this.react(seat, p);
    if (this.clock >= seat.nextThink || !seat.motor) this.think(seat, p, sw);
    const motor = seat.motor;
    if (!motor) return out;
    motor.tick(this.motorCtx(seat, p, sw), p, out);
    if (motor.status !== "running" && !seat.settled) {
      seat.settled = true;
      if (motor.status === "failed") {
        const sec = BLOCK_SEC[motor.reason] ?? DEFAULT_BLOCK_SEC;
        seat.blocked.set(seat.key, this.clock + secToTicks(sec));
      } else if (motor.goal.kind === "revive") {
        this.chatter(seat.id, "clap", 0.4);
      }
      this.soon(seat, 4, 10);
    }
    return out;
  }

  private motorCtx(seat: Seat, p: PlayerState, sw: SteerWorld): MotorCtx {
    const h = this.host;
    return {
      state: h.state,
      island: h.world.island,
      world: sw,
      timings: h.world.timings,
      role: seat.role,
      rng: () => h.rng(),
      // A stand-in's goals never craft or use the chest; refused here as well, so no stray goal can.
      craft: (recipe) => !seat.standIn && h.craft(p.id, recipe),
      chest: (msg) => !seat.standIn && h.chest(p.id, msg),
      velocity: (id) => this.tracks.get(id),
      fishStands: () => fishStandsFor(h.world.island, sw),
    };
  }

  private think(seat: Seat, p: PlayerState, sw: SteerWorld): void {
    const h = this.host;
    // Expired blocks go now: their keys name monsters, projectiles and nodes that come and go all match.
    for (const [key, until] of seat.blocked) if (until <= this.clock) seat.blocked.delete(key);
    const running = seat.motor && seat.motor.status === "running" ? seat.goal : null;
    const view = buildView({
      state: h.state,
      island: h.world.island,
      timings: h.world.timings,
      query: sw,
      id: seat.id,
      role: seat.role,
      roles: this.roles(),
      standIns: this.standIns(),
      velocity: this.tracks,
      claims: this.claimsFor(seat.id),
      blocked: (key) => (seat.blocked.get(key) ?? -1) > this.clock,
      current: running,
      roll: h.rng(),
    });
    seat.nextThink = this.clock + this.thinkDelay();
    if (!view) return;
    const goal = seat.standIn ? standInGoal(view) : chooseGoal(view);
    const key = goalKey(goal);
    if (!seat.motor || seat.motor.status !== "running" || key !== seat.key) {
      seat.goal = goal;
      seat.key = key;
      seat.motor = new Motor(goal, seat.mem);
      seat.settled = false;
    }
    // A stand-in doesn't speak for the absent player (no emotes, no pings).
    if (!seat.standIn) this.flavor(seat, p, view.team.stage);
  }

  /** Bring the next decision forward when something happened (human reaction time, not instant). */
  private react(seat: Seat, p: PlayerState): void {
    const state = this.host.state;
    if (p.hp < seat.lastHp - 4) this.soon(seat, 5, 10);
    seat.lastHp = p.hp;
    if (state.dayPhase !== seat.lastPhase) {
      if (seat.lastPhase !== "") this.soon(seat, 6, 20);
      seat.lastPhase = state.dayPhase;
    }
    const team = state.teams[p.team];
    if (team && team.stage !== seat.lastStage) {
      if (seat.lastStage >= 0) this.soon(seat, 6, 18);
      seat.lastStage = team.stage;
    }
    // (A stand-in never throws the absent player's puffer away: no point thinking again for it.)
    if (p.fuseTicks > 0 && !seat.standIn && seat.goal?.kind !== "throwAway") this.soon(seat, 2, 4);
    if ((this.clock + seat.seq) % 5 === 0 && seat.goal?.kind !== "attack" && seat.goal?.kind !== "flee") {
      let close = false;
      state.monsters.forEach((m) => {
        if (!close && Math.hypot(m.x - p.x, m.z - p.z) < 7 && isHostile(m)) close = true;
      });
      if (close) this.soon(seat, 8, 14);
    }
  }

  /** Think within min..max ticks (never later than already planned). */
  private soon(seat: Seat, min: number, max: number): void {
    const at = this.clock + min + Math.floor(this.host.rng() * (max - min + 1));
    if (at < seat.nextThink) seat.nextThink = at;
  }

  /** BOT_THINK_MIN..MAX_SEC, shrunk with the day length under the RAFT_TEST fast timers (a 4 s day). */
  private thinkDelay(): number {
    const sec = BOT_THINK_MIN_SEC + (BOT_THINK_MAX_SEC - BOT_THINK_MIN_SEC) * this.host.rng();
    const scale = Math.min(1, Math.max(0.15, this.host.world.timings.day / NORMAL_TIMINGS.day));
    return Math.max(1, secToTicks(sec * scale));
  }

  private roles(): Map<string, BotRole> {
    const out = new Map<string, BotRole>();
    for (const s of this.seats.values()) out.set(s.id, s.role);
    return out;
  }

  private standIns(): Set<string> {
    const out = new Set<string>();
    for (const s of this.seats.values()) if (s.standIn) out.add(s.id);
    return out;
  }

  /** What the OTHER bots are busy with right now. */
  private claimsFor(id: string): BotClaims {
    const nodes = new Set<number>();
    const items = new Set<string>();
    const crabs = new Set<string>();
    const spots = new Set<number>();
    for (const s of this.seats.values()) {
      if (s.id === id || !s.goal || !s.motor || s.motor.status !== "running") continue;
      const g = s.goal;
      if (g.kind === "gather" || g.kind === "shake") nodes.add(g.node);
      else if (g.kind === "pickup") items.add(g.projectileId);
      else if (g.kind === "collectCrab") crabs.add(g.monsterId);
      else if (g.kind === "fish") spots.add(g.spot);
    }
    return { nodes, items, crabs, spots };
  }

  /** Smoothed monster ground velocities (for leading throws). */
  private trackMonsters(): void {
    const monsters = this.host.state.monsters;
    // Waves come and go every night: forget the monsters that are gone (deleting while iterating is safe).
    for (const id of this.tracks.keys()) if (!monsters.has(id)) this.tracks.delete(id);
    for (const id of this.bossSpotted) if (!monsters.has(id)) this.bossSpotted.delete(id);
    monsters.forEach((m, id) => {
      const t = this.tracks.get(id);
      if (!t) {
        this.tracks.set(id, { x: m.x, z: m.z, vx: 0, vz: 0 });
        return;
      }
      const vx = (m.x - t.x) / DT;
      const vz = (m.z - t.z) / DT;
      // Teleports (spawn / knockback) would spike the estimate: ignore implausible jumps.
      if (Math.hypot(vx, vz) < 15) {
        t.vx += (vx - t.vx) * 0.35;
        t.vz += (vz - t.vz) * 0.35;
      }
      t.x = m.x;
      t.z = m.z;
    });
  }

  /* ============================================================= flavor */

  private chatter(id: string, emote: EmoteId, chance: number): void {
    if (this.seats.get(id)?.standIn) return;
    if (this.clock - this.lastChatter < CHATTER_GAP_TICKS || this.host.rng() >= chance) return;
    if (this.host.emote(id, { emote })) this.lastChatter = this.clock;
  }

  private flavor(seat: Seat, p: PlayerState, stage: number): void {
    const h = this.host;
    if (p.downed && !seat.helpPinged) {
      seat.helpPinged = true;
      h.marker(seat.id, { kind: "help", pos: { x: p.x, y: p.y, z: p.z } });
    } else if (!p.downed) seat.helpPinged = false;
    h.state.monsters.forEach((m) => {
      if (m.kind !== "boss" || this.bossSpotted.has(m.id) || Math.hypot(m.x - p.x, m.z - p.z) > 30) return;
      this.bossSpotted.add(m.id);
      h.marker(seat.id, { kind: "danger", pos: { x: m.x, y: m.y, z: m.z } });
      this.chatter(seat.id, "panic", 0.5);
    });
    if (stage === 3 && !this.cheeredRaft) {
      this.cheeredRaft = true;
      this.chatter(seat.id, h.rng() < 0.5 ? "dance" : "clap", 0.7);
    }
    if (p.character === "fenomen" && h.state.dayPhase === "day" && seat.lastPhase === "day" && seat.goal?.kind === "camp") {
      this.chatter(seat.id, "selfie", 0.02);
    }
  }
}
