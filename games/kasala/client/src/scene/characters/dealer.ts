// Cemil Abi, the old crocodile dealer: stands behind the table with his hands on the rail, watches the active
// player, deals with a wind-up + flick toward the active seat, yanks the wheel down with a big overhead
// reach, talks in syllables, smokes, wears his watch, ducks under the table when the door bursts and riffles
// the deck on the home screen. Owner: client-characters.

import * as THREE from "three";
import type { StageAnchors } from "../Stage";
import { TABLE_TOP_Y } from "../room/layout";
import { buildBody, Puppet, type BodyRig, type Face, type Pose } from "./body";
import { aimHead } from "./clips";
import { buildCrocHead, buildVisor } from "./heads";
import { G, mat, mesh, noOutline, optimizeShadows, suitMat } from "./kit";
import type { Particles } from "./particles";
import { buildCigar, buildDeckHalf } from "./props";
import { backOut, bump, clamp, easeIn, easeInOut, easeOut, smooth, wobble } from "./util";

export interface DealerApi {
  deal(): void;
  spinWheel(): void;
  talk(sec: number): void;
  hide(on: boolean): void;
  shuffle(on: boolean): void;
}

const DEAL_SEC = 0.62;
const SPIN_SEC = 1.7;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();

export class Dealer implements DealerApi {
  readonly rig: BodyRig;
  readonly face: Face;
  readonly puppet: Puppet;
  readonly root: THREE.Group;
  /** What Cemil watches (the active player's head, my first-person eye) — set every frame by Characters. */
  readonly focus = new THREE.Vector3();
  hasFocus = false;
  /** Where the card goes (the active seat's card row). */
  readonly dealTo = new THREE.Vector3();
  private decks: THREE.Group[];
  private cigar: ReturnType<typeof buildCigar>;
  private rest: [THREE.Vector3, THREE.Vector3];
  private dealT = Infinity;
  private spinT = Infinity;
  private talkLeft = 0;
  private hidden = false;
  private shuffling = false;
  private wispIn = 1.2;
  private seed = Math.random() * 10;
  /** Last frame step (one-shot impact kicks fire when their time is crossed). */
  private lastDt = 0.016;

  constructor(
    world: THREE.Object3D,
    private anchors: StageAnchors,
    private particles: Particles,
  ) {
    this.rig = buildBody({
      suit: suitMat("#55392B", "#B58A51"), hands: mat("#789C5B"),
      shirt: mat("#E8DCC0"), bowtie: mat("#D1453B"), vest: true,
      pocketSquare: mat("#FFC93C"), girth: 1.25, height: 1.1, armScale: 1.35,
    });
    const croc = buildCrocHead();
    this.face = croc.face;
    this.puppet = new Puppet(this.rig, this.face, buildVisor());
    this.root = this.rig.root;
    // A step closer to the table than the anchor so his hands rest on the rail with bent elbows.
    const toCenter = _a.set(-anchors.dealer.x, 0, -anchors.dealer.z).normalize();
    this.root.position.copy(anchors.dealer).addScaledVector(toCenter, 0.15);
    this.root.rotation.y = anchors.dealerYaw;
    world.add(this.root);
    this.decks = [buildDeckHalf(), buildDeckHalf()];
    this.decks.forEach((deck, i) => {
      deck.visible = false;
      this.rig.arms[i]!.grip.add(deck);
    });
    // Cigar in the corner of the jaw, a wristwatch on the left wrist (§13).
    this.cigar = buildCigar();
    this.cigar.group.position.copy(this.face.mouthTip.position).add(_b.set(0.02, -0.005, 0.02));
    this.cigar.group.rotation.set(0.15, 0.75, 0);
    this.face.head.add(this.cigar.group);
    const watch = new THREE.Group();
    watch.add(mesh(G().cyl, mat("#C9A64B"), 0, 0.0, 0, 0.068, 0.026, 0.068));
    const dial = noOutline(mesh(G().cyl, mat("#FFF4DF"), 0, 0, 0.05, 0.026, 0.008, 0.026));
    dial.rotation.x = Math.PI / 2;
    watch.add(dial);
    watch.position.y = 0.008;
    this.rig.arms[1].hand.add(watch);
    const r = Math.hypot(this.root.position.x, this.root.position.z);
    const railR = 1.5;
    const k = railR / Math.max(0.01, r);
    const lateral = 0.25;
    this.rest = [
      new THREE.Vector3(this.root.position.x * k, TABLE_TOP_Y + 0.15, this.root.position.z * k),
      new THREE.Vector3(this.root.position.x * k, TABLE_TOP_Y + 0.15, this.root.position.z * k),
    ];
    // Character's right (−x local) / left (+x local), dealer yaw 0 → world −x / +x.
    const yaw = anchors.dealerYaw;
    this.rest[0].add(_b.set(-Math.cos(yaw), 0, Math.sin(yaw)).multiplyScalar(lateral));
    this.rest[1].add(_b.set(Math.cos(yaw), 0, -Math.sin(yaw)).multiplyScalar(lateral));
    optimizeShadows(this.root);
    this.puppet.rememberMaterials(this.root);
  }

  deal(): void {
    this.dealT = 0;
  }
  spinWheel(): void {
    this.spinT = 0;
  }
  talk(sec: number): void {
    this.talkLeft = Math.max(this.talkLeft, sec);
  }
  hide(on: boolean): void {
    if (on && !this.hidden) this.puppet.kick(-4, 2);
    this.hidden = on;
  }
  shuffle(on: boolean): void {
    this.shuffling = on;
  }

  /** Seconds since the last deal (Infinity before any): the table watches the card meanwhile. */
  get sinceDeal(): number {
    return this.dealT;
  }
  get talking(): boolean {
    return this.talkLeft > 0;
  }

  update(dt: number, time: number): void {
    this.lastDt = dt;
    this.dealT += dt;
    this.spinT += dt;
    this.talkLeft = Math.max(0, this.talkLeft - dt);
    const p = this.puppet.target.reset();
    const pu = this.puppet;
    pu.refreshTorso();
    p.sit = 0;
    p.handV(0, pu.toTorso(this.rest[0], _a), -0.8, -0.4, -0.45);
    p.handV(1, pu.toTorso(this.rest[1], _a), 0.8, -0.4, -0.45);
    const breath = Math.sin(time * 1.9 + this.seed);
    p.stretch = 0.02 * breath;
    p.shrug = 0.1 * Math.max(0, breath);
    p.lean = 0.08;
    p.lid = 0.7;
    if (this.hasFocus) aimHead(p, this, this.focus, 0.85);
    else p.headYaw = Math.sin(time * 0.42) * 0.12;
    if (this.talkLeft > 0) {
      // Syllables, not a sine: jaw pops open on "beats", with a nod on emphasis.
      p.jaw = Math.max(0, wobble(time * 9, this.seed)) * 0.55 + 0.05;
      p.headPitch += 0.07 * Math.max(0, Math.sin(time * 3.3 + this.seed)) ** 6;
      p.brow = Math.sin(time * 1.7) > 0.4 ? "up" : "neutral";
    }
    for (const deck of this.decks) deck.visible = this.shuffling;
    if (this.shuffling) {
      const r = Math.sin(time * 11);
      p.hand(0, -0.15, 0.2 + r * 0.06, 0.45, -0.8, -0.4, -0.4);
      p.hand(1, 0.15, 0.2 - r * 0.06, 0.45, 0.8, -0.4, -0.4);
      p.headPitch = 0.22;
    }
    if (this.dealT < DEAL_SEC) this.poseDeal(p, this.dealT);
    if (this.spinT < SPIN_SEC) this.poseSpin(p, this.spinT);
    if (this.hidden) {
      // Duck under the table edge, hands over the head, eyes peeking.
      p.sit = 1;
      p.legHip[0] = p.legHip[1] = -0.6;
      p.legKnee[0] = p.legKnee[1] = 1.0;
      p.bounce = -0.32;
      p.lean = 0.5;
      p.headPitch = -0.2;
      p.hand(0, -0.12, 0.66, 0.2, -0.8, 0.2, -0.3).hand(1, 0.12, 0.66, 0.2, 0.8, 0.2, -0.3);
      p.lid = 1.45;
      p.eyeScale = 1.15;
      p.jaw = 0.15;
    }
    // Cigar ember breathes, a wisp now and then.
    (this.cigar.ember.material as THREE.MeshToonMaterial).emissiveIntensity = 0.9 + Math.max(0, Math.sin(time * 0.8)) * 0.8;
    this.wispIn -= dt;
    if (this.wispIn <= 0) {
      this.wispIn = 1.2 + Math.random() * 0.8;
      this.cigar.ember.getWorldPosition(_c);
      this.particles.puff(_c, _b.set(0.03, 0.28, 0.02), 0.035, "#CFCAD3", 2.2, 3.2, 0.6);
    }
    this.puppet.update(dt, time);
  }

  /** Wind back, flick toward the active seat (the card leaves the tower), settle. */
  private poseDeal(p: Pose, t: number): void {
    const pu = this.puppet;
    const dx = this.dealTo.x - this.root.position.x;
    const dz = this.dealTo.z - this.root.position.z;
    const yaw = clamp(Math.atan2(dx * Math.cos(this.root.rotation.y) - dz * Math.sin(this.root.rotation.y), dx * Math.sin(this.root.rotation.y) + dz * Math.cos(this.root.rotation.y)), -1.2, 1.2);
    p.twist += clamp(yaw * 0.45, -0.5, 0.5) * bump(t, 0, DEAL_SEC);
    // Flick target: arm's length from the shoulder toward the card's destination, over the felt.
    this.rig.arms[0].shoulder.getWorldPosition(_a);
    _b.copy(this.dealTo).setY(TABLE_TOP_Y + 0.25).sub(_a).normalize().multiplyScalar(0.5).add(_a);
    pu.toTorso(_b, _c);
    if (t < 0.12) p.blendHand(0, -0.18, 0.36, 0.2, easeOut(t / 0.12), -0.8, -0.3, -0.3);
    else if (t < 0.3) {
      const s = backOut((t - 0.12) / 0.18);
      p.hand(0, -0.18 + (_c.x + 0.18) * s, 0.36 + (_c.y - 0.36) * s, 0.2 + (_c.z - 0.2) * s, -0.8, -0.3, -0.3);
    } else p.blendHand(0, _c.x, _c.y, _c.z, 1 - easeInOut((t - 0.3) / (DEAL_SEC - 0.3)), -0.8, -0.3, -0.3);
    p.lean += 0.12 * bump(t, 0.05, 0.5);
    if (t >= 0.12 && t - this.lastDt < 0.12) this.puppet.kick(2, 0.8);
  }

  /** Big overhead reach, grab the chain and yank the wheel down. */
  private poseSpin(p: Pose, t: number): void {
    if (t < 0.3) {
      const s = smooth(t / 0.3);
      p.bounce -= 0.06 * s;
      p.blendHand(0, -0.22, 0.25, 0.05, s, -0.8, -0.3, -0.3);
    } else if (t < 0.55) {
      const s = backOut((t - 0.3) / 0.25);
      p.hand(0, -0.22 + 0.1 * s, 0.25 + 0.7 * s, 0.05 + 0.17 * s, -0.8, 0.2, -0.3);
      p.stretch += 0.12 * s;
    } else if (t < 0.75) {
      const s = easeIn((t - 0.55) / 0.2);
      p.hand(0, -0.12 - 0.08 * s, 0.95 - 0.63 * s, 0.22 + 0.08 * s, -0.8, -0.2, -0.3);
      p.lean += 0.22 * s;
      p.stretch -= 0.05 * s;
    } else p.blendHand(0, -0.2, 0.32, 0.3, 1 - easeInOut((t - 0.75) / (SPIN_SEC - 0.75)), -0.8, -0.3, -0.3);
    _a.copy(this.anchors.wheelDown);
    aimHead(p, this, _a, 0.9 * bump(t, 0.2, SPIN_SEC + 0.3));
    if (t - this.lastDt <= 1e-6) this.puppet.kick(-3, 1);
    if (t >= 0.58 && t - this.lastDt < 0.58) this.puppet.kick(3.5, 2);
  }
}
