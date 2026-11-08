// Procedural animation state machine. Owner: client-characters (MOTION).

import {
  CHARACTERS,
  CHARGE_FULL_TICKS,
  FULL_CHARGE_THRESHOLD,
  JUMP_VELOCITY,
  KNOCK_GETUP_TICKS,
  MOVE_SPEED,
  ZOOMIES_MULT,
} from "../../../shared/constants";
import { derivePlayerAction } from "../../../shared/sim/actions";
import type { AbilityId, CharacterId, HeldPowerUp, PlayerAction } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { Animal } from "./Animal";
import {
  BEAK_JAW,
  CANCEL_FADE,
  CLIPS,
  type ClipContext,
  type ClipDef,
  type ClipName,
  createClipContext,
  EXCLUSIVE_CLIPS,
  FIDGETS,
  INTERNAL_CLIPS,
  type InternalClip,
  isBeaked,
  NO_OPTS,
} from "./clips";
import { clamp01, copyPose, createPose, damp, easeInOut, envelope, lerpPose, restPose, wrapAngle } from "./pose";
import { createPuppetFrame } from "./puppet";
import { applyPose, prepareRig } from "./rigPose";
import { SpringRig } from "./springs";
import {
  advanceGait,
  blendTimeFor,
  createMotionInfo,
  evaluateState,
  type FaceParts,
  type MotionInfo,
  stateExpression,
  Tumble,
  type TumbleInput,
  TUMBLE_NONE,
} from "./states";
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
/** Velocity changes faster than this (m/s per frame) are teleports / launches, not accelerations. */
const TELEPORT_DV = 12;
const BLINK_SEC = 0.11;
/** Rendered-velocity and acceleration low-pass rates (1/s). */
const VEL_RATE = 20;
const ACCEL_RATE = 10;
/** Skid weight rise / decay rates (1/s) and the client-side detection thresholds. */
const SKID_RISE = 25;
const SKID_DECAY = 6;
const SKID_MIN_SPEED = 2;
const SKID_MIN_ACCEL = 25;
/** A hit trigger this recent sets the strength of the tumble that follows (s). */
const HIT_MEMORY_SEC = 0.35;
/** Fixed pool of simultaneously playing clips. */
const MAX_CLIPS = 6;
/** Ghosts' springs swing slower (floatier). */
const GHOST_SPRING_FREQ = 0.7;

interface ActiveClip {
  name: ClipName;
  def: ClipDef;
  ctx: ClipContext;
}

/** States whose pose leans with acceleration (momentum). */
const LEANING: ReadonlySet<PlayerAction> = new Set<PlayerAction>(["idle", "run", "charge", "catch", "jump", "fall", "whiff"]);
/** States in which a held ball is carried at the side (charge/roll/abilities own the arm). */
const CARRYING: ReadonlySet<PlayerAction> = new Set<PlayerAction>(["idle", "run", "jump", "fall", "whiff"]);
/** Right-arm carry pose (forward and out, palm up). */
const CARRY_ARM_X = 1.2;
const CARRY_ARM_Z = 0.65;
const CARRY_ARM_Y = 0;

/** Small seeded PRNG (mulberry32): cosmetic randomness that harness captures can reproduce. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface AnimatorOptions {
  /** Seed for blinks, fidgets and phases (default: random). */
  seed?: number;
}

/**
 * Continuous layer from derivePlayerAction(frame, character) with momentum-aware locomotion
 * (stride-locked gait, lean, bank, skid), blended air poses (takeoff / apex / fall / long-fall
 * flail), charge wind-up, catch, whiff, roll, per-ability states, a knockback tumble that spins
 * with the launch, bounces, rolls through or splats and gets up without unwinding, and a ghost
 * float. One-shot layer from trigger() plus internal exit clips (get-up, roll pop, air brake,
 * slide pop, headbutt stop) and idle fidgets. Squash & stretch via rig.body scale, spring-bone
 * secondary motion (SpringRig), eyes and mouth expressions chosen independently.
 * Facing: root yaw follows frame.yaw (smoothed 15/s). Allocation-free per frame.
 */
export class Animator {
  private readonly animal: Animal;
  private readonly character: CharacterId;
  private readonly abilityId: AbilityId;
  private readonly rng: () => number;
  /** Blended state pose (before clips), the pose a crossfade starts from, and the final output. */
  private readonly base = createPose();
  private readonly from = createPose();
  private readonly target = createPose();
  private readonly scratch = createPose();
  private readonly out = createPose();
  private readonly motion: MotionInfo;
  private readonly tumble = new Tumble();
  private readonly tumbleInput: TumbleInput = { stunned: false, grounded: true, stunTicks: 0, getUpTicks: KNOCK_GETUP_TICKS, speed: 0 };
  private readonly springs: SpringRig;

  /** Clip slots: [0, clipCount) play in start order; the rest are free objects. */
  private readonly clips: ActiveClip[] = [];
  private clipCount = 0;

  private started = false;
  private statePhase = 0;
  private action: PlayerAction = "idle";
  private stateTime = 0;
  private blendTime = 0;
  private blendDuration = 0;
  private time = 0;

  private yaw = 0;
  private hasYaw = false;
  private prevYaw = 0;
  private velYaw = 0;

  // Rendered motion (low-passed frame velocity) and acceleration, world space.
  private hasVel = false;
  private velX = 0;
  private velZ = 0;
  private accX = 0;
  private accZ = 0;

  // Edge tracking.
  private prevStun = 0;
  private prevRoll = 0;
  private prevAbility = 0;
  private prevBounces = 0;
  private prevJumping = false;
  private prevFull = false;
  private hasPrev = false;

  private squash = 0;
  private squashVel = 0;
  /** 0..1 blend of the ball-carry arm pose. */
  private carry = 0;

  // Last hit trigger (tumble strength / twist side).
  private hitK = 0.5;
  private hitAt = -1;
  private hitSide = 1;
  // Ball being charged.
  private lastPowerUp: HeldPowerUp = "";
  private lastCurve = false;

  // Idle look-around and fidgets.
  private lookTarget = 0;
  private lookHold = 1;
  private idleCalm = 0;
  private fidgetIn = 3;

  // Faces.
  private readonly face: FaceParts = { eyes: "idle", mouth: "idle" };
  private readonly faceTmp: FaceParts = { eyes: null, mouth: null };
  private readonly faceState: FaceParts = { eyes: null, mouth: null };
  private eyes: FaceExpression = "idle";
  private mouth: FaceExpression = "idle";
  private blinkIn = 2;
  private blinkLeft = 0;
  private ghostMode = false;

  constructor(animal: Animal, character: CharacterId, opts?: AnimatorOptions) {
    this.animal = animal;
    this.character = character;
    this.abilityId = CHARACTERS[character].ability.id;
    this.rng = mulberry32(opts?.seed ?? Math.floor(Math.random() * 4294967296));
    prepareRig(animal);
    this.springs = new SpringRig(animal.parts.springs);
    for (let i = 0; i < MAX_CLIPS; i++) {
      this.clips.push({ name: "land", def: CLIPS.land, ctx: createClipContext() });
    }
    this.motion = createMotionInfo(createPuppetFrame(character), character, this.abilityId, this.rng() * 100);
    this.motion.idlePhase = this.rng() * TAU;
    this.blinkIn = 1 + this.rng() * 3;
    this.fidgetIn = this.nextFidgetDelay();
  }

  /** Per frame with cosmetic dt (already scaled by hit-stop/slow-mo). */
  update(frame: PlayerFrame, dt: number): void {
    // 1. Time, facing.
    this.time += dt;
    this.updateFacing(frame, dt);
    // 2. Signals.
    this.updateSignals(frame, dt);
    // 3. Action, state changes, edge-triggered internal clips.
    const action = this.deriveAction(frame);
    const phase = action === "ability" ? frame.abilityPhase : 0;
    if (!this.started || action !== this.action || phase !== this.statePhase) this.enterState(action, phase);
    this.stateTime += dt;
    this.motion.t = this.stateTime;
    this.fireEdges(frame);
    // 4. Tumble.
    this.updateTumble(frame, dt);
    // 5–6. State pose and crossfade.
    restPose(this.target);
    evaluateState(action, this.target, this.motion);
    this.blendBase(dt);
    copyPose(this.out, this.base);
    // 7–8. Carry, momentum, tumble layer.
    this.applyCarry(frame, dt);
    this.applyMomentum(frame);
    this.applyTumble();
    // 9–10. Clips, fidgets.
    this.applyClips(dt);
    this.scheduleFidgets(frame, dt);
    // 11. Squash spring.
    this.stepSpring(dt);
    this.out.crouch += this.squash;
    this.out.ears -= this.squashVel * 0.05;
    // Faces decide the beak opening before the pose is written.
    this.updateFace(frame, dt);
    // 12–13. Pose, then spring bones on the posed rig.
    applyPose(this.animal, this.out);
    if (this.springs.count > 0) {
      this.animal.rig.root.updateMatrixWorld(true);
      this.springs.update(dt, this.ghostMode ? GHOST_SPRING_FREQ : 1);
    }
    // 14. Face.
    if (this.face.eyes !== this.eyes || this.face.mouth !== this.mouth) {
      this.eyes = this.face.eyes ?? "idle";
      this.mouth = this.face.mouth ?? "idle";
      this.animal.setFaceParts(this.eyes, this.mouth);
    }
  }

  trigger(anim: AnimTrigger, opts?: TriggerOptions): void {
    const options = opts ?? NO_OPTS;
    if (anim === "hit") {
      this.hitK = clamp01(options.strength ?? CLIPS.hit.strength);
      this.hitAt = this.time;
      this.hitSide = this.spinSide(options);
    }
    const slot = this.startClip(anim, CLIPS[anim], options);
    const c = slot.ctx;
    if (anim === "throw") {
      c.power = this.lastPowerUp;
      c.curve = this.lastCurve;
      this.lastPowerUp = "";
      this.lastCurve = false;
    } else if (anim === "ringOut") {
      c.omega = Math.max(9, this.tumble.omega);
      c.angle0 = this.tumble.angle;
    }
    this.beginClip(slot);
  }

  /** Eyes expression (dev harness `inspect`). */
  get expression(): FaceExpression {
    return this.eyes;
  }

  /** Mouth expression (dev harness). */
  get mouthExpression(): FaceExpression {
    return this.mouth;
  }

  /** Current continuous state (dev harness / debugging). */
  get state(): PlayerAction {
    return this.action;
  }

  /** Spring bones of this animal (dev harness debug points). */
  get springRig(): SpringRig {
    return this.springs;
  }

  /** Force the ghost float regardless of frame fields (driven by the KO / ring-out sequence). */
  setGhostMode(on: boolean): void {
    this.ghostMode = on;
  }

  hasClip(anim: AnimTrigger): boolean {
    for (let i = 0; i < this.clipCount; i++) if (this.clips[i].name === anim) return true;
    return false;
  }

  /** Drop every clip and spring and return to a fresh idle (round restart, revive). */
  reset(): void {
    this.clipCount = 0;
    this.ghostMode = false;
    this.started = false;
    this.squash = 0;
    this.squashVel = 0;
    this.carry = 0;
    this.hasYaw = false;
    this.hasVel = false;
    this.hasPrev = false;
    this.blendDuration = 0;
    this.tumble.reset();
    this.springs.reset();
    this.motion.skid = 0;
    this.idleCalm = 0;
    this.lastPowerUp = "";
    this.lastCurve = false;
    restPose(this.base);
  }

  /* ------------------------------------------------------------ signals */

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
    this.prevYaw = this.yaw;
    if (!this.hasYaw) {
      this.yaw = frame.yaw;
      this.prevYaw = frame.yaw;
      this.hasYaw = true;
    } else {
      this.yaw = wrapAngle(this.yaw + wrapAngle(frame.yaw - this.yaw) * damp(YAW_RATE, dt));
    }
    this.animal.rig.root.rotation.y = this.yaw;
  }

  /** Every sim field the animation reads is read here (§3.1). */
  private updateSignals(frame: PlayerFrame, dt: number): void {
    const m = this.motion;
    m.frame = frame;
    m.time = this.time;
    m.zoomies = frame.zoomiesTicks > 0;

    // Rendered velocity (low-passed; launches and teleports snap) and acceleration.
    if (!this.hasVel) {
      this.velX = frame.vx;
      this.velZ = frame.vz;
      this.accX = 0;
      this.accZ = 0;
      this.hasVel = true;
    } else if (dt > 0) {
      if (Math.hypot(frame.vx - this.velX, frame.vz - this.velZ) > TELEPORT_DV) {
        this.velX = frame.vx;
        this.velZ = frame.vz;
        this.accX = 0;
        this.accZ = 0;
      } else {
        const pvx = this.velX;
        const pvz = this.velZ;
        const kv = damp(VEL_RATE, dt);
        this.velX += (frame.vx - this.velX) * kv;
        this.velZ += (frame.vz - this.velZ) * kv;
        const ka = damp(ACCEL_RATE, dt);
        this.accX += ((this.velX - pvx) / dt - this.accX) * ka;
        this.accZ += ((this.velZ - pvz) / dt - this.accZ) * ka;
      }
    }
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const speed = Math.hypot(this.velX, this.velZ);
    m.speed = speed;
    m.fwdSpeed = -this.velX * sin - this.velZ * cos;
    m.rightSpeed = this.velX * cos - this.velZ * sin;
    m.speedNorm = speed / (MOVE_SPEED * (m.zoomies ? ZOOMIES_MULT : 1));
    m.accelFwd = -this.accX * sin - this.accZ * cos;
    m.accelRight = this.accX * cos - this.accZ * sin;
    if (dt > 0) m.yawRate += (wrapAngle(this.yaw - this.prevYaw) / dt - m.yawRate) * damp(ACCEL_RATE, dt);

    // Turn skid: the sim's flag, or a hard brake against the velocity.
    const accel = Math.hypot(this.accX, this.accZ);
    const against = speed > 1e-3 && accel > 1e-3 ? (this.accX * this.velX + this.accZ * this.velZ) / (accel * speed) : 0;
    const skidding =
      frame.grounded && frame.stunTicks === 0 && (frame.skid || (speed > SKID_MIN_SPEED && accel > SKID_MIN_ACCEL && against < -0.5));
    if (skidding && speed > 1e-3) {
      m.skidFwd = m.fwdSpeed / speed;
      m.skidRight = m.rightSpeed / speed;
    }
    const skidTarget = skidding ? 1 : 0;
    m.skid += (skidTarget - m.skid) * damp(skidTarget > m.skid ? SKID_RISE : SKID_DECAY, dt);

    // Air.
    if (frame.grounded) {
      m.airSec = 0;
      m.fallSec = 0;
      m.jumpCut = false;
    } else {
      m.airSec += dt;
      if (frame.vy < 0) m.fallSec += dt;
      if (this.prevJumping && !frame.jumping && frame.vy > 0) m.jumpCut = true;
    }
    m.airU = clamp01((JUMP_VELOCITY - frame.vy) / (2 * JUMP_VELOCITY));
    m.apex = frame.grounded ? 0 : 1 - clamp01(Math.abs(frame.vy) / 3);

    // Charge.
    m.charge = clamp01(frame.chargeTicks / CHARGE_FULL_TICKS);
    m.fullCharge = m.charge >= FULL_CHARGE_THRESHOLD;
    m.fullSec = m.fullCharge ? Math.max(0, m.fullSec) + dt : -1;
    if (frame.chargeTicks > 0) {
      if (frame.powerUp !== "") this.lastPowerUp = frame.powerUp;
      if (frame.curveArmed) this.lastCurve = true;
    }
    m.lastPowerUp = this.lastPowerUp;

    // Directions.
    if (frame.dirX !== 0 || frame.dirZ !== 0) m.dirTurn = wrapAngle(Math.atan2(-frame.dirX, -frame.dirZ) - this.yaw);
    if (frame.stunTicks > 0 && Math.hypot(frame.vx, frame.vz) > 0.8) this.velYaw = Math.atan2(-frame.vx, -frame.vz);
    else if (speed > 0.8) this.velYaw = Math.atan2(-this.velX, -this.velZ);
    m.velTurn = wrapAngle(this.velYaw - this.yaw);

    // Gait, breathing, idle look-around.
    advanceGait(m, dt);
    m.idlePhase = (m.idlePhase + dt * TAU * 1.15) % TAU;
    this.lookHold -= dt;
    if (this.lookHold <= 0) {
      const quacky = this.character === "quacky";
      this.lookTarget = (this.rng() * 2 - 1) * (quacky ? 0.3 : 0.18);
      this.lookHold = quacky ? 0.6 + this.rng() * 0.9 : 1.5 + this.rng() * 2.5;
    }
    m.look += (this.lookTarget - m.look) * damp(this.character === "quacky" ? 40 : 3, dt);
  }

  private enterState(action: PlayerAction, phase: number): void {
    const first = !this.started;
    const prev = this.action;
    copyPose(this.from, this.base);
    this.started = true;
    this.statePhase = phase;
    this.action = action;
    this.stateTime = 0;
    this.blendTime = 0;
    this.blendDuration = first ? 0 : blendTimeFor(action, prev);
    if (action === "jump" && prev !== "fall") {
      this.squashVel += 2.4;
      this.springs.kick(null, 0, -1.5, 0, this.yaw);
    }
    if (action === "roll") this.squashVel -= 1.5;
    if (action !== "idle") this.idleCalm = 0;
    // A state change cancels any fidget.
    for (let i = 0; i < this.clipCount; i++) {
      const c = this.clips[i];
      if (c.name === "fidget" && c.ctx.cancel <= 0) c.ctx.cancel = CANCEL_FADE;
    }
  }

  /** Edge-triggered internal clips and impulses (stun / roll / ability exits, bounces, full charge). */
  private fireEdges(frame: PlayerFrame): void {
    if (!this.hasPrev) {
      this.hasPrev = true;
      this.prevStun = frame.stunTicks;
      this.prevRoll = frame.rollTicks;
      this.prevAbility = frame.abilityTicks;
      this.prevBounces = frame.knockBounces;
      this.prevJumping = frame.jumping;
      this.prevFull = this.motion.fullCharge;
      return;
    }
    const m = this.motion;
    if (!this.ghostMode) {
      if (frame.stunTicks > 0 && this.prevStun === 0) {
        const recent = this.hitAt >= 0 && this.time - this.hitAt < HIT_MEMORY_SEC;
        this.tumble.start(frame.vx, frame.vz, recent ? this.hitK : 0.5, recent ? this.hitSide : this.rng() < 0.5 ? -1 : 1);
      }
      if (frame.stunTicks === 0 && this.prevStun > 0) this.startInternal("getUp");
      if (frame.knockBounces !== this.prevBounces && (frame.stunTicks > 0 || this.tumble.mode !== TUMBLE_NONE)) {
        const impact = Math.hypot(frame.vx, frame.vy, frame.vz);
        this.tumble.bounce(Math.hypot(frame.vx, frame.vz));
        this.squashVel -= 3.5 * Math.min(1, impact / 12);
        this.springs.kick(null, 0, -2, 0, this.yaw);
      }
      if (frame.rollTicks === 0 && this.prevRoll > 0 && frame.stunTicks === 0) this.startInternal("rollPop");
      if (frame.abilityTicks === 0 && this.prevAbility > 0 && frame.stunTicks === 0) {
        if (this.abilityId === "flapDash") this.startInternal("airBrake");
        else if (this.abilityId === "bellySlide") this.startInternal("slidePop");
        else if (this.abilityId === "headbutt") this.startInternal("headbuttStop");
      }
      if (m.fullCharge && !this.prevFull) {
        // "Ready" pulse.
        this.squashVel += 1.2;
        this.springs.kick(null, 0, 1.5, 0, this.yaw);
        if (this.character === "whiskers") this.springs.kick("tail", 2.5, 0, 0, this.yaw);
      }
    }
    this.prevStun = frame.stunTicks;
    this.prevRoll = frame.rollTicks;
    this.prevAbility = frame.abilityTicks;
    this.prevBounces = frame.knockBounces;
    this.prevJumping = frame.jumping;
    this.prevFull = m.fullCharge;
  }

  /* --------------------------------------------------------------- pose */

  private updateTumble(frame: PlayerFrame, dt: number): void {
    const t = this.tumble;
    const m = this.motion;
    const input = this.tumbleInput;
    input.stunned = this.action === "stunned";
    input.grounded = frame.grounded;
    input.stunTicks = frame.stunTicks;
    input.speed = m.speed;
    t.update(dt, input);
    m.tumbleMode = t.mode;
    m.lying = t.lying;
    m.launchStretch = t.mode !== TUMBLE_NONE && t.sinceLaunch < 0.1 && Math.hypot(frame.vx, frame.vz) > 10 ? 1 - t.sinceLaunch / 0.1 : 0;
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

  /** Lean into accelerations, bank into turns, skid against reversals; the head leads turns. */
  private applyMomentum(frame: PlayerFrame): void {
    const out = this.out;
    const m = this.motion;
    if (LEANING.has(this.action)) {
      const w = frame.grounded ? 1 : 0.4;
      out.leanX += clampRange(m.accelFwd * 0.012, -0.25, 0.3) * w;
      out.leanZ += clampRange(m.accelRight * 0.01 - m.yawRate * m.speed * 0.015, -0.22, 0.22) * w;
      const s = m.skid;
      if (s > 0.001 && frame.grounded) {
        // Lean back against the slide, feet braced toward it, arms windmilling.
        out.leanX -= 0.32 * m.skidFwd * s;
        out.leanZ -= 0.25 * m.skidRight * s;
        out.legRX += 0.6 * m.skidFwd * s;
        out.legLX += 0.6 * m.skidFwd * s;
        out.legRZ += 0.15 * s;
        out.legLZ += 0.15 * s;
        const wind = Math.sin(this.time * 18);
        out.armRZ += (1.2 + 0.3 * wind) * s;
        out.armLZ += (1.2 - 0.3 * wind) * s;
        out.armRX -= 0.5 * s;
        out.armLX -= 0.5 * s;
        out.ears += 0.3 * s;
      }
    }
    if (!this.ghostMode) out.headY -= clampRange(wrapAngle(frame.yaw - this.yaw) * 0.9, -0.5, 0.5);
  }

  /** The tumble flip / twist (and the lying offset) on top of whatever state is blending in. */
  private applyTumble(): void {
    const t = this.tumble;
    if (t.mode === TUMBLE_NONE) return;
    this.out.pitch -= wrapAngle(t.angle);
    this.out.spinY += wrapAngle(t.twist);
    if (this.action !== "stunned") this.out.lift -= 0.3 * t.lying;
  }

  /* -------------------------------------------------------------- clips */

  private startClip(name: ClipName, def: ClipDef, opts: TriggerOptions): ActiveClip {
    if (EXCLUSIVE_CLIPS.has(name)) {
      for (let i = this.clipCount - 1; i >= 0; i--) if (EXCLUSIVE_CLIPS.has(this.clips[i].name)) this.removeClip(i);
    }
    for (let i = this.clipCount - 1; i >= 0; i--) if (this.clips[i].name === name) this.removeClip(i);
    if (this.clipCount >= MAX_CLIPS) this.removeClip(0);
    const slot = this.clips[this.clipCount++];
    slot.name = name;
    slot.def = def;
    const c = slot.ctx;
    const m = this.motion;
    c.u = 0;
    c.t = 0;
    c.character = this.character;
    c.ability = this.abilityId;
    c.opts = opts;
    c.k = clamp01(opts.strength ?? def.strength);
    c.speed = m.speed;
    c.variant = 0;
    c.power = "";
    c.curve = false;
    c.omega = 0;
    c.angle0 = 0;
    c.cancel = 0;
    c.side = this.spinSide(opts);
    const dir = opts.dir;
    c.dirFwd = 0;
    c.dirRight = 0;
    if (dir) {
      const len = Math.hypot(dir.x, dir.z);
      if (len > 1e-6) {
        const sin = Math.sin(this.yaw);
        const cos = Math.cos(this.yaw);
        c.dirFwd = (-dir.x * sin - dir.z * cos) / len;
        c.dirRight = (dir.x * cos - dir.z * sin) / len;
      }
    }
    return slot;
  }

  /** Duration, squash impulse and spring kick once the context is filled. */
  private beginClip(slot: ActiveClip): void {
    const c = slot.ctx;
    c.duration = Math.max(0.05, slot.def.duration(c));
    this.squashVel += slot.def.impulse(c);
    slot.def.kick?.(c, this.springs, this.yaw);
  }

  private startInternal(name: InternalClip, variant = 0): void {
    const slot = this.startClip(name, INTERNAL_CLIPS[name], NO_OPTS);
    slot.ctx.variant = variant;
    if (name === "fidget") slot.ctx.side = this.rng() < 0.5 ? -1 : 1;
    this.beginClip(slot);
  }

  private removeClip(index: number): void {
    const removed = this.clips[index];
    for (let i = index; i < this.clipCount - 1; i++) this.clips[i] = this.clips[i + 1];
    this.clips[this.clipCount - 1] = removed;
    this.clipCount--;
  }

  private applyClips(dt: number): void {
    for (let i = 0; i < this.clipCount; i++) {
      const clip = this.clips[i];
      const c = clip.ctx;
      c.t += dt;
      c.u = Math.min(1, c.t / c.duration);
      let w = envelope(c.u, clip.def.fadeIn, clip.def.fadeOut);
      if (c.cancel > 0) {
        c.cancel -= dt;
        w *= Math.max(0, c.cancel / CANCEL_FADE);
        if (c.cancel <= 0) c.u = 1;
      }
      copyPose(this.scratch, this.out);
      clip.def.pose(this.scratch, c);
      lerpPose(this.out, this.scratch, w);
    }
    // In-place compaction of finished clips.
    for (let i = this.clipCount - 1; i >= 0; i--) if (this.clips[i].ctx.u >= 1) this.removeClip(i);
  }

  /** After 2 s of calm idle, an occasional per-animal fidget (seeded). */
  private scheduleFidgets(frame: PlayerFrame, dt: number): void {
    const calm = this.action === "idle" && !this.ghostMode && this.clipCount === 0 && this.motion.speed < 0.3 && frame.heldCount === 0;
    if (!calm) {
      if (this.clipCount === 0 || this.action !== "idle") this.idleCalm = 0;
      return;
    }
    this.idleCalm += dt;
    if (this.idleCalm < 2) return;
    this.fidgetIn -= dt;
    if (this.fidgetIn > 0) return;
    const list = FIDGETS[this.character];
    let variant = Math.floor(this.rng() * list.length);
    if (this.character === "whiskers" && this.rng() < 0.5) variant = 0; // ear flicks are frequent
    this.startInternal("fidget", Math.min(list.length - 1, variant));
    this.fidgetIn = this.nextFidgetDelay();
  }

  private nextFidgetDelay(): number {
    return this.character === "whiskers" ? 2 + this.rng() * 2 : 4 + this.rng() * 5;
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

  /* -------------------------------------------------------------- faces */

  /** Clips (newest first) > state > hurt flash > neutral (eyes blink; the mouth never does). */
  private updateFace(frame: PlayerFrame, dt: number): void {
    const f = this.face;
    f.eyes = null;
    f.mouth = null;
    const tmp = this.faceTmp;
    for (let i = this.clipCount - 1; i >= 0; i--) {
      const clip = this.clips[i];
      if (clip.ctx.cancel > 0) continue;
      tmp.eyes = null;
      tmp.mouth = null;
      clip.def.face(clip.ctx, tmp);
      if (f.eyes === null) f.eyes = tmp.eyes;
      if (f.mouth === null) f.mouth = tmp.mouth;
      if (f.eyes !== null && f.mouth !== null) break;
    }
    const st = stateExpression(this.action, this.motion, this.faceState);
    if (f.eyes === null) f.eyes = st.eyes;
    if (f.mouth === null) f.mouth = st.mouth;
    if (frame.hurtTicks > 0 && this.action !== "ghost") {
      if (f.eyes === null) f.eyes = "hurt";
      if (f.mouth === null) f.mouth = "hurt";
    }
    const blink = this.blink(dt);
    if (f.eyes === null) f.eyes = blink ? "blink" : "idle";
    if (f.mouth === null) f.mouth = "idle";
    if (isBeaked(this.character)) this.out.jaw = Math.max(this.out.jaw, BEAK_JAW[f.mouth] ?? 0);
  }

  /** Random blinks every 2–5 s (sometimes a double blink); seeded. */
  private blink(dt: number): boolean {
    if (this.blinkLeft > 0) {
      this.blinkLeft -= dt;
      return this.blinkLeft > 0;
    }
    this.blinkIn -= dt;
    if (this.blinkIn <= 0) {
      this.blinkLeft = BLINK_SEC;
      this.blinkIn = this.rng() < 0.15 ? 0.22 : 2 + this.rng() * 3;
      return true;
    }
    return false;
  }

  /** Twist direction: away from the side the hit came from (random without a direction). */
  private spinSide(opts: TriggerOptions): number {
    const dir = opts.dir;
    if (!dir || (dir.x === 0 && dir.z === 0)) return this.rng() < 0.5 ? -1 : 1;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    const right = dir.x * cos - dir.z * sin;
    return right >= 0 ? -1 : 1;
  }
}

function clampRange(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
