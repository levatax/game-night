# Bonk Brawl

3D dodgeball free-for-all for 2–8 players, built from the design doc [`game1.md`](../../game1.md).
Three.js client, Colyseus 0.16 authoritative server, and a small deterministic physics sim shared
by both (client-side prediction replays the exact same code the server runs).

## Play

From the repo root:

```bash
npm run build bonk-brawl
```

```bash
npm start
```

Open http://localhost:3000, pick Bonk Brawl, create a room and send the 4-letter code or the
`/r/CODE` link. To try it alone, open the room in a second browser tab.

If the browser refuses pointer lock (some embedded or sandboxed browsers), the game falls back
to unlocked mouse aim; Esc still opens the pause menu.

## Develop

```bash
npm run dev
```

rebuilds the client on save and restarts the server on server changes, all on port 3000.

```bash
npx vitest run games/bonk-brawl
```

runs every test: shared physics, server world + room rules, a real in-process Colyseus smoke
test, netcode (prediction, interpolation, ball sync), input and the game controller.

```bash
npx tsc --noEmit -p games/bonk-brawl/tsconfig.json
```

typechecks just this game (the root `npm run typecheck` covers every game in the repo).

### Dev harness pages

Each client area has a standalone page with mock data and buttons for every state. They are
not part of the production build. Run one with its own Vite config from the repo root, for
example:

```bash
npx vite --config games/bonk-brawl/client/dev/vite.client-ui.config.ts
```

| Page | What it shows |
|---|---|
| `dev/client-ui.html` | every screen and HUD state (`?s=<scenario>`) |
| `dev/client-render.html` | the 3 arenas, quality levels, camera modes, ring crumble |
| `dev/client-characters.html` | the 6 animals, every animation, faces, nameplates, ghosts |
| `dev/fx.html` | balls, particles, pop text, power-ups, game-feel effects |
| `dev/audio.html` | every sound effect, voice, music track and jingle, plus offline render checks |

The URL is `http://localhost:<port>/games/bonk-brawl/dev/<page>`, with the port from that
page's config.

## Layout

```
shared/   constants (all balance numbers), arenas, protocol, state types, sim/ (physics)
server/   BonkRoom (lifecycle, phases, scoring), room/ helpers, world/ (per-tick simulation)
client/   src/app (boot, screens, game loop), net, render, characters, fx, audio, ui, input
test/     in-process server smoke test
docs/     TECH_BRIEF.md (engineering decisions), ARCHITECTURE.md (module contracts)
```

Balance numbers from game1.md §16 live in `shared/constants.ts`; tune them there.

## Differences from game1.md

- Physics is a custom deterministic sim instead of Rapier, so client prediction can replay the
  server's exact steps.
- Models, textures, faces, sound effects and music are all generated in code (no asset files);
  the client build is about 1.2 MB.
- A thrown ball never hits its own thrower (game1.md's "0.3 s, then after a bounce" conflicts
  with dead balls being harmless).
- If sudden death stalls on the last ring for 30 s, the player with the most hearts wins the
  round.
- Gamepad support (a stretch goal) is not in v1.
