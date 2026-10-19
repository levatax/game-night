// One animated chef: seat placement, idle breathing/blinking, squash & stretch springs, every reaction
// (lean / cheer / gasp / laugh / point / pie / cry / devil / stand), arms that puppet the hover piece,
// nameplate with a rolling coin counter and comic speech bubbles. Owner: client-chefs.

import * as THREE from "three";
import { PLAYER_COLORS } from "../../../../shared/constants";
import type { PlayerView } from "../../../../shared/protocol";
import { jiggleEyes, toon } from "../toon";
import type { ChefReaction } from "../Chefs";
import { Bubble, Nameplate, glowTexture, type PlateInfo } from "./labels";
import { EYE_SPACING, EYE_Y, FACE_Y, MODEL_HEIGHT, buildChef, buildPieTin, buildStool, chefGeometry, setStoolHeight, type ChefRig, type Mouth } from "./model";

type Brow = "neutral" | "up" | "sad" | "angry";

/** How long each timed reaction plays (seconds). */
const DURATION: Partial<Record<ChefReaction, number>> = {
  lean: 9,
  cheer: 1.9,
  gasp: 1.6,
  laugh: 2.4,
  point: 2.2,
  pie: 2.6,
  cry: 3.2,
  devil: 4,
};
const CREAM_SEC = 4.2;
const TIN_STICK_SEC = 0.8;
const DEVIL_HOLD_SEC = 24;
const PLATE_Y = 1.64;
/** World height above the table top (y = 0) that the face center should sit at. */
const FACE_EYE_CLEARANCE = 0.16;
const BUBBLE_Y = 1.32;
/** Bubbles float beside the head, on the camera's right (model units). */
const BUBBLE_SIDE = 0.56;

const LINES: Partial<Record<ChefReaction, string[]>> = {
  cheer: ["YESSS!", "WOOO!", "NAILED IT!", "YIPPEE!", "BOOYAH!"],
  gasp: ["OOH!", "EEP!", "GASP!", "OH NO!", "YIKES!"],
  cry: ["NOOO!", "MY COINS!", "WAAAH!", "SOB!", "WHYYY"],
  point: ["LOOK!", "THAT ONE!", "OI!", "SUS!"],
  pie: ["MMPH!", "BLORP", "*splat*", "MMFF!"],
};
const LAUGHS = ["HA HA!", "HA HA HA!", "HO HO!", "HEE HEE!"];

const DOWN = new THREE.Vector3(0, -1, 0);
const UP_AXIS = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

function pick<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
/** Smooth 0→1→0 envelope for a reaction of length `dur`. */
function envelope(t: number, dur: number, inT: number, outT: number): number {
  if (t < inT) return easeOut(t / inT);
  if (t > dur - outT) return easeOut(clamp((dur - t) / outT, 0, 1));
  return 1;
}
function easeOut(t: number): number {
  return 1 - (1 - t) * (1 - t);
}
function elasticOut(t: number): number {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  return Math.pow(2, -9 * t) * Math.sin((t * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1;
}
function bounceOut(t: number): number {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}
function damp(rate: number, dt: number): number {
  return 1 - Math.exp(-rate * dt);
}

/** Damped spring around 0 (used for jelly wobble). */
class Spring {
  x = 0;
  v = 0;
  constructor(
    private k: number,
    private c: number,
  ) {}
  kick(v: number): void {
    this.v += v;
  }
  step(dt: number): void {
    const h = dt / 2;
    for (let i = 0; i < 2; i++) {
      this.v += (-this.k * this.x - this.c * this.v) * h;
      this.x += this.v * h;
    }
  }
}

interface ArmTarget {
  dir: THREE.Vector3;
  elbow: number;
}

interface Tear {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

export class Chef {
  readonly rig: ChefRig;
  readonly plate = new Nameplate();
  readonly bubble = new Bubble();
  /** Called when the pie tin peels off the face (the manager lets it fall in world space). */
  onTinFall: ((tin: THREE.Group) => void) | null = null;

  private glow: THREE.Sprite;
  private info: PlateInfo;
  private displayCoins = 0;
  private plateDirty = true;
  private platePop = 0;
  private lastDrawnCoins = -1;

  private seatPos = new THREE.Vector3();
  private seatYaw = 0;
  private baseScale = 1;
  /** How far the stool lifts the chef above the seat (world meters). */
  private lift = 0;
  private stool = buildStool();
  private seated = new THREE.Vector3();
  private placed = false;

  private reaction: ChefReaction | null = null;
  private rt = 0;
  private rdur = 0;
  private phase = Math.random() * 10;
  private standing = false;
  private standAmt = 0;
  private hold: THREE.Vector3 | null = null;
  private braceT = -1;
  private creamT = -1;
  private tin: THREE.Group | null = null;
  private starsT = -1;
  private devilT = -1;
  private hatDropT = -1;
  private hatVel = new THREE.Vector3();
  private laughIdx = 0;
  private zzzT = 0;

  private sq = new Spring(240, 9);
  private knock = new Spring(90, 7);
  private wob = new Spring(140, 6);
  private cur = { jump: 0, lean: 0, roll: 0, twist: 0, eye: 1, squint: 1, stretch: 0, devil: 0, cream: 0 };
  private arms: [ArmTarget, ArmTarget] = [
    { dir: new THREE.Vector3(), elbow: 0 },
    { dir: new THREE.Vector3(), elbow: 0 },
  ];
  private browCur: { y: number; rot: number }[] = [];
  private blinkIn = 1 + Math.random() * 3;
  private blinkT = -1;
  private eyeShake = 0;

  private bubbleT = -1;
  private bubbleDur = 0;
  private tears: Tear[] = [];
  private tearAcc = 0;
  private tearSide = 1;

  private spawnT = 0;
  private removeT = -1;
  dead = false;

  constructor(
    readonly id: string,
    player: PlayerView,
    readonly seatIndex: number,
  ) {
    const color = PLAYER_COLORS[player.color % PLAYER_COLORS.length]!;
    this.rig = buildChef(color, seatIndex);
    this.rig.root.userData.chefId = id;
    this.info = {
      nickname: player.nickname,
      coins: player.coins,
      color,
      isMe: false,
      isActive: false,
      connected: player.connected,
      trend: 0,
    };
    this.displayCoins = player.coins;

    this.plate.sprite.position.y = PLATE_Y;
    this.rig.root.add(this.plate.sprite);
    this.bubble.sprite.position.y = BUBBLE_Y;
    this.rig.root.add(this.bubble.sprite);

    const glowMat = new THREE.SpriteMaterial({
      map: glowTexture(),
      color: "#FF2A2A",
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.glow = new THREE.Sprite(glowMat);
    this.glow.position.set(0, 0.7, -0.2);
    this.glow.scale.setScalar(2.6);
    this.glow.visible = false;
    this.rig.root.add(this.glow);

    this.browCur = this.rig.brows.map(() => ({ y: 0, rot: 0 }));
    this.rig.root.add(this.stool);
    this.rig.root.scale.setScalar(0.001);
  }

  // ------------------------------------------------------------------ data
  setPlayer(p: PlayerView, isMe: boolean, isActive: boolean): void {
    const color = PLAYER_COLORS[p.color % PLAYER_COLORS.length]!;
    if (color !== this.info.color) {
      // Lobby hat-color change: swap the body/arm material and bounce.
      this.info.color = color;
      const mat = toon(color);
      this.rig.body.material = mat;
      for (const a of this.rig.arms) {
        a.shoulder.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.name !== "outline" && m.material === this.rig.bodyMat) m.material = mat;
        });
      }
      this.rig.bodyMat = mat;
      this.sq.kick(4);
      this.plateDirty = true;
    }
    if (p.nickname !== this.info.nickname || isMe !== this.info.isMe || isActive !== this.info.isActive || p.connected !== this.info.connected) {
      if (p.connected && !this.info.connected) this.sq.kick(5); // woke up!
      this.info.nickname = p.nickname;
      this.info.isMe = isMe;
      this.info.isActive = isActive;
      this.info.connected = p.connected;
      this.plateDirty = true;
    }
    if (p.coins !== this.info.coins) {
      this.info.coins = p.coins;
      this.platePop = 1;
    }
  }

  setSeat(position: THREE.Vector3, fallbackYaw: number): void {
    this.seatPos.copy(position);
    // Face the table center (model faces +Z); fall back to the stage's yaw at the exact center.
    const d = Math.hypot(position.x, position.z);
    this.seatYaw = d > 1e-3 ? Math.atan2(-position.x, -position.z) : fallbackYaw;
    // Fit the chef so the hat tops out ~0.55 m over the table top (y = 0) from wherever the seat is,
    // then pop it on a stool so the face clears the table edge.
    this.baseScale = clamp((0.55 - position.y) / MODEL_HEIGHT, 0.3, 1.0);
    this.lift = Math.max(0, FACE_EYE_CLEARANCE - (position.y + FACE_Y * this.baseScale));
    setStoolHeight(this.stool, this.lift / this.baseScale);
    this.seated.copy(position).y += this.lift;
    if (!this.placed) {
      this.placed = true;
      this.rig.root.position.copy(this.seated);
      this.rig.root.rotation.y = this.seatYaw;
    }
  }

  setHold(world: THREE.Vector3 | null): void {
    if (world) {
      if (!this.hold) this.hold = new THREE.Vector3();
      this.hold.copy(world);
    } else this.hold = null;
  }

  /** World-space face center. */
  facePoint(out: THREE.Vector3): THREE.Vector3 {
    this.rig.face.updateWorldMatrix(true, false);
    return this.rig.face.getWorldPosition(out);
  }

  /** World-space forward (toward the table). */
  forward(out: THREE.Vector3): THREE.Vector3 {
    return out.set(Math.sin(this.rig.root.rotation.y), 0, Math.cos(this.rig.root.rotation.y));
  }

  get floorY(): number {
    return this.seatPos.y;
  }

  get removing(): boolean {
    return this.removeT >= 0;
  }

  remove(): void {
    if (this.removeT < 0) {
      this.removeT = 0;
      this.say("BYE!", 0.6, "#FFFFFF");
    }
  }

  // ------------------------------------------------------------- reactions
  react(r: ChefReaction): void {
    if (this.removing) return;
    if (r === "standUp") {
      if (!this.standing) this.sq.kick(5);
      this.standing = true;
      return;
    }
    if (r === "sitDown") {
      if (this.standing) this.sq.kick(-4);
      this.standing = false;
      return;
    }
    if (r === "pie") {
      // Chefs.ts throws the pie and calls splat() on impact; meanwhile, brace for it.
      this.braceT = 0;
      return;
    }
    // The cream mask keeps its own timer, so reactions can stack on a creamy face.
    this.reaction = r;
    this.rt = 0;
    this.rdur = DURATION[r] ?? 2;
    switch (r) {
      case "cheer":
        this.say(pick(LINES.cheer!), 1.4, "#7BE07B");
        break;
      case "gasp":
        this.sq.kick(5);
        this.say(pick(LINES.gasp!), 1.2, "#3FA7FF");
        break;
      case "laugh":
        this.laughIdx = Math.floor(Math.random() * LAUGHS.length);
        this.say(LAUGHS[this.laughIdx]!, 2.2, "#FFC23F");
        break;
      case "cry":
        this.sq.kick(-3);
        this.say(pick(LINES.cry!), 1.8, "#7FD4FF");
        break;
      case "point":
        this.say(pick(LINES.point!), 1.4, "#FF8BD1");
        break;
      case "devil":
        this.devilT = 0;
        this.hatDropT = -1;
        this.hatVel.set((Math.random() - 0.5) * 0.8, 3.0, -0.7);
        this.rig.hat.position.copy(this.rig.hatHome);
        this.rig.hat.rotation.set(0, 0, 0);
        this.rig.hat.scale.setScalar(1);
        this.rig.hat.visible = true;
        this.sq.kick(-6);
        break;
      case "lean":
        break;
    }
  }

  /** The cream pie has landed: SPLAT. */
  splat(): void {
    this.braceT = -1;
    this.creamT = 0;
    this.starsT = 0;
    this.reaction = "pie";
    this.rt = 0;
    this.rdur = DURATION.pie!;
    this.sq.kick(-9);
    this.knock.kick(-7);
    this.wob.kick((Math.random() - 0.5) * 6);
    this.eyeShake = 4;

    const c = this.rig.cream;
    c.group.visible = true;
    c.group.scale.setScalar(0.01);
    c.group.position.y = 0.7;
    for (const d of c.drips) d.scale.y = 0.2;
    if (this.tin) this.tin.removeFromParent();
    this.tin = buildPieTin();
    this.tin.rotation.z = Math.random() * Math.PI;
    c.tinSlot.add(this.tin);
    this.bubbleT = -1;
    this.bubble.sprite.visible = false;
  }

  say(text: string, dur: number, accent: string): void {
    this.bubble.draw(text, accent);
    this.bubbleT = 0;
    this.bubbleDur = dur;
    this.bubble.sprite.visible = true;
  }

  // ---------------------------------------------------------------- update
  update(dt: number, time: number, pointAt: THREE.Vector3 | null, camRight?: THREE.Vector3): void {
    const rig = this.rig;
    this.rt += dt;

    // Seat slide + spawn/despawn pop.
    rig.root.position.lerp(this.seated, damp(5, dt));
    let dy = this.seatYaw - rig.root.rotation.y;
    dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    rig.root.rotation.y += dy * damp(5, dt);
    let pop = 1;
    if (this.removeT >= 0) {
      this.removeT += dt;
      const t = clamp(this.removeT / 0.45, 0, 1);
      pop = t < 0.3 ? 1 + 0.25 * (t / 0.3) : 1.25 * (1 - (t - 0.3) / 0.7);
      if (t >= 1) this.dead = true;
    } else if (this.spawnT < 1) {
      this.spawnT += dt / 0.7;
      pop = elasticOut(this.spawnT);
    }
    rig.root.scale.setScalar(Math.max(0.001, this.baseScale * pop));

    // ---- targets for this frame
    let jump = 0;
    let lean = 0;
    let roll = Math.sin(time * 0.9 + this.phase) * 0.025;
    let twist = Math.sin(time * 0.37 + this.phase) * 0.06;
    let eye = 1;
    let squint = 1;
    let stretch = Math.sin(time * 2.1 + this.phase) * 0.022; // breathing
    let mouth: Mouth = "smile";
    let brow: Brow = "neutral";
    const swing = Math.sin(time * 1.7 + this.phase) * 0.08;
    this.setArm(0, -0.25 - swing, -1, 0.12, -0.35);
    this.setArm(1, 0.25 + swing, -1, 0.12, -0.35);
    let mustacheWiggle = Math.sin(time * 3 + this.phase) * 0.04;

    const r = this.reaction;
    const t = this.rt;
    const env = r ? envelope(t, this.rdur, 0.12, 0.3) : 0;
    if (r && t >= this.rdur) this.reaction = null;

    switch (r) {
      case "lean": {
        const e = envelope(t, this.rdur, 0.5, 0.6);
        lean += 0.3 * e;
        eye += 0.18 * e;
        brow = "up";
        mouth = "o";
        twist *= 1 - e;
        this.setArm(0, -0.18, -0.15, 1, -0.4, e);
        this.setArm(1, 0.18, -0.15, 1, -0.4, e);
        break;
      }
      case "cheer": {
        // Two hops: anticipation squash → stretch on the way up → splat landing.
        const p = (t % 0.95) / 0.95;
        if (p < 0.16) stretch -= 0.28 * (p / 0.16);
        else if (p < 0.84) {
          const q = (p - 0.16) / 0.68;
          jump += 0.42 * Math.sin(Math.PI * q);
          stretch += 0.26 * Math.cos(Math.PI * q);
        } else stretch -= 0.32 * (1 - (p - 0.84) / 0.16);
        mouth = "grin";
        brow = "up";
        squint = 0.55;
        const wave = Math.sin(t * 16) * 0.35;
        this.setArm(0, -0.5 - wave, 1, 0.15, -0.2, env);
        this.setArm(1, 0.5 + wave, 1, 0.15, -0.2, env);
        break;
      }
      case "gasp": {
        jump += t < 0.25 ? Math.sin((t / 0.25) * Math.PI) * 0.1 : 0;
        stretch += 0.2 * Math.max(0, 1 - t / 0.4);
        lean -= 0.2 * env;
        eye += 0.85 * env;
        mouth = "o";
        brow = "up";
        // Hands slapped onto the cheeks.
        this.setArm(0, -0.2, 0.55, 0.95, -1.25, env);
        this.setArm(1, 0.2, 0.55, 0.95, -1.25, env);
        roll += Math.sin(t * 40) * 0.03 * env;
        break;
      }
      case "laugh": {
        roll += Math.sin(t * 24) * 0.13 * env;
        jump += Math.abs(Math.sin(t * 12)) * 0.06 * env;
        stretch += Math.sin(t * 24) * 0.06 * env;
        lean -= 0.14 * env;
        squint = 0.2;
        mouth = "grin";
        brow = "up";
        mustacheWiggle += Math.sin(t * 30) * 0.25;
        const shake = Math.sin(t * 20) * 0.15;
        this.setArm(0, -0.1, -0.1 + shake, 1, -1.0, env);
        this.setArm(1, 0.1, -0.1 - shake, 1, -1.0, env);
        const idx = Math.floor(t / 0.45);
        if (idx !== this.laughIdx && t < this.rdur - 0.4) {
          this.laughIdx = idx;
          this.bubble.draw(LAUGHS[idx % LAUGHS.length]!, "#FFC23F");
        }
        break;
      }
      case "point": {
        const target = pointAt;
        let side = 1;
        if (target) {
          rig.lean.updateWorldMatrix(true, false);
          tmpV.copy(target);
          rig.root.worldToLocal(tmpV);
          twist = clamp(Math.atan2(tmpV.x, tmpV.z), -0.8, 0.8) * env;
          side = tmpV.x >= 0 ? 1 : -1;
          this.aimArmAt(side === 1 ? 1 : 0, target, -0.05, env);
        } else this.setArm(1, 0.3, 0.5, 1, 0, env);
        // Other hand on the hip, very sassy.
        const other = side === 1 ? 0 : 1;
        const s = other === 0 ? -1 : 1;
        this.setArm(other, s * 1, -0.3, -0.3, -1.7, env);
        lean += 0.12 * env;
        brow = "angry";
        mouth = "grin";
        squint = 0.7;
        jump += t < 0.3 ? Math.sin((t / 0.3) * Math.PI) * 0.05 : 0;
        break;
      }
      case "pie": {
        // Knocked silly: arms flail, then a sad attempt to wipe the face.
        if (t < 1.1) {
          const f = Math.sin(t * 22);
          this.setArm(0, -1, 0.6 + f * 0.6, 0.2, -0.5 + f * 0.3);
          this.setArm(1, 1, 0.6 - f * 0.6, 0.2, -0.5 - f * 0.3);
        } else {
          const w = Math.sin(t * 10) * 0.25;
          this.setArm(0, -0.25 + w, 0.6, 1, -1.1, env);
          this.setArm(1, 0.25 - w, 0.6, 1, -1.1, env);
        }
        roll += Math.sin(t * 7) * 0.08 * env;
        brow = "sad";
        if (t > 0.55 && t - dt <= 0.55) this.say(pick(LINES.pie!), 1.3, "#FFFFFF");
        break;
      }
      case "cry": {
        jump += Math.abs(Math.sin(t * 9)) * 0.035 * env;
        stretch -= Math.abs(Math.sin(t * 9)) * 0.05 * env;
        lean += 0.15 * env;
        mouth = "frown";
        brow = "sad";
        squint = 0.35;
        const rub = Math.sin(t * 14) * 0.2;
        this.setArm(0, -0.15 + rub, 0.75, 1, -1.4, env * 0.8);
        this.setArm(1, 0.15 - rub, 0.75, 1, -1.4, env * 0.8);
        this.emitTears(dt, env);
        break;
      }
      case "devil": {
        const k = t > 0.45 ? env : 0;
        if (t > 0.45 && t - dt <= 0.45) this.say("MWAHAHA!", 2.6, "#FF4B4B");
        roll += Math.sin(t * 20) * 0.1 * k;
        jump += Math.abs(Math.sin(t * 10)) * 0.05 * k;
        lean -= 0.12 * k;
        mouth = "grin";
        squint = 0.55;
        // Evil hand-rubbing.
        const rub = Math.sin(t * 18) * 0.25;
        this.setArm(0, -0.05 + rub, 0.15, 1, -1.5, env);
        this.setArm(1, 0.05 - rub, 0.15, 1, -1.5, env);
        break;
      }
      default:
        break;
    }

    // Brace for the incoming pie: eyes HUGE, mouth O, hands up in front.
    if (this.braceT >= 0) {
      this.braceT += dt;
      const e = clamp(this.braceT / 0.15, 0, 1);
      eye += 0.9 * e;
      mouth = "o";
      brow = "up";
      lean -= 0.12 * e;
      stretch += 0.12 * e;
      this.setArm(0, -0.35, 0.9, 1, -0.6, e);
      this.setArm(1, 0.35, 0.9, 1, -0.6, e);
      if (this.braceT > 2) this.braceT = -1; // pie never arrived (chef left?)
    }

    // Devil look persists after the reveal laugh.
    this.updateDevil(dt, time);
    if (this.devilT >= 0) brow = "angry";

    // Standing / puppeting the hover piece.
    const wantStand = this.standing || this.hold !== null;
    this.standAmt += ((wantStand ? 1 : 0) - this.standAmt) * damp(6, dt);
    jump += 0.2 * this.standAmt;
    if (this.hold) {
      const wig = Math.sin(time * 7) * 0.08;
      this.aimArmAt(0, this.hold, -0.25 + wig, 1);
      this.aimArmAt(1, this.hold, -0.25 - wig, 1);
      lean += 0.1;
      eye += 0.1;
      brow = brow === "neutral" ? "up" : brow;
      twist *= 0.3;
    } else if (this.standing && !r) {
      // Puppeteer pose: arms up, fingers wiggling on invisible strings.
      const wig = Math.sin(time * 6) * 0.12;
      this.setArm(0, -0.4, 1.1 + wig, 0.6, -0.5, this.standAmt);
      this.setArm(1, 0.4, 1.1 - wig, 0.6, -0.5, this.standAmt);
    }

    // Disconnected: asleep, slumped, snoring.
    if (!this.info.connected) {
      squint = 0.08;
      lean += 0.28;
      mouth = "o";
      brow = "neutral";
      this.setArm(0, -0.1, -1, 0.05, -0.1);
      this.setArm(1, 0.1, -1, 0.05, -0.1);
      stretch += Math.sin(time * 1.4) * 0.04;
      this.zzzT -= dt;
      if (this.zzzT <= 0) {
        this.zzzT = 3.2;
        this.say("Zzz…", 2.4, "#9FA8FF");
      }
    }

    // Cream face.
    this.updateCream(dt, time);
    if (this.creamT >= 0) squint = Math.max(squint, 0.8);

    // ---- springs + smoothing
    this.sq.step(dt);
    this.knock.step(dt);
    this.wob.step(dt);
    const c = this.cur;
    c.jump += (jump - c.jump) * damp(28, dt);
    c.lean += (lean - c.lean) * damp(9, dt);
    c.roll += (roll - c.roll) * damp(18, dt);
    c.twist += (twist - c.twist) * damp(8, dt);
    c.eye += (eye - c.eye) * damp(eye > c.eye ? 30 : 10, dt);
    c.squint += (squint - c.squint) * damp(16, dt);
    c.stretch += (stretch - c.stretch) * damp(26, dt);

    rig.bounce.position.y = c.jump;
    rig.lean.rotation.set(c.lean + this.knock.x * 0.12, c.twist, c.roll + this.wob.x * 0.1, "YXZ");
    const sy = clamp(1 + c.stretch + this.sq.x * 0.06, 0.45, 1.65);
    const sxz = 1 / Math.sqrt(sy);
    rig.squash.scale.set(sxz, sy, sxz);

    this.updateArms(dt, time);
    this.updateFace(dt, mouth, brow, mustacheWiggle);

    // Eyes: blink, gasp size, poke through the cream.
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && this.blinkT < 0) this.blinkT = 0;
    let blink = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      blink = Math.max(0.08, Math.abs(1 - this.blinkT / 0.07));
      if (this.blinkT > 0.14) {
        this.blinkT = -1;
        this.blinkIn = this.creamT >= 0 ? 0.35 + Math.random() * 0.6 : 1.8 + Math.random() * 3.5;
      }
    }
    const e = c.eye * (1 + this.sq.x * 0.02);
    rig.eyes.scale.set(e, e * Math.min(blink, c.squint), e);
    rig.eyes.position.set(0, EYE_Y + (c.eye - 1) * 0.02, 0.272 + c.cream * 0.075);
    this.eyeShake = Math.max(0, this.eyeShake - dt * 3);
    jiggleEyes(rig.eyes, dt, this.eyeShake + Math.abs(this.sq.v) * 0.05 + Math.abs(c.roll) * 2);

    this.updateTears(dt);
    this.updateLabels(dt, time, camRight);
  }

  // ------------------------------------------------------------------ arms
  /** Aim arm `i` along a direction in squash space; `w` blends from the current target. */
  private setArm(i: number, x: number, y: number, z: number, elbow: number, w = 1): void {
    const a = this.arms[i as 0 | 1];
    if (w >= 1) {
      a.dir.set(x, y, z);
      a.elbow = elbow;
    } else if (w > 0) {
      a.dir.lerp(tmpV2.set(x, y, z), w);
      a.elbow += (elbow - a.elbow) * w;
    }
  }

  private aimArmAt(i: number, world: THREE.Vector3, elbow: number, w: number): void {
    const arm = this.rig.arms[i as 0 | 1];
    this.rig.squash.updateWorldMatrix(true, false);
    tmpV2.copy(world);
    this.rig.squash.worldToLocal(tmpV2);
    tmpV2.sub(arm.shoulder.position).normalize();
    this.setArm(i, tmpV2.x, tmpV2.y, tmpV2.z, elbow, w);
  }

  private updateArms(dt: number, time: number): void {
    const k = damp(14, dt);
    for (let i = 0; i < 2; i++) {
      const arm = this.rig.arms[i]!;
      const tgt = this.arms[i as 0 | 1];
      tmpV.copy(tgt.dir);
      if (tmpV.lengthSq() < 1e-6) tmpV.set(0, -1, 0);
      tmpV.normalize();
      if (tmpV.y > 0.999) tmpV.x += 0.01 * arm.side; // avoid the degenerate straight-up flip
      tmpQ.setFromUnitVectors(DOWN, tmpV.normalize());
      arm.shoulder.quaternion.slerp(tmpQ, k);
      arm.elbow.rotation.x += (tgt.elbow - arm.elbow.rotation.x) * k;
      // Noodle wobble: the forearm lags a little.
      arm.elbow.rotation.z = Math.sin(time * 5 + i * 2 + this.phase) * 0.08 + this.wob.v * 0.01 * arm.side;
      arm.hand.rotation.z = Math.sin(time * 9 + i) * (this.hold ? 0.5 : 0.08);
    }
  }

  // ------------------------------------------------------------------ face
  private updateFace(dt: number, mouth: Mouth, brow: Brow, wiggle: number): void {
    const rig = this.rig;
    const creamy = this.creamT >= 0 && this.creamT < CREAM_SEC - 0.3;
    for (const [k, o] of Object.entries(rig.mouths) as [Mouth, THREE.Object3D][]) o.visible = !creamy && k === mouth;
    if (mouth === "grin") rig.mouths.grin.scale.set(1, 1 + Math.sin(this.rt * 22) * 0.18, 1);
    if (mouth === "o") {
      const s = this.cur.eye > 1.3 ? 1.35 : 1;
      rig.mouths.o.scale.set(0.05 * s, 0.062 * s * (1 + Math.sin(this.rt * 30) * 0.06), 0.018);
    }
    if (mouth === "frown") rig.mouths.frown.position.x = Math.sin(this.rt * 35) * 0.006; // wobbly lip

    const k = damp(14, dt);
    rig.brows.forEach((b, i) => {
      const s = b.userData.side as number;
      const home = b.userData.home as THREE.Vector3;
      let y = 0;
      let rot = 0;
      if (brow === "up") y = 0.035;
      else if (brow === "sad") {
        y = 0.015;
        rot = -s * 0.42;
      } else if (brow === "angry") {
        y = -0.012;
        rot = s * 0.48;
      }
      if (s === 0 && brow === "angry") y = -0.02; // unibrow can only frown down
      const cb = this.browCur[i]!;
      cb.y += (y - cb.y) * k;
      cb.rot += (rot - cb.rot) * k;
      b.position.set(home.x, home.y + cb.y + (this.cur.eye - 1) * 0.03, home.z + this.cur.cream * 0.06);
      b.rotation.z = cb.rot;
    });
    if (rig.mustache) {
      rig.mustache.rotation.z = wiggle * 0.3;
      rig.mustache.scale.y = 1 + wiggle * 0.6;
    }
  }

  // ----------------------------------------------------------------- cream
  private updateCream(dt: number, time: number): void {
    const c = this.rig.cream;
    // Dizzy stars after the splat.
    if (this.starsT >= 0) {
      this.starsT += dt;
      const st = this.rig.stars;
      st.visible = true;
      const k = this.starsT < 0.2 ? this.starsT / 0.2 : this.starsT > 2.0 ? Math.max(0, 1 - (this.starsT - 2.0) / 0.4) : 1;
      st.children.forEach((s) => {
        const a = (s.userData.phase as number) + this.starsT * 6;
        s.position.set(Math.cos(a) * 0.26, Math.sin(a * 2) * 0.03, Math.sin(a) * 0.26);
        s.rotation.set(0, -a, this.starsT * 8);
        s.scale.setScalar(k);
      });
      if (this.starsT > 2.4) {
        this.starsT = -1;
        st.visible = false;
      }
    }

    if (this.creamT < 0) {
      this.cur.cream += (0 - this.cur.cream) * damp(10, dt);
      return;
    }
    this.creamT += dt;
    const t = this.creamT;
    this.cur.cream = t < CREAM_SEC - 0.5 ? 1 : Math.max(0, (CREAM_SEC - t) / 0.5);
    // Splat pop (wide and flat first), then jiggle.
    const p = elasticOut(clamp(t / 0.45, 0, 1));
    let sx = p * (1 + Math.max(0, 0.35 - t) * 1.5);
    let sy = p * (1 - Math.max(0, 0.35 - t) * 0.8);
    sx *= 1 + Math.sin(time * 9) * 0.015;
    sy *= 1 + Math.cos(time * 9) * 0.015;
    // End: the whole cream mask slides down and plops away.
    let slide = 0;
    if (t > CREAM_SEC - 0.6) {
      const q = clamp((t - (CREAM_SEC - 0.6)) / 0.6, 0, 1);
      slide = -0.22 * q * q;
      sx *= 1 - q;
      sy *= 1 - q;
    }
    c.group.scale.set(Math.max(0.001, sx), Math.max(0.001, sy), Math.max(0.001, p));
    c.group.position.y = 0.7 + slide;
    for (const d of c.drips) {
      const sp = d.userData.speed as number;
      d.scale.y = Math.min(2.6, 0.2 + t * sp * 0.55) * (1 + Math.sin(time * 6 + sp * 10) * 0.08);
    }
    // The tin hangs on for a beat, then peels off and clatters away.
    if (this.tin && t > TIN_STICK_SEC) {
      const tin = this.tin;
      this.tin = null;
      if (this.onTinFall) this.onTinFall(tin);
      else tin.removeFromParent();
    } else if (this.tin) {
      this.tin.rotation.z += dt * 0.6;
      this.tin.position.y = -Math.max(0, t - 0.5) * 0.12;
    }
    if (t >= CREAM_SEC) {
      this.creamT = -1;
      c.group.visible = false;
    }
  }

  // ----------------------------------------------------------------- devil
  private updateDevil(dt: number, time: number): void {
    const rig = this.rig;
    if (this.devilT >= 0) {
      this.devilT += dt;
      const t = this.devilT;
      // Chef hat rockets off, spinning, and tumbles away behind.
      if (rig.hat.visible) {
        this.hatVel.y -= 6.5 * dt;
        rig.hat.position.addScaledVector(this.hatVel, dt);
        rig.hat.rotation.x -= dt * 14;
        rig.hat.rotation.z += dt * 9;
        if (t > 0.9) rig.hat.scale.setScalar(Math.max(0.001, 1 - (t - 0.9) / 0.4));
        if (t > 1.3) rig.hat.visible = false;
      }
      // Tiny devil hat + tail pop in with a boing.
      const dh = elasticOut(clamp((t - 0.25) / 0.55, 0, 1));
      rig.devilHat.visible = dh > 0.001;
      rig.devilHat.scale.setScalar(Math.max(0.001, dh));
      rig.devilHat.rotation.z = Math.sin(time * 3) * 0.08;
      const tl = elasticOut(clamp((t - 0.5) / 0.6, 0, 1));
      rig.tail.visible = tl > 0.001;
      rig.tail.scale.setScalar(Math.max(0.001, tl));
      rig.tail.rotation.y = Math.sin(time * 4) * 0.4;
      this.cur.devil += (1 - this.cur.devil) * damp(3, dt);
      if (t > DEVIL_HOLD_SEC) {
        // Put the chef hat back on (it drops from the ceiling with a bonk).
        this.devilT = -1;
        this.hatDropT = 0;
        rig.hat.visible = true;
        rig.hat.rotation.set(0, 0, 0);
        rig.hat.scale.setScalar(1);
      }
    } else {
      this.cur.devil += (0 - this.cur.devil) * damp(4, dt);
      if (rig.devilHat.visible) {
        const s = rig.devilHat.scale.x * (1 - damp(10, dt));
        rig.devilHat.scale.setScalar(s);
        rig.tail.scale.setScalar(s);
        if (s < 0.02) rig.devilHat.visible = rig.tail.visible = false;
      }
    }
    if (this.hatDropT >= 0) {
      this.hatDropT += dt;
      const q = clamp(this.hatDropT / 0.7, 0, 1);
      rig.hat.position.copy(rig.hatHome);
      rig.hat.position.y += 1.2 * (1 - bounceOut(q));
      if (q >= 1) {
        this.hatDropT = -1;
        this.sq.kick(-5);
      }
    }
    const g = this.cur.devil;
    this.glow.visible = g > 0.01;
    this.glow.material.opacity = g * (0.45 + Math.sin(time * 5) * 0.12);
    this.glow.scale.setScalar(2.4 + Math.sin(time * 5) * 0.15);
  }

  // ----------------------------------------------------------------- tears
  private emitTears(dt: number, env: number): void {
    this.tearAcc += dt * 34 * env;
    const G = chefGeometry();
    while (this.tearAcc >= 1) {
      this.tearAcc -= 1;
      this.tearSide = -this.tearSide;
      const s = this.tearSide;
      let tear = this.tears.find((x) => x.life <= 0);
      if (!tear) {
        if (this.tears.length >= 60) break;
        const m = new THREE.Mesh(G.smallSphere, toon("#7FD4FF"));
        m.userData.noOutline = true;
        this.rig.root.add(m);
        tear = { mesh: m, vel: new THREE.Vector3(), life: 0 };
        this.tears.push(tear);
      }
      const sy = this.rig.squash.scale.y;
      tear.mesh.position.set(s * (EYE_SPACING + 0.05), EYE_Y * sy + this.cur.jump, 0.3);
      tear.vel.set(s * (0.9 + Math.random() * 0.6), 1.2 + Math.random() * 0.7, 0.25 + Math.random() * 0.35);
      tear.life = 0.85;
      tear.mesh.visible = true;
    }
  }

  private updateTears(dt: number): void {
    for (const t of this.tears) {
      if (t.life <= 0) continue;
      t.life -= dt;
      t.vel.y -= 5 * dt;
      t.mesh.position.addScaledVector(t.vel, dt);
      const s = 0.028 * Math.min(1, t.life / 0.3 + 0.2);
      t.mesh.scale.set(s, s * 1.4, s);
      if (t.life <= 0) t.mesh.visible = false;
    }
  }

  // ---------------------------------------------------------------- labels
  private updateLabels(dt: number, time: number, camRight?: THREE.Vector3): void {
    // Rolling coin counter.
    const diff = this.info.coins - this.displayCoins;
    if (Math.abs(diff) > 0.01) {
      const step = diff * damp(5, dt);
      this.displayCoins += Math.abs(step) < 0.4 ? Math.sign(diff) * Math.min(Math.abs(diff), 0.4) : step;
    }
    const shown = Math.round(this.displayCoins);
    const trend = shown === this.info.coins ? 0 : Math.sign(diff);
    if (shown !== this.lastDrawnCoins || trend !== this.info.trend || this.plateDirty) {
      this.info.trend = trend;
      this.plate.draw({ ...this.info, coins: shown });
      this.lastDrawnCoins = shown;
      this.plateDirty = false;
    }
    this.platePop = Math.max(0, this.platePop - dt * 2.5);
    const base = this.plate.sprite.userData.baseScale as THREE.Vector3;
    const bob = this.info.isActive ? 1 + Math.sin(time * 6) * 0.04 : 1;
    const pp = 1 + Math.sin(this.platePop * Math.PI) * 0.22;
    this.plate.sprite.scale.set(base.x * pp * bob, base.y * pp * bob, 1);
    this.plate.sprite.position.y = PLATE_Y + this.cur.jump * 0.6 + (this.info.isActive ? Math.sin(time * 3) * 0.02 : 0);
    this.plate.material.opacity = this.info.connected ? 1 : 0.6;

    // Speech bubble: pop in, float, fade.
    const b = this.bubble.sprite;
    if (this.bubbleT >= 0) {
      this.bubbleT += dt;
      const bt = this.bubbleT;
      const s = elasticOut(clamp(bt / 0.35, 0, 1));
      const bs = this.bubble.sprite.userData.baseScale as THREE.Vector3;
      b.scale.set(bs.x * s, bs.y * s, 1);
      // Beside the head on the camera's right, so the tail always points back at the face.
      if (camRight) {
        tmpV.copy(camRight).applyAxisAngle(UP_AXIS, -this.rig.root.rotation.y);
        tmpV.y = 0;
        if (tmpV.lengthSq() > 1e-6) tmpV.normalize();
      } else tmpV.set(1, 0, 0);
      b.position.set(tmpV.x * BUBBLE_SIDE, BUBBLE_Y + this.cur.jump * 0.8 + bt * 0.05 + Math.sin(bt * 3) * 0.015, tmpV.z * BUBBLE_SIDE);
      this.bubble.material.opacity = clamp((this.bubbleDur + 0.3 - bt) / 0.3, 0, 1);
      if (bt > this.bubbleDur + 0.3) {
        this.bubbleT = -1;
        b.visible = false;
      }
    }
  }

  dispose(): void {
    this.plate.dispose();
    this.bubble.dispose();
    this.glow.material.dispose();
    const cap = this.rig.devilHat.children[0] as THREE.Mesh | undefined;
    cap?.geometry.dispose();
    this.tin?.userData.dispose?.();
    this.stool.userData.dispose?.();
    this.rig.root.removeFromParent();
  }
}

