// The shared cartoon body every character is built on (gangsters, Cemil Abi, Komiser Rıfat, the weasel
// lawyer) and the Puppet that animates it procedurally: a Pose is written every frame by the character
// logic (base layer + blended clips), followed by critically damped springs (ease in AND out, no pops, the
// same at any frame rate) and applied: legs by angle with a stride driven by the real root motion (no foot
// sliding), arms by two-bone IK with a reach limit (elbows always bend), squash & stretch on the upper body,
// eyelids / blinks / gaze / brows / mouths / jaw / ears on the face. Owner: client-characters.
//
// Units: meters. The model stands at y = 0 and faces +z. Hierarchy:
//   root (world placement) > tilt (pivot on the floor: tip over / dragged) > body (hip pivot: height, bounce)
//   > { pelvis + legs, squash (upper body scale) > torso (waist pivot: lean/twist/roll) > neck/head + arms }

import * as THREE from "three";
import { addOutlines } from "../toon";
import { G, ghostDarkMat, ghostLineMat, ghostMat, greyOf, inkMat, mat, mergeStatic, mesh, noOutline } from "./kit";
import { Pop, Spring, TAU, clamp, damp, follow, followV, limitReach, solveArm, wrapAngle } from "./util";

export type MouthKind = "smile" | "smirk" | "frown" | "o" | "grin" | "flat" | "kiss" | "teeth";
export type BrowKind = "neutral" | "up" | "sad" | "angry" | "skeptic";
export type Skin = "normal" | "ghost" | "grey";

export interface Eye {
  root: THREE.Group;
  pupil: THREE.Object3D;
  lid: THREE.Mesh;
}
export interface Ear {
  pivot: THREE.Group;
  base: THREE.Euler;
  /** Rotation added at droop = 1 (sad) and at droop = −1 (perked up). */
  droop: THREE.Vector3;
  perk: THREE.Vector3;
}
export interface Face {
  head: THREE.Group;
  skull: THREE.Mesh;
  skullMat: THREE.MeshToonMaterial;
  eyes: Eye[];
  brows: { obj: THREE.Object3D; side: number; home: THREE.Vector3 }[];
  mouth: THREE.Group;
  mouths: Partial<Record<MouthKind, THREE.Object3D>>;
  jaw: THREE.Group | null;
  jawOpen: number;
  ears: Ear[];
  hatMount: THREE.Group;
  /** Lips (cigar, smoke, kisses) and nose tip anchors. */
  mouthTip: THREE.Object3D;
  nose: THREE.Object3D;
  /** Head-space height of the top of the head (without a hat). */
  top: number;
  blackEye: THREE.Object3D | null;
  /** Animal extras (frog throat, whiskers, nose twitch). */
  extra?: (time: number, dt: number, p: Pose) => void;
}

export interface Arm {
  side: number;
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Group;
  /** Props held in this hand attach here. */
  grip: THREE.Group;
  upper: number;
  fore: number;
  base: THREE.Vector3;
}
export interface Leg {
  side: number;
  hip: THREE.Group;
  knee: THREE.Group;
  foot: THREE.Group;
}

export interface BodySpec {
  suit: THREE.Material;
  pants?: THREE.Material;
  shirt?: THREE.Material;
  hands: THREE.Material;
  /** Tie in the player color (null: none). */
  tie?: THREE.Material | null;
  bowtie?: THREE.Material | null;
  /** Vest over the shirt (dealer): the jacket becomes the vest, sleeves become shirt sleeves. */
  vest?: boolean;
  /** Long trench coat skirt (cop). */
  coat?: THREE.Material | null;
  shoes?: THREE.Material;
  spats?: THREE.Material | null;
  /** Torso width / depth / height multipliers. */
  girth?: number;
  height?: number;
  legScale?: number;
  armScale?: number;
  pocketSquare?: THREE.Material | null;
}

export interface BodyRig {
  root: THREE.Group;
  tilt: THREE.Group;
  body: THREE.Group;
  pelvis: THREE.Group;
  squash: THREE.Group;
  torso: THREE.Group;
  neck: THREE.Group;
  arms: [Arm, Arm];
  legs: [Leg, Leg];
  /** Chest anchor (torso space) and tail mount (pelvis back). */
  chest: THREE.Object3D;
  back: THREE.Object3D;
  /** Invisible pick volume. */
  hitbox: THREE.Mesh;
  tie: THREE.Mesh[];
  /** Inside-out pocket linings (hidden until the empty-wallet raid). */
  pockets: THREE.Object3D[];
  seatHipY: number;
  standHipY: number;
  /** Thigh + shin. */
  legLen: number;
}

const SEAT_HIP_Y = 0.5;
const hitMat = new THREE.MeshBasicMaterial({ visible: false });
const hitGeo = new THREE.CylinderGeometry(0.34, 0.34, 1.45, 8);

export function buildBody(spec: BodySpec): BodyRig {
  const g = G();
  const girth = spec.girth ?? 1;
  const height = spec.height ?? 1;
  const ls = spec.legScale ?? 1;
  const as = spec.armScale ?? 1;
  const pants = spec.pants ?? spec.suit;
  const shirt = spec.shirt ?? mat("#F7F2E8");
  const shoes = spec.shoes ?? mat("#1E1A22");

  const root = new THREE.Group();
  const tilt = new THREE.Group();
  const body = new THREE.Group();
  const pelvis = new THREE.Group();
  const squash = new THREE.Group();
  const torso = new THREE.Group();
  root.add(tilt);
  tilt.add(body);
  body.add(pelvis, squash);
  squash.add(torso);
  torso.position.y = 0.03;

  // Pelvis (seat of the pants).
  pelvis.add(mesh(g.sphere, pants, 0, 0.02, 0, 0.2 * girth, 0.13, 0.17 * girth));
  const back = new THREE.Object3D();
  back.position.set(0, 0.04, -0.15 * girth);
  pelvis.add(back);

  // Legs.
  const thigh = 0.27 * ls;
  const shin = 0.28 * ls;
  const legs: Leg[] = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group();
    hip.position.set(s * 0.1 * girth, 0, 0.02);
    const th = mesh(g.thigh, pants, 0, 0, 0, 1.05 * girth, ls, 1.05 * girth);
    hip.add(th);
    const knee = new THREE.Group();
    knee.position.y = -thigh;
    hip.add(knee);
    knee.add(mesh(g.shin, pants, 0, 0, 0, 1, ls, 1));
    const foot = new THREE.Group();
    foot.position.y = -shin;
    knee.add(foot);
    foot.add(mesh(g.sphere, shoes, 0, -0.025, 0.05, 0.075, 0.055, 0.13));
    if (spec.spats) foot.add(mesh(g.cyl, spec.spats, 0, 0.0, 0.012, 0.072, 0.05, 0.08));
    pelvis.add(hip);
    legs.push({ side: s, hip, knee, foot });
  }

  // Torso: jacket (or vest), shirt front, tie, buttons, pocket square.
  torso.add(mesh(g.jacket, spec.suit, 0, 0, 0, girth, height, girth * 0.92));
  if (spec.coat) {
    const skirt = mesh(g.skirt, spec.coat, 0, 0.06, 0, girth * 1.02, height * 1.05, girth * 0.95);
    skirt.userData.noOutline = true;
    (skirt.material as THREE.Material).side = THREE.DoubleSide;
    torso.add(skirt);
    // Belt.
    torso.add(mesh(g.cyl, mat("#4A3424"), 0, 0.07 * height, 0, 0.212 * girth, 0.04, 0.198 * girth));
  }
  const frontZ = 0.185 * girth;
  const vY = 0.36 * height;
  torso.add(noOutline(mesh(g.sphere, shirt, 0, vY, frontZ - 0.01, 0.07 * girth, 0.11 * height, 0.045)));
  const tie: THREE.Mesh[] = [];
  if (spec.tie) {
    const knot = noOutline(mesh(g.sphere, spec.tie, 0, vY + 0.07 * height, frontZ + 0.022, 0.024, 0.022, 0.016));
    const blade = noOutline(mesh(g.cone, spec.tie, 0, vY - 0.035 * height, frontZ + 0.02, 0.032, -0.15 * height, 0.012));
    torso.add(knot, blade);
    tie.push(knot, blade);
  }
  if (spec.bowtie) {
    for (const s of [-1, 1]) {
      const b = noOutline(mesh(g.cone, spec.bowtie, s * 0.03, vY + 0.075 * height, frontZ + 0.03, 0.026, 0.05, 0.014));
      b.rotation.z = s * Math.PI / 2;
      torso.add(b);
    }
    torso.add(noOutline(mesh(g.sphere, spec.bowtie, 0, vY + 0.075 * height, frontZ + 0.034, 0.014)));
  }
  const btn = mat("#151219");
  for (let i = 0; i < 2; i++) torso.add(noOutline(mesh(g.sphereLo, btn, 0.0, 0.12 * height + i * 0.08 * height, 0.212 * girth, 0.013)));
  if (spec.pocketSquare) {
    const sq = noOutline(mesh(g.coneLo, spec.pocketSquare, 0.115 * girth, 0.33 * height, frontZ * 0.98, 0.026, 0.05, 0.012));
    sq.rotation.z = 0.25;
    torso.add(sq);
    tie.push(sq);
  }
  const chest = new THREE.Object3D();
  chest.position.set(0, 0.3 * height, frontZ + 0.05);
  torso.add(chest);

  // Inside-out pockets (empty wallet gag).
  const pockets: THREE.Object3D[] = [];
  for (const s of [-1, 1]) {
    const p = mesh(g.sphere, mat("#F2EEE6"), s * 0.215 * girth, 0.0, 0.06, 0.055, 0.07, 0.04);
    p.visible = false;
    pelvis.add(p);
    pockets.push(p);
  }

  // Neck / head mount.
  const neck = new THREE.Group();
  neck.position.set(0, 0.47 * height, 0.01);
  torso.add(neck);

  // Arms (IK driven).
  const sleeve = spec.vest ? shirt : spec.suit;
  const upper = 0.2 * as;
  const fore = 0.19 * as;
  const arms: Arm[] = [];
  for (const s of [-1, 1]) {
    const base = new THREE.Vector3(s * 0.2 * girth, 0.4 * height, 0);
    const shoulder = new THREE.Group();
    shoulder.position.copy(base);
    shoulder.add(mesh(g.sphere, sleeve, 0, 0, 0, 0.075, 0.075, 0.075));
    shoulder.add(mesh(g.upperArm, sleeve, 0, 0, 0, 1, as, 1));
    if (spec.vest) shoulder.add(noOutline(mesh(g.cyl, mat("#C0392B"), 0, -upper * 0.45, 0, 0.066, 0.025, 0.066)));
    const elbow = new THREE.Group();
    elbow.position.y = -upper;
    shoulder.add(elbow);
    elbow.add(mesh(g.foreArm, sleeve, 0, 0, 0, 1, as, 1));
    const hand = new THREE.Group();
    hand.position.y = -fore;
    elbow.add(hand);
    hand.add(noOutline(mesh(g.cyl, shirt, 0, 0.012, 0, 0.06, 0.03, 0.06)));
    hand.add(mesh(g.sphere, spec.hands, 0, -0.045, 0.005, 0.064, 0.06, 0.056));
    hand.add(mesh(g.sphere, spec.hands, -s * 0.045, -0.03, 0.03, 0.026, 0.03, 0.026));
    const grip = new THREE.Group();
    grip.position.set(0, -0.06, 0.04);
    hand.add(grip);
    torso.add(shoulder);
    arms.push({ side: s, shoulder, elbow, hand, grip, upper, fore, base });
  }

  const hitbox = new THREE.Mesh(hitGeo, hitMat);
  hitbox.position.y = 0.72;
  hitbox.name = "noOutline";
  tilt.add(hitbox);

  addOutlines(body, 1.05);
  // Fewer draw calls: static parts that share a material collapse into one mesh (+ one merged hull).
  const keep = new Set<THREE.Object3D>(tie);
  mergeStatic(torso, keep);
  for (const arm of arms) {
    mergeStatic(arm.shoulder);
    mergeStatic(arm.hand);
  }
  return {
    root,
    tilt,
    body,
    pelvis,
    squash,
    torso,
    neck,
    arms: arms as [Arm, Arm],
    legs: legs as [Leg, Leg],
    chest,
    back,
    hitbox,
    tie,
    pockets,
    seatHipY: SEAT_HIP_Y,
    standHipY: thigh + shin + 0.075,
    legLen: thigh + shin,
  };
}

// --------------------------------------------------------------------- pose
/** Channel groups a layer may write (clips are masked so an emote never fights a raid's arms or legs). */
export const MASK_BODY = 1;
export const MASK_HEAD = 2;
export const MASK_FACE = 4;
export const MASK_ARMS = 8;
export const MASK_HAT = 16;
export const MASK_ALL = 31;

export interface PoseArm {
  /** Hand (wrist) target in torso space. */
  t: THREE.Vector3;
  /** Elbow hint direction (torso space). */
  pole: THREE.Vector3;
}

type NumKey =
  | "sit" | "bounce" | "lean" | "twist" | "roll" | "stretch" | "tiltX" | "tiltZ" | "walk" | "armSwing" | "dangle" | "tailWag"
  | "headPitch" | "headYaw" | "headRoll" | "gazeX" | "gazeY"
  | "lid" | "eyeScale" | "jaw" | "earDroop" | "flush"
  | "shrug"
  | "hatLift" | "hatTilt" | "hatSpin";

const BODY_KEYS: NumKey[] = ["sit", "bounce", "lean", "twist", "roll", "stretch", "tiltX", "tiltZ", "walk", "armSwing", "dangle", "tailWag"];
const HEAD_KEYS: NumKey[] = ["headPitch", "headYaw", "headRoll", "gazeX", "gazeY"];
const FACE_KEYS: NumKey[] = ["lid", "eyeScale", "jaw", "earDroop", "flush"];
const ARM_KEYS: NumKey[] = ["shrug"];
const HAT_KEYS: NumKey[] = ["hatLift", "hatTilt", "hatSpin"];
const ALL_KEYS: NumKey[] = [...BODY_KEYS, ...HEAD_KEYS, ...FACE_KEYS, ...ARM_KEYS, ...HAT_KEYS];
const MASK_KEYS: [number, NumKey[]][] = [
  [MASK_BODY, BODY_KEYS],
  [MASK_HEAD, HEAD_KEYS],
  [MASK_FACE, FACE_KEYS],
  [MASK_ARMS, ARM_KEYS],
  [MASK_HAT, HAT_KEYS],
];
/** Follow stiffness per channel (≈ 4 / settle seconds). Gaze is fast (saccades), the body heavy. */
const OMEGA: Record<NumKey, number> = {
  sit: 9, bounce: 22, lean: 11, twist: 9, roll: 12, stretch: 22, tiltX: 11, tiltZ: 11, walk: 8, armSwing: 8, dangle: 4, tailWag: 5,
  headPitch: 11, headYaw: 9.5, headRoll: 14, gazeX: 42, gazeY: 42,
  lid: 30, eyeScale: 22, jaw: 34, earDroop: 9, flush: 6,
  shrug: 15,
  hatLift: 18, hatTilt: 12, hatSpin: 12,
};
/** Channels a scripted sequence may tighten with Puppet.snap. */
const SNAPPABLE = new Set<NumKey>(["sit", "bounce", "lean", "twist", "roll", "stretch", "tiltX", "tiltZ", "headPitch", "headYaw", "headRoll", "hatLift"]);
const OMEGA_ARM = 18;
const OMEGA_POLE = 12;
const OMEGA_LEG = 12;

/** What the character logic asks for this frame. Reset to defaults every frame, then layered. */
export class Pose {
  sit = 1;
  bounce = 0;
  lean = 0;
  twist = 0;
  roll = 0;
  stretch = 0;
  tiltX = 0;
  tiltZ = 0;
  headPitch = 0;
  headYaw = 0;
  headRoll = 0;
  /** 0 closed .. 1 normal (cool half-lid) .. 1.6 wide open. */
  lid = 1;
  eyeScale = 1;
  gazeX = 0;
  gazeY = 0;
  brow: BrowKind = "neutral";
  mouth: MouthKind = "smirk";
  jaw = 0;
  arms: [PoseArm, PoseArm] = [
    { t: new THREE.Vector3(-0.24, 0.02, 0.08), pole: new THREE.Vector3(-0.7, -0.4, -0.6) },
    { t: new THREE.Vector3(0.24, 0.02, 0.08), pole: new THREE.Vector3(0.7, -0.4, -0.6) },
  ];
  legHip: [number, number] = [0, 0];
  legKnee: [number, number] = [0, 0];
  /** Walk cycle weight (the stride itself follows the real root motion). */
  walk = 0;
  /** How much the arms swing while walking (0 when the hands hold something / are cuffed). */
  armSwing = 1;
  dangle = 0;
  hatLift = 0;
  hatTilt = 0;
  hatSpin = 0;
  earDroop = 0;
  tailWag = 0;
  shrug = 0;
  /** Red face (anger), 0..1. */
  flush = 0;

  reset(): this {
    this.sit = 1;
    this.bounce = this.lean = this.twist = this.roll = this.stretch = this.tiltX = this.tiltZ = 0;
    this.headPitch = this.headYaw = this.headRoll = 0;
    this.lid = 1;
    this.eyeScale = 1;
    this.gazeX = this.gazeY = 0;
    this.brow = "neutral";
    this.mouth = "smirk";
    this.jaw = 0;
    this.hand(0, -0.24, 0.02, 0.08).hand(1, 0.24, 0.02, 0.08);
    this.legHip[0] = this.legHip[1] = this.legKnee[0] = this.legKnee[1] = 0;
    this.walk = this.dangle = 0;
    this.armSwing = 1;
    this.hatLift = this.hatTilt = this.hatSpin = 0;
    this.earDroop = this.tailWag = this.shrug = this.flush = 0;
    return this;
  }

  copy(src: Pose): this {
    const self: Pose = this;
    for (let i = 0; i < ALL_KEYS.length; i++) {
      const k = ALL_KEYS[i]!;
      self[k] = src[k];
    }
    this.brow = src.brow;
    this.mouth = src.mouth;
    for (let i = 0; i < 2; i++) {
      this.arms[i]!.t.copy(src.arms[i]!.t);
      this.arms[i]!.pole.copy(src.arms[i]!.pole);
      this.legHip[i] = src.legHip[i]!;
      this.legKnee[i] = src.legKnee[i]!;
    }
    return this;
  }

  /** this = lerp(this, src, w) on the masked channel groups (discrete ones switch at w ≥ 0.5). */
  blend(src: Pose, w: number, mask = MASK_ALL): this {
    if (w <= 0) return this;
    const k = Math.min(1, w);
    const self: Pose = this;
    for (let g = 0; g < MASK_KEYS.length; g++) {
      const group = MASK_KEYS[g]!;
      if (!(mask & group[0])) continue;
      const keys = group[1];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i]!;
        self[key] += (src[key] - self[key]) * k;
      }
    }
    if (mask & MASK_FACE && k >= 0.5) {
      this.brow = src.brow;
      this.mouth = src.mouth;
    }
    if (mask & MASK_ARMS) {
      for (let i = 0; i < 2; i++) {
        this.arms[i]!.t.lerp(src.arms[i]!.t, k);
        this.arms[i]!.pole.lerp(src.arms[i]!.pole, k);
      }
    }
    if (mask & MASK_BODY) {
      for (let i = 0; i < 2; i++) {
        this.legHip[i]! += (src.legHip[i]! - this.legHip[i]!) * k;
        this.legKnee[i]! += (src.legKnee[i]! - this.legKnee[i]!) * k;
      }
    }
    return this;
  }

  /** Hand target in torso space (side 0 = −x hand = the character's right, 1 = +x hand). */
  hand(i: number, x: number, y: number, z: number, px = 0, py = -0.4, pz = -0.6): this {
    const a = this.arms[i]!;
    a.t.set(x, y, z);
    a.pole.set(px === 0 ? (i === 0 ? -0.7 : 0.7) : px, py, pz);
    return this;
  }

  /** Hand target from a torso-space vector. */
  handV(i: number, v: THREE.Vector3, px = 0, py = -0.4, pz = -0.6): this {
    return this.hand(i, v.x, v.y, v.z, px, py, pz);
  }

  /** Blend hand i toward a torso-space target by w (layering helper). */
  blendHand(i: number, x: number, y: number, z: number, w: number, px = 0, py = -0.4, pz = -0.6): this {
    if (w <= 0) return this;
    if (w >= 1) return this.hand(i, x, y, z, px, py, pz);
    const a = this.arms[i]!;
    a.t.x += (x - a.t.x) * w;
    a.t.y += (y - a.t.y) * w;
    a.t.z += (z - a.t.z) * w;
    a.pole.x += ((px === 0 ? (i === 0 ? -0.7 : 0.7) : px) - a.pole.x) * w;
    a.pole.y += (py - a.pole.y) * w;
    a.pole.z += (pz - a.pole.z) * w;
    return this;
  }
}

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

/** Smooths a Pose and drives a BodyRig + Face + optional hat. */
export class Puppet {
  readonly target = new Pose();
  private cur = new Pose();
  private vel = new Float32Array(ALL_KEYS.length);
  private legVel = new Float32Array(4);
  private armCur = [new THREE.Vector3(), new THREE.Vector3()];
  private armVel = [new THREE.Vector3(), new THREE.Vector3()];
  private poleCur = [new THREE.Vector3(-0.7, -0.4, -0.6), new THREE.Vector3(0.7, -0.4, -0.6)];
  private poleVel = [new THREE.Vector3(), new THREE.Vector3()];
  private armInit = false;
  /** Squash (+ stretch / − squash) and roll wobble springs: kick them on impacts. */
  readonly sq = new Spring(230, 9, -0.7, 0.7);
  readonly wob = new Spring(120, 6, -1.2, 1.2);
  private phase = 0;
  private lastX = NaN;
  private lastZ = NaN;
  /** Ground speed (m/s) measured from the root motion. */
  speed = 0;
  private fwdSpeed = 0;
  private blinkIn = 1 + Math.random() * 3;
  private blinkT = -1;
  private browCur: { y: number; r: number }[] = [];
  private mouthScales = new Map<THREE.Object3D, THREE.Vector3>();
  private mouthKind: MouthKind = "smirk";
  private mouthPop = new Pop(900, 38);
  private skin: Skin = "normal";
  private flushCur = 0;
  /** Rate multiplier for the body channels (scripted sequences want snappier tracking). */
  snap = 1;

  constructor(
    readonly rig: BodyRig,
    readonly face: Face,
    readonly hat: THREE.Group | null,
  ) {
    rig.neck.add(face.head);
    if (hat) face.hatMount.add(hat);
    this.browCur = face.brows.map(() => ({ y: 0, r: 0 }));
    for (const mouth of Object.values(face.mouths)) {
      if (mouth) this.mouthScales.set(mouth, mouth.scale.clone());
    }
    this.mouthPop.snap(1);
    this.rememberMaterials(rig.root);
  }

  /** Squash spring kick (+ = stretch up, − = squash) and roll wobble. */
  kick(squash: number, wobble = 0): void {
    this.sq.kick(squash);
    if (wobble) this.wob.kick(wobble);
  }

  /** Blink now (looks alive on big gaze shifts and surprises). */
  blink(): void {
    if (this.blinkT < 0) this.blinkT = 0;
  }

  /** Forget the last root position (after a teleport the stride must not jump). */
  resetMotion(): void {
    this.lastX = NaN;
    this.speed = 0;
    this.fwdSpeed = 0;
  }

  /** Jump straight to the target pose (new actor, teleport) instead of easing from the old one. */
  settle(): void {
    this.cur.copy(this.target);
    this.vel.fill(0);
    this.legVel.fill(0);
    this.armInit = false;
    this.resetMotion();
  }

  /** Remember original materials so skins can be swapped and restored (call after attaching new meshes). */
  rememberMaterials(root: THREE.Object3D): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.userData.mat0 || m === this.rig.hitbox) return;
      m.userData.mat0 = m.material;
    });
    if (this.skin !== "normal") this.applySkin(root, this.skin);
  }

  /** Swap a mesh's material (keeps skins working). */
  setMaterial(m: THREE.Mesh, material: THREE.Material): void {
    m.userData.mat0 = material;
    m.material = this.skin === "normal" ? material : this.skinned(m, material, this.skin);
    for (const c of m.children) {
      const sh = c as THREE.Mesh;
      if (sh.isMesh && sh.name === "outline" && this.skin === "ghost") sh.material = ghostLineMat;
    }
  }

  setSkin(skin: Skin): void {
    if (skin === this.skin) return;
    this.skin = skin;
    this.applySkin(this.rig.root, skin);
  }

  get currentSkin(): Skin {
    return this.skin;
  }

  private applySkin(root: THREE.Object3D, skin: Skin): void {
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m === this.rig.hitbox) return;
      if (m.name === "outline") {
        if (!m.userData.mat0) m.userData.mat0 = m.material;
        m.material = skin === "ghost" ? ghostLineMat : (m.userData.mat0 as THREE.Material);
        return;
      }
      const m0 = m.userData.mat0 as THREE.Material | undefined;
      if (!m0) return;
      m.material = skin === "normal" ? m0 : this.skinned(m, m0, skin);
    });
  }

  private skinned(m: THREE.Mesh, m0: THREE.Material, skin: Skin): THREE.Material {
    if (m.userData.keepSkin) return m0;
    if (skin === "grey") return greyOf(m0);
    if (m0 === inkMat || (m0 as THREE.MeshBasicMaterial).isMeshBasicMaterial) return m0;
    const c = (m0 as THREE.MeshToonMaterial).color;
    const lum = c ? c.r * 0.3 + c.g * 0.59 + c.b * 0.11 : 1;
    const dark = (m0 as THREE.MeshToonMaterial).map ? 0.3 : lum;
    return dark < 0.35 ? ghostDarkMat : ghostMat;
  }

  /** Bring the torso's world matrix up to date (call once before a batch of toTorso conversions). */
  refreshTorso(): void {
    this.rig.torso.updateWorldMatrix(true, false);
  }

  /** World point → torso space (hands that must land on a world spot: rail, mouth, a prop, a wrist). */
  toTorso(world: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    return this.rig.torso.worldToLocal(out.copy(world));
  }

  update(dt: number, time: number): void {
    const t = this.target;
    const c = this.cur;
    const rig = this.rig;
    const s = this.snap;

    this.sq.step(dt);
    this.wob.step(dt);

    for (let i = 0; i < ALL_KEYS.length; i++) {
      const k = ALL_KEYS[i]!;
      if (k === "hatSpin") continue;
      c[k] = follow(c[k], t[k], this.vel, i, OMEGA[k] * (SNAPPABLE.has(k) ? s : 1), dt);
    }
    // The hat spin is an angle (writers keep it wrapped): it follows its target fast along the shorter arc, so
    // a spin always turns forward and whole turns never unwind (a lagging spring would take the long way).
    c.hatSpin = wrapAngle(c.hatSpin + wrapAngle(t.hatSpin - c.hatSpin) * (1 - Math.exp(-30 * dt)));
    for (let i = 0; i < 2; i++) {
      c.legHip[i] = follow(c.legHip[i]!, t.legHip[i]!, this.legVel, i, OMEGA_LEG * s, dt);
      c.legKnee[i] = follow(c.legKnee[i]!, t.legKnee[i]!, this.legVel, i + 2, OMEGA_LEG * s, dt);
    }
    this.flushCur = c.flush;
    c.mouth = t.mouth;
    c.brow = t.brow;

    // ---- stride from the real ground motion: the feet travel exactly as far as the root (no sliding)
    const rp = rig.root.position;
    let dist = 0;
    let fwd = 0;
    if (!Number.isNaN(this.lastX)) {
      const dx = rp.x - this.lastX;
      const dz = rp.z - this.lastZ;
      dist = Math.hypot(dx, dz);
      const yaw = rig.root.rotation.y;
      fwd = dx * Math.sin(yaw) + dz * Math.cos(yaw);
      if (dist > 0.75) dist = fwd = 0;
    }
    this.lastX = rp.x;
    this.lastZ = rp.z;
    if (dt > 0) {
      const k = damp(12, dt);
      this.speed += (dist / dt - this.speed) * k;
      this.fwdSpeed += (fwd / dt - this.fwdSpeed) * k;
    }
    const moving = clamp(this.speed / 0.3, 0, 1);
    const w = c.walk * moving;
    const amp = 0.6 * clamp(this.speed / 2.2, 0.35, 1.25);
    const stride = Math.max(0.1, 2 * rig.legLen * Math.sin(amp));
    this.phase = (this.phase + (dist / stride) * Math.PI) % (TAU * 512);

    // ---- body + legs
    let hipDrop = 0;
    for (let i = 0; i < 2; i++) {
      const leg = rig.legs[i]!;
      const ph = this.phase + (i === 0 ? 0 : Math.PI);
      const swing = Math.sin(ph) * amp * w;
      const kneeBend = Math.max(0, Math.sin(ph - 0.9)) * 1.5 * amp * w;
      const dangle = Math.sin(time * 2.3 + i * 1.9) * 0.22 * c.dangle;
      leg.hip.rotation.x = -Math.PI / 2 * c.sit + swing + c.legHip[i]!;
      leg.knee.rotation.x = Math.PI / 2 * c.sit + kneeBend + dangle + c.legKnee[i]!;
      leg.hip.rotation.z = -leg.side * 0.06 * c.sit;
      // Spread legs are shorter vertically: drop the hips so the planted foot stays on the floor.
      hipDrop = Math.max(hipDrop, rig.legLen * (1 - Math.cos(swing)) * (1 - c.sit));
    }
    rig.body.position.y = rig.standHipY + (rig.seatHipY - rig.standHipY) * c.sit + c.bounce - hipDrop;
    rig.tilt.rotation.set(c.tiltX, 0, c.tiltZ);

    // ---- upper body: squash & stretch you can actually see, roll wobble, lean into the walk
    const sy = clamp(1 + c.stretch + this.sq.x * 0.4, 0.72, 1.32);
    const sxz = 1 / Math.sqrt(sy);
    rig.squash.scale.set(sxz, sy, sxz);
    const walkLean = clamp(this.fwdSpeed * 0.04, -0.12, 0.18) * w;
    rig.torso.rotation.set(c.lean + walkLean, c.twist, c.roll + this.wob.x * 0.6, "YXZ");
    rig.neck.rotation.set(c.headPitch - walkLean * 0.5, c.headYaw, c.headRoll - this.wob.x * 0.25, "YXZ");

    // ---- hat
    if (this.hat) {
      this.hat.position.y = c.hatLift;
      this.hat.rotation.set(-0.08 + c.hatLift * 0.6 - this.sq.x * 0.08, c.hatSpin, c.hatTilt);
    }

    // ---- arms (IK in torso space, critically damped targets, reach-limited so elbows always bend)
    for (let i = 0; i < 2; i++) {
      const arm = rig.arms[i]!;
      const pa = t.arms[i]!;
      _v.copy(pa.t);
      if (w > 0.01) {
        // Counter-swing: the arm goes forward when the same-side foot is back.
        const legPh = this.phase + (i === 0 ? 0 : Math.PI);
        _v.z += Math.sin(legPh) * 0.11 * w * c.armSwing;
        _v.y += Math.abs(Math.sin(legPh)) * 0.025 * w * c.armSwing;
      }
      arm.shoulder.position.set(arm.base.x, arm.base.y + c.shrug * 0.06, arm.base.z);
      const reach = arm.upper + arm.fore;
      limitReach(arm.shoulder.position, _v, reach);
      if (!this.armInit) {
        this.armCur[i]!.copy(_v);
        this.poleCur[i]!.copy(pa.pole);
        this.armVel[i]!.set(0, 0, 0);
        this.poleVel[i]!.set(0, 0, 0);
      } else {
        followV(this.armCur[i]!, _v, this.armVel[i]!, OMEGA_ARM * Math.max(1, s), dt);
        followV(this.poleCur[i]!, pa.pole, this.poleVel[i]!, OMEGA_POLE, dt);
      }
      _w.copy(this.armCur[i]!);
      limitReach(arm.shoulder.position, _w, reach);
      const bend = solveArm(arm.shoulder.position, _w, this.poleCur[i]!, arm.upper, arm.fore, _q);
      arm.shoulder.quaternion.copy(_q);
      arm.elbow.rotation.set(bend, 0, 0);
    }
    this.armInit = true;

    // ---- face
    this.blinkIn -= dt;
    if (this.blinkIn <= 0 && this.blinkT < 0) this.blinkT = 0;
    let blink = 1;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      blink = 1 - Math.sin(Math.PI * clamp(this.blinkT / 0.16, 0, 1));
      if (this.blinkT >= 0.16) {
        this.blinkT = -1;
        blink = 1;
        this.blinkIn = Math.random() < 0.16 ? 0.14 : 1.8 + Math.random() * 3.6;
      }
    }
    const f = this.face;
    const open = Math.min(c.lid, 0.12 + blink * 1.6);
    // Lid angle: +1.55 = closed, 0 = half (cool gangster), −1.2 = wide open.
    const lidAngle = open <= 1 ? 1.55 - open * 1.55 : -(open - 1) * 2.0;
    const es = c.eyeScale * (1 + this.sq.x * 0.05);
    const gx = clamp(c.gazeX, -1, 1) * 0.38;
    const gy = clamp(c.gazeY, -1, 1) * 0.3;
    const gz = Math.sqrt(Math.max(0.05, 1 - gx * gx - gy * gy)) * 0.88;
    for (const e of f.eyes) {
      e.lid.rotation.x = clamp(lidAngle, -1.3, 1.6);
      e.root.scale.setScalar(es);
      e.pupil.position.set(gx, gy, gz);
    }
    const kb = damp(14, dt);
    for (let i = 0; i < f.brows.length; i++) {
      const b = f.brows[i]!;
      let y = 0;
      let r = 0;
      const sd = b.side;
      switch (t.brow) {
        case "up":
          y = 0.028;
          break;
        case "sad":
          y = 0.012;
          r = -sd * 0.45;
          break;
        case "angry":
          y = -0.012;
          r = sd * 0.5;
          break;
        case "skeptic":
          y = sd > 0 ? 0.03 : -0.008;
          r = sd > 0 ? -0.15 : 0.2;
          break;
        default:
          y = (c.lid - 1) * 0.02;
      }
      const cb = this.browCur[i]!;
      cb.y += (y - cb.y) * kb;
      cb.r += (r - cb.r) * kb;
      b.obj.position.set(b.home.x, b.home.y + cb.y + this.sq.x * 0.01, b.home.z);
      b.obj.rotation.z = cb.r;
    }
    if (t.mouth !== this.mouthKind) {
      // A new mouth pops in from small instead of swapping in one frame.
      this.mouthKind = t.mouth;
      this.mouthPop.x = 0.55;
      this.mouthPop.v = 0;
      this.mouthPop.target = 1;
      for (const key in f.mouths) f.mouths[key as MouthKind]!.visible = key === t.mouth;
    }
    this.mouthPop.step(dt);
    const mo = f.mouths[t.mouth];
    if (mo) {
      mo.scale.copy(this.mouthScales.get(mo)!).multiplyScalar(this.mouthPop.x);
      if (t.mouth === "o") mo.scale.y *= 1 + c.jaw * 0.8;
      else if (t.mouth === "grin") mo.scale.y *= 1 + c.jaw * 0.6;
    }
    if (f.jaw) f.jaw.rotation.x = c.jaw * f.jawOpen;
    const droop = c.earDroop;
    const earKick = this.sq.x * 0.6;
    for (const ear of f.ears) {
      const d = droop >= 0 ? ear.droop : ear.perk;
      const a = Math.abs(droop);
      // Ears trail the head (follow-through on squash) and sway a little.
      ear.pivot.rotation.set(
        ear.base.x + d.x * a - earKick * 0.4,
        ear.base.y + d.y * a,
        ear.base.z + d.z * a + Math.sin(time * 1.3 + ear.base.z * 7) * 0.025 + earKick * Math.sign(ear.base.z || 1) * 0.2,
      );
    }
    if (this.flushCur > 0.01 || f.skullMat.emissiveIntensity > 0) {
      f.skullMat.emissive.setRGB(0.85, 0.05, 0.05);
      f.skullMat.emissiveIntensity = this.flushCur * (0.55 + Math.sin(time * 14) * 0.15);
      if (this.flushCur <= 0.01) f.skullMat.emissiveIntensity = 0;
    }
    f.extra?.(time, dt, c);
  }

  /** Current smoothed pose (read-only use). */
  get pose(): Pose {
    return this.cur;
  }
}
