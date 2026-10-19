// Jelly Jackpot server entry, loaded by the hub (see /server/types.ts GameServerModule). Complete.
import type { HubContext } from "../../../server/types.js";
import { ROOM_NAME } from "../shared/constants.js";
import { JellyRoom } from "./JellyRoom.js";
import { setHub } from "./hub.js";

export function register(ctx: HubContext): void {
  setHub(ctx);
  ctx.gameServer.define(ROOM_NAME, JellyRoom);
}
