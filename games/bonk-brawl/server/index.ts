// Bonk Brawl server entry, loaded by the hub (see /server/types.ts GameServerModule).
import type { HubContext } from "../../../server/types.js";
import { ROOM_NAME } from "../shared/protocol.js";
import { BonkRoom } from "./BonkRoom.js";
import { setHub } from "./hub.js";

export function register(ctx: HubContext): void {
  setHub(ctx);
  ctx.gameServer.define(ROOM_NAME, BonkRoom);
}
