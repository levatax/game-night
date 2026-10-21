// Continuous animation states of a tourist (one target pose per state, derived from the PlayerFrame every
// frame) plus the per-character gait flavor. Owner: client-characters. Adapted from
// games/bonk-brawl/client/src/characters/states.ts (new states: swim, downed crawl, boarded sit, gather /
// revive channels, fishing; no rolls / abilities).

import { CHANNEL, FISH_STATE, JUMP_VELOCITY, SPRINT_SPEED, WALK_SPEED, WATER_Y } from "../../../shared/constants";
import type { CharacterId, InvKind } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { HoldClass } from "./holds";
import { bump, clamp, clamp01, easeOutCubic, type FaceExpression, type Pose } from "./pose";

const TAU = Math.PI * 2;

export type TouristState =
  | "move"
  | "sprint"
  | "air"
  | "swim"
  | "charge"
  | "catch"
  | "stunned"
  | "downed"
  | "boarded"
  | "gather"
  | "revive"
  | "fish";

/** Everything a state needs besides its own pose (filled by the Animator every frame). */
export interface MotionInfo {
  frame: PlayerFrame;
  character: CharacterId;
  /** Seconds since this state was entered; Animator clock. */
  t: number;
  time: number;
  /** Horizontal speed (m/s) and its components in the character's frame. */
  speed: number;
  fwdSpeed: number;
  rightSpeed: number;
  /** Gait phase (radians), advanced with speed; idle breathing phase. */
  runPhase: number;
  idlePhase: number;
  /** 0..1 throw charge, full charge reached. */
  charge: number;
  fullCharge: boolean;
  held: InvKind;
  heldCls: HoldClass | null;
  /** Per-instance random phase so crowds don't move in lockstep. */
  seed: number;
}

/** Per-character gait flavor. */
interface Gait {
  stride: number;
  bob: number;
  waddle: number;
  armSwing: number;
  /** Step frequency multiplier. */
  cadence: number;
}

const GAITS: Record<CharacterId, Gait> = {
  kaptan: { stride: 0.7, bob: 0.05, waddle: 0.05, armSwing: 0.6, cadence: 1 },
  fenomen: { stride: 0.8, bob: 0.075, waddle: 0.08, armSwing: 0.75, cadence: 1.05 },
  amca: { stride: 0.6, bob: 0.05, waddle: 0.15, armSwing: 0.5, cadence: 0.95 },
  // Flippers: big slapping high steps.
  gelin: { stride: 0.95, bob: 0.09, waddle: 0.13, armSwing: 0.55, cadence: 0.9 },
  sef: { stride: 0.7, bob: 0.06, waddle: 0.09, armSwing: 0.65, cadence: 1 },
  cocuk: { stride: 0.95, bob: 0.09, waddle: 0.06, armSwing: 0.95, cadence: 1.25 },
};

export function gaitCadence(character: CharacterId): number {
  return GAITS[character].cadence;
}

/** Continuous state from the frame (priority order: the strongest constraint wins). */
export function deriveState(f: PlayerFrame, held: InvKind): TouristState {
  if (f.boarded) return "boarded";
  if (f.downed) return "downed";
  if (f.swimming) return "swim";
  if (f.stunTicks > 0) return "stunned";
  if (f.channel === CHANNEL.REVIVE) return "revive";
  if (f.channel === CHANNEL.GATHER) return "gather";
  if (f.fishState !== FISH_STATE.NONE && held === "rod") return "fish";
  if (f.catchTicks > 0) return "catch";
  if (f.chargeTicks > 0) return "charge";
  if (!f.grounded && f.airTicks > 3) return "air";
  if (f.sprinting && Math.hypot(f.vx, f.vz) > WALK_SPEED * 1.05) return "sprint";
  return "move";
}

/** States in which the held item / signature prop poses layer on top. */
export function carriesItems(s: TouristState): boolean {
  return s === "move" || s === "sprint" || s === "air" || s === "swim";
}

/* ============================================================ helpers */

/** Locomotion legs, bob and lean scaled by speed. `w` scales the whole effect. */
function locomotion(p: Pose, m: MotionInfo, w: number, ref = WALK_SPEED): void {
  const gait = GAITS[m.character];
  const amp = Math.min(1.4, m.speed / ref) * w;
  if (amp <= 0.001) return;
  const s = Math.sin(m.runPhase);
  const c = Math.cos(m.runPhase);
  const back = m.fwdSpeed < -0.35 * m.speed;
  const dir = back ? -1 : 1;
  let moveTurn = Math.atan2(-m.rightSpeed, m.fwdSpeed);
  if (back) moveTurn = moveTurn > 0 ? moveTurn - Math.PI : moveTurn + Math.PI;
  p.legYaw += clamp(moveTurn, -1, 1) * amp * 0.8;
  p.legRX += s * gait.stride * amp * dir;
  p.legLX -= s * gait.stride * amp * dir;
  if (m.character === "gelin") {
    // Flippers: lift the swinging leg outward so the fins clear the ground.
    p.legRZ += Math.max(0, s) * 0.18 * amp;
    p.legLZ += Math.max(0, -s) * 0.18 * amp;
  }
  p.lift += Math.abs(s) * gait.bob * amp;
  p.crouch += (0.05 * Math.abs(s) - 0.05 * Math.abs(c)) * amp;
  p.roll += s * gait.waddle * amp;
  p.leanX += ((0.16 * m.fwdSpeed) / ref) * w;
  p.leanZ += ((0.1 * m.rightSpeed) / ref) * w;
  p.twist += s * 0.1 * amp;
  p.headX -= 0.04 * Math.abs(s) * amp;
  p.extraX -= 0.15 * amp;
  p.extraZ += 0.12 * s * amp;
}

/** Arm swing that goes with locomotion. */
function armSwing(p: Pose, m: MotionInfo, w: number, ref = WALK_SPEED): void {
  const gait = GAITS[m.character];
  const amp = Math.min(1.4, m.speed / ref) * w;
  if (amp <= 0.001) return;
  const s = Math.sin(m.runPhase);
  p.armRX -= s * gait.armSwing * amp;
  p.armLX += s * gait.armSwing * amp;
  p.armRZ += 0.1 * amp;
  p.armLZ += 0.1 * amp;
}

/** Head follows the look pitch (people see where you look). */
function lookPitch(p: Pose, m: MotionInfo, w: number): void {
  p.headX -= m.frame.pitch * 0.55 * w;
  p.bend -= m.frame.pitch * 0.12 * w;
}

/** Idle flavor per character on top of the breathing bounce. */
function idleFlavor(p: Pose, m: MotionInfo): void {
  const t = m.time + m.seed;
  const still = 1 - clamp01(m.speed / 1.5);
  switch (m.character) {
    case "kaptan":
      // Hands behind the back now and then, chin up: very much in command.
      p.headX -= 0.06 * still;
      p.leanX -= 0.03 * still;
      break;
    case "fenomen":
      // Checking her angles.
      p.headZ += 0.1 * Math.sin(t * 0.8) * still;
      p.headY += 0.12 * Math.sin(t * 0.37) * still;
      break;
    case "amca":
      // Bobbing to his radio.
      p.lift += 0.012 * Math.abs(Math.sin(t * 4.2)) * still;
      p.headZ += 0.07 * Math.sin(t * 2.1) * still;
      break;
    case "gelin":
      p.extraX += 0.08 * Math.sin(t * 1.3);
      p.extraZ += 0.06 * Math.sin(t * 0.9);
      break;
    case "sef":
      p.extraZ += 0.05 * Math.sin(t * 1.7);
      p.headY += 0.08 * Math.sin(t * 0.5) * still;
      break;
    case "cocuk":
      // Can't stand still.
      p.lift += 0.02 * Math.max(0, Math.sin(t * 5.3)) * still;
      p.headZ += 0.09 * Math.sin(t * 1.9) * still;
      break;
  }
}

/* ============================================================== states */

function move(p: Pose, m: MotionInfo): void {
  const b = Math.sin(m.idlePhase);
  p.crouch += -0.025 + 0.045 * Math.max(0, b);
  p.armRZ += 0.05 * b;
  p.armLZ += 0.05 * b;
  p.headZ += 0.04 * Math.sin(m.time * 0.7 + m.seed);
  idleFlavor(p, m);
  lookPitch(p, m, 1);
  locomotion(p, m, 1);
  armSwing(p, m, 1);
}

function sprint(p: Pose, m: MotionInfo): void {
  locomotion(p, m, 1.15, SPRINT_SPEED * 0.85);
  const s = Math.sin(m.runPhase);
  p.leanX += 0.16;
  p.armRX -= s * 1.1;
  p.armLX += s * 1.1;
  p.armRZ += 0.18;
  p.armLZ += 0.18;
  p.headX -= 0.12;
  p.extraX -= 0.3;
  lookPitch(p, m, 0.6);
}

function air(p: Pose, m: MotionInfo): void {
  const f = m.frame;
  if (f.vy > 0) {
    const rise = clamp01(f.vy / JUMP_VELOCITY);
    p.crouch += 0.06 + 0.1 * rise;
    p.legRX += 0.6;
    p.legLX -= 0.2;
    p.armRZ += 1.0;
    p.armLZ += 1.0;
    p.armRX += 0.4;
    p.armLX += 0.4;
    p.headX -= 0.12;
    p.extraX += 0.35;
  } else {
    const flail = Math.sin(m.t * 14 + m.seed);
    p.crouch += 0.05;
    p.armRZ += 1.45 + 0.25 * flail;
    p.armLZ += 1.45 - 0.25 * flail;
    p.armRX += 0.25 * Math.sin(m.t * 11);
    p.armLX -= 0.25 * Math.sin(m.t * 11);
    p.legRX += 0.25 * Math.sin(m.t * 9);
    p.legLX -= 0.25 * Math.sin(m.t * 9);
    p.extraX -= 0.4;
  }
  locomotion(p, m, 0.25);
  lookPitch(p, m, 0.5);
}

/** Head height above the feet in the swim pose (lean 0.45): keeps the face above the water line. */
const SWIM_LEAN = 0.45;

function swim(p: Pose, m: MotionInfo): void {
  const f = m.frame;
  const moving = clamp01(m.speed / 2);
  const kid = m.character === "cocuk";
  const rate = (kid ? 7.5 : 5.5) * (0.55 + 0.45 * moving);
  const ph = m.time * rate + m.seed;
  // Float: lift the body so the head stays above the water (the duck ring floats the kid higher).
  const headUp = 1.4 * Math.cos(SWIM_LEAN);
  const want = (kid ? 0.42 : 0.3) + WATER_Y;
  p.lift += clamp(want - (f.y + headUp), 0, 0.75) + 0.035 * Math.sin(m.time * 2.3 + m.seed);
  p.leanX += SWIM_LEAN * (0.6 + 0.4 * moving);
  p.headX -= SWIM_LEAN * 0.9;
  // Doggy paddle: alternating circles in front.
  p.armRX += 1.35 + 0.45 * Math.sin(ph);
  p.armRZ += 0.25 + 0.22 * Math.cos(ph);
  p.armLX += 1.35 + 0.45 * Math.sin(ph + Math.PI);
  p.armLZ += 0.25 + 0.22 * Math.cos(ph + Math.PI);
  const kick = m.character === "gelin" ? 0.35 * Math.sin(ph * 0.7) : 0.3 * Math.sin(ph * 2);
  p.legRX += kick - 0.2 * moving;
  p.legLX -= kick + 0.2 * moving;
  p.legRZ += 0.1;
  p.legLZ += 0.1;
  p.extraX -= 0.3 * moving;
  p.roll += 0.06 * Math.sin(ph);
}

function charge(p: Pose, m: MotionInfo): void {
  const c = easeOutCubic(m.charge);
  const big = m.heldCls === "big";
  if (big) {
    // Heave a raft part over the head with both arms.
    p.armRX += 2.6 + 0.3 * c;
    p.armLX += 2.6 + 0.3 * c;
    p.armRZ += 0.3;
    p.armLZ += 0.3;
    p.leanX -= 0.1 * c;
    p.crouch -= 0.06 * c;
  } else {
    // Wind-up: throwing arm cocked back and up, upper body turned, the other arm aims.
    p.armRX += -1.5 - 0.75 * c;
    p.armRZ += 0.25 + 0.15 * c;
    p.armRY += 0.3 * c;
    p.armLX += 1.1 + 0.25 * c;
    p.armLZ += 0.15;
    p.twist += 0.25 + 0.4 * c;
    p.leanX -= 0.05 + 0.08 * c;
    p.crouch -= 0.04 + 0.06 * c;
    p.headY -= 0.25 * c;
    p.aim = 1;
  }
  if (m.speed < 0.6) {
    p.legRX -= 0.3;
    p.legLX += 0.22;
    p.legRZ += 0.1;
    p.legLZ += 0.1;
  }
  const shake = 0.01 + 0.04 * c * c + (m.fullCharge ? 0.04 : 0);
  const freq = m.fullCharge ? 34 : 18 + 14 * c;
  p.leanZ += shake * Math.sin(m.t * freq);
  p.headZ += shake * 1.4 * Math.sin(m.t * freq * 1.3 + 1);
  p.armRZ += shake * 2 * Math.sin(m.t * freq * 1.1);
  lookPitch(p, m, 1);
  locomotion(p, m, 0.8);
}

function catchReady(p: Pose, m: MotionInfo): void {
  const open = easeOutCubic(m.t / 0.08);
  p.armRX += 1.35 * open;
  p.armLX += 1.35 * open;
  p.armRZ += 0.4 * open;
  p.armLZ += 0.4 * open;
  p.armRY -= 0.4 * open;
  p.armLY -= 0.4 * open;
  p.leanX += 0.08;
  p.crouch -= 0.08;
  if (m.speed < 0.6) {
    p.legRZ += 0.2;
    p.legLZ += 0.2;
  }
  lookPitch(p, m, 0.7);
  locomotion(p, m, 0.7);
}

function stunned(p: Pose, m: MotionInfo): void {
  const t = m.t;
  p.crouch -= 0.1;
  p.leanX -= 0.1;
  p.headZ += 0.22 * Math.sin(t * 8);
  p.headX += 0.14 * Math.cos(t * 8);
  p.roll += 0.06 * Math.sin(t * 8);
  p.armRZ += 0.7 + 0.2 * Math.sin(t * 13);
  p.armLZ += 0.7 + 0.2 * Math.sin(t * 13 + 1);
  p.armRX += 0.3;
  p.armLX += 0.3;
  p.legRZ += 0.15;
  p.legLZ += 0.15;
}

function downed(p: Pose, m: MotionInfo): void {
  // Lying on the belly, head up, crawling (or waving for help when still).
  const moving = clamp01(m.speed / 0.6);
  const ph = m.runPhase * 0.6;
  p.pitch += 1.38;
  p.lift -= 0.5;
  p.headX -= 1.05;
  p.legRX += -0.15 + 0.25 * Math.sin(ph) * moving;
  p.legLX += -0.15 - 0.25 * Math.sin(ph) * moving;
  p.legRZ += 0.12;
  p.legLZ += 0.12;
  const reachR = Math.max(0, Math.sin(ph));
  const reachL = Math.max(0, -Math.sin(ph));
  p.armRX += 2.55 + 0.35 * reachR * moving;
  p.armLX += 2.55 + 0.35 * reachL * moving;
  p.armRZ += 0.35 - 0.15 * reachR * moving;
  p.armLZ += 0.35 - 0.15 * reachL * moving;
  // Still: the right arm waves "help!" from time to time.
  const wave = (1 - moving) * Math.max(0, Math.sin(m.time * 0.9 + m.seed)) ** 2;
  p.armRZ += wave * (0.9 + 0.45 * Math.sin(m.time * 11));
  p.armRX -= wave * 0.6;
  p.roll += 0.06 * Math.sin(ph) * moving;
  p.fwd += 0.04 * Math.sin(ph) * moving;
}

function boarded(p: Pose, m: MotionInfo): void {
  // Sitting on the raft deck, legs forward, swaying with the waves; a wave goodbye now and then.
  const t = m.time + m.seed;
  p.lift -= 0.36;
  p.leanX -= 0.08 + 0.03 * Math.sin(t * 1.3);
  p.leanZ += 0.04 * Math.sin(t * 0.9);
  p.legRX += 1.45;
  p.legLX += 1.4;
  p.legRZ += 0.1;
  p.legLZ += 0.1;
  p.armRZ += 0.3;
  p.armLZ += 0.3;
  p.armRX += 0.25;
  p.armLX += 0.25;
  const wave = Math.max(0, Math.sin(t * 0.7)) ** 3;
  p.armRX += 2.1 * wave;
  p.armRZ += 0.3 * wave + 0.35 * wave * Math.sin(t * 10);
  lookPitch(p, m, 0.6);
}

function gather(p: Pose, m: MotionInfo): void {
  const t = m.t;
  if (m.held === "axe") {
    // Overhand chop, two per second: up behind the head, down to the trunk in front-right.
    const u = (t * 2) % 1;
    const up = u < 0.55 ? easeOutCubic(u / 0.55) : 1 - easeOutCubic((u - 0.55) / 0.2);
    const swing = clamp01(up);
    p.armRX += 0.6 + 2.0 * swing;
    p.armRZ += 0.15;
    p.armLX += 0.5 + 1.8 * swing;
    p.armLZ += 0.05;
    p.twist -= 0.25 - 0.3 * swing;
    p.bend += 0.2 * (1 - swing);
    p.leanX += 0.06 * (1 - swing);
    p.aim = 0;
  } else {
    // Two-handed tug (vines, bushes, stones): bend in, grab, yank back.
    const tug = Math.max(0, Math.sin(t * TAU * 1.3));
    p.bend += 0.45 - 0.25 * tug;
    p.leanX += 0.1 - 0.18 * tug;
    p.crouch -= 0.08;
    p.armRX += 1.15 - 0.35 * tug;
    p.armLX += 1.15 - 0.35 * tug;
    p.armRZ += 0.05;
    p.armLZ += 0.05;
    p.headX += 0.2;
    p.legRX -= 0.15;
    p.legLX += 0.2;
  }
}

function revive(p: Pose, m: MotionInfo): void {
  // Kneel and pump the chest (CPR, cartoon edition).
  const pump = Math.max(0, Math.sin(m.t * TAU * 1.9));
  p.lift -= 0.3;
  p.crouch -= 0.1;
  p.bend += 0.55 + 0.12 * pump;
  p.legRX += 1.2;
  p.legLX -= 0.4;
  p.armRX += 1.05 - 0.15 * pump;
  p.armLX += 1.05 - 0.15 * pump;
  p.armRZ -= 0.08;
  p.armLZ -= 0.08;
  p.headX += 0.35;
}

function fish(p: Pose, m: MotionInfo): void {
  const fs = m.frame.fishState;
  const t = m.t;
  p.aim = 0.6;
  if (fs === FISH_STATE.BITE) {
    // The bobber dipped: frantic jerks.
    const j = Math.sin(t * 38);
    p.armRX += 1.0 + 0.25 * j;
    p.armLX += 0.9 + 0.2 * j;
    p.armLZ -= 0.15;
    p.leanX += 0.08 + 0.05 * j;
    p.crouch -= 0.08;
  } else if (fs === FISH_STATE.REEL) {
    // Rod up, left hand cranking the reel.
    const crank = t * 14;
    p.armRX += 1.55;
    p.armRZ += 0.1;
    p.armLX += 1.2 + 0.2 * Math.sin(crank);
    p.armLZ -= 0.2 + 0.12 * Math.cos(crank);
    p.leanX -= 0.12;
    p.headX -= 0.15;
  } else {
    // Line out: rod forward, gentle bob, the free hand on the hip.
    p.armRX += 0.85 + 0.05 * Math.sin(m.time * 1.6);
    p.armRZ += 0.1;
    p.armLZ += 0.35;
    p.armLX -= 0.15;
    p.leanX += 0.03;
  }
  lookPitch(p, m, 0.5);
}

type StateFn = (p: Pose, m: MotionInfo) => void;

const STATES: Record<TouristState, StateFn> = {
  move,
  sprint,
  air,
  swim,
  charge,
  catch: catchReady,
  stunned,
  downed,
  boarded,
  gather,
  revive,
  fish,
};

/** Write the target pose of `state` on top of the rest pose already in `p`. */
export function evaluateState(state: TouristState, p: Pose, m: MotionInfo): void {
  STATES[state](p, m);
}

/** Crossfade time into each state (s). */
export function blendTimeFor(state: TouristState): number {
  switch (state) {
    case "charge":
    case "catch":
    case "stunned":
      return 0.07;
    case "air":
      return 0.09;
    case "downed":
    case "boarded":
    case "swim":
      return 0.3;
    default:
      return 0.15;
  }
}

/** Face for a continuous state (null = neutral face, which blinks). */
export function stateFace(state: TouristState, m: MotionInfo): FaceExpression | null {
  switch (state) {
    case "downed":
      return "downed";
    case "stunned":
      return "dizzy";
    case "charge":
      return m.fullCharge ? "effort" : null;
    case "gather":
    case "revive":
      return "effort";
    case "fish":
      return m.frame.fishState === FISH_STATE.BITE ? "panic" : m.frame.fishState === FISH_STATE.REEL ? "happy" : null;
    case "swim":
      return m.speed > 1 ? "effort" : null;
    case "sprint":
      return m.frame.hunger < 20 || m.frame.thirst < 20 ? "tired" : null;
    case "boarded":
      return bump(((m.time + m.seed) * 0.15) % 1) > 0.6 ? "happy" : null;
    default:
      return null;
  }
}
