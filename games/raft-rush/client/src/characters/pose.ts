// Pose channels shared by the animation states and one-shot clips, plus easing helpers. Owner:
// client-characters. Adapted from games/bonk-brawl/client/src/characters/pose.ts.
//
// Sign conventions (character space: facing −Z, +X = the character's right):
//   lift / fwd     body offset up / forward (m)
//   turn           whole-body yaw offset, same convention as player yaw (+ = turn left)
//   leanX / leanZ  lean forward / to the right, pivoting at the feet (rad)
//   pitch          pitch forward around the center of mass (crawl, swim, dives)
//   roll           roll to the right around the center of mass (waddle, cartwheels)
//   spinY          twirl around the vertical axis through the center of mass (+ = left)
//   size           uniform scale delta (0 = rest size); puff inflates the torso only (puffer blast)
//   twist / bend   upper body turns right / bows forward at the waist
//   headX/Y/Z      look down / turn right / tilt right
//   arm*X          raise forward (π = straight up), arm*Z raise outward, arm*Y twist
//   leg*X          swing forward, leg*Z spread outward, legYaw turns both legs (+ = left)
//   extraX/Y/Z     the character's extra bone (veil, ponytail, toque, propeller tilt)
//   crouch         squash target (< 0 squash, > 0 stretch)
//   aim            0..1: a held tool turns to point where the body looks (spear wind-up, rod, torch)

export const POSE_KEYS = [
  "lift",
  "fwd",
  "turn",
  "leanX",
  "leanZ",
  "pitch",
  "roll",
  "spinY",
  "size",
  "puff",
  "twist",
  "bend",
  "headX",
  "headY",
  "headZ",
  "armLX",
  "armLY",
  "armLZ",
  "armRX",
  "armRY",
  "armRZ",
  "legLX",
  "legLZ",
  "legRX",
  "legRZ",
  "legYaw",
  "extraX",
  "extraY",
  "extraZ",
  "crouch",
  "aim",
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;

/** Channels that can wind past ±π (flips, twirls, overhand throws): blended along the shortest arc. */
const ANGLE_KEYS: ReadonlySet<PoseKey> = new Set<PoseKey>(["turn", "pitch", "roll", "spinY", "armLX", "armRX"]);
const TAU = Math.PI * 2;

/** Arms hang slightly away from the bean body at rest. */
export const REST_ARM_OUT = 0.12;

export function createPose(): Pose {
  const pose = {} as Pose;
  for (const key of POSE_KEYS) pose[key] = 0;
  return restPose(pose);
}

/** Reset to the rest pose. */
export function restPose(p: Pose): Pose {
  for (const key of POSE_KEYS) p[key] = 0;
  p.armLZ = REST_ARM_OUT;
  p.armRZ = REST_ARM_OUT;
  return p;
}

export function copyPose(dst: Pose, src: Pose): Pose {
  for (const key of POSE_KEYS) dst[key] = src[key];
  return dst;
}

/** Wrap an angle to (−π, π]. */
export function wrapAngle(a: number): number {
  const r = (((a + Math.PI) % TAU) + TAU) % TAU;
  return r - Math.PI;
}

/** dst = lerp(dst, target, t); angle channels take the shortest arc. */
export function lerpPose(dst: Pose, target: Pose, t: number): Pose {
  for (const key of POSE_KEYS) {
    if (ANGLE_KEYS.has(key)) {
      const from = wrapAngle(dst[key]);
      dst[key] = from + wrapAngle(target[key] - from) * t;
    } else {
      dst[key] += (target[key] - dst[key]) * t;
    }
  }
  return dst;
}

/* ============================================================ easing */

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const easeOutCubic = (t: number): number => 1 - Math.pow(1 - clamp01(t), 3);
export const easeInCubic = (t: number): number => Math.pow(clamp01(t), 3);
export const easeInOut = (t: number): number => {
  const x = clamp01(t);
  return x * x * (3 - 2 * x);
};
export const easeOutBack = (t: number): number => {
  const x = clamp01(t) - 1;
  return 1 + 2.4 * x * x * x + 1.4 * x * x;
};
/** 0 → 1 → 0 bump over [0, 1]. */
export const bump = (t: number): number => Math.sin(Math.PI * clamp01(t));
/** Progress of t through [a, b], clamped. */
export const seg = (t: number, a: number, b: number): number => (b <= a ? (t >= b ? 1 : 0) : clamp01((t - a) / (b - a)));
/** Fade-in over `a`, fade-out over the last `b` of a [0, 1] progress. */
export function envelope(u: number, a: number, b: number): number {
  const fadeIn = a > 0 ? easeInOut(u / a) : 1;
  const fadeOut = b > 0 ? easeInOut((1 - u) / b) : 1;
  return Math.min(fadeIn, fadeOut);
}
/** Frame-rate independent exponential approach factor for a rate in 1/s. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);

/* ============================================================== faces */

/** Facial expression of a tourist (meshed eyes + mouth, see Tourist.setFace). */
export type FaceExpression = "idle" | "blink" | "happy" | "effort" | "hurt" | "panic" | "tired" | "dizzy" | "downed" | "shush" | "chew";

/** The continuous face parameters an expression maps to. */
export interface FaceParams {
  /** Eye height scale (0 closed, 1 open, > 1 wide). */
  eyeOpen: number;
  /** Uniform eye size multiplier. */
  eyeSize: number;
  /** 0..1 smile arc; 0..1 open mouth. */
  smile: number;
  jaw: number;
}

export const FACES: Readonly<Record<FaceExpression, FaceParams>> = {
  idle: { eyeOpen: 1, eyeSize: 1, smile: 0.75, jaw: 0 },
  blink: { eyeOpen: 0.08, eyeSize: 1, smile: 0.75, jaw: 0 },
  happy: { eyeOpen: 0.32, eyeSize: 1.05, smile: 1, jaw: 0.4 },
  effort: { eyeOpen: 0.45, eyeSize: 1, smile: 0.1, jaw: 0.22 },
  hurt: { eyeOpen: 0.12, eyeSize: 1, smile: 0, jaw: 0.55 },
  panic: { eyeOpen: 1.3, eyeSize: 1.22, smile: 0, jaw: 0.95 },
  tired: { eyeOpen: 0.45, eyeSize: 0.95, smile: 0, jaw: 0.3 },
  dizzy: { eyeOpen: 0.7, eyeSize: 1, smile: 0, jaw: 0.35 },
  downed: { eyeOpen: 0.22, eyeSize: 1, smile: 0, jaw: 0.45 },
  shush: { eyeOpen: 0.75, eyeSize: 1, smile: 0, jaw: 0 },
  chew: { eyeOpen: 0.55, eyeSize: 1, smile: 0.5, jaw: 0.5 },
};
