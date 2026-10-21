// Deterministic first-person player movement. Owner: sim.
// Runs on the server (authoritative, in RaftWorld) and on the client (prediction replay).
// MUST be deterministic: same PlayerSim + InputCmd + SimContext → same result. No Math.random, no Date, no
// reading anything outside its arguments, integer tick timers only. Gameplay math avoids Math.sin/cos where the
// result is stored (yaw → direction uses forwardFromYaw; both sides run the same code on the same doubles, which
// is fine: V8/JSC/SpiderMonkey agree on sin/cos for the same input in practice, and reconciliation corrects
// the rest — only island GENERATION must be strictly trig-free).
//
// Order inside stepPlayer (game4.md §19, Bonk's stepPlayer frame): timers → look → slot edges → channel →
// wish velocity (speed multipliers) → edge actions (jump, catch, eat, interact press, drop/toss) → charge/throw/
// use → velocity (accel/decel/air control/swim) → sub-stepped integrate with terrain step/cliff rule + cover
// push-out + bounds clamp → ground / water (swim, float, swimTicks). The exact rules are on stepPlayer().
//
// Hot path: the client replays up to ~30 inputs per patch, so stepPlayerInto() allocates nothing except the
// ThrowRequest on the tick a throw / toss is released (module scratch below is written and read within one
// call, never retained).

import {
  AIR_CONTROL,
  CATCH_COOLDOWN_TICKS,
  CATCH_WINDOW_TICKS,
  CHANNEL,
  CHARACTERS,
  CHARGE_FULL_TICKS,
  CHARGE_MOVE_MULT,
  COYOTE_TICKS,
  DOWNED_EYE_HEIGHT,
  DOWNED_MOVE_MULT,
  EYE_HEIGHT,
  FREEZING_MOVE_MULT,
  GRAVITY,
  GROUND_ACCEL,
  GROUND_DECEL,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  MAX_WALK_NORMAL_Y,
  PITCH_LIMIT,
  PLAYER_HEIGHT,
  SPRINT_SPEED,
  STARVING_MOVE_MULT,
  STEP_MAX,
  SWIM_BUOYANCY,
  SWIM_DAMPING,
  SWIM_DEPTH,
  SWIM_FLOAT_DEPTH,
  SWIM_SPEED_MULT,
  THROW_RECOVER_TICKS,
  USE_RECOVER_TICKS,
  WALK_SPEED,
  WATER_ACCEL,
  WATER_Y,
} from "../constants.js";
import { heightAt, normalAt } from "../island/heightfield.js";
import type { Heightfield } from "../island/types.js";
import { isThrowable } from "../items.js";
import { BTN, BUTTON_MASK, hasButton, type InputCmd } from "../protocol.js";
import type { CharacterId, InvKind, ItemKind, PlayerSimFields, Vec3Like } from "../types.js";
import type { SimContext } from "./context.js";
import type { CoverCircle } from "./cover.js";
import { clamp, vec3, wrapAngle, type Vec3 } from "./math.js";
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
  "stunTicks",
  "chargeTicks",
  "throwTicks",
  "catchTicks",
  "catchCooldown",
  "channel",
  "channelTicks",
  "channelTarget",
  "swimming",
  "swimTicks",
  "sprinting",
  "activeSlot",
  "inv0",
  "inv1",
  "inv2",
  "inv3",
  "hp",
  "hunger",
  "thirst",
  "warmth",
  "alive",
  "downed",
  "boarded",
] as const satisfies ReadonlyArray<keyof PlayerSimFields>;

type MissingSimKeys = Exclude<keyof PlayerSimFields, (typeof PLAYER_SIM_KEYS)[number]>;
const _allSimKeys: [MissingSimKeys] extends [never] ? true : MissingSimKeys = true;
void _allSimKeys;

/** Fresh sim state at the origin: alive=false, facing -Z, full bars, empty inventory, all timers 0. */
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
    stunTicks: 0,
    chargeTicks: 0,
    throwTicks: 0,
    catchTicks: 0,
    catchCooldown: 0,
    channel: 0,
    channelTicks: 0,
    channelTarget: -1,
    swimming: false,
    swimTicks: 0,
    sprinting: false,
    activeSlot: 0,
    inv0: "",
    inv1: "",
    inv2: "",
    inv3: "",
    hp: 100,
    hunger: 100,
    thirst: 100,
    warmth: 100,
    alive: false,
    downed: false,
    boarded: false,
  };
}

/** Copy every PlayerSim field from `src` to `dst` (schema → plain or plain → schema). Returns dst. */
export function copyPlayerSim<T extends PlayerSimFields>(src: PlayerSimFields, dst: T): T {
  const out = dst as unknown as Record<string, unknown>;
  const from = src as unknown as Record<string, unknown>;
  for (const key of PLAYER_SIM_KEYS) out[key] = from[key];
  return dst;
}

/** Inventory kind in slot 0..3. */
export function invKind(p: PlayerSimFields, slot: number): InvKind {
  return slot === 0 ? p.inv0 : slot === 1 ? p.inv1 : slot === 2 ? p.inv2 : slot === 3 ? p.inv3 : "";
}

/** Kind in the active slot ("" = empty hand). */
export function heldKind(p: PlayerSimFields): InvKind {
  return invKind(p, p.activeSlot);
}

/** Alive, not downed, not aboard: can gather / throw / interact. */
export function canAct(p: PlayerSimFields): boolean {
  return p.alive && !p.downed && !p.boarded;
}

/** chargeTicks / CHARGE_FULL_TICKS clamped to [0, 1]. */
export function chargeFraction(p: PlayerSimFields): number {
  return clamp(p.chargeTicks / CHARGE_FULL_TICKS, 0, 1);
}

/** Capsule radius of a character. */
export function playerRadius(character: CharacterId): number {
  return CHARACTERS[character].radius;
}

/** Camera / eye position (feet + EYE_HEIGHT, or DOWNED_EYE_HEIGHT while downed). */
export function eyePosition(p: { x: number; y: number; z: number; downed: boolean }, out: Vec3 = vec3()): Vec3 {
  out.x = p.x;
  out.y = p.y + (p.downed ? DOWNED_EYE_HEIGHT : EYE_HEIGHT);
  out.z = p.z;
  return out;
}

/** A throw (LMB release of a throwable) or a toss (Q, any item) released this tick. */
export interface ThrowRequest {
  /** Item thrown (one unit of the active slot; the server consumes it). */
  kind: ItemKind;
  /** Active slot it came from. */
  slot: number;
  /** chargeTicks / CHARGE_FULL_TICKS at release in [0, 1]; 0 for a toss. A 1-tick tap gives 1/18. */
  charge: number;
  /** Q toss / pass (fixed TOSS_SPEED, + TOSS_PITCH). */
  toss: boolean;
  /** Aim at release (after this tick's look update). */
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
  /** -vy at the moment of landing (dust / thud). */
  landSpeed: number;
  throw: ThrowRequest | null;
  /**
   * LMB pressed (USE_PRESS) with a non-throwable or an empty hand while throwTicks == 0 (throwTicks is now
   * USE_RECOVER_TICKS): the server resolves palm hit / rod cast / bite strike / torch swing / place structure.
   */
  used: boolean;
  /** EAT edge (F) while able to act: the server eats / drinks the active item if consumable. */
  eat: boolean;
  /** INTERACT_PRESS edge while able to act (or downed: nothing): the server resolves the interaction. */
  interactPressed: boolean;
  catchStarted: boolean;
  /** activeSlot changed this tick. */
  slotChanged: boolean;
  /** channel was cleared this tick because INTERACT was released (or input locked). */
  channelCancelled: boolean;
  enteredWater: boolean;
  leftWater: boolean;
}

export function emptyStepResult(): StepPlayerResult {
  return {
    jumped: false,
    landed: false,
    landSpeed: 0,
    throw: null,
    used: false,
    eat: false,
    interactPressed: false,
    catchStarted: false,
    slotChanged: false,
    channelCancelled: false,
    enteredWater: false,
    leftWater: false,
  };
}

/** Reset a result object for reuse. */
export function resetStepResult(out: StepPlayerResult): StepPlayerResult {
  out.jumped = false;
  out.landed = false;
  out.landSpeed = 0;
  out.throw = null;
  out.used = false;
  out.eat = false;
  out.interactPressed = false;
  out.catchStarted = false;
  out.slotChanged = false;
  out.channelCancelled = false;
  out.enteredWater = false;
  out.leftWater = false;
  return out;
}

/* ============================================================ tuning (local) */

/** Horizontal movement is integrated in sub-steps no longer than this (§5.1), each checked against the terrain. */
export const MOVE_SUBSTEP = 0.25;
/** Sub-steps per tick are capped (8 × 0.25 m = 60 m/s, far above any knockback). */
const MAX_MOVE_SUBSTEPS = 8;
/** Feet support radius on cover tops, as a fraction of the capsule radius (slight overhang allowed). */
export const SUPPORT_RADIUS_FRACTION = 0.6;
/** A grounded player walking downhill sticks to walkable ground up to this far below the feet. */
export const GROUND_SNAP = STEP_MAX;
/**
 * The terrain is also probed this far ahead of the capsule center (× capsule radius) along every move, so the
 * first-person camera stops before a cliff face instead of at it. Only walls are probed there, not steps.
 */
export const WALL_LEAD_FRACTION = 0.6;
/** Move input shorter than this doesn't count as "moving" for sprinting. */
export const SPRINT_MIN_INPUT = 0.1;
/**
 * A swimmer rising faster than this is leaping out of the water (shore climb, knock-up): plain gravity and no
 * water drag apply until the leap is over, instead of the float spring.
 */
export const SWIM_LEAP_VY = 3;
/** Shore climb (JUMP while swimming): the ledge is probed this far ahead along the move (or look) direction. */
export const SHORE_PROBE = 0.9;
/** The ledge may be at most this far above the swimmer's feet (≈ 0.6 m above the water from the float depth). */
export const CLIMB_MAX_RISE = 1.7;
/** The climb leap clears the ledge by this much. */
export const CLIMB_CLEARANCE = 0.35;
/** Horizontal speed toward the ledge given by the climb leap (at least). */
export const CLIMB_FORWARD_SPEED = 3;
/** Capsule height of a crawling (downed) player. */
export const DOWNED_HEIGHT = 0.6;
/** Feet within this of a wall slope are on it (no input up it, see onWallSlope). */
const WALL_CONTACT = 0.05;
/** Cover push-out passes per call (see pushOutOfCover). */
const PUSH_PASSES = 3;
/** Cover overlap below this is "clear" (push-out leaves float dust). */
const PEN_EPS = 1e-6;

const MOVE_EPS = 1e-6;
/** Terrain at most this far above the feet counts as "not rising" (contour walking on a wall is allowed). */
const RISE_EPS = 1e-4;
const COUNTER_MAX = 65535;
const AIR_TICKS_MAX = 255;
/** Feet below this are swimming. */
const SWIM_LINE = WATER_Y - SWIM_DEPTH;
/** Over deep water the swimmer's feet float here. */
const FLOAT_Y = WATER_Y - SWIM_FLOAT_DEPTH;

/* ================================================================ scratch */

/** Camera-relative wish direction of this tick (length ≤ 1). */
const wish = { x: 0, z: 0, len: 0 };
/** Terrain normal scratch (normalAt). */
const nrm: Vec3Like = { x: 0, y: 1, z: 0 };
/** Unit horizontal uphill direction of a blocking slope (contour slide). */
const uphill = { x: 0, z: 0 };
/** Cover query results (grown by CoverQuery.query when needed). */
const coverHits: CoverCircle[] = [];
/** What resolveGround decided about landing (reported after the water state is known). */
const landing = { landed: false, speed: 0 };

/* ================================================================== step */

/**
 * Advance one player by one tick. Mutates `p`, returns what happened (a fresh result object).
 * Same as stepPlayerInto() with a new result; prefer stepPlayerInto() for replays.
 *
 * Rules (each skipped when it doesn't apply):
 *  0. !p.alive: nothing changes, empty result.
 *  1. Timers count down by 1 (never below 0): stunTicks, throwTicks, catchTicks, catchCooldown.
 *  2. Look: yaw = wrapAngle(input.yaw), pitch = clamp(input.pitch, ±PITCH_LIMIT); always applied (locked,
 *     stunned, downed, boarded too). Non-finite look values keep the previous look; non-finite move axes count
 *     as 0 and each axis is clamped to [-1, 1] (length clamped to 1).
 *  3. ctx.locked: move input = 0 and buttons = 0; a running charge is cancelled without a throw.
 *  4. Slot edges (canAct): SLOT1–4 select, SLOT_NEXT / SLOT_PREV cycle (mod 4); a change cancels the charge,
 *     slotChanged.
 *  5. Channel (server-set): while canAct and INTERACT is held, channelTicks counts up (saturating); otherwise
 *     channel / channelTicks / channelTarget are cleared at once, channelCancelled.
 *  6. Edge actions, "free" = canAct && no channel && stunTicks == 0:
 *     JUMP (free): on land when grounded or within COYOTE_TICKS of leaving the ground and vy <= 0 → vy =
 *       JUMP_VELOCITY, airTicks = COYOTE_TICKS + 1, jumped. Swimming: no jump, but when the terrain
 *       SHORE_PROBE ahead (move direction, else look) is wadeable and at most CLIMB_MAX_RISE above the feet, a
 *       leap that clears it by CLIMB_CLEARANCE with ≥ CLIMB_FORWARD_SPEED toward it (jumped).
 *     CATCH (free, catchCooldown == 0, no open window): catchTicks = CATCH_WINDOW_TICKS, catchCooldown =
 *       CATCH_COOLDOWN_TICKS, charge cancelled, catchStarted.
 *     EAT (canAct, no channel): eat. INTERACT_PRESS (canAct, even while channeling): interactPressed.
 *     DROP (free, throwTicks == 0, something in the active slot): toss request (charge 0, toss), charge
 *       cancelled, throwTicks = THROW_RECOVER_TICKS.
 *  7. Charge / throw / use (free, not after a toss this tick; otherwise the charge is cancelled):
 *     throwable active item, throwTicks == 0, no catch window: THROW held → chargeTicks++ (cap
 *     CHARGE_FULL_TICKS); THROW released with chargeTicks > 0 → throw request (charge = chargeTicks /
 *     CHARGE_FULL_TICKS), chargeTicks = 0, throwTicks = THROW_RECOVER_TICKS. A charge whose item stopped being
 *     throwable (server changed the slot) is cancelled. Non-throwable / empty hand + USE_PRESS with
 *     throwTicks == 0 → used, throwTicks = USE_RECOVER_TICKS.
 *     sprinting = free && moving && !swimming && SPRINT held && not charging.
 *  8. Boarded: velocity 0, position untouched (the server seats it), grounded, not swimming. Done.
 *  9. Velocity: stunned → no control (decelerate on the ground / in the water, keep momentum in the air);
 *     channeling on the ground / in the water → horizontal velocity 0; leaping out of the water → keep;
 *     otherwise approach wish × speed with GROUND_ACCEL (input) / GROUND_DECEL (none) on the ground,
 *     WATER_ACCEL while swimming, × AIR_CONTROL in the air. Feet on a wall slope: input only steers along the
 *     contour, never up it, and doesn't brake the slide. speed = WALK_SPEED or SPRINT_SPEED × charge
 *     CHARGE_MOVE_MULT × starving (hunger or thirst 0) STARVING_MOVE_MULT × freezing FREEZING_MOVE_MULT ×
 *     downed DOWNED_MOVE_MULT × swimming SWIM_SPEED_MULT · swimMult.
 * 10. Vertical: feet below the swim line (and not leaping): damped spring toward the float depth
 *     (SWIM_BUOYANCY, SWIM_DAMPING) instead of gravity; else gravity; vy ≥ -MAX_FALL_SPEED; y += average vy·dt
 *     (exact parabola, so the jump apex really is JUMP_HEIGHT).
 * 11. Horizontal: x/z += v·dt in sub-steps ≤ MOVE_SUBSTEP. A sub-step is rejected when the terrain at its end
 *     rises more than STEP_MAX above the feet, or rises at all and is steeper than MAX_WALK_NORMAL_Y (a wall;
 *     also probed WALL_LEAD_FRACTION·radius ahead). A rejected sub-step slides along the contour of the
 *     blocking slope (the move projected onto the perpendicular of its gradient, retried once); on the ground
 *     the uphill part of the velocity is removed. Then the capsule (character radius, playerHeight) is pushed
 *     out of every cover circle it overlaps whose top is above feet + STEP_MAX (lower cover is stepped onto)
 *     and whose bottom is below its head, removing the velocity into the circle (up to 3 passes; a push never
 *     lifts more than STEP_MAX). A sub-step that ends deeper in cover than it started (a gap narrower than the
 *     capsule) is undone. Positions clamp to ctx.bounds (outward velocity removed).
 * 12. Ground: support = max(terrain, highest cover top ≤ feet + STEP_MAX under the feet). Feet at or below it:
 *     rising (vy > 0) → lifted onto it, still airborne; a wall slope → slides down it (not grounded);
 *     otherwise grounded (landed + landSpeed when it was airborne and isn't swimming). Feet above it: a
 *     grounded player that didn't jump snaps down onto walkable ground up to GROUND_SNAP below (not below the
 *     float depth), else airborne. A final cover push and bounds clamp follow; the feet never end below the
 *     terrain.
 * 13. Water: swimming = feet below WATER_Y − SWIM_DEPTH (enteredWater / leftWater on change); swimTicks
 *     counts up while swimming (saturating), else 0. airTicks = grounded ? 0 : airTicks + 1 (cap 255).
 * 14. A released throw / toss gets origin = throwOrigin(p) after the movement.
 *
 * Must NOT touch the inventory, bars, alive / downed / boarded, or pick anything up (the server does that).
 */
export function stepPlayer(p: PlayerSim, input: InputCmd, ctx: SimContext): StepPlayerResult {
  return stepPlayerInto(p, input, ctx, emptyStepResult());
}

/** Advance one tick, writing what happened into `out` (reset first). Returns `out`. */
export function stepPlayerInto(p: PlayerSim, input: InputCmd, ctx: SimContext, out: StepPlayerResult): StepPlayerResult {
  resetStepResult(out);
  if (!p.alive) return out;

  countDownTimers(p);
  applyLook(p, input);

  const locked = ctx.locked;
  const buttons = locked ? 0 : (input.buttons | 0) & BUTTON_MASK;
  if (locked) p.chargeTicks = 0;
  const act = canAct(p);

  handleSlots(p, buttons, act, out);
  handleChannel(p, buttons, act, out);
  const channeling = p.channel !== CHANNEL.NONE;
  const still = locked || p.boarded;
  readWish(p.yaw, still ? 0 : input.moveX, still ? 0 : input.moveZ);

  const free = act && !channeling && p.stunTicks === 0;
  handleEdges(p, buttons, act, channeling, free, ctx, out);
  handleCharge(p, buttons, free, out);
  p.sprinting = free && wish.len > SPRINT_MIN_INPUT && !p.swimming && hasButton(buttons, BTN.SPRINT) && p.chargeTicks === 0;

  if (p.boarded) {
    holdOnRaft(p, out);
  } else {
    updateVelocity(p, ctx, channeling);
    integrate(p, ctx, out);
  }

  if (out.throw) throwOrigin(p, out.throw.origin);
  return out;
}

/** Player capsule height (for hit tests): crawling players are short. */
export function playerHeight(p: { downed: boolean }): number {
  return p.downed ? DOWNED_HEIGHT : PLAYER_HEIGHT;
}

/**
 * The terrain rule of stepPlayer for one horizontal move ending at (x, z), heading (dirX, dirZ) (unit, or 0),
 * with the feet at `feetY`: false when the terrain there rises more than STEP_MAX above the feet, or rises and
 * is a wall (normal.y < MAX_WALK_NORMAL_Y), or a rising wall starts `lead` meters further along the heading.
 * Bots and monsters may probe with it to see the island exactly like a walking player does.
 */
export function canStepTo(hf: Heightfield, x: number, z: number, dirX: number, dirZ: number, feetY: number, lead = 0): boolean {
  const rise = heightAt(hf, x, z) - feetY;
  if (rise > RISE_EPS) {
    if (rise > STEP_MAX) return false;
    if (normalAt(hf, x, z, nrm).y < MAX_WALK_NORMAL_Y) return false;
  }
  if (lead > 0) {
    const lx = x + dirX * lead;
    const lz = z + dirZ * lead;
    if (heightAt(hf, lx, lz) - feetY > RISE_EPS && normalAt(hf, lx, lz, nrm).y < MAX_WALK_NORMAL_Y) return false;
  }
  return true;
}

/* ========================================================== step phases */

function dec(ticks: number): number {
  return ticks > 0 ? ticks - 1 : 0;
}

function countDownTimers(p: PlayerSim): void {
  p.stunTicks = dec(p.stunTicks);
  p.throwTicks = dec(p.throwTicks);
  p.catchTicks = dec(p.catchTicks);
  p.catchCooldown = dec(p.catchCooldown);
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
  // forward = (-sin, -cos), right = (cos, -sin)
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

function handleSlots(p: PlayerSim, buttons: number, act: boolean, out: StepPlayerResult): void {
  if (!act) return;
  const prev = p.activeSlot;
  if (hasButton(buttons, BTN.SLOT1)) p.activeSlot = 0;
  else if (hasButton(buttons, BTN.SLOT2)) p.activeSlot = 1;
  else if (hasButton(buttons, BTN.SLOT3)) p.activeSlot = 2;
  else if (hasButton(buttons, BTN.SLOT4)) p.activeSlot = 3;
  else if (hasButton(buttons, BTN.SLOT_NEXT)) p.activeSlot = (p.activeSlot + 1) % 4;
  else if (hasButton(buttons, BTN.SLOT_PREV)) p.activeSlot = (p.activeSlot + 3) % 4;
  if (p.activeSlot !== prev) {
    out.slotChanged = true;
    p.chargeTicks = 0;
  }
}

function handleChannel(p: PlayerSim, buttons: number, act: boolean, out: StepPlayerResult): void {
  if (p.channel === CHANNEL.NONE) return;
  if (act && hasButton(buttons, BTN.INTERACT)) {
    if (p.channelTicks < COUNTER_MAX) p.channelTicks++;
    return;
  }
  p.channel = CHANNEL.NONE;
  p.channelTicks = 0;
  p.channelTarget = -1;
  out.channelCancelled = true;
}

function handleEdges(
  p: PlayerSim,
  buttons: number,
  act: boolean,
  channeling: boolean,
  free: boolean,
  ctx: SimContext,
  out: StepPlayerResult,
): void {
  if (free && hasButton(buttons, BTN.JUMP)) {
    if (p.swimming) climbOut(p, ctx, out);
    else if ((p.grounded || p.airTicks <= COYOTE_TICKS) && p.vy <= 0) jump(p, out);
  }
  if (free && hasButton(buttons, BTN.CATCH) && p.catchCooldown === 0 && p.catchTicks === 0) {
    p.catchTicks = CATCH_WINDOW_TICKS;
    p.catchCooldown = CATCH_COOLDOWN_TICKS;
    p.chargeTicks = 0;
    out.catchStarted = true;
  }
  if (act && !channeling && hasButton(buttons, BTN.EAT)) out.eat = true;
  if (act && hasButton(buttons, BTN.INTERACT_PRESS)) out.interactPressed = true;
  if (free && hasButton(buttons, BTN.DROP) && p.throwTicks === 0) {
    const held = heldKind(p);
    if (held !== "") {
      out.throw = { kind: held, slot: p.activeSlot, charge: 0, toss: true, yaw: p.yaw, pitch: p.pitch, origin: vec3() };
      p.chargeTicks = 0;
      p.throwTicks = THROW_RECOVER_TICKS;
    }
  }
}

function jump(p: PlayerSim, out: StepPlayerResult): void {
  p.vy = JUMP_VELOCITY;
  p.grounded = false;
  p.airTicks = COYOTE_TICKS + 1;
  out.jumped = true;
}

/** JUMP while swimming: leap onto a ledge just ahead (none in open water or at a tall wall). */
function climbOut(p: PlayerSim, ctx: SimContext, out: StepPlayerResult): void {
  let dx: number;
  let dz: number;
  if (wish.len > MOVE_EPS) {
    dx = wish.x / wish.len;
    dz = wish.z / wish.len;
  } else {
    dx = -Math.sin(p.yaw);
    dz = -Math.cos(p.yaw);
  }
  const ledge = heightAt(ctx.terrain, p.x + dx * SHORE_PROBE, p.z + dz * SHORE_PROBE);
  if (ledge < SWIM_LINE) return;
  const rise = ledge - p.y;
  if (rise > CLIMB_MAX_RISE) return;
  p.vy = Math.sqrt(2 * -GRAVITY * ((rise > 0 ? rise : 0) + CLIMB_CLEARANCE));
  const along = p.vx * dx + p.vz * dz;
  if (along < CLIMB_FORWARD_SPEED) {
    p.vx += dx * (CLIMB_FORWARD_SPEED - along);
    p.vz += dz * (CLIMB_FORWARD_SPEED - along);
  }
  p.grounded = false;
  p.airTicks = COYOTE_TICKS + 1;
  out.jumped = true;
}

function handleCharge(p: PlayerSim, buttons: number, free: boolean, out: StepPlayerResult): void {
  if (out.throw) return; // tossed this tick (the toss already cancelled the charge)
  if (!free) {
    p.chargeTicks = 0;
    return;
  }
  const held = heldKind(p);
  const throwable = isThrowable(held);
  if (throwable && p.throwTicks === 0 && p.catchTicks === 0) {
    if (hasButton(buttons, BTN.THROW)) {
      if (p.chargeTicks < CHARGE_FULL_TICKS) p.chargeTicks++;
    } else if (p.chargeTicks > 0) {
      out.throw = {
        kind: held as ItemKind,
        slot: p.activeSlot,
        charge: chargeFraction(p),
        toss: false,
        yaw: p.yaw,
        pitch: p.pitch,
        origin: vec3(),
      };
      p.chargeTicks = 0;
      p.throwTicks = THROW_RECOVER_TICKS;
    }
  } else {
    p.chargeTicks = 0;
  }
  if (!throwable && hasButton(buttons, BTN.USE_PRESS) && p.throwTicks === 0) {
    out.used = true;
    p.throwTicks = USE_RECOVER_TICKS;
  }
}

function holdOnRaft(p: PlayerSim, out: StepPlayerResult): void {
  p.vx = 0;
  p.vy = 0;
  p.vz = 0;
  p.grounded = true;
  p.airTicks = 0;
  if (p.swimming) {
    p.swimming = false;
    out.leftWater = true;
  }
  p.swimTicks = 0;
}

/* ============================================================== velocity */

/** Walk / sprint speed with every multiplier of §5.1 (0 while stunned, channeling or boarded). */
function targetSpeed(p: PlayerSim, character: CharacterId, channeling: boolean): number {
  if (p.stunTicks > 0 || channeling || p.boarded) return 0;
  let speed = p.sprinting ? SPRINT_SPEED : WALK_SPEED;
  if (p.chargeTicks > 0) speed *= CHARGE_MOVE_MULT;
  if (p.hunger <= 0 || p.thirst <= 0) speed *= STARVING_MOVE_MULT;
  if (p.warmth <= 0) speed *= FREEZING_MOVE_MULT;
  if (p.downed) speed *= DOWNED_MOVE_MULT;
  if (p.swimming) speed *= SWIM_SPEED_MULT * CHARACTERS[character].swimMult;
  return speed;
}

function updateVelocity(p: PlayerSim, ctx: SimContext, channeling: boolean): void {
  const dt = ctx.dt;
  const leaping = p.swimming && p.vy > SWIM_LEAP_VY;
  if (p.stunTicks > 0) {
    if (p.swimming && !leaping) approachHorizontal(p, 0, 0, WATER_ACCEL * dt);
    else if (p.grounded) approachHorizontal(p, 0, 0, GROUND_DECEL * dt);
    return;
  }
  if (leaping) return;
  if (channeling && (p.grounded || p.swimming)) {
    p.vx = 0;
    p.vz = 0;
    return;
  }
  const speed = targetSpeed(p, ctx.character, channeling);
  const hasInput = wish.len > MOVE_EPS && speed > 0;
  let accel: number;
  if (p.swimming) accel = WATER_ACCEL;
  else if (p.grounded) accel = hasInput ? GROUND_ACCEL : GROUND_DECEL;
  else accel = (hasInput ? GROUND_ACCEL : GROUND_DECEL) * AIR_CONTROL;
  let tx = wish.x * speed;
  let tz = wish.z * speed;
  if (onWallSlope(p, ctx.terrain)) {
    // Feet on a wall slope: input only steers along the contour (or faster down); it can neither push up the
    // slope nor brake the slide resolveGround started.
    const gx = uphill.x;
    const gz = uphill.z;
    let vu = p.vx * gx + p.vz * gz;
    if (vu > 0) {
      p.vx -= gx * vu;
      p.vz -= gz * vu;
      vu = 0;
    }
    const up = tx * gx + tz * gz;
    const keep = up < vu ? up : vu;
    tx += gx * (keep - up);
    tz += gz * (keep - up);
  }
  approachHorizontal(p, tx, tz, accel * dt);
}

/** Airborne feet touching a wall slope (uphill direction in `uphill`). */
function onWallSlope(p: PlayerSim, hf: Heightfield): boolean {
  if (p.grounded || p.swimming) return false;
  if (p.y - heightAt(hf, p.x, p.z) > WALL_CONTACT) return false;
  if (normalAt(hf, p.x, p.z, nrm).y >= MAX_WALK_NORMAL_Y) return false;
  return uphillAt(hf, p.x, p.z);
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
  const wasGrounded = p.grounded;
  const wasSwimming = p.swimming;
  const yBefore = p.y;

  // Vertical: float spring in the water, gravity otherwise; average velocity (exact for constant gravity).
  const vyStart = p.vy;
  if (p.y < SWIM_LINE && p.vy <= SWIM_LEAP_VY) p.vy += (SWIM_BUOYANCY * (FLOAT_Y - p.y) - SWIM_DAMPING * p.vy) * dt;
  else p.vy += GRAVITY * dt;
  if (p.vy < -MAX_FALL_SPEED) p.vy = -MAX_FALL_SPEED;
  p.y += (vyStart + p.vy) * 0.5 * dt;

  // Horizontal sub-steps against the terrain, cover and bounds.
  const radius = playerRadius(ctx.character);
  const height = playerHeight(p);
  const lead = radius * WALL_LEAD_FRACTION;
  const follow = wasGrounded && !out.jumped;
  let ref = yBefore > p.y ? yBefore : p.y;
  const dist = Math.sqrt(p.vx * p.vx + p.vz * p.vz) * dt;
  const n = dist > MOVE_SUBSTEP ? Math.min(MAX_MOVE_SUBSTEPS, Math.ceil(dist / MOVE_SUBSTEP)) : 1;
  const h = dt / n;
  let pen = coverPenetration(p, ctx, ref, radius, height);
  for (let i = 0; i < n; i++) {
    const sx = p.x;
    const sz = p.z;
    tryMove(p, ctx.terrain, p.vx * h, p.vz * h, ref, wasGrounded, lead);
    pushOutOfCover(p, ctx, ref, radius, height);
    clampToBounds(p, ctx);
    pen = keepIfNotDeeper(p, ctx, ref, radius, height, sx, sz, pen);
    if (follow) {
      // Walking feet follow the ground up a slope, so the step rule measures each sub-step, not the whole tick.
      const g = heightAt(ctx.terrain, p.x, p.z);
      if (g > ref) ref = g;
    }
  }

  resolveGround(p, ctx, ref, wasGrounded, out.jumped, radius);
  const fx = p.x;
  const fz = p.z;
  const finalPen = coverPenetration(p, ctx, p.y, radius, height);
  pushOutOfCover(p, ctx, p.y, radius, height);
  clampToBounds(p, ctx);
  keepIfNotDeeper(p, ctx, p.y, radius, height, fx, fz, finalPen);
  // The last push may have nudged the feet onto slightly higher ground: never end a tick inside the terrain.
  const g = heightAt(ctx.terrain, p.x, p.z);
  if (p.y < g) p.y = g;

  // Water state.
  p.swimming = p.y < SWIM_LINE;
  if (p.swimming && !wasSwimming) out.enteredWater = true;
  else if (!p.swimming && wasSwimming) out.leftWater = true;
  p.swimTicks = p.swimming ? Math.min(COUNTER_MAX, p.swimTicks + 1) : 0;
  if (landing.landed && !p.swimming) {
    out.landed = true;
    out.landSpeed = landing.speed;
  }
  p.airTicks = p.grounded ? 0 : Math.min(AIR_TICKS_MAX, p.airTicks + 1);
}

/**
 * Move by (dx, dz) when the terrain allows it (canStepTo), else slide along the contour of the blocking slope
 * (one retry). On the ground the uphill velocity component into the slope is removed.
 */
function tryMove(p: PlayerSim, hf: Heightfield, dx: number, dz: number, feetY: number, grounded: boolean, lead: number): void {
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 1e-12) return;
  const tx = p.x + dx;
  const tz = p.z + dz;
  if (canStepTo(hf, tx, tz, dx / len, dz / len, feetY, lead)) {
    p.x = tx;
    p.z = tz;
    return;
  }
  if (!uphillAt(hf, tx, tz) && !uphillAt(hf, tx + (dx / len) * lead, tz + (dz / len) * lead) && !uphillAt(hf, p.x + dx * 0.5, p.z + dz * 0.5)) return;
  const gx = uphill.x;
  const gz = uphill.z;
  if (grounded) {
    const vu = p.vx * gx + p.vz * gz;
    if (vu > 0) {
      p.vx -= gx * vu;
      p.vz -= gz * vu;
    }
  }
  const du = dx * gx + dz * gz;
  if (du <= 0) return;
  const sx = dx - gx * du;
  const sz = dz - gz * du;
  const sl = Math.sqrt(sx * sx + sz * sz);
  if (sl < 1e-9) return;
  const ux = p.x + sx;
  const uz = p.z + sz;
  if (canStepTo(hf, ux, uz, sx / sl, sz / sl, feetY, lead)) {
    p.x = ux;
    p.z = uz;
  }
}

/** Unit horizontal uphill direction of the terrain at (x, z) into `uphill`; false on flat ground. */
function uphillAt(hf: Heightfield, x: number, z: number): boolean {
  normalAt(hf, x, z, nrm);
  const gx = -nrm.x;
  const gz = -nrm.z;
  const gl = Math.sqrt(gx * gx + gz * gz);
  if (gl < 1e-6) return false;
  uphill.x = gx / gl;
  uphill.z = gz / gl;
  return true;
}

/**
 * Push the capsule (feet at feetY) out of overlapping cover circles, sliding the velocity along them. Pushes
 * ignore wall slopes (a few centimeters up a steep bank are harmless; the slide brings you back) but never
 * shove anyone more than STEP_MAX up the terrain. Up to PUSH_PASSES passes, so a capsule wedged between two
 * circles settles outside both.
 */
function pushOutOfCover(p: PlayerSim, ctx: SimContext, feetY: number, radius: number, height: number): void {
  for (let pass = 0; pass < PUSH_PASSES; pass++) {
    const n = ctx.cover.query(p.x, p.z, radius, coverHits);
    let pushed = false;
    for (let i = 0; i < n; i++) {
      const c = coverHits[i]!;
      if (c.top <= feetY + STEP_MAX || c.bottom >= feetY + height) continue;
      const dx = p.x - c.x;
      const dz = p.z - c.z;
      const min = c.r + radius;
      const d2 = dx * dx + dz * dz;
      if (d2 >= min * min) continue;
      const d = Math.sqrt(d2);
      let nx = 1;
      let nz = 0;
      if (d > 1e-9) {
        nx = dx / d;
        nz = dz / d;
      }
      const depth = min - d;
      const tx = p.x + nx * depth;
      const tz = p.z + nz * depth;
      if (heightAt(ctx.terrain, tx, tz) - feetY <= STEP_MAX) {
        p.x = tx;
        p.z = tz;
        pushed = true;
      }
      const vn = p.vx * nx + p.vz * nz;
      if (vn < 0) {
        p.vx -= nx * vn;
        p.vz -= nz * vn;
      }
    }
    if (!pushed) return;
  }
}

/** Deepest overlap of the capsule (feet at feetY) with a blocking cover circle (0 = clear). */
function coverPenetration(p: PlayerSim, ctx: SimContext, feetY: number, radius: number, height: number): number {
  const n = ctx.cover.query(p.x, p.z, radius, coverHits);
  let deepest = 0;
  for (let i = 0; i < n; i++) {
    const c = coverHits[i]!;
    if (c.top <= feetY + STEP_MAX || c.bottom >= feetY + height) continue;
    const dx = p.x - c.x;
    const dz = p.z - c.z;
    const depth = c.r + radius - Math.sqrt(dx * dx + dz * dz);
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

/**
 * A gap narrower than the capsule can't be squeezed into: when the move + push-out left the capsule deeper in
 * cover than it was at (sx, sz) (penetration `before`), go back there. Returns the penetration now.
 */
function keepIfNotDeeper(
  p: PlayerSim,
  ctx: SimContext,
  feetY: number,
  radius: number,
  height: number,
  sx: number,
  sz: number,
  before: number,
): number {
  const now = coverPenetration(p, ctx, feetY, radius, height);
  if (now <= PEN_EPS || now <= before) return now;
  p.x = sx;
  p.z = sz;
  return before;
}

function clampToBounds(p: PlayerSim, ctx: SimContext): void {
  const b = ctx.bounds;
  if (p.x < b.minX) {
    p.x = b.minX;
    if (p.vx < 0) p.vx = 0;
  } else if (p.x > b.maxX) {
    p.x = b.maxX;
    if (p.vx > 0) p.vx = 0;
  }
  if (p.z < b.minZ) {
    p.z = b.minZ;
    if (p.vz < 0) p.vz = 0;
  } else if (p.z > b.maxZ) {
    p.z = b.maxZ;
    if (p.vz > 0) p.vz = 0;
  }
}

/** Highest cover top ≤ reach under a circle of `radius` at (x, z), or -Infinity. */
function coverSupport(ctx: SimContext, x: number, z: number, radius: number, reach: number): number {
  const n = ctx.cover.query(x, z, radius, coverHits);
  let best = -Infinity;
  for (let i = 0; i < n; i++) {
    const top = coverHits[i]!.top;
    if (top > best && top <= reach) best = top;
  }
  return best;
}

function resolveGround(p: PlayerSim, ctx: SimContext, ref: number, wasGrounded: boolean, jumped: boolean, radius: number): void {
  landing.landed = false;
  landing.speed = 0;
  const hf = ctx.terrain;
  const terrain = heightAt(hf, p.x, p.z);
  const top = coverSupport(ctx, p.x, p.z, radius * SUPPORT_RADIUS_FRACTION, ref + STEP_MAX);
  let ground: number;
  let walkable: boolean;
  if (top >= terrain) {
    ground = top;
    walkable = true;
  } else {
    ground = terrain;
    walkable = normalAt(hf, p.x, p.z, nrm).y >= MAX_WALK_NORMAL_Y;
  }

  if (p.y <= ground) {
    p.y = ground;
    if (p.vy > 0) {
      // Rising terrain caught the feet mid-jump: lift them, keep rising.
      p.grounded = false;
      return;
    }
    if (!walkable) {
      // A wall slope doesn't hold anyone: slide down it (horizontal part of gravity along the surface).
      const k = -GRAVITY * nrm.y * ctx.dt;
      p.vx += nrm.x * k;
      p.vz += nrm.z * k;
      p.vy = 0;
      p.grounded = false;
      return;
    }
    if (!wasGrounded) {
      landing.landed = true;
      landing.speed = -p.vy;
    }
    p.vy = 0;
    p.grounded = true;
    return;
  }

  if (wasGrounded && !jumped && p.vy <= 0 && walkable && ground > FLOAT_Y && p.y - ground <= GROUND_SNAP) {
    // Walking downhill: stay on the ground instead of hopping down the slope.
    p.y = ground;
    p.vy = 0;
    p.grounded = true;
    return;
  }
  p.grounded = false;
}
