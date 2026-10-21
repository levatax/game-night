// Coach tips: once each, until the settings menu's "Show tips again" clears seenTips. Owner: client-app.
// Run: npx vitest run games/raft-rush/client/src/app

import { describe, expect, it, vi } from "vitest";
import type { Ui } from "../ui/Ui";
import { Coach, type CoachFrame } from "./coach";
import { SettingsStore } from "./settings";

/** A frame that skips detection (not alive) so only queued tips show. */
const frame = (nowMs: number): CoachFrame => ({ me: { alive: false }, nowMs }) as unknown as CoachFrame;

describe("Coach replay", () => {
  it("shows a tip once, and again after seenTips was cleared", () => {
    const store = new SettingsStore("raft-rush.coach-test");
    const ui = { coach: vi.fn(), feed: vi.fn() };
    const coach = new Coach(ui as unknown as Ui, store);
    coach.tip("move");
    coach.update(frame(0));
    expect(ui.coach).toHaveBeenCalledWith("move");
    // The UI records it as seen.
    store.set({ seenTips: ["move"] });
    coach.tip("move");
    coach.update(frame(60_000));
    expect(ui.coach).toHaveBeenCalledTimes(1);
    // "Show tips again".
    store.set({ seenTips: [] });
    coach.tip("move");
    coach.update(frame(60_001));
    expect(ui.coach).toHaveBeenCalledTimes(2);
  });
});
