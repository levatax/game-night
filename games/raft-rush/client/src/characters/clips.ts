// One-shot animation clips layered over the continuous state (throws, catches, hits, eating, fishing casts,
// downed / revived / washed / respawn, the six emotes, the puffer "inflate", boarding and the podium cheer).
// Owner: client-characters. Adapted from games/bonk-brawl/client/src/characters/clips.ts.

import { EMOTES } from "../../../shared/constants";
import type { CharacterId, EmoteId, InvKind } from "../../../shared/types";
import type { CharacterTrigger, TriggerOptions } from "./Characters";
import { holdClass } from "./holds";
import { bump, easeInOut, easeOutBack, easeOutCubic, type FaceExpression, type Pose, seg } from "./pose";

const TAU = Math.PI * 2;

/** What a clip sees while it plays. */
export interface ClipContext {
  /** 0..1 progress, seconds since start, total length. */
  u: number;
  t: number;
  duration: number;
  character: CharacterId;
  opts: TriggerOptions;
  /** Item in the hand when the clip started. */
  held: InvKind;
  /** +1 / −1: flinch side chosen when the clip started (from the hit direction). */
  side: number;
}

/** Temporary prop a clip shows in a hand. */
export type ClipProp = "food" | "phone" | null;

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
  /** The held item is gone (thrown / tossed) from this progress on, until the clip ends. */
  releaseAt?: number;
  /** A prop shown in the right hand while the clip plays. */
  prop?(c: ClipContext): ClipProp;
}

/* ============================================================== combat */

const throwClip: ClipDef = {
  duration: () => 0.48,
  fadeIn: 0.04,
  fadeOut: 0.35,
  releaseAt: 0.18,
  pose(p, c) {
    const whip = easeOutCubic(c.u / 0.38);
    if (c.held !== "" && holdClass(c.held) === "big") {
      // Two-handed heave from over the head.
      p.armRX = 2.8 - 1.6 * whip;
      p.armLX = 2.8 - 1.6 * whip;
      p.armRZ = 0.3;
      p.armLZ = 0.3;
      p.leanX += 0.3 * bump(c.u / 0.7);
      p.bend += 0.3 * bump(c.u / 0.7);
      return;
    }
    // Overhand: the arm passes straight up (−π) to forward (−1.5π) and follows through low.
    p.armRX = -2.1 - 3.25 * whip;
    p.armRZ = 0.3 - 0.35 * whip;
    p.armRY = 0.2;
    p.armLX = 1.1 - 1.7 * whip;
    p.armLZ = 0.35;
    p.twist = 0.5 - 1.0 * whip;
    p.leanX += 0.26 * bump(c.u / 0.7);
    p.bend += 0.2 * bump(c.u / 0.7);
    p.legLX = 0.45 * whip;
    p.legRX = -0.45 * whip;
    p.headX += 0.12 * whip;
    p.extraX += 0.4 * bump(c.u);
    p.aim = 1 - whip;
  },
  face: (c) => (c.u < 0.55 ? "effort" : null),
  impulse: () => 1.2,
};

const toss: ClipDef = {
  duration: () => 0.42,
  fadeIn: 0.06,
  fadeOut: 0.35,
  releaseAt: 0.4,
  pose(p, c) {
    // Underhand lob: back low, then up and forward.
    const k = c.u < 0.3 ? -easeOutCubic(c.u / 0.3) : -1 + 2.6 * easeOutCubic((c.u - 0.3) / 0.45);
    p.armRX = 0.9 * k + 0.1;
    p.armRZ = 0.2;
    p.armLZ += 0.2;
    p.leanX += 0.1 * bump(c.u);
    p.lift += 0.03 * bump(c.u);
  },
  face: () => null,
  impulse: () => 0.6,
};

const useClip: ClipDef = {
  duration: (o) => (o.item === "torch" ? 0.5 : 0.36),
  fadeIn: 0.05,
  fadeOut: 0.35,
  pose(p, c) {
    if (c.held === "torch") {
      // Sweeping torch swing, right to left in front.
      const s = easeInOut(c.u / 0.8);
      p.armRX = 1.5;
      p.armRZ = 0.9 - 1.5 * s;
      p.armRY = -0.4;
      p.twist = 0.35 - 0.7 * s;
      p.leanX += 0.08;
      p.aim = 0.3;
      return;
    }
    // Jab / slap at a palm trunk.
    const jab = c.u < 0.35 ? easeOutCubic(c.u / 0.35) : 1 - easeInOut((c.u - 0.35) / 0.65);
    p.armRX = 0.4 + 1.3 * jab;
    p.armRZ = 0.15;
    p.twist = -0.35 * jab;
    p.leanX += 0.1 * jab;
  },
  face: (c) => (c.u < 0.5 ? "effort" : null),
  impulse: () => 0.8,
};

const gatherPop: ClipDef = {
  duration: () => 0.34,
  fadeIn: 0.1,
  fadeOut: 0.4,
  pose(p, c) {
    const b = bump(c.u);
    p.lift += 0.04 * b;
    p.leanX -= 0.08 * b;
    p.armLZ += 0.3 * b;
  },
  face: () => "happy",
  impulse: () => 1,
};

const eat: ClipDef = {
  duration: () => 0.95,
  fadeIn: 0.12,
  fadeOut: 0.25,
  pose(p, c) {
    // Food to the mouth, three chomps.
    const chomp = Math.abs(Math.sin(c.t * 15));
    p.armRX = 2.15;
    p.armRZ = -0.35;
    p.armRY = 0.5;
    p.headX += 0.1 + 0.08 * chomp;
    p.crouch += 0.02 * chomp;
  },
  face: (c) => (c.u > 0.82 ? "happy" : "chew"),
  impulse: () => 0.5,
  prop: () => "food",
};

const catchHug: ClipDef = {
  duration: () => 0.7,
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
    p.leanX -= 0.2 * bump(c.u / 0.6);
    p.lift += 0.1 * bump(c.u / 0.4);
    p.headX += 0.25;
  },
  face: () => "happy",
  impulse: () => -2.4,
};

const hitReact: ClipDef = {
  duration: () => 0.5,
  fadeIn: 0,
  fadeOut: 0.3,
  pose(p, c) {
    const b = bump(c.u / 0.5);
    p.leanX -= 0.32 * b;
    p.leanZ += 0.18 * c.side * b;
    p.headX -= 0.35 * b;
    p.turn += 0.4 * c.side * b;
    p.armRZ += 1.1 * bump(c.u / 0.8);
    p.armLZ += 1.1 * bump(c.u / 0.8);
    p.armRX += 0.4 * bump(c.u / 0.8);
    p.armLX += 0.4 * bump(c.u / 0.8);
    p.extraX += 0.5 * b;
  },
  face: () => "hurt",
  impulse: () => -2.6,
};

const land: ClipDef = {
  duration: () => 0.28,
  fadeIn: 0.05,
  fadeOut: 0.6,
  pose(p, c) {
    const b = bump(c.u);
    p.armRZ += 0.45 * b;
    p.armLZ += 0.45 * b;
    p.headX += 0.1 * b;
    p.legRZ += 0.1 * b;
    p.legLZ += 0.1 * b;
    p.extraX += 0.3 * b;
  },
  face: () => null,
  impulse: () => -3.2,
};

/* ========================================================= life events */

const downedClip: ClipDef = {
  duration: () => 0.55,
  fadeIn: 0,
  fadeOut: 0.5,
  pose(p, c) {
    // Knees buckle, arms flail, then the belly flop (the downed state takes over).
    const b = bump(c.u);
    p.armRZ += 1.2 * b;
    p.armLZ += 1.2 * b;
    p.armRX += 0.8 * Math.sin(c.t * 22) * b;
    p.armLX -= 0.8 * Math.sin(c.t * 22) * b;
    p.crouch -= 0.15 * b;
  },
  face: () => "hurt",
  impulse: () => -3,
};

const revived: ClipDef = {
  duration: () => 0.8,
  fadeIn: 0.05,
  fadeOut: 0.3,
  pose(p, c) {
    // Spring up, arms high: "I'm alive!"
    const up = easeOutBack(seg(c.u, 0, 0.35));
    p.lift += 0.18 * bump(c.u / 0.6);
    p.armRX = 2.7 * up;
    p.armLX = 2.7 * up;
    p.armRZ = 0.4;
    p.armLZ = 0.4;
    p.legRX += 0.4 * bump(c.u / 0.5);
  },
  face: () => "happy",
  impulse: () => 2,
};

const washed: ClipDef = {
  duration: () => 0.9,
  fadeIn: 0.05,
  fadeOut: 0,
  pose(p, c) {
    // Swept away: twirl, sink, flail.
    p.spinY += TAU * 1.5 * easeInOut(c.u);
    p.lift -= 1.4 * easeInOut(c.u);
    p.armRZ = 2.2 + 0.4 * Math.sin(c.t * 20);
    p.armLZ = 2.2 + 0.4 * Math.sin(c.t * 18);
  },
  face: () => "panic",
  impulse: () => 0,
};

const respawn: ClipDef = {
  duration: () => 1.5,
  fadeIn: 0,
  fadeOut: 0.2,
  pose(p, c) {
    // Pop up out of the sand, then a big stretch and yawn.
    const pop = easeOutBack(seg(c.u, 0, 0.25));
    p.size += -0.95 * (1 - pop);
    const stretch = bump(seg(c.u, 0.3, 1));
    p.armRX += 2.9 * stretch;
    p.armLX += 2.9 * stretch;
    p.armRZ += 0.2 * stretch;
    p.armLZ += 0.2 * stretch;
    p.leanX -= 0.12 * stretch;
    p.headX -= 0.3 * stretch;
    p.crouch += 0.08 * stretch;
  },
  face: (c) => (c.u < 0.3 ? "blink" : c.u < 0.85 ? "tired" : "happy"),
  impulse: () => 1.5,
};

const board: ClipDef = {
  duration: () => 0.55,
  fadeIn: 0.04,
  fadeOut: 0.4,
  pose(p, c) {
    const b = bump(c.u);
    p.lift += 0.35 * b;
    p.legRX += 1.0 * b;
    p.legLX += 0.8 * b;
    p.armRZ += 0.9 * b;
    p.armLZ += 0.9 * b;
  },
  face: () => "happy",
  impulse: () => 2,
};

const cheer: ClipDef = {
  duration: () => 3.2,
  fadeIn: 0.04,
  fadeOut: 0.06,
  pose(p, c) {
    const hops = 5;
    const hopU = (c.u * hops) % 1;
    const hopIndex = Math.floor(c.u * hops);
    const pump = Math.sin(c.u * TAU * hops);
    p.lift += 0.3 * bump(hopU);
    p.crouch += 0.12 * bump(hopU) - 0.1 * (1 - bump(hopU));
    p.armRX = 2.55 + 0.4 * pump;
    p.armLX = 2.55 - 0.4 * pump;
    p.armRZ = 0.45;
    p.armLZ = 0.45;
    p.legRX += 0.5 * bump(hopU);
    p.legLX -= 0.3 * bump(hopU);
    p.headX -= 0.2;
    p.extraX += 0.4 * bump(hopU);
    if (hopIndex % 2 === 1) p.spinY += TAU * easeInOut(hopU);
  },
  face: () => "happy",
  impulse: () => 1.5,
};

/** Puffer exploded in hand: blown up like a beach ball for two seconds. */
const inflate: ClipDef = {
  duration: () => 2.2,
  fadeIn: 0.02,
  fadeOut: 0.15,
  pose(p, c) {
    const blow = easeOutBack(seg(c.u, 0, 0.12));
    const wobble = 0.08 * Math.sin(c.t * 16) * (1 - c.u);
    p.puff += 0.95 * blow + wobble;
    p.size += 0.08 * blow;
    p.lift += 0.1 * blow + 0.06 * Math.sin(c.t * 5);
    p.armRZ = 1.25 + 0.15 * Math.sin(c.t * 9);
    p.armLZ = 1.25 + 0.15 * Math.sin(c.t * 9 + 1);
    p.armRX = 0.2;
    p.armLX = 0.2;
    p.legRZ += 0.35 * blow;
    p.legLZ += 0.35 * blow;
  },
  face: (c) => (c.u < 0.85 ? "panic" : "dizzy"),
  impulse: () => 3,
};

const cast: ClipDef = {
  duration: () => 0.62,
  fadeIn: 0.05,
  fadeOut: 0.3,
  pose(p, c) {
    // Rod back over the shoulder, then the forward flick.
    const back = easeOutCubic(seg(c.u, 0, 0.35));
    const flick = easeOutCubic(seg(c.u, 0.35, 0.6));
    p.armRX = 0.9 + 1.9 * back - 2.0 * flick;
    p.armRZ = 0.15;
    p.armLX = 0.6;
    p.twist += 0.3 * back - 0.4 * flick;
    p.leanX += -0.1 * back + 0.2 * flick;
    p.aim = 0.2;
  },
  face: (c) => (c.u < 0.6 ? "effort" : null),
  impulse: () => 0.8,
};

const reel: ClipDef = {
  duration: () => 0.55,
  fadeIn: 0.04,
  fadeOut: 0.35,
  pose(p, c) {
    // Strike! Rod yanked up, lean back.
    const yank = easeOutBack(seg(c.u, 0, 0.3));
    p.armRX = 0.9 + 1.2 * yank;
    p.armLX = 0.9 + 0.9 * yank;
    p.leanX -= 0.22 * bump(c.u);
    p.lift += 0.05 * bump(c.u);
    p.aim = 0.4;
  },
  face: () => "happy",
  impulse: () => 1.4,
};

/* =============================================================== emotes */

function clap(p: Pose, c: ClipContext): void {
  const k = Math.sin(c.t * 30);
  p.armRX = 1.3;
  p.armLX = 1.3;
  p.armRZ = -0.18 + 0.32 * Math.max(0, k);
  p.armLZ = -0.18 + 0.32 * Math.max(0, k);
  p.armRY = 0.5;
  p.armLY = 0.5;
  p.lift += 0.02 * Math.abs(k);
  p.headZ += 0.08 * Math.sin(c.t * 6);
}

function panic(p: Pose, c: ClipContext): void {
  const f = Math.sin(c.t * 24);
  p.armRX = 2.8 + 0.35 * f;
  p.armLX = 2.8 - 0.35 * f;
  p.armRZ = 0.5 + 0.3 * Math.sin(c.t * 19);
  p.armLZ = 0.5 + 0.3 * Math.sin(c.t * 21);
  p.legRX += 0.7 * Math.max(0, Math.sin(c.t * 16));
  p.legLX += 0.7 * Math.max(0, -Math.sin(c.t * 16));
  p.lift += 0.05 * Math.abs(Math.sin(c.t * 16));
  p.headY += 0.35 * Math.sin(c.t * 13);
  p.extraX += 0.4 * f;
}

function dance(p: Pose, c: ClipContext): void {
  // Disco: hip sway and the arm pointing up / down, finished with a twirl.
  const beat = c.u * TAU * 4;
  const s = Math.sin(beat);
  p.leanZ += 0.16 * s;
  p.roll += 0.1 * s;
  p.lift += 0.06 * Math.abs(s);
  p.crouch += 0.05 * Math.abs(Math.cos(beat));
  const up = s > 0 ? 1 : 0;
  p.armRX = up ? 2.7 : 0.6;
  p.armRZ = up ? 0.6 : -0.1;
  p.armLZ = 0.6;
  p.armLX = 0.7;
  p.headZ -= 0.18 * s;
  p.legRX += 0.4 * Math.max(0, s);
  p.legLX += 0.4 * Math.max(0, -s);
  p.extraY += 0.4 * s;
  p.spinY += TAU * easeInOut((c.u - 0.72) / 0.24);
}

function tired(p: Pose, c: ClipContext): void {
  const sigh = bump(seg(c.u, 0.15, 0.65));
  p.bend += 0.45 + 0.1 * sigh;
  p.leanX += 0.1;
  p.crouch -= 0.1 + 0.05 * sigh;
  p.headX += 0.45;
  p.armRX = -0.05;
  p.armLX = -0.05;
  p.armRZ = 0.02;
  p.armLZ = 0.02;
  p.lift -= 0.04 * sigh;
}

function shush(p: Pose, c: ClipContext): void {
  // Finger to the lips, lean in.
  const up = easeOutBack(seg(c.u, 0, 0.2));
  p.armRX = 2.05 * up;
  p.armRZ = 0.12 - 0.62 * up;
  p.armRY = 0.4 * up;
  p.leanX += 0.12 * up;
  p.headX += 0.08 * up;
  p.headZ += 0.08 * Math.sin(c.t * 3);
}

function selfie(p: Pose, c: ClipContext): void {
  const up = easeOutBack(seg(c.u, 0, 0.2));
  const hip = 0.12 * up;
  p.leanZ -= hip;
  p.headZ += 0.22 * up;
  p.headY += 0.1 * up;
  if (c.character === "fenomen") {
    // Stick high, peace sign by the cheek.
    p.armLX = 2.25 * up;
    p.armLZ = 0.35;
    p.armRX = 2.0 * up;
    p.armRZ = -0.35 * up;
    p.armRY = 0.4;
  } else {
    // Phone at arm's length, the other hand flashes a peace sign.
    p.armRX = 2.2 * up;
    p.armRZ = 0.3;
    p.armLX = 2.0 * up;
    p.armLZ = 0.6 * up;
  }
  p.crouch += 0.03 * Math.sin(c.t * 4);
}

const EMOTE_POSES: Record<EmoteId, (p: Pose, c: ClipContext) => void> = { clap, panic, dance, tired, shush, selfie };
const EMOTE_FACES: Record<EmoteId, FaceExpression> = {
  clap: "happy",
  panic: "panic",
  dance: "happy",
  tired: "tired",
  shush: "shush",
  selfie: "happy",
};

const emoteClip: ClipDef = {
  duration: (o) => EMOTES[o.emote ?? "clap"].durationSec,
  fadeIn: 0.1,
  fadeOut: 0.16,
  pose(p, c) {
    EMOTE_POSES[c.opts.emote ?? "clap"](p, c);
  },
  face: (c) => EMOTE_FACES[c.opts.emote ?? "clap"],
  impulse: (o) => (o.emote === "tired" ? -1 : 0.8),
  prop: (c) => (c.opts.emote === "selfie" && c.character !== "fenomen" ? "phone" : null),
};

export const CLIPS: Record<CharacterTrigger, ClipDef> = {
  throw: throwClip,
  toss,
  use: useClip,
  gather: gatherPop,
  eat,
  catch: catchHug,
  hit: hitReact,
  downed: downedClip,
  revived,
  washed,
  respawn,
  land,
  cast,
  reel,
  emote: emoteClip,
  board,
  cheer,
  inflate,
};

/** Clips that take over the whole body: starting one stops the others in this set. */
export const EXCLUSIVE_CLIPS: ReadonlySet<CharacterTrigger> = new Set<CharacterTrigger>([
  "throw",
  "toss",
  "use",
  "eat",
  "catch",
  "emote",
  "cheer",
  "cast",
  "reel",
  "revived",
  "respawn",
  "board",
  "washed",
]);

/** Selfie flash moment (ring light / phone flash) as clip progress. */
export const SELFIE_FLASH_U = 0.55;
