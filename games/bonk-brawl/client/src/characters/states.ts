// Continuous animation states (one target pose per PlayerAction) and the knockback tumble
// integrator. Owner: client-characters (MOTION).

import {
  BELLY_BOUNCE_TICKS,
  BELLY_SLIDE_TICKS,
  GROUND_POUND_RISE_TICKS,
  HEADBUTT_TICKS,
  ROLL_TICKS,
  ticksToSec,
} from "../../../shared/constants";
import type { AbilityId, CharacterId, HeldPowerUp, PlayerAction } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import { bump, clamp01, easeInOut, easeOutCubic, envelope, type Pose, smoothstep } from "./pose";
import type { FaceExpression } from "./types";

const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;
const ROLL_SEC = ticksToSec(ROLL_TICKS);
/** Ground Pound rise time paces the tuck flip (the sim slams as soon as vy <= 0). */
const POUND_RISE_SEC = ticksToSec(GROUND_POUND_RISE_TICKS);
const BELLY_BOUNCE_SEC = ticksToSec(BELLY_BOUNCE_TICKS);
const BELLY_SLIDE_SEC = ticksToSec(BELLY_SLIDE_TICKS);
const HEADBUTT_SEC = ticksToSec(HEADBUTT_TICKS);
/** Airborne with vy < 0 longer than this = a real fall (windmill flail); step-downs never get here. */
export const LONG_FALL_SEC = 0.45;

/* ================================================================ gaits */

/** Per-animal locomotion profile (§3.3). */
export interface GaitProfile {
  /** Meters covered per gait cycle (two steps; one hop for the frog). */
  strideLen: number;
  /** Max gait cycles per second; above it the stride amplitude grows instead. */
  maxCadence: number;
  /** Vertical bob (m) and side-to-side waddle (rad of roll). */
  bob: number;
  waddle: number;
  /** Leg swing amplitude (rad) at a stride-locked cadence, and swinging-foot lift (m). */
  swing: number;
  footLift: number;
  /** Arm swing amplitude (rad). */
  armSwing: number;
  /** Extra sustained forward lean while running (rad) and head-down offset. */
  lean: number;
  headLow: number;
  /** Legs move together (frog hop). */
  hop: boolean;
}

export const GAITS: Readonly<Record<CharacterId, GaitProfile>> = {
  quacky: { strideLen: 0.9, maxCadence: 4.5, bob: 0.07, waddle: 0.16, swing: 0.62, footLift: 0.06, armSwing: 0, lean: 0, headLow: 0, hop: false },
  hopsworth: { strideLen: 1.4, maxCadence: 3.0, bob: 0.14, waddle: 0.03, swing: 0.6, footLift: 0, armSwing: 0.6, lean: 0, headLow: 0, hop: true },
  mochi: { strideLen: 1.2, maxCadence: 3.6, bob: 0.08, waddle: 0.1, swing: 0.6, footLift: 0.05, armSwing: 0.9, lean: 0, headLow: 0, hop: false },
  whiskers: { strideLen: 1.5, maxCadence: 3.4, bob: 0.05, waddle: 0.03, swing: 0.75, footLift: 0.06, armSwing: 0.7, lean: 0.05, headLow: 0, hop: false },
  pip: { strideLen: 0.8, maxCadence: 5.0, bob: 0.05, waddle: 0.22, swing: 0.55, footLift: 0.035, armSwing: 0, lean: 0, headLow: 0, hop: false },
  gruff: { strideLen: 1.3, maxCadence: 3.6, bob: 0.07, waddle: 0.05, swing: 0.6, footLift: 0.03, armSwing: 0.9, lean: 0, headLow: 0.12, hop: false },
};

const WINGED: ReadonlySet<CharacterId> = new Set<CharacterId>(["quacky", "pip"]);

/* ============================================================ motion info */

/** Tumble modes (see Tumble). */
export const TUMBLE_NONE = 0;
export const TUMBLE_AIR = 1;
export const TUMBLE_ROLL = 2;
export const TUMBLE_SPLAT = 3;
export const TUMBLE_GETUP = 4;

/** Everything a state needs besides its own pose (filled by Animator.updateSignals every frame). */
export interface MotionInfo {
  frame: PlayerFrame;
  character: CharacterId;
  ability: AbilityId;
  gait: GaitProfile;
  /** Seconds since this state was entered. */
  t: number;
  /** Animator clock (seconds). */
  time: number;
  /** Per-animal random phase so crowds don't move in lockstep. */
  seed: number;
  /** Rendered (low-passed) horizontal speed (m/s), its components in the character frame and normalized speed. */
  speed: number;
  fwdSpeed: number;
  rightSpeed: number;
  speedNorm: number;
  /** Low-passed acceleration in the character frame (m/s²). */
  accelFwd: number;
  accelRight: number;
  /** Rate of change of the smoothed facing (rad/s, + = turning left). */
  yawRate: number;
  /** Stride-locked gait phase (rad) and stride amplitude multiplier (> 1 above max cadence). */
  runPhase: number;
  strideAmp: number;
  /** Idle breathing phase (rad). */
  idlePhase: number;
  /** 0..1 turn-skid weight and the velocity direction in the character frame while skidding. */
  skid: number;
  skidFwd: number;
  skidRight: number;
  /** Air signals: 0 at takeoff → 0.5 apex → 1 falling fast; apex weight; seconds airborne / falling. */
  airU: number;
  apex: number;
  airSec: number;
  fallSec: number;
  /** A released (cut) jump: short hop. */
  jumpCut: boolean;
  /** 0..1 throw charge and whether it is full; seconds since full charge was reached (-1 = not full). */
  charge: number;
  fullCharge: boolean;
  fullSec: number;
  /** Power-up of the ball being charged ("" none). */
  lastPowerUp: HeldPowerUp;
  zoomies: boolean;
  /** Yaw offsets (player-yaw convention) toward the locked move direction and the velocity. */
  dirTurn: number;
  velTurn: number;
  /** Knockback tumble (owned by the Animator's Tumble). */
  tumbleMode: number;
  /** 0..1 lying on the back / front (splat). */
  lying: number;
  /** Stretch along the launch in the first 0.1 s of a strong knock (0..1). */
  launchStretch: number;
  /** Idle head look target (rad, + = right). */
  look: number;
}

export function createMotionInfo(frame: PlayerFrame, character: CharacterId, ability: AbilityId, seed: number): MotionInfo {
  return {
    frame,
    character,
    ability,
    gait: GAITS[character],
    t: 0,
    time: 0,
    seed,
    speed: 0,
    fwdSpeed: 0,
    rightSpeed: 0,
    speedNorm: 0,
    accelFwd: 0,
    accelRight: 0,
    yawRate: 0,
    runPhase: 0,
    strideAmp: 1,
    idlePhase: seed % TAU,
    skid: 0,
    skidFwd: 0,
    skidRight: 0,
    airU: 0,
    apex: 0,
    airSec: 0,
    fallSec: 0,
    jumpCut: false,
    charge: 0,
    fullCharge: false,
    fullSec: -1,
    lastPowerUp: "",
    zoomies: false,
    dirTurn: 0,
    velTurn: 0,
    tumbleMode: TUMBLE_NONE,
    lying: 0,
    launchStretch: 0,
    look: 0,
  };
}

/** Advance the stride-locked gait phase: cadence = speed / strideLen, clamped. */
export function advanceGait(m: MotionInfo, dt: number): void {
  const g = m.gait;
  const maxCad = g.maxCadence * (m.zoomies ? 1.25 : 1);
  const want = m.speed / g.strideLen;
  const cadence = want < 1.2 ? 1.2 : want > maxCad ? maxCad : want;
  m.strideAmp = Math.min(1.6, want / cadence);
  m.runPhase = (m.runPhase + TAU * cadence * dt) % (TAU * 64);
}

/* ============================================================== tumble */

export interface TumbleInput {
  stunned: boolean;
  grounded: boolean;
  stunTicks: number;
  /** Grounded stun ticks at or below this start the get-up early (KNOCK_GETUP_TICKS). */
  getUpTicks: number;
  speed: number;
}

/**
 * Knockback tumble angle (backflip, pitch = −angle) and twist (spinY): spins in the air at a rate
 * set by the launch speed, rolls through to upright or splats on landing, then gets up — always
 * rotating forward, never unwinding. Pure (no three.js) so it is unit-testable.
 */
export class Tumble {
  angle = 0;
  omega = 0;
  twist = 0;
  twistRate = 0;
  mode = TUMBLE_NONE;
  private target = 0;
  private vel = 0;
  private twistTarget = 0;
  private getUpFrom = 0;
  private getUpTwistFrom = 0;
  private getUpTwistTo = 0;
  private getUpT = 0;
  private getUpDur = 0;
  /** Seconds since the launch (stretch / face timing). */
  sinceLaunch = 0;

  /** Stun rising edge: spin rate from the horizontal launch speed; twist on big knocks. */
  start(vx: number, vz: number, strength: number, side: number): void {
    const vh = Math.hypot(vx, vz);
    // Keep the visual angle continuous if a new knock lands mid-tumble.
    this.angle = ((this.angle % TAU) + TAU) % TAU;
    this.twist = ((this.twist % TAU) + TAU) % TAU;
    if (this.twist > Math.PI) this.twist -= TAU;
    this.omega = clampN(vh / 0.55, 6, 22);
    this.twistRate = strength >= 0.9 || vh > 10 ? side * 0.35 * this.omega : 0;
    this.mode = TUMBLE_AIR;
    this.vel = 0;
    this.sinceLaunch = 0;
  }

  /** Floor / cover bounce while tumbling: re-spin. */
  bounce(speed: number): void {
    if (this.mode === TUMBLE_NONE) return;
    this.mode = TUMBLE_AIR;
    this.omega = Math.max(this.omega, clampN(speed / 0.55, 6, 22) * 0.7);
  }

  reset(): void {
    this.angle = 0;
    this.omega = 0;
    this.twist = 0;
    this.twistRate = 0;
    this.mode = TUMBLE_NONE;
    this.vel = 0;
  }

  /** Lying weight (splat) for the pose: 1 flat on the back / front. */
  get lying(): number {
    if (this.mode === TUMBLE_SPLAT || this.mode === TUMBLE_GETUP || this.mode === TUMBLE_ROLL) {
      return Math.abs(Math.sin(this.angle));
    }
    return 0;
  }

  update(dt: number, s: TumbleInput): void {
    if (dt <= 0) return;
    this.sinceLaunch += dt;
    if (this.mode === TUMBLE_NONE) return;
    if (this.mode === TUMBLE_GETUP) {
      if (s.stunned && !s.grounded) {
        // Launched again (bounce, ledge) before standing up.
        this.mode = TUMBLE_AIR;
        this.omega = Math.max(6, this.omega);
      } else {
        this.stepGetUp(dt);
        return;
      }
    }
    if (!s.stunned) {
      // Control is back: stand up now (upright within GETUP_FAST_SEC).
      this.beginGetUp(GETUP_FAST_SEC);
      this.stepGetUp(dt);
      return;
    }
    if (!s.grounded) {
      if (this.mode !== TUMBLE_AIR) {
        this.mode = TUMBLE_AIR;
        this.omega = Math.max(this.omega, this.vel, 4);
      }
      this.angle += this.omega * dt;
      this.omega *= Math.exp(-0.8 * dt);
      this.twist += this.twistRate * dt;
      return;
    }
    if (this.mode === TUMBLE_AIR) this.land();
    // Grounded: settle forward toward the roll-through upright or the lying angle.
    this.settle(dt);
    if (s.stunTicks <= s.getUpTicks) this.beginGetUp(s.speed > 1 ? GETUP_FAST_SEC : GETUP_SEC);
  }

  private land(): void {
    const next = Math.ceil(this.angle / TAU - 1e-9) * TAU;
    const rem = next - this.angle;
    this.vel = this.omega;
    if (rem < 0.45 * Math.PI) {
      this.mode = TUMBLE_ROLL;
      this.target = next;
    } else {
      this.mode = TUMBLE_SPLAT;
      let k = Math.ceil(this.angle / HALF_PI - 1e-9);
      if (k % 2 === 0) k += 1;
      this.target = k * HALF_PI;
    }
    const tw = this.twistRate >= 0 ? Math.ceil(this.twist / TAU - 1e-9) : Math.floor(this.twist / TAU + 1e-9);
    this.twistTarget = tw * TAU;
  }

  /** Critically damped (ωn 14) approach, forward only. */
  private settle(dt: number): void {
    const wn = 14;
    const x = this.angle - this.target;
    const a = -wn * wn * x - 2 * wn * this.vel;
    this.vel = Math.max(0, this.vel + a * dt);
    this.angle = Math.min(this.target, this.angle + this.vel * dt);
    if (this.angle >= this.target - 1e-4) this.vel = 0;
    this.twist += (this.twistTarget - this.twist) * (1 - Math.exp(-12 * dt));
  }

  private beginGetUp(duration: number): void {
    if (this.mode === TUMBLE_GETUP) return;
    this.mode = TUMBLE_GETUP;
    this.getUpFrom = this.angle;
    this.target = Math.ceil(this.angle / TAU - 1e-6) * TAU;
    this.getUpTwistFrom = this.twist;
    this.getUpTwistTo = Math.round(this.twist / TAU) * TAU;
    this.getUpT = 0;
    this.getUpDur = duration;
  }

  private stepGetUp(dt: number): void {
    this.getUpT += dt;
    const u = easeInOut(this.getUpT / this.getUpDur);
    this.angle = this.getUpFrom + (this.target - this.getUpFrom) * u;
    this.twist = this.getUpTwistFrom + (this.getUpTwistTo - this.getUpTwistFrom) * u;
    if (this.getUpT >= this.getUpDur) {
      this.angle = 0;
      this.twist = 0;
      this.mode = TUMBLE_NONE;
      this.omega = 0;
    }
  }
}

/** Get-up durations (s): standing still, or already moving (guardrail: upright ≤ 0.2 s after control returns). */
export const GETUP_SEC = 0.32;
export const GETUP_FAST_SEC = 0.18;

function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/* ============================================================ helpers */

/** Stride-locked locomotion: legs, foot lift, bob, waddle and sustained lean, scaled by `w`. */
function locomotion(p: Pose, m: MotionInfo, w: number): void {
  const g = m.gait;
  const ramp = clamp01(m.speed / 1.2);
  const amp = ramp * m.strideAmp * w;
  if (amp <= 0.001) return;
  const phi = m.runPhase;
  const s = Math.sin(phi);
  const c = Math.cos(phi);
  const back = m.fwdSpeed < -0.35 * m.speed;
  const dir = back ? -1 : 1;
  // Legs turn toward sideways movement (backwards: mirror so the stride still reads).
  let moveTurn = Math.atan2(-m.rightSpeed, m.fwdSpeed);
  if (back) moveTurn = moveTurn > 0 ? moveTurn - Math.PI : moveTurn + Math.PI;
  p.legYaw += Math.max(-1, Math.min(1, moveTurn)) * ramp * w * 0.8;

  const fwdNorm = m.speed > 1e-3 ? (m.fwdSpeed / m.speed) * m.speedNorm : 0;
  p.leanX += (0.18 * fwdNorm + (g.lean + (m.zoomies ? 0.08 : 0)) * ramp) * w;
  p.headX += g.headLow * ramp * w;

  if (g.hop) {
    // Frog hop: both legs together, one hop per cycle (air on sin > 0, contact squash on sin < 0).
    const air = Math.max(0, s);
    const contact = Math.max(0, -s);
    p.lift += g.bob * air * amp;
    p.pitch += 0.2 * air * amp * dir;
    p.crouch += (0.06 * air - 0.12 * contact) * amp;
    p.legRX += (0.5 * air - 0.45 * contact) * amp * dir;
    p.legLX += (0.5 * air - 0.45 * contact) * amp * dir;
    p.legRZ += 0.15 * amp;
    p.legLZ += 0.15 * amp;
    p.ears += 0.15 * air * amp;
    p.extraX -= 0.2 * air * amp;
    return;
  }

  // Biped: right leg = swing·cos φ; passing at sin φ = ±1 (bob up), contact at cos φ = ±1 (squash).
  const swing = g.swing * amp * dir;
  p.legRX += c * swing;
  p.legLX -= c * swing;
  p.legRLift += g.footLift * Math.max(0, -s) * amp;
  p.legLLift += g.footLift * Math.max(0, s) * amp;
  p.lift += Math.abs(s) * g.bob * amp;
  p.crouch -= 0.06 * c * c * amp;
  p.roll += c * g.waddle * amp;
  p.twist += c * 0.08 * amp;
  p.ears += 0.12 * Math.abs(s) * amp;
  p.extraY += 0.25 * c * amp;
  if (m.character === "quacky") {
    // Bird head bob: pulls back, then snaps forward each step.
    const step = ((phi / Math.PI) % 1 + 1) % 1;
    p.headX += (step < 0.7 ? -0.1 * (step / 0.7) : -0.1 + 0.22 * ((step - 0.7) / 0.3)) * amp;
  }
}

/** Arm swing that goes with locomotion (skipped by states that own the arms). */
function armSwing(p: Pose, m: MotionInfo, w: number): void {
  const g = m.gait;
  const amp = clamp01(m.speed / 1.2) * Math.min(1.3, m.strideAmp) * w;
  if (amp <= 0.001) return;
  const phi = m.runPhase;
  const c = Math.cos(phi);
  switch (m.character) {
    case "quacky": {
      // Wings out and back, fluttering.
      const flutter = 0.2 * Math.sin(3 * phi);
      p.armRZ += (0.35 + flutter) * amp;
      p.armLZ += (0.35 - flutter) * amp;
      p.armRX -= 0.35 * amp;
      p.armLX -= 0.35 * amp;
      return;
    }
    case "pip": {
      // Flippers out sideways for balance.
      const s = Math.abs(Math.sin(phi));
      p.armRZ += (0.55 + 0.1 * s) * amp;
      p.armLZ += (0.55 + 0.1 * s) * amp;
      p.armRX -= 0.1 * amp;
      p.armLX -= 0.1 * amp;
      return;
    }
    case "hopsworth": {
      // Arms swing together with the hop.
      const s = Math.sin(phi);
      p.armRX += -g.armSwing * s * amp;
      p.armLX += -g.armSwing * s * amp;
      p.armRZ += 0.2 * amp;
      p.armLZ += 0.2 * amp;
      return;
    }
    case "mochi":
      // Low pumping arms.
      p.armRX += -g.armSwing * c * amp;
      p.armLX += g.armSwing * c * amp;
      p.armRZ += 0.25 * amp;
      p.armLZ += 0.25 * amp;
      return;
    default:
      p.armRX += -g.armSwing * c * amp;
      p.armLX += g.armSwing * c * amp;
      p.armRZ += 0.15 * amp;
      p.armLZ += 0.15 * amp;
  }
}

/** Head follows the aim pitch a little (looking up / down). */
function lookPitch(p: Pose, m: MotionInfo, w: number): void {
  p.headX -= m.frame.pitch * 0.4 * w;
}

/** Turn in place: small alternating steps while the facing swings around. */
function turnSteps(p: Pose, m: MotionInfo): void {
  if (m.speed >= 0.6 || Math.abs(m.yawRate) <= 2) return;
  const w = clamp01((Math.abs(m.yawRate) - 2) / 2);
  const s = Math.sin(m.time * TAU * 3);
  p.legRLift += 0.05 * Math.max(0, s) * w;
  p.legLLift += 0.05 * Math.max(0, -s) * w;
  p.legYaw += 0.25 * Math.sign(m.yawRate) * w;
  p.crouch -= 0.03 * w;
}

/** Character idle flavor on top of the breathing bounce (continuous column of §3.7). */
function idleFlavor(p: Pose, m: MotionInfo): void {
  const t = m.time + m.seed;
  switch (m.character) {
    case "quacky":
      // Weight shift + bird head saccades (m.look snaps between holds).
      p.leanZ += 0.04 * Math.sin(t * 0.8);
      p.headY += m.look;
      p.extraY += 0.3 * Math.sin(t * 2.6);
      break;
    case "hopsworth":
      // Low frog crouch; frogs breathe with their throat sac.
      p.crouch -= 0.06;
      p.sac = 0.35 + 0.25 * Math.sin(t * 3.1);
      p.headY += m.look * 0.5;
      break;
    case "mochi":
      // Slow deep breathing and a sleepy sway.
      p.belly += 0.06 * Math.sin(t * TAU * 0.6);
      p.headZ += 0.05 * Math.sin(t * 0.6);
      p.leanZ += 0.03 * Math.sin(t * 0.5);
      p.headY += m.look * 0.4;
      break;
    case "whiskers":
      // Hip-shot lean, smug head tilt and a lazy S-tail swish.
      p.leanZ += 0.06;
      p.headZ += 0.12;
      p.headY -= 0.08;
      p.extraY += 0.55 * Math.sin(t * 1.4);
      p.extraZ += 0.2 * Math.sin(t * 0.9);
      p.tailCurl += 0.25 + 0.2 * Math.sin(t * 1.1);
      break;
    case "pip": {
      // Heel-toe rock side to side, flipper twitches.
      const rock = Math.sin(t * 2.4);
      p.roll += 0.06 * rock;
      p.legRLift += 0.02 * Math.max(0, rock);
      p.legLLift += 0.02 * Math.max(0, -rock);
      p.armRZ += 0.12 * (1 + Math.sin(t * 4.2)) * Math.max(0, Math.sin(t * 0.7)) ** 4;
      p.armLZ += 0.12 * (1 + Math.sin(t * 4.2 + 0.6)) * Math.max(0, Math.sin(t * 0.7 + 1)) ** 4;
      p.headY += m.look * 0.6;
      break;
    }
    case "gruff":
      // Always chewing, head low.
      p.jaw = Math.max(p.jaw, 0.25 + 0.25 * Math.sin(t * TAU * 2.2));
      p.headX += 0.1;
      p.extraX += 0.2 * Math.sin(t * 3.3);
      p.headY += m.look * 0.4;
      break;
  }
}

/** Whiskers' armed curveball: tail curls into a spiral (any grounded state). */
function curveFlavor(p: Pose, m: MotionInfo): void {
  if (m.frame.curveArmed) p.tailCurl += 0.9;
}

/* ============================================================== states */

function idle(p: Pose, m: MotionInfo): void {
  const b = Math.sin(m.idlePhase);
  const hop = Math.max(0, b);
  p.crouch += -0.035 + 0.06 * hop;
  p.lift += 0.015 * hop * hop;
  p.armRZ += 0.06 * b;
  p.armLZ += 0.06 * b;
  p.headX += -0.04 * Math.sin(m.idlePhase - 0.6);
  p.headZ += 0.05 * Math.sin(m.time * 0.7 + m.seed);
  p.ears += 0.08 * Math.sin(m.idlePhase - 1);
  idleFlavor(p, m);
  curveFlavor(p, m);
  lookPitch(p, m, 1);
  turnSteps(p, m);
  locomotion(p, m, 1);
}

function run(p: Pose, m: MotionInfo): void {
  locomotion(p, m, 1);
  armSwing(p, m, 1);
  lookPitch(p, m, 0.6);
  curveFlavor(p, m);
  if (m.character === "hopsworth") p.sac = 0.2;
}

/** Jump and fall share one air pose blended by airU: takeoff → apex → fall (→ long-fall flail). */
function air(p: Pose, m: MotionInfo): void {
  const short = m.jumpCut ? 0.6 : 1;
  const wTake = clamp01(1 - m.airU / 0.35) * (m.frame.vy > 0 ? 1 : 0);
  const wApex = m.apex * (1 - wTake);
  const wFall = clamp01((m.airU - 0.5) / 0.3) * (1 - wApex) * (1 - wTake);
  const flail = smoothstep(LONG_FALL_SEC, LONG_FALL_SEC + 0.2, m.fallSec);
  const winged = WINGED.has(m.character);

  // Takeoff: stretched, one leg back one forward, arms up-back.
  p.crouch += 0.15 * short * wTake;
  p.legRX += -0.4 * wTake;
  p.legLX += 0.5 * wTake;
  p.armRZ += 0.9 * wTake;
  p.armLZ += 0.9 * wTake;
  p.armRX += -0.4 * wTake;
  p.armLX += -0.4 * wTake;
  p.ears -= 0.25 * wTake;
  p.extraX -= 0.3 * wTake;
  p.headX -= 0.12 * wTake;

  // Apex: knees up, arms wide, head up, a tiny hang.
  p.legRX += 0.6 * wApex;
  p.legLX += 0.6 * wApex;
  p.armRZ += 1.2 * wApex;
  p.armLZ += 1.2 * wApex;
  p.headX -= 0.08 * wApex;
  p.lift += 0.02 * wApex;
  p.ears += 0.1 * wApex;

  // Fall: legs reach down, arms high.
  const calm = wFall * (1 - flail);
  p.armRZ += 1.6 * calm;
  p.armLZ += 1.6 * calm;
  p.crouch += 0.06 * calm;
  p.legRZ += 0.06 * calm;
  p.legLZ += 0.06 * calm;
  p.ears += 0.35 * wFall;
  p.extraX += 0.3 * wFall;

  // Long fall: windmill flail.
  if (flail > 0) {
    const t = m.t;
    p.armRZ += (1.4 + 0.3 * Math.sin(t * 14)) * flail;
    p.armLZ += (1.4 - 0.3 * Math.sin(t * 14)) * flail;
    p.armRX += 1.2 * Math.sin(t * 14) * flail;
    p.armLX += 1.2 * Math.sin(t * 14 + Math.PI) * flail;
    p.legRX += 0.5 * Math.sin(t * 11) * flail;
    p.legLX -= 0.5 * Math.sin(t * 11) * flail;
    p.headX -= 0.15 * flail;
    p.crouch += 0.05 * flail;
  }

  // Winged: flap on takeoff (first 0.15 s) and while falling for a while.
  if (winged) {
    const flapW = (m.frame.vy > 0 && m.airSec < 0.15 ? 1 : 0) + clamp01((m.fallSec - 0.2) / 0.1) * (1 - flail);
    if (flapW > 0) {
      const flap = Math.sin(m.airSec * 32);
      p.armRZ += (0.5 + 0.6 * flap) * Math.min(1, flapW);
      p.armLZ += (0.5 + 0.6 * flap) * Math.min(1, flapW);
    }
  }
  curveFlavor(p, m);
}

function charge(p: Pose, m: MotionInfo): void {
  const c = easeOutCubic(m.charge);
  const pitch = m.frame.pitch;
  // Wind-up: throwing arm cocked back and up, upper body turned, other arm aims.
  p.armRX += -1.5 - 0.75 * c - 0.35 * pitch;
  p.armRZ += 0.25 + 0.15 * c;
  p.armRY += 0.3 * c;
  p.armLX += 1.1 + 0.25 * c + 0.3 * pitch;
  p.armLZ += 0.15;
  p.twist += 0.25 + 0.4 * c;
  p.leanX -= 0.06 + 0.08 * c;
  p.crouch -= 0.05 + 0.07 * c;
  p.headY -= 0.25 * c;
  p.extraX -= 0.2 * c;
  p.ears -= 0.15 * c;
  p.bend -= 0.2 * pitch;
  if (m.speed < 0.6) {
    p.legRX -= 0.3;
    p.legLX += 0.22;
    p.legRZ += 0.12;
    p.legLZ += 0.12;
  }
  // Tremble grows with charge and turns into a shake at full charge.
  const shake = 0.012 + 0.05 * c * c + (m.fullCharge ? 0.045 : 0);
  const freq = m.fullCharge ? 34 : 18 + 14 * c;
  p.leanZ += shake * Math.sin(m.t * freq);
  p.headZ += shake * 1.4 * Math.sin(m.t * freq * 1.3 + 1);
  p.crouch += shake * 0.6 * Math.sin(m.t * freq * 0.9 + 2);
  p.armRZ += shake * 2 * Math.sin(m.t * freq * 1.1);

  // Per-animal flavor.
  const full = m.fullCharge ? 1 : 0;
  switch (m.character) {
    case "quacky":
      p.extraY += 0.5 * c * Math.sin(m.t * 9); // tail fan spreads / wags
      p.extraX -= 0.3 * c;
      p.armRZ += 0.08 * c * Math.sin(m.t * 40); // wing tip trembles
      break;
    case "hopsworth":
      p.crouch -= 0.1;
      p.sac = Math.max(p.sac, 0.3 + 0.5 * c);
      break;
    case "mochi":
      // Shot-put: ball tucked by the cheek, body wound up.
      p.twist += 0.2 * c;
      p.armRX += 0.6 * c;
      p.armRZ += 0.35 * c;
      p.headZ -= 0.08 * c;
      break;
    case "whiskers":
      // Lazy one-paw hold, other paw on the hip.
      p.armLX = 0.2;
      p.armLZ = 0.75;
      p.armLY = -0.6;
      p.headZ += 0.1;
      p.tailCurl += 0.4 * c + 0.3 * full * Math.sin(m.t * 12);
      break;
    case "pip":
      if (full) {
        const hop = Math.max(0, Math.sin(m.t * TAU * 3));
        p.lift += 0.06 * hop;
        p.crouch += 0.05 * hop - 0.04;
      }
      break;
    case "gruff":
      if (full) {
        p.legLX += 0.5 * Math.sin(m.t * 9);
        p.legLLift += 0.03 * Math.max(0, Math.sin(m.t * 9));
        p.headX += 0.25;
      }
      break;
  }
  lookPitch(p, m, 1);
  locomotion(p, m, 0.8);
}

function catchReady(p: Pose, m: MotionInfo): void {
  const open = easeOutCubic(m.t / 0.08);
  p.armRX += 1.35 * open;
  p.armLX += 1.35 * open;
  p.armRZ += 0.45 * open;
  p.armLZ += 0.45 * open;
  p.armRY -= 0.4 * open;
  p.armLY -= 0.4 * open;
  p.leanX += 0.1;
  p.crouch -= 0.1;
  p.headX -= 0.06;
  p.ears -= 0.2;
  if (m.speed < 0.6) {
    p.legRZ += 0.22;
    p.legLZ += 0.22;
  }
  lookPitch(p, m, 0.6);
  locomotion(p, m, 0.7);
}

function whiff(p: Pose, m: MotionInfo): void {
  const t = m.t;
  const fade = 1 - clamp01((t - 0.35) / 0.25);
  const flail = 22;
  p.armRX += (1.6 + 1.3 * Math.sin(t * flail)) * fade;
  p.armLX += (1.6 + 1.3 * Math.sin(t * flail + Math.PI)) * fade;
  p.armRZ += 0.6 * fade;
  p.armLZ += 0.6 * fade;
  p.headY += 0.3 * Math.sin(t * 17) * fade;
  p.leanX += 0.22 * bump(t / 0.35) - 0.08 * bump((t - 0.3) / 0.3);
  p.leanZ += 0.08 * Math.sin(t * 9) * fade;
  p.crouch -= 0.06;
  p.ears += 0.3 * fade;
  locomotion(p, m, 0.6);
}

function roll(p: Pose, m: MotionInfo): void {
  const u = clamp01(m.t / ROLL_SEC);
  const tuck = envelope(u, 0.15, 0.25);
  const backward = Math.abs(m.dirTurn) > 2.1;
  p.turn = backward ? m.dirTurn + (m.dirTurn > 0 ? -Math.PI : Math.PI) : m.dirTurn;
  p.pitch = (backward ? -TAU : TAU) * easeInOut(u);
  // Pre-squash before the tuck springs into the roll.
  p.crouch -= 0.3 * tuck + 0.15 * (1 - clamp01(m.t / 0.06));
  p.size -= 0.08 * tuck;
  p.lift += 0.14 * bump(u);
  p.armRX += 1.5 * tuck;
  p.armLX += 1.5 * tuck;
  p.armRZ -= 0.15 * tuck;
  p.armLZ -= 0.15 * tuck;
  p.legRX += 1.3 * tuck;
  p.legLX += 1.3 * tuck;
  p.headX += 0.5 * tuck;
  p.ears -= 0.3 * tuck;
  p.tailCurl += 0.6 * tuck;
}

function stunned(p: Pose, m: MotionInfo): void {
  const f = m.frame;
  p.turn = m.velTurn + Math.PI;
  if (!f.grounded) {
    // Knockback tumble (the Animator adds the flip / twist): starfish limbs, flailing.
    p.armRZ += 1.3 + 0.35 * Math.sin(m.t * 21);
    p.armLZ += 1.3 + 0.35 * Math.sin(m.t * 19 + 1);
    p.armRX += 0.35 * Math.sin(m.t * 17);
    p.armLX += 0.35 * Math.sin(m.t * 15 + 2);
    p.legRZ += 0.4;
    p.legLZ += 0.4;
    p.legRX += 0.35 * Math.sin(m.t * 19);
    p.legLX -= 0.35 * Math.sin(m.t * 19);
    p.ears += 0.5;
    p.crouch += 0.08 + 0.15 * m.launchStretch;
    return;
  }
  const lie = m.lying;
  if (m.tumbleMode === TUMBLE_SPLAT || lie > 0.5) {
    // Splat: flat on the back / front, limbs splayed, sliding with the ground velocity.
    p.lift -= 0.3 * lie;
    p.armRZ += 1.4;
    p.armLZ += 1.4;
    p.legRZ += 0.5;
    p.legLZ += 0.5;
    p.headX += 0.1 * Math.sin(m.t * 6);
    p.headY += 0.2 * Math.sin(m.t * 4.5);
    p.ears += 0.4;
    p.crouch -= 0.08;
    return;
  }
  // Rolled through onto the feet: staggering, dazed, arms out for balance.
  p.lift -= 0.3 * lie;
  p.crouch -= 0.12;
  p.leanX -= 0.12;
  p.leanZ += 0.1 * Math.sin(m.t * 6);
  p.headZ += 0.22 * Math.sin(m.t * 7);
  p.headX += 0.15 * Math.cos(m.t * 7);
  p.armRZ += 0.9 + 0.3 * Math.sin(m.t * 9);
  p.armLZ += 0.9 - 0.3 * Math.sin(m.t * 9);
  p.legRZ += 0.25;
  p.legLZ += 0.25;
  p.ears += 0.3;
}

function flapDash(p: Pose, m: MotionInfo): void {
  const flap = Math.sin(m.t * 40);
  p.turn = m.dirTurn;
  p.pitch = 1.2;
  p.lift += 0.12;
  p.crouch += 0.18;
  p.armRZ += 0.95 + 0.9 * flap;
  p.armLZ += 0.95 + 0.9 * flap;
  p.armRX -= 0.4;
  p.armLX -= 0.4;
  p.legRX -= 0.9;
  p.legLX -= 0.9;
  p.headX -= 0.85;
  p.extraX -= 0.4;
  p.jaw = Math.max(p.jaw, 0.3);
}

function groundPound(p: Pose, m: MotionInfo): void {
  if (m.frame.abilityPhase !== 2) {
    // Rising: launch stretch, then tuck into a ball and front-flip paced by the rise time.
    const stretch = 1 - clamp01(m.t / 0.08);
    const u = clamp01((m.t - 0.04) / POUND_RISE_SEC);
    const tuck = smoothstep(0.02, 0.12, m.t) * (1 - smoothstep(0.85, 1, u));
    p.pitch = TAU * easeOutCubic(u);
    p.crouch += 0.25 * stretch - 0.26 * tuck;
    p.size -= 0.05 * tuck;
    p.lift += 0.1 * tuck;
    p.legRX += 1.35 * tuck;
    p.legLX += 1.35 * tuck;
    p.armRX += 1.4 * tuck + 2.6 * (1 - tuck) * clamp01((u - 0.85) / 0.15);
    p.armLX += 1.4 * tuck + 2.6 * (1 - tuck) * clamp01((u - 0.85) / 0.15);
    p.armRZ -= 0.2 * tuck;
    p.armLZ -= 0.2 * tuck;
    p.headX += 0.4 * tuck;
    p.sac = 0.4;
    return;
  }
  // Slamming: stretched like a missile, legs up, eye bulbs squashed, arms up.
  p.crouch += 0.3;
  p.armRX += 2.9;
  p.armLX += 2.9;
  p.armRZ += 0.25;
  p.armLZ += 0.25;
  p.legRX -= 0.5;
  p.legLX -= 0.5;
  p.legRZ += 0.08;
  p.legLZ += 0.08;
  p.headX += 0.35;
  p.ears += 0.5;
  p.bulbs -= 0.15;
}

function bellyBounce(p: Pose, m: MotionInfo): void {
  const bounce = Math.abs(Math.sin(m.t * Math.PI * 2.4));
  const fade = 1 - smoothstep(BELLY_BOUNCE_SEC - 0.2, BELLY_BOUNCE_SEC, m.t);
  p.belly += (0.4 + 0.07 * Math.sin(m.t * 15)) * fade;
  p.cheeks += 0.3 * fade;
  p.crouch += -0.12 + 0.16 * bounce;
  p.lift += 0.1 * bounce;
  p.armRZ += 1.0 + 0.2 * bounce;
  p.armLZ += 1.0 + 0.2 * bounce;
  p.armRX += 0.3;
  p.armLX += 0.3;
  p.leanX -= 0.14;
  p.headX -= 0.12;
  p.legRZ += 0.2;
  p.legLZ += 0.2;
  p.ears += 0.25 * bounce;
  locomotion(p, m, 0.4);
}

function bellySlide(p: Pose, m: MotionInfo): void {
  const dive = easeOutCubic(m.t / 0.12);
  const wiggle = Math.sin(m.t * 10);
  const kick = Math.sin(m.t * TAU * 8);
  const out = 1 - smoothstep(BELLY_SLIDE_SEC - 0.15, BELLY_SLIDE_SEC, m.t);
  p.turn = m.dirTurn;
  p.pitch = 1.45 * dive * out;
  p.lift += 0.08 * bump(m.t / 0.12) - 0.24 * dive * out;
  p.roll += 0.08 * wiggle * dive;
  // Flippers swept back, feet kicking, head up.
  p.armRZ += 0.35 + 0.15 * wiggle;
  p.armLZ += 0.35 - 0.15 * wiggle;
  p.armRX -= 0.9 * dive;
  p.armLX -= 0.9 * dive;
  p.legRX -= 0.2 - 0.3 * kick;
  p.legLX -= 0.2 + 0.3 * kick;
  p.headX -= 1.05 * dive;
  p.extraX -= 0.4;
  p.extraZ += 0.3 * wiggle;
}

function headbutt(p: Pose, m: MotionInfo): void {
  const gallop = Math.sin(m.t * 32);
  const u = clamp01(m.t / HEADBUTT_SEC);
  p.turn = m.dirTurn;
  p.leanX += 0.42;
  p.fwd += 0.15;
  p.bend += 0.2;
  p.headX += 0.6;
  p.armRX -= 0.9;
  p.armLX -= 0.9;
  p.armRZ += 0.3;
  p.armLZ += 0.3;
  p.legRX += 0.8 * gallop;
  p.legLX -= 0.8 * gallop;
  p.legRLift += 0.04 * Math.max(0, gallop);
  p.legLLift += 0.04 * Math.max(0, -gallop);
  p.crouch += 0.1 + 0.05 * bump(u);
  p.ears -= 0.4;
  p.extraX -= 0.5;
}

function ability(p: Pose, m: MotionInfo): void {
  switch (m.ability) {
    case "flapDash":
      flapDash(p, m);
      return;
    case "groundPound":
      groundPound(p, m);
      return;
    case "bellyBounce":
      bellyBounce(p, m);
      return;
    case "bellySlide":
      bellySlide(p, m);
      return;
    case "headbutt":
      headbutt(p, m);
      return;
    case "curveball":
      idle(p, m);
      return;
  }
}

function ghost(p: Pose, m: MotionInfo): void {
  const t = m.time + m.seed;
  p.lift += 0.12 * Math.sin(t * 2.2);
  p.crouch += 0.04 * Math.sin(t * 2.2 + 0.5);
  p.leanZ += 0.08 * Math.sin(t * 1.3);
  p.leanX += 0.06;
  p.armRZ += 0.8 + 0.2 * Math.sin(t * 2.2 + 1);
  p.armLZ += 0.8 + 0.2 * Math.sin(t * 2.2 + 1.4);
  p.armRX += 0.35 + 0.12 * Math.sin(t * 1.7);
  p.armLX += 0.35 + 0.12 * Math.sin(t * 1.7 + 0.5);
  p.headZ += 0.12 * Math.sin(t * 1.1);
  p.extraY += 0.4 * Math.sin(t * 1.8);
  p.ears += 0.15 * Math.sin(t * 2.2);
}

type StateFn = (p: Pose, m: MotionInfo) => void;

const STATES: Record<PlayerAction, StateFn> = {
  idle,
  run,
  jump: air,
  fall: air,
  charge,
  catch: catchReady,
  whiff,
  roll,
  stunned,
  ability,
  ghost,
};

/** Write the target pose of `action` on top of the rest pose already in `p`. */
export function evaluateState(action: PlayerAction, p: Pose, m: MotionInfo): void {
  STATES[action](p, m);
}

/** Crossfade time into each state (s). `from` is the state being left. */
export function blendTimeFor(action: PlayerAction, from?: PlayerAction): number {
  switch (action) {
    case "roll":
    case "ability":
    case "stunned":
      return 0.06;
    case "catch":
    case "whiff":
      return 0.07;
    case "jump":
      return 0.08;
    case "fall":
      return from === "jump" ? 0.2 : 0.1;
    case "ghost":
      return 0.35;
    default:
      return from === "stunned" ? 0.16 : 0.14;
  }
}

/* =============================================================== faces */

/** Eyes and mouth expression (null = no opinion: neutral face, which blinks). */
export interface FaceParts {
  eyes: FaceExpression | null;
  mouth: FaceExpression | null;
}

function setFace(out: FaceParts, eyes: FaceExpression | null, mouth: FaceExpression | null): void {
  out.eyes = eyes;
  out.mouth = mouth;
}

/** Face for a continuous state (§3.9), written into `out`. */
export function stateExpression(action: PlayerAction, m: MotionInfo, out: FaceParts): FaceParts {
  setFace(out, null, null);
  switch (action) {
    case "ghost":
      setFace(out, "ko", "ko");
      break;
    case "stunned":
      if (m.frame.grounded && m.tumbleMode !== TUMBLE_AIR) setFace(out, "dizzy", "dizzy");
      else setFace(out, "hurt", "hurt");
      break;
    case "whiff":
      setFace(out, m.t < 0.25 ? "dizzy" : "hurt", "hurt");
      break;
    case "charge":
      setFace(out, "charging", "charging");
      break;
    case "catch":
      setFace(out, "angry", "charging");
      break;
    case "roll":
      setFace(out, "blink", null);
      break;
    case "ability":
      abilityExpression(m, out);
      break;
    case "jump":
    case "fall":
      if (m.fallSec > LONG_FALL_SEC) setFace(out, "hurt", "hurt");
      break;
    default:
      break;
  }
  if (out.eyes === null && m.skid > 0.4 && m.frame.grounded) setFace(out, "hurt", "hurt");
  return out;
}

function abilityExpression(m: MotionInfo, out: FaceParts): void {
  switch (m.ability) {
    case "flapDash":
      setFace(out, "charging", null);
      return;
    case "groundPound":
      setFace(out, m.frame.abilityPhase === 2 ? "angry" : "charging", "angry");
      return;
    case "bellyBounce":
      setFace(out, "happy", "happy");
      return;
    case "bellySlide":
      setFace(out, "happy", null);
      return;
    case "headbutt":
      setFace(out, "angry", "angry");
      return;
    case "curveball":
      setFace(out, "charging", null);
      return;
  }
}
