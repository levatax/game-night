// One-shot animation clips layered over the continuous state. Owner: client-characters.

import { EMOTES } from "../../../shared/constants";
import type { AbilityId, CharacterId, EmoteId } from "../../../shared/types";
import { bump, clamp01, easeInOut, easeOutBack, easeOutCubic, type Pose } from "./pose";
import type { AnimTrigger, FaceExpression, TriggerOptions } from "./types";

const TAU = Math.PI * 2;

/** What a clip sees while it plays. */
export interface ClipContext {
  /** 0..1 progress. */
  u: number;
  /** Seconds since the clip started. */
  t: number;
  duration: number;
  character: CharacterId;
  ability: AbilityId;
  opts: TriggerOptions;
  /** +1 / -1: spin direction chosen when the clip started (from the hit direction). */
  side: number;
}

export interface ClipDef {
  duration(opts: TriggerOptions, character: CharacterId): number;
  /** Fade-in / fade-out as fractions of the duration. */
  fadeIn: number;
  fadeOut: number;
  /** Writes the clip pose into `p`, which starts as a copy of the pose underneath. */
  pose(p: Pose, c: ClipContext): void;
  face(c: ClipContext): FaceExpression | null;
  /** Squash-spring impulse when the clip starts (< 0 squash, > 0 stretch). */
  impulse(opts: TriggerOptions): number;
}

const WINGED: ReadonlySet<CharacterId> = new Set<CharacterId>(["quacky", "pip"]);
/** Characters whose mouth is a beak on a jaw pivot (the sprite has no mouth). */
const BEAKED: ReadonlySet<CharacterId> = new Set<CharacterId>(["quacky", "pip"]);

const strengthOf = (opts: TriggerOptions, fallback: number): number => clamp01(opts.strength ?? fallback);

/* ============================================================== combat */

const throwClip: ClipDef = {
  duration: (o) => 0.38 + 0.12 * strengthOf(o, 0.5),
  fadeIn: 0.04,
  fadeOut: 0.35,
  pose(p, c) {
    const k = 0.75 + 0.35 * strengthOf(c.opts, 0.5);
    const whip = easeOutCubic(c.u / 0.38);
    // Overhand: the arm passes straight up (-π) to forward (-1.5π) and follows through low.
    p.armRX = -2.1 - 3.25 * whip;
    p.armRZ = 0.3 - 0.35 * whip;
    p.armRY = 0.2;
    p.armLX = 1.1 - 1.7 * whip;
    p.armLZ = 0.35;
    p.twist = 0.5 - 1.0 * whip * k;
    p.leanX += 0.28 * bump(c.u / 0.7) * k;
    p.bend += 0.2 * bump(c.u / 0.7) * k;
    p.legLX = 0.45 * whip;
    p.legRX = -0.45 * whip;
    p.headX += 0.12 * whip;
    p.ears -= 0.3 * bump(c.u);
    p.extraX += 0.4 * bump(c.u);
  },
  face: (c) => (c.u < 0.55 ? "angry" : null),
  impulse: (o) => 0.9 + 0.8 * strengthOf(o, 0.5),
};

const catchHug: ClipDef = {
  duration: () => 0.75,
  fadeIn: 0.06,
  fadeOut: 0.3,
  pose(p, c) {
    const grab = easeOutBack(c.u / 0.25);
    p.armRX = 1.25;
    p.armLX = 1.25;
    p.armRZ = 0.9 - 1.35 * grab;
    p.armLZ = 0.9 - 1.35 * grab;
    p.armRY = 0.3;
    p.armLY = 0.3;
    p.leanX -= 0.22 * bump(c.u / 0.6);
    p.lift += 0.12 * bump(c.u / 0.4);
    p.headX += 0.28;
    p.headZ += 0.15 * Math.sin(c.u * TAU * 1.5);
    p.twist += 0.22 * Math.sin(c.u * TAU * 1.5);
    p.ears -= 0.3;
    p.extraY += 0.5 * Math.sin(c.u * TAU * 3);
  },
  face: () => "happy",
  impulse: () => -2.6,
};

const whiffFlinch: ClipDef = {
  duration: () => 0.3,
  fadeIn: 0.05,
  fadeOut: 0.5,
  pose(p, c) {
    p.headX -= 0.2 * bump(c.u);
    p.leanX -= 0.1 * bump(c.u);
  },
  face: () => "hurt",
  impulse: () => -1.6,
};

const hitReact: ClipDef = {
  duration: () => 0.6,
  fadeIn: 0,
  fadeOut: 0.2,
  pose(p, c) {
    const k = 0.7 + 0.3 * strengthOf(c.opts, 0.8);
    p.spinY += c.side * TAU * easeOutCubic(c.u / 0.65);
    p.leanX -= 0.3 * bump(c.u / 0.45) * k;
    p.headX -= 0.35 * bump(c.u / 0.5);
    p.armRZ += 1.3 * bump(c.u / 0.8) * k;
    p.armLZ += 1.3 * bump(c.u / 0.8) * k;
    p.armRX += 0.4 * bump(c.u / 0.8);
    p.armLX += 0.4 * bump(c.u / 0.8);
    p.ears += 0.6 * bump(c.u);
    p.extraX += 0.5 * bump(c.u);
  },
  face: (c) => (c.u < 0.4 ? "hurt" : "dizzy"),
  impulse: (o) => -2.2 - 1.5 * strengthOf(o, 0.8),
};

const land: ClipDef = {
  duration: (o) => 0.22 + 0.12 * strengthOf(o, 0.5),
  fadeIn: 0.05,
  fadeOut: 0.6,
  pose(p, c) {
    const k = strengthOf(c.opts, 0.5);
    const b = bump(c.u);
    p.armRZ += (0.25 + 0.5 * k) * b;
    p.armLZ += (0.25 + 0.5 * k) * b;
    p.headX += 0.12 * k * b;
    p.ears += 0.5 * k * b;
    p.legRZ += 0.12 * k * b;
    p.legLZ += 0.12 * k * b;
  },
  face: (c) => (strengthOf(c.opts, 0.5) > 0.7 && c.u < 0.5 ? "hurt" : null),
  impulse: (o) => -(1.6 + 3.4 * strengthOf(o, 0.5)),
};

const pickup: ClipDef = {
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
  face: (c) => (c.u > 0.45 ? "happy" : null),
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
      // Belly "boing": a big jiggle (also used when a ball bounces off).
      p.belly += 0.35 * Math.sin(c.u * TAU * 2) * (1 - c.u);
      p.armRZ += 0.4 * b;
      p.armLZ += 0.4 * b;
      return;
    case "curveball": {
      // Smug flourish: paw twirl at the chin, tail curl, head cocked.
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
  duration: (_o, character) => (character === "whiskers" ? 0.9 : 0.45),
  fadeIn: 0.12,
  fadeOut: 0.3,
  pose: abilityFlourish,
  face: (c) => (c.ability === "curveball" ? (c.u < 0.85 ? "happy" : null) : null),
  impulse: () => 1.4,
};

const slam: ClipDef = {
  duration: () => 0.5,
  fadeIn: 0.04,
  fadeOut: 0.45,
  pose(p, c) {
    const b = bump(c.u);
    p.armRX = 0.3;
    p.armLX = 0.3;
    p.armRZ += 1.4 * b;
    p.armLZ += 1.4 * b;
    p.legRZ += 0.45 * b;
    p.legLZ += 0.45 * b;
    p.crouch -= 0.2 * b;
    p.headX -= 0.15 * b;
    p.ears += 0.8 * b;
    p.sac = 0.9 * b;
  },
  face: (c) => (c.u < 0.6 ? "angry" : null),
  impulse: () => -5,
};

/* =============================================================== emotes */

function honk(p: Pose, c: ClipContext): void {
  const windUp = bump(c.u / 0.35);
  const blast = c.u > 0.3 ? bump((c.u - 0.3) / 0.7) : 0;
  p.headX -= 0.45 * windUp - 0.2 * blast;
  p.leanX -= 0.15 * windUp - 0.12 * blast;
  p.crouch += 0.12 * blast;
  p.lift += 0.06 * blast;
  if (WINGED.has(c.character)) {
    const flap = Math.sin(c.t * 36);
    p.armRZ += (0.9 + 0.5 * flap) * blast;
    p.armLZ += (0.9 + 0.5 * flap) * blast;
  } else {
    p.armRZ += 0.9 * blast;
    p.armLZ += 0.9 * blast;
    p.armRX += 0.6 * blast;
    p.armLX += 0.6 * blast;
  }
  p.jaw = Math.max(p.jaw, blast);
  p.sac = Math.max(p.sac, 1.15 * blast);
  p.belly += 0.12 * blast;
  p.ears += 0.5 * blast;
  p.extraX -= 0.5 * blast;
}

function wave(p: Pose, c: ClipContext): void {
  const up = easeOutBack(c.u / 0.18);
  const waving = Math.sin(c.u * TAU * 3.2);
  p.armRX = 2.55 * up;
  p.armRZ = 0.55 + 0.45 * waving * up;
  p.armRY = 0.2;
  p.armLZ += 0.25;
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
  p.extraY += 0.6 * s;
  p.ears += 0.3 * Math.abs(s);
  // Finish with a twirl.
  p.spinY += TAU * easeInOut((c.u - 0.66) / 0.28);
}

const EMOTE_POSES: Record<EmoteId, (p: Pose, c: ClipContext) => void> = { honk, wave, dance };

const emoteClip: ClipDef = {
  duration: (o) => EMOTES[o.emote ?? "wave"].durationSec,
  fadeIn: 0.1,
  fadeOut: 0.18,
  pose(p, c) {
    EMOTE_POSES[c.opts.emote ?? "wave"](p, c);
  },
  face(c) {
    if (c.opts.emote === "honk" && !BEAKED.has(c.character)) return c.u > 0.3 ? "happy" : null;
    return "happy";
  },
  impulse: (o) => (o.emote === "honk" ? -1 : 0.8),
};

/* ===================================================== victory and KO */

const VICTORY_SEC = 3.2;

const victory: ClipDef = {
  duration: () => VICTORY_SEC,
  fadeIn: 0.04,
  fadeOut: 0.06,
  pose(p, c) {
    const hops = 5;
    const hopU = (c.u * hops) % 1;
    const hopIndex = Math.floor(c.u * hops);
    const pump = Math.sin(c.u * TAU * hops);
    p.lift += 0.32 * bump(hopU);
    p.crouch += 0.14 * bump(hopU) - 0.12 * (1 - bump(hopU));
    p.armRX = 2.55 + 0.4 * pump;
    p.armLX = 2.55 - 0.4 * pump;
    p.armRZ = 0.45;
    p.armLZ = 0.45;
    p.legRX += 0.5 * bump(hopU);
    p.legLX -= 0.3 * bump(hopU);
    p.headX -= 0.2;
    p.headZ += 0.15 * pump;
    p.ears += 0.4 * bump(hopU);
    p.extraY += 0.8 * pump;
    // Every other hop is a full twirl.
    if (hopIndex % 2 === 1) p.spinY += TAU * easeInOut(hopU);
  },
  face: () => "happy",
  impulse: () => 1.5,
};

/** Pop before the body disappears into a puff (the avatar hides the body at the end). */
export const KO_POP_SEC = 0.22;

const ko: ClipDef = {
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
  face: () => "ko",
  impulse: () => 0,
};

/** Falling off the island: tumbling and flailing until out of view. */
const ringOut: ClipDef = {
  duration: () => 1.6,
  fadeIn: 0.05,
  fadeOut: 0,
  pose(p, c) {
    p.pitch = -c.t * 9;
    p.roll = c.t * 3;
    p.armRZ = 1.5 + 0.4 * Math.sin(c.t * 24);
    p.armLZ = 1.5 + 0.4 * Math.sin(c.t * 22 + 1);
    p.armRX = 0.5 * Math.sin(c.t * 18);
    p.armLX = 0.5 * Math.sin(c.t * 16 + 2);
    p.legRX = 0.7 * Math.sin(c.t * 20);
    p.legLX = -0.7 * Math.sin(c.t * 20);
    p.legRZ = 0.3;
    p.legLZ = 0.3;
    p.ears = 0.6;
  },
  face: () => "hurt",
  impulse: () => 0,
};

export const CLIPS: Record<AnimTrigger, ClipDef> = {
  throw: throwClip,
  catch: catchHug,
  whiff: whiffFlinch,
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

/** Clips that take over the whole body: starting one stops the others in this set. */
export const EXCLUSIVE_CLIPS: ReadonlySet<AnimTrigger> = new Set<AnimTrigger>([
  "throw",
  "catch",
  "emote",
  "victory",
  "ko",
  "ringOut",
]);
