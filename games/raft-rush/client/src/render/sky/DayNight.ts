// The look of the island at any moment: sun / moon directions from the match clock (shared/rules/schedule.ts
// clockAt → cycle), key / hemisphere light colors and intensities, sky gradient, fog distances (§16: 160 m day /
// 45 m night, swamp 30, fog weather 25), sea colors (day blue → night navy), cloud tint, stars, fireflies,
// wind and wave height, with weather (rain / fog / heat wave / full moon), biome (volcanic red sky, swamp fog)
// and the storm layered on top. Pure math over reusable output objects (no allocation per frame); Renderer
// pushes the result into lights, fog, SkyDome, Water and the rest. Owner: client-render.

import * as THREE from "three";
import { BIOMES, FOG_DAY, FOG_NIGHT, FOG_WEATHER_DISTANCE, PALETTE, type Timings } from "../../../../shared/constants";
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

/** Per-biome color sets, parsed once (linear THREE colors). */
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
      sky: new THREE.Color(c.sky),
      skyDusk: new THREE.Color(c.skyDusk),
      skyNight: new THREE.Color(c.skyNight),
      sea: new THREE.Color(c.sea),
      sand: new THREE.Color(c.sand),
      grass: new THREE.Color(c.grass),
    };
    palettes.set(b, p);
  }
  return p;
}

const C = (hex: string) => new THREE.Color(hex);
const WHITE = C("#FFFFFF");
const SUN_DAY = C("#FFF4DC");
const SUN_GOLD = C("#FFB070");
const SUN_DAWN = C("#FFC6A8");
const MOON_LIGHT = C("#9FB7FF");
const MOON_DISC = C("#F4F1E2");
const SEA_NIGHT = C(PALETTE.seaNight);
const SHALLOW_TINT = C("#9FF0E6");
const NIGHT_HORIZON = C("#24406E");
const HEMI_NIGHT_SKY = C("#3A4C7A");
const HEMI_NIGHT_GROUND = C("#1A2233");
const HEMI_MOON_SKY = C("#7A8EC4");
const RAIN_SKY_DAY = C("#7E8A96");
const RAIN_SKY_NIGHT = C("#262C36");
const FOG_DAY_COLOR = C("#C8D2D4");
const FOG_NIGHT_COLOR = C("#3A4652");
const HEAT_HORIZON = C("#FFE7B0");
const STORM_TOP = C("#1E2230");
const STORM_HORIZON = C("#3B4150");
const STORM_HEMI = C("#4A5068");
const STORM_SEA = C("#2C4A55");
const FOAM_NIGHT = C("#9FB0D0");
const CLOUD_DUSK = C("#FFC2A8");
const CLOUD_NIGHT = C("#3A4666");
const CLOUD_RAIN = C("#8A939E");
const SWAMP_FOG = C("#A9C2B5");
const VOLCANIC_GROUND = C("#5A2A22");

const tmp = new THREE.Color();
const tmp2 = new THREE.Color();

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
  const moonStrength = lerp(0.5, 1.25, wx.fullmoon);
  if (out.sunDir.y > -0.05) {
    out.keyDir.copy(out.sunDir);
    out.keyColor.copy(SUN_DAY).lerp(SUN_GOLD, sunsetWarm * 0.85).lerp(SUN_DAWN, dawnWarm * 0.6);
    out.keyIntensity = 2.6 * sunUp * (0.55 + 0.45 * dayness);
  } else {
    out.keyDir.copy(out.moonDir);
    out.keyColor.copy(MOON_LIGHT);
    // Fade in as the sun sinks so the sun → moon hand-over never pops.
    out.keyIntensity = moonStrength * moonUp * nightness * smooth(-0.05, -0.25, out.sunDir.y);
  }
  out.keyColor.lerp(SUN_GOLD, wx.heat * 0.25 * sunUp);
  out.keyIntensity *= 1 + wx.heat * 0.1;
  out.keyIntensity *= 1 - 0.6 * wx.rain;
  out.keyIntensity *= 1 - 0.85 * storm;
  out.keyIntensity *= 1 - 0.35 * wx.fog;

  // --- Hemisphere (ambient).
  tmp.copy(pal.sky).lerp(WHITE, 0.3);
  tmp2.copy(pal.grass).lerp(pal.sand, 0.5).multiplyScalar(0.7);
  out.hemiSky.copy(HEMI_NIGHT_SKY).lerp(HEMI_MOON_SKY, wx.fullmoon).lerp(tmp, dayness).lerp(pal.skyDusk, warm * 0.5);
  out.hemiGround.copy(HEMI_NIGHT_GROUND).lerp(tmp2, dayness);
  if (input.biome === "volcanic") out.hemiGround.lerp(VOLCANIC_GROUND, 0.35);
  out.hemiIntensity = lerp(lerp(0.42, 0.8, wx.fullmoon), 1.08, dayness);
  out.hemiSky.lerp(RAIN_SKY_DAY, wx.rain * 0.5);
  out.hemiIntensity *= 1 - 0.2 * wx.rain;
  out.hemiSky.lerp(STORM_HEMI, storm * 0.8);
  out.hemiIntensity *= 1 - 0.4 * storm;

  // --- Sky gradient.
  const dayTop = tmp.copy(pal.sky).multiplyScalar(0.72);
  const nightTop = pal.skyNight;
  out.skyTop.copy(nightTop).lerp(dayTop, dayness);
  out.skyHorizon.copy(pal.skyNight).lerp(NIGHT_HORIZON, input.biome === "volcanic" ? 0.15 : 0.55);
  if (input.biome === "volcanic") out.skyHorizon.lerp(pal.skyDusk, 0.35);
  out.skyHorizon.lerp(tmp2.copy(pal.sky).lerp(WHITE, 0.45), dayness);
  // Golden hour / dusk / dawn.
  out.skyTop.lerp(tmp2.copy(pal.sky).lerp(pal.skyNight, 0.5), warm * 0.55);
  out.skyHorizon.lerp(pal.skyDusk, warm * 0.9);
  // Heat wave: pale, hazy, warm.
  out.skyHorizon.lerp(HEAT_HORIZON, wx.heat * 0.45 * dayness);
  out.skyTop.lerp(WHITE, wx.heat * 0.12 * dayness);
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
  out.fogNear = Math.max(2, far * lerp(0.22, 0.08, Math.max(wx.fog, biome.fog > 0 ? 0.6 : 0)));
  out.fogColor.copy(out.skyHorizon);
  if (biome.fog > 0) out.fogColor.lerp(tmp2.copy(SWAMP_FOG).multiplyScalar(lerp(0.25, 1, dayness)), 0.55);
  tmp2.copy(FOG_NIGHT_COLOR).lerp(FOG_DAY_COLOR, dayness);
  out.fogColor.lerp(tmp2, wx.fog * 0.85);
  out.skyHorizon.lerp(out.fogColor, Math.max(wx.fog * 0.8, biome.fog > 0 ? 0.35 : 0));
  out.fogAmount = Math.min(0.95, wx.fog * 0.85 + (biome.fog > 0 ? 0.35 : 0) + wx.rain * 0.15 + storm * 0.2);

  // --- Sun / moon discs.
  out.sunColor.copy(SUN_DAY).lerp(SUN_GOLD, warm);
  out.sunSize = lerp(0.9988, 0.9976, wx.heat);
  out.sunGlow = sunUp * (1 - 0.75 * wx.rain) * (1 - 0.9 * storm) * (1 - 0.5 * wx.fog) * lerp(0.9, 1.3, warm);
  out.moonColor.copy(MOON_DISC);
  out.moonSize = lerp(0.9993, 0.9984, wx.fullmoon);
  out.moonGlow = moonUp * (1 - 0.8 * wx.rain) * (1 - storm) * (1 - 0.6 * wx.fog) * (0.6 + 0.4 * nightness);
  // Below the horizon the dome shows the same haze the sea's far rim fades into (no visible plane edge).
  out.skyBelow.copy(out.fogColor);

  // --- Sea.
  out.sea.copy(SEA_NIGHT).lerp(pal.sea, dayness).lerp(pal.skyDusk, warm * 0.12);
  out.sea.lerp(STORM_SEA, storm * 0.7).lerp(RAIN_SKY_DAY, wx.rain * 0.15 * dayness);
  out.seaShallow.copy(out.sea).lerp(SHALLOW_TINT, 0.45 * lerp(0.35, 1, dayness) * (1 - 0.6 * storm));
  out.seaDeep.copy(out.sea).multiplyScalar(0.62);
  out.foam.copy(FOAM_NIGHT).lerp(WHITE, dayness);
  out.glint = Math.max(sunUp * 0.9, moonUp * nightness * lerp(0.9, 1.6, wx.fullmoon)) * (1 - 0.7 * wx.rain) * (1 - storm * 0.8) * (1 - wx.fog * 0.6);

  // --- Clouds, stars, fireflies, wind, waves, rain.
  out.cloudTint.copy(CLOUD_NIGHT).lerp(WHITE, dayness).lerp(CLOUD_DUSK, warm * 0.7);
  out.cloudTint.lerp(CLOUD_RAIN, wx.rain * 0.6 * lerp(0.4, 1, dayness)).lerp(STORM_HORIZON, storm * 0.7);
  if (input.biome === "volcanic") out.cloudTint.lerp(pal.skyDusk, 0.25);
  out.stormClouds = Math.max(wx.rain * 0.85, storm);
  out.starAlpha = smooth(0.25, 0.85, nightness) * (1 - wx.rain) * (1 - storm) * (1 - wx.fog * 0.85) * lerp(1, 0.45, wx.fullmoon);
  out.fireflies = smooth(0.3, 0.9, nightness) * (1 - wx.rain) * (1 - storm);
  out.wind = Math.min(1, 0.25 + wx.rain * 0.35 + storm * 0.75);
  out.waveAmp = 0.12 + wx.rain * 0.1 + storm * 1.0;
  out.rain = Math.max(wx.rain, storm);
  return out;
}
