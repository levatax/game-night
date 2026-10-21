// GameController with fake modules: 30 Hz input sampling with one page-lifetime seq, a failing module never stops
// the frame, E on the campfire opens the craft panel, the ping wheel sends the crosshair hit + the "need" item,
// matchStart enters the view facing the camp, the HUD is fed every frame. Owner: client-app.

import * as THREE from "three";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DT, NORMAL_TIMINGS } from "../../../shared/constants";
import type { IslandDef } from "../../../shared/island/types";
import type { InputCmd, MarkerMsg } from "../../../shared/protocol";
import { buildCover } from "../../../shared/sim/cover";
import { yawFromDir } from "../../../shared/sim/math";
import type { PlayerView, RaftStateView } from "../../../shared/types";
import type { AudioEngine } from "../audio/AudioEngine";
import type { Characters } from "../characters/Characters";
import type { Fx } from "../fx/Fx";
import type { Input } from "../input/Input";
import type { Net } from "../net/Net";
import type { NetEventMap, PlayerFrame } from "../net/types";
import type { Renderer } from "../render/Renderer";
import type { HudModel } from "../ui/models";
import type { Ui } from "../ui/Ui";
import { Emitter } from "../util/Emitter";
import { Coach } from "./coach";
import { PhaseTracker } from "./frameHelpers";
import { GameController } from "./GameController";
import { resetLogOnce } from "./guard";
import { settings } from "./settings";
import { fakePlayer, fakeState, testIsland } from "./testkit";

type Call = [string, unknown[]];

/** A module stand-in: every unknown method records its call; `over` supplies real members. */
function recorder<T>(over: Record<string, unknown> = {}): T & { calls: Call[] } {
  const calls: Call[] = [];
  // Descriptors, not a spread: getters in `over` must stay live.
  const target: Record<string, unknown> = Object.defineProperties({ calls }, Object.getOwnPropertyDescriptors(over));
  return new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop as string];
      if (typeof prop !== "string" || prop === "then") return undefined;
      return (...args: unknown[]) => {
        calls.push([prop, args]);
        return undefined;
      };
    },
    set(t, prop, value) {
      t[prop as string] = value;
      return true;
    },
  }) as unknown as T & { calls: Call[] };
}

const callsOf = (m: { calls: Call[] }, name: string): unknown[][] => m.calls.filter((c) => c[0] === name).map((c) => c[1]);

interface Rig {
  game: GameController;
  net: FakeNet;
  ui: Ui & { calls: Call[]; panel: string | null };
  input: Input & { calls: Call[] };
  renderer: Renderer & { calls: Call[] };
  fx: Fx & { calls: Call[] };
  island: IslandDef;
}

class FakeNet {
  readonly events = new Emitter<NetEventMap>();
  readonly sent: InputCmd[] = [];
  readonly messages: [string, unknown][] = [];
  sessionId = "me";
  status = "connected";
  code = "ABCD";
  wantsInput = true;
  timings = NORMAL_TIMINGS;
  cover;
  constructor(
    public state: RaftStateView,
    public island: IslandDef,
  ) {
    this.cover = buildCover(island);
  }
  get me(): PlayerView | null {
    return this.state.players.get(this.sessionId) ?? null;
  }
  get localSim(): null {
    return null;
  }
  sendInput(cmd: InputCmd): null {
    this.sent.push(cmd);
    return null;
  }
  send(type: string, msg: unknown): void {
    this.messages.push([type, msg]);
  }
  update(): void {}
  getLocalPlayer(_alpha: number, look: { yaw: number; pitch: number }): PlayerFrame | null {
    const me = this.me;
    if (!me) return null;
    return { ...me, yaw: look.yaw, pitch: look.pitch, isLocal: true, speed: 0 };
  }
  getRemotePlayers(): PlayerFrame[] {
    return [];
  }
  getProjectiles(): [] {
    return [];
  }
  getMonsters(): [] {
    return [];
  }
  clockTicksAt(): number {
    return this.state.clockTicks;
  }
  serverTickAt(): number {
    return this.state.tick;
  }
}

function rig(me: PlayerView, fxOver: Record<string, unknown> = {}): Rig {
  const island = testIsland();
  const state = fakeState([me], {}, island);
  const net = new FakeNet(state, island);
  let look = { yaw: me.yaw, pitch: me.pitch };
  let seq = 0;
  const input = recorder<Input>({
    get look() {
      return look;
    },
    get yaw() {
      return look.yaw;
    },
    get pitch() {
      return look.pitch;
    },
    capture: "none",
    pointerLocked: true,
    sample: (s: number): InputCmd => {
      seq = s;
      return { seq, moveX: 0, moveZ: 1, yaw: look.yaw, pitch: look.pitch, buttons: 0 };
    },
    setLook: (yaw: number, pitch: number) => {
      look = { yaw, pitch };
    },
  });
  const ui = recorder<Ui & { panel: string | null }>({ panel: null, capturesInput: false });
  (ui as unknown as Record<string, unknown>).openPanel = (p: string | null) => {
    ui.calls.push(["openPanel", [p]]);
    (ui as unknown as Record<string, unknown>).panel = p;
  };
  const fp = recorder({});
  const renderer = recorder<Renderer>({
    fp,
    camera: new THREE.PerspectiveCamera(),
    darkness: 0,
    isUnderwater: false,
    contextLost: false,
    raftPose: () => false,
  });
  const characters = recorder<Characters>({ fpArms: recorder({}), monsters: recorder({}), handPosition: () => false });
  const fx = recorder<Fx>(fxOver);
  const audio = recorder<AudioEngine>({});
  const game = new GameController({
    net: net as unknown as Net,
    input,
    renderer,
    characters,
    fx,
    audio,
    ui,
    phases: new PhaseTracker(),
    coach: new Coach(ui, settings),
  });
  return { game, net, ui, input, renderer, fx, island };
}

beforeEach(() => {
  resetLogOnce();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("GameController frame", () => {
  it("samples input at 30 Hz with one strictly increasing seq for the page lifetime", () => {
    const r = rig(fakePlayer("me"));
    r.game.enter();
    r.game.frame(1000, 0.1 + 1e-6);
    expect(r.net.sent.map((c) => c.seq)).toEqual([1, 2, 3]);
    r.game.exit();
    r.game.enter();
    r.game.frame(1100, DT + 1e-6);
    expect(r.net.sent.map((c) => c.seq)).toEqual([1, 2, 3, 4]);
    r.net.wantsInput = false;
    r.game.frame(1200, 0.2);
    expect(r.net.sent).toHaveLength(4);
  });

  it("a throwing module is contained: the frame still renders and feeds the HUD", () => {
    const r = rig(fakePlayer("me"), {
      syncProjectiles: () => {
        throw new Error("fx broke");
      },
    });
    r.game.enter();
    r.game.frame(1000, 0.016);
    r.game.frame(1016, 0.016);
    expect(callsOf(r.renderer, "render")).toHaveLength(2);
    expect(callsOf(r.renderer, "update")).toHaveLength(2);
    const huds = callsOf(r.ui, "updateHud");
    expect(huds).toHaveLength(2);
    expect((huds[0]![0] as HudModel).phase).toBe("playing");
  });

  it("E on the campfire opens the craft panel (walk-only capture) and feeds its model", () => {
    const island = testIsland();
    const camp = island.sites[0]!.campfire;
    const me = fakePlayer("me", camp.x, camp.z + 2, { yaw: 0 });
    const r = rig(me);
    r.game.enter();
    r.game.frame(1000, 0.016);
    r.game.onInteractKey();
    expect(callsOf(r.ui, "openPanel")).toContainEqual(["craft"]);
    expect(callsOf(r.input, "setCapture")).toContainEqual(["panel"]);
    r.game.frame(1016, 0.016);
    expect(callsOf(r.ui, "setCraftPanel").length).toBeGreaterThan(0);
    // Knocked far away: the panel closes on its own.
    (r.net.state.players as Map<string, PlayerView>).set("me", { ...me, x: camp.x + 20, z: camp.z + 20 });
    r.game.frame(1032, 0.016);
    expect(r.ui.panel).toBeNull();
  });

  it("the ping wheel sends the crosshair hit once, with what you look at as the need", () => {
    const me = fakePlayer("me", 0, 0, { yaw: 0, pitch: -0.4 });
    const r = rig(me);
    r.island.nodes.push({ i: 0, kind: "tree", x: 0, z: -1.5, y: 1, radius: 0.35, height: 3, yield: "none", amount: 3, island: 0, yaw: 0, scale: 1, variant: 0 });
    r.net.state.nodes = [3];
    r.game.enter();
    r.game.frame(5000, 0.016);
    expect(r.game.openPingWheel()).toBe(true);
    expect(r.ui.panel).toBe("pingWheel");
    r.game.sendMarker("need");
    r.game.sendMarker("need");
    const markers = r.net.messages.filter((m) => m[0] === "marker").map((m) => m[1] as MarkerMsg);
    expect(markers).toHaveLength(1);
    expect(markers[0]!.kind).toBe("need");
    expect(markers[0]!.need).toBe("wood");
    expect(markers[0]!.pos.z).toBeLessThan(0);
  });

  it("hands the mouse back while Net reconnects and asks for it again (veil) once it's back", () => {
    const r = rig(fakePlayer("me"));
    (r.input as unknown as { pointerLocked: boolean }).pointerLocked = false;
    r.game.enter();
    r.game.frame(1000, 0.016);
    expect(r.game.wantsPointer).toBe(true);
    r.net.status = "reconnecting";
    r.net.wantsInput = false;
    r.game.frame(1016, 0.016);
    expect(r.game.wantsPointer).toBe(false);
    expect((callsOf(r.ui, "updateHud").at(-1)![0] as HudModel).needsPointer).toBe(false);
    expect(r.game.openPingWheel()).toBe(false);
    r.net.status = "connected";
    r.net.wantsInput = true;
    r.game.frame(1032, 0.016);
    expect(r.game.wantsPointer).toBe(true);
    expect((callsOf(r.ui, "updateHud").at(-1)![0] as HudModel).needsPointer).toBe(true);
  });

  it("hands the mouse back while the WebGL context is lost", () => {
    const r = rig(fakePlayer("me"));
    r.game.enter();
    r.game.frame(1000, 0.016);
    expect(r.game.wantsPointer).toBe(true);
    (r.renderer as unknown as { contextLost: boolean }).contextLost = true;
    expect(r.game.wantsPointer).toBe(false);
    (r.renderer as unknown as { contextLost: boolean }).contextLost = false;
    expect(r.game.wantsPointer).toBe(true);
  });

  it("matchStart enters the game view and faces the camp", () => {
    const island = testIsland();
    const me = fakePlayer("me", 0, 0, { yaw: 2 });
    const r = rig(me);
    expect(r.game.active).toBe(false);
    r.net.events.emit("matchStart", { tick: 10, seed: 1, layout: "solo", biome: "tropic", participants: ["me"], seats: 2 });
    expect(r.game.active).toBe(true);
    const site = island.sites[0]!;
    const spawn = site.spawns[0]!;
    const want = yawFromDir(site.campfire.x - spawn.x, site.campfire.z - spawn.z);
    expect(r.input.look.yaw).toBeCloseTo(want);
    expect(callsOf(r.ui, "banner").length).toBe(1);
  });
});
