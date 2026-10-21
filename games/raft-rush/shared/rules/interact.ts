// What E does right now: one pure resolver shared by the server (executes it) and the client (prompt, panels).
// Owner: server-world. Keep the signatures (client-app / client-ui / bots call these).
//
// resolveInteraction picks, among every candidate within its reach and inside the view cone
// (INTERACT_CONE_COS on the horizontal look direction; 360° for the big site targets when within 1.2 m of their
// body, and for anything closer than 0.6 m), the best candidate by:
//   1. ok before !ok (a greyed-out candidate never hides one that would work),
//   2. kind priority: revive > collectCrab > pickup > board > deliver > craft > chest > spring > collector >
//      secretChest > gather,
//   3. the smallest view angle, then the nearest.
// Reaches: REVIVE_RANGE, INTERACT_RANGE (+ crab radius), PICKUP_RANGE, RAFT_RANGE, CRAFT_RANGE (campfire),
// CHEST_RANGE, SPRING_RANGE, COLLECTOR_RANGE, SECRET_CHEST_RANGE (only when team.secretRevealed &&
// !secretOpened), INTERACT_RANGE + node.radius (gather: tree / rock / bush with amount > 0; palms are LMB).
// Candidates that apply but can't be done now are still returned with ok=false and a `reason` (an i18n key
// under `reject.`), so the prompt can say why ("inventory full", "the raft doesn't need that"). `craft` is
// always ok (the panel can still feed a dead fire); its reason is "fireOut" as a hint while the fire is out.
//
// The raft helpers below (stage, remaining needs, delivery plan) are the single source of truth for delivery:
// the server executes exactly the plan planRaftDelivery() returns, and the client / bots use the same functions
// for prompts and the HUD (game4.md §7, docs/ARCHITECTURE.md §2.4).

import {
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
  RAFT_PART_WOOD,
  RAFT_RANGE,
  REVIVE_RANGE,
  REVIVE_TICKS,
  SECRET_CHEST_RANGE,
  SPRING_RANGE,
  secToTicks,
} from "../constants.js";
import { heightAt } from "../island/heightfield.js";
import type { IslandDef, NodeDef } from "../island/types.js";
import { ITEMS, raftCost, type RaftCost } from "../items.js";
import type {
  CharacterId,
  InteractKind,
  InvKind,
  ItemKind,
  PlayerView,
  RaftStage,
  RaftStateView,
  TeamView,
  Vec3Like,
} from "../types.js";
import { countOf, roomFor, SLOTS, slotCount, slotKind, type Inventory } from "./inventory.js";

export interface Interaction {
  kind: InteractKind;
  /** Hold E: the server starts a channel (CHANNEL.GATHER / CHANNEL.REVIVE) that completes after `ticks`. */
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
  /** i18n key under `reject.` when !ok: "full", "fireOut", "wrongStage", "nothingToDeliver", "notReady", "empty"… */
  reason: string;
}

/** The state an interaction reads (RaftState on the server, the decoded state on the client). */
export interface InteractWorld {
  island: IslandDef;
  /** `fast` (optional) selects the RAFT_TEST one-of-everything raft costs; a full RaftStateView carries it. */
  state: Pick<RaftStateView, "players" | "projectiles" | "monsters" | "structures" | "nodes" | "teams" | "phase"> & {
    fast?: boolean;
  };
}

/** Kind priority, highest first (index = rank). */
export const INTERACT_PRIORITY: ReadonlyArray<InteractKind> = [
  "revive",
  "collectCrab",
  "pickup",
  "board",
  "deliver",
  "craft",
  "chest",
  "spring",
  "collector",
  "secretChest",
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
export const SITE_BODY = { raft: 1.6, campfire: 0.8, chest: 0.55, spring: 1, collector: 0.45, secretChest: 0.6, player: 0.6 } as const;
/** Ground items are reachable from this far below to this far above the feet (spears stuck in trunks). */
const PICKUP_MIN_DY = -1.5;
const PICKUP_MAX_DY = 3;

/** Ticks one gather unit takes (wood: 2.5 s, 1 s with an axe in ANY slot; rope 1.5; stone 2; berries 1). */
export function gatherTicksFor(node: NodeDef, hasAxe: boolean): number {
  if (node.kind === "tree") return secToTicks(hasAxe ? GATHER_SEC.woodAxe : GATHER_SEC.wood);
  if (node.kind === "rock") return secToTicks(GATHER_SEC.stone);
  if (node.kind === "bush") return secToTicks(node.yield === "berry" ? GATHER_SEC.berry : GATHER_SEC.rope);
  return secToTicks(GATHER_SEC.wood);
}

/** Item a node yields per unit ("berry" is eaten on the spot; null = nothing). */
export function gatherYield(node: NodeDef): ItemKind | "berry" | null {
  if (node.kind === "tree") return "wood";
  if (node.kind === "rock") return "stone";
  if (node.kind === "palm") return "coconut";
  if (node.kind === "bush") return node.yield === "rope" ? "rope" : node.yield === "berry" ? "berry" : null;
  return null;
}

/** Required channel ticks for a channel kind (gather needs the node). */
export function channelTicksFor(channel: number, node: NodeDef | null, hasAxe: boolean): number {
  if (channel === CHANNEL.REVIVE) return REVIVE_TICKS;
  if (channel === CHANNEL.GATHER && node) return gatherTicksFor(node, hasAxe);
  return 0;
}

/* ================================================================== raft */

/** The raft part of a team (TeamView / TeamState satisfy it). */
export type RaftProgress = Pick<TeamView, "stage" | "hullWood" | "mastWood" | "mastRope" | "food" | "water" | "seats">;

/** What each requirement still needs (0 when complete). */
export interface RaftRemaining {
  hullWood: number;
  mastWood: number;
  mastRope: number;
  food: number;
  water: number;
}

/** Raft costs for a team (`cheap` = RAFT_TEST fast timings). */
export function teamRaftCost(team: Pick<TeamView, "seats">, cheap = false): RaftCost {
  return raftCost(team.seats, cheap);
}

/** Remaining needs of every requirement. */
export function raftRemaining(team: RaftProgress, cost: RaftCost, out?: RaftRemaining): RaftRemaining {
  const r = out ?? { hullWood: 0, mastWood: 0, mastRope: 0, food: 0, water: 0 };
  r.hullWood = Math.max(0, cost.hullWood - team.hullWood);
  r.mastWood = Math.max(0, cost.mastWood - team.mastWood);
  r.mastRope = Math.max(0, cost.mastRope - team.mastRope);
  r.food = Math.max(0, cost.food - team.food);
  r.water = Math.max(0, cost.water - team.water);
  return r;
}

/** Stage from the counts: the first incomplete stage (0 hull, 1 mast + sail, 2 provisions), 3 = ready. */
export function raftStageFor(team: RaftProgress, cost: RaftCost): RaftStage {
  if (team.hullWood < cost.hullWood) return 0;
  if (team.mastWood < cost.mastWood || team.mastRope < cost.mastRope) return 1;
  if (team.food < cost.food || team.water < cost.water) return 2;
  return 3;
}

/** Wood a raft part counts for when `character` delivers it (Kaptan +1). */
export function raftPartValue(character: CharacterId): number {
  return RAFT_PART_WOOD + CHARACTERS[character].raftPartBonus;
}

/** Food provisions are delivered cheapest first so the good food stays in your pockets. */
export const FOOD_DELIVERY_ORDER: ReadonlyArray<ItemKind> = (Object.keys(ITEMS) as ItemKind[])
  .filter((k) => ITEMS[k].provision === "food")
  .sort((a, b) => ITEMS[a].food - ITEMS[b].food);

export interface WoodPlan {
  /** Raft parts and wood units taken. */
  parts: number;
  wood: number;
  /** Wood credited (never more than `need`). */
  credited: number;
}

/**
 * How a wood requirement of `need` is filled from `parts` raft parts and `wood` loose wood: whole raft parts
 * while they fit, then wood one by one, then one more raft part when wood ran out (its overshoot is lost: the
 * requirement just completes). Nothing is taken once the need is met (surplus stays with the player).
 */
export function planWood(need: number, parts: number, wood: number, partValue: number, out?: WoodPlan): WoodPlan {
  const plan = out ?? { parts: 0, wood: 0, credited: 0 };
  let left = Math.max(0, need);
  let p = 0;
  let w = 0;
  while (left >= partValue && p < parts) {
    p++;
    left -= partValue;
  }
  while (left > 0 && w < wood) {
    w++;
    left--;
  }
  if (left > 0 && p < parts) {
    p++;
    left = 0;
  }
  plan.parts = p;
  plan.wood = w;
  plan.credited = Math.max(0, need) - left;
  return plan;
}

/** One stage's worth of a delivery: what leaves the inventory and what it credits. */
export interface RaftDeliveryPlan {
  /** Stage the items go to (the current one). */
  stage: RaftStage;
  /** Item units taken from the inventory, by kind (only kinds with count > 0). */
  items: { kind: ItemKind; count: number }[];
  /** Credits per requirement. */
  hullWood: number;
  mastWood: number;
  mastRope: number;
  food: number;
  water: number;
  /** Item units taken (Σ items.count). */
  units: number;
  /** Requirement units credited (a raft part counts its wood): stats.delivered / MVP points. */
  credited: number;
}

/**
 * What E at the raft would deliver to the CURRENT stage right now (null when nothing it needs is in the
 * inventory, or the raft is ready). Wood / raft parts go to the hull (stage 0) or the mast wood (stage 1), rope
 * to the mast (stage 1), provisions (ITEMS[k].provision) to stage 2. The server applies the plan, recomputes the
 * stage and, when the stage completed, plans again for the next one (a single press may fill several stages).
 */
export function planRaftDelivery(inv: Inventory, team: RaftProgress, cost: RaftCost, partValue: number): RaftDeliveryPlan | null {
  const stage = team.stage;
  if (stage >= 3) return null;
  const rem = raftRemaining(team, cost);
  const plan: RaftDeliveryPlan = { stage, items: [], hullWood: 0, mastWood: 0, mastRope: 0, food: 0, water: 0, units: 0, credited: 0 };
  const take = (kind: ItemKind, count: number): void => {
    if (count <= 0) return;
    plan.items.push({ kind, count });
    plan.units += count;
  };
  if (stage === 0 || stage === 1) {
    const need = stage === 0 ? rem.hullWood : rem.mastWood;
    const w = planWood(need, countOf(inv, "raft_part"), countOf(inv, "wood"), partValue);
    take("raft_part", w.parts);
    take("wood", w.wood);
    if (stage === 0) plan.hullWood = w.credited;
    else plan.mastWood = w.credited;
    plan.credited += w.credited;
  }
  if (stage === 1) {
    const rope = Math.min(rem.mastRope, countOf(inv, "rope"));
    take("rope", rope);
    plan.mastRope = rope;
    plan.credited += rope;
  }
  if (stage === 2) {
    let food = rem.food;
    for (const kind of FOOD_DELIVERY_ORDER) {
      if (food <= 0) break;
      const n = Math.min(food, countOf(inv, kind));
      take(kind, n);
      food -= n;
    }
    plan.food = rem.food - food;
    const water = Math.min(rem.water, countOf(inv, "water"));
    take("water", water);
    plan.water = water;
    plan.credited += plan.food + water;
  }
  return plan.units > 0 ? plan : null;
}

/** Carries something the raft takes at SOME stage (wood, raft parts, rope, provisions). */
export function carriesRaftGoods(inv: Inventory): boolean {
  for (let s = 0; s < SLOTS; s++) {
    const k = slotKind(inv, s);
    if (k === "" || slotCount(inv, s) <= 0) continue;
    if (k === "wood" || k === "raft_part" || k === "rope" || ITEMS[k].provision !== null) return true;
  }
  return false;
}

/** The item the current stage still wants most (prompt / HUD hint), "" when ready. */
export function raftWantedItem(team: RaftProgress, cost: RaftCost): InvKind {
  const rem = raftRemaining(team, cost);
  if (team.stage === 0) return "wood";
  if (team.stage === 1) return rem.mastWood > 0 ? "wood" : "rope";
  if (team.stage === 2) return rem.food > 0 ? "coconut" : "water";
  return "";
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
    res.reason = ok ? "" : "full";
    setPos(res.pos, b.x, b.y, b.z);
  });

  // the team's sites
  const site = island.sites[player.team] ?? island.sites[0];
  const team = state.teams[player.team] ?? state.teams[0];
  if (site && team) {
    const teamIdx = site.team;
    const cost = teamRaftCost(team, state.fast === true);
    // raft: board when ready, otherwise deliver
    if (team.stage >= 3) {
      if (better("board", site.raft.x, site.raft.z, RAFT_RANGE, SITE_BODY.raft + CONE_FREE_DIST, true)) fillSite(res, island, site.raft, teamIdx, "");
    } else {
      const plan = planRaftDelivery(player, team, cost, raftPartValue(player.character));
      const ok = plan !== null;
      if (better("deliver", site.raft.x, site.raft.z, RAFT_RANGE, SITE_BODY.raft + CONE_FREE_DIST, ok)) {
        fillSite(res, island, site.raft, teamIdx, raftWantedItem(team, cost));
        if (!ok) res.reason = carriesRaftGoods(player) ? "wrongStage" : "nothingToDeliver";
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
    // spring: a water gourd, or a drink when the pockets are full
    const springOk = roomFor(player, "water") > 0 || player.thirst < 100;
    if (better("spring", site.spring.x, site.spring.z, SPRING_RANGE, SITE_BODY.spring + CONE_FREE_DIST, springOk)) {
      fillSite(res, island, site.spring, teamIdx, "water");
      if (!springOk) res.reason = "full";
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
    res.ticks = gatherTicksFor(n, hasAxe);
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
