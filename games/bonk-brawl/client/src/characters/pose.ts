// Pose channels shared by the animation states and one-shot clips. Owner: client-characters.
//
// Sign conventions (character space: facing -Z, +X = the character's right):
//   lift/fwd       body offset up / forward (m)
//   turn           whole-body yaw offset, same convention as player yaw (+ = turn left)
//   leanX / leanZ  lean forward / to the right, pivoting at the feet (rad)
//   pitch          pitch forward around the center of mass (rolls, belly slide, flap dash)
//   roll           roll to the right around the center of mass (cartwheels)
//   spinY          twirl around the vertical axis through the center of mass (+ = left)
//   size           uniform scale delta (0 = rest size)
//   twist / bend   upper body turns right / bows forward at the waist
//   headX/Y/Z      look down / turn right / tilt right
//   arm*X          raise forward (π = straight up), arm*Z raise outward, arm*Y twist
//   leg*X          swing forward, leg*Z spread outward, legYaw turns both legs (+ = left)
//   extraX/Y/Z     tail / scarf rotation
//   jaw, sac       0..1 beak opening / frog throat sac
//   belly          belly puff (fraction of the rest scale)
//   crouch         squash target (< 0 squash, > 0 stretch)
//   ears           ear flop (rad)

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
  "jaw",
  "sac",
  "belly",
  "crouch",
  "ears",
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;

/**
 * Channels that can wind past ±π (flips, twirls, overhand throws): blended along the shortest
 * arc, so a finished 360° move settles back to rest without unwinding.
 */
const ANGLE_KEYS: ReadonlySet<PoseKey> = new Set<PoseKey>(["turn", "pitch", "roll", "spinY", "armLX", "armRX"]);
const TAU = Math.PI * 2;

/** Arms hang slightly away from the body at rest. */
const REST_ARM_OUT = 0.1;

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

export function zeroPose(p: Pose): Pose {
  for (const key of POSE_KEYS) p[key] = 0;
  return p;
}

/** dst += src · w */
export function addPose(dst: Pose, src: Pose, w: number): Pose {
  for (const key of POSE_KEYS) dst[key] += src[key] * w;
  return dst;
}

/** Wrap an angle to (-π, π]. */
export function wrapAngle(a: number): number {
  const r = (((a + Math.PI) % TAU) + TAU) % TAU;
  return r - Math.PI;
}

/**
 * dst = lerp(dst, target, t). Angle channels take the shortest arc and are re-wrapped, so a
 * finished 360° flip (2π) blends back to 0 without unwinding.
 */
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
/** Fade-in over `a`, fade-out over the last `b` of a [0, 1] progress. */
export function envelope(u: number, a: number, b: number): number {
  const fadeIn = a > 0 ? easeInOut(u / a) : 1;
  const fadeOut = b > 0 ? easeInOut((1 - u) / b) : 1;
  return Math.min(fadeIn, fadeOut);
}
/** Frame-rate independent exponential approach factor for a rate in 1/s. */
export const damp = (rate: number, dt: number): number => 1 - Math.exp(-rate * dt);
