// Deterministic player movement. Owner: sim.
// Runs on the server (authoritative, in GameWorld) and on the client (prediction replay).
// MUST be deterministic: same PlayerSim + InputCmd + SimContext → same result. No Math.random,
// no Date, no reading anything outside its arguments, integer tick timers only.

import {
  CHARGE_FULL_TICKS,
  PLAYER_HEIGHT,
  ROLL_IFRAME_TICKS,
  ROLL_TICKS,
  SLIDE_HEIGHT,
} from "../constants.js";
import type { InputCmd } from "../protocol.js";
import type { CharacterId, HeldPowerUp, PlayerSimFields } from "../types.js";
import type { SimContext } from "./context.js";
import type { Vec3 } from "./math.js";

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

/**
 * Advance one player by one tick. Mutates `p`, returns what happened.
 *
 * Order (each step skipped when it doesn't apply):
 *  0. If !p.alive: return an empty result, change nothing.
 *  1. Count down by 1 (never below 0): rollCooldown, catchCooldown, abilityCooldown, hurtTicks,
 *     throwTicks, zoomiesTicks, stunTicks, whiffTicks.
 *  2. Look: yaw = wrapAngle(input.yaw); pitch = clamp(input.pitch, ±PITCH_LIMIT). Always applied,
 *     even when locked or stunned.
 *  3. If ctx.locked: treat the input as moveX = moveZ = 0 and buttons = 0, and cancel any charge
 *     WITHOUT throwing (chargeTicks = 0). Everything else (timers, active roll/stun, gravity,
 *     deceleration, collisions) continues normally, so knockback arcs still play out.
 *  4. Catch window: if catchTicks > 0 → catchTicks--; reaching 0 → whiffTicks = WHIFF_TICKS,
 *     whiffStarted. (The server clears catchTicks itself on a successful catch, so no whiff.)
 *  5. canAct = stunTicks == 0 && whiffTicks == 0 && rollTicks == 0 && no movement ability running
 *     (flap dash, ground pound, belly slide, headbutt). Edge buttons, in this priority:
 *     - ROLL: canAct && grounded && rollCooldown == 0 → rollTicks = ROLL_TICKS,
 *       rollCooldown = ROLL_COOLDOWN_TICKS, dir = camera-relative move dir (or forward if no move
 *       input), chargeTicks = 0 (keeps the ball), catchTicks = 0. rollStarted.
 *     - ABILITY: canAct && abilityCooldown == 0 → abilityCooldown = CHARACTERS[c].ability.cooldownTicks,
 *       abilityStarted, then per character:
 *         quacky  Flap Dash: abilityTicks = FLAP_DASH_TICKS, dir = move dir or forward. Works mid-air.
 *         hopsworth Ground Pound: grounded or air; vy = GROUND_POUND_LEAP_VY, abilityPhase = 1,
 *                   abilityTicks = GROUND_POUND_MAX_TICKS.
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
 *     catchTicks == 0 && pip isn't sliding:
 *       THROW held → chargeTicks = min(chargeTicks + 1, CHARGE_FULL_TICKS)
 *       THROW released && chargeTicks > 0 → throw: result.throw = { charge, powerUp, curve, yaw,
 *         pitch, origin (computed after movement, step 10) }; heldCount -= 1; chargeTicks = 0;
 *         throwTicks = THROW_RECOVER_TICKS; powerUp = "" ; curveArmed = false.
 *     Otherwise (no ball, or can't act) → chargeTicks = 0 (no throw).
 *  7. Horizontal velocity:
 *     - stunned: no control; grounded → decelerate by STUN_GROUND_DECEL; airborne → keep.
 *     - rolling: v = dir * ROLL_SPEED; rollTicks--.
 *     - flap dash: v = dir * FLAP_DASH_SPEED, vy = 0, no gravity; abilityTicks--; on the last tick
 *       v = dir * FLAP_DASH_END_SPEED, vy = FLAP_DASH_END_VY.
 *     - ground pound phase 1: horizontal air control as normal; when vy <= 0 or rise ticks
 *       (GROUND_POUND_RISE_TICKS) elapsed → phase 2: vx = vz = 0, vy = GROUND_POUND_SLAM_VY.
 *       Phase 2 lands → slamLanded, abilityPhase = 0, abilityTicks = 0. abilityTicks-- each tick;
 *       reaching 0 ends the ability without a slam.
 *     - belly slide: dir turns toward forward(yaw) at most BELLY_SLIDE_TURN_RATE * dt rad per tick;
 *       v = dir * BELLY_SLIDE_SPEED; abilityTicks--. Ends early if airborne for > COYOTE_TICKS.
 *     - headbutt: v = dir * HEADBUTT_SPEED; abilityTicks--. (The server ends it early on a hit by
 *       setting abilityTicks = 0.)
 *     - otherwise: wish = right(yaw) * moveX + forward(yaw) * moveZ, length clamped to 1;
 *       target speed = MOVE_SPEED × (charging ? CHARGE_MOVE_MULT : 1) × (whiff ? WHIFF_MOVE_MULT : 1)
 *       × (zoomiesTicks > 0 ? ZOOMIES_MULT : 1); accelerate horizontal velocity toward wish × speed
 *       by arena.friction.groundAccel (input) or groundDecel (no input) × dt, scaled by AIR_CONTROL
 *       when airborne.
 *     - Mochi's belly bounce does not affect movement.
 *  8. Gravity: vy += GRAVITY * dt (not during flap dash, not in slam phase), vy >= -MAX_FALL_SPEED.
 *  9. Integrate: pos += v * dt. resolveCoverCollision (capsule radius PLAYER_RADIUS, height
 *     playerHeight(p, character)). Ground: g = groundHeightAt(q, x, z, PLAYER_RADIUS * 0.6,
 *     max(yBefore, y)); if y <= g and vy <= 0 → y = g, vy = 0, grounded (landed + landSpeed if it
 *     was airborne). Else grounded = false. Players stand on cover tops. Over a fallen ring /
 *     beyond the edge / once below the island top there is no floor.
 *     airTicks = grounded ? 0 : min(255, airTicks + 1).
 * 10. Compute result.throw.origin = throwOrigin(p) if a throw was released.
 * 11. fellOut = y < RING_OUT_Y.
 *
 * Must NOT: touch hearts/points/balls, pick anything up, apply knockback (the server world does
 * that by writing vx/vy/vz + stunTicks), or allocate per call beyond the result object.
 */
export function stepPlayer(p: PlayerSim, input: InputCmd, ctx: SimContext): StepPlayerResult {
  // TODO(sim): placeholder only applies look so the game runs before the sim is implemented.
  void ctx;
  if (p.alive) {
    p.yaw = input.yaw;
    p.pitch = input.pitch;
  }
  return emptyStepResult();
}

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
