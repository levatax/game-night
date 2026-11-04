// Per-frame sound of the game view (docs/ARCHITECTURE.md §6.1 step 8): listener at the eye, the continuous
// loops (charges, campfire, surf at the nearest shore point, swimming, puffer fuse, gather channel, reel), the
// ambience frame (the audio engine's beds: rain, wind, gulls, crickets, dusk drums, storm), Emekli Amca's radio as
// the music source and the music mood (day / dusk / night / boss / storm / launch / win / lose). Owner: client-app.

import { CHANNEL, FIRE_START_FUEL_TICKS, FISH_STATE, PUFFER_FUSE_TICKS, STORM_WARN_SEC, TICK_RATE, timingsFor, type Timings } from "../../../shared/constants";
import type { IslandDef } from "../../../shared/island/types";
import { daylight, type ClockInfo } from "../../../shared/rules/schedule";
import { chargeFraction } from "../../../shared/sim/player";
import { throwOrigin } from "../../../shared/sim/throw";
import type { Phase, PlayerView, RaftStateView, Vec3Like } from "../../../shared/types";
import type { AudioEngine } from "../audio/AudioEngine";
import type { LoopName, MusicMood } from "../audio/Sfx";
import type { MonsterFrame, PlayerFrame } from "../net/types";
import { nearestShore, seaProximity } from "./frameHelpers";

/** Charge whooshes of other players are heard within this range (m). */
const REMOTE_CHARGE_RANGE = 25;

export interface SoundFrame {
  phase: Phase;
  state: RaftStateView;
  me: PlayerView | null;
  local: PlayerFrame | null;
  remotes: ReadonlyArray<PlayerFrame>;
  monsters: ReadonlyArray<MonsterFrame>;
  island: IslandDef | null;
  clock: ClockInfo;
  timings: Readonly<Timings>;
  /** WorldFrame.storm (0..1 build-up). */
  storm: number;
  underwater: boolean;
  listener: Vec3Like;
  forward: Vec3Like;
  /** Match-end result (null outside matchEnd / unknown). */
  win: boolean | null;
  /** 0..1 of my running hold channel (gather / revive). */
  channelProgress: number;
  /** Launch ride: moves a point that sat on the resting raft to where the sailing raft is now (in place). */
  carry?: (p: { x: number; y: number; z: number }) => void;
  dt: number;
}

export class Soundscape {
  private readonly active = new Set<string>();
  private readonly seen = new Set<string>();
  private mood: MusicMood | null = null;
  private readonly hand = { x: 0, y: 0, z: 0 };
  private readonly radio = { x: 0, y: 0, z: 0 };
  private readonly shore = { x: 0, y: 0, z: 0 };

  constructor(private readonly audio: AudioEngine) {}

  /** Music for the menus (home / lobby / connecting). */
  menu(listener: Vec3Like, forward: Vec3Like, dt: number): void {
    this.stopLoops();
    this.setMood("lobby");
    this.audio.setRadio(null);
    this.audio.setListener(listener, forward);
    this.audio.setAmbience({ daylight: 0.9, weather: "clear", sea: 0.55, monsters: 0, storm: 0, underwater: false });
    this.audio.update(dt);
  }

  /** Per game frame. */
  update(f: SoundFrame): void {
    const { audio } = this;
    audio.setListener(f.listener, f.forward);
    this.seen.clear();
    this.loops(f);
    for (const key of [...this.active]) {
      if (this.seen.has(key)) continue;
      audio.stopLoop(key);
      this.active.delete(key);
    }
    const sea = f.island && f.local ? seaProximity(f.island, f.local.x, f.local.z, f.local.y) : f.island ? seaProximity(f.island, f.listener.x, f.listener.z, f.listener.y) : 0.5;
    audio.setAmbience({
      daylight: f.phase === "lobby" || f.phase === "matchEnd" ? 0.9 : daylight(f.clock.cycle, f.timings),
      weather: f.state.weather,
      sea,
      monsters: countMonsters(f.monsters),
      storm: f.storm,
      underwater: f.underwater || (f.local?.swimming ?? false),
    });
    audio.setRadio(this.radioPosition(f));
    this.setMood(moodFor(f));
    audio.update(f.dt);
  }

  /** Leaving the game view: silence every loop (the next screen picks its music). */
  stopLoops(): void {
    for (const key of this.active) this.audio.stopLoop(key);
    this.active.clear();
  }

  /** Forget the mood so the next frame re-sends it (after the audio unlocked). */
  refresh(): void {
    this.mood = null;
  }

  private setMood(mood: MusicMood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.audio.setMusic(mood);
  }

  private loop(key: string, name: LoopName, opts?: Parameters<AudioEngine["loop"]>[2]): void {
    this.audio.loop(key, name, opts);
    this.active.add(key);
    this.seen.add(key);
  }

  private loops(f: SoundFrame): void {
    const { me, local, state, island } = f;
    const inMatch = f.phase === "landing" || f.phase === "playing" || f.phase === "launch" || f.phase === "storm";
    // Surf: positional at the nearest shore point (it replaces the flat wave bed while it runs). Rain, wind,
    // crickets, gulls, drums and the storm are the ambience beds (setAmbience below).
    if (island) {
      const at = local ?? f.listener;
      if (nearestShore(island, at.x, at.z, this.shore)) {
        this.loop("waves", "waves", { pos: this.shore, param: seaProximity(island, at.x, at.z, at.y), volume: 1 });
      }
    }
    // Campfire crackle at the fire while it burns (bigger fire = louder, livelier).
    const team = state.teams[me?.team ?? 0] ?? state.teams[0];
    const site = island?.sites[me?.team ?? 0] ?? island?.sites[0];
    if (team && site && team.fireFuel > 0 && f.phase !== "lobby") {
      const size = Math.min(1, team.fireFuel / FIRE_START_FUEL_TICKS);
      this.loop("fire", "fire", { pos: { x: site.campfire.x, y: 0.6, z: site.campfire.z }, param: size, volume: 0.6 + 0.4 * size });
    }
    if (!inMatch) return;
    // Charges: mine (2D) and nearby players' (positional).
    if (local && local.alive && local.chargeTicks > 0) {
      const c = chargeFraction(local);
      this.loop("charge:me", "charge", { param: c, volume: 0.5 + 0.5 * c });
    }
    for (const r of f.remotes) {
      if (!r.alive || r.chargeTicks <= 0 || !local) continue;
      if (Math.hypot(r.x - local.x, r.z - local.z) > REMOTE_CHARGE_RANGE) continue;
      const c = chargeFraction(r);
      throwOrigin(r, this.hand);
      this.loop(`charge:${r.id}`, "charge", { pos: { x: this.hand.x, y: this.hand.y, z: this.hand.z }, param: c, volume: 0.4 + 0.4 * c });
    }
    if (local?.swimming) this.loop("swim", "swim", { param: Math.min(1, local.speed / 3) });
    if (me && me.fuseTicks > 0 && hasItem(me, "puffer")) {
      const urgency = 1 - me.fuseTicks / PUFFER_FUSE_TICKS;
      this.loop("fuse", "fuse", { param: urgency, volume: 0.7 + urgency * 0.5 });
    }
    if (local && local.channel !== CHANNEL.NONE && local.channelTicks > 0) {
      this.loop("channel", "channel", { param: f.channelProgress, pitch: local.channel === CHANNEL.REVIVE ? 1.3 : 1 });
    }
    if (me?.fishState === FISH_STATE.REEL) this.loop("reel", "reel", { param: 0.7 });
  }

  /** Emekli Amca's radio: the nearest Amca in the match (the local one when that's you). */
  private radioPosition(f: SoundFrame): Vec3Like | null {
    if (f.phase === "lobby" || f.phase === "matchEnd") return null;
    const local = f.local;
    if (local && local.character === "amca" && local.alive) return this.at(local, f);
    let best: PlayerFrame | null = null;
    let bestD = Infinity;
    for (const r of f.remotes) {
      if (r.character !== "amca" || !r.alive || r.spectator) continue;
      const d = local ? Math.hypot(r.x - local.x, r.z - local.z) : 0;
      if (d < bestD) {
        bestD = d;
        best = r;
      }
    }
    return best ? this.at(best, f) : null;
  }

  /** The radio on `p` (an aboard Amca sails with the raft: the server keeps the seat pinned at the slip). */
  private at(p: PlayerFrame, f: SoundFrame): Vec3Like {
    this.radio.x = p.x;
    this.radio.y = p.y + 1.1;
    this.radio.z = p.z;
    if (p.boarded) f.carry?.(this.radio);
    return this.radio;
  }
}

function hasItem(p: PlayerView, kind: string): boolean {
  return p.inv0 === kind || p.inv1 === kind || p.inv2 === kind || p.inv3 === kind;
}

function countMonsters(list: ReadonlyArray<MonsterFrame>): number {
  let n = 0;
  for (const m of list) if (m.kind !== "monkey" && m.kind !== "gull" && m.mode !== "flee") n++;
  return n;
}

/** Music mood for the phase / day phase / threats. */
export function moodFor(f: Pick<SoundFrame, "phase" | "state" | "monsters" | "clock" | "win">): MusicMood {
  switch (f.phase) {
    case "lobby":
      return "lobby";
    case "matchEnd":
      return f.win === null ? "lobby" : f.win ? "win" : "lose";
    case "launch":
      return "launch";
    case "storm":
      return "storm";
    case "landing":
      return "day";
    default:
      break;
  }
  const c = f.clock;
  if (c.day >= timingsFor(f.state.fast).days && c.dayPhase === "night" && c.stormLeft <= STORM_WARN_SEC * TICK_RATE) return "storm";
  if (c.dayPhase !== "day" && f.monsters.some((m) => m.kind === "boss" && m.mode !== "flee")) return "boss";
  return c.dayPhase;
}
