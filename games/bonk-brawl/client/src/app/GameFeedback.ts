// Gameplay one-shot events → characters / fx / audio / kill feed / camera, per the event →
// feedback table in docs/ARCHITECTURE.md §8. Round-flow events (roundStart, countdown,
// suddenDeath, roundWin, matchEnd) live in GameController because they drive its own state.
// Owner: client-app.

import * as THREE from "three";
import {
  CATCH_SLOWMO_MS,
  CATCH_SLOWMO_SCALE,
  CHARACTERS,
  CHEST_HEIGHT,
  FULL_CHARGE_THRESHOLD,
  HIT_STOP_MS,
  PEDESTAL_HEIGHT,
  POWERUP_HOVER_Y,
  POWERUPS,
} from "../../../shared/constants";
import type {
  AbilityEvent,
  BallSpawnEvent,
  BoomerangReturnEvent,
  CatchEvent,
  DeflectEvent,
  EmoteEvent,
  HeadbuttEvent,
  HitEvent,
  KoEvent,
  PickupEvent,
  PowerUpPickupEvent,
  PowerUpSpawnEvent,
  PowerUpWarningEvent,
  RingDropEvent,
  RingShakeEvent,
  RingOutEvent,
  ShockwaveEvent,
  ThrowEvent,
  WhiffEvent,
} from "../../../shared/protocol";
import type { ThrowRequest } from "../../../shared/sim/player";
import type { CharacterId, Vec3Like } from "../../../shared/types";
import type { NetEventMap } from "../net/types";
import type { KillFeedKind } from "../ui/models";
import type { GameControllerDeps } from "./GameController";
import type { PlayerEffects } from "./PlayerEffects";
import type { PlayerDirectory } from "./viewModels";

/** Chance a throw also plays the thrower's voice (game1.md §12: voices on throw). */
const THROW_VOICE_CHANCE = 0.3;
/** A ring-out victim watches their fall for this long before the ghost camera takes over. */
const RING_OUT_GHOST_DELAY_SEC = 0.8;
/** Shockwaves shake the local camera within this distance. */
const SHOCKWAVE_SHAKE_RANGE = 6;
/** Pop text heights above the event point (m). */
const POP_ABOVE_HIT = 0.6;
const POP_ABOVE_HEAD = 1.7;

/** What GameFeedback needs from its controller. */
export interface FeedbackHost {
  /** Own sessionId ("" when not connected). */
  readonly localId: string;
  /** Last rendered feet position of a player, falling back to its state position. */
  playerPosition(id: string, out: Vec3Like): boolean;
  /** The local player was eliminated: spectating banner + ghost camera (after `ghostDelaySec`). */
  localEliminated(reason: "ko" | "ringOut", pos: Vec3Like, ghostDelaySec: number): void;
}

function point(x: number, y: number, z: number): Vec3Like {
  return { x, y, z };
}

function above(p: Vec3Like, dy: number): Vec3Like {
  return point(p.x, p.y + dy, p.z);
}

/** Unit horizontal direction of `v` (the knockback), or undefined when it has no horizontal part. */
function horizontalDir(v: Vec3Like): Vec3Like | undefined {
  const len = Math.hypot(v.x, v.z);
  return len > 1e-4 ? point(v.x / len, 0, v.z / len) : undefined;
}

export class GameFeedback {
  private readonly offs: Array<() => void> = [];
  private feedId = 0;
  private readonly scratch = point(0, 0, 0);
  private readonly head = new THREE.Vector3();

  constructor(
    private readonly deps: GameControllerDeps,
    private readonly directory: PlayerDirectory,
    private readonly effects: PlayerEffects,
    private readonly host: FeedbackHost,
  ) {}

  /** Subscribe to every gameplay event. Idempotent. */
  attach(): void {
    if (this.offs.length > 0) return;
    this.on("localThrow", (e) => this.onLocalThrow(e.result));
    this.on("localStep", (e) => this.onLocalStep(e.result));
    this.on("throw", (e) => this.onThrow(e));
    this.on("pickup", (e) => this.onPickup(e));
    this.on("hit", (e) => this.onHit(e));
    this.on("catch", (e) => this.onCatch(e));
    this.on("whiff", (e) => this.onWhiff(e));
    this.on("deflect", (e) => this.onDeflect(e));
    this.on("ringOut", (e) => this.onRingOut(e));
    this.on("ko", (e) => this.onKo(e));
    this.on("emote", (e) => this.onEmote(e));
    this.on("ability", (e) => this.onAbility(e));
    this.on("shockwave", (e) => this.onShockwave(e));
    this.on("headbutt", (e) => this.onHeadbutt(e));
    this.on("ballSpawn", (e) => this.onBallSpawn(e));
    this.on("boomerangReturn", (e) => this.onBoomerangReturn(e));
    this.on("powerUpWarning", (e) => this.onPowerUpWarning(e));
    this.on("powerUpSpawn", (e) => this.onPowerUpSpawn(e));
    this.on("powerUpPickup", (e) => this.onPowerUpPickup(e));
    this.on("ringShake", (e) => this.onRingShake(e));
    this.on("ringDrop", (e) => this.onRingDrop(e));
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private on<K extends keyof NetEventMap>(type: K, fn: (payload: NetEventMap[K]) => void): void {
    this.offs.push(this.deps.net.events.on(type, fn));
  }

  /* ------------------------------------------------------------- throws */

  /** Own throw, played instantly from the prediction (the server `throw` for me is skipped). */
  private onLocalThrow(t: ThrowRequest): void {
    const id = this.host.localId;
    this.deps.characters.trigger(id, "throw", { strength: t.charge });
    this.effects.onThrow(id);
    this.throwSound(t.origin, t.charge, t.powerUp === "mega", this.directory.character(id));
  }

  private onThrow(ev: ThrowEvent): void {
    if (ev.ownerId === this.host.localId) return;
    this.deps.characters.trigger(ev.ownerId, "throw", { strength: ev.charge });
    this.effects.onThrow(ev.ownerId);
    this.throwSound(ev.origin, ev.charge, ev.kind === "mega", ev.character);
  }

  private throwSound(origin: Vec3Like, charge: number, mega: boolean, character: CharacterId | null): void {
    const pos = point(origin.x, origin.y, origin.z);
    const heavy = mega || charge >= FULL_CHARGE_THRESHOLD;
    this.deps.audio.play(heavy ? "throwHeavy" : "throw", { pos });
    if (character && Math.random() < THROW_VOICE_CHANCE) this.deps.audio.voice(character, "throw", { pos });
  }

  /* ------------------------------------------------- own predicted steps */

  private onLocalStep(result: NetEventMap["localStep"]["result"]): void {
    const sim = this.deps.net.localSim;
    if (!sim) return;
    const pos = point(sim.x, sim.y, sim.z);
    const { audio, fx } = this.deps;
    if (result.jumped) audio.play("jump", { pos });
    if (result.rollStarted) {
      fx.particles.burst("puff", pos, { scale: 0.7 });
      audio.play("roll", { pos });
    }
    if (result.abilityStarted) {
      const character = this.directory.character(this.host.localId);
      if (character) this.abilityFeedback(this.host.localId, character, pos, point(sim.dirX, 0, sim.dirZ));
    }
  }

  private onAbility(ev: AbilityEvent): void {
    if (ev.playerId === this.host.localId) return;
    this.abilityFeedback(ev.playerId, ev.character, ev.pos, ev.dir);
  }

  private abilityFeedback(id: string, character: CharacterId, pos: Vec3Like, dir: Vec3Like): void {
    const { audio, characters, fx } = this.deps;
    const def = CHARACTERS[character];
    if (!def) return;
    characters.trigger(id, "ability");
    const chest = above(pos, CHEST_HEIGHT);
    const back = point(-dir.x, 0, -dir.z);
    switch (def.ability.id) {
      case "flapDash":
        fx.particles.burst("feathers", chest, { color: def.colors.body, scale: 0.8 });
        fx.particles.burst("speedLines", chest, { dir: back });
        audio.play("flapDash", { pos });
        break;
      case "groundPound":
        fx.particles.burst("dust", pos, { scale: 0.8 });
        audio.play("groundPoundLeap", { pos });
        break;
      case "bellyBounce":
        fx.particles.burst("bubbles", chest, { scale: 1.2 });
        audio.voice(character, "emote", { pos });
        break;
      case "curveball":
        fx.particles.burst("sparkles", chest, { color: this.directory.color(id) });
        audio.play("curveArm", { pos });
        break;
      case "bellySlide":
        fx.particles.burst("dust", pos, { dir: back });
        audio.play("bellySlide", { pos });
        break;
      case "headbutt":
        fx.particles.burst("puff", pos, { scale: 0.6, dir: back });
        audio.play("roll", { pos, pitch: 0.8 });
        break;
    }
  }

  /* -------------------------------------------------------------- combat */

  private onPickup(ev: PickupEvent): void {
    this.deps.characters.trigger(ev.playerId, "pickup");
    this.deps.audio.play("pickup", { pos: ev.pos });
    this.deps.audio.play("squeak", { pos: ev.pos, volume: 0.5 });
  }

  private onHit(ev: HitEvent): void {
    const { audio, camera, characters, fx } = this.deps;
    const me = this.host.localId;
    const mega = ev.kind === "mega";
    const strong = mega || ev.fullCharge;
    characters.trigger(ev.targetId, "hit", { dir: horizontalDir(ev.knockback), strength: strong ? 1 : 0.6 });
    fx.particles.burst("stars", ev.pos, { scale: mega ? 1.6 : strong ? 1.3 : 1 });
    fx.popText.show("bonk", above(ev.pos, POP_ABOVE_HIT), this.directory.color(ev.throwerId));
    if (ev.throwerId === me || ev.targetId === me) fx.feel.hitStop(HIT_STOP_MS);
    audio.play("bonk", { pos: ev.pos, volume: strong ? 1 : 0.85 });
    if (mega) audio.announce?.("bonk");
    const victim = this.directory.character(ev.targetId);
    if (victim) audio.voice(victim, "hit", { pos: ev.pos });
    if (ev.throwerId === me) audio.play("ding");
    if (ev.targetId === me) camera.shake(mega ? 0.6 : 0.35, 0.35);
    this.pushFeed("bonk", ev.throwerId, ev.targetId);
  }

  private onCatch(ev: CatchEvent): void {
    const { audio, camera, characters, fx } = this.deps;
    const me = this.host.localId;
    const color = this.directory.color(ev.catcherId);
    characters.trigger(ev.catcherId, "catch");
    fx.popText.show("catch", above(ev.pos, POP_ABOVE_HIT), color);
    fx.particles.burst("sparkles", ev.pos, { color, scale: 1.2 });
    if (ev.catcherId === me) fx.feel.slowMo(CATCH_SLOWMO_SCALE, CATCH_SLOWMO_MS);
    // The thrower just lost a heart to the catch: a small nudge so it registers.
    if (ev.throwerId === me) camera.shake(0.2, 0.25);
    audio.play("catch", { pos: ev.pos });
    audio.play("crowdOoh");
    const catcher = this.directory.character(ev.catcherId);
    if (catcher) audio.voice(catcher, "catch", { pos: ev.pos });
    this.pushFeed("catch", ev.catcherId, ev.throwerId);
  }

  private onWhiff(ev: WhiffEvent): void {
    this.deps.characters.trigger(ev.playerId, "whiff");
    this.deps.fx.popText.show("miss", this.headOf(ev.playerId, ev.pos));
    this.deps.audio.play("whiff", { pos: ev.pos });
  }

  private onDeflect(ev: DeflectEvent): void {
    const { audio, characters, fx } = this.deps;
    const view = this.directory.view(ev.playerId);
    const bouncy = view?.character === "mochi" && view.abilityTicks > 0;
    if (bouncy) {
      characters.trigger(ev.playerId, "ability");
      fx.particles.burst("bubbles", ev.pos, { scale: 1.2 });
      audio.play("bellyBoing", { pos: ev.pos });
    } else {
      audio.play("bounce", { pos: ev.pos });
    }
    fx.popText.show("boing", above(ev.pos, POP_ABOVE_HIT), this.directory.color(ev.playerId));
  }

  private onShockwave(ev: ShockwaveEvent): void {
    const { audio, camera, characters, fx } = this.deps;
    characters.trigger(ev.playerId, "slam");
    for (const id of ev.affected) {
      if (!this.host.playerPosition(id, this.scratch)) continue;
      characters.trigger(id, "hit", { dir: horizontalDir({ x: this.scratch.x - ev.pos.x, y: 0, z: this.scratch.z - ev.pos.z }), strength: 0.6 });
    }
    fx.particles.burst("shockwave", ev.pos, { scale: ev.radius });
    fx.particles.burst("dust", ev.pos, { scale: 1.5 });
    audio.play("shockwave", { pos: ev.pos });
    if (this.localWithin(ev.pos, SHOCKWAVE_SHAKE_RANGE)) camera.shake(0.5, 0.4);
  }

  private onHeadbutt(ev: HeadbuttEvent): void {
    const { audio, camera, characters, fx } = this.deps;
    characters.trigger(ev.targetId, "hit", { dir: horizontalDir(ev.knockback), strength: 1 });
    fx.particles.burst("stars", ev.pos, { scale: 1.2 });
    audio.play("headbutt", { pos: ev.pos });
    if (ev.targetId === this.host.localId) camera.shake(0.5, 0.4);
  }

  /* -------------------------------------------------------- eliminations */

  private onRingOut(ev: RingOutEvent): void {
    const { audio, characters, fx } = this.deps;
    characters.trigger(ev.playerId, "ringOut", { pos: ev.pos });
    fx.popText.show("out", above(ev.pos, POP_ABOVE_HEAD), this.directory.color(ev.playerId));
    audio.play("slideWhistle", { pos: ev.pos });
    audio.announce?.("ringOut");
    const victim = this.directory.character(ev.playerId);
    if (victim) audio.voice(victim, "ko", { pos: ev.pos });
    this.pushFeed(ev.creditId ? "ringOut" : "fell", ev.creditId, ev.playerId);
    if (ev.playerId === this.host.localId) this.host.localEliminated("ringOut", ev.pos, RING_OUT_GHOST_DELAY_SEC);
  }

  private onKo(ev: KoEvent): void {
    const { audio, characters, fx } = this.deps;
    const character = this.directory.character(ev.playerId);
    const chest = above(ev.pos, CHEST_HEIGHT);
    characters.trigger(ev.playerId, "ko", { pos: ev.pos });
    fx.particles.burst("puff", chest, { scale: 1.4 });
    if (character) fx.particles.burst("feathers", chest, { color: CHARACTERS[character].colors.body, scale: 1.2 });
    fx.popText.show("out", above(ev.pos, POP_ABOVE_HEAD), this.directory.color(ev.playerId));
    audio.play("ko", { pos: ev.pos });
    if (character) audio.voice(character, "ko", { pos: ev.pos });
    this.pushFeed(ev.cause === "disconnect" ? "dropped" : "ko", ev.cause === "disconnect" ? "" : ev.byId, ev.playerId);
    if (ev.playerId === this.host.localId) this.host.localEliminated("ko", ev.pos, 0);
  }

  /* ------------------------------------------------------------ emotes */

  private onEmote(ev: EmoteEvent): void {
    this.deps.characters.trigger(ev.playerId, "emote", { emote: ev.emote });
    const pos = this.host.playerPosition(ev.playerId, this.scratch) ? point(this.scratch.x, this.scratch.y, this.scratch.z) : undefined;
    if (ev.emote === "honk") {
      this.deps.audio.play("honk", { pos });
      return;
    }
    const character = this.directory.character(ev.playerId);
    if (character) this.deps.audio.voice(character, "emote", { pos });
  }

  /* ------------------------------------------------- balls & power-ups */

  private onBallSpawn(ev: BallSpawnEvent): void {
    this.deps.audio.play("ballDrop", { pos: ev.pos });
  }

  private onBoomerangReturn(ev: BoomerangReturnEvent): void {
    this.deps.audio.play(ev.caught ? "pickup" : "boomerang", { pos: ev.pos });
  }

  private onPowerUpWarning(ev: PowerUpWarningEvent): void {
    this.deps.audio.play("powerUpWarning", { pos: ev.pos });
  }

  private onPowerUpSpawn(ev: PowerUpSpawnEvent): void {
    this.deps.fx.particles.burst("sparkles", hoverPoint(ev.pos), { color: POWERUPS[ev.type].color, scale: 1.2 });
    this.deps.audio.play("powerUpSparkle", { pos: ev.pos });
  }

  private onPowerUpPickup(ev: PowerUpPickupEvent): void {
    const def = POWERUPS[ev.type];
    this.deps.fx.particles.burst("sparkles", hoverPoint(ev.pos), { color: def.color, scale: 1.5 });
    this.deps.audio.play("powerUpPickup", { pos: ev.pos });
    if (ev.type === "zoomies") this.deps.audio.play("zoomies", { pos: ev.pos });
    if (ev.playerId === this.host.localId) this.deps.ui.toast(`${def.icon} ${def.name}!`, "success");
  }

  /* ---------------------------------------------------- sudden death */

  private onRingShake(ev: RingShakeEvent): void {
    void ev;
    this.deps.audio.play("ringShake");
    this.deps.camera.shake(0.1, 0.8);
  }

  /** Crumb particles come from the arena's onRingFall hook (GameController), in sync with the visuals. */
  private onRingDrop(ev: RingDropEvent): void {
    void ev;
    this.deps.audio.play("crumbleRumble");
    this.deps.camera.shake(0.25, 0.6);
  }

  /* ----------------------------------------------------------- helpers */

  private pushFeed(kind: KillFeedKind, actorId: string, victimId: string): void {
    this.deps.ui.pushKillFeed({
      id: ++this.feedId,
      kind,
      actor: actorId ? this.directory.feed(actorId) : null,
      victim: this.directory.feed(victimId),
    });
  }

  /** Above the player's rendered head, or above `fallback` when the animal isn't known. */
  private headOf(id: string, fallback: Vec3Like): Vec3Like {
    if (this.deps.characters.getHeadTop(id, this.head)) return above(this.head, 0.3);
    return above(fallback, POP_ABOVE_HEAD);
  }

  private localWithin(pos: Vec3Like, range: number): boolean {
    if (!this.host.playerPosition(this.host.localId, this.scratch)) return false;
    return Math.hypot(this.scratch.x - pos.x, this.scratch.y - pos.y, this.scratch.z - pos.z) <= range;
  }
}

/** Where a pedestal power-up floats (event positions are on the floor). */
function hoverPoint(pos: Vec3Like): Vec3Like {
  return point(pos.x, PEDESTAL_HEIGHT + POWERUP_HOVER_Y, pos.z);
}
