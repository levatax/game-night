// Room dimensions, seat arcs and fixed anchors of the pavyon back room. Pure math, no three.js scene
// objects. Angles: φ is measured around +y from +z toward +x, so a point on the seat circle is
// (sin φ, 0, cos φ) · r. Seat 0 sits at the dealer's left (+x) and turn order runs clockwise seen from above
// (φ decreasing). Models face +z at yaw 0, so yaw = φ + π faces the table center.

import * as THREE from "three";

export const TABLE_TOP_Y = 0.78;
export const TABLE_RADIUS = 1.45;

/** Room box: x ∈ [−ROOM_HALF_X, ROOM_HALF_X], z ∈ [ROOM_BACK_Z, ROOM_FRONT_Z]. */
export const ROOM_HALF_X = 4.3;
export const ROOM_BACK_Z = -3.5;
export const ROOM_FRONT_Z = 4.6;
export const CEILING_Y = 3.5;
/** Ceiling beams hang this far down (the "low ceiling" read). */
export const BEAM_DROP = 0.24;

/** Chair (character floor point) radius from the table center. */
export const SEAT_RADIUS = TABLE_RADIUS + 0.52;
/** Money stack / revealed card row / name plate radii on the table top. */
export const STACK_RADIUS = 1.02;
export const STACK_SIDE = 0.24;
export const CARD_ROW_RADIUS = 0.6;
export const PLATE_RADIUS = 1.32;

/** Half-angle of the seat arc for n seated players (seat 0 at +A, last seat at −A). */
export function seatArc(n: number): number {
  if (n <= 2) return 1.12;
  if (n === 3) return 1.32;
  if (n === 4) return 1.5;
  if (n === 5) return 1.62;
  return 1.72;
}

/** φ of a seat. A single seat (count 1) sits straight in front of the dealer. */
export function seatAngle(seat: number, count: number): number {
  const n = Math.max(1, Math.min(6, Math.floor(count)));
  if (n === 1) return 0;
  const s = Math.max(0, Math.min(n - 1, Math.floor(seat)));
  const a = seatArc(n);
  return a - (2 * a * s) / (n - 1);
}

/** Outward unit direction for φ. */
export function dirOf(phi: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.sin(phi), 0, Math.cos(phi));
}

/** The seated player's right-hand direction (they face the center): (uz, 0, −ux). */
export function rightOf(phi: number, out = new THREE.Vector3()): THREE.Vector3 {
  return out.set(Math.cos(phi), 0, -Math.sin(phi));
}

// ------------------------------------------------------------------------------------------ anchors
export const DEALER_POS = new THREE.Vector3(0, 0, -(TABLE_RADIUS + 0.55));
export const DEALER_YAW = 0;

/** Card tower plinth in the middle of the felt. DECK_TOWER_H is the card tower's height above the plinth. */
export const PLINTH_H = 0.07;
export const PLINTH_TOP_Y = TABLE_TOP_Y + PLINTH_H;
export const DECK_TOWER_H = 0.1;
export const DECK_POS = new THREE.Vector3(0, PLINTH_TOP_Y + DECK_TOWER_H, 0);

/** Dealer-side dressing on the felt (Table.ts): brass ashtray, whiskey bottle and glass. */
export const ASHTRAY_POS = new THREE.Vector3(0.6, TABLE_TOP_Y, -1.12);
export const BOTTLE_POS = new THREE.Vector3(0.92, TABLE_TOP_Y, -0.98);
export const GLASS_POS = new THREE.Vector3(0.76, TABLE_TOP_Y, -1.2);

/** Patronun Kumbarası: at the table edge on the dealer's right (screen left from the default view). */
export const KUMBARA_BASE = new THREE.Vector3(-0.66, TABLE_TOP_Y, -0.96);
export const KUMBARA_SIZE = 0.2;
export const KUMBARA_CENTER = new THREE.Vector3(KUMBARA_BASE.x, TABLE_TOP_Y + KUMBARA_SIZE * 0.92, KUMBARA_BASE.z);

/**
 * The wheel drops through a slot in the ceiling behind the lamp (far enough back that the slot's front trim
 * and flap clear the lamp well, see LAMP_WELL_R).
 */
export const WHEEL_Z = -0.82;
/** Ceiling slot half extents around (0, WHEEL_Z). */
export const SLOT_HALF_X = 1.2;
export const SLOT_HALF_Z = 0.24;
export const WHEEL_DOWN = new THREE.Vector3(0, 2.08, WHEEL_Z);
export const WHEEL_UP = new THREE.Vector3(0, CEILING_Y + 1.15, WHEEL_Z);

/** Back door: right part of the back wall. DOOR_X is the opening center. */
export const DOOR_X = 2.45;
export const DOOR_W = 1.04;
export const DOOR_H = 2.22;
export const DOOR_POS = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z + 0.45);
export const DOOR_YAW = 0;
export const OUTSIDE_POS = new THREE.Vector3(DOOR_X, 0, ROOM_BACK_Z - 1.3);

/** Match end podium: in front of the back wall under the neon sign. */
export const PODIUM_POS = new THREE.Vector3(-1.95, 0, -2.45);

/** Wall fixtures (back wall faces +z). */
export const SIGN_POS = new THREE.Vector3(-1.55, 2.12, ROOM_BACK_Z + 0.06);
export const SIREN_POS = new THREE.Vector3(1.3, 2.05, ROOM_BACK_Z + 0.02);

/**
 * Lamp: pivot at the ceiling over the table center, hanging out of a round well in the ceiling (radius
 * LAMP_WELL_R, LAMP_WELL_DEPTH deep). Shade center this high when lit; when the lights go out (the wheel) it
 * is hoisted all the way up into the well, out of every shot.
 */
export const LAMP_SHADE_Y = 2.42;
export const LAMP_WELL_R = 0.4;
export const LAMP_WELL_DEPTH = 0.7;
export const LAMP_HOIST_Y = CEILING_Y + 0.36;

// ------------------------------------------------------------------------------------------ first person
// Gaze angles use the three.js camera convention: yaw turns around +y, pitch around the camera's x axis
// (Euler order "YXZ"), forward = (−sin yaw · cos pitch, sin pitch, −cos yaw · cos pitch).

/** The seated eye sits this far in from the chair point (toward the table) and this high above the floor. */
export const EYE_IN = 0.14;
export const EYE_Y = 1.24;
/** Max extra eye height when the local puppet half-stands (Stage.setEyeLift). */
export const EYE_LIFT_MAX = 0.125;
/** Where a seated player's eyes rest: just past the deck, toward the dealer. */
export const FP_REST_TARGET = new THREE.Vector3(0, 1.05, -0.45);
/** Rest pitch (radians, negative = down): the felt, your own cards and the opponents all fit the view. */
export const FP_REST_PITCH = -0.2;
/** The first-person view never gets narrower than this horizontally (degrees), whatever the window shape. */
export const FP_MIN_HFOV_DEG = 75;

export interface Gaze {
  yaw: number;
  pitch: number;
}

/** Wrap an angle into (−π, π]. */
export function wrapAngle(a: number): number {
  const t = (a + Math.PI) % (Math.PI * 2);
  return (t <= 0 ? t + Math.PI * 2 : t) - Math.PI;
}

/** First-person eye point of a seat (no lift). */
export function eyePoint(seat: number, count: number, out = new THREE.Vector3()): THREE.Vector3 {
  const phi = seatAngle(seat, count);
  const r = SEAT_RADIUS - EYE_IN;
  return out.set(Math.sin(phi) * r, EYE_Y, Math.cos(phi) * r);
}

/** Yaw / pitch of the direction from `from` to `to`. */
export function gazeTo(from: THREE.Vector3Like, to: THREE.Vector3Like, out: Gaze = { yaw: 0, pitch: 0 }): Gaze {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  out.yaw = Math.atan2(-dx, -dz);
  out.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  return out;
}

/** Rest gaze from an eye: yaw toward FP_REST_TARGET, pitch FP_REST_PITCH. */
export function restGaze(eye: THREE.Vector3Like, out: Gaze = { yaw: 0, pitch: 0 }): Gaze {
  out.yaw = Math.atan2(-(FP_REST_TARGET.x - eye.x), -(FP_REST_TARGET.z - eye.z));
  out.pitch = FP_REST_PITCH;
  return out;
}

/** Unit forward vector of a gaze. */
export function gazeForward(g: Gaze, out = new THREE.Vector3()): THREE.Vector3 {
  const c = Math.cos(g.pitch);
  return out.set(-Math.sin(g.yaw) * c, Math.sin(g.pitch), -Math.cos(g.yaw) * c);
}

/**
 * How far (0..1) the head turns toward something happening `angleRad` off the rest axis, given the
 * horizontal field of view: things well inside the view get a small glance (0.25), things at or past the
 * edge pull the head most of the way (0.85), so the action lands inside the frame without a full snap.
 */
export function attentionWeight(angleRad: number, hfovRad: number): number {
  const a = Math.abs(angleRad);
  const half = Math.max(0.1, hfovRad / 2);
  const inner = half * 0.4;
  const outer = half;
  const t = Math.max(0, Math.min(1, (a - inner) / (outer - inner)));
  return 0.25 + 0.6 * t * t * (3 - 2 * t);
}

/** Horizontal FOV (radians) of a vertical FOV (degrees) at an aspect ratio. */
export function horizontalFov(vfovDeg: number, aspect: number): number {
  return 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(vfovDeg) / 2) * aspect);
}

/**
 * First-person vertical FOV (degrees): the user's setting, widened on narrow windows so the horizontal view
 * never drops under FP_MIN_HFOV_DEG (capped at 100° vertical).
 */
export function fpVerticalFov(settingDeg: number, aspect: number): number {
  const minV = THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(FP_MIN_HFOV_DEG) / 2) / Math.max(0.2, aspect)));
  return Math.min(100, Math.max(settingDeg, minV));
}

// ------------------------------------------------------------------------------------------ first-person pile
// In first person your own money pile leaves the middle of the view (where the card row and the hero card are)
// for the lower right: on the felt between your card row and the neighbour on your right. It also turns 90°
// (the Stacks frame's `right` = outward: chip towers toward you, the note bricks lined up behind them), which
// makes it only ~0.2 m wide, so it fits even between two seats of a full table.

/** Where the pile should appear: its middle this far right of / below the rest gaze (radians)… */
export const FP_PILE_VIEW_X = (24 * Math.PI) / 180;
export const FP_PILE_VIEW_Y = (-19 * Math.PI) / 180;
/** …its middle not farther right than this, its near right corner inside the view (soft: some seats are cramped). */
const FP_PILE_MAX_X = (33 * Math.PI) / 180;
const FP_PILE_EDGE_X = (40 * Math.PI) / 180;
/** The turned pile's footprint around its anchor in the seat frame (lateral = seat right, radial = outward). */
const FP_PILE_A0 = -0.07;
const FP_PILE_A1 = 0.13;
const FP_PILE_B0 = -0.29;
const FP_PILE_B1 = 0.12;
/** Every corner of the pile stays on the felt, inside the rail's lip. */
const FELT_R = 1.34;
/**
 * Your own first-person card row in the seat frame: Cards fans it along the seat's right around (−0.125, 0.84),
 * 0.105 m apart; this box holds six cards (a seventh may brush the pile's corner).
 */
const FP_ROW_A0 = -0.62;
const FP_ROW_A1 = 0.22;
const FP_ROW_B0 = 0.7;
const FP_ROW_B1 = 1.04;
/** Keep-out discs (world x, z, radius) around everything else on the felt. */
const pileDiscs: number[] = [];
const _pileEye = new THREE.Vector3();
const _pileGaze: Gaze = { yaw: 0, pitch: 0 };

/**
 * First-person spot of a seat's money pile: the point of a 2 cm grid in the seat frame whose pile middle lands
 * nearest FP_PILE_VIEW_X / _Y from the rest gaze while the whole (turned) pile stays on the felt, off your card
 * row and clear of the other seats' piles, name plates and card rows, the dealer's dressing, the kumbara and
 * the deck. ~1300 candidates: callers cache the result per seat and seat count.
 * Writes the anchor (on the felt) and the Stacks frame `right` (outward); false when nothing fits (the caller
 * keeps the classic spot).
 */
export function fpPileSpot(seat: number, count: number, out: THREE.Vector3, outRight: THREE.Vector3): boolean {
  const n = Math.max(1, Math.min(6, Math.floor(count)));
  const s = Math.max(0, Math.min(n - 1, Math.floor(seat)));
  const phi = seatAngle(s, n);
  const ux = Math.sin(phi);
  const uz = Math.cos(phi);
  const vx = Math.cos(phi);
  const vz = -Math.sin(phi);
  const discs = pileDiscs;
  discs.length = 0;
  for (let k = 0; k < n; k++) {
    if (k === s) continue;
    const pk = seatAngle(k, n);
    const kux = Math.sin(pk);
    const kuz = Math.cos(pk);
    const kvx = Math.cos(pk);
    const kvz = -Math.sin(pk);
    // name plate: a 0.5 m tent along the seat's right
    for (let t = -1; t <= 1; t++) {
      discs.push(kux * PLATE_RADIUS + kvx * t * 0.17, kuz * PLATE_RADIUS + kvz * t * 0.17, 0.1);
    }
    // classic pile: chip towers at the anchor, the brick block to its owner's left
    const ax = kux * STACK_RADIUS + kvx * STACK_SIDE;
    const az = kuz * STACK_RADIUS + kvz * STACK_SIDE;
    discs.push(ax + kvx * 0.037 - kux * 0.033, az + kvz * 0.037 - kuz * 0.033, 0.1);
    discs.push(ax - kvx * 0.16 - kux * 0.03, az - kvz * 0.16 - kuz * 0.03, 0.15);
    // the middle of their card row on their turn (a long row's far cards may still brush the pile)
    discs.push(kux * CARD_ROW_RADIUS - kvx * 0.09, kuz * CARD_ROW_RADIUS - kvz * 0.09, 0.2);
  }
  discs.push(ASHTRAY_POS.x, ASHTRAY_POS.z, 0.12, BOTTLE_POS.x, BOTTLE_POS.z, 0.08, GLASS_POS.x, GLASS_POS.z, 0.07);
  discs.push(KUMBARA_BASE.x, KUMBARA_BASE.z, 0.28, 0, 0, 0.3);

  const eye = eyePoint(s, n, _pileEye);
  const gaze = restGaze(eye, _pileGaze);
  // view angles (right of / below the rest gaze) of a seat-frame point at height y
  const viewRight = (a: number, b: number): number =>
    wrapAngle(gaze.yaw - Math.atan2(-(ux * b + vx * a - eye.x), -(uz * b + vz * a - eye.z)));
  const viewDown = (a: number, b: number, y: number): number =>
    Math.atan2(y - eye.y, Math.hypot(ux * b + vx * a - eye.x, uz * b + vz * a - eye.z)) - gaze.pitch;
  let best = Infinity;
  let bestA = 0;
  let bestB = 0;
  for (let i = 0; i <= 40; i++) {
    const a = 0.15 + i * 0.02;
    for (let j = 0; j <= 32; j++) {
      const b = 0.7 + j * 0.02;
      const a0 = a + FP_PILE_A0;
      const a1 = a + FP_PILE_A1;
      const b0 = b + FP_PILE_B0;
      const b1 = b + FP_PILE_B1;
      // on the felt: the outermost corner (b1 > 0 always here)
      if (Math.hypot(Math.max(Math.abs(a0), Math.abs(a1)), b1) > FELT_R) continue;
      // off my own card row
      if (a1 > FP_ROW_A0 && a0 < FP_ROW_A1 && b1 > FP_ROW_B0 && b0 < FP_ROW_B1) continue;
      let blocked = false;
      for (let d = 0; d < discs.length; d += 3) {
        const x = discs[d]!;
        const z = discs[d + 1]!;
        const r = discs[d + 2]! + 0.03;
        // disc center in the seat frame → distance to the footprint rectangle
        const da = x * vx + z * vz;
        const db = x * ux + z * uz;
        const ex = Math.max(a0 - da, 0, da - a1);
        const ez = Math.max(b0 - db, 0, db - b1);
        if (ex * ex + ez * ez < r * r) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      // the middle of the pile (half way up) near the target; it and the near right corner kept in view
      const ma = (a0 + a1) / 2;
      const mb = (b0 + b1) / 2;
      const right = viewRight(ma, mb);
      const score = (right - FP_PILE_VIEW_X) ** 2 + (viewDown(ma, mb, TABLE_TOP_Y + 0.07) - FP_PILE_VIEW_Y) ** 2
        + 8 * Math.max(0, right - FP_PILE_MAX_X) ** 2 + 4 * Math.max(0, viewRight(a1, b1) - FP_PILE_EDGE_X) ** 2;
      if (score < best) {
        best = score;
        bestA = a;
        bestB = b;
      }
    }
  }
  if (!Number.isFinite(best)) return false;
  out.set(ux * bestB + vx * bestA, TABLE_TOP_Y + 0.025, uz * bestB + vz * bestA);
  outRight.set(ux, 0, uz);
  return true;
}

// ------------------------------------------------------------------------------------------ camera shots
/** The Masa camera never rises into the ceiling beams (bottom at CEILING_Y − BEAM_DROP). */
export const CAMERA_MAX_Y = CEILING_Y - BEAM_DROP - 0.06;

/** Where the raid door shot aims at the door (opening center, chest height). */
export const DOOR_LOOK = new THREE.Vector3(DOOR_X, 1.2, DOOR_POS.z);

/**
 * Raid door shot for the Masa camera: a camera on a ring around the table that keeps the door AND the raided
 * chair in frame (smallest angular spread, preferring the classic 3/4 angle), aimed along the bisector.
 * Without a chair it is the classic door close-up.
 */
export function doorShot(chair: THREE.Vector3Like | null, outPos: THREE.Vector3, outTarget: THREE.Vector3): void {
  if (!chair) {
    outPos.set(Math.sin(0.3) * 3.45 + 0.7, 2.35, Math.cos(0.3) * 3.45);
    outTarget.set(DOOR_X, 1.18, DOOR_POS.z);
    return;
  }
  const R = 4;
  const H = 2.4;
  const cx = chair.x;
  const cz = chair.z;
  let best = Infinity;
  let bestYaw = 0.3;
  for (let yaw = -1.1; yaw <= 1.1001; yaw += 0.05) {
    const px = clampRoomX(Math.sin(yaw) * R);
    const pz = clampRoomZ(Math.cos(yaw) * R);
    const aD = Math.atan2(DOOR_LOOK.x - px, DOOR_LOOK.z - pz);
    const aC = Math.atan2(cx - px, cz - pz);
    const score = Math.abs(wrapAngle(aD - aC)) + Math.abs(yaw - 0.3) * 0.12;
    if (score < best) {
      best = score;
      bestYaw = yaw;
    }
  }
  outPos.set(clampRoomX(Math.sin(bestYaw) * R), H, clampRoomZ(Math.cos(bestYaw) * R));
  // bisector of the two horizontal directions, at the midpoint distance
  let dx = DOOR_LOOK.x - outPos.x;
  let dz = DOOR_LOOK.z - outPos.z;
  const ld = Math.hypot(dx, dz) || 1;
  let ex = cx - outPos.x;
  let ez = cz - outPos.z;
  const le = Math.hypot(ex, ez) || 1;
  dx /= ld; dz /= ld; ex /= le; ez /= le;
  let bx = dx + ex;
  let bz = dz + ez;
  const lb = Math.hypot(bx, bz) || 1;
  bx /= lb; bz /= lb;
  const dist = (ld + le) / 2;
  outTarget.set(outPos.x + bx * dist, 1.15, outPos.z + bz * dist);
}

// ------------------------------------------------------------------------------------------ Masa sightlines
/** A seated avatar's head + hat as a vertical capsule (axis HEAD_IN inside the chair point). */
export const HEAD_Y0 = 1.15;
export const HEAD_Y1 = 1.82;
export const HEAD_R = 0.27;
const HEAD_IN = 0.08;

const _segD1 = new THREE.Vector3();
const _segD2 = new THREE.Vector3();
const _segR = new THREE.Vector3();
const _segC = new THREE.Vector3();
const _headLo = new THREE.Vector3();
const _headHi = new THREE.Vector3();
const _sightNear = new THREE.Vector3();
const _sightMid = new THREE.Vector3();

/** Shortest distance between the segments p1–q1 and p2–q2 (Ericson, Real-Time Collision Detection 5.1.9). */
export function segmentDistance(p1: THREE.Vector3Like, q1: THREE.Vector3Like, p2: THREE.Vector3Like, q2: THREE.Vector3Like): number {
  const d1 = _segD1.set(q1.x - p1.x, q1.y - p1.y, q1.z - p1.z);
  const d2 = _segD2.set(q2.x - p2.x, q2.y - p2.y, q2.z - p2.z);
  const r = _segR.set(p1.x - p2.x, p1.y - p2.y, p1.z - p2.z);
  const a = d1.dot(d1);
  const e = d2.dot(d2);
  const f = d2.dot(r);
  const eps = 1e-9;
  let s = 0;
  let t = 0;
  if (a <= eps && e <= eps) return r.length();
  if (a <= eps) {
    t = Math.max(0, Math.min(1, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= eps) {
      s = Math.max(0, Math.min(1, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > eps ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = Math.max(0, Math.min(1, -c / a));
      } else if (t > 1) {
        t = 1;
        s = Math.max(0, Math.min(1, (b - c) / a));
      }
    }
  }
  // closest points p1 + d1·s and p2 + d2·t
  return _segC.copy(r).addScaledVector(d1, s).addScaledVector(d2, -t).length();
}

/**
 * Clearance (m; negative = blocked) of a Masa shot from `cam` aiming at `target` past the seated heads in
 * `seats` (bit mask of seat indexes): the sightline to the target and, with `near`, two more down to the
 * table rim in front of the camera, so nobody's head or hat sits in the lower middle of the frame.
 */
export function masaClearance(cam: THREE.Vector3Like, target: THREE.Vector3Like, count: number, seats: number, near: boolean): number {
  const n = Math.max(1, Math.min(6, Math.floor(count)));
  const h = Math.hypot(cam.x, cam.z) || 1;
  _sightNear.set((cam.x / h) * TABLE_RADIUS, TABLE_TOP_Y + 0.05, (cam.z / h) * TABLE_RADIUS);
  _sightMid.set((target.x + _sightNear.x) / 2, (target.y + _sightNear.y) / 2, (target.z + _sightNear.z) / 2);
  let worst = Infinity;
  for (let k = 0; k < n; k++) {
    if (!(seats & (1 << k))) continue;
    const phi = seatAngle(k, n);
    const r = SEAT_RADIUS - HEAD_IN;
    _headLo.set(Math.sin(phi) * r, HEAD_Y0, Math.cos(phi) * r);
    _headHi.set(_headLo.x, HEAD_Y1, _headLo.z);
    worst = Math.min(worst, segmentDistance(cam, target, _headLo, _headHi) - HEAD_R);
    if (near) {
      worst = Math.min(worst, segmentDistance(cam, _sightMid, _headLo, _headHi) - HEAD_R);
      worst = Math.min(worst, segmentDistance(cam, _sightNear, _headLo, _headHi) - HEAD_R);
    }
  }
  return worst;
}

function clampRoomX(x: number): number {
  return Math.max(-ROOM_HALF_X + 0.3, Math.min(ROOM_HALF_X - 0.3, x));
}
function clampRoomZ(z: number): number {
  return Math.max(ROOM_BACK_Z + 0.3, Math.min(ROOM_FRONT_Z - 0.3, z));
}
