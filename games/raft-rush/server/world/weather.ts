// Weather of the day + daytime mini-events (§6, §9). Owner: server-world-life. Signatures by the architect
// (RaftWorld calls them); keep them.
//
// Dawn: roll today's weather (day 1: DAY1_WEATHER_CHANCE, from day 2 always one of WEATHER_IDS) and today's
// day event (DAY_EVENT_IDS); at WEATHER_START_FRACTION of the day set state.weather + emit weather; at the next
// dawn back to "clear". At each of DAY_EVENT_FRACTIONS (two a day): gull / monkeys (MonsterSystem.spawnVisitor) or a wave gift: 3 resting
// items washed up on a shore cell (2 random materials + 1 coconut), and 25% of the time whoever picks up the first
// one also gets a treasure reel (FishingSystem.treasureReel "waveGift") — emit dayEvent either way.
// Effects other systems read: state.weather (rain: fire ×3 drain, collectors fill, warmth loss; fog: client
// view distance + compass hides non-ping marks; heatwave: thirst ×2 outside shade; fullmoon: monsters ×1.5).
//
// Implementation notes: weather / event never repeat yesterday's (life/forecast.ts); an impossible event falls
// back to the next one (life/dayEvents.ts). The wave gift's treasure reel runs on this system's own TreasureReels
// (same rules as FishingSystem's), so the weather system needs no reference to fishing. Pickups of gift items are
// detected on their own (a gift projectile vanished with a player right next to it); RaftWorld may also call
// onPickup() for an exact answer.

import { DAY_EVENT_FRACTIONS, WEATHER_START_FRACTION } from "../../shared/constants.js";
import { clockAt, type ClockInfo } from "../../shared/rules/schedule.js";
import type { DayEventKind, Weather } from "../../shared/types.js";
import type { MonsterSystem } from "./monsters.js";
import type { PlayerState, WorldContext } from "./context.js";
import { ClockRewind, phaseFraction } from "./life/clock.js";
import { runDayEvent, WaveGifts } from "./life/dayEvents.js";
import { rollDayEvent, rollWeather } from "./life/forecast.js";
import { TreasureReels } from "./life/treasure.js";

export interface Forecast {
  day: number;
  /** Today's weather (it shows from WEATHER_START_FRACTION on; "clear" = none today). */
  weather: Weather;
  /** Today's planned event (before fallbacks) and what actually happened ("" until it ran). */
  event: DayEventKind;
  happened: DayEventKind | "";
}

export class WeatherSystem {
  private rewind = new ClockRewind();
  private rolledDay = 0;
  /** Last day-event mark run: (day − 1) × DAY_EVENT_FRACTIONS.length + index + 1. */
  private eventMark = 0;
  private weatherDay = 0;
  private today: Forecast = { day: 0, weather: "clear", event: "waveGift", happened: "" };
  private yesterdayWeather: Weather = "clear";
  private yesterdayEvent: DayEventKind | null = null;
  private reels: TreasureReels;
  private gifts: WaveGifts;

  constructor(
    protected ctx: WorldContext,
    protected monsters: MonsterSystem,
  ) {
    this.reels = new TreasureReels(ctx);
    this.gifts = new WaveGifts(ctx, this.reels);
  }

  /** RaftWorld step 1. `prev` null at playing start. */
  onClock(prev: ClockInfo | null, clock: ClockInfo): void {
    void prev;
    this.sync(clock);
  }

  /** Per tick (collector filling etc. stay in RaftWorld; this is for event timers such as the wave-gift reel). */
  step(): void {
    const st = this.ctx.state;
    if (st.phase === "playing") this.sync(clockAt(st.clockTicks, this.ctx.timings));
    this.gifts.step();
    this.reels.step();
  }

  clear(): void {
    this.ctx.state.weather = "clear";
    this.resetMarks();
    this.rewind.reset();
    this.gifts.clear();
    this.reels.clear();
  }

  /** A player left the room for good: drop their wave-gift treasure reel. */
  forget(id: string): void {
    this.reels.forget(id);
  }

  /** Ids this system keeps anything for (tests: nothing outlives its player). */
  trackedIds(): string[] {
    return this.reels.trackedIds();
  }

  /** Optional hook: RaftWorld reports a ground pickup (wave-gift treasure goes to exactly this player). */
  onPickup(p: PlayerState, projectileId: string): void {
    this.gifts.onPickup(p, projectileId);
  }

  /** Today's roll (HUD / bots / tests). */
  forecast(): Readonly<Forecast> {
    return this.today;
  }

  /* ------------------------------------------------------------ internals */

  private resetMarks(): void {
    this.rolledDay = 0;
    this.eventMark = 0;
    this.weatherDay = 0;
    this.yesterdayWeather = "clear";
    this.yesterdayEvent = null;
    this.today = { day: 0, weather: "clear", event: "waveGift", happened: "" };
  }

  private sync(clock: ClockInfo): void {
    if (this.rewind.rewound(clock, this.ctx.timings)) {
      this.resetMarks();
      this.gifts.clear();
    }
    if (clock.over) return;
    if (clock.dayPhase !== "day") {
      // Seen a day only after it ended (shouldn't happen): don't replay its morning.
      if (this.rolledDay < clock.day) {
        this.rolledDay = this.weatherDay = clock.day;
        this.eventMark = clock.day * DAY_EVENT_FRACTIONS.length;
      }
      return;
    }
    if (this.rolledDay < clock.day) this.dawn(clock.day);
    const f = phaseFraction(clock);
    // Two events a day (Long Tide §6), one at each DAY_EVENT_FRACTIONS mark; eventDay counts in half-days.
    for (let k = 0; k < DAY_EVENT_FRACTIONS.length; k++) {
      const mark = (clock.day - 1) * DAY_EVENT_FRACTIONS.length + k + 1;
      if (this.eventMark < mark && f >= DAY_EVENT_FRACTIONS[k]!) {
        this.eventMark = mark;
        this.runEvent(k);
      }
    }
    if (this.weatherDay < clock.day && f >= WEATHER_START_FRACTION) {
      this.weatherDay = clock.day;
      this.startWeather(clock.day);
    }
  }

  /** Dawn: yesterday's weather clears, today's weather and event are rolled. */
  private dawn(day: number): void {
    this.rolledDay = day;
    if (this.ctx.state.weather !== "clear") {
      this.ctx.state.weather = "clear";
      this.ctx.emit({ type: "weather", tick: this.ctx.tick(), day, weather: "clear" });
    }
    const weather = rollWeather(day, this.ctx.rng, this.yesterdayWeather);
    const event = rollDayEvent(this.ctx.rng, this.yesterdayEvent);
    this.today = { day, weather, event, happened: "" };
  }

  private startWeather(day: number): void {
    this.yesterdayWeather = this.today.weather;
    if (this.today.weather === "clear") return;
    this.ctx.state.weather = this.today.weather;
    this.ctx.emit({ type: "weather", tick: this.ctx.tick(), day, weather: this.today.weather });
  }

  /** Day event `k` of today: the first is the rolled one, the second a fresh roll that isn't the first. */
  private runEvent(k: number): void {
    if (this.ctx.state.teams.length === 0) return;
    const kind = k === 0 ? this.today.event : rollDayEvent(this.ctx.rng, this.today.happened || this.today.event);
    const happened = runDayEvent(this.ctx, this.monsters, this.gifts, kind, 0);
    if (k === 0) this.today.happened = happened;
    this.yesterdayEvent = happened;
  }
}
