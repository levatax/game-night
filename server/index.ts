import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import express from "express";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { loadGames, publicManifest, type LoadedGame } from "./games.js";
import { CODE_PATTERN, createRoomCodeRegistry, normalizeCode } from "./roomCodes.js";
import type { GameServerModule } from "./types.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
for (const game of games) {
  const { manifest } = game;
  if (!manifest.server || manifest.status === "soon") continue;
  const entry = path.join(game.dir, manifest.server);
  try {
    const mod = (await import(pathToFileURL(entry).href)) as GameServerModule;
    await mod.register({ gameId: manifest.id, gameDir: game.dir, gameServer, app, codes, manifest });
    console.log(`[hub] registered ${manifest.id}`);
  } catch (err) {
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

app.get("/api/games", async (_req, res) => {
  const list = await Promise.all(
    games.map(async (game) => ({ ...publicManifest(game, isClientBuilt(game)), live: await liveStats(game) })),
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

app.get("/healthz", (_req, res) => void res.json({ ok: true, games: games.length }));

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
console.log(`[hub] Game Night is running at http://localhost:${PORT}`);
