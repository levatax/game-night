// Where does a tumbling (stunned) player come down? Owner: sim.
// Pure look-ahead on a scratch copy: steps the shared player sim with a neutral input, so the
// answer follows exactly the physics the server will run (minus future DI and bumps). Used by the
// client FX (danger tint / "out" warning on a launch that leaves the island). Deterministic and
// allocation-free; never touches the player passed in.

import type { InputCmd } from "../protocol.js";
import type { PlayerSimFields } from "../types.js";
import type { SimContext } from "./context.js";
import type { Vec3 } from "./math.js";
import { copyPlayerSim, createPlayerSim, emptyStepResult, stepPlayerInto } from "./player.js";

const scratch = createPlayerSim();
const result = emptyStepResult();
const neutral: InputCmd = { seq: 0, moveX: 0, moveZ: 0, yaw: 0, pitch: 0, buttons: 0 };

/**
 * Step a copy of `p` with no input for at most `maxTicks` ticks.
 * Returns the number of ticks until the first `landed` or `bounced` (1 = the next tick) and writes
 * the feet position at that moment into `out`; −1 when it falls out (below RING_OUT_Y) first;
 * `maxTicks` when neither happens in time (out = the last position). A player that is not alive
 * returns `maxTicks` with out = its position.
 */
export function predictTumbleLanding(p: PlayerSimFields, ctx: SimContext, maxTicks: number, out: Vec3): number {
  copyPlayerSim(p, scratch);
  neutral.yaw = p.yaw;
  neutral.pitch = p.pitch;
  out.x = scratch.x;
  out.y = scratch.y;
  out.z = scratch.z;
  if (!scratch.alive) return maxTicks;
  for (let i = 1; i <= maxTicks; i++) {
    stepPlayerInto(scratch, neutral, ctx, result);
    out.x = scratch.x;
    out.y = scratch.y;
    out.z = scratch.z;
    if (result.fellOut) return -1;
    if (result.landed || result.bounced) return i;
  }
  return maxTicks;
}
