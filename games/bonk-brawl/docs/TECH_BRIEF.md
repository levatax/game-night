# Bonk Brawl: technical brief

This is the binding engineering brief for building `game1.md` (the design doc, at the repo root).
`game1.md` says **what** the game is. This file says **how** we build it. If they disagree on a
technical point, this file wins. On a gameplay point, `game1.md` wins.

## 0. Where it lives

The repo is a multi-game hub called **Game Night**:

```
/server/            hub: Express + Colyseus, serves the portal and every game (DON'T EDIT unless told)
/portal/            the game-listing website (DON'T EDIT)
/games/bonk-brawl/  this game
  game.json         manifest the hub reads (DON'T EDIT)
  cover.svg
  shared/           code used by BOTH server and client (pure TS, no DOM, no Node APIs, no decorators)
  server/           Colyseus room + authoritative simulation (Node)
  client/           Vite + Three.js browser client, built to client/dist, served at /games/bonk-brawl/
  docs/             TECH_BRIEF.md (this), ARCHITECTURE.md (module contracts)
  test/             headless bot tests
```

- One `package.json` at the repo root. Installed already: `three@0.186`, `@types/three`,
  `@colyseus/core@0.16`, `@colyseus/ws-transport@0.16`, `@colyseus/schema@3`, `colyseus.js@0.16`,
  `express@5`, `vite@7`, `typescript@5.9`, `tsx`, `vitest`. **Don't add dependencies** unless the
  architecture doc says so. Read the installed `.d.ts` files in `node_modules` when unsure of an API.
  Colyseus is **0.16** (not 0.15, not 0.17+): client package is `colyseus.js`, state callbacks use
  `getStateCallbacks(room)`, schema v3.
- Commands (from repo root): `npm run typecheck` (tsc over server + games), `npx vitest run <path>`,
  `npm run build` (Vite build of every game client), `npm start` (hub on http://localhost:3000;
  set `PORT=` to use another port so you don't collide with a running dev server).
- The hub loads `games/bonk-brawl/server/index.ts` and calls `register(ctx: HubContext)` (see
  `/server/types.ts`). `ctx.codes` allocates hub-wide 4-letter room codes. `/r/ABCD` redirects to
  `/games/bonk-brawl/?room=ABCD`.
- `tsconfig.json` (root) has `experimentalDecorators: true` and `useDefineForClassFields: false`,
  needed by `@colyseus/schema` decorators. **Decorators are only allowed in `server/`.** The client
  never imports schema classes: `colyseus.js` decodes state by reflection. The client types the
  state with plain interfaces from `shared/types.ts`.

## 1. Deliberate deviations from game1.md §10/§15 (keep these)

| game1.md says | We do | Why |
|---|---|---|
| Rapier physics on both sides | A small **custom deterministic physics** in `shared/sim/` (capsule players, sphere balls, cylinder/box cover, ring floor) | Deterministic fixed-step replay for prediction, no WASM, tiny bundle, unit-testable |
| Blender glTF models, KTX2 textures, CC0 audio packs | **Procedural everything**: animals built from Three.js primitives, canvas-generated textures and face sprite sheets, Web Audio-synthesized SFX and music | No asset pipeline, no downloads, well under the 15 MB budget |
| Room URL `https://host/r/ABCD` | Same, served by the hub, which redirects to `/games/bonk-brawl/?room=ABCD` | Multi-game hub |
| Gamepad (stretch) | Not in v1 | Stretch goal |

Everything else in game1.md is in scope: all 6 characters and abilities, 4 power-ups, 3 maps,
sudden death crumble, catches with lag compensation, scoring, crown, every screen and HUD element,
settings, audio, game-feel effects.

## 2. World conventions (everyone must follow)

- Units: meters, seconds, radians. **Y is up.** Island floor top surface is at **y = 0**,
  centered on the origin. Falling below **y = -6** is a ring-out.
- Player position = **feet** (bottom of the capsule). Capsule radius 0.45, height 1.4 → chest
  at y + 1.0, head top at y + 1.4. Hand/throw origin: chest height, 0.5 m forward, 0.35 m right.
- **Yaw** 0 faces **−Z** (Three.js default forward). Forward vector
  `(-sin(yaw), 0, -cos(yaw))`, right vector `(cos(yaw), 0, -sin(yaw))`. Positive **pitch** looks
  up. Aim direction `(-sin(yaw)cos(pitch), sin(pitch), -cos(yaw)cos(pitch))`. Pitch clamped to ±1.2.
- Gravity −20 m/s² for players and balls.
- **Fixed timestep**: simulation runs at **30 Hz** (`DT = 1/30`) on server and in client
  prediction. Every gameplay timer inside the simulation is an **integer tick count**
  (constants are authored in seconds and converted with `secToTicks()`), so replays are exact.
- Player colors by slot: P1 `#FF5A5F`, P2 `#3FA7FF`, P3 `#7BE07B`, P4 `#FFC23F`.

## 3. Networking model

- Authoritative Colyseus room `bonk_brawl`. Server tick 30 Hz via `setSimulationInterval`,
  state patches at 20 Hz (`setPatchRate(50)`).
- The client sends one `input` message per sim tick (30 Hz) while in a round:
  `{ seq, moveX, moveZ, yaw, pitch, buttons }`. `moveX/moveZ` are camera-relative (x = strafe right,
  z = forward), each in [-1, 1]. `buttons` is a bitmask: `THROW` (held level), `CATCH`, `JUMP`,
  `ROLL`, `ABILITY` (edge-triggered: set only in the input of the tick the key went down).
  WebSocket delivery is reliable and ordered, so edges are not lost.
- Server keeps a per-player input queue. Each tick it consumes **one** input per player (if the
  queue is empty it repeats the last input with edge bits cleared; if the queue grows beyond 4 it
  drops the oldest so latency stays bounded). It writes `lastSeq` (last consumed seq) into the
  player's schema so the client can reconcile.
- **Own player**: client-side prediction with the shared `stepPlayer()`. On each state patch:
  take the server's player sim fields, drop acknowledged inputs (`seq <= lastSeq`), replay the
  rest. Smooth small visual errors over ~100 ms; snap if error > 2 m.
- **Remote players**: snapshot interpolation, rendered ~100 ms in the past.
- **Balls**: dead-reckoned on the client with the shared `stepBall()` from the latest server
  snapshot (balls are ballistic, so this is accurate), blended toward each new snapshot. Your own
  throws spawn a **predicted ball** immediately; when the server ball with the same
  `(ownerId, throwSeq)` appears, the client blends into it and removes the predicted one.
- **Hits** are decided by the server on server positions.
- **Catches** use lag compensation: the server keeps a ring buffer of each ball's position for the
  last 10 ticks. A catch input carries the client's seq; the server rewinds by the catcher's
  half-RTT (capped at 150 ms → ≤ 5 ticks) and checks the ball positions in the history over the
  0.25 s window. A live ball that would hit a player whose catch window is active, and that comes
  from the front half-space, is caught instead of hitting.
- RTT: the server sends `ping { t }` every second, the client answers `pong { t }` immediately;
  the server keeps an EMA RTT per player (also shown on the scoreboard).
- One-shot gameplay events (hit, catch, ringOut, ko, roundWin, throw, pickup, emote, ability,
  powerUp spawn/pickup, ring shake/drop, whiff, countdown ticks) are **messages**, not state. They
  drive VFX/SFX/kill feed.
- End-of-round slow-mo is **server-side**: when a round is decided the server keeps simulating at
  0.3× speed for 1 s (inputs ignored), so every client sees the same slow-mo. Hit-stop (60 ms) and
  the catcher's 0.15 s slow-mo are **client-side cosmetic** time scaling (particles, animation,
  camera), never applied to networked positions.

## 4. Rooms & lifecycle

- Create: `client.create("bonk_brawl", { nickname, character })`. In `onCreate` the room sets
  `this.roomId = hub.codes.allocate("bonk-brawl")` so the 4-letter code **is** the roomId.
  Join: `client.joinById(code, { nickname, character })`. Release the code in `onDispose`.
- `maxClients = 4`; a 5th client gets a "Room full" error. Players who join while a match is
  running are spectators (free ghost camera) until the match ends, then they're in the lobby.
- Host = first player; if the host leaves, the next player in join order becomes host.
- Disconnects: `allowReconnection(client, 20)`. The client stores `room.reconnectionToken` in
  `sessionStorage` and tries `client.reconnect(token)` on reload. If 20 s passes during a round,
  that player counts as KO for the round and is removed.
- `autoDispose = false`; when the last client leaves, dispose the room after 60 s unless
  someone joins.
- Phases: `lobby → countdown(3 s) → playing(60 s) → suddenDeath → roundEnd(1 s slow-mo + 3 s card) →
  (next round's countdown | matchEnd)`. `matchEnd` shows the podium; **Rematch** returns everyone
  to `lobby` (same room, characters kept, everyone un-readied). Host settings: map
  (picnic/bath/cake/random), rounds (3/5/7, default 5), power-ups on/off. Host can start when
  ≥ 2 players and all non-spectators are ready.
- A server-side test option `fast: true` in create options (only honored when
  `process.env.BONK_TEST === "1"`) shortens countdown/round timers for bot tests.

## 5. Map model (shared/maps.ts)

- Each arena: `id`, `name`, `shape` (`"circle"` or `"roundedSquare"`; rounded square uses the
  superellipse distance `(|x|^4 + |z|^4)^(1/4)`), `ringRadii` (ascending outer radii, the last one
  is the island edge, ≈ 15 m, at least 5 rings, innermost never falls), `cover[]` (cylinders and
  boxes with x, z, size, height, rotation, plus a `kind` string for the renderer), `pedestals` (3
  power-up spots), `spawns` (4 corner spots with yaw facing the center), `friction` profile
  (Bath Time is slippery), and theme info for the renderer.
- Ring state per ring: `0 = solid`, `1 = shaking (0.8 s, still solid)`, `2 = fallen`. Sudden death
  drops the outermost solid ring every 5 s.
- Players and balls stand on the floor only where the ring under them is not fallen. Players can
  stand on top of cover. Cover blocks movement sideways and bounces balls.

## 6. Code ownership & contracts

`docs/ARCHITECTURE.md` (written by the architect) lists every module, its owner, and its exact
exported API. Rules for everyone after the architect:

1. Only edit files in the area you own. Shared contract files (`shared/constants.ts`,
   `shared/types.ts`, `shared/protocol.ts`, `shared/maps.ts`, `server/schema.ts`) are frozen;
   if you truly need a change, put it in your own module (e.g. a local constant) and add a line to
   `docs/CONTRACT_CHANGES.md` (append only) saying what the integrator should reconcile.
2. Keep exported signatures exactly as in the stubs. You may add exports and private helpers and
   new files inside your own folder.
3. No `any` at module boundaries. `npm run typecheck` must pass for your files.
4. Code style: TypeScript, ES modules, 2-space indent, double quotes, small focused functions,
   comments only where the "why" isn't obvious. Imports between TS files use the `.js`
   extension in `server/` and `shared/` (Node ESM via tsx); the client may omit it (Vite).
5. No network fetches at runtime except the Colyseus connection and Google Fonts (Fredoka).

## 7. Quality bar

This should feel like a finished small indie game, not a tech demo: juicy feedback on every
action, readable silhouettes, cartoony motion with squash and stretch, crisp HUD, sound on
everything, 60 fps on a mid laptop at "Medium" quality, no console errors, and graceful handling
of disconnects, full rooms, bad codes and a lost server.
