// Authoritative per-tick game rules. Owner: server-world (signatures by the architect; keep them).
//
// RaftWorld owns everything that happens INSIDE a match: inputs → stepPlayer, interactions, gathering, palms,
// throws/tosses/catches, projectiles (stepProjectile) + hits, eating, inventory, crafting, chest, campfire fuel,
// raft delivery + boarding, structures, survival bars, downed/revive/wash/respawn, fishing + loot, monsters
// (spawn waves, AI, light rings, bait, gnawing), weather + daytime events. It never broadcasts: step() returns
// GameEvent[] and the room broadcasts the broadcast ones (server/world/events.ts).
//
// Per-tick order (docs/ARCHITECTURE.md §4.3): clock transitions (dawn / mid-day / dusk / night) → inputs →
// stepPlayer + results (interact / use / throw / toss / eat / catch / channel completion) → player separation →
// projectiles (stepProjectile + hits + catches + bait + fuel catch) → monsters (think every MONSTER_THINK_TICKS,
// move every tick) → structures (torch / kraken life, collectors) → survival (bars, fire, drown, jellyfish,
// puffer fuse) → downed / wash → boarding / launch check. MVP points + stats: RaftWorld credits gathering,
// delivery, hits, revives, eating (golden fish), crafting, the first aboard and the pirate hat; the life systems
// credit kills / flips (MonsterSystem) and catches (FishingSystem) through the same PlayerState / addScore.
//
// The rules live in small systems of this folder, wired through WorldCore (core.ts): bag (inventory + item
// timers), actions (stepPlayer results), nodes, projectiles, structures, raft, survival, crafting, effects. The
// life systems (monsters / fishing / weather, owned by server-world-life) get this object as their WorldContext.
// Determinism: players, projectiles and structures are iterated in MapSchema insertion order; every random pick
// uses the room-seeded gameplay rng (opts.rng), never Math.random.
// Bounded memory: emitted events go through an EventBuffer (eventBuffer.ts: identical rejects coalesce, hard cap
// between drains); removePlayer and every match reset drop what the systems keep per player; the light rings
// and the separation scratch are reused tick to tick instead of rebuilt.

import {
  BAR_MAX,
  CHANNEL,
  CHARACTERS,
  DEFAULT_CHARACTER,
  DIFFICULTIES,
  DT,
  ESCORT_RADIUS,
  fireLightRadius,
  fireRepels,
  FIRE_START_FUEL_TICKS,
  HIT_STUN_TICKS,
  MAX_HP,
  PLAYER_HEIGHT,
  PLAYER_SEPARATION,
  TORCH_LIGHT_RADIUS,
  timingsFor,
  type DifficultyDef,
  type Timings,
} from "../../shared/constants.js";
import type { IslandDef, IslandSite } from "../../shared/island/types.js";
import { isHeavy, isRecipeId } from "../../shared/items.js";
import { slotKind } from "../../shared/rules/inventory.js";
import type { ChestMsg, InputCmd, PickupEvent } from "../../shared/protocol.js";
import type { ClockInfo } from "../../shared/rules/schedule.js";
import type { SimContext } from "../../shared/sim/context.js";
import { buildCover, type CoverCircle, type CoverIndex } from "../../shared/sim/cover.js";
import { copyPlayerSim, createPlayerSim, emptyStepResult, heldKind, playerHeight, playerRadius, stepPlayerInto } from "../../shared/sim/player.js";
import type { Difficulty, HurtCause, InteractKind, ItemKind, RecipeId, TreasureId, Vec3Like } from "../../shared/types.js";
import { TeamState, type PlayerState, type RaftState, type StructureState } from "../schema.js";
import { ActionSystem } from "./actions.js";
import { Bag } from "./bag.js";
import { CampSystem } from "./camp.js";
import type { LightRing, ProjectileEntity, SpawnProjectileOptions } from "./context.js";
import type { RejectAction, WorldCore } from "./core.js";
import { CraftSystem } from "./crafting.js";
import { EffectSystem } from "./effects.js";
import { EventBuffer, type EventBufferStats } from "./eventBuffer.js";
import type { GameEvent } from "./events.js";
import { FishingSystem } from "./fishing.js";
import { InputQueues, sanitizeInput } from "./inputs.js";
import { MonsterSystem } from "./monsters.js";
import { NodeSystem } from "./nodes.js";
import { ProjectileSystem } from "./projectiles.js";
import { RaftSystem } from "./raft.js";
import { dist2, posOf } from "./rules.js";
import { RuntimeStore } from "./runtime.js";
import { StructureSystem } from "./structures.js";
import { SurvivalSystem } from "./survival.js";
import { WeatherSystem } from "./weather.js";

export interface WorldOptions {
  fast: boolean;
  difficulty: Difficulty;
  /** Gameplay rng (loot, weather, spawns, starter items). The room seeds it per match. Never Math.random. */
  rng: () => number;
}

export interface WorldStepOptions {
  /** stepPlayer ctx.locked (shared/rules/schedule.ts inputLocked()). */
  locked: boolean;
  /**
   * Day clock for this tick (shared clockAt(state.clockTicks)); null during the landing and the cinematics:
   * then bars don't drain, no monsters spawn, no weather / day events, but movement, gathering, crafting
   * and projectiles still work (landing) or everything is frozen except physics (launch / storm).
   */
  clock: ClockInfo | null;
}

/** One random starter item per participant (game4.md §4.2: wood ×2, a coconut, a stone, rope…). */
export const STARTER_ITEMS: ReadonlyArray<{ kind: ItemKind; count: number }> = [
  { kind: "wood", count: 2 },
  { kind: "coconut", count: 1 },
  { kind: "stone", count: 1 },
  { kind: "rope", count: 1 },
  { kind: "water", count: 1 },
];

/** The wreck's chest (the camp chest at match start) holds WRECK_CHEST_PICKS distinct picks from this pool. */
export const WRECK_CHEST_ITEMS: ReadonlyArray<{ kind: ItemKind; count: number }> = [
  { kind: "wood", count: 2 },
  { kind: "rope", count: 2 },
  { kind: "stone", count: 2 },
  { kind: "coconut", count: 2 },
  { kind: "water", count: 1 },
  { kind: "fish_raw", count: 1 },
  { kind: "torch", count: 1 },
];
export const WRECK_CHEST_PICKS = 2;

/** What a light ring comes from: a site (its campfire), a torch holder or a planted torch. */
type LightSource = IslandSite | PlayerState | StructureState;

/** Fresh rings (and their sources) a lights() rebuild fills. */
interface LightBuild {
  rings: LightRing[];
  sources: LightSource[];
}

export class RaftWorld implements WorldCore {
  readonly state: RaftState;
  island: IslandDef;
  cover: CoverIndex;
  timings: Readonly<Timings>;
  difficulty: Readonly<DifficultyDef>;
  protected opts: WorldOptions;
  protected events = new EventBuffer();
  protected inputs = new InputQueues();

  /* rule systems (see core.ts) */
  readonly runtime = new RuntimeStore();
  readonly bag: Bag;
  readonly projectiles: ProjectileSystem;
  readonly nodes: NodeSystem;
  readonly structures: StructureSystem;
  readonly raft: RaftSystem;
  readonly camp: CampSystem;
  readonly survival: SurvivalSystem;
  readonly crafting: CraftSystem;
  readonly effects: EffectSystem;
  readonly actions: ActionSystem;
  /* life systems (server-world-life) */
  readonly monsters: MonsterSystem;
  readonly fishing: FishingSystem;
  readonly weather: WeatherSystem;

  /** Day clock of the step in progress (null outside playing). */
  dayClock: ClockInfo | null = null;

  private prevClock: ClockInfo | null = null;
  /** The object prevClock points to while set (copied into every playing tick). */
  private readonly prevClockBuf: ClockInfo = { day: 0, dayPhase: "day", phaseElapsed: 0, phaseLength: 0, phaseLeft: 0, cycle: 0, stormLeft: 0, over: false };
  private readonly simCtx: SimContext;
  private readonly stepResult = emptyStepResult();
  private readonly coverScratch: CoverCircle[] = [];
  /**
   * separatePlayers() scratch, overwritten every pass (only the first `n` entries of a pass are live): the bodies,
   * and the ones pushed in first-push order. Holds at most MAX_PLAYERS references.
   */
  private readonly bodies: PlayerState[] = [];
  private readonly moved: PlayerState[] = [];
  /** stepPlayer input of a player with nothing queued (refilled per player). */
  private readonly idleInput: InputCmd = { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };
  private lightRings: LightRing[] = [];
  /** What each ring of lightRings comes from (same order): a site's campfire, a torch holder, a planted torch. */
  private lightSources: LightSource[] = [];
  /** Tick the light rings were last brought up to date on (-1 = stale). */
  private lightTick = -1;
  /** walkLights() pass: sources visited so far, and whether they still match lightSources one by one. */
  private lightSeen = 0;
  private lightSame = true;

  constructor(state: RaftState, island: IslandDef, opts: WorldOptions) {
    this.state = state;
    this.island = island;
    this.cover = buildCover(island);
    this.opts = opts;
    this.timings = timingsFor(opts.fast);
    this.difficulty = DIFFICULTIES[opts.difficulty] ?? DIFFICULTIES.normal;
    this.simCtx = { terrain: island.grid, cover: this.cover, bounds: island.bounds, character: DEFAULT_CHARACTER, dt: DT, locked: false };
    this.bag = new Bag(this);
    this.projectiles = new ProjectileSystem(this);
    this.nodes = new NodeSystem(this);
    this.structures = new StructureSystem(this);
    this.raft = new RaftSystem(this);
    this.camp = new CampSystem(this);
    this.survival = new SurvivalSystem(this);
    this.crafting = new CraftSystem(this);
    this.effects = new EffectSystem(this);
    this.actions = new ActionSystem(this);
    this.monsters = new MonsterSystem(this);
    this.fishing = new FishingSystem(this);
    this.weather = new WeatherSystem(this, this.monsters);
    this.setIsland(island);
  }

  /** Load another island (lobby preview / match start): state.seed/layout/biome, nodes reset to their amounts, cover rebuilt. */
  setIsland(island: IslandDef): void {
    this.island = island;
    this.cover = buildCover(island);
    this.simCtx.terrain = island.grid;
    this.simCtx.cover = this.cover;
    this.simCtx.bounds = island.bounds;
    this.state.seed = island.seed;
    this.state.layout = island.layout;
    this.state.biome = island.biome;
    this.monsters.clear();
    this.projectiles.clear();
    this.structures.clear();
    this.nodes.reset();
    this.ensureTeams();
    this.lightsChanged();
  }

  setOptions(opts: Partial<WorldOptions>): void {
    this.opts = { ...this.opts, ...opts };
    this.timings = timingsFor(this.opts.fast);
    this.difficulty = DIFFICULTIES[this.opts.difficulty] ?? DIFFICULTIES.normal;
  }

  /* ================================================================= inputs */

  /** Queue one input (validated + clamped; seq ≤ last seen dropped; cap INPUT_QUEUE_MAX carrying edge bits). */
  queueInput(id: string, cmd: InputCmd): void {
    const p = this.state.players.get(id);
    if (!p || !p.alive || p.spectator) return;
    const clean = sanitizeInput(cmd);
    if (clean) this.inputs.push(id, clean);
  }

  /** Forget queued inputs and the last seen seq (join / reconnect / bot takeover). */
  clearInputs(id?: string): void {
    this.inputs.clear(id);
    if (id === undefined) {
      this.state.players.forEach((p) => {
        p.lastSeq = 0;
      });
      return;
    }
    const p = this.state.players.get(id);
    if (p) p.lastSeq = 0;
  }

  /** Players with an input queue record (tests: nothing outlives its player). */
  inputIds(): string[] {
    return this.inputs.ids();
  }

  /** Fisher's RTT for the bite-window latency allowance. */
  setRtt(id: string, rttMs: number): void {
    this.fishing.setRtt(id, Number.isFinite(rttMs) ? Math.max(0, rttMs) : 0);
  }

  /* ========================================================= match lifecycle */

  /**
   * Start a match on the current island: one TeamState per site (coop: 1) sized for `seats`; every participant
   * alive at a spawn point with full bars and one random starter item (wood ×2, coconut, stone, rope…); a fresh
   * raft (nothing built), a full spring, the wreck's scrap, no bench; the camp chest holds 2 random starter items; campfire
   * FIRE_START_FUEL_TICKS; nodes reset; projectiles / monsters / structures cleared; per-match loot table
   * shuffled from the seed and biome; stats and scores reset.
   */
  startMatch(participants: string[], seats: number): void {
    const st = this.state;
    this.resetMatchSystems();
    this.ensureTeams();
    const inMatch = new Set(participants);
    st.teams.forEach((team, i) => {
      let teamSeats = seats;
      if (st.layout === "duel") {
        teamSeats = 0;
        st.players.forEach((p, id) => {
          if (inMatch.has(id) && p.team === i) teamSeats++;
        });
      }
      this.setupTeam(team, teamSeats);
    });
    st.players.forEach((p, id) => {
      if (inMatch.has(id)) this.enterMatch(p);
      else this.leaveMatch(p);
    });
    this.fishing.startMatch(st.seed, st.biome);
    this.lightsChanged();
  }

  /** Back to the lobby: entities cleared in place, everyone alive=false, boarded/downed/washed reset. */
  resetToLobby(): void {
    this.resetMatchSystems();
    this.state.players.forEach((p) => this.leaveMatch(p));
    this.lightsChanged();
  }

  /** Everything per match back to empty; per-player data of anyone no longer in the room is dropped. */
  private resetMatchSystems(): void {
    this.inputs.resetQueues((id) => this.state.players.has(id));
    this.monsters.clear();
    this.fishing.clear();
    this.weather.clear();
    this.projectiles.clear();
    this.structures.clear();
    this.nodes.reset();
    this.runtime.clear();
    this.raft.reset();
    this.camp.reset();
    this.survival.reset();
    this.prevClock = null;
    this.dayClock = null;
    this.state.launchTicksLeft = 0;
  }

  /** One TeamState per site, mutated in place (clients keep their references, incl. the chest map). */
  private ensureTeams(): void {
    const teams = this.state.teams;
    const n = Math.max(1, this.island.sites.length);
    while (teams.length > n) teams.pop();
    while (teams.length < n) teams.push(new TeamState());
    teams.forEach((t, i) => {
      if (t.index !== i) t.index = i;
    });
  }

  private setupTeam(team: TeamState, seats: number): void {
    this.raft.setup(team, seats);
    this.camp.setup(team);
    team.fireFuel = FIRE_START_FUEL_TICKS;
    team.chest.clear();
    team.flare = false;
    team.secretRevealed = false;
    team.secretOpened = false;
    team.springRevealed = false;
    team.ballRecipe = false;
    team.spyglassTicks = 0;
    team.hutHp = 0;
    team.score = 0;
    const pool = [...WRECK_CHEST_ITEMS];
    for (let k = 0; k < WRECK_CHEST_PICKS && pool.length > 0; k++) {
      const pick = pool.splice(Math.min(pool.length - 1, Math.floor(this.rng() * pool.length)), 1)[0]!;
      this.crafting.addToChest(team, pick.kind, pick.count);
    }
  }

  /** A participant wakes up on the beach: fresh body at its spawn, full bars, one starter item, stats reset. */
  private enterMatch(p: PlayerState): void {
    if (p.team < 0 || p.team >= this.island.sites.length) p.team = 0;
    this.survival.placeAtSpawn(p);
    p.alive = true;
    p.washed = false;
    p.downedTicks = 0;
    p.fuseTicks = 0;
    p.torchTicks = 0;
    p.cosmetic = "";
    p.golden = false;
    p.score = 0;
    resetStats(p);
    this.survival.setBars(p, MAX_HP, BAR_MAX);
    const starter = STARTER_ITEMS[Math.min(STARTER_ITEMS.length - 1, Math.floor(this.rng() * STARTER_ITEMS.length))]!;
    this.bag.give(p, starter.kind, starter.count);
  }

  /** Not in this match (spectator / lobby): no body. */
  private leaveMatch(p: PlayerState): void {
    copyPlayerSim(createPlayerSim(), p);
    this.bag.clear(p);
    p.alive = false;
    p.washed = false;
    p.downedTicks = 0;
    p.fishState = 0;
    p.fishSpot = -1;
    p.fuseTicks = 0;
    p.torchTicks = 0;
  }

  /* ================================================================ the tick */

  /** One tick. Returns (and clears) the events produced, plus any drained since the last step. */
  step(opts: WorldStepOptions): GameEvent[] {
    const clock = opts.clock;
    this.dayClock = clock;
    // 1. clock transitions
    if (clock) this.onClock(clock);
    // 2. players
    this.structures.syncCover();
    this.stepPlayers(opts.locked);
    this.fishing.step();
    this.separatePlayers();
    this.lightsChanged(); // held torches moved with their holders (refreshed in place) or changed hands
    // 3. projectiles
    this.projectiles.step();
    // 4. monsters (+ weather / day-event timers)
    if (clock) {
      this.monsters.step();
      this.weather.step();
    }
    // 5. structures, node regrowth
    this.structures.syncCover();
    this.structures.step(clock);
    this.nodes.step();
    // 6–8. survival, downed / wash, boarding / launch
    if (clock) {
      this.camp.step();
      this.survival.step(clock);
      this.survival.stepDowned(clock);
      this.raft.step(clock);
    }
    return this.drainEvents();
  }

  /** Events emitted outside step() (craft / chest messages, removals). */
  drainEvents(): GameEvent[] {
    return this.events.drain();
  }

  /** Events dropped at the buffer cap / rejects coalesced since this world was made (diagnostics). */
  eventStats(): Readonly<EventBufferStats> {
    return this.events.stats();
  }

  /**
   * Step 1. The life systems get (previous tick's clock, this tick's clock) on EVERY playing tick and detect
   * their own transitions (night start → wave, flare spent; mid-day weather; the day-event fraction; dawn →
   * flee). Here: dawn respawns the washed at the wreck.
   */
  private onClock(clock: ClockInfo): void {
    const prev = this.prevClock;
    if (prev && clock.dayPhase === "day" && clock.day > prev.day) {
      this.survival.respawnWashed();
      this.camp.onDawn(clock.day);
    }
    this.monsters.onClock(prev, clock);
    this.weather.onClock(prev, clock);
    this.prevClock = Object.assign(this.prevClockBuf, clock);
  }

  private stepPlayers(locked: boolean): void {
    const ctx = this.simCtx;
    ctx.terrain = this.island.grid;
    ctx.cover = this.cover;
    ctx.bounds = this.island.bounds;
    ctx.dt = DT;
    ctx.locked = locked;
    this.state.players.forEach((p, id) => {
      if (!p.alive) {
        const drained = this.inputs.drain(id);
        if (drained > 0) p.lastSeq = drained;
        return;
      }
      const cmd = this.nextInput(id, p);
      ctx.character = p.character;
      this.updateLoad(p);
      const res = stepPlayerInto(p, cmd, ctx, this.stepResult);
      if (p.boarded) this.raft.pinSeat(p);
      this.actions.handle(p, cmd, res);
    });
  }

  /**
   * Heavy carry (Long Tide T1): loadMult from the cargo in any slot — CharacterDef.carryAlone (logCarryAlone for a
   * log) alone, carryEscort with another living, standing teammate (bot included) within ESCORT_RADIUS; 100 when
   * nothing heavy is carried. Set before stepPlayer so the sim (and the client's prediction) read it.
   */
  updateLoad(p: PlayerState): void {
    let heavy: ItemKind | "" = "";
    for (let s = 0; s < 4 && heavy === ""; s++) {
      const k = slotKind(p, s);
      if (isHeavy(k)) heavy = k as ItemKind;
    }
    let mult = 100;
    if (heavy !== "" && !p.boarded) {
      const c = CHARACTERS[p.character];
      const r2 = ESCORT_RADIUS * ESCORT_RADIUS;
      let escorted = false;
      for (const q of this.state.players.values()) {
        if (q === p || q.team !== p.team || !q.alive || q.downed || q.boarded || q.spectator) continue;
        if (dist2(q.x, q.z, p.x, p.z) <= r2) {
          escorted = true;
          break;
        }
      }
      mult = escorted ? c.carryEscort : heavy === "log" ? c.logCarryAlone : c.carryAlone;
    }
    mult = Math.max(1, Math.min(100, Math.round(mult)));
    if (p.loadMult !== mult) p.loadMult = mult;
  }

  /** An alive player's input this tick: the queue (inputs.ts rules), else standing still looking the same way. */
  private nextInput(id: string, p: PlayerState): InputCmd {
    const taken = this.inputs.take(id);
    if (!taken) {
      const idle = this.idleInput;
      idle.seq = p.lastSeq;
      idle.yaw = p.yaw;
      idle.pitch = p.pitch;
      return idle;
    }
    if (taken.consumed) p.lastSeq = taken.cmd.seq;
    return taken.cmd;
  }

  /** Push overlapping capsules apart horizontally (half each), then out of cover again. */
  private separatePlayers(): void {
    const bodies = this.bodies;
    const moved = this.moved;
    let n = 0;
    let pushed = 0;
    for (const p of this.state.players.values()) {
      if (p.alive && !p.boarded && !p.spectator) bodies[n++] = p;
    }
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = bodies[i]!;
        const b = bodies[j]!;
        if (Math.abs(a.y - b.y) > PLAYER_HEIGHT) continue;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        let d = Math.sqrt(dx * dx + dz * dz);
        const min = Math.min(PLAYER_SEPARATION, playerRadius(a.character) + playerRadius(b.character));
        if (d >= min) continue;
        let nx: number;
        let nz: number;
        if (d < 1e-6) {
          // On the very same point: a fixed direction (a, the earlier body of the pass, to −x), the full min apart.
          nx = 1;
          nz = 0;
          d = 0;
        } else {
          nx = dx / d;
          nz = dz / d;
        }
        const push = (min - d) * 0.5;
        a.x -= nx * push;
        a.z -= nz * push;
        b.x += nx * push;
        b.z += nz * push;
        if (!listed(moved, pushed, a)) moved[pushed++] = a;
        if (!listed(moved, pushed, b)) moved[pushed++] = b;
      }
    }
    for (let i = 0; i < pushed; i++) this.pushOutOfCover(moved[i]!);
  }

  private pushOutOfCover(p: PlayerState): void {
    const r = playerRadius(p.character);
    const top = p.y + playerHeight(p);
    const n = this.cover.query(p.x, p.z, r, this.coverScratch);
    for (let i = 0; i < n; i++) {
      const c = this.coverScratch[i]!;
      if (!(c.bottom < top && c.top > p.y)) continue;
      let dx = p.x - c.x;
      let dz = p.z - c.z;
      let d = Math.sqrt(dx * dx + dz * dz);
      const min = c.r + r;
      if (d >= min) continue;
      if (d < 1e-6) {
        dx = 1;
        dz = 0;
        d = 1;
      }
      p.x = c.x + (dx / d) * min;
      p.z = c.z + (dz / d) * min;
    }
    const b = this.island.bounds;
    p.x = Math.max(b.minX, Math.min(b.maxX, p.x));
    p.z = Math.max(b.minZ, Math.min(b.maxZ, p.z));
  }

  /* ========================================================= craft & chest */

  /** CraftMsg from a player (or a bot). Validates range / fire / ingredients (inventory first, then chest). */
  craft(id: string, recipe: RecipeId): boolean {
    const p = this.state.players.get(id);
    if (!p || !isRecipeId(recipe)) return false;
    return this.crafting.craft(p, recipe);
  }

  /** ChestMsg from a player (or a bot). */
  chest(id: string, msg: ChestMsg): boolean {
    const p = this.state.players.get(id);
    if (!p || typeof msg !== "object" || msg === null) return false;
    return this.crafting.chest(p, msg);
  }

  /**
   * Remove a player entirely (lobby leave / spectator leave). Mid-match leavers become bots instead (room). Drops
   * everything kept per player: input queue, runtime bars, fishing line / pity streak / RTT, treasure reels.
   */
  removePlayer(id: string): void {
    const p = this.state.players.get(id);
    if (p) this.fishing.cancel(p, "cancel");
    this.inputs.clear(id);
    this.runtime.delete(id);
    this.fishing.forget(id);
    this.weather.forget(id);
    this.raft.forget(id);
    this.lightsChanged();
  }

  /** Team participants (alive or washed, not spectators) by team index. */
  participants(team = 0): PlayerState[] {
    const out: PlayerState[] = [];
    this.state.players.forEach((p) => {
      if (!p.spectator && p.team === team && (p.alive || p.washed)) out.push(p);
    });
    return out;
  }

  /* ===================================================== WorldContext impl */

  /** Gameplay rng [0, 1). Bound: the life systems pass `ctx.rng` around as a plain function. */
  readonly rng = (): number => this.opts.rng();

  /** Current server tick (state.tick). Bound like rng. */
  readonly tick = (): number => this.state.tick;

  /** Buffer an event for the next drain (identical rejects coalesce; capped, see eventBuffer.ts). */
  emit(ev: GameEvent): void {
    this.events.push(ev);
  }

  /** Alive (not washed, not spectator) players, optionally of one team. */
  alivePlayers(team?: number): PlayerState[] {
    const out: PlayerState[] = [];
    this.state.players.forEach((p) => {
      if (p.alive && !p.spectator && (team === undefined || p.team === team)) out.push(p);
    });
    return out;
  }

  /** Apply damage (no-op on downed / washed / boarded; hp 0 → downed). Emits playerHurt (+ playerDowned). */
  damagePlayer(p: PlayerState, amount: number, cause: HurtCause, byId: string): void {
    this.survival.damage(p, amount, cause, byId);
  }

  /** Knockback velocity + stun (HIT_STUN_TICKS when omitted). Cancels a charge and a hold-E channel. */
  knockPlayer(p: PlayerState, knock: Vec3Like, stunTicks?: number): void {
    if (!p.alive || p.boarded) return;
    p.vx = knock.x;
    p.vy = knock.y;
    p.vz = knock.z;
    p.grounded = false;
    const stun = Math.max(0, Math.round(stunTicks ?? HIT_STUN_TICKS));
    p.stunTicks = Math.min(255, Math.max(p.stunTicks, stun));
    p.chargeTicks = 0;
    if (p.channel !== CHANNEL.NONE) {
      p.channel = CHANNEL.NONE;
      p.channelTicks = 0;
      p.channelTarget = -1;
      this.runtime.of(p).reviveTarget = "";
    }
  }

  /** Give items: into the inventory, overflow dropped as resting projectiles at the player's feet. Emits pickup. Returns units that went into the inventory. */
  giveItem(p: PlayerState, kind: ItemKind, count: number, source: PickupEvent["source"]): number {
    const r = this.bag.give(p, kind, count);
    if (r.added > 0) this.emit({ type: "pickup", tick: this.tick(), playerId: p.id, kind, count: r.added, pos: posOf(p), projectileId: "", source });
    return r.added;
  }

  /** Add MVP points (MVP_POINTS.*). */
  addScore(p: PlayerState, points: number): void {
    if (!Number.isFinite(points)) return;
    p.score = Math.max(0, Math.min(65535, Math.round(p.score + points)));
  }

  /** Spawn a projectile (null when the cap is reached and nothing could be despawned). */
  spawnProjectile(kind: ItemKind, pos: Vec3Like, vel: Vec3Like, opts?: SpawnProjectileOptions): ProjectileEntity | null {
    return this.projectiles.spawn(kind, pos, vel, opts);
  }

  removeProjectile(id: string): void {
    this.projectiles.remove(id);
  }

  site(team: number): IslandSite {
    return this.island.sites[team] ?? this.island.sites[0]!;
  }

  team(team: number): TeamState {
    return this.state.teams[team] ?? this.state.teams[0]!;
  }

  /**
   * Every current light ring (lit campfires, held lit torches, planted torches), brought up to date once per tick
   * and after lightsChanged(). The array is rebuilt only when the set of light sources changed (a fire lit / out,
   * a torch taken into / out of the hand, planted, burnt out); otherwise its rings are refreshed in place (a held
   * torch walks with its holder) — read it right away rather than keeping it across ticks.
   */
  lights(): LightRing[] {
    if (this.lightTick === this.state.tick) return this.lightRings;
    this.lightTick = this.state.tick;
    this.walkLights(null);
    if (this.lightSame && this.lightSeen === this.lightRings.length) return this.lightRings;
    const build: LightBuild = { rings: [], sources: [] };
    this.walkLights(build);
    this.lightRings = build.rings;
    this.lightSources = build.sources;
    return this.lightRings;
  }

  /** (x, z) is inside any light ring. */
  inLight(x: number, z: number): boolean {
    for (const l of this.lights()) if (dist2(x, z, l.x, l.z) <= l.r * l.r) return true;
    return false;
  }

  lightsChanged(): void {
    this.lightTick = -1;
  }

  /**
   * One pass over the light sources in ring order: campfires by site, held lit torches by player, planted
   * torches. With `build`: fill it with fresh rings. Without: refresh the current rings in place while the
   * sources match lightSources one by one; lightSame / lightSeen then tell whether the set changed (a ring
   * array about to be replaced may be left half refreshed).
   */
  private walkLights(build: LightBuild | null): void {
    this.lightSeen = 0;
    this.lightSame = true;
    for (const site of this.island.sites) {
      // The campfire's ring shrinks with its fuel and stops keeping monsters out below FIRE_REPEL_MIN_FRACTION.
      const fuel = this.team(site.team).fireFuel;
      if (fireRepels(fuel)) this.lightFrom(build, site, site.campfire.x, site.campfire.z, "fire", site.team, fireLightRadius(fuel));
    }
    for (const p of this.state.players.values()) {
      if (p.alive && !p.spectator && p.torchTicks > 0 && heldKind(p) === "torch") this.lightFrom(build, p, p.x, p.z, "torch", p.team);
    }
    for (const s of this.state.structures.values()) {
      if (s.kind === "torch" && s.life > 0) this.lightFrom(build, s, s.x, s.z, "planted", s.team);
    }
  }

  private lightFrom(build: LightBuild | null, source: LightSource, x: number, z: number, kind: LightRing["kind"], team: number, radius = TORCH_LIGHT_RADIUS): void {
    const i = this.lightSeen++;
    if (build) {
      build.rings.push({ x, z, r: radius, kind, team });
      build.sources.push(source);
      return;
    }
    if (!this.lightSame || this.lightSources[i] !== source) {
      this.lightSame = false;
      return;
    }
    const l = this.lightRings[i]!;
    l.x = x;
    l.z = z;
    l.r = radius;
    l.team = team;
  }

  /** Lower the raft hp (gnawing / puffers / the boss); at 0 a stage is lost; emits raftDamage. */
  damageRaft(team: number, amount: number, byMonsterId: string, pos: Vec3Like): void {
    this.raft.damage(team, amount, byMonsterId, pos);
  }

  /** Take one item (a random kind, or `kind`) out of the team chest; null when empty. Emits chestChanged "steal". */
  stealFromChest(team: number, kind?: ItemKind): ItemKind | null {
    return this.crafting.steal(team, kind);
  }

  /** Put items back into the team chest. Emits chestChanged "return". */
  returnToChest(team: number, kind: ItemKind, count: number): void {
    this.crafting.restock(team, kind, count);
  }

  /** Add campfire fuel (capped); relights it. Emits fireFuel. */
  addFireFuel(team: number, ticks: number, byId: string, source: "wood" | "throw" | "jellyfish" | "fuelCan"): void {
    this.survival.addFuel(team, ticks, byId, source);
  }

  /** Apply a treasure to the finder's team (flare / sail / hat / spyglass / fuel can). */
  applyTreasure(p: PlayerState, treasure: TreasureId): void {
    this.effects.applyTreasure(p, treasure);
  }

  /** Mark something as seen by a bottle (see ARCHITECTURE §2.8) and emit bottle. */
  applyBottle(p: PlayerState): void {
    this.effects.applyBottle(p);
  }

  /** Emit a `reject` hint (reason = i18n key under `reject.`). */
  reject(p: PlayerState, action: RejectAction, reason: string, interact?: InteractKind): void {
    if (interact) this.emit({ type: "reject", tick: this.tick(), playerId: p.id, action, reason, interact });
    else this.emit({ type: "reject", tick: this.tick(), playerId: p.id, action, reason });
  }
}

/** `p` is among the first `count` entries of `list`. */
function listed(list: readonly PlayerState[], count: number, p: PlayerState): boolean {
  for (let i = 0; i < count; i++) if (list[i] === p) return true;
  return false;
}

function resetStats(p: PlayerState): void {
  const s = p.stats;
  s.gathered = 0;
  s.delivered = 0;
  s.hits = 0;
  s.kills = 0;
  s.revives = 0;
  s.fish = 0;
  s.eaten = 0;
  s.coconuts = 0;
  s.downs = 0;
  s.crafted = 0;
  s.raids = 0;
}
