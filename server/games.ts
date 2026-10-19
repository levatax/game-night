import fs from "node:fs";
import path from "node:path";
import type { GameManifest } from "./types.js";

export interface LoadedGame {
  manifest: GameManifest;
  dir: string;
}

const REQUIRED: (keyof GameManifest)[] = ["id", "title", "tagline", "description", "players", "status"];

/** Read every `games/<id>/game.json`, sorted so live games come first. */
export function loadGames(gamesRoot: string): LoadedGame[] {
  if (!fs.existsSync(gamesRoot)) return [];

  const games: LoadedGame[] = [];
  for (const entry of fs.readdirSync(gamesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(gamesRoot, entry.name);
    const manifestPath = path.join(dir, "game.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: GameManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      console.warn(`[hub] skipping ${entry.name}: game.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
    const missing = REQUIRED.filter((key) => manifest[key] === undefined);
    if (missing.length) {
      console.warn(`[hub] skipping ${entry.name}: game.json is missing ${missing.join(", ")}`);
      continue;
    }
    if (manifest.id !== entry.name) {
      console.warn(`[hub] ${entry.name}: game.json id "${manifest.id}" should match its folder name`);
    }
    games.push({ manifest, dir });
  }

  const rank = { live: 0, beta: 1, soon: 2 } as const;
  return games.sort(
    (a, b) => rank[a.manifest.status] - rank[b.manifest.status] || a.manifest.title.localeCompare(b.manifest.title),
  );
}

/** Fields the portal is allowed to see. */
export function publicManifest(game: LoadedGame, clientBuilt: boolean) {
  const { manifest } = game;
  return {
    id: manifest.id,
    title: manifest.title,
    tagline: manifest.tagline,
    description: manifest.description,
    players: manifest.players,
    duration: manifest.duration,
    input: manifest.input,
    tags: manifest.tags ?? [],
    accent: manifest.accent,
    status: manifest.status,
    badge: manifest.badge,
    howToPlay: manifest.howToPlay ?? [],
    controls: manifest.controls ?? [],
    cover: manifest.cover ? `/api/games/${manifest.id}/cover` : null,
    url: `/games/${manifest.id}/`,
    playable: manifest.status !== "soon" && clientBuilt,
  };
}
