// Printed keys (ui/controls.ts): the key preset and the learned layout reach every label, and every {k…}
// placeholder in the strings (every section) is one keyParams() fills, in both languages, with no letter left
// hard-coded. That each one is rendered through keyParams() is ui/keyStrings.test.ts. Owner: client-ui.
// Run: npx vitest run games/raft-rush/client/src/ui

import { afterEach, describe, expect, it } from "vitest";
import { settings } from "../app/settings";
import * as banner from "../i18n/strings/banner";
import * as characters from "../i18n/strings/characters";
import * as coach from "../i18n/strings/coach";
import * as feed from "../i18n/strings/feed";
import * as hud from "../i18n/strings/hud";
import * as items from "../i18n/strings/items";
import * as menu from "../i18n/strings/menu";
import * as overlays from "../i18n/strings/overlays";
import * as panels from "../i18n/strings/panels";
import * as prompt from "../i18n/strings/prompt";
import * as reject from "../i18n/strings/reject";
import * as server from "../i18n/strings/server";
import { learnKeyCap, resetKeyCaps } from "../input/bindings";
import { controlRows, keyLabel, keyParams, keysSignature, moveKeys, slotKeys, wheelKey, withKeys } from "./controls";

/** Every strings section (i18n/index.ts SECTIONS). */
const SECTIONS = { banner, characters, coach, feed, hud, items, menu, overlays, panels, prompt, reject, server } as const;

afterEach(() => {
  settings.set({ keyPreset: "standard", mouseLock: true });
  resetKeyCaps();
});

describe("key labels", () => {
  it("standard preset on a QWERTY board", () => {
    expect(moveKeys().join("")).toBe("WASD");
    expect(keyParams()).toMatchObject({ kMove: "WASD", kInteract: "E", kEat: "F", kToss: "Q", kSlots: "1–4", kPing: "V", kEmote: "T", kLegend: "H", kStats: "Tab", kEmoteKeys: "1–6" });
    expect(slotKeys()).toEqual(["1", "2", "3", "4"]);
  });

  it("the left-handed preset", () => {
    settings.set({ keyPreset: "leftHanded" });
    expect(keyParams()).toMatchObject({ kMove: "IJKL", kInteract: "U", kEat: "H", kToss: "O", kSlots: "7 8 9 0", kPing: "N", kEmote: "Y", kLegend: "P", kEmoteKeys: "7 8 9 0 - =" });
    expect(slotKeys()).toEqual(["7", "8", "9", "0"]);
    expect(wheelKey(5)).toBe("=");
  });

  it("follows the learned keyboard layout (AZERTY)", () => {
    const before = keysSignature();
    learnKeyCap("KeyW", "z");
    learnKeyCap("KeyA", "q");
    learnKeyCap("KeyQ", "a");
    expect(keysSignature()).not.toBe(before);
    expect(keyParams()).toMatchObject({ kMove: "ZQSD", kToss: "A" });
  });

  it("the control list follows the preset and the mouse-lock setting", () => {
    settings.set({ keyPreset: "leftHanded", mouseLock: false });
    const rows = controlRows();
    expect(rows.find((r) => r.action === "overlays.ctl_move")?.keys).toEqual(["I", "J", "K", "L"]);
    expect(rows.find((r) => r.action === "overlays.ctl_interact")?.keys).toEqual(["U"]);
    expect(rows.find((r) => r.action === "overlays.ctl_look")?.keys).toEqual(["overlays.key_drag"]);
    expect(keyLabel("stats")).toBe("\\");
  });
});

describe("withKeys", () => {
  it("is keyParams() under the caller's own params", () => {
    settings.set({ keyPreset: "leftHanded" });
    expect(withKeys()).toEqual(keyParams());
    expect(withKeys({ name: "Sam", kInteract: "X" })).toMatchObject({ name: "Sam", kInteract: "X", kEat: "H" });
  });
});

describe("key placeholders in the UI strings", () => {
  const placeholders = (s: string): string[] => [...s.matchAll(/\{(k[A-Z]\w*)\}/g)].map((m) => m[1]!).sort();

  it("are all filled by keyParams() and match between English and Turkish", () => {
    const known = new Set(Object.keys(keyParams()));
    const problems: string[] = [];
    let used = 0;
    for (const [name, section] of Object.entries(SECTIONS)) {
      const en = section.en as Record<string, string>;
      const tr = section.tr as Record<string, string>;
      for (const key of Object.keys(en)) {
        const a = placeholders(en[key]!);
        const b = placeholders(tr[key] ?? "");
        used += a.length;
        for (const p of a) if (!known.has(p)) problems.push(`${name}.${key}: unknown {${p}}`);
        if (a.join() !== b.join()) problems.push(`${name}.${key}: en {${a}} vs tr {${b}}`);
      }
    }
    expect(problems).toEqual([]);
    expect(used).toBeGreaterThan(40);
  });

  it("Turkish never glues a suffix onto a key ('{kInteract} tuşuna', not '{kInteract}'ye')", () => {
    const glued: string[] = [];
    for (const [name, section] of Object.entries(SECTIONS)) {
      for (const [key, text] of Object.entries(section.tr as Record<string, string>)) {
        if (/\{k[A-Z]\w*\}['’]?\p{L}/u.test(text)) glued.push(`${name}.${key}: ${text}`);
      }
    }
    expect(glued).toEqual([]);
  });

  it("no string still hard-codes a preset's letter or WASD (every section, both languages)", () => {
    // "press E", "Hold H", "E'ye", "Q'ya", "E basılı", "Q ile", "(E)", "E fills…", "WASD": the keys change with the
    // preset and the layout, so they go through the placeholders. Esc / Tab / Shift / Space / Enter mean the same
    // key in every preset. Left alone: the compass letters and the key preset's own name / description.
    const stale = new RegExp(
      [
        String.raw`\b(?:[Pp]ress|[Hh]old|[Hh]olding|[Rr]elease|[Ww]ith) [EFQVHTM]\b`,
        String.raw`(?:^|[\s(])[EFQVHTM]['’](?:ye|ya|yi|yı|e|a)(?!\p{L})`,
        String.raw`(?:^|[\s(])[EFQVHTM] (?:basılı|tuşu|ile)`,
        String.raw`(?:^|[\s(])[EFQVHTM](?=[\s).,!:]|$)`,
        String.raw`\bWASD\b`,
      ].join("|"),
      "u",
    );
    const exempt = /^(?:hud\.compass[NESW]|overlays\.keyPreset)/;
    for (const bad of ["Hold E on trees", "Press V (or middle-click)", "E'ye basılı tut", "Q'ya bas", "E basılı", "Q ile attığını", "dinner (E).", "E fills a gourd", "Mute everything (M)", "WASD to walk"]) {
      expect(stale.test(bad), bad).toBe(true);
    }
    for (const fine of ["Esc opens the menu", "Hold Tab", "Shift+Enter takes one", "A crate washed up", "Press {kInteract} on it", "Hepsini sustur ({kMute})", "{kInteract} tuşuna bas"]) {
      expect(stale.test(fine), fine).toBe(false);
    }
    const hits: string[] = [];
    for (const [name, section] of Object.entries(SECTIONS)) {
      for (const lang of ["en", "tr"] as const) {
        for (const [key, text] of Object.entries(section[lang] as Record<string, string>)) {
          if (!exempt.test(`${name}.${key}`) && stale.test(text)) hits.push(`${lang} ${name}.${key}: ${text}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
