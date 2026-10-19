# Game Night

A small hub of browser multiplayer party games. One Node process serves:

- **the portal** (`/`): lists every game, shows how many people are playing, and lets players
  jump into a room with its 4-letter code
- **each game's client** (`/games/<id>/`)
- **the multiplayer server** (Colyseus over WebSockets) for every game's rooms
- **share links**: `/r/ABCD` sends you to whichever game owns room `ABCD`

| Game | Folder | Design doc |
|---|---|---|
| Bonk Brawl: 3D dodgeball free-for-all for 2–4 players | `games/bonk-brawl/` | [`game1.md`](game1.md) |
| Jelly Jackpot: wobbly cake-stacking, gambling and a secret Saboteur for 2–6 players | `games/jelly-jackpot/` | [`game2.md`](game2.md) |

## Run it

```bash
npm install
```

```bash
npm run build
```

```bash
npm start
```

Then open http://localhost:3000. Set `PORT` to use another port. Friends on other machines need
to reach the server over HTTPS for mouse aim to work (see [Hosting](#hosting)).

While developing, `npm run dev` rebuilds game clients on save and restarts the server when
server code changes.

Other scripts: `npm run typecheck`, `npm test`.

## Add a game

Every folder in `games/` that has a `game.json` is picked up automatically: it's listed on the
portal, its client build is served at `/games/<id>/`, and its server module is registered.

```
games/<id>/
  game.json            # manifest (see server/types.ts → GameManifest)
  cover.svg            # card art, 16:10
  server/index.ts      # export function register(ctx: HubContext)
  client/vite.config.ts  # base: "/games/<id>/", outDir: "dist"
```

1. **`game.json`**: `id` (must match the folder name), `title`, `tagline`, `description`,
   `players`, `duration`, `input`, `tags`, `accent`, `status` (`live`, `beta` or `soon`),
   and optionally `howToPlay`, `controls`, `badge`, `cover`, `rooms` (Colyseus room names, used
   for the "N playing now" counter), `server`, `clientDist`, `viteConfig`. A `soon` game shows
   up as a teaser card and isn't built or registered.
2. **Server**: `register(ctx)` gets the Colyseus `gameServer`, the Express `app`, and
   `ctx.codes`, a hub-wide room code registry. Define your rooms with
   `ctx.gameServer.define(...)`. To get 4-letter codes and `/r/CODE` links, set
   `this.roomId = ctx.codes.allocate(ctx.gameId)` in your room's `onCreate`, and call
   `ctx.codes.release(this.roomId)` in `onDispose`.
3. **Client**: any Vite app with `base: "/games/<id>/"`. Read `?room=CODE` from the URL to
   support share links, and connect to Colyseus at the page's own origin.

`npm run build` builds every game client; restart the server to pick up a new game folder.

## Layout

```
portal/        static portal site (HTML/CSS/JS, no build step)
server/        hub: Express + Colyseus, game discovery, room codes
scripts/       build + dev helpers
games/<id>/    one folder per game
```

## Hosting

It's one Node process with no database, so any small VM or container works (Fly.io, Render,
Railway…). Run `npm run build` at deploy time and `npm start` as the process. Browsers only
allow pointer lock (needed for mouse aim) on secure origins, so put it behind HTTPS; `localhost`
counts as secure for local play.
