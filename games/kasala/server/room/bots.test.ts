// Unit tests for BotDesk timing rules (server/room/bots.ts) with a fake room host.
// Run: npx vitest run games/kasala/server/room/bots

import { describe, expect, it } from "vitest";
import { HECKLE_CASH_TAUNT } from "../../shared/constants.js";
import { BetState, KasalaState, PlayerState } from "../schema.js";
import { BotDesk, type BotHost } from "./bots.js";

/** A human ("h") on turn 1 with 2 cards out, a bot watcher ("b") with a "Kasalar" bet; rng always 0 (heckles). */
function table(): { state: KasalaState; desk: BotDesk; taunts: { id: string; index: number }[] } {
  const state = new KasalaState();
  for (const [id, bot] of [["h", false], ["b", true]] as const) {
    const p = new PlayerState();
    p.id = id;
    p.nickname = id;
    p.bot = bot;
    state.players.set(id, p);
    state.turnOrder.push(id);
  }
  const bet = new BetState();
  bet.playerId = "b";
  bet.box = "cash";
  bet.amount = 10;
  state.bets.set("b", bet);
  state.phase = "flipping";
  state.activeId = "h";
  state.flips = 2;
  const taunts: { id: string; index: number }[] = [];
  const host = {
    state,
    rng: () => 0,
    think: () => ({ min: 0.8, max: 2.2 }),
    timeLeft: () => 10,
    timeLowSec: () => 3,
    turnSerial: () => 1,
    canDeal: () => false,
    taunt: (id: string, index: number) => {
      taunts.push({ id, index });
      return true;
    },
  } as unknown as BotHost;
  const desk = new BotDesk(host);
  desk.add("b", "dengeli");
  return { state, desk, taunts };
}

describe("BotDesk heckles", () => {
  it("heckles a turn that goes on", () => {
    const { desk, taunts } = table();
    desk.onCard("h", 2);
    desk.tick(2);
    expect(taunts).toEqual([{ id: "b", index: HECKLE_CASH_TAUNT }]);
  });

  it("drops the heckle when another card (e.g. a raid) was flipped in between", () => {
    const { state, desk, taunts } = table();
    desk.onCard("h", 2);
    state.flips = 3;
    desk.tick(2);
    expect(taunts).toEqual([]);
  });

  it("drops the heckle once the turn left the flipping phase (raid result, wheel)", () => {
    const { state, desk, taunts } = table();
    desk.onCard("h", 2);
    state.phase = "result";
    desk.tick(2);
    expect(taunts).toEqual([]);
  });
});
