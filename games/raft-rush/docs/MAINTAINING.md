# Raft Rush: maintaining

Where the numbers live, how to run the harnesses and tests, what the debug hook gives you, and how the server is
run. How the game works is `docs/ARCHITECTURE.md`; what it should be is `game4.md` (Turkish, repo root).
Commands run from the repo root. `C` = `shared/constants.ts`, `I` = `shared/items.ts`.

## 1. Where the numbers live

| File | Holds | Client sees it |
|---|---|---|
| `C` | every game4.md §21 number, plus world size, movement, throws, survival, raft, fishing, monsters (`MONSTERS`, `nightWave`), `DIFFICULTIES`, the day schedule (`NORMAL_TIMINGS` / `FAST_TIMINGS`), scoring, room limits, net smoothing, camera, `CHARACTERS` (perks), `BIOMES` | yes |
| `I` | `ITEMS` (stack, damage, knock, food, water, physics), `RECIPES` (costs), `raftCost()`, `FISH_LOOT` / `TREASURE_LOOT` weights | yes |
| `server/world/life/tuning.ts` | what game4.md leaves open: monster steering, bite / gnaw reach, `BOSS_RAFT_GNAW` 2, `PUFFER_RAFT_DAMAGE` 1, monkey / gull timings, `MONKEY_FENOMEN_RADIUS` 25, `GIFT_TREASURE_CHANCE` 0.25 | no |
| `server/world/loot.ts`, `server/world/rules.ts` | `LOOT_JITTER` 0.2 (per-match ±20 % on each fish-loot weight); `RANGE_SLACK` 0.5 m on every server range check | no |
| `server/room/timings.ts` | `NEVER_JOINED_DISPOSE_SEC` 10, `PREVIEW_COOLDOWN_SEC` 1, `ACTION_COOLDOWN_TICKS` 5, `ACTION_BURST` 4; asserts `RECONNECT_GRACE_SEC < EMPTY_ROOM_DISPOSE_SEC` at startup | no |
| `server/room/flood.ts`, `registry.ts`, `server/world/eventBuffer.ts` | `MESSAGE_RATE` 120/s, `MESSAGE_BURST` 240; `DEFAULT_MAX_ROOMS` 64, `STALL_MS` 5000; `EVENT_BUFFER_CAP` 512 | no |
| `server/room/botBrain.ts`, `botNeeds.ts` | bot thresholds (`HUNGRY` / `THIRSTY` 45, `STARVING` 18, `FLEE_HP` 30, `REST_HP` 40, `COLD` 35, `ENGAGE_RANGE` 16 / `ENGAGE_RANGE_BEKCI` 22, `EVENING_SEC` 14, role `AFFINITY`) and raft pacing (`PACE_FINISH_FRACTION` 0.75, `PACE_SLACK` 0.06, `PACE_SLACK_PER_HUMAN` 0.08: bots stop feeding the raft while the team is that far ahead of a schedule that finishes at 75 % of the match) | no |

Rules for a retune:
- Changing a value is tuning. Renaming, removing or retyping an export is a contract change (one line in
  `docs/CONTRACT_CHANGES.md`, ARCHITECTURE §0).
- Author time in seconds (`*_SEC`, `secToTicks()`); the sim only sees integer 30 Hz ticks.
- The client runs the same `shared/` code: it predicts movement, throws and channels and regenerates the island
  from the seed. Ship client and server from one build. A page loaded before the deploy mispredicts (or flags an
  island mismatch) until it reloads; for a change to the shared sim or the island, bump `PROTOCOL_VERSION`
  (`shared/protocol.ts`) so those pages get `OUTDATED` and a Reload button instead.
- Island numbers (`ISLAND_RADIUS`, `PEAK_*`, `BASE_NODE_COUNTS`, `BIOMES[b].counts` / shares, `FISH_SPOTS_*`,
  `CAMP_FROM_WRECK_*`…) change the island of every seed: a shared seed no longer replays the same island, and
  `shared/island/generate.test.ts` checks node counts within ±10 % of the target and the corridors.
- After a retune run `npx vitest run games/raft-rush` (several world and bot tests use `NORMAL_TIMINGS`) and the
  balance harness (§4).

## 2. game4.md §21 → code

| §21 row | Constants | Now | Notes |
|---|---|---|---|
| Landing / day / dusk / night / storm 10 / 95 / 10 / 50 / 20 s | `LANDING_SEC`, `DAY_SEC`, `DUSK_SEC`, `NIGHT_SEC`, `STORM_SEC` (`C`) → `NORMAL_TIMINGS` | 10 / 95 / 10 / 50 / **12** | `DAYS` 3; storm at 7:45 after the landing (`matchTicks`, `shared/rules/schedule.ts`). `LANDING_LOCK_SEC` 3 (input locked), `LAUNCH_SEC` 8 (win cinematic), `STORM_WARN_SEC` 30, `MATCH_END_LOBBY_SEC` 60. Storm: drift 9 |
| Hunger / thirst 25 / 33 per min (sprint ×1.5, heat wave thirst ×2) | `HUNGER_PER_MIN`, `THIRST_PER_MIN`, `SPRINT_HUNGER_MULT`, `HEATWAVE_THIRST_MULT` | 25, 33, 1.5, 2 | × `DIFFICULTIES[d].bars` × `Timings.barMult`; heat wave ×1 within `SHADE_RADIUS` 2.5 m of a tree |
| Warmth −2/s; fire within 3 m +5/s; torch in hand −1/s | `WARMTH_LOSS_PER_SEC`, `FIRE_WARM_RADIUS`, `WARMTH_GAIN_FIRE_PER_SEC`, `TORCH_WARMTH_LOSS_PER_SEC` | 2, 3, 5, 1 | Drops at night, in rain, in water (not Çocuk: `waterChill`); volcanic: `BIOMES.volcanic.nightChill` false; cave: `SHELTER_RADIUS` 3.5 |
| Empty bar −2 hp/s each | `EMPTY_BAR_DAMAGE_PER_SEC` | 2 | Neighbours (game4.md §5): `FIRE_HEAL_PER_SEC` 3, `EAT_HEAL` 10 |
| Food: berry 15 · coconut 25 (+25 water) · raw fish 20 · cooked fish 45 · cooked crab 50 · golden fish 100 | `BERRY_FOOD` (`C`); `ITEMS.<kind>.food` / `.water` (`I`) | 15; 25 + 25; 20; 45; 50; 100 + 50 | `crab_raw` 10 (not in §21); Şef +5 on cooked food (`CHARACTERS.sef.cookedBonus`) |
| Water: spring 50 · coconut 25 · collector 40 | `SPRING_WATER`, `ITEMS.water.water`, `COLLECTOR_WATER` | 50, 50 (gourd), 40 | `COLLECTOR_USES` 3, rain refills one per `COLLECTOR_FILL_TICKS` 10 s |
| Gathering: wood 2.5 s (axe 1) · rope 1.5 · stone 2 · berry 1 | `GATHER_SEC` | as §21 | Hold-E channel per unit |
| Nodes (solo): 120 trees ×3 wood · 30 palms ×2 (60 s regrow) · 60 rocks ×2 · 80 bushes (50 % rope, 40 % berry) | `BASE_NODE_COUNTS`, `NODE_AMOUNT`, `PALM_REGROW_TICKS`, `BIOMES[b].ropeShare` / `berryShare` | as §21 (tropic 0.5 / 0.4) | × `BIOMES[b].counts`; `BERRY_REGROW_TICKS` 90 s. Changes every island |
| Fire: 60 s full, wood +30 s, fuel can +120 s | `FIRE_START_FUEL_TICKS`, `FIRE_WOOD_FUEL_TICKS`, `FUEL_CAN_TICKS` | 60, 30, 120 s | The cap `FIRE_FUEL_MAX_TICKS` 180 s is ours; jellyfish +60 s (`JELLYFISH_FUEL_TICKS`, game4.md §8); `RAIN_FIRE_DRAIN_MULT` 3 (drift 1); low-fire banner below `FIRE_LOW_FRACTION` 0.2 |
| Torch 90 s / 4 m (fire 5 m) | `TORCH_BURN_TICKS`, `TORCH_LIGHT_RADIUS`, `FIRE_LIGHT_RADIUS` | 90 s, 4, 5 | Keep `ITEMS.torch.lightRadius` (`I`, 4) equal: the bots' sense of a held torch reads it. Boss in light: `BOSS_LIGHT_SLOW` 0.5 |
| Raft cost: §7 table (2 seats 10 wood … 6 seats 24) | `RAFT_COSTS` (`C`) via `raftCost(seats)` (`I`) | as game4.md §7 | Seats = participants incl. bots, 2..6 (`server/room/lobby.ts` `raftSeats`). `WRECK_HULL_WOOD` 3 (free part), `RAFT_PART_WOOD` 3, `RECIPES.raft_part` 3 wood (drift 7) |
| Crab gnawing −1 hull wood / 4 s; a player within 6 m is targeted first | `RAFT_GNAW_TICKS`, `RAFT_GUARD_RADIUS` | 4 s, 6 | Reach `RAFT_GNAW_REACH` 2.5, boss gnaws `BOSS_RAFT_GNAW` 2 (`life/tuning.ts`) |
| Waves: night 1: 3 + seats · night 2: 5 + seats×1.5 + 2 puffers · night 3: 6 + seats×2 + 3 puffers + boss | `nightWave(night, seats)` | as §21 | × `DIFFICULTIES[d].monsters` × `BIOMES[b].crabMult` / `pufferMult` × `FULLMOON_MONSTER_MULT` 1.5 (`server/world/life/waves.ts` `planWave`); `MONSTER_CAP` 16 alive, spawns over `MONSTER_SPAWN_WINDOW` 0.6 of the night |
| Monster hp / damage: crab 2 / 15 · puffer 1 / 20 · boss 12 / 35 | `MONSTERS.crab` / `.puffer` / `.boss` | as §21 | Same records: speed, bite cooldown, radius, knockback; `CRAB_FLIP_TICKS` 8 s |
| Throw: charge 0.6 s, speed 34, gravity −20 → ~58 m; strait 26–30 m | `CHARGE_FULL_TICKS`, `THROW_SPEED_MAX`, `GRAVITY`, `STRAIT_MIN` / `STRAIT_MAX` | 0.6 s, 34, −20, 26 / 30 | `THROW_SPEED_MIN` 12; strait is duel only |
| Throw damage: coconut 1 · stone 1 · spear 2 · boot 1 (+knock) · puffer 2 in 3 m · fish 0 (bait 8 s, 15 m) | `ITEMS.<kind>.damage` / `.knock` (`I`); `PUFFER_BLAST_DAMAGE`, `PUFFER_BLAST_RADIUS`, `BAIT_TICKS`, `BAIT_RADIUS` (`C`) | as §21 (boot knock 2) | Boss takes bait for `BOSS_BAIT_TICKS` 5 s |
| Fishing: wait 2–6 s, window 0.6 s, loot §8, pity 4 | `FISH_WAIT_MIN_TICKS` / `MAX`, `FISH_BITE_TICKS`, `FISH_LOOT` (`I`), `FISH_PITY` | as §21 | Server slack ≤ `FISH_LAG_ALLOWANCE_MAX_TICKS` 0.15 s; weights × `BIOMES[b].loot` × `LOOT_JITTER` |
| Downed / revive: 10 s, hold E 3 s, half hp | `DOWNED_TICKS`, `REVIVE_TICKS`, `REVIVE_HP` | 10 s, 3 s, 50 | Dawn respawn with `RESPAWN_BARS` / `RESPAWN_HP` 60 |
| Reconnect 30 s | `RECONNECT_GRACE_SEC` | 30 | Server grace and the client's retry window; must stay below `EMPTY_ROOM_DISPOSE_SEC` 60 |
| Bot think 0.6–1.5 s; aim noise ±3° (Hamal / Aşçı), ±1° (Bekçi) | `BOT_THINK_MIN_SEC`, `BOT_THINK_MAX_SEC`, `BOT_AIM_NOISE_DEG` | 0.6, 1.5; hamal 3, balikci 2, bekci 1, asci 3 | Balıkçı's 2° is ours |
| Difficulty: Tatil monsters ×0.6, bars ×0.7 · Normal ×1 · Kabus ×1.5, ×1.3, boss on night 2 | `DIFFICULTIES` | as §21 | `DEFAULT_DIFFICULTY` normal |
| MVP: gather 1 · deliver 3 · hit 2 · kill 5 · revive 10 · fish 2 · golden 25 · raid 8 · first aboard +5 | `MVP_POINTS` | as §21 | `PIRATE_HAT_SCORE` 20; team score on a launch = Σ MVP points + `LAUNCH_BONUS` 500 + `LAUNCH_BONUS_PER_SEC` 2 × seconds left (`server/room/scoring.ts`) |
| Titles | `TITLE_IDS` | mvp + the seven of §21 | Rules: `server/room/scoring.ts` `awardTitles` |

§21's tempo paragraph (4 seats: hull 16, mast 4 + 6, provisions 4 + 4) is `RAFT_COSTS[4]`.

## 3. Known deviations from game4.md

Design calls the build made that game4.md doesn't (ARCHITECTURE §2 marks each). None is confirmed by a playtest.

| # | game4.md | Build | Where to change it |
|---|---|---|---|
| 1 | Rain puts the campfire out (§9) | Fuel drains ×3 while it rains (a duel hut shelters it) | `RAIN_FIRE_DRAIN_MULT`; `server/world/survival.ts` fire step |
| 2 | The raft leaves when every survivor has boarded (§4) | The first boarder starts a 20 s countdown; then the raft leaves with whoever is aboard ("Wilson finale") | `LAUNCH_WAIT_TICKS` (`Timings.launchWait`); `server/world/raft.ts` `step` |
| 3 | Treasures come out of the chest reel (§8) | Instant team effects when the reel stops, never an inventory item | `server/world/effects.ts` `EffectSystem`; reels `server/world/life/treasure.ts` |
| 4 | Kaptan: raft delivery +10 % faster (§14) | A raft part he delivers counts +1 wood (4) | `CHARACTERS.kaptan.raftPartBonus`; `shared/rules/interact.ts` `raftPartValue` |
| 5 | Şef: cooks 2× faster, cooked food +5 (§14) | Only the +5; cooking is instant for everyone | `CHARACTERS.sef.cookedBonus`; `server/world/actions.ts` eat |
| 6 | Monkeys steal Fenomen's selfie stick first (§14) | 1–2 monkeys each grab one item from the chest; the first goes for Fenomen's pockets instead when she is within 25 m of the chest carrying something | `server/world/life/dayEvents.ts`, `visitors.ts`; `MONKEY_FENOMEN_RADIUS` |
| 7 | Raft part: 3 wood, +1 rope in the mast stage (§7) | 3 wood only; rope is delivered straight to the mast | `RECIPES.raft_part` (`I`); `shared/rules/interact.ts` `planRaftDelivery` |
| 8 | No eat key (§15) | F eats / drinks the held item (H in the left-handed preset; LMB on food charges a throw); E also picks up ground items and flipped crabs | `client/src/input/bindings.ts` (`eat`), `BTN.EAT`; `game.json` `controls` / `howToPlay` say F |
| 9 | Storm scene 20 s (§4, §21) | `STORM_SEC` 12 | `C` |

## 4. Harnesses

**Client dev harnesses** (`client/dev/`, dev only, never in the game build): `npx vite --config
games/raft-rush/client/dev/vite.<name>.config.ts`, then open `http://localhost:<port>/games/raft-rush/dev/<name>.html`.
`npx vite build --config …` is a build check (it writes outside `client/dist`). Ports are fixed (`strictPort`).

| Name | Port | Shows | Hook |
|---|---|---|---|
| `island` | 5191 | `generateIsland(?seed=&layout=)` through the real Renderer: free-fly / FP walk / orbit, `?t=` time of day, `?weather=`, storm / launch, raft stage, fire fuel, structures, quality tiers | `window.islandHarness` |
| `ui` | 5192 | every screen, HUD state, panel, wheel and reel from mock models (`?state=<id>`, `?anim=0` for stable screenshots); logs every UiEventMap event | — |
| `characters` | 5193 | the six tourists, monsters, FP arms, nameplates, portraits | `window.raftCharHarness` |
| `fx` | 5194 | bursts, pop text, item meshes, projectiles, arc preview, pings, bobbers | `window.fxHarness` |
| `audio` | 5196 | every SFX, loop, voice, music mood, the radio, ambience; meter + loudness probe | `window.audioHarness` |

**Bot balance harness** (`server/room/botBalance.test.ts`, skipped by default): bot-only matches on the real
RaftWorld + BotDesk with the room's phase loop reproduced (no Colyseus, so stand-ins, budgets and reject routing
aren't in it). One line per seed (outcome launched / storm / wiped / timeout, seconds, raft, deliveries, downs,
kills, goal shares, rejects) and a summary, on stdout (a plain run shows it). About 0.7 s a match.

```
RAFT_BALANCE=1 npx vitest run games/raft-rush/server/room/botBalance.test.ts
```

| Variable | Default | Meaning |
|---|---|---|
| `RAFT_BALANCE` | off | run it |
| `RAFT_BALANCE_SEEDS` | 6 | matches |
| `RAFT_BALANCE_SEED` | — | first seed (default seeds 1000 + i × 7919) |
| `RAFT_BALANCE_BOTS` | 3 | bots |
| `RAFT_BALANCE_IDLE_HUMANS` | 0 | humans who never move (1 with 2 bots = the worst solo match) |
| `RAFT_BALANCE_DIFFICULTY` | normal | vacation / normal / nightmare |
| `RAFT_BALANCE_FAST` | off | `1` = the RAFT_TEST timers: a smoke run of the match flow (bots lose every match there) |
| `RAFT_BALANCE_TRACE` | off | print every bot goal change, throw and hit |
| `RAFT_BALANCE_BAND` | — | `lo-hi` win %: assert it. Only for the target scenario (normal, 3 bots, 0 idle humans, real timings); with any other scenario the run fails |
| `RAFT_BALANCE_GATE` | off | `1` = acceptance gate: 30 seeds × expert + novice cohorts, per-seed boss/launch table, gate assertions |

**Acceptance gate** (`npm run balance`, the same command CI runs): the expert cohort is Normal, 3 bots, no idle
humans; the novice cohort is Normal, 2 bots + 1 idle human (a novice partner who never plays). Each seed prints
`boss yes/no`, `launch <second>s`, the outcome and downs. The gate holds:

| Check | Target |
|---|---|
| boss spawn | 100 % in both cohorts |
| raft launch median (expert) | 440–460 s |
| expert win rate | 55–75 % |
| novice win rate | 40–50 % |
| any cohort | ≥ 15 % |

Any violation is printed as `GATE FAIL: …` and fails the run (CI red). This is an acceptance gate: a red run means
the beta is not accepted yet. The levers are §1–§2 (bars, waves, raft costs) and the bot pacing in
`botNeeds.ts`; the harness itself changes no balance value.

**CI**: `.github/workflows/balance.yml` ("Raft Rush acceptance", 03:23 UTC daily, on demand, and on pushes/PRs
that touch Raft Rush) runs `npm run typecheck` and `npm run balance`, and writes the whole table and summary into
the run summary.

**Render budget readout**: `?stats=1` on the game page prints draw calls and triangles for the frame just drawn,
their peak and the quality tier, and mirrors them to `window.__raftPerf`. `?quality=low|medium|high` pins the tier
before boot so the reading is reproducible (`?stats=1&quality=high`). The budget is ≤ 60 draw calls and ≤ 250k
triangles (`client/src/render/perfBudget.ts`); the overlay turns red and says `OVER BUDGET` when either is over.

## 5. `?debug=1`

`client/src/main.ts`: with `?debug=1` (any `debug` parameter) on a dev bundle (`import.meta.env.DEV`) or on a page
served from this machine (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost`), `window.__raft` is the App instance; a
deployed host never gets it. Its modules are TypeScript-private but
plain properties at run time: `__raft.net` (`state`, `me`, `status`, `events`), `__raft.game` (GameController),
`__raft.renderer`, `__raft.ui`, `__raft.input`, `__raft.audio`, `__raft.characters`, `__raft.fx`.

So `npm run dev` (or `npm run build && npm start`) and `http://localhost:3000/games/raft-rush/?debug=1` is all it
takes. The plain Vite dev server is a dev bundle too, but Net connects to the page's own origin, which has no
Colyseus there: only Home works.

## 6. Tests

| What | Command |
|---|---|
| Everything in the game | `npx vitest run games/raft-rush` |
| One area | `npx vitest run games/raft-rush/<folder or file>` (e.g. `server/world`, `server/RaftRoom.test.ts`, `client/src/ui`) |
| Hub helpers + `/healthz` | `npx vitest run server/games.test.ts` |
| Typecheck (game + hub) | `npx tsc --noEmit -p games/raft-rush/tsconfig.json`; whole repo `npm run typecheck` |
| Client build | `node scripts/build-games.mjs raft-rush` |
| What CI runs | `npm run typecheck && npm run balance` |

Room tests (`server/RaftRoom.test.ts`, `test/room-smoke.test.ts`):
- They start an in-process Colyseus server on a free port and talk real WebSockets through colyseus.js. They stub
  `RAFT_TEST=1` themselves (`vi.stubEnv`); don't run them with `NODE_ENV=production` (the knobs switch off).
- Bot matches and timer tests create the room with `manualClock: true`: no simulation interval; the test moves
  room time with `room.advance(ms)` (or `advance(ms, true)`: one stalled callback) on the instance from
  `matchMaker.getLocalRoomById(roomId)`. Use it for anything that waits on room time (dispose deadlines, budgets,
  match flow).
- Joins, messages, reconnects and the smoke test's warped match still run on the wall clock. A lone timeout on a
  loaded machine or after the laptop slept is usually a flake: rerun before digging.
- Room logs are muted under `RAFT_TEST=1`; `RAFT_LOG=1` turns them on.

Client tests run in vitest's node environment; the DOM ones (Input, ChestPanel, Subtitle, keyStrings) bring
small DOM shims.

## 7. Ops

**Environment**

| Variable | Read by | Effect |
|---|---|---|
| `PORT` | `server/index.ts` | hub port (3000) |
| `RAFT_MAX_ROOMS` | `server/room/registry.ts` `maxRooms()`, at every create | live RaftRooms per process (positive integer, default 64); a create beyond it fails with `SERVER_BUSY` (4405, client `menu.errServerBusy`) before a code or island is allocated |
| `RAFT_LOG` | `server/room/log.ts` | `1` = room logs on under `RAFT_TEST=1` |
| `RAFT_TEST` | `server/room/testing.ts` | `1` = honor the test CreateOptions `fast`, `testSeed`, `warp`, `manualClock` (any client may then shorten timers): never on a public server. Mutes room logs |
| `NODE_ENV` | `testing.ts`; Vite | `production` (the Dockerfile sets it) ignores `RAFT_TEST` and `register()` logs an error once; `test` or a vitest worker silences the "RAFT_TEST outside a test runner" warning. At client build time `development` makes a dev bundle (§5) |
| `SMOKE_PORT` | `scripts/smoke-hub.mjs` | port for the smoke boot (default: a free one) |

**Log lines** (`server/room/log.ts`): one JSON object per line, `{ ...fields, "ts", "game": "raft-rush", "event" }`,
info on stdout, warnings on stderr.

| `event` | When | Fields |
|---|---|---|
| `create` | room created | `room`, `rooms`, `maxRooms`, `fast`, `manualClock` |
| `createRefused` (warn) | creates refused at the cap; one summary per 10 s per process | `reason` "busy", `refused`, `rooms`, `maxRooms` |
| `firstJoin` | the first client joined | `room`, `afterMs` |
| `matchStart` | a match starts | `room`, `match`, `seed`, `biome`, `difficulty`, `humans`, `bots` |
| `phase` | every phase change | `room`, `match`, `from`, `to`, `tick` |
| `matchEnd` | the podium | `room`, `match`, `reason` (launched / storm / abandoned), `winnerTeam`, `teamScore`, `seconds`, `day` |
| `simDropped` (warn) | simulated time thrown away after a stall (more than 4 ticks due in one callback); one summary per 10 s per room, flushed at dispose | `room`, `droppedMs`, `stalls`, `phase` |
| `flood` (warn) | a client went over its message budget; once per client per second | `room`, `client`, `rate`, `burst` |
| `shutdown` | graceful process shutdown (SIGTERM / SIGINT): the room closes its clients with `CLOSE_CODE.SERVER_RESTART` | `room`, `phase`, `clients` |
| `stalled` (warn) | `/healthz` found a room with no fixed tick for `STALL_MS`; once per stall (`server/index.ts` health()) | `room`, `maxTickAgeMs` |
| `dispose` | room gone | `room`, `lifetimeSec`, `matches`, `joined`, `rooms` |

Not JSON: `[raft-rush CODE] <where> failed:` + stack (`console.error`; a message handler or tick that throws is
logged and the room carries on), one `[raft-rush] world: 512 events buffered…` warning per world at the event cap,
the hub's `[hub] registered raft-rush` / `[hub] failed to register raft-rush`, and the RAFT_TEST notice at
`register()`.

**`/healthz`** (hub, `server/games.ts` `hubHealth`): `{ ok, games, checks: { "raft-rush": { ok, rooms,
maxTickAgeMs, stalled } } }`, 200, or 503 when any check isn't `ok: true`, a game failed to register or its
`health()` threw. Raft Rush's `health()` (`server/index.ts` → `room/registry.ts` `roomHealth`) is not ok when a
live room hasn't completed a fixed tick for `STALL_MS` (5 s): a blocked loop, or a room whose every tick throws
(manual-clock test rooms are skipped). The endpoint is public, so it shows `stalled` as a count (the codes are
join codes) and no error text; throws from `health()` are logged throttled. The Docker image's HEALTHCHECK polls
it every 30 s.

**CI** (`.github/workflows/balance.yml`, every push/PR that touches Raft Rush, nightly and on demand, Node 22):
`npm ci`, `npm run typecheck`, `npm run balance`. A red run is a gate violation, not a broken workflow.

**Compiled server**: `npm run build:server` compiles the hub and every game's `server/` + `shared/` with
`tsconfig.server.json` (NodeNext, tests and clients left out) into `dist/` (`dist/server/index.js`,
`dist/games/raft-rush/server/…`); `npm run start:prod` (= the Docker CMD) runs `node dist/server/index.js`, which
loads each game's compiled server and serves the portal, `game.json` and the client builds from the repo root, so
run `npm run build` first. Server and shared files need `.js` import extensions (a missing one is a compile error)
and nothing tsx-only. `npm start` / `npm run dev` run from source with tsx.

**One process only**: room codes (`server/roomCodes.ts`), Colyseus matchmaking and the live-room registry are
in-process memory. Run exactly one replica (the Dockerfile says so); `RAFT_MAX_ROOMS` counts per process; a
restart ends every room and clients drop back to Home. The cap is not per client: a script that keeps creating
rooms can hold every slot until it stops (`registry.ts` header); a per-IP create throttle would sit in front of
matchmaking in the hub.
