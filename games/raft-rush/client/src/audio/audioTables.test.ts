// Audio parameter tables: every SFX / loop name has a recipe + mix entry, tourist voices are complete and
// distinct, the radio fades with distance, ambience beds follow day / night / weather / mood, drums speed up with
// the monster count. Owner: client-fx-audio.

import { describe, expect, it } from "vitest";
import { CHARACTER_IDS, CHARACTERS } from "../../../shared/constants";
import { BED_NAMES, ambienceLevels, drumParamForMonsters } from "./ambience";
import type { AmbienceFrame } from "./AudioEngine";
import { RADIO_FLOOR, radioDirectional, radioGain, radioLowCutHz, radioToneHz } from "./engine/spatial";
import { LOOP_NAMES, SFX_NAMES, type VoiceKind } from "./Sfx";
import { belowNyquist } from "./synth/dsp";
import { LOOP_LEVEL, drumBpmForParam } from "./synth/loops";
import { SFX_DEFS, SFX_RECIPES } from "./synth/recipes";
import { VOICE_PROFILES, WORDS, wordDuration } from "./voices";

const VOICE_KINDS: ReadonlyArray<VoiceKind> = ["hurt", "throw", "eat", "panic", "laugh", "help", "yes", "cheer", "emote", "downed", "revived", "shiver"];

const frame = (over: Partial<AmbienceFrame> = {}): AmbienceFrame => ({ daylight: 1, weather: "clear", sea: 0.5, monsters: 0, storm: 0, underwater: false, ...over });

describe("sfx tables", () => {
  it("has a recipe and a mix entry for every SFX name (and nothing else)", () => {
    expect(Object.keys(SFX_RECIPES).sort()).toEqual([...SFX_NAMES].sort());
    expect(Object.keys(SFX_DEFS).sort()).toEqual([...SFX_NAMES].sort());
    for (const name of SFX_NAMES) {
      expect(typeof SFX_RECIPES[name]).toBe("function");
      const def = SFX_DEFS[name];
      expect(def.volume, name).toBeGreaterThan(0);
      expect(def.volume, name).toBeLessThanOrEqual(1);
      expect(def.cap, name).toBeGreaterThanOrEqual(1);
    }
  });

  it("routes UI sounds to the UI bus, flat", () => {
    for (const name of SFX_NAMES) {
      if (!name.startsWith("ui")) continue;
      expect(SFX_DEFS[name].bus).toBe("ui");
      expect(SFX_DEFS[name].positional).toBe(false);
    }
    expect(SFX_DEFS.bonk.positional).toBe(true);
    expect(SFX_DEFS.thunder.positional).toBe(false);
  });

  it("has a level for every loop", () => {
    expect(Object.keys(LOOP_LEVEL).sort()).toEqual([...LOOP_NAMES].sort());
    for (const name of LOOP_NAMES) expect(LOOP_LEVEL[name]).toBeGreaterThan(0);
  });
});

describe("voices", () => {
  it("profiles every tourist with a distinct pitch", () => {
    for (const id of CHARACTER_IDS) expect(VOICE_PROFILES[id]).toBeTruthy();
    expect(new Set(CHARACTER_IDS.map((id) => CHARACTERS[id].voiceHz)).size).toBe(CHARACTER_IDS.length);
  });

  it("every voice kind is a short, non-empty line for every tourist", () => {
    let seed = 1;
    const rnd = (): number => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (const kind of VOICE_KINDS) {
      for (const id of CHARACTER_IDS) {
        const segs = WORDS[kind](rnd, VOICE_PROFILES[id].inflection);
        expect(segs.length, kind).toBeGreaterThan(0);
        const d = wordDuration(segs, id);
        expect(d, `${kind} ${id}`).toBeGreaterThan(0.08);
        expect(d, `${kind} ${id}`).toBeLessThan(1.4);
        for (const s of segs) {
          expect(s.p0).toBeGreaterThan(0);
          expect(s.p1).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("radio", () => {
  it("plays full next to Amca and fades smoothly to a floor far away", () => {
    expect(radioGain(0)).toBe(1);
    expect(radioGain(3)).toBe(1);
    let prev = 1;
    for (let d = 5; d <= 80; d += 5) {
      const g = radioGain(d);
      expect(g).toBeLessThan(prev);
      expect(g).toBeGreaterThan(RADIO_FLOOR);
      prev = g;
    }
    expect(radioGain(200)).toBeLessThan(0.12);
  });

  it("gets tinny and directional with distance", () => {
    expect(radioToneHz(2)).toBe(16000);
    expect(radioToneHz(40)).toBeLessThan(3000);
    expect(radioToneHz(20)).toBeLessThan(radioToneHz(10));
    expect(radioLowCutHz(40)).toBeGreaterThan(radioLowCutHz(5));
    expect(radioDirectional(1)).toBe(0);
    expect(radioDirectional(20)).toBe(1);
  });
});

describe("ambience", () => {
  it("gulls by day, crickets at night", () => {
    const day = ambienceLevels(frame({ daylight: 1 }), "day");
    const night = ambienceLevels(frame({ daylight: 0 }), "night");
    expect(day.gulls.level).toBeGreaterThan(0.3);
    expect(day.crickets.level).toBeLessThan(0.01);
    expect(night.crickets.level).toBeGreaterThan(0.3);
    expect(night.gulls.level).toBe(0);
    for (const name of BED_NAMES) {
      expect(day[name].level).toBeGreaterThanOrEqual(0);
      expect(day[name].level).toBeLessThanOrEqual(1);
    }
  });

  it("rain silences gulls; the storm builds", () => {
    const rain = ambienceLevels(frame({ weather: "rain" }), "day");
    expect(rain.rain.level).toBeGreaterThan(0.5);
    expect(rain.gulls.level).toBe(0);
    const storm = ambienceLevels(frame({ storm: 1, daylight: 0 }), "storm");
    expect(storm.storm.level).toBe(1);
    expect(storm.wind.level).toBeGreaterThan(ambienceLevels(frame({ daylight: 0 }), "night").wind.level);
  });

  it("waves follow the distance to the shore", () => {
    expect(ambienceLevels(frame({ sea: 1 }), "day").waves.level).toBeGreaterThan(ambienceLevels(frame({ sea: 0 }), "day").waves.level);
  });

  it("drums only from dusk, faster with more monsters", () => {
    expect(ambienceLevels(frame(), "day").drums.level).toBe(0);
    expect(ambienceLevels(frame(), "lobby").drums.level).toBe(0);
    expect(ambienceLevels(frame({ daylight: 0.3 }), "dusk").drums.level).toBeGreaterThan(0);
    const slow = drumBpmForParam(drumParamForMonsters(0));
    const busy = drumBpmForParam(drumParamForMonsters(10));
    expect(slow).toBeGreaterThan(80);
    expect(slow).toBeLessThan(90);
    expect(busy).toBeGreaterThan(slow + 30);
    expect(drumBpmForParam(drumParamForMonsters(100))).toBeLessThanOrEqual(150);
  });

  it("muffles beds underwater", () => {
    const dry = ambienceLevels(frame(), "day");
    const wet = ambienceLevels(frame({ underwater: true }), "day");
    expect(wet.waves.level).toBeCloseTo(dry.waves.level * 0.5, 5);
  });
});

describe("frequencies", () => {
  it("caps a frequency at the output's Nyquist (a 24 kHz Bluetooth headset), leaving normal outputs alone", () => {
    const at = (sampleRate: number) => ({ sampleRate }) as BaseAudioContext;
    expect(belowNyquist(at(24000), 16000)).toBe(12000);
    expect(belowNyquist(at(24000), 520)).toBe(520);
    expect(belowNyquist(at(48000), 20000)).toBe(20000);
  });
});
