// The game view's per-frame loop: input → net → characters / fx / camera / audio / HUD, in the exact order of
// docs/ARCHITECTURE.md §6.1, plus the panels (craft / chest), the ping and emote wheels and the per-match memory.
// Owner: client-app. Adapted from games/bonk-brawl/client/src/app/GameController.ts.
//
// Robustness: every module is a guard() proxy (one broken method logs once and returns undefined) and every frame
// step runs inside step(), so one failing module never stops the frame loop.

import * as THREE from "three";
import {
  ARC_PREVIEW_FRACTION,
  ARC_PREVIEW_MAX_POINTS,
  ARC_PREVIEW_MIN_CHARGE,
  CHEST_RANGE,
  CRAFT_RANGE,
  DAYS,
  DT,
  EMOTE_COOLDOWN_TICKS,
  EMOTE_IDS,
  FIRE_LOW_FRACTION,
  FIRE_START_FUEL_TICKS,
  FISH_STATE,
  MARKER_COOLDOWN_TICKS,
  MARKER_KINDS,
  PUFFER_FUSE_TICKS,
  STORM_WARN_SEC,
  TICK_MS,
  TICK_RATE,
  TORCH_LIGHT_RADIUS,
  playerColor,
} from "../../../shared/constants";
import type { IslandDef } from "../../../shared/island/types";
import { isThrowable } from "../../../shared/items";
import type { MarkerMsg, MatchEndEvent, MatchStartEvent, PlayerRespawnEvent } from "../../../shared/protocol";
import { emptyInteraction, resolveInteraction, type Interaction } from "../../../shared/rules/interact";
import type { ClockInfo } from "../../../shared/rules/schedule";
import type { WorldQuery } from "../../../shared/sim/context";
import { clamp, vec3, yawFromDir, type Vec3 } from "../../../shared/sim/math";
import { chargeFraction, copyPlayerSim, eyePosition, heldKind } from "../../../shared/sim/player";
import { aimDirection, computeThrowVelocity, projectileKindForThrow, sampleTrajectoryInto, throwOrigin } from "../../../shared/sim/throw";
import type { EmoteId, InvKind, ItemKind, MarkerKind, Phase, PlayerView, RaftStateView, StructureView, Vec3Like } from "../../../shared/types";
import type { FpArmsFrame } from "../characters/Characters";
import type { Bobber } from "../fx/Fx";
import type { MonsterFrame, PlayerFrame, ProjectileFrame } from "../net/types";
import type { WorldFrame } from "../render/types";
import type { ScoreRow } from "../ui/models";
import { CameraDirector, type CameraInputs, type CameraResult } from "./cinematics";
import { Coach } from "./coach";
import { GameFeedback } from "./feedback";
import { bannerLine, type FeedbackContext, type GameModules } from "./feedbackContext";
import { FlowFeedback } from "./flow";
import {
  aimedFishSpot,
  crosshairHit,
  dist2,
  LightBuffer,
  nodeAmount,
  palmInReach,
  PingBoard,
  RaftRide,
  type PhaseTracker,
  type Pose,
} from "./frameHelpers";
import { Later, step } from "./guard";
import { settings } from "./settings";
import { Soundscape } from "./soundscape";
import {
  buildChestPanel,
  buildCraftPanel,
  buildHudModel,
  buildScoreRows,
  hudClock,
  PlayerDirectory,
  scoreSignature,
  siteOf,
  teamOf,
  type LmbHint,
} from "./viewModels";

export interface GameControllerDeps extends GameModules {
  phases: PhaseTracker;
  coach: Coach;
}

/** The input accumulator never catches up more than this much real time (no burst after a stall). */
const MAX_INPUT_BACKLOG_SEC = 0.25;
/** Landmarks become "known" (compass) once you walked this close. */
const SPRING_KNOWN_DIST = 7;
const CAVE_KNOWN_DIST = 9;
/** A craft / chest panel closes when you're this much farther than its reach. */
const PANEL_SLACK = 1.2;
/** A torch about to burn out flickers down over its last seconds. */
const TORCH_FADE_TICKS = 10 * TICK_RATE;
/** Seconds the emote / marker cooldowns last client-side (same as the server's rate limits). */
const EMOTE_COOLDOWN_MS = EMOTE_COOLDOWN_TICKS * TICK_MS;
const MARKER_COOLDOWN_MS = MARKER_COOLDOWN_TICKS * TICK_MS;

const PANEL_KINDS = new Set(["craft", "chest"]);

/** Per-match memory (reset at every matchStart and on enter / exit). */
interface MatchMemory {
  knownSpring: boolean;
  knownCave: boolean;
  /** The fire was below the low mark last frame (banner once per dip). */
  fireLow: boolean;
  stormWarnShown: boolean;
}

function freshMemory(): MatchMemory {
  return { knownSpring: false, knownCave: false, fireLow: false, stormWarnShown: false };
}

export class GameController {
  private readonly deps: GameControllerDeps;
  readonly directory: PlayerDirectory;
  private readonly later = new Later();
  private readonly pings = new PingBoard();
  private readonly ctx: FeedbackContext;
  private readonly feedback: GameFeedback;
  private readonly flow: FlowFeedback;
  private readonly director: CameraDirector;
  private readonly sound: Soundscape;
  private readonly lights = new LightBuffer();
  private readonly ride = new RaftRide();
  /** Stable callback for the soundscape (RaftRide.carry is a no-op unless the raft is sailing). */
  private readonly carryOnRide = (p: { x: number; y: number; z: number }): void => this.ride.carry(p);

  private activeFlag = false;
  /** Input sequence: one strictly increasing counter for the page lifetime (never reset). */
  private seq = 0;
  private acc = 0;
  private elapsed = 0;
  private clockMs = 0;
  private memory: MatchMemory = freshMemory();
  private matchEndEvent: MatchEndEvent | null = null;

  // Per-frame results (read by the App between frames: E presses, wheels).
  private local: PlayerFrame | null = null;
  private remotes: PlayerFrame[] = [];
  private projectiles: ProjectileFrame[] = [];
  private monsters: MonsterFrame[] = [];
  private interaction: Interaction | null = null;
  private lmb: LmbHint = null;
  private camera: CameraResult = { mode: "orbit", firstPerson: false, cinematic: true };
  private phase: Phase = "lobby";

  // Scratch objects (no allocations in the hot path where it matters).
  private readonly interactionOut = emptyInteraction();
  private readonly localView: PlayerView;
  private readonly frames: PlayerFrame[] = [];
  private readonly rideCopies = new Map<string, PlayerFrame>();
  private readonly arcPoints: Vec3[] = [];
  private readonly arcOrigin = vec3();
  private readonly arcVelocity = vec3();
  private arcShown = false;
  private readonly glowing = new Set<string>();
  private readonly glowSeen = new Set<string>();
  private readonly bobberPool: Bobber[] = [];
  private readonly bobbers: Bobber[] = [];
  private readonly eye = vec3();
  private readonly aimDir = vec3();
  private readonly listener = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  private readonly pose: Pose = { x: 0, y: 0, z: 0, yaw: 0 };
  private readonly armsFrame: FpArmsFrame = {
    character: "kaptan",
    held: "",
    count: 0,
    charge: 0,
    channel: -1,
    channelKind: 0,
    speed: 0,
    grounded: true,
    sprinting: false,
    swimming: false,
    downed: false,
    fishState: 0,
    torchLit: false,
    fuse: -1,
  };
  private readonly world: WorldFrame;
  private readonly camInputs: CameraInputs;

  // Panels / wheels / scoreboard.
  private scoreboardOpen = false;
  private scoreSig = "";
  private craftSig = "";
  private chestSig = "";
  private ping: { pos: Vec3Like; need: ItemKind | "" } | null = null;
  private lastMarkerAt = -Infinity;
  private lastEmoteAt = -Infinity;
  private lastRosterSize = -1;

  constructor(deps: GameControllerDeps) {
    this.deps = deps;
    const { net, renderer } = deps;
    this.directory = new PlayerDirectory(() => net.state);
    this.director = new CameraDirector(renderer.fp);
    this.sound = new Soundscape(deps.audio);
    this.localView = blankView();
    this.ctx = this.feedbackContext();
    this.feedback = new GameFeedback(this.ctx);
    this.flow = new FlowFeedback(this.ctx);
    this.world = {
      phase: "lobby",
      clockTicks: 0,
      timings: net.timings,
      weather: "clear",
      biome: "tropic",
      nodes: [],
      teams: [],
      structures: [],
      lights: this.lights.list,
      focus: { x: 0, y: 0, z: 0 },
      launch: 0,
      storm: 0,
      secretShown: [],
      reducedFlashing: false,
    };
    this.camInputs = {
      phase: "lobby",
      state: null,
      me: null,
      local: null,
      look: { yaw: 0, pitch: 0 },
      island: null,
      timings: net.timings,
      raft: null,
      fov: settings.get().fov,
      headBob: settings.get().headBob,
      realDt: 0,
      nowMs: 0,
    };
    // Flow listeners stay subscribed for the controller's lifetime: matchStart arrives while the lobby is still
    // up (the patch with phase "landing" comes after it), so it must be able to enter the game view by itself.
    // These two come first so the view is active before the banner / feed handlers run.
    net.events.on("matchStart", (e) => this.onMatchStart(e));
    net.events.on("matchEnd", (e) => this.onMatchEnd(e));
    net.events.on("playerRespawn", (e) => this.onRespawn(e));
    net.events.on("state", () => this.onRoster());
    this.flow.attach();
    renderer.onLightning = (strength, distance) => this.onLightning(strength, distance);
  }

  /* ============================================================ lifecycle */

  get active(): boolean {
    return this.activeFlag;
  }

  /** Enter the game view (idempotent): subscribe the gameplay feedback, keep the server look on a reconnect. */
  enter(): void {
    if (this.activeFlag) return;
    this.activeFlag = true;
    this.acc = 0;
    this.feedback.attach();
    const { net, input } = this.deps;
    const island = net.island;
    if (island) this.showIsland(island);
    const me = net.me;
    if (me && me.alive && !me.spectator && !me.washed) input.setLook(me.yaw, me.pitch);
    const state = net.state;
    if (state) this.directory.rememberAll(state);
  }

  /** Leave the game view (idempotent): unsubscribe, stop loops, clear fx / characters / panels. */
  exit(): void {
    if (!this.activeFlag) return;
    this.activeFlag = false;
    const { characters, fx, input, ui } = this.deps;
    this.feedback.detach();
    this.feedback.reset();
    this.later.cancelAll();
    this.sound.stopLoops();
    fx.setArc(null, "#FFFFFF");
    this.arcShown = false;
    fx.setBobbers([]);
    for (const id of this.glowing) fx.setChargeGlow(id, null, 0, "#FFFFFF");
    this.glowing.clear();
    fx.clear();
    characters.clear();
    characters.monsters.clear();
    characters.fpArms.setVisible(false);
    if (ui.panel && ui.panel !== "settings") ui.openPanel(null);
    this.closeScoreboard();
    this.pings.clear();
    this.ride.reset();
    this.rideCopies.clear();
    this.ping = null;
    this.local = null;
    this.interaction = null;
    this.memory = freshMemory();
    input.clearLatches();
    this.acc = 0;
  }

  /** The latest MatchEndEvent of this match (null before / after). */
  get matchEnd(): MatchEndEvent | null {
    return this.matchEndEvent;
  }

  /**
   * Playing in first person: the app wants pointer lock + gameplay input. Never while Net reconnects (the world is
   * frozen) or the WebGL context is lost (the reload card is up): the mouse goes back to the player meanwhile and
   * the "click to play" veil asks for it again afterwards.
   */
  get wantsPointer(): boolean {
    if (!this.activeFlag) return false;
    const { net, renderer } = this.deps;
    if (net.status !== "connected" || renderer.contextLost) return false;
    const me = net.me;
    const mode = this.camera.mode;
    return !!me && me.alive && !me.washed && !me.spectator && (mode === "fp" || mode === "wake") && (this.phase === "landing" || this.phase === "playing");
  }

  /** The music the game view wants re-sent (after the audio unlocked). */
  refreshAudio(): void {
    this.sound.refresh();
  }

  /** Menu screens: keep the music / ambience going without the game view. */
  menuSound(dt: number): void {
    const cam = this.deps.renderer.camera;
    cam.getWorldPosition(this.listener);
    cam.getWorldDirection(this.forward);
    this.sound.menu(this.listener, this.forward, dt);
  }

  /* ============================================================== frame */

  /** One render frame (docs/ARCHITECTURE.md §6.1). */
  frame(nowMs: number, realDt: number): void {
    if (!this.activeFlag) return;
    this.clockMs = nowMs;
    const dt = Math.max(0, Math.min(realDt, 0.1));
    this.elapsed += dt;
    this.later.update(nowMs);
    const { net } = this.deps;
    // 1. Fixed-step input.
    let alpha = 0;
    step("input", () => {
      alpha = this.stepInput(realDt);
    });
    // 2. Net.
    step("net", () => net.update(nowMs, realDt));
    const state = net.state;
    if (!state) {
      // Reconnecting with no state: keep the last picture.
      step("render", () => this.deps.renderer.render());
      return;
    }
    this.phase = this.deps.phases.effective(state);
    // 3. Frames + this frame's camera plan.
    step("frames", () => this.pullFrames(nowMs, alpha));
    step("plan", () => {
      this.fillCameraInputs(state, nowMs, realDt);
      this.camera = this.director.plan(this.camInputs);
    });
    // 4. Interaction (prompt, panels), landmark knowledge, coach.
    step("interaction", () => this.resolveLocalInteraction(state));
    step("panels", () => this.keepPanels());
    step("memory", () => this.watchMatch(state, nowMs));
    // 5. World, characters, monsters, FP arms.
    step("world", () => this.updateWorld(state, nowMs, dt));
    step("characters", () => this.syncCharacters(dt));
    step("monsters", () => this.deps.characters.monsters.sync(this.monsters, dt));
    step("arms", () => this.updateArms(dt));
    // 6. Fx: projectiles, arc preview, bobbers.
    step("projectiles", () => this.deps.fx.syncProjectiles(this.projectiles, dt));
    step("arc", () => this.updateArc());
    step("glows", () => this.updateChargeGlows());
    step("bobbers", () => this.updateBobbers());
    step("fx", () => this.deps.fx.update(dt));
    // 7. Camera.
    step("camera", () => this.director.shoot(this.camInputs));
    // 8. Audio.
    step("audio", () => this.updateAudio(state, nowMs, dt));
    // 9. Render, HUD, panels, scoreboard.
    step("render", () => this.deps.renderer.render());
    step("hud", () => this.updateHud(state, nowMs));
    step("panelModels", () => this.updatePanelModels(state));
    step("scoreboard", () => this.updateScoreboard(state));
  }

  /** Step 1: fixed 30 Hz sampling; returns the interpolation alpha for the predicted player. */
  private stepInput(realDt: number): number {
    const { input, net } = this.deps;
    if (!net.wantsInput) {
      this.acc = 0;
      input.clearLatches();
      return 0;
    }
    this.acc += Math.min(Math.max(0, realDt), MAX_INPUT_BACKLOG_SEC);
    while (this.acc >= DT) {
      net.sendInput(input.sample(++this.seq));
      this.acc -= DT;
    }
    return this.acc / DT;
  }

  /** Step 3: local (predicted) / remote (interpolated) players, projectiles, monsters. */
  private pullFrames(nowMs: number, alpha: number): void {
    const { input, net } = this.deps;
    this.local = net.getLocalPlayer(alpha, input.look) ?? null;
    this.remotes = net.getRemotePlayers(nowMs) ?? [];
    this.projectiles = net.getProjectiles() ?? [];
    this.monsters = net.getMonsters(nowMs) ?? [];
  }

  private fillCameraInputs(state: RaftStateView, nowMs: number, realDt: number): void {
    const { input, net, renderer } = this.deps;
    const c = this.camInputs;
    const me = net.me;
    c.phase = this.phase;
    c.state = state;
    c.me = me;
    c.local = this.local;
    c.look.yaw = input.yaw;
    c.look.pitch = input.pitch;
    // Spectator camera: free look drained every frame (used only while spectating), teammates to follow.
    c.freeLook = input.takeFreeLook();
    c.remotes = this.remotes;
    c.island = net.island;
    c.timings = net.timings;
    c.raft = renderer.raftPose(me?.team ?? 0, this.pose) ? this.pose : null;
    const s = settings.get();
    c.fov = s.fov;
    c.headBob = s.headBob;
    c.realDt = realDt;
    c.nowMs = nowMs;
  }

  /* ======================================================== interaction */

  /** Step 4: what E / LMB would do (state's player with the predicted position and look). */
  private resolveLocalInteraction(state: RaftStateView): void {
    const { net } = this.deps;
    const me = net.me;
    const island = net.island;
    const local = this.local;
    this.interaction = null;
    this.lmb = null;
    if (!me || !island || !local || !me.alive || me.washed || me.spectator) return;
    if (this.phase !== "landing" && this.phase !== "playing") return;
    const view = toLocalView(me, local, this.localView);
    this.interaction = resolveInteraction({ island, state }, view, this.interactionOut);
    this.lmb = this.lmbHint(island, state, me, local);
  }

  /** What LMB would do (strike a bite > cast at a spot > shake a palm), for the prompt. */
  private lmbHint(island: IslandDef, state: RaftStateView, me: PlayerView, local: PlayerFrame): LmbHint {
    if (me.downed || me.boarded) return null;
    if (me.fishState === FISH_STATE.BITE) return "strike";
    const held = heldKind(local);
    if (held === "rod" && me.fishState === FISH_STATE.NONE) {
      eyePosition(local, this.eye);
      aimDirection(local.yaw, local.pitch, this.aimDir);
      if (aimedFishSpot(island, this.eye, this.aimDir) >= 0) return "cast";
      return null;
    }
    if (held !== "" && isThrowable(held)) return null;
    const palm = palmInReach(island, local.x, local.z, local.yaw);
    return palm && nodeAmount(island, state.nodes, palm.i) > 0 ? "palm" : null;
  }

  /** Input "interact" (E down): the craft / chest panels open on the client. */
  onInteractKey(): void {
    if (!this.activeFlag) return;
    const it = this.interaction;
    if (!it || (it.kind !== "craft" && it.kind !== "chest")) return;
    const { audio, input, ui } = this.deps;
    ui.openPanel(it.kind);
    input.setCapture("panel");
    this.craftSig = "";
    this.chestSig = "";
    audio.play(it.kind === "chest" ? "chestOpen" : "uiOpen");
    const state = this.deps.net.state;
    if (state) this.updatePanelModels(state);
  }

  /** Input "panelKey" (E with a panel open): close it. */
  onPanelKey(): void {
    const { ui } = this.deps;
    if (ui.panel === "craft" || ui.panel === "chest") this.closePanel(true);
  }

  /** Close the craft / chest panel (walked away, downed, E). `gesture`: we may re-lock the pointer now. */
  private closePanel(gesture: boolean): void {
    const { audio, input, ui } = this.deps;
    const was = ui.panel;
    if (was !== "craft" && was !== "chest") return;
    ui.openPanel(null);
    ui.setCraftPanel(null);
    ui.setChestPanel(null);
    input.setCapture("none");
    audio.play(was === "chest" ? "chestClose" : "uiClose");
    if (gesture) input.requestPointerLock();
  }

  /** Step 4b: a craft / chest panel closes when you walk away, go down or the match moves on. */
  private keepPanels(): void {
    const { net, ui } = this.deps;
    const panel = ui.panel;
    if (panel !== "craft" && panel !== "chest") return;
    const me = net.me;
    const local = this.local;
    const site = siteOf(net.island, me?.team ?? 0);
    const playing = this.phase === "landing" || this.phase === "playing";
    let keep = !!me && !!local && !!site && playing && me.alive && !me.downed && !me.washed && !me.boarded;
    if (keep && site && local) {
      const at = panel === "craft" ? site.campfire : site.chest;
      const reach = (panel === "craft" ? CRAFT_RANGE : CHEST_RANGE) + PANEL_SLACK;
      keep = dist2(at, local.x, local.z) <= reach;
    }
    if (!keep) this.closePanel(false);
  }

  /* =========================================================== the world */

  /** Per-match bookkeeping: landmark knowledge, fire-low banner, storm build-up memory, coach. */
  private watchMatch(state: RaftStateView, nowMs: number): void {
    const { net } = this.deps;
    const me = net.me;
    const local = this.local;
    const site = siteOf(net.island, me?.team ?? 0);
    const m = this.memory;
    if (site && local && me && me.alive) {
      if (!m.knownSpring && dist2(site.spring, local.x, local.z) <= SPRING_KNOWN_DIST) m.knownSpring = true;
      if (!m.knownCave && site.cave && dist2(site.cave, local.x, local.z) <= CAVE_KNOWN_DIST) m.knownCave = true;
    }
    const team = me ? teamOf(state, me.team) : null;
    if (team && this.phase === "playing") {
      const low = team.fireFuel > 0 && team.fireFuel < FIRE_LOW_FRACTION * FIRE_START_FUEL_TICKS;
      if (low && !m.fireLow) {
        bannerLine(this.ctx, "fireLow", "warn", { sub: "fireLowSub" });
        this.deps.audio.play("fireLow");
      }
      m.fireLow = low;
    }
    if (me && (this.phase === "playing" || this.phase === "landing")) {
      const clock = hudClock(this.phase, state, net.timings, net.clockTicksAt(nowMs));
      this.deps.coach.update({
        phase: this.phase,
        day: clock.day,
        dayPhase: clock.dayPhase,
        phaseFrac: clock.phaseLength > 0 ? clock.phaseElapsed / clock.phaseLength : 0,
        state,
        me,
        interaction: this.interaction,
        lookingAtPalm: this.lmb === "palm",
        nowMs,
      });
    }
  }

  /** Step 5a: the WorldFrame for the renderer. */
  private updateWorld(state: RaftStateView, nowMs: number, dt: number): void {
    const { net, renderer } = this.deps;
    const w = this.world;
    const timings = net.timings;
    w.phase = this.phase;
    w.clockTicks = net.clockTicksAt(nowMs);
    w.timings = timings;
    w.weather = state.weather;
    w.biome = state.biome;
    w.nodes = state.nodes;
    w.teams = state.teams;
    w.structures = structureList(state);
    this.fillLights();
    w.lights = this.lights.list;
    const focus = this.local ?? net.me;
    if (focus) eyePosition(focus, w.focus);
    const serverTick = net.serverTickAt(nowMs);
    const phaseLeft = Math.max(0, state.phaseTicksLeft - Math.max(0, serverTick - state.tick));
    w.launch = this.phase === "launch" ? clamp(1 - phaseLeft / Math.max(1, timings.launch), 0, 1) : this.phase === "matchEnd" && state.winReason === "launched" ? 1 : 0;
    w.storm = this.stormBuild(state, phaseLeft, nowMs);
    w.secretShown.length = 0;
    state.teams.forEach((t) => w.secretShown.push(t.secretRevealed));
    w.reducedFlashing = settings.get().reducedFlashing;
    renderer.update(dt, this.elapsed, w);
    // The raft ride: where the raft rests vs. where it sails (boarded players come along).
    if (renderer.raftPose(net.me?.team ?? 0, this.pose)) {
      if (this.phase === "launch" || (this.phase === "matchEnd" && state.winReason === "launched")) this.ride.setCurrent(this.pose);
      else this.ride.setRest(this.pose);
    }
  }

  /** WorldFrame.storm: the last 30 s of night 3 build up to 0.4, the storm phase runs 0.4 → 1. */
  private stormBuild(state: RaftStateView, phaseLeft: number, nowMs: number): number {
    const { net } = this.deps;
    const timings = net.timings;
    if (this.phase === "storm") return 0.4 + 0.6 * clamp(1 - phaseLeft / Math.max(1, timings.storm), 0, 1);
    if (this.phase === "matchEnd") return state.winReason === "storm" ? 1 : 0;
    if (this.phase !== "playing") return 0;
    const clock = hudClock(this.phase, state, timings, net.clockTicksAt(nowMs));
    const warn = STORM_WARN_SEC * TICK_RATE;
    if (clock.day < DAYS || clock.dayPhase !== "night" || clock.stormLeft > warn) return 0;
    return 0.4 * clamp(1 - clock.stormLeft / warn, 0, 1);
  }

  /** Lit torches in hands (planted torches are structures the renderer lights itself). */
  private fillLights(): void {
    const lights = this.lights;
    lights.reset();
    const add = (p: PlayerFrame): void => {
      if (!p.alive || p.washed || p.spectator || heldKind(p) !== "torch" || p.torchTicks <= 0) return;
      throwOrigin(p, this.eye);
      const fade = p.torchTicks < TORCH_FADE_TICKS ? 0.45 + 0.55 * (p.torchTicks / TORCH_FADE_TICKS) : 1;
      lights.add(this.eye.x, this.eye.y + 0.25, this.eye.z, TORCH_LIGHT_RADIUS, fade);
    };
    if (this.local) add(this.local);
    for (const r of this.remotes) add(r);
  }

  /** Step 5b: avatars (the local body only when the camera isn't first person). */
  private syncCharacters(dt: number): void {
    const { characters, net, renderer } = this.deps;
    const frames = this.frames;
    frames.length = 0;
    const riding = this.ride.active;
    const push = (f: PlayerFrame): void => {
      if (!f.alive || f.washed || f.spectator) return;
      if (riding && f.boarded) {
        let copy = this.rideCopies.get(f.id);
        if (!copy) this.rideCopies.set(f.id, (copy = { ...f }));
        else Object.assign(copy, f);
        this.ride.carry(copy);
        frames.push(copy);
        return;
      }
      frames.push(f);
    };
    for (const r of this.remotes) push(r);
    if (this.local) push(this.local);
    characters.sync(frames, { localId: net.sessionId, firstPerson: this.camera.firstPerson, dark: renderer.darkness }, dt);
  }

  /** Step 5c: first-person arms (hidden outside first person). */
  private updateArms(dt: number): void {
    const { characters, net, renderer } = this.deps;
    const local = this.local;
    const me = net.me;
    const visible = this.camera.firstPerson && !!local && !!me && local.alive && !local.washed && !local.spectator;
    characters.fpArms.setVisible(visible);
    if (!visible || !local || !me) return;
    const a = this.armsFrame;
    a.character = me.character;
    a.held = heldKind(local);
    a.count = slotCountOf(me, local.activeSlot);
    a.charge = chargeFraction(local);
    a.channel = channelFrac(local, this.interaction);
    a.channelKind = local.channel;
    a.speed = local.speed;
    a.grounded = local.grounded;
    a.sprinting = local.sprinting;
    a.swimming = local.swimming;
    a.downed = local.downed;
    a.fishState = me.fishState;
    a.torchLit = a.held === "torch" && me.torchTicks > 0;
    a.fuse = a.held === "puffer" && me.fuseTicks > 0 ? clamp(me.fuseTicks / PUFFER_FUSE_TICKS, 0, 1) : -1;
    characters.fpArms.update(dt, renderer.camera, a);
  }

  /** Step 6b: the dotted arc after half charge (settings.showArcPreview). */
  private updateArc(): void {
    const { fx, net } = this.deps;
    const local = this.local;
    const island = net.island;
    const cover = net.cover;
    const me = net.me;
    const charge = local ? chargeFraction(local) : 0;
    const held: InvKind = local ? heldKind(local) : "";
    const show =
      !!local && !!island && !!cover && !!me && this.camera.mode === "fp" && settings.get().showArcPreview && charge >= ARC_PREVIEW_MIN_CHARGE && held !== "" && isThrowable(held);
    if (!show || !local || !island || !cover || !me) {
      if (this.arcShown) fx.setArc(null, "#FFFFFF");
      this.arcShown = false;
      return;
    }
    const q: WorldQuery = { terrain: island.grid, cover, bounds: island.bounds };
    throwOrigin(local, this.arcOrigin);
    computeThrowVelocity(charge, local.yaw, local.pitch, this.arcVelocity);
    const points = sampleTrajectoryInto(q, this.arcOrigin, this.arcVelocity, { kind: projectileKindForThrow(held), maxPoints: ARC_PREVIEW_MAX_POINTS, fraction: ARC_PREVIEW_FRACTION }, this.arcPoints);
    fx.setArc(points, playerColor(me.seat));
    this.arcShown = true;
  }

  /** Step 6b': a glow at the hand of everyone charging a throw (the telegraph Bonk Brawl players rely on). */
  private updateChargeGlows(): void {
    const { fx } = this.deps;
    const seen = this.glowSeen;
    seen.clear();
    const glow = (p: PlayerFrame): void => {
      if (!p.alive || p.washed || p.chargeTicks <= 0) return;
      throwOrigin(p, this.eye);
      fx.setChargeGlow(p.id, this.eye, chargeFraction(p), playerColor(p.seat));
      seen.add(p.id);
    };
    if (this.local && this.camera.mode !== "fp") glow(this.local);
    for (const r of this.remotes) glow(r);
    for (const id of this.glowing) if (!seen.has(id)) fx.setChargeGlow(id, null, 0, "#FFFFFF");
    this.glowing.clear();
    for (const id of seen) this.glowing.add(id);
  }

  /** Step 6c: fishing lines from each fisher's hand to the bobber of their last cast. */
  private updateBobbers(): void {
    const { characters, fx } = this.deps;
    const list = this.bobbers;
    list.length = 0;
    const add = (p: PlayerFrame, isLocal: boolean): void => {
      if (p.fishState === FISH_STATE.NONE || !p.alive) return;
      const at = this.feedback.bobberOf(p.id);
      if (!at) return;
      let b = this.bobberPool[list.length];
      if (!b) {
        b = { playerId: "", from: { x: 0, y: 0, z: 0 }, pos: { x: 0, y: 0, z: 0 }, biting: false };
        this.bobberPool[list.length] = b;
      }
      b.playerId = p.id;
      const hand = isLocal ? characters.fpArms.handPosition(b.from) : characters.handPosition(p.id, b.from);
      if (!hand) {
        throwOrigin(p, this.eye);
        b.from.x = this.eye.x;
        b.from.y = this.eye.y + 0.2;
        b.from.z = this.eye.z;
      }
      b.pos.x = at.x;
      b.pos.y = at.y;
      b.pos.z = at.z;
      b.biting = p.fishState === FISH_STATE.BITE;
      list.push(b);
    };
    if (this.local) add(this.local, true);
    for (const r of this.remotes) add(r, false);
    fx.setBobbers(list);
  }

  /* ================================================================ audio */

  private updateAudio(state: RaftStateView, nowMs: number, dt: number): void {
    const { net, renderer } = this.deps;
    const cam = renderer.camera;
    cam.getWorldPosition(this.listener);
    cam.getWorldDirection(this.forward);
    const end = this.matchEndEvent;
    const myTeam = net.me?.team ?? 0;
    this.sound.update({
      phase: this.phase,
      state,
      me: net.me,
      local: this.local,
      remotes: this.remotes,
      monsters: this.monsters,
      island: net.island,
      clock: this.clock(state, nowMs),
      timings: net.timings,
      storm: this.world.storm,
      underwater: renderer.isUnderwater,
      listener: this.listener,
      forward: this.forward,
      win: this.phase === "matchEnd" ? (end ? end.winnerTeam >= 0 && end.winnerTeam === myTeam : state.winnerTeam >= 0 && state.winnerTeam === myTeam) : null,
      channelProgress: this.local ? Math.max(0, channelFrac(this.local, this.interaction)) : 0,
      carry: this.carryOnRide,
      dt,
    });
  }

  private clock(state: RaftStateView, nowMs: number): ClockInfo {
    return hudClock(this.phase, state, this.deps.net.timings, this.deps.net.clockTicksAt(nowMs));
  }

  /** Lightning (storm / rain): thunder after a distance delay + a shake. */
  private onLightning(strength: number, distance: number): void {
    if (!this.activeFlag) return;
    const { audio, renderer } = this.deps;
    const delayMs = Math.min(2500, Math.max(0, distance) * 3);
    this.later.run(delayMs, "thunder", () => {
      audio.play("thunder", { volume: 0.5 + strength * 0.7 });
      renderer.fp.shake(0.15 + strength * 0.35);
      this.feedback.thunder(strength);
    });
  }

  /* =================================================================== UI */

  private updateHud(state: RaftStateView, nowMs: number): void {
    if (this.phase === "matchEnd" || this.phase === "lobby") return;
    const { input, net, ui } = this.deps;
    const me = net.me;
    const local = this.local;
    const s = settings.get();
    const needsPointer = this.wantsPointer && input.capture === "none" && !input.pointerLocked && !this.camera.cinematic;
    ui.updateHud(
      buildHudModel({
        state,
        phase: this.phase,
        island: net.island,
        me,
        sim: net.localSim ?? local ?? me,
        origin: local ? { x: local.x, z: local.z, yaw: local.yaw } : null,
        timings: net.timings,
        clockTicks: net.clockTicksAt(nowMs),
        serverTick: net.serverTickAt(nowMs),
        interaction: this.interaction,
        lmb: this.lmb,
        fishBite: this.feedback.myBite,
        willRespawn: this.feedback.willRespawn,
        pings: this.pings.active(nowMs),
        known: { spring: this.memory.knownSpring, cave: this.memory.knownCave },
        monsters: this.monsters,
        cinematic: this.camera.cinematic,
        needsPointer,
        reducedFlashing: s.reducedFlashing,
      }),
    );
  }

  /** Feed the open craft / chest panel (rebuilt only when what it shows changed). */
  private updatePanelModels(state: RaftStateView): void {
    const { net, ui } = this.deps;
    const panel = ui.panel;
    const me = net.me;
    if (panel === "craft") {
      const sig = panelSignature(state, me) + `|${(teamOf(state, me?.team ?? 0)?.fireFuel ?? 0) > 0 ? 1 : 0}|${Math.round((teamOf(state, me?.team ?? 0)?.fireFuel ?? 0) / TICK_RATE)}`;
      if (sig !== this.craftSig) {
        this.craftSig = sig;
        ui.setCraftPanel(buildCraftPanel(state, me));
      }
    } else if (panel === "chest") {
      // The predicted held slot (shown as "in hand"): every chest put names its pocket, so the server's own held
      // slot doesn't matter to the panel.
      const active = this.local?.activeSlot ?? me?.activeSlot ?? 0;
      const sig = panelSignature(state, me) + `|${active}`;
      if (sig !== this.chestSig) {
        this.chestSig = sig;
        ui.setChestPanel(buildChestPanel(state, me, active));
      }
    }
  }

  /** Tab held / released (Input "scoreboard"). */
  setScoreboardOpen(open: boolean): void {
    if (open === this.scoreboardOpen) return;
    this.scoreboardOpen = open;
    this.scoreSig = "";
    if (!open) this.deps.ui.setScoreboard(null);
    else if (this.deps.net.state) this.updateScoreboard(this.deps.net.state);
  }

  private closeScoreboard(): void {
    if (!this.scoreboardOpen) return;
    this.scoreboardOpen = false;
    this.deps.ui.setScoreboard(null);
  }

  private updateScoreboard(state: RaftStateView): void {
    if (!this.scoreboardOpen) return;
    const sig = scoreSignature(state);
    if (sig === this.scoreSig) return;
    this.scoreSig = sig;
    const rows: ScoreRow[] = buildScoreRows(state, this.deps.net.sessionId);
    this.deps.ui.setScoreboard(rows);
  }

  /* ========================================================== ping wheel */

  /**
   * V / middle click: open the ping wheel. The crosshair hit and the "need" item (what the interaction you look
   * at yields; a palm = coconuts) are captured now, while the camera still looks at it.
   */
  openPingWheel(): boolean {
    if (!this.activeFlag || !this.wantsPointer) return false;
    const { net, ui, input } = this.deps;
    const local = this.local;
    const island = net.island;
    if (!local || !island) return false;
    eyePosition(local, this.eye);
    aimDirection(local.yaw, local.pitch, this.aimDir);
    const pos = { x: 0, y: 0, z: 0 };
    crosshairHit(island, this.eye, this.aimDir, pos);
    this.ping = { pos, need: this.needItem() };
    ui.openPanel("pingWheel");
    input.setCapture("full");
    this.deps.audio.play("uiOpen", { volume: 0.6 });
    return true;
  }

  /** What "Need this" asks for: the item of the interaction you look at. */
  private needItem(): ItemKind | "" {
    const it = this.interaction;
    if (it && it.item && it.item !== "berry") return it.item;
    if (it?.kind === "deliver" || it?.kind === "craft") return "wood";
    if (this.lmb === "palm") return "coconut";
    if (this.lmb === "cast") return "fish_raw";
    return "";
  }

  /** A slice was picked (UI click or 1–4): send the marker once. */
  sendMarker(kind: MarkerKind): void {
    const ping = this.ping;
    this.ping = null;
    if (!ping || !this.activeFlag) return;
    const now = this.clockMs;
    if (now - this.lastMarkerAt < MARKER_COOLDOWN_MS) return;
    this.lastMarkerAt = now;
    const msg: MarkerMsg = { kind, pos: ping.pos, need: kind === "need" ? ping.need : "" };
    this.deps.net.send("marker", msg);
  }

  /** wheelPick from the keyboard while a wheel is open. */
  pickWheel(index: number): boolean {
    const panel = this.deps.ui.panel;
    if (panel === "pingWheel") {
      const kind = MARKER_KINDS[index];
      if (!kind) return false;
      this.sendMarker(kind);
      return true;
    }
    if (panel === "emoteWheel") {
      const emote = EMOTE_IDS[index];
      if (!emote) return false;
      this.sendEmote(emote);
      return true;
    }
    return false;
  }

  /** The ping wheel closed without a pick. */
  cancelPing(): void {
    this.ping = null;
  }

  /** Send an emote (rate-limited like the server; only for castaways in the match). */
  sendEmote(emote: EmoteId): void {
    const { net } = this.deps;
    const me = net.me;
    if (!me || me.spectator || !me.alive || me.washed) return;
    const now = this.clockMs;
    if (now - this.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
    this.lastEmoteAt = now;
    net.send("emote", { emote });
  }

  /* ========================================================== match flow */

  private onMatchStart(ev: MatchStartEvent): void {
    this.deps.phases.announce("landing", ev.tick);
    this.enter();
    const { characters, coach, fx, input, net } = this.deps;
    this.memory = freshMemory();
    this.matchEndEvent = null;
    this.feedback.reset();
    this.pings.clear();
    this.later.cancelAll();
    this.ride.reset();
    this.rideCopies.clear();
    this.ping = null;
    fx.clear();
    characters.clear();
    characters.monsters.clear();
    coach.matchStarted(this.clockMs);
    this.director.matchStarted();
    const island = net.island;
    if (island) this.showIsland(island);
    // Wake up facing the camp (the server takes the look from our inputs).
    const me = net.me;
    const site = siteOf(island, me?.team ?? 0);
    if (site && me) {
      const spawn = site.spawns[me.seat % Math.max(1, site.spawns.length)] ?? site.wreck;
      input.setLook(yawFromDir(site.campfire.x - spawn.x, site.campfire.z - spawn.z), 0);
    }
    if (net.state) this.directory.rememberAll(net.state);
  }

  private onMatchEnd(ev: MatchEndEvent): void {
    this.deps.phases.announce("matchEnd", ev.tick);
    this.matchEndEvent = ev;
    const { ui } = this.deps;
    if (ui.panel && ui.panel !== "settings") ui.openPanel(null);
    this.deps.input.setCapture("none");
    this.closeScoreboard();
  }

  private onRespawn(ev: PlayerRespawnEvent): void {
    if (!this.activeFlag || ev.playerId !== this.deps.net.sessionId) return;
    const site = siteOf(this.deps.net.island, this.deps.net.me?.team ?? 0);
    if (site) this.deps.input.setLook(yawFromDir(site.campfire.x - ev.pos.x, site.campfire.z - ev.pos.z), 0);
  }

  /** Remember names / characters for feed lines about players who leave later. */
  private onRoster(): void {
    const state = this.deps.net.state;
    if (state && state.players.size !== this.lastRosterSize) {
      this.lastRosterSize = state.players.size;
      this.directory.rememberAll(state);
    }
  }

  /* ============================================================ helpers */

  /** The island to show: the scene, the fx ground and the island's own tune (all no-ops when unchanged). */
  private showIsland(def: IslandDef): void {
    this.deps.renderer.loadIsland(def);
    this.deps.fx.setIsland(def);
    this.deps.audio.setMusicSeed(def.seed);
  }

  private feedbackContext(): FeedbackContext {
    const self = this;
    const d = this.deps;
    return {
      net: d.net,
      input: d.input,
      renderer: d.renderer,
      characters: d.characters,
      fx: d.fx,
      audio: d.audio,
      ui: d.ui,
      get dir() {
        return self.directory;
      },
      get later() {
        return self.later;
      },
      get pings() {
        return self.pings;
      },
      coach: d.coach,
      get localId() {
        return d.net.sessionId;
      },
      get nowMs() {
        return self.clockMs;
      },
      position: (id, out) => self.playerPosition(id, out),
    };
  }

  /** Rendered feet position of a player, falling back to its state position. */
  private playerPosition(id: string, out: Vec3Like): boolean {
    const local = this.local;
    if (local && local.id === id) return copyXYZ(local, out);
    for (const r of this.remotes) if (r.id === id) return copyXYZ(r, out);
    const view = this.directory.view(id);
    return view ? copyXYZ(view, out) : false;
  }
}

/* =================================================================== helpers */

function copyXYZ(src: { x: number; y: number; z: number }, out: Vec3Like): boolean {
  out.x = src.x;
  out.y = src.y;
  out.z = src.z;
  return true;
}

function structureList(state: RaftStateView): StructureView[] {
  const out: StructureView[] = [];
  state.structures.forEach((s) => out.push(s));
  return out;
}

function slotCountOf(me: PlayerView, slot: number): number {
  return slot === 0 ? me.cnt0 : slot === 1 ? me.cnt1 : slot === 2 ? me.cnt2 : slot === 3 ? me.cnt3 : 0;
}

/** 0..1 of the running channel (gather / revive), -1 when none. */
function channelFrac(local: PlayerFrame, it: Interaction | null): number {
  if (local.channel === 0) return -1;
  const need = it && it.hold && it.channel === local.channel && it.ticks > 0 ? it.ticks : 0;
  return need > 0 ? clamp(local.channelTicks / need, 0, 1) : 0;
}

/** What the craft / chest panels show (inventory + chest + alive). */
function panelSignature(state: RaftStateView, me: PlayerView | null): string {
  const team = teamOf(state, me?.team ?? 0);
  let sig = me ? `${me.inv0}${me.cnt0},${me.inv1}${me.cnt1},${me.inv2}${me.cnt2},${me.inv3}${me.cnt3},${me.alive && !me.downed ? 1 : 0}` : "-";
  if (team) {
    sig += `|${team.ballRecipe ? 1 : 0}|`;
    team.chest.forEach((n, k) => {
      sig += `${k}${n},`;
    });
  }
  return sig;
}

/** A blank PlayerView the local interaction view is copied into. */
function blankView(): PlayerView {
  return {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    yaw: 0,
    pitch: 0,
    grounded: true,
    airTicks: 0,
    stunTicks: 0,
    chargeTicks: 0,
    throwTicks: 0,
    catchTicks: 0,
    catchCooldown: 0,
    channel: 0,
    channelTicks: 0,
    channelTarget: -1,
    swimming: false,
    swimTicks: 0,
    sprinting: false,
    activeSlot: 0,
    inv0: "",
    inv1: "",
    inv2: "",
    inv3: "",
    hp: 0,
    hunger: 0,
    thirst: 0,
    warmth: 0,
    alive: false,
    downed: false,
    boarded: false,
    id: "",
    nickname: "",
    character: "kaptan",
    seat: 0,
    team: 0,
    bot: false,
    botRole: "",
    ready: false,
    connected: true,
    spectator: false,
    ping: 0,
    lastSeq: 0,
    cnt0: 0,
    cnt1: 0,
    cnt2: 0,
    cnt3: 0,
    downedTicks: 0,
    washed: false,
    fishState: 0,
    fishSpot: -1,
    fuseTicks: 0,
    torchTicks: 0,
    cosmetic: "",
    golden: false,
    score: 0,
    stats: { gathered: 0, delivered: 0, hits: 0, kills: 0, revives: 0, fish: 0, eaten: 0, coconuts: 0, downs: 0, crafted: 0, raids: 0 },
  };
}

/**
 * The state's player with the predicted position / look / slot (what resolveInteraction should see). Fields are
 * copied one by one: decoded schema objects keep their values behind accessors, so spreading them is not safe.
 */
export function toLocalView(me: PlayerView, local: PlayerFrame | null, out: PlayerView): PlayerView {
  copyPlayerSim(me, out);
  out.id = me.id;
  out.nickname = me.nickname;
  out.character = me.character;
  out.seat = me.seat;
  out.team = me.team;
  out.bot = me.bot;
  out.botRole = me.botRole;
  out.ready = me.ready;
  out.connected = me.connected;
  out.spectator = me.spectator;
  out.ping = me.ping;
  out.lastSeq = me.lastSeq;
  out.cnt0 = me.cnt0;
  out.cnt1 = me.cnt1;
  out.cnt2 = me.cnt2;
  out.cnt3 = me.cnt3;
  out.downedTicks = me.downedTicks;
  out.washed = me.washed;
  out.fishState = me.fishState;
  out.fishSpot = me.fishSpot;
  out.fuseTicks = me.fuseTicks;
  out.torchTicks = me.torchTicks;
  out.cosmetic = me.cosmetic;
  out.golden = me.golden;
  out.score = me.score;
  out.stats = me.stats;
  if (local) {
    out.x = local.x;
    out.y = local.y;
    out.z = local.z;
    out.yaw = local.yaw;
    out.pitch = local.pitch;
    out.activeSlot = local.activeSlot;
  }
  return out;
}
