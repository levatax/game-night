import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { hubHealth, loadGames, publicManifest, type LoadedGame } from "./games.js";
import { CODE_PATTERN, createRoomCodeRegistry, normalizeCode } from "./roomCodes.js";
import type { GameServerModule } from "./types.js";
import { voiceRouter, voiceStatus } from "./voice.js";

// Runs from source (`npm start`: tsx server/index.ts) or compiled (`npm run start:prod`: node dist/server/index.js,
// built by tsconfig.server.json). Compiled, the game server modules sit in dist/ and everything else (portal,
// game.json files, client builds, covers) stays at the repo root one level up.
const COMPILED = path.extname(fileURLToPath(import.meta.url)) === ".js";
const BUILD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = COMPILED ? path.dirname(BUILD_ROOT) : BUILD_ROOT;
const PORTAL_DIR = path.join(ROOT, "portal");
const GAMES_DIR = path.join(ROOT, "games");
const PORT = Number(process.env.PORT ?? 3000);

const app = express();
app.disable("x-powered-by");
const httpServer = http.createServer(app);
const gameServer = new Server({ transport: new WebSocketTransport({ server: httpServer }) });
const codes = createRoomCodeRegistry();
const games = loadGames(GAMES_DIR);

const clientDistOf = (game: LoadedGame) => path.join(game.dir, game.manifest.clientDist ?? "client/dist");
const isClientBuilt = (game: LoadedGame) => fs.existsSync(path.join(clientDistOf(game), "index.html"));

// ---------------------------------------------------------------- game servers
/** Registered game server modules by game id (asked for their `health()` on /healthz). */
const modules = new Map<string, GameServerModule>();
/**
 * Games whose server module failed to import or register, with the error: /healthz answers 503 for them. The full
 * error (message, stack, file paths) is only logged here; /healthz shows a short reason (games.ts `errorReason`).
 */
const failed = new Map<string, unknown>();
/** `games/<id>/server/index.ts`, or `dist/games/<id>/server/index.js` when compiled. */
const serverEntryOf = (game: LoadedGame, server: string) =>
  COMPILED
    ? path.join(BUILD_ROOT, path.relative(ROOT, game.dir), server.replace(/\.ts$/, ".js"))
    : path.join(game.dir, server);

for (const game of games) {
  const { manifest } = game;
  if (!manifest.server || manifest.status === "soon") continue;
  const entry = serverEntryOf(game, manifest.server);
  try {
    const mod = (await import(pathToFileURL(entry).href)) as GameServerModule;
    await mod.register({ gameId: manifest.id, gameDir: game.dir, gameServer, app, codes, manifest });
    modules.set(manifest.id, mod);
    console.log(`[hub] registered ${manifest.id}`);
  } catch (err) {
    failed.set(manifest.id, err);
    console.error(`[hub] failed to register ${manifest.id}:`, err);
  }
}

// ------------------------------------------------------------------------- api
async function liveStats(game: LoadedGame) {
  const roomNames = game.manifest.rooms ?? [];
  let rooms = 0;
  let players = 0;
  for (const name of roomNames) {
    const listings = await matchMaker.query({ name });
    rooms += listings.length;
    players += listings.reduce((sum, room) => sum + (room.clients ?? 0), 0);
  }
  return { rooms, players };
}

// ElevenLabs text-to-speech (optional; recorded mp3s are always preferred). Clients only learn whether it is
// enabled and the public voice id — the API key stays in this process.
app.use("/api/voice", voiceRouter);

app.get("/api/games", async (_req, res) => {
  const list = await Promise.all(
    games.map(async (game) => ({
      ...publicManifest(game, isClientBuilt(game), failed.has(game.manifest.id)),
      live: await liveStats(game),
    })),
  );
  res.set("Cache-Control", "no-store").json({ games: list });
});

app.get("/api/games/:id/cover", (req, res) => {
  const game = games.find((g) => g.manifest.id === req.params.id);
  if (!game?.manifest.cover) return void res.status(404).end();
  res.sendFile(path.join(game.dir, game.manifest.cover));
});

app.get("/api/rooms/:code", (req, res) => {
  const code = normalizeCode(req.params.code);
  const owner = CODE_PATTERN.test(code) ? codes.lookup(code) : undefined;
  if (!owner) return void res.status(404).json({ error: "No room with that code" });
  res.json({ code, gameId: owner.gameId, url: `/games/${owner.gameId}/?room=${code}` });
});

// 503 as soon as one game says it isn't ok (e.g. a stalled room loop) or never registered, so the container
// healthcheck notices. Public: no error messages, paths or room codes in the body (a game's own report is cut to
// counts and flags, games.ts `publicHealth`), those stay in the server log, which polling can't flood
// (`throttledHealthLog`).
app.get("/healthz", (_req, res) => {
  const health = hubHealth(games.length, modules, failed);
  res.set("Cache-Control", "no-store").status(health.ok ? 200 : 503).json(health);
});

// Share links: /r/ABCD → whichever game owns that room.
app.get("/r/:code", (req, res) => {
  const code = normalizeCode(req.params.code);
  const owner = CODE_PATTERN.test(code) ? codes.lookup(code) : undefined;
  res.redirect(owner ? `/games/${owner.gameId}/?room=${code}` : `/?missing=${encodeURIComponent(code)}`);
});

// ---------------------------------------------------------------- game clients
for (const game of games) {
  const { id } = game.manifest;
  const dist = clientDistOf(game);
  app.use(`/games/${id}`, express.static(dist, { index: "index.html" }));
  // Paths like /games/<id>/r/ABCD fall back to the game's index.html.
  app.use(`/games/${id}`, (req, res, next) => {
    if (req.method !== "GET" || path.extname(req.path)) return next();
    const index = path.join(dist, "index.html");
    if (fs.existsSync(index)) return void res.sendFile(index);
    res
      .status(503)
      .type("html")
      .send(`<h1>${game.manifest.title} isn't built yet</h1><p>Run <code>npm run build</code>, then reload.</p>`);
  });
}

// ---------------------------------------------------------------------- portal
app.use(express.static(PORTAL_DIR, { extensions: ["html"] }));

await gameServer.listen(PORT);
const voice = voiceStatus();
console.log(
  voice.enabled
    ? `[voice] ElevenLabs on-demand synthesis enabled (voice ${voice.voiceId}, cache ${voice.cacheDir})`
    : "[voice] ElevenLabs disabled (no ELEVENLABS_API_KEY); announcer uses recorded mp3s / browser speech",
);
console.log(`[hub] Game Night is running at http://localhost:${PORT}`);
