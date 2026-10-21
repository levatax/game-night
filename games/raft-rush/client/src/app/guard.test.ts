// Fault isolation: guarded modules log once and keep going, dead stand-ins, frame-clock timers. Owner: client-app.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attempt, deadModule, guard, Later, make, resetLogOnce, step } from "./guard";

class Thing {
  calls = 0;
  readonly child = { boom(): void {
    throw new Error("child boom");
  } };
  ok(n: number): number {
    this.calls++;
    return n * 2;
  }
  boom(): number {
    throw new Error("boom");
  }
  async later(): Promise<number> {
    throw new Error("async boom");
  }
}

beforeEach(() => {
  resetLogOnce();
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("guard", () => {
  it("passes calls through and turns throws into a single logged undefined", async () => {
    const t = guard("thing", new Thing(), ["child"]);
    expect(t.ok(2)).toBe(4);
    expect(t.calls).toBe(1);
    expect(t.boom()).toBeUndefined();
    expect(t.boom()).toBeUndefined();
    expect(console.error).toHaveBeenCalledTimes(1);
    await expect(t.later()).resolves.toBeUndefined();
    expect(() => t.child.boom()).not.toThrow();
  });

  it("missing methods become logged no-ops", () => {
    const t = guard("thing", new Thing()) as Thing & { notThere(): void };
    expect(() => t.notThere()).not.toThrow();
  });

  it("make() falls back to a dead module whose every call is a no-op", () => {
    const built = make<Thing>("thing", () => {
      throw new Error("ctor");
    });
    expect(built.ok).toBe(false);
    expect(() => built.value.ok(1)).not.toThrow();
    const dead = deadModule<{ a: { b(): void } }>();
    expect(() => dead.a.b()).not.toThrow();
  });

  it("step / attempt keep the frame going", () => {
    let after = false;
    step("x", () => {
      throw new Error("x");
    });
    after = true;
    expect(after).toBe(true);
    expect(attempt("y", 7, () => {
      throw new Error("y");
    })).toBe(7);
  });
});

describe("Later", () => {
  it("runs callbacks on the frame clock in order, and cancels them", () => {
    const later = new Later();
    const seen: string[] = [];
    later.update(1000);
    later.run(200, "b", () => seen.push("b"));
    later.run(100, "a", () => seen.push("a"));
    later.update(1150);
    expect(seen).toEqual(["a"]);
    later.update(1300);
    expect(seen).toEqual(["a", "b"]);
    later.run(10, "c", () => seen.push("c"));
    later.cancelAll();
    later.update(5000);
    expect(seen).toEqual(["a", "b"]);
  });
});
