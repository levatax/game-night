// Test-only helpers for the sim vitest suites (*.test.ts next to this file).
// Not exported from the sim barrel and never imported by runtime code.

import { getArena, type ArenaDef } from "../maps.js";
import type { InputCmd } from "../protocol.js";
import type { CharacterId, MapId } from "../types.js";
import { createBallSim, type BallSim } from "./ball.js";
import type { BallContext, SimContext } from "./context.js";
import { createPlayerSim, stepPlayer, type PlayerSim, type StepPlayerResult } from "./player.js";
import { DT } from "../constants.js";

/** An InputCmd with everything neutral except the given fields. */
export function cmd(partial: Partial<InputCmd> = {}): InputCmd {
  return { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0, ...partial };
}

/** The arena without any cover (clean movement/flight measurements). */
export function openArena(id: MapId = "picnic"): ArenaDef {
  return { ...getArena(id), cover: [] };
}

export function solidRings(arena: ArenaDef): number[] {
  return arena.ringRadii.map(() => 0);
}

export function simCtx(
  character: CharacterId,
  arena: ArenaDef = openArena(),
  rings: ArrayLike<number> = solidRings(arena),
  locked = false,
): SimContext {
  return { arena, rings, character, dt: DT, locked };
}

export function ballCtx(arena: ArenaDef = openArena(), rings: ArrayLike<number> = solidRings(arena)): BallContext {
  return { arena, rings, dt: DT, steer: null, returnTarget: null };
}

/** An alive, grounded player standing at (x, y, z) looking along yaw. */
export function spawnPlayer(x = 0, z = 0, yaw = 0, y = 0): PlayerSim {
  const p = createPlayerSim();
  p.alive = true;
  p.x = x;
  p.y = y;
  p.z = z;
  p.yaw = yaw;
  p.grounded = y === 0;
  return p;
}

/** Step `ticks` times with a fixed command or a per-tick command factory (tick index from 0). */
export function runPlayer(
  p: PlayerSim,
  ctx: SimContext,
  ticks: number,
  input: InputCmd | ((tick: number) => InputCmd),
): StepPlayerResult[] {
  const results: StepPlayerResult[] = [];
  for (let i = 0; i < ticks; i++) {
    results.push(stepPlayer(p, typeof input === "function" ? input(i) : input, ctx));
  }
  return results;
}

export function ball(fields: Partial<BallSim>): BallSim {
  return { ...createBallSim(), ...fields };
}

export function horizontalSpeed(v: { vx: number; vz: number }): number {
  return Math.hypot(v.vx, v.vz);
}

/** Deterministic pseudo-random sequence (LCG), so "random" test inputs replay exactly. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
