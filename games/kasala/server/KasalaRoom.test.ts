// Real Colyseus protocol tests (in-process server, fast timings, seeded rng): a two-player match with bets and a
// loan, lobby bots, a whole match against bots, the first-card rule, the early bet close / PAS, a walk-out taken
// over by a bot, a Battle Royale leaver, the host blip, Son Şans for a dropped player and loan spam.
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { Client, type Room } from "colyseus.js";
import { BOT_NAMES, MAX_PLAYERS, ROOM_NAME, START_KASA } from "../shared/constants.js";
import { MSG } from "../shared/protocol.js";
import type {
  AttackMsg,
  BetsSettledMsg,
  CardMsg,
  CashedMsg,
  KasalaStateView,
  LoanMsg,
  MatchEndMsg,
  NoticeMsg,
  RaidedMsg,
} from "../shared/protocol.js";
import { KasalaRoom } from "./KasalaRoom.js";

process.env.KASALA_TEST = "1";
let server: Server;
let endpoint = "";
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const waitFor = async (check: () => boolean, label: string, timeout = 6000): Promise<void> => {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${label}`);
    await sleep(10);
  }
};

beforeAll(async () => {
  const httpServer = http.createServer();
  server = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
  server.define(ROOM_NAME, KasalaRoom);
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  endpoint = `ws://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});
afterAll(async () => { await server?.gracefullyShutdown(false); });

type TableRoom = Room<KasalaStateView>;
/** A connected test client with every message it received, by type. */
interface Peer { room: TableRoom; messages: Map<string, unknown[]> }
function peer(room: TableRoom): Peer {
  const p: Peer = { room, messages: new Map() };
  room.onMessage("*", (type: string | number, msg: unknown) => {
    const key = String(type);
    const list = p.messages.get(key) ?? [];
    list.push(msg);
    p.messages.set(key, list);
  });
  return p;
}
const events = <T>(p: Peer, type: string): T[] => (p.messages.get(type) ?? []) as T[];
const notices = (p: Peer): string[] => events<NoticeMsg>(p, MSG.NOTICE).map((n) => n.text);
const create = async (opts: Record<string, unknown>): Promise<Peer> => peer(await new Client(endpoint).create<KasalaStateView>(ROOM_NAME, opts));
const join = async (roomId: string, nickname: string): Promise<Peer> =>
  peer(await new Client(endpoint).joinById<KasalaStateView>(roomId, { nickname }));
const closeAll = async (peers: Peer[]): Promise<void> => {
  await Promise.all(peers.map((p) => (p.room.connection.isOpen ? p.room.leave(true).catch(() => undefined) : Promise.resolve())));
};
/** Every dollar at the table: kasas, kumbara, turn pot and real-money stakes. */
const money = (s: KasalaStateView): number => {
  let sum = s.kumbara + s.turnPot;
  s.players.forEach((p) => {
    if (!p.spectator) sum += p.kasa;
  });
  s.bets.forEach((b) => {
    if (!b.ghost) sum += b.amount;
  });
  return sum;
};

/**
 * A simple human: PAS on everyone else's bet window (unless `pas` is false), flip until `cashAt` cards, then
 * KASALA. The server stays authoritative for everything.
 */
function autoplay(p: Peer, opts: { pas?: boolean; cashAt?: number } = {}): void {
  const fired = new Set<string>();
  const me = p.room.sessionId;
  p.room.onStateChange((s) => {
    const turn = `${s.round}:${s.turnInRound}:${s.activeId}`;
    if (s.phase === "betting" && s.activeId && s.activeId !== me && opts.pas !== false && !fired.has(`pas:${turn}`)) {
      if (s.turnOrder.indexOf(me) >= 0) {
        fired.add(`pas:${turn}`);
        p.room.send(MSG.BET, { box: "cash", amount: 0 });
      }
    }
    if (s.phase === "flipping" && s.activeId === me && !s.busy) {
      const key = `${turn}:${s.flips}`;
      if (fired.has(key)) return;
      fired.add(key);
      p.room.send(s.flips < (opts.cashAt ?? 1) ? MSG.FLIP : MSG.CASH, {});
    }
  });
}

/** Act on synced phases once. The server remains authoritative for card, bet and loan outcomes. */
function drive(host: Peer, guest: Peer): void {
  const fired = new Set<string>();
  const act = (s: KasalaStateView) => {
    const turn = `${s.round}:${s.turnInRound}`;
    if (s.phase === "betting" && s.activeId === host.room.sessionId) {
      if (!fired.has("bet")) { fired.add("bet"); guest.room.send(MSG.BET, { box: "cash", amount: 10 }); }
      if (!fired.has("offer")) {
        fired.add("offer");
        host.room.send(MSG.LOAN_PROPOSE, { toId: guest.room.sessionId, kind: "offer", amount: 50, ratePct: 10 });
      }
    }
    if (s.phase === "flipping" && !s.busy) {
      const actor = s.activeId === host.room.sessionId ? host.room : guest.room;
      if (s.flips === 0 && !fired.has(`flip:${turn}`)) {
        fired.add(`flip:${turn}`);
        actor.send(MSG.FLIP, {});
      } else if (s.flips >= 1 && !fired.has(`cash:${turn}`)) {
        fired.add(`cash:${turn}`);
        actor.send(MSG.CASH, {});
      }
    }
    const offer = [...s.offers.values()].find((o) => o.fromId === host.room.sessionId && o.toId === guest.room.sessionId);
    if (offer && !fired.has(`accept:${offer.id}`)) {
      fired.add(`accept:${offer.id}`);
      guest.room.send(MSG.LOAN_RESPOND, { offerId: offer.id, accept: true });
    }
    const debt = [...s.debts.values()].find((d) => d.lenderId === host.room.sessionId && d.borrowerId === guest.room.sessionId);
    if (debt && !fired.has(`repay:${debt.id}`)) {
      fired.add(`repay:${debt.id}`);
      guest.room.send(MSG.LOAN_REPAY, { debtId: debt.id, amount: 20 });
    }
  };
  host.room.onStateChange(act);
  guest.room.onStateChange(act);
}

describe("KasalaRoom e2e", () => {
  it("runs a two-player match with a side bet, loan, repayment, final table and rematch", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 17, rounds: 1, cards: ["tomar", "bozukluk"] });
    const guest = await join(host.room.roomId, "Fare");
    try {
      await waitFor(() => host.room.state?.players?.size === 2 && guest.room.state?.players?.size === 2, "both players synced");
      expect(host.room.state.hostId).toBe(host.room.sessionId);
      expect(host.room.state.code).toMatch(/^[A-Z]{4}$/);
      drive(host, guest);
      guest.room.send(MSG.READY, { ready: true });
      await waitFor(() => host.room.state.players.get(guest.room.sessionId)?.ready === true, "guest ready");
      host.room.send(MSG.START, {});
      await waitFor(() => host.room.state.phase === "matchEnd", "match end", 12_000);
      await waitFor(() => events<MatchEndMsg>(host, MSG.MATCH_END).length > 0, "end event");

      const cards = events<CardMsg>(host, MSG.CARD);
      expect(cards.map((c) => c.card)).toEqual(["tomar", "bozukluk"]);
      expect(cards.map((c) => c.value)).toEqual([50, 20]); // One-round match is SON MASA ×2.
      const cashed = events<CashedMsg>(host, MSG.CASHED);
      expect(cashed.map((m) => m.pot)).toEqual([50, 20]);
      expect(cashed.every((m) => m.resultSec > 0)).toBe(true);
      const bet = events<BetsSettledMsg>(host, MSG.BETS_SETTLED).flatMap((m) => m.results).find((r) => r.playerId === guest.room.sessionId);
      expect(bet).toMatchObject({ box: "cash", amount: 10, won: true, delta: 30 }); // ×1.5, doubled at SON MASA.
      const loans = events<LoanMsg>(host, MSG.LOAN);
      expect(loans.map((m) => m.event)).toContain("accepted");
      expect(loans.some((m) => m.event === "repaid" && m.amount === 20)).toBe(true);
      expect(events<unknown>(host, MSG.ROUND_END)).toHaveLength(1);
      const end = events<MatchEndMsg>(host, MSG.MATCH_END)[0]!;
      // One completed round adds 10% interest to the remaining 30$ before collection.
      expect(end.collections).toEqual([expect.objectContaining({ paid: 33, wiped: 0 })]);
      expect(end.standings.map((p) => p.place)).toEqual([1, 2]);
      expect([...host.room.state.players.values()].map((p) => p.place).sort()).toEqual([1, 2]);

      guest.room.send(MSG.REMATCH, {}); // Only the host may reset the table.
      await sleep(100);
      expect(host.room.state.phase).toBe("matchEnd");
      host.room.send(MSG.REMATCH, {});
      await waitFor(() => host.room.state.phase === "lobby" && guest.room.state.phase === "lobby", "rematch lobby");
      expect([...host.room.state.players.values()].every((p) => p.kasa === START_KASA && !p.ready && p.place === 0)).toBe(true);
    } finally {
      await closeAll([host, guest]);
    }
  }, 20_000);

  it("refuses a 0-card KASALA, deals the first card when its timer runs out, then auto-KASALAs", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 5, rounds: 1, cards: ["tomar", "bozukluk"] });
    const guest = await join(host.room.roomId, "Fare");
    try {
      await waitFor(() => host.room.state?.players?.size === 2 && guest.room.state?.players?.size === 2, "both players synced");
      autoplay(guest);
      let triedCash = false;
      host.room.onStateChange((s) => {
        if (s.phase === "flipping" && s.activeId === host.room.sessionId && !s.busy && s.flips === 0 && !triedCash) {
          triedCash = true;
          host.room.send(MSG.CASH, {}); // Not allowed before the first card.
        }
      });
      guest.room.send(MSG.READY, { ready: true });
      await waitFor(() => host.room.state.players.get(guest.room.sessionId)?.ready === true, "guest ready");
      host.room.send(MSG.START, {});
      await waitFor(() => events<CashedMsg>(host, MSG.CASHED).length >= 1, "host's turn ends", 8000);

      expect(triedCash).toBe(true);
      expect(notices(host)).toContain("Önce bir kart çevir!");
      const card = events<CardMsg>(host, MSG.CARD)[0]!;
      expect(card).toMatchObject({ playerId: host.room.sessionId, flipNo: 1, card: "tomar" });
      const cashed = events<CashedMsg>(host, MSG.CASHED)[0]!;
      expect(cashed).toMatchObject({ playerId: host.room.sessionId, flips: 1, auto: true, pot: 50, skipped: false });

      await waitFor(() => host.room.state.phase === "matchEnd", "match end", 8000);
      expect(events<CashedMsg>(host, MSG.CASHED).every((c) => c.flips >= 1)).toBe(true);
    } finally {
      await closeAll([host, guest]);
    }
  }, 20_000);

  it("closes the bet window early once every bettor bet or passed (PAS)", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 7, rounds: 1 });
    const guest = await join(host.room.roomId, "Fare");
    try {
      await waitFor(() => host.room.state?.players?.size === 2 && guest.room.state?.players?.size === 2, "both players synced");
      autoplay(guest); // PAS on the host's turn.
      autoplay(host, { pas: false }); // Lets the guest's bet window run out.
      const opened = new Map<string, number>();
      const closed = new Map<string, number>();
      host.room.onStateChange((s) => {
        if (s.phase === "betting" && s.activeId && !opened.has(s.activeId)) opened.set(s.activeId, Date.now());
        if (s.phase === "flipping" && s.activeId && !closed.has(s.activeId)) closed.set(s.activeId, Date.now());
      });
      guest.room.send(MSG.READY, { ready: true });
      await waitFor(() => host.room.state.players.get(guest.room.sessionId)?.ready === true, "guest ready");
      host.room.send(MSG.START, {});
      await waitFor(() => host.room.state.phase === "matchEnd", "match end", 10_000);

      const h = host.room.sessionId;
      const g = guest.room.sessionId;
      const hostWindow = closed.get(h)! - opened.get(h)!;
      const guestWindow = closed.get(g)! - opened.get(g)!;
      expect(hostWindow).toBeLessThan(500); // PAS → closes ~0.05 s later instead of 0.8 s.
      expect(guestWindow).toBeGreaterThanOrEqual(600); // Nobody answered → the full round-1 window.
      expect(events<BetsSettledMsg>(host, MSG.BETS_SETTLED)).toHaveLength(0);
    } finally {
      await closeAll([host, guest]);
    }
  }, 20_000);

  it("a walk-out mid-turn is taken over by a bot: the Haraç money and the pot survive, the match goes on", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 9, rounds: 1, cards: ["harac", "tomar"] });
    const guest = await join(host.room.roomId, "Fare");
    const h = host.room.sessionId;
    const g = guest.room.sessionId;
    try {
      await waitFor(() => host.room.state?.players?.size === 2 && guest.room.state?.players?.size === 2, "both players synced");
      autoplay(guest);
      const fired = new Set<number>();
      host.room.onStateChange((s) => {
        if (s.phase === "flipping" && s.activeId === h && !s.busy && s.flips < 2 && !fired.has(s.flips)) {
          fired.add(s.flips);
          host.room.send(MSG.FLIP, {});
        }
      });
      guest.room.send(MSG.READY, { ready: true });
      await waitFor(() => host.room.state.players.get(g)?.ready === true, "guest ready");
      host.room.send(MSG.START, {});
      await waitFor(() => host.room.state.flips === 2 && host.room.state.phase === "flipping" && !host.room.state.busy, "two cards", 8000);

      const attack = events<AttackMsg>(host, MSG.ATTACK)[0]!;
      expect(attack).toMatchObject({ card: "harac", fromId: h, targetId: g, amount: 40, random: false }); // The only target: no wait.
      const before = money(host.room.state);
      expect(host.room.state.turnPot).toBe(90); // 40 Haraç + 50 Tomar (SON MASA).

      await guest.room.leave(true);
      await waitFor(() => host.room.state.players.get(g)?.bot === true, "bot takes the seat");
      const seat = host.room.state.players.get(g)!;
      expect(seat).toMatchObject({ nickname: "Fare", connected: true, kasa: 160 });
      expect(host.room.state.phase).toBe("flipping");

      host.room.send(MSG.CASH, {});
      await waitFor(() => host.room.state.phase === "result" || host.room.state.phase === "settle", "host cashed");
      expect(events<CashedMsg>(host, MSG.CASHED)[0]).toMatchObject({ playerId: h, pot: 90, kept: 90 });
      expect(money(host.room.state)).toBe(before);
      expect(host.room.state.players.get(h)!.kasa).toBe(290);

      await waitFor(() => host.room.state.phase === "matchEnd", "match end", 10_000);
      expect(events<CardMsg>(host, MSG.CARD).some((c) => c.playerId === g)).toBe(true); // The bot played the turn.
      expect(notices(host).some((n) => n.includes("yeterli oyuncu"))).toBe(false);
      expect(events<MatchEndMsg>(host, MSG.MATCH_END)[0]!.standings).toHaveLength(2);

      // The taken-over seat leaves the table at the rematch.
      host.room.send(MSG.REMATCH, {});
      await waitFor(() => host.room.state.phase === "lobby", "rematch lobby");
      expect(host.room.state.players.has(g)).toBe(false);
    } finally {
      await closeAll([host, guest]);
    }
  }, 25_000);

  it("Battle Royale: a leaver's seat plays on as a bot, survivors rank above the ghosts", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 13, rounds: 3, startKasa: 20, cards: ["baskin"] });
    host.room.send(MSG.SETTINGS, { mode: "royale" });
    const a = await join(host.room.roomId, "Deniz");
    const b = await join(host.room.roomId, "Cem");
    const aId = a.room.sessionId;
    try {
      await waitFor(() => host.room.state?.players?.size === 3 && host.room.state.settings.mode === "royale", "royale lobby");
      autoplay(host);
      autoplay(b);
      a.room.send(MSG.READY, { ready: true });
      b.room.send(MSG.READY, { ready: true });
      await waitFor(() => [...host.room.state.players.values()].every((p) => p.ready || p.id === host.room.sessionId), "ready");
      host.room.send(MSG.START, {});
      await waitFor(() => host.room.state.phase === "intro", "intro");
      await a.room.leave(true);
      await waitFor(() => host.room.state.players.get(aId)?.bot === true, "bot takes Deniz's seat");
      await waitFor(() => host.room.state.phase === "matchEnd", "match end", 40_000);
      await waitFor(() => events<MatchEndMsg>(host, MSG.MATCH_END).length > 0, "end event");

      expect(events<RaidedMsg>(host, MSG.RAIDED)[0]).toMatchObject({ playerId: host.room.sessionId, flipNo: 1 });
      expect(events<RaidedMsg>(host, MSG.RAIDED).every((r) => r.resultSec > 0 && typeof r.long === "boolean")).toBe(true);
      expect(host.room.state.players.get(aId)).toMatchObject({ nickname: "Deniz", bot: true });
      expect(events<CardMsg>(host, MSG.CARD).some((c) => c.playerId === aId)).toBe(true);
      expect(notices(host).some((n) => n.includes("yeterli oyuncu"))).toBe(false);

      const end = events<MatchEndMsg>(host, MSG.MATCH_END)[0]!;
      expect(end.standings).toHaveLength(3);
      const ghost = (id: string) => !!host.room.state.players.get(id)?.ghost;
      const flags = end.standings.map((row) => ghost(row.playerId));
      expect(flags[0]).toBe(false); // The winner is still at the table.
      expect(flags.indexOf(true) === -1 || flags.slice(flags.indexOf(true)).every(Boolean)).toBe(true);
      expect(end.winnerId).toBe(end.standings[0]!.playerId);
    } finally {
      await closeAll([host, a, b]);
    }
  }, 50_000);
});

describe("KasalaRoom bots", () => {
  it("host-only lobby bots: fill the table, give a seat to a joining human, can be removed, never host", async () => {
    const host = await create({ nickname: "Kedi", fast: true });
    const guest = await join(host.room.roomId, "Fare");
    const extra: Peer[] = [];
    try {
      await waitFor(() => host.room.state?.players?.size === 2, "both players synced");
      guest.room.send(MSG.ADD_BOT, {}); // Not the host.
      await sleep(100);
      expect(host.room.state.players.size).toBe(2);

      for (let i = 0; i < MAX_PLAYERS; i++) host.room.send(MSG.ADD_BOT, {});
      await waitFor(() => host.room.state.players.size === MAX_PLAYERS, "table full");
      await waitFor(() => notices(host).some((n) => n.includes("Masa dolu")), "table full notice");
      const bots = [...host.room.state.players.values()].filter((p) => p.bot);
      expect(bots).toHaveLength(MAX_PLAYERS - 2);
      expect(bots.every((p) => p.ready && p.connected && (BOT_NAMES as readonly string[]).includes(p.nickname))).toBe(true);
      const all = [...host.room.state.players.values()];
      expect(new Set(all.map((p) => p.animal)).size).toBe(all.length);
      expect(new Set(all.map((p) => p.color)).size).toBe(all.length);
      expect(new Set(all.map((p) => p.seat)).size).toBe(all.length);

      // A human joining a full lobby takes the newest bot's seat.
      const newest = bots.reduce((x, y) => (y.seat > x.seat ? y : x));
      extra.push(await join(host.room.roomId, "Tavşan"));
      await waitFor(() => host.room.state.players.has(extra[0]!.room.sessionId) && !host.room.state.players.has(newest.id), "bot made room");
      expect(host.room.state.players.size).toBe(MAX_PLAYERS);

      const first = bots[0]!;
      guest.room.send(MSG.REMOVE_BOT, { id: first.id }); // Not the host.
      host.room.send(MSG.REMOVE_BOT, { id: guest.room.sessionId }); // Not a bot.
      await sleep(100);
      expect(host.room.state.players.has(first.id)).toBe(true);
      expect(host.room.state.players.has(guest.room.sessionId)).toBe(true);
      host.room.send(MSG.REMOVE_BOT, { id: first.id });
      await waitFor(() => !host.room.state.players.has(first.id), "bot removed");

      // The host walks out: the next human gets the table, never a bot.
      await host.room.leave(true);
      await waitFor(() => guest.room.state.hostId !== host.room.sessionId, "host migrated");
      expect(guest.room.state.players.get(guest.room.state.hostId)?.bot).toBe(false);
    } finally {
      await closeAll([host, guest, ...extra]);
    }
  }, 15_000);

  it("plays a whole match with one human and three bots (flips, bets, targets on their own)", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 21, rounds: 2 });
    try {
      await waitFor(() => host.room.state?.players?.size === 1, "host synced");
      for (let i = 0; i < 3; i++) host.room.send(MSG.ADD_BOT, {});
      await waitFor(() => host.room.state.players.size === 4, "three bots");
      autoplay(host);
      host.room.send(MSG.START, {}); // Bots are always ready; a solo human can start.
      await waitFor(() => host.room.state.phase === "matchEnd", "match end", 45_000);
      await waitFor(() => events<MatchEndMsg>(host, MSG.MATCH_END).length > 0, "end event");

      const bots = [...host.room.state.players.values()].filter((p) => p.bot).map((p) => p.id);
      expect(bots).toHaveLength(3);
      const cards = events<CardMsg>(host, MSG.CARD);
      for (const id of bots) expect(cards.some((c) => c.playerId === id)).toBe(true);
      const settled = events<BetsSettledMsg>(host, MSG.BETS_SETTLED).flatMap((m) => m.results);
      expect(settled.some((r) => bots.includes(r.playerId))).toBe(true);
      const cashed = events<CashedMsg>(host, MSG.CASHED);
      expect(cashed.every((c) => c.skipped || c.flips >= 1)).toBe(true);
      // Bots decide well before their timers: they never get auto-KASALA'd.
      expect(cashed.filter((c) => bots.includes(c.playerId)).every((c) => !c.auto)).toBe(true);
      const end = events<MatchEndMsg>(host, MSG.MATCH_END)[0]!;
      expect(end.standings).toHaveLength(4);
      expect(host.room.state.hostId).toBe(host.room.sessionId);

      // Lobby bots stay for the rematch, ready.
      host.room.send(MSG.REMATCH, {});
      await waitFor(() => host.room.state.phase === "lobby", "rematch lobby");
      expect([...host.room.state.players.values()].filter((p) => p.bot && p.ready)).toHaveLength(3);
    } finally {
      await closeAll([host]);
    }
  }, 60_000);
});

describe("KasalaRoom table manners", () => {
  it("the host gets the table back after a short disconnect", async () => {
    const host = await create({ nickname: "Kedi", fast: true });
    const guest = await join(host.room.roomId, "Fare");
    let back: Peer | null = null;
    try {
      await waitFor(() => guest.room.state?.players?.size === 2, "both players synced");
      const h = host.room.sessionId;
      const token = host.room.reconnectionToken;
      host.room.connection.close(); // Not consented: the seat is held for the grace period.
      await waitFor(() => guest.room.state.hostId === guest.room.sessionId, "host moved on");
      back = peer(await new Client(endpoint).reconnect<KasalaStateView>(token));
      await waitFor(() => guest.room.state.hostId === h, "host back");
      expect(guest.room.state.players.get(h)?.connected).toBe(true);
    } finally {
      await closeAll([guest, ...(back ? [back] : [])]);
    }
  }, 15_000);

  it("Son Şans for a disconnected broke player doesn't wait for a loan that can't reach them", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 13, rounds: 3, startKasa: 20, cards: ["baskin"] });
    host.room.send(MSG.SETTINGS, { mode: "royale" });
    const a = await join(host.room.roomId, "Deniz");
    const b = await join(host.room.roomId, "Cem");
    const h = host.room.sessionId;
    try {
      await waitFor(() => host.room.state?.players?.size === 3 && host.room.state.settings.mode === "royale", "royale lobby");
      autoplay(host);
      autoplay(a);
      autoplay(b);
      a.room.send(MSG.READY, { ready: true });
      b.room.send(MSG.READY, { ready: true });
      await waitFor(() => [...host.room.state.players.values()].every((p) => p.ready || p.id === h), "ready");
      host.room.send(MSG.START, {});
      // The host's first card is a raid that takes all 20$; they drop before the turn ends (no consented leave).
      await waitFor(() => events<RaidedMsg>(a, MSG.RAIDED).some((r) => r.playerId === h), "host raided");
      host.room.connection.close();
      await waitFor(() => events<{ playerId: string }>(a, MSG.LAST_CHANCE).some((m) => m.playerId === h), "Son Şans");
      const started = Date.now();
      // Two connected players could lend (full Son Şans in fast timings is 1.2 s), but no offer can reach them.
      await waitFor(() => events<{ playerId: string }>(a, MSG.ELIMINATED).some((m) => m.playerId === h), "eliminated", 3000);
      expect(Date.now() - started).toBeLessThan(800);
    } finally {
      await closeAll([a, b]);
    }
  }, 20_000);

  it("rate-limits loan proposals and doesn't re-broadcast an identical offer", async () => {
    const host = await create({ nickname: "Kedi", fast: true, seed: 3, rounds: 1 });
    const guest = await join(host.room.roomId, "Fare");
    try {
      await waitFor(() => host.room.state?.players?.size === 2 && guest.room.state?.players?.size === 2, "both players synced");
      guest.room.send(MSG.READY, { ready: true });
      await waitFor(() => host.room.state.players.get(guest.room.sessionId)?.ready === true, "guest ready");
      host.room.send(MSG.START, {});
      await waitFor(() => host.room.state.phase === "betting", "first turn");
      const offer = { toId: guest.room.sessionId, kind: "offer", amount: 50, ratePct: 10 };
      host.room.send(MSG.LOAN_PROPOSE, offer);
      host.room.send(MSG.LOAN_PROPOSE, { ...offer, amount: 40 }); // Inside the cooldown: ignored.
      await waitFor(() => events<LoanMsg>(host, MSG.LOAN).length >= 1, "proposed");
      await sleep(300);
      host.room.send(MSG.LOAN_PROPOSE, offer); // Same offer again: the clock restarts, nothing is broadcast.
      await sleep(300);
      host.room.send(MSG.LOAN_PROPOSE, { ...offer, amount: 60 }); // A new offer replaces the old one.
      await waitFor(() => events<LoanMsg>(host, MSG.LOAN).length >= 3, "replaced");
      await sleep(100);
      const loans = events<LoanMsg>(host, MSG.LOAN).map((m) => `${m.event}:${m.amount}`);
      expect(loans).toEqual(["proposed:50", "canceled:50", "proposed:60"]);
      expect([...host.room.state.offers.values()].map((o) => o.timeLeft).every((t) => Number.isInteger(t))).toBe(true);
    } finally {
      await closeAll([host, guest]);
    }
  }, 15_000);
});
