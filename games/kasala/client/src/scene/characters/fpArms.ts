// First-person arms for the local player (Liar's Bar style): dark pinstripe sleeves that come in from the
// bottom corners, a thin white shirt cuff with a cufflink in the player color, and small toon paws (fur color,
// thumb, knuckle bumps, fingers that curl into a fist) resting on the felt at the lower left / lower right.
// The rest spot is solved from the camera's field of view, so the paws sit in the bottom ~20% of the screen at
// any window shape and never cover the view center. They follow the seat's REST view (not the mouse-look), so
// the hands stay put on the table while you look around, and they step aside from my own chip stack.
// Gestures are keyframed clips (wrist target, elbow pole, paw rotation, finger curl) cross-faded over the rest
// pose and followed by critically damped springs + two-bone IK, all kept low and to the sides: knock (a small
// rap on the felt to the right), slam + rake (KASALA), push (bet), cheer, flinch, finger drum, the six emotes
// with their props, and the at-the-seat raid poses (cuffed hands, the empty wallet, the mugshot plate), which
// lock the arms until they end (an emote never cuts them). Owner: client-characters.

import * as THREE from "three";
import { PALETTE, SIREN_MID_CHANCE, type EmoteId } from "../../../../shared/constants";
import { addOutlines, noShadow } from "../toon";
import { FP_REST_PITCH } from "../room/layout";
import { ghostDarkMat, ghostLineMat, ghostMat, G, mat, mergeParts, suitMat, trs } from "./kit";
import type { Skin } from "./body";
import { PropSet, type PropHandle } from "./cast";
import type { Particles } from "./particles";
import { buildBillWad, buildCigar, buildCuff, buildHanky, buildLighter, buildStrand, buildWallet, stretchStrand, type Wallet } from "./props";
import { backOut, bump, clamp, easeIn, easeInOut, easeOut, envelope, follow, followV, limitReach, seg, smooth, solveArm } from "./util";

export type FpGesture =
  | "knock" | "slam" | "push" | "cheer" | "flinch" | "drum" | "cuffed" | "wallet" | "plate"
  | EmoteId;

export interface FpPlayOpts {
  /** Aim point for smoke / kisses (a rival's head). */
  target?: THREE.Vector3 | null;
  /** Length override (s). */
  sec?: number;
  /** Start this much later (s): e.g. the KASALA cheer waits for the slam + rake. */
  delay?: number;
  /** Cheer: banknotes thrown up from the felt in front of me. */
  bills?: number;
}

const UPPER = 0.36;
const FORE = 0.37;
const REACH = UPPER + FORE;
/** The suit sleeve stops this far up the forearm; the shirt cuff shows below it. */
const SLEEVE_GAP = 0.014;
/** Ink outline thickness (m) of the paws and sleeves (≈2–3 px at the rest distance). */
const INK = 0.0022;
/** Paw size factor over the unit paw below (≈9 cm wide, a cartoon paw a bit wider than the sleeve). */
const PAW = 1.3;
/** Where the wrists rest on screen (NDC at the seat's rest pitch): the lower left / lower right corners. */
const REST_NX = 0.6;
const REST_NY = -0.84;
/** Wrist height above the felt at rest: the paw lies flat, the fingertips on the cloth. */
const WRIST_UP = 0.05;
/** The paw centers keep this far (m, horizontal) from the axis of my own chip pile. */
const AVOID_R = 0.17;
/** The wrists stay inside this table radius: on the felt, never on the padded rail (inner edge 1.40). */
const FELT_R = 1.31;

const DUR: Record<FpGesture, number> = {
  knock: 0.55, slam: 0.95, push: 0.75, cheer: 1.3, flinch: 0.7, drum: 1.2, cuffed: 3, wallet: 2.4, plate: 3,
  puro: 2.1, paraSay: 2.3, yumruk: 1.3, opucuk: 1.5, agla: 2.4, allahAllah: 1.8,
};
const FADE_IN: Partial<Record<FpGesture, number>> = { knock: 0.06, slam: 0.06, yumruk: 0.08, flinch: 0.04 };
/** Raid poses own the arms until they end: other gestures and emotes are ignored meanwhile. */
const LOCKS: ReadonlySet<FpGesture> = new Set<FpGesture>(["cuffed", "wallet", "plate"]);

interface FpArm {
  /** −1: right hand (camera right = local −x), +1: left hand. */
  side: number;
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Group;
  paw: THREE.Group;
  grip: THREE.Group;
  link: THREE.Mesh;
  pawMesh: THREE.Mesh;
  pawInk: THREE.Mesh;
  cur: THREE.Vector3;
  vel: THREE.Vector3;
  pole: THREE.Vector3;
  poleVel: THREE.Vector3;
  /** Paw pitch (+ = fingers down) / yaw / roll in root space, and its velocity. */
  rot: THREE.Vector3;
  rotVel: THREE.Vector3;
  curl: number;
  curlVel: Float32Array;
}

interface FpRun {
  g: FpGesture;
  t: number;
  dur: number;
  fadeOut: number;
  fired: number;
  acc: number;
  bills: number;
  target: THREE.Vector3 | null;
}

interface Pending {
  g: FpGesture;
  at: number;
  opts: FpPlayOpts;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _X = new THREE.Vector3(1, 0, 0);
/** Per-frame targets (blended rest + clips) and one clip's scratch copy: wrist, elbow pole, paw rot, curl. */
const _t = [new THREE.Vector3(), new THREE.Vector3()];
const _p = [new THREE.Vector3(), new THREE.Vector3()];
const _r = [new THREE.Vector3(), new THREE.Vector3()];
const _k = new Float32Array(2);
const _ct = [new THREE.Vector3(), new THREE.Vector3()];
const _cp = [new THREE.Vector3(), new THREE.Vector3()];
const _cr = [new THREE.Vector3(), new THREE.Vector3()];
const _ck = new Float32Array(2);
const POLE_REST = [new THREE.Vector3(-1, -0.3, 0.1), new THREE.Vector3(1, -0.3, 0.1)];
/** Paw at rest: fingers forward and a little inward, tipped onto the felt, thumb side up. */
const ROT_REST = [new THREE.Vector3(0.22, 0.3, 0.15), new THREE.Vector3(0.22, -0.3, -0.15)];
const CURL_REST = 0.3;
/** Paw rotations (pitch, yaw, roll) of the poses that hold props (the props are oriented for them). */
const PURO_R = [-0.5, 0.35, 0.1];
const PURO_L = [-1.2, -0.3, 0];
const PARA_L = [-0.35, -0.4, -0.2];
const AGLA_L = [-1.1, -0.3, 0];
const WALLET_L = [-0.9, -0.3, 0];

// ------------------------------------------------------------------ geometry
/** [x, y, z, rx, ry, rz, sx, sy, sz] of a unit part. */
type Xf = readonly number[];
interface Part {
  g: THREE.BufferGeometry;
  open: Xf;
  fist?: Xf;
}

function partMatrix(v: Xf, k: number, grow: number): THREE.Matrix4 {
  return trs(v[0]! * k, v[1]! * k, v[2]! * k, v[3]!, v[4]!, v[5]!, v[6]! * k + grow, v[7]! * k + grow, v[8]! * k + grow);
}

/**
 * Merge the paw parts (scaled by `k`) into one mesh with a "fist" morph target; `grow` builds the ink hull
 * (every part grown by the same width, so the outline is even).
 */
function morphGeometry(parts: Part[], k: number, grow: number): THREE.BufferGeometry {
  const open = mergeParts(parts.map((p) => ({ g: p.g, m: partMatrix(p.open, k, grow) })));
  const fist = mergeParts(parts.map((p) => ({ g: p.g, m: partMatrix(p.fist ?? p.open, k, grow) })));
  open.morphAttributes.position = [fist.getAttribute("position") as THREE.BufferAttribute];
  open.morphAttributes.normal = [fist.getAttribute("normal") as THREE.BufferAttribute];
  open.computeBoundingSphere();
  return open;
}

/**
 * A unit paw in its own space: origin at the wrist, +z = fingers, +y = back of the hand. `inner` is the thumb
 * side (+1 / −1). Open: fingers forward, slightly splayed. Fist: fingers curled under with the knuckles in
 * front, the thumb across them.
 */
function pawParts(inner: number): Part[] {
  const big = new THREE.SphereGeometry(1, 14, 10);
  const lo = G().sphereLo;
  const parts: Part[] = [
    { g: big, open: [0, 0.001, 0.004, 0, 0, 0, 0.025, 0.02, 0.025] },
    { g: big, open: [0, -0.002, 0.042, 0, 0, 0, 0.034, 0.018, 0.04], fist: [0, 0, 0.04, 0, 0, 0, 0.034, 0.021, 0.034] },
  ];
  const xs = [-0.0235, -0.0078, 0.0078, 0.0235];
  for (const x of xs) {
    // The pinky (outer side) is the shortest, the middle fingers the longest.
    const outer = x * inner < 0;
    const len = Math.abs(x) > 0.02 ? (outer ? 0.0155 : 0.017) : 0.019;
    parts.push({
      g: lo,
      open: [x * 1.05, -0.003, 0.074 + len * 0.75, 0, x * 1.2, 0, 0.0105, 0.0098, len],
      fist: [x * 0.95, -0.012, 0.072, 1.6, 0, 0, 0.0108, 0.0105, len * 0.8],
    });
    // Knuckle bumps on the back of the paw.
    parts.push({ g: lo, open: [x, 0.008, 0.066, 0, 0, 0, 0.0095, 0.008, 0.009] });
  }
  parts.push({
    g: lo,
    open: [inner * 0.034, -0.005, 0.04, 0, inner * 0.55, -inner * 0.3, 0.0115, 0.011, 0.021],
    fist: [inner * 0.016, -0.014, 0.074, 0, -inner * 1.1, 0, 0.011, 0.0105, 0.019],
  });
  return parts;
}

/** A tapered sleeve from its joint (y = 0) down to −len, with a ball at the joint so the bend stays closed. */
function sleeveGeometry(rTop: number, rBot: number, len: number, grow: number): THREE.BufferGeometry {
  const cyl = new THREE.CylinderGeometry(rTop + grow, rBot + grow, len + grow * 2, 14, 1, false);
  const ball = new THREE.SphereGeometry(1, 14, 8);
  const g = mergeParts([
    { g: cyl, m: new THREE.Matrix4().makeTranslation(0, -len / 2, 0) },
    { g: ball, m: trs(0, 0, 0, 0, 0, 0, rTop + grow) },
  ]);
  cyl.dispose();
  ball.dispose();
  return g;
}

const inkMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.BackSide });

/** An inverted-hull ink outline from its own (grown) geometry: off the shadow passes, no raycasts. */
function inkHull(g: THREE.BufferGeometry): THREE.Mesh {
  const m = new THREE.Mesh(g, inkMat);
  m.name = "outline";
  noShadow(m);
  m.raycast = () => {};
  return m;
}

/** obj.quaternion so that, held in a paw posed at `paw` (pitch, yaw, roll), it ends up at `want` (root space). */
function holdAs(obj: THREE.Object3D, paw: readonly number[], want: readonly number[]): void {
  _q.setFromEuler(_e.set(paw[0]!, paw[1]!, paw[2]!, "YXZ")).invert();
  _q2.setFromEuler(_e.set(want[0]!, want[1]!, want[2]!, "YXZ"));
  obj.quaternion.copy(_q).multiply(_q2);
}

export class FpArms {
  readonly root = new THREE.Group();
  private arms: [FpArm, FpArm];
  private sleeves: THREE.Mesh[] = [];
  private sleeveInks: THREE.Mesh[] = [];
  private pawInks: THREE.Mesh[] = [];
  private links: THREE.Mesh[] = [];
  private sleeveMat: THREE.Material;
  private handMat: THREE.Material = mat("#F2A65A");
  private runs: FpRun[] = [];
  private pending: Pending[] = [];
  private clock = 0;
  private props = new PropSet();
  private cigar: ReturnType<typeof buildCigar>;
  private lighter: ReturnType<typeof buildLighter>;
  private wad: ReturnType<typeof buildBillWad>;
  private wallet: Wallet;
  /** The short chain between the handcuffs. */
  private chain: THREE.Mesh;
  private h: Record<"cigar" | "lighter" | "wad" | "hanky" | "wallet" | "cuffL" | "cuffR" | "plate", PropHandle>;
  /** Wrist rest points this frame (root space). */
  private rest = [new THREE.Vector3(), new THREE.Vector3()];
  /** My chip pile as a capsule axis (world): the paws rest beside it, never in it. */
  private avoid = false;
  private avoidA = new THREE.Vector3();
  private avoidB = new THREE.Vector3();
  private lean = new THREE.Vector3();
  private leanVel = new THREE.Vector3();
  private nervous = 0;
  private drumIn = 2;
  private skin: Skin = "normal";
  private init = false;

  constructor(
    private particles: Particles,
    plate: THREE.Mesh,
  ) {
    this.sleeveMat = suitMat("#292833", "#605763");
    const shirt = mat("#F7F2E8");
    const upperGeo = sleeveGeometry(0.044, 0.04, UPPER, 0);
    const upperInk = sleeveGeometry(0.044, 0.04, UPPER, INK);
    const foreGeo = sleeveGeometry(0.04, 0.034, FORE - SLEEVE_GAP, 0);
    const foreInk = sleeveGeometry(0.04, 0.034, FORE - SLEEVE_GAP, INK);
    const cuffGeo = new THREE.CylinderGeometry(0.031, 0.031, 0.02, 16);
    const arms: FpArm[] = [];
    for (const s of [-1, 1]) {
      const inner = -s;
      const shoulder = new THREE.Group();
      const upper = new THREE.Mesh(upperGeo, this.sleeveMat);
      const upperHull = inkHull(upperInk);
      upper.add(upperHull);
      shoulder.add(upper);
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER;
      shoulder.add(elbow);
      const fore = new THREE.Mesh(foreGeo, this.sleeveMat);
      const foreHull = inkHull(foreInk);
      fore.add(foreHull);
      elbow.add(fore);
      const hand = new THREE.Group();
      hand.position.y = -FORE;
      elbow.add(hand);
      // Thin shirt cuff peeking out of the sleeve, with a cufflink on top (placed per frame).
      const cuff = new THREE.Mesh(cuffGeo, shirt);
      cuff.position.y = 0.004;
      hand.add(cuff);
      const link = new THREE.Mesh(G().sphereLo, mat("#FF5A5F"));
      link.scale.setScalar(0.0062);
      hand.add(link);
      // The paw: oriented on its own (absolute in root space), curls through a morph target.
      const paw = new THREE.Group();
      hand.add(paw);
      const parts = pawParts(inner);
      const pawMesh = new THREE.Mesh(morphGeometry(parts, PAW, 0), this.handMat);
      const pawInk = inkHull(morphGeometry(parts, PAW, INK));
      pawMesh.add(pawInk);
      paw.add(pawMesh);
      const grip = new THREE.Group();
      grip.position.set(0, -0.016 * PAW, 0.06 * PAW);
      paw.add(grip);
      for (const m of [upper, fore, pawMesh]) {
        m.castShadow = true;
        m.receiveShadow = false;
      }
      cuff.castShadow = link.castShadow = false;
      this.root.add(shoulder);
      this.sleeves.push(upper, fore);
      this.sleeveInks.push(upperHull, foreHull);
      this.pawInks.push(pawInk);
      this.links.push(link);
      const i = s < 0 ? 0 : 1;
      arms.push({
        side: s, shoulder, elbow, hand, paw, grip, link, pawMesh, pawInk,
        cur: new THREE.Vector3(), vel: new THREE.Vector3(), pole: POLE_REST[i]!.clone(), poleVel: new THREE.Vector3(),
        rot: ROT_REST[i]!.clone(), rotVel: new THREE.Vector3(), curl: CURL_REST, curlVel: new Float32Array(1),
      });
    }
    this.arms = arms as [FpArm, FpArm];
    const [R, L] = this.arms;

    // Props (copies of the third-person ones, already outlined), oriented for the pose that holds them.
    this.cigar = buildCigar();
    this.cigar.group.scale.setScalar(0.75);
    this.cigar.group.position.set(0.012, 0.002, 0.03);
    holdAs(this.cigar.group, PURO_R, [0.05, 0.55, 0]);
    R.grip.add(this.cigar.group);
    this.lighter = buildLighter();
    this.lighter.group.scale.setScalar(0.85);
    this.lighter.group.position.set(0, -0.006, 0.02);
    holdAs(this.lighter.group, PURO_L, [0, 0, 0]);
    L.grip.add(this.lighter.group);
    this.wad = buildBillWad();
    this.wad.group.scale.setScalar(0.85);
    this.wad.group.position.set(0, -0.012, 0.0);
    holdAs(this.wad.group, PARA_L, [0.15, -0.5, 0]);
    L.grip.add(this.wad.group);
    const hanky = buildHanky();
    hanky.scale.setScalar(0.5);
    hanky.position.set(0, 0.005, 0.02);
    holdAs(hanky, AGLA_L, [-0.2, 0, 0]);
    L.grip.add(hanky);
    this.wallet = buildWallet();
    this.wallet.group.scale.setScalar(0.85);
    this.wallet.group.position.set(0, -0.005, 0.03);
    holdAs(this.wallet.group, WALLET_L, [-0.57, Math.PI, 0]);
    L.grip.add(this.wallet.group);
    const cuffs = [buildCuff(), buildCuff()];
    cuffs.forEach((c, i) => {
      c.scale.setScalar(0.04);
      c.position.y = -0.008;
      addOutlines(c, 1.08);
      this.arms[i]!.hand.add(c);
    });
    this.chain = buildStrand("#AEB4C2", 0.0055);
    this.chain.visible = false;
    this.root.add(this.chain);
    // The mugshot plate (shares the 3D plate's canvas, so the number matches), turned so I can read it.
    const myPlate = new THREE.Mesh(plate.geometry, plate.material);
    myPlate.scale.copy(plate.scale).multiplyScalar(0.95);
    myPlate.position.set(0, -0.275, 0.48);
    myPlate.rotation.set(0.54, Math.PI, 0);
    this.root.add(myPlate);
    const pr = this.props;
    this.h = {
      cigar: pr.add(this.cigar.group), lighter: pr.add(this.lighter.group), wad: pr.add(this.wad.group),
      hanky: pr.add(hanky), wallet: pr.add(this.wallet.group), cuffL: pr.add(cuffs[0]!), cuffR: pr.add(cuffs[1]!),
      plate: pr.add(myPlate),
    };
    this.root.visible = false;
    this.root.name = "fpArms";
  }

  /** Paw color (animal fur) and cufflink color (player color). */
  setLook(fur: string, band: string): void {
    this.handMat = mat(fur);
    const link = mat(band);
    for (const l of this.links) l.material = link;
    this.applySkin();
  }

  setSkin(skin: Skin): void {
    if (skin === this.skin) return;
    this.skin = skin;
    this.applySkin();
  }

  private applySkin(): void {
    const ghost = this.skin === "ghost";
    for (const m of this.sleeves) m.material = ghost ? ghostDarkMat : this.sleeveMat;
    for (const a of this.arms) a.pawMesh.material = ghost ? ghostMat : this.handMat;
    for (const m of this.sleeveInks) m.material = ghost ? ghostLineMat : inkMat;
    for (const m of this.pawInks) m.material = ghost ? ghostLineMat : inkMat;
  }

  /** My turn's raid chance (0..1): from the mid siren on, the fingers start drumming. */
  setNervous(level: number): void {
    this.nervous = level;
  }

  /** Keep the paws off a capsule around the world segment a–b (my chip pile), null = nothing to avoid. */
  setAvoid(a: THREE.Vector3 | null, b?: THREE.Vector3): void {
    this.avoid = !!a;
    if (!a) return;
    this.avoidA.copy(a);
    this.avoidB.copy(b ?? a);
  }

  /** A raid pose (cuffs, wallet, plate) is holding the arms. */
  get locked(): boolean {
    for (const r of this.runs) if (LOCKS.has(r.g) && r.t < r.dur - r.fadeOut) return true;
    for (const p of this.pending) if (LOCKS.has(p.g)) return true;
    return false;
  }

  /**
   * Start a gesture (the running ones cross-fade out). While a raid pose holds the arms, anything else is
   * ignored; a raid pose always starts.
   */
  play(g: FpGesture, opts: FpPlayOpts = {}): void {
    const lock = LOCKS.has(g);
    if (!lock && this.locked) return;
    if (opts.delay && opts.delay > 0) {
      if (lock) this.pending.length = 0;
      this.pending.push({ g, at: this.clock + opts.delay, opts: { ...opts, delay: 0 } });
      if (this.pending.length > 3) this.pending.shift();
      return;
    }
    if (lock) this.pending.length = 0;
    for (const r of this.runs) {
      const end = r.t + 0.16;
      if (end < r.dur) {
        r.dur = end;
        r.fadeOut = Math.min(r.fadeOut, 0.16);
      }
    }
    const dur = Math.max(0.3, opts.sec ?? DUR[g]);
    const target = opts.target ? new THREE.Vector3().copy(opts.target) : null;
    this.runs.push({ g, t: 0, dur, fadeOut: Math.min(0.3, dur * 0.3), fired: 0, acc: 0, bills: opts.bills ?? 0, target });
    if (this.runs.length > 3) this.runs.shift();
  }

  /** Stop everything (left the seat, view change). */
  clear(): void {
    this.runs.length = 0;
    this.pending.length = 0;
    this.props.clear();
  }

  /** World position of paw i's palm (0 = right). */
  handWorld(i: number, out: THREE.Vector3): THREE.Vector3 {
    return this.arms[i === 0 ? 0 : 1].paw.localToWorld(out.set(0, -0.005 * PAW, 0.045 * PAW));
  }

  /**
   * Per frame. `eye` is the camera position, `yaw` the arms' frame yaw (the seat's rest view: local +z points
   * at the table along the rest gaze, the right hand is on local −x), `vfov` (degrees) / `aspect` the camera's,
   * used to keep the rest spot in the screen's lower corners.
   */
  update(dt: number, time: number, eye: THREE.Vector3, yaw: number, feltY: number, visible: boolean, vfov = 58, aspect = 1.6): void {
    this.root.visible = visible;
    if (!visible) {
      this.init = false;
      return;
    }
    this.clock += dt;
    this.root.position.copy(eye);
    this.root.rotation.set(0, yaw, 0);
    this.root.updateMatrixWorld(true);
    this.solveRest(eye.y, feltY, vfov, aspect);
    // ---- rest: a little breathing and drift
    const br = Math.sin(time * 2.2) * 0.003;
    for (let i = 0; i < 2; i++) {
      _t[i]!.copy(this.rest[i]!);
      _t[i]!.x += Math.sin(time * (i === 0 ? 0.5 : 0.43) + i) * 0.006;
      _t[i]!.y += br;
      _p[i]!.copy(POLE_REST[i]!);
      _r[i]!.copy(ROT_REST[i]!);
      _k[i] = CURL_REST;
    }
    // Delayed gestures whose time has come.
    for (let i = 0; i < this.pending.length; i++) {
      const p = this.pending[i]!;
      if (p.at > this.clock) continue;
      this.pending.splice(i--, 1);
      this.play(p.g, p.opts);
    }
    // Nervous finger drum on my own turn.
    if (this.nervous >= SIREN_MID_CHANCE && !this.runs.length && !this.pending.length) {
      this.drumIn -= dt;
      if (this.drumIn <= 0) {
        this.drumIn = 2.5 + Math.random() * 2;
        this.play("drum");
      }
    }
    // ---- clips
    let lean = 0;
    for (const r of this.runs) {
      r.t += dt;
      const w = envelope(r.t, r.dur, FADE_IN[r.g] ?? 0.14, r.fadeOut);
      if (w <= 0) continue;
      for (let i = 0; i < 2; i++) {
        _ct[i]!.copy(_t[i]!);
        _cp[i]!.copy(_p[i]!);
        _cr[i]!.copy(_r[i]!);
        _ck[i] = _k[i]!;
      }
      const l = this.pose(r, time, dt);
      for (let i = 0; i < 2; i++) {
        _t[i]!.lerp(_ct[i]!, w);
        _p[i]!.lerp(_cp[i]!, w);
        _r[i]!.lerp(_cr[i]!, w);
        _k[i] = _k[i]! + (_ck[i]! - _k[i]!) * w;
      }
      lean += l * w;
    }
    for (let i = this.runs.length - 1; i >= 0; i--) if (this.runs[i]!.t >= this.runs[i]!.dur) this.runs.splice(i, 1);
    // ---- springs + IK (shoulders slide forward with the lean), then the paw's own orientation and curl
    _a.set(0, -lean * 0.05, lean);
    followV(this.lean, _a, this.leanVel, 14, dt);
    for (let i = 0; i < 2; i++) {
      const arm = this.arms[i]!;
      arm.shoulder.position.set(arm.side * 0.19, -0.27, -0.06).add(this.lean);
      limitReach(arm.shoulder.position, _t[i]!, REACH, 0.96, 0.12);
      if (!this.init) {
        arm.cur.copy(_t[i]!);
        arm.pole.copy(_p[i]!);
        arm.rot.copy(_r[i]!);
        arm.curl = _k[i]!;
        arm.vel.set(0, 0, 0);
        arm.rotVel.set(0, 0, 0);
        arm.curlVel[0] = 0;
      } else {
        followV(arm.cur, _t[i]!, arm.vel, 20, dt);
        followV(arm.pole, _p[i]!, arm.poleVel, 12, dt);
        followV(arm.rot, _r[i]!, arm.rotVel, 16, dt);
        arm.curl = follow(arm.curl, _k[i]!, arm.curlVel, 0, 22, dt);
      }
      _w.copy(arm.cur);
      limitReach(arm.shoulder.position, _w, REACH, 0.96, 0.12);
      const bend = solveArm(arm.shoulder.position, _w, arm.pole, UPPER, FORE, _q);
      arm.shoulder.quaternion.copy(_q);
      arm.elbow.rotation.set(bend, 0, 0);
      // Hand bone in root space = shoulder · elbow bend; the paw undoes it and takes its own rotation.
      _q2.setFromAxisAngle(_X, bend);
      _q.multiply(_q2).invert();
      arm.paw.quaternion.copy(_q).multiply(_q2.setFromEuler(_e.set(arm.rot.x, arm.rot.y, arm.rot.z, "YXZ")));
      // Cufflink on top of the wrist, whatever way the forearm turned.
      _a.set(0, 1, 0).applyQuaternion(_q);
      _a.y = 0;
      if (_a.lengthSq() < 1e-6) _a.set(0, 0, 1);
      _a.normalize();
      arm.link.position.set(_a.x * 0.031, 0.005, _a.z * 0.031);
      const curl = clamp(arm.curl, 0, 1);
      arm.pawMesh.morphTargetInfluences![0] = curl;
      arm.pawInk.morphTargetInfluences![0] = curl;
    }
    this.init = true;
    this.props.update(dt);
    // Handcuff chain from wrist to wrist (root space).
    const cuffed = this.h.cuffL.obj.visible && this.h.cuffL.pop.x > 0.5;
    if (cuffed) {
      this.root.worldToLocal(this.h.cuffL.obj.getWorldPosition(_a));
      this.root.worldToLocal(this.h.cuffR.obj.getWorldPosition(_b));
      stretchStrand(this.chain, _a, _b);
    }
    this.chain.visible = cuffed;
  }

  /** Wrist rest points: the NDC rest spot at the rest pitch, on the felt, clear of my chip stack. */
  private solveRest(eyeY: number, feltY: number, vfov: number, aspect: number): void {
    const P = FP_REST_PITCH;
    const sp = Math.sin(P);
    const cp = Math.cos(P);
    const tv = Math.tan(THREE.MathUtils.degToRad(clamp(vfov, 30, 100)) / 2);
    const th = tv * clamp(aspect, 0.5, 3);
    const h = feltY + WRIST_UP - eyeY;
    // A point at NDC (nx, ny) and depth d: d·forward + d·ny·tv·up + d·nx·th·right, with its height = h.
    const den = Math.min(-0.2, sp + REST_NY * tv * cp);
    const d = clamp(h / den, 0.35, 0.8);
    const z = clamp(d * cp - d * REST_NY * tv * sp, 0.4, 0.7);
    const x = Math.min(0.42, d * REST_NX * th);
    this.rest[0]!.set(-x, h, z);
    this.rest[1]!.set(x, h, z);
    if (this.avoid) {
      this.root.worldToLocal(_a.copy(this.avoidA));
      this.root.worldToLocal(_b.copy(this.avoidB));
    }
    for (let i = 0; i < 2; i++) {
      const r = this.rest[i]!;
      this.onFelt(r);
      if (!this.avoid) continue;
      // Closest point of the pile's axis to the paw center (≈ 6 cm ahead of the wrist), horizontally.
      const px = r.x;
      const pz = r.z + 0.045 * PAW;
      const ax = _b.x - _a.x;
      const az = _b.z - _a.z;
      const len2 = ax * ax + az * az;
      const u = len2 > 1e-8 ? clamp(((px - _a.x) * ax + (pz - _a.z) * az) / len2, 0, 1) : 0;
      const dx = px - (_a.x + ax * u);
      const dz = pz - (_a.z + az * u);
      const dist = Math.hypot(dx, dz);
      if (dist >= AVOID_R) continue;
      // Step out of the capsule (beside the chips; toward the view center if dead on the axis), still on the felt.
      if (dist < 1e-3) r.x -= this.arms[i]!.side * AVOID_R;
      else {
        r.x += (dx / dist) * (AVOID_R - dist);
        r.z += (dz / dist) * (AVOID_R - dist);
      }
      this.onFelt(r);
    }
  }

  /**
   * Wide fields of view, the end seats (rest view turned along the edge) or the pile would put the wrist on
   * the padded rail: pull it straight in toward the table center, onto the felt.
   */
  private onFelt(r: THREE.Vector3): void {
    this.root.localToWorld(_w.copy(r));
    const rr = Math.hypot(_w.x, _w.z);
    if (rr <= FELT_R) return;
    _w.x *= FELT_R / rr;
    _w.z *= FELT_R / rr;
    this.root.worldToLocal(r.copy(_w));
  }

  /** Write one clip's targets into _ct/_cp/_cr/_ck (root space); returns the lean (shoulders forward, m). */
  private pose(r: FpRun, time: number, dt: number): number {
    const t = r.t;
    const R = _ct[0]!;
    const L = _ct[1]!;
    const R0 = this.rest[0]!;
    const h = this.h;
    switch (r.g) {
      case "knock": {
        // A small rap of the right fist on the felt, a little inward: lift, rap, half lift, rap.
        R.lerp(_a.copy(R0).add(_b.set(0.05, 0.016, 0.05)), smooth(seg(t, 0, 0.12)));
        R.y += 0.05 * easeOut(seg(t, 0, 0.12)) * (1 - easeIn(seg(t, 0.12, 0.17))) + 0.026 * easeOut(seg(t, 0.17, 0.23)) * (1 - easeIn(seg(t, 0.23, 0.29)));
        _cr[0]!.set(0.4, 0.3, 0.05);
        _ck[0] = 1;
        return 0.03 * bump(t, 0, 0.45);
      }
      case "slam": {
        // Both paws up a little, flat down on the felt, then rake the pot in toward me.
        for (let i = 0; i < 2; i++) {
          const s = this.arms[i]!.side;
          const o = _ct[i]!;
          const base = this.rest[i]!;
          const up = _a.copy(base).add(_b.set(-s * 0.02, 0.085, -0.035));
          const hit = _c.copy(base).add(_b.set(-s * 0.035, 0.002, 0.04));
          const rake = _w.copy(base).add(_b.set(-s * 0.06, 0.02, -0.075));
          if (t < 0.15) o.lerp(up, easeOut(t / 0.15));
          else if (t < 0.22) o.lerpVectors(up, hit, easeIn((t - 0.15) / 0.07));
          else if (t < 0.32) o.copy(hit);
          else if (t < 0.62) o.lerpVectors(hit, rake, easeInOut((t - 0.32) / 0.3));
          else o.lerpVectors(rake, base, easeInOut(seg(t, 0.62, 0.9)));
          _cr[i]!.set(t < 0.15 ? -0.25 : t < 0.32 ? 0.1 : 0.4, -s * 0.3, -s * 0.05);
          _ck[i] = t < 0.32 ? 0.05 : 0.65 * seg(t, 0.32, 0.45);
        }
        if (this.once(r, 1, 0.22)) {
          for (let i = 0; i < 2; i++) {
            this.handWorld(i, _a);
            _a.y -= 0.02;
            for (let k = 0; k < 3; k++) this.particles.chip(_a, _b.set((Math.random() - 0.5) * 0.6, 0.9 + Math.random() * 0.6, (Math.random() - 0.5) * 0.6), 0.016);
            for (let k = 0; k < 2; k++) this.particles.puff(_a, _b.set((Math.random() - 0.5) * 0.5, 0.12, (Math.random() - 0.5) * 0.5), 0.03, "#CFC7B8", 0.5, 2, 4);
          }
        }
        return t < 0.15 ? -0.02 : 0.06 * (1 - smooth(seg(t, 0.22, 0.8)));
      }
      case "push": {
        // Slide the right paw forward on the felt (chips into the box) and back.
        R.lerp(_a.copy(R0).add(_b.set(0.1, 0.004, 0.15)), t < 0.32 ? easeOut(t / 0.32) : 1);
        _cr[0]!.set(0.22, 0.45, 0.05);
        _ck[0] = 0.15;
        return 0.07 * bump(t, 0, 0.7);
      }
      case "cheer": {
        // Fists up at the sides of the view (lower half), pumping.
        const up = backOut(seg(t, 0, 0.25));
        const pump = Math.sin(t * 10) * 0.03 * seg(t, 0.25, 0.35);
        R.lerp(_a.set(-0.3, -0.29 + pump, 0.46), up);
        L.lerp(_a.set(0.3, -0.29 - pump, 0.46), up);
        _cp[0]!.set(-1, -0.7, 0);
        _cp[1]!.set(1, -0.7, 0);
        _cr[0]!.set(-1.25, 0.2, 0.2);
        _cr[1]!.set(-1.25, -0.2, -0.2);
        _ck[0] = _ck[1] = 1;
        if (r.bills > 0 && this.once(r, 1, 0.08)) {
          this.root.localToWorld(_a.set(0, -0.32, 0.62));
          for (let i = 0; i < r.bills; i++) {
            _b.set((Math.random() - 0.5) * 1.4, 0, 0.3 + Math.random() * 0.8).applyQuaternion(this.root.quaternion);
            this.particles.bill(_a, _b.setY(1.3 + Math.random() * 1.4));
          }
        }
        return -0.02;
      }
      case "flinch": {
        const j = backOut(seg(t, 0, 0.12));
        R.lerp(_a.set(-0.24, -0.26, 0.4), j);
        L.lerp(_a.set(0.24, -0.26, 0.4), j);
        _cr[0]!.set(-1.05, 0.35, 0);
        _cr[1]!.set(-1.05, -0.35, 0);
        _ck[0] = _ck[1] = 0.05;
        return -0.04;
      }
      case "drum": {
        const k = Math.abs(Math.sin(t * 22));
        R.y += k * 0.006;
        _ck[0] = 0.2 + k * 0.5;
        _ck[1] = 0.3 + Math.abs(Math.sin(t * 17 + 1)) * 0.25;
        return 0;
      }
      case "cuffed": {
        // Wrists together, lifted off the felt at the bottom center so the cuffs show.
        const jig = Math.sin(time * 7) * 0.008;
        R.set(-0.075 + jig, -0.3, 0.48);
        L.set(0.075 + jig, -0.3, 0.48);
        _cp[0]!.set(-1, -0.8, 0.2);
        _cp[1]!.set(1, -0.8, 0.2);
        _cr[0]!.set(0.25, 0.45, 0.3);
        _cr[1]!.set(0.25, -0.45, -0.3);
        _ck[0] = _ck[1] = 0.45;
        h.cuffL.want = h.cuffR.want = t > 0.15;
        return 0;
      }
      case "wallet": {
        L.lerp(_a.set(0.14, -0.29, 0.42), smooth(seg(t, 0, 0.3)));
        _cr[1]!.set(WALLET_L[0]!, WALLET_L[1]!, WALLET_L[2]!);
        _ck[1] = 0.55;
        h.wallet.want = t > 0.12 && t < r.dur - 0.2;
        const open = backOut(seg(t, 0.45, 0.7));
        this.wallet.left.rotation.y = -0.95 * open;
        this.wallet.right.rotation.y = 0.95 * open;
        if (t > 0.6 && t < 1.8) {
          const n = this.emit(r, 10, dt);
          if (n) {
            this.wallet.group.getWorldPosition(_b);
            this.root.localToWorld(_c.set(0, 0.25, 0.7));
            for (let i = 0; i < n; i++) this.particles.moth(_b, _c, 2);
          }
        }
        return 0;
      }
      case "plate": {
        const up = smooth(seg(t, 0, 0.3));
        R.lerp(_a.set(-0.165, -0.3, 0.46), up);
        L.lerp(_a.set(0.165, -0.3, 0.46), up);
        _cr[0]!.set(-1.1, 0.6, 0);
        _cr[1]!.set(-1.1, -0.6, 0);
        _ck[0] = _ck[1] = 0.7;
        h.plate.want = t > 0.1 && t < r.dur - 0.2;
        return 0;
      }
      case "puro": {
        // Cigar hand comes up at the lower right; the lighter hand flicks a flame at the tip; smoke at the rival.
        const hold = _a.set(-0.13, -0.26, 0.37);
        if (t < 0.3) R.lerp(hold, easeInOut(t / 0.3));
        else if (t < 1.65) R.copy(hold);
        else R.lerpVectors(hold, R0, easeIn((t - 1.65) / 0.45));
        _cr[0]!.set(PURO_R[0]!, PURO_R[1]!, PURO_R[2]!);
        _ck[0] = 0.55;
        const lw = seg(t, 0.28, 0.45) * (1 - seg(t, 0.85, 1.05));
        L.lerp(_b.set(-0.05, -0.28, 0.41), lw);
        _cr[1]!.lerp(_b.set(PURO_L[0]!, PURO_L[1]!, PURO_L[2]!), lw);
        _ck[1] = _ck[1]! + (0.75 - _ck[1]!) * lw;
        h.cigar.want = t > 0.2 && t < 1.9;
        h.lighter.want = lw > 0.15;
        this.lighter.flame.scale.set(0.014, 0.05 * (t > 0.45 && t < 0.95 ? 0.8 + Math.sin(time * 40) * 0.25 : 0.001), 0.014);
        (this.cigar.ember.material as THREE.MeshToonMaterial).emissiveIntensity = 1.1 + bump(t, 0.6, 0.95) * 2.2;
        if (t > 0.75 && t < 1.55) {
          const n = this.emit(r, 14, dt);
          if (n) {
            this.cigar.ember.getWorldPosition(_b);
            if (r.target) _c.subVectors(r.target, _b).normalize();
            else _c.set(0, 0, 1).applyQuaternion(this.root.quaternion);
            for (let i = 0; i < n; i++) {
              _w.copy(_c).multiplyScalar(1 + Math.random() * 0.5);
              _w.y += 0.1 + Math.random() * 0.1;
              _w.x += (Math.random() - 0.5) * 0.2;
              _w.z += (Math.random() - 0.5) * 0.2;
              this.particles.puff(_b, _w, 0.04, "#D9D4DA", 1.5, 2.8, 0.9);
            }
          }
        }
        return 0;
      }
      case "paraSay": {
        // The wad in the left paw, the right one flicks the bills, then both toss them up.
        L.lerp(_a.set(0.1, -0.28, 0.4), smooth(seg(t, 0, 0.3)));
        _cr[1]!.set(PARA_L[0]!, PARA_L[1]!, PARA_L[2]!);
        _ck[1] = 0.6;
        const flick = t > 0.5 && t < 1.45 ? Math.abs(Math.sin(t * 16)) * 0.025 : 0;
        R.lerp(_a.set(-0.04, -0.27 + flick, 0.4), smooth(seg(t, 0.1, 0.4)));
        _cr[0]!.set(0.3, 0.6, 0);
        _ck[0] = 0.35 + flick * 8;
        const toss = backOut(seg(t, 1.45, 1.7)) * (1 - smooth(seg(t, 1.9, 2.3)));
        R.lerp(_a.set(-0.24, -0.24, 0.46), toss);
        L.lerp(_a.set(0.24, -0.24, 0.46), toss);
        _cr[0]!.lerp(_b.set(-1, 0.2, 0), clamp(toss, 0, 1));
        _cr[1]!.lerp(_b.set(-1, -0.2, 0), clamp(toss, 0, 1));
        h.wad.want = t > 0.05 && t < 1.6;
        this.wad.top.rotation.y = flick * 10;
        if (this.once(r, 1, 1.6)) {
          this.root.localToWorld(_b.set(0, -0.18, 0.5));
          for (let i = 0; i < 9; i++) {
            _c.set((Math.random() - 0.5) * 1.4, 0, 0.2 + Math.random() * 0.6).applyQuaternion(this.root.quaternion);
            this.particles.bill(_b, _c.setY(1.6 + Math.random() * 1.2));
          }
        }
        return 0;
      }
      case "yumruk": {
        // Wind up at the right, fist down on the felt; chips jump.
        const wind = _a.set(-0.24, -0.2, 0.36);
        const hit = _b.copy(R0).add(_c.set(0.05, 0.016, 0.05));
        if (t < 0.22) R.lerp(wind, easeOut(t / 0.22));
        else if (t < 0.3) R.lerpVectors(wind, hit, easeIn((t - 0.22) / 0.08));
        else R.copy(hit).add(_c.set(Math.sin(t * 46) * 0.008 * (1 - seg(t, 0.3, 1)), 0, 0));
        _cr[0]!.set(t < 0.22 ? -0.7 : 0.4, 0.25, 0);
        _ck[0] = 1;
        if (this.once(r, 1, 0.3)) {
          this.root.localToWorld(_c.copy(hit));
          _c.y -= 0.02;
          for (let i = 0; i < 7; i++) this.particles.chip(_c, _w.set((Math.random() - 0.5) * 1.1, 1.3 + Math.random() * 1.1, (Math.random() - 0.5) * 1.1));
          for (let i = 0; i < 3; i++) this.particles.puff(_c, _w.set((Math.random() - 0.5) * 0.6, 0.15, (Math.random() - 0.5) * 0.6), 0.035, "#CFC7B8", 0.6, 2, 4);
        }
        return t < 0.22 ? -0.03 : 0.06 * (1 - smooth(seg(t, 0.3, 1.1)));
      }
      case "opucuk": {
        // Fingertips to the lips, then the kiss thrown out toward the rival.
        const lips = _a.set(-0.07, -0.23, 0.25);
        const out = _b.set(-0.22, -0.21, 0.5);
        if (t < 0.35) R.lerp(lips, easeInOut(t / 0.35));
        else if (t < 0.6) R.lerpVectors(lips, out, backOut((t - 0.35) / 0.25));
        else R.copy(out);
        _cr[0]!.set(t < 0.35 ? -1.35 : -0.75, 0.3, 0.2);
        _ck[0] = t < 0.35 ? 0.45 : 0.05;
        for (let k = 0; k < 3; k++) {
          if (!this.once(r, 1 << k, 0.45 + k * 0.12)) continue;
          this.handWorld(0, _b);
          if (r.target) _c.copy(r.target);
          else this.root.localToWorld(_c.set(0, 0.1, 2));
          this.particles.heart(_b, _c, k === 0 ? 0.07 : 0.045, 0.9 + k * 0.1, 0.4);
        }
        return 0;
      }
      case "agla": {
        // Hanky up at the bottom of the view, shaking with the sobs.
        L.lerp(_a.set(0.13, -0.29 + Math.sin(t * 9) * 0.015, 0.36), smooth(seg(t, 0, 0.3)));
        _cr[1]!.set(AGLA_L[0]!, AGLA_L[1]!, AGLA_L[2]!);
        _ck[1] = 0.7;
        R.y += Math.abs(Math.sin(t * 16)) * 0.006 * seg(t, 0.3, 0.5);
        h.hanky.want = t > 0.1 && t < r.dur - 0.25;
        return 0;
      }
      case "allahAllah": {
        // Both open paws up at the sides, shaking.
        const up = backOut(seg(t, 0, 0.3));
        const sh = Math.sin(t * 14) * 0.02;
        R.lerp(_a.set(-0.3, -0.25 + sh, 0.44), up);
        L.lerp(_a.set(0.3, -0.25 - sh, 0.44), up);
        _cp[0]!.set(-1, -0.6, 0);
        _cp[1]!.set(1, -0.6, 0);
        // Palms turned up to the sky (thumbs outward).
        _cr[0]!.set(-0.45, -0.35, Math.PI);
        _cr[1]!.set(-0.45, 0.35, -Math.PI);
        _ck[0] = _ck[1] = 0.15;
        return -0.03;
      }
    }
    return 0;
  }

  private emit(r: FpRun, rate: number, dt: number): number {
    r.acc += rate * dt;
    const n = Math.floor(r.acc);
    r.acc -= n;
    return n;
  }

  private once(r: FpRun, bit: number, at: number): boolean {
    if (r.t < at || r.fired & bit) return false;
    r.fired |= bit;
    return true;
  }
}
