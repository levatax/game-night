// First-match coach tips (game4.md §17 "Coach ipuçları"): each tip fires once, on the moment it's useful (first
// steps, first night, fire low, hungry, raft ready, got a rod…). Owner: client-app.
//
// Tips are shown by Ui.coach(id) (text `coach.<id>`, ids from client-ui's ui/hud/Coach.ts COACH_TIPS; the UI
// records settings.seenTips). An id the UI's coach section doesn't have (or a future rename) falls back to a feed
// line (`feed.tip_<id>`, client-app) and the app records it in settings.seenTips itself, so every tip still shows
// at most once — until the settings menu's "Show tips again" clears seenTips, which re-arms every tip here too.

import { BAR_MAX, CHANNEL, FIRE_LOW_FRACTION, FIRE_START_FUEL_TICKS, FISH_STATE, LOW_BAR_FRACTION, RAFT_LAUNCH_STAGE, timingsFor } from "../../../shared/constants";
import { carriesRaftGoods, raftMaterialsDone, type Interaction } from "../../../shared/rules/interact";
import { launchDayFor } from "../../../shared/rules/schedule";
import { countOf } from "../../../shared/rules/inventory";
import type { DayPhase, Phase, PlayerView, RaftStateView } from "../../../shared/types";
import { has } from "../i18n";
import type { Ui } from "../ui/Ui";
import type { SettingsStore } from "./settings";

/** Every tip id the app can show (coach.<id> on the UI, feed.tip_<id> as the fallback). */
export const COACH_TIPS = [
  "move",
  "gather",
  "palm",
  "fire",
  "lowFire",
  "craft",
  "raft",
  "bars",
  "spring",
  "dusk",
  "night",
  "torch",
  "fishing",
  "bite",
  "bait",
  "revive",
  "downed",
  "board",
  "ping",
  "chest",
  "catch",
  "storm",
  "legend",
  "fellWithAxe",
  "heavyCarry",
  "buildBench",
  "salvageWreck",
  "assemble",
  "cookProvisions",
  "guardRaft",
  "killBoss",
] as const;
export type CoachTip = (typeof COACH_TIPS)[number];

/** Into the landing before the first tips. */
const MOVE_TIP_DELAY_MS = 1500;
const GATHER_TIP_DELAY_MS = 7000;
/** At most one tip this often (they'd drown each other out). */
const TIP_GAP_MS = 8000;
/** Fraction of day 1 after which the ping / legend tips come up. */
const PING_DAY_FRACTION = 0.4;
const LEGEND_DAY_FRACTION = 0.7;

export interface CoachFrame {
  phase: Phase;
  day: number;
  dayPhase: DayPhase;
  /** 0..1 through the current day phase. */
  phaseFrac: number;
  state: RaftStateView;
  me: PlayerView;
  interaction: Interaction | null;
  lookingAtPalm: boolean;
  nowMs: number;
}

export class Coach {
  /** Tips shown this page session (also covers the seenTips the UI writes asynchronously). */
  private readonly shown = new Set<string>();
  private readonly queue: CoachTip[] = [];
  private lastShownAt = -Infinity;
  private matchStartAt = 0;

  constructor(
    private readonly ui: Ui,
    private readonly settings: SettingsStore,
  ) {
    settings.onChange((next, changed) => {
      if (changed.includes("seenTips") && next.seenTips.length === 0) this.replay();
    });
  }

  /** "Show tips again": forget what this page already showed (seenTips was cleared by the menu). */
  replay(): void {
    this.shown.clear();
    this.lastShownAt = -Infinity;
  }

  /** A new match began (the first tips wait a moment into the landing). */
  matchStarted(nowMs: number): void {
    this.matchStartAt = nowMs;
    this.queue.length = 0;
  }

  /** Ask for a tip; it shows now or after the current one (once ever). */
  tip(id: CoachTip): void {
    if (this.seen(id) || this.queue.includes(id)) return;
    this.queue.push(id);
  }

  /** Per frame while in a match: detect the moments, then show at most one queued tip. */
  update(f: CoachFrame): void {
    this.detect(f);
    if (this.queue.length === 0 || f.nowMs - this.lastShownAt < TIP_GAP_MS) return;
    const id = this.queue.shift()!;
    if (this.seen(id)) return;
    this.show(id, f.nowMs);
  }

  clear(): void {
    this.queue.length = 0;
  }

  private detect(f: CoachFrame): void {
    const { me, state } = f;
    if (!me.alive || me.washed || me.spectator) return;
    const since = f.nowMs - this.matchStartAt;
    if (f.phase === "landing") {
      if (since > MOVE_TIP_DELAY_MS) this.tip("move");
      if (since > GATHER_TIP_DELAY_MS) this.tip("gather");
      return;
    }
    if (f.phase !== "playing") return;
    this.tip("gather");
    const team = state.teams[me.team] ?? state.teams[0];
    const it = f.interaction;
    if (f.lookingAtPalm) this.tip("palm");
    if (it?.kind === "craft") this.tip("craft");
    if (it?.kind === "chest") this.tip("chest");
    if (it?.kind === "spring") this.tip("spring");
    if (team && team.stage < RAFT_LAUNCH_STAGE && carriesRaftGoods(me)) this.tip("raft");
    if (countOf(me, "axe") > 0) this.tip("fellWithAxe");
    if (countOf(me, "log") > 0 || countOf(me, "barrel") > 0 || (me.loadMult > 0 && me.loadMult < 100)) this.tip("heavyCarry");
    if (team && team.benchTier === 0 && it?.kind === "craft") this.tip("buildBench");
    if (team && team.stage >= 2 && team.benchTier >= 1 && countOf(me, "hammer") === 0) this.tip("salvageWreck");
    if (team && raftMaterialsDone(team)) this.tip("assemble");
    if (team && team.stage === 5) this.tip("cookProvisions");
    if (team && team.stage >= 1 && f.dayPhase === "dusk") this.tip("guardRaft");
    if (team && team.stage >= 4 && !team.bossDown) this.tip("killBoss");
    if (countOf(me, "rod") > 0) this.tip("fishing");
    if (me.fishState === FISH_STATE.CAST) this.tip("bite");
    if (countOf(me, "torch") > 0) this.tip("torch");
    if (countOf(me, "fish_raw") > 0 && f.dayPhase !== "day") this.tip("bait");
    if (f.day === 1 && f.dayPhase === "day" && f.phaseFrac > PING_DAY_FRACTION) this.tip("ping");
    if (f.day === 1 && f.dayPhase === "day" && f.phaseFrac > LEGEND_DAY_FRACTION) this.tip("legend");
    if (f.dayPhase === "dusk") this.tip("dusk");
    if (f.dayPhase === "night") this.tip("night");
    if (f.day >= timingsFor(f.state.fast).days && f.dayPhase !== "day") this.tip("storm");
    if (team) {
      if (team.fireFuel > 0 && team.fireFuel < FIRE_LOW_FRACTION * FIRE_START_FUEL_TICKS) this.tip("lowFire");
      else if (team.fireFuel < FIRE_START_FUEL_TICKS * 0.5) this.tip("fire");
      if (team.stage >= RAFT_LAUNCH_STAGE && f.day >= launchDayFor(f.state.difficulty, timingsFor(f.state.fast))) this.tip("board");
    }
    const low = LOW_BAR_FRACTION * BAR_MAX;
    if (me.hunger < low || me.thirst < low || me.warmth < low) this.tip("bars");
    if (me.downed) this.tip("downed");
    let mateDown = false;
    state.players.forEach((q) => {
      if (q.id !== me.id && q.team === me.team && q.downed && q.alive && !q.spectator) mateDown = true;
    });
    if (mateDown && me.channel !== CHANNEL.REVIVE) this.tip("revive");
  }

  private seen(id: string): boolean {
    return this.shown.has(id) || this.settings.get().seenTips.includes(id);
  }

  private show(id: CoachTip, nowMs: number): void {
    this.shown.add(id);
    this.lastShownAt = nowMs;
    if (has(`coach.${id}`)) {
      this.ui.coach(id);
      return;
    }
    // The UI has no text for it: say it in the feed and remember it ourselves.
    this.ui.feed({ key: `feed.tip_${id}`, icon: "💡", tone: "info" });
    const seenTips = this.settings.get().seenTips;
    if (!seenTips.includes(id)) this.settings.set({ seenTips: [...seenTips, id] });
  }
}
