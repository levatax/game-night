// Unit tests for the bot Motor (server/room/botMotor.ts): edge vs level buttons per goal — slot select then EAT,
// a charged throw held for the planned ticks then released on target, the night torch planted outside the
// raft's keep-out, chest "put" from the selected slot, E pressed past an item that outranks the raft (looking
// away from it, or stepping around the raft first). A tiny fake world applies look / slots / movement / charge
// like stepPlayer does.
// Run: npx vitest run games/raft-rush/server/room

import { describe, expect, it } from "vitest";
import { CHARGE_FULL_TICKS, DT, MONSTERS, PLACE_DISTANCE, THROW_RECOVER_TICKS, WALK_SPEED, timingsFor } from "../../shared/constants.js";
import { isThrowable } from "../../shared/items.js";
import { BTN, type ChestMsg } from "../../shared/protocol.js";
import { resolveInteraction } from "../../shared/rules/interact.js";
import { setSlot, slotCount, slotKind } from "../../shared/rules/inventory.js";
import { buildCover } from "../../shared/sim/cover.js";
import { createProjectileSim, stepProjectile } from "../../shared/sim/projectile.js";
import { computeThrowVelocity, throwOrigin } from "../../shared/sim/throw.js";
import { yawFromDir } from "../../shared/sim/math.js";
import { MonsterState, PlayerState, ProjectileEntity, RaftState, TeamState } from "../schema.js";
import { Motor, posed, type MotorCtx, type MotorFrame } from "./botMotor.js";
import { newSteerMemory } from "./botSteer.js";
import { flatField, query, testIsland } from "./botTestkit.js";
import type { Goal } from "./botTypes.js";

interface Rig {
  state: RaftState;
  p: PlayerState;
  ctx: MotorCtx;
  chestCalls: ChestMsg[];
  releases: { charge: number; yaw: number; pitch: number; x: number; y: number; z: number }[];
  /** Run the motor `n` ticks (or until it stops), applying its inputs. Returns the frames. */
  run(motor: Motor, n: number): MotorFrame[];
}

function rig(): Rig {
  const island = testIsland();
  const state = new RaftState();
  state.phase = "playing";
  state.dayPhase = "day";
  const team = new TeamState();
  team.seats = 2;
  team.fireFuel = 1800;
  state.teams.push(team);
  for (const n of island.nodes) state.nodes.push(n.amount);
  const p = new PlayerState();
  p.id = "bot-1";
  p.bot = true;
  p.alive = true;
  p.x = 0;
  p.y = 1;
  p.z = 0;
  state.players.set(p.id, p);
  const cover = buildCover(island);
  const chestCalls: ChestMsg[] = [];
  const releases: Rig["releases"] = [];
  const ctx: MotorCtx = {
    state,
    island,
    world: { terrain: island.grid, cover, bounds: island.bounds, nav: null },
    timings: timingsFor(false),
    role: "bekci",
    rng: () => 0.5,
    craft: () => true,
    chest: (msg) => {
      chestCalls.push(msg);
      if (msg.op === "put") setSlot(p, p.activeSlot, slotKind(p, p.activeSlot), slotCount(p, p.activeSlot) - (msg.count ?? 99));
      return true;
    },
    velocity: () => ({ vx: 0, vz: 0 }),
    fishStands: () => [],
  };
  const run = (motor: Motor, n: number): MotorFrame[] => {
    const frames: MotorFrame[] = [];
    for (let i = 0; i < n && motor.status === "running"; i++) {
      const f: MotorFrame = { moveX: 0, moveZ: 0, yaw: p.yaw, pitch: p.pitch, buttons: 0 };
      motor.tick(ctx, p, f);
      frames.push(f);
      // look, slots, a little movement
      p.yaw = f.yaw;
      p.pitch = f.pitch;
      for (let s = 0; s < 4; s++) if (f.buttons & (BTN.SLOT1 << s)) p.activeSlot = s;
      const sn = Math.sin(p.yaw);
      const cs = Math.cos(p.yaw);
      p.x += (cs * f.moveX - sn * f.moveZ) * WALK_SPEED * DT;
      p.z += (-sn * f.moveX - cs * f.moveZ) * WALK_SPEED * DT;
      // charge / release like stepPlayer
      if (p.throwTicks > 0) p.throwTicks--;
      const held = slotKind(p, p.activeSlot);
      if (isThrowable(held) && p.throwTicks === 0) {
        if (f.buttons & BTN.THROW) p.chargeTicks = Math.min(CHARGE_FULL_TICKS, p.chargeTicks + 1);
        else if (p.chargeTicks > 0) {
          const o = throwOrigin(p);
          releases.push({ charge: p.chargeTicks / CHARGE_FULL_TICKS, yaw: p.yaw, pitch: p.pitch, x: o.x, y: o.y, z: o.z });
          p.chargeTicks = 0;
          p.throwTicks = THROW_RECOVER_TICKS;
          setSlot(p, p.activeSlot, held, slotCount(p, p.activeSlot) - 1);
        }
      }
      if (f.buttons & BTN.EAT) setSlot(p, p.activeSlot, slotKind(p, p.activeSlot), slotCount(p, p.activeSlot) - 1);
      if (f.buttons & BTN.DROP) setSlot(p, p.activeSlot, slotKind(p, p.activeSlot), slotCount(p, p.activeSlot) - 1);
    }
    return frames;
  };
  return { state, p, ctx, chestCalls, releases, run };
}

const EDGE_BITS = BTN.EAT | BTN.DROP | BTN.USE_PRESS | BTN.INTERACT_PRESS;

describe("Motor", () => {
  it("eats: selects the slot (one edge), then presses F once", () => {
    const r = rig();
    setSlot(r.p, 2, "water", 2);
    const motor = new Motor({ kind: "eat", slot: 2 }, newSteerMemory());
    const frames = r.run(motor, 20);
    expect(frames[0]!.buttons).toBe(BTN.SLOT3);
    expect(frames[1]!.buttons & BTN.EAT).toBe(BTN.EAT);
    expect(frames.filter((f) => f.buttons & BTN.EAT).length).toBe(1);
    expect(motor.status).toBe("done");
    expect(slotCount(r.p, 2)).toBe(1);
  });

  it("charges a throw for the planned ticks and releases it on target", () => {
    const r = rig();
    setSlot(r.p, 0, "stone", 3);
    const crab = new MonsterState();
    crab.id = "m1";
    crab.kind = "crab";
    crab.mode = "hunt";
    crab.x = 2;
    crab.y = 1;
    crab.z = -10;
    r.state.monsters.set(crab.id, crab);
    const goal: Goal = { kind: "attack", monsterId: "m1", slot: 0 };
    const motor = new Motor(goal, newSteerMemory());
    const frames = r.run(motor, 120);
    expect(motor.status).toBe("done");
    expect(r.releases.length).toBe(1);
    // THROW is a level bit: one unbroken run, then let go.
    const held = frames.map((f) => (f.buttons & BTN.THROW) !== 0);
    const first = held.indexOf(true);
    const last = held.lastIndexOf(true);
    expect(held.slice(first, last + 1).every(Boolean)).toBe(true);
    const rel = r.releases[0]!;
    expect(rel.charge * CHARGE_FULL_TICKS).toBe(last - first + 1);
    // The released stone flies into the crab.
    const terrain = flatField(97, 97, 1);
    const pctx = { ...query(terrain), dt: DT };
    const v = computeThrowVelocity(rel.charge, rel.yaw, rel.pitch);
    const b = createProjectileSim("stone");
    Object.assign(b, { x: rel.x, y: rel.y, z: rel.z, vx: v.x, vy: v.y, vz: v.z, state: "live" });
    let best = Infinity;
    for (let i = 0; i < 120 && b.state === "live"; i++) {
      stepProjectile(b, pctx);
      best = Math.min(best, Math.hypot(b.x - crab.x, b.y - (crab.y + MONSTERS.crab.height / 2), b.z - crab.z));
    }
    expect(best).toBeLessThan(MONSTERS.crab.radius);
    for (let i = 1; i < frames.length; i++) expect(frames[i - 1]!.buttons & frames[i]!.buttons & EDGE_BITS).toBe(0);
  });

  it("plants the night torch outside the raft's keep-out, facing the raft", () => {
    const r = rig();
    setSlot(r.p, 1, "torch", 1);
    const motor = new Motor({ kind: "plantTorch", slot: 1 }, newSteerMemory());
    const frames = r.run(motor, 600);
    const drop = frames.findIndex((f) => (f.buttons & BTN.DROP) !== 0);
    expect(drop).toBeGreaterThan(0);
    expect(motor.status).toBe("done");
    // Where the torch lands: PLACE_DISTANCE in front of the player.
    const raft = r.ctx.island.sites[0]!.raft;
    const fx = r.p.x - Math.sin(r.p.yaw) * PLACE_DISTANCE;
    const fz = r.p.z - Math.cos(r.p.yaw) * PLACE_DISTANCE;
    const landed = Math.hypot(fx - raft.x, fz - raft.z);
    expect(landed).toBeGreaterThan(2.2);
    expect(landed).toBeLessThan(3.5);
  });

  it("puts into the chest from the selected slot", () => {
    const r = rig();
    const chest = r.ctx.island.sites[0]!.chest;
    r.p.x = chest.x + 1.4;
    r.p.z = chest.z;
    setSlot(r.p, 1, "wood", 3);
    setSlot(r.p, 3, "stone", 2);
    const motor = new Motor({ kind: "chestPut", items: [{ kind: "stone", count: 2 }, { kind: "wood", count: 3 }] }, newSteerMemory());
    r.run(motor, 120);
    expect(motor.status).toBe("done");
    expect(r.chestCalls).toEqual([
      { op: "put", count: 2 },
      { op: "put", count: 3 },
    ]);
    expect(slotKind(r.p, 1)).toBe("");
    expect(slotKind(r.p, 3)).toBe("");
  });

  it("boards past an item that outranks the raft: looks away from it, or steps around it, never presses E on it", () => {
    // 1.4 m ahead: turning away gets it out of the view cone. 0.35 m: at the bot's feet it's reachable from every
    // side, so the bot first steps around the raft.
    for (const ahead of [1.4, 0.35]) {
      const r = rig();
      r.state.teams[0]!.stage = 3;
      const { raft, campfire } = r.ctx.island.sites[0]!;
      const l = Math.hypot(campfire.x - raft.x, campfire.z - raft.z);
      const ux = (campfire.x - raft.x) / l;
      const uz = (campfire.z - raft.z) / l;
      // The board flow's land-side stand point, facing the raft, with a coconut lying between.
      r.p.x = raft.x + ux * 2.4;
      r.p.z = raft.z + uz * 2.4;
      r.p.yaw = yawFromDir(-ux, -uz);
      const c = new ProjectileEntity();
      c.id = "c1";
      c.kind = "coconut";
      c.x = r.p.x - ux * ahead;
      c.y = 1;
      c.z = r.p.z - uz * ahead;
      r.state.projectiles.set(c.id, c);
      const world = { island: r.ctx.island, state: r.state };
      expect(resolveInteraction(world, r.p)?.kind).toBe("pickup"); // E right now would pick it up
      const motor = new Motor({ kind: "board" }, newSteerMemory());
      const pressed: string[] = [];
      for (let i = 0; i < 200 && motor.status === "running"; i++) {
        const f = r.run(motor, 1)[0]!;
        if (!(f.buttons & BTN.INTERACT_PRESS)) continue;
        // What the server resolves: the seat after it took the command's look and step (the rig applied both).
        pressed.push(resolveInteraction(world, r.p)?.kind ?? "none");
        r.p.boarded = true;
      }
      expect(pressed, `coconut ${ahead} m ahead`).toEqual(["board"]);
      expect(motor.status).toBe("done");
      if (ahead < 1) expect(Math.hypot(r.p.x - raft.x - ux * 2.4, r.p.z - raft.z - uz * 2.4)).toBeGreaterThan(0.8);
    }
  });

  it("posed() reads a seat at another spot and look without writing it", () => {
    const r = rig();
    r.p.yaw = 0.5;
    setSlot(r.p, 0, "wood", 2);
    const v = posed(r.p, 4, 2, -3, 1.25);
    expect([v.x, v.y, v.z, v.yaw]).toEqual([4, 2, -3, 1.25]);
    expect([v.id, v.inv0, v.cnt0, v.alive]).toEqual(["bot-1", "wood", 2, true]);
    expect([r.p.x, r.p.y, r.p.z, r.p.yaw]).toEqual([0, 1, 0, 0.5]);
  });

  it("fails (for the desk's blacklist) when the target can't be reached", () => {
    const r = rig();
    const motor = new Motor({ kind: "pickup", projectileId: "nope" }, newSteerMemory());
    r.run(motor, 5);
    expect(motor.status).toBe("failed");
    expect(motor.reason).toBe("gone");
  });
});
