// Continuous animation states (one target pose per PlayerAction). Owner: client-characters.

import { JUMP_VELOCITY, MOVE_SPEED, ROLL_TICKS, ticksToSec } from "../../../shared/constants";
import type { AbilityId, CharacterId, PlayerAction } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import { bump, clamp01, easeInOut, easeOutCubic, envelope, type Pose } from "./pose";
import type { FaceExpression } from "./types";

const TAU = Math.PI * 2;
const ROLL_SEC = ticksToSec(ROLL_TICKS);
/** Ground Pound rise time used to pace the tuck flip (the sim slams as soon as vy <= 0). */
const POUND_FLIP_SEC = 0.32;

/** Everything a state needs besides its own pose (filled by the Animator every frame). */
export interface MotionInfo {
  frame: PlayerFrame;
  character: CharacterId;
  ability: AbilityId;
  /** Seconds since this state was entered. */
  t: number;
  /** Animator clock (seconds). */
  time: number;
  /** Horizontal speed (m/s) and its components in the character's frame. */
  speed: number;
  fwdSpeed: number;
  rightSpeed: number;
  /** Gait phase (radians), advanced with speed. */
  runPhase: number;
  /** Idle bounce phase (radians). */
  idlePhase: number;
  /** 0..1 throw charge and whether it is full. */
  charge: number;
  fullCharge: boolean;
  /** Yaw offsets (player-yaw convention) toward the locked move direction and the velocity. */
  dirTurn: number;
  velTurn: number;
  /** Accumulated knockback tumble angle (radians). */
  tumble: number;
  /** Per-animal random phase so crowds don't move in lockstep. */
  seed: number;
}

/** Per-character gait flavor. */
interface Gait {
  /** Leg swing amplitude (rad). */
  stride: number;
  /** Vertical bob (m). */
  bob: number;
  /** Side-to-side waddle (rad of roll). */
  waddle: number;
  /** Arm swing amplitude (rad). */
  armSwing: number;
}

const GAITS: Record<CharacterId, Gait> = {
  quacky: { stride: 0.8, bob: 0.07, waddle: 0.14, armSwing: 0.35 },
  hopsworth: { stride: 0.7, bob: 0.12, waddle: 0.05, armSwing: 1.0 },
  mochi: { stride: 0.75, bob: 0.08, waddle: 0.1, armSwing: 0.95 },
  whiskers: { stride: 0.9, bob: 0.06, waddle: 0.04, armSwing: 1.0 },
  pip: { stride: 0.6, bob: 0.06, waddle: 0.2, armSwing: 0.3 },
  gruff: { stride: 0.85, bob: 0.07, waddle: 0.06, armSwing: 0.95 },
};

const WINGED: ReadonlySet<CharacterId> = new Set<CharacterId>(["quacky", "pip"]);

/* ============================================================ helpers */

/** Locomotion legs, bob and lean scaled by speed. `w` scales the whole effect. */
function locomotion(p: Pose, m: MotionInfo, w: number): void {
  const gait = GAITS[m.character];
  const amp = Math.min(1.4, m.speed / MOVE_SPEED) * w;
  if (amp <= 0.001) return;
  const s = Math.sin(m.runPhase);
  const c = Math.cos(m.runPhase);
  const back = m.fwdSpeed < -0.35 * m.speed;
  const dir = back ? -1 : 1;
  // Legs turn toward sideways movement (backwards: mirror so the stride still reads).
  let moveTurn = Math.atan2(-m.rightSpeed, m.fwdSpeed);
  if (back) moveTurn = moveTurn > 0 ? moveTurn - Math.PI : moveTurn + Math.PI;
  p.legYaw += Math.max(-1, Math.min(1, moveTurn)) * amp * 0.8;

  p.legRX += s * gait.stride * amp * dir;
  p.legLX -= s * gait.stride * amp * dir;
  p.lift += Math.abs(s) * gait.bob * amp;
  p.crouch += (0.05 * Math.abs(s) - 0.05 * Math.abs(c)) * amp;
  p.roll += s * gait.waddle * amp;
  p.leanX += ((0.22 * m.fwdSpeed) / MOVE_SPEED) * w;
  p.leanZ += ((0.12 * m.rightSpeed) / MOVE_SPEED) * w;
  p.twist += s * 0.1 * amp;
  p.headX -= 0.05 * Math.abs(s) * amp;
  p.ears += 0.12 * Math.abs(s) * amp;
  p.extraY += 0.25 * s * amp;
}

/** Arm swing that goes with locomotion (skipped by states that own the arms). */
function armSwing(p: Pose, m: MotionInfo, w: number): void {
  const gait = GAITS[m.character];
  const amp = Math.min(1.4, m.speed / MOVE_SPEED) * w;
  if (amp <= 0.001) return;
  const s = Math.sin(m.runPhase);
  if (WINGED.has(m.character)) {
    p.armRZ += (0.25 + 0.2 * Math.abs(s)) * amp;
    p.armLZ += (0.25 + 0.2 * Math.abs(s)) * amp;
    p.armRX -= 0.2 * amp;
    p.armLX -= 0.2 * amp;
  } else {
    p.armRX -= s * gait.armSwing * amp;
    p.armLX += s * gait.armSwing * amp;
    p.armRZ += 0.15 * amp;
    p.armLZ += 0.15 * amp;
  }
}

/** Head follows the aim pitch a little (looking up / down). */
function lookPitch(p: Pose, m: MotionInfo, w: number): void {
  p.headX -= m.frame.pitch * 0.4 * w;
}

/** Character idle flavor on top of the breathing bounce. */
function idleFlavor(p: Pose, m: MotionInfo): void {
  const t = m.time + m.seed;
  switch (m.character) {
    case "quacky":
      // Occasional wing flutter.
      p.armRZ += 0.25 * Math.max(0, Math.sin(t * 0.9)) ** 8 * (1 + Math.sin(t * 30));
      p.armLZ += 0.25 * Math.max(0, Math.sin(t * 0.9)) ** 8 * (1 + Math.sin(t * 30 + 1));
      p.extraY += 0.3 * Math.sin(t * 2.6);
      break;
    case "hopsworth":
      // Frogs breathe with their throat sac.
      p.sac = 0.35 + 0.25 * Math.sin(t * 3.1);
      break;
    case "mochi":
      p.belly += 0.05 * Math.sin(m.idlePhase);
      p.headZ += 0.05 * Math.sin(t * 0.6);
      break;
    case "whiskers":
      // Smug head tilt and a lazy tail swish.
      p.headZ += 0.12;
      p.headY -= 0.08;
      p.extraY += 0.55 * Math.sin(t * 1.4);
      p.extraZ += 0.2 * Math.sin(t * 0.9);
      break;
    case "pip":
      p.armRZ += 0.12 * (1 + Math.sin(t * 4.2));
      p.armLZ += 0.12 * (1 + Math.sin(t * 4.2 + 0.6));
      break;
    case "gruff":
      p.headX += 0.04 * Math.sin(t * 5.5);
      p.extraX += 0.2 * Math.sin(t * 3.3);
      break;
  }
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
  lookPitch(p, m, 1);
  locomotion(p, m, 1);
}

function run(p: Pose, m: MotionInfo): void {
  locomotion(p, m, 1);
  armSwing(p, m, 1);
  lookPitch(p, m, 0.6);
  if (m.character === "hopsworth") p.sac = 0.2;
}

function jump(p: Pose, m: MotionInfo): void {
  const rise = clamp01(m.frame.vy / JUMP_VELOCITY);
  p.crouch += 0.08 + 0.1 * rise;
  p.headX -= 0.18;
  p.legRX += 0.55;
  p.legLX -= 0.25;
  p.ears -= 0.25;
  p.extraX -= 0.3;
  if (WINGED.has(m.character)) {
    const flap = Math.sin(m.t * 32);
    p.armRZ += 1.0 + 0.45 * flap;
    p.armLZ += 1.0 + 0.45 * flap;
  } else {
    p.armRZ += 1.1;
    p.armLZ += 1.1;
    p.armRX += 0.35;
    p.armLX += 0.35;
  }
  locomotion(p, m, 0.3);
}

function fall(p: Pose, m: MotionInfo): void {
  const flail = Math.sin(m.t * 14 + m.seed);
  p.crouch += 0.06;
  p.headX += 0.12;
  p.armRZ += 1.55 + 0.25 * flail;
  p.armLZ += 1.55 - 0.25 * flail;
  p.armRX += 0.25 * Math.sin(m.t * 11);
  p.armLX -= 0.25 * Math.sin(m.t * 11);
  p.legRX += 0.25 * Math.sin(m.t * 9);
  p.legLX -= 0.25 * Math.sin(m.t * 9);
  p.ears += 0.35;
  p.extraX += 0.3;
}

function charge(p: Pose, m: MotionInfo): void {
  const c = easeOutCubic(m.charge);
  // Wind-up: throwing arm cocked back and up, upper body turned, other arm aims.
  p.armRX += -1.5 - 0.75 * c;
  p.armRZ += 0.25 + 0.15 * c;
  p.armRY += 0.3 * c;
  p.armLX += 1.1 + 0.25 * c;
  p.armLZ += 0.15;
  p.twist += 0.25 + 0.4 * c;
  p.leanX -= 0.06 + 0.08 * c;
  p.crouch -= 0.05 + 0.07 * c;
  p.headY -= 0.25 * c;
  p.extraX -= 0.2 * c;
  p.ears -= 0.15 * c;
  if (m.speed < 0.6) {
    p.legRX -= 0.3;
    p.legLX += 0.22;
    p.legRZ += 0.12;
    p.legLZ += 0.12;
  }
  // Wobble grows with charge and turns into a shake at full charge.
  const shake = 0.012 + 0.05 * c * c + (m.fullCharge ? 0.045 : 0);
  const freq = m.fullCharge ? 34 : 18 + 14 * c;
  p.leanZ += shake * Math.sin(m.t * freq);
  p.headZ += shake * 1.4 * Math.sin(m.t * freq * 1.3 + 1);
  p.crouch += shake * 0.6 * Math.sin(m.t * freq * 0.9 + 2);
  p.armRZ += shake * 2 * Math.sin(m.t * freq * 1.1);
  lookPitch(p, m, 1);
  p.bend -= m.frame.pitch * 0.2;
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
  p.crouch -= 0.3 * tuck;
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
}

function stunned(p: Pose, m: MotionInfo): void {
  const f = m.frame;
  if (!f.grounded) {
    // Knockback tumble: flung backwards, flipping head over heels, limbs everywhere.
    p.turn = m.velTurn + Math.PI;
    p.pitch = -m.tumble;
    p.armRZ += 1.3 + 0.35 * Math.sin(m.t * 21);
    p.armLZ += 1.3 + 0.35 * Math.sin(m.t * 19 + 1);
    p.armRX += 0.5 * Math.sin(m.t * 17);
    p.armLX += 0.5 * Math.sin(m.t * 15 + 2);
    p.legRZ += 0.4;
    p.legLZ += 0.4;
    p.legRX += 0.6 * Math.sin(m.t * 19);
    p.legLX -= 0.6 * Math.sin(m.t * 19);
    p.ears += 0.5;
    p.crouch += 0.08;
    return;
  }
  // Sliding to a stop, dazed: plopped down, head circling.
  p.turn = m.velTurn + Math.PI;
  p.pitch = -m.tumble;
  p.crouch -= 0.16;
  p.lift -= 0.06;
  p.leanX -= 0.18;
  p.headZ += 0.22 * Math.sin(m.t * 7);
  p.headX += 0.15 * Math.cos(m.t * 7);
  p.armRZ += 0.55;
  p.armLZ += 0.55;
  p.legRX += 0.7;
  p.legLX += 0.7;
  p.legRZ += 0.3;
  p.legLZ += 0.3;
  p.ears += 0.3;
}

function flapDash(p: Pose, m: MotionInfo): void {
  const flap = Math.sin(m.t * 40);
  p.turn = m.dirTurn;
  p.pitch = 1.0;
  p.lift += 0.12;
  p.crouch += 0.18;
  p.armRZ += 0.95 + 0.7 * flap;
  p.armLZ += 0.95 + 0.7 * flap;
  p.armRX -= 0.4;
  p.armLX -= 0.4;
  p.legRX -= 0.9;
  p.legLX -= 0.8;
  p.headX -= 0.75;
  p.extraX -= 0.4;
}

function groundPound(p: Pose, m: MotionInfo): void {
  if (m.frame.abilityPhase !== 2) {
    // Rising: tuck into a ball and front-flip.
    const u = clamp01(m.t / POUND_FLIP_SEC);
    p.pitch = TAU * easeOutCubic(u);
    p.crouch -= 0.26;
    p.size -= 0.05;
    p.lift += 0.1;
    p.legRX += 1.35;
    p.legLX += 1.35;
    p.armRX += 1.4;
    p.armLX += 1.4;
    p.armRZ -= 0.2;
    p.armLZ -= 0.2;
    p.headX += 0.4;
    p.sac = 0.4;
    return;
  }
  // Slamming: stretched like a missile, arms up, eyes on the ground.
  p.crouch += 0.3;
  p.armRX += 2.9;
  p.armLX += 2.9;
  p.armRZ += 0.25;
  p.armLZ += 0.25;
  p.legRZ += 0.08;
  p.legLZ += 0.08;
  p.headX += 0.35;
  p.ears += 0.5;
}

function bellyBounce(p: Pose, m: MotionInfo): void {
  const bounce = Math.abs(Math.sin(m.t * 7.5));
  p.belly += 0.4 + 0.07 * Math.sin(m.t * 15);
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
  const wiggle = Math.sin(m.t * 10);
  p.turn = m.dirTurn;
  p.pitch = 1.42;
  p.lift -= 0.24;
  p.roll += 0.08 * wiggle;
  p.armRZ += 0.35 + 0.15 * wiggle;
  p.armLZ += 0.35 - 0.15 * wiggle;
  p.legRX -= 0.2;
  p.legLX -= 0.2;
  p.legRZ += 0.1 * wiggle;
  p.legLZ -= 0.1 * wiggle;
  p.headX -= 1.05;
  p.extraX -= 0.4;
  p.extraZ += 0.3 * wiggle;
}

function headbutt(p: Pose, m: MotionInfo): void {
  const gallop = Math.sin(m.t * 32);
  p.turn = m.dirTurn;
  p.leanX += 0.42;
  p.fwd += 0.12;
  p.bend += 0.2;
  p.headX += 0.6;
  p.armRX -= 0.9;
  p.armLX -= 0.9;
  p.armRZ += 0.3;
  p.armLZ += 0.3;
  p.legRX += 0.8 * gallop;
  p.legLX -= 0.8 * gallop;
  p.crouch += 0.08;
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
  jump,
  fall,
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

/** Crossfade time into each state (s). */
export function blendTimeFor(action: PlayerAction): number {
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
    case "ghost":
      return 0.35;
    default:
      return 0.14;
  }
}

/** Face for a continuous state (null = neutral face, which blinks). */
export function stateExpression(action: PlayerAction, m: MotionInfo): FaceExpression | null {
  switch (action) {
    case "ghost":
      return "ko";
    case "stunned":
      return m.frame.grounded ? "dizzy" : "hurt";
    case "whiff":
      return "hurt";
    case "charge":
      return "charging";
    case "catch":
      return "angry";
    case "roll":
      return "blink";
    case "ability":
      return abilityExpression(m);
    default:
      return null;
  }
}

function abilityExpression(m: MotionInfo): FaceExpression | null {
  switch (m.ability) {
    case "flapDash":
      return "charging";
    case "groundPound":
      return m.frame.abilityPhase === 2 ? "angry" : "charging";
    case "bellyBounce":
    case "bellySlide":
      return "happy";
    case "headbutt":
      return "angry";
    case "curveball":
      return null;
  }
}
