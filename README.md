# Game Night

A small hub of browser multiplayer party games. One Node process serves:

- **the portal** (`/`): lists every game, shows how many people are playing, and lets players
  jump into a room with its 4-letter code
- **each game's client** (`/games/<id>/`)
- **the multiplayer server** (Colyseus over WebSockets) for every game's rooms
- **share links**: `/r/ABCD` sends you to whichever game owns room `ABCD`

| Game | Folder | Design doc |
|---|---|---|
| Bonk Brawl: 3D dodgeball free-for-all for 2–8 players | `games/bonk-brawl/` | [`game1.md`](game1.md) |
| Jelly Jackpot: wobbly cake-stacking, gambling and a secret Saboteur for 2–6 players | `games/jelly-jackpot/` | [`game2.md`](game2.md) |
| KASALA!: push-your-luck card flipping, side bets and loan sharks in a mafia back room for 2–6 players (Turkish) | `games/kasala/` | [`game3.md`](game3.md) |
| Raft Rush: first-person co-op island survival, build a raft before the storm, 1–6 players with helper bots (EN/TR, beta) | `games/raft-rush/` | [`game4.md`](game4.md) |

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

## Voices (ElevenLabs)

KASALA's announcer, Cemil Abi, speaks 95 Turkish lines. They are pre-rendered with ElevenLabs
(Eleven v4, the Istanbul-accented Adam voice `J17lijyP1BHYcM7ld0Rg`, with per-line delivery tags and a
short back-room reverb baked in) and committed under
`games/kasala/client/public/audio/spiker/`, so the game needs no key to speak. The client plays a
recorded mp3 when one exists, otherwise asks the hub's `/api/voice/tts` proxy to synthesize the
line, then falls back to the browser's Turkish speech voice, then to a subtitle. A missing key or
an ElevenLabs outage never breaks the game.

The voice performance (audio tags such as `[shouting]`, `[whispers]`, `[laughs]`) lives in
`scripts/voice-performance.ts`; subtitle text stays clean. To render lines (after editing
`games/kasala/shared/announcer.ts`) with your own ElevenLabs API
key:

```bash
ELEVENLABS_API_KEY=sk_… npm run voices          # only missing lines
ELEVENLABS_API_KEY=sk_… npm run voices -- --force
```

The same key enables on-demand synthesis on the server: set `ELEVENLABS_API_KEY` in the host's
environment (EasyPanel → service → Environment). Optional: `ELEVENLABS_VOICE_KASALA` (default
`J17lijyP1BHYcM7ld0Rg`), `ELEVENLABS_VOICE_ID` (other games, default Adam
`pNInz6obpgDQGcFmaJgB`), `ELEVENLABS_MODEL_ID` (default `eleven_v4`), `ELEVENLABS_TTS_DISABLED=1`,
`VOICE_CACHE_DIR`.
On-demand audio is cached on disk (`.voice-cache/` by default), so each line is paid for once.
The key is read only by the server; clients never see it. See `.env.example`.

## Raft Rush sound effects (ElevenLabs)

Raft Rush has 95 one-shot effects and 13 continuous loops (waves, wind, gulls, crickets, rain,
storm, drums, fire, charge, swim, fuse, reel, channel), all rendered with ElevenLabs Sound
Effects `eleven_text_to_sound_v3` and stored under
`games/raft-rush/client/public/audio/raft-rush/`. The client starts playing generated files as
they decode and keeps the original Web Audio synth as a fallback, so a slow network or missing
file never silences the game.

To re-render after editing a prompt or adding a sound (the script resumes missing files):

```bash
ELEVENLABS_API_KEY=sk_… npm run sfx
ELEVENLABS_API_KEY=sk_… npm run sfx -- --force
```

The cue sheet and durations are in `scripts/generate-raft-sfx.mjs`; it validates that every
`SFX_NAMES` / `LOOP_NAMES` entry has exactly one cue and rebuilds `manifest.json`.

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

### Docker (Easypanel, etc.)

The `Dockerfile` builds every game client and runs the hub as a single service on port 3000
(override with `PORT`). It has a health check on `/healthz`.

```bash
docker build -t game-night .
```

```bash
docker run -p 3000:3000 game-night
```

On Easypanel: create an **App** service, point it at this repo with the **Dockerfile** build
method, set the domain's proxy port to `3000`, and turn on HTTPS. Keep it at **one replica**:
rooms live in memory, so players in the same room must reach the same process.
