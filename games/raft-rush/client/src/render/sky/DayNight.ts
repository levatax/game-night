// The look of the island at any moment: sun / moon directions from the match clock (shared/rules/schedule.ts
// clockAt → cycle), key / hemisphere light colors and intensities, sky gradient, fog distances (§16: 160 m day /
// 45 m night, swamp 30, fog weather 25), sea colors (day blue → night navy), cloud tint, stars, fireflies,
// wind and wave height, with weather (rain / fog / heat wave / full moon), biome (volcanic red sky, swamp fog)
// and the storm layered on top. Pure math over reusable output objects (no allocation per frame); Renderer
// pushes the result into lights, fog, SkyDome, Water and the rest. Owner: client-render.
//
// Look (2026-11 color pass): naturalistic, slightly desaturated tropics, not neon. The biome colors of
// shared/constants.ts are muted here at parse time (mutedPalette: less saturation, lower value; the sea pulled
// toward a deep teal-navy), daylight is softer (key 2.15, hemi 0.9, near-neutral sky fill instead of a cyan
// one), dawn / dusk warm but restrained, nights a genuinely dark blue-black where the campfire, torches and
// light rings carry the scene, rain / storm grey and desaturated. Fog starts at ~13% of its far distance by day
// so the bigger island fades into a muted horizon haze with distance. The sky dome and fog are not tone mapped
// on the direct render path (fog mixes after the grade), so these colors are close to final.

import * as THREE from "three";
import { BIOMES, FOG_DAY, FOG_NIGHT, FOG_WEATHER_DISTANCE, type Timings } from "../../../../shared/constants";
import { clockAt } from "../../../../shared/rules/schedule";
import type { Biome, Phase } from "../../../../shared/types";

/** Smoothed 0..1 weights of the current weather (Renderer eases them so weather fades in / out). */
export interface WeatherWeights {
  rain: number;
  fog: number;
  heat: number;
  fullmoon: number;
}

export interface DayNightInput {
  phase: Phase;
  clockTicks: number;
  timings: Readonly<Timings>;
  biome: Biome;
  weather: WeatherWeights;
  /** 0..1 storm (WorldFrame.storm). */
  storm: number;
}

export interface Lighting {
  /** 0..1 through the day's cycle (clockAt().cycle). */
  cycle: number;
  /** 0 (night) .. 1 (full daylight) visual light level. */
  dayness: number;
  /** 0 (day) .. 1 (night): characters' nameplates, fireflies, torches' visual weight. */
  dark: number;
  sunDir: THREE.Vector3;
  moonDir: THREE.Vector3;
  /** Directional key light: sun by day, moon by night (direction TO the light). */
  keyDir: THREE.Vector3;
  keyColor: THREE.Color;
  keyIntensity: number;
  hemiSky: THREE.Color;
  hemiGround: THREE.Color;
  hemiIntensity: number;
  skyTop: THREE.Color;
  skyHorizon: THREE.Color;
  skyBelow: THREE.Color;
  fogColor: THREE.Color;
  /** 0..1 how much the dome itself melts into the fog. */
  fogAmount: number;
  fogNear: number;
  fogFar: number;
  sunColor: THREE.Color;
  sunSize: number;
  sunGlow: number;
  moonColor: THREE.Color;
  moonSize: number;
  moonGlow: number;
  sea: THREE.Color;
  seaShallow: THREE.Color;
  seaDeep: THREE.Color;
  foam: THREE.Color;
  /** Water glints (sun sparkles by day, the moon path by night). */
  glint: number;
  cloudTint: THREE.Color;
  /** 0..1 size of the storm / rain cloud layer. */
  stormClouds: number;
  starAlpha: number;
  fireflies: number;
  /** 0..1 flora sway strength. */
  wind: number;
  /** Wave amplitude (m). */
  waveAmp: number;
  /** 0..1 rain particle density. */
  rain: number;
}

export function createLighting(): Lighting {
  return {
    cycle: 0,
    dayness: 1,
    dark: 0,
    sunDir: new THREE.Vector3(0, 1, 0),
    moonDir: new THREE.Vector3(0, -1, 0),
    keyDir: new THREE.Vector3(0, 1, 0),
    keyColor: new THREE.Color(),
    keyIntensity: 1,
    hemiSky: new THREE.Color(),
    hemiGround: new THREE.Color(),
    hemiIntensity: 1,
    skyTop: new THREE.Color(),
    skyHorizon: new THREE.Color(),
    skyBelow: new THREE.Color(),
    fogColor: new THREE.Color(),
    fogAmount: 0,
    fogNear: 40,
    fogFar: FOG_DAY,
    sunColor: new THREE.Color(),
    sunSize: 0.9988,
    sunGlow: 1,
    moonColor: new THREE.Color(),
    moonSize: 0.9993,
    moonGlow: 0,
    sea: new THREE.Color(),
    seaShallow: new THREE.Color(),
    seaDeep: new THREE.Color(),
    foam: new THREE.Color(),
    glint: 1,
    cloudTint: new THREE.Color(),
    stormClouds: 0,
    starAlpha: 0,
    fireflies: 0,
    wind: 0.3,
    waveAmp: 0.12,
    rain: 0,
  };
}

/** Lobby / menus show a sunny morning. */
const LOBBY_CYCLE = 0.3;

/** Per-biome color sets, parsed once and muted (linear THREE colors). */
interface BiomePalette {
  sky: THREE.Color;
  skyDusk: THREE.Color;
  skyNight: THREE.Color;
  sea: THREE.Color;
  sand: THREE.Color;
  grass: THREE.Color;
}
const palettes = new Map<Biome, BiomePalette>();
function biomePalette(b: Biome): BiomePalette {
  let p = palettes.get(b);
  if (!p) {
    const c = BIOMES[b].colors;
    p = {
      sky: mute(new THREE.Color(c.sky), 0.7, 0.78),
      skyDusk: mute(new THREE.Color(c.skyDusk), 0.68, 0.84),
      skyNight: mute(new THREE.Color(c.skyNight), 0.85, 0.72),
      sea: new THREE.Color(c.sea).lerp(SEA_DAY, 0.84),
      sand: mute(new THREE.Color(c.sand), 0.6, 0.78),
      grass: mute(new THREE.Color(c.grass), 0.6, 0.72),
    };
    palettes.set(b, p);
  }
  return p;
}

const C = (hex: string) => new THREE.Color(hex);
/** Midday sun: warm white, not paper white. */
const SUN_DAY = C("#FFF0D6");
/** Golden hour / sunset key: warm amber, kept short of orange. */
const SUN_GOLD = C("#F0AE7C");
const SUN_DAWN = C("#ECC0A6");
const MOON_LIGHT = C("#8C9FCF");
const MOON_DISC = C("#E9E6D8");
/** Daytime sea every biome's sea color is pulled toward (deep teal-navy, not cyan). */
const SEA_DAY = C("#1B4F5E");
const SEA_NIGHT = C("#0B1C2B");
/** Shallow water over sand: muted turquoise. */
const SHALLOW_TINT = C("#5E9E96");
const NIGHT_HORIZON = C("#1A2B45");
/** Daytime sky fill is mostly neutral (a cyan fill turned every surface minty). */
const HEMI_DAY_NEUTRAL = C("#C9CCC4");
const HEMI_NIGHT_SKY = C("#2C3A5C");
const HEMI_NIGHT_GROUND = C("#11151E");
const HEMI_MOON_SKY = C("#6878A2");
/** Horizon haze the day sky melts into (warm grey; the fog color by day). */
const DAY_HAZE = C("#CDD1CA");
const RAIN_SKY_DAY = C("#7B8184");
const RAIN_SKY_NIGHT = C("#1D2126");
const FOG_DAY_COLOR = C("#B6BDBC");
const FOG_NIGHT_COLOR = C("#29313A");
const HEAT_HORIZON = C("#E6D6B2");
const STORM_TOP = C("#1B1E25");
const STORM_HORIZON = C("#383B42");
const STORM_HEMI = C("#474B56");
const STORM_SEA = C("#243840");
const FOAM_DAY = C("#E2E5DF");
const FOAM_NIGHT = C("#5D6A7E");
const CLOUD_DAY = C("#E9EBE8");
const CLOUD_DUSK = C("#D9AF9B");
const CLOUD_NIGHT = C("#222937");
const CLOUD_RAIN = C("#83888C");
const SWAMP_FOG = C("#91A499");
const VOLCANIC_GROUND = C("#4A2A24");
const LUMA = new THREE.Vector3(0.2126, 0.7152, 0.0722);

const tmp = new THREE.Color();
const tmp2 = new THREE.Color();

/** Pull a (linear) color toward its own luma by 1 - `sat`, then scale its value. Parse-time only. */
function mute(c: THREE.Color, sat: number, value: number): THREE.Color {
  const l = c.r * LUMA.x + c.g * LUMA.y + c.b * LUMA.z;
  return c.lerp(new THREE.Color(l, l, l), 1 - sat).multiplyScalar(value);
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Fill `out` for this frame. */
export function computeLighting(input: DayNightInput, out: Lighting): Lighting {
  const t = input.timings;
  const cyc = t.day + t.dusk + t.night;
  const dayEnd = t.day / cyc;
  const duskEnd = (t.day + t.dusk) / cyc;
  const c = input.phase === "lobby" ? LOBBY_CYCLE : clockAt(input.clockTicks, t).cycle;
  out.cycle = c;
  const wx = input.weather;
  const storm = Math.min(1, Math.max(0, input.storm));
  const pal = biomePalette(input.biome);
  const biome = BIOMES[input.biome];

  // --- Light level and warmth over the cycle.
  let light: number;
  if (c < dayEnd) light = 0.32 + 0.68 * smooth(0, 0.14, c / dayEnd);
  else if (c < duskEnd) light = 1 - 0.85 * smooth(0, 1, (c - dayEnd) / (duskEnd - dayEnd));
  else light = 0.12 + smooth(0.9, 1, (c - duskEnd) / (1 - duskEnd)) * 0.2;
  const nightness = 1 - smooth(0.15, 0.6, light);
  // A full moon makes the night almost as bright as day (§9).
  light = Math.max(light, 0.12 + 0.43 * wx.fullmoon * nightness);
  const dayness = smooth(0.12, 1, light);
  out.dayness = dayness;
  out.dark = 1 - smooth(0.15, 0.85, light) * (1 - storm * 0.6);
  // Dawn glow: builds over the end of the night and fades during the first part of the day (continuous).
  const preDawn = c >= duskEnd ? smooth(0.82, 1, (c - duskEnd) / (1 - duskEnd)) : 0;
  const dawnWarm = c < dayEnd ? 1 - smooth(0, 0.12, c / dayEnd) : preDawn;
  const sunsetWarm = smooth(dayEnd - 0.1, dayEnd, c) * (1 - smooth(duskEnd - 0.01, duskEnd + 0.06, c));
  const warm = Math.max(dawnWarm, sunsetWarm);

  // --- Sun and moon paths (east → west; the moon on the north side of the sky).
  const sunsetC = dayEnd + 0.55 * (duskEnd - dayEnd);
  // Sunrise a moment after the day starts (the sun climbs out of the sea instead of popping up at dawn).
  const theta = (Math.PI * (c - 0.012)) / (sunsetC - 0.012);
  out.sunDir.set(Math.cos(theta), Math.sin(theta) * 1.1, 0.45).normalize();
  const m0 = dayEnd + 0.5 * (duskEnd - dayEnd);
  const phi = (Math.PI * (c - m0)) / (0.995 - m0);
  out.moonDir.set(Math.cos(phi), c >= m0 ? Math.sin(phi) * 0.95 : -0.5, -0.55).normalize();
  const sunUp = smooth(-0.03, 0.12, out.sunDir.y);
  const moonUp = smooth(-0.02, 0.1, out.moonDir.y);

  // --- Key light.
  const moonStrength = lerp(0.38, 1.0, wx.fullmoon);
  if (out.sunDir.y > -0.05) {
    out.keyDir.copy(out.sunDir);
    out.keyColor.copy(SUN_DAY).lerp(SUN_GOLD, sunsetWarm * 0.8).lerp(SUN_DAWN, dawnWarm * 0.6);
    out.keyIntensity = 2.15 * sunUp * (0.55 + 0.45 * dayness);
  } else {
    out.keyDir.copy(out.moonDir);
    out.keyColor.copy(MOON_LIGHT);
    // Fade in as the sun sinks so the sun → moon hand-over never pops.
    out.keyIntensity = moonStrength * moonUp * nightness * smooth(-0.05, -0.25, out.sunDir.y);
  }
  out.keyColor.lerp(SUN_GOLD, wx.heat * 0.2 * sunUp);
  out.keyIntensity *= 1 + wx.heat * 0.08;
  out.keyIntensity *= 1 - 0.6 * wx.rain;
  out.keyIntensity *= 1 - 0.85 * storm;
  out.keyIntensity *= 1 - 0.35 * wx.fog;

  // --- Hemisphere (ambient).
  tmp.copy(pal.sky).lerp(HEMI_DAY_NEUTRAL, 0.45);
  tmp2.copy(pal.grass).lerp(pal.sand, 0.5).multiplyScalar(0.6);
  out.hemiSky.copy(HEMI_NIGHT_SKY).lerp(HEMI_MOON_SKY, wx.fullmoon).lerp(tmp, dayness).lerp(pal.skyDusk, warm * 0.4);
  out.hemiGround.copy(HEMI_NIGHT_GROUND).lerp(tmp2, dayness);
  if (input.biome === "volcanic") out.hemiGround.lerp(VOLCANIC_GROUND, 0.35);
  out.hemiIntensity = lerp(lerp(0.34, 0.62, wx.fullmoon), 0.9, dayness);
  out.hemiSky.lerp(RAIN_SKY_DAY, wx.rain * 0.65);
  out.hemiIntensity *= 1 - 0.22 * wx.rain;
  out.hemiSky.lerp(STORM_HEMI, storm * 0.8);
  out.hemiIntensity *= 1 - 0.4 * storm;

  // --- Sky gradient.
  const dayTop = tmp.copy(pal.sky).multiplyScalar(0.7);
  const nightTop = pal.skyNight;
  out.skyTop.copy(nightTop).lerp(dayTop, dayness);
  out.skyHorizon.copy(pal.skyNight).lerp(NIGHT_HORIZON, input.biome === "volcanic" ? 0.15 : 0.55);
  if (input.biome === "volcanic") out.skyHorizon.lerp(pal.skyDusk, 0.35);
  out.skyHorizon.lerp(tmp2.copy(pal.sky).lerp(DAY_HAZE, 0.5), dayness);
  // Golden hour / dusk / dawn.
  out.skyTop.lerp(tmp2.copy(pal.sky).lerp(pal.skyNight, 0.5), warm * 0.55);
  out.skyHorizon.lerp(pal.skyDusk, warm * 0.8);
  // Heat wave: pale, hazy, warm.
  out.skyHorizon.lerp(HEAT_HORIZON, wx.heat * 0.45 * dayness);
  out.skyTop.lerp(DAY_HAZE, wx.heat * 0.15 * dayness);
  // Rain: grey sky.
  tmp2.copy(RAIN_SKY_NIGHT).lerp(RAIN_SKY_DAY, dayness);
  out.skyTop.lerp(tmp2, wx.rain * 0.75);
  out.skyHorizon.lerp(tmp2, wx.rain * 0.7);
  // Storm: bruised dark sky.
  out.skyTop.lerp(STORM_TOP, storm * 0.85);
  out.skyHorizon.lerp(STORM_HORIZON, storm * 0.8);

  // --- Fog.
  let far = lerp(lerp(FOG_NIGHT, 120, wx.fullmoon), FOG_DAY, dayness);
  if (biome.fog > 0) far = Math.min(far, biome.fog);
  far = lerp(far, Math.min(far, 120), wx.heat);
  far = lerp(far, Math.min(far, 70), wx.rain);
  far = lerp(far, Math.min(far, 55), storm);
  far = lerp(far, FOG_WEATHER_DISTANCE, wx.fog);
  out.fogFar = far;
  // Haze starts early by day (aerial perspective across the island), a little later at night.
  out.fogNear = Math.max(2, far * lerp(lerp(0.2, 0.13, dayness), 0.08, Math.max(wx.fog, biome.fog > 0 ? 0.6 : 0)));
  out.fogColor.copy(out.skyHorizon);
  if (biome.fog > 0) out.fogColor.lerp(tmp2.copy(SWAMP_FOG).multiplyScalar(lerp(0.25, 1, dayness)), 0.55);
  tmp2.copy(FOG_NIGHT_COLOR).lerp(FOG_DAY_COLOR, dayness);
  out.fogColor.lerp(tmp2, wx.fog * 0.85);
  out.skyHorizon.lerp(out.fogColor, Math.max(wx.fog * 0.8, biome.fog > 0 ? 0.35 : 0));
  out.fogAmount = Math.min(0.95, wx.fog * 0.85 + (biome.fog > 0 ? 0.35 : 0) + wx.rain * 0.15 + storm * 0.2);

  // --- Sun / moon discs.
  out.sunColor.copy(SUN_DAY).lerp(SUN_GOLD, warm);
  out.sunSize = lerp(0.9988, 0.9976, wx.heat);
  out.sunGlow = sunUp * (1 - 0.75 * wx.rain) * (1 - 0.9 * storm) * (1 - 0.5 * wx.fog) * lerp(0.75, 1.1, warm);
  out.moonColor.copy(MOON_DISC);
  out.moonSize = lerp(0.9993, 0.9984, wx.fullmoon);
  out.moonGlow = moonUp * (1 - 0.8 * wx.rain) * (1 - storm) * (1 - 0.6 * wx.fog) * (0.6 + 0.4 * nightness);
  // Below the horizon the dome shows the same haze the sea's far rim fades into (no visible plane edge).
  out.skyBelow.copy(out.fogColor);

  // --- Sea.
  out.sea.copy(SEA_NIGHT).lerp(pal.sea, dayness).lerp(pal.skyDusk, warm * 0.1);
  out.sea.lerp(STORM_SEA, storm * 0.7).lerp(RAIN_SKY_DAY, wx.rain * 0.25 * dayness);
  out.seaShallow.copy(out.sea).lerp(SHALLOW_TINT, 0.55 * lerp(0.3, 1, dayness) * (1 - 0.6 * storm));
  out.seaDeep.copy(out.sea).multiplyScalar(0.6);
  out.foam.copy(FOAM_NIGHT).lerp(FOAM_DAY, dayness).lerp(RAIN_SKY_DAY, Math.max(wx.rain * 0.3, storm * 0.4));
  out.glint = Math.max(sunUp * 0.9, moonUp * nightness * lerp(0.9, 1.6, wx.fullmoon)) * (1 - 0.7 * wx.rain) * (1 - storm * 0.8) * (1 - wx.fog * 0.6);

  // --- Clouds, stars, fireflies, wind, waves, rain.
  out.cloudTint.copy(CLOUD_NIGHT).lerp(CLOUD_DAY, dayness).lerp(CLOUD_DUSK, warm * 0.7);
  out.cloudTint.lerp(CLOUD_RAIN, wx.rain * 0.7 * lerp(0.4, 1, dayness)).lerp(STORM_HORIZON, storm * 0.7);
  if (input.biome === "volcanic") out.cloudTint.lerp(pal.skyDusk, 0.25);
  out.stormClouds = Math.max(wx.rain * 0.85, storm);
  out.starAlpha = smooth(0.25, 0.85, nightness) * (1 - wx.rain) * (1 - storm) * (1 - wx.fog * 0.85) * lerp(1, 0.45, wx.fullmoon);
  out.fireflies = smooth(0.3, 0.9, nightness) * (1 - wx.rain) * (1 - storm);
  out.wind = Math.min(1, 0.25 + wx.rain * 0.35 + storm * 0.75);
  out.waveAmp = 0.12 + wx.rain * 0.1 + storm * 1.0;
  out.rain = Math.max(wx.rain, storm);
  return out;
}
