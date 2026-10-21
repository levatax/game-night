// Share links, room codes, nicknames, the reconnect window, the expired-seat note, the ticket's room and the boot
// choice between that ticket and an invite link to another room. Owner: client-app.

import { afterEach, describe, expect, it, vi } from "vitest";
import { RECONNECT_STORAGE_KEY } from "../../../shared/constants";
import {
  cleanNickname,
  dropStaleTicket,
  parseRoomCode,
  readRoomCodeFromUrl,
  reconnectTicketRoom,
  ReconnectWindow,
  rejoinTicketAtBoot,
  SeatExpiry,
  shareLink,
} from "./session";

describe("ReconnectWindow", () => {
  it("opens on the first attempt, follows the attempt number and closes once", () => {
    const w = new ReconnectWindow();
    expect(w.attempt).toBeNull();
    expect(w.attempted(1)).toBe(true);
    expect(w.attempt).toBe(1);
    expect(w.attempted(2)).toBe(false);
    expect(w.attempted(3)).toBe(false);
    expect(w.attempt).toBe(3);
    expect(w.close()).toBe(true);
    expect(w.attempt).toBeNull();
    expect(w.close()).toBe(false);
  });

  it("a new drop opens a new window; junk attempt numbers read as 1", () => {
    const w = new ReconnectWindow();
    w.attempted(4);
    w.close();
    expect(w.attempted(Number.NaN)).toBe(true);
    expect(w.attempt).toBe(1);
  });
});

describe("SeatExpiry", () => {
  it("flags only the auto-join of the expired room, once", () => {
    const s = new SeatExpiry();
    s.expired("ABCD", "abcd");
    expect(s.settle("ABCD", true)).toBe(true);
    expect(s.settle("ABCD", true)).toBe(false);
  });

  it("forgets the note after a failed join, another room or a create", () => {
    const s = new SeatExpiry();
    s.expired("ABCD", "ABCD");
    expect(s.settle("ABCD", false)).toBe(false);
    expect(s.settle("ABCD", true)).toBe(false);
    s.expired("ABCD", "ABCD");
    expect(s.settle("WXYZ", true)).toBe(false);
    s.expired("ABCD", "ABCD");
    expect(s.settle("", true)).toBe(false);
    expect(s.settle("ABCD", true)).toBe(false);
  });

  it("no deep link, no note", () => {
    const s = new SeatExpiry();
    s.expired("", "ABCD");
    expect(s.settle("", true)).toBe(false);
  });

  it("an invite to another room than the stale ticket's is no old seat", () => {
    const s = new SeatExpiry();
    s.expired("WXYZ", "ABCD");
    expect(s.settle("WXYZ", true)).toBe(false);
    s.expired("WXYZ", "");
    expect(s.settle("WXYZ", true)).toBe(false);
  });
});

describe("reconnectTicketRoom", () => {
  afterEach(() => vi.unstubAllGlobals());
  const stubTicket = (raw: string | null): void => {
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => (k === RECONNECT_STORAGE_KEY ? raw : null), setItem: () => undefined, removeItem: () => undefined });
  };

  it("reads the stored ticket's room, upper-cased", () => {
    stubTicket(JSON.stringify({ roomId: "abcd", token: "abcd:tok" }));
    expect(reconnectTicketRoom()).toBe("ABCD");
  });

  it("is empty without a ticket, with junk, or with a ticket that names no room", () => {
    stubTicket(null);
    expect(reconnectTicketRoom()).toBe("");
    stubTicket("not json");
    expect(reconnectTicketRoom()).toBe("");
    stubTicket(JSON.stringify({ token: "tok" }));
    expect(reconnectTicketRoom()).toBe("");
  });
});

describe("boot: reconnect ticket vs invite link", () => {
  afterEach(() => vi.unstubAllGlobals());
  /** A sessionStorage holding `raw` under the ticket key; removeItem really removes it. */
  const stubStore = (raw: string | null): Map<string, string> => {
    const data = new Map<string, string>(raw === null ? [] : [[RECONNECT_STORAGE_KEY, raw]]);
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    return data;
  };

  it("an invite to another room wins over the ticket; the ticket's own room or no link rejoins", () => {
    expect(rejoinTicketAtBoot("WXYZ", "ABCD")).toBe(false);
    expect(rejoinTicketAtBoot("ABCD", "ABCD")).toBe(true);
    expect(rejoinTicketAtBoot("abcd", "ABCD")).toBe(true);
    expect(rejoinTicketAtBoot("", "ABCD")).toBe(true);
    // A ticket that doesn't name its room (can't tell): rejoin as before.
    expect(rejoinTicketAtBoot("WXYZ", "")).toBe(true);
  });

  it("drops a ticket for ABCD when the tab opens an invite to WXYZ, so App follows the link", () => {
    const data = stubStore(JSON.stringify({ roomId: "ABCD", token: "ABCD:tok" }));
    expect(dropStaleTicket("WXYZ")).toBe(true);
    expect(data.has(RECONNECT_STORAGE_KEY)).toBe(false);
    expect(reconnectTicketRoom()).toBe("");
  });

  it("keeps the ticket for its own room's link, without a link and when there is none", () => {
    const ticket = JSON.stringify({ roomId: "ABCD", token: "ABCD:tok" });
    let data = stubStore(ticket);
    expect(dropStaleTicket("ABCD")).toBe(false);
    expect(dropStaleTicket("")).toBe(false);
    expect(data.get(RECONNECT_STORAGE_KEY)).toBe(ticket);
    data = stubStore(null);
    expect(dropStaleTicket("WXYZ")).toBe(false);
    expect(data.size).toBe(0);
  });
});

describe("session helpers", () => {
  it("parses typed codes and pasted share links", () => {
    expect(parseRoomCode(" abcd ")).toBe("ABCD");
    expect(parseRoomCode("https://game.night/r/WXYZ")).toBe("WXYZ");
    expect(parseRoomCode("https://game.night/games/raft-rush/?room=qrst")).toBe("QRST");
    expect(parseRoomCode("ABCI")).toBeNull(); // I is not in the alphabet
    expect(parseRoomCode("ABC")).toBeNull();
    expect(parseRoomCode("")).toBeNull();
  });

  it("reads ?room=CODE and /r/CODE deep links", () => {
    expect(readRoomCodeFromUrl({ search: "?room=abcd", pathname: "/games/raft-rush/" })).toBe("ABCD");
    expect(readRoomCodeFromUrl({ search: "", pathname: "/games/raft-rush/r/WXYZ" })).toBe("WXYZ");
    expect(readRoomCodeFromUrl({ search: "?room=nope!", pathname: "/games/raft-rush/" })).toBeNull();
    expect(readRoomCodeFromUrl({ search: "", pathname: "/games/raft-rush/" })).toBeNull();
  });

  it("builds the hub share link", () => {
    expect(shareLink("ABCD", "https://x.y")).toBe("https://x.y/r/ABCD");
    expect(shareLink("", "https://x.y")).toBe("");
  });

  it("cleans nicknames (trim, collapse spaces, clamp to 16)", () => {
    expect(cleanNickname("  Kaptan   Deniz ")).toBe("Kaptan Deniz");
    expect(cleanNickname("   ")).toBe("");
    expect(cleanNickname("x".repeat(30))).toHaveLength(16);
  });
});
