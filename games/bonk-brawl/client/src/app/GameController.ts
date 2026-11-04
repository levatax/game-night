// Per-frame game loop wiring input → net → characters/fx/camera/audio/ui. Owner: client-app.

import * as THREE from "three";
import {
  ARC_PREVIEW_FRACTION,
  ARC_PREVIEW_MAX_POINTS,
  BALL_RADIUS,
  CHEST_HEIGHT,
  COUNTDOWN_TICKS,
  DEFAULT_MAP,
  DT,
  FULL_CHARGE_THRESHOLD,
  KO_CUT_SEC,
  MEGA_BALL_RADIUS,
  PALETTE,
  PLAYER_RADIUS,
  ROUND_END_CARD_TICKS,
  TICK_RATE,
  playerColor,
} from "../../../shared/constants";
import { getArena, type ArenaDef, type CrumbleKind } from "../../../shared/maps";
import type {
  CountdownEvent,
  MatchEndEvent,
  RoundStartEvent,
  RoundWinEvent,
  SuddenDeathEvent,
} from "../../../shared/protocol";
import { TAU, clamp, vec3 } from "../../../shared/sim/math";
import { chargeFraction } from "../../../shared/sim/player";
import { aimDirection, computeThrowVelocity, sampleTrajectory, throwOrigin } from "../../../shared/sim/throw";
import type { BonkStateView, MapId, Phase, PlayerView, PowerUpView, Vec3Like } from "../../../shared/types";
import type { AudioEngine } from "../audio/AudioEngine";
import type { MusicTrack } from "../audio/Music";
import type { Characters } from "../characters/Characters";
import type { CharacterSyncOptions } from "../characters/types";
import type { Fx } from "../fx/Fx";
import { computeOffscreenIndicators, type IndicatorInput } from "../fx/Indicators";
import type { BallVisualContext } from "../fx/types";
import type { Input } from "../input/Input";
import type { Net } from "../net/Net";
import type { BallFrame, PlayerFrame } from "../net/types";
import type { Arena } from "../render/Arena";
import type { CameraMode, CameraRig, CameraUpdate } from "../render/CameraRig";
import type { Renderer } from "../render/Renderer";
import type { OffscreenIndicator, ScoreRow } from "../ui/models";
import type { Ui } from "../ui/Ui";
import { LiveFloorQuery, ShadowCasterBuffer, crumbColor, ringMidRadius, shapePoint } from "./frameHelpers";
import { GameFeedback } from "./GameFeedback";
import { PlayerEffects } from "./PlayerEffects";
import { settings } from "./settings";
import {
  HudModelBuilder,
  PlayerDirectory,
  ScoreRowsCache,
  buildRoundEndModel,
  isRoundPhase,
  type SpectateReason,
} from "./viewModels";

export interface GameControllerDeps {
  net: Net;
  input: Input;
  renderer: Renderer;
  camera: CameraRig;
  characters: Characters;
  fx: Fx;
  audio: AudioEngine;
  ui: Ui;
}

/** The input accumulator never catches up more than this much real time (no burst after a stall). */
const MAX_INPUT_BACKLOG_SEC = 0.25;
/** "BONK!" stays on the countdown widget this long after n = 0. */
const GO_SHOW_MS = 1000;
/** Sudden-death music tempo ramp (ARCHITECTURE §8: 1 → 1.35 over 25 s). */
const SUDDEN_DEATH_TEMPO_MAX = 1.35;
const SUDDEN_DEATH_TEMPO_RAMP_MS = 25_000;
/** Hide the local animal when the collision-pushed camera gets this close to its chest. */
const HIDE_LOCAL_DIST = 0.9;
/** The ghost camera starts this far above the elimination point, looking slightly down. */
const GHOST_RISE = 2.5;
const GHOST_PITCH = -0.35;
/** Dead without a ko/ringOut event (reconnect, missed message): enter the ghost cam after this. */
const AUTO_GHOST_GRACE_MS = 300;
/** Mid-match spectators start here, looking at the island center. */
const SPECTATOR_VANTAGE: Readonly<Vec3Like> = { x: 0, y: 9, z: 16 };
const SPECTATOR_PITCH = -0.45;
/** Crumb bursts spread around a falling ring. */
const CRUMB_BURSTS = 10;
/** Pop text above the local head for the "BONK!" start. */
const GO_POP_HEIGHT = 2.2;

const NO_INDICATORS: readonly OffscreenIndicator[] = [];
const NO_ROWS: readonly ScoreRow[] = [];

/** Round-scoped UI/camera state, reset at every roundStart and on enter/exit. */
interface RoundState {
  /** Tick of the latest roundStart (state older than this predates the round). */
  startTick: number;
  /** Last countdown number received (null before the first one this round). */
  countdown: number | null;
  goAtMs: number;
  suddenDeathAtMs: number;
  localAlive: boolean;
  deadSinceMs: number;
  koReason: SpectateReason | null;
  ghostEntered: boolean;
  /** Pending delayed ghost entry (ring-out), 0 = none. */
  ghostAtMs: number;
  ghostFrom: Vec3Like;
  pendingRoundEnd: RoundWinEvent | null;
}

function freshRound(): RoundState {
  return {
    startTick: 0,
    countdown: null,
    goAtMs: 0,
    suddenDeathAtMs: 0,
    localAlive: false,
    deadSinceMs: 0,
    koReason: null,
    ghostEntered: false,
    ghostAtMs: 0,
    ghostFrom: { x: 0, y: 0, z: 0 },
    pendingRoundEnd: null,
  };
}

function phaseMusic(phase: Phase): MusicTrack {
  if (phase === "suddenDeath") return "suddenDeath";
  return phase === "lobby" || phase === "matchEnd" ? "lobby" : "fight";
}

/**
 * Active while the room phase is countdown / playing / suddenDeath / roundEnd / matchEnd.
 *
 * frame(now, realDt) — exact order (docs/ARCHITECTURE.md §5):
 *  1. dt = fx.feel.update(realDt)                       (cosmetic dt: hit-stop / slow-mo)
 *  2. fixed-step input: if !net.wantsInput → acc = 0 (no backlog burst later). Else
 *     acc += min(realDt, 0.25); while acc >= DT: cmd = input.sample(++seq); net.sendInput(cmd)
 *     (prediction; localThrow/localStep events); acc -= DT. alpha = acc / DT.
 *     `seq` is ONE counter for the page lifetime (a field initialized once, never reset on
 *     enter/exit, new rounds, matches or reconnects): the server drops seq <= the last seen one.
 *  3. net.update(now, realDt)
 *  4. local = net.getLocalPlayer(alpha, { yaw: input.yaw, pitch: input.pitch });
 *     remotes = net.getRemotePlayers(now); balls = net.getBalls()
 *  5. renderer.arena.syncRings(state.rings)
 *  6. characters.sync([local, ...remotes], { crownId, localId, hideLocal }, dt)
 *  7. fx.balls.sync(balls, dt, { handOf: characters.getHandPosition, colorOf });
 *     charge telegraph for EVERY alive player frame (local and remote, chargeTicks is synced):
 *     fx.balls.setChargeGlow(id, chargeFraction(frame)) and a positional "charge" loop per
 *     charging player (setParam(charge), setPosition(hand), stop when the charge ends);
 *     fx.powerUps.sync(state powerUps, dt, elapsed); fx.shadows.update(players + balls);
 *     fx.arc.update(local full charge && settings.showArcPreview ? sampleTrajectory(...) : null, color);
 *     bounce SFX/squash for balls with `bounced`; zoomies speed lines + "zoomies" loop and Pip's
 *     "slide" loop per player while active
 *  8. fx.update(dt)
 *  9. camera.update(realDt, follow local | ghost when dead/spectating | orbit at matchEnd)
 * 10. audio.setListener(camera pos, forward); audio.setTimeScale(fx.feel.timeScale)
 * 11. renderer.update(dt, elapsed); renderer.render()
 * 12. ui.updateHud(buildHudModel(...)); ui.setIndicators(computeOffscreenIndicators(...));
 *     scoreboard rows while Tab is held
 *
 * Net events → feedback: see the event→feedback table in docs/ARCHITECTURE.md §8. Gameplay
 * events are handled by GameFeedback (subscribed in enter(), unsubscribed in exit()). Round-flow
 * messages stay subscribed for the controller's lifetime: `roundStart` can arrive one patch
 * before the phase change that makes the App enter the game view, so it enters by itself.
 */
export class GameController {
  private readonly deps: GameControllerDeps;
  private readonly directory: PlayerDirectory;
  private readonly effects: PlayerEffects;
  private readonly feedback: GameFeedback;
  private readonly rowsCache = new ScoreRowsCache();
  private readonly hud = new HudModelBuilder();
  private readonly floor: LiveFloorQuery;
  private readonly casters = new ShadowCasterBuffer();

  private activeFlag = false;
  /** Input sequence: one strictly increasing counter for the page lifetime (§2.16). */
  private seq = 0;
  private acc = 0;
  /** Cosmetic seconds (slowed by hit-stop / slow-mo). */
  private elapsed = 0;
  /**
   * Real time of the latest frame (rAF timestamp). Event handlers stamp with it too, so every
   * timer in here compares values from one clock.
   */
  private clockMs = performance.now();
  private round: RoundState = freshRound();
  private hookedArena: Arena | null = null;
  private music: MusicTrack = "none";
  private musicTempo = 1;
  private scoreboardOpen = false;
  private shownRows: readonly ScoreRow[] | null = null;
  private rosterRows: readonly ScoreRow[] | null = null;
  private arcShown = false;
  private cameraModeValue: CameraMode = "orbit";

  // Per-frame results and reusable scratch objects (no allocations in the hot path).
  private local: PlayerFrame | null = null;
  private balls: readonly BallFrame[] = [];
  private readonly frames: PlayerFrame[] = [];
  private readonly powerUpList: PowerUpView[] = [];
  private readonly pushPowerUp = (p: PowerUpView): void => {
    this.powerUpList.push(p);
  };
  private readonly look = { yaw: 0, pitch: 0 };
  private readonly syncOpts: CharacterSyncOptions = { crownId: "", localId: "", hideLocal: false };
  private readonly ballCtx: BallVisualContext;
  private readonly camUpdate: CameraUpdate = { mode: "orbit", charge: 0 };
  private readonly followTarget = { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
  private hasFollowTarget = false;
  private readonly ghostLook = { yaw: 0, pitch: 0 };
  private readonly orbitCenter = vec3();
  private readonly lastAlivePos = vec3();
  private hasLastAlivePos = false;
  private readonly chest = vec3();
  private readonly listenerForward = new THREE.Vector3();
  private readonly head = new THREE.Vector3();
  private readonly scratch = vec3();
  private readonly arcOrigin = vec3();
  private readonly arcAim = vec3();
  private readonly arcVelocity = vec3();
  private readonly indicatorInput: IndicatorInput;

  constructor(deps: GameControllerDeps) {
    this.deps = deps;
    const { net, characters, fx, audio } = deps;
    this.directory = new PlayerDirectory(() => net.state);
    this.effects = new PlayerEffects({ characters, fx, audio, colorOf: (id) => this.directory.color(id) });
    this.feedback = new GameFeedback(deps, this.directory, this.effects, {
      get localId() {
        return net.sessionId;
      },
      playerPosition: (id, out) => this.playerPosition(id, out),
      localEliminated: (reason, pos, delay) => this.onLocalEliminated(reason, pos, delay),
    });
    this.floor = new LiveFloorQuery(getArena(DEFAULT_MAP), () => net.state);
    this.ballCtx = {
      handOf: (id, out) => characters.getHandPosition(id, out),
      colorOf: (id) => this.directory.color(id),
    };
    this.indicatorInput = {
      camera: deps.renderer.camera,
      viewport: { width: 0, height: 0 },
      balls: [],
      chest: this.chest,
      localId: "",
      colorOf: (id) => this.directory.color(id),
    };
    net.events.on("roundStart", (e) => this.onRoundStart(e));
    net.events.on("countdown", (e) => this.onCountdown(e));
    net.events.on("suddenDeath", (e) => this.onSuddenDeath(e));
    net.events.on("roundWin", (e) => this.onRoundWin(e));
    net.events.on("matchEnd", (e) => this.onMatchEnd(e));
  }

  /**
   * Enter the game view: renderer.loadArena(state.mapId) (and again whenever mapId changes),
   * camera.setFloorQuery, fx.setArena, input.setLook(spawn yaw), music "fight", subscribe to
   * net gameplay events. Idempotent.
   * FloorQuery objects handed to camera/fx must read the CURRENT state.rings: either a live view
   * ({ arena, get rings() { return net.state?.rings ?? [] } }) or re-set them on every map change
   * and after a reconnect (a reconnect creates a new decoded state object).
   */
  enter(): void {
    this.activate(null);
  }

  /**
   * Shared by enter() and an early roundStart (which knows the new map before state.mapId does,
   * so the old map is never built just to be replaced).
   */
  private activate(roundStart: RoundStartEvent | null): void {
    if (this.activeFlag) return;
    this.activeFlag = true;
    this.acc = 0;
    this.round = freshRound();
    this.round.deadSinceMs = this.clockMs;
    this.hasFollowTarget = false;
    this.feedback.attach();
    const { net, input } = this.deps;
    const state = net.state;
    const mapId = roundStart?.mapId ?? state?.mapId;
    if (mapId) this.loadArena(mapId);
    const me = net.me;
    if (!roundStart && me && me.alive && !me.spectator) input.setLook(me.yaw, me.pitch);
    if (!roundStart && state?.phase === "matchEnd") this.setOrbitCenter(state.matchWinnerId);
    this.playMusic(roundStart ? "fight" : phaseMusic(state?.phase ?? "countdown"));
  }

  /** Leave the game view: unsubscribe, stop loops, fx.clear(), characters.clear(). Idempotent. */
  exit(): void {
    if (!this.activeFlag) return;
    this.activeFlag = false;
    const { audio, characters, fx, input, ui } = this.deps;
    this.feedback.detach();
    this.effects.clear();
    fx.arc.update(null, PALETTE.white);
    this.arcShown = false;
    this.casters.reset();
    fx.shadows.update(this.casters.list);
    fx.clear();
    characters.clear();
    ui.hideRoundEnd();
    ui.setIndicators(NO_INDICATORS);
    if (this.scoreboardOpen) ui.setScoreboard(false, NO_ROWS);
    this.shownRows = null;
    this.rosterRows = null;
    this.directory.clear();
    this.rowsCache.invalidate();
    this.round = freshRound();
    this.local = null;
    this.balls = [];
    this.frames.length = 0;
    this.hookedArena = null;
    this.acc = 0;
    input.clearLatches();
    this.setMusicTempo(1);
    this.music = "none";
    audio.setTimeScale(1);
  }

  get active(): boolean {
    return this.activeFlag;
  }

  /** Music the game view wants right now (the App re-plays it once audio unlocks). */
  get musicTrack(): MusicTrack {
    return this.music;
  }

  /** Tab held / released (Input "scoreboard" event). */
  setScoreboardOpen(open: boolean): void {
    if (open === this.scoreboardOpen) return;
    this.scoreboardOpen = open;
    this.shownRows = null;
    if (!open) this.deps.ui.setScoreboard(false, NO_ROWS);
  }

  /** One render frame (see order above). */
  frame(nowMs: number, realDt: number): void {
    if (!this.activeFlag) return;
    this.clockMs = nowMs;
    const { fx, net, renderer } = this.deps;
    const dt = fx.feel.update(realDt);
    this.elapsed += dt;
    const alpha = this.stepInput(realDt);
    net.update(nowMs, realDt);
    const state = net.state;
    if (state) this.syncWorld(state, nowMs, alpha, dt);
    fx.update(dt);
    this.updateCamera(realDt, state, nowMs);
    this.updateAudio(state, nowMs);
    renderer.update(dt, this.elapsed);
    renderer.render();
    if (state) this.updateUi(state, nowMs);
  }

  /* ============================================================== input */

  /** Step 2: fixed 30 Hz sampling; returns the interpolation alpha for the predicted player. */
  private stepInput(realDt: number): number {
    const { input, net } = this.deps;
    if (!net.wantsInput) {
      this.acc = 0;
      input.clearLatches();
      return 0;
    }
    this.acc += Math.min(realDt, MAX_INPUT_BACKLOG_SEC);
    while (this.acc >= DT) {
      net.sendInput(input.sample(++this.seq));
      this.acc -= DT;
    }
    return this.acc / DT;
  }

  /* ========================================================== the world */

  /** Steps 4–7: pull frames from net and push them into characters and fx. */
  private syncWorld(state: BonkStateView, nowMs: number, alpha: number, dt: number): void {
    const { characters, fx, input, net, renderer } = this.deps;
    this.look.yaw = input.yaw;
    this.look.pitch = input.pitch;
    const local = net.getLocalPlayer(alpha, this.look);
    const remotes = net.getRemotePlayers(nowMs);
    const balls = net.getBalls();
    this.local = local;
    this.balls = balls;

    this.ensureArena(state);
    renderer.arena?.syncRings(state.rings);

    const frames = this.frames;
    frames.length = 0;
    if (local) frames.push(local);
    for (const r of remotes) frames.push(r);
    const opts = this.syncOpts;
    opts.crownId = state.crownId;
    opts.localId = net.sessionId;
    opts.hideLocal = this.cameraTooClose(local);
    opts.cameraPos = renderer.camera.position;
    characters.sync(frames, opts, dt);

    fx.balls.sync(balls, dt, this.ballCtx);
    this.effects.update(frames, dt);
    this.powerUpList.length = 0;
    state.powerUps.forEach(this.pushPowerUp);
    fx.powerUps.sync(this.powerUpList, dt, this.elapsed);
    this.updateShadows(balls);
    this.updateArc(local);
    this.playBounces(balls);
  }

  /** Load the round's arena. A roundStart can precede the mapId patch: never flip back to the old map. */
  private ensureArena(state: BonkStateView): void {
    if (this.isStale(state)) return;
    this.loadArena(state.mapId);
  }

  /**
   * True while the decoded state still predates the latest roundStart message. Messages beat
   * patches, and a Start from the lobby is broadcast within the tick of the previous patch, so
   * the tick alone can't tell; but the old phase is never "countdown" (it's lobby or roundEnd).
   */
  private isStale(state: BonkStateView): boolean {
    const start = this.round.startTick;
    return start > 0 && state.phase !== "countdown" && state.tick <= start;
  }

  private loadArena(mapId: MapId): void {
    const { camera, fx, renderer } = this.deps;
    const current = renderer.arena;
    if (current && current === this.hookedArena && current.def.id === mapId) return;
    const arena = renderer.loadArena(mapId);
    arena.onRingFall = (ring, crumble) => this.onRingFall(arena.def, ring, crumble);
    this.hookedArena = arena;
    this.floor.arena = arena.def;
    camera.setFloorQuery(this.floor);
    fx.setArena(arena.def, this.floor);
  }

  /** Crumbs around the ring as it starts to fall (the rumble SFX comes with the ringDrop event). */
  private onRingFall(def: ArenaDef, ring: number, crumble: CrumbleKind): void {
    const r = ringMidRadius(def, ring);
    if (r < 0) return;
    const color = crumbColor(def, crumble);
    const p = this.scratch;
    for (let i = 0; i < CRUMB_BURSTS; i++) {
      shapePoint(def.shape, r, ((i + Math.random() * 0.6) / CRUMB_BURSTS) * TAU, p);
      p.y = -0.2;
      this.deps.fx.particles.burst("crumbs", p, { color, scale: 0.9 });
    }
  }

  private cameraTooClose(local: PlayerFrame | null): boolean {
    if (!local || !local.alive) return false;
    const cam = this.deps.renderer.camera.position;
    return Math.hypot(cam.x - local.x, cam.y - (local.y + CHEST_HEIGHT), cam.z - local.z) < HIDE_LOCAL_DIST;
  }

  private updateShadows(balls: readonly BallFrame[]): void {
    const c = this.casters;
    c.reset();
    for (const f of this.frames) {
      if (f.alive && !f.spectator) c.add(f.x, f.y, f.z, PLAYER_RADIUS);
    }
    for (const b of balls) {
      if (b.state !== "held" && b.opacity > 0.2) c.add(b.x, b.y - b.radius, b.z, b.radius);
    }
    this.deps.fx.shadows.update(c.list);
  }

  /** Full-charge arc preview (first 25% of the real trajectory), a skill helper not an aimbot. */
  private updateArc(local: PlayerFrame | null): void {
    const { fx } = this.deps;
    const charge = local ? chargeFraction(local) : 0;
    const show =
      local !== null &&
      local.alive &&
      local.heldCount > 0 &&
      charge >= FULL_CHARGE_THRESHOLD &&
      settings.get().showArcPreview;
    if (!show || !local) {
      if (this.arcShown) fx.arc.update(null, PALETTE.white);
      this.arcShown = false;
      return;
    }
    throwOrigin(local, this.arcOrigin);
    aimDirection(local.yaw, local.pitch, this.arcAim);
    computeThrowVelocity(charge, this.arcAim, local.powerUp, this.arcVelocity);
    const radius = local.powerUp === "mega" ? MEGA_BALL_RADIUS : BALL_RADIUS;
    const points = sampleTrajectory(this.floor, this.arcOrigin, this.arcVelocity, {
      radius,
      fraction: ARC_PREVIEW_FRACTION,
      maxPoints: ARC_PREVIEW_MAX_POINTS,
    });
    fx.arc.update(points, playerColor(local.slot));
    this.arcShown = true;
  }

  /** Bounce boing (+ squeak on hard bounces); the squash itself is drawn by fx.balls. */
  private playBounces(balls: readonly BallFrame[]): void {
    const { audio } = this.deps;
    for (const b of balls) {
      if (!b.bounced) continue;
      const strength = clamp(b.bounceSpeed / 14, 0.15, 1);
      const pos = { x: b.x, y: b.y, z: b.z };
      audio.play("bounce", { pos, volume: strength, pitch: 1.15 - 0.3 * strength });
      if (b.bounceSpeed > 12) audio.play("squeak", { pos, volume: 0.6 });
    }
  }

  /* ============================================================= camera */

  private updateCamera(realDt: number, state: BonkStateView | null, nowMs: number): void {
    const { camera, input } = this.deps;
    const mode = this.cameraMode(state, nowMs);
    this.cameraModeValue = mode;
    const u = this.camUpdate;
    u.mode = mode;
    u.charge = 0;
    if (mode === "follow") {
      const local = this.local;
      if (local && local.alive && !local.spectator) {
        const t = this.followTarget;
        t.x = local.x;
        t.y = local.y;
        t.z = local.z;
        t.yaw = local.yaw;
        t.pitch = local.pitch;
        this.hasFollowTarget = true;
        u.charge = chargeFraction(local);
      }
      u.target = this.followTarget;
    } else if (mode === "ghost") {
      u.ghostMove = input.ghostMove();
      this.ghostLook.yaw = input.yaw;
      this.ghostLook.pitch = input.pitch;
      u.ghostLook = this.ghostLook;
    } else {
      u.orbitCenter = this.orbitCenter;
    }
    camera.update(realDt, u);
  }

  /** follow while alive (or while watching a ring-out fall), ghost when out, orbit at matchEnd. */
  private cameraMode(state: BonkStateView | null, nowMs: number): CameraMode {
    // No state (reconnecting) or a state that predates the latest roundStart: keep the view.
    if (!state || this.isStale(state)) return this.cameraModeValue;
    if (state.phase === "matchEnd" || state.phase === "lobby") return "orbit";
    this.updateLifeState(nowMs);
    const r = this.round;
    if (r.localAlive) return "follow";
    // Watching a ring-out fall, or the short grace before a fallback ghost entry.
    if (!r.ghostEntered && this.hasFollowTarget) return "follow";
    return "ghost";
  }

  /** Track the local player's alive → out → alive cycle and enter the ghost camera on time. */
  private updateLifeState(nowMs: number): void {
    const r = this.round;
    const local = this.local;
    const alive = local !== null && local.alive && !local.spectator;
    if (alive) {
      if (!r.localAlive) {
        r.koReason = null;
        r.ghostEntered = false;
        r.ghostAtMs = 0;
      }
      r.localAlive = true;
      this.lastAlivePos.x = local.x;
      this.lastAlivePos.y = local.y;
      this.lastAlivePos.z = local.z;
      this.hasLastAlivePos = true;
      return;
    }
    if (r.localAlive) {
      r.localAlive = false;
      r.deadSinceMs = nowMs;
    }
    if (r.ghostAtMs > 0 && nowMs >= r.ghostAtMs) {
      r.ghostAtMs = 0;
      this.enterGhost(r.ghostFrom, this.deps.input.yaw, GHOST_PITCH);
    }
    const graceOver = local?.spectator === true || nowMs - r.deadSinceMs >= AUTO_GHOST_GRACE_MS;
    if (!r.ghostEntered && r.ghostAtMs === 0 && graceOver) this.enterFallbackGhost(local);
  }

  /** Ghost entry without a ko/ringOut event: spectators, reconnects, missed messages. */
  private enterFallbackGhost(local: PlayerFrame | null): void {
    const onIsland = this.hasLastAlivePos && this.lastAlivePos.y > -1;
    if (local?.spectator || !onIsland) {
      this.enterGhost(SPECTATOR_VANTAGE, 0, SPECTATOR_PITCH);
      return;
    }
    const p = this.lastAlivePos;
    this.enterGhost({ x: p.x, y: p.y + GHOST_RISE, z: p.z }, this.deps.input.yaw, GHOST_PITCH);
  }

  private enterGhost(from: Vec3Like, yaw: number, pitch: number): void {
    this.deps.camera.enterGhost(from, yaw);
    this.deps.input.setLook(yaw, pitch);
    this.round.ghostEntered = true;
  }

  /** FeedbackHost: the local player got knocked out or rung out. */
  private onLocalEliminated(reason: "ko" | "ringOut", pos: Vec3Like, delaySec: number): void {
    const r = this.round;
    r.koReason = reason;
    r.ghostFrom = { x: pos.x, y: Math.max(pos.y, 0) + GHOST_RISE, z: pos.z };
    if (delaySec > 0) {
      r.ghostAtMs = this.clockMs + delaySec * 1000;
      return;
    }
    r.ghostAtMs = 0;
    this.enterGhost(r.ghostFrom, this.deps.input.yaw, GHOST_PITCH);
  }

  /* ============================================================== audio */

  private updateAudio(state: BonkStateView | null, nowMs: number): void {
    const { audio, fx, renderer } = this.deps;
    const cam = renderer.camera;
    cam.getWorldDirection(this.listenerForward);
    audio.setListener(cam.position, this.listenerForward);
    audio.setTimeScale(fx.feel.timeScale);
    if (state) this.updateMusicTempo(state, nowMs);
  }

  private updateMusicTempo(state: BonkStateView, nowMs: number): void {
    if (state.phase !== "suddenDeath") {
      this.setMusicTempo(1);
      return;
    }
    const r = this.round;
    if (r.suddenDeathAtMs === 0) {
      // Joined or reconnected during sudden death: start the ramp (and its music) now.
      r.suddenDeathAtMs = nowMs;
      this.playMusic("suddenDeath");
    }
    const t = clamp((nowMs - r.suddenDeathAtMs) / SUDDEN_DEATH_TEMPO_RAMP_MS, 0, 1);
    this.setMusicTempo(1 + (SUDDEN_DEATH_TEMPO_MAX - 1) * t);
  }

  /** Skips sub-0.5% steps of the ramp, but always lands exactly on 1 when it resets. */
  private setMusicTempo(tempo: number): void {
    if (tempo === this.musicTempo || (tempo !== 1 && Math.abs(tempo - this.musicTempo) < 0.005)) return;
    this.musicTempo = tempo;
    this.deps.audio.setMusicTempo(tempo);
  }

  /** While active, only the game view picks music; exit() forgets the track. */
  private playMusic(track: MusicTrack): void {
    if (track === this.music) return;
    this.music = track;
    this.deps.audio.playMusic(track);
  }

  /* ================================================================= UI */

  private updateUi(state: BonkStateView, nowMs: number): void {
    const { net, renderer, ui } = this.deps;
    if (state.phase === "matchEnd" || state.phase === "lobby") return;
    this.maybeShowRoundEnd(state);
    const me = net.me;
    const localId = net.sessionId;
    const rows = this.rowsCache.get(state, localId, 0);
    if (rows !== this.rosterRows) {
      // Rows rebuild whenever the roster changes: keep names for players who leave mid-round.
      this.rosterRows = rows;
      this.directory.rememberAll(state);
    }
    const spectating = this.spectateReason(state, me);
    const timerSec = this.timerSec(state, nowMs);
    ui.updateHud(
      this.hud.build({
        state,
        me,
        sim: net.localSim ?? me,
        timerSec,
        countdown: this.countdownValue(state, timerSec, nowMs),
        scoreboard: rows,
        spectating,
      }),
    );
    const local = this.local;
    if (local && local.alive && !spectating) {
      const input = this.indicatorInput;
      input.viewport = renderer.viewport;
      input.balls = this.balls;
      input.localId = localId;
      this.chest.x = local.x;
      this.chest.y = local.y + CHEST_HEIGHT;
      this.chest.z = local.z;
      ui.setIndicators(computeOffscreenIndicators(input));
    } else {
      ui.setIndicators(NO_INDICATORS);
    }
    if (this.scoreboardOpen && rows !== this.shownRows) {
      ui.setScoreboard(true, rows);
      this.shownRows = rows;
    }
  }

  private spectateReason(state: BonkStateView, me: PlayerView | null): SpectateReason | null {
    if (!me) return null;
    if (me.spectator) return "spectator";
    if (!isRoundPhase(state.phase) || this.isStale(state) || me.alive) return null;
    return this.round.koReason ?? "ko";
  }

  /** Phase seconds left, advanced between 20 Hz patches with the server clock. */
  private timerSec(state: BonkStateView, nowMs: number): number {
    let ticks = state.phaseTicksLeft;
    const clock = this.deps.net.clock;
    if (clock.synced) ticks -= Math.max(0, clock.serverTickAt(nowMs) - state.tick);
    return Math.max(0, ticks) / TICK_RATE;
  }

  private countdownValue(state: BonkStateView, timerSec: number, nowMs: number): number | null {
    const r = this.round;
    const stale = this.isStale(state);
    if (state.phase === "countdown" || stale) {
      if (r.countdown !== null) return r.countdown;
      return stale ? COUNTDOWN_TICKS / TICK_RATE : clamp(Math.ceil(timerSec), 1, COUNTDOWN_TICKS / TICK_RATE);
    }
    return r.goAtMs > 0 && nowMs - r.goAtMs < GO_SHOW_MS ? 0 : null;
  }

  /** The round-end card waits for the server's slow-mo to finish. */
  private maybeShowRoundEnd(state: BonkStateView): void {
    const ev = this.round.pendingRoundEnd;
    if (!ev) return;
    if (state.phase === "roundEnd") {
      if (state.phaseTicksLeft > ROUND_END_CARD_TICKS) return;
      this.deps.ui.showRoundEnd(buildRoundEndModel(ev, state, this.deps.net.sessionId, this.directory));
      this.round.pendingRoundEnd = null;
    } else if (state.phase !== "playing" && state.phase !== "suddenDeath") {
      this.round.pendingRoundEnd = null;
    }
  }

  /* ========================================================= round flow */

  private onRoundStart(ev: RoundStartEvent): void {
    this.activate(ev);
    const { audio, fx, input, net, ui } = this.deps;
    const r = (this.round = freshRound());
    r.startTick = ev.tick;
    r.deadSinceMs = this.clockMs;
    this.loadArena(ev.mapId);
    fx.clear();
    this.effects.clear();
    ui.hideRoundEnd();
    this.playMusic("fight");
    this.setMusicTempo(1);
    audio.setTimeScale(1);
    ui.banner(ev.round >= ev.totalRounds ? "FINAL ROUND!" : `ROUND ${ev.round}`, "info");
    audio.announce?.("roundStart");
    const me = net.me;
    if (me && ev.participants.includes(me.id)) {
      const spawns = getArena(ev.mapId).spawns;
      const spawn = spawns[((me.slot % spawns.length) + spawns.length) % spawns.length];
      if (spawn) input.setLook(spawn.yaw, 0);
    }
  }

  private onCountdown(ev: CountdownEvent): void {
    if (!this.activeFlag) return;
    const { audio, fx } = this.deps;
    this.round.countdown = ev.n;
    if (ev.n > 0) {
      audio.play("countdownTick");
      return;
    }
    audio.play("countdownGo");
    this.round.goAtMs = this.clockMs;
    fx.popText.show("bonk", this.localPopPoint(), this.directory.color(this.deps.net.sessionId));
  }

  private onSuddenDeath(ev: SuddenDeathEvent): void {
    if (!this.activeFlag) return;
    void ev;
    const { audio, camera, ui } = this.deps;
    audio.play("suddenDeath");
    audio.announce?.("suddenDeath");
    this.playMusic("suddenDeath");
    this.round.suddenDeathAtMs = this.clockMs;
    ui.banner("SUDDEN DEATH!", "danger");
    camera.shake(0.15, 0.6);
  }

  private onRoundWin(ev: RoundWinEvent): void {
    if (!this.activeFlag) return;
    const { audio, camera, characters, fx, net } = this.deps;
    if (ev.winnerId) {
      characters.trigger(ev.winnerId, "victory");
      if (this.playerPosition(ev.winnerId, this.scratch)) {
        const pos = { x: this.scratch.x, y: this.scratch.y + 1.5, z: this.scratch.z };
        fx.particles.burst("confetti", pos, { scale: 1.5 });
        const winner = this.directory.character(ev.winnerId);
        if (winner) audio.voice(winner, "win", { pos });
      }
    }
    const me = net.me;
    const lost = me !== null && !me.spectator && ev.winnerId !== me.id;
    audio.jingle(lost ? "roundLose" : "roundWin");
    if (ev.winnerId) audio.announce?.("lastOne");
    if (ev.finalPos) camera.koCut(ev.finalPos, KO_CUT_SEC);
    this.round.pendingRoundEnd = ev;
  }

  private onMatchEnd(ev: MatchEndEvent): void {
    if (!this.activeFlag) return;
    const { audio, characters, fx, ui } = this.deps;
    ui.hideRoundEnd();
    this.round.pendingRoundEnd = null;
    audio.announce?.("win");
    this.setOrbitCenter(ev.winnerId);
    if (ev.winnerId) {
      characters.trigger(ev.winnerId, "victory");
      const c = this.orbitCenter;
      fx.particles.burst("confetti", { x: c.x, y: c.y + 1.5, z: c.z }, { scale: 2 });
    }
    audio.jingle("matchWin");
    this.playMusic("lobby");
    this.setMusicTempo(1);
  }

  /* ============================================================ helpers */

  /** Last rendered feet position of a player, falling back to its state position. */
  private playerPosition(id: string, out: Vec3Like): boolean {
    if (this.effects.positionOf(id, out)) return true;
    const view = this.directory.view(id);
    if (!view) return false;
    out.x = view.x;
    out.y = view.y;
    out.z = view.z;
    return true;
  }

  /** Where the match-end orbit circles: the winner, else the island center. */
  private setOrbitCenter(winnerId: string): void {
    const c = this.orbitCenter;
    if (!winnerId || !this.playerPosition(winnerId, c)) {
      c.x = 0;
      c.y = 0;
      c.z = 0;
    }
  }

  /** Above the local animal's head, or above the island center for spectators. */
  private localPopPoint(): Vec3Like {
    const id = this.deps.net.sessionId;
    if (this.deps.characters.getHeadTop(id, this.head)) return { x: this.head.x, y: this.head.y + 0.5, z: this.head.z };
    if (this.playerPosition(id, this.scratch) && this.scratch.y > -1) {
      return { x: this.scratch.x, y: this.scratch.y + GO_POP_HEIGHT, z: this.scratch.z };
    }
    return { x: 0, y: GO_POP_HEIGHT, z: 0 };
  }
}
