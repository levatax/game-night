// Per-seat money stacks on the felt (§13 "para yığını"): poker chips in the player's color (towers of 10, up
// to 3 towers) next to a pile of green banknote bricks, topped with gold bars for the really rich. The shown
// amount counts toward the real kasa (ease-out), so chips cascade in one by one with a drop + squash and pop
// away when money leaves. Everything is instanced: chips (body / notches / top ring / outline share one
// instance matrix buffer), bricks (+ outline) and bars — at most 7 draw calls for all six seats (empty
// layers are hidden), 3 shadow casters.

import * as THREE from "three";
import { PALETTE } from "../../../../shared/constants";
import { toon } from "../toon";
import { inkBackMaterial } from "./batch";
import { brickTexture, chipEdgeTexture, chipTopTexture } from "./textures";

const SEATS = 6;
const MAX_CHIPS = 30;
const MAX_BRICKS = 15;
const MAX_BARS = 3;
const CHIP_R = 0.034;
const CHIP_H = 0.0135;
const BRICK = new THREE.Vector3(0.068, 0.036, 0.145);
const BAR = new THREE.Vector3(0.11, 0.035, 0.05);

/** Chip tower centers in the stack frame (x = player's right, z = toward the table center). */
const TOWERS: [number, number][] = [
  [0.0, 0.0],
  [0.074, 0.006],
  [0.036, 0.066],
];
const BRICK_ORIGIN = new THREE.Vector2(-0.16, 0.02);
const UP = new THREE.Vector3(0, 1, 0);

export interface StackPieces {
  chips: number;
  bricks: number;
  bars: number;
}

/** kasa → visible pieces. ≤200$: 10$ chips; above: 100$ bricks + leftover chips; bricks cap → gold bars. */
export function stackPieces(v: number, out: StackPieces = { chips: 0, bricks: 0, bars: 0 }): StackPieces {
  const value = Math.max(0, v);
  if (value <= 200) {
    out.chips = Math.min(MAX_CHIPS, Math.round(value / 10));
    out.bricks = 0;
    out.bars = 0;
    return out;
  }
  const over = value - 200;
  out.chips = Math.min(MAX_CHIPS, 20 + Math.round((over % 100) / 10));
  out.bricks = Math.min(MAX_BRICKS, Math.floor(over / 100));
  out.bars = value >= 1800 ? Math.min(MAX_BARS, 1 + Math.floor((value - 1800) / 700)) : 0;
  return out;
}

interface Slot {
  /** 0 = gone .. 1 = resting. */
  p: number;
  target: 0 | 1;
  /** Landing squash timer (s since landing, −1 = none). */
  land: number;
}

interface SeatStack {
  active: boolean;
  color: THREE.Color;
  pos: THREE.Vector3;
  posVel: THREE.Vector3;
  goal: THREE.Vector3;
  right: THREE.Vector3;
  goalRight: THREE.Vector3;
  value: number;
  from: number;
  to: number;
  t: number;
  chips: Slot[];
  bricks: Slot[];
  bars: Slot[];
  /** Deterministic jitter per piece so piles look hand-stacked. */
  jitter: number[];
}

const slots = (n: number): Slot[] => Array.from({ length: n }, () => ({ p: 0, target: 0 as 0 | 1, land: -1 }));

export class Stacks {
  readonly group = new THREE.Group();
  private seats: SeatStack[] = [];
  private chipBody: THREE.InstancedMesh;
  private chipSide: THREE.InstancedMesh;
  private chipTop: THREE.InstancedMesh;
  private chipLine: THREE.InstancedMesh;
  private brick: THREE.InstancedMesh;
  private brickLine: THREE.InstancedMesh;
  private bar: THREE.InstancedMesh;
  private chipLayers: THREE.InstancedMesh[];
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private basis = new THREE.Matrix4();
  private back = new THREE.Vector3();
  private qBasis = new THREE.Quaternion();
  private dirty = true;
  private pieces: StackPieces = { chips: 0, bricks: 0, bars: 0 };
  /** Stack frame of the seat being written (writeMatrices). */
  private framePos = new THREE.Vector3();

  constructor() {
    this.group.name = "stacks";
    const chipCap = SEATS * MAX_CHIPS;
    const bodyGeo = new THREE.CylinderGeometry(CHIP_R, CHIP_R, CHIP_H, 20);
    this.chipBody = new THREE.InstancedMesh(bodyGeo, toon("#FFFFFF", { unique: true }), chipCap);
    const edge = chipEdgeTexture();
    edge.repeat.set(2, 1);
    const sideMat = toon("#FFFFFF", { map: edge, unique: true });
    sideMat.alphaTest = 0.5;
    this.chipSide = new THREE.InstancedMesh(new THREE.CylinderGeometry(CHIP_R * 1.012, CHIP_R * 1.012, CHIP_H * 0.94, 20, 1, true), sideMat, chipCap);
    const topMat = toon("#FFFFFF", { map: chipTopTexture(), unique: true });
    topMat.alphaTest = 0.5;
    const topGeo = new THREE.CircleGeometry(CHIP_R * 0.97, 20);
    topGeo.rotateX(-Math.PI / 2);
    topGeo.translate(0, CHIP_H / 2 + 0.0006, 0);
    this.chipTop = new THREE.InstancedMesh(topGeo, topMat, chipCap);
    this.chipLine = new THREE.InstancedMesh(new THREE.CylinderGeometry(CHIP_R * 1.13, CHIP_R * 1.13, CHIP_H + 0.003, 16), inkBackMaterial(), chipCap);
    // all chip layers share one matrix buffer
    const shared = this.chipBody.instanceMatrix;
    this.chipSide.instanceMatrix = shared;
    this.chipTop.instanceMatrix = shared;
    this.chipLine.instanceMatrix = shared;
    this.chipBody.setColorAt(0, new THREE.Color("#FFFFFF"));

    const brickCap = SEATS * MAX_BRICKS;
    this.brick = new THREE.InstancedMesh(new THREE.BoxGeometry(BRICK.x, BRICK.y, BRICK.z), toon("#FFFFFF", { map: brickTexture(), unique: true }), brickCap);
    this.brickLine = new THREE.InstancedMesh(new THREE.BoxGeometry(BRICK.x + 0.008, BRICK.y + 0.007, BRICK.z + 0.008), inkBackMaterial(), brickCap);
    this.brickLine.instanceMatrix = this.brick.instanceMatrix;
    const barGeo = new THREE.CylinderGeometry(0.5, 0.62, 1, 4, 1);
    barGeo.rotateY(Math.PI / 4);
    barGeo.scale(BAR.x / 0.88, BAR.y, BAR.z / 0.88);
    this.bar = new THREE.InstancedMesh(barGeo, toon(PALETTE.gold, { emissive: "#6A4A00", emissiveIntensity: 0.4, unique: true }), SEATS * MAX_BARS);

    for (const mesh of [this.chipBody, this.chipSide, this.chipTop, this.chipLine, this.brick, this.brickLine, this.bar]) {
      mesh.count = 0;
      mesh.visible = false;
      mesh.frustumCulled = false;
      // one caster per silhouette: the chip body (edge + top decals and hulls add nothing to the shadow)
      mesh.castShadow = mesh === this.chipBody || mesh === this.brick || mesh === this.bar;
      mesh.receiveShadow = mesh !== this.chipLine && mesh !== this.brickLine;
      this.group.add(mesh);
    }
    this.chipLayers = [this.chipBody, this.chipSide, this.chipTop, this.chipLine];
    this.chipLine.raycast = () => {};
    this.brickLine.raycast = () => {};

    for (let i = 0; i < SEATS; i++) {
      const jitter: number[] = [];
      let r = (i + 1) * 9301;
      for (let k = 0; k < 64; k++) {
        r = (r * 9301 + 49297) % 233280;
        jitter.push(r / 233280 - 0.5);
      }
      this.seats.push({
        active: false,
        color: new THREE.Color(),
        pos: new THREE.Vector3(),
        posVel: new THREE.Vector3(),
        goal: new THREE.Vector3(),
        right: new THREE.Vector3(1, 0, 0),
        goalRight: new THREE.Vector3(1, 0, 0),
        value: 0,
        from: 0,
        to: 0,
        t: 1,
        chips: slots(MAX_CHIPS),
        bricks: slots(MAX_BRICKS),
        bars: slots(MAX_BARS),
        jitter,
      });
    }
  }

  /**
   * Place / update a seat's stack: it glides (and turns) to `at`. `right` = the pile frame's x axis on the table
   * (unit xz): the player's right, or outward for the first-person pile (turned 90°: chips toward the player,
   * the note bricks behind them).
   */
  set(seat: number, at: THREE.Vector3, right: THREE.Vector3, color: string, kasa: number): void {
    const s = this.seats[seat];
    if (!s) return;
    if (!s.active) {
      s.active = true;
      s.pos.copy(at);
      s.posVel.set(0, 0, 0);
      s.right.copy(right);
      s.value = 0;
      s.from = 0;
      s.to = 0;
      s.t = 1;
    }
    s.goal.copy(at);
    s.goalRight.copy(right);
    s.color.set(color);
    if (kasa !== s.to) {
      s.from = s.value;
      s.to = kasa;
      s.t = 0;
    }
    this.dirty = true;
  }

  /** Seat no longer in use: its pieces pop away. */
  clear(seat: number): void {
    const s = this.seats[seat];
    if (!s || !s.active) return;
    s.from = s.value;
    s.to = 0;
    s.t = 0;
    s.active = false;
    this.dirty = true;
  }

  /** Displayed (counting) value of a seat's stack — the name plate shows the same number. */
  shown(seat: number): number {
    return this.seats[seat]?.value ?? 0;
  }

  /** World point at the top of a seat's chip towers (for chip / money fx). */
  top(seat: number, out: THREE.Vector3): THREE.Vector3 {
    const s = this.seats[seat];
    if (!s) return out.set(0, 0, 0);
    const pieces = stackPieces(s.value, this.pieces);
    const h = Math.min(10, pieces.chips) * CHIP_H;
    return out.copy(s.pos).setY(s.pos.y + h + 0.03);
  }

  update(dt: number): void {
    let animating = this.dirty;
    this.dirty = false;
    for (const s of this.seats) {
      // count toward the target kasa
      if (s.t < 1) {
        const dur = Math.min(1.4, 0.45 + Math.abs(s.to - s.from) / 400);
        s.t = Math.min(1, s.t + dt / dur);
        const e = 1 - Math.pow(1 - s.t, 3);
        s.value = s.from + (s.to - s.from) * e;
        animating = true;
      }
      // glide to a new spot (seat count changed, first person on / off)
      const dx = s.goal.x - s.pos.x;
      const dz = s.goal.z - s.pos.z;
      if (Math.abs(dx) + Math.abs(dz) > 1e-4 || s.posVel.lengthSq() > 1e-6) {
        const k = 60;
        const c = 2 * Math.sqrt(k);
        s.posVel.x += (dx * k - s.posVel.x * c) * dt;
        s.posVel.z += (dz * k - s.posVel.z * c) * dt;
        s.pos.x += s.posVel.x * dt;
        s.pos.z += s.posVel.z * dt;
        s.pos.y = s.goal.y;
        animating = true;
      }
      // …and turn with it (the first-person pile is turned 90°)
      if (1 - s.right.dot(s.goalRight) > 1e-6) {
        s.right.lerp(s.goalRight, 1 - Math.exp(-9 * dt));
        // exactly opposite frames would pass through zero: step a quarter turn first
        if (s.right.lengthSq() < 1e-4) s.right.set(-s.goalRight.z, 0, s.goalRight.x);
        s.right.normalize();
        if (1 - s.right.dot(s.goalRight) <= 1e-6) s.right.copy(s.goalRight);
        animating = true;
      }
      const want = stackPieces(s.value, this.pieces);
      if (stepSlots(s.chips, want.chips, dt, 7, 0.4)) animating = true;
      if (stepSlots(s.bricks, want.bricks, dt, 5, 0.45)) animating = true;
      if (stepSlots(s.bars, want.bars, dt, 3.5, 0.5)) animating = true;
    }
    if (animating) this.writeMatrices();
  }

  /** Stack-frame point (x = right, z = toward the table center) → world, for the seat being written. */
  private local = (x: number, y: number, z: number, out: THREE.Vector3): THREE.Vector3 =>
    out.set(x, y, -z).applyMatrix4(this.basis).add(this.framePos);
  /** Stack-frame yaw → world quaternion (this.q). */
  private turn = (yaw: number): THREE.Quaternion => this.q.setFromAxisAngle(UP, yaw).premultiply(this.qBasis);

  private writeMatrices(): void {
    let nc = 0;
    let nb = 0;
    let ng = 0;
    for (let si = 0; si < this.seats.length; si++) {
      const s = this.seats[si]!;
      // right-handed frame (right, up, back = outward u); callers pass z = toward the table center
      this.back.set(-s.right.z, 0, s.right.x);
      this.basis.makeBasis(s.right, UP, this.back);
      this.qBasis.setFromRotationMatrix(this.basis);
      this.framePos.copy(s.pos);
      const local = this.local;
      const turn = this.turn;

      // chips
      for (let k = 0; k < MAX_CHIPS; k++) {
        const slot = s.chips[k]!;
        if (slot.p <= 0.001) continue;
        const tower = Math.floor(k / 10);
        const level = k % 10;
        const [tx, tz] = TOWERS[tower]!;
        const j = s.jitter[k]!;
        const rising = slot.target === 1;
        const drop = rising ? (1 - slot.p) * (1 - slot.p) * 0.26 : 0;
        const sc = rising ? 1 : slot.p;
        let sy = 1;
        let sxz = 1;
        if (slot.land >= 0 && slot.land < 0.25) {
          const w = Math.sin((slot.land / 0.25) * Math.PI) * (1 - slot.land / 0.25);
          sy = 1 - w * 0.45;
          sxz = 1 + w * 0.25;
        }
        local(tx + j * 0.004, CHIP_H * (level + 0.5) + drop, tz + s.jitter[k + 30]! * 0.004, this.p);
        turn(j * 2);
        this.s.set(sc * sxz, sc * sy, sc * sxz);
        this.m.compose(this.p, this.q, this.s);
        this.chipBody.setMatrixAt(nc, this.m);
        this.chipBody.setColorAt(nc, s.color);
        nc++;
      }

      // bricks: 3 per layer side by side, alternate layers slightly turned
      for (let k = 0; k < MAX_BRICKS; k++) {
        const slot = s.bricks[k]!;
        if (slot.p <= 0.001) continue;
        const layer = Math.floor(k / 3);
        const col = k % 3;
        const j = s.jitter[k + 10]!;
        const rising = slot.target === 1;
        const drop = rising ? (1 - slot.p) * (1 - slot.p) * 0.3 : 0;
        const sc = rising ? 1 : slot.p;
        const lx = BRICK_ORIGIN.x + (col - 1) * (BRICK.x + 0.004) + j * 0.01;
        const lz = BRICK_ORIGIN.y + (layer % 2) * 0.012 + s.jitter[k + 40]! * 0.012;
        local(lx, BRICK.y * (layer + 0.5) + drop, lz, this.p);
        turn(j * 0.18 + (layer % 2 ? 0.05 : -0.04));
        let sy = 1;
        if (slot.land >= 0 && slot.land < 0.25) sy = 1 - Math.sin((slot.land / 0.25) * Math.PI) * 0.3;
        this.s.set(sc, sc * sy, sc);
        this.m.compose(this.p, this.q, this.s);
        this.brick.setMatrixAt(nb++, this.m);
      }

      // gold bars on top of the brick pile
      const brickLayers = Math.ceil(stackPieces(s.value, this.pieces).bricks / 3);
      for (let k = 0; k < MAX_BARS; k++) {
        const slot = s.bars[k]!;
        if (slot.p <= 0.001) continue;
        const rising = slot.target === 1;
        const drop = rising ? (1 - slot.p) * (1 - slot.p) * 0.35 : 0;
        const sc = rising ? 1 : slot.p;
        local(BRICK_ORIGIN.x + (k - 1) * 0.05, BRICK.y * brickLayers + BAR.y * (0.5 + (k === 1 ? 1 : 0)) + drop, BRICK_ORIGIN.y + (k === 1 ? 0 : 0.03), this.p);
        turn((k - 1) * 0.5);
        this.s.setScalar(sc);
        this.m.compose(this.p, this.q, this.s);
        this.bar.setMatrixAt(ng++, this.m);
      }
    }
    for (const mesh of this.chipLayers) {
      mesh.count = nc;
      mesh.visible = nc > 0;
    }
    this.brick.count = nb;
    this.brickLine.count = nb;
    this.bar.count = ng;
    this.brick.visible = this.brickLine.visible = nb > 0;
    this.bar.visible = ng > 0;
    this.chipBody.instanceMatrix.needsUpdate = true;
    if (this.chipBody.instanceColor) this.chipBody.instanceColor.needsUpdate = true;
    this.brick.instanceMatrix.needsUpdate = true;
    this.bar.instanceMatrix.needsUpdate = true;
  }
}

/**
 * Move slots toward `want` present pieces. Rising pieces cascade bottom-up (a piece starts once the one
 * below is `stagger` landed); leaving pieces pop top-down. Returns true while anything moves.
 */
function stepSlots(list: Slot[], want: number, dt: number, rate: number, stagger: number): boolean {
  let moving = false;
  for (let k = 0; k < list.length; k++) list[k]!.target = k < want ? 1 : 0;
  // rising: bottom-up cascade
  for (let k = 0; k < list.length; k++) {
    const s = list[k]!;
    if (s.target === 1 && s.p < 1) {
      const below = k === 0 || list[k - 1]!.p >= stagger || list[k - 1]!.target === 0;
      if (!below) break;
      s.p = Math.min(1, s.p + dt * rate);
      if (s.p >= 1) s.land = 0;
      moving = true;
    }
    if (s.land >= 0) {
      s.land += dt;
      if (s.land > 0.3) s.land = -1;
      moving = true;
    }
  }
  // leaving: top-down
  for (let k = list.length - 1; k >= 0; k--) {
    const s = list[k]!;
    if (s.target === 0 && s.p > 0) {
      s.p = Math.max(0, s.p - dt * rate * 2.2);
      s.land = -1;
      moving = true;
      if (s.p > 0.35) break;
    }
  }
  return moving;
}
