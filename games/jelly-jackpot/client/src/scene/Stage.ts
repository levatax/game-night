// Renderer, kitchen scene, table, cake stand, lights and the orbit camera. Owner: client-scene.
// PUBLIC API IS THE CONTRACT; fill in the bodies (add private helpers / files under scene/kitchen/ freely).
//
// Look (game2.md §10–11): cozy cartoon kitchen at NIGHT (wall PALETTE.wall), warm lamp light (PALETTE.lamp)
// hanging over a round table with a red/white checkered tablecloth (canvas texture), a glass cake stand
// with a pink-frosted birthday cake (drippy frosting, sprinkles, candles with flickering flames). Fridge
// with a NEON CASINO SIGN above it (canvas texture) that shows the current card (setSign). Silly details:
// a clock with googly eyes, a cat-shaped cookie jar, wobbly cabinets, a window with a cheesy moon.
// Everything via toon() + addOutlines() from ./toon. Saturated food colors vs the dark kitchen.
//
// Frames: `standGroup` sits at the table center and is rotated about Y by state.standAngle every frame
// (setStandAngle). The tower pieces / hover piece / ghost shadow are children of standGroup and use the
// stand-LOCAL frame directly (same numbers as the server). The cake's top surface is at CAKE_TOP_Y.
//
// Camera: orbit around the stand axis at a 35° downward angle; target y follows the tower top (smooth).
// Card effects: setUpsideDown (roll the camera 180° smoothly), setFog (thick steam particles + scene fog),
// shake(), pushIn() during settling.

//
// Implementation notes (client-scene): the kitchen pieces live in ./kitchen/ (Table, CakeStand, Room,
// NeonSign + fridge, Lamp, DeskFan, Steam). Scene graph: scene → kitchen (static room + lamp + sign),
// world (chefs / fx), tableRig (quake wobble) → table + standGroup (rotates) → stand, cake, fan, pieces.
// Seats: chef models are expected to face +z; seat i sits at angle (i + 0.5) / count around the table
// on the floor (FLOOR_Y), so the default camera (yaw 0, +z side) never sits right behind a chef.

import * as THREE from "three";
import type { Quality } from "../app/settings";
import { CAKE_TOP_Y, TABLE_RADIUS } from "../../../shared/constants";
import { CakeStand } from "./kitchen/CakeStand";
import { DeskFan } from "./kitchen/DeskFan";
import { Lamp } from "./kitchen/Lamp";
import { NeonSign } from "./kitchen/NeonSign";
import { CEILING_Y, ROOM_HALF, Room } from "./kitchen/Room";
import { Steam } from "./kitchen/Steam";
import { FLOOR_Y, buildTable } from "./kitchen/Table";

export { FLOOR_Y } from "./kitchen/Table";

export interface SeatPose {
  /** World position for a chef sitting at this seat (on the floor, facing the table center). */
  position: THREE.Vector3;
  /** Y rotation so the chef faces the center. */
  yaw: number;
}

const DEG = Math.PI / 180;
const DEFAULT_PITCH = 35 * DEG;
const MIN_PITCH = 10 * DEG;
const MAX_PITCH = 70 * DEG;
const BASE_DIST = 2.3;
const SEAT_RADIUS = TABLE_RADIUS + 0.45;
const MAX_STEAM = 90;
const FOG_COLOR = new THREE.Color("#CFC7E8");
const BG_COLOR = new THREE.Color("#1E1B30");

const wrapAngle = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const damp = (k: number, dt: number) => 1 - Math.exp(-k * dt);

export class Stage {
  readonly renderer!: THREE.WebGLRenderer;
  readonly scene!: THREE.Scene;
  readonly camera!: THREE.PerspectiveCamera;
  /** Rotates with the stand. Tower pieces + hover piece live here (stand-local frame). */
  readonly standGroup!: THREE.Group;
  /** Static world root for chefs / fx that don't rotate. */
  readonly world!: THREE.Group;

  private container: HTMLElement;
  private kitchen = new THREE.Group();
  private tableRig = new THREE.Group();
  private cakeStand = new CakeStand();
  private room = new Room();
  private sign = new NeonSign();
  private lamp = new Lamp();
  private fan = new DeskFan();
  private steam = new Steam(MAX_STEAM);
  private fog = new THREE.FogExp2(FOG_COLOR.getHex(), 0);
  private bg = BG_COLOR.clone();
  private quality: Quality = "high";
  private resizeObs: ResizeObserver | null = null;

  // camera rig
  private yaw = 0;
  private yawS = 0;
  private pitch = DEFAULT_PITCH;
  private pitchS = DEFAULT_PITCH;
  private zoomF = 1;
  private zoomS = 1;
  private towerH = 0;
  private towerS = 0;
  private pushOn = false;
  private pushS = 0;
  private roll = 0;
  private rollVel = 0;
  private upsideDown = false;
  private shakeT = 0;
  private shakeDur = 1;
  private shakeAmp = 0;
  private reducedFlashing = false;
  private fogOn = false;
  private fogS = 0;
  private quakeOn = false;
  private quakeS = 0;
  private jackpotT = 0;

  // stand angle smoothing: last server angle + estimated angular velocity → predicted angle
  private angleCur = 0;
  private angleLast = 0;
  private angleLastAt = -1;
  private angleVel = 0;
  private hasAngle = false;

  // scratch
  private raycaster = new THREE.Raycaster();
  private ndc = new THREE.Vector2();
  private tmpV = new THREE.Vector3();
  private tmpM = new THREE.Matrix4();
  private ray = new THREE.Ray();
  private camTarget = new THREE.Vector3(0, CAKE_TOP_Y, 0);

  constructor(container: HTMLElement) {
    this.container = container;
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(BG_COLOR);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    scene.background = this.bg;
    scene.fog = this.fog;
    const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 30);

    const standGroup = new THREE.Group();
    standGroup.name = "standGroup";
    const world = new THREE.Group();
    world.name = "world";

    Object.assign(this, { renderer, scene, camera, standGroup, world });

    // lights: dim purple night fill + moonlight + the lamp (the only shadow caster) + neon + candles
    scene.add(new THREE.HemisphereLight("#8C82C8", "#3A2E4A", 0.9));
    scene.add(new THREE.AmbientLight("#5A5280", 0.45));
    const moon = new THREE.DirectionalLight("#9DB8FF", 0.7);
    moon.position.set(ROOM_HALF, 2.5, 0.5);
    scene.add(moon);

    this.kitchen.add(this.room.group, this.sign.group, this.lamp.group);
    this.tableRig.add(buildTable(), standGroup);
    standGroup.add(this.cakeStand.stand, this.cakeStand.cake, this.fan.group);
    scene.add(this.kitchen, this.tableRig, world, this.steam.points);
    this.sign.set(null);

    this.applyQuality("high");
    this.resize();
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObs = new ResizeObserver(() => this.resize());
      this.resizeObs.observe(container);
    }
    window.addEventListener("resize", () => this.resize());
    this.updateCamera(0, 0);
  }

  // ------------------------------------------------------------------------------ settings
  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.applyQuality(q);
  }

  private applyQuality(q: Quality): void {
    this.quality = q;
    const dpr = window.devicePixelRatio || 1;
    this.renderer.setPixelRatio(Math.min(dpr, q === "low" ? 1 : q === "medium" ? 1.5 : 2));
    const shadows = q !== "low";
    const size = q === "high" ? 2048 : 1024;
    const spot = this.lamp.spot;
    if (spot.shadow.mapSize.x !== size) {
      spot.shadow.mapSize.set(size, size);
      spot.shadow.map?.dispose();
      spot.shadow.map = null;
    }
    if (this.renderer.shadowMap.enabled !== shadows) {
      this.renderer.shadowMap.enabled = shadows;
      spot.castShadow = shadows;
      // materials must recompile to pick up / drop shadow sampling
      this.scene.traverse((o) => {
        const m = (o as THREE.Mesh).material;
        if (!m) return;
        for (const mat of Array.isArray(m) ? m : [m]) mat.needsUpdate = true;
      });
    }
    spot.castShadow = shadows;
    this.steam.setCount(q === "low" ? 30 : q === "medium" ? 60 : MAX_STEAM);
    this.resize();
  }

  private resize(): void {
    const w = Math.max(1, this.container.clientWidth || window.innerWidth);
    const h = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // portrait screens: widen the FOV so the cake + chefs still fit
    this.camera.fov = w / h < 1 ? 50 + (1 - w / h) * 25 : 50;
    this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------------------ stand + tower
  /** Visual stand rotation in radians (from state.standAngle; smooth it yourself between patches). */
  setStandAngle(rad: number): void {
    const now = performance.now() / 1000;
    if (!this.hasAngle) {
      this.hasAngle = true;
      this.angleCur = rad;
      this.angleLast = rad;
      this.angleLastAt = now;
      return;
    }
    if (rad === this.angleLast) return;
    const dtSet = now - this.angleLastAt;
    const delta = wrapAngle(rad - this.angleLast);
    if (dtSet > 0.005 && dtSet < 0.5 && Math.abs(delta) < 0.5) {
      const v = delta / dtSet;
      this.angleVel += (v - this.angleVel) * 0.35;
    } else {
      this.angleVel = 0;
    }
    if (Math.abs(delta) > 0.5) this.angleCur = rad; // big jump (reset / reconnect) → snap
    this.angleLast = rad;
    this.angleLastAt = now;
  }

  /** Tower top above CAKE_TOP_Y in meters: the camera target rises to keep the tower framed. */
  setTowerHeight(m: number): void {
    this.towerH = Math.max(0, Math.min(3, Number.isFinite(m) ? m : 0));
  }

  // ------------------------------------------------------------------------------ camera controls
  /** Orbit by mouse/keyboard deltas (radians). Pitch clamped to 10°..70°. */
  orbit(dYaw: number, dPitch: number): void {
    this.yaw += dYaw;
    this.pitch = Math.min(MAX_PITCH, Math.max(MIN_PITCH, this.pitch + dPitch));
  }
  /** Zoom factor delta (scroll when not placing). */
  zoom(delta: number): void {
    this.zoomF = Math.min(1.6, Math.max(0.6, this.zoomF * (1 + delta)));
  }
  /** Slow push-in during settling (true) / back out (false). */
  pushIn(on: boolean): void {
    this.pushOn = on;
  }
  /** Camera shake: intensity 0..1, seconds. Respect reducedFlashing (×0.3) via setReducedFlashing. */
  shake(intensity: number, seconds: number): void {
    const amp = Math.max(0, Math.min(1, intensity)) * (this.reducedFlashing ? 0.3 : 1);
    const current = this.shakeT > 0 ? this.shakeAmp * (this.shakeT / this.shakeDur) : 0;
    if (amp < current) return;
    this.shakeAmp = amp;
    this.shakeDur = Math.max(0.05, seconds);
    this.shakeT = this.shakeDur;
  }
  setReducedFlashing(on: boolean): void {
    this.reducedFlashing = on;
    this.sign.reducedFlashing = on;
    this.lamp.reducedFlashing = on;
  }
  /** Upside Down card. */
  setUpsideDown(on: boolean): void {
    this.upsideDown = on;
  }
  /** Fog card: kitchen steam. */
  setFog(on: boolean): void {
    this.fogOn = on;
  }
  /** Wind Storm: show a silly desk fan at the table edge pointing along (dx, dz) stand-local, strength 0..1. */
  setWind(dx: number, dz: number, strength: number): void {
    this.fan.set(dx, dz, strength);
  }
  /** Earthquake: wobble the table + rattle props. */
  setQuake(on: boolean): void {
    this.quakeOn = on;
  }
  /** Neon casino sign above the fridge: card name + rarity color; null = "JELLY JACKPOT" idle marquee. */
  setSign(text: string | null, color?: string): void {
    this.sign.set(text, color);
  }
  /** Jackpot mode: strobe the lamp + neon in gold for `seconds`. */
  jackpotLights(seconds: number): void {
    this.jackpotT = Math.max(this.jackpotT, seconds);
    this.sign.setJackpot(true);
  }
  /** Fresh cake slides in (after a topple): cake squashes/slides from the side over ~0.8 s. */
  newCake(): void {
    this.cakeStand.slideIn();
  }

  /** Seat poses for `count` chefs around the table (seat 0..count-1). */
  seat(seat: number, count: number): SeatPose {
    const n = Math.max(1, count);
    const a = ((seat + 0.5) / n) * Math.PI * 2;
    return {
      position: new THREE.Vector3(Math.sin(a) * SEAT_RADIUS, FLOOR_Y, Math.cos(a) * SEAT_RADIUS),
      yaw: a + Math.PI, // chef's +z points at the table center
    };
  }

  // ------------------------------------------------------------------------------ picking / projection
  /**
   * Intersect the screen point with the horizontal plane y = planeY in the stand-LOCAL frame. Returns the
   * local-frame point (x, planeY, z) or null.
   */
  pickLocal(clientX: number, clientY: number, planeY: number): THREE.Vector3 | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    this.ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    this.camera.updateMatrixWorld();
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.standGroup.updateWorldMatrix(true, false);
    this.tmpM.copy(this.standGroup.matrixWorld).invert();
    const ray = this.ray.copy(this.raycaster.ray).applyMatrix4(this.tmpM);
    const dy = ray.direction.y;
    if (Math.abs(dy) < 1e-6) return null;
    const t = (planeY - ray.origin.y) / dy;
    if (t < 0) return null;
    const p = ray.at(t, new THREE.Vector3());
    p.y = planeY;
    return p;
  }

  /** Project a stand-local point to screen pixels (for DOM pop text). */
  localToScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    this.standGroup.updateWorldMatrix(true, false);
    return this.worldToScreen(this.tmpV.copy(p).applyMatrix4(this.standGroup.matrixWorld));
  }
  /** Project a world point to screen pixels. */
  worldToScreen(p: THREE.Vector3): { x: number; y: number; visible: boolean } {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const v = this.tmpV.copy(p).project(this.camera);
    return {
      x: rect.left + ((v.x + 1) / 2) * rect.width,
      y: rect.top + ((1 - v.y) / 2) * rect.height,
      visible: v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1,
    };
  }

  // ------------------------------------------------------------------------------ frame
  /** Per-frame animation (camera smoothing, candle flicker, neon blink, steam, props). */
  update(dt: number, time: number): void {
    dt = Math.min(0.1, Math.max(0, dt));

    // stand rotation: chase the predicted server angle
    if (this.hasAngle) {
      const now = performance.now() / 1000;
      const ahead = Math.min(0.15, now - this.angleLastAt);
      const predicted = this.angleLast + this.angleVel * ahead;
      this.angleCur += wrapAngle(predicted - this.angleCur) * damp(14, dt);
      this.standGroup.rotation.y = this.angleCur;
    }

    // effect amounts
    this.fogS += ((this.fogOn ? 1 : 0) - this.fogS) * damp(1.8, dt);
    this.quakeS += ((this.quakeOn ? 1 : 0) - this.quakeS) * damp(8, dt);
    if (this.jackpotT > 0) {
      this.jackpotT = Math.max(0, this.jackpotT - dt);
      if (this.jackpotT === 0) this.sign.setJackpot(false);
    }
    const q = this.quakeS;

    // earthquake: the whole table + stand wobbles
    this.tableRig.position.set(Math.sin(time * 31) * 0.012 * q, Math.abs(Math.sin(time * 19)) * 0.006 * q, Math.cos(time * 27) * 0.012 * q);
    this.tableRig.rotation.set(Math.sin(time * 21) * 0.012 * q, 0, Math.sin(time * 23) * 0.014 * q);

    // fog / steam
    this.fog.density = this.fogS * 0.42;
    this.bg.copy(BG_COLOR).lerp(FOG_COLOR, this.fogS * 0.85);
    this.steam.amount = this.fogS;
    this.steam.update(time, this.camTarget.y);

    // props
    this.cakeStand.update(dt, time, q);
    this.room.update(dt, time, q);
    this.sign.update(dt, time, q);
    this.lamp.update(dt, time, q, this.jackpotT);
    this.fan.update(dt, time);

    this.updateCamera(dt, time);
  }

  private updateCamera(dt: number, time: number): void {
    const k = dt > 0 ? damp(12, dt) : 1;
    this.yawS += (this.yaw - this.yawS) * k;
    this.pitchS += (this.pitch - this.pitchS) * k;
    this.zoomS += (this.zoomF - this.zoomS) * k;
    this.towerS += (this.towerH - this.towerS) * (dt > 0 ? damp(2.5, dt) : 1);
    this.pushS += ((this.pushOn ? 1 : 0) - this.pushS) * (dt > 0 ? damp(this.pushOn ? 0.6 : 2.5, dt) : 1);

    const h = this.towerS;
    const dist = (BASE_DIST + h * 0.9) * this.zoomS * (1 - 0.2 * this.pushS);
    // aim a bit above the cake so the tower grows into the frame (and the neon sign peeks in at the top)
    this.camTarget.set(0, CAKE_TOP_Y + 0.18 + h * 0.55 + this.pushS * h * 0.15, 0);
    const cp = Math.cos(this.pitchS);
    const pos = this.tmpV.set(Math.sin(this.yawS) * cp * dist, Math.sin(this.pitchS) * dist, Math.cos(this.yawS) * cp * dist).add(this.camTarget);
    // stay inside the kitchen
    const horiz = Math.hypot(pos.x, pos.z);
    const maxH = ROOM_HALF - 0.4;
    if (horiz > maxH) {
      pos.x *= maxH / horiz;
      pos.z *= maxH / horiz;
    }
    pos.y = Math.min(CEILING_Y - 0.2, pos.y);

    // shake (decaying) + quake jitter
    let shake = 0;
    if (this.shakeT > 0) {
      this.shakeT = Math.max(0, this.shakeT - dt);
      shake = this.shakeAmp * (this.shakeT / this.shakeDur);
    }
    shake += this.quakeS * (this.reducedFlashing ? 0.06 : 0.2);
    const s = shake * 0.06;
    pos.x += (Math.sin(time * 47.3) + Math.sin(time * 23.1)) * s;
    pos.y += (Math.sin(time * 53.7) + Math.cos(time * 31.9)) * s * 0.7;
    pos.z += (Math.cos(time * 41.1) + Math.sin(time * 19.7)) * s;

    // upside-down roll on a slightly bouncy spring (it overshoots and wobbles, cartoon style)
    const rollTarget = this.upsideDown ? Math.PI : 0;
    if (dt > 0) {
      this.rollVel += ((rollTarget - this.roll) * 28 - this.rollVel * 6) * dt;
      this.roll += this.rollVel * dt;
    }

    this.camera.position.copy(pos);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.camTarget);
    this.camera.rotateZ(this.roll + Math.sin(time * 37) * shake * 0.03);
    this.camera.updateMatrixWorld();
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }
}
