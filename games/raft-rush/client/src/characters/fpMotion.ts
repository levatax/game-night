// Keyframed first-person motion: the clip format the arm rig plays (gestures, charge wind-ups, fidgets), its
// evaluator, and the clip library. A clip has per-hand key tracks; every channel (wrist position, hand rotation,
// finger pose) is interpolated on its own between the keys that set it, starting from the hand's solved state when
// the clip began ("snap") and ending on the live base pose ("base"), so clips start and end seamlessly and blend
// back into the bob / sprint / hold underneath. Keys are authored for the RIGHT hand in camera space at 16:10
// (+x right, +y up, −z forward, m); left-hand tracks are authored mirrored the same way (x → −x, yaw / roll
// negated). Rule of thumb: wind-ups decelerate into a short hang (O), strikes accelerate into contact (I), then a
// hit-stop, then the recovery eases in and out (IO). Owner: client-characters.

import * as THREE from "three";
import { blendPose, HAND_DOF, type HandPose, handPose, type HandPoseName, SHAFT_PSI } from "./fpHand";
import type { V3 } from "./kit";

/* ============================================================ easing */

/** O = ease out (into an apex), I = ease in (into contact), IO = smoothstep, B = out-back (lands with overshoot), L = linear. */
export type Ease = "O" | "I" | "IO" | "B" | "L";

export function ease(e: Ease, u: number): number {
  const x = u < 0 ? 0 : u > 1 ? 1 : u;
  switch (e) {
    case "O":
      return 1 - (1 - x) ** 3;
    case "I":
      return x * x * x;
    case "IO":
      return x * x * (3 - 2 * x);
    case "B": {
      const c = 1.70158;
      return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2;
    }
    case "L":
      return x;
  }
}

/* ============================================================ rotations */

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _eu = new THREE.Euler(0, 0, 0, "YXZ");

/** The fingers of a right fist wrap forward-inward by default. */
export const FINGERS_R: V3 = [-0.55, -0.3, -0.78];

/**
 * Right-hand rotation of a fist whose held axis (the thumb side, hand −X) points along `dir`, the fingers wrapping
 * toward `wrap` (camera space).
 */
export function fistQ(dir: V3, out: THREE.Quaternion, wrap: V3 = FINGERS_R): THREE.Quaternion {
  _x.set(-dir[0], -dir[1], -dir[2]).normalize();
  _z.set(-wrap[0], -wrap[1], -wrap[2]).normalize();
  _z.addScaledVector(_x, -_z.dot(_x));
  if (_z.lengthSq() < 1e-6) _z.set(0, 0, 1).addScaledVector(_x, -_x.z);
  _z.normalize();
  _y.crossVectors(_z, _x).normalize();
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

const SHAFT_FIX = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), SHAFT_PSI);

/**
 * Right-hand rotation of a fist holding a shaft that points along `dir` (camera space): like fistQ, turned so the
 * oblique shaft of the power grip (fpHand SHAFT_PSI), not the hand's own axis, lies along `dir`.
 */
export function shaftQ(dir: V3, out: THREE.Quaternion, wrap: V3 = FINGERS_R): THREE.Quaternion {
  return fistQ(dir, out, wrap).multiply(SHAFT_FIX);
}

/** Right-hand rotation with the fingers along `fingers` and the palm facing `palm` (camera space). */
export function basisQ(fingers: V3, palm: V3, out: THREE.Quaternion): THREE.Quaternion {
  _z.set(-fingers[0], -fingers[1], -fingers[2]).normalize();
  _y.set(-palm[0], -palm[1], -palm[2]);
  _y.addScaledVector(_z, -_y.dot(_z)).normalize();
  _x.crossVectors(_y, _z).normalize();
  return out.setFromRotationMatrix(_m.makeBasis(_x, _y, _z));
}

/** Right-hand rotation from Euler YXZ (pitch, yaw, roll). */
export function eulerQ(r: V3, out: THREE.Quaternion): THREE.Quaternion {
  return out.setFromEuler(_eu.set(r[0], r[1], r[2], "YXZ"));
}

/** Mirror a right-hand rotation onto the left hand (reflection across the camera's YZ plane). */
export function mirrorQ(q: THREE.Quaternion): THREE.Quaternion {
  q.y = -q.y;
  q.z = -q.z;
  return q;
}

/* ============================================================ targets */

/** A hand target: wrist (camera space), hand rotation, elbow pole, finger joints, position spring rate. */
export interface HandTarget {
  pos: THREE.Vector3;
  q: THREE.Quaternion;
  pole: THREE.Vector3;
  pose: HandPose;
  omega: number;
}

export function handTarget(): HandTarget {
  return { pos: new THREE.Vector3(), q: new THREE.Quaternion(), pole: new THREE.Vector3(), pose: new Float32Array(HAND_DOF), omega: 22 };
}

export function copyTarget(dst: HandTarget, src: HandTarget): HandTarget {
  dst.pos.copy(src.pos);
  dst.q.copy(src.q);
  dst.pole.copy(src.pole);
  dst.pose.set(src.pose);
  dst.omega = src.omega;
  return dst;
}

/** dst → src by w (position, rotation, pole, fingers, spring rate). */
export function lerpTarget(dst: HandTarget, src: HandTarget, w: number): HandTarget {
  if (w <= 0) return dst;
  if (w >= 1) return copyTarget(dst, src);
  dst.pos.lerp(src.pos, w);
  dst.q.slerp(src.q, w);
  dst.pole.lerp(src.pole, w);
  blendPose(dst.pose, dst.pose, src.pose, w);
  dst.omega += (src.omega - dst.omega) * w;
  return dst;
}

/* ============================================================ clips */

export type Ref = "snap" | "base";

/** One key of a hand track (right-hand terms; left tracks are mirrored on compile). */
export interface Key {
  t: number;
  /** Wrist: absolute, the clip start, the live base, or (dp) an offset from the clip start. */
  p?: V3 | Ref;
  dp?: V3;
  /** Hand rotation: Euler YXZ (pitch, yaw, roll), or where a held shaft points (d, knuckle hint dw), or [fingers, palm],
   * or (dr) a turn on top of the clip start. */
  r?: V3 | Ref;
  dr?: V3;
  d?: V3;
  dw?: V3;
  b?: readonly [V3, V3];
  /** Finger pose. */
  h?: HandPoseName | Ref;
  /** Easing and position spring rate of the segment that ends at this key. */
  e?: Ease;
  w?: number;
  /** Squeeze pulse (extra finger flex, 0..0.3) when this key is reached. */
  sq?: number;
}

/** Shake window: [from, to, position amplitude (m), yaw amplitude (rad), Hz, hands (0 right, 1 left, 2 both)]. */
export type Wobble = readonly [number, number, number, number, number, number];

export interface Clip {
  dur: number;
  /** Tracks; a hand without one stays on its base pose. B = both hands (the left mirrored). */
  R?: readonly Key[];
  L?: readonly Key[];
  B?: readonly Key[];
  /** The held item leaves the hand at this time (hidden until the clip ends). */
  release?: number;
  /** Hit-stops [from, to, shake m, shake Hz]: at `from` the clip holds for (to − from) s of real time while the hand
   * trembles, then goes on from `to` (so the clip keeps its length). */
  stop?: readonly (readonly [number, number, number, number])[];
  wob?: readonly Wobble[];
  /** Angular kick into the rig sway when the clip starts (pitch, yaw, roll rad/s). */
  shove?: V3;
  /** Impact squash of the right hand at this time. */
  squash?: number;
  /** Charge-style clips: start on the base (not the snapshot) and hold the last key (no implicit end). */
  fromBase?: boolean;
  hold?: boolean;
}

interface PosK {
  t: number;
  ref: Ref | null;
  v: THREE.Vector3;
  rel: boolean;
  e: Ease;
  w: number;
}

interface RotK {
  t: number;
  ref: Ref | null;
  q: THREE.Quaternion;
  /** q is a camera-space turn applied on top of the clip start (dr keys). */
  rel: boolean;
  e: Ease;
}

interface PoseK {
  t: number;
  ref: Ref | null;
  v: HandPose;
  e: Ease;
}

export interface Track {
  pos: PosK[];
  rot: RotK[];
  pose: PoseK[];
  sq: { t: number; amt: number }[];
}

export interface CompiledClip {
  clip: Clip;
  tracks: [Track | null, Track | null];
}

const compiled = new WeakMap<Clip, CompiledClip>();

function compileTrack(keys: readonly Key[], clip: Clip, mirror: boolean): Track {
  const m = mirror ? -1 : 1;
  const start: Ref = clip.fromBase ? "base" : "snap";
  const tr: Track = { pos: [], rot: [], pose: [], sq: [] };
  for (const k of keys) {
    const e = k.e ?? "IO";
    if (k.p !== undefined || k.dp) {
      if (tr.pos.length === 0 && k.t > 0) tr.pos.push({ t: 0, ref: start, v: new THREE.Vector3(), rel: false, e: "L", w: 22 });
      if (k.dp) tr.pos.push({ t: k.t, ref: null, v: new THREE.Vector3(k.dp[0] * m, k.dp[1], k.dp[2]), rel: true, e, w: k.w ?? 22 });
      else if (typeof k.p === "string") tr.pos.push({ t: k.t, ref: k.p, v: new THREE.Vector3(), rel: false, e, w: k.w ?? 22 });
      else if (k.p) tr.pos.push({ t: k.t, ref: null, v: new THREE.Vector3(k.p[0] * m, k.p[1], k.p[2]), rel: false, e, w: k.w ?? 22 });
    }
    if (k.r !== undefined || k.d || k.b || k.dr) {
      if (tr.rot.length === 0 && k.t > 0) tr.rot.push({ t: 0, ref: start, q: new THREE.Quaternion(), rel: false, e: "L" });
      const q = new THREE.Quaternion();
      let ref: Ref | null = null;
      if (typeof k.r === "string") ref = k.r;
      else if (k.r) eulerQ(k.r, q);
      else if (k.d) shaftQ(k.d, q, k.dw);
      else if (k.b) basisQ(k.b[0], k.b[1], q);
      else if (k.dr) eulerQ(k.dr, q);
      if (!ref && mirror) mirrorQ(q);
      tr.rot.push({ t: k.t, ref, q, rel: !!k.dr && k.r === undefined, e });
    }
    if (k.h !== undefined) {
      if (tr.pose.length === 0 && k.t > 0) tr.pose.push({ t: 0, ref: start, v: new Float32Array(HAND_DOF), e: "L" });
      const ref = k.h === "snap" || k.h === "base" ? k.h : null;
      tr.pose.push({ t: k.t, ref, v: ref ? new Float32Array(HAND_DOF) : handPose(k.h as HandPoseName), e });
    }
    if (k.sq) tr.sq.push({ t: k.t, amt: k.sq });
  }
  if (!clip.hold) {
    const end = clip.dur;
    if (tr.pos.length && tr.pos[tr.pos.length - 1]!.t < end) tr.pos.push({ t: end, ref: "base", v: new THREE.Vector3(), rel: false, e: "IO", w: 22 });
    if (tr.rot.length && tr.rot[tr.rot.length - 1]!.t < end) tr.rot.push({ t: end, ref: "base", q: new THREE.Quaternion(), rel: false, e: "IO" });
    if (tr.pose.length && tr.pose[tr.pose.length - 1]!.t < end) tr.pose.push({ t: end, ref: "base", v: new Float32Array(HAND_DOF), e: "IO" });
  }
  return tr;
}

/** The compiled form of a clip (cached per clip object). */
export function compile(clip: Clip): CompiledClip {
  let c = compiled.get(clip);
  if (!c) {
    const right = clip.R ?? clip.B;
    const left = clip.L ?? clip.B;
    c = { clip, tracks: [right ? compileTrack(right, clip, false) : null, left ? compileTrack(left, clip, true) : null] };
    compiled.set(clip, c);
  }
  return c;
}

function segment<K extends { t: number }>(keys: readonly K[], t: number): number {
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1]!.t <= t) i++;
  return i;
}

const _va = new THREE.Vector3();
const _vb = new THREE.Vector3();
const _qa = new THREE.Quaternion();
const _qb = new THREE.Quaternion();

function posValue(k: PosK, snap: HandTarget, base: HandTarget, aspect: number, out: THREE.Vector3): THREE.Vector3 {
  if (k.ref === "snap") return out.copy(snap.pos);
  if (k.ref === "base") return out.copy(base.pos);
  if (k.rel) return out.copy(snap.pos).add(k.v);
  return out.set(k.v.x * aspect, k.v.y, k.v.z);
}

function rotValue(k: RotK, snap: HandTarget, base: HandTarget, out: THREE.Quaternion): THREE.Quaternion {
  if (k.ref === "snap") return out.copy(snap.q);
  if (k.ref === "base") return out.copy(base.q);
  if (k.rel) return out.multiplyQuaternions(k.q, snap.q);
  return out.copy(k.q);
}

function poseValue(k: PoseK, snap: HandTarget, base: HandTarget): ArrayLike<number> {
  return k.ref === "snap" ? snap.pose : k.ref === "base" ? base.pose : k.v;
}

/**
 * Evaluate one hand's track at clip time t into `out` (which starts as a copy of the base). `aspect` scales the
 * x of absolute keys so gestures follow the FOV-solved rest at other window shapes.
 */
export function evalTrack(tr: Track, t: number, snap: HandTarget, base: HandTarget, aspect: number, out: HandTarget): void {
  if (tr.pos.length > 1) {
    const i = segment(tr.pos, t);
    const a = tr.pos[i]!;
    const b = tr.pos[i + 1]!;
    const u = ease(b.e, (t - a.t) / Math.max(1e-4, b.t - a.t));
    posValue(a, snap, base, aspect, _va);
    posValue(b, snap, base, aspect, _vb);
    out.pos.lerpVectors(_va, _vb, u);
    out.omega = t < b.t ? b.w : 22;
  }
  if (tr.rot.length > 1) {
    const i = segment(tr.rot, t);
    const a = tr.rot[i]!;
    const b = tr.rot[i + 1]!;
    const u = ease(b.e, (t - a.t) / Math.max(1e-4, b.t - a.t));
    rotValue(a, snap, base, _qa);
    rotValue(b, snap, base, _qb);
    out.q.slerpQuaternions(_qa, _qb, u);
  }
  if (tr.pose.length > 1) {
    const i = segment(tr.pose, t);
    const a = tr.pose[i]!;
    const b = tr.pose[i + 1]!;
    const u = ease(b.e, (t - a.t) / Math.max(1e-4, b.t - a.t));
    blendPose(out.pose, poseValue(a, snap, base), poseValue(b, snap, base), u);
  }
}

/* ============================================================ the library */

const PI = Math.PI;

/** Palm items thrown overhand (from the wound-up snapshot: the projectile already left, all follow-through). */
const THROW_PALM: Clip = {
  dur: 0.46,
  release: 0,
  R: [
    { t: 0.02, h: "open" },
    { t: 0.06, p: [0.2, -0.1, -0.52], r: [0.3, 0.3, -0.2], e: "I", w: 55 },
    { t: 0.14, p: [0.05, -0.27, -0.52], r: [-0.55, 0.55, -0.9], h: "relaxed", e: "O", w: 40 },
    { t: 0.26, p: [0.12, -0.33, -0.46], r: [-0.35, 0.4, -0.6], w: 22 },
  ],
  L: [
    { t: 0.06, p: [0.12, -0.27, -0.33], h: "fist", e: "I", w: 40 },
    { t: 0.14, p: [0.13, -0.28, -0.36], h: "relaxed", e: "O" },
  ],
};

/** A quick flick (barely charged). */
const THROW_TAP: Clip = {
  dur: 0.32,
  release: 0,
  R: [
    { t: 0.05, p: [0.2, -0.13, -0.52], h: "open", e: "I", w: 50 },
    { t: 0.14, p: [0.16, -0.27, -0.48], h: "relaxed", e: "O" },
  ],
};

/** Stones fly flat: a sidearm whip low across the view. */
const THROW_STONE: Clip = {
  dur: 0.4,
  release: 0,
  R: [
    { t: 0.05, p: [0.12, -0.17, -0.53], r: [-0.1, 0.2, -0.3], h: "open", e: "I", w: 55 },
    { t: 0.14, p: [-0.04, -0.22, -0.5], r: [-0.3, 0.6, -0.6], h: "relaxed", e: "O" },
    { t: 0.3, p: [0.1, -0.3, -0.46] },
  ],
  L: [{ t: 0.06, p: [0.14, -0.27, -0.36], h: "fist", e: "I", w: 40 }],
};

/** Flinging a jellyfish, then shaking the sting off. */
const THROW_JELLY: Clip = {
  dur: 0.45,
  release: 0,
  R: [
    { t: 0.06, p: [0.22, -0.12, -0.52], h: "splay", e: "I", w: 55 },
    { t: 0.4, p: [0.24, -0.2, -0.46], h: "splay" },
  ],
  L: [{ t: 0.1, p: [0.18, -0.24, -0.42], h: "splay" }],
  wob: [[0.12, 0.4, 0.02, 0.1, 10, 2]],
};

/** The puffer: overhand, the off hand flinches up to guard. */
const THROW_PUFFER: Clip = {
  dur: 0.36,
  release: 0,
  R: THROW_PALM.R,
  L: [
    { t: 0.1, p: [0.11, -0.13, -0.35], r: [1.2, 0.6, -0.4], h: "splay", e: "B", w: 50 },
    { t: 0.22, p: [0.11, -0.13, -0.35], r: [1.2, 0.6, -0.4] },
  ],
};

/** The javelin release: the fingers open forward, the index ends pointing at the target. */
const THROW_SPEAR: Clip = {
  dur: 0.55,
  release: 0,
  R: [
    { t: 0.05, p: [0.24, -0.09, -0.52], r: [0.05, 0.15, -0.2], h: "open", e: "I", w: 60 },
    { t: 0.13, p: [0.12, -0.17, -0.56], r: [0.1, 0.12, -0.3], h: "point", e: "O", w: 40 },
    { t: 0.3, p: [0.17, -0.28, -0.48], r: [-0.3, 0.3, -0.5], h: "relaxed" },
  ],
  L: [{ t: 0.05, p: [0.14, -0.25, -0.36], h: "fist", e: "I", w: 45 }],
};

/** Shoving a raft part off both hands. */
const THROW_BIG: Clip = {
  dur: 0.5,
  release: 0,
  B: [
    { t: 0.08, p: [0.13, -0.14, -0.54], r: [1.2, 0.35, 0], h: "flat", e: "I", w: 50 },
    { t: 0.22, p: [0.15, -0.2, -0.52], h: "open", e: "O" },
  ],
};

/**
 * Underhand pass (Q). Like the throws, all follow-through: the predicted projectile leaves the hand at once, so the
 * open hand scoops up and forward after it and presents an empty palm.
 */
const TOSS: Clip = {
  dur: 0.42,
  release: 0,
  R: [
    { t: 0.04, p: [0.17, -0.2, -0.5], r: [0.2, 0.3, PI - 0.2], h: "open", e: "I", w: 45 },
    { t: 0.16, p: [0.14, -0.08, -0.52], r: [0.5, 0.35, PI - 0.3], h: "tray", e: "O" },
    { t: 0.3, h: "relaxed" },
  ],
  L: [
    { t: 0.08, p: [0.29, -0.29, -0.42] },
    { t: 0.24, p: "base" },
  ],
};

/** Empty-hand jab: wind, corkscrew into the hit, hit-stop, recoil. */
const PUNCH: Clip = {
  dur: 0.4,
  R: [
    { t: 0.05, p: [0.28, -0.21, -0.34], r: [0.1, 0.2, -1.3], h: "fist", e: "O", w: 40 },
    { t: 0.11, p: [0.1, -0.13, -0.54], r: [0, 0.15, -0.25], e: "I", w: 60, sq: 0.15 },
    { t: 0.26, p: [0.24, -0.21, -0.42], r: [0.1, 0.3, -0.8], e: "O", w: 28 },
    { t: 0.36, h: "relaxed" },
  ],
  L: [
    { t: 0.05, p: [0.2, -0.2, -0.4], h: "fist", e: "O", w: 40 },
    { t: 0.11, p: [0.19, -0.21, -0.37], e: "I" },
  ],
  stop: [[0.11, 0.15, 0.004, 28]],
  squash: 0.11,
};

/** The same with the left hand (a one-two when the jab repeats quickly). */
const PUNCH_LEFT: Clip = { ...PUNCH, R: PUNCH.L, L: PUNCH.R, squash: undefined };

/** Overhead axe chop: wind up to the top right, hang, strike down-forward, hit-stop, pull out. */
const CHOP: Clip = {
  dur: 0.52,
  R: [
    { t: 0.14, p: [0.29, -0.05, -0.34], d: [0, 0.98, 0.12], e: "O", w: 30 },
    { t: 0.17, p: [0.29, -0.05, -0.34], d: [0, 0.98, 0.12] },
    { t: 0.25, p: [0.08, -0.25, -0.55], d: [-0.3, 0.15, -0.94], e: "I", w: 60, sq: 0.2 },
    { t: 0.38, p: [0.2, -0.22, -0.47], d: [-0.3, 0.5, -0.8], e: "O", w: 30 },
  ],
  L: [
    { t: 0.14, p: [0.27, -0.22, -0.45], h: "relaxed" },
    { t: 0.3, p: "base" },
  ],
  stop: [[0.25, 0.3, 0.006, 35]],
};

/** Bonk with whatever is in the hand (rope, crab, gourd...). */
const BONK: Clip = {
  dur: 0.4,
  R: [
    { t: 0.09, p: [0.31, -0.1, -0.36], e: "O", w: 35 },
    { t: 0.17, p: [0.1, -0.21, -0.55], e: "I", w: 60, sq: 0.2 },
  ],
  stop: [[0.17, 0.22, 0.004, 30]],
};

/** A wet fish slap: wind wide, sweep across. */
const FISH_SLAP: Clip = {
  dur: 0.42,
  R: [
    { t: 0.1, p: [0.37, -0.16, -0.36], e: "O", w: 35 },
    { t: 0.19, p: [0.02, -0.17, -0.54], e: "I", w: 60, sq: 0.15 },
  ],
  stop: [[0.19, 0.24, 0.004, 30]],
};

/** Torch swing: back to the right, sweep through the middle, follow through left; the off hand tucks away. */
const SWING: Clip = {
  dur: 0.5,
  R: [
    { t: 0.09, p: [0.36, -0.1, -0.35], d: [0.4, 0.85, -0.25], e: "O", w: 32 },
    { t: 0.22, p: [-0.02, -0.15, -0.52], d: [-0.75, 0.5, -0.45], e: "I", w: 55 },
    { t: 0.3, p: [-0.11, -0.19, -0.49], d: [-0.85, 0.3, -0.4], e: "O" },
  ],
  L: [
    { t: 0.05, p: [0.25, -0.29, -0.4] },
    { t: 0.35, p: [0.25, -0.29, -0.4] },
  ],
};

/** Food to the mouth, three bites (the food shrinks), dust the hands off. */
const BITE_AT = [0.28, 0.46, 0.64] as const;
function eatKeys(hold: Key): Key[] {
  const near: V3 = [0.07, -0.21, -0.24];
  const keys: Key[] = [{ ...hold, t: 0.18, p: near, e: "B", w: 30 }];
  for (const b of BITE_AT) {
    keys.push({ t: b, p: [0.06, -0.2, -0.21], e: "I", w: 50, sq: 0.1 });
    keys.push({ t: b + 0.08, p: near, e: "O" });
  }
  keys.push({ t: 0.86, p: [0.08, -0.27, -0.36], h: "relaxed" });
  keys.push({ t: 0.92, p: [0.04, -0.27, -0.4], r: [0.1, 0.2, -0.3], h: "flat" });
  keys.push({ t: 1.04, p: [0.04, -0.27, -0.4] });
  return keys;
}
const EAT_L: Key[] = [
  { t: 0.2, p: [0.1, -0.29, -0.32], r: [0.3, 0.3, PI - 0.3], h: "tray" },
  { t: 0.8, p: [0.1, -0.29, -0.32] },
  { t: 0.92, p: [0.04, -0.28, -0.4], r: [0.1, 0.2, -0.3], h: "flat" },
  { t: 1.04, p: [0.04, -0.28, -0.4] },
];
const DUST: Wobble = [0.92, 1.04, 0.015, 0, 7, 2];
/** Food on the palm (crabs): the palm turns toward the mouth. */
const EAT_PALM: Clip = { dur: 1.1, R: eatKeys({ t: 0, b: [[-0.3, 0.8, -0.5], [-0.45, 0, 0.9]] }), L: EAT_L, wob: [DUST] };
/** Food in the fist (fish by the tail, the skewer): it points at the mouth. */
const EAT_FIST: Clip = { dur: 1.1, R: eatKeys({ t: 0, d: [-0.24, 0.54, 0.81] }), L: EAT_L, wob: [DUST] };

/**
 * Drinking from the gourd like from a bottle: the neck at the lips, the bottom tipped up and forward (so it stays in
 * view above the hand), three gulps tipping it further; the off hand wipes the mouth.
 */
const DRINK_GOURD: Clip = {
  dur: 1.05,
  R: [
    { t: 0.2, p: [0.04, -0.15, -0.21], d: [0, -0.45, 0.89], dw: [0.9, 0.2, 0.3], e: "B", w: 30 },
    { t: 0.3, p: [0.04, -0.145, -0.21], d: [0, -0.55, 0.83], dw: [0.9, 0.2, 0.3], e: "IO" },
    { t: 0.48, p: [0.04, -0.14, -0.21], d: [0, -0.63, 0.77], dw: [0.9, 0.2, 0.3], e: "IO" },
    { t: 0.66, p: [0.04, -0.135, -0.21], d: [0, -0.7, 0.71], dw: [0.9, 0.2, 0.3], e: "IO" },
    { t: 0.78, p: [0.12, -0.25, -0.36], e: "IO" },
  ],
  L: [
    { t: 0.82, p: [0.05, -0.17, -0.26], r: [0.9, 0.4, 0.2], h: "relaxed", e: "O" },
    { t: 0.98, p: [-0.1, -0.16, -0.27], e: "O" },
  ],
};

/** Drinking a coconut: cradled up to the mouth and tipped back. */
const DRINK_COCONUT: Clip = {
  dur: 1.05,
  R: [
    { t: 0.2, p: [0.06, -0.2, -0.26], b: [[-0.25, 0.55, -0.8], [-0.1, 0.62, 0.78]], e: "B", w: 30 },
    { t: 0.36, p: [0.06, -0.185, -0.25], b: [[-0.25, 0.68, -0.69], [-0.1, 0.46, 0.88]] },
    { t: 0.56, p: [0.06, -0.17, -0.25], b: [[-0.25, 0.8, -0.55], [-0.1, 0.34, 0.94]] },
    { t: 0.74, p: [0.12, -0.25, -0.36] },
  ],
  L: [
    { t: 0.2, p: [0.04, -0.24, -0.3], r: [0.36, 0.33, -2.71], h: "cup", e: "B", w: 30 },
    { t: 0.66, p: [0.04, -0.24, -0.3], r: [0.36, 0.33, -2.71] },
    { t: 0.82, p: [0.05, -0.17, -0.26], r: [0.9, 0.4, 0.2], h: "relaxed", e: "O" },
    { t: 0.98, p: [-0.1, -0.16, -0.27], e: "O" },
  ],
};

/** The golden fish: up to the mouth like a bite, then swallowed in one big gulp (it squashes and vanishes). */
const EAT_GULP: Clip = {
  dur: 0.95,
  R: [
    { t: 0.2, p: [0.07, -0.21, -0.24], b: [[-0.3, 0.8, -0.5], [-0.45, 0, 0.9]], e: "B", w: 30 },
    { t: 0.36, p: [0.065, -0.2, -0.22], e: "IO" },
    { t: 0.44, p: [0.06, -0.19, -0.2], e: "I", w: 50, sq: 0.15 },
    { t: 0.6, p: [0.08, -0.27, -0.36], h: "relaxed", e: "O" },
  ],
  L: [
    { t: 0.2, p: [0.1, -0.29, -0.32], r: [0.3, 0.3, PI - 0.3], h: "tray" },
    { t: 0.6, p: [0.1, -0.29, -0.32] },
  ],
  wob: [[0.62, 0.8, 0.012, 0.08, 7, 0]],
};

/** F with something inedible: up to the face, a sniff, a disgusted shake. */
const NOPE_ITEM: Clip = {
  dur: 0.65,
  R: [
    { t: 0.15, p: [0.1, -0.2, -0.3], e: "B", w: 30 },
    { t: 0.45, p: [0.1, -0.2, -0.3] },
  ],
  wob: [[0.2, 0.45, 0.015, 0.15, 6, 0]],
};

/** F with empty hands: pinch at the mouth, nothing there, a shrug. */
const NOPE_EMPTY: Clip = {
  dur: 0.7,
  R: [
    { t: 0.18, p: [0.06, -0.22, -0.26], r: [0.6, 0.5, -0.6], h: "pinch", e: "B", w: 30 },
    { t: 0.25, h: "open" },
    { t: 0.35, p: [0.18, -0.24, -0.44], r: [0.3, 0.3, PI - 0.3], h: "relaxed" },
    { t: 0.55, p: [0.18, -0.24, -0.44], r: [0.3, 0.3, PI - 0.3] },
  ],
  L: [
    { t: 0.35, p: [0.18, -0.24, -0.44], r: [0.3, 0.3, PI - 0.3], h: "relaxed" },
    { t: 0.55, p: [0.18, -0.24, -0.44], r: [0.3, 0.3, PI - 0.3] },
  ],
};

/** The gather completion yank (by hand) / the last axe hit. */
const GATHER_HAND: Clip = {
  dur: 0.34,
  B: [
    { t: 0.06, p: [0.13, -0.25, -0.35], h: "fist", e: "B", w: 50, sq: 0.2 },
    { t: 0.18, p: [0.13, -0.23, -0.41] },
  ],
};
const GATHER_AXE: Clip = {
  dur: 0.34,
  R: [{ t: 0.16, p: [0.22, -0.16, -0.46], e: "O" }],
  stop: [[0, 0.05, 0.007, 35]],
};

/** Catch: both hands up into a basket, ready; a miss claps on nothing (CAUGHT takes over on a catch). */
const CATCH: Clip = {
  dur: 0.6,
  B: [
    { t: 0.07, p: [0.15, -0.11, -0.5], r: [1.1, 0.5, -0.6], h: "open", e: "B", w: 45 },
    { t: 0.3, p: [0.14, -0.11, -0.5], r: [1.1, 0.5, -0.6], h: "claw" },
    { t: 0.36, p: [0.035, -0.15, -0.49], h: "flat", e: "I", w: 60 },
    { t: 0.45, p: [0.06, -0.19, -0.47], h: "relaxed" },
  ],
  wob: [[0.07, 0.3, 0.003, 0, 9, 2]],
  stop: [[0.36, 0.39, 0.003, 30]],
};

/** Catch with the right hand full: only the left reaches out. */
const CATCH_LEFT: Clip = { ...CATCH, R: undefined, L: CATCH.B, B: undefined };

/** Caught: a clap-cup on the item, absorb, into its hold. */
export const CAUGHT: Clip = {
  dur: 0.35,
  B: [
    { t: 0.05, p: [0.05, -0.16, -0.45], h: "cup", e: "I", w: 60 },
    { t: 0.12, p: [0.07, -0.19, -0.38], e: "O", sq: 0.2 },
  ],
};

/** Rod cast: dip, back-cast with the tip behind, whip forward, follow through into the fishing idle. */
const CAST: Clip = {
  dur: 0.66,
  R: [
    { t: 0.08, p: [0.23, -0.22, -0.49], d: [-0.08, 0.22, -0.97], e: "O" },
    { t: 0.28, p: [0.26, -0.03, -0.31], d: [-0.05, 0.99, 0.08], e: "IO", w: 30 },
    { t: 0.32, p: [0.26, -0.03, -0.31], d: [-0.05, 0.99, 0.08] },
    { t: 0.4, p: [0.16, -0.15, -0.56], d: [-0.1, 0.25, -0.96], e: "I", w: 60 },
  ],
  L: [
    { t: 0.28, p: [0.22, -0.22, -0.46] },
    { t: 0.4, p: [0.24, -0.26, -0.4] },
  ],
};

/** Strike on a bite: yank the rod up, hold the tension, settle into reeling (the left hand to the crank). */
const REEL: Clip = {
  dur: 0.52,
  R: [
    { t: 0.08, p: [0.22, -0.04, -0.36], d: [-0.12, 0.85, -0.5], e: "B", w: 55, sq: 0.25 },
    { t: 0.2, p: [0.22, -0.04, -0.36], d: [-0.12, 0.85, -0.5] },
  ],
  L: [{ t: 0.1, p: [-0.09, -0.21, -0.44], h: "fist" }],
  wob: [[0.08, 0.2, 0.003, 0, 16, 0]],
};

/** The fish comes out of the water: yank high. */
const REEL_RESULT: Clip = {
  dur: 0.52,
  R: [
    { t: 0.1, p: [0.2, 0.0, -0.34], d: [-0.1, 0.95, -0.3], e: "B", w: 55, sq: 0.25 },
    { t: 0.22, p: [0.2, -0.01, -0.34], d: [-0.1, 0.95, -0.3] },
  ],
};

/** Hit: both hands snap up to guard, palms out, shiver; the rig gets a shove. */
const HURT: Clip = {
  dur: 0.42,
  B: [
    { t: 0.04, p: [0.11, -0.13, -0.35], r: [1.2, 0.6, -0.4], h: "splay", e: "B", w: 60 },
    { t: 0.14, p: [0.11, -0.13, -0.35], r: [1.2, 0.6, -0.4] },
  ],
  wob: [[0.04, 0.14, 0.003, 0, 20, 2]],
  shove: [1.6, 0, 1.2],
};

/** Hit while holding something: the right hand only flinches halfway and squeezes, the left guards fully. */
const HURT_HOLDING: Clip = {
  dur: 0.42,
  R: [
    { t: 0.04, dp: [-0.07, 0.05, 0.07], e: "B", w: 60, sq: 0.25 },
    { t: 0.14, dp: [-0.07, 0.05, 0.07] },
  ],
  L: HURT.B,
  wob: HURT.wob,
  shove: HURT.shove,
};

/** Hit while carrying a bundle: pushed back into the chest. */
const HURT_BIG: Clip = {
  dur: 0.42,
  B: [
    { t: 0.04, dp: [0, 0.02, 0.04], e: "B", w: 60, sq: 0.2 },
    { t: 0.14, dp: [0, 0.02, 0.04] },
  ],
  wob: HURT.wob,
  shove: HURT.shove,
};

/** Set a fence / collector / tentacle down in front: lift, lower forward, let go, a relief bounce. */
const PLACE: Clip = {
  dur: 0.58,
  release: 0.3,
  B: [
    { t: 0.1, p: [0.16, -0.22, -0.44], e: "O", sq: 0.15 },
    { t: 0.28, p: [0.15, -0.33, -0.56], e: "IO", w: 35 },
    { t: 0.3, h: "flat" },
    { t: 0.4, p: [0.15, -0.3, -0.52] },
  ],
};

/** Raft delivery with a bundle: heave, push it onto the raft, a clap, a rebound. */
const DELIVER_BIG: Clip = {
  dur: 0.7,
  release: 0.3,
  B: [
    { t: 0.12, p: [0.15, -0.16, -0.55], e: "O" },
    { t: 0.3, p: [0.14, -0.25, -0.58], h: "flat", e: "I", w: 45 },
    { t: 0.44, p: [0.03, -0.22, -0.5], e: "I", w: 60 },
    { t: 0.52, p: [0.06, -0.23, -0.48], e: "O" },
  ],
  stop: [[0.44, 0.47, 0.003, 30]],
};

/** Delivery of a hand-held item: presented on the palm, let go, a small wave. */
const DELIVER_HAND: Clip = {
  dur: 0.55,
  release: 0.25,
  R: [
    { t: 0.15, p: [0.15, -0.16, -0.55], r: [0.3, 0.3, PI - 0.3], h: "tray", e: "O" },
    { t: 0.25, h: "open" },
    { t: 0.4, p: [0.16, -0.15, -0.54], r: [0.9, 0.3, -0.2], h: "flat" },
  ],
  wob: [[0.3, 0.45, 0.012, 0.1, 7, 0]],
};

/** Delivery from the pockets (empty hands): pat and push. */
const DELIVER_EMPTY: Clip = {
  dur: 0.55,
  B: [
    { t: 0.18, p: [0.14, -0.25, -0.58], r: [0.9, 0.3, -0.2], h: "flat", e: "I", w: 45 },
    { t: 0.3, p: [0.03, -0.22, -0.5], e: "I", w: 60 },
    { t: 0.38, p: [0.06, -0.23, -0.48], e: "O" },
  ],
  stop: [[0.3, 0.33, 0.003, 30]],
};

/** Delivery from the pockets while the right hand holds something else: the left hand pats and pushes. */
const DELIVER_OFF: Clip = { ...DELIVER_EMPTY, B: undefined, L: DELIVER_EMPTY.B };

export type ClipName =
  | "throwPalm"
  | "throwTap"
  | "throwStone"
  | "throwJelly"
  | "throwPuffer"
  | "throwSpear"
  | "throwBig"
  | "toss"
  | "punch"
  | "punchLeft"
  | "chop"
  | "bonk"
  | "fishSlap"
  | "swing"
  | "eatPalm"
  | "eatFist"
  | "eatGulp"
  | "drinkGourd"
  | "drinkCoconut"
  | "nopeItem"
  | "nopeEmpty"
  | "gatherHand"
  | "gatherAxe"
  | "catch"
  | "catchLeft"
  | "caught"
  | "cast"
  | "reel"
  | "reelResult"
  | "hurt"
  | "hurtHolding"
  | "hurtBig"
  | "place"
  | "deliverBig"
  | "deliverHand"
  | "deliverEmpty"
  | "deliverOff";

export const CLIPS: Readonly<Record<ClipName, Clip>> = {
  throwPalm: THROW_PALM,
  throwTap: THROW_TAP,
  throwStone: THROW_STONE,
  throwJelly: THROW_JELLY,
  throwPuffer: THROW_PUFFER,
  throwSpear: THROW_SPEAR,
  throwBig: THROW_BIG,
  toss: TOSS,
  punch: PUNCH,
  punchLeft: PUNCH_LEFT,
  chop: CHOP,
  bonk: BONK,
  fishSlap: FISH_SLAP,
  swing: SWING,
  eatPalm: EAT_PALM,
  eatFist: EAT_FIST,
  eatGulp: EAT_GULP,
  drinkGourd: DRINK_GOURD,
  drinkCoconut: DRINK_COCONUT,
  nopeItem: NOPE_ITEM,
  nopeEmpty: NOPE_EMPTY,
  gatherHand: GATHER_HAND,
  gatherAxe: GATHER_AXE,
  catch: CATCH,
  catchLeft: CATCH_LEFT,
  caught: CAUGHT,
  cast: CAST,
  reel: REEL,
  reelResult: REEL_RESULT,
  hurt: HURT,
  hurtHolding: HURT_HOLDING,
  hurtBig: HURT_BIG,
  place: PLACE,
  deliverBig: DELIVER_BIG,
  deliverHand: DELIVER_HAND,
  deliverEmpty: DELIVER_EMPTY,
  deliverOff: DELIVER_OFF,
};

/** Going down: the hands slam forward onto the ground, a jolt, then the crawl. */
export const DOWNED: Clip = {
  dur: 0.4,
  B: [
    { t: 0.08, p: [0.15, -0.33, -0.5], r: [-1.2, 0.25, -0.15], h: "claw", e: "I", w: 60, sq: 0.2 },
    { t: 0.25, p: [0.16, -0.31, -0.48] },
  ],
  stop: [[0.08, 0.13, 0.004, 30]],
};

/** Revived: a push off the ground, back up, two "phew" flicks of the wrists. */
export const REVIVED: Clip = {
  dur: 0.8,
  B: [
    { t: 0.12, dp: [0, -0.02, 0], h: "flat", e: "O" },
    { t: 0.5, p: "base", h: "base", e: "O" },
  ],
  wob: [[0.55, 0.75, 0.012, 0.1, 9, 2]],
};

/** Into the water: the hands fly up for a moment. */
export const WATER_IN: Clip = {
  dur: 0.4,
  B: [
    { t: 0.1, dp: [0, 0.05, 0], h: "splay", e: "O" },
    { t: 0.25, dp: [0, 0.05, 0] },
  ],
};

/** Out of the water: shake the drips off. */
export const WATER_OUT: Clip = {
  dur: 0.45,
  B: [
    { t: 0.06, h: "splay" },
    { t: 0.4, h: "splay" },
  ],
  wob: [[0, 0.4, 0.012, 0.08, 9, 2]],
};

/** The clips that put food in the mouth (the item shows as the food being eaten / drunk). */
export const EAT_CLIPS: ReadonlySet<ClipName> = new Set<ClipName>(["eatPalm", "eatFist", "eatGulp", "drinkGourd", "drinkCoconut"]);

/* ============================================================ private clips (no gesture event) */

/** One more of the same kind into the pocket: a small dip. */
export const POCKET: Clip = { dur: 0.25, R: [{ t: 0.08, dp: [0, -0.015, 0], e: "O" }] };

/** Idle fidgets (played after a while standing still). */
export const FIDGETS = {
  /** Empty hand: the fingers roll closed and open again. */
  fingers: { dur: 0.75, R: [{ t: 0.25, h: "fist" }, { t: 0.5, h: "open", e: "O" }, { t: 0.7, h: "base" }] },
  /** Amca checks his wristwatch. */
  watch: {
    dur: 1.4,
    R: [
      { t: 0.35, p: [0.1, -0.17, -0.33], b: [[-0.75, 0.45, -0.45], [0, -0.3, -1]] },
      { t: 1.15, p: [0.1, -0.17, -0.33], b: [[-0.75, 0.45, -0.45], [0, -0.3, -1]] },
    ],
  },
  /** Weighing a heavy item: a little hop in the palm. */
  weigh: {
    dur: 0.42,
    R: [
      { t: 0.14, dp: [0, 0.03, 0], e: "O" },
      { t: 0.26, dp: [0, -0.008, 0], e: "I", sq: 0.15 },
    ],
  },
  /** Loosen and re-tighten the grip on a handle. */
  regrip: { dur: 0.45, R: [{ t: 0.15, h: "claw", e: "O" }, { t: 0.3, h: "base", e: "I", sq: 0.12 }] },
  /** Warm the off hand at the lit torch. */
  warm: {
    dur: 1.6,
    L: [
      { t: 0.35, p: [-0.12, -0.1, -0.44], r: [0.2, 0, -Math.PI / 2], h: "open" },
      { t: 1.3, p: [-0.12, -0.1, -0.44], r: [0.2, 0, -Math.PI / 2] },
    ],
  },
  /** Şef: a chef's kiss. */
  chefKiss: {
    dur: 1.0,
    R: [
      { t: 0.25, p: [0.06, -0.21, -0.26], r: [0.6, 0.5, -0.6], h: "pinch" },
      { t: 0.4, p: [0.06, -0.205, -0.25], r: [0.6, 0.5, -0.6] },
      { t: 0.6, p: [0.13, -0.17, -0.34], r: [0.9, 0.4, -0.3], h: "splay", e: "O" },
    ],
  },
  /** Fenomen: a flick of the wrist that jingles the bangles. */
  bangles: { dur: 0.45, R: [{ t: 0.05, dp: [0, 0.01, 0] }, { t: 0.4, dp: [0, 0.01, 0] }], wob: [[0.05, 0.4, 0.02, 0.15, 8, 0]] },
  /** Kaptan / Gelin: the left hand tugs the right cuff straight. */
  cuff: {
    dur: 0.9,
    L: [
      { t: 0.3, p: [-0.2, -0.24, -0.4], r: [0.3, -0.6, 0.3], h: "pinch" },
      { t: 0.45, p: [-0.2, -0.24, -0.385] },
      { t: 0.6, p: [-0.2, -0.24, -0.4] },
      { t: 0.75, p: [-0.2, -0.24, -0.385] },
    ],
  },
  /** The axe: a roll of the wrist to check the edge. */
  edge: { dur: 0.8, R: [{ t: 0.3, dr: [0, 0, 0.3] }, { t: 0.55, dr: [0, 0, 0.3] }] },
  /** Food: admire it, tilted toward you. */
  admire: { dur: 1.4, R: [{ t: 0.4, dr: [0.2, 0, 0], dp: [0, 0.01, 0.01] }, { t: 1.0, dr: [0.2, 0, 0], dp: [0, 0.01, 0.01] }] },
  /** Hitch a heavy bundle up. */
  hitch: {
    dur: 0.45,
    B: [
      { t: 0.15, dp: [0, 0.03, 0], e: "O" },
      { t: 0.27, dp: [0, -0.004, 0], e: "I", sq: 0.15 },
    ],
  },
} satisfies Record<string, Clip>;

/** Bite moments of the eat clips (the food loses a chunk at each). */
export const BITES: readonly number[] = BITE_AT;

/* ============================================================ charge wind-ups (clip time = eased charge 0..1) */

const C_PALM: Clip = {
  dur: 1,
  fromBase: true,
  hold: true,
  R: [
    { t: 0.15, p: [0.26, -0.23, -0.42], r: [0.7, 0.3, 1.5] },
    { t: 0.5, p: [0.29, -0.15, -0.37], r: [1.2, 0.25, 0.4] },
    { t: 1, p: [0.3, -0.1, -0.34], r: [1.45, 0.25, 0], h: "claw" },
  ],
  L: [
    { t: 0.3, p: "base", h: "base" },
    { t: 1, p: [0.16, -0.15, -0.5], r: [1.2, 0.3, -0.3], h: "aim" },
  ],
};
/** Fist-held palm items keep their fist; only the arm cocks back. */
const C_FIST: Clip = {
  dur: 1,
  fromBase: true,
  hold: true,
  R: [
    { t: 0.15, p: [0.26, -0.23, -0.42] },
    { t: 0.5, p: [0.29, -0.15, -0.37], d: [0.2, 0.9, 0.35] },
    { t: 1, p: [0.3, -0.1, -0.34], d: [0.3, 0.75, 0.6] },
  ],
  L: C_PALM.L,
};
const C_STONE: Clip = {
  dur: 1,
  fromBase: true,
  hold: true,
  R: [
    { t: 0.15, p: [0.27, -0.23, -0.42] },
    { t: 0.5, p: [0.32, -0.22, -0.35] },
    { t: 1, p: [0.36, -0.22, -0.3], r: [0.05, -1.2, -0.3], h: "claw" },
  ],
  L: [
    { t: 0.3, p: "base" },
    { t: 1, p: [0.32, -0.21, -0.43], h: "open" },
  ],
};
const C_JELLY: Clip = {
  dur: 1,
  fromBase: true,
  hold: true,
  R: [
    { t: 0.15, p: [0.29, -0.18, -0.4] },
    { t: 0.5, p: [0.31, -0.14, -0.37] },
    { t: 1, p: [0.33, -0.12, -0.34] },
  ],
  L: [{ t: 1, p: [0.22, -0.26, -0.42], h: "splay" }],
};
const C_SPEAR: Clip = {
  dur: 1,
  fromBase: true,
  hold: true,
  R: [
    { t: 0.15, p: [0.25, -0.22, -0.42], d: [-0.1, 0.45, -0.89], dw: [0.25, -0.85, 0.45] },
    { t: 0.5, p: [0.3, -0.14, -0.33], d: [-0.07, 0.3, -0.95], dw: [0.25, -0.85, 0.45] },
    { t: 1, p: [0.32, -0.08, -0.26], d: [-0.05, 0.12, -0.99], dw: [0.25, -0.85, 0.45] },
  ],
  L: [
    { t: 0.3, p: "base", h: "base" },
    { t: 1, p: [0.16, -0.15, -0.5], r: [0.25, 0.25, -0.3], h: "point" },
  ],
};
const C_BIG: Clip = {
  dur: 1,
  fromBase: true,
  hold: true,
  B: [
    { t: 0.15, dp: [0, -0.03, 0] },
    { t: 0.5, p: [0.18, -0.28, -0.43] },
    { t: 1, p: [0.2, -0.24, -0.4], sq: 0.2 },
  ],
};

export type ChargeName = "palm" | "fist" | "stone" | "jelly" | "spear" | "big";
export const CHARGES: Readonly<Record<ChargeName, Clip>> = { palm: C_PALM, fist: C_FIST, stone: C_STONE, jelly: C_JELLY, spear: C_SPEAR, big: C_BIG };

/* ============================================================ equip / holster */

/** Where the hand goes to put an item away (offset from its target, camera space) and how long it takes. */
export interface Stow {
  pos: V3;
  /** Added rotation (pitch, yaw, roll), right hand. */
  rot: V3;
  down: number;
  up: number;
  /** Both hands go (big carries). */
  both: boolean;
}

export type StowClass = "empty" | "palm" | "tool" | "torch" | "big";

export const STOW: Readonly<Record<StowClass, Stow>> = {
  empty: { pos: [0.03, -0.24, 0.04], rot: [-0.4, 0, 0.2], down: 0.1, up: 0.22, both: false },
  palm: { pos: [0.06, -0.28, 0.06], rot: [-0.7, 0.2, 0.3], down: 0.12, up: 0.26, both: false },
  tool: { pos: [0.1, -0.3, 0.1], rot: [-1.0, 0.1, 0.4], down: 0.15, up: 0.3, both: false },
  torch: { pos: [0.1, -0.3, 0.1], rot: [-0.6, 0, 0.3], down: 0.15, up: 0.3, both: false },
  big: { pos: [0, -0.3, 0.05], rot: [0.3, 0, 0], down: 0.2, up: 0.4, both: true },
};
