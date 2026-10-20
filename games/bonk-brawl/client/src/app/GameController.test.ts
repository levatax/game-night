// GameController + GameFeedback behavior against fake dependencies (node environment, no WebGL).
// Owner: client-app.  Run: npx vitest run games/bonk-brawl/client/src/app

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { DT, ROUND_END_CARD_TICKS, TICK_MS } from "../../../shared/constants";
import { getArena } from "../../../shared/maps";
import type { InputCmd, RoundStartEvent } from "../../../shared/protocol";
import { createPlayerSim } from "../../../shared/sim/player";
import type { BonkStateView, MapId, PlayerView } from "../../../shared/types";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Characters } from "../characters/Characters";
import type { Fx } from "../fx/Fx";
import type { Input } from "../input/Input";
import type { Net } from "../net/Net";
import type { BallFrame, NetEventMap, PlayerFrame } from "../net/types";
import type { CameraRig, CameraUpdate } from "../render/CameraRig";
import type { Renderer } from "../render/Renderer";
import type { HudModel, KillFeedEntry } from "../ui/models";
import type { Ui } from "../ui/Ui";
import { Emitter } from "../util/Emitter";
import { GameController } from "./GameController";

const ME = "me";
const FOE = "foe";

function player(id: string, slot: number, patch: Partial<PlayerView> = {}): PlayerView {
  return {
    ...createPlayerSim(),
    id,
    nickname: id === ME ? "Me" : "Foe",
    character: id === ME ? "quacky" : "gruff",
    slot,
    ready: true,
    connected: true,
    spectator: false,
    ping: 40,
    hearts: 3,
    points: 0,
    roundPoints: 0,
    place: 0,
    lastSeq: 0,
    stats: { throws: 0, hits: 0, catches: 0, ringOuts: 0, kos: 0, roundWins: 0 },
    alive: true,
    grounded: true,
    ...patch,
  };
}

function makeState(phase: BonkStateView["phase"], tick: number, mapId: MapId): BonkStateView {
  const players = new Map<string, PlayerView>([
    [ME, player(ME, 0)],
    [FOE, player(FOE, 1)],
  ]);
  return {
    phase,
    round: 1,
    totalRounds: 5,
    phaseTicksLeft: 90,
    tick,
    mapId,
    hostId: ME,
    crownId: "",
    roundWinnerId: "",
    matchWinnerId: "",
    settings: { map: "random", rounds: 5, powerUps: true },
    players,
    balls: new Map(),
    powerUps: new Map(),
    rings: [0, 0, 0, 0, 0],
  };
}

function frameOf(v: PlayerView, isLocal: boolean): PlayerFrame {
  return { ...v, isLocal };
}

/** Records everything the controller asks of its dependencies. */
function setup(initial: BonkStateView | null) {
  const events = new Emitter<NetEventMap>();
  const sent: InputCmd[] = [];
  const net = {
    events,
    clock: { synced: false, serverTickAt: (_nowMs: number): number => 0 },
    status: "connected",
    sessionId: ME,
    code: "ABCD",
    state: initial,
    wantsInput: true,
    localSim: null,
    get me(): PlayerView | null {
      return this.state?.players.get(ME) ?? null;
    },
    sendInput(cmd: InputCmd) {
      sent.push(cmd);
      return null;
    },
    update() {},
    getLocalPlayer() {
      const me = this.me;
      return me ? frameOf(me, true) : null;
    },
    getRemotePlayers() {
      const foe = this.state?.players.get(FOE);
      return foe ? [frameOf(foe, false)] : [];
    },
    getBalls: (): BallFrame[] => [],
  };

  const input = {
    yaw: 0,
    pitch: 0,
    latchesCleared: 0,
    sample(seq: number): InputCmd {
      return { seq, moveX: 0, moveZ: 0, yaw: this.yaw, pitch: this.pitch, buttons: 0 };
    },
    clearLatches() {
      this.latchesCleared++;
    },
    setLook(yaw: number, pitch: number) {
      this.yaw = yaw;
      this.pitch = pitch;
    },
    ghostMove: () => ({ x: 0, y: 0, z: 0 }),
  };

  const loads: MapId[] = [];
  const renderer = {
    camera: new THREE.PerspectiveCamera(70, 1, 0.1, 600),
    arena: null as { def: ReturnType<typeof getArena>; onRingFall: unknown; syncRings(): void } | null,
    viewport: { width: 800, height: 600 },
    loadArena(mapId: MapId) {
      if (this.arena?.def.id === mapId) return this.arena;
      loads.push(mapId);
      this.arena = { def: getArena(mapId), onRingFall: null, syncRings() {} };
      return this.arena;
    },
    update() {},
    render() {},
  };

  const cam = {
    modes: [] as CameraUpdate["mode"][],
    ghosts: [] as Array<{ x: number; y: number; z: number }>,
    shakes: [] as number[],
    cuts: 0,
    setFloorQuery() {},
    update(_dt: number, u: CameraUpdate) {
      this.modes.push(u.mode);
    },
    enterGhost(from: { x: number; y: number; z: number }) {
      this.ghosts.push({ ...from });
    },
    shake(intensity: number) {
      this.shakes.push(intensity);
    },
    koCut() {
      this.cuts++;
    },
  };

  const triggers: string[] = [];
  const characters = {
    sync() {},
    trigger(id: string, anim: string) {
      triggers.push(`${id}:${anim}`);
    },
    getHandPosition: () => false,
    getHeadTop: () => false,
    clear() {},
  };

  const feel = { hitStops: 0, slowMos: 0, hitStop() { this.hitStops++; }, slowMo() { this.slowMos++; }, update: (dt: number) => dt, timeScale: 1 };
  const noop = { sync() {}, setChargeGlow() {}, clear() {}, burst() {}, emit() {}, update() {}, show() {}, setArena() {} };
  const fx = {
    balls: noop,
    particles: noop,
    popText: noop,
    powerUps: noop,
    arc: { update() {} },
    shadows: { update() {}, setFloorQuery() {} },
    feel,
    setArena() {},
    update() {},
    clear() {},
  };

  const sounds: string[] = [];
  const music: string[] = [];
  const audio = {
    play(id: string) {
      sounds.push(id);
    },
    voice() {},
    jingle(kind: string) {
      sounds.push(`jingle:${kind}`);
    },
    playMusic(track: string) {
      music.push(track);
    },
    setMusicTempo() {},
    setTimeScale() {},
    setListener() {},
    startLoop: () => ({ setParam() {}, setPosition() {}, stop() {} }),
  };

  const ui = {
    hud: null as HudModel | null,
    feed: [] as KillFeedEntry[],
    roundEndShown: 0,
    banners: [] as string[],
    updateHud(m: HudModel) {
      this.hud = { ...m };
    },
    setIndicators() {},
    pushKillFeed(e: KillFeedEntry) {
      this.feed.push(e);
    },
    setScoreboard() {},
    showRoundEnd() {
      this.roundEndShown++;
    },
    hideRoundEnd() {},
    banner(text: string) {
      this.banners.push(text);
    },
    toast() {},
  };

  const game = new GameController({
    net: net as unknown as Net,
    input: input as unknown as Input,
    renderer: renderer as unknown as Renderer,
    camera: cam as unknown as CameraRig,
    characters: characters as unknown as Characters,
    fx: fx as unknown as Fx,
    audio: audio as unknown as AudioEngine,
    ui: ui as unknown as Ui,
  });
  let now = 1000;
  const step = (sec = 1 / 60): void => {
    now += sec * 1000;
    game.frame(now, sec);
  };
  return { game, net, events, sent, input, loads, cam, triggers, feel, sounds, music, ui, step };
}

const roundStart = (tick: number, mapId: MapId): RoundStartEvent => ({
  tick,
  round: 1,
  totalRounds: 5,
  mapId,
  participants: [ME, FOE],
});

describe("GameController input loop", () => {
  it("samples at 30 Hz with one page-lifetime seq, and drops the backlog while not sending", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.step(0.1);
    expect(t.sent.length).toBe(3);
    t.net.wantsInput = false;
    t.step(0.2);
    expect(t.sent.length).toBe(3);
    expect(t.input.latchesCleared).toBeGreaterThan(0);
    t.game.exit();
    t.game.enter();
    t.net.wantsInput = true;
    t.step(DT);
    const seqs = t.sent.map((c) => c.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });
});

describe("GameController round flow", () => {
  it("enters on an early roundStart and never rebuilds the stale map", () => {
    // Lobby patch of the same tick (Start is handled between ticks), map still the old one.
    const t = setup(makeState("lobby", 500, "picnic"));
    t.events.emit("roundStart", roundStart(500, "cake"));
    expect(t.game.active).toBe(true);
    t.step();
    t.step();
    expect(t.loads).toEqual(["cake"]);
    expect(t.music.at(-1)).toBe("fight");
    expect(t.ui.banners).toContain("ROUND 1");
    expect(t.input.yaw).toBeCloseTo(getArena("cake").spawns[0].yaw);
    // The countdown patch arrives with the new map: no extra load.
    t.net.state = makeState("countdown", 501, "cake");
    t.step();
    expect(t.loads).toEqual(["cake"]);
  });

  it("switches maps when a new round's state arrives", () => {
    const t = setup(makeState("countdown", 10, "picnic"));
    t.game.enter();
    t.step();
    t.net.state = makeState("countdown", 400, "bath");
    t.events.emit("roundStart", roundStart(400, "bath"));
    t.step();
    expect(t.loads).toEqual(["picnic", "bath"]);
  });

  it("shows the round-end card only after the server slow-mo", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.events.emit("roundWin", { tick: 101, round: 1, winnerId: ME, finalVictimId: FOE, finalPos: { x: 1, y: 0, z: 1 }, roundPoints: { [ME]: 4 }, nextRound: 2 });
    expect(t.cam.cuts).toBe(1);
    expect(t.sounds).toContain("jingle:roundWin");
    const state = makeState("roundEnd", 102, "picnic");
    state.phaseTicksLeft = ROUND_END_CARD_TICKS + 20;
    t.net.state = state;
    t.step();
    expect(t.ui.roundEndShown).toBe(0);
    state.phaseTicksLeft = ROUND_END_CARD_TICKS;
    t.step();
    expect(t.ui.roundEndShown).toBe(1);
  });
});

describe("GameController feedback", () => {
  it("wires a hit on me: hit-stop, shake, voice/bonk, kill feed", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.events.emit("hit", {
      tick: 100,
      ballId: "b1",
      throwerId: FOE,
      targetId: ME,
      pos: { x: 0, y: 1, z: 0 },
      knockback: { x: 6, y: 4, z: 0 },
      charge: 0.5,
      kind: "normal",
      heartsLeft: 2,
      fullCharge: false,
    });
    expect(t.feel.hitStops).toBe(1);
    expect(t.cam.shakes).toEqual([0.35]);
    expect(t.sounds).toContain("bonk");
    expect(t.sounds).not.toContain("ding");
    expect(t.triggers).toContain(`${ME}:hit`);
    expect(t.ui.feed[0]).toMatchObject({ kind: "bonk", actor: { name: "Foe" }, victim: { name: "Me" } });
  });

  it("skips my own server throw (already predicted) but plays others'", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    const base = { tick: 1, throwSeq: 3, ballIds: ["b"], charge: 1, kind: "normal" as const, powerUp: "" as const, curve: false, origin: { x: 0, y: 1, z: 0 }, velocities: [{ x: 0, y: 0, z: -34 }] };
    t.events.emit("throw", { ...base, ownerId: ME, character: "quacky" });
    expect(t.triggers).not.toContain(`${ME}:throw`);
    t.events.emit("throw", { ...base, ownerId: FOE, character: "gruff" });
    expect(t.triggers).toContain(`${FOE}:throw`);
    expect(t.sounds).toContain("throwHeavy");
  });

  it("gives the catcher slow-mo and the crowd an ooh", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.events.emit("catch", { tick: 1, ballId: "b", catcherId: ME, throwerId: FOE, pos: { x: 0, y: 1, z: 0 }, throwerHeartsLeft: 2, rewindTicks: 1, kept: true });
    expect(t.feel.slowMos).toBe(1);
    expect(t.sounds).toEqual(expect.arrayContaining(["catch", "crowdOoh"]));
    expect(t.ui.feed[0].kind).toBe("catch");
  });

  it("unsubscribes gameplay events on exit", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.game.exit();
    t.events.emit("whiff", { tick: 1, playerId: FOE, pos: { x: 0, y: 0, z: 0 } });
    expect(t.sounds).not.toContain("whiff");
  });
});

describe("GameController ghost camera", () => {
  it("KO: ghost cam at once, spectating HUD once the patch lands", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.step();
    expect(t.cam.modes.at(-1)).toBe("follow");
    t.events.emit("ko", { tick: 101, playerId: ME, byId: FOE, cause: "hits", pos: { x: 2, y: 0, z: 3 } });
    expect(t.cam.ghosts).toHaveLength(1);
    const state = makeState("playing", 102, "picnic");
    state.players.get(ME)!.alive = false;
    t.net.state = state;
    t.step();
    expect(t.cam.modes.at(-1)).toBe("ghost");
    expect(t.ui.hud?.spectating?.reason).toBe("ko");
  });

  it("ring-out: watches the fall for 0.8 s before the ghost cam", () => {
    const t = setup(makeState("playing", 100, "picnic"));
    t.game.enter();
    t.step();
    t.events.emit("ringOut", { tick: 101, playerId: ME, creditId: "", pos: { x: 14, y: 0, z: 0 } });
    const state = makeState("playing", 102, "picnic");
    state.players.get(ME)!.alive = false;
    t.net.state = state;
    t.step(0.1);
    expect(t.cam.modes.at(-1)).toBe("follow");
    expect(t.cam.ghosts).toHaveLength(0);
    for (let i = 0; i < 10; i++) t.step(0.1);
    expect(t.cam.ghosts).toHaveLength(1);
    expect(t.cam.modes.at(-1)).toBe("ghost");
    expect(t.ui.feed[0].kind).toBe("fell");
  });

  it("spectators fly the ghost cam right away", () => {
    const state = makeState("playing", 100, "picnic");
    state.players.get(ME)!.spectator = true;
    state.players.get(ME)!.alive = false;
    const t = setup(state);
    t.game.enter();
    t.step();
    expect(t.cam.ghosts).toHaveLength(1);
    expect(t.ui.hud?.spectating?.reason).toBe("spectator");
  });
});

describe("GameController HUD", () => {
  it("counts 3-2-1 from the server and holds BONK! briefly", () => {
    const t = setup(makeState("countdown", 100, "picnic"));
    t.game.enter();
    t.events.emit("countdown", { tick: 100, round: 1, n: 2 });
    t.step();
    expect(t.ui.hud?.countdown).toBe(2);
    expect(t.sounds).toContain("countdownTick");
    t.events.emit("countdown", { tick: 160, round: 1, n: 0 });
    t.net.state = makeState("playing", 161, "picnic");
    t.step();
    expect(t.ui.hud?.countdown).toBe(0);
    t.step(1.2);
    expect(t.ui.hud?.countdown).toBeNull();
  });

  it("advances the timer between patches with the server clock", () => {
    const state = makeState("playing", 100, "picnic");
    state.phaseTicksLeft = 300;
    const t = setup(state);
    // The server clock says 15 ticks have passed since the patch.
    t.net.clock = { synced: true, serverTickAt: () => 115 };
    t.game.enter();
    t.step();
    expect(t.ui.hud?.timerSec).toBeCloseTo((300 - 15) / (1000 / TICK_MS));
  });
});
