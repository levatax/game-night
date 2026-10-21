// Reconnect ticket storage tests. Owner: client-net.

import { describe, expect, it } from "vitest";
import { RECONNECT_STORAGE_KEY } from "../../../shared/constants";
import { clearTicket, readTicket, storeTicket, type TicketStorage } from "./reconnectToken";

function memoryStorage(): TicketStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const blocked: TicketStorage = {
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceeded");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("reconnect ticket", () => {
  it("stores { roomId, token } as JSON under RECONNECT_STORAGE_KEY and reads it back", () => {
    const s = memoryStorage();
    storeTicket({ roomId: "ABCD", token: "ABCD:xyz" }, s);
    expect(JSON.parse(s.data.get(RECONNECT_STORAGE_KEY)!)).toEqual({ roomId: "ABCD", token: "ABCD:xyz" });
    expect(readTicket(s)).toEqual({ roomId: "ABCD", token: "ABCD:xyz" });
  });

  it("clears it", () => {
    const s = memoryStorage();
    storeTicket({ roomId: "ABCD", token: "t" }, s);
    clearTicket(s);
    expect(readTicket(s)).toBeNull();
  });

  it("ignores empty tokens and garbage", () => {
    const s = memoryStorage();
    storeTicket({ roomId: "ABCD", token: "" }, s);
    expect(s.data.size).toBe(0);
    s.data.set(RECONNECT_STORAGE_KEY, "not json");
    expect(readTicket(s)).toBeNull();
    s.data.set(RECONNECT_STORAGE_KEY, JSON.stringify({ roomId: 5 }));
    expect(readTicket(s)).toBeNull();
    s.data.set(RECONNECT_STORAGE_KEY, JSON.stringify({ token: "t" }));
    expect(readTicket(s)).toEqual({ roomId: "", token: "t" });
  });

  it("never throws on missing or blocked storage", () => {
    expect(readTicket(null)).toBeNull();
    expect(readTicket(blocked)).toBeNull();
    expect(() => storeTicket({ roomId: "A", token: "t" }, blocked)).not.toThrow();
    expect(() => clearTicket(blocked)).not.toThrow();
    expect(() => storeTicket({ roomId: "A", token: "t" }, null)).not.toThrow();
  });
});
