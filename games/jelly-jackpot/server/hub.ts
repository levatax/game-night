// Module-level holder for the hub context handed to register() (complete).
// JellyRoom uses getRoomCodes() to allocate/release its 4-letter roomId. Outside the hub (tests that
// define JellyRoom on their own Colyseus server) a local registry is used instead.

import type { HubContext, RoomCodeRegistry } from "../../../server/types.js";
import { CODE_ALPHABET, CODE_LENGTH } from "../shared/constants.js";

export { GAME_ID } from "../shared/constants.js";

let hub: HubContext | null = null;
let localCodes: RoomCodeRegistry | null = null;

export function setHub(ctx: HubContext): void {
  hub = ctx;
}

export function getHub(): HubContext | null {
  return hub;
}

/** The hub's hub-wide code registry, or a process-local fallback when running without the hub. */
export function getRoomCodes(): RoomCodeRegistry {
  if (hub) return hub.codes;
  localCodes ??= createLocalCodes();
  return localCodes;
}

function createLocalCodes(): RoomCodeRegistry {
  const owners = new Map<string, string>();
  const randomCode = () => {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    return code;
  };
  return {
    allocate(gameId) {
      for (let attempt = 0; attempt < 10_000; attempt++) {
        const code = randomCode();
        if (!owners.has(code)) {
          owners.set(code, gameId);
          return code;
        }
      }
      throw new Error("No free room codes left");
    },
    release(code) {
      owners.delete(code.trim().toUpperCase());
    },
    lookup(code) {
      const gameId = owners.get(code.trim().toUpperCase());
      return gameId ? { gameId } : undefined;
    },
  };
}
