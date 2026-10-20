// Scripted sequences: the base layer of an actor while something happens TO them. Each one runs on a single
// clock that drives the actor, Komiser Rıfat and the props together, fits the time it is given (the raid fits
// the server's result phase) and ends in a settled pose, so nothing teleports or snaps afterwards:
//   raid    — long: the door bursts, Rıfat walks a planned path (around the chairs, behind Cemil, through the
//             door opening), cuffs the victim (or bags them) and drags them out; they come back with a black
//             eye. Wallet / mugshot: Rıfat stays in the doorway. Short: everything happens at the seat.
//   eliminate — cement shoes: escorted to the pier, buckets on the feet, teeter, ŞLAP at 2.6 s, sink, and only
//             then the ghost rises out of the water and floats back to the chair. The pier sinks away after.
//   podium  — walk to a slot (piles for places 1–3, the floor in front for the rest), hop up, face the camera.
//   return  — the ghost comes back from the river: wet, dog-shake, cheer.
// Emotes still play on top as clips, masked away from the channels a sequence locks. Owner: client-characters.

import * as THREE from "three";
import type { RaidAnim } from "../../../../shared/constants";
import { DOOR_X, ROOM_BACK_Z, SEAT_RADIUS } from "../room/layout";
import type { StageAnchors } from "../Stage";
import { MASK_ARMS, MASK_BODY, MASK_HEAD, type Pose, type Skin } from "./body";
import type { Actor, Npc, PropHandle, PropSet } from "./cast";
import { aimHead } from "./clips";
import type { Particles } from "./particles";
import { stretchStrand, type BoxCamera, type Bucket, type NumberPlate, type Pier } from "./props";
import {
  Path, Pop, approachAngle, arcSide, backOut, bounceOut, bump, clamp, easeIn, easeInOut, easeOut, lerp,
  planPoints, ramp, seg, smooth, wrapAngle, yawTo,
} from "./util";

/** Walking ring around the table: clears the chairs and passes behind Cemil Abi. */
export const RING = SEAT_RADIUS + 0.55;
const LEASH = 0.75;
const CUFF_SEC = 0.6;
const BACK_SEC = 0.7;
const WALK_IN_SEC = 0.95;
/** Long kelepçe: the cuffs click at this time (door kick at 0, Rıfat at the seat at 1.3 s). Quick version: 0.85 s. */
export const RAID_CUFFS_AT = 0.35 + WALK_IN_SEC + CUFF_SEC * 0.5;

export interface Shared {
  props: PropSet;
  cuffs: [THREE.Mesh, THREE.Mesh];
  cuffH: [PropHandle, PropHandle];
  chain: [THREE.Mesh, THREE.Mesh];
  rope: [THREE.Mesh, THREE.Mesh];
  stars: THREE.Group;
  starsH: PropHandle;
  plate: NumberPlate;
  plateH: PropHandle;
  board: THREE.Group;
  boardH: PropHandle;
  camera: BoxCamera;
  cameraH: PropHandle;
  cement: [Bucket, Bucket];
  cementH: [PropHandle, PropHandle];
  pier: Pier;
  pierPop: Pop;
}

export interface SeqEnv {
  anchors: StageAnchors;
  particles: Particles;
  cop: Npc;
  shared: Shared;
  time: number;
  dt: number;
  /** The actor is my own body seen from inside (first person): its own particles are left out. */
  inside: boolean;
}

/** A raid pose my first-person arms take over while the hidden body plays it (see RaidSeq.fpHold). */
export interface FpHold {
  pose: "plate" | "cuffed" | "wallet";
  left: number;
}

export abstract class Seq {
  abstract readonly kind: "raid" | "eliminate" | "podium" | "return";
  t = 0;
  dur = 1;
  /** Channels clips may not write while this runs (emotes become face-only, never cancel the sequence). */
  lock = MASK_BODY | MASK_ARMS;
  /** The root left the seat (the chair stays pushed out). */
  away = false;
  /** The root is out of sight (behind the door, under the water). */
  hidden = false;
  /** Chair push-out 0..1 (null: follow the sit amount). */
  chairOut: number | null = null;
  /** Skin override while running (cement shoes: still alive until the splash). */
  skin: Skin | null = null;
  /** Ask the orchestrator to jump the puppet to this frame's pose (after a hidden teleport). */
  settleNow = false;
  /** Seconds the local first-person camera should leave the body (0 = stay). */
  outOfBodySec = 0;
  private bits = 0;
  abstract update(a: Actor, p: Pose, env: SeqEnv): void;
  /** Leave everything clean (also when interrupted). */
  finish(_a: Actor, _env: SeqEnv): void {}
  get done(): boolean {
    return this.t >= this.dur;
  }
  protected once(bit: number, at: number): boolean {
    if (this.t < at || this.bits & bit) return false;
    this.bits |= bit;
    return true;
  }
}

// ----------------------------------------------------------------- helpers
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Vector3();
const _w = new THREE.Vector3();
const _x = new THREE.Vector3();

/** Seated at the table, hands resting on the rail. */
export function seatedRest(a: Actor, p: Pose): void {
  p.sit = 1;
  p.handV(0, a.puppet.toTorso(a.rest[0], _x), -0.8, -0.35, -0.45);
  p.handV(1, a.puppet.toTorso(a.rest[1], _x), 0.8, -0.35, -0.45);
}

/** Ghost float over the chair (§10 hayalet). */
export function ghostPose(p: Pose, time: number, seed: number): void {
  p.sit = 0.7;
  p.bounce += 0.12 + Math.sin(time * 2.1 + seed) * 0.08;
  p.dangle = 0.6;
  const drift = Math.sin(time * 1.3 + seed) * 0.04;
  p.hand(0, -0.2, 0.28 + drift, 0.3, -0.7, -0.6, -0.3).hand(1, 0.2, 0.28 - drift, 0.3, 0.7, -0.6, -0.3);
  p.lid = 1.1;
  p.mouth = "o";
  p.headRoll = Math.sin(time * 1.1 + seed) * 0.08;
}

function hangHands(p: Pose): void {
  p.hand(0, -0.25, 0.05, 0.07, -0.7, -0.2, -0.6).hand(1, 0.25, 0.05, 0.07, 0.7, -0.2, -0.6);
}

/** Hands cuffed behind the back. */
function handsBehind(p: Pose, w = 1): void {
  p.blendHand(0, -0.06, 0.12, -0.17, w, -0.8, 0, -0.6);
  p.blendHand(1, 0.06, 0.12, -0.17, w, 0.8, 0, -0.6);
  p.armSwing = 0;
}

function sagStrand(s: [THREE.Mesh, THREE.Mesh], from: THREE.Vector3, to: THREE.Vector3, sag: number): void {
  _m.copy(from).lerp(to, 0.5);
  _m.y -= sag;
  stretchStrand(s[0], from, _m);
  stretchStrand(s[1], _m, to);
  s[0].visible = s[1].visible = true;
}
function hideStrand(s: [THREE.Mesh, THREE.Mesh]): void {
  s[0].visible = s[1].visible = false;
}

function wristsMid(a: Actor, out: THREE.Vector3): THREE.Vector3 {
  a.rig.arms[0].hand.getWorldPosition(out);
  a.rig.arms[1].hand.getWorldPosition(_w);
  return out.add(_w).multiplyScalar(0.5);
}

/**
 * A walk from the seat to `to`: side-step out of the chair (toward the travel direction), out to the ring,
 * around it, then `extra` waypoints. Returns the path and the distance of the "stand beside the chair" point.
 */
function exitPath(a: Actor, to: THREE.Vector3, extra: THREE.Vector3[]): { path: Path; dStand: number } {
  const side = arcSide(a.home, to) > 0 ? -1 : 1;
  const p0 = a.home.clone().setY(0);
  const p1 = p0.clone().addScaledVector(a.right, side * 0.5);
  const p2 = p0.clone().addScaledVector(a.right, side * 0.62).addScaledVector(a.out, 0.34);
  const pts = [p0, p1, ...planPoints(p2, to, RING), ...extra];
  const path = new Path(pts);
  return { path, dStand: path.distOf(2) };
}

/** Walk an npc / actor root along a path: position + facing (travel direction, or reversed). */
function walkAlong(root: THREE.Object3D, path: Path, d: number, backwards: boolean, dt: number, rate = 11): void {
  const yaw = path.at(d, _d);
  root.position.x = _d.x;
  root.position.z = _d.z;
  root.rotation.y = approachAngle(root.rotation.y, backwards ? yaw + Math.PI : yaw, rate, dt);
}

function face(root: THREE.Object3D, target: THREE.Vector3, dt: number, rate = 9): void {
  root.rotation.y = approachAngle(root.rotation.y, yawTo(root.position, target), rate, dt);
}

function npcPose(cop: Npc): Pose {
  const p = cop.puppet.target.reset();
  p.sit = 0;
  hangHands(p);
  return p;
}

const _p1 = new THREE.Vector3();
const _p2 = new THREE.Vector3();
/** A point 0.46 m from a shoulder toward a world target, in the npc's torso space (pointing). */
function pointAt(n: Npc, i: number, target: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
  n.rig.arms[i]!.shoulder.getWorldPosition(_p1);
  _p1.addScaledVector(_p2.subVectors(target, _p1).normalize(), 0.46);
  return n.puppet.toTorso(_p1, out);
}

function blendHandV(p: Pose, i: number, v: THREE.Vector3, w: number, px: number, py: number, pz: number): void {
  p.blendHand(i, v.x, v.y, v.z, w, px, py, pz);
}

// ===================================================================== raid
export interface RaidOpts {
  anim: RaidAnim;
  long: boolean;
  sec: number;
}

type RaidMode = "drag" | "door" | "seat";

export class RaidSeq extends Seq {
  readonly kind = "raid";
  readonly anim: RaidAnim;
  readonly mode: RaidMode;
  private path: Path | null = null;
  private dStand = 0;
  private dThr = 0;
  private copStart = 0;
  private lin = 0;
  private lout = 0;
  private t1 = 0;
  private t2 = 0;
  private t3 = 0;
  private tRet = 0;
  private door: Path;
  private flashAt = -1;
  private dash = false;
  private behind = new THREE.Vector3();

  constructor(a: Actor, opts: RaidOpts, env: SeqEnv) {
    super();
    this.anim = opts.anim;
    this.dur = Math.max(2.6, opts.sec - 0.25);
    const thr = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z + 0.02);
    const inside = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z + 0.85);
    this.door = new Path([thr, inside]);
    let mode: RaidMode = "seat";
    if (opts.long && (opts.anim === "kelepce" || opts.anim === "cuval")) mode = this.planDrag(a) ? "drag" : "seat";
    else if (opts.long) mode = "door";
    this.mode = mode;
    this.lock = MASK_BODY | MASK_ARMS | (mode === "drag" || (mode === "seat" && (opts.anim === "kelepce" || opts.anim === "cuval")) ? MASK_HEAD : 0);
    this.behind.copy(a.home).addScaledVector(a.out, 0.68).setY(0);
    if (mode === "drag") this.outOfBodySec = this.tRet + 0.35;
    else if (mode === "seat" && opts.anim === "cuval") this.outOfBodySec = this.dur;
    const sh = env.shared;
    if (opts.anim === "kelepce") {
      for (let i = 0; i < 2; i++) {
        a.rig.arms[i]!.hand.add(sh.cuffs[i]!);
        sh.cuffs[i]!.position.set(0, 0.0, 0);
      }
    }
    if (opts.anim === "sabika" || opts.anim === "kelepce") {
      a.root.add(sh.plate.group);
      sh.plate.redraw();
    }
  }

  private planDrag(a: Actor): boolean {
    const doorIn = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z + 0.85);
    const thr = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z + 0.02);
    const outside = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z - 1.2);
    const { path, dStand } = exitPath(a, doorIn, [thr, outside]);
    this.path = path;
    this.dStand = dStand;
    this.dThr = path.distOf(path.points.length - 2);
    this.copStart = this.dThr - 0.05;
    this.lin = Math.max(0.3, this.copStart - dStand);
    this.lout = this.dThr + 0.4 + LEASH - dStand;
    // Fixed beats (the door kick, Rıfat's arrival and the cuffs land at the same time from every seat, so
    // sounds can be timed): far seats get a dash, the drag-out takes the rest of the time.
    const tin = WALK_IN_SEC;
    const avail = this.dur - 0.35 - tin - CUFF_SEC - BACK_SEC - 0.1;
    if (avail < this.lout / 7) return false;
    const tout = Math.min(avail, Math.max(this.lout / 3.4, avail * 0.8));
    this.dash = this.lin / tin > 5.5;
    this.t1 = 0.35 + tin;
    this.t2 = this.t1 + CUFF_SEC;
    this.t3 = this.t2 + tout;
    this.tRet = this.t3 + 0.05;
    return true;
  }

  update(a: Actor, p: Pose, env: SeqEnv): void {
    if (this.mode === "drag") this.updateDrag(a, p, env);
    else if (this.mode === "door") this.updateDoor(a, p, env);
    else this.updateSeat(a, p, env);
  }

  /**
   * What the victim's hands hold from now on, for my first-person arms (the hidden body cannot show it): the
   * mugshot plate, the cuffed hands or the empty wallet, and for how long. null = nothing (or out of body).
   */
  fpHold(): FpHold | null {
    const t = this.t;
    const D = this.dur;
    let hold: FpHold | null = null;
    if (this.mode === "drag") {
      if (this.anim === "kelepce") hold = { pose: "plate", left: this.tRet + 1.3 - t };
    } else if (this.anim === "bosCuzdan") hold = { pose: "wallet", left: D - 0.5 - t };
    else if (this.anim === "sabika") hold = { pose: "plate", left: D - 0.6 - t };
    else if (this.anim === "kelepce" && this.mode === "seat") hold = { pose: "cuffed", left: D - 0.45 - t };
    return hold && hold.left > 0.3 ? hold : null;
  }

  // ---------------------------------------------------------------- drag
  private updateDrag(a: Actor, p: Pose, env: SeqEnv): void {
    const t = this.t;
    const dt = env.dt;
    const path = this.path!;
    const cop = env.cop;
    const sh = env.shared;
    const kelepce = this.anim === "kelepce";
    if (this.once(1, 0)) {
      const yaw = path.at(this.copStart, _a);
      cop.appear(_a, yaw + Math.PI, false);
      cop.owner = this;
    }
    // ---- Komiser Rıfat
    let dC = this.copStart;
    if (cop.owner === this && cop.shown) {
      const cp = npcPose(cop);
      cp.mouth = "teeth";
      cp.brow = "angry";
      cop.puppet.refreshTorso();
      if (t < 0.35) {
        cp.legHip[1] = -1.3 * backOut(seg(t, 0, 0.18)) * (1 - smooth(seg(t, 0.2, 0.35)));
        cp.hand(0, -0.3, 0.5, 0.25).hand(1, 0.3, 0.5, 0.25);
        cp.lean = -0.1;
      } else if (t < this.t1) {
        dC = this.copStart - this.lin * ramp((t - 0.35) / (this.t1 - 0.35), this.dash ? 0.12 : 0.18);
        walkAlong(cop.root, path, dC, true, dt, this.dash ? 16 : 11);
        cp.walk = 1;
        cp.lean = this.dash ? 0.32 : 0.12;
        if (this.dash && Math.sin(t * 50) > 0.5) {
          cop.root.localToWorld(_b.set(0, 0.05, -0.25));
          env.particles.puff(_b, _c.set((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4), 0.07, "#C9BFAE", 0.5, 2.2, 3);
        }
      } else if (t < this.t2) {
        dC = this.dStand;
        path.at(dC, _a);
        cop.root.position.x = _a.x;
        cop.root.position.z = _a.z;
        face(cop.root, a.root.position, dt);
        const u = seg(t, this.t1, this.t2);
        const reach = smooth(seg(u, 0.1, 0.45));
        for (let i = 0; i < 2; i++) {
          a.rig.arms[i]!.hand.getWorldPosition(_b);
          blendHandV(cp, i, cop.puppet.toTorso(_b, _c), reach, i === 0 ? -0.6 : 0.6, -0.5, 0.2);
        }
        cp.lean = 0.25 * reach;
      } else {
        dC = this.dStand + this.lout * ramp((t - this.t2) / (this.t3 - this.t2), 0.15);
        walkAlong(cop.root, path, dC, false, dt);
        cp.walk = 1;
        cp.lean = 0.16;
        cp.hand(0, -0.17, 0.62, -0.05, -0.8, -0.2, 0.4);
        cp.armSwing = 0.5;
        if (dC > this.dThr + 0.25) cop.vanish(true);
      }
      if (t < this.t2) aimHead(cp, cop, a.face.head.getWorldPosition(_b), 0.9);
    } else if (t >= this.t2) dC = this.dStand + this.lout * ramp((t - this.t2) / (this.t3 - this.t2), 0.15);

    // ---- the victim
    a.puppet.refreshTorso();
    if (t < this.t1) {
      seatedRest(a, p);
      const fl = bump(t, 0.05, this.t1 + 0.4);
      p.blendHand(0, -0.22, 0.5, 0.28, fl * 0.8, -0.8, -0.4, -0.4);
      p.blendHand(1, 0.22, 0.5, 0.28, fl * 0.8, 0.8, -0.4, -0.4);
      p.mouth = "o";
      p.brow = "up";
      p.lid = 1.5;
      p.lean = -0.12;
      p.headRoll = Math.sin(t * 30) * 0.03;
      if (cop.shown) aimHead(p, a, cop.face.head.getWorldPosition(_b), 1);
      if (this.once(2, 0.02)) a.puppet.kick(-4);
    } else if (t < this.t2) {
      const u = seg(t, this.t1, this.t2);
      this.chairOut = 1;
      p.sit = 1 - easeInOut(seg(u, 0, 0.55));
      if (kelepce) {
        seatedRest(a, p);
        p.sit = 1 - easeInOut(seg(u, 0, 0.55));
        handsBehind(p, smooth(seg(u, 0.15, 0.6)));
        sh.cuffH[0].want = sh.cuffH[1].want = u > 0.5;
      } else {
        hangHands(p);
        a.pr.sack.obj.position.y = 0.6 * (1 - bounceOut(seg(u, 0.2, 0.75)));
        a.pr.sack.want = u > 0.15;
        p.blendHand(0, -0.2, 0.55, 0.25, bump(u, 0.4, 1), -0.8, -0.4, -0.4);
        p.blendHand(1, 0.2, 0.55, 0.25, bump(u, 0.4, 1), 0.8, -0.4, -0.4);
      }
      p.mouth = kelepce ? "o" : "flat";
      p.brow = "up";
      if (cop.shown) aimHead(p, a, cop.face.head.getWorldPosition(_b), 0.8);
      if (this.once(4, this.t1 + CUFF_SEC * 0.5)) a.puppet.kick(-2.5, 2);
    } else if (t < this.tRet) {
      const dV = Math.max(0, dC - LEASH);
      this.away = dV > 0.05;
      this.chairOut = 1;
      walkAlong(a.root, path, dV, kelepce, env.dt, 9);
      p.sit = 0;
      if (kelepce) {
        // Dragged backwards by the cuffs: heels skid, body leans toward the cop.
        handsBehind(p);
        p.legHip[0] = p.legHip[1] = -0.38;
        p.legKnee[0] = p.legKnee[1] = 0.15;
        p.tiltX = -0.16 * smooth(seg(dV, 0, 0.3));
        p.lean = -0.12;
        p.mouth = "o";
        p.brow = "up";
        p.lid = 1.4;
        p.headRoll = Math.sin(t * 9) * 0.12;
        p.headYaw = Math.sin(t * 3.7) * 0.4;
        if (dV > 0.05 && Math.sin(t * 40) > 0.9) {
          a.root.localToWorld(_b.set(0, 0.03, 0.3));
          env.particles.puff(_b, _c.set((Math.random() - 0.5) * 0.3, 0.25, (Math.random() - 0.5) * 0.3), 0.04, "#B8AC98", 0.6, 2, 3);
        }
      } else {
        // Blind under the sack: stumbles after the cop, gropes, bumps into things.
        a.pr.sack.want = true;
        a.pr.sack.obj.position.y = 0;
        p.walk = 1;
        p.armSwing = 0;
        const g = Math.sin(t * 7) * 0.04;
        p.hand(0, -0.17, 0.38 + g, 0.32, -0.7, -0.3, -0.4).hand(1, 0.17, 0.38 - g, 0.32, 0.7, -0.3, -0.4);
        const u = seg(t, this.t2, this.t3);
        const hit = bump(u, 0.26, 0.36) + bump(u, 0.58, 0.68);
        p.tiltZ = 0.25 * hit * (u < 0.5 ? 1 : -1);
        p.headRoll = Math.sin(t * 6) * 0.15;
        p.mouth = "flat";
        if (this.once(8, this.t2 + (this.t3 - this.t2) * 0.28) || this.once(16, this.t2 + (this.t3 - this.t2) * 0.6)) a.puppet.kick(-3, 3);
      }
      this.hidden = dV > this.dThr + 0.15;
      // Cuffs chained to Rıfat's fist (or a rope to the sack's neck).
      if (!this.hidden) {
        const strand = kelepce ? sh.chain : sh.rope;
        const from = kelepce ? wristsMid(a, _a) : a.rig.neck.getWorldPosition(_a);
        if (cop.shown) cop.rig.arms[0].grip.getWorldPosition(_b);
        else {
          path.at(this.dThr + 0.1, _b);
          _b.y = 1.0;
        }
        sagStrand(strand, from, _b, 0.06);
      } else {
        hideStrand(sh.chain);
        hideStrand(sh.rope);
      }
      if (kelepce) sh.cuffH[0].want = sh.cuffH[1].want = true;
    } else {
      // Back in the chair: black eye, stars, the mugshot plate for a moment.
      if (this.once(32, this.tRet)) {
        this.hidden = false;
        this.away = false;
        a.root.position.copy(a.home);
        a.root.rotation.y = a.yaw;
        a.puppet.resetMotion();
        this.settleNow = true;
        hideStrand(sh.chain);
        hideStrand(sh.rope);
        a.blackEye = true;
        a.chairOut = 0;
        a.chairVel[0] = 0;
        a.face.head.getWorldPosition(_b);
        env.particles.poof(_b.setY(_b.y - 0.2), 0.16, "#E9E4F0", 16);
        a.puppet.kick(3, 2);
      }
      this.chairOut = null;
      seatedRest(a, p);
      this.dizzy(p, t);
      sh.starsH.want = true;
      if (kelepce && t < this.tRet + 1.3) this.holdPlate(a, p, sh, 0);
    }
  }

  private dizzy(p: Pose, t: number): void {
    p.headRoll = Math.sin(t * 6) * 0.15;
    p.headYaw = Math.sin(t * 4.1) * 0.2;
    p.lid = 0.55;
    p.mouth = "frown";
    p.brow = "sad";
    p.gazeX = Math.sin(t * 9) * 0.8;
    p.gazeY = Math.cos(t * 9) * 0.6;
  }

  /** The number plate held at the chest with both hands (`up`: 0 seated … 1 standing). */
  private holdPlate(a: Actor, p: Pose, sh: Shared, up: number): void {
    const plate = sh.plate.group;
    plate.position.set(0, lerp(1.0, 1.1, up), lerp(0.3, 0.34, up));
    plate.rotation.set(0.12, 0, 0);
    sh.plateH.want = true;
    plate.updateWorldMatrix(true, false);
    for (let i = 0; i < 2; i++) {
      plate.localToWorld(_b.set(i === 0 ? -0.42 : 0.42, -0.15, -0.6));
      p.handV(i, a.puppet.toTorso(_b, _c), i === 0 ? -0.8 : 0.8, -0.5, -0.3);
    }
    p.armSwing = 0;
  }

  // ------------------------------------------------- doorway (wallet, mugshot)
  private updateDoor(a: Actor, p: Pose, env: SeqEnv): void {
    const t = this.t;
    const cop = env.cop;
    const D = this.dur;
    if (this.once(1, 0)) {
      const yaw = this.door.at(0, _a);
      cop.appear(_a, yaw, false);
      cop.owner = this;
      if (this.anim === "sabika") {
        cop.face.head.add(env.shared.camera.group);
        env.shared.camera.group.position.set(0, 0.2, 0.33);
      }
    }
    if (cop.owner === this && cop.shown) {
      const cp = npcPose(cop);
      cop.puppet.refreshTorso();
      cp.mouth = "teeth";
      cp.brow = "angry";
      const L = this.door.length;
      if (t < 0.35) {
        cp.legHip[1] = -1.3 * backOut(seg(t, 0, 0.18)) * (1 - smooth(seg(t, 0.2, 0.35)));
        cp.hand(0, -0.3, 0.5, 0.25).hand(1, 0.3, 0.5, 0.25);
      } else if (t < D - 0.8) {
        const d = L * ramp(seg(t, 0.35, this.anim === "sabika" ? 0.6 : 0.85));
        walkAlong(cop.root, this.door, d, false, env.dt);
        if (d >= L - 0.01) face(cop.root, a.root.position, env.dt);
        cp.walk = d < L - 0.01 ? 1 : 0;
        a.face.head.getWorldPosition(_b);
        if (this.anim === "sabika") {
          env.shared.cameraH.want = true;
          // Both hands on the camera in front of the face; flash at 0.75 s (matches the sound).
          const cam = env.shared.camera.group;
          cam.updateWorldMatrix(true, false);
          for (let i = 0; i < 2; i++) {
            cam.localToWorld(_c.set(i === 0 ? -0.1 : 0.1, -0.03, 0));
            cp.handV(i, cop.puppet.toTorso(_c, _d), i === 0 ? -0.7 : 0.7, -0.6, -0.2);
          }
          if (this.once(2, 0.75)) this.flashAt = t;
          if (t > 1.4) cp.mouth = "grin";
          aimHead(cp, cop, _b, 0.4);
        } else {
          // Points at the victim and laughs.
          const pw = smooth(seg(t, 0.8, 1.1));
          blendHandV(cp, 0, pointAt(cop, 0, _b, _c), pw, -0.6, -0.3, -0.5);
          if (t > 1.3) {
            const ha = Math.abs(Math.sin(t * 16));
            cp.mouth = "grin";
            cp.jaw = 0.3 + ha * 0.3;
            cp.shrug = ha * 0.6;
            cp.hand(1, 0.15, 0.25, 0.25, 0.8, -0.5, -0.3);
          }
          aimHead(cp, cop, _b, 0.9);
        }
      } else {
        const d = L * (1 - ramp(seg(t, D - 0.8, D - 0.15)));
        walkAlong(cop.root, this.door, d, true, env.dt);
        cp.walk = 1;
        if (t >= D - 0.2) cop.vanish(true);
      }
    }
    const flash = this.flashAt >= 0 ? Math.max(0, 1 - (t - this.flashAt) / 0.35) : 0;
    (env.shared.camera.bulb.material as THREE.MeshToonMaterial).emissiveIntensity = flash * 4;
    (env.shared.camera.glow.material as THREE.SpriteMaterial).opacity = flash;
    if (this.anim === "bosCuzdan") this.wallet(a, p, env);
    else this.mugshot(a, p, env, true);
  }

  // -------------------------------------------------------- quick at the seat
  private updateSeat(a: Actor, p: Pose, env: SeqEnv): void {
    if (this.anim === "bosCuzdan") return this.wallet(a, p, env);
    if (this.anim === "sabika") {
      if (this.once(1, 0.75)) this.flashAt = this.t;
      return this.mugshot(a, p, env, false);
    }
    const t = this.t;
    const D = this.dur;
    const cop = env.cop;
    const sh = env.shared;
    const kelepce = this.anim === "kelepce";
    if (this.once(1, kelepce ? 0.12 : 0.08)) {
      cop.appear(this.behind, a.yaw, true);
      cop.owner = this;
      env.particles.poof(_a.copy(this.behind).setY(0.9), 0.16, "#E9E4F0", 14);
    }
    a.puppet.refreshTorso();
    seatedRest(a, p);
    a.face.head.getWorldPosition(_b);
    if (cop.owner === this && cop.shown) {
      const cp = npcPose(cop);
      cop.puppet.refreshTorso();
      cp.mouth = "teeth";
      cp.brow = "angry";
      if (kelepce) {
        // Wind up, bonk the head, then point and laugh.
        _c.copy(_b).setY(_b.y + 0.42);
        cop.puppet.toTorso(_c, _d);
        const up = _w.set(-0.22, 0.75, 0.15);
        if (t < 0.55) cp.blendHand(0, up.x, up.y, up.z, smooth(seg(t, 0.15, 0.5)), -0.8, -0.2, -0.3);
        else if (t < 0.7) cp.handV(0, _x.copy(up).lerp(_d, easeIn(seg(t, 0.55, 0.7))), -0.8, -0.2, -0.3);
        else cp.blendHand(0, _d.x, _d.y + 0.08, _d.z, 1 - smooth(seg(t, 0.75, 1.1)), -0.8, -0.2, -0.3);
        cp.lean = 0.35 * bump(t, 0.45, 1.0);
        if (t > 1.0) {
          const ha = Math.abs(Math.sin(t * 16));
          cp.mouth = "grin";
          cp.jaw = 0.3 + ha * 0.3;
          cp.shrug = ha * 0.5;
        }
        if (t > D - 0.75) cop.vanish();
      } else {
        // Holds the sack up high, pulls it down over the head, pats it, leaves.
        _c.copy(_b).setY(_b.y + 0.45 + (1 - easeIn(seg(t, 0.35, 0.6))) * 0.35);
        cop.puppet.toTorso(_c, _d);
        const w = 1 - smooth(seg(t, 0.75, 1.0));
        cp.blendHand(0, _d.x - 0.12, _d.y, _d.z, w, -0.7, -0.3, -0.3);
        cp.blendHand(1, _d.x + 0.12, _d.y, _d.z, w, 0.7, -0.3, -0.3);
        if (t > 1.0) cp.mouth = "grin";
        if (t > 1.45) cop.vanish();
      }
      aimHead(cp, cop, _b, 0.8);
    }
    if (kelepce) {
      if (this.once(2, 0.7)) {
        a.puppet.kick(-4, 3);
        a.blackEye = true;
        a.face.head.getWorldPosition(_a);
        env.particles.poof(_a.setY(_a.y + 0.35), 0.06, "#FFF4DF", 8);
      }
      if (t < 0.7) {
        p.mouth = "o";
        p.brow = "up";
        p.lid = 1.5;
        p.lean = -0.08;
      } else {
        // Hands cuffed together on the table, dizzy.
        const cw = smooth(seg(t, 0.75, 1.0)) * (1 - smooth(seg(t, D - 0.5, D - 0.2)));
        p.blendHand(0, -0.04, 0.38, 0.36, cw, -0.8, -0.3, -0.3);
        p.blendHand(1, 0.04, 0.38, 0.36, cw, 0.8, -0.3, -0.3);
        sh.cuffH[0].want = sh.cuffH[1].want = t > 0.85 && t < D - 0.45;
        this.dizzy(p, t);
        p.headPitch = 0.12;
        sh.starsH.want = true;
      }
    } else {
      const drop = easeIn(seg(t, 0.35, 0.6));
      const lift = easeInOut(seg(t, D - 0.6, D - 0.25));
      a.pr.sack.obj.position.y = 0.45 * (1 - drop) + 0.6 * lift;
      a.pr.sack.want = t > 0.28 && t < D - 0.3;
      if (this.once(2, 0.6)) a.puppet.kick(-3, 2);
      if (t > 0.6 && t < D - 0.6) {
        // Blind flailing, head bonks on the table.
        const f = Math.sin(t * 9);
        p.hand(0, -0.24, 0.5 + f * 0.08, 0.3 + Math.cos(t * 7) * 0.05, -0.8, -0.3, -0.4);
        p.hand(1, 0.24, 0.5 - f * 0.08, 0.3 + Math.sin(t * 6) * 0.05, 0.8, -0.3, -0.4);
        const bonk = bump(t, 1.05, 1.35) + bump(t, 1.85, 2.15);
        p.lean = 0.38 * bonk;
        p.headRoll = Math.sin(t * 5) * 0.2;
        if (this.once(4, 1.2) || this.once(8, 2.0)) a.puppet.kick(-3, 3);
      } else {
        p.mouth = "o";
        p.brow = "up";
      }
    }
  }

  /** Wallet out, it opens, moths fly, pockets turn inside out, shrug. */
  private wallet(a: Actor, p: Pose, env: SeqEnv): void {
    const t = this.t;
    const D = this.dur;
    a.puppet.refreshTorso();
    seatedRest(a, p);
    const hold = smooth(seg(t, 0.3, 0.6)) * (1 - smooth(seg(t, 1.75, 2.05)));
    if (t < 0.6) p.blendHand(1, 0.06, 0.3, 0.2, smooth(seg(t, 0.2, 0.45)), 0.8, -0.5, -0.3);
    else p.blendHand(1, 0.08, 0.37, 0.33, hold, 0.8, -0.5, -0.3);
    a.pr.wallet.want = t > 0.42 && t < 2.0;
    const open = backOut(seg(t, 0.95, 1.2));
    a.wallet.left.rotation.y = -0.95 * open;
    a.wallet.right.rotation.y = 0.95 * open;
    if (t > 1.0 && t < 2.3 && !env.inside) {
      const n = Math.floor(t * 11) - Math.floor((t - env.dt) * 11);
      if (n > 0) {
        a.wallet.group.getWorldPosition(_a);
        a.face.head.getWorldPosition(_b);
        _b.y += 0.35;
        for (let i = 0; i < n; i++) env.particles.moth(_a, _b, 2.2);
      }
    }
    a.pr.pocketL.want = a.pr.pocketR.want = t > 1.4 && t < D - 0.35;
    const shrug = smooth(seg(t, 1.9, 2.2)) * (1 - smooth(seg(t, D - 0.6, D - 0.25)));
    p.blendHand(0, -0.3, 0.45, 0.3, shrug, -0.8, -0.5, -0.2);
    p.blendHand(1, 0.3, 0.45, 0.3, shrug, 0.8, -0.5, -0.2);
    p.shrug = shrug;
    p.headPitch = t > 0.8 && t < 1.6 ? 0.35 : 0;
    p.mouth = t < 1.0 ? "o" : "frown";
    p.brow = t < 1.0 ? "up" : "sad";
    p.earDroop = t > 1.2 ? 1 : 0;
    p.lid = t < 1.0 ? 1.4 : 0.8;
    if (this.once(64, 1.0)) a.puppet.kick(-2);
  }

  /** Mugshot: (stand and) hold the number plate, the height board behind, squint at the flash. */
  private mugshot(a: Actor, p: Pose, env: SeqEnv, stand: boolean): void {
    const t = this.t;
    const D = this.dur;
    const sh = env.shared;
    a.puppet.refreshTorso();
    seatedRest(a, p);
    const up = stand ? easeInOut(seg(t, 0, 0.35)) * (1 - easeInOut(seg(t, D - 0.85, D - 0.35))) : 0;
    p.sit = 1 - up;
    this.chairOut = stand ? up : null;
    const showing = t > 0.2 && t < D - 0.6;
    if (showing) this.holdPlate(a, p, sh, up);
    sh.boardH.want = t > 0.15 && t < D - 0.4;
    sh.board.position.copy(a.home).addScaledVector(a.out, stand ? 0.95 : 0.8).setY(0);
    sh.board.rotation.y = a.yaw;
    const sinceFlash = this.flashAt >= 0 ? t - this.flashAt : -1;
    p.lid = sinceFlash >= 0 && sinceFlash < 0.45 ? 0.12 : 1.1;
    p.mouth = sinceFlash >= 0 ? "flat" : "o";
    p.brow = sinceFlash >= 0 ? "angry" : "up";
    p.headPitch = -0.05;
    if (this.once(128, 0.76)) a.puppet.kick(-2.5, 1.5);
  }

  finish(a: Actor, env: SeqEnv): void {
    const sh = env.shared;
    hideStrand(sh.chain);
    hideStrand(sh.rope);
    if (env.cop.owner === this) env.cop.vanish();
    a.root.visible = true;
    a.root.position.copy(a.home);
    a.root.rotation.y = a.yaw;
    a.root.position.y = 0;
    a.wallet.left.rotation.y = a.wallet.right.rotation.y = 0;
    a.pr.sack.obj.position.y = 0;
    (sh.camera.bulb.material as THREE.MeshToonMaterial).emissiveIntensity = 0;
    (sh.camera.glow.material as THREE.SpriteMaterial).opacity = 0;
    this.chairOut = null;
  }
}

// ================================================================ eliminate
export class EliminateSeq extends Seq {
  readonly kind = "eliminate";
  private path: Path;
  private dPlank: number;
  private edge = new THREE.Vector3();
  private drop = new THREE.Vector3();
  private pierYaw: number;
  private walkEnd = 1.95;

  constructor(a: Actor, sec: number, env: SeqEnv) {
    super();
    this.dur = Math.max(4, sec - 0.15);
    this.lock = MASK_BODY | MASK_ARMS | MASK_HEAD;
    this.skin = "normal";
    this.outOfBodySec = this.dur - 0.25;
    const pier = env.shared.pier;
    // The pier may be popped down to nothing right now: measure it at full size.
    const sy = pier.group.scale.y;
    pier.group.scale.y = 1;
    pier.group.updateMatrixWorld(true);
    const start = pier.group.localToWorld(new THREE.Vector3(0, 0, -0.55)).setY(0);
    pier.group.localToWorld(this.edge.copy(pier.edge));
    pier.group.localToWorld(this.drop.copy(pier.drop));
    pier.group.scale.y = sy;
    pier.group.updateMatrixWorld(true);
    this.pierYaw = pier.group.rotation.y;
    const { path } = exitPath(a, start, [this.edge.clone().setY(0)]);
    this.path = path;
    this.dPlank = path.distOf(path.points.length - 2);
    for (let i = 0; i < 2; i++) {
      a.rig.legs[i]!.foot.add(env.shared.cement[i]!.group);
      env.shared.cement[i]!.group.position.set(0, -0.09, 0.03);
    }
    env.shared.pierPop.target = 1;
  }

  update(a: Actor, p: Pose, env: SeqEnv): void {
    const t = this.t;
    const dt = env.dt;
    const sh = env.shared;
    const cop = env.cop;
    const path = this.path;
    const L = path.length;
    sh.pierPop.target = t < this.dur - 0.8 ? 1 : 0;
    const uw = seg(t, 0.3, this.walkEnd);
    const dV = L * ramp(uw, 0.15);

    // ---- Rıfat leads the way to the pier, then steps aside and points at the water.
    if (this.once(1, 0.05)) {
      path.at(0.8, _a);
      cop.appear(_a, yawTo(_a, a.root.position), true);
      cop.owner = this;
      env.particles.poof(_b.copy(_a).setY(0.9), 0.16, "#E9E4F0", 12);
    }
    if (cop.owner === this && cop.shown) {
      const cp = npcPose(cop);
      cop.puppet.refreshTorso();
      cp.mouth = "teeth";
      cp.brow = "angry";
      const dC = Math.min(this.dPlank - 0.2, 0.8 + dV);
      const yaw = path.at(dC, _a);
      const aside = smooth(seg(dV, this.dPlank - 1.6, this.dPlank - 0.6));
      _b.set(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(-0.75 * aside);
      cop.root.position.set(_a.x + _b.x, 0, _a.z + _b.z);
      if (t < 0.3 || aside > 0.95) face(cop.root, aside > 0.95 ? this.edge : a.root.position, dt);
      else cop.root.rotation.y = approachAngle(cop.root.rotation.y, yaw, 11, dt);
      cp.walk = t > 0.3 && t < this.walkEnd ? 1 : 0;
      if (t > this.walkEnd - 0.2) {
        blendHandV(cp, 0, pointAt(cop, 0, this.drop, _c), smooth(seg(t, this.walkEnd - 0.2, this.walkEnd + 0.2)), -0.6, -0.3, -0.5);
      }
      if (t > 2.6) {
        const ha = Math.abs(Math.sin(t * 16));
        cp.mouth = "grin";
        cp.jaw = 0.3 + ha * 0.3;
        cp.shrug = ha * 0.6;
      }
      aimHead(cp, cop, t < 2.6 ? a.face.head.getWorldPosition(_b) : this.drop, 0.8);
      if (t > 3.2) cop.vanish();
    }

    // ---- the condemned
    a.puppet.refreshTorso();
    p.mouth = "o";
    p.brow = "up";
    p.lid = 1.55;
    if (t < 0.3) {
      seatedRest(a, p);
      p.lean = -0.12;
      aimHead(p, a, this.edge, 0.7);
      if (this.once(2, 0.02)) a.puppet.kick(-4);
      return;
    }
    if (t < this.walkEnd) {
      this.away = true;
      this.chairOut = 1;
      walkAlong(a.root, path, dV, false, dt, 10);
      // Hop up onto the planks.
      const up = (dV - this.dPlank) / 0.55;
      a.root.position.y = up > 0 ? 0.33 * smooth(up) + 0.12 * bump(up, 0, 1) : 0;
      p.sit = 0;
      p.walk = 1;
      hangHands(p);
      p.headRoll = Math.sin(t * 7) * 0.06;
      return;
    }
    a.root.rotation.y = approachAngle(a.root.rotation.y, this.pierYaw, 10, dt);
    p.sit = 0;
    if (t < 2.6) {
      a.root.position.copy(this.edge);
      sh.cementH[0].want = sh.cementH[1].want = true;
      if (this.once(4, this.walkEnd)) a.puppet.kick(-3, 2);
      if (t < 2.4) {
        // Teeter on the edge, windmilling.
        const ph = (t - this.walkEnd) * 16;
        p.tiltX = Math.sin((t - this.walkEnd) * 14) * 0.15 * smooth(seg(t, this.walkEnd, this.walkEnd + 0.15));
        p.hand(0, -0.33, 0.55 + Math.sin(ph) * 0.18, 0.1 + Math.cos(ph) * 0.18, -0.9, 0, -0.2);
        p.hand(1, 0.33, 0.55 + Math.sin(ph + 1.6) * 0.18, 0.1 + Math.cos(ph + 1.6) * 0.18, 0.9, 0, -0.2);
        p.armSwing = 0;
      } else {
        // Over she goes: face first, timed to land on the ŞLAP at 2.6 s.
        p.tiltX = 1.55 * easeIn(seg(t, 2.4, 2.6));
        p.hand(0, -0.3, 0.75, 0.15, -0.8, 0, -0.3).hand(1, 0.3, 0.75, 0.15, 0.8, 0, -0.3);
        p.mouth = "o";
        p.lid = 0.2;
      }
      return;
    }
    if (this.once(8, 2.6)) {
      for (let i = 0; i < 16; i++) {
        const ang = (i / 16) * Math.PI * 2;
        _a.copy(this.drop).setY(0.05);
        _c.set(this.drop.x + Math.cos(ang) * 0.7, 0.02, this.drop.z + Math.sin(ang) * 0.7);
        _b.copy(_a).lerp(_c, 0.5).setY(0.7 + Math.random() * 0.4);
        env.particles.dropArc(_a, _b, _c, 0.03, "#8EDCFF", 0.55 + Math.random() * 0.2);
      }
      a.puppet.kick(-5, 3);
    }
    this.ripples(sh.pier, t - 2.6);
    if (t < 3.3) {
      // Sink.
      const s = seg(t, 2.6, 3.25);
      a.root.position.lerpVectors(this.edge, this.drop, easeOut(s));
      a.root.position.y = lerp(0.33, -0.75, easeIn(s));
      p.tiltX = 1.55;
      sh.cementH[0].want = sh.cementH[1].want = true;
      this.hidden = s >= 1;
      if (t > 2.85 && Math.sin(t * 60) > 0.6) env.particles.bubble(_a.copy(this.drop).setY(0.05).add(_b.set((Math.random() - 0.5) * 0.4, 0, (Math.random() - 0.5) * 0.4)));
      return;
    }
    if (t < 3.45) {
      this.hidden = true;
      a.root.position.copy(this.drop).setY(-1.0);
      if (Math.sin(t * 60) > 0.3) env.particles.bubble(_a.copy(this.drop).setY(0.05));
      return;
    }
    // The ghost rises out of the river and floats home.
    if (this.once(16, 3.45)) {
      this.skin = "ghost";
      this.hidden = false;
      this.settleNow = true;
      env.particles.poof(_a.copy(this.drop).setY(0.4), 0.22, "#60C9BD", 22);
    }
    ghostPose(p, env.time, a.seed);
    if (t < 3.95) {
      a.root.position.copy(this.drop).setY(lerp(-1.0, 0.95, easeOut(seg(t, 3.45, 3.95))));
      p.hand(0, -0.38, 0.6, 0.15).hand(1, 0.38, 0.6, 0.15);
      p.mouth = "grin";
      a.root.rotation.y = approachAngle(a.root.rotation.y, yawTo(this.drop, a.home), 6, dt);
      return;
    }
    if (t < 4.15) {
      // Spin away in a puff of river mist…
      if (this.once(32, 3.95)) env.particles.poof(_a.copy(a.root.position).setY(a.root.position.y + 0.8), 0.22, "#60C9BD", 18);
      this.hidden = t > 4.0;
      a.root.rotation.y += dt * 18;
      p.stretch = -0.2 * seg(t, 3.95, 4.0);
      return;
    }
    // …and float back into the chair.
    if (this.once(64, 4.15)) {
      this.hidden = false;
      this.away = false;
      this.chairOut = 0;
      a.chairOut = 0;
      a.chairVel[0] = 0;
      a.root.position.copy(a.home).setY(0.5);
      a.root.rotation.y = a.yaw;
      a.puppet.resetMotion();
      this.settleNow = true;
      env.particles.poof(_a.copy(a.home).setY(1.1), 0.2, "#60C9BD", 18);
      a.puppet.kick(3, 2);
    }
    a.root.position.copy(a.home).setY(0.5 * (1 - easeOut(seg(t, 4.15, 4.6))));
    a.root.rotation.y = a.yaw;
  }

  private ripples(pier: Pier, since: number): void {
    for (let i = 0; i < pier.ripples.length; i++) {
      const r = pier.ripples[i]!;
      const u = (since - i * 0.18) / 0.9;
      const m = r.material as THREE.MeshBasicMaterial;
      if (u <= 0 || u >= 1) {
        m.opacity = 0;
        continue;
      }
      r.scale.setScalar(0.3 + easeOut(u) * 0.55);
      m.opacity = 0.85 * (1 - u);
    }
  }

  finish(a: Actor, env: SeqEnv): void {
    const sh = env.shared;
    sh.pierPop.target = 0;
    sh.cementH[0].want = sh.cementH[1].want = false;
    for (const r of sh.pier.ripples) (r.material as THREE.MeshBasicMaterial).opacity = 0;
    if (env.cop.owner === this) env.cop.vanish();
    a.root.visible = true;
    a.root.position.copy(a.home);
    a.root.rotation.y = a.yaw;
    this.chairOut = null;
  }
}

// =================================================================== podium
export interface PodiumSlot {
  /** Standing point (pile top or the floor spot). */
  at: THREE.Vector3;
  /** Pile height (0 = floor). */
  top: number;
  place: number;
  last: boolean;
  /** Yaw facing the camera. */
  faceYaw: number;
}

export class PodiumSeq extends Seq {
  readonly kind = "podium";
  private path: Path;
  private tWalk: number;
  private front = new THREE.Vector3();

  constructor(
    a: Actor,
    readonly slot: PodiumSlot,
    private delay: number,
  ) {
    super();
    this.dur = Infinity;
    this.lock = MASK_BODY | MASK_ARMS;
    this.front.copy(slot.at).setY(0);
    if (slot.top > 0) this.front.z += 0.5;
    const { path } = exitPath(a, this.front, []);
    this.path = path;
    this.tWalk = path.length / 2.3 + 0.2;
  }

  update(a: Actor, p: Pose, env: SeqEnv): void {
    const t = this.t - this.delay;
    const dt = env.dt;
    const slot = this.slot;
    a.puppet.refreshTorso();
    if (t < 0) {
      seatedRest(a, p);
      p.sit = 1 - smooth(seg(t, -0.5, 0));
      this.chairOut = 1 - p.sit;
      return;
    }
    this.chairOut = 1;
    this.away = true;
    p.sit = 0;
    hangHands(p);
    if (t < this.tWalk) {
      walkAlong(a.root, this.path, this.path.length * ramp(t / this.tWalk), false, dt, 10);
      p.walk = 1;
      p.mouth = slot.place === 1 ? "grin" : slot.last ? "frown" : "smirk";
      return;
    }
    const tt = t - this.tWalk;
    if (slot.top > 0 && tt < 0.45) {
      // Hop up onto the money pile.
      const s = seg(tt, 0, 0.45);
      a.root.position.lerpVectors(this.front, slot.at, easeOut(s));
      a.root.position.y = slot.top * easeOut(s) + 0.25 * Math.sin(Math.PI * s);
      p.stretch = 0.12 * bump(s, 0, 0.6);
      if (this.once(1, this.tWalk + this.delay)) a.puppet.kick(3);
      return;
    }
    if (this.once(2, this.tWalk + this.delay + (slot.top > 0 ? 0.45 : 0))) {
      a.root.position.copy(slot.at);
      a.puppet.kick(-3, 1.5);
    }
    a.root.rotation.y = approachAngle(a.root.rotation.y, slot.faceYaw, 6, dt);
    const time = env.time;
    if (slot.place === 1) {
      const cyc = tt / 1.6;
      const pump = Math.sin(tt * 9) * 0.05;
      p.hand(0, -0.34, 0.72 + pump, 0.12, -0.8, -0.3, -0.3).hand(1, 0.34, 0.72 - pump, 0.12, 0.8, -0.3, -0.3);
      // One spin per cycle, written wrapped (the puppet keeps it going forward): nothing to unwind afterwards.
      p.hatSpin = wrapAngle(backOut(clamp((cyc % 1) / 0.4, 0, 1)) * Math.PI * 2);
      p.hatLift = 0.04 + 0.03 * Math.abs(Math.sin(tt * 4.5));
      p.bounce = Math.abs(Math.sin(tt * 4.5)) * 0.04;
      p.mouth = "grin";
      p.brow = "up";
      p.lid = 1.35;
      p.jaw = 0.3;
    } else if (slot.top > 0 && !slot.last) {
      const wave = Math.sin(tt * 8) * 0.08;
      p.hand(0, -0.3 + wave, 0.74, 0.12, -0.8, -0.2, -0.3);
      p.mouth = "smile";
      p.brow = "up";
      p.bounce = Math.abs(Math.sin(tt * 3 + slot.place)) * 0.02;
    } else {
      // Sulking: sitting on the floor in front (standing slumped if a pile was given), the last one under the
      // sack with the hat on top of it.
      if (slot.top > 0) {
        p.sit = 0;
        p.lean = 0.12;
        hangHands(p);
      } else {
        p.sit = 1;
        p.bounce = -0.4;
        p.legKnee[0] = p.legKnee[1] = -Math.PI / 2 + 0.15;
        p.lean = 0.18;
        p.hand(0, -0.16, 0.12, 0.3, -0.7, -0.4, -0.4).hand(1, 0.16, 0.12, 0.3, 0.7, -0.4, -0.4);
      }
      p.headPitch = 0.28;
      p.mouth = "frown";
      p.brow = "sad";
      p.earDroop = 1;
      p.lid = 0.6;
      p.headRoll = Math.sin(time * 0.9 + a.seed) * 0.05;
      if (slot.last) {
        a.pr.sack.want = true;
        p.hatLift = 0.28;
      }
    }
  }

  finish(a: Actor): void {
    a.root.position.copy(a.home);
    a.root.rotation.y = a.yaw;
    this.chairOut = null;
  }
}

/** The place's yaw facing a camera at `cam` from `at`. */
export function facing(at: THREE.Vector3, cam: THREE.Vector3): number {
  return wrapAngle(yawTo(at, cam));
}

// ============================================================ ghost return
export class ReturnSeq extends Seq {
  readonly kind = "return";

  constructor(sec = 2) {
    super();
    this.dur = sec;
    this.lock = MASK_BODY | MASK_ARMS;
  }

  update(a: Actor, p: Pose, env: SeqEnv): void {
    const t = this.t;
    a.puppet.refreshTorso();
    seatedRest(a, p);
    if (this.once(1, 0)) {
      a.face.head.getWorldPosition(_a);
      if (!env.inside) env.particles.poof(_a, 0.25, "#60C9BD", 24);
      a.puppet.kick(4, 2);
    }
    const up = smooth(seg(t, 0, 0.3)) * (1 - smooth(seg(t, this.dur - 0.45, this.dur - 0.05)));
    p.sit = 1 - 0.45 * up;
    // Dripping from the hat brim.
    if (t < 1.4 && Math.sin(t * 50) > 0.4 && !env.inside) {
      a.face.hatMount.getWorldPosition(_a);
      _a.x += (Math.random() - 0.5) * 0.4;
      _a.z += (Math.random() - 0.5) * 0.4;
      env.particles.drop(_a, _b.set(0, -0.2, 0), 0.02, "#8EDCFF", 0.8, 9);
    }
    // Dog shake: twist + head, water spraying off.
    const shake = bump(t, 0.45, 1.15);
    if (shake > 0) {
      p.twist = Math.sin(t * 28) * 0.35 * shake;
      p.headYaw = Math.sin(t * 28 + 0.6) * 0.45 * shake;
      p.lid = 0.2;
      p.mouth = "flat";
      if (Math.sin(t * 70) > 0.2 && !env.inside) {
        a.face.head.getWorldPosition(_a);
        const ang = Math.random() * Math.PI * 2;
        env.particles.drop(_a, _b.set(Math.cos(ang) * 1.6, 0.6 + Math.random() * 0.6, Math.sin(ang) * 1.6), 0.02, "#8EDCFF", 0.7, 9);
      }
    } else {
      const cheer = smooth(seg(t, 1.1, 1.3)) * (1 - smooth(seg(t, this.dur - 0.4, this.dur)));
      p.blendHand(0, -0.34, 0.72, 0.12, cheer, -0.8, -0.3, -0.3);
      p.blendHand(1, 0.34, 0.72, 0.12, cheer, 0.8, -0.3, -0.3);
      p.mouth = "grin";
      p.brow = "up";
      p.lid = 1.3;
    }
    this.chairOut = null;
  }
}
