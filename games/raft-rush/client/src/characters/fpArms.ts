// First-person arms of the local tourist: the character's own sleeves (Kaptan's white uniform with navy-gold
// cuffs, Fenomen's pink short sleeves and gold bangles, Amca's Hawaiian print and wristwatch, the bride's
// opera gloves, the chef's rolled-up sleeves, the kid's armbands), the seat-colored all-inclusive wristband,
// skinned cartoon hands with real finger joints (fpHand.ts) and the held item in its first-person hold
// (fpHolds.ts). Attached to the camera and drawn on top of the world (the depth buffer is cleared right before
// them, so they never clip into trees or terrain). Wrist targets in camera space are solved from the FOV so the
// hands sit in the lower corners at any window shape, then followed by damped springs (a little follow-through),
// a quaternion spring for the hand rotation, per-joint finger springs and two-bone IK.
//
// Layers, in order: the hold rest + locomotion (walk counter-swing, sprint carry per item, swim, downed crawl)
// + idle (breath, micro-noise, settling, fidgets) + continuous states (charge wind-up per item, hold-E loops locked
// to the channel progress, fishing, puffer fuse, jellyfish at arm's length); then the keyframed one-shot clip
// (fpMotion.ts: throw / toss / use / eat / drink / gather / catch / cast / reel / swing / hurt / place / deliver,
// each with item variants, hit-stops and squeezes); then the item swap (holster, change at the bottom, equip
// with a pop); then the springs. The whole rig sways around a pivot between the shoulders (look lag with a soft
// overshoot, the walk bob locked to the camera bob, strafe lean, jump lift / landing dip), and held items get
// secondary motion (rod / spear whip, a fish flopping by its tail, a dangling boot, a wobbling jellyfish, the
// torch flame leaning). Owner: client-characters. Adapted from games/kasala/client/src/scene/characters/fpArms.ts.

import * as THREE from "three";
import { CHANNEL, CHARACTERS, FISH_STATE, HEAD_BOB_HZ, PALETTE, SPRINT_SPEED, WALK_SPEED } from "../../../shared/constants";
import { ITEM_KINDS, ITEMS } from "../../../shared/items";
import type { CharacterId, InvKind, ItemKind } from "../../../shared/types";
import type { FpArmsFrame, FpGesture } from "./Characters";
import { blendPose, clampPose, cupPose, FpHand, gripPose, HAND_DOF, type HandLook, type HandPose, handPose, type HandPoseName } from "./fpHand";
import { createFpHeldItem, fpAnchor, type FpHold, fpHold, type FpPoseRef, isFist, orientQ } from "./fpHolds";
import {
  BITES,
  CAUGHT,
  CHARGES,
  type ChargeName,
  type Clip,
  type ClipName,
  CLIPS,
  compile,
  type CompiledClip,
  copyTarget,
  DOWNED,
  EAT_CLIPS,
  eulerQ,
  evalTrack,
  FIDGETS,
  fistQ,
  type HandTarget,
  handTarget,
  lerpTarget,
  mirrorQ,
  POCKET,
  REVIVED,
  shaftQ,
  STOW,
  type StowClass,
  WATER_IN,
  WATER_OUT,
} from "./fpMotion";
import { setItemGlow } from "../fx/itemMeshes";
import { flickerHeld, heldTipWorld } from "./holds";
import { follow, followV, solveArm } from "./ik";
import { bodyMaterial, cylinderGeo, flowerGeo, latheGeo, mergePrims, overlayMaterial, type Prim, sphereGeo, torusGeo, trs, type V3 } from "./kit";
import { clamp, clamp01, easeOutBack, easeOutCubic, wrapAngle } from "./pose";
import { toonColor } from "../render/Toon";
import { mixHex } from "../util/color";

/** Upper arm / forearm lengths (m) and the full reach. */
const UPPER = 0.31;
const FORE = 0.33;
const REACH = UPPER + FORE;
/** Ink hull growth (m): ≈ 2–3 px at the rest distance (sleeves); the hands use a palm / finger split. */
const INK = 0.0024;
const HAND_INK = { palm: 0.0026, finger: 0.002 };
/** Hands are drawn a bit bigger than life (cartoon). */
const HAND = 1.18;
/** Render order of the overlay (every group in the subtree gets it as its group order). */
export const FP_ORDER = 9_000_000;
/** Shoulders in camera space (+x right, +y up, −z forward): low, so the forearms rise from the bottom corners at
 * about 58° (instead of entering flat like pipes) and every clip key stays within 98% of the reach. */
const SHOULDER: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.17, -0.36, 0.03), new THREE.Vector3(-0.17, -0.37, 0.03)];
/** Rest spots on screen (NDC) and depth. */
const REST_NDC: readonly [readonly [number, number], readonly [number, number]] = [
  [0.5, -0.57],
  [-0.62, -0.76],
];
const REST_DEPTH = 0.44;
const REST_MAX_X = 0.3;
/** The viewmodel's own framing (deg), whatever the camera FOV. */
const VIEW_FOV = 75;
/** The right-hand rest x the clips were authored at (FOV 75, 16:10). */
const AUTHOR_REST_X = 0.27;
/** Pivot of the look sway, between the shoulders: the arms swing from the body instead of the image sliding. */
const PIVOT = new THREE.Vector3(0, -0.33, 0.03);
/** The two-handed carry spot (camera space): low, so a bundle covers little of the view. */
const BIG_AT = new THREE.Vector3(0, -0.3, -0.5);

type Side = 0 | 1;

const POLE_REST: readonly [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(0.7, -1, 0.15), new THREE.Vector3(-0.7, -1, 0.15)];
/** Empty hands at rest, per side (not mirrored): a 0.25 rad wrist bend off the forearm, the back of the hand ¾ to the view. */
const ROT_EMPTY: readonly [V3, V3] = [
  [0.549, 0.409, -0.265],
  [0.485, -0.328, 0.358],
];
const ROT_BIG: V3 = [-0.15, 0.15, -Math.PI / 2 + 0.2];
const FIST_DEFAULT: V3 = [-0.15, 0.7, -0.7];

/** Right-hand quaternion, mirrored for the left. */
function sideQ(q: THREE.Quaternion, side: Side): THREE.Quaternion {
  return side === 1 ? mirrorQ(q) : q;
}

/** Mass feel of what the hands carry: heavier = slower sway, deeper dips. */
function massOf(kind: InvKind): number {
  switch (kind) {
    case "":
      return 0.7;
    case "rope":
    case "fish_raw":
    case "fish_cooked":
    case "fish_golden":
    case "crab_raw":
    case "crab_cooked":
    case "jellyfish":
    case "puffer":
    case "boot":
      return 0.85;
    case "rod":
      return 0.9;
    case "torch":
      return 0.95;
    case "axe":
      return 1.15;
    case "kraken":
      return 1.3;
    case "fence":
    case "collector":
      return 1.5;
    case "raft_part":
      return 1.8;
    default:
      return 1;
  }
}

function stowClass(kind: InvKind): StowClass {
  if (kind === "") return "empty";
  if (kind === "torch") return "torch";
  const s = fpHold(kind).style;
  return s === "big" ? "big" : s === "tool" ? "tool" : "palm";
}

function consumable(kind: InvKind): boolean {
  return kind !== "" && (ITEMS[kind].food > 0 || ITEMS[kind].water > 0);
}

/**
 * Damped spring toward `target` (a little overshoot when zeta < 1), substepped so a long frame stays stable.
 * `omega` = stiffness (rad/s), `zeta` = damping ratio.
 */
function springV(cur: THREE.Vector3, vel: THREE.Vector3, target: THREE.Vector3, omega: number, zeta: number, dt: number): void {
  if (dt <= 0) return;
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  const k = omega * omega;
  const c = 2 * zeta * omega;
  for (let i = 0; i < steps; i++) {
    vel.x += (k * (target.x - cur.x) - c * vel.x) * h;
    vel.y += (k * (target.y - cur.y) - c * vel.y) * h;
    vel.z += (k * (target.z - cur.z) - c * vel.z) * h;
    cur.addScaledVector(vel, h);
  }
}

/** Scalar damped spring; returns the new value, the velocity lives in vel[i]. */
function spring1(cur: number, target: number, vel: Float32Array, i: number, omega: number, zeta: number, dt: number): number {
  if (dt <= 0) return cur;
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  let x = cur;
  let v = vel[i]!;
  for (let s = 0; s < steps; s++) {
    v += (omega * omega * (target - x) - 2 * zeta * omega * v) * h;
    x += v * h;
  }
  vel[i] = v;
  return x;
}

const _sqErr = new THREE.Quaternion();
const _sqInv = new THREE.Quaternion();
const _sqStep = new THREE.Quaternion();
const _sqAxis = new THREE.Vector3();

/** Quaternion spring: the angular velocity (rad/s, parent space) lives in `w`. Always takes the short way round. */
function springQ(q: THREE.Quaternion, w: THREE.Vector3, target: THREE.Quaternion, omega: number, zeta: number, dt: number): void {
  if (dt <= 0) return;
  const steps = Math.max(1, Math.ceil(dt * 120));
  const h = dt / steps;
  const k = omega * omega;
  const c = 2 * zeta * omega;
  for (let i = 0; i < steps; i++) {
    _sqErr.multiplyQuaternions(target, _sqInv.copy(q).invert());
    if (_sqErr.w < 0) _sqErr.set(-_sqErr.x, -_sqErr.y, -_sqErr.z, -_sqErr.w);
    const s = Math.sqrt(Math.max(0, 1 - _sqErr.w * _sqErr.w));
    const angle = 2 * Math.acos(clamp(_sqErr.w, -1, 1));
    const f = s < 1e-6 ? 2 : angle / s;
    w.x += (k * _sqErr.x * f - c * w.x) * h;
    w.y += (k * _sqErr.y * f - c * w.y) * h;
    w.z += (k * _sqErr.z * f - c * w.z) * h;
    const a = w.length() * h;
    if (a > 1e-7) {
      _sqStep.setFromAxisAngle(_sqAxis.copy(w).normalize(), a);
      q.premultiply(_sqStep).normalize();
    }
  }
}

/**
 * Keep a wrist target within reach, softly: untouched up to 90% of the reach, then eased toward 97% (a hard clamp
 * flattens the end of every strike); never closer than 0.12 m to the shoulder.
 */
function softReach(shoulder: THREE.Vector3, target: THREE.Vector3): void {
  _sr.subVectors(target, shoulder);
  const d = _sr.length();
  const a = 0.9 * REACH;
  const b = 0.07 * REACH;
  let k = d;
  if (d > a) k = a + b * Math.tanh((d - a) / b);
  else if (d < 0.12) k = 0.12;
  if (k !== d && d > 1e-6) target.copy(shoulder).addScaledVector(_sr, k / d);
}
const _sr = new THREE.Vector3();

/** Walk-bob multipliers (vertical, sideways, roll) per what the hands carry. */
const BOB_EMPTY = [1, 1, 1] as const;
const BOB_PALM = [1.1, 0.9, 1] as const;
const BOB_TOOL = [0.8, 0.8, 0.7] as const;
const BOB_TORCH = [0.9, 0.8, 0.8] as const;
const BOB_BIG = [1.5, 1.2, 2] as const;
const NONE: readonly never[] = [];

/** Soft clamp: linear near 0, saturating at ±c. */
function soft(x: number, c: number): number {
  return c * Math.tanh(x / c);
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
  /** Per-side hand details (rings, polish, stitches, a band-aid, a sticker, pudgy fingers). */
  handExtras?: (side: Side) => Partial<HandLook>;
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
  /** Ink hull geometry for parts authored at full size (lathes): used as-is instead of growing `size`. */
  hull?: THREE.BufferGeometry;
}

function lookFor(character: CharacterId): SleeveLook {
  const c = CHARACTERS[character].colors;
  switch (character) {
    case "kaptan":
      return {
        sleeve: c.outfit,
        cover: 1,
        skin: c.skin,
        hand: c.skin,
        forearm: c.skin,
        cuff: c.accent,
        cuffStripe: "#F2C14E",
        handScale: 1.05,
        // A gold signet ring on the right pinky.
        handExtras: (side) => (side === 0 ? { rings: [{ finger: 3, phalanx: 0, color: "#F2C14E", gem: "#1F3A73" }] } : {}),
      };
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
        // Long pink nails.
        handExtras: () => ({ nail: "#FF4FA0", nailLength: 1.3 }),
        extras: (p) => {
          // Gold bangles on the wrist.
          for (const [y, r] of [[-FORE + 0.045, 0.031], [-FORE + 0.068, 0.033]] as const) {
            p.fore.push({ geo: torusGeo(0.14, Math.PI * 2, 6, 22), at: [0, y, 0], rot: [0.12, 0, 0.08], size: [r, r, r], color: "#F2C14E", ink: false });
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
        // His wedding band on the left ring finger.
        handExtras: (side) => (side === 1 ? { rings: [{ finger: 2, phalanx: 0, color: "#F2C14E" }] } : {}),
        extras: (p, side) => {
          // Hibiscus prints on the sleeve; a gold wristwatch on the right wrist (the band is on the left).
          for (const [a, y] of [[0.4, -0.08], [2.2, -0.18], [-1.2, -0.25]] as const) {
            p.upper.push({ geo: flowerGeo(), at: [Math.sin(a) * 0.05, y, Math.cos(a) * 0.05], rot: [0, a, 0], size: [0.022, 0.022, 0.022], color: c.accent, ink: false });
          }
          if (side === 0) {
            p.fore.push({ geo: torusGeo(0.3, Math.PI * 2, 8, 24), at: [0, -FORE + 0.05, 0], rot: [0, 0, 0], size: [0.037, 0.03, 0.037 * FORE_FLAT], color: "#6B4226", ink: true });
            p.fore.push({ geo: cylinderGeo(1, 16), at: [0, -FORE + 0.05, 0.033], rot: [Math.PI / 2, 0, 0], size: [0.015, 0.007, 0.015], color: "#F2C14E", ink: true });
            p.fore.push({ geo: cylinderGeo(1, 16), at: [0, -FORE + 0.05, 0.0395], rot: [Math.PI / 2, 0, 0], size: [0.011, 0.001, 0.011], color: "#FFF8E0", ink: false });
          }
        },
      };
    case "gelin":
      return {
        sleeve: c.outfit,
        cover: 0.3,
        skin: c.skin,
        hand: "#FFFFFF",
        // The opera glove's forearm a shade off the hand, so the two read apart.
        forearm: "#F4F4F8",
        cuff: c.outfit,
        cuffStripe: c.accent,
        handScale: 0.95,
        // Glove stitching on the back, a little thicker fingers, the diamond on the left ring finger.
        handExtras: (side) => ({
          fingerThickness: 1.06,
          stitches: "#D8D8E2",
          rings: side === 1 ? [{ finger: 2, phalanx: 0, color: "#E8E8F0", gem: "#BFE9FF" }] : [],
        }),
      };
    case "sef":
      return {
        sleeve: c.outfit,
        cover: 0.72,
        skin: c.skin,
        hand: c.skin,
        forearm: c.skin,
        cuff: c.outfit,
        cuffStripe: c.accent,
        handScale: 1.12,
        // A kitchen band-aid on the left index.
        handExtras: (side) => (side === 1 ? { bandaid: [0, 1] } : {}),
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
        handScale: 0.88,
        // Pudgy little hands, a star sticker on the right one.
        handExtras: (side) => ({ fingerLength: 0.88, fingerThickness: 1.06, sticker: side === 0 ? "#FFD23F" : undefined }),
        extras: (p) => {
          // The inflatable armband rides low on the arm so it peeks into view, with its valve.
          p.fore.push({ geo: torusGeo(0.5, Math.PI * 2, 8, 24), at: [0, -FORE + 0.16, 0], rot: [0, 0, 0], size: [0.066, 0.085, 0.066], color: c.accent, ink: true });
          p.fore.push({ geo: sphereGeo(8), at: [0, -FORE + 0.16, -0.07], rot: [0, 0, 0], size: [0.011, 0.011, 0.011], color: "#FFFFFF", ink: false });
        },
      };
  }
}

/** Bare forearm radius (m) by distance below the elbow: a belly near the elbow, a slim neck at the wrist. */
const FORE_PROFILE: ReadonlyArray<readonly [number, number]> = [
  [0, 0.036],
  [0.08, 0.039],
  [0.19, 0.034],
  [0.28, 0.027],
  [0.318, 0.0245],
  [FORE, 0.025],
];
/** Front-to-back squash of the forearm's cross-section. */
const FORE_FLAT = 0.82;
/** A sleeve sits this much proud of the arm; a full sleeve stops this far above the wrist. */
const SLEEVE_PAD = 0.008;
const SLEEVE_GAP = 0.045;

function foreRadius(d: number): number {
  const p = FORE_PROFILE;
  if (d <= p[0]![0]) return p[0]![1];
  for (let i = 1; i < p.length; i++) {
    const [d1, r1] = p[i]!;
    const [d0, r0] = p[i - 1]!;
    if (d <= d1) return r0 + ((r1 - r0) * (d - d0)) / Math.max(1e-6, d1 - d0);
  }
  return p[p.length - 1]![1];
}

/** A forearm lathe from `from` to `to` m below the elbow (radius + pad), with its ink hull grown in metres. */
function lathePart(from: number, to: number, pad: number, color: string): FpPart {
  const ds = [from, ...FORE_PROFILE.map(([d]) => d).filter((d) => d > from + 1e-4 && d < to - 1e-4), to];
  const profile = (grow: number): [number, number][] => ds.map((d) => [foreRadius(d) + pad + grow, -d] as [number, number]).reverse();
  const key = `fore:${from.toFixed(3)}:${to.toFixed(3)}:${pad.toFixed(3)}`;
  return {
    geo: latheGeo(key, profile(0), 22),
    hull: latheGeo(`${key}:ink`, profile(INK), 22),
    at: [0, 0, 0],
    rot: [0, 0, 0],
    size: [1, 1, FORE_FLAT],
    color,
    ink: true,
  };
}

/** Sleeve + forearm parts of one arm. */
function armParts(look: SleeveLook, side: Side): ArmParts {
  const cover = clamp(look.cover, 0, 1) * REACH;
  const parts: ArmParts = { upper: [], fore: [] };
  const upperSleeve = Math.min(cover, UPPER);
  // Upper arm: shoulder ball, sleeve, bare skin below a short sleeve.
  parts.upper.push({ geo: sphereGeo(16), at: [0, 0, 0], rot: [0, 0, 0], size: [0.052, 0.052, 0.052], color: look.sleeve, ink: true });
  if (upperSleeve > 0.01) parts.upper.push({ geo: cylinderGeo(1.12, 20, true), at: [0, -upperSleeve, 0], rot: [0, 0, 0], size: [0.047, upperSleeve, 0.047], color: look.sleeve, ink: true });
  if (upperSleeve < UPPER - 0.01) {
    const len = UPPER - upperSleeve;
    parts.upper.push({ geo: cylinderGeo(1.1, 18, true), at: [0, -UPPER, 0], rot: [0, 0, 0], size: [0.039, len + 0.01, 0.039], color: look.skin, ink: true });
    parts.upper.push({ geo: torusGeo(0.3, Math.PI * 2, 6, 22), at: [0, -upperSleeve + 0.006, 0], rot: [0, 0, 0], size: [0.048, 0.03, 0.048], color: look.cuff ?? look.sleeve, ink: true });
  }
  // Forearm: a tapered lathe (a belly below the elbow, a slim neck at the wrist, flattened front to back), the
  // sleeve over it as a slightly fatter lathe, a cuff ring where it ends. A full sleeve stops short of the wrist so
  // the skin shows between the cuff and the hand.
  const foreSleeve = clamp(cover - UPPER, 0, FORE - SLEEVE_GAP);
  const sleeved = foreSleeve > 0.01;
  const elbowR = foreRadius(0) + (sleeved ? SLEEVE_PAD : 0);
  parts.fore.push({ geo: sphereGeo(16), at: [0, 0, 0], rot: [0, 0, 0], size: [elbowR, elbowR, elbowR * FORE_FLAT], color: sleeved ? look.sleeve : look.forearm, ink: true });
  if (sleeved) parts.fore.push(lathePart(0, foreSleeve, SLEEVE_PAD, look.sleeve));
  parts.fore.push(lathePart(sleeved ? foreSleeve - 0.01 : 0, FORE, 0, look.forearm));
  if (sleeved && look.cuff) {
    const y = -foreSleeve + 0.006;
    const r = foreRadius(foreSleeve) + SLEEVE_PAD + 0.004;
    const rolled = foreSleeve < FORE - SLEEVE_GAP - 0.02;
    const tube = rolled ? 0.42 : 0.3;
    parts.fore.push({ geo: torusGeo(tube, Math.PI * 2, 8, 24), at: [0, y, 0], rot: [0, 0, 0], size: [r, rolled ? r * 1.1 : r * 0.75, r * FORE_FLAT], color: look.cuff, ink: true });
    if (look.cuffStripe) parts.fore.push({ geo: torusGeo(0.16, Math.PI * 2, 6, 24), at: [0, y + 0.016, 0], rot: [0, 0, 0], size: [r * 0.98, r * 0.7, r * FORE_FLAT * 0.98], color: look.cuffStripe, ink: false });
  }
  look.extras?.(parts, side);
  return parts;
}

function partPrim(p: FpPart, grow: number): Prim {
  if (grow > 0 && p.hull) return { geometry: p.hull, matrix: trs(p.at, p.rot, p.size), color: new THREE.Color(p.color) };
  const size: V3 = [p.size[0] + grow, p.size[1] + grow, p.size[2] + grow];
  return { geometry: p.geo, matrix: trs(p.at, p.rot, size), color: new THREE.Color(p.color) };
}

/** Merged geometry of parts (optionally only the inked ones, grown into a hull). */
function bakeParts(parts: ReadonlyArray<FpPart>, hull: boolean): THREE.BufferGeometry {
  const list = hull ? parts.filter((p) => p.ink) : parts;
  const out = mergePrims(list.map((p) => partPrim(p, hull ? INK : 0)));
  out.computeBoundingSphere();
  return out;
}

interface ArmGeometry {
  upper: THREE.BufferGeometry;
  upperInk: THREE.BufferGeometry;
  fore: THREE.BufferGeometry;
  foreInk: THREE.BufferGeometry;
}

const geometryCache = new Map<string, ArmGeometry>();

function armGeometry(character: CharacterId, side: Side): ArmGeometry {
  const key = `${character}:${side}`;
  let g = geometryCache.get(key);
  if (!g) {
    const look = lookFor(character);
    const parts = armParts(look, side);
    g = {
      upper: bakeParts(parts.upper, false),
      upperInk: bakeParts(parts.upper, true),
      fore: bakeParts(parts.fore, false),
      foreInk: bakeParts(parts.fore, true),
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

// The skinned hands get their own material sources: a material shared between skinned and plain meshes makes three
// switch its program on every flip, several times a frame.
let handSkin: THREE.MeshToonMaterial | null = null;
function fpHandSkin(): THREE.MeshToonMaterial {
  if (!handSkin) {
    handSkin = bodyMaterial().clone();
    handSkin.name = "fp-hand-skin";
  }
  return handSkin;
}
let handInk: THREE.MeshBasicMaterial | null = null;
function fpHandInk(): THREE.MeshBasicMaterial {
  if (!handInk) {
    handInk = fpInk().clone();
    handInk.name = "fp-hand-ink";
  }
  return handInk;
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
  /** Item anchors in hand space (FpHand): on the gripping fist's shaft axis (placed per item), the cupped palm,
   * the open palm, the pinch, the hooked fingers. */
  grip: THREE.Group;
  cup: THREE.Group;
  tray: THREE.Group;
  pinch: THREE.Group;
  hook: THREE.Group;
  upper: THREE.Mesh;
  upperInk: THREE.Mesh;
  fore: THREE.Mesh;
  foreInk: THREE.Mesh;
  /** The skinned hand of the current character (per character, cached). */
  fingers: FpHand | null;
  cur: THREE.Vector3;
  vel: THREE.Vector3;
  q: THREE.Quaternion;
  angVel: THREE.Vector3;
  pole: THREE.Vector3;
  poleVel: THREE.Vector3;
  pose: HandPose;
  poseVel: Float32Array;
  /** Finger targets after the per-finger delay (the overlapping close / open). */
  poseIn: HandPose;
  /** Squeeze: extra finger flex on impacts / catches / landings, [value, velocity]. */
  squeeze: Float32Array;
  /** Impact squash time left (s). */
  squash: number;
}

/** A playing clip. */
interface Run {
  /** The gesture it plays, or null for a private clip (fidget, land, pocket). */
  g: FpGesture | null;
  name: ClipName | null;
  clip: CompiledClip;
  /** Clip clock (slowed inside hit-stops) and real time since the start. */
  t: number;
  age: number;
  /** Held item when it started. */
  item: InvKind;
  snap: [HandTarget, HandTarget];
  /** Next squeeze key per hand. */
  sqNext: [number, number];
  squashed: boolean;
  shoved: boolean;
  /** Fade-out time left after being cancelled (fidgets), -1 = playing. */
  fadeOut: number;
  caught: boolean;
  /** The active slot's count when it started (a released item waits for the server to take it off). */
  count0: number;
  /** Next hit-stop window, and the real time left in the one holding now. */
  stopIdx: number;
  stopLeft: number;
}

/** Item swap: holster what's in the hand (`down` class), change it at the bottom, equip the new one (`up` class). */
interface Swap {
  phase: "down" | "up";
  t: number;
  down: StowClass;
  up: StowClass;
  /** Equip time factor (a reload after a throw is quicker). */
  upScale: number;
  gripped: boolean;
}

/** Secondary motion of a held item about its hold point: how it swings, how stiff, how much. */
interface Dyn {
  /** out = sticks out of the fist's thumb side, hang = hangs from the fist's pinky side, down = dangles below. */
  mode: "out" | "hang" | "down";
  omega: number;
  zeta: number;
  /** rad per m/s² of hand acceleration. */
  gain: number;
  max: number;
}

const DYN: Partial<Record<ItemKind, Dyn>> = {
  rod: { mode: "out", omega: 11, zeta: 0.22, gain: 0.004, max: 0.3 },
  spear: { mode: "out", omega: 16, zeta: 0.35, gain: 0.002, max: 0.12 },
  axe: { mode: "out", omega: 20, zeta: 0.5, gain: 0.001, max: 0.05 },
  torch: { mode: "out", omega: 18, zeta: 0.45, gain: 0.0012, max: 0.06 },
  fish_cooked: { mode: "out", omega: 11, zeta: 0.35, gain: 0.003, max: 0.25 },
  water: { mode: "hang", omega: 7, zeta: 0.25, gain: 0.004, max: 0.2 },
};

/** Per-finger delays (s) of the overlapping action [index, middle, ring, pinky, thumb]: closing goes pinky first and the
 * thumb wraps last; opening lets go from the thumb and the index first (a thrown item rolls off the index). */
const CLOSE_TAU = [0.045, 0.03, 0.015, 0, 0.055] as const;
const OPEN_TAU = [0, 0.012, 0.024, 0.036, 0] as const;
const FIST = handPose("fist");

const _pose = new Float32Array(HAND_DOF);
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _qr = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, "YXZ");
const _X = new THREE.Vector3(1, 0, 0);
const _fwd = new THREE.Vector3();
const _cq = new THREE.Quaternion();
const _tmp = handTarget();

/** Camera-space rotation (pitch, yaw, roll) applied on top of a target's rotation. */
function turn(h: HandTarget, pitch: number, yaw: number, roll: number): void {
  if (pitch === 0 && yaw === 0 && roll === 0) return;
  h.q.premultiply(_qr.setFromEuler(_e.set(pitch, yaw, roll, "YXZ")));
}

/** Smoothstep. */
function smooth(u: number): number {
  const x = clamp01(u);
  return x * x * (3 - 2 * x);
}

/** Slow two-tone noise in about −1..1 (idle micro-motion). */
function noise(t: number, seed: number): number {
  return 0.6 * Math.sin(2 * Math.PI * 0.23 * t + seed) + 0.4 * Math.sin(2 * Math.PI * 0.61 * t + seed * 2.7);
}

/**
 * The forearm's direction (elbow → wrist) in hand space for a hold: a relaxed wrist bends a little; palm-up holds
 * extend it; a fist leans toward the pinky (ulnar), as wrists do around a handle.
 */
function foreLine(hold: FpHold | null, side: Side, out: THREE.Vector3): THREE.Vector3 {
  if (side === 0 && hold && (hold.style === "cup" || hold.style === "tray")) return out.set(0, -0.34, -0.94);
  if (side === 0 && isFist(hold)) return out.set(-0.257, 0.17, -0.95);
  return out.set(0, 0.247, -0.969);
}

/**
 * A hand pose for a hold reference: a named pose, or a family solved for the item — grip (around a handle of
 * `handle` m, the thumb wrapped or along), gripRod (the index lifted off for the line), cup (under a ball of
 * `ball` m). `k` = the hand's size (m per auth unit).
 */
function posePart(ref: FpPoseRef, thumb: "wrap" | "along", handle: number, ball: number, k: number, out: HandPose): HandPose {
  switch (ref) {
    case "grip":
      return gripPose(out, handle / k, thumb);
    case "gripRod":
      return gripPose(out, handle / k, "along", true);
    case "cup":
      return cupPose(out, ball / k);
    default:
      return out.set(handPose(ref)), out;
  }
}

/** A hold's hand pose with its tweaks (spread added to the fan; bias added to the bend of each finger). */
function holdPose(hold: FpHold, held: THREE.Object3D | null, k: number, out: HandPose): HandPose {
  const handle = (held?.userData.handle as number | undefined) ?? (hold.handle ?? 0.022) * hold.scale;
  const ball = hold.rs !== undefined ? hold.rs * k : ((held?.userData.ball as number | undefined) ?? 0.05);
  posePart(hold.pose, hold.thumb ?? "wrap", handle, ball, k, out);
  if (hold.spread) for (let f = 0; f < 4; f++) out[f * 4] = out[f * 4]! + hold.spread;
  const b = hold.bias;
  if (b) {
    for (let f = 0; f < 4; f++) {
      out[f * 4 + 1] = out[f * 4 + 1]! + b[f + 1]!;
      out[f * 4 + 2] = out[f * 4 + 2]! + b[f + 1]!;
    }
    out[19] = out[19]! + b[0];
    out[20] = out[20]! + b[0];
  }
  return out;
}

/** The camera-attached first-person arm rig (the FpArms facade in Characters.ts drives it). */
export class FpArmsRig {
  /** Child of the camera. */
  readonly root = new THREE.Group();
  private readonly sway = new THREE.Group();
  /** Hidden parking for items built ahead (prepare). */
  private readonly stash = new THREE.Group();
  private readonly bigAnchor = new THREE.Group();
  private readonly arms: [FpArm, FpArm];
  private readonly band: THREE.Mesh;
  private character: CharacterId | null = null;
  private seatColor = "#FFFFFF";
  private visible = true;
  private clock = 0;
  private init = false;
  /** Rest wrist points (camera space) this frame, and how far the window shape moved them from the authoring. */
  private readonly rest: [THREE.Vector3, THREE.Vector3] = [new THREE.Vector3(), new THREE.Vector3()];
  private aspectK = 1;
  /** The continuous pose, and the final targets (+ clip + swap). */
  private readonly base: [HandTarget, HandTarget] = [handTarget(), handTarget()];
  private readonly out: [HandTarget, HandTarget] = [handTarget(), handTarget()];
  private readonly evalT: [HandTarget, HandTarget] = [handTarget(), handTarget()];
  private run: Run | null = null;
  private fidget: Run | null = null;
  private lastPunchAt = -Infinity;
  private lastPunchLeft = false;
  private lastReelAt = -Infinity;
  // Sway (whole rig): look lag rotation about PIVOT, translation lag, the vertical jump / land and nod channels.
  private readonly swayRot = new THREE.Vector3();
  private readonly swayRotVel = new THREE.Vector3();
  private readonly swayRotTarget = new THREE.Vector3();
  private readonly swayPos = new THREE.Vector3();
  private readonly swayPosVel = new THREE.Vector3();
  private readonly swayPosTarget = new THREE.Vector3();
  /** [vertical offset, nod angle] and their velocities. */
  private readonly chan = new Float32Array(2);
  private readonly chanVel = new Float32Array(2);
  /** Look rates through two cascaded low-passes: [yaw1, yaw2, pitch1, pitch2]. */
  private readonly rate = new Float32Array(4);
  private prevYaw = Number.NaN;
  private prevPitch = 0;
  private viewPitch = 0;
  private readonly camPrev = new THREE.Vector3();
  private readonly camVel = new THREE.Vector3();
  private camVelZPrev = 0;
  private fwdAcc = 0;
  private camInit = false;
  private vy = 0;
  private airVy = 0;
  private wasGrounded = true;
  private wasDowned = false;
  private wasSwimming = false;
  private bobPhase = 0;
  private bobAmp = 0;
  private stepIdx = 0;
  private readonly sprint = new Float32Array(2);
  // Idle.
  private still = 0;
  private settle = 0;
  private nextFidget = 8;
  // Held items.
  private readonly heldCache = new Map<ItemKind, THREE.Group>();
  private held: THREE.Group | null = null;
  private heldKind: InvKind = "";
  /** First-person hold of the held kind (fpHolds.ts), null with empty hands. */
  private hold: FpHold | null = null;
  private food: THREE.Group | null = null;
  private foodKind: InvKind = "";
  private readonly foodCache = new Map<ItemKind, THREE.Group>();
  private swap: Swap | null = null;
  /** What the swap changes to at the bottom. */
  private pending: InvKind = "";
  /** The held item is out of the hand (released by a clip or being eaten). */
  private hidden = false;
  /** A released item stays out of the hand until the server's count drops below `count` (or `until` passes). */
  private relLatch: { kind: InvKind; count: number; until: number } | null = null;
  private prevCount = 0;
  // Item secondary motion: [angle a, angle b] + velocities; hand acceleration; flops / twitches / spins.
  private readonly dyn = new Float32Array(2);
  private readonly dynVel = new Float32Array(2);
  /** Dangling items: the pendulum's rotation of the holder and its angular velocity. */
  private readonly hangQ = new THREE.Quaternion();
  private readonly hangW = new THREE.Vector3();
  /** The camera's world rotation, inverted (world down into camera space). */
  private readonly camQInv = new THREE.Quaternion();
  private readonly handVelPrev = new THREE.Vector3();
  private readonly handAcc = new THREE.Vector3();
  private flopAt = -10;
  private nextFlop = 3;
  private twitchAt = -10;
  private nextTwitch = 4;
  private spinAt = -10;
  /** Flame lean [x, its velocity, z, its velocity]. */
  private readonly flameLean = new Float32Array(4);
  private bigTilt = 0;
  /** Where the hands' mid point is at rest on the bundle (the bundle moves with them from there), and their roll. */
  private readonly bigRest = new THREE.Vector3();
  private bigRoll0 = 0;
  private glow = 0;
  private glowColor = "#FFE27A";
  // Charge, fishing, channels.
  private wasFull = false;
  private readonly ding = new Float32Array(2);
  private nextJerk = 0;
  private jerkAt = -10;
  private nextTug = 0;
  private tugAt = -10;
  private nextJig = 4;
  private jigAt = -10;
  private chanPrev = -1;
  private chanRate = 0;
  private chanHit = -1;
  private lastFrame: FpArmsFrame | null = null;
  /** Skinned hands per character:side (made on first use). */
  private readonly hands = new Map<string, FpHand>();
  /** Dev harness: pin both hands to a pose / spot (camera space, right hand; the left mirrors). */
  debugHand: { pose: HandPoseName; pos?: V3; rot?: V3 } | null = null;

  constructor() {
    this.root.name = "fpArms";
    this.root.userData.rig = this;
    this.root.add(this.sway);
    this.sway.add(this.bigAnchor);
    this.stash.visible = false;
    this.root.add(this.stash);
    this.bigAnchor.position.copy(BIG_AT);
    const arms: FpArm[] = [];
    for (const side of [0, 1] as const) {
      const shoulder = new THREE.Group();
      const elbow = new THREE.Group();
      elbow.position.y = -UPPER;
      const hand = new THREE.Group();
      hand.position.y = -FORE;
      shoulder.add(elbow);
      elbow.add(hand);
      // Anchors (placed per character from its hand, see setCharacter); fpHolds.ts authors items in hand space.
      const grip = new THREE.Group();
      const cup = new THREE.Group();
      const tray = new THREE.Group();
      const pinch = new THREE.Group();
      const hook = new THREE.Group();
      hand.add(grip, cup, tray, pinch, hook);
      const mk = (): THREE.Mesh => new THREE.Mesh(new THREE.BufferGeometry(), bodyMaterial());
      const upper = mk();
      const upperInk = new THREE.Mesh(new THREE.BufferGeometry(), fpInk());
      const fore = mk();
      const foreInk = new THREE.Mesh(new THREE.BufferGeometry(), fpInk());
      shoulder.add(upper, upperInk);
      elbow.add(fore, foreInk);
      this.sway.add(shoulder);
      arms.push({
        side,
        shoulder,
        elbow,
        hand,
        grip,
        cup,
        tray,
        pinch,
        hook,
        upper,
        upperInk,
        fore,
        foreInk,
        fingers: null,
        cur: new THREE.Vector3(),
        vel: new THREE.Vector3(),
        q: eulerQ(ROT_EMPTY[side], new THREE.Quaternion()),
        angVel: new THREE.Vector3(),
        pole: POLE_REST[side].clone(),
        poleVel: new THREE.Vector3(),
        pose: new Float32Array(handPose("relaxed")),
        poseVel: new Float32Array(HAND_DOF),
        poseIn: new Float32Array(handPose("relaxed")),
        squeeze: new Float32Array(2),
        squash: 0,
      });
    }
    this.arms = arms as [FpArm, FpArm];
    // Seat-colored all-inclusive wristband on the left wrist.
    this.band = new THREE.Mesh(torusGeo(0.34, Math.PI * 2, 6, 22), toonColor(this.seatColor));
    this.band.name = "fpWristband";
    this.band.position.set(0, -FORE + 0.03, 0);
    this.band.scale.set(0.04, 0.04, 0.034);
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
      // Whatever was playing is stale by the time the arms come back.
      this.run = null;
      this.fidget = null;
      this.swap = null;
      this.relLatch = null;
    }
  }

  /**
   * Play a gesture (the clip variant follows what is in the hand). `kinds` = what a delivery took from the pockets
   * (the held item only leaves the hand when it is among them).
   */
  play(g: FpGesture, kinds?: readonly InvKind[]): void {
    // The server's fishResult repeats the strike the local click already played.
    if (g === "reel" && this.run?.name === "reel" && this.run.age < 0.6) return;
    const name = this.clipFor(g, kinds);
    if (!name) return;
    if (name === "punch" || name === "punchLeft") {
      this.lastPunchAt = this.clock;
      this.lastPunchLeft = name === "punchLeft";
    }
    if (g === "reel") this.lastReelAt = this.clock;
    this.start(g, name, CLIPS[name]);
  }

  clear(): void {
    this.run = null;
    this.fidget = null;
    this.relLatch = null;
  }

  /** Charge glow on the held item (applied with the item each frame; 0 = off). */
  setChargeGlow(amount: number, color: string): void {
    this.glow = Number.isFinite(amount) ? clamp01(amount) : 0;
    this.glowColor = color;
  }

  /** World center of the held item (the bundle for a two-handed carry), or the right grip with empty hands. */
  releaseWorld(out: THREE.Vector3): THREE.Vector3 {
    if (this.hold?.style === "big") return this.bigAnchor.getWorldPosition(out);
    const c = this.held?.userData.center as THREE.Vector3 | undefined;
    if (this.held && c) {
      this.held.updateWorldMatrix(true, false);
      return this.held.localToWorld(out.copy(c));
    }
    return this.arms[0].grip.getWorldPosition(out);
  }

  /**
   * Attach to the camera (hidden) and build ahead: the character's skinned hands, then one close-up item per call,
   * parked in a hidden stash so a shader prewarm sees their materials too. True while it built something.
   */
  prepare(camera: THREE.Camera, character: CharacterId): boolean {
    if (this.root.parent !== camera) camera.add(this.root);
    if (character !== this.character) {
      this.setCharacter(character);
      return true;
    }
    for (const kind of ITEM_KINDS) {
      if (this.heldCache.has(kind)) continue;
      this.stash.add(this.heldObject(this.heldCache, kind));
      return true;
    }
    return false;
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
    this.clock += dt;
    if (f.character !== this.character) this.setCharacter(f.character);
    if (!this.init) {
      // Coming into view (first person on, respawn): both hands rise from below.
      this.setHeld(f.count > 0 ? f.held : "");
      this.swap = { phase: "up", t: 0, down: "empty", up: "big", upScale: 0.9, gripped: false };
    }
    this.updateSwap(dt, f.count > 0 ? f.held : "", f);
    // The fish comes out of the water when the reel ends.
    if (this.init && this.heldKind === "rod" && this.lastFrame?.fishState === FISH_STATE.REEL && f.fishState === FISH_STATE.NONE) this.start("reel", "reelResult", CLIPS.reelResult);
    // Going down / getting back up / into and out of the water.
    if (this.init && f.downed !== this.wasDowned) this.start(null, null, f.downed ? DOWNED : REVIVED);
    else if (this.init && f.swimming !== this.wasSwimming && !f.downed) this.start(null, null, f.swimming ? WATER_IN : WATER_OUT);
    this.wasDowned = f.downed;
    this.wasSwimming = f.swimming;
    this.updateSway(dt, camera, f);
    this.solveRest(camera);
    this.basePose(f, dt);
    this.applyClips(dt, f);
    this.applySwap();
    if (this.debugHand) this.applyDebugHand(this.debugHand);
    this.solve(dt);
    this.updateItems(f, dt);
    this.prevCount = f.count;
    this.lastFrame = f;
  }

  /* ---------------------------------------------------------- clips */

  /** Which clip a gesture plays, from what is in the hand. */
  private clipFor(g: FpGesture, kinds?: readonly InvKind[]): ClipName | null {
    const kind = this.heldKind;
    const style = this.hold?.style;
    switch (g) {
      case "throw":
        if (style === "big") return "throwBig";
        if (kind === "spear") return "throwSpear";
        if (kind === "stone") return "throwStone";
        if (kind === "jellyfish") return "throwJelly";
        if (kind === "puffer") return "throwPuffer";
        return (this.lastFrame?.charge ?? 0) < 0.25 ? "throwTap" : "throwPalm";
      case "toss":
        return "toss";
      case "use":
        if (kind === "") return this.clock - this.lastPunchAt < 0.75 && !this.lastPunchLeft ? "punchLeft" : "punch";
        if (kind === "axe") return "chop";
        if (kind === "torch") return "swing";
        if (kind === "fish_raw" || kind === "fish_cooked" || kind === "fish_golden") return "fishSlap";
        return "bonk";
      case "swing":
        return "swing";
      case "eat":
        if (kind === "") return "nopeEmpty";
        if (!consumable(kind)) return "nopeItem";
        if (kind === "water") return "drinkGourd";
        if (kind === "coconut") return "drinkCoconut";
        if (kind === "fish_golden") return "eatGulp";
        return style === "tray" || style === "cup" ? "eatPalm" : "eatFist";
      case "gather":
        return kind === "axe" ? "gatherAxe" : "gatherHand";
      case "catch":
        return kind === "" ? "catch" : "catchLeft";
      case "cast":
        return "cast";
      case "reel":
        return "reel";
      case "hurt":
        return style === "big" ? "hurtBig" : kind !== "" ? "hurtHolding" : "hurt";
      case "place":
        return "place";
      case "deliver": {
        const gives = kind !== "" && (!kinds || kinds.includes(kind));
        if (kind === "") return "deliverEmpty";
        if (style === "big") return gives ? "deliverBig" : null;
        return gives ? "deliverHand" : "deliverOff";
      }
    }
  }

  /**
   * Start a clip from where the hands are now. The "run" slot holds gestures (and the private land / caught
   * clips); a new one replaces the running one and fades a fidget out. The "fidget" slot plays under it and
   * only when nothing else runs.
   */
  private start(g: FpGesture | null, name: ClipName | null, clip: Clip, slot: "run" | "fidget" = "run"): void {
    if (slot === "fidget" && this.run) return;
    const run: Run = {
      g,
      name,
      clip: compile(clip),
      t: 0,
      age: 0,
      item: this.heldKind,
      snap: [handTarget(), handTarget()],
      sqNext: [0, 0],
      squashed: false,
      shoved: false,
      fadeOut: -1,
      caught: false,
      count0: this.lastFrame?.count ?? 0,
      stopIdx: 0,
      stopLeft: 0,
    };
    for (const arm of this.arms) {
      const s = run.snap[arm.side];
      if (this.init) {
        s.pos.copy(arm.cur);
        s.q.copy(arm.q);
        s.pole.copy(arm.pole);
        s.pose.set(arm.pose);
      } else copyTarget(s, this.base[arm.side]);
    }
    if (slot === "fidget") {
      this.fidget = run;
      return;
    }
    this.run = run;
    if (this.fidget && this.fidget.fadeOut < 0) this.fidget.fadeOut = 0.15;
  }

  /** The clip layer: out = base, then the fidget, then the gesture on top. */
  private applyClips(dt: number, f: FpArmsFrame): void {
    copyTarget(this.out[0], this.base[0]);
    copyTarget(this.out[1], this.base[1]);
    // Anything happening cancels a fidget (it fades out).
    const fid = this.fidget;
    if (fid && fid.fadeOut < 0 && (f.speed > 0.3 || f.charge > 0 || f.channel >= 0 || Math.abs(this.rate[1]) + Math.abs(this.rate[3]) > 0.6)) fid.fadeOut = 0.15;
    this.fidget = this.advance(this.fidget, dt);
    this.run = this.advance(this.run, dt);
    // A carried bundle is rigid: until a clip lets go of it, both hands move together (by their mean offset), so
    // they keep their grip width instead of sliding along or into it.
    const run = this.run;
    if (this.hold?.style === "big" && (!run || run.clip.clip.release === undefined || run.t < run.clip.clip.release)) {
      const [R, L] = this.out;
      _a.subVectors(R.pos, this.base[0].pos).add(_b.subVectors(L.pos, this.base[1].pos)).multiplyScalar(0.5);
      R.pos.addVectors(this.base[0].pos, _a);
      L.pos.addVectors(this.base[1].pos, _a);
      // …and follow at the same rate, or the faster one runs ahead.
      R.omega = L.omega = Math.max(R.omega, L.omega);
    }
  }

  /** Advance one run and layer it onto `out`; returns null when it is over. */
  private advance(run: Run | null, dt: number): Run | null {
    if (!run) return null;
    const c = run.clip.clip;
    const stops = c.stop ?? NONE;
    let shake = 0;
    let hz = 0;
    if (run.stopLeft > 0) {
      // Hit-stop: the clip holds at contact for a fixed real time while the hand trembles, then skips the window.
      const s = stops[run.stopIdx - 1]!;
      run.stopLeft -= dt;
      shake = s[2] * Math.max(0, run.stopLeft) / Math.max(1e-3, s[1] - s[0]);
      hz = s[3];
      if (run.stopLeft <= 0) run.t = s[1];
    } else {
      run.t += dt;
      const s = stops[run.stopIdx];
      if (s && run.t >= s[0]) {
        run.t = s[0];
        run.stopLeft = s[1] - s[0];
        run.stopIdx++;
      }
    }
    run.age += dt;
    if (run.fadeOut >= 0) {
      run.fadeOut -= dt;
      if (run.fadeOut <= 0) return null;
    }
    if (run.t >= c.dur) return null;
    if (c.shove && !run.shoved) {
      run.shoved = true;
      this.swayRotVel.x += c.shove[0];
      this.swayRotVel.y += c.shove[1];
      this.swayRotVel.z += c.shove[2] * (Math.random() < 0.5 ? -1 : 1);
    }
    if (c.squash !== undefined && !run.squashed && run.t >= c.squash) {
      run.squashed = true;
      this.arms[0].squash = 0.06;
    }
    const w = run.fadeOut >= 0 ? clamp01(run.fadeOut / 0.15) : 1;
    for (const side of [0, 1] as const) {
      const tr = run.clip.tracks[side];
      if (!tr) continue;
      const e = this.evalT[side];
      copyTarget(e, this.out[side]);
      evalTrack(tr, run.t, run.snap[side], this.base[side], this.aspectK, e);
      while (run.sqNext[side] < tr.sq.length && tr.sq[run.sqNext[side]]!.t <= run.t) {
        this.squeezeHand(side, tr.sq[run.sqNext[side]]!.amt);
        run.sqNext[side]++;
      }
      if (shake > 0) {
        e.pos.x += shake * Math.sin(run.age * hz * Math.PI * 2);
        e.pos.y += shake * Math.sin(run.age * hz * Math.PI * 2 * 1.3 + 1);
      }
      for (const wb of c.wob ?? NONE) {
        if (run.t < wb[0] || run.t >= wb[1] || (wb[5] !== 2 && wb[5] !== side)) continue;
        const s = Math.sin((run.t - wb[0]) * wb[4] * Math.PI * 2);
        e.pos.x += wb[2] * s * (side === 0 ? 1 : -1);
        if (wb[3] !== 0) turn(e, 0, wb[3] * s * (side === 0 ? 1 : -1), 0);
      }
      lerpTarget(this.out[side], e, w);
    }
    return run;
  }

  private squeezeHand(side: Side, amt: number): void {
    const s = this.arms[side].squeeze;
    s[0] = Math.max(s[0]!, amt);
  }

  /** A catch succeeded (the catch event, or the item showing up in the hand): clap-cup onto it. */
  caught(): void {
    const run = this.run;
    if (!run || run.g !== "catch" || run.caught) return;
    this.start("catch", "caught", CAUGHT);
    this.run!.caught = true;
  }

  /* ---------------------------------------------------------- the swap */

  /**
   * Follow the wanted item: holster the current one (the hand dips out of view), change it at the bottom, equip
   * the new one. A thrown / tossed / placed / eaten last unit just leaves (consumed); a catch takes the item
   * straight into the hands; a fish just reeled in arrives from the water side; one more of the same kind is a
   * small pocket dip; another unit after a throw comes back up from below (reload, see updateItems).
   */
  private updateSwap(dt: number, wanted: InvKind, f: FpArmsFrame): void {
    const s = this.swap;
    if (s) {
      s.t += dt * (f.charge > 0 && s.phase === "up" ? 3 : 1);
      if (s.phase === "down" && s.t >= STOW[s.down].down) {
        this.setHeld(this.pending);
        this.swap = { phase: "up", t: 0, down: s.down, up: stowClass(this.pending), upScale: 1, gripped: false };
      } else if (s.phase === "up" && s.t >= STOW[s.up].up * s.upScale) this.swap = null;
    }
    const run = this.run;
    // A catch (or its clap-cup) is running: the item goes straight into the hands.
    const catching = run !== null && run.g === "catch";
    if (wanted === this.heldKind) {
      if (this.swap?.phase === "down") this.pending = wanted;
      else if (wanted !== "" && f.count > this.prevCount && this.prevCount > 0) {
        if (catching) this.caught();
        else this.start(null, null, POCKET, this.run ? "fidget" : "run");
      }
      return;
    }
    if (this.swap?.phase === "down") {
      this.pending = wanted;
      return;
    }
    if (catching && wanted !== "") {
      this.setHeld(wanted);
      this.swap = null;
      this.caught();
      return;
    }
    // The last unit left the hand (thrown / tossed / placed / delivered / eaten, or released and still waiting for
    // the server's count): no holster. A clip that lets go later keeps it in the hand until its release.
    const rel = run?.clip.clip.release;
    const eatingHeld = run !== null && run.name !== null && EAT_CLIPS.has(run.name);
    const releasing = run !== null && run.item === this.heldKind && (rel !== undefined || eatingHeld);
    const latched = this.relLatch !== null && this.relLatch.kind === this.heldKind;
    if (wanted === "" && (releasing || latched)) {
      if (!releasing || rel === undefined || run!.t >= rel) this.setHeld("");
      this.swap = null;
      return;
    }
    const down = stowClass(this.heldKind);
    let t0 = 0;
    if (this.swap?.phase === "up") {
      const st = STOW[this.swap.up];
      t0 = STOW[down].down * clamp01(1 - this.swap.t / (st.up * this.swap.upScale));
    }
    this.pending = wanted;
    this.swap = { phase: "down", t: t0, down, up: stowClass(wanted), upScale: 1, gripped: false };
  }

  /** The swap on top of the targets: down and out with the wrist tipped, the rise overshooting a hair. */
  private applySwap(): void {
    const s = this.swap;
    if (!s) return;
    const st = STOW[s.phase === "down" ? s.down : s.up];
    let w: number;
    let wr: number;
    if (s.phase === "down") {
      const u = clamp01(s.t / st.down);
      w = u * u;
      wr = w;
    } else {
      const dur = st.up * s.upScale;
      const u = clamp01(s.t / dur);
      w = 1 - easeOutBack(u);
      wr = 1 - easeOutCubic(Math.min(1, u / 0.75));
      if (!s.gripped && u >= 0.55) {
        s.gripped = true;
        this.squeezeHand(0, 0.15);
        if (st.both) this.squeezeHand(1, 0.15);
      }
    }
    for (const side of [0, 1] as const) {
      const h = this.out[side];
      const m = side === 0 ? 1 : -1;
      if (side === 1 && !st.both) {
        // A sympathetic dip of the other hand.
        h.pos.y -= 0.015 * w;
        h.pos.z += 0.01 * w;
        continue;
      }
      h.pos.x += st.pos[0] * w * m;
      h.pos.y += st.pos[1] * w;
      h.pos.z += st.pos[2] * w;
      turn(h, st.rot[0] * wr, st.rot[1] * wr * m, st.rot[2] * wr * m);
      if (s.phase === "down") blendPose(h.pose, h.pose, handPose("relaxed"), 0.6 * w);
    }
  }

  private applyDebugHand(d: NonNullable<FpArmsRig["debugHand"]>): void {
    for (const side of [0, 1] as const) {
      const h = this.out[side];
      const m = side === 0 ? 1 : -1;
      h.pose.set(handPose(d.pose));
      if (d.pos) h.pos.set(d.pos[0] * m, d.pos[1], d.pos[2]);
      if (d.rot) sideQ(eulerQ(d.rot, h.q), side);
    }
  }

  /* ---------------------------------------------------------- building */

  private fpHandFor(character: CharacterId, side: Side): FpHand {
    const key = `${character}:${side}`;
    let h = this.hands.get(key);
    if (!h) {
      const look = lookFor(character);
      const gloved = look.hand !== look.skin;
      const hand: HandLook = {
        color: look.hand,
        nail: gloved ? null : mixHex(look.hand, "#FFF3EC", 0.5),
        scale: HAND * look.handScale,
        ink: HAND_INK,
        ...look.handExtras?.(side),
      };
      h = new FpHand(key, hand, side === 0 ? -1 : 1, fpHandSkin(), fpHandInk());
      markOverlay(h.root);
      this.hands.set(key, h);
    }
    return h;
  }

  private setCharacter(character: CharacterId): void {
    this.character = character;
    for (const arm of this.arms) {
      const g = armGeometry(character, arm.side);
      arm.upper.geometry = g.upper;
      arm.upperInk.geometry = g.upperInk;
      arm.fore.geometry = g.fore;
      arm.foreInk.geometry = g.foreInk;
      if (arm.fingers) arm.fingers.root.visible = false;
      const fingers = this.fpHandFor(character, arm.side);
      if (fingers.root.parent !== arm.hand) arm.hand.add(fingers.root);
      fingers.root.visible = true;
      arm.fingers = fingers;
      fingers.gripPoint(0.011, arm.grip.position);
      arm.cup.position.copy(fingers.anchors.cup);
      arm.tray.position.copy(fingers.anchors.tray);
      arm.pinch.position.copy(fingers.anchors.pinch);
      arm.hook.position.copy(fingers.anchors.hook);
    }
  }

  private setHeld(kind: InvKind): void {
    if (kind === this.heldKind) return;
    this.heldKind = kind;
    if (this.held) this.held.visible = false;
    this.held = null;
    this.hold = kind === "" ? null : fpHold(kind);
    this.relLatch = null;
    this.dyn.fill(0);
    this.dynVel.fill(0);
    this.hangQ.identity();
    this.hangW.set(0, 0, 0);
    if (kind === "") return;
    const obj = this.heldObject(this.heldCache, kind);
    this.attach(obj, this.hold!);
    obj.visible = true;
    this.held = obj;
  }

  /** A first-person item object for `kind` from `cache` (made on first use, overlay materials). */
  private heldObject(cache: Map<ItemKind, THREE.Group>, kind: ItemKind): THREE.Group {
    let obj = cache.get(kind);
    if (!obj) {
      obj = createFpHeldItem(kind);
      markOverlay(obj);
      cache.set(kind, obj);
    }
    return obj;
  }

  /** Put an item object at its hold anchor (a gripped item's handle on the fist's shaft axis). */
  private attach(obj: THREE.Group, hold: FpHold): void {
    const R = this.arms[0];
    const at = fpAnchor(hold);
    const anchor = at === "big" ? this.bigAnchor : at === "grip" ? R.grip : R[at];
    if (at === "grip") R.fingers?.gripPoint(obj.userData.handle as number, R.grip.position);
    if (obj.parent !== anchor) anchor.add(obj);
    const off = obj.userData.at as THREE.Vector3 | undefined;
    if (off) obj.position.copy(off);
    else obj.position.set(0, 0, 0);
    obj.quaternion.identity();
  }

  /* ---------------------------------------------------------- sway */

  /**
   * The whole rig: look lag (low-passed look rates → a soft-clamped rotation about the pivot between the shoulders,
   * slightly underdamped so a flick overshoots), translation lag, strafe lean, the walk bob locked to the camera
   * bob, and the vertical / nod channels (jump lift, landing dip, footfalls, hurt shoves).
   */
  private updateSway(dt: number, camera: THREE.PerspectiveCamera, f: FpArmsFrame): void {
    // The predicted look when the frame has it (free of camera shake and recoil), else the camera's.
    camera.getWorldDirection(_fwd);
    const yaw = f.yaw !== undefined && Number.isFinite(f.yaw) ? f.yaw : Math.atan2(-_fwd.x, -_fwd.z);
    const pitch = f.pitch !== undefined && Number.isFinite(f.pitch) ? f.pitch : Math.asin(clamp(_fwd.y, -1, 1));
    camera.getWorldPosition(_a);
    if (Number.isNaN(this.prevYaw) || dt <= 0 || !this.camInit || !this.init) {
      this.prevYaw = yaw;
      this.prevPitch = pitch;
      this.camPrev.copy(_a);
      this.camInit = true;
    }
    const m = massOf(this.heldKind);
    const style = this.hold?.style ?? null;
    // Look rates through two cascaded low-passes (≈5 Hz): camera shake and recoil jitter drop out.
    const yawRaw = dt > 0 ? clamp(wrapAngle(yaw - this.prevYaw) / dt, -20, 20) : 0;
    const pitchRaw = dt > 0 ? clamp((pitch - this.prevPitch) / dt, -15, 15) : 0;
    this.prevYaw = yaw;
    this.prevPitch = pitch;
    this.viewPitch = pitch;
    const k1 = 1 - Math.exp(-dt / 0.032);
    const r = this.rate;
    r[0] = r[0]! + (yawRaw - r[0]!) * k1;
    r[1] = r[1]! + (r[0]! - r[1]!) * k1;
    r[2] = r[2]! + (pitchRaw - r[2]!) * k1;
    r[3] = r[3]! + (r[2]! - r[3]!) * k1;
    const yawRate = r[1]!;
    const pitchRate = r[3]!;
    // Eye velocity into camera space (teleports and respawns ignored), vertical speed.
    _w.subVectors(_a, this.camPrev).divideScalar(Math.max(dt, 1e-3));
    this.camPrev.copy(_a);
    if (_w.lengthSq() > 400) _w.set(0, 0, 0);
    this.vy += (_w.y - this.vy) * (1 - Math.exp(-dt / 0.03));
    this.camQInv.copy(camera.getWorldQuaternion(_cq)).invert();
    _w.applyQuaternion(this.camQInv);
    this.camVel.lerp(_w, 1 - Math.exp(-dt / 0.06));
    const acc = dt > 0 ? (this.camVel.z - this.camVelZPrev) / dt : 0;
    this.camVelZPrev = this.camVel.z;
    this.fwdAcc += (acc - this.fwdAcc) * (1 - Math.exp(-dt / 0.08));

    // Jump lift / landing dip (kicks into the vertical and nod channels).
    const ch = this.chan;
    const water = f.swimming || f.downed;
    let vertTarget = 0;
    let nodTarget = 0;
    if (!f.grounded && !water) {
      this.airVy = Math.min(this.airVy, this.vy);
      vertTarget = 0.012 * clamp01(-this.vy / 6);
      nodTarget = 0.03;
    }
    if (!f.grounded && this.wasGrounded && this.vy > 1.5 && !water) {
      this.chanVel[0] = this.chanVel[0]! - 0.3 * m;
      this.chanVel[1] = this.chanVel[1]! - 0.25;
    }
    if (f.grounded && !this.wasGrounded && !water) {
      const s = clamp(-this.airVy / 6.6, 0.15, 1.6);
      this.chanVel[0] = this.chanVel[0]! - 0.85 * s * m;
      this.chanVel[1] = this.chanVel[1]! - 0.5 * s;
      this.squeezeHand(0, 0.2 * Math.min(1, s));
      this.squeezeHand(1, 0.2 * Math.min(1, s));
    }
    if (f.grounded) this.airVy = 0;
    this.wasGrounded = f.grounded;

    // Walk bob on the camera's own clock (phase passed in, or the same formula), lagging its dip a little.
    const k = Math.min(1.6, Math.max(0, f.speed / WALK_SPEED));
    if (f.bobPhase !== undefined && Number.isFinite(f.bobPhase)) this.bobPhase = f.bobPhase;
    else this.bobPhase += dt * HEAD_BOB_HZ * Math.PI * 2 * (0.7 + 0.3 * Math.max(0.6, k));
    const moving = f.grounded && !f.swimming && !f.downed;
    this.bobAmp += ((moving ? k : 0) - this.bobAmp) * (1 - Math.exp(-8 * dt));
    const b = this.bobAmp * (1 - 0.6 * easeOutCubic(clamp01(f.charge)));
    const phi = this.bobPhase;
    const [my, mx, mr] = style === "big" ? BOB_BIG : this.heldKind === "torch" ? BOB_TORCH : isFist(this.hold) ? BOB_TOOL : this.hold ? BOB_PALM : BOB_EMPTY;
    const bobY = my * 0.011 * b * (1 - Math.cos(2 * phi - 0.6)) * 0.5 * (0.8 + 0.3 * m);
    const bobX = -mx * 0.006 * b * Math.sin(phi - 0.4);
    const bobRoll = mr * 0.025 * b * Math.sin(phi - 0.4);
    const bobYaw = style === "tool" ? 0.015 * b * Math.sin(phi) : 0;
    // A footfall at every camera dip.
    const step = Math.floor((2 * phi - Math.PI) / (Math.PI * 2));
    if (step !== this.stepIdx) {
      this.stepIdx = step;
      if (b > 0.1) this.chanVel[0] = this.chanVel[0]! - 0.08 * b * m;
    }
    ch[0] = spring1(ch[0]!, vertTarget, this.chanVel, 0, 13, 0.42, dt);
    ch[1] = spring1(ch[1]!, nodTarget, this.chanVel, 1, 11, 0.45, dt);

    // Look lag: the arms trail a turn and bank into it; a strafe leans them.
    const vx = this.camVel.x;
    const sm = Math.sqrt(m);
    const ty = -0.06 * sm * Math.tanh(yawRate / 4.5);
    this.swayRotTarget.set(-0.045 * sm * Math.tanh(pitchRate / 3.5), ty, 0.7 * ty - 0.04 * Math.tanh(vx / 4.6));
    const zeta = style === "big" ? 0.62 : style === "tool" ? 0.55 : 0.5;
    springV(this.swayRot, this.swayRotVel, this.swayRotTarget, 13 / Math.sqrt(m), zeta, dt);
    this.swayPosTarget.set(
      clamp(yawRate * 0.006, -0.03, 0.03) - 0.01 * Math.tanh(vx / 4.6),
      clamp(-pitchRate * 0.006, -0.03, 0.03),
      0.012 * Math.tanh(-this.fwdAcc / 10),
    );
    springV(this.swayPos, this.swayPosVel, this.swayPosTarget, 15, 0.7, dt);
    const sr = this.swayRot;
    this.sway.quaternion.setFromEuler(_e.set(soft(sr.x, 0.07) + ch[1]!, soft(sr.y, 0.09) + bobYaw, soft(sr.z, 0.07) + bobRoll, "YXZ"));
    // Rotate about the pivot: position = P − R·P + translation.
    _b.copy(PIVOT).applyQuaternion(this.sway.quaternion);
    this.sway.position.copy(PIVOT).sub(_b).add(this.swayPos);
    this.sway.position.x += bobX;
    this.sway.position.y += bobY + ch[0]!;
  }

  /**
   * The viewmodel keeps a fixed 75° framing whatever the camera FOV (settings, sprint widening, charge zoom): the
   * root's depth is scaled by tan(37.5°) / tan(fov/2), which projects exactly like a 75° camera. Wrist
   * rest points are the NDC rest spots at REST_DEPTH for that framing and the window's aspect.
   */
  private solveRest(camera: THREE.PerspectiveCamera): void {
    const tv = Math.tan(THREE.MathUtils.degToRad(VIEW_FOV) / 2);
    // Squashing depth projects like a 75° camera and keeps view-space outlines at a constant pixel width.
    this.root.scale.set(1, 1, tv / Math.tan(THREE.MathUtils.degToRad(clamp(camera.fov, 30, 120)) / 2));
    const th = tv * clamp(camera.aspect, 0.6, 2.6);
    for (const side of [0, 1] as const) {
      const [nx, ny] = REST_NDC[side];
      const x = clamp(nx * REST_DEPTH * th, -REST_MAX_X, REST_MAX_X);
      const y = clamp(ny * REST_DEPTH * tv, -0.3, -0.14);
      this.rest[side].set(x, y, -REST_DEPTH);
    }
    this.aspectK = clamp(this.rest[0].x / AUTHOR_REST_X, 0.8, 1.1);
  }

  /* ---------------------------------------------------------- the base pose */

  /** The continuous pose of both hands for this frame into `base`. */
  private basePose(f: FpArmsFrame, dt: number): void {
    const [R, L] = this.base;
    const hold = this.hold;
    const style = hold?.style ?? null;
    const big = style === "big";
    const fist = isFist(hold ?? null);
    const kind = this.heldKind;
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      h.pos.copy(this.rest[side]);
      eulerQ(ROT_EMPTY[side], h.q);
      h.pole.copy(POLE_REST[side]);
      h.pose.set(handPose("relaxed"));
      h.omega = 22;
    }
    // The off hand drops low when the right one is busy holding something.
    if (hold && !big) L.pos.y -= 0.03;

    if (f.downed) {
      this.crawl(f);
      this.idle(f, dt);
      return;
    }
    if (f.swimming) {
      this.swim(f);
      this.idle(f, dt);
      return;
    }

    // Hold rest (fpHolds.ts).
    if (hold) {
      R.pos.x += hold.hand[0] * this.aspectK;
      R.pos.y += hold.hand[1];
      R.pos.z += hold.hand[2];
      holdPose(hold, this.held, this.handK(0), R.pose);
      if (big) this.bigCarry();
      else if (fist) {
        shaftQ(hold.dir ?? FIST_DEFAULT, R.q, hold.wrap);
        if (kind === "torch" && f.torchLit) {
          R.pos.y += 0.035;
          R.pos.x += 0.01;
        }
      } else if (hold.rot) eulerQ(hold.rot, R.q);
    }
    // Looking down pulls the hands forward and up a little so the item stays in frame; looking up drops them.
    const sp = Math.sin(this.viewPitch);
    for (const h of this.base) {
      h.pos.y += -0.02 * Math.max(0, sp) + 0.015 * Math.max(0, -sp);
      h.pos.z -= 0.025 * Math.max(0, -sp);
    }
    this.idle(f, dt);
    this.locomotion(f, dt);
    this.itemPosture(f);
    if (f.charge > 0) this.charge(f);
    else this.wasFull = false;
    this.ding[0] = spring1(this.ding[0]!, 0, this.ding, 1, 30, 0.4, dt);
    R.pos.z += this.ding[0]!;
    R.pos.y += this.ding[0]! * 0.5;
    this.trackChannel(f, dt);
    if (f.channel >= 0 && f.channelKind === CHANNEL.GATHER) this.gatherLoop(f);
    else if (f.channel >= 0 && f.channelKind === CHANNEL.REVIVE) this.reviveLoop(f);
    if (kind === "rod" && f.fishState !== FISH_STATE.NONE) this.fishing(f);
  }

  /** Breath, micro-noise, settling after standing still for a while, and the idle fidgets. */
  private idle(f: FpArmsFrame, dt: number): void {
    const looking = Math.abs(this.rate[1]!) + Math.abs(this.rate[3]!) > 0.1;
    const busy = f.speed > 0.2 || looking || f.charge > 0 || f.channel >= 0 || f.downed || f.swimming || this.run !== null || this.swap !== null || f.fishState !== FISH_STATE.NONE;
    this.still = busy ? 0 : this.still + dt;
    if (busy) this.nextFidget = 6 + Math.random() * 5;
    const want = this.still > 1.5 ? 1 : 0;
    this.settle = want > this.settle ? Math.min(1, this.settle + dt / 0.6) : Math.max(0, this.settle - dt / 0.15);
    const s = this.settle;
    const t = this.clock;
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      const ph = (((t - side * 0.25) / 3.8) % 1 + 1) % 1;
      const br = (ph < 0.4 ? smooth(ph / 0.4) : 1 - smooth((ph - 0.4) / 0.6)) * (1 + 0.4 * s);
      h.pos.y += 0.0035 * br - 0.008 * s;
      h.pos.z -= 0.002 * br;
      h.pos.x += 0.0015 * noise(t, 1.3 + side * 4.1);
      h.pos.y += 0.0012 * noise(t, 2.9 + side * 3.3);
      turn(h, 0.012 * br, 0, 0.012 * noise(t, 0.7 + side * 5.2) * (side === 0 ? 1 : -1));
      // Finger micro-motion: open hands breathe a little; a grip only moves the thumb.
      const style = this.hold?.style;
      const gripping = this.hold !== null && (side === 0 ? style !== "cup" && style !== "tray" : style === "big");
      if (gripping) h.pose[19] = h.pose[19]! + 0.02 * Math.sin(t * 0.3 * Math.PI * 2 + side);
      else {
        for (let f = 0; f < 4; f++) {
          const n = 0.03 * Math.sin(t * 0.3 * Math.PI * 2 + f * 1.7 + side * 2.3);
          h.pose[f * 4 + 1] = h.pose[f * 4 + 1]! + n;
          h.pose[f * 4 + 2] = h.pose[f * 4 + 2]! + n * 0.8;
        }
      }
      if (side === 1 || !this.hold) blendPose(h.pose, h.pose, FIST, 0.04 * s);
    }
    if (s > 0.99 && !this.fidget && !this.run && this.still > this.nextFidget) {
      const clip = this.fidgetFor(f);
      if (clip) {
        this.start(null, null, clip, "fidget");
        if (clip === FIDGETS.regrip && this.heldKind === "spear") this.spinAt = this.clock;
      }
      this.nextFidget = this.still + 6 + Math.random() * 5;
    }
  }

  private fidgetFor(f: FpArmsFrame): Clip | null {
    const style = this.hold?.style;
    const kind = this.heldKind;
    const coin = Math.random() < 0.5;
    if (!this.hold) {
      if (coin) {
        if (this.character === "amca") return FIDGETS.watch;
        if (this.character === "sef") return FIDGETS.chefKiss;
        if (this.character === "fenomen") return FIDGETS.bangles;
        if (this.character === "kaptan" || this.character === "gelin") return FIDGETS.cuff;
      }
      return FIDGETS.fingers;
    }
    if (style === "big") return FIDGETS.hitch;
    if (kind === "torch") return f.torchLit ? FIDGETS.warm : FIDGETS.regrip;
    if (kind === "axe" && coin) return FIDGETS.edge;
    if (kind === "fish_cooked" || kind === "crab_cooked" || kind === "fish_golden") return FIDGETS.admire;
    if (isFist(this.hold)) return FIDGETS.regrip;
    return FIDGETS.weigh;
  }

  /** Walking counter-swing of empty hands, the sprint carry per item. */
  private locomotion(f: FpArmsFrame, dt: number): void {
    const [R, L] = this.base;
    const hold = this.hold;
    const style = hold?.style ?? null;
    const b = this.bobAmp;
    const phi = this.bobPhase;
    if (!hold && b > 0.01) {
      const s = Math.sin(phi);
      R.pos.z += 0.014 * b * s;
      L.pos.z -= 0.014 * b * s;
      turn(R, 0.06 * b * s, 0, 0);
      turn(L, -0.06 * b * s, 0, 0);
    }
    const run = f.sprinting && f.grounded && f.speed > WALK_SPEED * 1.05 ? clamp01((f.speed - WALK_SPEED) / (SPRINT_SPEED - WALK_SPEED)) : 0;
    this.sprint[0] = follow(this.sprint[0]!, run, this.sprint, 1, 8, dt);
    const k = clamp01(this.sprint[0]!);
    if (k < 0.001 || style === "big") return;
    this.pump(L, 1, phi + Math.PI, k);
    if (!hold) {
      this.pump(R, 0, phi, k);
      return;
    }
    const kind = this.heldKind;
    const carry = (p: V3, dir: V3 | null): void => {
      R.pos.lerp(_a.set(p[0] * this.aspectK, p[1], p[2]), k);
      if (dir) R.q.slerp(shaftQ(dir, _q), k);
      R.pos.z += 0.015 * k * Math.sin(phi);
    };
    if (kind === "spear") carry([0.22, -0.28, -0.42], [-0.25, 0.25, -0.93]);
    else if (kind === "axe") carry([0.25, -0.29, -0.38], [-0.35, 0.85, -0.2]);
    else if (kind === "rod") carry([0.24, -0.27, -0.38], [-0.15, 0.95, 0.05]);
    else if (kind === "torch") carry([0.27, -0.12, -0.46], null);
    else {
      // Football tuck.
      carry([0.22, -0.26, -0.36], null);
      turn(R, 0, 0, 0.4 * k);
    }
  }

  /** A sprinting fist pumping back and forth on the stride. */
  private pump(h: HandTarget, side: Side, phase: number, k: number): void {
    const u = (1 + Math.sin(phase)) / 2;
    const m = side === 0 ? 1 : -1;
    _a.set((0.27 + (0.21 - 0.27) * u) * m * this.aspectK, -0.27 + 0.12 * u, -0.36 - 0.15 * u);
    h.pos.lerp(_a, k);
    blendPose(h.pose, h.pose, FIST, 0.85 * k);
    turn(h, 0.35 * k * Math.sin(phase), 0, 0);
  }

  /** Item-specific postures: the jellyfish held at arm's length, the puffer about to blow, a fish flop in the hand. */
  private itemPosture(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const t = this.clock;
    const kind = this.heldKind;
    if (kind === "jellyfish") {
      R.pos.z -= 0.06;
      R.pos.x += 0.03;
      L.pos.lerp(_a.set(-0.2 * this.aspectK, -0.24, -0.42), 0.8);
      L.pose.set(handPose("splay"));
      // A zap every second: the fingers spring open for a moment.
      const z = (t % 1) / 1;
      if (z < 0.08) {
        blendPose(R.pose, R.pose, handPose("splay"), 0.6);
        R.pos.x += 0.02;
      }
      R.pos.x += 0.006 * Math.sin(t * 26);
      R.pos.y += 0.005 * Math.sin(t * 31);
    }
    if (kind === "puffer" && f.fuse >= 0) {
      const danger = 1 - clamp01(f.fuse);
      const amp = 0.003 + 0.018 * danger * danger;
      const hz = 30 + 40 * danger;
      R.pos.x += amp * Math.sin(t * hz);
      R.pos.y += amp * Math.sin(t * hz * 1.3 + 1);
      R.pos.z -= 0.08 * clamp01(danger * 1.5);
      if (danger > 0.55) {
        const w = clamp01((danger - 0.55) * 3);
        L.pos.lerp(_a.set(-0.12 * this.aspectK, -0.16, -0.4), w);
        L.q.slerp(mirrorQ(eulerQ([1.2, 0.6, -0.4], _q)), w);
        blendPose(L.pose, L.pose, handPose("splay"), w);
        L.pos.x += amp * Math.sin(t * hz + 2);
      }
    }
    // The hand reacts to a flopping fish a beat later.
    const sinceFlop = t - this.flopAt;
    if (sinceFlop > 0.06 && sinceFlop < 0.16) {
      R.pos.y -= 0.006;
      if (sinceFlop < 0.08) this.squeezeHand(0, 0.15);
    }
  }

  /**
   * Both hands on a carried bundle (fpHolds FpBig): each hand's anchor (hooked fingers, the grip axis around the
   * handle, the cupped palm) on its contact point. The bundle follows the hands from there (see updateItems).
   */
  private bigCarry(): void {
    const hold = this.hold!;
    const big = hold.big;
    this.bigRest.set(0, 0, 0);
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      const m = side === 0 ? 1 : -1;
      if (big) {
        eulerQ(big.rot[side], h.q);
        const k = this.handK(side);
        const handle = (big.handle?.[side] ?? 0.02) * hold.scale;
        posePart(big.pose[side], "wrap", handle, 0.05, k, h.pose);
        const fingers = this.arms[side].fingers;
        const ref = big.pose[side];
        if (fingers && ref === "grip") fingers.gripPoint(handle, _b);
        else if (fingers && (ref === "hook" || ref === "cup")) _b.copy(fingers.anchors[ref]);
        else _b.set(0, -0.02, -0.06);
        _b.applyQuaternion(h.q);
        orientQ(big.orient, _q);
        h.pos.set(...big.contacts[side]).multiplyScalar(hold.scale).applyQuaternion(_q).add(_a.set(...big.at)).sub(_b);
        h.pos.x += big.at[0] * (this.aspectK - 1);
      } else {
        h.pos.set(m * 0.17, BIG_AT.y - 0.01, BIG_AT.z + 0.06);
        sideQ(eulerQ(ROT_BIG, h.q), side);
        h.pose.set(handPose("hook"));
      }
      h.pole.set(m, -0.8, 0.3);
      this.bigRest.addScaledVector(h.pos, 0.5);
    }
    const [R, L] = this.base;
    this.bigRoll0 = Math.atan2(R.pos.y - L.pos.y, R.pos.x - L.pos.x);
  }

  /** The hand's size (m per auth unit) of a side. */
  private handK(side: Side): number {
    return this.arms[side].fingers?.scale ?? HAND;
  }

  /** Hold-to-throw wind-up per item (fpMotion CHARGES), with tension and a "ding" when it is full. */
  private charge(f: FpArmsFrame): void {
    const style = this.hold?.style ?? null;
    const kind = this.heldKind;
    const fist = isFist(this.hold);
    const name: ChargeName = style === "big" ? "big" : kind === "spear" ? "spear" : kind === "stone" ? "stone" : kind === "jellyfish" ? "jelly" : fist ? "fist" : "palm";
    const c = easeOutCubic(clamp01(f.charge));
    const clip = compile(CHARGES[name]);
    for (const side of [0, 1] as const) {
      const tr = clip.tracks[side];
      if (!tr) continue;
      copyTarget(_tmp, this.base[side]);
      evalTrack(tr, c, this.base[side], this.base[side], this.aspectK, _tmp);
      copyTarget(this.base[side], _tmp);
    }
    const t = this.clock;
    const full = f.charge >= 0.999;
    const buzz = 0.0015 * c * c + (full ? 0.0015 : 0);
    for (const side of style === "big" ? ([0, 1] as const) : ([0] as const)) {
      const h = this.base[side];
      h.pos.x += 0.004 * c * Math.sin(t * 1.3 * Math.PI * 2) + buzz * Math.sin(t * 22 * Math.PI * 2);
      h.pos.y += buzz * Math.sin(t * 22 * Math.PI * 2 * 1.31 + 1);
    }
    // The coconut cluster whirls on its rope as the arm winds up.
    if (kind === "coconut_ball") {
      const w = t * 3 * Math.PI * 2;
      this.base[0].pos.x += 0.03 * c * Math.cos(w);
      this.base[0].pos.z += 0.03 * c * Math.sin(w);
    }
    if (full && !this.wasFull) {
      this.ding[1] = this.ding[1]! + 0.5;
      this.squeezeHand(0, 0.15);
    }
    this.wasFull = full;
    if (style === "big") this.bigTilt = 0.25 * c;
  }

  /** The hold-E channel's length (s): from the frame, or estimated from how fast the progress moves. */
  private trackChannel(f: FpArmsFrame, dt: number): void {
    if (f.channel < 0) {
      this.chanPrev = -1;
      this.chanHit = -1;
      return;
    }
    if (this.chanPrev >= 0 && dt > 0 && f.channel > this.chanPrev) {
      const r = (f.channel - this.chanPrev) / dt;
      this.chanRate = this.chanRate > 0 ? this.chanRate + (r - this.chanRate) * (1 - Math.exp(-dt / 0.2)) : r;
    }
    this.chanPrev = f.channel;
  }

  private channelSec(f: FpArmsFrame): number {
    if (f.channelSec !== undefined && f.channelSec > 0) return f.channelSec;
    return this.chanRate > 0 ? clamp(1 / this.chanRate, 0.5, 4) : 2;
  }

  /**
   * Gathering, locked to the channel progress so the last hit lands at completion: the axe chops, by hand the
   * motion follows what comes out (berries are plucked, rope pulled hand over hand, stones pried, wood punched).
   */
  private gatherLoop(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const T = this.channelSec(f);
    const item = f.channelItem ?? "";
    const p = clamp01(f.channel);
    const k = this.aspectK;
    if (this.heldKind === "axe" && (item === "wood" || item === "")) {
      const n = Math.max(2, Math.round(2.5 * T));
      const u = (p * n) % 1;
      const hit = Math.floor(p * n);
      if (hit !== this.chanHit) {
        if (this.chanHit >= 0) this.squeezeHand(0, 0.2);
        this.chanHit = hit;
      }
      _a.set(0.07 * k, -0.25, -0.55);
      _b.set(0.28 * k, -0.05, -0.35);
      let w: number;
      if (u < 0.06) w = 0;
      else if (u < 0.55) w = easeOutCubic((u - 0.06) / 0.49);
      else if (u < 0.65) w = 1;
      else w = 1 - (((u - 0.65) / 0.35) ** 3);
      R.pos.lerpVectors(_a, _b, w);
      shaftQ([-0.3 * (1 - w), 0.15 + 0.83 * w, -0.94 + 1.06 * w], R.q);
      R.omega = u > 0.65 ? 60 : 30;
      if (u < 0.06) R.pos.x += 0.006 * Math.sin(this.clock * 35 * Math.PI * 2);
      L.pos.lerp(_a.set(-0.27 * k, -0.22, -0.45), 0.5 * w);
      return;
    }
    if (item === "berry" || (item === "" && T <= 1.2)) {
      // Pluck: pinch, twist off, pull back; the other hand cups below.
      const u = (p * 3) % 1;
      const reach = u < 0.35 ? easeOutCubic(u / 0.35) : u < 0.7 ? 1 - smooth((u - 0.35) / 0.35) : 0;
      R.pos.lerpVectors(_a.set(0.22 * k, -0.24, -0.42), _b.set(0.18 * k, -0.2, -0.56), reach);
      eulerQ([0.2, 0.3, -0.5 + (u > 0.35 && u < 0.7 ? 0.4 * smooth((u - 0.35) / 0.35) : 0)], R.q);
      R.pose.set(handPose(u > 0.3 && u < 0.75 ? "pinch" : "open"));
      L.pos.lerp(_a.set(-0.06 * k, -0.27, -0.44), 0.9);
      mirrorQ(eulerQ([0.3, 0.3, Math.PI - 0.3], L.q));
      L.pose.set(handPose("cup"));
      return;
    }
    if (item === "rope" || (item === "" && T <= 1.8)) {
      // Hand over hand: reach, grab, pull back with strain, let go.
      const n = Math.max(2, Math.round(2 * T));
      for (const side of [0, 1] as const) {
        const h = this.base[side];
        const m = side === 0 ? 1 : -1;
        const u = (p * n + (side === 1 ? 0.5 : 0)) % 1;
        const pull = u < 0.2 ? 0 : u < 0.6 ? easeOutCubic((u - 0.2) / 0.4) : 1 - smooth((u - 0.6) / 0.4);
        h.pos.lerpVectors(_a.set(0.11 * m * k, -0.2, -0.56), _b.set(0.14 * m * k, -0.26, -0.38), pull);
        if (u > 0.2 && u < 0.6) h.pos.x += 0.002 * Math.sin(this.clock * 18 * Math.PI * 2);
        sideQ(eulerQ([0.1, 0.3, -0.9], h.q), side);
        h.pose.set(handPose(u > 0.2 && u < 0.85 ? "fist" : "open"));
      }
      return;
    }
    if (item === "stone" || (item === "" && T <= 2.2)) {
      // Pry it loose with both hands, the wrists rolling out on each heave.
      const u = (p * 3) % 1;
      const pull = u < 0.45 ? easeOutCubic(u / 0.45) : 1 - smooth((u - 0.45) / 0.55);
      for (const side of [0, 1] as const) {
        const h = this.base[side];
        const m = side === 0 ? 1 : -1;
        h.pos.lerpVectors(_a.set(0.1 * m * k, -0.3, -0.56), _b.set(0.13 * m * k, -0.24, -0.42), pull);
        sideQ(eulerQ([-0.4, 0.25, -0.3 - 0.4 * pull], h.q), side);
        h.pose.set(handPose("claw"));
      }
      return;
    }
    // Punch the tree: alternating jabs, the last one with the right hand.
    const n = Math.max(2, Math.round(2.4 * T));
    const i = Math.min(n - 1, Math.floor(p * n));
    const u = (p * n) % 1;
    const side: Side = (n - 1 - i) % 2 === 0 ? 0 : 1;
    const h = this.base[side];
    const m = side === 0 ? 1 : -1;
    const jab = u < 0.4 ? -0.4 * easeOutCubic(u / 0.4) : u < 0.6 ? -0.4 + 1.4 * ((u - 0.4) / 0.2) ** 3 : 1 - smooth((u - 0.6) / 0.4);
    h.pos.lerp(_a.set(0.08 * m * k, -0.14, -0.53), clamp01(jab));
    if (jab < 0) h.pos.z -= 0.08 * jab;
    sideQ(eulerQ([0, 0.15, -0.25], h.q), side);
    h.pose.set(FIST);
    h.omega = u > 0.4 && u < 0.6 ? 60 : 30;
    if (i !== this.chanHit && u > 0.6) {
      this.chanHit = i;
      this.squeezeHand(side, 0.15);
    }
  }

  /** CPR: six pumps over the channel, fast press, slow release. */
  private reviveLoop(f: FpArmsFrame): void {
    const u = (clamp01(f.channel) * 6) % 1;
    const press = u < 0.2 ? (u / 0.2) ** 3 : 1 - easeOutCubic((u - 0.2) / 0.8);
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      const m = side === 0 ? 1 : -1;
      h.pos.set((side === 0 ? 0.03 : -0.01) * this.aspectK, (side === 0 ? -0.27 : -0.29) - 0.05 * press, side === 0 ? -0.5 : -0.51);
      if (press > 0.9) h.pos.x += 0.002 * Math.sin(this.clock * 40);
      sideQ(eulerQ([-0.9, 0.3, -0.25], h.q), side);
      h.pose.set(handPose("flat"));
      h.pole.set(m, -0.7, 0.2);
    }
  }

  /** Rod states: a bite jerks the tip, reeling cranks with the left hand against the fish's tugs, waiting jigs. */
  private fishing(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const t = this.clock;
    const k = this.aspectK;
    if (f.fishState === FISH_STATE.BITE) {
      if (t >= this.nextJerk) {
        this.jerkAt = t;
        this.nextJerk = t + 0.25 + Math.random() * 0.2;
        this.squeezeHand(0, 0.12);
        this.dynVel[0] = this.dynVel[0]! - 3;
      }
      const j = Math.exp(-(t - this.jerkAt) / 0.07);
      R.pos.set(0.2 * k, -0.18 - 0.02 * j + 0.003 * Math.sin(t * 12 * Math.PI * 2), -0.48);
      shaftQ([-0.1, 0.25 - 0.25 * j, -0.96], R.q);
      R.omega = 45;
    } else if (f.fishState === FISH_STATE.REEL) {
      if (t >= this.nextTug) {
        this.tugAt = t;
        this.nextTug = t + 0.5 + Math.random() * 0.4;
      }
      const tug = t - this.tugAt < 0.15 ? 1 : 0;
      R.pos.set(0.18 * k, -0.12 - 0.015 * tug, -0.45 - 0.01 * tug);
      shaftQ([-0.15, 0.75 - 0.2 * tug, -0.65 - 0.1 * tug], R.q);
      const c = t * 2.2 * Math.PI * 2;
      L.pos.set((0.08 + 0.025 * Math.cos(c)) * k, -0.21 + 0.025 * Math.sin(c), -0.45);
      mirrorQ(eulerQ([0, 0.6, -Math.PI / 2], L.q));
      L.pose.set(FIST);
    } else {
      if (t >= this.nextJig) {
        this.jigAt = t;
        this.nextJig = t + 3 + Math.random() * 3;
      }
      const g = t - this.jigAt;
      const jig = (g < 0.08 ? g / 0.08 : g < 0.2 ? 1 - (g - 0.08) / 0.12 : 0) + (g > 0.12 && g < 0.32 ? Math.max(0, 1 - Math.abs(g - 0.2) / 0.08) : 0);
      R.pos.set(0.2 * k, -0.19 + 0.006 * Math.sin(t * 1.7), -0.48);
      shaftQ([-0.08, 0.38 + 0.15 * jig, -0.92], R.q);
    }
    gripPose(R.pose, ((this.held?.userData.handle as number | undefined) ?? 0.018) / this.handK(0), "along", true);
  }

  private crawl(f: FpArmsFrame): void {
    const [R, L] = this.base;
    const moving = clamp01(f.speed / 0.6);
    const ph = this.clock * 4.5;
    const r = Math.max(0, Math.sin(ph)) * moving;
    const l = Math.max(0, -Math.sin(ph)) * moving;
    // Low in the view but on screen: the hands plant ahead and drag the body along.
    R.pos.set(0.17 * this.aspectK, -0.29 + 0.03 * r, -0.46 - 0.12 * r);
    L.pos.set(-0.17 * this.aspectK, -0.29 + 0.03 * l, -0.46 - 0.12 * l);
    eulerQ([-1.2, 0.25, -0.15], R.q);
    mirrorQ(eulerQ([-1.2, 0.25, -0.15], L.q));
    R.pose.set(handPose(r < 0.2 ? "splay" : "claw"));
    L.pose.set(handPose(l < 0.2 ? "splay" : "claw"));
    R.pole.set(1, 0.2, 0.4);
    L.pole.set(-1, 0.2, 0.4);
  }

  /** Breaststroke (paddle on the pull); a held item stays out of the water, a bundle is pushed like a float. */
  private swim(f: FpArmsFrame): void {
    const moving = clamp01(f.speed / 1.5);
    const rate = 0.75 + 0.4 * moving;
    const u = (this.clock * rate) % 1;
    const style = this.hold?.style ?? null;
    if (style === "big") {
      // Pushed along like a float board: the hands keep their grip, the bundle bobs with the kicks.
      this.bigCarry();
      const bob = 0.008 * Math.sin(this.clock * 7) + 0.03;
      for (const h of this.base) h.pos.y += bob;
      return;
    }
    for (const side of [0, 1] as const) {
      const h = this.base[side];
      const s = side === 0 ? 1 : -1;
      if (side === 0 && this.hold) {
        h.pos.set(0.2 * this.aspectK, -0.08 + 0.01 * Math.sin(u * Math.PI * 2), -0.42);
        holdPose(this.hold, this.held, this.handK(0), h.pose);
        if (this.hold.dir) shaftQ(this.hold.dir, h.q, this.hold.wrap);
        else if (this.hold.rot) eulerQ(this.hold.rot, h.q);
        continue;
      }
      let x: number;
      let y: number;
      let z: number;
      if (u < 0.35) {
        const k = smooth(u / 0.35);
        x = 0.05 + 0.03 * k;
        y = -0.2 + 0.03 * k;
        z = -0.32 - 0.26 * k;
      } else if (u < 0.7) {
        const k = smooth((u - 0.35) / 0.35);
        x = 0.08 + 0.26 * k;
        y = -0.17 - 0.04 * k;
        z = -0.58 + 0.16 * k;
      } else {
        const k = smooth((u - 0.7) / 0.3);
        x = 0.34 - 0.29 * k;
        y = -0.21 + 0.01 * k;
        z = -0.42 + 0.1 * k;
      }
      const amp = 0.35 + 0.65 * moving;
      h.pos.set(s * (0.12 + (x - 0.12) * amp), -0.2 + (y + 0.2) * amp, -0.45 + (z + 0.45) * amp);
      sideQ(eulerQ([-0.2, 0.5, -0.9 + (u > 0.35 && u < 0.7 ? -0.6 : 0)], h.q), side);
      h.pose.set(handPose(u > 0.35 && u < 0.7 ? "paddle" : u < 0.35 ? "open" : "relaxed"));
    }
  }

  /* ---------------------------------------------------------- springs + IK */

  /** Springs (position with a little follow-through, quaternion rotation, pole, fingers + squeeze), then IK. */
  private solve(dt: number): void {
    for (const arm of this.arms) {
      const h = this.out[arm.side];
      const holding = arm.side === 0 ? this.hold !== null : this.hold?.style === "big";
      arm.shoulder.position.copy(SHOULDER[arm.side]);
      _w.copy(h.pos);
      softReach(arm.shoulder.position, _w);
      if (!this.init) {
        arm.cur.copy(_w);
        arm.pole.copy(h.pole);
        arm.q.copy(h.q);
        arm.pose.set(h.pose);
        arm.poseIn.set(h.pose);
        arm.vel.set(0, 0, 0);
        arm.angVel.set(0, 0, 0);
        arm.poleVel.set(0, 0, 0);
        arm.poseVel.fill(0);
        arm.squeeze.fill(0);
      } else {
        springV(arm.cur, arm.vel, _w, h.omega, 0.85, dt);
        // The elbow goes where the hand's own forearm line points (no broken-looking wrists), blended with the pose's pole.
        foreLine(this.hold, arm.side, _b).applyQuaternion(arm.q).multiplyScalar(-FORE).add(arm.cur).sub(arm.shoulder.position).normalize();
        _w.copy(h.pole).normalize().lerp(_b, 0.6);
        followV(arm.pole, _w, arm.poleVel, 12, dt);
        springQ(arm.q, arm.angVel, h.q, h.omega * 1.2, 0.85, dt);
        // Fingers: each through its delay, then a spring per joint — a small flick when opening, critically damped
        // around a held item so it never closes into it.
        for (let f = 0; f < 5; f++) {
          const lo = f * 4;
          const hi = f < 4 ? lo + 4 : HAND_DOF;
          let want = 0;
          let have = 0;
          for (let i = lo; i < hi; i++) {
            want += h.pose[i]!;
            have += arm.poseIn[i]!;
          }
          const tau = (want > have ? CLOSE_TAU : OPEN_TAU)[f]!;
          const a = tau > 0 ? 1 - Math.exp(-dt / tau) : 1;
          const omega = f === 4 ? 28 : holding ? 40 : 32;
          const zeta = holding ? 1 : f === 4 ? 0.8 : 0.72;
          for (let i = lo; i < hi; i++) {
            arm.poseIn[i] = arm.poseIn[i]! + (h.pose[i]! - arm.poseIn[i]!) * a;
            arm.pose[i] = spring1(arm.pose[i]!, arm.poseIn[i]!, arm.poseVel, i, omega, zeta, dt);
          }
        }
        arm.squeeze[0] = spring1(arm.squeeze[0]!, 0, arm.squeeze, 1, 45, 0.5, dt);
      }
      _w.copy(arm.cur);
      softReach(arm.shoulder.position, _w);
      const bend = solveArm(arm.shoulder.position, _w, arm.pole, UPPER, FORE, _q);
      arm.shoulder.quaternion.copy(_q);
      arm.elbow.rotation.set(bend, 0, 0);
      // Hand in sway space = shoulder · elbow bend; the hand undoes it and takes its own rotation.
      _q2.setFromAxisAngle(_X, bend);
      _q.multiply(_q2).invert();
      arm.hand.quaternion.copy(_q).multiply(arm.q);
      // Squeeze: extra bend at the base and middle joints (half on the thumb), capped around a held item; then the
      // joints' anatomical ranges.
      const sq = clamp(arm.squeeze[0]!, -0.05, holding ? 0.06 : 0.25);
      _pose.set(arm.pose);
      for (let f = 0; f < 4; f++) {
        _pose[f * 4 + 1] = _pose[f * 4 + 1]! + sq;
        _pose[f * 4 + 2] = _pose[f * 4 + 2]! + sq;
      }
      _pose[19] = _pose[19]! + sq * 0.5;
      arm.fingers?.apply(clampPose(_pose));
      // Impact squash.
      if (arm.squash > 0) {
        arm.squash = Math.max(0, arm.squash - dt);
        const s = Math.sin((arm.squash / 0.06) * Math.PI) * 0.06;
        arm.hand.scale.set(1 + s, 1 - s, 1 + s);
      } else arm.hand.scale.set(1, 1, 1);
    }
    this.init = true;
  }

  /* ---------------------------------------------------------- items */

  /**
   * Held item visibility (out of the hand while a clip has released it or it is being eaten), the equip pop, the
   * food being eaten (it loses a chunk at every bite), the item's secondary motion, the torch flame, and the
   * two-handed bundle following the hands.
   */
  private updateItems(f: FpArmsFrame, dt: number): void {
    const run = this.run;
    const rel = run?.clip.clip.release;
    const released = run !== null && rel !== undefined && run.t >= rel && run.item === this.heldKind && run.item !== "";
    const eating = run !== null && run.name !== null && EAT_CLIPS.has(run.name) ? run.item : "";
    const gone = released || (eating !== "" && eating === this.heldKind);
    // Once out of the hand, it stays out until the server takes it off the slot (on a slow link the clip ends first).
    if (gone && run && !this.relLatch && f.count >= run.count0) this.relLatch = { kind: this.heldKind, count: run.count0, until: this.clock + 0.8 };
    const latch = this.relLatch;
    if (latch && (latch.kind !== this.heldKind || f.count < latch.count || this.clock > latch.until)) this.relLatch = null;
    // Downed: the hands are on the ground, the item is put away until the revive.
    const hidden = gone || this.relLatch !== null || f.downed;
    // Another unit of what was just thrown / eaten comes up from below.
    if (this.hidden && !hidden && this.held && !this.swap) {
      const c = stowClass(this.heldKind);
      this.swap = { phase: "up", t: 0, down: c, up: c, upScale: 0.8, gripped: false };
    }
    this.hidden = hidden;
    if (this.held) this.held.visible = !hidden;
    // Food being eaten (it may already be gone from the inventory).
    if (eating !== this.foodKind) {
      if (this.food) this.food.visible = false;
      this.food = null;
      this.foodKind = eating;
      if (eating !== "") {
        const food = this.heldObject(this.foodCache, eating);
        this.attach(food, fpHold(eating));
        food.visible = true;
        this.food = food;
      }
    }
    if (this.food && run) {
      let left = 1;
      if (run.name === "eatGulp") {
        // One big gulp: it swells, squashes and is gone.
        const g = run.t;
        left = g < 0.36 ? 1 : g < 0.4 ? 1 + 0.15 * ((g - 0.36) / 0.04) : g < 0.44 ? 1.15 - 0.55 * ((g - 0.4) / 0.04) : g < 0.48 ? 0.6 * (1 - (g - 0.44) / 0.04) : 0;
      } else if (run.name === "eatPalm" || run.name === "eatFist") {
        let bites = 0;
        for (const b of BITES) if (run.t >= b) bites++;
        left = run.t >= 0.78 && bites === 3 ? 0 : [1, 0.78, 0.56, 0.3][bites]!;
      }
      this.food.scale.setScalar((this.food.userData.scale as number) * left);
      // Only while the eaten kind is in the hand (a slot switch mid-bite takes it away with the holster).
      this.food.visible = left > 0.01 && (eating === this.heldKind || this.heldKind === "");
    }
    if (!this.held) return;
    // Equip pop: the new item grows in as it comes up.
    let pop = 1;
    const s = this.swap;
    if (s?.phase === "up") pop = 0.75 + 0.25 * easeOutBack(clamp01(s.t / (0.6 * STOW[s.up].up * s.upScale)));
    this.itemMotion(f, dt, pop);
    const mesh = this.held.children[0];
    if (mesh) setItemGlow(mesh, this.hidden ? 0 : this.glow, this.glowColor, this.clock);
    if (this.heldKind === "torch") {
      flickerHeld(this.held, this.clock, f.torchLit);
      this.leanFlame(dt);
    }
    // The bundle rides on both hands.
    if (this.hold?.style === "big") {
      const [R, L] = this.arms;
      const big = this.hold.big;
      // The bundle rides on the hands: its rest spot plus however far they moved off their rest.
      this.bigAnchor.position.addVectors(R.cur, L.cur).multiplyScalar(0.5).sub(this.bigRest);
      if (big) this.bigAnchor.position.add(_a.set(big.at[0] * this.aspectK, big.at[1], big.at[2]));
      else this.bigAnchor.position.add(BIG_AT);
      if (f.charge <= 0) this.bigTilt *= Math.exp(-8 * dt);
      this.bigAnchor.rotation.set(this.bigTilt + this.chan[1]! * 0.5, 0, clamp(Math.atan2(R.cur.y - L.cur.y, R.cur.x - L.cur.x) - this.bigRoll0, -0.3, 0.3));
    } else {
      this.bigAnchor.position.copy(BIG_AT);
      this.bigAnchor.rotation.set(0, 0, 0);
    }
  }

  /** Secondary motion of the held item about its hold point, driven by the hand's acceleration, plus its own life. */
  private itemMotion(f: FpArmsFrame, dt: number, pop: number): void {
    const obj = this.held!;
    const kind = this.heldKind as ItemKind;
    const R = this.arms[0];
    const t = this.clock;
    if (dt > 0) {
      _a.copy(R.vel).sub(this.handVelPrev).divideScalar(dt);
      this.handVelPrev.copy(R.vel);
      if (_a.lengthSq() > 1e6) _a.setLength(1000);
      this.handAcc.lerp(_a, 1 - Math.exp(-2 * Math.PI * 20 * dt));
    }
    // Into hand space (the anchor's frame).
    _a.copy(this.handAcc).applyQuaternion(_q.copy(R.q).invert());
    const d = DYN[kind];
    let ax = 0;
    let ay = 0;
    let az = 0;
    if (d) {
      let ta: number;
      let tb: number;
      if (d.mode === "out") {
        ta = d.gain * _a.y;
        tb = -d.gain * _a.z;
      } else if (d.mode === "hang") {
        ta = -d.gain * _a.y;
        tb = d.gain * _a.z;
      } else {
        ta = -d.gain * _a.x;
        tb = d.gain * _a.z;
      }
      this.dyn[0] = spring1(this.dyn[0]!, clamp(ta, -d.max, d.max), this.dynVel, 0, d.omega, d.zeta, dt);
      this.dyn[1] = spring1(this.dyn[1]!, clamp(tb, -d.max, d.max), this.dynVel, 1, d.omega, d.zeta, dt);
      const a = clamp(this.dyn[0]!, -d.max * 1.3, d.max * 1.3);
      const b = clamp(this.dyn[1]!, -d.max * 1.3, d.max * 1.3);
      if (d.mode === "down") {
        az = a;
        ax = b;
      } else {
        az = a;
        ay = b;
      }
    }
    let sx = 1;
    let sy = 1;
    let sz = 1;
    switch (kind) {
      case "fish_raw":
      case "fish_golden": {
        // A flop now and then: three wiggles, decaying.
        if (t >= this.nextFlop && !this.run) {
          this.flopAt = t;
          this.nextFlop = t + (kind === "fish_golden" ? 6 : 2.2 + Math.random() * 2.3);
        }
        const g = t - this.flopAt;
        if (g < 0.45) {
          const e = Math.exp(-g / 0.15);
          az += 0.45 * e * Math.sin(g * 7 * Math.PI * 2);
          ay += 0.3 * e * Math.sin(g * 7 * Math.PI * 2 + 1.2);
        }
        if (kind === "fish_golden") ax += 0.12 * Math.sin(t * 0.5 * Math.PI * 2);
        break;
      }
      case "crab_raw": {
        if (t >= this.nextTwitch) {
          this.twitchAt = t;
          this.nextTwitch = t + 3 + Math.random() * 3;
        }
        const g = t - this.twitchAt;
        if (g < 0.17) ay += 0.2 * Math.sin(g * 12 * Math.PI * 2);
        break;
      }
      case "kraken":
        az += 0.04 * Math.sin(t * 1.3 * Math.PI * 2);
        if (t >= this.nextTwitch) {
          this.twitchAt = t;
          this.nextTwitch = t + 3 + Math.random() * 2;
        }
        if (t - this.twitchAt < 0.4) ay += 0.04 * Math.sin((t - this.twitchAt) * 4 * Math.PI * 2);
        break;
      case "jellyfish": {
        const w = Math.sin(t * 9);
        sy = 1 + 0.06 * w;
        sx = sz = 1 - 0.03 * w;
        break;
      }
      case "puffer": {
        const danger = f.fuse >= 0 ? 1 - clamp01(f.fuse) : 0;
        const puff = 1 + 0.25 * danger * danger + 0.04 * danger * Math.sin(t * (2 + 4 * danger) * Math.PI * 2);
        sx = sy = sz = puff;
        break;
      }
      case "spear":
        // The fidget roll: one turn around the shaft (below).
        break;
      default:
        break;
    }
    obj.quaternion.setFromEuler(_e.set(ax, ay, az, "XYZ"));
    const tip = obj.userData.tip as THREE.Vector3 | null;
    if (kind === "spear" && tip && t - this.spinAt < 0.5) obj.quaternion.multiply(_q.setFromAxisAngle(_b.copy(tip).normalize(), smooth((t - this.spinAt) / 0.5) * Math.PI * 2));
    const dg = this.hold?.dangle;
    const hang = obj.userData.hang as THREE.Vector3 | undefined;
    if (dg && hang && dt > 0) {
      // World down in hand space: the item's middle swings toward it, within dg.max of its rest.
      _b.set(0, -1, 0).applyQuaternion(this.camQInv).applyQuaternion(_q2.copy(this.sway.quaternion).invert()).applyQuaternion(_q.copy(R.q).invert());
      _qr.setFromUnitVectors(hang, _b.normalize());
      const angle = 2 * Math.acos(clamp(Math.abs(_qr.w), -1, 1));
      if (angle > dg.max) _qr.slerp(_q.identity(), 1 - dg.max / angle);
      // The hand's acceleration kicks it: a pendulum lags behind its pivot (≈ a / length, softened).
      this.hangW.addScaledVector(_w.crossVectors(hang, _a), -6 * dt);
      springQ(this.hangQ, this.hangW, _qr, dg.hz * Math.PI * 2, dg.zeta, dt);
      obj.quaternion.premultiply(this.hangQ);
    }
    const base = (obj.userData.scale as number) * pop;
    obj.scale.set(base * sx, base * sy, base * sz);
  }

  /** The torch flame leans away from the way the hand moves and stretches when it moves fast. */
  private leanFlame(dt: number): void {
    const flame = this.held?.getObjectByName("flame");
    if (!flame || !flame.visible) return;
    const v = this.arms[0].vel;
    _a.copy(v).applyQuaternion(_q.copy(this.arms[0].q).invert());
    // The flame's local X tilts it toward hand ±Y, its local Z toward hand ±Z: it leans against the motion.
    this.flameLean[0] = follow(this.flameLean[0]!, clamp(-_a.y * 0.3, -0.6, 0.6), this.flameLean, 1, 9, dt);
    this.flameLean[2] = follow(this.flameLean[2]!, clamp(-_a.z * 0.3, -0.6, 0.6), this.flameLean, 3, 9, dt);
    flame.rotation.x = this.flameLean[0]!;
    flame.rotation.z += this.flameLean[2]!;
    flame.scale.y *= 1 + 0.5 * Math.min(1, v.length() / 4);
  }

  /** Last frame seen (dev harness). */
  get frame(): FpArmsFrame | null {
    return this.lastFrame;
  }
}
