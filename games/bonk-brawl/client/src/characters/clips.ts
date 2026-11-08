// One-shot animation clips layered over the continuous state. Owner: client-characters (MOTION).
//
// Public clips are started by trigger(AnimTrigger); internal clips (get-up, exit pops, fidgets)
// are started by the Animator from state edges and never leave this module's API.

import { EMOTES } from "../../../shared/constants";
import type { AbilityId, CharacterId, EmoteId, HeldPowerUp } from "../../../shared/types";
import { bump, clamp01, easeInOut, easeOutBack, easeOutCubic, lerp, type Pose } from "./pose";
import type { SpringRig } from "./springs";
import type { FaceParts } from "./states";
import type { AnimTrigger, TriggerOptions } from "./types";

const TAU = Math.PI * 2;

/** Clips the Animator starts on its own (state exits, fidgets); not part of the AnimTrigger contract. */
export type InternalClip = "getUp" | "rollPop" | "airBrake" | "slidePop" | "headbuttStop" | "fidget";
export type ClipName = AnimTrigger | InternalClip;

/** What a clip sees while it plays (one reused object per clip slot). */
export interface ClipContext {
  /** 0..1 progress. */
  u: number;
  /** Seconds since the clip started. */
  t: number;
  duration: number;
  character: CharacterId;
  ability: AbilityId;
  opts: TriggerOptions;
  /** +1 / -1: twist direction chosen when the clip started (from the hit direction). */
  side: number;
  /** 0..1 strength (opts.strength or the clip's default). */
  k: number;
  /** Horizontal speed when the clip started (m/s). */
  speed: number;
  /** Clip variant (fidget index). */
  variant: number;
  /** Power-up of the thrown ball; curveball throw. */
  power: HeldPowerUp;
  curve: boolean;
  /** Hit direction in the character frame (forward / right components of opts.dir). */
  dirFwd: number;
  dirRight: number;
  /** Tumble spin rate / angle when the clip started (ring-out keeps spinning). */
  omega: number;
  angle0: number;
  /** > 0 while a cancelled clip fades out (seconds left of CANCEL_FADE). */
  cancel: number;
}

export function createClipContext(): ClipContext {
  return {
    u: 0,
    t: 0,
    duration: 1,
    character: "quacky",
    ability: "flapDash",
    opts: NO_OPTS,
    side: 1,
    k: 0.5,
    speed: 0,
    variant: 0,
    power: "",
    curve: false,
    dirFwd: 0,
    dirRight: 0,
    omega: 0,
    angle0: 0,
    cancel: 0,
  };
}

export const NO_OPTS: TriggerOptions = Object.freeze({});
/** Seconds a cancelled clip (fidget on a state change) takes to fade out. */
export const CANCEL_FADE = 0.1;

export interface ClipDef {
  /** Default strength when opts.strength is absent. */
  strength: number;
  duration(c: ClipContext): number;
  /** Fade-in / fade-out as fractions of the duration. */
  fadeIn: number;
  fadeOut: number;
  /** Writes the clip pose into `p`, which starts as a copy of the pose underneath. */
  pose(p: Pose, c: ClipContext): void;
  /** Writes the eyes / mouth the clip wants into `out` (leave null for no opinion). */
  face(c: ClipContext, out: FaceParts): void;
  /** Squash-spring impulse when the clip starts (< 0 squash, > 0 stretch). */
  impulse(c: ClipContext): number;
  /** Spring-bone kick when the clip starts. */
  kick?(c: ClipContext, springs: SpringRig, yaw: number): void;
}

const WINGED: ReadonlySet<CharacterId> = new Set<CharacterId>(["quacky", "pip"]);
/** Characters whose mouth is a beak on a jaw pivot (the sprite has no mouth band). */
const BEAKED: ReadonlySet<CharacterId> = new Set<CharacterId>(["quacky", "pip"]);

const noFace = (): void => {};

function face(out: FaceParts, eyes: FaceParts["eyes"], mouth: FaceParts["mouth"]): void {
  out.eyes = eyes;
  out.mouth = mouth;
}

/** Piecewise ease from a to b between t0 and t1 (seconds). */
function seg(t: number, t0: number, t1: number, a: number, b: number): number {
  return lerp(a, b, easeOutCubic((t - t0) / (t1 - t0)));
}

/* ============================================================== combat */

/** Overhand release: the arm passes the release point (forward-up) ~0.04 s after the trigger. */
const QUICK_THROW = 0.15;

function throwOverhand(p: Pose, c: ClipContext): void {
  const k = c.k;
  const t = c.t;
  // Whip from overhead (−3.6) through the release point (−4.3 at ~0.04 s) and follow through low
  // across the body (−4.98 ≡ 1.3, forward-down).
  p.armRX = t < 0.06 ? seg(t, 0, 0.06, -3.6, -4.5) : seg(t, 0.06, 0.2, -4.5, -4.98);
  p.armRZ = 0.3 - 0.35 * easeOutCubic(t / 0.12);
  p.armRY = -0.4 * easeOutCubic((t - 0.06) / 0.14);
  if (c.curve) p.armRY += 0.8 * bump((t - 0.02) / 0.14); // Whiskers' wrist flick
  p.armLX = 1.1 - 1.7 * easeOutCubic(t / 0.12);
  p.armLZ = 0.35;
  const unwind = easeOutCubic(t / 0.12);
  p.twist = 0.5 - (0.5 + 1.0 * k) * unwind;
  const lean = bump(t / 0.4);
  p.leanX += (0.12 + 0.3 * k) * lean;
  p.bend += 0.2 * k * lean;
  p.legLX = 0.45 * unwind;
  p.legRX = -0.45 * unwind;
  p.headX += 0.15 * unwind;
  p.ears -= 0.3 * bump(c.u);
  p.extraX += 0.4 * bump(c.u);
}

function throwQuick(p: Pose, c: ClipContext): void {
  // Sidearm flick from the carry pose.
  const u = easeOutCubic(c.t / 0.1);
  p.armRX = 1.3;
  p.armRZ = 0.9 - 0.8 * u;
  p.armRY = -0.6 + 1.2 * u;
  if (c.curve) p.armRY += 0.6 * bump(c.t / 0.12);
  p.twist = 0.3 - 0.6 * u;
  p.leanX += 0.1 * bump(c.u);
  p.headX += 0.05 * bump(c.u);
}

function throwMega(p: Pose, c: ClipContext): void {
  // Two-arm overhead heave.
  const t = c.t;
  const arm = t < 0.1 ? seg(t, 0, 0.1, -3.2, -4.4) : seg(t, 0.1, 0.26, -4.4, -5.0);
  p.armRX = arm;
  p.armLX = arm;
  p.armRZ = 0.25;
  p.armLZ = 0.25;
  p.twist = 0;
  const lean = bump(t / 0.5);
  p.leanX += 0.35 * lean;
  p.bend += 0.3 * lean;
  p.crouch -= 0.1 * lean;
  p.legLX = 0.4 * easeOutCubic(t / 0.12);
  p.legRX = -0.3 * easeOutCubic(t / 0.12);
  p.headX += 0.2 * easeOutCubic(t / 0.12);
  p.ears -= 0.4 * bump(c.u);
}

function throwTriple(p: Pose, c: ClipContext): void {
  // Horizontal fan sweep.
  const u = easeOutCubic(c.t / 0.15);
  p.armRX = 1.5;
  p.armRZ = 1.2 - 1.0 * u;
  p.armRY = -0.3 + 0.9 * u;
  p.armLX = 0.6;
  p.armLZ = 0.6;
  p.twist = 0.6 - 1.2 * u;
  p.leanX += 0.15 * bump(c.u);
  p.headY -= 0.3 - 0.6 * u;
}

const throwClip: ClipDef = {
  strength: 0.5,
  duration: (c) => (c.power === "mega" ? 0.48 + 0.12 * c.k : c.k < QUICK_THROW && c.power !== "triple" ? 0.25 : 0.38 + 0.12 * c.k),
  fadeIn: 0.04,
  fadeOut: 0.5,
  pose(p, c) {
    if (c.power === "mega") throwMega(p, c);
    else if (c.power === "triple") throwTriple(p, c);
    else if (c.k < QUICK_THROW) throwQuick(p, c);
    else throwOverhand(p, c);
  },
  face: (c, out) => {
    if (c.u < 0.55) face(out, "angry", "angry");
  },
  impulse: (c) => (c.k < QUICK_THROW ? 0.4 : 0.9 + 0.8 * c.k),
  kick: (c, s, yaw) => s.kick(null, 0, 0, -2.5 * Math.max(0.3, c.k), yaw),
};

const catchHug: ClipDef = {
  strength: 1,
  duration: () => 0.75,
  fadeIn: 0.06,
  fadeOut: 0.3,
  pose(p, c) {
    // Arms clamp in, hug the ball to the belly, then hand it to the carry pose.
    const grab = easeOutBack(c.u / 0.25);
    const hug = 1 - clamp01((c.t - 0.45) / 0.2);
    p.armRX = lerp(1.35, 0.9, grab * hug);
    p.armLX = lerp(1.35, 0.9, grab * hug);
    p.armRZ = 0.9 - 1.35 * grab;
    p.armLZ = 0.9 - 1.35 * grab;
    p.armRY = 0.3;
    p.armLY = 0.3;
    p.leanX -= 0.22 * bump(c.u / 0.6);
    p.lift += 0.1 * bump(c.u / 0.4);
    p.headX += 0.28;
    p.headZ += 0.15 * Math.sin(c.u * TAU * 1.5);
    p.twist += 0.22 * Math.sin(c.u * TAU * 1.5);
    p.ears -= 0.3;
    p.extraY += 0.5 * Math.sin(c.u * TAU * 3);
  },
  face: (_c, out) => face(out, "happy", "happy"),
  impulse: () => -2.6,
  kick: (_c, s, yaw) => s.kick(null, 0, 0, 2.0, yaw),
};

const whiffClip: ClipDef = {
  strength: 0.5,
  duration: () => 0.7,
  fadeIn: 0.03,
  fadeOut: 0.35,
  pose(p, c) {
    const t = c.t;
    // Clap on nothing (arms in at ~0.1 s), stumble forward, head shake.
    const clap = bump(t / 0.2);
    p.armRX = 1.4;
    p.armLX = 1.4;
    p.armRZ = 0.7 - 1.0 * clap;
    p.armLZ = 0.7 - 1.0 * clap;
    const stumble = clamp01((t - 0.15) / 0.2);
    p.leanX += 0.25 * stumble * (1 - clamp01((t - 0.4) / 0.3)) + 0.06 * Math.sin(t * 14) * stumble;
    const shake = Math.max(0, 1 - (t - 0.2) / 0.45);
    if (t > 0.2) p.headY += 0.3 * Math.sin((t - 0.2) * TAU * 12 * 0.5) * shake;
    p.headX -= 0.15 * bump(c.u);
  },
  face: (c, out) => face(out, c.t < 0.25 ? "dizzy" : "hurt", "hurt"),
  impulse: () => -1.6,
};

const hitReact: ClipDef = {
  strength: 0.8,
  duration: () => 0.6,
  fadeIn: 0,
  fadeOut: 0.1,
  pose(p, c) {
    const k = c.k;
    const jolt = bump(c.u / 0.45);
    // Jolt away from the hit: lean along the push direction, head snaps back.
    p.leanX += 0.35 * k * c.dirFwd * jolt;
    p.leanZ += 0.35 * k * c.dirRight * jolt;
    p.headX -= 0.4 * bump(c.u / 0.5);
    p.armRZ += 1.3 * bump(c.u / 0.8) * (0.7 + 0.3 * k);
    p.armLZ += 1.3 * bump(c.u / 0.8) * (0.7 + 0.3 * k);
    p.armRX += 0.4 * bump(c.u / 0.8);
    p.armLX += 0.4 * bump(c.u / 0.8);
    p.ears += 0.6 * bump(c.u);
    p.extraX += 0.5 * bump(c.u);
    // Big hits only: a half twist, completed back around in the clip's last quarter.
    if (k >= 0.9) p.spinY += c.side * (Math.PI * easeOutCubic(c.u / 0.35) + Math.PI * easeInOut((c.u - 0.72) / 0.24));
  },
  face: (c, out) => face(out, c.u < 0.4 ? "hurt" : "dizzy", "hurt"),
  impulse: (c) => -2.2 - 1.5 * c.k,
  kick: (c, s, yaw) => s.kick(null, 3 * c.k * c.dirRight, 0.5, -3 * c.k * c.dirFwd, yaw),
};

const land: ClipDef = {
  strength: 0.5,
  duration: (c) => 0.22 + 0.12 * c.k + (c.k > 0.75 ? 0.08 : 0),
  fadeIn: 0.05,
  fadeOut: 0.6,
  pose(p, c) {
    const k = c.k;
    const rolling = c.speed > 3;
    // Strong landings hold a splat for 0.08 s before springing back.
    const hold = k > 0.75 ? clamp01(c.t / 0.04) * (1 - clamp01((c.t - 0.12) / 0.08)) : 0;
    const b = Math.max(bump(c.u), hold);
    if (!rolling) {
      // Arms flop down then up.
      p.armRZ += (0.25 + 0.5 * k) * (c.u < 0.35 ? -0.4 * bump(c.u / 0.35) : bump((c.u - 0.35) / 0.65));
      p.armLZ += (0.25 + 0.5 * k) * (c.u < 0.35 ? -0.4 * bump(c.u / 0.35) : bump((c.u - 0.35) / 0.65));
      p.legRZ += 0.12 * k * b;
      p.legLZ += 0.12 * k * b;
    }
    p.crouch -= (rolling ? 0.04 : 0.1) * k * b;
    p.headX += 0.12 * k * b;
    p.ears += 0.5 * k * b;
    p.crouch -= 0.12 * hold;
  },
  face: (c, out) => {
    if (c.k > 0.75 && c.t < 0.2) face(out, "hurt", "hurt");
  },
  impulse: (c) => -(1.6 + 3.4 * c.k) * (c.speed > 3 ? 0.5 : 1),
  kick: (c, s, yaw) => s.kick(null, 0, -2.5 * c.k, 0, yaw),
};

const pickup: ClipDef = {
  strength: 0.5,
  duration: () => 0.36,
  fadeIn: 0.1,
  fadeOut: 0.4,
  pose(p, c) {
    const b = bump(c.u);
    p.bend += 0.5 * b;
    p.crouch -= 0.1 * b;
    p.armRX += 0.9 * b;
    p.armRZ -= 0.05 * b;
    p.headX += 0.3 * b;
  },
  face: (c, out) => {
    if (c.u > 0.45) face(out, "happy", "happy");
  },
  impulse: () => 0.8,
};

/* ============================================================ abilities */

function abilityFlourish(p: Pose, c: ClipContext): void {
  const b = bump(c.u);
  switch (c.ability) {
    case "flapDash":
      p.armRZ += 0.6 * b;
      p.armLZ += 0.6 * b;
      p.extraX -= 0.6 * b;
      return;
    case "groundPound":
      p.sac = Math.max(p.sac, 0.8 * b);
      return;
    case "bellyBounce":
      // Belly "boing" (start, and when a ball bounces off): a big jiggle and a happy squish.
      p.belly += 0.35 * Math.sin(c.u * TAU * 2) * (1 - c.u);
      p.cheeks += 0.25 * b;
      p.armRZ += 0.4 * b;
      p.armLZ += 0.4 * b;
      p.crouch -= 0.06 * b;
      return;
    case "curveball": {
      // Smug flourish: paw twirl at the chin, tail swish, head cocked.
      const twirl = Math.sin(c.u * TAU * 2);
      p.armRX = 2.0 + 0.25 * twirl;
      p.armRZ = -0.25;
      p.armRY = 0.6 + 0.3 * twirl;
      p.armLZ = 0.45;
      p.armLX = -0.2;
      p.headZ += 0.25 * b;
      p.headY -= 0.2 * b;
      p.leanZ -= 0.08 * b;
      p.extraY += 0.9 * Math.sin(c.u * TAU * 1.5);
      p.extraZ += 0.4 * b;
      p.tailCurl += 0.5 * b;
      return;
    }
    case "bellySlide":
      p.armRZ += 0.4 * b;
      p.armLZ += 0.4 * b;
      return;
    case "headbutt":
      p.headX += 0.3 * b;
      p.ears -= 0.5 * b;
      return;
  }
}

const abilityClip: ClipDef = {
  strength: 0.5,
  duration: (c) => (c.character === "whiskers" ? 0.9 : 0.45),
  fadeIn: 0.12,
  fadeOut: 0.3,
  pose: abilityFlourish,
  face: (c, out) => {
    if (c.ability === "curveball" && c.u < 0.85) face(out, "charging", "idle");
    else if (c.ability === "bellyBounce") face(out, "happy", "happy");
  },
  impulse: () => 1.4,
  kick: (c, s, yaw) => {
    if (c.ability === "bellyBounce") s.kick("belly", 0, 2.5, 0, yaw);
    else if (c.ability === "curveball") s.kick("tail", 2.5, 0.5, 0, yaw);
  },
};

const slam: ClipDef = {
  strength: 1,
  duration: () => 0.5,
  fadeIn: 0.04,
  fadeOut: 0.45,
  pose(p, c) {
    const b = bump(c.u);
    p.armRX = 0.3;
    p.armLX = 0.3;
    p.armRZ += 1.4 * b;
    p.armLZ += 1.4 * b;
    // Frog splat: legs spread wide.
    p.legRZ += 0.6 * b;
    p.legLZ += 0.6 * b;
    p.crouch -= 0.2 * b;
    p.headX -= 0.15 * b;
    p.ears += 0.8 * b;
    p.sac = 0.9 * b;
    p.bulbs += 0.2 * b;
  },
  face: (c, out) => {
    if (c.u < 0.6) face(out, "angry", "angry");
  },
  impulse: () => -5,
  kick: (_c, s, yaw) => s.kick(null, 0, -4, 0, yaw),
};

/* =============================================================== emotes */

function honk(p: Pose, c: ClipContext): void {
  const windUp = bump(c.u / 0.35);
  const blast = c.u > 0.3 ? bump((c.u - 0.3) / 0.7) : 0;
  p.headX -= 0.45 * windUp - 0.2 * blast;
  p.leanX -= 0.15 * windUp - 0.12 * blast;
  p.crouch += 0.12 * blast;
  p.lift += 0.06 * blast;
  switch (c.character) {
    case "quacky":
    case "pip": {
      const flap = Math.sin(c.t * 36);
      p.armRZ += (0.9 + 0.5 * flap) * blast;
      p.armLZ += (0.9 + 0.5 * flap) * blast;
      p.jaw = Math.max(p.jaw, blast);
      break;
    }
    case "hopsworth":
      p.sac = Math.max(p.sac, 1.15 * blast);
      p.bulbs += 0.15 * blast;
      p.armRZ += 0.5 * blast;
      p.armLZ += 0.5 * blast;
      break;
    case "mochi":
      // Belly-puff "roar".
      p.belly += 0.3 * blast;
      p.cheeks += 0.3 * blast;
      p.armRZ += 1.1 * blast;
      p.armLZ += 1.1 * blast;
      p.armRX += 0.9 * blast;
      p.armLX += 0.9 * blast;
      break;
    case "whiskers":
      // Hiss: arch the back, ears flat, tail up.
      p.bend -= 0.3 * blast;
      p.crouch += 0.08 * blast;
      p.ears -= 0.6 * blast;
      p.tailCurl -= 0.5 * blast;
      p.armRX += 0.8 * blast;
      p.armLX += 0.8 * blast;
      break;
    case "gruff":
      // Rear back and bleat.
      p.leanX -= 0.3 * blast;
      p.headX -= 0.3 * blast;
      p.jaw = Math.max(p.jaw, blast);
      p.armRX += 1.2 * blast;
      p.armLX += 1.2 * blast;
      break;
  }
  p.ears += 0.5 * blast;
  p.extraX -= 0.5 * blast;
}

function wave(p: Pose, c: ClipContext): void {
  const up = easeOutBack(c.u / 0.18);
  const waving = Math.sin(c.u * TAU * 3.2);
  p.armRX = 2.55 * up;
  p.armRZ = 0.55 + 0.45 * waving * up;
  p.armRY = 0.2;
  // Free paw on the hip.
  p.armLX = 0.2 * up;
  p.armLZ = 0.75 * up;
  p.armLY = -0.6 * up;
  p.headZ -= 0.2 * up;
  p.headY -= 0.1 * up;
  p.leanZ -= 0.07 * up;
  p.crouch += 0.03 * Math.sin(c.u * TAU * 3.2 + 1);
  p.extraY += 0.6 * waving;
}

function dance(p: Pose, c: ClipContext): void {
  const beat = c.u * TAU * 4;
  const s = Math.sin(beat);
  p.leanZ += 0.18 * s;
  p.lift += 0.07 * Math.abs(s);
  p.crouch += 0.06 * Math.abs(Math.cos(beat));
  p.armRX = 1.5 + 1.2 * s;
  p.armLX = 1.5 - 1.2 * s;
  p.armRZ = 0.55;
  p.armLZ = 0.55;
  p.headZ -= 0.2 * s;
  p.legRX += 0.45 * Math.max(0, s);
  p.legLX += 0.45 * Math.max(0, -s);
  p.legRLift += 0.05 * Math.max(0, s);
  p.legLLift += 0.05 * Math.max(0, -s);
  p.extraY += 0.6 * s;
  p.ears += 0.3 * Math.abs(s);
  // Run flavor per animal.
  switch (c.character) {
    case "quacky":
      p.armRZ += 0.4 * Math.abs(s);
      p.armLZ += 0.4 * Math.abs(s);
      p.headX += 0.1 * Math.sin(beat * 2);
      break;
    case "hopsworth":
      p.lift += 0.06 * Math.abs(s);
      p.sac = Math.max(p.sac, 0.4 * Math.abs(s));
      break;
    case "mochi":
      p.belly += 0.1 * Math.abs(s);
      break;
    case "whiskers":
      p.tailCurl += 0.6 * s;
      break;
    case "pip":
      p.roll += 0.12 * s;
      break;
    case "gruff":
      p.headX += 0.2 * Math.abs(s);
      break;
  }
  // Finish with a twirl.
  p.spinY += TAU * easeInOut((c.u - 0.66) / 0.28);
}

const EMOTE_POSES: Record<EmoteId, (p: Pose, c: ClipContext) => void> = { honk, wave, dance };

const emoteClip: ClipDef = {
  strength: 0.5,
  duration: (c) => EMOTES[c.opts.emote ?? "wave"].durationSec,
  fadeIn: 0.1,
  fadeOut: 0.18,
  pose(p, c) {
    EMOTE_POSES[c.opts.emote ?? "wave"](p, c);
  },
  face(c, out) {
    if (c.opts.emote === "honk") {
      if (c.character === "whiskers") face(out, c.u > 0.3 ? "angry" : null, c.u > 0.3 ? "angry" : null);
      else if (!BEAKED.has(c.character)) face(out, c.u > 0.3 ? "happy" : null, c.u > 0.3 ? "happy" : null);
      else face(out, "happy", null);
      return;
    }
    face(out, "happy", "happy");
  },
  impulse: (c) => (c.opts.emote === "honk" ? -1 : 0.8),
};

/* ===================================================== victory and KO */

const VICTORY_SEC = 3.2;

function victoryHops(p: Pose, c: ClipContext, hops: number, height: number): number {
  const hopU = (c.u * hops) % 1;
  p.lift += height * bump(hopU);
  p.crouch += 0.14 * bump(hopU) - 0.12 * (1 - bump(hopU));
  p.legRX += 0.5 * bump(hopU);
  p.legLX -= 0.3 * bump(hopU);
  return hopU;
}

const victory: ClipDef = {
  strength: 1,
  duration: () => VICTORY_SEC,
  fadeIn: 0.04,
  fadeOut: 0.06,
  pose(p, c) {
    const u = c.u;
    const t = c.t;
    switch (c.character) {
      case "quacky": {
        // Flap-hover hops, then a hat tip.
        const hopU = victoryHops(p, c, 4, 0.4);
        const flap = Math.sin(t * 36);
        const tip = u > 0.75 ? bump((u - 0.75) / 0.25) : 0;
        p.armRZ = (1.0 + 0.6 * flap) * (1 - tip) + 0.3 * tip;
        p.armLZ = 1.0 + 0.6 * flap;
        p.armRX = 2.8 * tip;
        p.headX -= 0.15 * tip;
        p.jaw = Math.max(p.jaw, 0.5 * bump(hopU));
        break;
      }
      case "hopsworth": {
        // Bow-tie straighten, then a big leap with a throat-sac honk.
        const fix = u < 0.3 ? bump(u / 0.3) : 0;
        const leap = u >= 0.3 ? (u - 0.3) / 0.7 : 0;
        p.armRX = 1.6 * fix + 2.6 * bump(leap);
        p.armLX = 1.6 * fix + 2.6 * bump(leap);
        p.armRZ = 0.5 - 0.6 * fix;
        p.armLZ = 0.5 - 0.6 * fix;
        p.headX += 0.2 * fix;
        p.lift += 0.7 * bump(leap);
        p.crouch += 0.2 * bump(leap) - 0.15 * (leap > 0 && leap < 0.1 ? 1 : 0);
        p.legRZ += 0.4 * bump(leap);
        p.legLZ += 0.4 * bump(leap);
        p.sac = Math.max(p.sac, 1.1 * (leap > 0.4 ? bump((leap - 0.4) / 0.6) : 0));
        break;
      }
      case "mochi": {
        // Belly drum (paws alternate) and a happy wiggle.
        const drum = Math.sin(t * TAU * 4);
        p.armRX = 0.9 + 0.4 * Math.max(0, drum);
        p.armLX = 0.9 + 0.4 * Math.max(0, -drum);
        p.armRZ = -0.1;
        p.armLZ = -0.1;
        p.belly += 0.08 * Math.abs(drum);
        p.leanZ += 0.12 * Math.sin(t * TAU * 1.5);
        p.headZ -= 0.15 * Math.sin(t * TAU * 1.5);
        p.lift += 0.04 * Math.abs(drum);
        break;
      }
      case "whiskers": {
        // Paw lick, then a pose with the tail curled.
        const lick = u < 0.45 ? bump(u / 0.45) : 0;
        const pose = clamp01((u - 0.45) / 0.15);
        p.armRX = 2.2 * lick + 2.7 * pose;
        p.armRZ = -0.2 * lick + 0.4 * pose;
        p.headX += 0.25 * lick - 0.15 * pose;
        p.headZ += 0.15 * Math.sin(t * 9) * lick + 0.15 * pose;
        p.armLX = 0.2 * pose;
        p.armLZ = 0.75 * pose;
        p.armLY = -0.6 * pose;
        p.leanZ += 0.08 * pose;
        p.tailCurl += 0.9 * pose;
        break;
      }
      case "pip": {
        // Tap dance with flipper flaps.
        const tap = Math.sin(t * TAU * 8);
        p.legRLift += 0.05 * Math.max(0, tap);
        p.legLLift += 0.05 * Math.max(0, -tap);
        p.legRX += 0.3 * Math.max(0, tap);
        p.legLX += 0.3 * Math.max(0, -tap);
        p.armRZ = 0.9 + 0.5 * Math.sin(t * 24);
        p.armLZ = 0.9 + 0.5 * Math.sin(t * 24 + 1);
        p.roll += 0.1 * Math.sin(t * TAU * 2);
        p.lift += 0.03 * Math.abs(tap);
        break;
      }
      case "gruff": {
        // Headbang, then rear up on the hind legs ringing the bell.
        const bang = u < 0.5 ? Math.sin(t * TAU * 3) : 0;
        const rear = clamp01((u - 0.5) / 0.15) * (1 - clamp01((u - 0.9) / 0.1));
        p.headX += 0.45 * bang;
        p.leanX -= 0.45 * rear;
        p.armRX = 1.8 * rear + 0.4 * Math.sin(t * 20) * rear;
        p.armLX = 1.8 * rear + 0.4 * Math.sin(t * 20 + 1) * rear;
        p.armRZ = 0.3;
        p.armLZ = 0.3;
        p.jaw = Math.max(p.jaw, 0.7 * rear);
        p.headX -= 0.3 * rear;
        break;
      }
    }
    p.ears += 0.3 * Math.abs(Math.sin(t * 6));
    p.extraY += 0.6 * Math.sin(t * 7);
  },
  face: (_c, out) => face(out, "happy", "happy"),
  impulse: () => 1.5,
};

/** Pop before the body disappears into a puff (the avatar hides the body at the end). */
export const KO_POP_SEC = 0.22;

const ko: ClipDef = {
  strength: 1,
  duration: () => KO_POP_SEC,
  fadeIn: 0.05,
  fadeOut: 0,
  pose(p, c) {
    const grow = easeOutBack(c.u);
    p.size += 0.35 * grow;
    p.crouch += 0.12 * grow;
    p.armRZ = 1.4;
    p.armLZ = 1.4;
    p.legRZ = 0.5;
    p.legLZ = 0.5;
    p.headX -= 0.3;
    p.ears += 0.7;
  },
  face: (_c, out) => face(out, "ko", "ko"),
  impulse: () => 0,
};

/** Falling off the island: keeps the tumble spin going, windmilling, until out of view. */
const ringOut: ClipDef = {
  strength: 1,
  duration: () => 1.6,
  fadeIn: 0.05,
  fadeOut: 0,
  pose(p, c) {
    p.pitch = -(c.angle0 + c.omega * c.t);
    p.roll = c.t * 3;
    p.armRZ = 1.5 + 0.4 * Math.sin(c.t * 24);
    p.armLZ = 1.5 + 0.4 * Math.sin(c.t * 22 + 1);
    p.armRX = 1.2 * Math.sin(c.t * 14);
    p.armLX = 1.2 * Math.sin(c.t * 14 + Math.PI);
    p.legRX = 0.7 * Math.sin(c.t * 20);
    p.legLX = -0.7 * Math.sin(c.t * 20);
    p.legRZ = 0.3;
    p.legLZ = 0.3;
    p.ears = 0.6;
  },
  face: (_c, out) => face(out, "hurt", "hurt"),
  impulse: () => 0,
};

/* ====================================================== internal clips */

/** Stand-up flourish after a knockback (the Animator's Tumble does the rotation). */
const getUp: ClipDef = {
  strength: 0.5,
  duration: (c) => (c.speed > 1 ? 0.3 : 0.5),
  fadeIn: 0.05,
  fadeOut: 0.4,
  pose(p, c) {
    const shake = Math.max(0, 1 - c.u);
    p.headY += 0.25 * Math.sin(c.t * TAU * 9 * 0.5) * shake;
    p.armRZ += 0.5 * bump(c.u);
    p.armLZ += 0.5 * bump(c.u);
    p.ears += 0.3 * shake;
  },
  face: (c, out) => face(out, c.u < 0.6 ? "dizzy" : null, c.u < 0.4 ? "dizzy" : null),
  impulse: () => -1.8,
};

const rollPop: ClipDef = {
  strength: 0.5,
  duration: () => 0.15,
  fadeIn: 0.1,
  fadeOut: 0.5,
  pose(p, c) {
    const b = bump(c.u);
    p.crouch += 0.1 * b;
    p.armRZ += 0.7 * b;
    p.armLZ += 0.7 * b;
    p.ears -= 0.2 * b;
  },
  face: noFace,
  impulse: () => 1.2,
};

/** Quacky after a Flap Dash: wings spread wide, upright, floating. */
const airBrake: ClipDef = {
  strength: 0.5,
  duration: () => 0.25,
  fadeIn: 0.1,
  fadeOut: 0.5,
  pose(p, c) {
    const b = bump(c.u);
    const flap = Math.sin(c.t * 30);
    p.armRZ += (1.3 + 0.3 * flap) * b;
    p.armLZ += (1.3 + 0.3 * flap) * b;
    p.armRX -= 0.3 * b;
    p.armLX -= 0.3 * b;
    p.lift += 0.05 * b;
    p.legRX += 0.3 * b;
    p.legLX -= 0.2 * b;
    p.extraX -= 0.4 * b;
  },
  face: (c, out) => {
    if (c.u < 0.6) face(out, "charging", null);
  },
  impulse: () => 0.6,
};

/** Pip pops up from a belly slide. */
const slidePop: ClipDef = {
  strength: 0.5,
  duration: () => 0.25,
  fadeIn: 0.05,
  fadeOut: 0.5,
  pose(p, c) {
    const b = bump(c.u);
    p.lift += 0.1 * b;
    p.crouch += 0.12 * b;
    p.armRZ += 0.8 * b;
    p.armLZ += 0.8 * b;
  },
  face: (_c, out) => face(out, "happy", null),
  impulse: () => 1.6,
};

/** Gruff's headbutt recoil. */
const headbuttStop: ClipDef = {
  strength: 0.5,
  duration: () => 0.18,
  fadeIn: 0.05,
  fadeOut: 0.5,
  pose(p, c) {
    const b = bump(c.u);
    p.leanX -= 0.15 * b;
    p.headX -= 0.2 * b;
    p.armRZ += 0.4 * b;
    p.armLZ += 0.4 * b;
  },
  face: (c, out) => {
    if (c.u < 0.5) face(out, "hurt", null);
  },
  impulse: () => -1.2,
};

/* ------------------------------------------------------------- fidgets */

/** Fidget variants per animal (index = ClipContext.variant). */
export const FIDGETS: Readonly<Record<CharacterId, ReadonlyArray<{ name: string; sec: number }>>> = {
  quacky: [
    { name: "preen", sec: 1.2 },
    { name: "hatAdjust", sec: 0.9 },
    { name: "flapHop", sec: 0.6 },
  ],
  hopsworth: [
    { name: "bowTie", sec: 1.0 },
    { name: "croak", sec: 0.8 },
    { name: "bulbBlink", sec: 0.5 },
  ],
  mochi: [
    { name: "nodOff", sec: 2.2 },
    { name: "bellyScratch", sec: 1.2 },
    { name: "yawn", sec: 1.4 },
  ],
  whiskers: [
    { name: "earFlick", sec: 0.3 },
    { name: "pawLick", sec: 1.4 },
    { name: "slowBlink", sec: 0.8 },
  ],
  pip: [
    { name: "happyFeet", sec: 1.0 },
    { name: "flipperFlap", sec: 0.7 },
    { name: "scarfToss", sec: 0.6 },
  ],
  gruff: [
    { name: "hoofScrape", sec: 1.0 },
    { name: "headToss", sec: 0.7 },
  ],
};

function fidgetPose(p: Pose, c: ClipContext): void {
  const u = c.u;
  const t = c.t;
  const b = bump(u);
  const name = FIDGETS[c.character][c.variant]?.name;
  switch (name) {
    case "preen":
      // Head to the wing, nibbling.
      p.headY += 0.9 * b;
      p.headX += 0.35 * b;
      p.armRZ += 0.5 * b;
      p.armRX -= 0.3 * b;
      p.jaw = Math.max(p.jaw, 0.4 * b * (0.5 + 0.5 * Math.sin(t * 30)));
      break;
    case "hatAdjust":
      p.armRX = 2.6 * b;
      p.armRZ = 0.4 + 0.2 * Math.sin(t * 20) * b;
      p.headZ -= 0.15 * b;
      break;
    case "flapHop": {
      const hop = bump(u / 0.7);
      const flap = Math.sin(t * 36);
      p.lift += 0.12 * hop;
      p.armRZ += (0.8 + 0.5 * flap) * hop;
      p.armLZ += (0.8 + 0.5 * flap) * hop;
      p.legRX += 0.3 * hop;
      break;
    }
    case "bowTie":
      p.armRX = 1.9 * b;
      p.armLX = 1.9 * b;
      p.armRZ = -0.35 * b;
      p.armLZ = -0.35 * b;
      p.headX -= 0.2 * b;
      p.headZ += 0.08 * Math.sin(t * 14) * b;
      break;
    case "croak": {
      const pulse = Math.max(0, Math.sin(u * TAU * 2));
      p.sac = Math.max(p.sac, 1.0 * pulse);
      p.headX -= 0.1 * pulse;
      break;
    }
    case "bulbBlink":
      p.bulbs -= 0.5 * bump(u / 0.5);
      p.headZ += 0.1 * b;
      break;
    case "nodOff": {
      // Head droops, then snaps awake with an ear pop.
      const droop = u < 0.73 ? easeInOut(u / 0.73) : 1 - easeOutBack((u - 0.73) / 0.12);
      p.headX += 0.5 * droop;
      p.crouch -= 0.05 * droop;
      p.armRZ -= 0.08 * droop;
      p.armLZ -= 0.08 * droop;
      p.ears += u > 0.73 ? 0.6 * bump((u - 0.73) / 0.2) : 0;
      break;
    }
    case "bellyScratch":
      p.armRX = 0.6 * b;
      p.armRZ = -0.25 * b;
      p.armRY = 0.4 * Math.sin(t * 18) * b;
      p.headX += 0.2 * b;
      p.belly += 0.04 * Math.sin(t * 18) * b;
      break;
    case "yawn":
      p.armRX = 2.8 * b;
      p.armLX = 2.8 * b;
      p.armRZ = 0.3;
      p.armLZ = 0.3;
      p.headX -= 0.3 * b;
      p.crouch += 0.08 * b;
      p.belly += 0.08 * b;
      break;
    case "earFlick":
      if (c.side > 0) p.earR += 0.6 * bump(u);
      else p.earL += 0.6 * bump(u);
      break;
    case "pawLick":
      p.armRX = 2.3 * b;
      p.armRZ = -0.25 * b;
      p.headX += 0.3 * b;
      p.headY -= 0.15 * b;
      p.headZ += 0.08 * Math.sin(t * 12) * b;
      break;
    case "slowBlink":
      p.headZ += 0.1 * b;
      break;
    case "happyFeet": {
      const tap = Math.sin(t * TAU * 6);
      p.legRLift += 0.05 * Math.max(0, tap) * b;
      p.legLLift += 0.05 * Math.max(0, -tap) * b;
      p.roll += 0.08 * tap * b;
      break;
    }
    case "flipperFlap": {
      const flap = Math.sin(t * 30);
      p.armRZ += (0.6 + 0.4 * flap) * b;
      p.armLZ += (0.6 + 0.4 * flap) * b;
      break;
    }
    case "scarfToss":
      p.headY += 0.5 * bump(u / 0.5) - 0.2 * bump((u - 0.5) / 0.5);
      p.headX -= 0.15 * b;
      break;
    case "hoofScrape": {
      const scuff = Math.sin(u * TAU * 2);
      p.legLX -= 0.5 * Math.max(0, scuff);
      p.legLLift += 0.04 * Math.max(0, scuff);
      p.headX += 0.2 * b;
      break;
    }
    case "headToss":
      p.headZ += 0.4 * Math.sin(u * TAU * 1.5) * (1 - u);
      p.headX -= 0.2 * b;
      break;
    default:
      break;
  }
}

const fidgetClip: ClipDef = {
  strength: 0.5,
  duration: (c) => FIDGETS[c.character][c.variant]?.sec ?? 1,
  fadeIn: 0.15,
  fadeOut: 0.25,
  pose: fidgetPose,
  face(c, out) {
    const name = FIDGETS[c.character][c.variant]?.name;
    switch (name) {
      case "nodOff":
        if (c.u > 0.3 && c.u < 0.73) face(out, "blink", null);
        return;
      case "yawn":
        face(out, c.u > 0.2 && c.u < 0.8 ? "blink" : null, c.u > 0.2 && c.u < 0.8 ? "happy" : null);
        return;
      case "slowBlink":
        if (c.u > 0.25 && c.u < 0.75) face(out, "blink", null);
        return;
      case "preen":
      case "pawLick":
        if (c.u > 0.2 && c.u < 0.8) face(out, "happy", null);
        return;
      default:
        return;
    }
  },
  impulse: () => 0,
  kick(c, s, yaw) {
    switch (FIDGETS[c.character][c.variant]?.name) {
      case "hatAdjust":
        s.kick("ribbon", 0, 1.5, 0.5, yaw);
        s.kick("hat", 0.4, 0.4, 0, yaw);
        return;
      case "scarfToss":
        s.kick("scarf", 1.5, 2, 0, yaw);
        return;
      case "headToss":
        s.kick("bell", 1.8, 0, 0, yaw);
        s.kick("ear", 0, 1.5, 0, yaw);
        return;
      case "croak":
        s.kick("sac", 0, 1.5, 0, yaw);
        return;
      default:
        return;
    }
  },
};

/* ============================================================= registry */

export const CLIPS: Record<AnimTrigger, ClipDef> = {
  throw: throwClip,
  catch: catchHug,
  whiff: whiffClip,
  hit: hitReact,
  land,
  pickup,
  ability: abilityClip,
  slam,
  emote: emoteClip,
  victory,
  ko,
  ringOut,
};

export const INTERNAL_CLIPS: Record<InternalClip, ClipDef> = {
  getUp,
  rollPop,
  airBrake,
  slidePop,
  headbuttStop,
  fidget: fidgetClip,
};

/** Clips that take over the whole body: starting one stops the others in this set. */
export const EXCLUSIVE_CLIPS: ReadonlySet<ClipName> = new Set<ClipName>(["throw", "catch", "emote", "victory", "ko", "ringOut"]);

/** Beak opening per mouth expression (duck / penguin have no mouth band; the jaw shows the mood). */
export const BEAK_JAW: Readonly<Partial<Record<string, number>>> = {
  happy: 0.5,
  hurt: 0.7,
  angry: 0.2,
  charging: 0.15,
  dizzy: 0.3,
  ko: 0.6,
};

export function isBeaked(character: CharacterId): boolean {
  return BEAKED.has(character);
}

export function isWinged(character: CharacterId): boolean {
  return WINGED.has(character);
}
