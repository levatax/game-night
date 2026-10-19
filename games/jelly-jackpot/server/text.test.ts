import { describe, expect, it } from "vitest";
import { en as clientEn, tr as clientTr } from "../client/src/i18n/strings/server";
import { NOTICE_EN, RIG_REASON_EN, say } from "./room/text.js";
import { ADJUST_EN } from "./rules.js";

describe("server text ↔ client i18n", () => {
  const serverEn: Record<string, string> = { ...NOTICE_EN, ...RIG_REASON_EN, ...ADJUST_EN };

  it("every key the server sends has the same English line on the client", () => {
    for (const [k, v] of Object.entries(serverEn)) expect(clientEn[k as keyof typeof clientEn], k).toBe(v);
    expect(Object.keys(clientEn).sort()).toEqual(Object.keys(serverEn).sort());
  });

  it("Turkish keeps every placeholder", () => {
    for (const [k, v] of Object.entries(clientEn)) {
      const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort();
      expect(ph(clientTr[k as keyof typeof clientTr]), k).toEqual(ph(v));
    }
  });

  it("notices carry key + params and fill the English text", () => {
    expect(say.joined(() => 0.3, "Bob")).toEqual({ text: "🥄 Bob has entered the kitchen. Hide the good spatulas.", key: "joined2", params: { n: "Bob" } });
    expect(say.cantStartLazy(["A", "B"])).toEqual({ text: "🙅 Can't start yet: A, B are still tying their apron.", key: "cantStartLazyMany", params: { names: "A, B" } });
    expect(say.rematch()).toEqual({ text: "🔁 Fresh cake! Back to the lobby.", key: "rematch" });
  });
});
