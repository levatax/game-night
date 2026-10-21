// Gameplay one-shot events → characters / FP arms / fx / audio / feed / camera (docs/ARCHITECTURE.md §6.2).
// Match-flow events (matchStart, dayPhase, weather, storm, raft ready / board / launch, matchEnd, notices) live in
// flow.ts. Owner: client-app.
//
// "Me" = the local player. Events already predicted for me (my own throw, my LMB use, my eat / catch gesture)
// skip the duplicate SFX / gesture: localThrow / localStep played them the instant the key went down.
//
// Sounds nothing else on screen says get a caption (ui.caption, CAPTION_KEYS): crabs / puffers crawling out of
// the sea (not while the night banner says it), a fence being gnawed, a puffer blast nobody got a feed line for,
// and thunder (GameController times the strike and calls thunder()). Each is rate-limited, only within earshot
// of the camera (CAPTION_RANGE) and says where it came from relative to the view ("behind you").

import {
  CHARACTERS,
  CHEST_HEIGHT,
  FISH_REEL_TICKS,
  FISH_STATE,
  FULL_CHARGE_THRESHOLD,
  MARKER_TICKS,
  TICK_MS,
  TICK_RATE,
  TREASURE_REEL_TICKS,
  playerColor,
} from "../../../shared/constants";
import { heightAt } from "../../../shared/island/heightfield";
import { FISH_LOOT_ITEM } from "../../../shared/items";
import type {
  BlastEvent,
  BottleEvent,
  CatchEvent,
  ChestChangedEvent,
  CraftedEvent,
  DayPhaseEvent,
  DeliverEvent,
  EatEvent,
  EmoteEvent,
  FireFuelEvent,
  FishBiteEvent,
  FishCastEvent,
  FishMissEvent,
  FishResultEvent,
  GatherEvent,
  HitEvent,
  LowBarEvent,
  MarkerEvent,
  MonsterAttackEvent,
  MonsterDieEvent,
  MonsterFlipEvent,
  MonsterHurtEvent,
  MonsterSpawnEvent,
  PalmShakeEvent,
  PickupEvent,
  PlayerDownedEvent,
  PlayerHurtEvent,
  PlayerRespawnEvent,
  PlayerRevivedEvent,
  PlayerWashedEvent,
  RaftDamageEvent,
  RejectEvent,
  SplashEvent,
  StealEvent,
  StickEvent,
  StructureDestroyedEvent,
  StructureHitEvent,
  StructurePlacedEvent,
  ThrowEvent,
  TreasureEvent,
  UseEvent,
} from "../../../shared/protocol";
import type { StepPlayerResult, ThrowRequest } from "../../../shared/sim/player";
import { heldKind } from "../../../shared/sim/player";
import type { CharacterId, RecipeId, Vec3Like } from "../../../shared/types";
import type { VoiceKind } from "../audio/Sfx";
import { bottleText, has, itemName, lootName, recipeName, t, treasureName } from "../i18n";
import type { NetEventMap } from "../net/types";
import { above, bannerLine, bearingOf, captionLine, feedLine, horizontalDir, point, Throttle, type FeedbackContext } from "./feedbackContext";

/** Chance a throw also plays the thrower's voice (§18: voices on throw). */
const THROW_VOICE_CHANCE = 0.3;
/** Pop text / burst heights above an event point (m). */
const POP_ABOVE = 0.6;
const HEAD = 1.75;
/** Feed spam guards (ms). */
const GNAW_FEED_GAP_MS = 8000;
const GNAW_SFX_GAP_MS = 700;
const BAR_HURT_SFX_GAP_MS = 2200;
const VOICE_GAP_MS = 140;
const VOICE_PER_PLAYER_MS = 900;
/** A friend's toss this close (m) brings up the catch tip. */
const CATCH_TIP_RANGE = 10;
/** Shake the local camera for blasts / boss stomps this close (m). */
const SHAKE_RANGE = 9;
/** Sound captions: heard this close to the camera (m; the panners are near silent past it) and how often (ms). */
const CAPTION_RANGE = 30;
const SPAWN_CAPTION_GAP_MS = 8000;
const FENCE_CAPTION_GAP_MS = 8000;
const BLAST_CAPTION_GAP_MS = 5000;
const THUNDER_CAPTION_GAP_MS = 6000;
/** The night banner already says the crabs are coming: no crab caption under it (ms after the night starts). */
const NIGHT_BANNER_MS = 3000;
/** Every caption key the feedback composes (hud.cap_<key>); `{dir}` is " · behind you" or "". */
export const CAPTION_KEYS = ["spawn_crab", "spawn_puffer", "fence", "blast", "thunder", "thunderNear"] as const;
/** Recipes worth a feed line when someone crafts them (the rest are said by the item in their hands). */
const NOTABLE_CRAFTS: ReadonlySet<RecipeId> = new Set<RecipeId>(["rod", "axe", "torch", "collector", "cook_kraken", "coconut_ball", "raft_part"]);

/** The fish-loot SFX / fx when the reel stops. */
const LOOT_SOUND = {
  fish: "catchFish",
  crab: "catchFish",
  boot: "bootBonk",
  jellyfish: "jellyZap",
  puffer: "fuseTick",
  bottle: "bottle",
  treasure: "treasure",
  golden: "golden",
  kraken: "legendary",
} as const;

export class GameFeedback {
  private readonly offs: Array<() => void> = [];
  private readonly throttle = new Throttle();
  private readonly scratch = point(0, 0, 0);
  private lastVoiceAt = -Infinity;
  /** Bobber position of each player's current cast (fishCast events). */
  private readonly bobbers = new Map<string, Vec3Like>();
  private bite: { tick: number; windowTicks: number } | null = null;
  private willRespawnValue: boolean | null = null;
  private nightBannerUntil = -Infinity;
  private readonly view = { x: 0, z: 0, yaw: 0 };

  constructor(private readonly ctx: FeedbackContext) {}

  /** Subscribe to every gameplay event. Idempotent. */
  attach(): void {
    if (this.offs.length > 0) return;
    this.on("localThrow", (e) => this.onLocalThrow(e.result));
    this.on("localStep", (e) => this.onLocalStep(e.result));
    this.on("throw", (e) => this.onThrow(e));
    this.on("hit", (e) => this.onHit(e));
    this.on("splash", (e) => this.onSplash(e));
    this.on("stick", (e) => this.onStick(e));
    this.on("pickup", (e) => this.onPickup(e));
    this.on("catch", (e) => this.onCatch(e));
    this.on("gather", (e) => this.onGather(e));
    this.on("palmShake", (e) => this.onPalmShake(e));
    this.on("use", (e) => this.onUse(e));
    this.on("eat", (e) => this.onEat(e));
    this.on("crafted", (e) => this.onCrafted(e));
    this.on("fireFuel", (e) => this.onFireFuel(e));
    this.on("chestChanged", (e) => this.onChestChanged(e));
    this.on("deliver", (e) => this.onDeliver(e));
    this.on("raftDamage", (e) => this.onRaftDamage(e));
    this.on("structurePlaced", (e) => this.onStructurePlaced(e));
    this.on("structureHit", (e) => this.onStructureHit(e));
    this.on("structureDestroyed", (e) => this.onStructureDestroyed(e));
    this.on("monsterSpawn", (e) => this.onMonsterSpawn(e));
    this.on("monsterHurt", (e) => this.onMonsterHurt(e));
    this.on("monsterFlip", (e) => this.onMonsterFlip(e));
    this.on("monsterDie", (e) => this.onMonsterDie(e));
    this.on("monsterAttack", (e) => this.onMonsterAttack(e));
    this.on("steal", (e) => this.onSteal(e));
    this.on("playerHurt", (e) => this.onPlayerHurt(e));
    this.on("playerDowned", (e) => this.onPlayerDowned(e));
    this.on("playerRevived", (e) => this.onPlayerRevived(e));
    this.on("playerWashed", (e) => this.onPlayerWashed(e));
    this.on("playerRespawn", (e) => this.onPlayerRespawn(e));
    this.on("lowBar", (e) => this.onLowBar(e));
    this.on("blast", (e) => this.onBlast(e));
    this.on("fishCast", (e) => this.onFishCast(e));
    this.on("fishBite", (e) => this.onFishBite(e));
    this.on("fishResult", (e) => this.onFishResult(e));
    this.on("fishMiss", (e) => this.onFishMiss(e));
    this.on("treasure", (e) => this.onTreasure(e));
    this.on("bottle", (e) => this.onBottle(e));
    this.on("reject", (e) => this.onReject(e));
    this.on("marker", (e) => this.onMarker(e));
    this.on("emote", (e) => this.onEmote(e));
    this.on("dayPhase", (e) => this.onDayPhase(e));
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  /** A new match (or leaving the game view): forget per-match memory. */
  reset(): void {
    this.bobbers.clear();
    this.bite = null;
    this.willRespawnValue = null;
    this.nightBannerUntil = -Infinity;
    this.throttle.clear();
  }

  /** A lightning strike's thunder just played (GameController delays it by the distance): caption it. */
  thunder(strength: number): void {
    if (!this.throttle.allow("capThunder", THUNDER_CAPTION_GAP_MS, this.ctx.nowMs)) return;
    captionLine(this.ctx, strength >= 0.8 ? "thunderNear" : "thunder", "⚡");
  }

  /** Where a player's bobber floats (last fishCast), or null. */
  bobberOf(id: string): Vec3Like | null {
    return this.bobbers.get(id) ?? null;
  }

  /** My latest bite window (fishBite). */
  get myBite(): { tick: number; windowTicks: number } | null {
    return this.bite;
  }

  /** From my last playerWashed event. */
  get willRespawn(): boolean | null {
    return this.willRespawnValue;
  }

  private on<K extends keyof NetEventMap>(type: K, fn: (payload: NetEventMap[K]) => void): void {
    this.offs.push(this.ctx.net.events.on(type, fn));
  }

  private isMe(id: string): boolean {
    return id !== "" && id === this.ctx.localId;
  }

  private name(id: string): string {
    return this.ctx.dir.name(id) || "?";
  }

  private character(id: string): CharacterId | null {
    return this.ctx.dir.character(id);
  }

  /** A tourist's gibberish voice, throttled so a big moment doesn't turn into a cacophony. */
  private voice(id: string, kind: VoiceKind, pos?: Vec3Like): void {
    const character = this.character(id);
    if (!character) return;
    const now = this.ctx.nowMs;
    if (now - this.lastVoiceAt < VOICE_GAP_MS) return;
    if (!this.throttle.allow(`voice:${id}`, VOICE_PER_PLAYER_MS, now)) return;
    this.lastVoiceAt = now;
    this.ctx.audio.voice(character, kind, pos);
  }

  private withinOfMe(pos: Vec3Like, range: number): number {
    if (!this.ctx.position(this.ctx.localId, this.scratch)) return Infinity;
    const d = Math.hypot(this.scratch.x - pos.x, this.scratch.z - pos.z);
    return d <= range ? d : Infinity;
  }

  /** Caption a sound heard from `pos` with where it came from, when the camera is within earshot. */
  private captionHeard(key: (typeof CAPTION_KEYS)[number], icon: string, pos: Vec3Like, gapMs: number): void {
    const view = this.cameraView();
    if (view && Math.hypot(pos.x - view.x, pos.z - view.z) > CAPTION_RANGE) return;
    if (!this.throttle.allow(`cap:${key}`, gapMs, this.ctx.nowMs)) return;
    const where = view ? bearingOf(view, view.yaw, pos) : null;
    captionLine(this.ctx, key, icon, { dir: where ? ` · ${t(`hud.dir_${where}`)}` : "" });
  }

  /** The rendered camera's ground position and view yaw (last frame), null before there is one. */
  private cameraView(): { x: number; z: number; yaw: number } | null {
    const m = this.ctx.renderer.camera?.matrixWorld?.elements;
    if (!m || m.length < 16) return null;
    // The camera looks down its local −Z: forward = −(m8, m9, m10), so yaw = atan2(m8, m10).
    this.view.x = m[12] ?? 0;
    this.view.z = m[14] ?? 0;
    this.view.yaw = Math.atan2(m[8] ?? 0, m[10] ?? 1);
    return this.view;
  }

  /* ============================================================= throws */

  /** My own throw / toss, instantly from the prediction (the server `throw` for me is skipped). */
  private onLocalThrow(t: ThrowRequest): void {
    const { audio, characters, renderer } = this.ctx;
    const id = this.ctx.localId;
    const gesture = t.toss ? "toss" : "throw";
    characters.fpArms.play(gesture);
    characters.trigger(id, gesture, { item: t.kind });
    if (!t.toss) renderer.fp.recoil(t.charge);
    this.throwSound(id, t.origin, t.charge, t.toss);
  }

  private onThrow(ev: ThrowEvent): void {
    if (this.isMe(ev.ownerId)) return;
    // A friend tossed something my way: time to learn catching.
    if (ev.toss && Number.isFinite(this.withinOfMe(ev.origin, CATCH_TIP_RANGE))) this.ctx.coach.tip("catch");
    const dir = ev.velocities[0] ? horizontalDir(ev.velocities[0]) : undefined;
    this.ctx.characters.trigger(ev.ownerId, ev.toss ? "toss" : "throw", { dir, item: ev.kind });
    this.throwSound(ev.ownerId, ev.origin, ev.charge, ev.toss);
  }

  private throwSound(id: string, origin: Vec3Like, charge: number, toss: boolean): void {
    const pos = point(origin.x, origin.y, origin.z);
    this.ctx.audio.play(toss ? "toss" : charge >= FULL_CHARGE_THRESHOLD ? "throwHeavy" : "throw", { pos });
    if (!toss && Math.random() < THROW_VOICE_CHANCE) this.voice(id, "throw", pos);
  }

  /** Other predicted one-shots of mine: jump, land, water, LMB use, eat, catch, slot change. */
  private onLocalStep(r: StepPlayerResult): void {
    const sim = this.ctx.net.localSim;
    if (!sim) return;
    const { audio, characters, fx } = this.ctx;
    const id = this.ctx.localId;
    const pos = point(sim.x, sim.y, sim.z);
    if (r.jumped) audio.play("jump", { pos, volume: 0.7 });
    if (r.landed && r.landSpeed > 3) {
      audio.play("land", { pos, volume: Math.min(1, r.landSpeed / 12) });
      if (r.landSpeed > 7) characters.trigger(id, "land");
    }
    if (r.enteredWater) {
      audio.play("waterIn", { pos });
      fx.burst("splash", pos, { scale: 0.8 });
    }
    if (r.leftWater) audio.play("waterOut", { pos, volume: 0.7 });
    if (r.used) this.localUse(this.ctx.net.me?.fishState ?? 0);
    if (r.eat) characters.fpArms.play("eat");
    if (r.catchStarted) {
      characters.fpArms.play("catch");
      characters.trigger(id, "catch");
    }
    if (r.slotChanged) audio.play("uiTick", { volume: 0.35 });
  }

  /** LMB "use" with what's in my hand (rod: cast / strike; torch: swing; placeables; else a punch / palm hit). */
  private localUse(fishState: number): void {
    const sim = this.ctx.net.localSim;
    if (!sim) return;
    const { audio, characters } = this.ctx;
    const held = heldKind(sim);
    if (held === "rod") {
      characters.fpArms.play(fishState === FISH_STATE.BITE ? "reel" : "cast");
      return;
    }
    if (held === "torch") {
      characters.fpArms.play("swing");
      audio.play("swing");
      return;
    }
    if (held === "fence" || held === "collector" || held === "kraken") {
      characters.fpArms.play("place");
      return;
    }
    characters.fpArms.play("use");
    audio.play("swing", { volume: 0.6 });
  }

  /* ============================================================= combat */

  private onHit(ev: HitEvent): void {
    const { audio, characters, fx, renderer } = this.ctx;
    const pos = ev.pos;
    const strong = ev.charge >= FULL_CHARGE_THRESHOLD;
    if (ev.targetType === "player") {
      characters.trigger(ev.targetId, "hit", { dir: horizontalDir(ev.knockback) });
      fx.burst("hitStars", above(pos, 0.2), { scale: strong ? 1.3 : 1 });
      if (ev.kind === "boot") fx.burst("bonk", pos);
      fx.popText(t("feed.pop_bonk"), above(pos, POP_ABOVE), "hit");
      audio.play(ev.kind === "boot" ? "bootBonk" : "bonk", { pos });
      this.voice(ev.targetId, "hurt", pos);
      if (this.isMe(ev.targetId)) {
        renderer.fp.shake(strong ? 0.5 : 0.3);
        characters.fpArms.play("hurt");
      }
      if (ev.throwerId && ev.throwerId !== ev.targetId && this.throttle.allow(`ff:${ev.throwerId}`, 4000, this.ctx.nowMs)) {
        feedLine(this.ctx, "friendlyBonk", "🥥", "info", { name: this.name(ev.throwerId), victim: this.name(ev.targetId), item: itemName(ev.kind) });
      }
      return;
    }
    if (ev.targetType === "monster") {
      characters.monsters.trigger(ev.targetId, "hurt");
      fx.burst(ev.kind === "boot" ? "bonk" : "hitStars", pos, { scale: strong ? 1.2 : 0.9 });
      if (ev.damage > 0) fx.popText(`-${ev.damage}`, above(pos, POP_ABOVE), strong ? "big" : "hit");
      audio.play(ev.kind === "boot" ? "bootBonk" : "hit", { pos });
      if (this.isMe(ev.throwerId)) audio.play("crabClick", { pos, volume: 0.5, pitch: 1.4 });
      return;
    }
    if (ev.targetType === "palm" || ev.targetType === "tree") {
      fx.burst("leaves", above(pos, 0.5), { scale: 0.8 });
      audio.play("bonk", { pos, volume: 0.6, pitch: 0.8 });
      return;
    }
    if (ev.targetType === "rock") {
      fx.burst("stoneChips", pos, { scale: 0.7 });
      audio.play("bonk", { pos, volume: 0.5, pitch: 1.3 });
      return;
    }
    fx.burst("woodChips", pos, { scale: 0.7 });
    audio.play("hit", { pos, volume: 0.7 });
  }

  private onSplash(ev: SplashEvent): void {
    this.ctx.fx.burst("splash", ev.pos, { scale: ev.kind === "raft_part" ? 1.3 : 0.9 });
    this.ctx.fx.burst("ripple", ev.pos);
    this.ctx.audio.play("splash", { pos: ev.pos });
  }

  private onStick(ev: StickEvent): void {
    this.ctx.fx.burst("dust", ev.pos, { scale: 0.5 });
    this.ctx.audio.play("stick", { pos: ev.pos });
  }

  private onCatch(ev: CatchEvent): void {
    const { audio, characters, fx, renderer } = this.ctx;
    if (!this.isMe(ev.playerId)) characters.trigger(ev.playerId, "catch");
    fx.burst("sparkle", ev.pos, { color: this.ctx.dir.color(ev.playerId) });
    audio.play(ev.kept ? "catch" : "bounce", { pos: ev.pos });
    if (this.isMe(ev.playerId)) {
      renderer.fp.punch(0.6);
      if (ev.kept) {
        fx.itemPop(ev.kind, 1, above(ev.pos, 0.4));
        characters.fpArms.caught();
      }
    }
    // A pass between castaways is worth a line (catching a crab-bound coconut is just good reflexes).
    if (ev.kept && ev.throwerId && ev.throwerId !== ev.playerId && this.ctx.dir.view(ev.throwerId)) {
      feedLine(this.ctx, "pass", "🤲", "good", { name: this.name(ev.playerId), thrower: this.name(ev.throwerId), item: itemName(ev.kind) });
    }
  }

  private onBlast(ev: BlastEvent): void {
    const { audio, characters, fx, renderer } = this.ctx;
    fx.burst("blast", ev.pos, { scale: ev.radius / 3 });
    fx.burst("smoke", ev.pos);
    audio.play("blast", { pos: ev.pos });
    if (ev.inHand && ev.byId) {
      characters.trigger(ev.byId, "inflate");
      this.voice(ev.byId, "panic", ev.pos);
      feedLine(this.ctx, "blastInHand", "🐡", "bad", { name: this.name(ev.byId) });
    } else if (ev.monsters.length > 0) {
      feedLine(this.ctx, "blast", "💥", "good", { name: this.name(ev.byId), n: ev.monsters.length });
    } else {
      this.captionHeard("blast", "💥", ev.pos, BLAST_CAPTION_GAP_MS);
    }
    for (const id of ev.players) characters.trigger(id, "hit");
    for (const id of ev.monsters) characters.monsters.trigger(id, "flip");
    const d = this.withinOfMe(ev.pos, SHAKE_RANGE);
    if (Number.isFinite(d)) renderer.fp.shake(Math.max(0.25, 0.8 - d / SHAKE_RANGE));
  }

  /* ========================================================= gathering */

  private onGather(ev: GatherEvent): void {
    const { audio, characters, fx } = this.ctx;
    const me = this.isMe(ev.playerId);
    if (me) characters.fpArms.play("gather");
    else characters.trigger(ev.playerId, "gather");
    const node = this.ctx.net.island?.nodes[ev.node];
    const pos = ev.pos;
    const kind = ev.kind;
    if (node?.kind === "tree" || kind === "wood") {
      fx.burst("woodChips", pos);
      audio.play(ev.depleted ? "chopDone" : "chop", { pos });
    } else if (node?.kind === "rock" || kind === "stone") {
      fx.burst("stoneChips", pos);
      audio.play(ev.depleted ? "mineDone" : "mine", { pos });
    } else if (kind === "berry") {
      fx.burst("berries", pos);
      audio.play("berry", { pos });
      if (me) audio.play("eat", { pos, volume: 0.6 });
    } else {
      fx.burst("leaves", pos, { scale: 0.7 });
      audio.play("rustle", { pos });
    }
    if (me) {
      fx.itemPop(kind, ev.count, above(pos, 0.8));
      if (ev.dropped) feedLine(this.ctx, "pocketsFull", "🎒", "warn");
    }
  }

  private onPalmShake(ev: PalmShakeEvent): void {
    const { audio, characters, fx } = this.ctx;
    if (!this.isMe(ev.playerId)) characters.trigger(ev.playerId, "use");
    fx.burst("leaves", above(ev.pos, 3), { scale: 1.2 });
    audio.play("palmShake", { pos: ev.pos });
    if (ev.projectileIds.length > 0) {
      const n = ev.projectileIds.length;
      for (let i = 0; i < Math.min(n, 4); i++) {
        this.ctx.later.run(380 + i * 120, "coconutFall", () => audio.play("coconutFall", { pos: ev.pos, pitch: 0.9 + Math.random() * 0.2 }));
      }
    }
  }

  private onUse(ev: UseEvent): void {
    const { audio, characters, fx } = this.ctx;
    const me = this.isMe(ev.playerId);
    if (!me) characters.trigger(ev.playerId, "use");
    if (ev.what === "torchSwing") {
      fx.burst("embers", ev.pos, { scale: 0.8 });
      if (!me) audio.play("swing", { pos: ev.pos });
    } else if (ev.what === "whiffPalm") {
      fx.burst("leaves", ev.pos, { scale: 0.5 });
      audio.play("rustle", { pos: ev.pos, volume: 0.6 });
    } else if (!me) {
      audio.play("swing", { pos: ev.pos, volume: 0.6 });
    }
  }

  private onPickup(ev: PickupEvent): void {
    const { audio, fx } = this.ctx;
    const me = this.isMe(ev.playerId);
    if (ev.source === "spring") {
      fx.burst("splash", ev.pos, { scale: 0.5 });
      audio.play("spring", { pos: ev.pos });
    } else if (ev.source === "fish" || ev.source === "treasure") {
      // The reel already made the noise.
    } else {
      audio.play("pickup", { pos: ev.pos, volume: me ? 0.9 : 0.6 });
    }
    if (me) fx.itemPop(ev.kind, ev.count, above(ev.pos, 0.5));
    if (me && ev.source === "crab") this.ctx.fx.burst("crabBits", ev.pos, { scale: 0.6 });
  }

  private onEat(ev: EatEvent): void {
    const { audio, characters, fx } = this.ctx;
    const me = this.isMe(ev.playerId);
    if (!me) characters.trigger(ev.playerId, "eat");
    const drink = ev.kind === "water" || ev.kind === "spring" || ev.kind === "collector";
    audio.play(drink ? "drink" : "eat", { pos: ev.pos });
    if (!drink && Math.random() < 0.25) this.ctx.later.run(650, "burp", () => audio.play("burp", { pos: ev.pos }));
    if (me) {
      const amount = Math.round(ev.hunger + ev.thirst);
      if (amount > 0) fx.popText(`+${amount}`, above(ev.pos, HEAD), "good");
      fx.burst(drink ? "bubbles" : "sparkle", above(ev.pos, HEAD - 0.3), { scale: 0.6 });
    }
    if (ev.kind === "fish_golden") {
      fx.burst("gold", above(ev.pos, 1.2), { scale: 1.4 });
      feedLine(this.ctx, "ateGolden", "🐠", "gold", { name: this.name(ev.playerId) });
    } else if (Math.random() < 0.3) {
      this.voice(ev.playerId, "eat", ev.pos);
    }
  }

  /* ======================================================= camp & raft */

  private onCrafted(ev: CraftedEvent): void {
    const { audio, fx } = this.ctx;
    const me = this.isMe(ev.playerId);
    fx.burst("sparkle", above(ev.pos, 0.8), { scale: 0.8 });
    if (ev.recipe === "fuel") {
      fx.burst("embers", ev.pos);
      audio.play("fireFeed", { pos: ev.pos });
    } else {
      audio.play(ev.recipe === "raft_part" || ev.recipe === "collector" ? "hammer" : "craft", { pos: ev.pos });
    }
    if (me && ev.item) fx.itemPop(ev.item, 1, above(ev.pos, 1));
    if (me && ev.dropped) feedLine(this.ctx, "craftDropped", "🎒", "warn", { item: itemName(ev.item ?? "") });
    if (ev.recipe === "cook_kraken") {
      fx.burst("confetti", above(ev.pos, 1));
      feedLine(this.ctx, "feast", "🦑", "gold", { name: this.name(ev.playerId) });
      return;
    }
    if (NOTABLE_CRAFTS.has(ev.recipe)) {
      feedLine(this.ctx, "crafted", "🔨", me ? "good" : "info", { name: this.name(ev.playerId), item: recipeName(ev.recipe) });
    }
  }

  private onFireFuel(ev: FireFuelEvent): void {
    const { audio, fx } = this.ctx;
    const site = this.ctx.net.island?.sites[ev.team] ?? this.ctx.net.island?.sites[0];
    const pos = site ? point(site.campfire.x, groundY(this.ctx, site.campfire.x, site.campfire.z) + 0.6, site.campfire.z) : null;
    switch (ev.source) {
      case "out":
        audio.play("fireOut", pos ? { pos } : undefined);
        if (pos) fx.burst("smoke", pos, { scale: 1.4 });
        bannerLine(this.ctx, "fireOut", "bad", { sub: "fireOutSub" });
        feedLine(this.ctx, ev.added < 0 ? "fireRained" : "fireOut", "🌑", "bad");
        audio.duck(1.5);
        break;
      case "relit":
        audio.play("fireFeed", pos ? { pos } : undefined);
        if (pos) fx.burst("embers", pos, { scale: 1.6 });
        feedLine(this.ctx, "fireRelit", "🔥", "good", { name: this.name(ev.playerId) });
        break;
      case "jellyfish":
        if (pos) fx.burst("embers", pos, { scale: 1.3, color: "#B57CFF" });
        audio.play("fireFeed", pos ? { pos } : undefined);
        feedLine(this.ctx, "fireJelly", "🪼", "good", { name: this.name(ev.playerId) });
        break;
      case "fuelCan":
        if (pos) fx.burst("embers", pos, { scale: 2 });
        audio.play("fireFeed", pos ? { pos, volume: 1.3 } : undefined);
        break;
      default:
        if (pos) fx.burst("embers", pos);
        audio.play("fireFeed", pos ? { pos } : undefined);
        break;
    }
  }

  private onChestChanged(ev: ChestChangedEvent): void {
    if (ev.op === "steal" || ev.op === "return") {
      if (ev.op === "return" && ev.items[0]) feedLine(this.ctx, "chestReturned", "🐒", "good", { item: itemName(ev.items[0].kind) });
      return;
    }
    if (!this.isMe(ev.playerId)) return;
    this.ctx.audio.play(ev.op === "take" ? "chestOpen" : "chestClose", { volume: 0.8 });
  }

  private onDeliver(ev: DeliverEvent): void {
    const { audio, characters, fx } = this.ctx;
    const me = this.isMe(ev.playerId);
    const site = this.ctx.net.island?.sites[ev.team] ?? this.ctx.net.island?.sites[0];
    const pos = site ? point(site.raft.x, groundY(this.ctx, site.raft.x, site.raft.z) + 0.6, site.raft.z) : null;
    if (me) characters.fpArms.play("deliver", ev.items.map((i) => i.kind));
    else characters.trigger(ev.playerId, "use");
    if (pos) {
      fx.burst("woodChips", pos, { scale: 0.9 });
      fx.burst("sparkle", above(pos, 0.6));
    }
    audio.play("deliver", pos ? { pos } : undefined);
    if (me && pos) {
      const units = ev.items.reduce((s, it) => s + it.count, 0);
      fx.popText(`+${units}`, above(pos, 1.4), "good");
    }
    if (ev.newStage > ev.stage) {
      audio.play("raftStage", pos ? { pos } : undefined);
      if (pos) fx.burst("confetti", above(pos, 1.2), { scale: 0.8 });
      if (ev.newStage < 3) {
        bannerLine(this.ctx, `raftStage${ev.newStage}`, "good", { sub: `raftStage${ev.newStage}Sub` });
        feedLine(this.ctx, `raftStage${ev.newStage}`, "🛶", "good", { name: this.name(ev.playerId) });
      }
    }
  }

  private onRaftDamage(ev: RaftDamageEvent): void {
    const { audio, fx } = this.ctx;
    fx.burst("woodChips", ev.pos, { scale: 0.7 });
    if (this.throttle.allow("gnawSfx", GNAW_SFX_GAP_MS, this.ctx.nowMs)) audio.play("raftGnaw", { pos: ev.pos });
    if (this.throttle.allow("gnawFeed", GNAW_FEED_GAP_MS, this.ctx.nowMs)) feedLine(this.ctx, "raftGnawed", "🦀", "bad");
  }

  private onStructurePlaced(ev: StructurePlacedEvent): void {
    const { audio, characters, fx } = this.ctx;
    if (!this.isMe(ev.playerId)) characters.trigger(ev.playerId, "use");
    fx.burst("dust", ev.pos, { scale: 0.8 });
    if (ev.kind === "torch") fx.burst("embers", above(ev.pos, 1.1), { scale: 0.6 });
    audio.play(ev.kind === "kraken" ? "kraken" : "place", { pos: ev.pos });
    if (ev.kind === "kraken") feedLine(this.ctx, "krakenPlaced", "🦑", "gold", { name: this.name(ev.playerId) });
  }

  private onStructureHit(ev: StructureHitEvent): void {
    this.ctx.fx.burst("woodChips", above(ev.pos, 0.5), { scale: 0.5 });
    this.ctx.audio.play("crabBite", { pos: ev.pos, volume: 0.6, pitch: 0.8 });
    // Monsters chewing a fence you may not see (the feed only speaks up once it breaks).
    if (ev.kind === "fence" && !this.ctx.dir.view(ev.byId)) this.captionHeard("fence", "🚧", ev.pos, FENCE_CAPTION_GAP_MS);
  }

  private onStructureDestroyed(ev: StructureDestroyedEvent): void {
    const { audio, fx } = this.ctx;
    if (ev.kind === "torch") {
      fx.burst("smoke", above(ev.pos, 1));
      return;
    }
    if (ev.kind === "kraken") {
      fx.burst("splash", ev.pos);
      return;
    }
    fx.burst("woodChips", above(ev.pos, 0.4), { scale: 1.2 });
    fx.burst("dust", ev.pos);
    if (ev.kind === "fence" || ev.kind === "collector" || ev.kind === "hut") audio.play("fenceBreak", { pos: ev.pos });
    if (ev.byId && ev.kind === "fence" && this.throttle.allow("fenceFeed", 6000, this.ctx.nowMs)) feedLine(this.ctx, "fenceBroken", "🚧", "bad");
  }

  /* =========================================================== monsters */

  private onMonsterSpawn(ev: MonsterSpawnEvent): void {
    const { audio, characters, fx, renderer } = this.ctx;
    characters.monsters.trigger(ev.id, "spawn");
    if (ev.kind === "monkey") {
      audio.play("monkey", { pos: ev.pos });
      return;
    }
    if (ev.kind === "gull") {
      audio.play("gull", { pos: ev.pos });
      fx.burst("feathers", ev.pos, { scale: 0.6 });
      return;
    }
    fx.burst("splash", ev.pos, { scale: ev.kind === "boss" ? 2 : 0.7 });
    if (ev.kind === "boss") {
      audio.play("bossRoar", { pos: ev.pos, volume: 1.4 });
      audio.duck(3);
      renderer.fp.shake(0.6);
      bannerLine(this.ctx, "boss", "bad", { sub: "bossSub", duration: 3.5 });
      feedLine(this.ctx, "bossArrived", "👑", "bad");
      return;
    }
    if (this.throttle.allow(`emerge:${ev.kind}`, 350, this.ctx.nowMs)) audio.play("crabEmerge", { pos: ev.pos });
    if (this.ctx.nowMs >= this.nightBannerUntil) this.captionHeard(ev.kind === "puffer" ? "spawn_puffer" : "spawn_crab", ev.kind === "puffer" ? "🐡" : "🦀", ev.pos, SPAWN_CAPTION_GAP_MS);
  }

  private onDayPhase(ev: DayPhaseEvent): void {
    if (ev.dayPhase === "night") this.nightBannerUntil = this.ctx.nowMs + NIGHT_BANNER_MS;
  }

  private onMonsterHurt(ev: MonsterHurtEvent): void {
    this.ctx.characters.monsters.trigger(ev.id, "hurt");
    if (ev.kind === "boss") {
      this.ctx.audio.play("bossStomp", { pos: ev.pos, volume: 0.7 });
      if (ev.hp > 0 && ev.hp <= 4 && this.throttle.allow("bossLow", 15000, this.ctx.nowMs)) feedLine(this.ctx, "bossLow", "👑", "good");
    }
  }

  private onMonsterFlip(ev: MonsterFlipEvent): void {
    const { audio, characters, fx } = this.ctx;
    characters.monsters.trigger(ev.id, ev.flipped ? "flip" : "unflip");
    if (ev.flipped) {
      fx.burst("flip", ev.pos);
      audio.play("crabFlip", { pos: ev.pos });
      if (this.isMe(ev.byId)) fx.popText(t("feed.pop_flip"), above(ev.pos, 0.9), "good");
    } else {
      audio.play("crabClick", { pos: ev.pos, volume: 0.6 });
    }
  }

  private onMonsterDie(ev: MonsterDieEvent): void {
    const { audio, characters, fx } = this.ctx;
    characters.monsters.trigger(ev.id, ev.fled ? "flee" : "die");
    if (ev.fled) {
      fx.burst("splash", ev.pos, { scale: 0.5 });
      return;
    }
    if (ev.collected) return; // the pickup event follows
    if (ev.kind === "puffer") {
      fx.burst("blast", ev.pos, { scale: 0.5 });
      audio.play("pufferPop", { pos: ev.pos });
      return;
    }
    fx.burst("crabBits", ev.pos, { scale: ev.kind === "boss" ? 2 : 1 });
    audio.play("crabDie", { pos: ev.pos, pitch: ev.kind === "boss" ? 0.6 : 1 });
    if (ev.kind === "boss") {
      fx.burst("confetti", above(ev.pos, 1.5), { scale: 2 });
      bannerLine(this.ctx, "bossDown", "gold", { params: { name: this.name(ev.byId) } });
      feedLine(this.ctx, "bossDown", "👑", "gold", { name: this.name(ev.byId) });
    }
  }

  private onMonsterAttack(ev: MonsterAttackEvent): void {
    const { audio, characters, renderer } = this.ctx;
    characters.monsters.trigger(ev.id, "attack");
    if (ev.kind === "boss") {
      audio.play("bossStomp", { pos: ev.pos });
      if (Number.isFinite(this.withinOfMe(ev.pos, SHAKE_RANGE))) renderer.fp.shake(0.45);
    } else if (ev.kind === "puffer") {
      audio.play("pufferPop", { pos: ev.pos, volume: 0.8 });
    } else {
      audio.play("crabBite", { pos: ev.pos });
    }
  }

  private onSteal(ev: StealEvent): void {
    const { audio, characters, fx } = this.ctx;
    characters.monsters.trigger(ev.monsterId, ev.dropped ? "drop" : "steal");
    audio.play(ev.dropped ? "drop" : "steal", { pos: ev.pos });
    audio.play(ev.kind === "gull" ? "gull" : "monkey", { pos: ev.pos, volume: 0.8 });
    if (ev.kind === "gull") fx.burst("feathers", ev.pos);
    const item = itemName(ev.item);
    if (ev.dropped) {
      feedLine(this.ctx, ev.kind === "gull" ? "gullDropped" : "monkeyDropped", ev.kind === "gull" ? "🐦" : "🐒", "good", { item });
      return;
    }
    if (ev.fromId === "chest") feedLine(this.ctx, "monkeyStole", "🐒", "bad", { item });
    else {
      feedLine(this.ctx, "gullStole", "🐦", "bad", { name: this.name(ev.fromId), item });
      if (this.isMe(ev.fromId)) this.voice(ev.fromId, "panic", ev.pos);
    }
  }

  /* ============================================================ players */

  private onPlayerHurt(ev: PlayerHurtEvent): void {
    const { audio, characters, fx, renderer } = this.ctx;
    const me = this.isMe(ev.playerId);
    const barCause = ev.cause === "hunger" || ev.cause === "thirst" || ev.cause === "cold" || ev.cause === "drown" || ev.cause === "jellyfish";
    if (barCause) {
      // Ticking damage: a soft reminder for me now and then, nothing for others.
      if (!me || !this.throttle.allow("barHurt", BAR_HURT_SFX_GAP_MS, this.ctx.nowMs)) return;
      audio.play(ev.cause === "jellyfish" ? "jellyZap" : "hurt", { volume: 0.5 });
      if (ev.cause === "cold") this.voice(ev.playerId, "shiver");
      renderer.fp.shake(0.1);
      return;
    }
    characters.trigger(ev.playerId, "hit");
    fx.burst("hitStars", above(ev.pos, CHEST_HEIGHT), { scale: ev.amount >= 30 ? 1.4 : 1 });
    audio.play("hurt", { pos: ev.pos });
    this.voice(ev.playerId, "hurt", ev.pos);
    if (me) {
      renderer.fp.shake(Math.min(0.8, 0.2 + ev.amount / 50));
      characters.fpArms.play("hurt");
    }
  }

  private onPlayerDowned(ev: PlayerDownedEvent): void {
    const { audio, characters, fx, renderer } = this.ctx;
    characters.trigger(ev.playerId, "downed");
    fx.burst("hitStars", above(ev.pos, 0.6), { scale: 1.3 });
    audio.play("downed", { pos: ev.pos });
    this.voice(ev.playerId, "downed", ev.pos);
    const cause = has(`feed.downed_${ev.cause}`) ? `downed_${ev.cause}` : "downed";
    feedLine(this.ctx, cause, "💫", "bad", { name: this.name(ev.playerId) });
    if (this.isMe(ev.playerId)) {
      renderer.fp.shake(0.6);
      this.ctx.coach.tip("downed");
    } else {
      this.ctx.coach.tip("revive");
    }
  }

  private onPlayerRevived(ev: PlayerRevivedEvent): void {
    const { audio, characters, fx } = this.ctx;
    characters.trigger(ev.playerId, "revived");
    fx.burst("hearts", above(ev.pos, 1.2));
    audio.play("revive", { pos: ev.pos });
    this.voice(ev.playerId, "revived", ev.pos);
    feedLine(this.ctx, "revived", "❤️", "good", { name: this.name(ev.playerId), by: this.name(ev.byId) });
  }

  private onPlayerWashed(ev: PlayerWashedEvent): void {
    const { audio, characters, fx } = this.ctx;
    characters.trigger(ev.playerId, "washed");
    fx.burst("splash", ev.pos, { scale: 1.2 });
    audio.play("washed", { pos: ev.pos });
    feedLine(this.ctx, ev.willRespawn ? "washed" : "washedLast", "🌊", "bad", { name: this.name(ev.playerId) });
    if (this.isMe(ev.playerId)) {
      this.willRespawnValue = ev.willRespawn;
      audio.duck(2);
    }
  }

  private onPlayerRespawn(ev: PlayerRespawnEvent): void {
    const { audio, characters, fx } = this.ctx;
    characters.trigger(ev.playerId, "respawn");
    fx.burst("sparkle", above(ev.pos, 1));
    audio.play("respawn", { pos: ev.pos });
    feedLine(this.ctx, "respawn", "🌅", "info", { name: this.name(ev.playerId) });
    if (this.isMe(ev.playerId)) {
      this.willRespawnValue = null;
      bannerLine(this.ctx, "respawn", "good", { sub: "respawnSub" });
    }
  }

  private onLowBar(ev: LowBarEvent): void {
    feedLine(this.ctx, `lowBar_${ev.bar}`, ev.bar === "hunger" ? "🍖" : ev.bar === "thirst" ? "💧" : ev.bar === "warmth" ? "🥶" : "❤️", "warn", {
      name: this.name(ev.playerId),
    });
    if (!this.isMe(ev.playerId)) return;
    this.ctx.audio.play("lowBar");
    if (ev.bar === "warmth") {
      this.ctx.audio.play("shiver");
      this.voice(ev.playerId, "shiver");
    }
  }

  /* ============================================================ fishing */

  private onFishCast(ev: FishCastEvent): void {
    this.bobbers.set(ev.playerId, point(ev.pos.x, ev.pos.y, ev.pos.z));
    const { audio, characters, fx } = this.ctx;
    if (!this.isMe(ev.playerId)) characters.trigger(ev.playerId, "cast");
    audio.play("cast", { pos: ev.pos });
    this.ctx.later.run(450, "plop", () => {
      fx.burst("ripple", ev.pos);
      audio.play("splash", { pos: ev.pos, volume: 0.35, pitch: 1.6 });
    });
  }

  private onFishBite(ev: FishBiteEvent): void {
    const { audio, fx } = this.ctx;
    const pos = this.bobbers.get(ev.playerId);
    if (pos) {
      fx.burst("ripple", pos, { scale: 1.3 });
      fx.burst("splash", pos, { scale: 0.4 });
    }
    if (this.isMe(ev.playerId)) {
      this.bite = { tick: ev.tick, windowTicks: ev.windowTicks };
      audio.play("bite", { volume: 1.2 });
    } else {
      audio.play("bite", pos ? { pos, volume: 0.5 } : { volume: 0.3 });
    }
  }

  private onFishResult(ev: FishResultEvent): void {
    const { audio, characters, ui } = this.ctx;
    const me = this.isMe(ev.playerId);
    if (me) {
      this.bite = null;
      characters.fpArms.play("reel");
    } else {
      characters.trigger(ev.playerId, "reel");
    }
    const durationMs = FISH_REEL_TICKS * TICK_MS;
    if (me) audio.play("reelSpin");
    // Revealed when the reel actually lands (it may wait behind another reel), not on a fixed timer.
    ui.reel({ kind: "fish", strip: [...ev.reel], stopIndex: ev.stopIndex, durationMs, who: me ? "" : this.name(ev.playerId), onLanded: () => this.fishLanded(ev, me) });
  }

  /** The "What did I get?" reel stopped. */
  private fishLanded(ev: FishResultEvent, me: boolean): void {
    const { audio, fx, renderer } = this.ctx;
    const bobber = this.bobbers.get(ev.playerId);
    this.bobbers.delete(ev.playerId);
    if (me) audio.play("reelStop");
    const pos = bobber ?? undefined;
    audio.play(LOOT_SOUND[ev.loot], pos && !me ? { pos, volume: 0.7 } : undefined);
    if (bobber) fx.burst("splash", bobber, { scale: 0.7 });
    const name = this.name(ev.playerId);
    const loot = lootName(ev.loot);
    switch (ev.loot) {
      case "golden":
        if (bobber) fx.burst("gold", above(bobber, 0.6), { scale: 1.6 });
        if (me) {
          renderer.fp.punch(1.2);
          bannerLine(this.ctx, "golden", "gold", { sub: "goldenSub" });
        }
        this.voice(ev.playerId, "cheer");
        feedLine(this.ctx, "caughtGolden", "🐠", "gold", { name });
        break;
      case "kraken":
        if (me) renderer.fp.punch(0.8);
        feedLine(this.ctx, "caughtKraken", "🦑", "gold", { name });
        break;
      case "boot":
        if (me) feedLine(this.ctx, "caughtBoot", "🥾", "info", { name });
        break;
      case "jellyfish":
        if (me) feedLine(this.ctx, "caughtJelly", "🪼", "warn", { name });
        break;
      case "puffer":
        if (me) feedLine(this.ctx, "caughtPuffer", "🐡", "warn", { name });
        break;
      case "fish":
      case "crab":
        if (me && ev.pity) feedLine(this.ctx, "pity", "🍀", "good", { item: loot });
        if (!me && Math.random() < 0.5) this.voice(ev.playerId, "yes", pos);
        break;
      default:
        break;
    }
    if (me) {
      const item = FISH_LOOT_ITEM[ev.loot];
      if (item && bobber) fx.itemPop(item, 1, above(bobber, 0.8));
    }
  }

  private onFishMiss(ev: FishMissEvent): void {
    this.bobbers.delete(ev.playerId);
    if (!this.isMe(ev.playerId)) return;
    this.bite = null;
    this.ctx.audio.play("miss");
    if (ev.reason === "late" || ev.reason === "early") feedLine(this.ctx, `fishMiss_${ev.reason}`, "🎣", "warn");
  }

  private onTreasure(ev: TreasureEvent): void {
    const { audio, ui } = this.ctx;
    const me = this.isMe(ev.playerId);
    const durationMs = TREASURE_REEL_TICKS * TICK_MS;
    if (me) audio.play("chestOpen");
    ui.reel({ kind: "treasure", strip: [...ev.reel], stopIndex: ev.stopIndex, durationMs, who: me ? "" : this.name(ev.playerId), onLanded: () => {
      audio.play("treasure");
      if (me) this.ctx.renderer.fp.punch(0.7);
      const params = { name: this.name(ev.playerId), treasure: treasureName(ev.treasure) };
      feedLine(this.ctx, "treasure", "💰", "gold", params);
      bannerLine(this.ctx, `treasure_${ev.treasure}`, "gold", { sub: `treasure_${ev.treasure}Sub`, params });
    } });
  }

  private onBottle(ev: BottleEvent): void {
    this.ctx.audio.play("bottle");
    feedLine(this.ctx, "bottle", "🍾", "gold", { name: this.name(ev.playerId), effect: bottleText(ev.effect) });
    if (ev.effect === "recipe") this.ctx.audio.play("legendary", { volume: 0.7 });
  }

  /* ============================================================= social */

  private onReject(ev: RejectEvent): void {
    if (!this.isMe(ev.playerId)) return;
    if (!this.throttle.allow(`reject:${ev.reason}`, 1200, this.ctx.nowMs)) return;
    this.ctx.audio.play("uiError", { volume: 0.7 });
    const key = has(`reject.${ev.reason}`) ? `reject.${ev.reason}` : "feed.rejectGeneric";
    this.ctx.ui.toast(t(key), "warn");
    if (ev.reason === "full") this.ctx.coach.tip("chest");
  }

  private onMarker(ev: MarkerEvent): void {
    const { audio, fx } = this.ctx;
    this.ctx.pings.add(ev, this.ctx.nowMs);
    const seat = this.ctx.dir.seat(ev.playerId);
    const label = ev.kind === "need" && ev.need ? t("feed.markerNeed", { item: itemName(ev.need) }) : t(`prompt.mark_${ev.kind}`);
    fx.marker({ id: ev.playerId, kind: ev.kind, pos: ev.pos, color: seat >= 0 ? playerColor(seat) : "#FFD166", label, ttl: MARKER_TICKS / TICK_RATE });
    audio.play("marker", { pos: ev.pos, volume: this.isMe(ev.playerId) ? 0.8 : 1 });
    this.voice(ev.playerId, ev.kind === "help" || ev.kind === "danger" ? "help" : "yes");
    if (!this.isMe(ev.playerId)) {
      const who = this.name(ev.playerId);
      const kaptan = this.character(ev.playerId) === "kaptan" && has(`feed.marker_${ev.kind}_kaptan`);
      feedLine(this.ctx, kaptan ? `marker_${ev.kind}_kaptan` : `marker_${ev.kind}`, ev.kind === "danger" ? "⚠️" : "📍", ev.kind === "danger" || ev.kind === "help" ? "warn" : "info", {
        name: who,
        item: ev.need ? itemName(ev.need) : "",
      });
    }
  }

  private onEmote(ev: EmoteEvent): void {
    const { audio, characters } = this.ctx;
    characters.trigger(ev.playerId, "emote", { emote: ev.emote });
    const pos = this.ctx.position(ev.playerId, this.scratch) ? point(this.scratch.x, this.scratch.y + HEAD, this.scratch.z) : undefined;
    audio.play("emote", pos ? { pos } : undefined);
    const voice: VoiceKind = ev.emote === "panic" ? "panic" : ev.emote === "clap" || ev.emote === "dance" ? "cheer" : ev.emote === "tired" ? "shiver" : "emote";
    this.voice(ev.playerId, voice, pos);
    if (ev.emote === "selfie" && this.character(ev.playerId) === "fenomen" && pos) this.ctx.fx.burst("sparkle", pos, { scale: 1.2, color: CHARACTERS.fenomen.colors.accent });
  }
}

/** Terrain height at (x, z) on the current island (0 before one is loaded). */
function groundY(ctx: FeedbackContext, x: number, z: number): number {
  const def = ctx.net.island;
  return def ? heightAt(def.grid, x, z) : 0;
}
