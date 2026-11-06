// Which camera the game view uses this frame, and the cinematic shots (docs/ARCHITECTURE.md §6.1 step 7):
// first person (head-bob, downed view inside FpCamera), the landing wake-up (lying on the sand looking at the
// sky, then sitting up), the spectator camera (washed ashore / mid-match joiners, §2.17: the slow orbit over the
// camp until the mouse steers it (Input free look); a click / Space follows the next teammate, RMB the previous,
// and past the last one it is back over the camp), the launch cinematic (aboard: a slow orbit around the sailing
// raft; left on the beach: your own eyes turn to watch it go), the storm (pulling up and away from you while
// the sky breaks) and the menu / podium orbit over the island.
// Owner: client-app. Only drives renderer.fp (FpCamera); the lightning is the renderer's.

import { EYE_HEIGHT, ISLAND_RADIUS, PITCH_LIMIT, TICK_RATE, type Timings } from "../../../shared/constants";
import { heightAt } from "../../../shared/island/heightfield";
import type { IslandDef } from "../../../shared/island/types";
import { inputLocked } from "../../../shared/rules/schedule";
import { angleDelta, clamp, lerp, pitchFromDir, wrapAngle, yawFromDir } from "../../../shared/sim/math";
import { chargeFraction, eyePosition } from "../../../shared/sim/player";
import type { Phase, PlayerView, RaftStateView, Vec3Like } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import type { FpCamera } from "../render/FpCamera";
import type { CameraFrame } from "../render/types";
import { ease, type Pose } from "./frameHelpers";

export type CameraMode = "orbit" | "fp" | "wake" | "spectate" | "launchRide" | "launchShore" | "storm";

export interface CameraInputs {
  phase: Phase;
  state: RaftStateView | null;
  me: PlayerView | null;
  /** Rendered local player (predicted while playing). */
  local: PlayerFrame | null;
  look: { yaw: number; pitch: number };
  island: IslandDef | null;
  timings: Readonly<Timings>;
  /** Current pose of the local team's raft (sails away during the launch), null when unknown. */
  raft: Pose | null;
  fov: number;
  headBob: boolean;
  realDt: number;
  nowMs: number;
  /** Other players this frame (interpolated): the teammates a spectator can follow. */
  remotes?: readonly PlayerFrame[];
  /** Spectator free look since the last frame (Input.takeFreeLook()): look deltas + follow steps. */
  freeLook?: { yaw: number; pitch: number; cycle: number };
}

export interface CameraResult {
  mode: CameraMode;
  /** Hide the local body and show the FP arms. */
  firstPerson: boolean;
  /** A cinematic owns the view (crosshair hidden, look input ignored). */
  cinematic: boolean;
}

/** Menu / lobby orbit over the whole island (scales with it: 40 m / 21 m on the old radius-30 island). */
const MENU_RADIUS = ISLAND_RADIUS * 1.33;
const MENU_HEIGHT = ISLAND_RADIUS * 0.6;
const MENU_SPEED = 0.045;
/** Podium orbit. */
const PODIUM_RADIUS = 13;
const PODIUM_HEIGHT = 6;
const PODIUM_SPEED = 0.12;
/** Launch ride orbit around the raft. */
const RIDE_RADIUS = 8.5;
const RIDE_HEIGHT = 3.4;
const RIDE_SPEED = 0.22;
/** Storm pull-back (from just behind you to high above the camp). */
const STORM_RADIUS: readonly [number, number] = [1.6, 20];
const STORM_HEIGHT: readonly [number, number] = [1.7, 13];
/** Wake-up: eye starts this high above the feet, looking up this much. */
const WAKE_EYE = 0.32;
const WAKE_PITCH = 1.05;
/** How fast the left-behind view turns to the raft (1/s). */
const WATCH_RATE = 2.2;
/** Spectator following a teammate: orbit distance (the camp framing is FpCamera's default) and aim height (m). */
const FOLLOW_DISTANCE = 9;
const FOLLOW_AIM = 0.4;
/** How fast the spectator orbit's center glides to a new target (1/s), and the lens's least height over the ground (m). */
const SPECTATE_GLIDE_RATE = 4;
const SPECTATE_CLEARANCE = 0.8;

export class CameraDirector {
  private readonly frame: CameraFrame = {
    eye: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    speed: 0,
    grounded: true,
    sprinting: false,
    swimming: false,
    downed: false,
    spectate: false,
    charge: 0,
    fov: 75,
    headBob: true,
  };
  private readonly lastEye = { x: 0, y: 2, z: 0 };
  private elapsed = 0;
  private modeValue: CameraMode = "orbit";
  private modeSince = 0;
  private wakeStartMs = -1;
  private watchYaw = 0;
  private watchPitch = 0;
  private stormYaw = 0;
  private readonly stormCenter = { x: 0, y: 0, z: 0 };
  /** Spectator: the teammate followed (null = over the camp) and the gliding orbit center. */
  private followId: string | null = null;
  private readonly spectateCenter = { x: 0, y: 0, z: 0 };
  private spectateCenterSet = false;

  constructor(private readonly fp: FpCamera) {}

  get mode(): CameraMode {
    return this.modeValue;
  }

  /** The teammate the spectator camera follows (null: the orbit over the camp, or not spectating). */
  get following(): string | null {
    return this.modeValue === "spectate" ? this.followId : null;
  }

  /** A new match: the next landing frame starts the wake-up from the beginning. */
  matchStarted(): void {
    this.wakeStartMs = -1;
  }

  /** Step 3 of the frame: pick this frame's camera (characters / arms need to know before the shot). */
  plan(i: CameraInputs): CameraResult {
    const mode = this.pick(i);
    if (mode !== this.modeValue) {
      this.enterMode(mode, i);
      this.modeValue = mode;
      this.modeSince = i.nowMs;
    }
    return resultFor(mode);
  }

  /** Step 7 of the frame: place the camera for the planned mode (same inputs as plan()). */
  shoot(i: CameraInputs): void {
    const dt = Math.max(0, Math.min(i.realDt, 0.1));
    this.elapsed += dt;
    // A shot that needs the local player falls back to the orbit when it vanished in between.
    const needsLocal = this.modeValue === "fp" || this.modeValue === "wake" || this.modeValue === "launchShore";
    if (needsLocal && !i.local) {
      this.orbitShot(i);
      return;
    }
    switch (this.modeValue) {
      case "orbit":
        this.orbitShot(i);
        break;
      case "spectate":
        this.spectateShot(i, dt);
        break;
      case "launchRide":
        this.rideShot(i);
        break;
      case "launchShore":
        this.shoreShot(i, dt);
        break;
      case "storm":
        this.stormShot(i);
        break;
      case "wake":
        this.wakeShot(i, dt);
        break;
      default:
        this.fpShot(i, dt);
        break;
    }
  }

  /** plan() + shoot() in one call (menus). */
  update(i: CameraInputs): CameraResult {
    const r = this.plan(i);
    this.shoot(i);
    return r;
  }

  private pick(i: CameraInputs): CameraMode {
    const { me, local, state } = i;
    if (!state || !me || i.phase === "lobby" || i.phase === "matchEnd") return "orbit";
    if (me.spectator || !me.alive || me.washed || !local) return "spectate";
    if (i.phase === "launch") return me.boarded ? "launchRide" : "launchShore";
    if (i.phase === "storm") return "storm";
    if (i.phase === "landing" && i.timings.landingLock > 0 && inputLocked("landing", state.phaseTicksLeft, i.timings)) return "wake";
    return "fp";
  }

  private enterMode(mode: CameraMode, i: CameraInputs): void {
    if (mode === "wake" && this.wakeStartMs < 0) this.wakeStartMs = i.nowMs;
    if (mode === "spectate") {
      // Every spectating spell starts on today's framing: over the camp, drifting.
      this.fp.resetSpectate();
      this.followId = null;
      this.spectateCenterSet = false;
    }
    if (mode === "launchShore") {
      this.watchYaw = i.look.yaw;
      this.watchPitch = i.look.pitch;
    }
    if (mode === "storm") {
      const at = i.local ?? i.me;
      this.stormYaw = i.look.yaw;
      this.stormCenter.x = at?.x ?? this.lastEye.x;
      this.stormCenter.y = (at?.y ?? this.lastEye.y - EYE_HEIGHT) + 1;
      this.stormCenter.z = at?.z ?? this.lastEye.z;
    }
  }

  /* ---------------------------------------------------------------- shots */

  private fillFromLocal(local: PlayerFrame, i: CameraInputs): CameraFrame {
    const f = this.frame;
    eyePosition(local, f.eye);
    f.yaw = local.yaw;
    f.pitch = local.pitch;
    f.speed = local.speed;
    f.grounded = local.grounded;
    f.sprinting = local.sprinting;
    f.swimming = local.swimming;
    f.downed = local.downed;
    f.spectate = false;
    f.charge = chargeFraction(local);
    f.fov = i.fov;
    f.headBob = i.headBob;
    this.lastEye.x = f.eye.x;
    this.lastEye.y = f.eye.y;
    this.lastEye.z = f.eye.z;
    return f;
  }

  private fpShot(i: CameraInputs, dt: number): void {
    this.fp.update(dt, this.fillFromLocal(i.local!, i));
  }

  private wakeShot(i: CameraInputs, dt: number): void {
    const f = this.fillFromLocal(i.local!, i);
    const lockMs = (i.timings.landingLock / TICK_RATE) * 1000;
    const p = lockMs > 0 ? ease((i.nowMs - this.wakeStartMs) / lockMs) : 1;
    const feet = f.eye.y - EYE_HEIGHT;
    f.eye.y = feet + lerp(WAKE_EYE, EYE_HEIGHT, p);
    f.pitch = clamp(lerp(WAKE_PITCH, i.look.pitch, p), -PITCH_LIMIT, PITCH_LIMIT);
    f.speed = 0;
    f.headBob = false;
    f.charge = 0;
    this.fp.update(dt, f);
  }

  private spectateShot(i: CameraInputs, dt: number): void {
    const f = this.frame;
    f.eye.x = this.lastEye.x;
    f.eye.y = this.lastEye.y;
    f.eye.z = this.lastEye.z;
    f.yaw = i.look.yaw;
    f.pitch = -0.3;
    f.speed = 0;
    f.grounded = true;
    f.sprinting = false;
    f.swimming = false;
    f.downed = false;
    f.spectate = true;
    f.charge = 0;
    f.fov = i.fov;
    f.headBob = false;
    const free = i.freeLook;
    if (free) this.fp.steerSpectate(free.yaw, free.pitch);
    // Who to watch: a followed teammate (a click / Space steps through them), else your own team's camp.
    const remotes = i.remotes ?? [];
    const mates = followableMates(remotes, i.me?.team ?? 0);
    if (free && free.cycle !== 0) this.followId = stepFollow(this.followId, mates, free.cycle);
    let target = this.followId ? (remotes.find((p) => p.id === this.followId) ?? null) : null;
    if (this.followId && (!target || !mates.includes(this.followId))) {
      // The followed castaway was washed ashore or left: keep watching whoever is closest to that spot.
      target = nearestMate(remotes, mates, this.spectateCenter);
      this.followId = target?.id ?? null;
    }
    let tx: number;
    let ty: number;
    let tz: number;
    let distance: number | undefined;
    const island = i.island;
    const site = island?.sites[i.me?.team ?? 0] ?? island?.sites[0];
    if (target) {
      tx = target.x;
      ty = target.y + FOLLOW_AIM;
      tz = target.z;
      distance = FOLLOW_DISTANCE;
    } else if (island && site) {
      // Orbit your own team's camp (the renderer defaults to the first site).
      tx = site.campfire.x;
      ty = groundAt(island, site.campfire.x, site.campfire.z);
      tz = site.campfire.z;
    } else {
      this.fp.update(dt, f);
      return;
    }
    const c = this.spectateCenter;
    const k = this.spectateCenterSet ? 1 - Math.exp(-SPECTATE_GLIDE_RATE * dt) : 1;
    this.spectateCenterSet = true;
    c.x += (tx - c.x) * k;
    c.y += (ty - c.y) * k;
    c.z += (tz - c.z) * k;
    this.fp.setSpectateCenter(c, distance);
    this.fp.update(dt, f);
    // Steered low next to a hill: keep the lens above the sand (and the sea).
    const lens = this.fp.camera.position;
    const floor = groundAt(island, lens.x, lens.z) + SPECTATE_CLEARANCE;
    if (lens.y < floor) lens.y = floor;
  }

  /** Aboard: circle the sailing raft. */
  private rideShot(i: CameraInputs): void {
    const raft = i.raft;
    if (!raft) {
      this.orbitShot(i);
      return;
    }
    const t = raft.yaw + Math.PI * 0.75 + ((i.nowMs - this.modeSince) / 1000) * RIDE_SPEED;
    this.fp.orbit({ x: raft.x, y: raft.y + 1.1, z: raft.z }, RIDE_RADIUS, RIDE_HEIGHT, t);
  }

  /** Left on the beach ("Wilson finale"): your own eyes turn to watch the raft go. */
  private shoreShot(i: CameraInputs, dt: number): void {
    const f = this.fillFromLocal(i.local!, i);
    if (i.raft) {
      const dx = i.raft.x - f.eye.x;
      const dz = i.raft.z - f.eye.z;
      const dy = i.raft.y + 0.8 - f.eye.y;
      const targetYaw = yawFromDir(dx, dz);
      const targetPitch = pitchFromDir({ x: dx, y: dy, z: dz });
      const k = 1 - Math.exp(-WATCH_RATE * dt);
      this.watchYaw = wrapAngle(this.watchYaw + angleDelta(this.watchYaw, targetYaw) * k);
      this.watchPitch += (targetPitch - this.watchPitch) * k;
    }
    f.yaw = this.watchYaw;
    f.pitch = clamp(this.watchPitch, -PITCH_LIMIT, PITCH_LIMIT);
    f.charge = 0;
    this.fp.update(dt, f);
  }

  /** Night 3 ended without a launch: the view pulls up and away while the storm takes the camp. */
  private stormShot(i: CameraInputs): void {
    const total = Math.max(1, (i.timings.storm / TICK_RATE) * 1000);
    const p = ease((i.nowMs - this.modeSince) / total);
    const r = lerp(STORM_RADIUS[0], STORM_RADIUS[1], p);
    const h = lerp(STORM_HEIGHT[0], STORM_HEIGHT[1], p);
    this.fp.orbit(this.stormCenter, r, h, this.stormYaw + p * 0.9);
  }

  /** Menus and the podium: a slow circle over the island (win: around the raft out at sea). */
  private orbitShot(i: CameraInputs): void {
    const island = i.island;
    const center = { x: 0, y: 2, z: 0 };
    let radius = MENU_RADIUS;
    let height = MENU_HEIGHT;
    let speed = MENU_SPEED;
    const site = island?.sites[i.me?.team ?? 0] ?? island?.sites[0];
    if (i.phase === "matchEnd" && site) {
      const won = (i.state?.winnerTeam ?? -1) >= 0;
      const target: Vec3Like = won && i.raft ? { x: i.raft.x, y: i.raft.y + 1, z: i.raft.z } : { x: site.campfire.x, y: groundAt(island, site.campfire.x, site.campfire.z) + 1, z: site.campfire.z };
      center.x = target.x;
      center.y = target.y;
      center.z = target.z;
      radius = PODIUM_RADIUS;
      height = PODIUM_HEIGHT;
      speed = PODIUM_SPEED;
    } else if (site) {
      center.x = site.center.x;
      center.z = site.center.z;
      center.y = 2;
    }
    this.fp.orbit(center, radius, height, this.elapsed * speed);
  }
}

function groundAt(island: IslandDef | null, x: number, z: number): number {
  return island ? Math.max(0, heightAt(island.grid, x, z)) : 0;
}

/** Ids of the teammates a spectator can follow, by seat: same team, still in the match (not washed / watching). */
export function followableMates(remotes: readonly PlayerFrame[], team: number): string[] {
  return remotes
    .filter((p) => p.team === team && p.alive && !p.washed && !p.spectator && !p.isLocal)
    .sort((a, b) => a.seat - b.seat)
    .map((p) => p.id);
}

/** Step `step` places around the ring [camp, ...ids] from `current` (null = the camp; an id gone = the camp). */
export function stepFollow(current: string | null, ids: readonly string[], step: number): string | null {
  const ring = ids.length + 1;
  const at = current === null ? 0 : ids.indexOf(current) + 1;
  const next = (((at + Math.trunc(step)) % ring) + ring) % ring;
  return next === 0 ? null : (ids[next - 1] ?? null);
}

/** The frame among `ids` closest to `from` (horizontal), or null. */
export function nearestMate(remotes: readonly PlayerFrame[], ids: readonly string[], from: Vec3Like): PlayerFrame | null {
  let best: PlayerFrame | null = null;
  let bestD = Infinity;
  for (const p of remotes) {
    if (!ids.includes(p.id)) continue;
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** First person / cinematic flags of a mode. */
export function resultFor(mode: CameraMode): CameraResult {
  switch (mode) {
    case "fp":
      return { mode, firstPerson: true, cinematic: false };
    case "wake":
    case "launchShore":
      return { mode, firstPerson: true, cinematic: true };
    default:
      return { mode, firstPerson: false, cinematic: true };
  }
}
