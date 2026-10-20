// Pure first-person / camera geometry from layout.ts (no renderer, no DOM).
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  CAMERA_MAX_Y,
  DOOR_LOOK,
  EYE_IN,
  EYE_Y,
  FP_MIN_HFOV_DEG,
  FP_REST_PITCH,
  FP_REST_TARGET,
  ROOM_BACK_Z,
  ROOM_FRONT_Z,
  ROOM_HALF_X,
  SEAT_RADIUS,
  STACK_RADIUS,
  STACK_SIDE,
  TABLE_RADIUS,
  TABLE_TOP_Y,
  WHEEL_DOWN,
  attentionWeight,
  doorShot,
  eyePoint,
  fpPileSpot,
  fpVerticalFov,
  gazeForward,
  gazeTo,
  horizontalFov,
  masaClearance,
  restGaze,
  seatAngle,
  segmentDistance,
  wrapAngle,
} from "./layout";

const deg = THREE.MathUtils.degToRad;

describe("eyePoint", () => {
  it("sits EYE_IN inside the chair radius at eye height, on the seat's direction", () => {
    for (const count of [2, 3, 4, 5, 6]) {
      for (let seat = 0; seat < count; seat++) {
        const e = eyePoint(seat, count);
        expect(e.y).toBeCloseTo(EYE_Y, 6);
        expect(Math.hypot(e.x, e.z)).toBeCloseTo(SEAT_RADIUS - EYE_IN, 6);
        const phi = seatAngle(seat, count);
        expect(Math.atan2(e.x, e.z)).toBeCloseTo(phi, 6);
      }
    }
  });
  it("writes into the out vector", () => {
    const out = new THREE.Vector3();
    expect(eyePoint(0, 2, out)).toBe(out);
  });
});

describe("gaze math", () => {
  it("gazeTo and gazeForward agree (three.js camera convention)", () => {
    const from = new THREE.Vector3(1.2, 1.24, 0.9);
    for (const to of [new THREE.Vector3(0, 1, -2), new THREE.Vector3(-3, 0.5, 2), new THREE.Vector3(2, 2.5, 0.9)]) {
      const g = gazeTo(from, to);
      const f = gazeForward(g);
      const d = to.clone().sub(from).normalize();
      expect(f.dot(d)).toBeCloseTo(1, 6);
      // a camera with this Euler looks along −z rotated into the same direction
      const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(g.pitch, g.yaw, 0, "YXZ"));
      const camFwd = new THREE.Vector3(0, 0, -1).applyQuaternion(q);
      expect(camFwd.dot(d)).toBeCloseTo(1, 6);
    }
  });

  it("rest gaze faces the rest target with the fixed rest pitch", () => {
    for (const count of [2, 4, 6]) {
      for (let seat = 0; seat < count; seat++) {
        const eye = eyePoint(seat, count);
        const g = restGaze(eye);
        expect(g.pitch).toBe(FP_REST_PITCH);
        const f = gazeForward({ yaw: g.yaw, pitch: 0 });
        const d = new THREE.Vector3(FP_REST_TARGET.x - eye.x, 0, FP_REST_TARGET.z - eye.z).normalize();
        expect(f.dot(d)).toBeCloseTo(1, 6);
      }
    }
    // a lone seat straight in front of the dealer looks straight down −z
    expect(restGaze(eyePoint(0, 1)).yaw).toBeCloseTo(0, 6);
  });

  it("wrapAngle folds into (−π, π]", () => {
    expect(wrapAngle(0)).toBeCloseTo(0);
    expect(wrapAngle(Math.PI * 2 + 0.3)).toBeCloseTo(0.3);
    expect(wrapAngle(-Math.PI * 2 - 0.3)).toBeCloseTo(-0.3);
    expect(wrapAngle(Math.PI)).toBeCloseTo(Math.PI);
    expect(wrapAngle(-Math.PI)).toBeCloseTo(Math.PI);
    expect(Math.abs(wrapAngle(7.5))).toBeLessThanOrEqual(Math.PI);
  });
});

describe("attentionWeight", () => {
  const hfov = deg(84);
  it("glances at things in view, turns toward things at the edge", () => {
    expect(attentionWeight(0, hfov)).toBeCloseTo(0.25, 6);
    expect(attentionWeight(hfov / 2, hfov)).toBeCloseTo(0.85, 6);
    expect(attentionWeight(deg(120), hfov)).toBeCloseTo(0.85, 6);
  });
  it("is symmetric, bounded and monotonic", () => {
    let last = 0;
    for (let a = 0; a <= Math.PI; a += 0.05) {
      const w = attentionWeight(a, hfov);
      expect(w).toBeGreaterThanOrEqual(0.25);
      expect(w).toBeLessThanOrEqual(0.85);
      expect(w).toBeGreaterThanOrEqual(last - 1e-9);
      expect(attentionWeight(-a, hfov)).toBeCloseTo(w, 9);
      last = w;
    }
  });
});

describe("first-person fov", () => {
  it("keeps the setting on wide windows", () => {
    expect(fpVerticalFov(58, 16 / 10)).toBeCloseTo(58, 6);
    expect(fpVerticalFov(75, 16 / 9)).toBeCloseTo(75, 6);
  });
  it("widens narrow windows to the minimum horizontal fov", () => {
    for (const aspect of [1, 0.75, 0.56]) {
      const v = fpVerticalFov(58, aspect);
      expect(v).toBeGreaterThan(58);
      if (v < 100) expect(THREE.MathUtils.radToDeg(horizontalFov(v, aspect))).toBeCloseTo(FP_MIN_HFOV_DEG, 4);
      expect(v).toBeLessThanOrEqual(100);
    }
  });
});

describe("door shot", () => {
  const pos = new THREE.Vector3();
  const target = new THREE.Vector3();
  const angleBetween = (from: THREE.Vector3, a: THREE.Vector3Like, b: THREE.Vector3Like) => {
    const ga = Math.atan2(a.x - from.x, a.z - from.z);
    const gb = Math.atan2(b.x - from.x, b.z - from.z);
    return Math.abs(wrapAngle(ga - gb));
  };

  it("keeps the door and the raided chair inside ±30° of the view axis for every seat", () => {
    for (const count of [2, 3, 4, 5, 6]) {
      for (let seat = 0; seat < count; seat++) {
        const phi = seatAngle(seat, count);
        const chair = new THREE.Vector3(Math.sin(phi) * SEAT_RADIUS, 1.1, Math.cos(phi) * SEAT_RADIUS);
        doorShot(chair, pos, target);
        expect(angleBetween(pos, target, DOOR_LOOK)).toBeLessThan(deg(30));
        expect(angleBetween(pos, target, chair)).toBeLessThan(deg(30));
        expect(Math.abs(pos.x)).toBeLessThan(ROOM_HALF_X);
        expect(pos.z).toBeLessThan(ROOM_FRONT_Z);
        expect(pos.z).toBeGreaterThan(ROOM_BACK_Z);
        expect(pos.y).toBeLessThanOrEqual(CAMERA_MAX_Y);
      }
    }
  });

  it("falls back to the classic door close-up without a seat", () => {
    doorShot(null, pos, target);
    expect(target.x).toBeCloseTo(DOOR_LOOK.x, 6);
    expect(pos.y).toBeLessThanOrEqual(CAMERA_MAX_Y);
  });
});

describe("first-person money pile", () => {
  const at = new THREE.Vector3();
  const right = new THREE.Vector3();
  it("finds a spot on the felt, right of the rest gaze and clear of the other piles, for every seat", () => {
    for (const count of [1, 2, 3, 4, 5, 6]) {
      for (let seat = 0; seat < count; seat++) {
        expect(fpPileSpot(seat, count, at, right)).toBe(true);
        expect(at.y).toBeCloseTo(TABLE_TOP_Y + 0.025, 6);
        expect(Math.hypot(at.x, at.z)).toBeLessThan(TABLE_RADIUS - 0.15);
        // the frame is turned to point outward
        const phi = seatAngle(seat, count);
        expect(right.x).toBeCloseTo(Math.sin(phi), 6);
        expect(right.z).toBeCloseTo(Math.cos(phi), 6);
        // off the middle of the view: well right of the rest gaze, still inside the narrowest view
        const eye = eyePoint(seat, count);
        const rest = restGaze(eye);
        const g = gazeTo(eye, at);
        const off = wrapAngle(rest.yaw - g.yaw);
        expect(off).toBeGreaterThan(deg(15));
        expect(off).toBeLessThan(deg(FP_MIN_HFOV_DEG / 2));
        expect(g.pitch).toBeLessThan(rest.pitch - deg(10));
        // never on another seat's classic pile
        for (let k = 0; k < count; k++) {
          if (k === seat) continue;
          const pk = seatAngle(k, count);
          const ox = Math.sin(pk) * STACK_RADIUS + Math.cos(pk) * STACK_SIDE;
          const oz = Math.cos(pk) * STACK_RADIUS - Math.sin(pk) * STACK_SIDE;
          expect(Math.hypot(at.x - ox, at.z - oz)).toBeGreaterThan(0.3);
        }
      }
    }
  });
});

describe("Masa sightlines", () => {
  it("segmentDistance handles crossing, parallel and end-point cases", () => {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    expect(segmentDistance(v(-1, 0, 0), v(1, 0, 0), v(0, -1, 1), v(0, 1, 1))).toBeCloseTo(1, 6);
    expect(segmentDistance(v(0, 0, 0), v(1, 0, 0), v(0, 1, 0), v(1, 1, 0))).toBeCloseTo(1, 6);
    expect(segmentDistance(v(0, 0, 0), v(1, 0, 0), v(3, 0, 0), v(3, 2, 0))).toBeCloseTo(2, 6);
    expect(segmentDistance(v(0, 0, 0), v(0, 0, 0), v(0, 2, 0), v(0, 2, 0))).toBeCloseTo(2, 6);
  });

  it("a head straight between the camera and the table blocks the shot, a gap between seats is clear", () => {
    const target = new THREE.Vector3(0, 0.82, -0.35);
    // three seats: the middle one (seat 1) sits on +z, right on the line of a camera straight behind it
    const behind = new THREE.Vector3(0, 3.18, 4);
    expect(masaClearance(behind, target, 3, 0b111, true)).toBeLessThan(0);
    // without that seat the same shot is clear
    expect(masaClearance(behind, target, 3, 0b101, true)).toBeGreaterThan(0.06);
    // nobody seated: nothing in the way
    expect(masaClearance(behind, target, 3, 0, true)).toBe(Infinity);
    // half way between two seats of a full table
    const gap = (seatAngle(2, 6) + seatAngle(3, 6)) / 2;
    const between = new THREE.Vector3(Math.sin(gap) * 4, 3.18, Math.cos(gap) * 4);
    expect(masaClearance(between, target, 6, 0b111111, true)).toBeGreaterThan(0.06);
    // the wheel hangs above every head
    const wheelCam = new THREE.Vector3(0, 2.45, 2.6);
    expect(masaClearance(wheelCam, WHEEL_DOWN, 3, 0b111, false)).toBeGreaterThan(0.06);
  });
});
