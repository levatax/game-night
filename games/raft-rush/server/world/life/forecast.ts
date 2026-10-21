// Today's weather and day event (game4.md §6, §9). Owner: server-world-life. Pure (rng passed in).
//
// Weather: day 1 has one with DAY1_WEATHER_CHANCE, from day 2 on there is always one (WEATHER_IDS), never the
// same as yesterday's. Day event: one of DAY_EVENT_IDS, never yesterday's.

import { DAY1_WEATHER_CHANCE, DAY_EVENT_IDS, WEATHER_IDS } from "../../../shared/constants.js";
import type { DayEventKind, Weather } from "../../../shared/types.js";
import { pick, type Rng } from "./util.js";

/** Weather for `day` given yesterday's ("clear" when none). */
export function rollWeather(day: number, rng: Rng, yesterday: Weather): Weather {
  if (day <= 1 && rng() >= DAY1_WEATHER_CHANCE) return "clear";
  const pool = WEATHER_IDS.filter((w) => w !== yesterday);
  return pick(rng, pool.length > 0 ? pool : WEATHER_IDS) ?? "rain";
}

/** Day event for today given yesterday's (null on day 1). */
export function rollDayEvent(rng: Rng, yesterday: DayEventKind | null): DayEventKind {
  const pool = DAY_EVENT_IDS.filter((e) => e !== yesterday);
  return pick(rng, pool.length > 0 ? pool : DAY_EVENT_IDS) ?? "waveGift";
}

/** Fallback order when today's event can't happen (no fish for the gull, nothing for the monkeys). */
export function eventFallbacks(first: DayEventKind): DayEventKind[] {
  const rest = DAY_EVENT_IDS.filter((e) => e !== first && e !== "waveGift");
  return first === "waveGift" ? ["waveGift"] : [first, ...rest, "waveGift"];
}
