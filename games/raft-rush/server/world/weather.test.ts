// WeatherSystem + day events against the fake WorldContext (server/world/life/testkit.ts).
// Owner: server-world-life.

import { describe, expect, it } from "vitest";
import { DAY1_WEATHER_CHANCE, DAY_EVENT_FRACTION, FAST_TIMINGS, PICKUP_RANGE, TREASURE_REEL_TICKS, WEATHER_IDS, WEATHER_START_FRACTION } from "../../shared/constants.js";
import { heightAt } from "../../shared/island/heightfield.js";
import { mulberry32 } from "../../shared/island/noise.js";
import type { DayEventKind, Weather } from "../../shared/types.js";
import type { WeatherEvent } from "../../shared/protocol.js";
import { WaveGifts } from "./life/dayEvents.js";
import { eventFallbacks, rollDayEvent, rollWeather } from "./life/forecast.js";
import { FakeWorld, type BenchOptions } from "./life/testkit.js";
import { TreasureReels } from "./life/treasure.js";
import { MonsterSystem } from "./monsters.js";
import { WeatherSystem } from "./weather.js";

function bench(o: BenchOptions = {}) {
  const w = new FakeWorld({ fast: true, ...o });
  const mon = new MonsterSystem(w);
  const sky = new WeatherSystem(w, mon);
  return { w, mon, sky };
}

/** Play the whole match clock (playing phase), stepping the weather system every tick. */
function playMatch(w: FakeWorld, sky: WeatherSystem, each?: () => void): void {
  const total = w.timings.days * (w.timings.day + w.timings.dusk + w.timings.night);
  w.setClock(0);
  sky.onClock(null, w.setClock(0));
  for (let t = 0; t < total - 1; t++) {
    w.state.tick++;
    const prev = w.setClock(w.state.clockTicks);
    const clock = w.setClock(w.state.clockTicks + 1);
    sky.onClock(prev, clock);
    sky.step();
    each?.();
  }
}

describe("forecast rolls", () => {
  it("day 1 has weather about DAY1_WEATHER_CHANCE of the time; days 2+ always", () => {
    const rng = mulberry32(42);
    let day1 = 0;
    const N = 4000;
    for (let k = 0; k < N; k++) {
      if (rollWeather(1, rng, "clear") !== "clear") day1++;
      expect(rollWeather(2, rng, "clear")).not.toBe("clear");
      expect(rollWeather(3, rng, "rain")).not.toBe("clear");
    }
    expect(Math.abs(day1 / N - DAY1_WEATHER_CHANCE)).toBeLessThan(0.03);
  });

  it("never repeats yesterday's weather or event", () => {
    const rng = mulberry32(7);
    for (const w of WEATHER_IDS) for (let k = 0; k < 200; k++) expect(rollWeather(2, rng, w)).not.toBe(w);
    for (const e of ["gull", "monkeys", "waveGift"] as DayEventKind[]) for (let k = 0; k < 200; k++) expect(rollDayEvent(rng, e)).not.toBe(e);
  });

  it("falls back from impossible events to the wave gift", () => {
    expect(eventFallbacks("gull")).toEqual(["gull", "monkeys", "waveGift"]);
    expect(eventFallbacks("monkeys")).toEqual(["monkeys", "gull", "waveGift"]);
    expect(eventFallbacks("waveGift")).toEqual(["waveGift"]);
  });
});

describe("weather schedule", () => {
  it("day 2+ always has weather; it starts mid-day, lasts the night and clears at dawn", () => {
    for (let seed = 1; seed <= 60; seed++) {
      const { w, sky } = bench({ seed });
      const seen: { day: number; dayPhase: string; frac: number; ev: WeatherEvent }[] = [];
      let lastCount = 0;
      const weatherByDay = new Map<number, Weather>();
      playMatch(w, sky, () => {
        const evs = w.ofType("weather");
        for (const ev of evs.slice(lastCount)) {
          const c = w.setClock(w.state.clockTicks);
          seen.push({ day: c.day, dayPhase: c.dayPhase, frac: c.phaseElapsed / c.phaseLength, ev });
        }
        lastCount = evs.length;
        // Through dusk and night the day's weather stays on.
        const c = w.setClock(w.state.clockTicks);
        if (c.dayPhase !== "day") weatherByDay.set(c.day, w.state.weather);
      });
      for (const day of [2, 3]) {
        const start = seen.find((s) => s.day === day && s.ev.weather !== "clear");
        expect(start, `seed ${seed} day ${day}`).toBeDefined();
        expect(start!.dayPhase).toBe("day");
        expect(start!.frac).toBeGreaterThanOrEqual(WEATHER_START_FRACTION - 1e-9);
        expect(start!.frac).toBeLessThan(WEATHER_START_FRACTION + 0.05);
        expect(weatherByDay.get(day)).toBe(start!.ev.weather);
      }
      // Yesterday's weather clears at dawn (an explicit "clear" event at the start of the day).
      for (const day of [2, 3]) {
        const prev = weatherByDay.get(day - 1);
        const clear = seen.find((s) => s.day === day && s.ev.weather === "clear");
        if (prev && prev !== "clear") {
          expect(clear).toBeDefined();
          expect(clear!.frac).toBeLessThan(0.05);
        } else expect(clear).toBeUndefined();
      }
      expect(weatherByDay.get(2)).not.toBe(weatherByDay.get(3));
    }
  });

  it("sets state.weather and the event payload", () => {
    const { w, sky } = bench({ seed: 3 });
    playMatch(w, sky);
    const evs = w.ofType("weather").filter((e) => e.weather !== "clear");
    expect(evs.length).toBeGreaterThanOrEqual(2);
    for (const e of evs) expect(WEATHER_IDS).toContain(e.weather);
    expect(w.state.weather).toBe(evs.at(-1)!.weather);
    sky.clear();
    expect(w.state.weather).toBe("clear");
  });

  it("fires each transition once even when the clock arrives from onClock and step both", () => {
    const { w, sky } = bench({ seed: 9 });
    playMatch(w, sky, () => sky.onClock(null, w.setClock(w.state.clockTicks)));
    expect(w.ofType("dayEvent")).toHaveLength(FAST_TIMINGS.days * 2);
    const starts = w.ofType("weather").filter((e) => e.weather !== "clear");
    expect(new Set(starts.map((e) => e.day)).size).toBe(starts.length);
  });

  it("a new match (the clock starts over) rolls everything again", () => {
    const { w, sky } = bench({ seed: 4 });
    playMatch(w, sky);
    const first = w.ofType("dayEvent").length;
    playMatch(w, sky);
    expect(w.ofType("dayEvent").length).toBe(first * 2);
  });
});

describe("day events", () => {
  it("two per day (Long Tide §6), the second never the first, and today's plan is never what happened last", () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { w, sky } = bench({ seed });
      const plans: DayEventKind[] = [];
      let lastDay = 0;
      playMatch(w, sky, () => {
        const f = sky.forecast();
        if (f.day !== lastDay && f.day > 0) {
          plans.push(f.event);
          lastDay = f.day;
        }
      });
      const evs = w.ofType("dayEvent");
      expect(evs).toHaveLength(FAST_TIMINGS.days * 2);
      expect(plans).toHaveLength(FAST_TIMINGS.days);
      for (let k = 1; k < plans.length; k++) expect(plans[k]).not.toBe(evs[2 * k - 1]!.kind);
      for (let d = 0; d < FAST_TIMINGS.days; d++) {
        if (evs[2 * d]!.kind !== "waveGift") expect(evs[2 * d + 1]!.kind).not.toBe(evs[2 * d]!.kind);
      }
    }
  });

  it("the first event lands at 25% of the day", () => {
    const { w, sky } = bench({ seed: 2 });
    let at = -1;
    playMatch(w, sky, () => {
      if (at < 0 && w.ofType("dayEvent").length > 0) at = w.state.clockTicks;
    });
    expect(at).toBe(Math.ceil(w.timings.day * DAY_EVENT_FRACTION));
  });

  it("the gull goes for a player with a raw fish", () => {
    for (let seed = 1; seed < 80; seed++) {
      const { w, sky } = bench({ seed });
      const ana = w.addPlayer("ana", 6, 8);
      ana.inv0 = "fish_raw";
      ana.cnt0 = 1;
      w.setClock(0);
      sky.step();
      if (sky.forecast().event !== "gull") continue;
      w.setClock(Math.ceil(w.timings.day * DAY_EVENT_FRACTION));
      sky.step();
      expect(w.ofType("dayEvent")[0]).toMatchObject({ kind: "gull", playerId: "ana" });
      const gull = [...w.state.monsters.values()].find((m) => m.kind === "gull");
      expect(gull?.targetId).toBe("ana");
      return;
    }
    throw new Error("no seed rolled a gull day");
  });

  it("without any fish the gull day becomes monkeys (chest stocked) or a wave gift", () => {
    let checked = 0;
    for (let seed = 1; seed < 200 && checked < 6; seed++) {
      const { w, sky } = bench({ seed });
      if (checked % 2 === 1) w.team(0).chest.set("wood", 3);
      w.setClock(0);
      sky.step();
      if (sky.forecast().event !== "gull") continue;
      w.setClock(Math.ceil(w.timings.day * DAY_EVENT_FRACTION));
      sky.step();
      const ev = w.ofType("dayEvent")[0]!;
      expect(ev.kind).toBe(checked % 2 === 1 ? "monkeys" : "waveGift");
      expect(sky.forecast().happened).toBe(ev.kind);
      checked++;
    }
    expect(checked).toBe(6);
  });

  it("a wave gift: 3 resting items (2 materials + a coconut) on dry sand", () => {
    const w = new FakeWorld({ seed: 5 });
    const gifts = new WaveGifts(w, new TreasureReels(w));
    const pos = gifts.spawn(0);
    expect(w.ofType("dayEvent")[0]).toMatchObject({ kind: "waveGift", playerId: "" });
    const items = [...w.state.projectiles.values()];
    expect(items).toHaveLength(3);
    expect(items.filter((p) => p.kind === "coconut").length).toBeGreaterThanOrEqual(1);
    expect(items.filter((p) => ["wood", "rope", "stone"].includes(p.kind))).toHaveLength(2);
    for (const p of items) {
      expect(p.state).toBe("rest");
      expect(heightAt(w.island.grid, p.x, p.z)).toBeGreaterThanOrEqual(0.15);
      expect(Math.hypot(p.x - pos.x, p.z - pos.z)).toBeLessThan(2);
    }
  });

  it("25%: the first picker of a wave gift also spins a treasure reel", () => {
    // rng: cell, material, material, treasure roll (0.1 < 0.25 → yes), then the stream.
    const base = mulberry32(1);
    const q = [0.1, 0.2, 0.7, 0.1];
    const w = new FakeWorld({ rng: () => (q.length > 0 ? q.shift()! : base()) });
    const reels = new TreasureReels(w);
    const gifts = new WaveGifts(w, reels);
    gifts.spawn(0);
    expect(gifts.hasTreasure()).toBe(true);
    const [first, second] = [...w.state.projectiles.values()];
    const bob = w.addPlayer("bob", first!.x + PICKUP_RANGE * 0.5, first!.z);
    w.addPlayer("far", first!.x + 15, first!.z);
    w.removeProjectile(first!.id);
    w.state.tick++;
    gifts.step();
    reels.step();
    expect(w.ofType("treasure")).toHaveLength(1);
    expect(w.ofType("treasure")[0]).toMatchObject({ playerId: "bob", source: "waveGift" });
    for (let k = 0; k < TREASURE_REEL_TICKS; k++) {
      w.state.tick++;
      reels.step();
    }
    expect(w.treasures.map((t) => t.playerId)).toEqual(["bob"]);
    // The second pickup is just an item.
    w.place(bob, second!.x, second!.z);
    gifts.onPickup(bob, second!.id);
    w.removeProjectile(second!.id);
    gifts.step();
    expect(w.ofType("treasure")).toHaveLength(1);
  });

  it("no treasure on a plain gift, and despawned gifts give nothing", () => {
    const base = mulberry32(2);
    const q = [0.1, 0.2, 0.7, 0.9];
    const w = new FakeWorld({ rng: () => (q.length > 0 ? q.shift()! : base()) });
    const gifts = new WaveGifts(w, new TreasureReels(w));
    gifts.spawn(0);
    expect(gifts.hasTreasure()).toBe(false);
    for (const p of [...w.state.projectiles.values()]) w.removeProjectile(p.id);
    gifts.step();
    expect(gifts.ids()).toHaveLength(0);
    expect(w.ofType("treasure")).toHaveLength(0);
  });

  it("the onPickup hook gives the treasure to exactly that player", () => {
    const base = mulberry32(3);
    const q = [0.1, 0.2, 0.7, 0.1];
    const w = new FakeWorld({ rng: () => (q.length > 0 ? q.shift()! : base()) });
    const gifts = new WaveGifts(w, new TreasureReels(w));
    gifts.spawn(0);
    const first = [...w.state.projectiles.values()][0]!;
    const cleo = w.addPlayer("cleo", 0, 0);
    gifts.onPickup(cleo, first.id);
    expect(w.ofType("treasure")[0]).toMatchObject({ playerId: "cleo", source: "waveGift" });
  });

  it("a leaver's treasure reels are forgotten; everyone else's still land", () => {
    const { w, sky } = bench();
    const reels = new TreasureReels(w);
    const gone = w.addPlayer("gone", 0, 0);
    const stays = w.addPlayer("stays", 1, 0);
    reels.start(gone, "secretChest");
    reels.start(gone, "secretChest");
    reels.start(stays, "waveGift");
    expect(reels.trackedIds().sort()).toEqual(["gone", "stays"]);
    reels.forget("gone");
    expect(reels.trackedIds()).toEqual(["stays"]);
    for (let k = 0; k < 2 * TREASURE_REEL_TICKS + 1; k++) {
      w.state.tick++;
      reels.step();
    }
    expect(w.treasures.map((t) => t.playerId)).toEqual(["stays"]);
    expect(reels.trackedIds()).toEqual([]);
    sky.forget("gone");
    expect(sky.trackedIds()).toEqual([]);
  });
});
