// Patronun Çarkı (§7, §14 "Çark", §16.4). Owner: client-cards-fx. PUBLIC API IS THE CONTRACT.
//
// A giant gold-rimmed wheel of fortune hanging on two chains. Hidden at stage.anchors.wheelUp (in the
// ceiling shaft); lowered to anchors.wheelDown. 8 equal slices in WHEEL_SLICES order (index 0 at the top, then
// clockwise as seen from the front), big readable Turkish labels painted on a canvas texture
// (WheelSliceDef.label, slice color), light bulbs around the rim that chase while spinning, a flapper/pointer
// at the top that clicks against pegs (onTick per peg, speed 0..1 so audio can slow the clicks). The spin
// decelerates smoothly (ease-out) so `slice` stops under the pointer EXACTLY at descendMs + spinMs after
// spin() is called (the server sends WHEEL_RESULT at that moment). On landing the winning slice is singled
// out (celebrate): the other slices dim and a pulsing gold frame with an ink edge runs around the winner,
// whose own colors and label stay untouched (no additive wash: the cream label must stay readable). raise()
// hoists it back up (WHEEL_ASCEND_SEC).
//
// Choreography: spin() opens the ceiling slot first (stage.setLightsOut — the lights go down with it), the
// wheel waits in the shaft until the flaps are open, then comes down on its chains (ease in-out with a small
// stretch-bounce). Below the ceiling the wheel turns on a swivel under its marquee sign to face the viewer
// (the first-person eye or the Masa camera, via stage.readingBasis); once the sign is below the ceiling it
// turns with it, a little (SIGN_MAX_YAW, so its chains stay inside the slot), so it never reads edge-on from a
// side seat. All of this is a local cosmetic, the spin and
// its landing are untouched. The dealer's pull is a short rock-back, then the launch. The visual turn count
// is chosen here (the landing angle doesn't depend on it) so the launch stays under MAX_LAUNCH rad/s, and a
// pre-blurred copy of the face fades in with the per-frame step: no strobing, no "spinning backwards". On
// raise() the wheel swivels back, rises, and keeps the slot open until it has cleared the ceiling.
//
// Timing runs on the wall clock (performance.now), not the visual dt, so the landing matches server time even
// when frames drop. Face radius WHEEL_RADIUS (0.78 m); the marquee sign tops out ~1.2 m above the hub.

import * as THREE from "three";
import { PALETTE, WHEEL_ASCEND_SEC, WHEEL_HOLD_SEC, WHEEL_SLICES, type WheelSliceId } from "../../../shared/constants";
import { settings } from "../app/settings";
import type { Stage } from "./Stage";
import { CEILING_Y } from "./room/layout";
import { addOutlines, toon, toonRamp } from "./toon";
import { SPARK_DOT, SPARK_GLOW, SPARK_STAR, Sparks } from "./fx/Sparks";
import { raysTexture } from "./fx/textures";
import {
  TAU,
  clamp,
  clamp01,
  damp,
  dampAngle,
  easeInOutCubic,
  easeInOutSine,
  easeOutCubic,
  hash01,
  nowMs,
  pick,
  rand,
  smoothstep,
} from "./fx/util";
import { wheelBlurTexture, wheelFaceTexture, wheelSignTexture } from "./fx/wheelArt";

/** Face radius (m). */
export const WHEEL_RADIUS = 0.78;
const R = WHEEL_RADIUS;
const N = WHEEL_SLICES.length;
const SLICE = TAU / N;
const BULBS = 24;
const LINK = 0.04;
const LINKS_PER_CHAIN = 80;
/** Pendulum pivot height above the hub (the wheel swings from up here after it drops). */
const PIVOT_H = 1.6;
/** Flapper contact: a peg this close (rad) to the top starts pushing the flapper. */
const CONTACT = 0.17;
const FLAP_MAX = 0.62;
/** Highest launch speed (rad/s): ≈14° per frame at 60 Hz against 45° slices. */
const MAX_LAUNCH = 15;
/** The dealer's pull: rock back this far (rad) over WIND_SEC before the launch. */
const WIND = 0.13;
const WIND_SEC = 0.26;
/** The wheel waits in the shaft this long (at most) while the ceiling flaps swing open. */
const SLOT_WAIT_MS = 450;
/** Lowest point of the wheel below the hub, and the top of the swiveling part above it (m). */
const BOTTOM = R + 0.09;
const SWIVEL_TOP = R + 0.21;
/** The wheel turns at most this far (rad) toward a viewer. */
const MAX_YAW = 1.5;
/** The sign turns with it at most this far: its corner chains (x ±0.44) stay inside the 0.24 m half slot. */
const SIGN_MAX_YAW = 0.45;
/** Top of the sign (and the start of its chains) above the hub (m). */
const SIGN_TOP = R + 0.42;
/**
 * Winning-slice frame: around the sector from just outside the hub to inside the dark outer band (m), drawn
 * mostly inside the winner's border (negative insets reach over the separator), clear of the labels.
 */
const FRAME_R0 = 0.14;
const FRAME_R1 = R - 0.05;
/** How dark the losing slices get while the winner is celebrated. */
const DIM_ALPHA = 0.5;

type Mode = "hidden" | "descend" | "down" | "raise";

const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _on = new THREE.Color("#FFF1B5");
const _off = new THREE.Color("#4A2E12");
const _slice = new THREE.Color();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _gold = new THREE.Color(PALETTE.gold);
const _hot = new THREE.Color("#FFF3B8");

/**
 * Outline band of the annular sector [a0, a1] × [r0, r1] (radians, m), between `in0` and `in1` inside its
 * border (negative = outside), with constant width along the straight edges too.
 */
function sectorFrame(a0: number, a1: number, r0: number, r1: number, in0: number, in1: number): THREE.ShapeGeometry {
  const path = (d: number, out: THREE.Path): THREE.Path => {
    const ro = r1 - d;
    const ri = r0 + d;
    const so = Math.asin(Math.min(0.99, d / ro));
    const si = Math.asin(Math.min(0.99, d / ri));
    out.absarc(0, 0, ro, a0 + so, a1 - so, false);
    out.absarc(0, 0, ri, a1 - si, a0 + si, true);
    out.closePath();
    return out;
  };
  const shape = path(in0, new THREE.Shape()) as THREE.Shape;
  shape.holes.push(path(in1, new THREE.Path()));
  return new THREE.ShapeGeometry(shape, 12);
}

/** Ease in-out with a small overshoot at both ends (anticipation up in the shaft, stretch at the bottom). */
function easeInOutBack(x: number, c1 = 0.7): number {
  const c2 = c1 * 1.525;
  return x < 0.5
    ? (Math.pow(2 * x, 2) * ((c2 + 1) * 2 * x - c2)) / 2
    : (Math.pow(2 * x - 2, 2) * ((c2 + 1) * (x * 2 - 2) + c2) + 2) / 2;
}

export class Wheel {
  private readonly stage: Stage;
  private readonly root = new THREE.Group();
  private readonly pivot = new THREE.Group();
  private readonly body = new THREE.Group();
  /** Everything that turns toward the viewer (the wheel, its pointer and bracket). */
  private readonly swivel = new THREE.Group();
  /** The marquee sign and its chains: follow the swivel's yaw, clamped to SIGN_MAX_YAW, below the ceiling. */
  private readonly signHang = new THREE.Group();
  private readonly spinner = new THREE.Group();
  private readonly flapper = new THREE.Group();
  private readonly bulbs: THREE.InstancedMesh;
  private readonly blur: THREE.Mesh;
  private readonly blurMat: THREE.MeshToonMaterial;
  /** Celebrate: the 7 losing slices dimmed, and an ink-edged gold frame around the winner (rotate together). */
  private readonly winner = new THREE.Group();
  private readonly dimMat: THREE.MeshBasicMaterial;
  private readonly frameInkMat: THREE.MeshBasicMaterial;
  private readonly frameMat: THREE.MeshBasicMaterial;
  private readonly rays: THREE.Mesh;
  private readonly raysMat: THREE.MeshBasicMaterial;
  private readonly gemMat: THREE.MeshToonMaterial;
  private readonly sparks: Sparks;

  private mode: Mode = "hidden";
  private modeStart = 0;
  private modeDur = 0;
  /** 0 = up in the ceiling, 1 = down over the table (may overshoot while bouncing). */
  private lowered = 0;
  private lowerFrom = 0;
  private isDown = false;
  /** This wheel holds the ceiling slot open (stage.setLightsOut) until it is back up past the flaps. */
  private holdingSlot = false;
  private yaw = 0;
  private yawFrom = 0;

  // spin (angle = clockwise rotation as seen from the front, radians)
  private angle = 0;
  private spinFrom = 0;
  private spinTo = 0;
  private spinStart = 0;
  private spinDur = 0;
  private windSec = WIND_SEC;
  private spinning = false;
  private speed = 0;
  private omega = 0;
  private lastNow = 0;
  private spinResolve: (() => void) | null = null;
  private spinGuard = 0;
  private onTick: ((speed: number) => void) | undefined;
  private pegIndex = 0;
  private flap = 0;
  private flapVel = 0;

  // juice
  private swingT = 99;
  private swingAmp = 0;
  private chase = 0;
  private clock = 0;
  private celebrateT = -1;
  private celebrateSlice = 0;
  private punchT = -1;

  constructor(stage: Stage) {
    this.stage = stage;
    this.root.name = "wheel";
    this.root.visible = false;
    stage.world.add(this.root);
    this.root.add(this.pivot);
    this.pivot.position.y = PIVOT_H;
    this.pivot.add(this.body);
    this.body.position.y = -PIVOT_H;
    this.body.add(this.swivel);
    this.body.add(this.signHang);
    this.swivel.add(this.spinner);

    const gold = toon(PALETTE.gold, { emissive: "#5A3A00", emissiveIntensity: 0.8 });
    const darkGold = toon("#C9962C", { emissive: "#3A2400" });
    const wood = toon(PALETTE.woodDark, { emissive: "#120806" });

    // back plate + rim
    const back = new THREE.Mesh(new THREE.CylinderGeometry(R + 0.075, R + 0.075, 0.07, 56), wood);
    back.rotation.x = Math.PI / 2;
    back.position.z = -0.045;
    back.castShadow = true;
    this.swivel.add(back);
    const rim = new THREE.Mesh(new THREE.TorusGeometry(R + 0.02, 0.045, 10, 72), gold);
    rim.castShadow = true;
    this.swivel.add(rim);

    // spinning face
    const faceTex = wheelFaceTexture();
    const faceMat = new THREE.MeshToonMaterial({
      map: faceTex,
      emissiveMap: faceTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      gradientMap: toonRamp(),
    });
    const faceGeo = new THREE.CircleGeometry(R, 72);
    const face = new THREE.Mesh(faceGeo, faceMat);
    face.position.z = 0.006;
    face.userData.noOutline = true;
    this.spinner.add(face);

    // motion blur: the face smeared over one slice, faded in with the per-frame step
    const blurTex = wheelBlurTexture(faceTex, SLICE);
    this.blurMat = new THREE.MeshToonMaterial({
      map: blurTex,
      emissiveMap: blurTex,
      emissive: 0xffffff,
      emissiveIntensity: 0.55,
      gradientMap: toonRamp(),
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.blur = new THREE.Mesh(faceGeo, this.blurMat);
    this.blur.position.z = 0.0085;
    this.blur.visible = false;
    this.blur.userData.noOutline = true;
    this.spinner.add(this.blur);

    const pegGeo = new THREE.CylinderGeometry(0.014, 0.014, 0.05, 8);
    pegGeo.rotateX(Math.PI / 2);
    const pegs = new THREE.InstancedMesh(pegGeo, gold, N);
    pegs.userData.noOutline = true;
    for (let k = 0; k < N; k++) {
      const a = Math.PI / 2 - (SLICE / 2 + k * SLICE);
      _m.makeTranslation(Math.cos(a) * (R - 0.045), Math.sin(a) * (R - 0.045), 0.03);
      pegs.setMatrixAt(k, _m);
    }
    this.spinner.add(pegs);

    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.125, 0.06, 28), gold);
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.035;
    this.spinner.add(hub);
    this.gemMat = toon("#E5383B", { unique: true, emissive: "#7A0A10", emissiveIntensity: 1 });
    const gem = new THREE.Mesh(new THREE.SphereGeometry(0.048, 16, 12), this.gemMat);
    gem.scale.z = 0.6;
    gem.position.z = 0.075;
    this.spinner.add(gem);

    // winning slice (centered at the top, the group is rotated onto the slice): everything else dims, a gold
    // frame with an ink edge pulses around the winner. Normal blending, so the slice keeps its own colors.
    const basic = (color: THREE.ColorRepresentation) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false });
    this.dimMat = basic(PALETTE.ink);
    this.frameInkMat = basic(PALETTE.ink);
    this.frameMat = basic(PALETTE.gold);
    const a0 = Math.PI / 2 - SLICE / 2;
    const a1 = Math.PI / 2 + SLICE / 2;
    const dim = new THREE.Mesh(new THREE.CircleGeometry(R - 0.004, 56, a1, TAU - SLICE), this.dimMat);
    const ink = new THREE.Mesh(sectorFrame(a0, a1, FRAME_R0, FRAME_R1, -0.01, 0.022), this.frameInkMat);
    const frame = new THREE.Mesh(sectorFrame(a0, a1, FRAME_R0, FRAME_R1, -0.004, 0.016), this.frameMat);
    dim.position.z = 0.012;
    ink.position.z = 0.0135;
    frame.position.z = 0.015;
    [dim, ink, frame].forEach((m, k) => {
      m.renderOrder = 1 + k;
      m.userData.noOutline = true;
      this.winner.add(m);
    });
    this.winner.visible = false;
    this.spinner.add(this.winner);

    // bulbs on the static rim
    this.bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(0.026, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffffff }), BULBS);
    this.bulbs.userData.noOutline = true;
    for (let k = 0; k < BULBS; k++) {
      const a = (k / BULBS) * TAU;
      _m.makeTranslation(Math.cos(a) * (R + 0.02), Math.sin(a) * (R + 0.02), 0.048);
      this.bulbs.setMatrixAt(k, _m);
      this.bulbs.setColorAt(k, _on);
    }
    this.swivel.add(this.bulbs);

    // flapper at the top
    this.flapper.position.set(0, R + 0.08, 0.055);
    this.swivel.add(this.flapper);
    const shape = new THREE.Shape();
    shape.moveTo(0, -0.165);
    shape.bezierCurveTo(0.02, -0.11, 0.045, -0.04, 0.04, 0);
    shape.absarc(0, 0, 0.04, 0, Math.PI, false);
    shape.bezierCurveTo(-0.045, -0.04, -0.02, -0.11, 0, -0.165);
    const flapGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.022, bevelEnabled: true, bevelSize: 0.006, bevelThickness: 0.006, bevelSegments: 2, curveSegments: 10 });
    flapGeo.translate(0, 0, -0.011);
    const flap = new THREE.Mesh(flapGeo, toon("#E5383B", { emissive: "#5A0A10" }));
    this.flapper.add(flap);
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), gold);
    cap.position.z = 0.02;
    this.flapper.add(cap);

    // bracket and posts turn with the wheel; a gold swivel joint hangs it under the sign
    const bar = new THREE.Mesh(new THREE.BoxGeometry(R * 1.25, 0.045, 0.06), gold);
    bar.position.y = R + 0.17;
    this.swivel.add(bar);
    for (const x of [-0.26, 0.26]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.13, 0.04), darkGold);
      post.position.set(x, R + 0.1, -0.01);
      this.swivel.add(post);
    }
    const joint = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.03, 18), darkGold);
    joint.position.set(0, R + 0.2, -0.01);
    this.body.add(joint);

    // the marquee sign (straight under the ceiling slot; turns a little toward the viewer once below it)
    const signMat = new THREE.MeshBasicMaterial({ map: wheelSignTexture(), transparent: true, alphaTest: 0.5 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.215), signMat);
    sign.position.set(0, R + 0.3, 0.0);
    sign.userData.noOutline = true;
    this.signHang.add(sign);
    const signBack = new THREE.Mesh(new THREE.BoxGeometry(1.02, 0.225, 0.03), wood);
    signBack.position.set(0, R + 0.3, -0.02);
    this.signHang.add(signBack);

    // two gold chains from the sign's corners up into the ceiling
    const linkGeo = new THREE.TorusGeometry(0.02, 0.006, 5, 10);
    const chains = new THREE.InstancedMesh(linkGeo, darkGold, LINKS_PER_CHAIN * 2);
    chains.userData.noOutline = true;
    const top = SIGN_TOP - 0.02;
    let n = 0;
    for (const x of [-0.44, 0.44]) {
      for (let k = 0; k < LINKS_PER_CHAIN; k++) {
        _q.setFromAxisAngle(_v.set(0, 1, 0), k % 2 ? Math.PI / 2 : 0);
        _s.set(1, 1.55, 1);
        _m.compose(_v.set(x, top + 0.02 + k * LINK, -0.01), _q, _s);
        chains.setMatrixAt(n++, _m);
      }
    }
    this.signHang.add(chains);

    // rays behind the wheel for the big moment
    this.raysMat = new THREE.MeshBasicMaterial({
      map: raysTexture(),
      color: PALETTE.gold,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.rays = new THREE.Mesh(new THREE.PlaneGeometry(R * 3.6, R * 3.6), this.raysMat);
    this.rays.position.z = -0.12;
    this.rays.visible = false;
    this.rays.userData.noOutline = true;
    this.swivel.add(this.rays);

    addOutlines(this.body, 1.04);
    this.body.traverse((o) => {
      o.raycast = () => {};
    });

    this.sparks = new Sparks(this.root, 220, true, "wheel-sparks");
    this.placeRoot();
  }

  /** True while lowered (between spin() and the end of raise()). */
  get down(): boolean {
    return this.isDown;
  }

  /** Lower (descendMs; 0 = already down) then spin so `slice` lands under the pointer after spinMs. `turns` = extra full rotations (an upper bound for the visual). */
  spin(slice: WheelSliceId, descendMs: number, spinMs: number, turns: number, onTick?: (speed: number) => void): Promise<void> {
    const t0 = nowMs();
    this.finishSpin();
    this.isDown = true;
    this.root.visible = true;
    this.onTick = onTick;
    this.celebrateT = -1;
    this.winner.visible = false;
    this.rays.visible = false;

    if (this.mode !== "down") {
      if (descendMs > 0) {
        this.mode = "descend";
        this.modeStart = t0;
        this.modeDur = descendMs;
        this.lowerFrom = clamp01(this.lowered);
        // the ceiling flaps open (and the lights go down) before the wheel comes through them
        this.openSlot();
      } else {
        // Already down on the server (re-spin, or we joined mid-wheel): snap into place, facing the viewer.
        this.mode = "down";
        this.lowered = 1;
        this.placeRoot();
        this.yaw = this.viewerYaw();
        this.openSlot();
      }
    }

    const idx = Math.max(0, WHEEL_SLICES.findIndex((s) => s.id === slice));
    // Where inside the slice the pointer stops: deterministic per spin, never on a peg.
    const offset = (hash01(idx * 7.13 + turns * 3.7 + spinMs * 0.011) - 0.5) * 0.66 * SLICE;
    const target = -(idx * SLICE + offset);
    const base = this.angle;
    const d = (((target - base) % TAU) + TAU) % TAU;
    const total = Math.max(1, spinMs) / 1000;
    this.windSec = Math.min(WIND_SEC, total * 0.12);
    // The landing angle doesn't depend on the number of turns, so pick as many as keep the launch (an
    // ease-out-cubic starts at 3Δ/T) under MAX_LAUNCH.
    const room = Math.floor(((MAX_LAUNCH * (total - this.windSec)) / 3 - d) / TAU);
    const turnsV = clamp(room, 1, Math.max(1, Math.round(turns)));
    this.spinFrom = base;
    this.spinTo = base + turnsV * TAU + d;
    this.spinStart = t0 + Math.max(0, descendMs);
    this.spinDur = Math.max(1, spinMs);
    this.spinning = true;
    this.lastNow = t0;
    this.pegIndex = Math.floor((this.angle - SLICE / 2) / SLICE);

    return new Promise<void>((resolve) => {
      this.spinResolve = resolve;
      // Lands on time even if frames stall (hidden tab): the visual snaps to the result on the next frame.
      this.spinGuard = window.setTimeout(() => this.finishSpin(), Math.max(0, descendMs) + Math.max(1, spinMs) + 40);
    });
  }

  /** Winning slice glow + bulbs flash (call when WHEEL_RESULT arrives). */
  celebrate(slice: WheelSliceId): void {
    if (!this.isDown) return;
    if (this.spinning) this.finishSpin();
    const idx = Math.max(0, WHEEL_SLICES.findIndex((s) => s.id === slice));
    this.celebrateSlice = idx;
    this.celebrateT = 0;
    this.punchT = 0;
    this.winner.rotation.z = -idx * SLICE;
    this.winner.visible = true;
    this.dimMat.opacity = this.frameInkMat.opacity = this.frameMat.opacity = 0;
    this.rays.visible = true;
    this.raysMat.color.set(WHEEL_SLICES[idx]!.color).lerp(_c.set(PALETTE.gold), 0.5);
    this.flapVel += 9;
    // confetti of stars from around the rim, thrown toward the viewer the wheel faces
    this.root.updateMatrixWorld(true);
    const reduced = settings.get().reducedFlashing;
    const n = reduced ? 30 : 60;
    const colors = [WHEEL_SLICES[idx]!.color, PALETTE.gold, "#FFFFFF"];
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    for (let k = 0; k < n; k++) {
      const a = rand(0, TAU);
      _v.set(Math.cos(a) * (R + 0.04), Math.sin(a) * (R + 0.04), 0.06);
      this.swivel.localToWorld(_v);
      this.root.worldToLocal(_v);
      // velocity in the swivel's frame, turned by its yaw
      const lx = Math.cos(a) * rand(0.6, 1.8);
      const lz = rand(0.3, 1.0);
      this.sparks.spawn({
        x: _v.x,
        y: _v.y,
        z: _v.z,
        vx: lx * cy + lz * sy,
        vy: Math.sin(a) * rand(0.6, 1.8) + 0.4,
        vz: -lx * sy + lz * cy,
        size: rand(0.05, 0.1),
        sizeEnd: 0.01,
        life: rand(0.7, 1.4),
        color: pick(colors),
        frame: SPARK_STAR,
        gravity: 1.6,
        drag: 1.2,
        spin: rand(-6, 6),
      });
    }
    for (let k = 0; k < 5; k++) {
      this.sparks.spawn({ x: 0.1 * sy, y: k * 0.02, z: 0.1 * cy, size: 0.45, sizeEnd: 1.2, life: 0.5, color: WHEEL_SLICES[idx]!.color, alpha: reduced ? 0.2 : 0.5, frame: SPARK_GLOW });
    }
  }

  /** Hoist back into the ceiling. */
  raise(): void {
    if (this.mode === "hidden" || this.mode === "raise") return;
    this.finishSpin();
    this.mode = "raise";
    this.modeStart = nowMs();
    this.modeDur = WHEEL_ASCEND_SEC * 1000;
    this.lowerFrom = this.lowered;
    this.yawFrom = this.yaw;
    // the slot must stay open until the wheel is back above the flaps
    this.openSlot();
  }

  update(dt: number, time: number): void {
    void time;
    if (this.mode === "hidden") {
      this.sparks.update(dt, this.stage.renderer, this.stage.camera);
      return;
    }
    const now = nowMs();
    const frameSec = clamp((now - this.lastNow) / 1000, 1 / 240, 0.1);
    this.lastNow = now;
    this.clock += dt;

    // ---- height (+ the swivel toward the viewer)
    const a = this.stage.anchors;
    const span = Math.max(0.01, a.wheelUp.y - a.wheelDown.y);
    /** `lowered` above which the swiveling part is below the ceiling and free to turn. */
    const turnFree = clamp01((a.wheelUp.y - (CEILING_Y - SWIVEL_TOP - 0.03)) / span);
    /** `lowered` above which the sign is below the ceiling and may turn with the wheel. */
    const signFree = clamp01((a.wheelUp.y - (CEILING_Y - SIGN_TOP - 0.03)) / span);
    /** `lowered` below which the whole wheel is back above the flaps. */
    const clear = clamp01((a.wheelUp.y - (CEILING_Y + BOTTOM + 0.04)) / span);
    if (this.mode === "descend") {
      const elapsed = now - this.modeStart;
      const wait = Math.min(SLOT_WAIT_MS, this.modeDur * 0.3);
      if (elapsed < wait) this.lowered = this.lowerFrom;
      else {
        const u = clamp01((elapsed - wait) / Math.max(1, this.modeDur - wait));
        this.lowered = this.lowerFrom + (1 - this.lowerFrom) * easeInOutBack(u);
        if (u >= 1) this.landed();
      }
      if (this.mode === "descend" || this.mode === "down") this.turnToViewer(turnFree, dt);
    } else if (this.mode === "raise") {
      const u = clamp01((now - this.modeStart) / this.modeDur);
      const turnU = 0.24;
      if (u < turnU) {
        // swivel back in line with the slot, with a little dip as the chains take the weight
        const k = u / turnU;
        this.yaw = this.yawFrom * (1 - easeInOutSine(k));
        this.lowered = this.lowerFrom + 0.025 * Math.sin(Math.PI * k);
      } else {
        this.yaw = 0;
        this.lowered = this.lowerFrom * (1 - easeInOutCubic((u - turnU) / (1 - turnU)));
      }
      if (this.holdingSlot) {
        if (this.lowered < clear) this.closeSlot();
        else this.stage.setLightsOut(true);
      }
      if (u >= 1) {
        this.mode = "hidden";
        this.lowered = 0;
        this.yaw = 0;
        this.isDown = false;
        this.root.visible = false;
        this.celebrateT = -1;
        this.winner.visible = false;
        this.rays.visible = false;
        this.blur.visible = false;
        if (this.holdingSlot) this.closeSlot();
      }
    } else {
      this.turnToViewer(turnFree, dt);
    }
    this.placeRoot();
    this.swivel.rotation.y = this.yaw;
    this.signHang.rotation.y =
      clamp(this.yaw, -SIGN_MAX_YAW, SIGN_MAX_YAW) * smoothstep(signFree, Math.min(1, signFree + 0.08), this.lowered);

    // ---- spin + pegs + flapper
    this.omega = 0;
    if (this.spinning && now >= this.spinStart) {
      const total = this.spinDur / 1000;
      const k = (now - this.spinStart) / 1000;
      const wind = this.windSec;
      if (k < wind) {
        // the dealer's pull: rock back, then let go
        this.angle = this.spinFrom - WIND * Math.sin((Math.PI * k) / wind);
        this.speed = 0.05;
      } else {
        const run = Math.max(0.05, total - wind);
        const u = clamp01((k - wind) / run);
        const delta = this.spinTo - this.spinFrom;
        this.angle = this.spinFrom + delta * easeOutCubic(u);
        this.speed = (1 - u) * (1 - u);
        this.omega = (3 * delta * (1 - u) * (1 - u)) / run;
        if (u >= 1) this.finishSpin();
      }
    } else if (!this.spinning) {
      this.speed = damp(this.speed, 0, 6, dt);
    }
    this.spinner.rotation.z = -this.angle;
    // motion blur by how far the face turns in one frame (more blur on a slow frame)
    const step = this.omega * frameSec;
    const blur = smoothstep(0.1 * SLICE, 0.34 * SLICE, step);
    this.blurMat.opacity = blur * 0.94;
    this.blur.visible = this.blurMat.opacity > 0.01;
    const peg = Math.floor((this.angle - SLICE / 2) / SLICE);
    if (peg !== this.pegIndex) {
      const crossings = Math.min(3, Math.abs(peg - this.pegIndex));
      this.pegIndex = peg;
      for (let i = 0; i < crossings; i++) this.onTick?.(this.speed);
      this.flapVel -= 2 + this.speed * 4;
    }
    // A peg approaching the top pushes the flapper tip to the right; after it passes, a spring snaps it back.
    const toNext = (peg + 1) * SLICE + SLICE / 2 - this.angle;
    const push = toNext < CONTACT ? (1 - toNext / CONTACT) * FLAP_MAX : 0;
    if (dt > 0) {
      const acc = -900 * this.flap - 16 * this.flapVel;
      this.flapVel += acc * dt;
      this.flap += this.flapVel * dt;
    }
    if (push > this.flap) {
      this.flap = push;
      this.flapVel = 0;
    }
    this.flapper.rotation.z = this.flap;

    // ---- swing after the drop + a little torque wobble while spinning
    this.swingT += dt;
    const swing = this.swingAmp * Math.exp(-this.swingT * 1.6) * Math.sin(this.swingT * 4.2);
    this.pivot.rotation.x = swing;
    this.pivot.rotation.z = swing * 0.35 + this.speed * 0.012 * Math.sin(this.clock * 13);

    // ---- celebrate: slice pulse, rays (never wider than the view), punch
    const reduced = settings.get().reducedFlashing;
    if (this.celebrateT >= 0) {
      this.celebrateT += dt;
      const t = this.celebrateT;
      const fadeOut = clamp01((WHEEL_HOLD_SEC + 1.2 - t) / 0.6);
      const show = Math.min(1, t * 5) * fadeOut;
      this.dimMat.opacity = DIM_ALPHA * show;
      this.frameInkMat.opacity = 0.9 * show;
      this.frameMat.opacity = show;
      // the frame breathes between gold and a hot pale gold (steady under reduced flashing)
      const pulse = reduced ? 0.3 : 0.5 + 0.5 * Math.sin(t * 9);
      this.frameMat.color.copy(_gold).lerp(_hot, pulse);
      const fit = this.raysFit();
      this.raysMat.opacity = Math.min(1, t * 3) * (reduced ? 0.22 : 0.5) * fadeOut * (0.6 + 0.4 * fit);
      this.rays.rotation.z -= dt * 0.5;
      this.rays.scale.setScalar((1 + Math.min(1, t * 4) * 0.12 * fadeOut) * fit);
      if (fadeOut <= 0) {
        this.celebrateT = -1;
        this.winner.visible = false;
        this.rays.visible = false;
      }
    }
    if (this.punchT >= 0) {
      this.punchT += dt;
      const t = this.punchT;
      const k = 1 + 0.09 * Math.exp(-t * 5) * Math.sin(t * 22 + 0.3);
      this.body.scale.setScalar(k);
      if (t > 1.2) {
        this.punchT = -1;
        this.body.scale.setScalar(1);
      }
    }
    this.gemMat.emissiveIntensity = 0.8 + 0.6 * Math.sin(this.clock * 3);

    this.updateBulbs(dt, reduced);
    this.sparks.update(dt, this.stage.renderer, this.stage.camera);
  }

  // ------------------------------------------------------------------------------------------ helpers

  private landed(): void {
    this.mode = "down";
    this.lowered = 1;
    this.swingT = 0;
    this.swingAmp = 0.06;
    this.dust();
  }

  private openSlot(): void {
    this.holdingSlot = true;
    this.stage.setLightsOut(true);
  }

  private closeSlot(): void {
    this.holdingSlot = false;
    this.stage.setLightsOut(false);
  }

  /** Yaw (rad, about +y) that turns the face (+z) toward the viewer, clamped. */
  private viewerYaw(): number {
    this.stage.readingBasis(_eye, _dir);
    const dx = _eye.x - this.root.position.x;
    const dz = _eye.z - this.root.position.z;
    if (dx * dx + dz * dz < 1e-4) return 0;
    return clamp(Math.atan2(dx, dz), -MAX_YAW, MAX_YAW);
  }

  /** Swivel toward the viewer once the swiveling part is below the ceiling (`free` = that `lowered`). */
  private turnToViewer(free: number, dt: number): void {
    const allow = smoothstep(free, Math.min(1, free + 0.08), this.lowered);
    const want = this.viewerYaw() * allow;
    this.yaw = allow < 1 && Math.abs(this.yaw) > Math.abs(want) ? want : dampAngle(this.yaw, want, 2.6, dt);
  }

  /** Rays scale so they never cover more than ~85% of the screen height at the wheel's distance. */
  private raysFit(): number {
    _eye.setFromMatrixPosition(this.stage.camera.matrixWorld);
    this.root.getWorldPosition(_d);
    const dist = Math.max(0.5, _eye.distanceTo(_d));
    const screenH = 2 * dist * Math.tan(THREE.MathUtils.degToRad(this.stage.camera.fov) * 0.5);
    return Math.min(1, (0.85 * screenH) / (R * 3.6));
  }

  private placeRoot(): void {
    const a = this.stage.anchors;
    this.root.position.lerpVectors(a.wheelUp, a.wheelDown, this.lowered);
    // Swing from up near the ceiling so the visible chain stays straight.
    const pivotH = Math.max(PIVOT_H, a.wheelUp.y - a.wheelDown.y);
    this.pivot.position.y = pivotH;
    this.body.position.y = -pivotH;
  }

  private finishSpin(): void {
    if (this.spinGuard) {
      window.clearTimeout(this.spinGuard);
      this.spinGuard = 0;
    }
    if (this.spinning) {
      this.spinning = false;
      this.angle = this.spinTo;
      this.omega = 0;
      this.spinner.rotation.z = -this.angle;
      this.blurMat.opacity = 0;
      this.blur.visible = false;
      this.pegIndex = Math.floor((this.angle - SLICE / 2) / SLICE);
      if (this.mode === "descend") {
        this.landed();
        this.placeRoot();
      }
    }
    const r = this.spinResolve;
    this.spinResolve = null;
    r?.();
  }

  private dust(): void {
    const cy = Math.cos(this.yaw);
    const sy = Math.sin(this.yaw);
    for (let k = 0; k < 14; k++) {
      const x = rand(-0.5, 0.5);
      this.sparks.spawn({
        x: x * cy,
        y: R + 0.45 + rand(0, 0.1),
        z: -x * sy + rand(-0.05, 0.05),
        vx: rand(-0.4, 0.4),
        vy: rand(-0.2, 0.3),
        vz: rand(-0.1, 0.2),
        size: rand(0.03, 0.06),
        life: rand(0.5, 1),
        color: "#FFE6A0",
        alpha: 0.7,
        frame: SPARK_DOT,
        gravity: 0.8,
        drag: 2,
      });
    }
  }

  private updateBulbs(dt: number, reduced: boolean): void {
    this.chase += dt * (reduced ? 2 + this.speed * 4 : 3 + this.speed * 30);
    const celebrating = this.celebrateT >= 0;
    if (celebrating) _slice.set(WHEEL_SLICES[this.celebrateSlice]!.color);
    for (let k = 0; k < BULBS; k++) {
      let b: number;
      if (celebrating) {
        b = reduced ? 0.7 + 0.3 * Math.sin(this.celebrateT * 3) : (k + Math.floor(this.celebrateT * 9)) % 2 === 0 ? 1 : 0.12;
      } else if (this.spinning || this.speed > 0.02) {
        b = reduced
          ? 0.5 + 0.5 * Math.sin(k * 0.8 - this.chase)
          : (((k - Math.floor(this.chase)) % 4) + 4) % 4 < 2
            ? 1
            : 0.1;
      } else {
        b = 0.55 + 0.45 * Math.sin(this.clock * 2.6 + k * 0.9);
      }
      _c.copy(_off).lerp(_on, b);
      if (celebrating && k % 2 === 1) _c.lerp(_slice, 0.5);
      this.bulbs.setColorAt(k, _c);
    }
    if (this.bulbs.instanceColor) this.bulbs.instanceColor.needsUpdate = true;
  }
}
