// DayNight: fog distances (§16), light levels, sun / moon and weather layering, and no visible jumps over a
// whole match. Owner: client-render.

import { describe, expect, it } from "vitest";
import { FOG_DAY, FOG_NIGHT, FOG_WEATHER_DISTANCE, NORMAL_TIMINGS } from "../../../../shared/constants";
import { cycleTicks, matchTicks } from "../../../../shared/rules/schedule";
import type { Biome, Phase } from "../../../../shared/types";
import { computeLighting, createLighting, type Lighting, type WeatherWeights } from "./DayNight";

const T = NORMAL_TIMINGS;
const CYC = cycleTicks(T);
const NOON = 0.3 * CYC;
const MIDNIGHT = (T.day + T.dusk + T.night * 0.5) ;
const CLEAR: WeatherWeights = { rain: 0, fog: 0, heat: 0, fullmoon: 0 };

function at(clockTicks: number, opts: { biome?: Biome; weather?: Partial<WeatherWeights>; storm?: number; phase?: Phase } = {}): Lighting {
  return computeLighting(
    {
      phase: opts.phase ?? "playing",
      clockTicks,
      timings: T,
      biome: opts.biome ?? "tropic",
      weather: { ...CLEAR, ...opts.weather },
      storm: opts.storm ?? 0,
    },
    createLighting(),
  );
}

describe("DayNight", () => {
  it("noon is bright: sun up, 160 m fog, no stars", () => {
    const l = at(NOON);
    expect(l.dayness).toBeGreaterThan(0.95);
    expect(l.dark).toBeLessThan(0.05);
    expect(l.fogFar).toBeCloseTo(FOG_DAY, 3);
    expect(l.sunDir.y).toBeGreaterThan(0.6);
    expect(l.keyDir.equals(l.sunDir)).toBe(true);
    expect(l.keyIntensity).toBeGreaterThan(2);
    expect(l.starAlpha).toBe(0);
  });

  it("midnight is dark: moon key, 45 m fog, stars and fireflies", () => {
    const l = at(MIDNIGHT);
    expect(l.dark).toBeGreaterThan(0.95);
    expect(l.fogFar).toBeCloseTo(FOG_NIGHT, 3);
    expect(l.moonDir.y).toBeGreaterThan(0.3);
    expect(l.keyDir.equals(l.moonDir)).toBe(true);
    expect(l.sunGlow).toBe(0);
    expect(l.starAlpha).toBeGreaterThan(0.5);
    expect(l.fireflies).toBeGreaterThan(0.5);
  });

  it("swamp fog caps the view at 30 m; fog weather at 25 m", () => {
    expect(at(NOON, { biome: "swamp" }).fogFar).toBeLessThanOrEqual(30);
    expect(at(NOON, { weather: { fog: 1 } }).fogFar).toBeCloseTo(FOG_WEATHER_DISTANCE, 3);
    expect(at(MIDNIGHT, { weather: { fog: 1 } }).fogFar).toBeCloseTo(FOG_WEATHER_DISTANCE, 3);
  });

  it("rain greys the sky, kills stars and fireflies, adds rain particles", () => {
    const clear = at(NOON);
    const rain = at(NOON, { weather: { rain: 1 } });
    expect(rain.rain).toBe(1);
    expect(rain.keyIntensity).toBeLessThan(clear.keyIntensity * 0.5);
    expect(rain.fogFar).toBeLessThanOrEqual(70);
    expect(at(MIDNIGHT, { weather: { rain: 1 } }).starAlpha).toBe(0);
    expect(at(MIDNIGHT, { weather: { rain: 1 } }).fireflies).toBe(0);
  });

  it("a full moon night is almost as bright as day", () => {
    const plain = at(MIDNIGHT);
    const moon = at(MIDNIGHT, { weather: { fullmoon: 1 } });
    expect(moon.dayness).toBeGreaterThan(plain.dayness + 0.2);
    expect(moon.fogFar).toBeGreaterThan(plain.fogFar * 2);
    expect(moon.moonSize).toBeLessThan(plain.moonSize);
  });

  it("the storm darkens, swells the sea and rains", () => {
    const s = at(NOON, { storm: 1 });
    expect(s.rain).toBe(1);
    expect(s.waveAmp).toBeGreaterThan(1);
    expect(s.wind).toBe(1);
    expect(s.keyIntensity).toBeLessThan(at(NOON).keyIntensity * 0.2);
    expect(s.stormClouds).toBe(1);
  });

  it("volcanic sky is red", () => {
    const l = at(NOON, { biome: "volcanic" });
    expect(l.skyHorizon.r).toBeGreaterThan(l.skyHorizon.b);
  });

  it("the lobby shows a fixed sunny morning whatever the clock", () => {
    const a = at(0, { phase: "lobby" });
    const b = at(MIDNIGHT, { phase: "lobby" });
    expect(a.cycle).toBe(b.cycle);
    expect(a.dayness).toBeGreaterThan(0.9);
  });

  it("nothing visible jumps over a whole match (including the day boundaries)", () => {
    const total = matchTicks(T);
    const step = 3;
    let prev = at(0);
    let worst = { key: 0, fog: 0, sky: 0, sun: 0 };
    for (let t = step; t < total; t += step) {
      const l = at(t);
      worst = {
        key: Math.max(worst.key, Math.abs(l.keyIntensity - prev.keyIntensity)),
        fog: Math.max(worst.fog, Math.abs(l.fogFar - prev.fogFar)),
        sky: Math.max(worst.sky, Math.abs(l.skyHorizon.r - prev.skyHorizon.r) + Math.abs(l.skyHorizon.g - prev.skyHorizon.g) + Math.abs(l.skyHorizon.b - prev.skyHorizon.b)),
        sun: Math.max(worst.sun, Math.abs(l.sunGlow - prev.sunGlow)),
      };
      prev = l;
    }
    expect(worst.key).toBeLessThan(0.2);
    expect(worst.fog).toBeLessThan(3);
    expect(worst.sky).toBeLessThan(0.05);
    expect(worst.sun).toBeLessThan(0.1);
  });
});
