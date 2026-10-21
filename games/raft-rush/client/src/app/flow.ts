// Match-flow events → banners, one-shot cues, feed lines (docs/ARCHITECTURE.md §6.2 rows matchStart, dayPhase,
// weather / dayEvent, stormWarning / storm, raftReady / board / raftLaunch, matchEnd, notice). The camera and
// music react to the phase itself (cinematics.ts, soundscape.ts). Owner: client-app.

import { DAYS, TICK_RATE } from "../../../shared/constants";
import type {
  BoardEvent,
  DayEventEvent,
  DayPhaseEvent,
  MatchEndEvent,
  MatchStartEvent,
  NoticeMsg,
  RaftLaunchEvent,
  RaftReadyEvent,
  StormEvent,
  StormWarningEvent,
  WeatherEvent,
} from "../../../shared/protocol";
import { clockAt, matchTicks } from "../../../shared/rules/schedule";
import { biomeName, clockText, has, t, weatherName } from "../i18n";
import type { NetEventMap } from "../net/types";
import { above, bannerLine, feedLine, point, type FeedbackContext } from "./feedbackContext";

/** Banners for big moments stay a little longer. */
const LONG_BANNER_SEC = 3.6;

export class FlowFeedback {
  private readonly offs: Array<() => void> = [];
  private readonly scratch = point(0, 0, 0);

  constructor(private readonly ctx: FeedbackContext) {}

  attach(): void {
    if (this.offs.length > 0) return;
    this.on("matchStart", (e) => this.onMatchStart(e));
    this.on("dayPhase", (e) => this.onDayPhase(e));
    this.on("weather", (e) => this.onWeather(e));
    this.on("dayEvent", (e) => this.onDayEvent(e));
    this.on("stormWarning", (e) => this.onStormWarning(e));
    this.on("storm", (e) => this.onStorm(e));
    this.on("raftReady", (e) => this.onRaftReady(e));
    this.on("board", (e) => this.onBoard(e));
    this.on("raftLaunch", (e) => this.onRaftLaunch(e));
    this.on("matchEnd", (e) => this.onMatchEnd(e));
  }

  detach(): void {
    for (const off of this.offs.splice(0)) off();
  }

  private on<K extends keyof NetEventMap>(type: K, fn: (payload: NetEventMap[K]) => void): void {
    this.offs.push(this.ctx.net.events.on(type, fn));
  }

  private name(id: string): string {
    return this.ctx.dir.name(id) || "?";
  }

  /** "Day 1 — storm in 7:45": the landing banner (game4.md §4.2). */
  private onMatchStart(ev: MatchStartEvent): void {
    const { audio } = this.ctx;
    const storm = matchTicks(this.ctx.net.timings) / TICK_RATE;
    audio.play("dayStart");
    bannerLine(this.ctx, "day", "info", {
      params: { n: 1, days: DAYS },
      sub: "daySubFirst",
      subParams: { time: clockText(storm), biome: biomeName(ev.biome) },
      duration: LONG_BANNER_SEC,
    });
    feedLine(this.ctx, "landing", "🚢", "info", { biome: biomeName(ev.biome), seed: ev.seed });
  }

  private onDayPhase(ev: DayPhaseEvent): void {
    const { audio } = this.ctx;
    const state = this.ctx.net.state;
    const timings = this.ctx.net.timings;
    const last = ev.day >= DAYS;
    if (ev.dayPhase === "day") {
      if (ev.day <= 1) return; // the landing banner already said "Day 1"
      audio.play("dayStart");
      const stormLeft = state ? clockAt(state.clockTicks, timings).stormLeft / TICK_RATE : 0;
      bannerLine(this.ctx, "day", "good", { params: { n: ev.day, days: DAYS }, sub: last ? "daySubLast" : "daySub", subParams: { time: clockText(stormLeft) } });
      feedLine(this.ctx, "dawn", "🌅", "good", { n: ev.day });
      return;
    }
    if (ev.dayPhase === "dusk") {
      audio.play("duskDrums");
      audio.duck(2);
      bannerLine(this.ctx, last ? "duskLast" : "dusk", "warn", { sub: "duskSub", duration: LONG_BANNER_SEC });
      return;
    }
    audio.play("nightStart");
    const team = state?.teams[0];
    const quiet = team?.flare === true;
    bannerLine(this.ctx, "night", "bad", { params: { n: ev.day }, sub: quiet ? "nightSubFlare" : last ? "nightSubLast" : "nightSub" });
    // Kaptan's nightly denial (game4.md §14).
    let kaptan = "";
    state?.players.forEach((p) => {
      if (!kaptan && p.character === "kaptan" && !p.spectator) kaptan = p.id;
    });
    if (kaptan) feedLine(this.ctx, `captainLine${((ev.day - 1) % 3) + 1}`, "🧢", "info", { name: this.name(kaptan) });
  }

  private onWeather(ev: WeatherEvent): void {
    const { audio, renderer } = this.ctx;
    if (ev.weather === "clear") return;
    bannerLine(this.ctx, `weather_${ev.weather}`, ev.weather === "fullmoon" || ev.weather === "rain" ? "warn" : "info", { sub: `weather_${ev.weather}Sub` });
    feedLine(this.ctx, `weather_${ev.weather}`, ev.weather === "rain" ? "🌧️" : ev.weather === "fog" ? "🌫️" : ev.weather === "heatwave" ? "🥵" : "🌕", "info", {
      weather: weatherName(ev.weather),
    });
    if (ev.weather === "rain") {
      renderer.lightning(0.5);
      audio.play("thunder", { volume: 0.8 });
    }
  }

  private onDayEvent(ev: DayEventEvent): void {
    const { audio } = this.ctx;
    bannerLine(this.ctx, `dayEvent_${ev.kind}`, ev.kind === "waveGift" ? "good" : "warn", { sub: `dayEvent_${ev.kind}Sub` });
    if (ev.kind === "gull") {
      audio.play("gull", { pos: ev.pos, volume: 1.2 });
      feedLine(this.ctx, "dayEvent_gull", "🐦", "warn", { name: this.name(ev.playerId) });
    } else if (ev.kind === "monkeys") {
      audio.play("monkey", { pos: ev.pos, volume: 1.2 });
      feedLine(this.ctx, "dayEvent_monkeys", "🐒", "warn");
    } else {
      audio.play("splash", { pos: ev.pos, volume: 1.2, pitch: 0.7 });
      this.ctx.fx.burst("splash", ev.pos, { scale: 1.6 });
      feedLine(this.ctx, "dayEvent_waveGift", "📦", "good");
    }
  }

  private onStormWarning(ev: StormWarningEvent): void {
    this.ctx.audio.play("stormWarn");
    this.ctx.audio.duck(2.5);
    this.ctx.renderer.fp.shake(0.25);
    bannerLine(this.ctx, "stormWarning", "bad", { params: { sec: Math.round(ev.secondsLeft) }, sub: "stormWarningSub", duration: LONG_BANNER_SEC });
  }

  private onStorm(ev: StormEvent): void {
    void ev;
    const { audio, renderer } = this.ctx;
    renderer.lightning(1);
    renderer.fp.shake(0.8);
    audio.play("thunder", { volume: 1.4 });
    audio.duck(3);
    bannerLine(this.ctx, "storm", "bad", { sub: "stormSub", duration: LONG_BANNER_SEC });
  }

  private onRaftReady(ev: RaftReadyEvent): void {
    const { audio, fx } = this.ctx;
    const site = this.ctx.net.island?.sites[ev.team] ?? this.ctx.net.island?.sites[0];
    audio.play("raftReady");
    audio.duck(2);
    if (site) fx.burst("confetti", point(site.raft.x, 2, site.raft.z), { scale: 1.6 });
    bannerLine(this.ctx, "raftReady", "gold", { sub: "raftReadySub", duration: LONG_BANNER_SEC });
    feedLine(this.ctx, "raftReady", "🛶", "gold");
    this.ctx.coach.tip("board");
  }

  private onBoard(ev: BoardEvent): void {
    const { audio, characters } = this.ctx;
    characters.trigger(ev.playerId, "board");
    const at = this.ctx.position(ev.playerId, this.scratch) ? point(this.scratch.x, this.scratch.y, this.scratch.z) : undefined;
    audio.play("board", at ? { pos: at } : undefined);
    feedLine(this.ctx, "boarded", "🛶", "good", { name: this.name(ev.playerId) });
    if (ev.launchTicksLeft > 0) {
      bannerLine(this.ctx, "boarding", "warn", { params: { sec: Math.ceil(ev.launchTicksLeft / TICK_RATE) }, sub: "boardingSub" });
    }
  }

  private onRaftLaunch(ev: RaftLaunchEvent): void {
    const { audio, characters } = this.ctx;
    audio.play("launch");
    audio.duck(2);
    for (const id of ev.aboard) characters.trigger(id, "cheer");
    const me = this.ctx.localId;
    const leftBehind = ev.left.includes(me);
    bannerLine(this.ctx, leftBehind ? "launchLeft" : "launch", leftBehind ? "bad" : "gold", { sub: leftBehind ? "launchLeftSub" : "launchSub", duration: LONG_BANNER_SEC });
    for (const id of ev.left) feedLine(this.ctx, "wilson", "🏐", "info", { name: this.name(id) });
  }

  private onMatchEnd(ev: MatchEndEvent): void {
    const { audio, characters, fx } = this.ctx;
    const me = this.ctx.net.me;
    const win = ev.winnerTeam >= 0 && ev.winnerTeam === (me?.team ?? 0);
    audio.play(win ? "win" : "lose");
    if (win) {
      for (const s of ev.standings) if (s.aboard) characters.trigger(s.id, "cheer");
      const site = this.ctx.net.island?.sites[ev.winnerTeam] ?? this.ctx.net.island?.sites[0];
      if (site) fx.burst("confetti", above(point(site.raft.x, 1, site.raft.z), 2), { scale: 2.4 });
    }
  }
}

/** A room notice as a translated toast line (English fallback when the key is unknown). */
export function noticeText(n: NoticeMsg): string {
  const key = `server.${n.key}`;
  return has(key) ? t(key, n.params) : n.text;
}
