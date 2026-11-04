// What E does right now: one pure resolver shared by the server (executes it) and the client (prompt, panels).
// Owner: server-world. Keep the signatures (client-app / client-ui / bots call these).
//
// resolveInteraction picks, among every candidate within its reach and inside the view cone
// (INTERACT_CONE_COS on the horizontal look direction; 360° for the big site targets when within 1.2 m of their
// body, and for anything closer than 0.6 m), the best candidate by:
//   1. ok before !ok (a greyed-out candidate never hides one that would work),
//   2. kind priority: revive > collectCrab > pickup > board > deliver > assemble > repair > craft > chest > spring >
//      collector > secretChest > salvage > gather,
//   3. the smallest view angle, then the nearest.
// Reaches: REVIVE_RANGE, INTERACT_RANGE (+ crab radius), PICKUP_RANGE, RAFT_RANGE, CRAFT_RANGE (campfire),
// CHEST_RANGE, SPRING_RANGE, COLLECTOR_RANGE, SECRET_CHEST_RANGE (only when team.secretRevealed &&
// !secretOpened), WRECK_RANGE (salvage), INTERACT_RANGE + node.radius (gather: tree / rock / bush with amount > 0;
// palms are LMB).
// The raft offers ONE candidate (raftInteraction): board (launch stage, launch day, raft hp ≥ RAFT_HP_BOARD or
// the push-off already counting), deliver (the current stage is open on this day and the pockets hold something
// it still needs), assemble (every material is in: hold E, CHANNEL.BUILD), repair (a hammer + a plank or 2 wood,
// raft hp below max, keel assembled), else a greyed-out board / deliver saying why ("seaRough", "raftWeak",
// "stageLocked", "wrongStage", "nothingToDeliver").
// Candidates that apply but can't be done now are still returned with ok=false and a `reason` (an i18n key
// under `reject.`), so the prompt can say why ("inventory full", "the raft doesn't need that"). `craft` is
// always ok (the panel can still feed a dead fire); its reason is "fireOut" as a hint while the fire is out.
//
// The raft helpers below (stage defs, remaining needs, delivery plan) are the single source of truth for delivery:
// the server executes exactly the plan planRaftDelivery() returns, and the client / bots use the same functions
// for prompts and the HUD (game4.md §7, docs/ARCHITECTURE.md §2.4).

import {
  ASSEMBLY_GROUP_MULT,
  ASSEMBLY_HAMMER_RATE,
  ASSEMBLY_HAND_RATE,
  ASSEMBLY_MAX_HOLDERS,
  CHANNEL,
  CHARACTERS,
  CHEST_RANGE,
  COLLECTOR_RANGE,
  CRAFT_RANGE,
  GATHER_SEC,
  INTERACT_CONE_COS,
  INTERACT_RANGE,
  MONSTERS,
  PICKUP_RANGE,
  RAFT_HP_BOARD,
  RAFT_HP_MAX,
  RAFT_LAUNCH_STAGE,
  RAFT_RANGE,
  RAFT_REPAIR_WOOD_COST,
  RAFT_REQ_SLOTS,
  RAFT_STAGES,
  REVIVE_RANGE,
  REVIVE_TICKS,
  SECRET_CHEST_RANGE,
  SPRING_RANGE,
  WRECK_RANGE,
  secToTicks,
  type RaftReqDef,
  type RaftStageDef,
} from "../constants.js";
import { heightAt } from "../island/heightfield.js";
import type { IslandDef, NodeDef } from "../island/types.js";
import { ITEMS } from "../items.js";
import type {
  CharacterId,
  Difficulty,
  InteractKind,
  InvKind,
  ItemKind,
  PlayerView,
  RaftStage,
  RaftStateView,
  TeamView,
  Vec3Like,
} from "../types.js";
import { countOf, heavyCount, roomFor, SLOTS, slotCount, slotKind, type Inventory } from "./inventory.js";
import { launchDayFor, stageDayLock } from "./schedule.js";

export interface Interaction {
  kind: InteractKind;
  /**
   * Hold E: the server starts a channel (CHANNEL.GATHER / REVIVE / SALVAGE) that completes after `ticks`; BUILD has
   * no fixed end (`ticks` = the stage's remaining work at one hammer holder's rate, a progress hint).
   */
  hold: boolean;
  channel: number;
  ticks: number;
  /** Target refs (unused ones are -1 / ""). */
  node: number;
  playerId: string;
  monsterId: string;
  projectileId: string;
  structureId: string;
  /** Team whose site it is (campfire / chest / raft / spring / secret chest), -1 otherwise. */
  team: number;
  /** What it yields or concerns (prompt text): gathered item / "berry", picked-up kind, … ("" if n/a). */
  item: InvKind | "berry";
  /** Prompt anchor in the world. */
  pos: Vec3Like;
  /** False = shown greyed out with `reason`; the server won't act on it. */
  ok: boolean;
  /**
   * i18n key under `reject.` when !ok: "full", "fireOut", "wrongStage", "nothingToDeliver", "notReady", "empty",
   * "stageLocked" (day: stageDayLock), "seaRough" (day: launchDayFor), "raftWeak", "springDry", "needHammer",
   * "wreckEmpty", "tooHeavy" (a second log / barrel)…
   */
  reason: string;
}

/** The state an interaction reads (RaftState on the server, the decoded state on the client). */
export interface InteractWorld {
  island: IslandDef;
  /**
   * `fast` (RAFT_TEST: no day locks), `day` (absent = no day lock), `difficulty` (launch day) and
   * `launchTicksLeft` (push-off running) are optional; a full RaftStateView carries them all.
   */
  state: Pick<RaftStateView, "players" | "projectiles" | "monsters" | "structures" | "nodes" | "teams" | "phase"> & {
    fast?: boolean;
    day?: number;
    difficulty?: Difficulty;
    launchTicksLeft?: number;
  };
}

/** Kind priority, highest first (index = rank). */
export const INTERACT_PRIORITY: ReadonlyArray<InteractKind> = [
  "revive",
  "collectCrab",
  "pickup",
  "board",
  "deliver",
  "assemble",
  "repair",
  "craft",
  "chest",
  "spring",
  "collector",
  "secretChest",
  "salvage",
  "gather",
];

/** Rank of a kind in INTERACT_PRIORITY (0 = highest). */
export function interactRank(kind: InteractKind): number {
  return INTERACT_PRIORITY.indexOf(kind);
}

/** Big targets are reachable from any direction when the player stands this close to their body. */
export const CONE_FREE_DIST = 1.2;
/** Small targets (items, crabs) are reachable from any direction this close. */
export const CONE_FREE_SMALL = 0.6;
/** Body radii of the site targets for the cone-free rule (cosmetic sizes of the props). */
export const SITE_BODY = { raft: 1.6, campfire: 0.8, chest: 0.55, spring: 1, collector: 0.45, secretChest: 0.6, player: 0.6, wreck: 1.8 } as const;
/** Ground items are reachable from this far below to this far above the feet (spears stuck in trunks). */
const PICKUP_MIN_DY = -1.5;
const PICKUP_MAX_DY = 3;

/**
 * Ticks one gather unit takes (wood: 4 s by hand, 1.5 s with an axe in ANY slot — CharacterDef.chopSec; rope 1.5;
 * stone 2.5; berries 1). `character` defaults to the base times.
 */
export function gatherTicksFor(node: NodeDef, hasAxe: boolean, character?: CharacterId): number {
  if (node.kind === "tree") return secToTicks(hasAxe ? (character ? CHARACTERS[character].chopSec : GATHER_SEC.woodAxe) : GATHER_SEC.wood);
  if (node.kind === "rock") return secToTicks(GATHER_SEC.stone);
  if (node.kind === "bush") return secToTicks(node.yield === "berry" ? GATHER_SEC.berry : GATHER_SEC.rope);
  return secToTicks(GATHER_SEC.wood);
}

/** Ticks one scrap takes at the wreck (GATHER_SEC.salvage; CharacterDef.salvageSec). */
export function salvageTicksFor(character?: CharacterId): number {
  return secToTicks(character ? CHARACTERS[character].salvageSec : GATHER_SEC.salvage);
}

/** Item a node yields per unit ("berry" is eaten on the spot; null = nothing). */
export function gatherYield(node: NodeDef): ItemKind | "berry" | null {
  if (node.kind === "tree") return "wood";
  if (node.kind === "rock") return "stone";
  if (node.kind === "palm") return "coconut";
  if (node.kind === "bush") return node.yield === "rope" ? "rope" : node.yield === "berry" ? "berry" : null;
  return null;
}

/** Required channel ticks for a channel kind (gather needs the node). BUILD has no fixed length (0). */
export function channelTicksFor(channel: number, node: NodeDef | null, hasAxe: boolean, character?: CharacterId): number {
  if (channel === CHANNEL.REVIVE) return REVIVE_TICKS;
  if (channel === CHANNEL.GATHER && node) return gatherTicksFor(node, hasAxe, character);
  if (channel === CHANNEL.SALVAGE) return salvageTicksFor(character);
  return 0;
}

/* ================================================================== raft */

/** The raft part of a team (TeamView / TeamState satisfy it). */
export type RaftProgress = Pick<TeamView, "stage" | "raftHave" | "raftNeed" | "raftWork" | "raftWorkNeed" | "raftHp">;

/** The definition of raft stage `stage` (null for the launch stage and beyond). */
export function raftStageDef(stage: RaftStage): RaftStageDef | null {
  return RAFT_STAGES[stage] ?? null;
}

/** Requirement slot `slot` of stage `stage` (null when unused). */
export function raftReq(stage: RaftStage, slot: number): RaftReqDef | null {
  return RAFT_STAGES[stage]?.req[slot] ?? null;
}

/** Every build stage is assembled: the raft can be boarded (launch window and hp permitting). */
export function raftFinished(team: Pick<TeamView, "stage">): boolean {
  return team.stage >= RAFT_LAUNCH_STAGE;
}

/** Units slot `slot` of the current stage still needs (0 when complete or unused). */
export function raftSlotRemaining(team: RaftProgress, slot: number): number {
  return Math.max(0, (team.raftNeed[slot] ?? 0) - (team.raftHave[slot] ?? 0));
}

/** Every material of the current stage is in (assembly may start). False on the launch stage. */
export function raftMaterialsDone(team: RaftProgress): boolean {
  if (raftFinished(team)) return false;
  for (let i = 0; i < RAFT_REQ_SLOTS; i++) if (raftSlotRemaining(team, i) > 0) return false;
  return true;
}

/** Slot of the current stage that accepts `kind` (-1 none). */
export function raftSlotFor(stage: RaftStage, kind: InvKind): number {
  if (kind === "") return -1;
  const def = RAFT_STAGES[stage];
  if (!def) return -1;
  for (let i = 0; i < def.req.length; i++) if (def.req[i]!.kinds.includes(kind)) return i;
  return -1;
}

/** Kinds some raft stage accepts (carriesRaftGoods / prompts). */
export const RAFT_GOODS: ReadonlySet<ItemKind> = new Set(RAFT_STAGES.flatMap((d) => d.req.flatMap((r) => [...r.kinds])));

/** One delivery to the current stage: what leaves the inventory and what it credits per slot. */
export interface RaftDeliveryPlan {
  /** Stage the items go to (the current one). */
  stage: RaftStage;
  /** Item units taken from the inventory, by kind (only kinds with count > 0). */
  items: { kind: ItemKind; count: number }[];
  /** Units credited per requirement slot (length RAFT_REQ_SLOTS). */
  slots: number[];
  /** Item units taken (Σ items.count) = units credited: stats.delivered / MVP points. */
  units: number;
  /** Heavy units among them (logs, barrels): MVP_POINTS.heavy. */
  heavy: number;
}

/**
 * What E at the raft would deliver to the CURRENT stage right now (null when nothing it still needs is in the
 * inventory, or the raft is finished). Every slot takes up to its remaining need; a slot accepting several kinds
 * (cooked food) takes them in RaftReqDef.kinds order. Surplus stays with the player. The day lock is the
 * caller's (raftStageOpen).
 */
export function planRaftDelivery(inv: Inventory, team: RaftProgress): RaftDeliveryPlan | null {
  const stage = team.stage;
  const def = RAFT_STAGES[stage];
  if (!def) return null;
  const plan: RaftDeliveryPlan = { stage, items: [], slots: [], units: 0, heavy: 0 };
  for (let i = 0; i < RAFT_REQ_SLOTS; i++) plan.slots.push(0);
  def.req.forEach((r, i) => {
    let left = raftSlotRemaining(team, i);
    for (const kind of r.kinds) {
      if (left <= 0) break;
      const n = Math.min(left, countOf(inv, kind));
      if (n <= 0) continue;
      plan.items.push({ kind, count: n });
      plan.units += n;
      if (ITEMS[kind].heavy) plan.heavy += n;
      plan.slots[i]! += n;
      left -= n;
    }
  });
  return plan.units > 0 ? plan : null;
}

/** The current stage accepts materials on `day` (absent = no day lock; 0, the lobby / landing, counts as day 1). */
export function raftStageOpen(team: Pick<TeamView, "stage">, day: number | undefined, cheap: boolean): boolean {
  if (raftFinished(team)) return false;
  return day === undefined || Math.max(1, day) >= stageDayLock(team.stage, { cheapRaft: cheap });
}

/** Carries something the raft takes at SOME stage. */
export function carriesRaftGoods(inv: Inventory): boolean {
  for (let s = 0; s < SLOTS; s++) {
    const k = slotKind(inv, s);
    if (k === "" || slotCount(inv, s) <= 0) continue;
    if (RAFT_GOODS.has(k)) return true;
  }
  return false;
}

/** The item the current stage still wants most (prompt / HUD hint): the first incomplete slot's item, "" when none. */
export function raftWantedItem(team: RaftProgress): InvKind {
  const def = RAFT_STAGES[team.stage];
  if (!def) return "";
  for (let i = 0; i < def.req.length; i++) if (raftSlotRemaining(team, i) > 0) return def.req[i]!.item;
  return "";
}

/** What a repair would spend: one plank (preferred) or RAFT_REPAIR_WOOD_COST wood. */
export interface RaftRepairPlan {
  kind: ItemKind;
  count: number;
}

/**
 * A repair `inv` could do now: a hammer in any slot, the keel assembled (stage ≥ 1), raft hp below RAFT_HP_MAX,
 * and a plank or RAFT_REPAIR_WOOD_COST wood. Null otherwise.
 */
export function planRaftRepair(inv: Inventory, team: Pick<TeamView, "stage" | "raftHp">): RaftRepairPlan | null {
  if (team.stage < 1 || team.raftHp >= RAFT_HP_MAX || countOf(inv, "hammer") <= 0) return null;
  if (countOf(inv, "raft_part") > 0) return { kind: "raft_part", count: 1 };
  if (countOf(inv, "wood") >= RAFT_REPAIR_WOOD_COST) return { kind: "wood", count: RAFT_REPAIR_WOOD_COST };
  return null;
}

/** One assembly holder: a hammer in any slot and the character (assemblyMult). */
export interface AssemblyHolder {
  hammer: boolean;
  character: CharacterId;
}

/** Work per second of one holder (ASSEMBLY_HAMMER_RATE / ASSEMBLY_HAND_RATE × CharacterDef.assemblyMult). */
export function holderRate(h: AssemblyHolder): number {
  return (h.hammer ? ASSEMBLY_HAMMER_RATE : ASSEMBLY_HAND_RATE) * CHARACTERS[h.character].assemblyMult;
}

/**
 * Team assembly work per tick (work ticks) from these holders: the best ASSEMBLY_MAX_HOLDERS count, their rates
 * summed × ASSEMBLY_GROUP_MULT[count]; 0 below `minHolders`.
 */
export function assemblyWorkPerTick(holders: ReadonlyArray<AssemblyHolder>, minHolders = 1): number {
  if (holders.length < Math.max(1, minHolders)) return 0;
  const rates = holders.map(holderRate).sort((a, b) => b - a).slice(0, ASSEMBLY_MAX_HOLDERS);
  let sum = 0;
  for (const r of rates) sum += r;
  return sum * (ASSEMBLY_GROUP_MULT[rates.length] ?? ASSEMBLY_GROUP_MULT[ASSEMBLY_GROUP_MULT.length - 1]!);
}

/** The finished raft can be boarded on `day` (launch window) with this hp (or while the push-off counts). */
export function raftBoardable(
  team: Pick<TeamView, "stage" | "raftHp">,
  day: number | undefined,
  difficulty: Difficulty,
  cheap: boolean,
  pushOff: boolean,
): { ok: boolean; reason: string } {
  if (!raftFinished(team)) return { ok: false, reason: "notReady" };
  if (pushOff) return { ok: true, reason: "" };
  if (day !== undefined && Math.max(1, day) < launchDayFor(difficulty, { cheapRaft: cheap })) return { ok: false, reason: "seaRough" };
  if (team.raftHp < RAFT_HP_BOARD) return { ok: false, reason: "raftWeak" };
  return { ok: true, reason: "" };
}

/** What E at the raft does for `player` (one candidate; see the file header). */
export interface RaftAction {
  kind: "board" | "deliver" | "assemble" | "repair";
  ok: boolean;
  reason: string;
  /** Prompt item. */
  item: InvKind;
}

export function raftInteraction(
  inv: Inventory,
  team: RaftProgress,
  day: number | undefined,
  difficulty: Difficulty,
  cheap: boolean,
  pushOff: boolean,
): RaftAction {
  const repair = planRaftRepair(inv, team);
  if (raftFinished(team)) {
    const b = raftBoardable(team, day, difficulty, cheap, pushOff);
    if (b.ok) return { kind: "board", ok: true, reason: "", item: "" };
    if (repair) return { kind: "repair", ok: true, reason: "", item: repair.kind };
    return { kind: "board", ok: false, reason: b.reason, item: "" };
  }
  const open = raftStageOpen(team, day, cheap);
  if (open && planRaftDelivery(inv, team)) return { kind: "deliver", ok: true, reason: "", item: raftWantedItem(team) };
  if (open && raftMaterialsDone(team)) return { kind: "assemble", ok: true, reason: "", item: "" };
  if (repair) return { kind: "repair", ok: true, reason: "", item: repair.kind };
  const reason = !open ? "stageLocked" : carriesRaftGoods(inv) ? "wrongStage" : "nothingToDeliver";
  return { kind: "deliver", ok: false, reason, item: raftWantedItem(team) };
}

/* ============================================================== resolver */

interface Pick_ {
  found: boolean;
  ok: boolean;
  rank: number;
  cos: number;
  dist: number;
}

/** Best interaction for `player` (looking along its yaw from its eye), or null. Writes into `out` when given. */
export function resolveInteraction(w: InteractWorld, player: PlayerView, out?: Interaction): Interaction | null {
  const state = w.state;
  if (state.phase !== "landing" && state.phase !== "playing") return null;
  if (!player.alive || player.downed || player.boarded || player.spectator) return null;

  const island = w.island;
  const res = out ?? emptyInteraction();
  const best: Pick_ = { found: false, ok: false, rank: 99, cos: -2, dist: Infinity };
  const px = player.x;
  const pz = player.z;
  const fx = -Math.sin(player.yaw);
  const fz = -Math.cos(player.yaw);

  /** Cone / reach test + ordering. Returns true when this candidate becomes the best (caller fills `res`). */
  const better = (kind: InteractKind, tx: number, tz: number, reach: number, coneFree: number, ok: boolean): boolean => {
    const dx = tx - px;
    const dz = tz - pz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d > reach) return false;
    const cos = d > 1e-6 ? (dx * fx + dz * fz) / d : 1;
    if (d > coneFree && cos < INTERACT_CONE_COS) return false;
    const rank = interactRank(kind);
    if (best.found) {
      if (best.ok !== ok) {
        if (best.ok) return false;
      } else if (rank !== best.rank) {
        if (rank > best.rank) return false;
      } else if (cos !== best.cos) {
        if (cos < best.cos) return false;
      } else if (d >= best.dist) return false;
    }
    best.found = true;
    best.ok = ok;
    best.rank = rank;
    best.cos = cos;
    best.dist = d;
    resetInteraction(res);
    res.kind = kind;
    res.ok = ok;
    return true;
  };

  // revive: a downed teammate
  state.players.forEach((q) => {
    if (q.id === player.id || q.team !== player.team || !q.alive || !q.downed || q.washed || q.spectator) return;
    if (!better("revive", q.x, q.z, REVIVE_RANGE, SITE_BODY.player + CONE_FREE_DIST, true)) return;
    res.hold = true;
    res.channel = CHANNEL.REVIVE;
    res.ticks = REVIVE_TICKS;
    res.playerId = q.id;
    setPos(res.pos, q.x, q.y + 0.3, q.z);
  });

  // collectCrab: a crab on its back
  const crabR = MONSTERS.crab.radius;
  state.monsters.forEach((m) => {
    if (m.kind !== "crab" || m.mode !== "flipped") return;
    if (!better("collectCrab", m.x, m.z, INTERACT_RANGE + crabR, crabR + CONE_FREE_SMALL, true)) return;
    res.monsterId = m.id;
    res.item = "crab_raw";
    setPos(res.pos, m.x, m.y + 0.3, m.z);
  });

  // pickup: items lying on the ground or stuck in something
  state.projectiles.forEach((b) => {
    if (b.state !== "rest" && b.state !== "stuck") return;
    const dy = b.y - player.y;
    if (dy < PICKUP_MIN_DY || dy > PICKUP_MAX_DY) return;
    const ok = roomFor(player, b.kind) > 0;
    if (!better("pickup", b.x, b.z, PICKUP_RANGE, b.radius + CONE_FREE_SMALL, ok)) return;
    res.projectileId = b.id;
    res.item = b.kind;
    res.reason = ok ? "" : ITEMS[b.kind].heavy && heavyCount(player) > 0 ? "tooHeavy" : "full";
    setPos(res.pos, b.x, b.y, b.z);
  });

  // the team's sites
  const site = island.sites[player.team] ?? island.sites[0];
  const team = state.teams[player.team] ?? state.teams[0];
  if (site && team) {
    const teamIdx = site.team;
    // raft: one candidate (board / deliver / assemble / repair, or a greyed-out reason)
    const ra = raftInteraction(player, team, state.day, state.difficulty ?? "normal", state.fast === true, (state.launchTicksLeft ?? 0) > 0);
    if (better(ra.kind, site.raft.x, site.raft.z, RAFT_RANGE, SITE_BODY.raft + CONE_FREE_DIST, ra.ok)) {
      fillSite(res, island, site.raft, teamIdx, ra.item);
      res.reason = ra.reason;
      if (ra.kind === "assemble") {
        res.hold = true;
        res.channel = CHANNEL.BUILD;
        res.ticks = Math.max(1, team.raftWorkNeed - team.raftWork);
      }
    }
    // campfire workbench (always opens; the panel greys out recipes)
    if (better("craft", site.campfire.x, site.campfire.z, CRAFT_RANGE, SITE_BODY.campfire + CONE_FREE_DIST, true)) {
      fillSite(res, island, site.campfire, teamIdx, "");
      if (team.fireFuel <= 0) res.reason = "fireOut";
    }
    if (better("chest", site.chest.x, site.chest.z, CHEST_RANGE, SITE_BODY.chest + CONE_FREE_DIST, true)) {
      fillSite(res, island, site.chest, teamIdx, "");
    }
    // spring: a water gourd, or a drink when the pockets are full (one charge either way)
    const springWants = roomFor(player, "water") > 0 || player.thirst < 100;
    const springOk = springWants && team.springCharges > 0;
    if (better("spring", site.spring.x, site.spring.z, SPRING_RANGE, SITE_BODY.spring + CONE_FREE_DIST, springOk)) {
      fillSite(res, island, site.spring, teamIdx, "water");
      if (!springOk) res.reason = springWants ? "springDry" : "full";
    }
    // wreck: salvage scrap with a hammer (hold E)
    const hasHammer = countOf(player, "hammer") > 0;
    const salvageOk = hasHammer && team.wreckScrap > 0;
    if (better("salvage", site.wreck.x, site.wreck.z, WRECK_RANGE, SITE_BODY.wreck + CONE_FREE_DIST, salvageOk)) {
      fillSite(res, island, site.wreck, teamIdx, "scrap");
      if (salvageOk) {
        res.hold = true;
        res.channel = CHANNEL.SALVAGE;
        res.ticks = salvageTicksFor(player.character);
      } else {
        res.reason = hasHammer ? "wreckEmpty" : "needHammer";
      }
    }
    if (team.secretRevealed && !team.secretOpened) {
      if (better("secretChest", site.secretChest.x, site.secretChest.z, SECRET_CHEST_RANGE, SITE_BODY.secretChest + CONE_FREE_DIST, true)) {
        fillSite(res, island, site.secretChest, teamIdx, "");
      }
    }
  }

  // collectors of the player's team
  state.structures.forEach((s) => {
    if (s.kind !== "collector" || s.team !== player.team) return;
    const ok = s.uses > 0;
    if (!better("collector", s.x, s.z, COLLECTOR_RANGE, SITE_BODY.collector + CONE_FREE_DIST, ok)) return;
    res.structureId = s.id;
    res.team = s.team;
    res.item = "water";
    res.reason = ok ? "" : "empty";
    setPos(res.pos, s.x, s.y + 0.8, s.z);
  });

  // gather: trees, rocks, bushes (palms are shaken with LMB)
  const hasAxe = countOf(player, "axe") > 0;
  const nodes = island.nodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]!;
    if (n.kind === "palm") continue;
    if ((state.nodes[i] ?? 0) <= 0) continue;
    const yieldKind = gatherYield(n);
    if (yieldKind === null) continue;
    // Cheap reject before the full test.
    const dx = n.x - px;
    const dz = n.z - pz;
    const reach = INTERACT_RANGE + n.radius;
    if (dx * dx + dz * dz > reach * reach) continue;
    if (!better("gather", n.x, n.z, reach, n.radius + CONE_FREE_SMALL, true)) continue;
    res.hold = true;
    res.channel = CHANNEL.GATHER;
    res.ticks = gatherTicksFor(n, hasAxe, player.character);
    res.node = i;
    res.item = yieldKind;
    setPos(res.pos, n.x, n.y + (n.kind === "tree" ? 1.2 : 0.5), n.z);
  }

  return best.found ? res : null;
}

function fillSite(res: Interaction, island: IslandDef, at: { x: number; z: number }, team: number, item: InvKind): void {
  res.team = team;
  res.item = item;
  setPos(res.pos, at.x, heightAt(island.grid, at.x, at.z) + 0.6, at.z);
}

function setPos(p: Vec3Like, x: number, y: number, z: number): void {
  p.x = x;
  p.y = y;
  p.z = z;
}

/** Reset every field of an Interaction to the blank values (keeps the pos object). */
export function resetInteraction(it: Interaction): Interaction {
  it.kind = "gather";
  it.hold = false;
  it.channel = CHANNEL.NONE;
  it.ticks = 0;
  it.node = -1;
  it.playerId = "";
  it.monsterId = "";
  it.projectileId = "";
  it.structureId = "";
  it.team = -1;
  it.item = "";
  setPos(it.pos, 0, 0, 0);
  it.ok = false;
  it.reason = "";
  return it;
}

/** A blank Interaction (for reuse). */
export function emptyInteraction(): Interaction {
  return {
    kind: "gather",
    hold: false,
    channel: CHANNEL.NONE,
    ticks: 0,
    node: -1,
    playerId: "",
    monsterId: "",
    projectileId: "",
    structureId: "",
    team: -1,
    item: "",
    pos: { x: 0, y: 0, z: 0 },
    ok: false,
    reason: "",
  };
}
