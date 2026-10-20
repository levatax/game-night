// The pavyon back room, renderer, seat layout, lighting and camera.
//
// Camera: two poses blended with a 0.9 s ease. "Masa" is the classic camera over the table (home attract,
// podium, spectators, the raid door shot, out-of-body moments and the V toggle). First person ("fp", the
// default while seated in a match) sits at the local seat's eye: a rest gaze toward the dealer, mouse-look
// with soft limits, an idle ease-back, focus-driven head turns (the active player, the door, the wheel) and
// transient attend() look-ats from other modules, all blended in yaw/pitch so the view never rolls. Shake is
// positional in Masa and a small rotation in first person (comfort); reduced flashing scales both by 0.3.
// The automatic Masa shots nudge their yaw so no seated head sits on the sightlines to the table (hysteresis,
// never against a drag). In first person your own money pile moves to the lower right of the view
// (layout.fpPileSpot): seatPose(mySeat).stack follows, and the Stacks pile glides there and back as first
// person turns on / off.
//
// Rendering budget: quality tiers or "auto" (frame-time driven DPR / shadow ladder with hysteresis), four
// lights for the whole scene (hemisphere, the lamp spot with the only shadow, one accent point light that is
// the siren flood or the corridor police light, one accent spot that is the siren sweep or the wheel light),
// so the light count and every shader stay fixed; shadow-map updates scheduled by tier; prewarm() compiles
// every program (hidden pools included) before the first dramatic moment needs it.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { PALETTE } from "../../../shared/constants";
import { settings, type Quality, type ViewMode } from "../app/settings";
import { OUTLINE_LAYER, fontsReady } from "./toon";
import { Door } from "./room/Door";
import { Kumbara } from "./room/Kumbara";
import { Lamp } from "./room/Lamp";
import {
  CAMERA_MAX_Y, CARD_ROW_RADIUS, DEALER_POS, DEALER_YAW, DECK_POS, DOOR_LOOK, DOOR_POS, DOOR_YAW, EYE_LIFT_MAX,
  FP_REST_PITCH, KUMBARA_CENTER, OUTSIDE_POS, PLATE_RADIUS, PODIUM_POS, ROOM_BACK_Z, ROOM_FRONT_Z, ROOM_HALF_X,
  SEAT_RADIUS, STACK_RADIUS, STACK_SIDE, TABLE_TOP_Y, WHEEL_DOWN, WHEEL_UP,
  attentionWeight, dirOf, doorShot, eyePoint, fpPileSpot, fpVerticalFov, gazeForward, gazeTo, horizontalFov,
  masaClearance, restGaze, rightOf, seatAngle, wrapAngle, type Gaze,
} from "./room/layout";
import { NeonSign } from "./room/NeonSign";
import { Room } from "./room/Room";
import { Siren } from "./room/Siren";
import { Smoke } from "./room/Smoke";
import { Stacks } from "./room/Stacks";
import { Table } from "./room/Table";

export { TABLE_RADIUS, TABLE_TOP_Y } from "./room/layout";

export interface SeatPose {
  seat: number;
  chair: THREE.Vector3;
  yaw: number;
  stack: THREE.Vector3;
  cardRow: THREE.Vector3;
  rowDir: THREE.Vector3;
  plate: THREE.Vector3;
}
export interface StageAnchors {
  dealer: THREE.Vector3;
  dealerYaw: number;
  deck: THREE.Vector3;
  kumbara: THREE.Vector3;
  wheelUp: THREE.Vector3;
  wheelDown: THREE.Vector3;
  door: THREE.Vector3;
  doorYaw: number;
  outside: THREE.Vector3;
  podium: THREE.Vector3;
}
export interface SeatProps {
  seat: number;
  color: string;
  nickname: string;
  kasa: number;
  active: boolean;
  ghost: boolean;
  connected: boolean;
}
export type CameraFocus = "table" | "seat" | "door" | "wheel" | "podium" | "home";

/** Projected screen point (client px). */
export interface ScreenPoint {
  x: number;
  y: number;
  visible: boolean;
}

/** Live first-person state (one object, updated in place every frame by Stage.update). */
export interface FirstPersonView {
  /** The camera is (mostly) at the eye: blend > 0.5. */
  active: boolean;
  /** 0 = Masa camera .. 1 = first person (eased). */
  blend: number;
  /** Seat of the eye while any first person is blended in, else null. */
  seat: number | null;
  /** Eye point (world, no shake). */
  eye: THREE.Vector3;
  /** Current first-person look direction (unit, includes mouse-look and attention, no shake). */
  forward: THREE.Vector3;
  /** Rest yaw of the seat (three.js camera convention). */
  restYaw: number;
}

interface Plate {
  group: THREE.Group;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  texture: THREE.CanvasTexture;
  mat: THREE.MeshBasicMaterial;
  data: SeatProps | null;
  /** Everything but the counting value (repaint at once when it changes). */
  key: string;
  paintedKey: string;
  paintedValue: number;
  paintedAt: number;
  hidden: boolean;
}

interface Tier {
  /** Device-pixel-ratio cap. */
  dpr: number;
  /** Lamp shadow map size (0 = no shadows). */
  shadow: 0 | 1024 | 2048;
  /** Re-render the shadow map every n-th frame. */
  shadowEvery: number;
  /** Smoke sheets. */
  smoke: number;
}

interface Attention {
  active: boolean;
  point: THREE.Vector3;
  fn: (() => THREE.Vector3 | null) | null;
  start: number;
  until: number;
  weight: number;
  priority: number;
}

/** Critically damped spring (implicit integration: stable at any dt). */
class Spring {
  x = 0;
  v = 0;
  step(target: number, omega: number, dt: number): number {
    const f = 1 + 2 * dt * omega;
    const oo = omega * omega;
    const hoo = dt * oo;
    const hhoo = dt * hoo;
    const inv = 1 / (f + hhoo);
    const x = (f * this.x + dt * this.v + hhoo * target) * inv;
    this.v = (this.v + hoo * (target - this.x)) * inv;
    this.x = x;
    return x;
  }
  reset(x = 0): void {
    this.x = x;
    this.v = 0;
  }
}

const MAX_SEATS = 6;
const TIERS: Record<Exclude<Quality, "auto">, Tier> = {
  low: { dpr: 1, shadow: 0, shadowEvery: 1, smoke: 2 },
  medium: { dpr: 1.25, shadow: 1024, shadowEvery: 2, smoke: 4 },
  high: { dpr: 1.75, shadow: 2048, shadowEvery: 1, smoke: 6 },
};
/** "auto" ladder, cheapest first. Never toggles shadows on/off (that would recompile every lit shader). */
const AUTO_LADDER: Tier[] = [
  { dpr: 0.85, shadow: 1024, shadowEvery: 2, smoke: 2 },
  { dpr: 1, shadow: 1024, shadowEvery: 2, smoke: 4 },
  { dpr: 1.25, shadow: 2048, shadowEvery: 1, smoke: 4 },
  { dpr: 1.5, shadow: 2048, shadowEvery: 1, smoke: 6 },
];
const AUTO_START = AUTO_LADDER.length - 1;

const MASA_FOV = 46;
/** Masa occluder avoidance: wanted / kept sightline clearance (m), yaw search step (rad) and steps per side. */
const OCC_OK = 0.06;
const OCC_KEEP = 0.02;
const OCC_STEP = 0.05;
const OCC_STEPS = 10;
const MASA_NEAR = 0.05;
const FP_NEAR = 0.03;
const BLEND_SEC = 0.9;
/** Mouse-look offsets from the rest gaze (radians): soft limits rubber-band, hard limits stop. */
const YAW_SOFT = 1.15;
const YAW_HARD = 1.5;
const PITCH_DOWN_SOFT = -0.55;
const PITCH_DOWN_HARD = -0.8;
const PITCH_UP_SOFT = 0.42;
const PITCH_UP_HARD = 0.6;
const DRAG_GAIN = 0.0026;
const LOCK_GAIN = 0.0021;
/** Transient attention envelope. */
const ATT_IN = 0.25;
const ATT_OUT = 0.35;
const DEG = Math.PI / 180;
const PLATE_W = 0.5;
const PLATE_SLANT = 0.2;
const PLATE_TILT = 0.3;
const PLATE_REPAINT_SEC = 1 / 12;
const FLOOD_POS = new THREE.Vector3(0.4, 1.85, 0.1);
const WHEEL_LIGHT_POS = new THREE.Vector3(0, 2.9, 1.5);
const SIREN_COLOR = new THREE.Color(PALETTE.siren);
const GOLD = new THREE.Color(PALETTE.gold);
const SCONCE_ON = new THREE.Color("#FFC98A");
const SCONCE_OFF = new THREE.Color("#241917");
const SMOKE_WARM = new THREE.Color("#AA9CA5");
const SMOKE_RED = new THREE.Color("#9B6264");
const LAMP_WARM = new THREE.Color(PALETTE.lamp);
const LAMP_RED = new THREE.Color("#FF897F");

const fmt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });
const clamp = (x: number, a: number, b: number): number => Math.max(a, Math.min(b, x));
const smoothing = (speed: number, dt: number): number => 1 - Math.exp(-speed * dt);
const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
const smooth01 = (t: number): number => {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
};
const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clockSec = (): number => performance.now() / 1000;

/** Add `d` to `v` with a rubber band beyond ±soft (no further than ±hard). */
function rubber(v: number, d: number, lo: number, loHard: number, hi: number, hiHard: number): number {
  if (d > 0 && v > hi) d *= Math.max(0, 1 - (v - hi) / (hiHard - hi));
  if (d < 0 && v < lo) d *= Math.max(0, 1 - (lo - v) / (lo - loHard));
  return clamp(v + d, loHard, hiHard);
}

/** Tent-card plate: two back-to-back faces leaning together, the text readable from both sides. */
function tentGeometry(): THREE.BufferGeometry {
  const front = new THREE.PlaneGeometry(PLATE_W, PLATE_SLANT);
  front.translate(0, PLATE_SLANT / 2, 0);
  front.rotateX(-PLATE_TILT);
  front.translate(0, 0, PLATE_SLANT * Math.sin(PLATE_TILT));
  const back = front.clone().rotateY(Math.PI);
  const merged = mergeGeometries([front, back], false)!;
  front.dispose();
  back.dispose();
  merged.computeBoundingSphere();
  return merged;
}

export class Stage {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly world: THREE.Group;
  readonly anchors: StageAnchors;

  private room = new Room();
  private table = new Table();
  private stacks = new Stacks();
  private kumbara = new Kumbara();
  private lamp = new Lamp();
  private siren = new Siren();
  private door = new Door();
  private smoke = new Smoke();
  private neon = new NeonSign();
  private ambient = new THREE.HemisphereLight("#B8ABC2", "#1A1218", 1.55);
  /** Siren red flood over the table, or the flashing police light in the corridor during a raid. */
  private accentPoint = new THREE.PointLight(PALETTE.siren, 0, 8, 1.7);
  /** Siren sweep, or the gold wheel light when the lights are out. */
  private accentSpot = new THREE.SpotLight(PALETTE.siren, 0, 12, 0.55, 0.85, 1.2);
  private floodLevel = 0;
  private wheelLevel = 0;
  private plates: Plate[] = [];
  private plateGeo = tentGeometry();
  private plateLight = 1;
  private count = 2;
  private quality: Quality = "auto";
  private qualityApplied = false;
  private tier: Tier = AUTO_LADDER[AUTO_START]!;
  private focus: CameraFocus = "home";
  private focusSeat = 0;
  private focusSince = 0;
  private doorSeat: number | null = null;
  private viewSeat: number | null = null;
  private lightsOut = false;
  private finalTable = false;
  /** Bit mask of the seats with someone in them (Masa occluder test). */
  private seatMask = 0;
  /** Seat whose money pile sits in its first-person spot (null = every pile in its classic spot). */
  private pileSeat: number | null = null;
  /** fpPileSpot per seat·count (null = nothing fits: the classic spot). */
  private pileSpots = new Map<number, { at: THREE.Vector3; right: THREE.Vector3 } | null>();

  // ---- Masa camera
  private position = new THREE.Vector3(0, 3.1, 4.2);
  private target = new THREE.Vector3(0, 0.9, 0);
  private wantedPosition = new THREE.Vector3();
  private wantedTarget = new THREE.Vector3();
  private masaQuat = new THREE.Quaternion();
  private doorPos = new THREE.Vector3();
  private doorTarget = new THREE.Vector3();
  private doorKey = -1;
  private orbitYaw = 0;
  private orbitPitch = 0;
  private orbitIdle = 10;
  /** Yaw nudge (rad) that keeps seated heads off the automatic Masa shot's sightlines. */
  private occYaw = 0;
  /** After a search that found no fully clear shot, the next one waits until then (s). */
  private occRetryAt = 0;

  // ---- first person
  private view: ViewMode = settings.get().view;
  private fpAllowed = false;
  private outOfBodyUntil = 0;
  private liftWanted = 0;
  private liftShown = 0;
  private fpBlend = 0;
  private fpE = 0;
  private fpTarget = 0;
  private fpEye = new THREE.Vector3();
  private fpEyeValid = false;
  private eyeWanted = new THREE.Vector3();
  private rest: Gaze = { yaw: 0, pitch: FP_REST_PITCH };
  private gaze: Gaze = { yaw: 0, pitch: 0 };
  private lookYaw = 0;
  private lookPitch = 0;
  private lookYawShown = 0;
  private lookPitchShown = 0;
  private lookIdle = 10;
  private lookLocked = false;
  private recenterLeft = 0;
  private recenterRate = 6;
  private attYaw = new Spring();
  private attPitch = new Spring();
  private att: Attention = { active: false, point: new THREE.Vector3(), fn: null, start: 0, until: 0, weight: 1, priority: 2 };
  private baseWeight = 0;
  private basePriority = 0;
  private hfov = 1.4;
  private fpQuat = new THREE.Quaternion();
  private fpView: FirstPersonView = {
    active: false, blend: 0, seat: null, eye: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), restYaw: 0,
  };

  // ---- shake / punch
  private shakePower = 0;
  private shakeLeft = 0;
  private tremble = 0;
  private punchPower = 0;
  private shakeQuat = new THREE.Quaternion();
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private lookMatrix = new THREE.Matrix4();

  // ---- scratch (no per-frame allocations)
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmpA = new THREE.Vector3();
  private attPoint = new THREE.Vector3();
  private tmpB = new THREE.Vector3();
  private occCam = new THREE.Vector3();
  private tmpColor = new THREE.Color();
  private rect: DOMRect;

  // ---- frame pacing / quality
  private frameNo = 0;
  private shadowDirty = true;
  private lastFrameAt = 0;
  private win = new Float32Array(240);
  private winN = 0;
  private winSum = 0;
  private slowWindows = 0;
  private fastWindows = 0;
  private autoLevel = AUTO_START;
  private settleUntil = 0;
  private lastUpAt = -Infinity;
  private upBlockedUntil = 0;
  private upBackoff = 30000;
  private projDirty = true;
  private warmState: "idle" | "compiling" | "ready" | "done" = "idle";
  private renders = 0;

  constructor(private container: HTMLElement) {
    const dpr = window.devicePixelRatio || 1;
    // above 1.5 DPR MSAA buys little and costs a lot of bandwidth
    this.renderer = new THREE.WebGLRenderer({ antialias: dpr < 1.5, powerPreference: "high-performance", stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.setClearColor(PALETTE.wall);
    this.renderer.localClippingEnabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.shadowMap.autoUpdate = false;
    container.appendChild(this.renderer.domElement);
    this.rect = this.renderer.domElement.getBoundingClientRect();

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(PALETTE.wall);
    this.scene.fog = new THREE.FogExp2(PALETTE.wall, 0.022);
    this.camera = new THREE.PerspectiveCamera(MASA_FOV, 1, MASA_NEAR, 40);
    this.camera.layers.enable(OUTLINE_LAYER);
    this.world = new THREE.Group();
    this.world.name = "world";
    this.scene.add(this.room.group, this.table.group, this.world, this.ambient);
    this.world.add(this.stacks.group, this.kumbara.group, this.lamp.group, this.siren.group,
      this.door.group, this.smoke.group, this.neon.group);
    this.accentPoint.position.copy(FLOOD_POS);
    this.accentSpot.position.copy(this.siren.spotPos);
    this.accentSpot.target.position.copy(this.siren.spotTarget);
    this.scene.add(this.accentPoint, this.accentSpot, this.accentSpot.target);
    this.door.onImpact = (strength) => {
      this.shake(strength * 0.7, 0.38);
      this.lamp.kick(strength);
    };
    this.anchors = {
      dealer: DEALER_POS.clone(), dealerYaw: DEALER_YAW, deck: DECK_POS.clone(),
      kumbara: KUMBARA_CENTER.clone(), wheelUp: WHEEL_UP.clone(), wheelDown: WHEEL_DOWN.clone(),
      door: DOOR_POS.clone(), doorYaw: DOOR_YAW, outside: OUTSIDE_POS.clone(), podium: PODIUM_POS.clone(),
    };
    for (let i = 0; i < MAX_SEATS; i++) this.plates.push(this.makePlate());
    void fontsReady().then(() => this.plates.forEach((p) => { p.paintedKey = ""; }));
    this.camera.position.copy(this.position);
    this.camera.lookAt(this.target);
    this.masaQuat.copy(this.camera.quaternion);
    this.setQuality(settings.get().quality);
    settings.onChange((s) => this.setQuality(s.quality));
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(() => this.resize()).observe(container);
    window.addEventListener("resize", () => this.resize());
    window.addEventListener("scroll", () => { this.rect = this.canvas.getBoundingClientRect(); }, { passive: true });
    this.resize();
    this.settleUntil = performance.now() + 3000;
  }

  get canvas(): HTMLCanvasElement { return this.renderer.domElement; }

  /**
   * A seat's table spots. In first person your own pile (`stack`) is in its first-person spot (lower right of
   * the view, see layout.fpPileSpot), so chip flights and money floats land where the pile really is.
   */
  seatPose(seat: number, seatCount: number): SeatPose {
    const angle = seatAngle(seat, seatCount);
    const outward = dirOf(angle);
    const right = rightOf(angle);
    const pile = seat === this.pileSeat && seatCount === this.count ? this.pileSpot(seat) : null;
    return {
      seat, chair: outward.clone().multiplyScalar(SEAT_RADIUS), yaw: angle + Math.PI,
      stack: pile
        ? pile.at.clone()
        : outward.clone().multiplyScalar(STACK_RADIUS).addScaledVector(right, STACK_SIDE).setY(TABLE_TOP_Y + 0.025),
      cardRow: outward.clone().multiplyScalar(CARD_ROW_RADIUS).addScaledVector(right, -0.09).setY(TABLE_TOP_Y + 0.018),
      rowDir: right, plate: outward.clone().multiplyScalar(PLATE_RADIUS).setY(TABLE_TOP_Y + 0.025),
    };
  }
  get seatCount(): number { return this.count; }

  setSeats(seats: SeatProps[]): void {
    this.count = Math.max(2, Math.min(MAX_SEATS, seats.length));
    this.seatMask = 0;
    const used = new Set<number>();
    for (const s of seats) {
      if (s.seat < 0 || s.seat >= MAX_SEATS) continue;
      used.add(s.seat);
      if (s.seat < this.count) this.seatMask |= 1 << s.seat;
      const plate = this.plates[s.seat]!;
      plate.data = s;
      const pose = this.placeStack(s.seat)!;
      plate.group.position.copy(pose.plate).setY(TABLE_TOP_Y + 0.004);
      plate.group.rotation.y = seatAngle(s.seat, this.count);
      plate.key = `${s.nickname}|${s.color}|${s.active}|${s.ghost}|${s.connected}`;
      plate.group.visible = !plate.hidden;
    }
    for (let i = 0; i < MAX_SEATS; i++) {
      if (used.has(i)) continue;
      this.plates[i]!.group.visible = false;
      this.plates[i]!.data = null;
      this.stacks.clear(i);
    }
  }
  setKumbara(amount: number): void { this.kumbara.setAmount(amount); }
  pulseKumbara(kind: "in" | "burst"): void {
    this.kumbara.pulse(kind);
    if (kind === "burst") this.shake(0.7, 0.5);
  }
  setSiren(chance: number): void { this.siren.setChance(clamp(chance, 0, 1)); }
  setFinalTable(on: boolean): void {
    if (on === this.finalTable) return;
    this.finalTable = on;
    this.neon.setColor(on ? PALETTE.siren : PALETTE.neonPink);
    this.lamp.setTint(on ? LAMP_RED : LAMP_WARM);
  }
  setLightsOut(on: boolean): void {
    this.lightsOut = on;
    this.lamp.setHoisted(on);
    this.room.setSlotOpen(on);
  }
  breakDoor(): void { this.door.kick(); }

  /**
   * Camera framing. Masa: the classic shots ("door" with a seat frames the door AND that chair). First person:
   * "seat" turns the head toward that player, "door" toward the door then the raided player, "wheel" up to the
   * wheel; "podium" / "home" hand the camera to Masa.
   */
  setFocus(focus: CameraFocus, seat?: number): void {
    const s = typeof seat === "number" && Number.isFinite(seat) ? seat : null;
    if (focus !== this.focus || (s !== null && s !== this.focusSeat)) this.focusSince = clockSec();
    // a door shot without a seat frames the player the camera was on (the active, raided one)
    if (focus === "door") this.doorSeat = s ?? (this.focus === "seat" ? this.focusSeat : null);
    this.focus = focus;
    if (s !== null) this.focusSeat = s;
  }
  setViewSeat(seat: number | null): void { this.viewSeat = seat; }
  setViewMode(mode: ViewMode): void { this.view = mode === "masa" ? "masa" : "fp"; }
  setFirstPersonAllowed(on: boolean): void { this.fpAllowed = on; }
  /** Temporarily hand the camera to Masa (own avatar walks away). Infinity allowed, 0 cancels. */
  outOfBody(sec: number): void {
    this.outOfBodyUntil = sec > 0 ? clockSec() + sec : 0;
  }
  /** 0..EYE_LIFT_MAX: the local puppet half-standing lifts the eye. */
  setEyeLift(m: number): void { this.liftWanted = clamp(Number.isFinite(m) ? m : 0, 0, EYE_LIFT_MAX); }

  /** Mouse-look in pixels (drag or pointer-lock movement). Outside first person it orbits the Masa camera. */
  look(dx: number, dy: number, locked: boolean): void {
    if (this.fpBlend < 0.5) {
      this.orbitMasa(dx, dy);
      return;
    }
    const k = (locked ? LOCK_GAIN : DRAG_GAIN) * settings.get().cameraSensitivity;
    this.lookYaw = rubber(this.lookYaw, -dx * k, -YAW_SOFT, -YAW_HARD, YAW_SOFT, YAW_HARD);
    this.lookPitch = rubber(this.lookPitch, -dy * k, PITCH_DOWN_SOFT, PITCH_DOWN_HARD, PITCH_UP_SOFT, PITCH_UP_HARD);
    this.lookIdle = 0;
    this.lookLocked = locked;
    this.recenterLeft = 0;
  }
  orbit(dxPixels: number, dyPixels: number): void {
    if (this.fpBlend >= 0.5) this.look(dxPixels, dyPixels, false);
    else this.orbitMasa(dxPixels, dyPixels);
  }

  /**
   * First-person look-at for `sec` seconds (fades in 0.25 s, out 0.35 s). `weight` 0..1 is how far the head
   * turns; a lower `priority` never interrupts a higher one that is still holding (focus shots: seat 1,
   * door / wheel 3). A function target is polled every frame (null = nothing to look at right now).
   */
  attend(target: THREE.Vector3 | (() => THREE.Vector3 | null), sec: number, weight = 1, priority = 2): void {
    const now = clockSec();
    const a = this.att;
    const holding = a.active && now < a.until - ATT_OUT;
    if (holding && priority < a.priority) return;
    if (!(a.active && now < a.until)) a.start = now;
    if (typeof target === "function") {
      a.fn = target;
    } else {
      a.fn = null;
      a.point.copy(target);
    }
    a.until = now + Math.max(0, sec);
    a.weight = clamp(Number.isFinite(weight) ? weight : 1, 0, 1);
    a.priority = priority;
    a.active = sec > 0;
  }
  /** Ease the first-person look back to the rest gaze and drop any transient look-at. */
  recenter(sec = 0.6): void {
    this.recenterLeft = Math.max(0.05, sec);
    this.recenterRate = 4 / Math.max(0.1, sec);
    this.att.active = false;
    this.lookIdle = 10;
  }
  get firstPerson(): FirstPersonView { return this.fpView; }

  /** Reading frame for cards / the wheel: FP = eye + rest forward (ignores mouse-look); Masa = the camera. */
  readingBasis(pos: THREE.Vector3, dir: THREE.Vector3): void {
    const fp = this.fpTarget === 1 ? this.viewSeat !== null : this.fpE > 0.5;
    if (fp && this.viewSeat !== null) {
      if (this.fpEyeValid) pos.copy(this.fpEye);
      else eyePoint(this.viewSeat, this.count, pos).setY(pos.y + this.liftShown);
      restGaze(pos, this.gaze);
      gazeForward(this.gaze, dir);
      return;
    }
    pos.copy(this.camera.position);
    this.camera.getWorldDirection(dir);
  }
  /** Hide one seat's name plate (your own in first person). */
  setPlateHidden(seat: number, hidden: boolean): void {
    const p = this.plates[seat];
    if (!p) return;
    p.hidden = hidden;
    p.group.visible = !!p.data && !hidden;
  }
  /** Stereo pan −0.8..0.8 of a world point, from camera space (correct for sounds behind the camera). */
  panOf(world: THREE.Vector3): number {
    const v = this.tmpB.copy(world).applyMatrix4(this.camera.matrixWorldInverse);
    const pan = v.x / Math.max(0.5, Math.hypot(v.x, v.z));
    return Number.isFinite(pan) ? clamp(pan, -0.8, 0.8) : 0;
  }
  /** The canvas' client rect, cached on resize / scroll (no layout reads in the frame loop). */
  canvasRect(): DOMRect {
    if (this.rect.width <= 0 || this.rect.height <= 0) this.rect = this.canvas.getBoundingClientRect();
    return this.rect;
  }

  shake(strength: number, sec: number): void {
    this.shakePower = Math.max(this.shakePower, clamp(strength, 0, 1));
    this.shakeLeft = Math.max(this.shakeLeft, Math.max(0, sec));
    this.lamp.kick(strength * 0.3);
  }
  setTremble(strength: number): void { this.tremble = clamp(strength, 0, 1); }
  punch(amount: number): void { this.punchPower = Math.max(this.punchPower, clamp(amount, 0, 1)); }

  /** Project a world point to client px. Pass `out` to avoid an allocation per call. */
  toScreen(world: THREE.Vector3, out?: ScreenPoint): ScreenPoint {
    const rect = this.canvasRect();
    const at = this.tmpA.copy(world).project(this.camera);
    const o = out ?? { x: 0, y: 0, visible: false };
    o.x = rect.left + (at.x + 1) * rect.width / 2;
    o.y = rect.top + (1 - at.y) * rect.height / 2;
    o.visible = at.z >= -1 && at.z <= 1 && Math.abs(at.x) <= 1 && Math.abs(at.y) <= 1;
    return o;
  }
  raycast(clientX: number, clientY: number, objects: THREE.Object3D[], recursive = true): THREE.Intersection[] {
    const rect = this.canvasRect();
    if (rect.width <= 0 || rect.height <= 0) return [];
    this.ndc.set((clientX - rect.left) / rect.width * 2 - 1, 1 - (clientY - rect.top) / rect.height * 2);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObjects(objects, recursive);
  }

  setQuality(q: Quality): void {
    if (this.qualityApplied && q === this.quality) return;
    this.quality = q;
    this.qualityApplied = true;
    if (q === "auto") {
      this.autoLevel = AUTO_START;
      this.slowWindows = this.fastWindows = 0;
      this.upBlockedUntil = 0;
      this.upBackoff = 30000;
      this.applyTier(AUTO_LADDER[this.autoLevel]!);
    } else {
      this.applyTier(TIERS[q]);
    }
    this.winN = 0;
    this.winSum = 0;
    this.settleUntil = performance.now() + 2000;
  }

  /**
   * Compile every shader the scene can need (hidden pools, the wheel, door splinters…) without stalling:
   * compileAsync now (parallel where the browser supports it), then one throw-away render with every hidden
   * object shown right before the next real frame (also uploads textures / buffers and the shadow programs).
   */
  prewarm(): void {
    if (this.warmState === "compiling" || this.warmState === "ready") return;
    this.warmState = "compiling";
    const restore = this.exposeHidden();
    let pending: Promise<unknown> | null = null;
    try {
      pending = this.renderer.compileAsync(this.scene, this.camera);
    } catch {
      pending = null;
    } finally {
      restore();
    }
    const ready = () => { this.warmState = "ready"; };
    if (pending) pending.then(ready, ready);
    else ready();
  }

  update(dt: number, time: number): void {
    const reduced = settings.get().reducedFlashing;
    // camera first: every DOM projection later in the frame uses this frame's camera
    this.updateCamera(dt, time, reduced);
    const fade = smoothing(3, dt);
    const dark = this.lightsOut;
    this.lamp.power += ((dark ? 0.07 : 1) - this.lamp.power) * fade;
    this.neon.power += ((dark ? 0.12 : 1) - this.neon.power) * fade;
    this.siren.setPower(dark ? 0.12 : 1);
    this.ambient.intensity += ((dark ? 0.28 : this.finalTable ? 1.32 : 1.55) - this.ambient.intensity) * fade;
    this.room.sconceMat.color.lerp(dark ? SCONCE_OFF : SCONCE_ON, fade);
    this.table.smokeLight = dark ? 0.2 : 1;
    this.smoke.amount += ((dark ? 0.25 : 0.8) - this.smoke.amount) * fade;
    this.smoke.setTint(this.tmpColor.copy(this.finalTable ? SMOKE_RED : SMOKE_WARM).multiplyScalar(dark ? 0.4 : 1));
    this.room.update(dt, time);
    this.table.update(dt, time);
    this.stacks.update(dt);
    this.kumbara.update(dt, time);
    this.lamp.update(dt, time, reduced);
    this.siren.update(dt, time, reduced);
    this.door.update(dt, time, reduced);
    this.neon.update(dt, time, reduced);
    this.updateAccents(dt, fade, dark, reduced);
    this.smoke.update(dt, time, this.camera, this.fpE);
    this.plateLight += ((dark ? 0.35 : 1) - this.plateLight) * fade;
    this.updatePlates();
  }

  render(): void {
    const now = performance.now();
    this.adapt(now);
    if (this.warmState === "idle" && ++this.renders === 30) this.prewarm();
    const sm = this.renderer.shadowMap;
    if (this.warmState === "ready") {
      // throw-away frame with every hidden object shown; the real render below overwrites it
      this.warmState = "done";
      const restore = this.exposeHidden();
      sm.needsUpdate = sm.enabled;
      try {
        this.renderer.render(this.scene, this.camera);
      } catch {
        /* a module's half-built object: the real frame still renders */
      } finally {
        restore();
      }
      this.shadowDirty = true;
      this.settleUntil = Math.max(this.settleUntil, now + 1500);
    }
    this.frameNo++;
    sm.needsUpdate = sm.enabled && (this.shadowDirty || this.frameNo % this.tier.shadowEvery === 0);
    this.shadowDirty = false;
    this.renderer.render(this.scene, this.camera);
  }

  // ======================================================================== internals
  /** Show every hidden object, defeat frustum culling and give empty instanced meshes one instance. */
  private exposeHidden(): () => void {
    const hidden: THREE.Object3D[] = [];
    const culled: THREE.Object3D[] = [];
    const empty: THREE.InstancedMesh[] = [];
    this.scene.traverse((o) => {
      if (!o.visible) {
        hidden.push(o);
        o.visible = true;
      }
      if (o.frustumCulled) {
        culled.push(o);
        o.frustumCulled = false;
      }
      const im = o as THREE.InstancedMesh;
      if (im.isInstancedMesh && im.count === 0) {
        empty.push(im);
        im.count = 1;
      }
    });
    return () => {
      for (const o of hidden) o.visible = false;
      for (const o of culled) o.frustumCulled = true;
      for (const im of empty) im.count = 0;
    };
  }

  private applyTier(t: Tier): void {
    this.tier = t;
    const shadows = t.shadow > 0;
    if (this.renderer.shadowMap.enabled !== shadows || this.lamp.spot.castShadow !== shadows) {
      // only from the settings menu (auto never toggles shadows): recompiles the lit shaders
      this.renderer.shadowMap.enabled = shadows;
      this.lamp.spot.castShadow = shadows;
    }
    const shadow = this.lamp.spot.shadow;
    if (shadows && shadow.mapSize.x !== t.shadow) {
      shadow.mapSize.set(t.shadow, t.shadow);
      shadow.map?.dispose();
      shadow.map = null;
    }
    this.shadowDirty = true;
    this.smoke.setCount(t.smoke);
    this.resize();
  }

  /**
   * "auto": a 1 s window of frame deltas. The refresh interval is the 10th-percentile delta (120 Hz screens
   * work, capped at 20 ms); the goal is ≥ 60 fps. Two slow windows (mean > 1.2× goal) step down, five fast ones (< 1.05×) step
   * up. A step down soon after a step up blocks further step-ups for 30 s, then 60 s, … (no thrashing).
   */
  private adapt(now: number): void {
    const last = this.lastFrameAt;
    this.lastFrameAt = now;
    if (this.quality !== "auto" || last === 0) return;
    const d = now - last;
    if (d > 250 || document.hidden) {
      // tab switch / long stall: not a measurement
      this.winN = 0;
      this.winSum = 0;
      return;
    }
    if (now < this.settleUntil) return;
    this.win[this.winN++] = d;
    this.winSum += d;
    if (this.winSum < 1000 && this.winN < this.win.length) return;
    const n = this.winN;
    const mean = this.winSum / n;
    const sorted = this.win.subarray(0, n).sort();
    // displays are ≥ 50 Hz: a steady 33 ms is a GPU-bound 30 fps (or a battery-saver cap, where a lower
    // resolution is welcome too), never "the refresh rate"
    const refresh = clamp(sorted[Math.floor(n * 0.1)] ?? 16.7, 4, 20);
    this.winN = 0;
    this.winSum = 0;
    const goal = Math.max(refresh, 1000 / 61);
    if (mean > goal * 1.2) {
      this.fastWindows = 0;
      if (++this.slowWindows >= 2) this.stepAuto(-1, now);
    } else if (mean < goal * 1.05) {
      this.slowWindows = 0;
      if (++this.fastWindows >= 5) this.stepAuto(1, now);
    } else {
      this.slowWindows = 0;
      this.fastWindows = 0;
    }
  }

  private stepAuto(dir: -1 | 1, now: number): void {
    this.slowWindows = 0;
    this.fastWindows = 0;
    const next = clamp(this.autoLevel + dir, 0, AUTO_LADDER.length - 1);
    if (next === this.autoLevel) return;
    if (dir > 0 && now < this.upBlockedUntil) return;
    if (dir < 0 && now - this.lastUpAt < 20000) {
      this.upBlockedUntil = now + this.upBackoff;
      this.upBackoff = Math.min(300000, this.upBackoff * 2);
    }
    if (dir > 0) this.lastUpAt = now;
    this.autoLevel = next;
    this.applyTier(AUTO_LADDER[next]!);
    this.settleUntil = now + 2000;
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    const ratio = Math.min(window.devicePixelRatio || 1, this.tier.dpr);
    if (Math.abs(this.renderer.getPixelRatio() - ratio) > 1e-3) this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.projDirty = true;
    this.rect = this.canvas.getBoundingClientRect();
  }

  private updateAccents(dt: number, fade: number, dark: boolean, reduced: boolean): void {
    // point: siren flood over the table ↔ police light in the corridor (weighted by their brightness)
    const flood = dark ? 0 : this.siren.level * (reduced ? 2.5 : 1.5 + this.siren.pulse * 5);
    this.floodLevel += (flood - this.floodLevel) * smoothing(9, dt);
    const police = this.door.policeIntensity;
    const total = this.floodLevel + police;
    const p = total > 1e-4 ? police / total : 0;
    const pl = this.accentPoint;
    pl.intensity = total;
    pl.position.lerpVectors(FLOOD_POS, this.door.policePos, p);
    pl.distance = lerp(8, 9, p);
    pl.decay = lerp(1.7, 1.3, p);
    pl.color.copy(SIREN_COLOR).lerp(this.door.policeColor, p);
    // spot: siren sweep ↔ gold wheel light when the lights are out
    this.wheelLevel += ((dark ? 28 : 0) - this.wheelLevel) * fade;
    const sirenI = this.siren.spotIntensity;
    const sum = sirenI + this.wheelLevel;
    const w = sum > 1e-4 ? this.wheelLevel / sum : dark ? 1 : 0;
    const sp = this.accentSpot;
    sp.intensity = sum;
    sp.position.lerpVectors(this.siren.spotPos, WHEEL_LIGHT_POS, w);
    sp.target.position.lerpVectors(this.siren.spotTarget, WHEEL_DOWN, w);
    sp.angle = lerp(0.55, 0.78, w);
    sp.penumbra = lerp(0.85, 0.65, w);
    sp.distance = lerp(12, 7, w);
    sp.decay = lerp(1.2, 1.25, w);
    sp.color.copy(SIREN_COLOR).lerp(GOLD, w);
  }

  // ---------------------------------------------------------------------- money piles
  /** The first-person pile spot of a seat at the current seat count (cached; null = nothing fits). */
  private pileSpot(seat: number): { at: THREE.Vector3; right: THREE.Vector3 } | null {
    const key = seat * 8 + this.count;
    let spot = this.pileSpots.get(key);
    if (spot === undefined) {
      const at = new THREE.Vector3();
      const right = new THREE.Vector3();
      spot = fpPileSpot(seat, this.count, at, right) ? { at, right } : null;
      this.pileSpots.set(key, spot);
    }
    return spot;
  }

  /** (Re)place a seated seat's pile from its plate data (glides with the Stacks spring). Returns the pose. */
  private placeStack(seat: number): SeatPose | null {
    const d = this.plates[seat]?.data;
    if (!d) return null;
    const pose = this.seatPose(seat, this.count);
    const pile = seat === this.pileSeat ? this.pileSpot(seat) : null;
    this.stacks.set(seat, pose.stack, pile ? pile.right : pose.rowDir, d.color, d.kasa);
    return pose;
  }

  /** Move the local pile to its first-person spot while first person is wanted or mostly blended in. */
  private updatePileSeat(): void {
    const fp = this.viewSeat !== null && this.viewSeat < this.count && (this.fpTarget === 1 || this.fpE > 0.5);
    const want = fp ? this.viewSeat : null;
    if (want === this.pileSeat) return;
    const old = this.pileSeat;
    this.pileSeat = want;
    if (old !== null) this.placeStack(old);
    if (want !== null) this.placeStack(want);
  }

  // ---------------------------------------------------------------------- camera
  private orbitMasa(dxPixels: number, dyPixels: number): void {
    const sensitivity = settings.get().cameraSensitivity;
    this.orbitYaw = clamp(this.orbitYaw - dxPixels * 0.005 * sensitivity, -1.15, 1.15);
    this.orbitPitch = clamp(this.orbitPitch + dyPixels * 0.0038 * sensitivity, -0.5, 0.5);
    this.orbitIdle = 0;
  }

  private fpWanted(now: number): boolean {
    return this.view === "fp" && this.fpAllowed && this.viewSeat !== null && now >= this.outOfBodyUntil
      && this.focus !== "home" && this.focus !== "podium";
  }

  private updateCamera(dt: number, time: number, reduced: boolean): void {
    const now = clockSec();
    this.masaPose(dt, time);

    // ---- first person blend
    this.fpTarget = this.fpWanted(now) ? 1 : 0;
    if (this.fpTarget === 1 && this.fpBlend === 0) {
      // fresh start at the seat: rest gaze, no leftover look offsets
      this.fpEyeValid = false;
      this.lookYaw = this.lookPitch = this.lookYawShown = this.lookPitchShown = 0;
      this.attYaw.reset();
      this.attPitch.reset();
    }
    this.fpBlend = clamp(this.fpBlend + (this.fpTarget ? dt : -dt) / BLEND_SEC, 0, 1);
    const e = easeInOutCubic(this.fpBlend);
    this.fpE = e;
    this.updatePileSeat();
    const aspect = this.camera.aspect;
    const fpVfov = fpVerticalFov(settings.get().fov, aspect);
    this.hfov = horizontalFov(fpVfov, aspect);
    if (this.viewSeat !== null && (e > 0 || this.fpTarget === 1)) {
      this.fpPose(dt, now);
    } else {
      // parked: keep the getter's eye meaningful, snap to the anchor on the next entry
      this.fpEyeValid = false;
      if (this.viewSeat !== null) {
        eyePoint(this.viewSeat, this.count, this.fpEye);
        restGaze(this.fpEye, this.rest);
      }
    }

    // ---- compose
    const cam = this.camera;
    cam.position.lerpVectors(this.position, this.fpEye, e);
    cam.quaternion.slerpQuaternions(this.masaQuat, this.fpQuat, e);

    // ---- shake: positional in Masa, a small rotation in first person (comfort), punch: a narrower fov
    this.shakeLeft = Math.max(0, this.shakeLeft - dt);
    if (this.shakeLeft <= 0) this.shakePower *= Math.exp(-12 * dt);
    const calm = reduced ? 0.3 : 1;
    const amp = this.shakePower * (this.shakeLeft > 0 ? 1 : 0.2) * calm;
    const trem = this.tremble * calm;
    const masaAmp = (amp + trem * 0.035) * (1 - e);
    if (masaAmp > 0.001) {
      cam.position.x += Math.sin(time * 19) * masaAmp * 0.065;
      cam.position.y += Math.sin(time * 23 + 1.4) * masaAmp * 0.046;
      cam.position.z += Math.sin(time * 17 + 0.6) * masaAmp * 0.038;
    }
    const rot = amp * e;
    const nod = Math.min(1, trem / 0.45) * e;
    if (rot > 0.0005 || nod > 0.0005) {
      const w = Math.PI * 2 * time;
      const yawJ = (Math.sin(w * 6.3) * 0.6 + Math.sin(w * 8.7 + 1.1) * 0.4) * rot * 0.6 * DEG;
      const pitchJ = (Math.sin(w * 7.4 + 0.4) * 0.6 + Math.sin(w * 5.9 + 2.2) * 0.4) * rot * 0.6 * DEG
        + Math.sin(w * 1.2) * nod * 0.15 * DEG;
      const rollJ = Math.sin(w * 6.8 + 0.9) * rot * 0.3 * DEG;
      cam.quaternion.multiply(this.shakeQuat.setFromEuler(this.euler.set(pitchJ, yawJ, rollJ, "YXZ")));
    }
    this.punchPower *= Math.exp(-7 * dt);
    const fov = lerp(MASA_FOV, fpVfov, e) - this.punchPower * lerp(4, 2, e);
    const near = e > 0.5 ? FP_NEAR : MASA_NEAR;
    if (this.projDirty || Math.abs(cam.fov - fov) > 0.01 || cam.near !== near) {
      cam.fov = fov;
      cam.near = near;
      cam.updateProjectionMatrix();
      this.projDirty = false;
    }
    cam.updateMatrixWorld();

    // ---- public first-person state
    const v = this.fpView;
    v.blend = e;
    v.active = e > 0.5;
    v.seat = e > 0 ? this.viewSeat : null;
    v.eye.copy(this.fpEye);
    v.restYaw = this.rest.yaw;
  }

  private masaPose(dt: number, time: number): void {
    this.orbitIdle += dt;
    if (this.orbitIdle > 3) {
      this.orbitYaw *= Math.exp(-0.8 * dt);
      this.orbitPitch *= Math.exp(-0.8 * dt);
    }
    // own avatar off the table center: a gentler yaw toward the local seat, target a bit deeper
    let yaw = this.viewSeat === null ? 0 : seatAngle(this.viewSeat, this.count) * 0.55;
    let radius = 4;
    let height = 3.18;
    let exact = false;
    this.wantedTarget.set(0, 0.82, -0.35);
    switch (this.focus) {
      case "home":
        yaw = 0.3 + Math.sin(time * 0.12) * 0.3;
        radius = 4.25;
        height = 3.05;
        this.wantedTarget.set(0, 0.95, -0.32);
        break;
      case "seat": {
        const a = seatAngle(this.focusSeat, this.count);
        yaw += clamp(a - yaw, -1.1, 1.1) * 0.25;
        dirOf(a, this.wantedTarget).multiplyScalar(0.34).setY(0.87);
        break;
      }
      case "door": {
        this.occYaw = 0;
        const key = (this.doorSeat ?? 9) * 10 + this.count;
        if (key !== this.doorKey) {
          this.doorKey = key;
          const chair = this.doorSeat === null ? null : dirOf(seatAngle(this.doorSeat, this.count), this.tmpA).multiplyScalar(SEAT_RADIUS).setY(1.1);
          doorShot(chair, this.doorPos, this.doorTarget);
        }
        this.wantedPosition.copy(this.doorPos);
        this.wantedPosition.x += Math.sin(this.orbitYaw) * 0.6;
        this.wantedPosition.y += this.orbitPitch * 0.6;
        this.wantedTarget.copy(this.doorTarget);
        exact = true;
        break;
      }
      case "wheel":
        // the wheel and its marquee fill the frame (the lamp is up in its well, out of the shot)
        yaw = 0; radius = 2.35; height = 2.45;
        this.wantedTarget.copy(WHEEL_DOWN);
        break;
      case "podium":
        yaw = -0.25; radius = 3.1; height = 2.5;
        this.wantedTarget.set(PODIUM_POS.x, PODIUM_POS.y + 0.95, PODIUM_POS.z);
        break;
      case "table": break;
    }
    if (!exact) {
      yaw += this.orbitYaw;
      // pitch rides a sphere: past the beam limit the camera moves in (steeper) instead of up
      let y = height + this.orbitPitch * 2;
      if (y > CAMERA_MAX_Y) {
        radius = Math.max(2.4, radius - (y - CAMERA_MAX_Y) * 1.4);
        y = CAMERA_MAX_Y;
      }
      // the table shots never look over someone's head
      const table = this.focus === "table" || this.focus === "seat" || this.focus === "wheel";
      if (table) yaw += this.clearShot(yaw, radius, y);
      else this.occYaw = 0;
      this.wantedPosition.set(Math.sin(yaw) * radius, y, Math.cos(yaw) * radius);
      if (this.focus === "podium") this.wantedPosition.x -= 0.8;
    }
    const wp = this.wantedPosition;
    wp.x = clamp(wp.x, -ROOM_HALF_X + 0.25, ROOM_HALF_X - 0.25);
    wp.y = clamp(wp.y, 0.6, CAMERA_MAX_Y);
    wp.z = clamp(wp.z, ROOM_BACK_Z + 0.3, ROOM_FRONT_Z - 0.25);
    this.position.lerp(wp, smoothing(this.focus === "door" || this.focus === "wheel" ? 4 : 2.8, dt));
    this.target.lerp(this.wantedTarget, smoothing(4, dt));
    this.lookMatrix.lookAt(this.position, this.target, this.camera.up);
    this.masaQuat.setFromRotationMatrix(this.lookMatrix);
  }

  /** Sightline clearance of a Masa camera at (yaw, radius, y) aiming at wantedTarget (layout.masaClearance). */
  private shotClearance(yaw: number, radius: number, y: number, near: boolean): number {
    this.occCam.set(Math.sin(yaw) * radius, y, Math.cos(yaw) * radius);
    return masaClearance(this.occCam, this.wantedTarget, this.count, this.seatMask, near);
  }

  /**
   * Yaw nudge for an automatic Masa shot so no seated head (or hat) sits on the sightlines to the target and
   * the near table rim: none when the straight shot is clear; else the current nudge while it stays clear
   * (hysteresis), else the smallest clear one (toward the middle of the room first). Never re-searched while
   * the user drags the camera.
   */
  private clearShot(yaw: number, radius: number, y: number): number {
    if (!this.seatMask) return (this.occYaw = 0);
    // the wheel hangs above every head: only its own sightline counts
    const near = this.focus !== "wheel";
    const straight = this.shotClearance(yaw, radius, y, near);
    if (straight >= OCC_OK) return (this.occYaw = 0);
    const current = this.occYaw === 0 ? straight : this.shotClearance(yaw + this.occYaw, radius, y, near);
    if ((this.occYaw !== 0 && current >= OCC_KEEP) || this.orbitIdle < 1) return this.occYaw;
    const now = clockSec();
    if (now < this.occRetryAt) return this.occYaw;
    let best = this.occYaw;
    let bestClear = current;
    const first = this.occYaw !== 0 ? Math.sign(this.occYaw) : yaw > 0 ? -1 : 1;
    for (let i = 1; i <= OCC_STEPS; i++) {
      for (let j = 0; j < 2; j++) {
        const off = (j === 0 ? first : -first) * i * OCC_STEP;
        const c = this.shotClearance(yaw + off, radius, y, near);
        if (c >= OCC_OK) return (this.occYaw = off);
        if (c > bestClear + 0.02) {
          bestClear = c;
          best = off;
        }
      }
    }
    // nothing fully clear: the least blocked (straight on when that is as good), and no new search for a while
    this.occRetryAt = now + 0.3;
    return (this.occYaw = straight >= bestClear - 0.02 ? 0 : best);
  }

  private fpPose(dt: number, now: number): void {
    const seat = this.viewSeat!;
    // eye: the seat anchor (+ the puppet's sit/stand lift), sliding when the seat count changes
    this.liftShown += (this.liftWanted - this.liftShown) * smoothing(8, dt);
    eyePoint(seat, this.count, this.eyeWanted);
    this.eyeWanted.y += this.liftShown;
    if (!this.fpEyeValid) {
      this.fpEye.copy(this.eyeWanted);
      this.fpEyeValid = true;
    } else {
      this.fpEye.lerp(this.eyeWanted, smoothing(6, dt));
    }
    restGaze(this.fpEye, this.rest);

    // user look: recenter / idle ease-back, back inside the soft limits once the input stops, light smoothing
    this.lookIdle += dt;
    if (this.recenterLeft > 0) {
      this.recenterLeft -= dt;
      const k = smoothing(this.recenterRate, dt);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
    } else if (this.lookIdle > (this.lookLocked ? 6 : 2.5)) {
      const k = smoothing(1.3, dt);
      this.lookYaw -= this.lookYaw * k;
      this.lookPitch -= this.lookPitch * k;
    }
    if (this.lookIdle > 0.15) {
      const k = smoothing(6, dt);
      if (Math.abs(this.lookYaw) > YAW_SOFT) this.lookYaw += (Math.sign(this.lookYaw) * YAW_SOFT - this.lookYaw) * k;
      if (this.lookPitch > PITCH_UP_SOFT) this.lookPitch += (PITCH_UP_SOFT - this.lookPitch) * k;
      if (this.lookPitch < PITCH_DOWN_SOFT) this.lookPitch += (PITCH_DOWN_SOFT - this.lookPitch) * k;
    }
    const follow = smoothing(this.lookLocked ? 45 : 22, dt);
    this.lookYawShown += (this.lookYaw - this.lookYawShown) * follow;
    this.lookPitchShown += (this.lookPitch - this.lookPitchShown) * follow;
    const userYaw = this.rest.yaw + this.lookYawShown;
    const userPitch = this.rest.pitch + this.lookPitchShown;

    // attention: focus-driven head turns + transient look-ats; the user's hand wins while it moves
    const userActive = 1 - smooth01((this.lookIdle - 0.25) / 1.25);
    let offYaw = 0;
    let offPitch = 0;
    let cinematic = false;
    const point = this.attPoint;
    const hasBase = this.baseAttention(now, point);
    if (hasBase) {
      gazeTo(this.fpEye, point, this.gaze);
      const w = this.baseWeight * (1 - userActive * (this.basePriority >= 3 ? 0.6 : 1));
      offYaw = wrapAngle(this.gaze.yaw - userYaw) * w;
      offPitch = (this.gaze.pitch - userPitch) * w;
      cinematic = this.basePriority >= 3;
    }
    const a = this.att;
    if (a.active) {
      const env = Math.min(smooth01((now - a.start) / ATT_IN), Number.isFinite(a.until) ? smooth01((a.until - now) / ATT_OUT) : 1);
      if (now >= a.until) a.active = false;
      const p = a.fn ? a.fn() : a.point;
      if (a.active && p && (!hasBase || a.priority >= this.basePriority)) {
        gazeTo(this.fpEye, p, this.gaze);
        const w = a.weight * env * (1 - userActive * (a.priority >= 3 ? 0.6 : 1));
        offYaw = lerp(offYaw, wrapAngle(this.gaze.yaw - userYaw), w);
        offPitch = lerp(offPitch, this.gaze.pitch - userPitch, w);
        cinematic = cinematic || a.priority >= 3;
      }
    }
    const omega = userActive > 0.5 ? 14 : cinematic ? 7 : 5.5;
    const yaw = userYaw + this.attYaw.step(offYaw, omega, dt);
    const pitch = clamp(userPitch + this.attPitch.step(offPitch, omega, dt), -1.25, 1.1);
    this.fpQuat.setFromEuler(this.euler.set(pitch, yaw, 0, "YXZ"));
    this.gaze.yaw = yaw;
    this.gaze.pitch = pitch;
    gazeForward(this.gaze, this.fpView.forward);
  }

  /** Focus → first-person look-at (writes the point, baseWeight, basePriority). */
  private baseAttention(now: number, out: THREE.Vector3): boolean {
    const mine = this.viewSeat;
    switch (this.focus) {
      case "seat": {
        if (this.focusSeat === mine || this.focusSeat < 0 || this.focusSeat >= this.count) return false;
        this.seatLook(this.focusSeat, out);
        gazeTo(this.fpEye, out, this.gaze);
        this.baseWeight = attentionWeight(wrapAngle(this.gaze.yaw - this.rest.yaw), this.hfov);
        this.basePriority = 1;
        return true;
      }
      case "door": {
        const seat = this.doorSeat;
        if (now - this.focusSince < 0.9 || seat === null || seat === mine || seat >= this.count) {
          out.copy(DOOR_LOOK);
          this.baseWeight = 0.95;
        } else {
          this.seatLook(seat, out);
          this.baseWeight = 0.9;
        }
        this.basePriority = 3;
        return true;
      }
      case "wheel":
        out.copy(WHEEL_DOWN);
        this.baseWeight = 1;
        this.basePriority = 3;
        return true;
      default:
        return false;
    }
  }

  /** A seated player's face, pulled 40% toward their card row. */
  private seatLook(seat: number, out: THREE.Vector3): THREE.Vector3 {
    const d = dirOf(seatAngle(seat, this.count), this.tmpB);
    const headR = SEAT_RADIUS - 0.12;
    const headY = 1.28;
    const rowY = TABLE_TOP_Y + 0.02;
    return out.set(d.x * lerp(headR, CARD_ROW_RADIUS, 0.4), lerp(headY, rowY, 0.4), d.z * lerp(headR, CARD_ROW_RADIUS, 0.4));
  }

  // ---------------------------------------------------------------------- name plates
  private makePlate(): Plate {
    const canvas = document.createElement("canvas");
    canvas.width = 512; canvas.height = 200;
    const context = canvas.getContext("2d")!;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = 4;
    const group = new THREE.Group();
    group.visible = false;
    const mat = new THREE.MeshBasicMaterial({ map: texture });
    const tent = new THREE.Mesh(this.plateGeo, mat);
    tent.name = "plate";
    tent.raycast = () => {};
    group.add(tent);
    this.world.add(group);
    return { group, canvas, context, texture, mat, data: null, key: "", paintedKey: "", paintedValue: NaN, paintedAt: -1, hidden: false };
  }

  /**
   * Repaint a plate when its name / color / status changes, and while the money counts up at most 12 times a
   * second (plus the final value), so a payout doesn't re-upload six canvases every frame.
   */
  private updatePlates(): void {
    const now = clockSec();
    for (let i = 0; i < MAX_SEATS; i++) {
      const p = this.plates[i]!;
      const d = p.data;
      if (!d) continue;
      if (Math.abs(p.mat.color.r - this.plateLight) > 0.004) p.mat.color.setScalar(this.plateLight);
      const shown = Math.round(this.stacks.shown(i));
      if (p.paintedKey === p.key) {
        if (shown === p.paintedValue) continue;
        if (now - p.paintedAt < PLATE_REPAINT_SEC && shown !== Math.round(d.kasa)) continue;
      }
      this.paintPlate(p, d, shown, now);
    }
  }

  private paintPlate(p: Plate, d: SeatProps, shown: number, now: number): void {
    p.paintedKey = p.key;
    p.paintedValue = shown;
    p.paintedAt = now;
    const g = p.context;
    const W = p.canvas.width, H = p.canvas.height;
    // frame in the player's color (gold while it's their turn), dark card inside
    g.fillStyle = d.active ? PALETTE.gold : d.color;
    g.fillRect(0, 0, W, H);
    g.fillStyle = d.ghost ? "#153A40" : "#241F2B";
    g.fillRect(12, 12, W - 24, H - 24);
    g.fillStyle = d.active ? PALETTE.gold : d.color;
    g.fillRect(12, 12, 14, H - 24);
    g.fillStyle = d.connected ? "#FFF4DF" : "#AEA6A6";
    g.textAlign = "center"; g.textBaseline = "middle";
    g.font = '700 66px "Fredoka", system-ui, sans-serif';
    g.fillText(d.nickname.slice(0, 14), W / 2 + 6, 70, W - 70);
    g.font = '600 60px "Fredoka", system-ui, sans-serif';
    g.fillStyle = d.connected ? "#7BD389" : "#AEA6A6";
    g.fillText(`${fmt.format(shown)}$`, W / 2 + 6, d.ghost || !d.connected ? 128 : 138, W - 70);
    if (d.ghost || !d.connected) {
      g.fillStyle = d.ghost ? "#A8E7E4" : "#FFBA88";
      g.font = '600 26px "Fredoka", system-ui, sans-serif';
      g.fillText(d.ghost ? "HAYALET" : "BAĞLANTI YOK", W / 2 + 6, 170);
    }
    p.texture.needsUpdate = true;
  }
}
