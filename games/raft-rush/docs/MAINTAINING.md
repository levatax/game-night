# Raft Rush: maintaining

Where the numbers live, how to run the harnesses and tests, what the debug hook gives you, and how the server is
run. How the game works is `docs/ARCHITECTURE.md`; what it should be is `game4.md` (Turkish, repo root).
Commands run from the repo root. `C` = `shared/constants.ts`, `I` = `shared/items.ts`.

## 1. Where the numbers live

| File | Holds | Client sees it |
|---|---|---|
| `C` | every game4.md §21 number, plus world size, movement, throws, survival, the raft (`RAFT_STAGES`: per-stage requirement rows by seats, `minDay`, `assemblySec`, `minHolders`; `RAFT_HP_*`, `RAFT_REPAIR_*`, `ASSEMBLY_*`, `ESCORT_RADIUS`, `HEAVY_CARRY_*`), spring / wreck charges, fishing, monsters (`MONSTERS`, `nightWave`, `bossHpFor`), `DIFFICULTIES` (`raftCostMult`, `bossHp`, `bossFromNight`, `launchDay`), the day schedule (`NORMAL_TIMINGS` / `FAST_TIMINGS`, `Timings.days`), scoring (`WIN_*`, `LEFT_BEHIND_PENALTY`, `LOSS_PER_STAGE`), room limits, net smoothing, camera, `CHARACTERS` (role kits), `BIOMES` | yes |
| `I` | `ITEMS` (stack, damage, knock, food, water, physics, `heavy`), `RECIPES` (costs, `bench` tier, `minDay`), `raftStageNeeds()` / `raftAssemblyTicks()` (seats × `raftCostMult`; fast: 1 / 1 s), `FISH_LOOT` / `TREASURE_LOOT` weights | yes |
| `server/world/life/tuning.ts` | what game4.md leaves open: monster steering, bite / gnaw reach, raft hp per gnaw (`CRAB_RAFT_GNAW` 2, `BOSS_RAFT_GNAW` 16, `PUFFER_RAFT_DAMAGE` 10), `CHEST_RAID_TICKS` 8 s, the boss unstick (`BOSS_STUCK_TICKS` 8 s), monkey / gull timings, `MONKEY_FENOMEN_RADIUS` 25, `GIFT_TREASURE_CHANCE` 0.25 | no |
| `server/world/loot.ts`, `server/world/rules.ts` | `LOOT_JITTER` 0.2 (per-match ±20 % on each fish-loot weight); `RANGE_SLACK` 0.5 m on every server range check | no |
| `server/room/timings.ts` | `NEVER_JOINED_DISPOSE_SEC` 10, `PREVIEW_COOLDOWN_SEC` 1, `ACTION_COOLDOWN_TICKS` 5, `ACTION_BURST` 4; asserts `RECONNECT_GRACE_SEC < EMPTY_ROOM_DISPOSE_SEC` at startup | no |
| `server/room/flood.ts`, `registry.ts`, `server/world/eventBuffer.ts` | `MESSAGE_RATE` 120/s, `MESSAGE_BURST` 240; `DEFAULT_MAX_ROOMS` 64, `STALL_MS` 5000; `EVENT_BUFFER_CAP` 512 | no |
| `server/room/botBrain.ts`, `botNeeds.ts` | bot thresholds (`HUNGRY` / `THIRSTY` 45, `STARVING` 18, `FLEE_HP` 30, `REST_HP` 40, `COLD` 35, `ENGAGE_RANGE` 16 / `ENGAGE_RANGE_BEKCI` 22, `EVENING_SEC` 14, role `AFFINITY`), the bill of materials (`teamPlan`: current stage + next-stage prestock + role tools + repairs to `RAFT_REPAIR_TARGET` 80 + fuel), the work weighting (a wanted log counts ×3, scrap ×2: what they unlock). No pacing brake any more: the day locks pace the raft | no |

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
| Landing / day / dusk / night / storm (Long Tide) 10 / 165 / 15 / 80 / 20 s | `LANDING_SEC`, `DAY_SEC`, `DUSK_SEC`, `NIGHT_SEC`, `STORM_SEC` (`C`) → `NORMAL_TIMINGS` | 10 / 165 / 15 / 80 / **12** | `Timings.days` 8 (fast 3); storm at 34:40 after the landing (`matchTicks`, `shared/rules/schedule.ts`). Launch window from `DIFFICULTIES[d].launchDay` (normal 7 = 26:00; `launchDayFor`), stage locks `RAFT_STAGES[s].minDay` (`stageDayLock`); both 1 in fast mode. Push-off `LAUNCH_WAIT_TICKS` 60 s, earliest departure `LAUNCH_MIN_TICKS` 30 s. `LANDING_LOCK_SEC` 3 (input locked), `LAUNCH_SEC` 8 (win cinematic), `STORM_WARN_SEC` 30, `MATCH_END_LOBBY_SEC` 60. Storm: drift 9 |
| Hunger / thirst per min (Long Tide: 12 / 16; sprint ×1.5, heat wave thirst ×2) | `HUNGER_PER_MIN`, `THIRST_PER_MIN`, `SPRINT_HUNGER_MULT`, `HEATWAVE_THIRST_MULT` | 12, 16, 1.5, 2 | × `DIFFICULTIES[d].bars` × `Timings.barMult`; heat wave ×1 within `SHADE_RADIUS` 2.5 m of a tree |
| Warmth −2/s; fire within 3 m +5/s; torch in hand −1/s | `WARMTH_LOSS_PER_SEC`, `FIRE_WARM_RADIUS`, `WARMTH_GAIN_FIRE_PER_SEC`, `TORCH_WARMTH_LOSS_PER_SEC` | 2, 3, 5, 1 | Drops at night, in rain, in water (not Çocuk: `waterChill`); volcanic: `BIOMES.volcanic.nightChill` false; cave: `SHELTER_RADIUS` 3.5 |
| Empty bar (Long Tide) −3 hp/s each, cold −1.5 | `EMPTY_BAR_DAMAGE_PER_SEC`, `COLD_DAMAGE_PER_SEC` | 3, 1.5 | Neighbours: `FIRE_HEAL_PER_SEC` 1 (only while fed and watered), `EAT_HEAL` 10 |
| Food: berry 15 · coconut 25 (+25 water) · raw fish 20 · cooked fish 45 · cooked crab 50 · golden fish 100 | `BERRY_FOOD` (`C`); `ITEMS.<kind>.food` / `.water` (`I`) | 15; 25 + 25; 20; 45; 50; 100 + 50 | `crab_raw` 10 (not in §21); Şef +5 on cooked food (`CHARACTERS.sef.cookedBonus`) |
| Water: spring 50 · coconut 25 · collector 40 | `SPRING_WATER`, `ITEMS.water.water`, `COLLECTOR_WATER` | 50, 50 (gourd), 40 | `COLLECTOR_USES` 3, rain refills one per `COLLECTOR_FILL_TICKS` 10 s |
| Gathering (Long Tide): wood 4 s (axe 1.5, Amca 1.1) · rope 1.5 · stone 2.5 · berry 1 · salvage 3 (Fenomen 2) | `GATHER_SEC`, `CHARACTERS[c].woodAxeSec` / `salvageSec` | as Long Tide | Hold-E channel per unit; the last unit of a tree taken with an axe drops a heavy `log` (`server/world/nodes.ts`); salvage needs a hammer (`CHANNEL.SALVAGE`) |
| Nodes (solo): 300 trees ×4 wood · 75 palms ×2 (90 s regrow) · 150 rocks ×2 · 200 bushes (50 % rope, 40 % berry; rope regrows in 150 s) | `BASE_NODE_COUNTS`, `NODE_AMOUNT`, `PALM_REGROW_TICKS`, `ROPE_REGROW_TICKS`, `BIOMES[b].ropeShare` / `berryShare` | tree 4 (Long Tide) | × `BIOMES[b].counts`; `BERRY_REGROW_TICKS` 90 s. Spring: `SPRING_BASE_CHARGES` + `SPRING_CHARGES_PER_SEAT` × seats charges, +1 per `SPRING_RECHARGE_TICKS`; wreck scrap `WRECK_SCRAP_BASE` + seats, +`WRECK_SCRAP_PER_DAWN` from day 2. Changes every island hash |
| Fire (Long Tide): 120 s full, wood +40 s, cap 300 s, fuel can +120 s | `FIRE_START_FUEL_TICKS`, `FIRE_WOOD_FUEL_TICKS`, `FIRE_FUEL_MAX_TICKS`, `FUEL_CAN_TICKS` | 120, 40, 300, 120 s | Burns ×`FIRE_DAY_BURN_MULT` 0.5 by day; jellyfish +60 s; `RAIN_FIRE_DRAIN_MULT` 2; ring `fireLightRadius` 3–6 m with the fuel, no ring below `FIRE_REPEL_MIN_FRACTION` 0.2; heals `FIRE_HEAL_PER_SEC` 1 only while fed and watered; low-fire banner below `FIRE_LOW_FRACTION` 0.2 |
| Torch 90 s / 4 m (fire 5 m) | `TORCH_BURN_TICKS`, `TORCH_LIGHT_RADIUS`, `FIRE_LIGHT_RADIUS` | 90 s, 4, 5 | Keep `ITEMS.torch.lightRadius` (`I`, 4) equal: the bots' sense of a held torch reads it. Boss in light: `BOSS_LIGHT_SLOW` 0.5 |
| Raft (Long Tide): six stages + the launch, game4.md §7 table | `RAFT_STAGES` (`C`) via `raftStageNeeds(stage, seats, raftCostMult)` / `raftAssemblyTicks` (`I`) | keel 2/4 · deck 12/4 · mast 1/4/5 · sail 4/2 · rudder 4/4/1 · provisions 5/2 at 3 seats | Seats = participants incl. bots, 2..6 (`server/room/lobby.ts` `raftSeats`). Assembly 1 work/s per holder with a hammer (0.5 by hand) × Kaptan 1.5 × `ASSEMBLY_GROUP_MULT` 1 / 1.2 / 1.4, ≤ 4 holders; the mast needs 2. Raft hp `RAFT_HP_MAX` 100, boarding ≥ `RAFT_HP_BOARD` 50; at 0 hp the raft is wrecked (keeps its stages, takes no more damage, can't be boarded until repaired; only a push-off in progress rolls Provisions back to `RAFT_HP_AFTER_LOSS` 40); repair plank +20 / 2 wood +10. Plank = `RECIPES.raft_part` (1 log → 3, bench 1) |
| Crab gnawing −raft hp / 4 s; a player within 6 m is targeted first | `RAFT_GNAW_TICKS`, `RAFT_GUARD_RADIUS` | 4 s, 6 | Reach `RAFT_GNAW_REACH` 2.5; crab −2 hp (Long Tide says 4: halved, see CONTRACT_CHANGES), boss −16 (`life/tuning.ts`); crabs going for the raft ignore torch rings |
| Waves (Long Tide): crabs round((2 + 1.2n)(0.7 + 0.3s)), puffers min(5, n − 1); Captain Crab every night from `bossFromNight` until killed, hp round((4 + 2s) × bossHp), wounds carry over between nights (`monsters.ts` `bossHpLeft`) | `nightWave(night, seats)`, `bossHpFor` | — | × `DIFFICULTIES[d].monsters` × `BIOMES[b].crabMult` / `pufferMult` × `FULLMOON_MONSTER_MULT` 1.5, puffers ≤ `MAX_PUFFERS` 6 (`server/world/life/waves.ts` `planWave`); `MONSTER_CAP` 24 alive, spawns over `MONSTER_SPAWN_WINDOW` 0.7; push-off launch wave `planLaunchWave` |
| Monster hp / damage: crab 2 / 15 · puffer 1 / 20 · boss 12 / 35 | `MONSTERS.crab` / `.puffer` / `.boss` | as §21 | Same records: speed, bite cooldown, radius, knockback; `CRAB_FLIP_TICKS` 8 s |
| Throw: charge 0.6 s, speed 34, gravity −20 → ~58 m; strait 26–30 m | `CHARGE_FULL_TICKS`, `THROW_SPEED_MAX`, `GRAVITY`, `STRAIT_MIN` / `STRAIT_MAX` | 0.6 s, 34, −20, 26 / 30 | `THROW_SPEED_MIN` 12; strait is duel only |
| Throw damage: coconut 1 · stone 1 · spear 2 · boot 1 (+knock) · puffer 2 in 3 m · fish 0 (bait 8 s, 15 m) | `ITEMS.<kind>.damage` / `.knock` (`I`); `PUFFER_BLAST_DAMAGE`, `PUFFER_BLAST_RADIUS`, `BAIT_TICKS`, `BAIT_RADIUS` (`C`) | as §21 (boot knock 2) | Boss takes bait for `BOSS_BAIT_TICKS` 5 s |
| Fishing: wait 2–6 s, window 0.6 s, loot §8, pity 4 | `FISH_WAIT_MIN_TICKS` / `MAX`, `FISH_BITE_TICKS`, `FISH_LOOT` (`I`), `FISH_PITY` | as §21 | Server slack ≤ `FISH_LAG_ALLOWANCE_MAX_TICKS` 0.15 s; weights × `BIOMES[b].loot` × `LOOT_JITTER` |
| Downed / revive: 25 s (Long Tide), hold E 3 s, half hp | `DOWNED_TICKS`, `REVIVE_TICKS`, `REVIVE_HP` | 25 s, 3 s, 50 | Dawn respawn with `RESPAWN_BARS` / `RESPAWN_HP` 60, only while a teammate lives; everyone washed = team wipe on any day |
| Reconnect 30 s | `RECONNECT_GRACE_SEC` | 30 | Server grace and the client's retry window; must stay below `EMPTY_ROOM_DISPOSE_SEC` 60 |
| Bot think 0.6–1.5 s; aim noise ±3° (Hamal / Aşçı), ±1° (Bekçi) | `BOT_THINK_MIN_SEC`, `BOT_THINK_MAX_SEC`, `BOT_AIM_NOISE_DEG` | 0.6, 1.5; hamal 3, balikci 2, bekci 1, asci 3 | Balıkçı's 2° is ours |
| Difficulty: Tatil monsters ×0.6, bars ×0.7 · Normal ×1 · Kabus ×1.5, ×1.3, boss from night 2 | `DIFFICULTIES` | + Long Tide `raftCostMult` 0.75 / 1 / 1.25, `bossHp` 0.7 / 1 / 1.4, `bossFromNight` 3 / 3 / 2, `launchDay` 6 / 7 / 7 | `DEFAULT_DIFFICULTY` normal |
| MVP: gather 1 · deliver 3 · hit 2 · kill 5 · revive 10 · fish 2 · golden 25 · raid 8 · first aboard +5 | `MVP_POINTS` | + Long Tide: assemble 1 per 2 s held, heavy +4, escort 2, salvage 2, repair 3, processed craft 1 | `PIRATE_HAT_SCORE` 20; team score = Σ MVP points + (win) `LAUNCH_BONUS` 500 + `WIN_SURVIVOR_BONUS` 200 × survivors aboard + `WIN_RAFT_HP_BONUS` 5 × raft hp + `WIN_BOSS_BONUS` 100 if Captain Crab is down − `LEFT_BEHIND_PENALTY` 150 × living left behind, or (loss) `LOSS_PER_STAGE` 40 × stages assembled (`server/room/scoring.ts`). No seconds bonus any more |
| Titles | `TITLE_IDS` | mvp + the seven of §21 | Rules: `server/room/scoring.ts` `awardTitles` |

§21's old tempo paragraph (one shopping list, hull 16 / mast 4 + 6 / provisions 4 + 4) is gone: the Long Tide stage table is `RAFT_STAGES`.

## 3. Known deviations from game4.md

Design calls the build made that game4.md doesn't (ARCHITECTURE §2 marks each). None is confirmed by a playtest.

| # | game4.md | Build | Where to change it |
|---|---|---|---|
| 1 | Rain puts the campfire out (§9) | Fuel drains ×2 while it rains (a hut shelters it) | `RAIN_FIRE_DRAIN_MULT`; `server/world/survival.ts` fire step |
| 2 | The raft leaves when every survivor has boarded (§4) | The first boarder starts a 60 s push-off (and the launch wave); the raft leaves once every living participant is aboard and 30 s have passed, else at 60 s with whoever is aboard (−150 per living one left behind) | `LAUNCH_WAIT_TICKS`, `LAUNCH_MIN_TICKS` (`Timings.launchWait` / `launchMin`); `server/world/raft.ts` `step` |
| 3 | Treasures come out of the chest reel (§8) | Instant team effects when the reel stops, never an inventory item | `server/world/effects.ts` `EffectSystem`; reels `server/world/life/treasure.ts` |
| 4 | Kaptan: raft delivery +10 % faster (§14) | Long Tide role kit: assembles ×1.5, a plank repair gives +10 more | `CHARACTERS.kaptan.assemblyMult` / `repairBonus` |
| 5 | Şef: cooks 2× faster, cooked food +5 (§14) | Cooking is instant for everyone; Şef gets 2 cooked from 1 raw (Long Tide) and +5 on cooked food | `CHARACTERS.sef.cookOut` / `cookedBonus` |
| 6 | Monkeys steal Fenomen's selfie stick first (§14) | 1–2 monkeys each grab one item from the chest; the first goes for Fenomen's pockets instead when she is within 25 m of the chest carrying something | `server/world/life/dayEvents.ts`, `visitors.ts`; `MONKEY_FENOMEN_RADIUS` |
| 7 | Raft part: 3 wood, +1 rope in the mast stage (§7) | Long Tide: `raft_part` is the Plank (1 log → 3 at the workbench), delivered like any other requirement | `RECIPES.raft_part` (`I`); `shared/rules/interact.ts` `planRaftDelivery` |
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
kills, stages lost, Captain Crab's nights / damage taken / the day he went down, goal shares, rejects) and a
summary, on stdout (a plain run shows it). About 1.5 s a 35-minute match.

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
| `RAFT_BALANCE_TRACE` | off | print every bot goal change (and why the last one failed), throw and hit, plus a team status line every 10 s (fire, raft stage / rows / work / hp, bench, wreck scrap, Captain Crab, chest) |
| `RAFT_BALANCE_BOSS_HELP` | 0 | `<day>`: Captain Crab is down by the dawn of that day and his compass is in the chest — the "human helps a bit" stand-in (bots alone rarely kill him) |
| `RAFT_BALANCE_BAND` | — | `lo-hi` win %: assert it. Only for the target scenario (normal, 3 bots, 0 idle humans, real timings); with any other scenario the run fails |

Target (Long Tide): 55–75 % Normal wins, the launch between 26:00 and 34:40 (the day locks make an earlier one
impossible). No band is agreed yet, so it reports only. Measured in the Long Tide verifier pass (10 seeds, Normal,
after the bots' log / scrap weighting): bots alone 0 % (Captain Crab is never killed, so the rudder never gets its
compass; the bots land ~1–2 hits a night on him); with `RAFT_BALANCE_BOSS_HELP=4` 3 bots 5/10 launch (26:40,
26:51, 31:57, 32:20, 32:23) and 4 bots 5/10 (26:30–31:43); `BOSS_HELP=5` 3 bots 4/10; 2 bots + 1 idle human 0/10
(the bots spend a quarter of their time reviving the passenger). Losses are mostly storms at stage 4–5 or a wipe on
night 4–5. The levers: the threat
numbers in `C` (`nightWave`, `bossHpFor`, bars, fire) and `server/world/life/tuning.ts` (`CRAB_RAFT_GNAW`,
`BOSS_RAFT_GNAW`, `PUFFER_RAFT_DAMAGE`, `CHEST_RAID_TICKS`), the raft table `RAFT_STAGES`, and the bots' night
duties (`botBrain.ts` guard / guard2, `botMotor.ts` guard: torch swings, throws at scared crabs, kiting the boss).

**Nightly CI**: `.github/workflows/balance.yml` ("Raft Rush balance", 03:23 UTC daily and on demand) runs the
target scenario with 30 seeds and writes the table into the run summary. It fails only when the harness breaks;
set `RAFT_BALANCE_BAND` there (commented out, `"55-75"`) once a band is agreed.

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
| What CI runs | `npm run typecheck && npx vitest run && npm run build && npm run build:server && node scripts/smoke-hub.mjs` |

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

**CI** (`.github/workflows/ci.yml`, every push and PR, Node 22): `npm ci`, typecheck, `npx vitest run`, `npm run
build`, `npm run build:server`, then `node scripts/smoke-hub.mjs` boots the compiled hub and fails unless
`/healthz` answers 200 and every game logged `registered`. Nightly balance: §4.

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
