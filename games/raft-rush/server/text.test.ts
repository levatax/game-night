// Server notice text ↔ client i18n parity (server/room/text.ts NOTICE_EN vs client/src/i18n/strings/server.ts).
// Owner: server-room. Run: npx vitest run games/raft-rush/server/text.test.ts
import { describe, expect, it } from "vitest";
import { en as clientEn, tr as clientTr } from "../client/src/i18n/strings/server";
import { NOTICE_EN, fill, notice, say } from "./room/text.js";

const placeholders = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort();

describe("server text ↔ client i18n", () => {
  it("every key the server sends has the same English line on the client (and nothing else)", () => {
    for (const [k, v] of Object.entries(NOTICE_EN)) expect(clientEn[k as keyof typeof clientEn], k).toBe(v);
    expect(Object.keys(clientEn).sort()).toEqual(Object.keys(NOTICE_EN).sort());
  });

  it("Turkish has every key, keeps every placeholder and is really translated", () => {
    expect(Object.keys(clientTr).sort()).toEqual(Object.keys(clientEn).sort());
    for (const [k, v] of Object.entries(clientEn)) {
      const trLine = clientTr[k as keyof typeof clientTr];
      expect(trLine.trim().length, k).toBeGreaterThan(0);
      expect(placeholders(trLine), k).toEqual(placeholders(v));
      expect(trLine, k).not.toBe(v);
    }
  });

  it("notices carry key + params and fill the English text", () => {
    expect(say.joined(() => 0.3, "Bob")).toEqual({ key: "joined2", params: { n: "Bob" }, text: "🧳 Bob arrived with three suitcases and zero sunscreen." });
    expect(say.cantStartLazy(["A"])).toEqual({ key: "cantStartLazyOne", params: { names: "A" }, text: "🙅 Can't sail yet: A is still putting on sunscreen." });
    expect(say.cantStartLazy(["A", "B"])).toMatchObject({ key: "cantStartLazyMany", params: { names: "A, B" } });
    expect(say.duelLocked()).toEqual({ key: "duelLocked", text: NOTICE_EN.duelLocked });
    expect(say.soloBots(2).text).toBe("🤖 Going solo? 2 helper bots washed up to lend a hand.");
    expect(notice("host", { n: "Ayşe" }).text).toBe("🧢 Ayşe is the tour guide now (host).");
  });

  it("variant pickers stay inside their numbered keys for any rng value", () => {
    for (const r of [0, 0.25, 0.5, 0.75, 0.999999, 1]) {
      expect(NOTICE_EN).toHaveProperty(say.joined(() => r, "x").key);
      expect(NOTICE_EN).toHaveProperty(say.left(() => r, "x").key);
      expect(NOTICE_EN).toHaveProperty(say.spectating(() => r, "x").key);
    }
  });

  it("fill leaves unknown placeholders alone", () => {
    expect(fill("{a} and {b}", { a: 1 })).toBe("1 and {b}");
  });
});
