import type { RoomCodeRegistry } from "./types.js";

/** Letters only, minus the ambiguous I and O (digits are never used, so no 0/1). */
export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CODE_LENGTH = 4;
export const CODE_PATTERN = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

/** In-memory registry shared by every game, so codes are unique hub-wide. */
export function createRoomCodeRegistry(random: () => number = Math.random): RoomCodeRegistry {
  const owners = new Map<string, string>();

  const randomCode = () => {
    let code = "";
    for (let i = 0; i < CODE_LENGTH; i++) {
      code += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    }
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
      owners.delete(normalizeCode(code));
    },
    lookup(code) {
      const gameId = owners.get(normalizeCode(code));
      return gameId ? { gameId } : undefined;
    },
  };
}
