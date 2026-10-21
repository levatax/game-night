// First-person arms of the local tourist: the character's own sleeves (Kaptan's white uniform with navy-gold
// cuffs, Fenomen's pink short sleeves and gold bangles, Amca's Hawaiian print and wristwatch, the bride's
// opera gloves, the chef's rolled-up sleeves, the kid's armbands), the seat-colored all-inclusive wristband,
// cartoon hands that curl into fists (morph target), and the held item in the right hand. Attached to the
// camera and drawn on top of the world (the depth buffer is cleared right before them, so they never clip
// into trees or terrain). Wrist targets in camera space are solved from the FOV so the hands sit in the lower
// corners at any window shape, then followed by critically damped springs + two-bone IK.
// Continuous poses come from FpArmsFrame (idle sway, look lag, walk bob, sprint pump, swim strokes, downed
// crawl, charge pull-back + tremble, gather chop / tug, revive pumps, rod states, lit torch, puffer fuse
// shaking, jellyfish "AAAH"); one-shot gestures cross-fade over them (throw, toss, use, swing, eat, gather,
// catch, cast, reel, hurt, place, deliver). Owner: client-characters. Adapted from
// games/kasala/client/src/scene/characters/fpArms.ts.

import * as THREE from "three";
import { CHANNEL, CHARACTERS, FISH_STATE, HEAD_BOB_HZ, PALETTE, SPRINT_SPEED, WALK_SPEED } from "../../../shared/constants";
import { ITEMS } from "../../../shared/items";
import type { CharacterId, InvKind, ItemKind } from "../../../shared/types";
import type { FpArmsFrame, FpGesture } from "./Characters";
import { createHeldItem, flickerHeld, heldTipWorld, holdClass, type HoldClass } from "./holds";
import { follow, followV, limitReach, solveArm } from "./ik";
import { bodyMaterial, cylinderGeo, mergePrims, overlayMaterial, type Prim, sphereGeo, torusGeo, trs, type V3, flowerGeo } from "./kit";
import { bump, clamp, clamp01, easeInOut, easeOutBack, easeOutCubic, seg, wrapAngle } from "./pose";
import { toonColor } from "../render/Toon";

/** Upper arm / forearm lengths (m) and the full reach. */
const UPPER = 0.3;
const FORE = 0.3;
const REACH = UPPER + FORE;
/** Ink hull growth (m): ≈ 2–3 px at the rest distance. */
const INK = 0.0024;
/** Hands are drawn a bit bigger than life (cartoon). */
const HAND = 1.18;
/** Render order of the overlay (every group in the subtree gets it as its group order). */
export const FP_ORDER = 9_000_000;
/** Shoulders in camera space (+x right, +y up, −z forward). */
const SHOULDER: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.2, -0.29, 0.08), new THREE.Vector3(-0.2, -0.29, 0.08)];
/** Rest spots on screen (NDC) and depth. */
const REST_NDC: readonly [readonly [number, number], readonly [number, number]] = [
  [0.5, -0.57],
  [-0.62, -0.76],
];
const REST_DEPTH = 0.44;
const REST_MAX_X = 0.3;

type Side = 0 | 1;

interface HandTarget {
  pos: THREE.Vector3;
  pole: THREE.Vector3;
  /** Hand rotation (pitch, yaw, roll), Euler YXZ in camera space; fingers along −Z, back of the hand +Y. */
  rot: THREE.Vector3;
  curl: number;
}

function target(): HandTarget {
  return { pos: new THREE.Vector3(), pole: new THREE.Vector3(), rot: new THREE.Vector3(), curl: 0 };
}

function copyTarget(dst: HandTarget, src: HandTarget): void {
  dst.pos.copy(src.pos);
  dst.pole.copy(src.pole);
  dst.rot.copy(src.rot);
  dst.curl = src.curl;
}

function lerpTarget(dst: HandTarget, src: HandTarget, w: number): void {
  dst.pos.lerp(src.pos, w);
  dst.pole.lerp(src.pole, w);
  dst.rot.x += wrapAngle(src.rot.x - dst.rot.x) * w;
  dst.rot.y += wrapAngle(src.rot.y - dst.rot.y) * w;
  dst.rot.z += wrapAngle(src.rot.z - dst.rot.z) * w;
  dst.curl += (src.curl - dst.curl) * w;
}

/* ============================================================ poses */

const _bx = new THREE.Vector3();
const _by = new THREE.Vector3();
const _bz = new THREE.Vector3();
const _bm = new THREE.Matrix4();
const _be = new THREE.Euler(0, 0, 0, "YXZ");

/**
 * Hand rotation (Euler YXZ) for a fist holding a tool that points along `dir` (camera space), the fingers
 * wrapping toward `fingers`. The tool leaves the fist on the thumb side.
 */
function fistAround(dir: V3, fingers: V3, side: Side): THREE.Vector3 {
  const inner = side === 0 ? -1 : 1;
  _bx.set(dir[0], dir[1], dir[2]).normalize().multiplyScalar(inner);
  _bz.set(fingers[0], fingers[1], fingers[2]).normalize().negate();
  _bz.addScaledVector(_bx, -_bz.dot(_bx)).normalize();
  _by.crossVectors(_bz, _bx).normalize();
  _bm.makeBasis(_bx, _by, _bz);
  _be.setFromRotationMatrix(_bm, "YXZ");
  return new THREE.Vector3(_be.x, _be.y, _be.z);
}

const POLE_REST: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(1, -0.55, 0.25), new THREE.Vector3(-1, -0.55, 0.25)];
const ROT_EMPTY: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.12, 0.35, -0.4), new THREE.Vector3(0.12, -0.35, 0.4)];
const ROT_PALM_UP = new THREE.Vector3(0.18, 0.3, Math.PI - 0.25);
const ROT_BIG: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(-0.15, 0.15, -Math.PI / 2 + 0.2), new THREE.Vector3(-0.15, -0.15, Math.PI / 2 - 0.2)];

/** Tool directions at rest (camera space) per kind; the fingers wrap forward-inward. */
const TOOL_DIR: Partial<Record<ItemKind, V3>> = {
  spear: [-0.12, 0.55, -0.83],
  rod: [-0.1, 0.5, -0.86],
  axe: [-0.25, 0.85, -0.45],
  torch: [-0.15, 0.9, -0.4],
};
const FINGERS_R: V3 = [-0.55, -0.3, -0.78];

function toolRot(kind: ItemKind | "", dir?: V3): THREE.Vector3 {
  const d = dir ?? (kind !== "" ? TOOL_DIR[kind] : undefined) ?? [-0.15, 0.7, -0.7];
  return fistAround(d, FINGERS_R, 0);
}

/* ============================================================ looks */

interface SleeveLook {
  sleeve: string;
  /** Fraction of the full arm (shoulder → wrist) the sleeve covers. */
  cover: number;
  skin: string;
  /** Hands (gloves). */
  hand: string;
  /** Bare forearm below the sleeve (opera gloves). */
  forearm: string;
  cuff: string | null;
  cuffStripe: string | null;
  handScale: number;
  extras?: (p: ArmParts, side: Side) => void;
}

interface ArmParts {
  upper: FpPart[];
  fore: FpPart[];
}

/** A unit primitive placed by center / rotation / size, so its ink hull can grow every axis evenly. */
interface FpPart {
  geo: THREE.BufferGeometry;
  at: V3;
  rot: V3;
  size: V3;
  color: string;
  ink: boolean;
  /** Fist pose of hand parts (morph target); omitted = same as open. */
  fist?: { at: V3; rot: V3; size: V3 };
}

function lookFor(character: CharacterId): SleeveLook {
  const c = CHARACTERS[character].colors;
  switch (character) {
    case "kaptan":
      return { sleeve: c.outfit, cover: 1, skin: c.skin, hand: c.skin, forearm: c.skin, cuff: c.accent, cuffStripe: "#F2C14E", handScale: 1.05 };
    case "fenomen":
      return {
        sleeve: c.outfit,
        cover: 0.32,
        skin: c.skin,
        hand: c.skin,
        forearm: c.skin,
        cuff: null,
        cuffStripe: null,
        handScale: 0.95,
        extras: (p) => {
          // Gold bangles on the wrist.
          for (const [y, r] of [[-FORE + 0.045, 0.039], [-FORE + 0.065, 0.04]] as const) {
            p.fore.push({ geo: torusGeo(0.14), at: [0, y, 0], rot: [0.12, 0, 0.08], size: [r, r, r], color: "#F2C14E", ink: false });
          }
        },
      };
    case "amca":
      return {
        sleeve: c.outfit,
        cover: 0.42,
        skin: c.skin,
        hand: c.skin,
        forearm: c.skin,
        cuff: "#2E9CC0",
        cuffStripe: null,
        handScale: 1.05,
        extras: (p, side) => {
          // Hibiscus prints on the sleeve; a gold wristwatch on the right wrist (the band is on the left).
          for (const [a, y] of [[0.4, -0.08], [2.2, -0.18], [-1.2, -0.25]] as const) {
            p.upper.push({ geo: flowerGeo(), at: [Math.sin(a) * 0.05, y, Math.cos(a) * 0.05], rot: [0, a, 0], size: [0.022, 0.022, 0.022], color: c.accent, ink: false });
          }
          if (side === 0) {
            p.fore.push({ geo: torusGeo(0.3), at: [0, -FORE + 0.05, 0], rot: [0, 0, 0], size: [0.037, 0.037, 0.037], color: "#6B4226", ink: true });
            p.fore.push({ geo: cylinderGeo(1, 10), at: [0, -FORE + 0.045, 0.04], rot: [Math.PI / 2, 0, 0], size: [0.017, 0.008, 0.017], color: "#F2C14E", ink: true });
          }
        },
      };
    case "gelin":
      return { sleeve: c.outfit, cover: 0.3, skin: c.skin, hand: "#FFFFFF", forearm: "#FFFFFF", cuff: c.outfit, cuffStripe: c.accent, handScale: 0.95 };
    case "sef":
      return {
        sleeve: c.outfit,
        cover: 0.72,
        skin: c.skin,
        hand: c.skin,
        forearm: c.skin,
        cuff: c.outfit,
        cuffStripe: c.accent,
        handScale: 1.08,
      };
    case "cocuk":
      return {
        sleeve: c.outfit,
        cover: 0.3,
        skin: c.skin,
        hand: c.skin,
        forearm: c.skin,
        cuff: null,
        cuffStripe: null,
        handScale: 0.85,
        extras: (p) => {
          // The inflatable armband rides low on the arm so it peeks into view, with its valve.
          p.fore.push({ geo: torusGeo(0.5), at: [0, -0.06, 0], rot: [0, 0, 0], size: [0.07, 0.09, 0.07], color: c.accent, ink: true });
          p.fore.push({ geo: sphereGeo(6), at: [0, -0.06, -0.075], rot: [0, 0, 0], size: [0.012, 0.012, 0.012], color: "#FFFFFF", ink: false });
        },
      };
  }
}

/** Sleeve + forearm parts of one arm. */
function armParts(look: SleeveLook, side: Side): ArmParts {
  const cover = clamp(look.cover, 0, 1) * REACH;
  const parts: ArmParts = { upper: [], fore: [] };
  const upperSleeve = Math.min(cover, UPPER);
  // Upper arm: shoulder ball, sleeve, bare skin below a short sleeve.
  parts.upper.push({ geo: sphereGeo(8), at: [0, 0, 0], rot: [0, 0, 0], size: [0.052, 0.052, 0.052], color: look.sleeve, ink: true });
  if (upperSleeve > 0.01) parts.upper.push({ geo: cylinderGeo(1.12, 12, true), at: [0, -upperSleeve, 0], rot: [0, 0, 0], size: [0.047, upperSleeve, 0.047], color: look.sleeve, ink: true });
  if (upperSleeve < UPPER - 0.01) {
    const len = UPPER - upperSleeve;
    parts.upper.push({ geo: cylinderGeo(1.1, 10, true), at: [0, -UPPER, 0], rot: [0, 0, 0], size: [0.039, len + 0.01, 0.039], color: look.skin, ink: true });
    parts.upper.push({ geo: torusGeo(0.3), at: [0, -upperSleeve + 0.006, 0], rot: [0, 0, 0], size: [0.048, 0.03, 0.048], color: look.cuff ?? look.sleeve, ink: true });
  }
  // Forearm: elbow ball, sleeve part, bare (or gloved) part, cuff ring at the sleeve end.
  const foreSleeve = clamp(cover - UPPER, 0, FORE);
  const elbowColor = foreSleeve > 0.01 ? look.sleeve : look.forearm;
  parts.fore.push({ geo: sphereGeo(8), at: [0, 0, 0], rot: [0, 0, 0], size: [0.043, 0.043, 0.043], color: elbowColor, ink: true });
  if (foreSleeve > 0.01) parts.fore.push({ geo: cylinderGeo(1.12, 12, true), at: [0, -foreSleeve, 0], rot: [0, 0, 0], size: [0.04, foreSleeve, 0.04], color: look.sleeve, ink: true });
  if (foreSleeve < FORE - 0.01) {
    const len = FORE - foreSleeve;
    parts.fore.push({ geo: cylinderGeo(1.15, 10, true), at: [0, -FORE, 0], rot: [0, 0, 0], size: [0.031, len, 0.031], color: look.forearm, ink: true });
  }
  if (look.cuff && cover > UPPER + 0.01) {
    const y = -foreSleeve + 0.008;
    parts.fore.push({ geo: torusGeo(0.32), at: [0, y, 0], rot: [0, 0, 0], size: [0.041, 0.034, 0.041], color: look.cuff, ink: true });
    if (look.cuffStripe) parts.fore.push({ geo: torusGeo(0.18), at: [0, y + 0.022, 0], rot: [0, 0, 0], size: [0.04, 0.03, 0.04], color: look.cuffStripe, ink: false });
  }
  look.extras?.(parts, side);
  return parts;
}

/**
 * Hand parts (wrist origin, fingers −Z, back +Y). `inner` = the thumb side (+1 / −1). Each part has its fist
 * pose: fingers curl under with the knuckles in front, the thumb wraps across them.
 */
function handParts(look: SleeveLook, inner: number): FpPart[] {
  const k = HAND * look.handScale;
  const col = look.hand;
  const sp = sphereGeo(9);
  const lo = sphereGeo(6);
  const s = (v: V3): V3 => [v[0] * k, v[1] * k, v[2] * k];
  const parts: FpPart[] = [
    { geo: sphereGeo(7), at: s([0, 0, -0.006]), rot: [0, 0, 0], size: s([0.028, 0.024, 0.028]), color: col, ink: true },
    { geo: sp, at: s([0, 0.0, -0.046]), rot: [0, 0, 0], size: s([0.039, 0.018, 0.045]), color: col, ink: true, fist: { at: s([0, 0.002, -0.044]), rot: [0, 0, 0], size: s([0.039, 0.022, 0.04]) } },
  ];
  const xs = [-0.027, -0.009, 0.009, 0.027];
  for (const x of xs) {
    const outer = x * inner < 0;
    const len = Math.abs(x) > 0.02 ? (outer ? 0.032 : 0.036) : 0.04;
    parts.push({
      geo: lo,
      at: s([x * 1.05, -0.002, -0.088 - len * 0.5]),
      rot: [0, -x * 1.4, 0],
      size: s([0.0105, 0.0098, len * 0.55]),
      color: col,
      ink: true,
      fist: { at: s([x * 0.95, -0.02, -0.088]), rot: [1.45, 0, 0], size: s([0.011, 0.0115, len * 0.38]) },
    });
  }
  parts.push({
    geo: lo,
    at: s([inner * 0.04, -0.007, -0.036]),
    rot: [0, inner * 0.6, -inner * 0.25],
    size: s([0.012, 0.011, 0.025]),
    color: col,
    ink: true,
    fist: { at: s([inner * 0.02, -0.018, -0.075]), rot: [0, -inner * 1.2, 0], size: s([0.012, 0.011, 0.02]) },
  });
  return parts;
}

function partPrim(p: FpPart, grow: number, fist: boolean): Prim {
  const f = fist && p.fist ? p.fist : p;
  const size: V3 = [f.size[0] + grow, f.size[1] + grow, f.size[2] + grow];
  return { geometry: p.geo, matrix: trs(f.at, f.rot, size), color: new THREE.Color(p.color) };
}

/** Merged geometry of parts (optionally only the inked ones, grown into a hull), with a fist morph target. */
function bakeParts(parts: ReadonlyArray<FpPart>, hull: boolean, morph: boolean): THREE.BufferGeometry {
  const list = hull ? parts.filter((p) => p.ink) : parts;
  const grow = hull ? INK : 0;
  const open = mergePrims(list.map((p) => partPrim(p, grow, false)));
  if (morph) {
    const fist = mergePrims(list.map((p) => partPrim(p, grow, true)));
    open.morphAttributes.position = [fist.getAttribute("position") as THREE.BufferAttribute];
    open.morphAttributes.normal = [fist.getAttribute("normal") as THREE.BufferAttribute];
    fist.dispose();
  }
  open.computeBoundingSphere();
  return open;
}

interface ArmGeometry {
  upper: THREE.BufferGeometry;
  upperInk: THREE.BufferGeometry;
  fore: THREE.BufferGeometry;
  foreInk: THREE.BufferGeometry;
  hand: THREE.BufferGeometry;
  handInk: THREE.BufferGeometry;
}

const geometryCache = new Map<string, ArmGeometry>();

function armGeometry(character: CharacterId, side: Side): ArmGeometry {
  const key = `${character}:${side}`;
  let g = geometryCache.get(key);
  if (!g) {
    const look = lookFor(character);
    const parts = armParts(look, side);
    const hand = handParts(look, side === 0 ? -1 : 1);
    g = {
      upper: bakeParts(parts.upper, false, false),
      upperInk: bakeParts(parts.upper, true, false),
      fore: bakeParts(parts.fore, false, false),
      foreInk: bakeParts(parts.fore, true, false),
      hand: bakeParts(hand, false, true),
      handInk: bakeParts(hand, true, true),
    };
    geometryCache.set(key, g);
  }
  return g;
}

/* ============================================================ materials */

let inkMat: THREE.MeshBasicMaterial | null = null;
function fpInk(): THREE.MeshBasicMaterial {
  if (!inkMat) {
    inkMat = new THREE.MeshBasicMaterial({ color: PALETTE.ink, side: THREE.BackSide, transparent: true, depthWrite: true });
    inkMat.name = "fp-ink";
  }
  return inkMat;
}

/** Put a subtree in the overlay pass: group order, transparent material twins, no shadows / culling. */
function markOverlay(root: THREE.Object3D): void {
  root.traverse((o) => {
    if ((o as THREE.Group).isGroup) o.renderOrder = FP_ORDER;
    const m = o as THREE.Mesh;
    o.frustumCulled = false;
    if (!m.isMesh) return;
    m.castShadow = false;
    m.receiveShadow = false;
    m.renderOrder = 1;
    if (Array.isArray(m.material)) m.material = m.material.map((x) => overlayMaterial(x));
    else m.material = overlayMaterial(m.material);
  });
}

/* ============================================================ the rig */

interface FpArm {
  side: Side;
  shoulder: THREE.Group;
  elbow: THREE.Group;
  hand: THREE.Group;
  /** Fist grip (tools) and palm top (palm items), in hand space. */
  grip: THREE.Group;
  palm: THREE.Group;
  upper: THREE.Mesh;
  upperInk: THREE.Mesh;
  fore: THREE.Mesh;
  foreInk: THREE.Mesh;
  handMesh: THREE.Mesh;
  handInk: THREE.Mesh;
  cur: THREE.Vector3;
  vel: THREE.Vector3;
  pole: THREE.Vector3;
  poleVel: THREE.Vector3;
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
  /** Item the gesture started with (eat shows it, throw hides it). */
  item: InvKind;
}

const DUR: Record<FpGesture, number> = {
  throw: 0.42,
  toss: 0.45,
  use: 0.36,
  eat: 0.9,
  gather: 0.3,
  catch: 0.5,
  cast: 0.62,
  reel: 0.5,
  swing: 0.5,
  hurt: 0.38,
  place: 0.5,
  deliver: 0.55,
};
const FADE_IN: Partial<Record<FpGesture, number>> = { throw: 0.02, use: 0.04, swing: 0.05, hurt: 0.02, catch: 0.04 };
/** Gestures after which the item left the hand (hidden from this time until the gesture ends). */
const RELEASE_AT: Partial<Record<FpGesture, number>> = { throw: 0.06, toss: 0.22, place: 0.25, deliver: 0.3 };

const _a = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _X = new THREE.Vector3(1, 0, 0);
const _fwd = new THREE.Vector3();

/** The camera-attached first-person arm rig (the FpArms facade in Characters.ts drives it). */
export class FpArmsRig {
  /** Child of the camera. */
  readonly root = new THREE.Group();
  private readonly sway = new THREE.Group();
  private readonly bigAnchor = new THREE.Group();
  private readonly arms: [FpArm, FpArm];
  private readonly band: THREE.Mesh;
  private character: CharacterId | null = null;
  private seatColor = "#FFFFFF";
  private visible = true;
  private runs: FpRun[] = [];
  private clock = 0;
  private init = false;
  /** Rest wrist points (camera space) this frame. */
  private readonly rest: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private readonly base: [HandTarget, HandTarget] = [target(), target()];
  private readonly clip: [HandTarget, HandTarget] = [target(), target()];
  private readonly swayPos = new THREE.Vector3();
  private readonly swayVel = new THREE.Vector3();
  private readonly swayTarget = new THREE.Vector3();
  private prevYaw = Number.NaN;
  private prevPitch = 0;
  private bobPhase = 0;
  private bobAmp = 0;
  private fovSmooth = 75;
  /** Held item objects per kind (created lazily, overlay materials). */
  private readonly heldCache = new Map<ItemKind, THREE.Group>();
  private held: THREE.Group | null = null;
  private heldKind: InvKind = "";
  private heldCls: HoldClass | null = null;
  private food: THREE.Group | null = null;
  private foodKind: InvKind = "";
  private lastFrame: FpArmsFrame | null = null;

  constructor() {
    this.root.name = "fpArms";
    this.root.add(this.sway);
    this.sway.add(this.bigAnchor);
    this.bigAnchor.position.set(0, -0.25, -0.48);
    const arms: FpArm[] = [];
    for (const side of [0, 1] as const) {
      const shoulder = new THREE.Group();
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER;
      const hand = new THREE.Group();
      hand.position.y = -FORE;
      shoulder.add(elbow);
      elbow.add(hand);
      const inner = side === 0 ? -1 : 1;
      const grip = new THREE.Group();
      grip.position.set(inner * 0.004 * HAND, -0.012 * HAND, -0.055 * HAND);
      // Grip frame (see holds.ts): −Z = out of the fist on the thumb side, −Y = toward the fingertips.
      _bm.makeBasis(_bx.set(0, -inner, 0), _by.set(0, 0, 1), _bz.set(-inner, 0, 0));
      grip.quaternion.setFromRotationMatrix(_bm);
      const palm = new THREE.Group();
      palm.position.set(0, -0.03 * HAND, -0.05 * HAND);
      hand.add(grip, palm);
      const mk = (): THREE.Mesh => new THREE.Mesh(new THREE.BufferGeometry(), bodyMaterial());
      const upper = mk();
      const upperInk = new THREE.Mesh(new THREE.BufferGeometry(), fpInk());
      const fore = mk();
      const foreInk = new THREE.Mesh(new THREE.BufferGeometry(), fpInk());
      const handMesh = mk();
      const handInk = new THREE.Mesh(new THREE.BufferGeometry(), fpInk());
      shoulder.add(upper, upperInk);
      elbow.add(fore, foreInk);
      hand.add(handMesh, handInk);
      this.sway.add(shoulder);
      arms.push({
        side,
        shoulder,
        elbow,
        hand,
        grip,
        palm,
        upper,
        upperInk,
        fore,
        foreInk,
        handMesh,
        handInk,
        cur: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        pole: POLE_REST[side].clone(),
        poleVel: new THREE.Vector3(),
        rot: ROT_EMPTY[side].clone(),
        rotVel: new THREE.Vector3(),
        curl: 0.5,
        curlVel: new Float32Array(1),
      });
    }
    this.arms = arms as [FpArm, FpArm];
    // Seat-colored all-inclusive wristband on the left wrist.
    this.band = new THREE.Mesh(torusGeo(0.34), toonColor(this.seatColor));
    this.band.name = "fpWristband";
    this.band.position.set(0, -FORE + 0.03, 0);
    this.band.scale.setScalar(0.04);
    this.arms[1].elbow.add(this.band);
    // Depth clear right before the arms draw (they render last in the transparent pass).
    const clear = new THREE.Mesh(
      new THREE.PlaneGeometry(1e-4, 1e-4),
      new THREE.MeshBasicMaterial({ transparent: true, colorWrite: false, depthWrite: false, depthTest: false }),
    );
    clear.name = "fpDepthClear";
    clear.onBeforeRender = (renderer) => renderer.clearDepth();
    this.root.add(clear);
    markOverlay(this.root);
    clear.renderOrder = 0;
    this.root.visible = false;
  }

  /** Seat color of the wristband. */
  setSeatColor(color: string): void {
    if (color === this.seatColor) return;
    this.seatColor = color;
    this.band.material = overlayMaterial(toonColor(color));
  }

  setVisible(v: boolean): void {
    this.visible = v;
    if (!v) {
      this.root.visible = false;
      this.init = false;
    }
  }

  play(g: FpGesture): void {
    for (const r of this.runs) {
      const end = r.t + 0.14;
      if (end < r.dur) {
        r.dur = end;
        r.fadeOut = Math.min(r.fadeOut, 0.14);
      }
    }
    const dur = DUR[g];
    this.runs.push({ g, t: 0, dur, fadeOut: Math.min(0.28, dur * 0.4), item: this.heldKind });
    if (this.runs.length > 3) this.runs.shift();
  }

  clear(): void {
    this.runs.length = 0;
  }

  /** World position of the right hand's grip, or of a held rod's tip (bobber line). */
  handWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.held && this.heldKind === "rod" && heldTipWorld(this.held, out)) return out;
    return this.arms[0].grip.getWorldPosition(out);
  }

  get isVisible(): boolean {
    return this.root.visible;
  }

  update(dt: number, camera: THREE.PerspectiveCamera, f: FpArmsFrame): void {
    if (this.root.parent !== camera) camera.add(this.root);
    this.root.visible = this.visible;
    if (!this.visible) return;
    this.lastFrame = f;
    this.clock += dt;
    if (f.character !== this.character) this.setCharacter(f.character);
    this.setHeld(f.count > 0 ? f.held : "");
    this.updateSway(dt, camera, f);
    this.solveRest(camera);
    this.basePose(f);
    // Gestures.
    for (const r of this.runs) {
      r.t += dt;
      const w = envelope(r.t, r.dur, FADE_IN[r.g] ?? 0.1, r.fadeOut);
      if (w <= 0) continue;
      copyTarget(this.clip[0], this.base[0]);
      copyTarget(this.clip[1], this.base[1]);
      this.gesture(r);
      lerpTarget(this.base[0], this.clip[0], w);
      lerpTarget(this.base[1], this.clip[1], w);
    }
    this.runs = this.runs.filter((r) => r.t < r.dur);
    this.solve(dt);
    this.updateItems(f);
  }

  /* ---------------------------------------------------------- building */

  private setCharacter(character: CharacterId): void {
    this.character = character;
    for (const arm of this.arms) {
      const g = armGeometry(character, arm.side);
      arm.upper.geometry = g.upper;
      arm.upperInk.geometry = g.upperInk;
      arm.fore.geometry = g.fore;
      arm.foreInk.geometry = g.foreInk;
      arm.handMesh.geometry = g.hand;
      arm.handInk.geometry = g.handInk;
      arm.handMesh.updateMorphTargets();
      arm.handInk.updateMorphTargets();
    }
  }

  private setHeld(kind: InvKind): void {
    if (kind === this.heldKind) return;
    this.heldKind = kind;
    if (this.held) this.held.visible = false;
    this.held = null;
    this.heldCls = kind === "" ? null : holdClass(kind);
    if (kind === "") return;
    let obj = this.heldCache.get(kind);
    if (!obj) {
      obj = createHeldItem(kind, "fp");
      markOverlay(obj);
      this.heldCache.set(kind, obj);
    }
    const anchor = this.heldCls === "big" ? this.bigAnchor : this.heldCls === "palm" ? this.arms[0].palm : this.arms[0].grip;
    if (obj.parent !== anchor) anchor.add(obj);
    if (this.heldCls === "palm") {
      // Sit on the palm (palm side = hand −Y): lift by the item's size.
      obj.position.set(0, -ITEMS[kind].radius * obj.scale.x * 0.9, 0);
      obj.rotation.set(0, 0.4, 0);
    }
    obj.visible = true;
    this.held = obj;
  }

  /* ------------------------------------------------------------- poses */

  /** Look lag (the arms trail the view a little) and the walking bob. */
  private updateSway(dt: number, camera: THREE.PerspectiveCamera, f: FpArmsFrame): void {
    camera.getWorldDirection(_fwd);
    const yaw = Math.atan2(-_fwd.x, -_fwd.z);
    const pitch = Math.asin(clamp(_fwd.y, -1, 1));
    if (Number.isNaN(this.prevYaw) || dt <= 0) {
      this.prevYaw = yaw;
      this.prevPitch = pitch;
    }
    const yawRate = dt > 0 ? wrapAngle(yaw - this.prevYaw) / dt : 0;
    const pitchRate = dt > 0 ? (pitch - this.prevPitch) / dt : 0;
    this.prevYaw = yaw;
    this.prevPitch = pitch;
    this.swayTarget.set(clamp(yawRate * 0.012, -0.05, 0.05), clamp(-pitchRate * 0.01, -0.04, 0.04), 0);
    // Walk bob (figure eight), stronger when sprinting; none while swimming / downed.
    const moving = f.grounded && !f.swimming && !f.downed;
    const k = moving ? clamp(f.speed / WALK_SPEED, 0, 1.6) : 0;
    this.bobAmp += (k - this.bobAmp) * (1 - Math.exp(-8 * dt));
    this.bobPhase += dt * HEAD_BOB_HZ * Math.PI * 2 * (0.75 + 0.25 * Math.min(1.5, k));
    const b = this.bobAmp;
    this.swayTarget.x += Math.sin(this.bobPhase) * 0.008 * b;
    this.swayTarget.y += -Math.abs(Math.cos(this.bobPhase)) * 0.012 * b + Math.sin(this.clock * 2.1) * 0.003;
    followV(this.swayPos, this.swayTarget, this.swayVel, 16, dt);
    this.sway.position.copy(this.swayPos);
    this.sway.rotation.set(0, 0, -this.swayPos.x * 0.8);
  }

  /** Wrist rest points: the NDC rest spots at REST_DEPTH, solved from the (smoothed) FOV and aspect. */
  private solveRest(camera: THREE.PerspectiveCamera): void {
    this.fovSmooth += (camera.fov - this.fovSmooth) * 0.2;
    const tv = Math.tan(THREE.MathUtils.degToRad(clamp(this.fovSmooth, 40, 110)) / 2);
    const th = tv * clamp(camera.aspect, 0.6, 2.6);
    for (const side of [0, 1] as const) {
      const [nx, ny] = REST_NDC[side];
      const x = clamp(nx * REST_DEPTH * th, -REST_MAX_X, REST_MAX_X);
      const y = clamp(ny * REST_DEPTH * tv, -0.3, -0.14);
      this.rest[side].set(x, y, -REST_DEPTH);
    }
  }

  /** The continuous pose of both hands for this frame into `base`. */
  private basePose(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const t = this.clock;
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      h.pos.copy(this.rest[side]);
      h.pos.y += Math.sin(t * 2.1 + side) * 0.003;
      h.pos.x += Math.sin(t * (side ? 0.43 : 0.5) + side) * 0.004;
      h.pole.copy(POLE_REST[side]);
      h.rot.copy(ROT_EMPTY[side]);
      h.curl = 0.55;
    }
    // The off hand drops low when the right one is busy holding something.
    if (this.heldCls && this.heldCls !== "big") L.pos.y -= 0.03;

    if (f.downed) {
      this.crawl(f);
      return;
    }
    if (f.swimming) {
      this.swim(f);
      return;
    }

    // Held item rest poses (right hand).
    const kind = this.heldKind;
    switch (this.heldCls) {
      case "palm":
        R.pos.set(R.pos.x - 0.03, R.pos.y + 0.02, R.pos.z - 0.03);
        R.rot.copy(ROT_PALM_UP);
        R.curl = 0.22;
        break;
      case "tool":
      case "torch":
        R.pos.y += 0.02;
        R.rot.copy(toolRot(kind));
        R.curl = 1;
        if (kind === "torch" && f.torchLit) {
          R.pos.y += 0.04;
          R.pos.x += 0.01;
        }
        break;
      case "big":
        R.pos.set(0.17, -0.27, -0.46);
        L.pos.set(-0.17, -0.27, -0.46);
        R.rot.copy(ROT_BIG[0]);
        L.rot.copy(ROT_BIG[1]);
        R.curl = L.curl = 0.45;
        R.pole.set(1, -0.8, 0.3);
        L.pole.set(-1, -0.8, 0.3);
        break;
      default:
        break;
    }

    // Sprint: pumping fists.
    if (f.sprinting && f.grounded && f.speed > WALK_SPEED * 1.05 && this.heldCls !== "big") {
      const k = clamp01((f.speed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED));
      const s = Math.sin(this.bobPhase);
      R.pos.z += 0.06 * s * k;
      R.pos.y += 0.03 * Math.cos(this.bobPhase) * k;
      L.pos.z -= 0.06 * s * k;
      L.pos.y += 0.03 * Math.cos(this.bobPhase + Math.PI) * k;
      L.pos.y += 0.05 * k;
      L.curl = 0.9;
    }

    // Puffer fuse: the hands shake harder as it gets close; the left hand hovers nervously.
    if (kind === "puffer" && f.fuse >= 0) {
      const danger = 1 - clamp01(f.fuse);
      const amp = 0.003 + 0.018 * danger * danger;
      const hz = 30 + 40 * danger;
      R.pos.x += amp * Math.sin(t * hz);
      R.pos.y += amp * Math.sin(t * hz * 1.3 + 1);
      R.pos.z -= 0.08;
      if (danger > 0.55) {
        L.pos.lerp(_a.set(-0.1, -0.2, -0.42), (danger - 0.55) * 2);
        L.curl = 0.1;
        L.pos.x += amp * Math.sin(t * hz + 2);
      }
    }
    if (kind === "jellyfish") {
      R.pos.x += 0.012 * Math.sin(t * 26);
      R.pos.y += 0.01 * Math.sin(t * 31);
      R.pos.z -= 0.06;
    }

    // Charge: pull back and up, tremble at full.
    if (f.charge > 0 && this.heldCls !== "big") {
      const c = easeOutCubic(f.charge);
      // Back and down into the lower-right corner, so the item never blocks the view.
      if (this.heldCls === "tool") {
        R.pos.lerp(_a.set(0.34, -0.12, -0.3), c);
        R.rot.copy(toolRot(kind, [-0.05, 0.25 + 0.2 * c, -0.97]));
      } else {
        R.pos.lerp(_a.set(0.4, -0.2, -0.33), c);
        R.rot.lerp(_a.set(0.55, 0.45, Math.PI - 0.55), c);
      }
      R.pole.set(1, -0.3, 0.6);
      const shake = 0.002 + 0.006 * c * c + (f.charge >= 0.999 ? 0.004 : 0);
      R.pos.x += shake * Math.sin(t * 34);
      R.pos.y += shake * Math.sin(t * 41 + 1);
      // The off hand comes up to aim.
      L.pos.lerp(_a.set(-0.2, -0.18, -0.5), c * 0.8);
      L.rot.lerp(_a.set(0.2, -0.2, 0.2), c * 0.8);
      L.curl += (0.15 - L.curl) * c;
    } else if (f.charge > 0) {
      // Heave the big item up.
      const c = easeOutCubic(f.charge);
      R.pos.y += 0.12 * c;
      L.pos.y += 0.12 * c;
      R.pos.z += 0.08 * c;
      L.pos.z += 0.08 * c;
    }

    // Hold-E channels.
    if (f.channel >= 0 && f.channelKind === CHANNEL.GATHER) this.gatherLoop();
    else if (f.channel >= 0 && f.channelKind === CHANNEL.REVIVE) this.reviveLoop();

    // Fishing.
    if (kind === "rod" && f.fishState !== FISH_STATE.NONE) this.fishing(f);
  }

  private gatherLoop(): void {
    const [R, L] = this.base;
    const t = this.clock;
    if (this.heldKind === "axe") {
      // Chop: up and back, down into the trunk in front, twice a second.
      const u = (t * 2) % 1;
      const up = u < 0.55 ? easeOutCubic(u / 0.55) : 1 - easeOutCubic((u - 0.55) / 0.2);
      const k = clamp01(up);
      R.pos.set(0.05 + 0.2 * k, -0.27 + 0.32 * k, -0.56 + 0.24 * k);
      R.rot.copy(toolRot("axe", [-0.35 + 0.1 * k, 0.2 + 0.7 * k, -0.9 + 0.6 * k]));
      R.curl = 1;
      R.pole.set(1, -0.2, 0.4);
      return;
    }
    // Two-handed tug: grab, pull back, alternate.
    const ph = t * Math.PI * 2 * 1.3;
    const r = Math.max(0, Math.sin(ph));
    const l = Math.max(0, Math.sin(ph + Math.PI));
    R.pos.set(0.13 + 0.01 * r, -0.21 - 0.04 * r, -0.56 + 0.14 * r);
    L.pos.set(-0.13 - 0.01 * l, -0.21 - 0.04 * l, -0.56 + 0.14 * l);
    R.rot.set(-0.1, 0.25, -0.5);
    L.rot.set(-0.1, -0.25, 0.5);
    R.curl = 0.3 + 0.7 * r;
    L.curl = 0.3 + 0.7 * l;
  }

  private reviveLoop(): void {
    const [R, L] = this.base;
    const pump = Math.max(0, Math.sin(this.clock * Math.PI * 2 * 1.9));
    for (const side of [0, 1] as const) {
      const h = side === 0 ? R : L;
      const s = side === 0 ? 1 : -1;
      h.pos.set(0.045 * s, -0.33 - 0.05 * pump, -0.5);
      h.rot.set(-0.9, 0.3 * s, -0.25 * s);
      h.curl = 0.15;
      h.pole.set(s, -0.7, 0.2);
    }
  }

  private fishing(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const t = this.clock;
    if (f.fishState === FISH_STATE.BITE) {
      // The bobber dipped: the rod tip jerks.
      const j = Math.sin(t * 40);
      R.pos.set(0.2 + 0.006 * j, -0.18 + 0.01 * j, -0.48);
      R.rot.copy(toolRot("rod", [-0.1, 0.25 + 0.15 * j, -0.96]));
    } else if (f.fishState === FISH_STATE.REEL) {
      // Rod up, the left hand cranks the reel.
      R.pos.set(0.18, -0.12, -0.45);
      R.rot.copy(toolRot("rod", [-0.15, 0.75, -0.65]));
      const c = t * 14;
      L.pos.set(0.07 + 0.025 * Math.cos(c), -0.2 + 0.025 * Math.sin(c), -0.46);
      L.rot.set(0, -0.6, Math.PI / 2);
      L.curl = 0.8;
    } else {
      R.pos.set(0.2, -0.19 + 0.006 * Math.sin(t * 1.7), -0.48);
      R.rot.copy(toolRot("rod", [-0.08, 0.38, -0.92]));
    }
    R.curl = 1;
  }

  private crawl(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const moving = clamp01(f.speed / 0.6);
    const ph = this.clock * 4.5;
    const r = Math.max(0, Math.sin(ph)) * moving;
    const l = Math.max(0, -Math.sin(ph)) * moving;
    R.pos.set(0.17, -0.36 + 0.03 * r, -0.42 - 0.12 * r);
    L.pos.set(-0.17, -0.36 + 0.03 * l, -0.42 - 0.12 * l);
    R.rot.set(-1.2, 0.25, -0.15);
    L.rot.set(-1.2, -0.25, 0.15);
    R.curl = 0.35 + 0.3 * (1 - r);
    L.curl = 0.35 + 0.3 * (1 - l);
    R.pole.set(1, 0.2, 0.4);
    L.pole.set(-1, 0.2, 0.4);
  }

  private swim(f: FpArmsFrame): void {
    const moving = clamp01(f.speed / 1.5);
    const rate = 0.75 + 0.4 * moving;
    const u = (this.clock * rate) % 1;
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      const s = side === 0 ? 1 : -1;
      // Breaststroke: reach forward together, sweep out, pull back in under the chin.
      let x: number;
      let y: number;
      let z: number;
      if (u < 0.35) {
        const k = easeInOut(u / 0.35);
        x = 0.05 + 0.03 * k;
        y = -0.2 + 0.03 * k;
        z = -0.32 - 0.26 * k;
      } else if (u < 0.7) {
        const k = easeInOut((u - 0.35) / 0.35);
        x = 0.08 + 0.26 * k;
        y = -0.17 - 0.04 * k;
        z = -0.58 + 0.16 * k;
      } else {
        const k = easeInOut((u - 0.7) / 0.3);
        x = 0.34 - 0.29 * k;
        y = -0.21 + 0.01 * k;
        z = -0.42 + 0.1 * k;
      }
      const amp = 0.35 + 0.65 * moving;
      h.pos.set(s * (0.12 + (x - 0.12) * amp), -0.2 + (y + 0.2) * amp, -0.45 + (z + 0.45) * amp);
      h.rot.set(-0.2, 0.5 * s, (-0.9 + (u > 0.35 && u < 0.7 ? -0.6 : 0)) * s);
      h.curl = 0.12;
    }
  }

  /** One gesture's targets into `clip` (starts as a copy of the base). */
  private gesture(r: FpRun): void {
    const [R, L] = this.clip;
    const t = r.t;
    switch (r.g) {
      case "throw": {
        if (r.item !== "" && holdClass(r.item) === "big") {
          const k = easeOutCubic(seg(t, 0, 0.14));
          R.pos.lerp(_a.set(0.14, -0.12, -0.62), k);
          L.pos.lerp(_a.set(-0.14, -0.12, -0.62), k);
          break;
        }
        const k = easeOutCubic(seg(t, 0, 0.12));
        R.pos.lerp(_a.set(0.12, -0.14, -0.62), k);
        R.rot.lerp(_a.set(-0.5, 0.35, -0.5), k);
        R.curl = 0.1;
        R.pole.set(1, -0.4, 0.3);
        break;
      }
      case "toss": {
        const back = easeOutCubic(seg(t, 0, 0.12));
        const fwd = easeOutCubic(seg(t, 0.12, 0.28));
        R.pos.lerp(_a.set(0.2, -0.33, -0.33), back * (1 - fwd));
        R.pos.lerp(_a.set(0.12, -0.13, -0.6), fwd);
        R.rot.lerp(ROT_PALM_UP, back);
        R.curl = 0.15;
        break;
      }
      case "use": {
        if (r.item === "torch") {
          this.swingTorch(t);
          break;
        }
        const jab = t < 0.11 ? easeOutCubic(t / 0.11) : 1 - easeInOut((t - 0.11) / 0.25);
        R.pos.lerp(_a.set(0.08, -0.1, -0.62), jab);
        R.rot.lerp(_a.set(0, 0.15, -0.2), jab);
        R.curl = 1;
        break;
      }
      case "swing":
        this.swingTorch(t);
        break;
      case "eat": {
        const k = easeOutBack(seg(t, 0, 0.22)) * (1 - easeInOut(seg(t, 0.72, 0.9)));
        const chomp = Math.abs(Math.sin(t * 15)) * seg(t, 0.2, 0.3) * (1 - seg(t, 0.7, 0.72));
        R.pos.lerp(_a.set(0.03, -0.16 + 0.012 * chomp, -0.2), k);
        R.rot.lerp(_a.set(0.5, 0.6, Math.PI - 0.6), k);
        R.curl = 0.35;
        break;
      }
      case "gather": {
        const b = bump(t / 0.3);
        R.pos.z += 0.04 * b;
        L.pos.z += 0.04 * b;
        R.curl = L.curl = 1;
        break;
      }
      case "catch": {
        const open = easeOutBack(seg(t, 0, 0.08));
        const pull = easeInOut(seg(t, 0.14, 0.45));
        R.pos.lerp(_a.set(0.13, -0.12, -0.52), open * (1 - pull));
        L.pos.lerp(_a.set(-0.13, -0.12, -0.52), open * (1 - pull));
        R.rot.lerp(_a.set(0.3, 0.6, -1.3), open);
        L.rot.lerp(_a.set(0.3, -0.6, 1.3), open);
        R.curl = L.curl = t < 0.12 ? 0 : 1;
        break;
      }
      case "cast": {
        const back = easeOutCubic(seg(t, 0, 0.3));
        const flick = easeOutCubic(seg(t, 0.32, 0.5));
        R.pos.lerp(_a.set(0.24, 0.0, -0.26), back * (1 - flick));
        R.pos.lerp(_a.set(0.16, -0.17, -0.56), flick);
        R.rot.copy(toolRot("rod", [-0.1, 0.4 + 0.55 * back * (1 - flick), -0.9 + 1.2 * back * (1 - flick)]));
        R.curl = 1;
        break;
      }
      case "reel": {
        const yank = easeOutBack(seg(t, 0, 0.2));
        R.pos.lerp(_a.set(0.2, -0.03, -0.38), yank);
        R.rot.copy(toolRot("rod", [-0.15, 0.6 + 0.3 * yank, -0.78 + 0.4 * yank]));
        R.curl = 1;
        break;
      }
      case "hurt": {
        const k = easeOutBack(seg(t, 0, 0.1));
        R.pos.lerp(_a.set(0.13, -0.15, -0.38), k);
        L.pos.lerp(_a.set(-0.13, -0.15, -0.38), k);
        R.curl = L.curl = 1;
        break;
      }
      case "place":
      case "deliver": {
        const k = easeOutCubic(seg(t, 0, 0.22));
        const y = r.g === "place" ? -0.32 : -0.19;
        R.pos.lerp(_a.set(0.12, y, -0.6), k);
        L.pos.lerp(_a.set(-0.12, y, -0.6), k);
        R.rot.lerp(_a.set(-0.4, 0.2, -0.4), k);
        L.rot.lerp(_a.set(-0.4, -0.2, 0.4), k);
        R.curl = L.curl = 0.1;
        break;
      }
    }
  }

  private swingTorch(t: number): void {
    const R = this.clip[0];
    const s = easeInOut(seg(t, 0, 0.36));
    R.pos.set(0.36 - 0.55 * s, -0.06 - 0.1 * bump(s), -0.42 - 0.08 * bump(s));
    R.rot.copy(toolRot("torch", [-0.9 * s + 0.4, 0.75, -0.55]));
    R.curl = 1;
  }

  /** Springs + IK, then each hand's own orientation and finger curl. */
  private solve(dt: number): void {
    for (const arm of this.arms) {
      const h = this.base[arm.side];
      arm.shoulder.position.copy(SHOULDER[arm.side]);
      limitReach(arm.shoulder.position, h.pos, REACH, 0.95, 0.12);
      if (!this.init) {
        arm.cur.copy(h.pos);
        arm.pole.copy(h.pole);
        arm.rot.copy(h.rot);
        arm.curl = h.curl;
        arm.vel.set(0, 0, 0);
        arm.rotVel.set(0, 0, 0);
        arm.curlVel[0] = 0;
      } else {
        followV(arm.cur, h.pos, arm.vel, 22, dt);
        followV(arm.pole, h.pole, arm.poleVel, 12, dt);
        // Shortest way around for the angles.
        _a.set(arm.rot.x + wrapAngle(h.rot.x - arm.rot.x), arm.rot.y + wrapAngle(h.rot.y - arm.rot.y), arm.rot.z + wrapAngle(h.rot.z - arm.rot.z));
        followV(arm.rot, _a, arm.rotVel, 18, dt);
        arm.curl = follow(arm.curl, h.curl, arm.curlVel, 0, 24, dt);
      }
      _w.copy(arm.cur);
      limitReach(arm.shoulder.position, _w, REACH, 0.95, 0.12);
      const bend = solveArm(arm.shoulder.position, _w, arm.pole, UPPER, FORE, _q);
      arm.shoulder.quaternion.copy(_q);
      arm.elbow.rotation.set(bend, 0, 0);
      // Hand in sway space = shoulder · elbow bend; the hand undoes it and takes its own rotation.
      _q2.setFromAxisAngle(_X, bend);
      _q.multiply(_q2).invert();
      arm.hand.quaternion.copy(_q).multiply(_q2.setFromEuler(_e.set(arm.rot.x, arm.rot.y, arm.rot.z, "YXZ")));
      const curl = clamp01(arm.curl);
      if (arm.handMesh.morphTargetInfluences) arm.handMesh.morphTargetInfluences[0] = curl;
      if (arm.handInk.morphTargetInfluences) arm.handInk.morphTargetInfluences[0] = curl;
    }
    this.init = true;
  }

  /** Held item visibility (released during throws), eaten food in the hand, the torch flame. */
  private updateItems(f: FpArmsFrame): void {
    let released = false;
    let eating: InvKind = "";
    for (const r of this.runs) {
      const at = RELEASE_AT[r.g];
      if (at !== undefined && r.t >= at) released = true;
      if (r.g === "eat") eating = r.item;
    }
    if (this.held) this.held.visible = !released && !(eating !== "" && eating === this.heldKind);
    // Food being eaten (it may already be gone from the inventory).
    if (eating !== this.foodKind) {
      if (this.food) this.food.visible = false;
      this.food = null;
      this.foodKind = eating;
      if (eating !== "") {
        const food = createHeldItem(eating, "fp");
        markOverlay(food);
        this.arms[0].palm.add(food);
        food.position.set(0, -ITEMS[eating].radius * food.scale.x * 0.9, 0);
        this.food = food;
      }
    }
    // Lit torch flicker (a burnt-out torch shows no flame).
    if (this.held && this.heldKind === "torch") flickerHeld(this.held, this.clock, f.torchLit);
  }

  /** Last frame seen (dev harness). */
  get frame(): FpArmsFrame | null {
    return this.lastFrame;
  }
}

/** Fade-in / fade-out envelope of a gesture of length `dur` (seconds). */
function envelope(t: number, dur: number, inT: number, outT: number): number {
  if (t <= 0 || t >= dur) return 0;
  if (inT > 0 && t < inT) return easeInOut(t / inT);
  if (outT > 0 && t > dur - outT) return easeInOut((dur - t) / outT);
  return 1;
}
