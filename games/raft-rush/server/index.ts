// Raft Rush server entry, loaded by the hub (see /server/types.ts GameServerModule): register() defines the room
// (and says once what a RAFT_TEST flag means here), health() reports the live rooms for the hub's /healthz and logs
// each newly stalled room by code (the public report only counts them).
import type { HubContext } from "../../../server/types.js";
import { ROOM_NAME } from "../shared/protocol.js";
import { RaftRoom } from "./RaftRoom.js";
import { setHub } from "./hub.js";
import { logLine } from "./room/log.js";
import { freshStalls, roomHealth, type RoomHealth } from "./room/registry.js";
import { testFlagWarning } from "./room/testing.js";

let announced = false;
/** Stalled room codes already logged by health(). */
const reportedStalls = new Set<string>();

export function register(ctx: HubContext): void {
  setHub(ctx);
  announceTestFlag();
  ctx.gameServer.define(ROOM_NAME, RaftRoom);
}

/**
 * Live rooms of this process and the age of their last fixed tick: ok = false when a room has not completed a
 * fixed tick for STALL_MS (room/registry.ts), so a wedged room no longer reports healthy.
 */
export function health(): RoomHealth {
  const report = roomHealth(performance.now());
  for (const room of freshStalls(report, reportedStalls)) logLine("stalled", { room, maxTickAgeMs: report.maxTickAgeMs }, "warn");
  return report;
}

/** RAFT_TEST set in production (ignored there: loud error) or outside a test runner (warning), once per process. */
function announceTestFlag(): void {
  if (announced) return;
  announced = true;
  const warning = testFlagWarning();
  if (!warning) return;
  if (warning.level === "error") console.error(warning.message);
  else console.warn(warning.message);
}
