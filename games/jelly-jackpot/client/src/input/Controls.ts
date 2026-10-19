// Keyboard + mouse (+ basic touch) input. Owner: client-controls. PUBLIC API IS THE CONTRACT.
//
// Two jobs:
// 1) Global key/mouse actions → `actions` events (Game decides what they do): Space spin, R rig, 1–4 bet
//    amount, F/G bet stand/fall, T emote (down/up), Tab scoreboard (down/up, preventDefault), Esc menu.
//    Ignore keys while focus is in an <input>/<textarea>. Camera orbit: right-drag or A/D (and left-drag
//    when NOT placing), wheel zoom when not placing → stage.orbit / stage.zoom, scaled by
//    settings.cameraSensitivity and invertOrbit.
// 2) Placement (beginPlacement … endPlacement), only for the active player:
//    - Mouse move → stage.pickLocal(x, y, planeY) where planeY = the current hover height (provided via
//      setMinY: the lowest legal center y, recomputed by Game from the state; hover y = minY + 0.03). Clamp
//      xz to HOVER_RADIUS. Mirror Hands: mirror the screen x around the canvas center before picking.
//    - Yaw: scroll or Q/E (15° steps on scroll, 120°/s held). Pitch: W/S (90°/s, clamp ±60°).
//      Tied Hands: no rotation at all; instead the piece swings like a pendulum on a string (lagging spring
//      behind the cursor + sway) — apply to the pose.
//    - Hiccups: the server adds hops; the client only shows what the server relays, nothing to do here.
//    - Left click (or Enter) → emit "drop" with the current pose. Touch: drag to move, two-finger twist =
//      yaw, tap the on-screen DROP button (create it while placing on touch devices).
//    - Every frame: emit nothing; Game reads `pose()` and sends net.hover(pose) (Net throttles).
// Upside Down card: the Stage flips the camera; pickLocal already accounts for it (no extra inversion).
//
// Notes: `betAmount` carries the coin VALUE from BET_AMOUNTS (keys 1–4 → 0/10/25/50), not the index.
// Touch extras: two-finger vertical drag = pitch; when not placing, one-finger drag orbits, pinch zooms.

import * as THREE from "three";
import { BET_AMOUNTS, HOVER_RADIUS, type PieceType } from "../../../shared/constants";
import type { Pose } from "../../../shared/protocol";
import { settings } from "../app/settings";
import type { Stage } from "../scene/Stage";
import { Emitter } from "../util/Emitter";
import "./controls.css";

export interface ControlActions {
  spin: void;
  rig: void;
  betAmount: number;
  bet: "stand" | "fall";
  emoteDown: void;
  emoteUp: void;
  scoreboardDown: void;
  scoreboardUp: void;
  menu: void;
  drop: Pose;
}

export interface PlacementOptions {
  type: PieceType;
  scale: number;
  mirror: boolean;
  tiedHands: boolean;
}

// ---- tuning ----------------------------------------------------------------------------------------------
const DEG = Math.PI / 180;
const HOVER_LIFT = 0.03; // hover center sits this far above minY
const SCROLL_STEP = 15 * DEG;
const SCROLL_UNITS_PER_STEP = 60; // trackpads send tiny deltas: accumulate to one 15° step
const YAW_SPEED = 120 * DEG; // rad/s held Q/E
const PITCH_SPEED = 90 * DEG; // rad/s held W/S
const PITCH_LIMIT = 60 * DEG;
const ORBIT_KEY_SPEED = 1.6; // rad/s held A/D
const ORBIT_PX = 0.006; // rad per dragged pixel
const ZOOM_PER_WHEEL = 0.0015;
const POS_SMOOTH = 22; // 1/s, exponential follow of the cursor
const ROT_SMOOTH = 18;
const DROP_GUARD_MS = 280; // ignore drops right after placement starts (no accidental double-clicks)
const DRAG_DEADZONE = 4; // px before a left press counts as a drag

// Tied Hands pendulum (a piece dangling from a string held at the cursor)
const STRING_LEN = 0.14; // m
const GRAVITY = 9.81;
const PEND_DAMP = 0.9; // light damping: it keeps swinging, which is the joke
const PEND_MAX = 0.8; // max offset as a fraction of string length
const SWAY_FORCE = 0.35; // m/s² drunken sway

const Y_AXIS = new THREE.Vector3(0, 1, 0);

const isTypingTarget = (t: EventTarget | null): boolean => {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
};

const shortestAngle = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));

interface TouchPt {
  x: number;
  y: number;
}

export class Controls {
  readonly actions = new Emitter<ControlActions>();

  private stage: Stage;
  private canvas: HTMLElement;
  private cleanup: Array<() => void> = [];

  // global input state
  private held = new Set<string>();
  private scoreboardHeld = false;
  private emoteHeld = false;
  private orbitDrag: { id: number; x: number; y: number; moved: number; button: number } | null = null;
  private touches = new Map<number, TouchPt>();
  private twist: { angle: number; midY: number; dist: number } | null = null;
  private lastClient: { x: number; y: number } | null = null;
  private sawTouch = false;

  // placement state
  private isPlacing = false;
  private opts: PlacementOptions | null = null;
  private placingSince = 0;
  private lastDropAt = 0;
  private minY = 0;
  private target = new THREE.Vector2(); // cursor point (xz), clamped
  private targetYaw = 0;
  private yaw = 0;
  private targetPitch = 0;
  private pitch = 0;
  private scrollAccum = 0;
  private time = 0;

  // pendulum (offset of the dangling piece from the string anchor, in xz)
  private pendOff = new THREE.Vector2();
  private pendVel = new THREE.Vector2();
  private anchor = new THREE.Vector2();
  private pendTwist = 0;

  private dropBtn: HTMLButtonElement | null = null;

  // scratch
  private q = new THREE.Quaternion();
  private qTmp = new THREE.Quaternion();
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private up = new THREE.Vector3();

  constructor(stage: Stage, canvas: HTMLElement) {
    this.stage = stage;
    this.canvas = canvas;
    this.sawTouch =
      typeof window !== "undefined" &&
      ((typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches) ||
        (navigator.maxTouchPoints ?? 0) > 0);

    canvas.style.touchAction = "none";

    this.listen(window, "keydown", (e) => this.onKeyDown(e as KeyboardEvent));
    this.listen(window, "keyup", (e) => this.onKeyUp(e as KeyboardEvent));
    this.listen(window, "blur", () => this.releaseAll());
    this.listen(document, "visibilitychange", () => {
      if (document.hidden) this.releaseAll();
    });
    this.listen(canvas, "contextmenu", (e) => e.preventDefault());
    this.listen(canvas, "pointerdown", (e) => this.onPointerDown(e as PointerEvent));
    this.listen(window, "pointermove", (e) => this.onPointerMove(e as PointerEvent));
    this.listen(window, "pointerup", (e) => this.onPointerUp(e as PointerEvent));
    this.listen(window, "pointercancel", (e) => this.onPointerUp(e as PointerEvent));
    this.listen(canvas, "wheel", (e) => this.onWheel(e as WheelEvent), { passive: false });
  }

  beginPlacement(opts: PlacementOptions): void {
    this.opts = { ...opts };
    this.isPlacing = true;
    this.placingSince = performance.now();
    this.targetYaw = this.yaw = 0;
    this.targetPitch = this.pitch = 0;
    this.scrollAccum = 0;
    this.target.set(0, 0);
    if (this.lastClient) this.pickAt(this.lastClient.x, this.lastClient.y);
    this.anchor.copy(this.target);
    // Start with a cheeky little kick so tied hands is immediately obvious.
    this.pendOff.set(opts.tiedHands ? STRING_LEN * 0.35 : 0, 0);
    this.pendVel.set(0, opts.tiedHands ? 0.4 : 0);
    this.pendTwist = 0;
    if (this.sawTouch) this.showDropButton();
  }

  endPlacement(): void {
    this.isPlacing = false;
    this.opts = null;
    this.hideDropButton();
    this.twist = null;
  }

  get placing(): boolean {
    return this.isPlacing;
  }

  /** Lowest legal center y for the hover piece (stand-local). */
  setMinY(y: number): void {
    if (Number.isFinite(y)) this.minY = y;
  }

  /** Current hover pose in the stand-local frame (valid while placing). */
  pose(): Pose {
    const q = this.poseQuat();
    const p = this.posePosition();
    return { x: p.x, y: p.y, z: p.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w };
  }

  /** Same pose as a quaternion object for TowerView.setLocalHover. */
  poseQuat(): THREE.Quaternion {
    if (this.opts?.tiedHands) {
      // String direction (from the piece up to the anchor) tilts the piece; a lazy twist spins it a bit.
      const d = Math.min(this.pendOff.length(), STRING_LEN * PEND_MAX);
      const h = Math.sqrt(Math.max(1e-6, STRING_LEN * STRING_LEN - d * d));
      this.up.set(-this.pendOff.x, h, -this.pendOff.y).normalize();
      this.q.setFromUnitVectors(Y_AXIS, this.up);
      this.euler.set(0, this.pendTwist, 0, "YXZ");
      this.qTmp.setFromEuler(this.euler);
      return this.q.clone().multiply(this.qTmp);
    }
    this.euler.set(this.pitch, this.yaw, 0, "YXZ");
    return new THREE.Quaternion().setFromEuler(this.euler);
  }

  /** Per-frame: held keys rotation, tied-hands pendulum, smoothing. */
  update(dt: number): void {
    if (!(dt > 0)) return;
    dt = Math.min(dt, 0.05);
    this.time += dt;

    // Camera orbit on A/D (works whether placing or not).
    const orbitDir = (this.held.has("KeyD") ? 1 : 0) - (this.held.has("KeyA") ? 1 : 0);
    if (orbitDir !== 0) this.orbit(orbitDir * ORBIT_KEY_SPEED * dt, 0);

    if (!this.isPlacing || !this.opts) return;

    // Re-pick every frame: the camera and the hover plane move even when the mouse doesn't.
    if (this.lastClient && !this.touchDragging()) this.pickAt(this.lastClient.x, this.lastClient.y);

    const tied = this.opts.tiedHands;
    if (!tied) {
      const yawDir = (this.held.has("KeyE") ? 1 : 0) - (this.held.has("KeyQ") ? 1 : 0);
      const pitchDir = (this.held.has("KeyW") ? 1 : 0) - (this.held.has("KeyS") ? 1 : 0);
      this.targetYaw += yawDir * YAW_SPEED * dt;
      this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + pitchDir * PITCH_SPEED * dt, -PITCH_LIMIT, PITCH_LIMIT);
    }
    const kr = 1 - Math.exp(-ROT_SMOOTH * dt);
    this.yaw += shortestAngle(this.targetYaw - this.yaw) * kr;
    this.pitch += (this.targetPitch - this.pitch) * kr;
    // Keep targetYaw bounded without visible jumps.
    if (Math.abs(this.targetYaw) > Math.PI * 4) {
      const wrap = Math.round(this.targetYaw / (Math.PI * 2)) * Math.PI * 2;
      this.targetYaw -= wrap;
      this.yaw -= wrap;
    }

    // Follow the cursor smoothly.
    const kp = 1 - Math.exp(-POS_SMOOTH * dt);
    const prevAnchor = this.anchor.clone();
    this.anchor.x += (this.target.x - this.anchor.x) * kp;
    this.anchor.y += (this.target.y - this.anchor.y) * kp;

    if (tied) this.stepPendulum(dt, prevAnchor);
    else this.pendOff.set(0, 0);

  }

  dispose(): void {
    this.endPlacement();
    this.releaseAll();
    for (const off of this.cleanup.splice(0)) off();
    this.actions.clear();
  }

  // ---- placement internals -----------------------------------------------------------------------------

  private hoverY(): number {
    return this.minY + HOVER_LIFT;
  }

  private posePosition(): THREE.Vector3 {
    let x = this.anchor.x + this.pendOff.x;
    let z = this.anchor.y + this.pendOff.y;
    const r = Math.hypot(x, z);
    if (r > HOVER_RADIUS) {
      x *= HOVER_RADIUS / r;
      z *= HOVER_RADIUS / r;
    }
    let y = this.hoverY();
    if (this.opts?.tiedHands) {
      // The bob rises as it swings out (it's on a string), never dipping below the legal height.
      const d = Math.min(this.pendOff.length(), STRING_LEN * PEND_MAX);
      y += STRING_LEN - Math.sqrt(STRING_LEN * STRING_LEN - d * d);
    }
    return new THREE.Vector3(x, y, z);
  }

  /** Small-angle 2D pendulum in xz hanging from the (moving) cursor anchor, plus drunken sway. */
  private stepPendulum(dt: number, prevAnchor: THREE.Vector2): void {
    // The anchor moved; inertia leaves the bob behind (offset shrinks by the anchor's motion).
    this.pendOff.x -= this.anchor.x - prevAnchor.x;
    this.pendOff.y -= this.anchor.y - prevAnchor.y;

    const w2 = GRAVITY / STRING_LEN;
    const t = this.time;
    const swayX = SWAY_FORCE * (Math.sin(t * 1.7) + 0.5 * Math.sin(t * 3.1 + 1.3));
    const swayZ = SWAY_FORCE * (Math.cos(t * 2.3) + 0.4 * Math.sin(t * 0.9 + 0.4));
    // Sub-step for stability (ω ≈ 8.4 rad/s).
    const steps = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      const ax = -w2 * this.pendOff.x - PEND_DAMP * this.pendVel.x + swayX;
      const az = -w2 * this.pendOff.y - PEND_DAMP * this.pendVel.y + swayZ;
      this.pendVel.x += ax * h;
      this.pendVel.y += az * h;
      this.pendOff.x += this.pendVel.x * h;
      this.pendOff.y += this.pendVel.y * h;
    }
    const max = STRING_LEN * PEND_MAX;
    const len = this.pendOff.length();
    if (len > max) {
      this.pendOff.multiplyScalar(max / len);
      // Lose the outward velocity component so it bounces off the limit instead of sticking.
      const n = this.pendOff.clone().normalize();
      const vn = this.pendVel.dot(n);
      if (vn > 0) this.pendVel.addScaledVector(n, -vn * 1.5);
    }
    // The string twists back and forth lazily.
    this.pendTwist = 0.35 * Math.sin(t * 1.3) + 0.15 * Math.sin(t * 2.9 + 0.7);
  }

  private pickAt(clientX: number, clientY: number): void {
    let x = clientX;
    if (this.opts?.mirror) {
      const rect = this.canvas.getBoundingClientRect();
      x = rect.left + rect.width - (clientX - rect.left);
    }
    const hit = this.stage.pickLocal(x, clientY, this.hoverY());
    if (!hit) return;
    this.target.set(hit.x, hit.z);
    const r = this.target.length();
    if (r > HOVER_RADIUS) this.target.multiplyScalar(HOVER_RADIUS / r);
  }

  private rotateYaw(delta: number): void {
    if (!this.isPlacing || this.opts?.tiedHands) return;
    this.targetYaw += delta;
  }

  private rotatePitch(delta: number): void {
    if (!this.isPlacing || this.opts?.tiedHands) return;
    this.targetPitch = THREE.MathUtils.clamp(this.targetPitch + delta, -PITCH_LIMIT, PITCH_LIMIT);
  }

  private tryDrop(): void {
    if (!this.isPlacing) return;
    const now = performance.now();
    if (now - this.placingSince < DROP_GUARD_MS || now - this.lastDropAt < DROP_GUARD_MS) return;
    this.lastDropAt = now;
    this.actions.emit("drop", this.pose());
  }

  // ---- camera --------------------------------------------------------------------------------------------

  private orbit(dYaw: number, dPitch: number): void {
    const s = settings.get();
    const sign = s.invertOrbit ? -1 : 1;
    this.stage.orbit(dYaw * s.cameraSensitivity * sign, dPitch * s.cameraSensitivity * sign);
  }

  // ---- keyboard ------------------------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (isTypingTarget(e.target) || isTypingTarget(document.activeElement)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const code = e.code;
    if (code === "Tab") {
      e.preventDefault();
      if (!this.scoreboardHeld) {
        this.scoreboardHeld = true;
        this.actions.emit("scoreboardDown", undefined);
      }
      return;
    }
    // Held keys (camera + rotation) are tracked even on repeat.
    if (["KeyA", "KeyD", "KeyQ", "KeyE", "KeyW", "KeyS"].includes(code)) {
      this.held.add(code);
      return;
    }
    if (e.repeat) {
      if (code === "Space") e.preventDefault();
      return;
    }
    switch (code) {
      case "Space":
        e.preventDefault();
        this.actions.emit("spin", undefined);
        break;
      case "KeyR":
        this.actions.emit("rig", undefined);
        break;
      case "Digit1":
      case "Digit2":
      case "Digit3":
      case "Digit4":
      case "Numpad1":
      case "Numpad2":
      case "Numpad3":
      case "Numpad4": {
        const i = Number(code.slice(-1)) - 1;
        this.actions.emit("betAmount", BET_AMOUNTS[i] ?? 0);
        break;
      }
      case "KeyF":
        this.actions.emit("bet", "stand");
        break;
      case "KeyG":
        this.actions.emit("bet", "fall");
        break;
      case "KeyT":
        if (!this.emoteHeld) {
          this.emoteHeld = true;
          this.actions.emit("emoteDown", undefined);
        }
        break;
      case "Escape":
        this.actions.emit("menu", undefined);
        break;
      case "Enter":
      case "NumpadEnter":
        if (this.isPlacing) {
          e.preventDefault();
          this.tryDrop();
        }
        break;
    }
  }

  private onKeyUp(e: KeyboardEvent): void {
    this.held.delete(e.code);
    if (e.code === "Tab" && this.scoreboardHeld) {
      e.preventDefault();
      this.scoreboardHeld = false;
      this.actions.emit("scoreboardUp", undefined);
    } else if (e.code === "KeyT" && this.emoteHeld) {
      this.emoteHeld = false;
      this.actions.emit("emoteUp", undefined);
    }
  }

  /** Window lost focus: nothing should stay "held". */
  private releaseAll(): void {
    this.held.clear();
    if (this.scoreboardHeld) {
      this.scoreboardHeld = false;
      this.actions.emit("scoreboardUp", undefined);
    }
    if (this.emoteHeld) {
      this.emoteHeld = false;
      this.actions.emit("emoteUp", undefined);
    }
    this.orbitDrag = null;
    this.touches.clear();
    this.twist = null;
  }

  // ---- mouse / touch -------------------------------------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.sawTouch = true;
      if (this.isPlacing && !this.dropBtn) this.showDropButton();
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.capture(e);
      if (this.touches.size === 1) {
        this.lastClient = { x: e.clientX, y: e.clientY };
        if (this.isPlacing) this.pickAt(e.clientX, e.clientY);
      } else if (this.touches.size === 2) {
        this.twist = this.twistState();
      }
      e.preventDefault();
      return;
    }

    this.lastClient = { x: e.clientX, y: e.clientY };
    if (e.button === 2 || (e.button === 0 && !this.isPlacing) || e.button === 1) {
      this.orbitDrag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0, button: e.button };
      this.capture(e);
      e.preventDefault();
      return;
    }
    if (e.button === 0 && this.isPlacing) {
      this.pickAt(e.clientX, e.clientY);
      this.tryDrop();
    }
  }

  private onPointerMove(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      const prev = this.touches.get(e.pointerId);
      if (!prev) return;
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      prev.x = e.clientX;
      prev.y = e.clientY;
      if (this.touches.size === 1) {
        if (this.isPlacing) {
          this.lastClient = { x: e.clientX, y: e.clientY };
          this.pickAt(e.clientX, e.clientY);
        } else {
          this.orbit(-dx * ORBIT_PX, -dy * ORBIT_PX);
        }
      } else if (this.touches.size === 2 && this.twist) {
        const next = this.twistState();
        if (!next) return;
        const dAngle = shortestAngle(next.angle - this.twist.angle);
        const dMid = next.midY - this.twist.midY;
        if (this.isPlacing) {
          this.rotateYaw((this.opts?.mirror ? 1 : -1) * dAngle);
          this.rotatePitch(-dMid * 0.006);
        } else {
          this.orbit(-dAngle, -dMid * ORBIT_PX);
          if (this.twist.dist > 0 && next.dist > 0) this.stage.zoom((this.twist.dist - next.dist) * 0.004);
        }
        this.twist = next;
      }
      return;
    }

    this.lastClient = { x: e.clientX, y: e.clientY };
    const drag = this.orbitDrag;
    if (drag && drag.id === e.pointerId) {
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      drag.x = e.clientX;
      drag.y = e.clientY;
      drag.moved += Math.abs(dx) + Math.abs(dy);
      if (drag.moved >= DRAG_DEADZONE || drag.button === 2) this.orbit(-dx * ORBIT_PX, -dy * ORBIT_PX);
      return;
    }
    // Hovering: update() re-picks from lastClient each frame, but pick now too for snappy response.
    if (this.isPlacing) this.pickAt(e.clientX, e.clientY);
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.pointerType === "touch") {
      this.touches.delete(e.pointerId);
      this.twist = this.touches.size === 2 ? this.twistState() : null;
      if (this.touches.size === 1) {
        // Resume single-finger drag from the remaining finger without a jump.
        const [pt] = [...this.touches.values()];
        if (pt) this.lastClient = { x: pt.x, y: pt.y };
      }
      return;
    }
    if (this.orbitDrag && this.orbitDrag.id === e.pointerId) this.orbitDrag = null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    // Normalize line/page deltas to pixels.
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    const dy = e.deltaY * unit;
    if (this.isPlacing) {
      if (this.opts?.tiedHands) {
        // Scrolling with tied hands just jiggles the string. Futile, but funny.
        this.pendVel.x += Math.sign(dy) * 0.05;
        return;
      }
      const dir = this.opts?.mirror ? -1 : 1;
      if (Math.abs(dy) >= 40) {
        // A real mouse-wheel notch: exactly one 15° step per notch.
        this.scrollAccum = 0;
        this.rotateYaw(Math.sign(dy) * dir * SCROLL_STEP);
      } else {
        // Trackpad: accumulate the tiny deltas into steps.
        this.scrollAccum += dy;
        while (Math.abs(this.scrollAccum) >= SCROLL_UNITS_PER_STEP) {
          const s = Math.sign(this.scrollAccum);
          this.scrollAccum -= s * SCROLL_UNITS_PER_STEP;
          this.rotateYaw(s * dir * SCROLL_STEP);
        }
      }
      return;
    }
    this.stage.zoom(THREE.MathUtils.clamp(dy * ZOOM_PER_WHEEL, -0.3, 0.3));
  }

  private twistState(): { angle: number; midY: number; dist: number } | null {
    const pts = [...this.touches.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts as [TouchPt, TouchPt];
    return {
      angle: Math.atan2(b.y - a.y, b.x - a.x),
      midY: (a.y + b.y) / 2,
      dist: Math.hypot(b.x - a.x, b.y - a.y),
    };
  }

  private touchDragging(): boolean {
    return this.touches.size > 1;
  }

  private capture(e: PointerEvent): void {
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* element not capturable (e.g. synthetic events) */
    }
  }

  // ---- DROP button (touch) -------------------------------------------------------------------------------

  private showDropButton(): void {
    if (this.dropBtn) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "jj-drop";
    btn.setAttribute("aria-label", "Drop the piece");
    btn.innerHTML =
      '<span class="jj-drop__eyes"><span class="jj-drop__eye"></span><span class="jj-drop__eye"></span></span>' +
      '<span class="jj-drop__label">DROP!</span>';
    const onDown = (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      btn.classList.add("is-pressed");
    };
    const onUp = (ev: PointerEvent) => {
      ev.preventDefault();
      ev.stopPropagation();
      btn.classList.remove("is-pressed");
      this.tryDrop();
    };
    const onLeave = () => btn.classList.remove("is-pressed");
    btn.addEventListener("pointerdown", onDown);
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointerleave", onLeave);
    btn.addEventListener("contextmenu", (ev) => ev.preventDefault());
    const host = document.getElementById("ui") ?? document.body;
    host.appendChild(btn);
    this.dropBtn = btn;
  }

  private hideDropButton(): void {
    this.dropBtn?.remove();
    this.dropBtn = null;
  }

  private listen(
    target: EventTarget,
    type: string,
    fn: (e: Event) => void,
    opts?: AddEventListenerOptions,
  ): void {
    target.addEventListener(type, fn, opts);
    this.cleanup.push(() => target.removeEventListener(type, fn, opts));
  }
}
