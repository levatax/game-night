// Every feed / banner / prompt key the app composes exists in English and Turkish, with the same {placeholders}.
// Dynamic key families (weather, day events, causes, treasures, coach tips…) are enumerated from the contracts so
// a new id fails here instead of showing a raw key on screen. Owner: client-app.

import { describe, expect, it } from "vitest";
import { DAY_EVENT_IDS, MARKER_KINDS, WEATHER_IDS } from "../../../shared/constants";
import type { HurtCause, InteractKind, MonsterKind, TreasureId } from "../../../shared/types";
import * as banner from "../i18n/strings/banner";
import * as feed from "../i18n/strings/feed";
import * as prompt from "../i18n/strings/prompt";
import { COACH_TIPS } from "./coach";
import { START_HINT } from "./viewModels";

type Section = { en: Record<string, string>; tr: Record<string, string> };
const SECTIONS: Record<string, Section> = { banner, feed, prompt };

const CAUSES: HurtCause[] = ["crab", "puffer", "boss", "hunger", "thirst", "cold", "drown", "jellyfish", "blast", "friendly"];
const TREASURES: TreasureId[] = ["flare", "old_sail", "pirate_hat", "spyglass", "fuel_can"];
const INTERACTS: InteractKind[] = ["revive", "collectCrab", "pickup", "board", "deliver", "assemble", "repair", "craft", "chest", "spring", "collector", "secretChest", "salvage", "gather"];
const MONSTER_KINDS: MonsterKind[] = ["crab", "puffer", "boss", "monkey", "gull"];

/** Every key the app's code builds, as "section.key". */
function usedKeys(): string[] {
  const keys: string[] = [];
  const add = (k: string): void => {
    keys.push(k);
  };
  // banners
  for (const k of ["day", "daySubFirst", "daySub", "daySubLast", "dusk", "duskLast", "duskSub", "night", "nightSub", "nightSubLast", "nightSubFlare"]) add(`banner.${k}`);
  for (const w of WEATHER_IDS) add(`banner.weather_${w}`), add(`banner.weather_${w}Sub`), add(`feed.weather_${w}`);
  for (const d of DAY_EVENT_IDS) add(`banner.dayEvent_${d}`), add(`banner.dayEvent_${d}Sub`), add(`feed.dayEvent_${d}`);
  for (const k of ["stormWarning", "stormWarningSub", "storm", "stormSub", "raftReady", "raftReadySub", "boarding", "boardingSub", "launch", "launchSub", "launchLeft", "launchLeftSub"]) add(`banner.${k}`);
  for (const k of ["fireLow", "fireLowSub", "fireOut", "fireOutSub", "stageDone", "stageDoneSub", "stageLost", "boss", "bossSub", "bossDown", "respawn", "respawnSub", "golden", "goldenSub"]) add(`banner.${k}`);
  for (const t of TREASURES) add(`banner.treasure_${t}`), add(`banner.treasure_${t}Sub`);
  // feed
  for (const c of CAUSES) add(`feed.downed_${c}`);
  for (const b of ["hunger", "thirst", "warmth", "hp"]) add(`feed.lowBar_${b}`);
  for (const m of MARKER_KINDS) add(`feed.marker_${m}`), add(`feed.marker_${m}_kaptan`), add(`prompt.mark_${m}`);
  for (const r of ["late", "early"]) add(`feed.fishMiss_${r}`);
  for (const n of [1, 2, 3]) add(`feed.captainLine${n}`);
  for (const k of ["stageDone", "stageLost", "materialsIn", "logFelled"]) add(`feed.${k}`);
  for (const tip of COACH_TIPS) add(`feed.tip_${tip}`);
  for (const k of [
    "pop_bonk",
    "pop_flip",
    "landing",
    "dawn",
    "raftReady",
    "boarded",
    "wilson",
    "fireOut",
    "fireRained",
    "fireRelit",
    "fireJelly",
    "crafted",
    "craftDropped",
    "feast",
    "chestReturned",
    "pocketsFull",
    "raftGnawed",
    "bossArrived",
    "bossLow",
    "bossDown",
    "monkeyStole",
    "monkeyDropped",
    "gullStole",
    "gullDropped",
    "krakenPlaced",
    "fenceBroken",
    "blast",
    "blastInHand",
    "friendlyBonk",
    "pass",
    "downed",
    "revived",
    "washed",
    "washedLast",
    "respawn",
    "ateGolden",
    "caughtGolden",
    "caughtKraken",
    "caughtBoot",
    "caughtJelly",
    "caughtPuffer",
    "pity",
    "treasure",
    "bottle",
    "markerNeed",
    "rejectGeneric",
    "connBack",
    "seatExpired",
    "islandMismatch",
    "linkCopied",
    "linkCopyFailed",
    "muted",
    "unmuted",
    "qualityLowered",
    "fatalTitle",
    "fatalText",
    "fatalBack",
  ])
    add(`feed.${k}`);
  // prompts
  for (const k of INTERACTS) if (k !== "gather") add(`prompt.${k}`);
  for (const k of ["gather", "gather_wood", "gather_stone", "gather_rope", "gather_berry", "spring_drink", "palm", "cast", "strike", "glyphLmb"]) add(`prompt.${k}`);
  for (const k of ["camp", "raft", "spring", "secret", "cave", "fish"]) add(`prompt.mark_${k}`);
  for (const m of MONSTER_KINDS) add(`prompt.mark_${m}`);
  for (const pair of Object.values(START_HINT)) add(pair[1]);
  return keys;
}

const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();

describe("app strings (feed / banner / prompt)", () => {
  it("every composed key exists in English and Turkish", () => {
    const missing: string[] = [];
    for (const full of usedKeys()) {
      const dot = full.indexOf(".");
      const section = SECTIONS[full.slice(0, dot)];
      const key = full.slice(dot + 1);
      if (!section || !section.en[key] || !section.tr[key]) missing.push(full);
    }
    expect(missing).toEqual([]);
  });

  it("English and Turkish lines carry the same placeholders and are never empty", () => {
    const bad: string[] = [];
    for (const [name, section] of Object.entries(SECTIONS)) {
      for (const key of Object.keys(section.en)) {
        const en = section.en[key]!;
        const tr = section.tr[key] ?? "";
        if (!en.trim() || !tr.trim()) bad.push(`${name}.${key} empty`);
        if (placeholders(en).join() !== placeholders(tr).join()) bad.push(`${name}.${key}: ${placeholders(en)} vs ${placeholders(tr)}`);
      }
      expect(Object.keys(section.tr).sort()).toEqual(Object.keys(section.en).sort());
    }
    expect(bad).toEqual([]);
  });

  it("Turkish never glues a suffix straight onto a {name}-like placeholder", () => {
    const glued: string[] = [];
    for (const [name, section] of Object.entries(SECTIONS)) {
      for (const [key, line] of Object.entries(section.tr)) {
        if (/\{(name|by|victim|thrower)\}['’]?[a-zçğıöşü]/i.test(line)) glued.push(`${name}.${key}`);
      }
    }
    expect(glued).toEqual([]);
  });
});
