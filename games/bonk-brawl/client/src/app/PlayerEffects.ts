// Continuous per-player feedback derived from rendered frames: landings, remote jumps/rolls,
// charge telegraph (held-ball glow + positional whoosh), zoomies / dash / slide / skid trails and
// their loops, tumble bounces, turn skids, tumble ribbons and the off-island launch warning.
// Owner: client-app.

import * as THREE from "three";
import { CHARACTERS, DT, MOVE_SPEED, POWERUPS, TUMBLE_RESTITUTION, ZOOMIES_MULT } from "../../../shared/constants";
import type { FloorQuery, SimContext } from "../../../shared/sim/context";
import { predictTumbleLanding } from "../../../shared/sim/landing";
import { vec3 } from "../../../shared/sim/math";
import { chargeFraction } from "../../../shared/sim/player";
import { throwOrigin } from "../../../shared/sim/throw";
import type { Vec3Like } from "../../../shared/types";
import type { AudioEngine, LoopHandle } from "../audio/AudioEngine";
import type { LoopId } from "../audio/Sfx";
import type { Characters } from "../characters/Characters";
import type { Fx } from "../fx/Fx";
import type { BurstOptions } from "../fx/types";
import type { PlayerFrame } from "../net/types";

/** Shorter hops (stepping off a curb, interpolation jitter) don't count as a landing. */
const MIN_AIR_SEC = 0.12;
/** Fall speed that maps to a full-strength landing squash. */
const HARD_LANDING_VY = 14;
/** Upward speed that marks a remote player's jump (no jump event exists on the wire). */
const REMOTE_JUMP_VY = 3;
/** Horizontal speed above which a stunned, grounded player leaves a dust skid. */
const SKID_SPEED = 2;
/** Landings at least this strong (0..1) always kick up dust. */
const LANDING_DUST_MIN = 0.3;
/** Tumble ribbon: shown above this speed (m/s); full width at TUMBLE_TRAIL_SPEED + TUMBLE_TRAIL_RANGE. */
const TUMBLE_TRAIL_SPEED = 6;
const TUMBLE_TRAIL_RANGE = 10;
/** Impact speed (m/s) that maps to a full-volume tumble bounce. */
const BOUNCE_FULL_SPEED = 12;
/** Turn skid squeak: the land SFX, quiet and pitched up. */
const SKID_SFX_VOLUME = 0.35;
const SKID_SFX_PITCH = 1.4;
/** Look-ahead for the off-island warning (1.5 s covers the longest launch). */
const LANDING_LOOKAHEAD_TICKS = 45;
const ZOOMIES_TOP_SPEED = MOVE_SPEED * ZOOMIES_MULT;

interface Track {
  id: string;
  stamp: number;
  alive: boolean;
  grounded: boolean;
  airSec: number;
  minVy: number;
  rolling: boolean;
  /** Last seen knockBounces (wrapping counter) and skid flag (remote edge detection). */
  bounces: number;
  skid: boolean;
  /** Stunned last frame (launch edge), and whether this launch already warned "out". */
  stunned: boolean;
  dangerShown: boolean;
  /** A throw was released: keep the telegraph off until the (interpolated) charge resets. */
  chargeSuppressed: boolean;
  chargeLoop: LoopHandle | null;
  zoomLoop: LoopHandle | null;
  slideLoop: LoopHandle | null;
  /** Last rendered feet position. */
  pos: THREE.Vector3;
  chest: THREE.Vector3;
  hand: THREE.Vector3;
  speedKey: string;
  dustKey: string;
  skidKey: string;
  speedOpts: BurstOptions & { dir: Vec3Like };
  dustOpts: BurstOptions & { dir: Vec3Like };
  skidOpts: BurstOptions & { dir: Vec3Like };
}

export interface PlayerEffectsDeps {
  characters: Characters;
  fx: Fx;
  audio: AudioEngine;
  colorOf(id: string): string;
  /** Local camera shake (off-island warning for the local victim). */
  shake?(intensity: number, durationSec: number): void;
  /** Current arena + rings for the off-island launch prediction (no warning without it). */
  floor?(): FloorQuery | null;
}

export class PlayerEffects {
  private readonly tracks = new Map<string, Track>();
  private stamp = 0;
  private readonly burstPos = new THREE.Vector3();
  private readonly landing = vec3();
  private simCtx: SimContext | null = null;

  constructor(private readonly deps: PlayerEffectsDeps) {}

  /** Per frame with every rendered player (local + remotes) and the cosmetic dt. */
  update(frames: readonly PlayerFrame[], dt: number): void {
    this.stamp++;
    for (const f of frames) this.updateOne(f, dt);
    for (const t of this.tracks.values()) {
      if (t.stamp !== this.stamp) this.drop(t);
    }
  }

  /** A throw was released by `id`: stop its charge whoosh right away. */
  onThrow(id: string): void {
    const t = this.tracks.get(id);
    if (!t) return;
    t.chargeSuppressed = true;
    this.stopLoop(t, "chargeLoop");
    this.deps.fx.balls.setChargeGlow(id, 0);
  }

  /**
   * A tumble bounce (floor or cover) of `id` at impact speed `speed` (m/s). The local player's
   * come from the prediction (localStep.bounced); remote ones are detected from knockBounces.
   */
  onBounce(id: string, speed: number): void {
    const t = this.tracks.get(id);
    if (!t || !t.alive) return;
    const { audio, fx } = this.deps;
    const k = Math.min(1, Math.max(0, speed) / BOUNCE_FULL_SPEED);
    fx.particles.burst("dust", t.pos, { scale: 0.5 + 0.5 * k });
    fx.particles.burst("stars", t.chest, { scale: 0.5 });
    audio.play("bounce", { pos: t.pos, volume: 0.5 + 0.5 * k });
    // The final landing's strength should come from the last arc, not the launch.
    t.minVy = 0;
  }

  /** A turn skid started (local: localStep.skidStarted; remote: rising `skid`). */
  onSkidStart(id: string): void {
    const t = this.tracks.get(id);
    if (!t || !t.alive) return;
    this.deps.audio.play("land", { pos: t.pos, volume: SKID_SFX_VOLUME, pitch: SKID_SFX_PITCH });
  }

  /** Last rendered feet position of a player (false if never rendered). */
  positionOf(id: string, out: Vec3Like): boolean {
    const t = this.tracks.get(id);
    if (!t) return false;
    out.x = t.pos.x;
    out.y = t.pos.y;
    out.z = t.pos.z;
    return true;
  }

  /** Stop every loop and forget every player (round start, leaving the game view). */
  clear(): void {
    for (const t of this.tracks.values()) this.drop(t);
  }

  /* ------------------------------------------------------------ internals */

  private track(f: PlayerFrame): Track {
    let t = this.tracks.get(f.id);
    if (!t) {
      t = {
        id: f.id,
        stamp: 0,
        alive: false,
        grounded: true,
        airSec: 0,
        minVy: 0,
        rolling: false,
        bounces: f.knockBounces,
        skid: false,
        stunned: false,
        dangerShown: false,
        chargeSuppressed: false,
        chargeLoop: null,
        zoomLoop: null,
        slideLoop: null,
        pos: new THREE.Vector3(f.x, f.y, f.z),
        chest: new THREE.Vector3(),
        hand: new THREE.Vector3(),
        speedKey: `speed:${f.id}`,
        dustKey: `dust:${f.id}`,
        skidKey: `skid:${f.id}`,
        speedOpts: { dir: { x: 0, y: 0, z: 0 } },
        dustOpts: { dir: { x: 0, y: 0, z: 0 }, scale: 0.6 },
        skidOpts: { dir: { x: 0, y: 0, z: 0 }, scale: 0.45 },
      };
      this.tracks.set(f.id, t);
    }
    return t;
  }

  private updateOne(f: PlayerFrame, dt: number): void {
    const t = this.track(f);
    t.stamp = this.stamp;
    if (f.spectator || !f.alive) {
      this.goQuiet(t);
      return;
    }
    if (!t.alive) this.revive(t, f);
    t.pos.set(f.x, f.y, f.z);
    t.chest.set(f.x, f.y + 1, f.z);
    if (!this.deps.characters.getHandPosition(f.id, t.hand)) throwOrigin(f, t.hand);

    this.detectAirborne(t, f, dt);
    this.detectBounceAndSkid(t, f);
    this.updateTumble(t, f);
    if (!f.isLocal) this.detectRemoteRoll(t, f);
    this.updateCharge(t, f);
    this.updateTrails(t, f);
  }

  /** Player alive again (round start / reconnect): no landing or roll from the teleport. */
  private revive(t: Track, f: PlayerFrame): void {
    t.alive = true;
    t.grounded = f.grounded;
    t.airSec = 0;
    t.minVy = 0;
    t.rolling = f.rollTicks > 0;
    t.bounces = f.knockBounces;
    t.skid = f.skid;
    t.stunned = f.stunTicks > 0;
    t.dangerShown = false;
    t.chargeSuppressed = false;
  }

  private goQuiet(t: Track): void {
    if (t.alive) this.deps.fx.balls.setChargeGlow(t.id, 0);
    t.alive = false;
    this.stopLoop(t, "chargeLoop");
    this.stopLoop(t, "zoomLoop");
    this.stopLoop(t, "slideLoop");
  }

  private detectAirborne(t: Track, f: PlayerFrame, dt: number): void {
    const { audio, characters, fx } = this.deps;
    if (!f.grounded) {
      if (t.grounded && !f.isLocal && f.vy > REMOTE_JUMP_VY) audio.play("jump", { pos: t.pos, volume: 0.7 });
      t.airSec += dt;
      t.minVy = Math.min(t.minVy, f.vy);
    } else if (!t.grounded && t.airSec >= MIN_AIR_SEC) {
      const strength = Math.min(1, Math.max(0.15, -t.minVy / HARD_LANDING_VY));
      characters.trigger(f.id, "land", { strength });
      audio.play("land", { pos: t.pos, volume: 0.4 + 0.6 * strength });
      if (strength > LANDING_DUST_MIN || f.stunTicks > 0) fx.particles.burst("dust", t.pos, { scale: 0.4 + 1.1 * strength });
    }
    if (f.grounded) {
      t.airSec = 0;
      t.minVy = 0;
    }
    t.grounded = f.grounded;
  }

  /**
   * Tumble bounces from the wrapping knockBounces counter (remote only; the local one comes from
   * the prediction via onBounce), and turn-skid starts (remote rising `skid`).
   */
  private detectBounceAndSkid(t: Track, f: PlayerFrame): void {
    const bounces = f.knockBounces;
    if (bounces !== t.bounces) {
      t.bounces = bounces;
      // Remote frames carry no impact speed: the bounce kept TUMBLE_RESTITUTION of it upward.
      if (!f.isLocal) this.onBounce(f.id, f.vy > 0 ? f.vy / TUMBLE_RESTITUTION : 6);
    }
    const skid = f.skid && f.grounded;
    if (skid && !t.skid && !f.isLocal) this.onSkidStart(f.id);
    t.skid = skid;
  }

  /** Off-island warning (once per launch) and the tumble ribbon. */
  private updateTumble(t: Track, f: PlayerFrame): void {
    const stunned = f.stunTicks > 0;
    if (stunned && !t.stunned) t.dangerShown = false;
    t.stunned = stunned;
    if (!stunned || f.grounded) return;
    const danger = this.launchOffIsland(f);
    if (danger && !t.dangerShown) {
      t.dangerShown = true;
      const color = this.deps.colorOf(f.id);
      this.burstPos.set(f.x, f.y + 1.9, f.z);
      this.deps.fx.popText.show("out", this.burstPos, color);
      if (f.isLocal) this.deps.shake?.(0.2, 0.3);
    }
    const speed = Math.hypot(f.vx, f.vy, f.vz);
    if (speed > TUMBLE_TRAIL_SPEED) {
      const intensity = (speed - TUMBLE_TRAIL_SPEED) / TUMBLE_TRAIL_RANGE;
      this.deps.fx.trails.feed(f.id, t.chest.x, t.chest.y - 0.3, t.chest.z, this.deps.colorOf(f.id), intensity, danger);
    }
  }

  /** The predicted flight (no further input) falls off the island. Allocation-free. */
  private launchOffIsland(f: PlayerFrame): boolean {
    const floor = this.deps.floor?.();
    if (!floor) return false;
    let ctx = this.simCtx;
    if (!ctx) {
      ctx = { arena: floor.arena, rings: floor.rings, character: f.character, dt: DT, locked: true };
      this.simCtx = ctx;
    }
    ctx.arena = floor.arena;
    ctx.rings = floor.rings;
    ctx.character = f.character;
    return predictTumbleLanding(f, ctx, LANDING_LOOKAHEAD_TICKS, this.landing) === -1;
  }

  /** Remote rolls have no event: detect the start from the synced rollTicks. */
  private detectRemoteRoll(t: Track, f: PlayerFrame): void {
    const rolling = f.rollTicks > 0;
    if (rolling && !t.rolling) {
      this.deps.fx.particles.burst("puff", t.pos, { scale: 0.7 });
      this.deps.audio.play("roll", { pos: t.pos });
    }
    t.rolling = rolling;
  }

  private updateCharge(t: Track, f: PlayerFrame): void {
    if (t.chargeSuppressed && f.chargeTicks === 0) t.chargeSuppressed = false;
    const charge = t.chargeSuppressed ? 0 : chargeFraction(f);
    this.deps.fx.balls.setChargeGlow(f.id, charge);
    if (charge <= 0) {
      this.stopLoop(t, "chargeLoop");
      return;
    }
    const loop = this.ensureLoop(t, "chargeLoop", "charge", t.hand);
    loop.setParam(charge);
    loop.setPosition(t.hand);
  }

  private updateTrails(t: Track, f: PlayerFrame): void {
    const { fx } = this.deps;
    const speed = Math.hypot(f.vx, f.vz);
    const character = f.character;
    const abilityOn = f.abilityTicks > 0;
    const dashing = abilityOn && (character === "quacky" || character === "gruff");
    const sliding = abilityOn && character === "pip";

    if (f.zoomiesTicks > 0 || dashing) {
      this.setDir(t.speedOpts.dir, f, speed);
      t.speedOpts.color = f.zoomiesTicks > 0 ? POWERUPS.zoomies.color : this.deps.colorOf(f.id);
      fx.particles.emit(t.speedKey, "speedLines", t.chest, t.speedOpts);
    }
    this.updateLoop(t, "zoomLoop", "zoomies", f.zoomiesTicks > 0, speed / ZOOMIES_TOP_SPEED);

    const knockSliding = f.stunTicks > 0 && f.grounded && speed > SKID_SPEED;
    if (sliding || knockSliding) {
      this.setDir(t.dustOpts.dir, f, speed);
      t.dustOpts.color = sliding ? CHARACTERS.pip.colors.secondary : undefined;
      fx.particles.emit(t.dustKey, "dust", t.pos, t.dustOpts);
    }
    // Turn skid: feet planted, dust sprays the way the body is still sliding.
    if (f.skid && f.grounded && speed > 1e-3) {
      const d = t.skidOpts.dir;
      d.x = f.vx / speed;
      d.y = 0;
      d.z = f.vz / speed;
      fx.particles.emit(t.skidKey, "dust", t.pos, t.skidOpts);
    }
    this.updateLoop(t, "slideLoop", "slide", sliding, Math.min(1, speed / 10));
  }

  /** Trail direction: opposite the motion (particles stream behind the player). */
  private setDir(out: Vec3Like, f: PlayerFrame, speed: number): void {
    if (speed > 1e-3) {
      out.x = -f.vx / speed;
      out.z = -f.vz / speed;
    } else {
      out.x = Math.sin(f.yaw);
      out.z = Math.cos(f.yaw);
    }
    out.y = 0;
  }

  private updateLoop(t: Track, slot: "zoomLoop" | "slideLoop", id: LoopId, on: boolean, param: number): void {
    if (!on) {
      this.stopLoop(t, slot);
      return;
    }
    const loop = this.ensureLoop(t, slot, id, t.pos);
    loop.setParam(Math.min(1, Math.max(0, param)));
    loop.setPosition(t.pos);
  }

  private ensureLoop(t: Track, slot: "chargeLoop" | "zoomLoop" | "slideLoop", id: LoopId, pos: Vec3Like): LoopHandle {
    let loop = t[slot];
    if (!loop) {
      this.burstPos.set(pos.x, pos.y, pos.z);
      loop = this.deps.audio.startLoop(id, { pos: this.burstPos });
      t[slot] = loop;
    }
    return loop;
  }

  private stopLoop(t: Track, slot: "chargeLoop" | "zoomLoop" | "slideLoop"): void {
    const loop = t[slot];
    if (!loop) return;
    loop.stop();
    t[slot] = null;
  }

  private drop(t: Track): void {
    this.goQuiet(t);
    this.tracks.delete(t.id);
  }
}
