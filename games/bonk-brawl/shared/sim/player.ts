// Deterministic player movement. Owner: sim.
// Runs on the server (authoritative, in GameWorld) and on the client (prediction replay).
// MUST be deterministic: same PlayerSim + InputCmd + SimContext → same result. No Math.random,
// no Date, no reading anything outside its arguments, integer tick timers only.
//
// Hot path: the client replays up to ~30 inputs per state patch, so stepPlayerInto() allocates
// nothing (module scratch below is written and read within one call, never retained). The only
// allocation is the ThrowRequest on the tick a throw is released.

import {
  AIR_CONTROL,
  BELLY_BOUNCE_TICKS,
  BELLY_SLIDE_SPEED,
  BELLY_SLIDE_TICKS,
  BELLY_SLIDE_TURN_RATE,
  CATCH_COOLDOWN_TICKS,
  CATCH_WINDOW_TICKS,
  CHARACTERS,
  CHARGE_FULL_TICKS,
  CHARGE_MOVE_MULT,
  COYOTE_TICKS,
  FLAP_DASH_END_SPEED,
  FLAP_DASH_END_VY,
  FLAP_DASH_SPEED,
  FLAP_DASH_TICKS,
  GRAVITY,
  GROUND_POUND_LEAP_VY,
  GROUND_POUND_MAX_TICKS,
  GROUND_POUND_RISE_TICKS,
  GROUND_POUND_SLAM_VY,
  HEADBUTT_SPEED,
  HEADBUTT_TICKS,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MOVE_SPEED,
  PITCH_LIMIT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RING_OUT_Y,
  ROLL_COOLDOWN_TICKS,
  ROLL_IFRAME_TICKS,
  ROLL_SPEED,
  ROLL_TICKS,
  SLIDE_HEIGHT,
  STUN_GROUND_DECEL,
  THROW_RECOVER_TICKS,
  WHIFF_MOVE_MULT,
  WHIFF_TICKS,
  ZOOMIES_MULT,
} from "../constants.js";
import { BTN, type InputCmd } from "../protocol.js";
import type { CharacterId, HeldPowerUp, PlayerSimFields } from "../types.js";
import type { SimContext } from "./context.js";
import { groundHeightAt, resolveCoverCollision } from "./geometry.js";
import { angleDelta, clamp, vec3, wrapAngle, type Vec3 } from "./math.js";
import { throwOrigin } from "./throw.js";

/** Plain mutable player sim state. PlayerState (schema) is assignable to and from it via copyPlayerSim. */
export type PlayerSim = PlayerSimFields;

/** Every key of PlayerSim, used by copyPlayerSim. Compile-time checked to be complete. */
export const PLAYER_SIM_KEYS = [
  "x",
  "y",
  "z",
  "vx",
  "vy",
  "vz",
  "yaw",
  "pitch",
  "grounded",
  "airTicks",
  "rollTicks",
  "rollCooldown",
  "stunTicks",
  "hurtTicks",
  "catchTicks",
  "catchCooldown",
  "whiffTicks",
  "chargeTicks",
  "throwTicks",
  "abilityTicks",
  "abilityPhase",
  "abilityCooldown",
  "zoomiesTicks",
  "curveArmed",
  "powerUp",
  "heldCount",
  "dirX",
  "dirZ",
  "alive",
] as const satisfies ReadonlyArray<keyof PlayerSimFields>;

type MissingSimKeys = Exclude<keyof PlayerSimFields, (typeof PLAYER_SIM_KEYS)[number]>;
const _allSimKeys: [MissingSimKeys] extends [never] ? true : MissingSimKeys = true;
void _allSimKeys;

/** Fresh sim state at the origin, alive=false, facing -Z, all timers 0. */
export function createPlayerSim(): PlayerSim {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    airTicks: 0,
    rollTicks: 0,
    rollCooldown: 0,
    stunTicks: 0,
    hurtTicks: 0,
    catchTicks: 0,
    catchCooldown: 0,
    whiffTicks: 0,
    chargeTicks: 0,
    throwTicks: 0,
    abilityTicks: 0,
    abilityPhase: 0,
    abilityCooldown: 0,
    zoomiesTicks: 0,
    curveArmed: false,
    powerUp: "",
    heldCount: 0,
    dirX: 0,
    dirZ: -1,
    alive: false,
  };
}

/** Copy every PlayerSim field from `src` to `dst` (schema → plain or plain → schema). Returns dst. */
export function copyPlayerSim<T extends PlayerSimFields>(src: PlayerSimFields, dst: T): T {
  const out = dst as unknown as Record<string, unknown>;
  const from = src as unknown as Record<string, unknown>;
  for (const key of PLAYER_SIM_KEYS) out[key] = from[key];
  return dst;
}

/** A throw released this tick. */
export interface ThrowRequest {
  /** chargeTicks / CHARGE_FULL_TICKS at release, clamped to [0, 1]. A 1-tick tap gives ~0.033. */
  charge: number;
  /** Power-up consumed by this throw ("" none). Already cleared from the player. */
  powerUp: HeldPowerUp;
  /** Curveball (Whiskers' curveArmed was set). Already cleared from the player. */
  curve: boolean;
  /** Aim at release (the player's yaw/pitch after this tick's look update). */
  yaw: number;
  pitch: number;
  /** throwOrigin() of the player AFTER this tick's movement. */
  origin: Vec3;
}

/** What happened during one stepPlayer() call. Consumers on replay (prediction) ignore it. */
export interface StepPlayerResult {
  jumped: boolean;
  /** Became grounded this tick after being airborne. */
  landed: boolean;
  /** -vy at the moment of landing (for squash amount / dust). */
  landSpeed: number;
  rollStarted: boolean;
  catchStarted: boolean;
  /** Catch window expired without a catch this tick (whiffTicks just set). */
  whiffStarted: boolean;
  /** The character ability activated this tick (cooldown just set). */
  abilityStarted: boolean;
  /** Ground Pound slam reached the ground this tick (server spawns the shockwave). */
  slamLanded: boolean;
  throw: ThrowRequest | null;
  /** Feet dropped below RING_OUT_Y this tick (server eliminates; client stops predicting). */
  fellOut: boolean;
}

export function emptyStepResult(): StepPlayerResult {
  return {
    jumped: false,
    landed: false,
    landSpeed: 0,
    rollStarted: false,
    catchStarted: false,
    whiffStarted: false,
    abilityStarted: false,
    slamLanded: false,
    throw: null,
    fellOut: false,
  };
}

/** Reset a result object for reuse (stepPlayerInto does this itself). */
export function resetStepResult(out: StepPlayerResult): StepPlayerResult {
  out.jumped = false;
  out.landed = false;
  out.landSpeed = 0;
  out.rollStarted = false;
  out.catchStarted = false;
  out.whiffStarted = false;
  out.abilityStarted = false;
  out.slamLanded = false;
  out.throw = null;
  out.fellOut = false;
  return out;
}

/* ============================================================ tuning (local) */

/**
 * Horizontal speed a roll, belly slide or headbutt hands over to normal movement when its timer
 * runs out. Without it the 10–13 m/s dash speed would keep sliding the player on (≈2 m extra at
 * default friction), so a "4 m roll" would really be 6 m.
 */
export const DASH_EXIT_SPEED = MOVE_SPEED;
/** Feet support radius on cover tops (slight overhang allowed, TECH_BRIEF / groundHeightAt). */
export const SUPPORT_RADIUS = PLAYER_RADIUS * 0.6;
/** Move input below this length counts as "no input" (decelerate instead of accelerate). */
const MOVE_EPS = 1e-6;

const EXIT_NONE = 0;
const EXIT_CLAMP = 1;
const EXIT_FLAP = 2;

/* ================================================================ scratch */

/** Camera-relative wish direction of this tick (length ≤ 1). */
const wish = { x: 0, z: 0, len: 0 };
/** What the velocity phase decided for the integration phase. */
const motion = { gravity: true, exit: EXIT_NONE };
/** Velocity view handed to resolveCoverCollision (PlayerSim stores it as vx/vy/vz). */
const vel: Vec3 = vec3();
/** Capsule feet handed to resolveCoverCollision. */
const probe: Vec3 = vec3();
/** Horizontal movement sub-steps are capped at this many per tick. */
const MAX_MOVE_SUBSTEPS = 4;

/* ================================================================== step */

/**
 * Advance one player by one tick. Mutates `p`, returns what happened (a fresh result object).
 * Same as stepPlayerInto() with a new result; prefer stepPlayerInto() for replays.
 *
 * Order (each step skipped when it doesn't apply):
 *  0. If !p.alive: return an empty result, change nothing.
 *  1. Count down by 1 (never below 0): rollCooldown, catchCooldown, abilityCooldown, hurtTicks,
 *     throwTicks, zoomiesTicks, stunTicks, whiffTicks; and Mochi's Belly Bounce abilityTicks
 *     (counted here, before activation, so isBouncy() holds for exactly BELLY_BOUNCE_TICKS of the
 *     checks the server runs after stepPlayer). The movement abilities count down in step 7.
 *  2. Look: yaw = wrapAngle(input.yaw); pitch = clamp(input.pitch, ±PITCH_LIMIT). Always applied,
 *     even when locked or stunned. Non-finite look values keep the previous look; non-finite
 *     move axes count as 0 and each axis is clamped to [-1, 1].
 *  3. If ctx.locked: treat the input as moveX = moveZ = 0 and buttons = 0, and cancel any charge
 *     WITHOUT throwing (chargeTicks = 0). Everything else (timers, active roll/stun, gravity,
 *     deceleration, collisions) continues normally, so knockback arcs still play out.
 *  4. Catch window: if catchTicks > 0 → catchTicks--; reaching 0 → whiffTicks = WHIFF_TICKS,
 *     whiffStarted. (The server clears catchTicks itself on a successful catch, so no whiff.)
 *     Stun: while stunTicks > 0 an active roll and any movement ability (flap dash, ground pound,
 *     belly slide, headbutt) are cancelled (rollTicks / abilityTicks / abilityPhase = 0), so a
 *     knocked-back player never resumes a frozen dash afterwards. Belly Bounce keeps running.
 *  5. canAct = stunTicks == 0 && whiffTicks == 0 && rollTicks == 0 && no movement ability running
 *     (flap dash, ground pound, belly slide, headbutt). Edge buttons, in this priority (canAct is
 *     re-evaluated after each, so a roll or movement ability blocks the lower-priority buttons):
 *     - ROLL: canAct && grounded && rollCooldown == 0 → rollTicks = ROLL_TICKS,
 *       rollCooldown = ROLL_COOLDOWN_TICKS, dir = camera-relative move dir (or forward if no move
 *       input), chargeTicks = 0 (keeps the ball), catchTicks = 0. rollStarted.
 *     - ABILITY: canAct && abilityCooldown == 0 → abilityCooldown = CHARACTERS[c].ability.cooldownTicks,
 *       abilityStarted, then per character:
 *         quacky  Flap Dash: abilityTicks = FLAP_DASH_TICKS, dir = move dir or forward. Works mid-air.
 *         hopsworth Ground Pound: grounded or air; vy = GROUND_POUND_LEAP_VY, grounded = false,
 *                   abilityPhase = 1, abilityTicks = GROUND_POUND_MAX_TICKS.
 *         mochi   Belly Bounce: abilityTicks = BELLY_BOUNCE_TICKS (no movement change).
 *         whiskers Curveball: curveArmed = true (abilityTicks stays 0).
 *         pip     Belly Slide: grounded only (else ability doesn't fire, no cooldown);
 *                 abilityTicks = BELLY_SLIDE_TICKS, dir = forward. Cancels charge.
 *         gruff   Headbutt: abilityTicks = HEADBUTT_TICKS, dir = forward. Cancels charge.
 *     - CATCH: canAct && catchCooldown == 0 && catchTicks == 0 → catchTicks = CATCH_WINDOW_TICKS,
 *       catchCooldown = CATCH_COOLDOWN_TICKS, chargeTicks = 0. catchStarted.
 *     - JUMP: canAct && (grounded || airTicks <= COYOTE_TICKS) && vy <= 0 → vy = JUMP_VELOCITY,
 *       grounded = false, airTicks = COYOTE_TICKS + 1. jumped.
 *  6. Charge / throw (THROW is a level bit): if heldCount > 0 && canAct && throwTicks == 0 &&
 *     catchTicks == 0 (canAct already excludes Pip's slide):
 *       THROW held → chargeTicks = min(chargeTicks + 1, CHARGE_FULL_TICKS)
 *       THROW released && chargeTicks > 0 → throw: result.throw = { charge, powerUp, curve, yaw,
 *         pitch, origin (computed after movement, step 10) }; heldCount -= 1; chargeTicks = 0;
 *         throwTicks = THROW_RECOVER_TICKS; powerUp = "" ; curveArmed = false.
 *     Otherwise (no ball, or can't act) → chargeTicks = 0 (no throw).
 *  7. Velocity (first matching case):
 *     - stunned: no control; grounded → decelerate by STUN_GROUND_DECEL; airborne → keep.
 *     - rolling: v = dir * ROLL_SPEED; rollTicks--.
 *     - flap dash: v = dir * FLAP_DASH_SPEED, vy = 0, no gravity; abilityTicks--.
 *     - ground pound phase 1: horizontal air control as normal; abilityTicks--; when vy <= 0 or
 *       GROUND_POUND_RISE_TICKS have elapsed → phase 2. Phase 2: vx = vz = 0,
 *       vy = GROUND_POUND_SLAM_VY, no gravity. Phase 2 lands → slamLanded, abilityPhase = 0,
 *       abilityTicks = 0. abilityTicks reaching 0 ends the ability without a slam.
 *     - belly slide: ends at once (abilityTicks = 0, normal movement this tick) if airborne for
 *       > COYOTE_TICKS; else dir turns toward forward(yaw) at most BELLY_SLIDE_TURN_RATE * dt rad
 *       per tick; v = dir * BELLY_SLIDE_SPEED; abilityTicks--.
 *     - headbutt: v = dir * HEADBUTT_SPEED; abilityTicks--. (The server ends it early on a hit by
 *       setting abilityTicks = 0.)
 *     - otherwise: wish = right(yaw) * moveX + forward(yaw) * moveZ, length clamped to 1;
 *       target speed = MOVE_SPEED × (charging ? CHARGE_MOVE_MULT : 1) × (whiff ? WHIFF_MOVE_MULT : 1)
 *       × (zoomiesTicks > 0 ? ZOOMIES_MULT : 1); move the horizontal velocity toward wish × speed
 *       by at most arena.friction.groundAccel (input) or groundDecel (no input) × dt, scaled by
 *       AIR_CONTROL when airborne.
 *     - Mochi's belly bounce does not affect movement.
 *     Every dash covers exactly its documented distance: all of its ticks move at full dash
 *     speed (speed = distance / duration). The velocity it leaves behind is set right after the
 *     integration of its last tick: flap dash → v = dir * FLAP_DASH_END_SPEED,
 *     vy = FLAP_DASH_END_VY (a little hop, grounded = false); roll / belly slide (timer end) /
 *     headbutt → horizontal speed capped at DASH_EXIT_SPEED.
 *  8. Gravity: vy += GRAVITY * dt (not during flap dash, not in slam phase), vy >= -MAX_FALL_SPEED.
 *  9. Integrate: y += average(vy before, vy after gravity) * dt (exact for constant gravity, so
 *     the jump apex really is JUMP_HEIGHT); x/z += v * dt in sub-steps no longer than
 *     PLAYER_RADIUS with cover resolved between them (fast dashes can't tunnel through candles).
 *     Ground: g = groundHeightAt(q, x, z,
 *     SUPPORT_RADIUS, max(yBefore, y)); if y <= g and vy <= 0 → y = g, vy = 0, grounded (landed +
 *     landSpeed if it was airborne). Else grounded = false. Then resolveCoverCollision (capsule
 *     radius PLAYER_RADIUS, height playerHeight(p, character)) pushes the capsule out of cover
 *     sides; running it after the ground snap means a fast fall onto a cover top lands on it
 *     instead of being shoved off the side. Players stand on cover tops. Over a fallen ring /
 *     beyond the edge / once below the island top there is no floor.
 *     airTicks = grounded ? 0 : min(255, airTicks + 1).
 * 10. Compute result.throw.origin = throwOrigin(p) if a throw was released.
 * 11. fellOut = y < RING_OUT_Y.
 *
 * Must NOT: touch hearts/points/balls, pick anything up, apply knockback (the server world does
 * that by writing vx/vy/vz + stunTicks), or allocate per call beyond the result object.
 */
export function stepPlayer(p: PlayerSim, input: InputCmd, ctx: SimContext): StepPlayerResult {
  return stepPlayerInto(p, input, ctx, emptyStepResult());
}

/**
 * Allocation-free stepPlayer(): resets and fills `out`, returns it. Use one scratch result for
 * prediction replays. Exactly the same simulation as stepPlayer().
 */
export function stepPlayerInto(p: PlayerSim, input: InputCmd, ctx: SimContext, out: StepPlayerResult): StepPlayerResult {
  resetStepResult(out);
  if (!p.alive) return out;

  countDownTimers(p);
  if (ctx.character === "mochi") p.abilityTicks = dec(p.abilityTicks);
  applyLook(p, input);

  const locked = ctx.locked;
  const buttons = locked ? 0 : input.buttons | 0;
  if (locked) p.chargeTicks = 0;
  readWish(p.yaw, locked ? 0 : input.moveX, locked ? 0 : input.moveZ);

  tickCatchWindow(p, out);
  if (p.stunTicks > 0) cancelMovement(p, ctx.character);

  handleEdgeButtons(p, buttons, ctx.character, out);
  handleCharge(p, buttons, ctx.character, out);

  updateVelocity(p, ctx);
  integrate(p, ctx, out);

  if (out.throw) throwOrigin(p, out.throw.origin);
  out.fellOut = p.y < RING_OUT_Y;
  return out;
}

/* ================================================================ queries */

/** Capsule height for hit tests: SLIDE_HEIGHT while Pip belly-slides (abilityTicks > 0), else PLAYER_HEIGHT. */
export function playerHeight(p: PlayerSim, character: CharacterId): number {
  return character === "pip" && p.abilityTicks > 0 ? SLIDE_HEIGHT : PLAYER_HEIGHT;
}

/**
 * Dodge-roll i-frames: the first ROLL_IFRAME_TICKS of a roll, as seen by checks that run AFTER
 * stepPlayer (server hits/headbutts/shockwaves). The start tick sets rollTicks = ROLL_TICKS and the
 * same stepPlayer call already decrements it, so the values seen afterwards are ROLL_TICKS-1 … 0;
 * the first ROLL_IFRAME_TICKS of those are >= ROLL_TICKS - ROLL_IFRAME_TICKS.
 */
export function hasRollIFrames(p: PlayerSim): boolean {
  return p.rollTicks > 0 && p.rollTicks >= ROLL_TICKS - ROLL_IFRAME_TICKS;
}

/** Cannot take ball damage right now (roll i-frames or post-hit mercy). Catch windows are separate. */
export function isInvulnerable(p: PlayerSim): boolean {
  return hasRollIFrames(p) || p.hurtTicks > 0;
}

/** Mochi's Belly Bounce is active. */
export function isBouncy(p: PlayerSim, character: CharacterId): boolean {
  return character === "mochi" && p.abilityTicks > 0;
}

/** Charge fraction 0..1 of the current charge. */
export function chargeFraction(p: PlayerSim): number {
  return Math.min(1, p.chargeTicks / CHARGE_FULL_TICKS);
}

/** A movement ability (flap dash, ground pound, belly slide, headbutt) is running: no other actions. */
export function isMovementAbilityActive(p: PlayerSim, character: CharacterId): boolean {
  return p.abilityTicks > 0 && character !== "mochi" && character !== "whiskers";
}

/** The player may start actions (roll, ability, catch, jump, charge) this tick. */
export function canAct(p: PlayerSim, character: CharacterId): boolean {
  return p.stunTicks === 0 && p.whiffTicks === 0 && p.rollTicks === 0 && !isMovementAbilityActive(p, character);
}

/* ========================================================== step phases */

function dec(ticks: number): number {
  return ticks > 0 ? ticks - 1 : 0;
}

function countDownTimers(p: PlayerSim): void {
  p.rollCooldown = dec(p.rollCooldown);
  p.catchCooldown = dec(p.catchCooldown);
  p.abilityCooldown = dec(p.abilityCooldown);
  p.hurtTicks = dec(p.hurtTicks);
  p.throwTicks = dec(p.throwTicks);
  p.zoomiesTicks = dec(p.zoomiesTicks);
  p.stunTicks = dec(p.stunTicks);
  p.whiffTicks = dec(p.whiffTicks);
}

function applyLook(p: PlayerSim, input: InputCmd): void {
  if (Number.isFinite(input.yaw)) p.yaw = wrapAngle(input.yaw);
  if (Number.isFinite(input.pitch)) p.pitch = clamp(input.pitch, -PITCH_LIMIT, PITCH_LIMIT);
}

function moveAxis(v: number): number {
  return Number.isFinite(v) ? clamp(v, -1, 1) : 0;
}

/** wish = right(yaw) * moveX + forward(yaw) * moveZ, length clamped to 1. */
function readWish(yaw: number, moveX: number, moveZ: number): void {
  const mx = moveAxis(moveX);
  const mz = moveAxis(moveZ);
  const s = Math.sin(yaw);
  const c = Math.cos(yaw);
  let x = c * mx - s * mz;
  let z = -s * mx - c * mz;
  let len = Math.sqrt(x * x + z * z);
  if (len > 1) {
    x /= len;
    z /= len;
    len = 1;
  }
  wish.x = x;
  wish.z = z;
  wish.len = len;
}

/** Lock the dash direction: the move direction (if allowed and present) or the facing. */
function lockDirection(p: PlayerSim, useMove: boolean): void {
  if (useMove && wish.len > MOVE_EPS) {
    p.dirX = wish.x / wish.len;
    p.dirZ = wish.z / wish.len;
  } else {
    p.dirX = -Math.sin(p.yaw);
    p.dirZ = -Math.cos(p.yaw);
  }
}

function tickCatchWindow(p: PlayerSim, out: StepPlayerResult): void {
  if (p.catchTicks <= 0) return;
  p.catchTicks--;
  if (p.catchTicks === 0) {
    p.whiffTicks = WHIFF_TICKS;
    out.whiffStarted = true;
  }
}

function cancelMovement(p: PlayerSim, character: CharacterId): void {
  p.rollTicks = 0;
  if (isMovementAbilityActive(p, character)) {
    p.abilityTicks = 0;
    p.abilityPhase = 0;
  }
}

function pressed(buttons: number, bit: number): boolean {
  return (buttons & bit) !== 0;
}

function handleEdgeButtons(p: PlayerSim, buttons: number, character: CharacterId, out: StepPlayerResult): void {
  if (pressed(buttons, BTN.ROLL) && canAct(p, character) && p.grounded && p.rollCooldown === 0) {
    startRoll(p, out);
  }
  if (pressed(buttons, BTN.ABILITY) && canAct(p, character) && p.abilityCooldown === 0) {
    startAbility(p, character, out);
  }
  if (pressed(buttons, BTN.CATCH) && canAct(p, character) && p.catchCooldown === 0 && p.catchTicks === 0) {
    startCatch(p, out);
  }
  if (
    pressed(buttons, BTN.JUMP) &&
    canAct(p, character) &&
    (p.grounded || p.airTicks <= COYOTE_TICKS) &&
    p.vy <= 0
  ) {
    jump(p, out);
  }
}

function startRoll(p: PlayerSim, out: StepPlayerResult): void {
  p.rollTicks = ROLL_TICKS;
  p.rollCooldown = ROLL_COOLDOWN_TICKS;
  lockDirection(p, true);
  p.chargeTicks = 0;
  p.catchTicks = 0;
  out.rollStarted = true;
}

function startAbility(p: PlayerSim, character: CharacterId, out: StepPlayerResult): void {
  switch (character) {
    case "quacky":
      p.abilityTicks = FLAP_DASH_TICKS;
      lockDirection(p, true);
      break;
    case "hopsworth":
      p.vy = GROUND_POUND_LEAP_VY;
      p.grounded = false;
      p.abilityPhase = 1;
      p.abilityTicks = GROUND_POUND_MAX_TICKS;
      break;
    case "mochi":
      p.abilityTicks = BELLY_BOUNCE_TICKS;
      break;
    case "whiskers":
      p.curveArmed = true;
      break;
    case "pip":
      if (!p.grounded) return;
      p.abilityTicks = BELLY_SLIDE_TICKS;
      lockDirection(p, false);
      p.chargeTicks = 0;
      break;
    case "gruff":
      p.abilityTicks = HEADBUTT_TICKS;
      lockDirection(p, false);
      p.chargeTicks = 0;
      break;
  }
  p.abilityCooldown = CHARACTERS[character].ability.cooldownTicks;
  out.abilityStarted = true;
}

function startCatch(p: PlayerSim, out: StepPlayerResult): void {
  p.catchTicks = CATCH_WINDOW_TICKS;
  p.catchCooldown = CATCH_COOLDOWN_TICKS;
  p.chargeTicks = 0;
  out.catchStarted = true;
}

function jump(p: PlayerSim, out: StepPlayerResult): void {
  p.vy = JUMP_VELOCITY;
  p.grounded = false;
  p.airTicks = COYOTE_TICKS + 1;
  out.jumped = true;
}

function handleCharge(p: PlayerSim, buttons: number, character: CharacterId, out: StepPlayerResult): void {
  const ready = p.heldCount > 0 && canAct(p, character) && p.throwTicks === 0 && p.catchTicks === 0;
  if (!ready) {
    p.chargeTicks = 0;
    return;
  }
  if (pressed(buttons, BTN.THROW)) {
    p.chargeTicks = Math.min(p.chargeTicks + 1, CHARGE_FULL_TICKS);
  } else if (p.chargeTicks > 0) {
    releaseThrow(p, out);
  }
}

function releaseThrow(p: PlayerSim, out: StepPlayerResult): void {
  out.throw = {
    charge: chargeFraction(p),
    powerUp: p.powerUp,
    curve: p.curveArmed,
    yaw: p.yaw,
    pitch: p.pitch,
    origin: vec3(),
  };
  p.heldCount = Math.max(0, p.heldCount - 1);
  p.chargeTicks = 0;
  p.throwTicks = THROW_RECOVER_TICKS;
  p.powerUp = "";
  p.curveArmed = false;
}

/* ============================================================== velocity */

function updateVelocity(p: PlayerSim, ctx: SimContext): void {
  motion.gravity = true;
  motion.exit = EXIT_NONE;
  if (p.stunTicks > 0) {
    if (p.grounded) approachHorizontal(p, 0, 0, STUN_GROUND_DECEL * ctx.dt);
    return;
  }
  if (p.rollTicks > 0) {
    rollVelocity(p);
    return;
  }
  if (isMovementAbilityActive(p, ctx.character)) {
    switch (ctx.character) {
      case "quacky":
        flapDashVelocity(p);
        return;
      case "hopsworth":
        groundPoundVelocity(p, ctx);
        return;
      case "gruff":
        headbuttVelocity(p);
        return;
      case "pip":
        if (bellySlideVelocity(p, ctx.dt)) return;
        break;
    }
  }
  walkVelocity(p, ctx);
}

function setDashVelocity(p: PlayerSim, speed: number): void {
  p.vx = p.dirX * speed;
  p.vz = p.dirZ * speed;
}

function rollVelocity(p: PlayerSim): void {
  setDashVelocity(p, ROLL_SPEED);
  p.rollTicks--;
  if (p.rollTicks === 0) motion.exit = EXIT_CLAMP;
}

function flapDashVelocity(p: PlayerSim): void {
  setDashVelocity(p, FLAP_DASH_SPEED);
  p.vy = 0;
  motion.gravity = false;
  p.abilityTicks--;
  if (p.abilityTicks === 0) motion.exit = EXIT_FLAP;
}

function groundPoundVelocity(p: PlayerSim, ctx: SimContext): void {
  p.abilityTicks--;
  if (p.abilityPhase !== 2) {
    p.abilityPhase = 1;
    walkVelocity(p, ctx);
    const elapsed = GROUND_POUND_MAX_TICKS - p.abilityTicks;
    if (p.vy <= 0 || elapsed >= GROUND_POUND_RISE_TICKS) p.abilityPhase = 2;
  }
  if (p.abilityPhase === 2) {
    p.vx = 0;
    p.vz = 0;
    p.vy = GROUND_POUND_SLAM_VY;
    motion.gravity = false;
  }
}

/** Returns false when the slide just ended (airborne too long): normal movement takes over. */
function bellySlideVelocity(p: PlayerSim, dt: number): boolean {
  if (p.airTicks > COYOTE_TICKS) {
    p.abilityTicks = 0;
    return false;
  }
  turnSlideDirection(p, BELLY_SLIDE_TURN_RATE * dt);
  setDashVelocity(p, BELLY_SLIDE_SPEED);
  p.abilityTicks--;
  if (p.abilityTicks === 0) motion.exit = EXIT_CLAMP;
  return true;
}

/** Rotate dir toward forward(yaw) by at most `maxTurn` radians. */
function turnSlideDirection(p: PlayerSim, maxTurn: number): void {
  const current = Math.atan2(-p.dirX, -p.dirZ);
  const delta = angleDelta(current, p.yaw);
  if (delta === 0) return;
  const heading = current + clamp(delta, -maxTurn, maxTurn);
  p.dirX = -Math.sin(heading);
  p.dirZ = -Math.cos(heading);
}

function headbuttVelocity(p: PlayerSim): void {
  setDashVelocity(p, HEADBUTT_SPEED);
  p.abilityTicks--;
  if (p.abilityTicks === 0) motion.exit = EXIT_CLAMP;
}

function walkVelocity(p: PlayerSim, ctx: SimContext): void {
  const speed =
    MOVE_SPEED *
    (p.chargeTicks > 0 ? CHARGE_MOVE_MULT : 1) *
    (p.whiffTicks > 0 ? WHIFF_MOVE_MULT : 1) *
    (p.zoomiesTicks > 0 ? ZOOMIES_MULT : 1);
  const friction = ctx.arena.friction;
  const hasInput = wish.len > MOVE_EPS;
  const accel = (hasInput ? friction.groundAccel : friction.groundDecel) * (p.grounded ? 1 : AIR_CONTROL);
  approachHorizontal(p, wish.x * speed, wish.z * speed, accel * ctx.dt);
}

/** Move (vx, vz) toward (tx, tz) by at most maxDelta (vector length). */
function approachHorizontal(p: PlayerSim, tx: number, tz: number, maxDelta: number): void {
  const dx = tx - p.vx;
  const dz = tz - p.vz;
  const d = Math.sqrt(dx * dx + dz * dz);
  if (d <= maxDelta) {
    p.vx = tx;
    p.vz = tz;
  } else {
    p.vx += (dx / d) * maxDelta;
    p.vz += (dz / d) * maxDelta;
  }
}

/* ============================================================ integration */

function integrate(p: PlayerSim, ctx: SimContext, out: StepPlayerResult): void {
  const dt = ctx.dt;
  const vyStart = p.vy;
  if (motion.gravity) p.vy = Math.max(p.vy + GRAVITY * dt, -MAX_FALL_SPEED);

  const yBefore = p.y;
  p.y += (vyStart + p.vy) * 0.5 * dt;
  moveHorizontally(p, ctx, Math.max(yBefore, p.y));

  resolveGround(p, ctx, yBefore, out);
  pushOutOfCover(p, ctx, p.y);

  applyDashExit(p);
  if (ctx.character === "hopsworth") finishGroundPound(p, out);
  p.airTicks = p.grounded ? 0 : Math.min(255, p.airTicks + 1);
}

/**
 * x/z += v * dt in sub-steps no longer than the capsule radius, resolving cover between them, so
 * fast motion (a 25 m/s Flap Dash, mega knockback) can't carry the capsule past a thin candle's
 * center and out the far side. Intermediate pushes use the higher of the old/new feet height, so
 * a fast fall onto a cover top still lands on it (the final push runs after the ground snap).
 */
function moveHorizontally(p: PlayerSim, ctx: SimContext, probeY: number): void {
  const dt = ctx.dt;
  const step = Math.sqrt(p.vx * p.vx + p.vz * p.vz) * dt;
  const n = step > PLAYER_RADIUS ? Math.min(MAX_MOVE_SUBSTEPS, Math.ceil(step / PLAYER_RADIUS)) : 1;
  const h = dt / n;
  for (let i = 0; i < n; i++) {
    p.x += p.vx * h;
    p.z += p.vz * h;
    if (i < n - 1) pushOutOfCover(p, ctx, probeY);
  }
}

/** resolveCoverCollision for the capsule with its feet at height `feetY`; slides the velocity. */
function pushOutOfCover(p: PlayerSim, ctx: SimContext, feetY: number): void {
  probe.x = p.x;
  probe.y = feetY;
  probe.z = p.z;
  vel.x = p.vx;
  vel.y = p.vy;
  vel.z = p.vz;
  if (!resolveCoverCollision(ctx.arena, probe, PLAYER_RADIUS, playerHeight(p, ctx.character), vel)) return;
  p.x = probe.x;
  p.z = probe.z;
  p.vx = vel.x;
  p.vz = vel.z;
}

function resolveGround(p: PlayerSim, ctx: SimContext, yBefore: number, out: StepPlayerResult): void {
  const ground = groundHeightAt(ctx, p.x, p.z, SUPPORT_RADIUS, Math.max(yBefore, p.y));
  if (p.y <= ground && p.vy <= 0) {
    if (!p.grounded) {
      out.landed = true;
      out.landSpeed = -p.vy;
    }
    p.y = ground;
    p.vy = 0;
    p.grounded = true;
  } else {
    p.grounded = false;
  }
}

function applyDashExit(p: PlayerSim): void {
  if (motion.exit === EXIT_FLAP) {
    setDashVelocity(p, FLAP_DASH_END_SPEED);
    p.vy = FLAP_DASH_END_VY;
    p.grounded = false;
  } else if (motion.exit === EXIT_CLAMP) {
    const speed = Math.sqrt(p.vx * p.vx + p.vz * p.vz);
    if (speed > DASH_EXIT_SPEED) {
      const k = DASH_EXIT_SPEED / speed;
      p.vx *= k;
      p.vz *= k;
    }
  }
}

function finishGroundPound(p: PlayerSim, out: StepPlayerResult): void {
  if (p.abilityPhase === 0) return;
  if (p.abilityPhase === 2 && p.grounded) {
    out.slamLanded = true;
    p.abilityPhase = 0;
    p.abilityTicks = 0;
  } else if (p.abilityTicks === 0) {
    p.abilityPhase = 0;
  }
}
