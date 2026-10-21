// Procedural animation of one tourist: the continuous state from the PlayerFrame (crossfaded), the held-item
// and signature-prop arm layers, momentum lean, one-shot clips, squash & stretch spring, the tool aim, the
// extra bone flavor (veil / ponytail / toque / propeller) and the meshed face (expressions + blinks).
// Owner: client-characters. Adapted from games/bonk-brawl/client/src/characters/Animator.ts.

import * as THREE from "three";
import { CHARGE_FULL_TICKS, FULL_CHARGE_THRESHOLD, PUFFER_FUSE_TICKS } from "../../../shared/constants";
import type { CharacterId, InvKind } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { CharacterTrigger, TriggerOptions } from "./Characters";
import { CLIPS, type ClipContext, type ClipDef, type ClipProp, EXCLUSIVE_CLIPS, SELFIE_FLASH_U } from "./clips";
import { holdClass } from "./holds";
import {
  clamp01,
  copyPose,
  createPose,
  damp,
  easeInOut,
  envelope,
  type FaceExpression,
  type FaceParams,
  FACES,
  lerpPose,
  restPose,
  wrapAngle,
} from "./pose";
import { createPuppetFrame } from "./puppet";
import { applyPose } from "./rigPose";
import { blendTimeFor, carriesItems, deriveState, evaluateState, gaitCadence, type MotionInfo, stateFace, type TouristState } from "./states";
import type { Tourist } from "./Tourist";

const TAU = Math.PI * 2;
/** Body facing follows frame.yaw at this rate (1/s). */
const YAW_RATE = 14;
/** Squash spring (underdamped, so landings wobble). */
const SPRING_K = 300;
const SPRING_C = 2 * Math.sqrt(SPRING_K) * 0.3;
const SPRING_STEP = 1 / 120;
const SQUASH_MIN = -0.45;
const SQUASH_MAX = 0.4;
/** Velocity changes faster than this per frame are teleports, not accelerations. */
const TELEPORT_DV = 12;
const BLINK_SEC = 0.11;
const FACE_RATE = 18;
/** A land squash is auto-detected from this fall speed (m/s). */
const LAND_SPEED = 4;

interface ActiveClip {
  name: CharacterTrigger;
  def: ClipDef;
  ctx: ClipContext;
}

/** Right-arm pose per held-item situation (raise forward, twist, raise outward). */
const CARRY_R = {
  palm: [0.95, 0, 0.3],
  tool: [0.75, 0.1, 0.22],
  torch: [1.95, 0.15, 0.25],
  torchOut: [0.75, 0.1, 0.22],
  big: [2.75, 0, 0.45],
  puffer: [1.45, 0, 0.1],
  jelly: [1.35, 0, 0.55],
} as const;
type CarryKind = keyof typeof CARRY_R;

/** Left-arm signature prop holds (selfie stick up, radio at the side, ladle raised). */
const SIGNATURE_L: Partial<Record<CharacterId, readonly [number, number, number]>> = {
  fenomen: [0.72, 0.1, 0.22],
  amca: [0.32, 0, 0.18],
  sef: [0.95, 0.2, 0.35],
};

const tmpQ = new THREE.Quaternion();
const tmpQ2 = new THREE.Quaternion();
const tmpM = new THREE.Matrix4();
const tmpV = new THREE.Vector3();
const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const IDENTITY = new THREE.Quaternion();

export class Animator {
  private readonly tourist: Tourist;
  private readonly character: CharacterId;
  private readonly base = createPose();
  private readonly from = createPose();
  private readonly target = createPose();
  private readonly scratch = createPose();
  private readonly out = createPose();
  private readonly motion: MotionInfo;
  private clips: ActiveClip[] = [];

  private stateName: TouristState | "" = "";
  private stateTime = 0;
  private blendTime = 0;
  private blendDuration = 0;
  private time = 0;

  private yaw = 0;
  private hasYaw = false;
  private prevVx = 0;
  private prevVz = 0;
  private accelFwd = 0;
  private accelRight = 0;
  private squash = 0;
  private squashVel = 0;
  private carryW = 0;
  private carryKind: CarryKind = "palm";
  private readonly carryPose = [0, 0, 0];
  private signatureW = 0;
  private prevGrounded = true;
  private prevVy = 0;
  private landCooldown = 0;
  private propeller = 0;
  private aimW = 0;

  private readonly face: FaceParams = { ...FACES.idle };
  private expression: FaceExpression = "idle";
  private blinkIn = 1 + Math.random() * 3;
  private blinkLeft = 0;
  private flashGlow = 0;

  constructor(tourist: Tourist) {
    this.tourist = tourist;
    this.character = tourist.character;
    this.motion = {
      frame: createPuppetFrame(tourist.character),
      character: tourist.character,
      t: 0,
      time: 0,
      speed: 0,
      fwdSpeed: 0,
      rightSpeed: 0,
      runPhase: 0,
      idlePhase: Math.random() * TAU,
      charge: 0,
      fullCharge: false,
      held: "",
      heldCls: null,
      seed: Math.random() * 100,
    };
  }

  /** Current continuous state (dev harness / debugging). */
  get state(): TouristState | "" {
    return this.stateName;
  }

  get currentExpression(): FaceExpression {
    return this.expression;
  }

  /** Per frame with the cosmetic dt. `held` = the active inventory kind. */
  update(frame: PlayerFrame, held: InvKind, dt: number): void {
    this.time += dt;
    this.landCooldown = Math.max(0, this.landCooldown - dt);
    this.updateFacing(frame, dt);
    this.updateMotion(frame, held, dt);
    this.detectLanding(frame);

    const state = deriveState(frame, held);
    if (state !== this.stateName) this.enterState(state);
    this.stateTime += dt;
    this.motion.t = this.stateTime;

    restPose(this.target);
    evaluateState(state, this.target, this.motion);
    this.blendBase(dt);
    copyPose(this.out, this.base);
    this.applyCarry(frame, held, state, dt);
    this.applySignature(state, held, dt);
    this.applyCold(frame);
    this.applyMomentum(frame, state, dt);
    this.applyClips(dt);
    this.stepSpring(dt);
    this.out.crouch += this.squash;
    this.updateExtra(frame, dt);
    applyPose(this.tourist.rig, this.out, this.character === "cocuk" ? this.propeller : 0);
    this.updateAim(frame, dt);
    this.updateFace(frame, held, state, dt);
    this.updateGlow(dt);
  }

  trigger(what: CharacterTrigger, opts: TriggerOptions = {}, held: InvKind = ""): void {
    if (what === "land") {
      if (this.landCooldown > 0) return;
      this.landCooldown = 0.25;
    }
    const def = CLIPS[what];
    const options: TriggerOptions = what === "use" && !opts.item && held !== "" ? { ...opts, item: held } : opts;
    if (EXCLUSIVE_CLIPS.has(what)) this.clips = this.clips.filter((c) => !EXCLUSIVE_CLIPS.has(c.name));
    this.clips = this.clips.filter((c) => c.name !== what);
    const duration = Math.max(0.05, def.duration(options, this.character));
    this.clips.push({
      name: what,
      def,
      ctx: { u: 0, t: 0, duration, character: this.character, opts: options, held, side: this.flinchSide(options) },
    });
    this.squashVel += def.impulse(options);
  }

  hasClip(what: CharacterTrigger): boolean {
    return this.clips.some((c) => c.name === what);
  }

  /** The held item should be hidden right now (it left the hand during a throw / toss clip). */
  get heldReleased(): boolean {
    for (const c of this.clips) if (c.def.releaseAt !== undefined && c.ctx.u >= c.def.releaseAt) return true;
    return false;
  }

  /** Temporary prop of the running clips (food while eating, a phone for the selfie). */
  get clipProp(): { prop: ClipProp; item: InvKind } {
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const c = this.clips[i]!;
      const prop = c.def.prop?.(c.ctx) ?? null;
      if (prop) return { prop, item: (c.ctx.opts.item as InvKind | undefined) ?? c.ctx.held };
    }
    return { prop: null, item: "" };
  }

  /** Drop every clip and spring and return to a fresh pose (respawn, rebuild). */
  reset(): void {
    this.clips = [];
    this.stateName = "";
    this.squash = 0;
    this.squashVel = 0;
    this.carryW = 0;
    this.signatureW = 0;
    this.hasYaw = false;
    this.blendDuration = 0;
    restPose(this.base);
  }

  /* ----------------------------------------------------------- internals */

  private updateFacing(frame: PlayerFrame, dt: number): void {
    if (!this.hasYaw) {
      this.yaw = frame.yaw;
      this.hasYaw = true;
    } else {
      this.yaw = wrapAngle(this.yaw + wrapAngle(frame.yaw - this.yaw) * damp(YAW_RATE, dt));
    }
    this.tourist.rig.root.rotation.y = this.yaw;
  }

  private updateMotion(frame: PlayerFrame, held: InvKind, dt: number): void {
    const m = this.motion;
    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    m.frame = frame;
    m.time = this.time;
    m.speed = Math.hypot(frame.vx, frame.vz);
    m.fwdSpeed = -frame.vx * sin - frame.vz * cos;
    m.rightSpeed = frame.vx * cos - frame.vz * sin;
    m.runPhase = (m.runPhase + dt * (4.5 + m.speed * 1.7) * gaitCadence(this.character)) % (TAU * 64);
    m.idlePhase = (m.idlePhase + dt * TAU * 1.1) % TAU;
    m.charge = clamp01(frame.chargeTicks / CHARGE_FULL_TICKS);
    m.fullCharge = m.charge >= FULL_CHARGE_THRESHOLD;
    m.held = held;
    m.heldCls = held === "" ? null : holdClass(held);
  }

  private detectLanding(frame: PlayerFrame): void {
    if (frame.grounded && !this.prevGrounded && !frame.swimming && this.prevVy < -LAND_SPEED) {
      this.trigger("land", {}, this.motion.held);
    }
    this.prevGrounded = frame.grounded;
    this.prevVy = frame.vy;
  }

  private enterState(state: TouristState): void {
    const first = this.stateName === "";
    copyPose(this.from, this.base);
    this.stateName = state;
    this.stateTime = 0;
    this.blendTime = 0;
    this.blendDuration = first ? 0 : blendTimeFor(state);
    if (state === "air" && this.motion.frame.vy > 0) this.squashVel += 2.2;
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

  /** Hold the active item: palm in front, tool up, lit torch high, raft part on the head, puffer at arm's length. */
  private applyCarry(frame: PlayerFrame, held: InvKind, state: TouristState, dt: number): void {
    let kind: CarryKind | null = null;
    if (held !== "" && carriesItems(state)) {
      const cls = holdClass(held);
      if (held === "puffer") kind = "puffer";
      else if (held === "jellyfish") kind = "jelly";
      else if (cls === "torch") kind = frame.torchTicks > 0 ? "torch" : "torchOut";
      else kind = cls;
    }
    this.carryW += ((kind ? 1 : 0) - this.carryW) * damp(12, dt);
    if (kind) {
      this.carryKind = kind;
      const pose = CARRY_R[kind];
      const k = damp(14, dt);
      for (let i = 0; i < 3; i++) this.carryPose[i]! += (pose[i]! - this.carryPose[i]!) * k;
    }
    if (this.carryW < 0.001) return;
    const w = this.carryW;
    const out = this.out;
    const sway = 0.12 * Math.sin(this.motion.runPhase) * Math.min(1, this.motion.speed / 5);
    let jitter = 0;
    if (this.carryKind === "puffer") {
      const fuse = 1 - clamp01(frame.fuseTicks / PUFFER_FUSE_TICKS);
      jitter = (0.03 + 0.2 * fuse * fuse) * Math.sin(this.time * (30 + 30 * fuse));
    } else if (this.carryKind === "jelly") {
      jitter = 0.18 * Math.sin(this.time * 26);
    }
    out.armRX += (this.carryPose[0]! + sway + jitter - out.armRX) * w;
    out.armRY += (this.carryPose[1]! - out.armRY) * w;
    out.armRZ += (this.carryPose[2]! + jitter * 0.5 - out.armRZ) * w;
    if (this.carryKind === "big") {
      out.armLX += (CARRY_R.big[0] - out.armLX) * w;
      out.armLZ += (CARRY_R.big[2] - out.armLZ) * w;
      out.leanX += 0.04 * w;
    }
    if (this.carryKind === "jelly") out.leanZ -= 0.08 * w;
  }

  /** The character's signature prop in the left hand (stick, radio, ladle). */
  private applySignature(state: TouristState, held: InvKind, dt: number): void {
    const pose = SIGNATURE_L[this.character];
    if (!pose) return;
    const busy = !carriesItems(state) || (held !== "" && holdClass(held) === "big");
    this.signatureW += ((busy ? 0 : 1) - this.signatureW) * damp(10, dt);
    if (this.signatureW < 0.001) return;
    const w = this.signatureW;
    const out = this.out;
    const bob = this.character === "amca" ? 0.06 * Math.sin(this.time * 4.2) : 0.04 * Math.sin(this.time * 1.3);
    out.armLX += (pose[0] + bob - out.armLX) * w;
    out.armLY += (pose[1] - out.armLY) * w;
    out.armLZ += (pose[2] - out.armLZ) * w;
  }

  /** Shivering when the warmth bar runs low. */
  private applyCold(frame: PlayerFrame): void {
    if (frame.warmth >= 25 || frame.swimming || frame.downed) return;
    const k = (25 - frame.warmth) / 25;
    const j = Math.sin(this.time * 47) * 0.025 * k;
    this.out.leanZ += j;
    this.out.headZ += j * 1.5;
    this.out.armRZ -= 0.15 * k;
    this.out.armLZ -= 0.15 * k;
    this.out.crouch -= 0.03 * k;
  }

  /** Lean into accelerations and let the head lead turns (secondary motion). */
  private applyMomentum(frame: PlayerFrame, state: TouristState, dt: number): void {
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
    if ((state === "move" || state === "sprint" || state === "charge") && frame.grounded) {
      out.leanX += clampAbs(this.accelFwd * 0.006, 0.14);
      out.leanZ += clampAbs(this.accelRight * 0.005, 0.1);
    }
    out.headY -= clampAbs(wrapAngle(frame.yaw - this.yaw) * 0.9, 0.5);
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

  /** Veil / ponytail trail behind when moving; the kid's propeller spins with speed. */
  private updateExtra(frame: PlayerFrame, dt: number): void {
    const speed = this.motion.speed;
    if (this.character === "cocuk") {
      const rate = 2 + speed * 4.5 + (frame.grounded ? 0 : 14);
      this.propeller = (this.propeller + rate * dt) % TAU;
    } else if (this.character === "gelin" || this.character === "fenomen") {
      this.out.extraX -= Math.min(0.5, speed * 0.07);
      this.out.extraZ += 0.05 * Math.sin(this.time * 6.5 + this.motion.seed) * Math.min(1, speed / 3);
    }
  }

  /** Point a held tool where the body looks (spear wind-up, rod, torch swing). */
  private updateAim(frame: PlayerFrame, dt: number): void {
    const held = this.tourist.heldObject;
    this.aimW += (clamp01(this.out.aim) - this.aimW) * damp(14, dt);
    if (!held) return;
    if (this.aimW < 0.01 || this.tourist.heldClass === "big") {
      held.quaternion.copy(IDENTITY);
      return;
    }
    const grip = this.tourist.rig.gripR;
    this.tourist.rig.root.updateMatrixWorld(true);
    grip.getWorldQuaternion(tmpQ);
    const cp = Math.cos(frame.pitch);
    tmpV.set(-Math.sin(this.yaw) * cp, Math.sin(frame.pitch) + 0.15, -Math.cos(this.yaw) * cp).normalize();
    tmpM.lookAt(ORIGIN, tmpV, UP);
    tmpQ2.setFromRotationMatrix(tmpM);
    tmpQ.invert().multiply(tmpQ2);
    held.quaternion.slerpQuaternions(IDENTITY, tmpQ, this.aimW);
  }

  private updateFace(frame: PlayerFrame, held: InvKind, state: TouristState, dt: number): void {
    let face = this.clipFace() ?? stateFace(state, this.motion);
    if (!face && held === "jellyfish") face = "panic";
    if (!face && held === "puffer" && frame.fuseTicks > 0 && frame.fuseTicks < PUFFER_FUSE_TICKS * 0.4) face = "panic";
    if (!face && (frame.hunger < 15 || frame.thirst < 15 || frame.warmth < 15 || frame.hp < 25)) face = "tired";
    if (!face) face = this.blink(dt) ? "blink" : "idle";
    this.expression = face;
    const target = FACES[face];
    if (face === "blink") {
      this.face.eyeOpen = target.eyeOpen;
    } else {
      const k = damp(FACE_RATE, dt);
      this.face.eyeOpen += (target.eyeOpen - this.face.eyeOpen) * k;
      this.face.eyeSize += (target.eyeSize - this.face.eyeSize) * k;
      this.face.smile += (target.smile - this.face.smile) * k;
      this.face.jaw += (target.jaw - this.face.jaw) * k;
      if (face === "chew") this.face.jaw = 0.25 + 0.3 * Math.abs(Math.sin(this.time * 15));
      if (face === "dizzy") this.face.eyeOpen = 0.55 + 0.25 * Math.sin(this.time * 9);
    }
    this.tourist.setFace(this.face);
  }

  /** Fenomen's ring light: steady glow, a big flash at the selfie moment. */
  private updateGlow(dt: number): void {
    if (!this.tourist.rig.glow) return;
    for (const c of this.clips) {
      if (c.name === "emote" && c.ctx.opts.emote === "selfie" && c.ctx.u >= SELFIE_FLASH_U && c.ctx.u - dt / c.ctx.duration < SELFIE_FLASH_U) this.flashGlow = 1;
    }
    this.flashGlow = Math.max(0, this.flashGlow - dt * 3);
    this.tourist.setGlow(1 + 3.5 * this.flashGlow);
  }

  private clipFace(): FaceExpression | null {
    for (let i = this.clips.length - 1; i >= 0; i--) {
      const clip = this.clips[i]!;
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

  /** Hit flinch side: away from the side the hit came from (random without a direction). */
  private flinchSide(opts: TriggerOptions): number {
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
