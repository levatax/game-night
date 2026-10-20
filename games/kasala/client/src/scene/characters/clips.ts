// Layered animation clips for the seated gangsters: §11 emotes (aimed cigar smoke, counting the wad, fist on
// the felt with jumping chips, an aimed kiss, a hanky honk with two buckets of tears, "Allah Allah"), moods,
// table gestures (knock on a flip, slam + rake on KASALA, push chips on a bet), the KASALA celebration and
// idle fidgets. A clip is keyframed (anticipation → action → hold with secondary motion → settle), written
// over a copy of the base pose and blended in with a fade envelope on a channel mask, so clips never cancel
// a scripted sequence (raid, cement shoes, podium) and two clips cross-fade instead of popping.
// Owner: client-characters.

import * as THREE from "three";
import type { EmoteId } from "../../../../shared/constants";
import { MASK_ARMS, MASK_BODY, MASK_FACE, MASK_HAT, MASK_HEAD, type Face, type Pose, type Puppet } from "./body";
import type { Actor } from "./cast";
import type { Particles } from "./particles";
import { backOut, bump, clamp, easeIn, easeInOut, easeOut, envelope, seg, smooth, wrapAngle } from "./util";

export type Mood = "idle" | "happy" | "cheer" | "sad" | "shock" | "angry" | "nervous" | "laugh";
export type GestureKind = "knock" | "slam" | "push";

export interface ClipEnv {
  particles: Particles;
  /** Aim point for smoke / kisses (a rival's head), or null. */
  target: THREE.Vector3 | null;
  /** Channels this clip may write right now (a sequence can lock some). Props and particles need MASK_ARMS. */
  mask: number;
  /** The actor is my own body seen from inside (first person): it emits no particles (FpArms has its own). */
  inside: boolean;
  time: number;
  dt: number;
}

export interface ClipDef {
  kind: "idle" | "mood" | "gesture" | "emote" | "cash";
  name: string;
  dur: number;
  fadeIn: number;
  fadeOut: number;
  mask: number;
  pose(p: Pose, run: ClipRun, a: Actor, env: ClipEnv): void;
}

export interface ClipRun {
  def: ClipDef;
  t: number;
  dur: number;
  fadeOut: number;
  /** One-shot event bits already fired. */
  fired: number;
  /** Particle emission accumulator. */
  acc: number;
  big: boolean;
}

const PRIORITY: Record<ClipDef["kind"], number> = { idle: 0, mood: 1, gesture: 2, emote: 3, cash: 4 };
const FAST_OUT = 0.18;

/**
 * Start a clip; a running clip of the same kind fades out quickly (cross-fade, never a cut). An emote also
 * ends an idle fidget; the KASALA celebration ends fidgets and emotes but lets the slam + rake gesture it
 * follows play out (it only rises once the rake is done).
 */
export function startClip(a: Actor, def: ClipDef, dur = def.dur, big = false): ClipRun {
  for (const r of a.clips) {
    const k = r.def.kind;
    if (k === def.kind || (def.kind === "emote" && k === "idle") || (def.kind === "cash" && (k === "idle" || k === "emote"))) fadeClip(r);
  }
  const run: ClipRun = { def, t: 0, dur: Math.max(def.fadeIn + def.fadeOut + 0.05, dur), fadeOut: def.fadeOut, fired: 0, acc: 0, big };
  a.clips.push(run);
  a.clips.sort((x, y) => PRIORITY[x.def.kind] - PRIORITY[y.def.kind]);
  return run;
}

/** Let a clip fade out now. */
export function fadeClip(r: ClipRun): void {
  const end = r.t + FAST_OUT;
  if (end < r.dur) {
    r.dur = end;
    r.fadeOut = Math.min(r.fadeOut, FAST_OUT);
  }
}

export function clipWeight(r: ClipRun): number {
  return envelope(r.t, r.dur, Math.min(r.def.fadeIn, r.dur * 0.4), Math.min(r.fadeOut, r.dur * 0.5));
}

export function hasClip(a: Actor, kind: ClipDef["kind"]): boolean {
  return a.clips.some((r) => r.def.kind === kind && r.t < r.dur - r.fadeOut);
}

// ------------------------------------------------------------------ helpers
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _w = new THREE.Vector3();
const _h = new THREE.Vector3();
const _v = new THREE.Vector3();

function once(run: ClipRun, bit: number, at: number): boolean {
  if (run.t < at || run.fired & bit) return false;
  run.fired |= bit;
  return true;
}
/** How many particles to emit this frame at `rate` per second (frame-rate independent). */
function emit(run: ClipRun, rate: number, dt: number): number {
  run.acc += rate * dt;
  const n = Math.floor(run.acc);
  run.acc -= n;
  return n;
}
function lerp3(out: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, s: number): THREE.Vector3 {
  return out.copy(a).lerp(b, s);
}
/** Hand i's rest point on the rail, in torso space (refreshTorso was called for this frame). */
function restT(a: Actor, i: number, out: THREE.Vector3): THREE.Vector3 {
  return a.puppet.toTorso(a.rest[i]!, out);
}
function worldOf(o: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  return o.getWorldPosition(out);
}
const armsFree = (env: ClipEnv): boolean => (env.mask & MASK_ARMS) !== 0;
/** Particles only for bodies the camera sees from outside. */
const fxOn = (env: ClipEnv): boolean => !env.inside;

/** Anything with a face on a puppet (gangsters, the cop, the lawyer, Cemil Abi). */
export interface Looker {
  face: Face;
  root: THREE.Object3D;
  puppet: Puppet;
}

/**
 * Turn head + eyes toward a world point (eyes lead, the head follows through its spring, the torso helps on
 * big turns). `w` blends it over what the pose already has.
 */
export function aimHead(p: Pose, a: Looker, target: THREE.Vector3, w: number): void {
  if (w <= 0) return;
  worldOf(a.face.head, _h);
  const dx = target.x - _h.x;
  const dy = target.y - (_h.y + 0.18);
  const dz = target.z - _h.z;
  const yaw = a.root.rotation.y;
  const lx = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const lz = dx * Math.sin(yaw) + dz * Math.cos(yaw);
  const hy = clamp(Math.atan2(lx, lz), -1.6, 1.6);
  const hp = Math.atan2(-dy, Math.max(0.05, Math.hypot(lx, lz)));
  const headYaw = clamp(hy * 0.8, -0.85, 0.85);
  const twist = clamp(hy - headYaw, -0.5, 0.5) * 0.7;
  const headPitch = clamp(hp * 0.75, -0.42, 0.45);
  const cur = a.puppet.pose;
  const gazeX = clamp((hy - cur.headYaw - cur.twist) / 0.5, -1, 1);
  const gazeY = clamp(-(hp - cur.headPitch) / 0.45, -1, 1);
  p.headYaw += (headYaw - p.headYaw) * w;
  p.twist += (twist - p.twist) * w;
  p.headPitch += (headPitch - p.headPitch) * w;
  p.gazeX += (gazeX - p.gazeX) * w;
  p.gazeY += (gazeY - p.gazeY) * w;
}

// ------------------------------------------------------------------- emotes
const puro: ClipDef = {
  kind: "emote", name: "puro", dur: 2.1, fadeIn: 0.2, fadeOut: 0.35, mask: MASK_ARMS | MASK_FACE | MASK_HEAD | MASK_BODY,
  pose(p, run, a, env) {
    const t = run.t;
    // Cigar hand (+x): inner pocket → lips (back-out) → hold → lower.
    if (t < 0.3) lerp3(_a, _b.set(0.12, 0.25, 0.25), _c.set(0.06, 0.3, 0.2), easeInOut(t / 0.3));
    else if (t < 0.55) lerp3(_a, _b.set(0.06, 0.3, 0.2), _c.set(0.07, 0.5, 0.25), backOut((t - 0.3) / 0.25));
    else if (t < 1.65) _a.set(0.07, 0.5, 0.25);
    else lerp3(_a, _b.set(0.07, 0.5, 0.25), _c.set(0.16, 0.24, 0.3), easeIn((t - 1.65) / 0.45));
    const atLips = seg(t, 0.4, 0.55) * (1 - seg(t, 1.5, 1.7));
    if (atLips > 0) {
      a.puppet.toTorso(worldOf(a.face.mouthTip, _w), _b).add(_c.set(0.05, -0.08, 0.02));
      _a.lerp(_b, atLips);
    }
    p.handV(1, _a, 0.7, -0.6, -0.3);
    // Lighter hand (−x) comes up to the tip and flicks.
    const lw = seg(t, 0.25, 0.45) * (1 - seg(t, 0.85, 1.05));
    p.blendHand(0, -0.03, 0.48, 0.34, lw, -0.7, -0.6, -0.3);
    p.stretch += 0.06 * bump(t, 0.6, 0.95);
    p.lid = 0.72;
    p.brow = "skeptic";
    p.mouth = t > 0.75 && t < 1.55 && Math.sin(t * 15) > 0.2 ? "o" : "smirk";
    p.jaw = t > 0.75 && t < 1.55 ? 0.15 : 0;
    if (env.target) aimHead(p, a, env.target, 0.7);
    if (!armsFree(env)) return;
    a.pr.cigar.want = t > 0.22 && t < 1.9;
    a.pr.lighter.want = lw > 0.15;
    a.lighter.flame.scale.set(0.014, 0.05 * (0.8 + Math.sin(env.time * 40) * 0.25) * (t > 0.48 && t < 0.95 ? 1 : 0.001), 0.014);
    (a.cigar.ember.material as THREE.MeshToonMaterial).emissiveIntensity = 1.1 + bump(t, 0.6, 0.95) * 2.2;
    // Smoke blown at the rival (or straight ahead).
    if (t > 0.75 && t < 1.55 && fxOn(env)) {
      const n = emit(run, 16, env.dt);
      if (n) {
        worldOf(a.face.mouthTip, _w);
        if (env.target) _v.subVectors(env.target, _w).setY(0).normalize();
        else _v.set(Math.sin(a.root.rotation.y), 0, Math.cos(a.root.rotation.y));
        for (let i = 0; i < n; i++) {
          _c.copy(_v).multiplyScalar(1.1 + Math.random() * 0.5);
          _c.x += (Math.random() - 0.5) * 0.25;
          _c.y = 0.12 + Math.random() * 0.15;
          _c.z += (Math.random() - 0.5) * 0.25;
          env.particles.puff(_w, _c, 0.05 + Math.random() * 0.03, "#D9D4DA", 1.5, 2.8, 0.9);
        }
      }
    }
  },
};

const paraSay: ClipDef = {
  kind: "emote", name: "paraSay", dur: 2.3, fadeIn: 0.2, fadeOut: 0.35, mask: MASK_ARMS | MASK_FACE | MASK_HEAD | MASK_BODY,
  pose(p, run, a, env) {
    const t = run.t;
    // Wad hand (−x) holds the stack in front, then tosses it up.
    if (t < 1.45) _a.set(-0.08, 0.31, 0.27);
    else if (t < 1.7) lerp3(_a, _b.set(-0.08, 0.31, 0.27), _c.set(-0.22, 0.7, 0.16), backOut((t - 1.45) / 0.25));
    else lerp3(_a, _b.set(-0.22, 0.7, 0.16), _c.set(-0.16, 0.38, 0.3), easeInOut((t - 1.7) / 0.6));
    p.handV(0, _a);
    // Counting hand (+x): lick the thumb, then flick bills.
    if (t < 0.3) _a.set(0.06, 0.33, 0.29);
    else if (t < 0.45) lerp3(_a, _b.set(0.06, 0.33, 0.29), _c.set(0.04, 0.52, 0.25), easeOut((t - 0.3) / 0.15));
    else if (t < 0.6) lerp3(_a, _b.set(0.04, 0.52, 0.25), _c.set(0.06, 0.33, 0.29), easeInOut((t - 0.45) / 0.15));
    else if (t < 1.45) _a.set(0.06 + Math.sin(t * 16) * 0.02, 0.33 + Math.abs(Math.sin(t * 16)) * 0.03, 0.29);
    else if (t < 1.7) lerp3(_a, _b.set(0.06, 0.33, 0.29), _c.set(0.22, 0.72, 0.15), backOut((t - 1.45) / 0.25));
    else lerp3(_a, _b.set(0.22, 0.72, 0.15), _c.set(0.16, 0.38, 0.3), easeInOut((t - 1.7) / 0.6));
    p.handV(1, _a);
    p.headPitch = t < 1.45 ? 0.3 : -0.12;
    p.mouth = t > 0.35 && t < 0.55 ? "o" : "grin";
    p.jaw = t > 1.5 ? 0.25 + Math.abs(Math.sin(t * 17)) * 0.25 : 0;
    p.lid = t < 1.45 ? 0.85 : 1.3;
    p.brow = "up";
    p.stretch += 0.08 * bump(t, 1.45, 1.9);
    if (!armsFree(env)) return;
    a.pr.wad.want = t > 0.05 && t < 1.65;
    a.wad.top.rotation.y = t > 0.6 && t < 1.45 ? Math.sin(t * 16) * 0.35 : 0;
    if (t > 0.65 && t < 1.4 && emit(run, 3.5, env.dt) && fxOn(env)) {
      worldOf(a.wad.group, _w);
      env.particles.bill(_w, _c.set((Math.random() - 0.5) * 0.5, 0.9, (Math.random() - 0.5) * 0.5), 1.4);
    }
    if (once(run, 1, 1.62)) {
      worldOf(a.wad.group, _w);
      if (fxOn(env)) for (let i = 0; i < 9; i++) env.particles.bill(_w, _c.set((Math.random() - 0.5) * 1.6, 1.8 + Math.random() * 1.4, (Math.random() - 0.5) * 1.6));
      a.puppet.kick(3);
    }
  },
};

const yumruk: ClipDef = {
  kind: "emote", name: "yumruk", dur: 1.4, fadeIn: 0.1, fadeOut: 0.3, mask: MASK_ARMS | MASK_FACE | MASK_HEAD | MASK_BODY,
  pose(p, run, a, env) {
    const t = run.t;
    restT(a, 0, _c);
    _c.y -= 0.02;
    _c.z += 0.02;
    if (t < 0.22) lerp3(_a, _b.set(-0.2, 0.42, 0.22), _w.set(-0.24, 0.64, 0.12), easeOut(t / 0.22));
    else if (t < 0.3) lerp3(_a, _w.set(-0.24, 0.64, 0.12), _c, easeIn((t - 0.22) / 0.08));
    else if (t < 1.0) _a.copy(_c).add(_b.set(Math.sin(t * 46) * 0.012 * (1 - seg(t, 0.3, 1)), Math.abs(Math.sin(t * 23)) * 0.01, 0));
    else lerp3(_a, _c, restT(a, 0, _b), easeInOut((t - 1) / 0.4));
    p.handV(0, _a, -0.8, -0.2, -0.5);
    p.lean = t < 0.22 ? -0.1 * easeOut(t / 0.22) : t < 0.3 ? -0.1 + 0.35 * easeIn((t - 0.22) / 0.08) : 0.25 * (1 - smooth((t - 0.3) / 1.1));
    p.brow = "angry";
    p.mouth = "teeth";
    p.flush = 1;
    p.lid = 0.85;
    p.headPitch = 0.15;
    if (once(run, 1, 0.01)) a.puppet.kick(2);
    if (once(run, 2, 0.3)) {
      a.puppet.kick(-5, 3);
      if (!armsFree(env) || !fxOn(env)) return;
      // Chips and dust jump off the felt where the fist lands.
      a.puppet.refreshTorso();
      a.rig.torso.localToWorld(_w.copy(_c));
      for (let i = 0; i < 7; i++) env.particles.chip(_w, _v.set((Math.random() - 0.5) * 1.1, 1.4 + Math.random() * 1.1, (Math.random() - 0.5) * 1.1));
      for (let i = 0; i < 4; i++) env.particles.puff(_w, _v.set((Math.random() - 0.5) * 0.8, 0.2, (Math.random() - 0.5) * 0.8), 0.05, "#CFC7B8", 0.6, 2, 4);
    }
  },
};

const opucuk: ClipDef = {
  kind: "emote", name: "opucuk", dur: 1.5, fadeIn: 0.15, fadeOut: 0.35, mask: MASK_ARMS | MASK_FACE | MASK_HEAD,
  pose(p, run, a, env) {
    const t = run.t;
    if (t < 0.35) lerp3(_a, _b.set(-0.12, 0.4, 0.3), _c.set(-0.04, 0.55, 0.25), easeInOut(t / 0.35));
    else if (t < 0.6) lerp3(_a, _b.set(-0.04, 0.55, 0.25), _c.set(-0.32, 0.56, 0.3), backOut((t - 0.35) / 0.25));
    else _a.set(-0.32, 0.56, 0.3);
    p.handV(0, _a, -0.7, -0.6, -0.3);
    p.mouth = t < 0.5 ? "kiss" : "grin";
    p.headPitch = -0.1;
    p.lid = t < 0.5 ? 0.5 : 1.2;
    p.brow = "up";
    if (env.target) aimHead(p, a, env.target, 0.8);
    if (!armsFree(env) || !fxOn(env)) return;
    for (let k = 0; k < 3; k++) {
      if (!once(run, 1 << k, 0.45 + k * 0.12)) continue;
      worldOf(a.face.mouthTip, _w);
      if (env.target) _v.copy(env.target);
      else _v.set(Math.sin(a.root.rotation.y), 0, Math.cos(a.root.rotation.y)).multiplyScalar(1.6).add(_w);
      env.particles.heart(_w, _v, k === 0 ? 0.08 : 0.05, 0.9 + k * 0.1, 0.45 + k * 0.1);
    }
  },
};

const agla: ClipDef = {
  kind: "emote", name: "agla", dur: 2.6, fadeIn: 0.2, fadeOut: 0.4, mask: MASK_ARMS | MASK_FACE | MASK_HEAD | MASK_BODY,
  pose(p, run, a, env) {
    const t = run.t;
    if (t < 0.3) lerp3(_a, _b.set(-0.12, 0.35, 0.3), _c.set(-0.04, 0.55, 0.25), easeOut(t / 0.3));
    else _a.set(-0.04 + Math.sin(t * 30) * 0.008, 0.55, 0.25);
    p.handV(0, _a, -0.7, -0.6, -0.3);
    const honk = bump(t, 0.35, 0.7);
    p.headPitch = -0.15 * honk + 0.18 * seg(t, 0.7, 0.9);
    p.stretch += 0.06 * honk;
    p.mouth = "frown";
    p.brow = "sad";
    p.earDroop = 1;
    p.lid = 0.35;
    p.shrug = 0.45 + Math.sin(t * 16) * 0.45;
    p.headRoll = Math.sin(t * 8) * 0.05;
    if (once(run, 1, 0.5)) a.puppet.kick(2.5, 1);
    if (!armsFree(env)) return;
    a.pr.hanky.want = t > 0.08 && t < 2.35;
    const tears = t > 0.6 && t < 2.2;
    a.pr.bucketL.want = a.pr.bucketR.want = t > 0.45 && t < 2.45;
    const fill = 0.012 + 0.17 * seg(t, 0.6, 2.2);
    a.buckets[0].fill.position.y = a.buckets[1].fill.position.y = fill;
    if (!tears || !fxOn(env)) return;
    const n = emit(run, 22, env.dt);
    for (let i = 0; i < n; i++) {
      const side = (run.fired & 64) ? 1 : 0;
      run.fired ^= 64;
      const eye = a.face.eyes[side];
      if (!eye) continue;
      worldOf(eye.root, _w);
      worldOf(a.buckets[side === 0 ? 0 : 1].group, _c);
      _c.y += 0.2;
      _b.copy(_w).lerp(_c, 0.5);
      _b.y = Math.max(_w.y, _c.y) + 0.35;
      env.particles.dropArc(_w, _b, _c, 0.022, "#8EDCFF", 0.55);
    }
  },
};

const allahAllah: ClipDef = {
  kind: "emote", name: "allahAllah", dur: 1.9, fadeIn: 0.12, fadeOut: 0.35, mask: MASK_ARMS | MASK_FACE | MASK_HEAD | MASK_BODY,
  pose(p, run, _a2, _env) {
    const t = run.t;
    const up = backOut(seg(t, 0, 0.3));
    const sh = Math.sin(t * 14) * 0.02;
    p.blendHand(0, -0.38, 0.66 + sh, 0.2, up, -0.8, -0.3, -0.4);
    p.blendHand(1, 0.38, 0.66 - sh, 0.2, up, 0.8, -0.3, -0.4);
    p.headYaw = Math.sin(t * 9) * 0.28 * seg(t, 0.1, 0.3);
    p.headPitch = -0.12;
    p.mouth = "o";
    p.brow = "up";
    p.lid = 1.4;
    p.eyeScale = 1.12;
    p.stretch += 0.06;
    p.shrug = 0.6;
  },
};

export const EMOTE_CLIPS: Record<EmoteId, ClipDef> = { puro, paraSay, yumruk, opucuk, agla, allahAllah };

// -------------------------------------------------------------------- moods
function moodClip(name: Mood, mask: number, pose: ClipDef["pose"]): ClipDef {
  return { kind: "mood", name, dur: 1.65, fadeIn: 0.12, fadeOut: 0.4, mask, pose };
}

export const MOOD_CLIPS: Record<Exclude<Mood, "idle">, ClipDef> = {
  happy: moodClip("happy", MASK_FACE | MASK_BODY, (p, run) => {
    p.mouth = "grin";
    p.brow = "up";
    p.lid = 1.3;
    p.stretch += 0.06;
    p.bounce += Math.abs(Math.sin(run.t * 9)) * 0.012;
  }),
  cheer: moodClip("cheer", MASK_FACE | MASK_BODY | MASK_ARMS | MASK_HAT, (p, run) => {
    const t = run.t;
    const pump = Math.sin(t * 10) * 0.05;
    p.hand(0, -0.34, 0.7 + pump, 0.14, -0.8, -0.3, -0.3).hand(1, 0.34, 0.7 - pump, 0.14, 0.8, -0.3, -0.3);
    p.mouth = "grin";
    p.brow = "up";
    p.lid = 1.35;
    p.jaw = 0.3;
    p.stretch += 0.1;
    p.hatLift = 0.05;
    p.bounce += Math.abs(Math.sin(t * 10)) * 0.025;
  }),
  sad: moodClip("sad", MASK_FACE | MASK_HEAD | MASK_BODY, (p) => {
    p.mouth = "frown";
    p.brow = "sad";
    p.earDroop = 1;
    p.headPitch = 0.26;
    p.lid = 0.55;
    p.lean += 0.06;
    p.stretch -= 0.06;
    p.gazeY = -0.4;
  }),
  shock: moodClip("shock", MASK_FACE | MASK_BODY | MASK_ARMS, (p, run) => {
    const t = run.t;
    const jerk = bump(t, 0, 0.9);
    p.blendHand(0, -0.22, 0.48, 0.28, jerk, -0.8, -0.4, -0.4);
    p.blendHand(1, 0.22, 0.48, 0.28, jerk, 0.8, -0.4, -0.4);
    p.mouth = "o";
    p.brow = "up";
    p.lid = 1.6;
    p.eyeScale = 1.18;
    p.lean -= 0.2 * (1 - seg(t, 0.5, 1.2));
    p.stretch += 0.08;
  }),
  angry: moodClip("angry", MASK_FACE | MASK_HEAD | MASK_BODY, (p) => {
    p.mouth = "teeth";
    p.brow = "angry";
    p.flush = 1;
    p.lean += 0.1;
    p.headPitch = 0.12;
    p.lid = 0.85;
  }),
  nervous: moodClip("nervous", MASK_FACE | MASK_HEAD, (p, run, a, env) => {
    const t = run.t;
    p.mouth = "flat";
    p.brow = "skeptic";
    p.headRoll = Math.sin(t * 13) * 0.06;
    p.gazeX = Math.sin(t * 5.3) * 0.7;
    p.lid = 1.2;
    if (once(run, 1, 0.25) && fxOn(env)) {
      a.face.head.localToWorld(_w.set(0.17, 0.3, 0.08));
      env.particles.drop(_w, _v.set(0, -0.1, 0), 0.02, "#BFE9FF", 1.1, 2.2);
    }
  }),
  laugh: moodClip("laugh", MASK_FACE | MASK_HEAD | MASK_BODY | MASK_ARMS, (p, run) => {
    const t = run.t;
    const ha = Math.abs(Math.sin(t * 18));
    p.mouth = "grin";
    p.brow = "up";
    p.lid = 0.45;
    p.headPitch = -0.15 + Math.sin(t * 18) * 0.06;
    p.jaw = 0.3 + ha * 0.25;
    p.bounce += ha * 0.02;
    p.shrug = ha * 0.5;
  }),
};

// ----------------------------------------------------------------- gestures
const knock: ClipDef = {
  kind: "gesture", name: "knock", dur: 0.62, fadeIn: 0.08, fadeOut: 0.22, mask: MASK_ARMS | MASK_BODY,
  pose(p, run, a) {
    const t = run.t;
    restT(a, 0, _c);
    _c.z -= 0.03;
    const lift = _b.copy(_c).add(_w.set(0, 0.11, -0.03));
    if (t < 0.14) lerp3(_a, _c, lift, easeOut(t / 0.14));
    else if (t < 0.2) lerp3(_a, lift, _c, easeIn((t - 0.14) / 0.06));
    else if (t < 0.27) lerp3(_a, _c, _w.copy(_c).setY(_c.y + 0.06), easeOut((t - 0.2) / 0.07));
    else if (t < 0.33) lerp3(_a, _w.copy(_c).setY(_c.y + 0.06), _c, easeIn((t - 0.27) / 0.06));
    else _a.copy(_c);
    p.handV(0, _a, -0.8, -0.3, -0.4);
    p.lean += 0.08 * bump(t, 0, 0.6);
    if (once(run, 1, 0.2) || once(run, 2, 0.33)) a.puppet.kick(-1.2);
  },
};

/** KASALA: both hands up, SLAM on the felt at 0.26 s, rake the pot in (done by 0.62 s, when the cash clip rises). */
const slam: ClipDef = {
  kind: "gesture", name: "slam", dur: 0.95, fadeIn: 0.08, fadeOut: 0.25, mask: MASK_ARMS | MASK_BODY | MASK_FACE,
  pose(p, run, a, env) {
    const t = run.t;
    for (let i = 0; i < 2; i++) {
      restT(a, i, _c);
      const up = _b.copy(_c).add(_w.set(0, 0.16, -0.06));
      if (t < 0.18) lerp3(_a, _c, up, easeOut(t / 0.18));
      else if (t < 0.26) lerp3(_a, up, _w.copy(_c).add(_v.set(0, -0.015, 0.03)), easeIn((t - 0.18) / 0.08));
      else if (t < 0.34) _a.copy(_c).add(_v.set(0, -0.015, 0.03));
      else if (t < 0.62) lerp3(_a, _w.copy(_c).add(_v.set(0, -0.015, 0.03)), _b.copy(_c).add(_v.set(0, -0.02, -0.13)), easeInOut((t - 0.34) / 0.28));
      else lerp3(_a, _b.copy(_c).add(_v.set(0, -0.02, -0.13)), _c, easeInOut(seg(t, 0.62, 0.82)));
      p.handV(i, _a, i === 0 ? -0.8 : 0.8, -0.3, -0.4);
    }
    p.lean += t < 0.18 ? -0.06 * easeOut(t / 0.18) : t < 0.26 ? 0.22 * easeIn((t - 0.18) / 0.08) : 0.22 * (1 - smooth((t - 0.26) / 0.6));
    p.mouth = "grin";
    p.brow = "up";
    if (once(run, 1, 0.26)) {
      a.puppet.kick(-4, 2);
      if (!armsFree(env) || !fxOn(env)) return;
      for (let i = 0; i < 2; i++) for (let k = 0; k < 2; k++) env.particles.puff(a.rest[i]!, _v.set((Math.random() - 0.5) * 0.7, 0.15, (Math.random() - 0.5) * 0.7), 0.04, "#CFC7B8", 0.5, 2, 4);
    }
  },
};

const push: ClipDef = {
  kind: "gesture", name: "push", dur: 0.8, fadeIn: 0.1, fadeOut: 0.25, mask: MASK_ARMS | MASK_BODY,
  pose(p, run, a) {
    const t = run.t;
    restT(a, 0, _c);
    const fwd = _b.copy(_c).add(_w.set(0.05, -0.02, 0.17));
    if (t < 0.35) lerp3(_a, _c, fwd, easeOut(t / 0.35));
    else if (t < 0.45) _a.copy(fwd);
    else lerp3(_a, fwd, _c, easeInOut((t - 0.45) / 0.35));
    p.handV(0, _a, -0.8, -0.3, -0.4);
    p.lean += 0.2 * bump(t, 0, 0.75);
  },
};

export const GESTURE_CLIPS: Record<GestureKind, ClipDef> = { knock, slam, push };

// --------------------------------------------------------------------- cash
/**
 * KASALA celebration, sized to the result phase. It starts together with the slam + rake gesture and leaves
 * the arms to it until the rake is done (0.6 s), then: dip, half-stand, fists up, hat lift (one full spin when
 * big, written wrapped so it never unwinds), bills.
 */
export const CASH_CLIP: ClipDef = {
  kind: "cash", name: "cash", dur: 2.2, fadeIn: 0.15, fadeOut: 0.5, mask: MASK_ARMS | MASK_BODY | MASK_FACE | MASK_HAT | MASK_HEAD,
  pose(p, run, a, env) {
    const t = run.t;
    const end = run.dur - 0.55;
    const rise = backOut(seg(t, 0.6, 0.9)) * (1 - easeInOut(seg(t, end - 0.15, end + 0.3)));
    const pump = t > 0.9 ? Math.sin((t - 0.9) * 10) * 0.05 : 0;
    p.bounce += -0.04 * bump(t, 0.5, 0.68) + Math.abs(pump) * 0.4;
    p.sit = 1 - 0.65 * rise;
    p.blendHand(0, -0.34, 0.72 + pump, 0.12, rise, -0.8, -0.3, -0.3);
    p.blendHand(1, 0.34, 0.72 - pump, 0.12, rise, 0.8, -0.3, -0.3);
    p.stretch += 0.12 * rise;
    p.hatLift = 0.06 * rise;
    if (run.big) p.hatSpin = wrapAngle(Math.PI * 2 * backOut(seg(t, 0.85, 1.4)));
    p.mouth = "grin";
    p.brow = "up";
    p.lid = 1.35;
    p.jaw = 0.2 + rise * 0.2;
    p.headPitch -= 0.12 * rise;
    if (once(run, 1, 0.55)) a.puppet.kick(-2);
    if (once(run, 2, 0.66)) a.puppet.kick(4, 1.5);
    if (!armsFree(env) || !fxOn(env)) return;
    const rate = run.big ? 18 : 7;
    if (t > 0.65 && t < (run.big ? 1.9 : 1.25)) {
      const n = emit(run, rate, env.dt);
      if (n) {
        worldOf(a.face.hatMount, _w);
        _w.y += 0.25;
        for (let i = 0; i < n; i++) env.particles.bill(_w, _v.set((Math.random() - 0.5) * 1.6, 1 + Math.random() * 1.8, (Math.random() - 0.5) * 1.3));
      }
    }
  },
};

// --------------------------------------------------------------------- idle
const hatTip: ClipDef = {
  kind: "idle", name: "hatTip", dur: 1.3, fadeIn: 0.3, fadeOut: 0.35, mask: MASK_ARMS | MASK_HAT,
  pose(p, run) {
    const t = run.t;
    const w = smooth(seg(t, 0, 0.35)) * (1 - smooth(seg(t, 0.85, 1.2)));
    p.blendHand(0, -0.11, 0.77, 0.2, w, -0.8, -0.2, -0.3);
    p.hatTilt = 0.22 * bump(t, 0.3, 1.0);
    p.hatLift = 0.025 * bump(t, 0.35, 0.8);
  },
};
const drum: ClipDef = {
  kind: "idle", name: "drum", dur: 1.4, fadeIn: 0.2, fadeOut: 0.3, mask: MASK_ARMS,
  pose(p, run, a) {
    restT(a, 0, _a);
    _a.y += Math.abs(Math.sin(run.t * 22)) * 0.016;
    p.handV(0, _a, -0.8, -0.3, -0.4);
  },
};
const tie: ClipDef = {
  kind: "idle", name: "tie", dur: 1.3, fadeIn: 0.3, fadeOut: 0.35, mask: MASK_ARMS | MASK_HEAD,
  pose(p, run) {
    const t = run.t;
    p.hand(1, 0.03 + Math.sin(t * 20) * 0.01 * bump(t, 0.4, 0.9), 0.43, 0.24, 0.8, -0.5, -0.3);
    p.headPitch = 0.12 * bump(t, 0.2, 0.9) - 0.08 * bump(t, 0.9, 1.3);
  },
};
const stretchIdle: ClipDef = {
  kind: "idle", name: "stretch", dur: 1.6, fadeIn: 0.35, fadeOut: 0.4, mask: MASK_ARMS | MASK_BODY | MASK_HEAD,
  pose(p, run) {
    const t = run.t;
    p.shrug = bump(t, 0.1, 0.8);
    p.stretch += 0.06 * bump(t, 0.1, 0.9);
    p.lean -= 0.08 * bump(t, 0.1, 0.9);
    p.headRoll = 0.15 * bump(t, 0.6, 1.0) - 0.15 * bump(t, 1.0, 1.4);
  },
};
const watch: ClipDef = {
  kind: "idle", name: "watch", dur: 1.4, fadeIn: 0.3, fadeOut: 0.35, mask: MASK_ARMS | MASK_HEAD,
  pose(p) {
    p.hand(1, 0.1, 0.42, 0.3, 0.8, -0.5, -0.3);
    p.headPitch = 0.35;
    p.gazeY = -0.6;
  },
};

export const IDLE_CLIPS: readonly ClipDef[] = [hatTip, drum, tie, stretchIdle, watch];
