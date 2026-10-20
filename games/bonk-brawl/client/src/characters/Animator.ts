// Procedural animation state machine. Owner: client-characters.

import { CHARACTERS, CHARGE_FULL_TICKS, FULL_CHARGE_THRESHOLD } from "../../../shared/constants";
import { derivePlayerAction } from "../../../shared/sim/actions";
import type { AbilityId, CharacterId, PlayerAction } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { Animal } from "./Animal";
import { CLIPS, type ClipContext, type ClipDef, EXCLUSIVE_CLIPS } from "./clips";
import { clamp01, copyPose, createPose, damp, easeInOut, envelope, lerpPose, restPose, wrapAngle } from "./pose";
import { createPuppetFrame } from "./puppet";
import { applyPose, prepareRig } from "./rigPose";
import { blendTimeFor, evaluateState, type MotionInfo, stateExpression } from "./states";
import type { AnimTrigger, FaceExpression, TriggerOptions } from "./types";

const TAU = Math.PI * 2;
/** Facing follows frame.yaw at this rate (1/s). */
const YAW_RATE = 15;
/** Squash spring: stiffness and damping (underdamped, so landings wobble). */
const SPRING_K = 300;
const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.3;
const SPRING_STEP = 1 / 120;
const SQUASH_MIN = -0.45;
const SQUASH_MAX = 0.4;
/** Velocity changes faster than this (m/s per frame) are teleports, not accelerations. */
const TELEPORT_DV = 12;
const BLINK_SEC = 0.11;

interface ActiveClip {
  name: AnimTrigger;
  def: ClipDef;
  ctx: ClipContext;
}

/** States whose pose leans with acceleration (momentum). */
const LEANING: ReadonlySet<PlayerAction> = new Set<PlayerAction>(["idle", "run", "charge", "catch"]);
/** States in which a held ball is carried at the side (charge/roll/abilities own the arm). */
const CARRYING: ReadonlySet<PlayerAction> = new Set<PlayerAction>(["idle", "run", "jump", "fall", "whiff"]);
/** Right-arm carry pose (forward and out, palm up). */
const CARRY_ARM_X = 1.2;
const CARRY_ARM_Z = 0.65;
const CARRY_ARM_Y = 0;

/**
 * Continuous layer from derivePlayerAction(frame, character): idle (bouncy breathing), run (leg
 * swing + bob, speed from horizontal velocity), jump (stretch) / fall (arms up) / land (squash,
 * triggered on grounded rising edge), charge (wind-up arm back, wobble increasing with charge,
 * shake at full), catch (arms forward ready pose), whiff (flail), roll (tuck + 360° roll along
 * dir), stunned / knockback tumble (spin along velocity), ability per character (flap dash wings,
 * pound tuck/slam, belly-bounce puff-up, slide on belly, headbutt lunge), ghost (float + sway).
 * One-shot layer from trigger(): throw, catch hug, whiff, hit-react spin + dizzy face, pickup,
 * ability flourish, slam squash, emote ×3 (honk / wave / dance), victory dance, ko (pop).
 * Squash & stretch everywhere via rig.body scale (volume-preserving). Expressions: blink every
 * 2–5 s randomly; charging/angry/hurt/dizzy/happy/ko as states dictate.
 * Facing: root yaw follows frame.yaw for the local player and remote players (smoothed 15/s).
 */
export class Animator {
  private readonly animal: Animal;
  private readonly character: CharacterId;
  private readonly abilityId: AbilityId;
  /** Blended state pose (before clips), the pose a crossfade starts from, and the final output. */
  private readonly base = createPose();
  private readonly from = createPose();
  private readonly target = createPose();
  private readonly scratch = createPose();
  private readonly out = createPose();
  private readonly motion: MotionInfo;
  private clips: ActiveClip[] = [];

  private stateKey = "";
  private action: PlayerAction = "idle";
  private stateTime = 0;
  private blendTime = 0;
  private blendDuration = 0;
  private time = 0;

  private yaw = 0;
  private hasYaw = false;
  private velYaw = 0;
  private prevVx = 0;
  private prevVz = 0;
  private accelFwd = 0;
  private accelRight = 0;
  private squash = 0;
  private squashVel = 0;
  /** 0..1 blend of the ball-carry arm pose. */
  private carry = 0;

  private face: FaceExpression = "idle";
  private blinkIn = 1 + Math.random() * 3;
  private blinkLeft = 0;
  private ghostMode = false;

  constructor(animal: Animal, character: CharacterId) {
    this.animal = animal;
    this.character = character;
    this.abilityId = CHARACTERS[character].ability.id;
    prepareRig(animal);
    this.motion = {
      frame: createPuppetFrame(character),
      character,
      ability: this.abilityId,
      t: 0,
      time: 0,
      speed: 0,
      fwdSpeed: 0,
      rightSpeed: 0,
      runPhase: 0,
      idlePhase: Math.random() * TAU,
      charge: 0,
      fullCharge: false,
      dirTurn: 0,
      velTurn: 0,
      tumble: 0,
      seed: Math.random() * 100,
    };
  }

  /** Per frame with cosmetic dt (already scaled by hit-stop/slow-mo). */
  update(frame: PlayerFrame, dt: number): void {
    this.time += dt;
    this.updateFacing(frame, dt);
    this.updateMotion(frame, dt);

    const action = this.deriveAction(frame);
    const key = action === "ability" ? `ability:${frame.abilityPhase}` : action;
    if (key !== this.stateKey) this.enterState(action, key);
    this.stateTime += dt;
    this.motion.t = this.stateTime;
    this.updateTumble(frame, dt);

    restPose(this.target);
    evaluateState(action, this.target, this.motion);
    this.blendBase(dt);
    copyPose(this.out, this.base);
    this.applyCarry(frame, dt);
    this.applyMomentum(frame, dt);
    this.applyClips(dt);
    this.stepSpring(dt);
    this.out.crouch += this.squash;
    this.out.ears -= this.squashVel * 0.05;
    applyPose(this.animal, this.out);
    this.updateFace(frame, dt);
  }

  trigger(anim: AnimTrigger, opts?: TriggerOptions): void {
    const def = CLIPS[anim];
    const options = opts ?? {};
    if (EXCLUSIVE_CLIPS.has(anim)) this.clips = this.clips.filter((c) => !EXCLUSIVE_CLIPS.has(c.name));
    this.clips = this.clips.filter((c) => c.name !== anim);
    const duration = Math.max(0.05, def.duration(options, this.character));
    this.clips.push({
      name: anim,
      def,
      ctx: {
        u: 0,
        t: 0,
        duration,
        character: this.character,
        ability: this.abilityId,
        opts: options,
        side: this.spinSide(options),
      },
    });
    this.squashVel += def.impulse(options);
  }

  get expression(): FaceExpression {
    return this.face;
  }

  /** Current continuous state (dev harness / debugging). */
  get state(): PlayerAction {
    return this.action;
  }

  /** Force the ghost float regardless of frame fields (driven by the KO / ring-out sequence). */
  setGhostMode(on: boolean): void {
    this.ghostMode = on;
  }

  hasClip(anim: AnimTrigger): boolean {
    return this.clips.some((c) => c.name === anim);
  }

  /** Drop every clip and spring and return to a fresh idle (round restart, revive). */
  reset(): void {
    this.clips = [];
    this.ghostMode = false;
    this.stateKey = "";
    this.squash = 0;
    this.squashVel = 0;
    this.carry = 0;
    this.hasYaw = false;
    this.blendDuration = 0;
    restPose(this.base);
  }

  /* ----------------------------------------------------------- internals */

  /**
   * Ghost form is driven by setGhostMode (the avatar's KO / ring-out sequence), not by a dead
   * frame: while the body pops or falls the clips play over a neutral base.
   */
  private deriveAction(frame: PlayerFrame): PlayerAction {
    if (this.ghostMode) return "ghost";
    const action = derivePlayerAction(frame, this.character);
    return action === "ghost" ? "idle" : action;
  }

  private updateFacing(frame: PlayerFrame, dt: number): void {
    if (!this.hasYaw) {
      this.yaw = frame.yaw;
      this.hasYaw = true;
    } else {
      this.yaw = wrapAngle(this.yaw + wrapAngle(frame.yaw - this.yaw) * damp(YAW_RATE, dt));
    }
    this.animal.rig.root.rotation.y = this.yaw;
  }

  private updateMotion(frame: PlayerFrame, dt: number): void {
    const m = this.motion;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    m.frame = frame;
    m.time = this.time;
    m.speed = Math.hypot(frame.vx, frame.vz);
    m.fwdSpeed = -frame.vx * sin - frame.vz * cos;
    m.rightSpeed = frame.vx * cos - frame.vz * sin;
    m.runPhase = (m.runPhase + dt * (5 + m.speed * 2)) % (TAU * 64);
    m.idlePhase = (m.idlePhase + dt * TAU * 1.15) % TAU;
    m.charge = clamp01(frame.chargeTicks / CHARGE_FULL_TICKS);
    m.fullCharge = m.charge >= FULL_CHARGE_THRESHOLD;
    if (frame.dirX !== 0 || frame.dirZ !== 0) m.dirTurn = wrapAngle(Math.atan2(-frame.dirX, -frame.dirZ) - this.yaw);
    if (m.speed > 0.8) this.velYaw = Math.atan2(-frame.vx, -frame.vz);
    m.velTurn = wrapAngle(this.velYaw - this.yaw);
  }

  private enterState(action: PlayerAction, key: string): void {
    const first = this.stateKey === "";
    copyPose(this.from, this.base);
    this.stateKey = key;
    this.action = action;
    this.stateTime = 0;
    this.blendTime = 0;
    this.blendDuration = first ? 0 : blendTimeFor(action);
    if (action === "jump") this.squashVel += 2.4;
    if (action === "roll") this.squashVel -= 1.5;
  }

  /** Knockback tumble angle: spins while airborne, settles upright once grounded. */
  private updateTumble(frame: PlayerFrame, dt: number): void {
    const m = this.motion;
    if (this.action !== "stunned") {
      m.tumble = 0;
      return;
    }
    if (!frame.grounded) {
      m.tumble += dt * (8 + m.speed * 0.5);
    } else {
      const upright = Math.round(m.tumble / TAU) * TAU;
      m.tumble += (upright - m.tumble) * damp(12, dt);
    }
  }

  private blendBase(dt: number): void {
    this.blendTime += dt;
    if (this.blendTime >= this.blendDuration) {
      copyPose(this.base, this.target);
      return;
    }
    copyPose(this.base, this.from);
    lerpPose(this.base, this.target, easeInOut(this.blendTime / this.blendDuration));
  }

  /** Hold the ball at the side while carrying it (fx attaches the ball to rig.hand). */
  private applyCarry(frame: PlayerFrame, dt: number): void {
    const want = frame.heldCount > 0 && CARRYING.has(this.action) ? 1 : 0;
    this.carry += (want - this.carry) * damp(12, dt);
    if (this.carry < 0.001) return;
    const w = this.carry;
    const out = this.out;
    const sway = 0.12 * Math.sin(this.motion.runPhase) * Math.min(1, this.motion.speed / 6);
    out.armRX += (CARRY_ARM_X + sway - out.armRX) * w;
    out.armRZ += (CARRY_ARM_Z - out.armRZ) * w;
    out.armRY += (CARRY_ARM_Y - out.armRY) * w;
  }

  /** Lean into accelerations and let the head lead turns (secondary motion). */
  private applyMomentum(frame: PlayerFrame, dt: number): void {
    const out = this.out;
    const dvx = frame.vx - this.prevVx;
    const dvz = frame.vz - this.prevVz;
    this.prevVx = frame.vx;
    this.prevVz = frame.vz;
    if (dt > 0 && Math.hypot(dvx, dvz) < TELEPORT_DV) {
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const fwd = (-dvx * sin - dvz * cos) / dt;
      const right = (dvx * cos - dvz * sin) / dt;
      const k = damp(8, dt);
      this.accelFwd += (fwd - this.accelFwd) * k;
      this.accelRight += (right - this.accelRight) * k;
    }
    if (LEANING.has(this.action) && frame.grounded) {
      out.leanX += clampAbs(this.accelFwd * 0.006, 0.16);
      out.leanZ += clampAbs(this.accelRight * 0.005, 0.12);
    }
    if (!this.ghostMode) out.headY -= clampAbs(wrapAngle(frame.yaw - this.yaw) * 0.9, 0.5);
  }

  private applyClips(dt: number): void {
    if (this.clips.length === 0) return;
    for (const clip of this.clips) {
      const c = clip.ctx;
      c.t += dt;
      c.u = Math.min(1, c.t / c.duration);
      copyPose(this.scratch, this.out);
      clip.def.pose(this.scratch, c);
      lerpPose(this.out, this.scratch, envelope(c.u, clip.def.fadeIn, clip.def.fadeOut));
    }
    this.clips = this.clips.filter((c) => c.ctx.u < 1);
  }

  private stepSpring(dt: number): void {
    if (dt <= 0) return;
    const steps = Math.min(12, Math.ceil(dt / SPRING_STEP));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      this.squashVel += (-SPRING_K * this.squash - SPRING_C * this.squashVel) * h;
      this.squash += this.squashVel * h;
    }
    if (this.squash < SQUASH_MIN || this.squash > SQUASH_MAX) {
      this.squash = Math.max(SQUASH_MIN, Math.min(SQUASH_MAX, this.squash));
      this.squashVel *= 0.5;
    }
  }

  private updateFace(frame: PlayerFrame, dt: number): void {
    let face = this.clipFace() ?? stateExpression(this.action, this.motion);
    if (!face && frame.hurtTicks > 0) face = "hurt";
    if (!face) face = this.blink(dt) ? "blink" : "idle";
    if (face !== this.face) {
      this.face = face;
      this.animal.setExpression(face);
    }
  }

  private clipFace(): FaceExpression | null {
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const clip = this.clips[i];
      const face = clip.def.face(clip.ctx);
      if (face) return face;
    }
    return null;
  }

  /** Random blinks every 2–5 s (sometimes a double blink). */
  private blink(dt: number): boolean {
    if (this.blinkLeft > 0) {
      this.blinkLeft -= dt;
      return this.blinkLeft > 0;
    }
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blinkLeft = BLINK_SEC;
      this.blinkIn = Math.random() < 0.15 ? 0.22 : 2 + Math.random() * 3;
      return true;
    }
    return false;
  }

  /** Hit spin direction: away from the side the hit came from (random without a direction). */
  private spinSide(opts: TriggerOptions): number {
    const dir = opts.dir;
    if (!dir || (dir.x === 0 && dir.z === 0)) return Math.random() < 0.5 ? -1 : 1;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const right = dir.x * cos - dir.z * sin;
    return right >= 0 ? -1 : 1;
  }
}

function clampAbs(v: number, max: number): number {
  return v < -max ? -max : v > max ? max : v;
}
