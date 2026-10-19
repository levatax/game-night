// End-to-end test for JellyRoom: a real Colyseus server on a random port, bot clients via colyseus.js,
// fast timings (JELLY_TEST=1 + { fast: true }). Plays whole matches and checks the protocol.

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "colyseus.js";
import { CARD_BY_ID, ROOM_NAME, START_COINS } from "../shared/constants.js";
import { MSG } from "../shared/protocol.js";
import type {
  BetsMsg,
  JellyStateView,
  Phase,
  ResultMsg,
  RevealMsg,
  RigStatusMsg,
  RoleMsg,
  SpinResultMsg,
  SpinStartMsg,
  VotesMsg,
} from "../shared/protocol.js";
import { JellyRoom } from "./JellyRoom.js";

process.env.JELLY_TEST = "1";

let gameServer: Server;
let endpoint = "";

beforeAll(async () => {
  const httpServer = http.createServer();
  gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
  gameServer.define(ROOM_NAME, JellyRoom);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await gameServer?.gracefullyShutdown(false);
});

const IDENTITY = { qx: 0, qy: 0, qz: 0, qw: 1 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Room2 = Room<JellyStateView>;

interface Bot {
  name: string;
  room: Room2;
  id: string;
  role?: RoleMsg["role"];
  roleCount: number;
  log: { type: string; msg: unknown }[];
  /** Turn keys already handled (spin/drop/bet once per turn). */
  done: Set<string>;
  on: Map<string, ((msg: unknown) => void)[]>;
}

const SERVER_MSGS = [
  MSG.WELCOME, MSG.ROLE, MSG.RIG_STATUS, MSG.SPIN_START, MSG.SPIN_RESULT, MSG.DROPPED, MSG.IMPACT, MSG.HICCUP,
  MSG.TOPPLE, MSG.RESULT, MSG.BETS, MSG.VOTES, MSG.REVEAL, MSG.EMOTED, MSG.NOTICE,
] as const;

function makeBot(name: string, room: Room2): Bot {
  const bot: Bot = { name, room, id: room.sessionId, roleCount: 0, log: [], done: new Set(), on: new Map() };
  // colyseus.js calls only ONE handler per type, so the bot owns them all and fans out to listeners.
  for (const type of SERVER_MSGS) {
    room.onMessage(type, (msg: unknown) => {
      bot.log.push({ type, msg });
      if (type === MSG.ROLE) {
        bot.role = (msg as RoleMsg).role;
        bot.roleCount++;
      }
      for (const cb of bot.on.get(type) ?? []) cb(msg);
    });
  }
  return bot;
}

function on<T>(bot: Bot, type: string, cb: (msg: T) => void): void {
  const list = bot.on.get(type) ?? [];
  list.push(cb as (msg: unknown) => void);
  bot.on.set(type, list);
}

async function makeTable(n: number, createOpts: Record<string, unknown>): Promise<Bot[]> {
  const host = await new Client(endpoint).create<JellyStateView>(ROOM_NAME, { nickname: "Host", fast: true, ...createOpts });
  const bots = [makeBot("Host", host)];
  for (let i = 1; i < n; i++) {
    const room = await new Client(endpoint).joinById<JellyStateView>(host.roomId, { nickname: `Bot${i}` });
    bots.push(makeBot(`Bot${i}`, room));
  }
  await waitFor(() => bots.every((b) => b.room.state?.players?.size === n), 3000, "everyone synced");
  return bots;
}

async function waitFor(cond: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

const phaseOf = (b: Bot): Phase | undefined => b.room.state?.phase;
const msgs = <T>(b: Bot, type: string): T[] => b.log.filter((l) => l.type === type).map((l) => l.msg as T);

/** Drive the bots as simple players: spin, hover + drop at the center, bet, optionally rig and vote. */
function autoplay(bots: Bot[], opts: { rig?: boolean; vote?: (voter: Bot) => string | null } = {}) {
  let rigged = false;
  for (const bot of bots) {
    const room = bot.room;
    if (opts.rig) {
      on<SpinStartMsg>(bot, MSG.SPIN_START, (m) => {
        if (bot.role === "saboteur" && !rigged && m.playerId !== bot.id) {
          rigged = true;
          room.send(MSG.RIG, {});
        }
      });
    }
    room.onStateChange((s) => {
      const turnKey = `${s.round}:${s.turnInRound}`;
      if (s.phase === "spinning" && s.spinStage === "idle" && s.activeId === bot.id && !bot.done.has(`spin${turnKey}`)) {
        bot.done.add(`spin${turnKey}`);
        room.send(MSG.SPIN, {});
      }
      if (s.phase === "placing" && s.activeId === bot.id && !bot.done.has(`drop${turnKey}`)) {
        bot.done.add(`drop${turnKey}`);
        void (async () => {
          for (let i = 0; i < 3; i++) {
            room.send(MSG.HOVER, { x: 0.01 * i, y: 1.2, z: 0, ...IDENTITY });
            await sleep(30);
          }
          room.send(MSG.DROP, { x: 0, y: 1.2, z: 0, ...IDENTITY });
        })();
      }
      if ((s.phase === "spinning" || s.phase === "placing") && s.activeId && s.activeId !== bot.id && !bot.done.has(`bet${turnKey}`)) {
        const me = s.players.get(bot.id);
        if (me && !me.spectator && me.coins >= 10) {
          bot.done.add(`bet${turnKey}`);
          room.send(MSG.BET, { side: Math.random() < 0.5 ? "stand" : "fall", amount: 10 });
        }
      }
      if (s.phase === "voting" && opts.vote && !bot.done.has("vote")) {
        const suspect = opts.vote(bot);
        if (suspect) {
          bot.done.add("vote");
          room.send(MSG.VOTE, { suspectId: suspect });
        }
      }
    });
  }
}

/** Checks every RESULT/BETS against the coin totals in the first "result" state that follows it. */
function watchCoins(observer: Bot) {
  const checks: { ok: boolean; info: string }[] = [];
  let pending: { before: Map<string, number>; result?: ResultMsg; bets?: BetsMsg } | null = null;
  on<ResultMsg>(observer, MSG.RESULT, (m) => {
    const before = new Map<string, number>();
    observer.room.state.players.forEach((p, id) => before.set(id, p.coins));
    pending = { before, result: m };
  });
  on<BetsMsg>(observer, MSG.BETS, (m) => {
    if (pending) pending.bets = m;
  });
  observer.room.onStateChange((s) => {
    if (!pending?.result || !pending.bets || s.phase !== "result") return;
    const { before, result, bets } = pending;
    pending = null;
    before.forEach((coins, id) => {
      const p = s.players.get(id);
      if (!p) return;
      let expected = coins;
      if (id === result.playerId) expected += result.delta;
      for (const b of bets.bets) if (b.playerId === id) expected += b.delta;
      expected = Math.max(0, expected);
      checks.push({ ok: p.coins === expected, info: `${id} ${coins}→${p.coins} expected ${expected}` });
    });
  });
  return checks;
}

async function startMatch(bots: Bot[]) {
  const [host, ...rest] = bots;
  for (const b of rest) b.room.send(MSG.READY, { ready: true });
  await waitFor(() => rest.every((b) => host!.room.state.players.get(b.id)?.ready), 3000, "ready");
  host!.room.send(MSG.START, {});
  await waitFor(() => bots.every((b) => phaseOf(b) === "roleReveal" || phaseOf(b) === "spinning"), 3000, "match start");
}

async function leaveAll(bots: Bot[]) {
  await Promise.all(bots.map((b) => b.room.connection.isOpen && b.room.leave(true).catch(() => undefined)));
}

describe("JellyRoom e2e", () => {
  it("plays a full 3-player match with a Saboteur, rig, bets, vote, reveal, podium and rematch", async () => {
    const bots = await makeTable(3, { rounds: 2 });
    const [host] = bots;
    const sabo = () => bots.find((b) => b.role === "saboteur");
    autoplay(bots, {
      rig: true,
      vote: (voter) => (voter.role === "saboteur" ? bots.find((b) => b !== voter)!.id : sabo()!.id),
    });
    const coinChecks = watchCoins(host!);
    const phases: Phase[] = [];
    host!.room.onStateChange((s) => {
      if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
    });

    await startMatch(bots);
    await waitFor(() => bots.every((b) => b.roleCount === 1), 3000, "roles");
    expect(bots.filter((b) => b.role === "saboteur")).toHaveLength(1);
    expect(bots.filter((b) => b.role === "baker")).toHaveLength(2);
    // Roles are private: nothing in the synced state names them.
    expect(JSON.stringify((host!.room.state as unknown as { toJSON(): unknown }).toJSON())).not.toMatch(/saboteur"\s*:\s*"|"role"/);

    await waitFor(() => phaseOf(host!) === "matchEnd", 60_000, "matchEnd");
    const saboteur = sabo()!;

    // Phase flow.
    for (const p of ["roleReveal", "spinning", "placing", "settling", "result", "voting", "reveal", "matchEnd"] as Phase[]) {
      expect(phases).toContain(p);
    }

    // Every turn: one SPIN_START, one SPIN_RESULT with a consistent reel; 2 rounds × 4 turns.
    const starts = msgs<SpinStartMsg>(host!, MSG.SPIN_START);
    const results = msgs<SpinResultMsg>(host!, MSG.SPIN_RESULT);
    expect(starts).toHaveLength(8);
    expect(results).toHaveLength(8);
    for (const r of results) {
      expect(r.strip[r.winIndex]).toBe(r.card);
      expect(CARD_BY_ID[r.card].rarity).toBe(r.rarity);
    }

    // The rig: accepted once, the victim's card is cursed.
    const statuses = msgs<RigStatusMsg>(saboteur, MSG.RIG_STATUS).filter((m) => m.accepted !== undefined);
    expect(statuses).toHaveLength(1);
    expect(statuses[0]!.accepted).toBe(true);
    const reveal = msgs<RevealMsg>(host!, MSG.REVEAL);
    expect(reveal).toHaveLength(1);
    expect(reveal[0]!.saboteurId).toBe(saboteur.id);
    expect(reveal[0]!.rigs).toHaveLength(1);
    const rig = reveal[0]!.rigs[0]!;
    expect(rig.victimId).not.toBe(saboteur.id);
    const victimSpin = results.find((r) => r.playerId === rig.victimId && r.card === rig.card);
    expect(victimSpin).toBeDefined();
    expect(victimSpin!.rarity).toBe("cursed");
    // Nobody but the Saboteur hears RIG_STATUS.
    for (const b of bots) if (b !== saboteur) expect(msgs(b, MSG.RIG_STATUS)).toHaveLength(0);

    // Coins moved exactly per RESULT + BETS.
    const resultsMsgs = msgs<ResultMsg>(host!, MSG.RESULT);
    expect(resultsMsgs).toHaveLength(8);
    expect(msgs<BetsMsg>(host!, MSG.BETS)).toHaveLength(8);
    expect(msgs<BetsMsg>(host!, MSG.BETS).some((m) => m.bets.length > 0)).toBe(true);
    expect(coinChecks.length).toBeGreaterThanOrEqual(8 * 3 - 3);
    expect(coinChecks.filter((c) => !c.ok).map((c) => c.info)).toEqual([]);

    // Vote: both bakers accused the Saboteur → caught.
    const votes = msgs<VotesMsg>(host!, MSG.VOTES);
    expect(votes).toHaveLength(1);
    expect(votes[0]!.votes).toHaveLength(3);
    expect(votes[0]!.majorityId).toBe(saboteur.id);
    expect(reveal[0]!.caught).toBe(true);
    expect(reveal[0]!.adjustments.some((a) => a.delta > 0)).toBe(true);

    // Podium places 1..3.
    await waitFor(() => {
      const places = [...host!.room.state.players.values()].map((p) => p.place).sort();
      return places.join() === "1,2,3";
    }, 2000, "places");

    // Rematch → lobby with coins reset.
    bots[1]!.room.send(MSG.REMATCH, {}); // not the host: ignored
    await sleep(150);
    expect(phaseOf(host!)).toBe("matchEnd");
    host!.room.send(MSG.REMATCH, {});
    await waitFor(() => bots.every((b) => phaseOf(b) === "lobby"), 3000, "lobby after rematch");
    await waitFor(() => [...host!.room.state.players.values()].every((p) => p.coins === START_COINS && p.place === 0), 2000, "coins reset");

    await leaveAll(bots);
  }, 90_000);

  it("a 2-player match has no Saboteur and skips voting", async () => {
    const bots = await makeTable(2, { rounds: 1 });
    autoplay(bots, { rig: true });
    const phases: Phase[] = [];
    bots[0]!.room.onStateChange((s) => {
      if (phases[phases.length - 1] !== s.phase) phases.push(s.phase);
    });
    await startMatch(bots);
    await waitFor(() => bots.every((b) => b.roleCount === 1), 3000, "roles");
    expect(bots.every((b) => b.role === "baker")).toBe(true);

    await waitFor(() => phaseOf(bots[0]!) === "matchEnd", 30_000, "matchEnd");
    expect(phases).not.toContain("voting");
    expect(phases).toContain("reveal");
    const reveal = msgs<RevealMsg>(bots[0]!, MSG.REVEAL);
    expect(reveal).toHaveLength(1);
    expect(reveal[0]!.saboteurId).toBe("");
    expect(reveal[0]!.rigs).toEqual([]);
    expect(msgs(bots[0]!, MSG.VOTES)).toHaveLength(0);
    expect(msgs<SpinResultMsg>(bots[0]!, MSG.SPIN_RESULT)).toHaveLength(4);
    await waitFor(() => [...bots[0]!.room.state.players.values()].map((p) => p.place).sort().join() === "1,2", 2000, "places");
    await leaveAll(bots);
  }, 60_000);

  it("a player disconnecting mid-turn doesn't stall the match", async () => {
    const bots = await makeTable(3, { rounds: 1 });
    const [host, a, quitter] = bots as [Bot, Bot, Bot];
    // The quitter never plays: it vanishes (non-consented) the moment its turn starts.
    autoplay([host, a], { vote: (voter) => bots.find((b) => b !== voter && b !== quitter)!.id });
    let gone = false;
    quitter.room.onStateChange((s) => {
      if (!gone && s.activeId === quitter.id && (s.phase === "spinning" || s.phase === "placing")) {
        gone = true;
        void quitter.room.leave(false);
      }
    });
    await startMatch(bots);
    await waitFor(() => gone, 30_000, "quitter's turn");
    await waitFor(() => !host.room.state.players.get(quitter.id)?.connected, 3000, "marked disconnected");
    await waitFor(() => phaseOf(host) === "matchEnd", 40_000, "matchEnd despite the quitter");
    expect(host.room.state.players.has(quitter.id)).toBe(false); // grace ran out → removed
    expect(msgs(host, MSG.REVEAL)).toHaveLength(1);
    await leaveAll([host, a]);
  }, 60_000);
});
