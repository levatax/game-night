// Input queues (server/world/inputs.ts) and RaftWorld's use of them. Owner: server-world.

import { describe, expect, it } from "vitest";
import { INPUT_QUEUE_MAX, PITCH_LIMIT } from "../../shared/constants.js";
import { BTN, BUTTON_MASK, type InputCmd } from "../../shared/protocol.js";
import { InputQueues, REPEAT_HOLD_TICKS, sanitizeInput } from "./inputs.js";
import { Bench } from "./testkit.js";

const cmd = (seq: number, buttons = 0): InputCmd => ({ seq, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons });

describe("sanitizeInput", () => {
  it("clamps and masks; rejects malformed payloads", () => {
    const c = sanitizeInput({ seq: 3, moveX: 2, moveZ: 2, yaw: 10, pitch: 9, buttons: 0xfffff })!;
    expect(Math.hypot(c.moveX, c.moveZ)).toBeCloseTo(1, 9);
    expect(c.pitch).toBe(PITCH_LIMIT);
    expect(c.yaw).toBeGreaterThan(-Math.PI);
    expect(c.yaw).toBeLessThanOrEqual(Math.PI);
    expect(c.buttons).toBe(BUTTON_MASK);
    expect(sanitizeInput(null)).toBeNull();
    expect(sanitizeInput({ ...cmd(0) })).toBeNull();
    expect(sanitizeInput({ ...cmd(1), moveX: Number.NaN })).toBeNull();
    expect(sanitizeInput({ ...cmd(1), buttons: 1.5 })).toBeNull();
  });
});

describe("InputQueues", () => {
  it("drops stale seqs, repeats the last input without edges, carries edges of dropped inputs", () => {
    const q = new InputQueues();
    expect(q.push("a", cmd(2, BTN.THROW | BTN.JUMP))).toBe(true);
    expect(q.push("a", cmd(2))).toBe(false);
    expect(q.push("a", cmd(1))).toBe(false);
    expect(q.take("a")).toEqual({ cmd: cmd(2, BTN.THROW | BTN.JUMP), consumed: true });
    expect(q.take("a")).toEqual({ cmd: cmd(2, BTN.THROW), consumed: false });
    for (let s = 3; s < 3 + INPUT_QUEUE_MAX; s++) q.push("a", cmd(s, s === 3 ? BTN.INTERACT_PRESS : 0));
    q.push("a", cmd(3 + INPUT_QUEUE_MAX));
    expect(q.queuedCount("a")).toBe(INPUT_QUEUE_MAX);
    const next = q.take("a")!.cmd;
    expect(next.seq).toBe(4);
    expect(next.buttons & BTN.INTERACT_PRESS).toBeTruthy();
    q.clear("a");
    expect(q.push("a", cmd(1))).toBe(true);
  });

  it("a silent client stops moving / sprinting / channeling after REPEAT_HOLD_TICKS, keeping look and a held charge", () => {
    const q = new InputQueues();
    q.push("a", { seq: 1, moveX: 0, moveZ: 1, yaw: 0.5, pitch: 0.2, buttons: BTN.SPRINT | BTN.INTERACT | BTN.THROW });
    q.take("a");
    for (let i = 0; i < REPEAT_HOLD_TICKS; i++) expect(q.take("a")!.cmd.moveZ).toBe(1);
    const held = q.take("a")!.cmd;
    expect(held).toMatchObject({ moveX: 0, moveZ: 0, yaw: 0.5, pitch: 0.2, buttons: BTN.THROW });
    q.push("a", { seq: 2, moveX: 0, moveZ: 1, yaw: 0, pitch: 0, buttons: BTN.SPRINT });
    expect(q.take("a")!.cmd.moveZ).toBe(1);
    expect(q.take("a")!.cmd).toMatchObject({ moveZ: 1, buttons: BTN.SPRINT });
  });

  it("a new match empties every queue, keeps the last seen seqs and forgets players no longer in the room", () => {
    const q = new InputQueues();
    q.push("a", cmd(5));
    q.push("gone", cmd(3));
    q.resetQueues((id) => id === "a");
    expect(q.ids()).toEqual(["a"]);
    expect(q.queuedCount("a")).toBe(0);
    expect(q.take("a")).toBeNull();
    expect(q.push("a", cmd(5))).toBe(false);
    expect(q.push("gone", cmd(1))).toBe(true);
    q.resetQueues();
    expect(q.ids()).toEqual(["a", "gone"]);
  });
});

describe("RaftWorld inputs", () => {
  it("one input per tick, lastSeq echoes the consumed seq; washed players' inputs are ignored", () => {
    const b = new Bench([["a"], ["b"]]);
    const a = b.place("a", 0, 0, 0);
    b.send("a", { moveZ: 1 });
    b.send("a", { moveZ: 1 });
    b.tick();
    expect(a.lastSeq).toBe(1);
    b.tick();
    expect(a.lastSeq).toBe(2);
    expect(a.z).toBeLessThan(0);
    const w = b.p("b");
    w.alive = false;
    w.washed = true;
    b.send("b", { moveZ: 1 });
    b.tick();
    expect(w.lastSeq).toBe(0);
    b.world.clearInputs("a");
    expect(a.lastSeq).toBe(0);
  });
});
