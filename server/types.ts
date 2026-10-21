import type { Express } from "express";
import type { Server } from "@colyseus/core";

/**
 * Contents of `games/<id>/game.json`. Every folder under `games/` with one of
 * these is picked up by the hub: listed on the portal, its client build served
 * at `/games/<id>/`, and its server module registered with Colyseus.
 *
 * Language: the portal is English and has no translations, so the text fields
 * (tagline, description, duration, input, badge, howToPlay, controls) are shown
 * as written. Write them in English, and add a "Türkçe" tag when the game can be
 * played in Turkish. A game that only has a Turkish UI (KASALA!) writes its
 * manifest in Turkish, so the card reads like the game it opens.
 */
export interface GameManifest {
  /** Folder name and URL slug, e.g. "bonk-brawl". */
  id: string;
  title: string;
  /** One line for the game card. */
  tagline: string;
  /** A short paragraph for the details panel. */
  description: string;
  players: { min: number; max: number };
  /** Human-readable match length, e.g. "~5 min". */
  duration: string;
  /** What you need to play, e.g. "Keyboard + mouse". */
  input: string;
  /**
   * True when the game can't be played without a keyboard and mouse (no touch
   * controls). On a device with no fine pointer the portal says so on the card.
   */
  desktopOnly?: boolean;
  tags: string[];
  /** Card accent color (hex). */
  accent: string;
  /** Cover image path, relative to the game folder. */
  cover?: string;
  /** "live" games are playable, "beta" ones too (the portal marks them BETA), "soon" ones are teasers. */
  status: "live" | "beta" | "soon";
  /** Optional "NEW", "HOT"… label on the card. */
  badge?: string;
  howToPlay?: string[];
  controls?: { keys: string; action: string }[];
  /** Colyseus room names this game defines (used for live player counts). */
  rooms?: string[];
  /**
   * Server entry module, relative to the game folder (e.g. "server/index.ts").
   * The compiled hub (tsconfig.server.json) loads the same path from dist/ with
   * a .js extension instead.
   */
  server?: string;
  /** Built client directory, relative to the game folder (e.g. "client/dist"). */
  clientDist?: string;
  /** Vite config used by `npm run build`, relative to the game folder. */
  viteConfig?: string;
}

export interface RoomCodeRegistry {
  /** Reserve a fresh 4-letter code (no I/O/0/1) for a room of `gameId`. */
  allocate(gameId: string): string;
  /** Free a code when its room is disposed. */
  release(code: string): void;
  /** Which game owns this code, if any. */
  lookup(code: string): { gameId: string } | undefined;
}

/** Handed to each game's server module. */
export interface HubContext {
  gameId: string;
  /** Absolute path of `games/<id>/`. */
  gameDir: string;
  gameServer: Server;
  app: Express;
  codes: RoomCodeRegistry;
  manifest: GameManifest;
}

/**
 * A game's own health report for `/healthz`: `ok: false` (or a throw) makes the
 * hub answer 503. Any other fields (room counts, tick age…) are passed through
 * as-is for whoever reads the endpoint.
 */
export interface GameHealth {
  ok: boolean;
  [detail: string]: unknown;
}

/** What `games/<id>/<manifest.server>` must export. */
export interface GameServerModule {
  register(ctx: HubContext): void | Promise<void>;
  /** Optional liveness check, called on every `/healthz` request: keep it cheap and synchronous. */
  health?(): GameHealth;
}
