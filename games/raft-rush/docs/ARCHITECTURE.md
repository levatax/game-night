# Raft Rush: architecture & module contracts

How Raft Rush is built: the modules and their owners, the contracts between them and the rules each one implements.
Read with `game4.md` (WHAT, in Turkish; repo root). Where the two differ, this file says what the code does, and §2
marks the calls that depart from game4.md. File headers and JSDoc are the detailed spec; `docs/CONTRACT_CHANGES.md`
logs every contract change; `docs/MAINTAINING.md` covers tuning (game4.md §21 → constants), harnesses, tests and ops.
Scope: milestones **M1–M5 plus most of M7** (co-op, solo with bots, TR/EN, tourists, FP arms, fish reel, weather
and day events, ping wheel). **M6 Ada Savaşı (duel) is not built**: the contracts carry `layout`, `team`, `hutHp`,
duel recipes and `generateIsland(seed, "duel")`, but the room only plays `mode: "coop"` (the lobby rejects duel with
a notice).

## 0. Rules

- **Contract files** (the interfaces between owners): `shared/constants.ts`, `shared/types.ts`, `shared/items.ts`,
  `shared/protocol.ts`, `shared/island/types.ts`, `shared/sim/context.ts`, `shared/sim/math.ts`,
  `shared/rules/schedule.ts`, `shared/rules/inventory.ts`, `server/schema.ts`, `server/world/events.ts`,
  `server/world/context.ts`, `server/hub.ts`, `server/index.ts`, `client/index.html`, `client/vite.config.ts`,
  `client/src/util/*`, `client/src/app/settings.ts`, `client/src/i18n/index.ts`, `client/src/net/types.ts`,
  `client/src/render/types.ts`, `client/src/ui/models.ts`, `client/src/audio/Sfx.ts` (append-only). Treat them as
  frozen: a body may get a real bug fix, a value in `constants.ts` / `items.ts` may be retuned (MAINTAINING.md §1),
  but a signature, field, message shape or key meaning changes only as a **contract change**: prefer additive
  (optional fields, new exports), update every caller in the same change, and append one line to
  `docs/CONTRACT_CHANGES.md` prefixed with the owner (a line that replaces an earlier rule says "supersedes"). An
  incompatible message or schema change also bumps `PROTOCOL_VERSION`.
- **Facades** (each module's public entry point, the only thing other modules call): `shared/island/generate.ts`,
  `shared/sim/{cover,player,projectile,throw}.ts`, `shared/rules/interact.ts`, `server/world/World.ts` (RaftWorld)
  with `server/world/{monsters,fishing,weather}.ts` behind `server/world/context.ts`, `server/RaftRoom.ts`,
  `server/room/bots.ts` (BotDesk), `client/src/net/Net.ts`, `client/src/render/Renderer.ts`,
  `client/src/characters/Characters.ts`, `client/src/fx/Fx.ts`, `client/src/audio/AudioEngine.ts`,
  `client/src/ui/Ui.ts`, `client/src/main.ts`. Their signatures are contracts too. `shared/island/{noise,
  heightfield}.ts` must keep their results bit-identical (they feed `gridHash`).
- **Owners** (§1): every file names its owner in its header (`Owner: <role>`). A change stays inside the owner's
  folder (private helpers, new files, new exports); anything another module needs goes through its facade or a
  contract change.
- **Games don't share code**: never import from `games/bonk-brawl`, `games/jelly-jackpot` or `games/kasala`.
  "Reuse" = copy the file under `games/raft-rush/` and adapt it (game4.md §20 has the source map).
- Imports: `.js` extensions in `shared/` and `server/` (the compiled server runs on plain Node ESM: a missing one
  is a `build:server` error); the client omits extensions (Vite). `shared/` has no DOM, no Node APIs, no
  decorators. Only `server/` imports `@colyseus/*`; only `client/src/net/` imports `colyseus.js`. No new npm
  dependencies.
- No `any` at module boundaries. Typecheck, tests and builds: MAINTAINING.md §6.
- Every user-facing string goes through i18n with **both** English and Turkish (game4.md §1). Server text is
  English + a `key` the client translates (see §7).

## 1. Modules and owners

| Path | Owner | Purpose |
|---|---|---|
| `shared/constants.ts`, `types.ts`, `items.ts`, `protocol.ts` | architect | numbers, unions/views, items/recipes/loot, messages + `PROTOCOL_VERSION` |
| `shared/island/types.ts` | architect | IslandDef shape |
| `shared/island/generate.ts` (+ `placement.ts`, `shape.ts`, `coast.ts`, `terrain.ts`, `landmarks.ts`, …, tests), `noise.ts`, `heightfield.ts` | **island** | seed → IslandDef (§5.3); integer-hash noise; heightfield queries (sim, server and client) |
| `shared/sim/{cover,player,projectile,throw}.ts` (+ tests, `testkit.ts`) | **sim** | collision index, stepPlayer, stepProjectile, throw math (§5.1–5.2) |
| `shared/rules/schedule.ts`, `inventory.ts` | architect | day clock; 4-slot inventory helpers |
| `shared/rules/interact.ts` | **server-world** | resolveInteraction (shared by server execution, client prompt, bots) |
| `server/world/**` except the life systems | **server-world** | RaftWorld + WorldContext impl: every in-match rule (§4), the event buffer (`eventBuffer.ts`) |
| `server/world/{monsters,fishing,weather,loot}.ts`, `server/world/life/**` (+ tests) | **server-world-life** | MonsterSystem, FishingSystem (+ loot tables, treasure reels), WeatherSystem + day events, called by RaftWorld through `server/world/context.ts`; their own tuning in `life/tuning.ts` |
| `server/RaftRoom.ts`, `server/index.ts` (register / health), `server/room/{lobby,timings,ping,text,testing,scoring,rng,registry,log,flood}.ts`, `server/RaftRoom.test.ts`, `server/text.test.ts`, `server/room/{lobby,scoring,ops}.test.ts`, `client/src/i18n/strings/server.ts`, `test/room-smoke.test.ts` | **server-room** | lifecycle, lobby, phases, notices, standings; room cap, health, logs, message budgets |
| `server/room/{bots,botBrain,botMotor,botSense,botSteer,botNav,botAim,botNeeds,botTypes}.ts` (+ tests, `botBalance.test.ts`) | **server-bots** | BotDesk, stand-ins + pure bot decisions (§4.6), balance harness |
| `client/src/net/**` | **client-net** | Net facade, Clock, Prediction, Interpolation, MonsterSync, ProjectileSync, reconnect |
| `client/src/render/**`, `client/dev/island.*` | **client-render** | Renderer, FpCamera, island scene, sky/day-night, weather, island harness |
| `client/src/characters/**`, `client/dev/characters.*` | **client-characters** | 6 tourists, monsters, FP arms, nameplates, portraits |
| `client/src/fx/**`, `client/src/audio/**`, `client/dev/{fx,audio}.*` | **client-fx-audio** | item meshes, particles, pop text, arc, markers, bobbers; all sound + music |
| `client/src/ui/**`, `client/src/i18n/strings/*` (except server/feed/banner/prompt), `cover.svg`, `client/dev/ui.*` | **client-ui** | every screen + HUD widget + CSS, translations |
| `client/src/main.ts`, `app/**` (except settings.ts), `input/**`, `i18n/strings/{feed,banner,prompt}.ts` | **client-app** | boot, screens state machine, GameController, view models, Input + key bindings |
| `render/ContextWatch.ts`, `ui/hud/{ReconnectPill,ContextLostCard}.ts` | **client-net-app** | connection and GPU edge cases that span net, render, ui and app (§6.1) |

Allowed cross-module imports on the client (everything else goes through client-app):
`net → shared`, `render → shared, app/settings (types)`, `characters → render/* (Toon, kit), fx/itemMeshes, net/types, shared`,
`fx → render/* (Toon, textures, island/waves), net/types, shared`, `audio → shared, app/settings (types)`,
`ui → app/settings, i18n, audio/Sfx (types), input/bindings (pure key tables: bindingFor / codesFor / keyCap /
keyCapsVersion / onKeyCapsChange), shared`, `app → everything`. Every client module may import `util/*` and
`i18n` (`t`, `itemName`, …).

## 2. Key contract decisions (interpretations of game4.md)

Items marked **drift** depart from game4.md; MAINTAINING.md §3 lists all nine with the code that would change them.

1. **Controls added** (**drift**: game4.md §15 has no eat key): **F = eat / drink** the active item (LMB on a
   coconut charges a throw). **E** also picks up ground items (coconuts, spears, tossed items) and collects flipped
   crabs. Middle click or **V** opens the ping wheel; **M** mutes. Scroll wheel = slot next/prev. Keys are physical
   codes in two presets (`settings.keyPreset`: "standard" WASD, "leftHanded" IJKL with U / H / O and 7–0;
   `client/src/input/bindings.ts`); every key the UI prints follows the preset and the keyboard layout (§7).
2. **Inventory**: 4 slots, one kind per slot, stacks per `ITEMS[kind].stack`. A full inventory drops gathered /
   crafted items on the ground (`dropped: true`) instead of losing them. Berries are eaten on the spot (+15).
3. **LMB**: throwable in hand → hold to charge (0.6 s), release to throw. Otherwise LMB press = "use": palm in
   reach → shake (1 coconut; axe: all), rod → cast at a fish spot (or strike when the bobber dipped), torch →
   swing (scares crabs 1 s), fence / collector / kraken → place in front, empty hand / axe elsewhere → punch
   (`use` event "punch"/"whiffPalm"). **Q** tosses one unit of the active item (any item; a torch is planted
   instead, becoming a `torch` structure with its remaining burn).
4. **Raft**: stage 0 hull needs `hullWood` (the wreck already counts `WRECK_HULL_WOOD` = one free raft part); stage 1
   needs `mastWood` + `mastRope`; stage 2 needs `food` + `water` provision items (`ITEMS[k].provision`); stage 3 =
   ready. **E at the raft delivers everything in your inventory that the current stage still needs** (wood,
   raft parts = 3 wood (Kaptan 4), rope, provisions); surplus stays with you. A delivered unit also counts toward
   a later stage only when that stage is current (no pre-delivery), except the **old sail** treasure (`team.sail`:
   the mast stage completes the moment the hull does). Gnawing removes hull wood (it can drop a completed stage
   back: stage = first incomplete stage). **Drift**: the raft part "+1 rope in the mast stage" of game4.md §7 is
   dropped: rope is delivered directly.
5. **Boarding & launch** (**drift**: game4.md §4 launches only when everyone alive is aboard): at stage 3, E on
   the raft boards (frozen on a raft seat). When every *required* teammate is aboard → launch; required = alive,
   not downed, not washed participants (`server/world/raft.ts` `required()`), so a dropped human counts too and
   their stand-in boards for them when the bots would (§2.15). Otherwise the first boarding starts
   `LAUNCH_WAIT_TICKS` (20 s, `state.launchTicksLeft`); at 0 the raft leaves with whoever is aboard ("Wilson
   finale" for the rest). Downed players can't board — revive them first.
6. **Win / lose**: launch → `launch` phase (8 s cinematic) → matchEnd win (team score = Σ MVP points +
   LAUNCH_BONUS + LAUNCH_BONUS_PER_SEC × seconds left). End of night 3 without a launch → `storm` (12 s;
   **drift**: game4.md says 20 s) → matchEnd lose. Everyone washed on night 3 (no dawn coming) → storm at once.
   Every human participant gone for good → matchEnd "abandoned".
7. **Fire**: fuel burns 1 tick per tick, always (day too) — a wood sink by design; rain drains ×3
   (`RAIN_FIRE_DRAIN_MULT`; **drift**: game4.md §9 "ateş söner" puts it out) unless a duel hut shelters it (none in
   coop). Fuel 0 = out: no warmth, no light ring, no crafting; feeding it relights. Wood or a jellyfish **thrown /
   tossed into the fire** (lands within `FUEL_CATCH_RADIUS`) is burned as fuel.
8. **Treasure** items are instant team effects, not inventory items (**drift**: game4.md §8 hands them out from the
   reel): flare (next night: no monsters), old sail, pirate hat (cosmetic + 20 MVP), spyglass (`team.spyglassTicks`),
   fuel can (+120 s fire). Bottle effects: reveal the secret chest (if unrevealed), else reveal the spring on the
   compass, else unlock the coconut-ball recipe. The secret chest (E) gives 2 treasure reels.
9. **Fishing** (§8): rod active, look at a fish spot within `FISH_CAST_RANGE`, LMB = cast (fishState CAST,
   fishSpot set). Bite after rng 2–6 s → state BITE for `FISH_BITE_TICKS` + lag allowance (≤ RTT/2, ≤ 150 ms):
   LMB press → REEL (FishResultEvent with the reel strip; item delivered FISH_REEL_TICKS later); no click → miss
   "late"; LMB while CAST (before the bite) → miss "early"; walking `FISH_CANCEL_DIST` away / switching slot →
   miss "moved". Loot: `fishLootFor(biome.loot)` with a ±20% per-match jitter from the seed, pity after
   `FISH_PITY` junk catches. A bottle / treasure applies when the reel ends.
10. **Monsters** never enter light rings (lit campfire `fireLightRadius(fuel)` 3–6 m, none below
    `FIRE_REPEL_MIN_FRACTION` of the max fuel; held lit torch / planted torch `TORCH_LIGHT_RADIUS`); the boss walks in
    at `BOSS_LIGHT_SLOW`. Long Tide: crabs going for the raft (or the player guarding it) ignore torch rings — only
    the campfire keeps them off, a torch swing still scares them. Target priority: player within
    `MONSTER_AGGRO_RADIUS` > bait fish (`BAIT_RADIUS`, the boss for `BOSS_BAIT_TICKS`) > (two crabs in five: the
    dark chest, else the camp's light edge) > raft > chest > fence in the way. Players inside a light ring are safe
    from crabs (crabs circle the edge). At dawn they flee to the nearest shore cell and despawn (Captain Crab too:
    he comes back at full hp every night from `bossFromNight` until killed — then `team.bossDown`, the compass and
    `BOSS_DROP_SCRAP` scrap drop; a boss that stops closing on the raft resurfaces at the shore cell nearest it).
    Waves (`nightWave`) spawn over the first 70% of the night from shore cells, weighted to the far side of the
    camp; the push-off adds `planLaunchWave`. Gnawing: a crab at the raft (within 2.5 m of the raft center) removes
    `CRAB_RAFT_GNAW` raft hp every `RAFT_GNAW_TICKS` (boss `BOSS_RAFT_GNAW`, a puffer `PUFFER_RAFT_DAMAGE` and pops)
    unless a player is within `RAFT_GUARD_RADIUS` (then it targets that player). A crab at the dark chest destroys one
    material / food unit every `CHEST_RAID_TICKS` (never the compass; monkeys steal 2 items by day).
11. **Downed / washed**: hp 0 → downed (`DOWNED_TICKS` 25 s crawl; a carried compass goes to the chest); teammate
    holds E `REVIVE_TICKS` → hp `REVIVE_HP`. Timer out → washed (alive=false, inventory lost,
    `PlayerWashedEvent.willRespawn` = not the last night and a teammate alive) → at the next dawn respawn at the
    wreck with `RESPAWN_BARS`, only while a teammate is alive; every participant washed = `teamWiped` on any day.
    Hunger / thirst at 0 deal `EMPTY_BAR_DAMAGE_PER_SEC` each, warmth at 0 `COLD_DAMAGE_PER_SEC`.
    **Heavy cargo** (log, barrel; one at a time): `PlayerState.loadMult` (server, every tick) = CharacterDef
    carryAlone / logCarryAlone, carryEscort with a living teammate within `ESCORT_RADIUS`; the sim walks at
    loadMult % with no sprint and no throw, and DROP sets the cargo down at the feet.
12. **Coop friendly fire**: no damage, knockback × FRIENDLY_KNOCK_MULT, 0.3 s stun. Caught projectiles (RMB
    window, any thrower) go to the inventory (or bounce off when full). A coconut/stone hitting a palm trunk
    drops a coconut.
13. **Character perks** (`CHARACTERS`; **drift** for Kaptan and Şef: game4.md §14 gives Kaptan +10 % faster raft
    delivery and Şef 2× faster cooking): Kaptan raft part +1 wood; Gelin swim ×1.6; Şef cooked food +5 (cooking is
    instant for everyone); Çocuk no warmth loss in water + smaller capsule; Fenomen / Amca cosmetic (selfie emote;
    monkeys go for Fenomen first; the music plays from Amca's radio).
14. **Day events** (one per day at `DAY_EVENT_FRACTION`): gull Şükrü steals a raw fish from a player who has one
    (else from the chest; else skipped), circles `GULL_CIRCLES` times and drops it on the beach (a hit with any
    projectile drops it at once); 1–2 monkeys each steal 1 item from the chest and flee to a tree (a coconut hit
    drops it) — the first one takes it from Fenomen's pockets instead when she is within `MONKEY_FENOMEN_RADIUS` of
    the chest with something (**drift**: game4.md §14 has them steal her selfie stick first); wave gift = a crate
    on the shore (E: 2 random materials + a 25% treasure). **Weather** (from day 2 always, day 1 with
    `DAY1_WEATHER_CHANCE`) starts mid-day and lasts until the next dawn.
15. **Bots** are real seats. Lobby bots: `bot: true`, id `bot-<n>`, named from `BOT_NAMES`, role `BOT_ROLES[i]` of
    their name's index (`server/room/lobby.ts` `botIdentity`), always ready. A lone human starting with no bots
    gets `SOLO_AUTO_BOTS`. A human's seat is driven by the BotDesk in two ways, both playing
    `roleForCharacter(character)` from the one character → role table, `ROLE_BY_CHARACTER` in `server/room/bots.ts`
    (kaptan hamal, fenomen asci, amca bekci, gelin balikci, sef asci, cocuk hamal):
    - **Stand-in** during the `RECONNECT_GRACE_SEC` reconnect window (`BotDesk.add(id, role, { standIn: true })`;
      the seat keeps `bot: false`, `connected: false`, `botRole` ""): it only moves, flees, keeps to the light,
      revives and boards. It never spends, tosses, delivers, crafts or uses the chest with the absent player's
      inventory, sends no emotes / markers, takes no team duty, and hands the seat back (inventory and position
      kept) on reconnection.
    - **Takeover bot** for a human who leaves mid-match for good (consented, or the grace ran out): the seat
      becomes a full bot (`bot: true`, same id, name, seat, inventory, `botRole` from the character) until the
      lobby, where it is removed.
16. **Seeds**: lobby shows the preview island's seed + biome; host can type a seed (0 = random each match).
    WelcomeMsg carries seed, gridHash, defHash; the client regenerates and compares (`island` event `mismatch`).
17. **Spectators**: mid-match joiners spectate until the match ends; washed players watch until their dawn
    respawn. The spectator camera (client only, no InputCmd) circles your team's camp until the mouse steers it
    (a drag on the game surface, or mouse movement under a lock still held: `Input.takeFreeLook()` →
    `FpCamera.steerSpectate`); a click or Space follows the next teammate by seat, RMB the previous one, and past
    the last one it is back over the camp; a followed teammate who is washed or leaves hands over to the nearest
    one (`app/cinematics.ts` `followableMates` / `stepFollow` / `nearestMate`). The HUD shows `hud.spectateHint`.
    Max 6 players incl. bots and spectators; a full room rejects joins (`ROOM_FULL`): bots keep their seats.
18. **State collections** are mutated in place (MapSchema/ArraySchema `clear()/push/set`), never reassigned.

## 3. Data flow

```
                    ┌──────────────── server (Node, 30 Hz) ──────────────────┐
 client input ─────▶│ RaftRoom.onMessage(input) ─▶ RaftWorld.queueInput       │
 (MSG.INPUT 30 Hz)  │ RaftRoom.fixedTick:                                    │
 craft/chest msgs ─▶│   phase / clock work ─▶ BotDesk.tick (bots' InputCmds)  │
                    │   RaftWorld.step({locked, clock}) ─ stepPlayer /       │
                    │     stepProjectile (shared) + rules ─▶ mutates RaftState│
                    │        └─▶ GameEvent[] ─▶ broadcast / phase changes    │
                    └──────────────┬────────────────────────┬────────────────┘
                     state patches │ 20 Hz                  │ event messages
                                   ▼                        ▼
 ┌────────────────────────── client (browser) ──────────────────────────────────┐
 │ Net (colyseus.js) ── NetEventMap ──────────────────────────▶ GameController   │
 │   ├ generateIsland(seed) → IslandDef + CoverIndex              ├▶ Renderer    │
 │   ├ Clock / Prediction (own player) / Interpolation (others,   ├▶ Characters  │
 │   │   monsters) / ProjectileSync (dead-reckoning + predicted)  ├▶ Fx          │
 │ Input ── InputCmd (fixed 30 Hz) ──▶ Net.sendInput              ├▶ AudioEngine │
 │ Ui ◀── models (Home/Lobby/Hud/…) ◀── viewModels ◀──────────────┘  (FpCamera)  │
 │ Ui ── UiEventMap ──▶ App ──▶ Net.send(...) / settings                         │
 └──────────────────────────────────────────────────────────────────────────────┘
```

## 4. Server

### 4.1 Room vs world

| Concern | RaftRoom (server-room) | RaftWorld (server-world) |
|---|---|---|
| Create / join / leave / reconnect, seats, host, spectators, nickname / character / protocol validation | ✔ | `removePlayer` |
| Lobby ready / character / settings / addBot / removeBot / start / rematch | ✔ | `setIsland` (preview), `startMatch` |
| Phases, landing / launch / storm / matchEnd timers, `clockTicks`, `day`, `dayPhase`, `phaseTicksLeft` | ✔ | reads the clock it's given |
| Broadcast `dayPhase`, `stormWarning`, `raftLaunch`, `storm`, `matchEnd`, `matchStart`, `notice`, `welcome`, `ping`, `marker`, `emote`; world events (a `reject` to its actor only) | ✔ | never broadcasts |
| Message budgets, craft / chest action budgets, live-room cap, health, structured logs | ✔ | event buffer cap |
| Input validation & queues (1 per tick, repeat last without edges, cap 4), `lastSeq` | forwards | ✔ (`server/world/inputs.ts`) |
| Movement, gathering, palms, throws, catches, projectiles, hits, eating, crafting, chest, fire, raft, boarding, structures, bars, downed / revive / wash / respawn, fishing + loot, monsters, weather, day events, MVP points + stats | | ✔ (emits events) |
| Standings, titles, MVP, team score at matchEnd | ✔ (`room/scoring.ts`) | provides stats / score |
| Bots (lobby bots, stand-ins, takeover bots) | `BotDesk` ticks before `world.step` | same rules as humans |
| RTT → `player.ping`, `world.setRtt` | ✔ | fishing lag allowance |

### 4.2 Room lifecycle and per-tick order

Lifecycle (`server/RaftRoom.ts` header; helpers in `server/room/`):
- **Create** is refused before a room code or an island exists: join options a join would refuse
  (`checkJoinOptions`: a `protocol` other than `PROTOCOL_VERSION` → `OUTDATED` 4406, absent / null accepted; bad
  nickname / character → `BAD_NICKNAME` / `BAD_CHARACTER`), or no live-room slot (`room/registry.ts`
  `claimRoomSlot`, `RAFT_MAX_ROOMS` per process, default 64 → `SERVER_BUSY` 4405). A create that fails later
  (e.g. the island generator throws) gives its code and slot back; otherwise both are released exactly once, in
  onDispose.
- **Join**: the same option check in onAuth / onJoin; `ROOM_FULL` at `MAX_PLAYERS` players (bots and spectators
  included). Nickname cleaned and made unique, first unused character, lowest free seat kept for the room's
  lifetime, mid-match joiners spectate.
- **Drop / leave**: an unconsented drop keeps the seat for `RECONNECT_GRACE_SEC` (`allowReconnection`); in a match
  a stand-in drives it (§2.15); the return gets a fresh welcome. A consented leave or a grace that ran out → a
  takeover bot in a match, removal in the lobby. The host migrates to the next connected human (never a bot) and
  stays there.
- **Dispose** (`autoDispose = false`; deadlines in room time, the sum of simulation-interval deltas, so the
  manual test clock drives them too): a room nobody ever joined disposes `NEVER_JOINED_DISPOSE_SEC` (10 s) after
  creation; an emptied room `EMPTY_ROOM_DISPOSE_SEC` (60 s) after the last client left, but never while a human is
  inside the reconnect grace (the grace ending re-arms the timer, a return cancels it). The room closes its clients
  with code 4000. A graceful process shutdown (`onBeforeShutdown`) closes them with `CLOSE_CODE.SERVER_RESTART`
  (4002, shared/protocol.ts) instead, which the client shows as `menu.errServerRestart`.
- **Messages**: every client message (inputs and unknown types included) first spends one token of the client's
  `MessageBudget` (`room/flood.ts`: `MESSAGE_RATE` 120/s, `MESSAGE_BURST` 240); over budget it is dropped before
  any validation and logged once per client per second (`flood`). A human's craft and chest messages each spend an
  `ActionBudget` (`ACTION_BURST` 4 back to back, then one per `ACTION_COOLDOWN_TICKS` 5 ticks; bots are not
  throttled); a seat a bot drives ignores its old client's craft / chest / marker / emote / input. Lobby seed
  changes regenerate the preview island at most once per `PREVIEW_COOLDOWN_SEC` (1 s).
- **Test knobs** (`room/testing.ts` `readKnobs`), honored only with `RAFT_TEST=1` and `NODE_ENV` ≠ production:
  CreateOptions `fast` (`FAST_TIMINGS`), `testSeed` (every rng), `warp` (1..8 ticks per real tick, with fast) and
  `manualClock` (no simulation interval: tests call the public `RaftRoom.advance(ms, stall?)` on the instance
  from `matchMaker.getLocalRoomById`). `register()` logs an error once when `RAFT_TEST=1` is set under
  `NODE_ENV=production` (ignored there), a warning when it is set outside a test runner.
- **Ops**: one JSON log line per lifecycle transition plus rate-limited warnings (`room/log.ts`; events in
  MAINTAINING.md §7); the registry slot keeps each room's last completed fixed tick for `server/index.ts`
  `health()` (stalled after `STALL_MS` 5 s; manual-clock rooms never count). Rate limits, tick ages and health run
  on `performance.now()`.

Per tick (every 1/30 s: real time is accumulated and at most `MAX_TICKS_PER_CALL` (4) × warp fixed ticks run per
simulation callback; what is left after a stall is dropped and logged as `simDropped`):

1. `state.tick++`. lobby / matchEnd: only timers (lobby preview regeneration; matchEnd auto-lobby after
   `Timings.matchEndLobby`), then `world.drainEvents()` sent out.
2. landing: `phaseTicksLeft--`; at 0 → `playing` (clockTicks 0, `dayPhase` day 1 broadcast).
3. playing: `clockTicks++`; `clock = clockAt(clockTicks, timings)`; when `day`/`dayPhase` changed → broadcast
   `dayPhase`; `phaseTicksLeft = clock.phaseLeft`; `stormWarning` once when `clock.stormLeft` reaches
   `STORM_WARN_SEC` (clamped to the night) on the last night; `clock.over` → `storm` phase.
4. `bots.tick()` (BotDesk queues one InputCmd per driven seat).
5. `events = world.step({ locked: inputLocked(phase, phaseTicksLeft, timings), clock: playing ? clock : null })`.
6. Send the events: a `reject` only to its actor's client (none for bots and dropped seats), every other
   broadcast event to everyone (`this.broadcast(ev.type, payload)`); internal: `launchRequest` → phase `launch`
   (`phaseTicksLeft = timings.launch`, `winnerTeam`, `winReason "launched"`, broadcast `raftLaunch`); `teamWiped`
   → `storm`.
7. launch / storm `phaseTicksLeft` 0 → `matchEnd` (scoring, broadcast `matchEnd`).
8. Colyseus sends the patch on its own 20 Hz timer (`patchRate = PATCH_INTERVAL_MS`).

Every message handler and fixed tick runs inside try/catch (logged, the room carries on). Pings: every 1 s
`ping {t, tick}` to each client; `pong` → RTT EMA (α 0.25) → `player.ping`, `world.setRtt`. Rngs: gameplay rng
(world) and bot rng (desk) are separate mulberry32 streams seeded per match from (testSeed ?? crypto random) so
bots never shift loot.

### 4.3 RaftWorld.step order

1. **Clock transitions** (compare with the previous clock): playing start / dawn (day > 1): monsters `flee`,
   washed players respawn at the wreck (`playerRespawn`), roll today's weather (day 1: `DAY1_WEATHER_CHANCE`) and
   day event; mid-day (`WEATHER_START_FRACTION`): weather starts (`weather` event; state.weather); event time
   (`DAY_EVENT_FRACTIONS` 0.25 and 0.65): spawn a day event (`dayEvent`, two a day); dusk: nothing (room banner);
   night start: plan the wave (`nightWave(night, seats)` × difficulty × biome × full moon, Captain Crab from
   `bossFromNight` until `bossDown`; skipped with `team.flare`, which is then cleared); weather "clear" at the next
   dawn.
2. **Players**: for each alive player pop one input (inputs.ts rules), `stepPlayer(p, cmd, ctx)` with ctx =
   `{terrain, cover, bounds, character, dt: DT, locked}`; then act on the result:
   `interactPressed` → `resolveInteraction` → execute (tap kinds) or start a channel (`hold`: set `channel`,
   `channelTicks = 0`, `channelTarget`); a greyed-out result rejects (action "deliver" / "board" for the raft,
   else "interact"); a running channel reaching `channelTicksFor(...)` completes one unit
   (gather: +1 item / berry eaten, node amount −1, `gather` event, restart the channel if the node has more;
   revive: `playerRevived`); `used` → use rules (§2.3); `throw` → consume one unit of `slot` (reject silently if
   the slot no longer holds `kind`), spawn projectile(s) at `origin` with `computeThrowVelocities(req)` (coconut
   ball → 3 coconuts), `throw` event with `throwSeq = cmd.seq`, a torch toss plants a torch; `eat` → consume +
   bars (+EAT_HEAL, Şef bonus, golden fish → golden nameplate + MVP), `eat` event; `catchStarted` → open the catch
   window (any live / loose projectile within the catch sphere during `catchTicks` is caught: inventory or
   bounce). Leaving a fish spot / slot change cancels fishing. Separate overlapping players (two bodies on the
   very same point part along x, deterministically).
3. **Projectiles**: `stepProjectile` each; `sank` → remove + `splash`; live projectile vs players (capsule,
   not the thrower for the first 6 ticks) / monsters (sphere) / palm trunk (`hitCover.kind === "palm"`) →
   `hit` (damage, knockback, flips, coconut drop), then loose; puffers explode on any contact (`blast`); fish
   landing (rest) → `baitTicks = BAIT_TICKS`; wood / jellyfish within FUEL_CATCH_RADIUS of a lit fire → fuel.
   Despawn resting items older than GROUND_ITEM_DESPAWN_TICKS and the oldest when over MAX_PROJECTILES.
4. **Monsters** (`monsters.ts`): think every MONSTER_THINK_TICKS (target selection, path), move every tick
   (steer around cover with probes, slide along terrain, avoid light rings, fences block → gnaw), attacks with
   cooldown (`monsterAttack`, `playerHurt`, knockback), flipped / stunned / lured / emerge timers, monkeys /
   gull behaviors, dawn flee + despawn (`monsterDie` fled). Cap MONSTER_CAP alive (queue the rest of the wave).
5. **Structures**: planted torch / kraken life (expire → `structureDestroyed`), kraken flings monsters,
   collectors fill in rain.
6. **Survival** (bars as floats in a side map, written rounded to the schema): hunger / thirst drain per minute
   × difficulty × timings.barMult (sprint, heat wave / shade), warmth (night & biome nightChill, rain unless
   sheltered (cave), in water unless Çocuk; near a lit fire +5/s; held lit torch slows the loss), empty bars → hp
   damage, near fire heal, drowning, jellyfish active item, puffer fuse (explodes in hand → `blast inHand`),
   torch burn (`torchTicks`), fire fuel (×0.5 by day, rain ×2) + `fireFuel` "out" event, `lowBar` events once per dip,
   spyglass countdown.
7. **Downed / wash**: `downedTicks` countdown → `playerWashed`; all washed (any night) → `teamWiped`.
8. **Boarding**: `launchTicksLeft` countdown; launch condition → `launchRequest`.

**Events** go through `server/world/eventBuffer.ts` until the room drains them, because craft / chest messages and
removals between two ticks add to the same buffer. Identical rejects (same tick, playerId, action, reason,
interact kind) coalesce into the first one. At most `EVENT_BUFFER_CAP` (512) events wait between two drains: at the
cap a newcomer evicts the oldest event of the most-buffered (type, actor) while that one holds at least two more
events than the newcomer's own, else the newcomer is dropped, so one actor's flood drops its own repeats and gives
way to everyone else's events; `launchRequest` / `teamWiped` are never dropped; the first overflow warns once
(`RaftWorld.eventStats()` counts `{ dropped, coalesced }`). State lives in the schema, so a dropped event never
desyncs a client. Per-player bookkeeping goes with the player: `removePlayer` forgets their input queue, fishing
line / pity / RTT and treasure reels; a match reset drops data of ids no longer in `state.players`.

### 4.4 Interactions (server execution of `resolveInteraction`)

Tap kinds on `INTERACT_PRESS`: `pickup` (projectile → inventory, `pickup` event source "ground"; doesn't fit →
`reject full`), `collectCrab` (flipped crab → crab_raw, `monsterDie collected`), `board`, `deliver`, `spring`
(water item, or drink +SPRING_WATER when full), `collector` (drink +COLLECTOR_WATER, uses−1), `secretChest`.
`craft` / `chest` are client panels: the server ignores INTERACT_PRESS on them (crafting arrives as CraftMsg /
ChestMsg, validated by range with +0.5 m slack and fire lit for crafting). Hold kinds: `gather`, `revive`.

### 4.5 Crafting & chest

`craft(id, recipe)`: within CRAFT_RANGE of the team fire, fire lit (fuel > 0) except for `fuel` itself, not
locked (`coconut_ball` needs `team.ballRecipe`), not duelOnly. Ingredients come from the inventory first, then
the chest. Output: `addItem`, overflow dropped at the feet (`dropped`). `fuel`: +FIRE_WOOD_FUEL_TICKS (cap).
`cook_kraken`: every teammate +KRAKEN_TEAM_FOOD hunger. Stats `crafted++`. Rejects → `reject` event, action
"craft" (`missing`, `fireOut`, `tooFar`, `locked`, `full` = the fire is already full, `dead`).

`chest(id, msg)` within CHEST_RANGE (+0.5 m): `put` from the active slot, or from ChestMsg `slot` (0..3) when given
— then a given `kind` must be what that pocket holds (else reject `empty`); `take` (`kind`, `count`); `putAll`
(every material / food / water stack). `chestChanged` events; rejects (action "chest") `tooFar`, `empty`, `full`,
`dead`. `room/lobby.ts` `readChest` treats a non-integer or out-of-range `slot` as malformed (ignored) and drops a
`slot` on take / putAll. A human's craft and chest messages pass the room's ActionBudget first (§4.2).

### 4.6 Bots (server-bots)

`BotDesk` per §12: think delay BOT_THINK_MIN..MAX_SEC (sooner when something happens: a finished goal, damage, a
puffer in the pocket, a monster closing in, dusk), roles (Long Tide §7): **hamal** (axe + hammer: fells trees for
logs, salvages the wreck, crafts the plan's benches / planks / nails / sailcloth / barrels, repairs the raft),
**balikci** (rod: fishes, cooks, keeps the fire when there is no Aşçı), **bekci** (spear + axe: ammo, logs; the
first raft guard at night), **asci** (rod: water + food runs, feeds the fire, cooks, tosses food to teammates with
low bars). Every role: eat / drink when low, go to the fire at dusk / night, revive downed teammates (not into a
pack or next to Captain Crab), keep away from Captain Crab, assemble the stage whose materials are in, walk beside
a teammate carrying a log / barrel, flee monsters when low hp, board only during the push-off a human started (a
bot-only team, or the storm < 90 s away, starts it itself). Pure functions in `botBrain.ts`: `chooseGoal(view) →
Goal` (puffer in the pocket → flee (Captain Crab at any hp) → revive → board → attack / self-care (self-care first
when starving) → pass food → evening (fire, torches) → deliver → assemble → repair → craft → housekeeping → escort →
nearby pickups → work (gather / fell / salvage / fish / water / ammo by the team plan × role affinity, by day) →
crabs / pickups → camp or night post: the guard and a second guard at the raft with a lit torch once the keel
exists — the motor swings it at close crabs, throws at scared ones, picks up flipped ones and kites the boss around
the raft), `steer(world, pos, target, memory) → {moveX, moveZ, yaw, jump}` (1.5 m forward probe, ±30/60/90/135°
sweep, 10-tick hysteresis, stuck detector → jump + random dir; fallback BFS on a 2 m walkability grid),
`aimAt(origin, target, kind, noiseDeg, rng) → {yaw, pitch, charge}` (solveBallistic + personality noise). The
economy (`botNeeds.ts` `teamPlan`): a bill of materials over RECIPES — the current stage's missing rows, the next
stage's rows (chest prestock while the day lock holds), role tools, fuel, a larder and repair planks, matched
against everyone's pockets + the chest → crafts (with the bench tiers they need) and raw wants; the day locks pace
the raft. Bots craft through `host.craft` / `host.chest` (same validation). Desk clock = Σ ticks, never Date.now.

**Stand-ins** (`add(id, role, { standIn: true })`) are enforced on three levels: the goal comes from
`chooseStandInGoal` filtered by `STAND_IN_GOALS` (idle, crawl, flee, revive, board, warm, camp, wait, follow); the
motor's craft / chest calls are refused; every InputCmd is masked by `standInButtons` (JUMP / SPRINT, E only where
`standInE` says it revives or boards from the pose the command leads to; the desk's own slot press drops a held
jellyfish or cancels a charge). `add()` on a driven seat with another role or `standIn` re-plans it from scratch
(a stand-in becoming the leaver's takeover bot).

## 5. Shared sim & island

### 5.1 stepPlayer (sim)

Order and fields: see `shared/sim/player.ts` header. Rules:
- Walk speed WALK_SPEED / SPRINT_SPEED (SPRINT held, moving, on land, not charging, not downed), multipliers
  stack (charge 0.6, starving 0.7, freezing 0.6, downed 0.25, swim 0.5 × character swimMult; stun / channel /
  boarded = 0). Accel GROUND_ACCEL / decel GROUND_DECEL / AIR_CONTROL / WATER_ACCEL.
- Jump only when grounded (or within COYOTE_TICKS) and not swimming; JUMP_VELOCITY ≈ 1.1 m apex.
- Horizontal integration in sub-steps ≤ 0.25 m: for each sub-step compute the new ground height; if it rises more
  than STEP_MAX above the current feet while grounded, or the slope there has normal.y < MAX_WALK_NORMAL_Y and
  rises, reject the step and slide along the contour (project the move onto the perpendicular of the gradient;
  retry once). Then push out of cover circles (capsule radius from the character vs circle r, only when the
  capsule overlaps [bottom, top]). Clamp to ctx.bounds.
- Vertical: gravity, MAX_FALL_SPEED; ground = heightAt; landing sets `landed` / `landSpeed`.
- Water: swimming = feet below WATER_Y − SWIM_DEPTH; over deep water the swimmer floats at WATER_Y −
  SWIM_FLOAT_DEPTH (buoyancy SWIM_BUOYANCY, damping SWIM_DAMPING), can't sprint / jump (a jump near the shore
  climbs out); `swimTicks` counts up while swimming.
- Downed: crawl (DOWNED_MOVE_MULT), no actions except look; boarded: no movement at all (the server places it).
- Edge actions only when `canAct` and not channeling (except INTERACT_PRESS which is reported while canAct).
- Must be deterministic and allocation-free on replay. Tests (`player.test.ts`): jump apex, cliff blocks a
  2 m step, walks up a 0.3 m step, slides along a cliff, swim float depth, sprint speed, channel freeze,
  replay twice `toEqual`, throw release at charge 1 / tap, toss, slot edges.

### 5.2 stepProjectile & throws (sim)

See `projectile.ts` / `throw.ts` headers. Tests: parabola = `ballisticPoint` for the first ticks, slope
reflection, water → sank, spear sticks, coconut bounces twice then rolls to rest, cover hit reported (palm),
no tunneling at 34 m/s through a 0.3 m trunk, `sampleTrajectory` end ≈ actual first contact, `solveBallistic`
+ `stepProjectile` within 1 m at 10 / 20 / 30 m.

### 5.3 Island generator (island) — game4.md §9

- Grid: SOLO_GRID (160 m; the island is ~95–100 m across) / DUEL_GRID (256 × 176 m), CELL_SIZE 1 m, centered on the origin (duel island centers ±(R + strait/2)).
- Shape: elliptical mask (random axes 0.85–1.15 × ISLAND_RADIUS, random rotation via a *rational* rotation
  (pick (c, s) from a Pythagorean-triple table, never cos/sin)), coastline perturbed by low-frequency fbm2 of
  the position, a low rolling lowland (plateau + low-frequency swells / dips, a few soft knolls, one or two
  small flat-topped tors, one broad gentle main rise; fbm2 / ridged2 detail by biome `rugged`), peak
  PEAK_MIN..MAX (4–7 m, per-biome range in shape.ts BIOME_STYLES, volcanic highest), a wide beach band around
  the coast (0–0.6 m sand), shallow shelf (walkable, −0.6..0), deep water beyond, sea floor SEA_FLOOR_Y at the edges.
  Ensure: the camp/wreck/raft beach area is gentle (flatten a radius around them), no unwalkable pits, at least
  one gentle path from the beach to the spring.
- Landmarks per site with **corridor guarantees** (CORRIDOR_WIDTH clear of nodes between wreck↔camp↔raft and the
  raft↔shore): wreck on the beach; campfire CAMP_FROM_WRECK_MIN..MAX inland, dry and flat; chest CHEST_FROM_FIRE
  from the fire; raft on the flattest beach cell at the waterline facing open water (yaw toward the sea); spring
  inland (usually up the hill); cave (shelter, may be null) at a slope / rock cluster; secret chest somewhere
  remote; 6 spawns around the wreck; ≥ 24 shore cells (water 0.3–1.5 m deep, spread around the coast);
  FISH_SPOTS_MIN..MAX (+ biome extra) fish spots in water 1–3 m deep near the coast, ≥ 8 m apart, some near
  rocks.
- Nodes: `BASE_NODE_COUNTS × BIOMES[b].counts`; trees inland on grass, palms on/near the beach, rocks anywhere
  (more on slopes), bushes in clusters; min spacing (trees 1.6 m), keep-out radius around landmarks and the
  corridors; bushes: ropeShare / berryShare yields; amounts NODE_AMOUNT (decorative bushes 0). Archetype
  `variant` 0..3 and cosmetic yaw / scale may use any rng values (but stay deterministic too — they feed defHash
  only through positions).
- Biome from the seed (`biomeForSeed`), counts / fog / colors from BIOMES.
- Performance: < 40 ms solo, < 80 ms duel (it runs on the server at every match start and lobby seed change, and
  on every client).
- Tests (`generate.test.ts`): same seed → same gridHash / defHash; 50 seeds: wreck / camp / spawns / raft on dry
  land (raft at the waterline), spring dry, node counts within ±10% of the target, corridors clear, shore cells ≥
  24 and in water, fish spots in water, duel: the strait between islands is water and 26–30 m wide; generation
  time budget.

## 6. Client

### 6.1 Per-frame order (GameController.frame(now, realDt))

1. Fixed-step input: if `!net.wantsInput` (not connected, not predicting, or not a simulated phase) → reset the
   accumulator. Else `acc += min(realDt, 0.25)`; while `acc >= DT`: `cmd = input.sample(++seq)`;
   `net.sendInput(cmd)`; `acc -= DT`. `alpha = acc / DT`. `seq` is one counter for the page lifetime.
2. `net.update(now, realDt)`. No state yet (reconnecting with nothing decoded) → render the last picture, stop.
3. `local = net.getLocalPlayer(alpha, input.look)`, `remotes = net.getRemotePlayers(now)`, `projectiles =
   net.getProjectiles()`, `monsters = net.getMonsters(now)`; camera plan (`CameraDirector.plan`, with the
   spectator free look drained from `input.takeFreeLook()` and the remotes it can follow).
4. Interaction: `resolveInteraction({island, state}, localView)` (localView = state's player with the predicted
   position / yaw) → HUD prompt; E press on `craft` / `chest` opens the panel (pointer unlocked) instead of
   sending (the INTERACT bits are still sent; the server ignores them for panels).
5. `renderer.update(dt, elapsed, worldFrame)`; `characters.sync([...remotes, local], {localId, firstPerson: true,
   dark}, dt)`; `characters.monsters.sync(monsters, dt)`; `characters.fpArms.update(dt, camera, armsFrame)`.
6. `fx.syncProjectiles(projectiles, dt)`; arc preview when charge ≥ ARC_PREVIEW_MIN_CHARGE and
   settings.showArcPreview (`sampleTrajectory` from the predicted player's throwOrigin / computeThrowVelocity);
   bobbers from players with fishState ≠ 0 (bobber position from the last `fishCast` event per player);
   `fx.update(dt)`.
7. `renderer.fp.update(realDt, cameraFrame)` (eye from the local frame, look from Input; `CameraDirector.shoot`).
   It runs right after the world update in step 5, before the characters / arms / fx, so the first-person rig, the
   throw hand-off and the fishing line read the pose that is rendered this frame.
8. Audio: listener at the eye; loops (charge, fire near camp, rain, waves by distance to the shore, swim,
   puffer fuse, channel); `setAmbience`; `setRadio(Amca's position)`; `audio.update(dt)`.
9. `renderer.render()`; `ui.updateHud(hudModel)`; open panels' models; Tab scoreboard rows.

Screens: `home → connecting → lobby → game → matchEnd → lobby`; the lobby shows the preview island orbit (the
island is loaded on `island` events); `?room=CODE` / `/r/CODE` deep links; reconnect ticket on reload (dropped at
boot when the address bar invites to another room: `app/session.ts` `rejoinTicketAtBoot` / `dropStaleTicket`). On a
device without a fine pointer Home shows a keyboard + mouse card first (`ui/screens/homeState.ts`); Home keeps the
typed nickname and code across a language reload.

Edges:
- **Reconnect**: an unexpected close (any code but 4000 / 4002, `net/errors.ts isFinalClose`) → Net status `reconnecting`, retrying the ticket with
  backoff for up to `RECONNECT_GRACE_SEC`. Meanwhile the world is frozen: the server-tick estimate, the match clock
  and the interpolation render tick hold where the drop found them (never past the newest patch), projectiles
  aren't dead-reckoned, every frame reports speed 0, nothing is sent. `Ui.setReconnecting(attempt)` shows the
  persistent "Reconnecting… (attempt n)" pill (`ui/hud/ReconnectPill.ts`); `GameController.wantsPointer` is false
  while Net isn't `connected`, so the pointer lock is released and the "click to play" veil asks for it again on
  return (`feed.connBack` toast). A (re)join completes only once its WelcomeMsg arrived; a welcome from another
  `PROTOCOL_VERSION` ends it `outdated` (Home offers a reload). A reload whose ticket was refused toasts
  `feed.seatExpired`.
- **WebGL context loss**: `render/ContextWatch.ts` flags `Renderer.contextLost` (render() / prewarm() are no-ops)
  and calls `onContextChange`; `Ui.setGraphicsLost(true)` shows `ui/hud/ContextLostCard.ts` with a Reload button
  (the reconnect ticket rejoins the room) and the pointer is released. It hides only after a restore whose rebuild
  worked.
- **Loading splash**: `client/index.html` paints `#rr-splash` before the bundle arrives (text in en / tr from the
  saved settings or the browser language); `app/splash.ts` `dismissSplash()` removes it from `App.start()` (and
  `main.ts` on a boot failure, which shows the fatal card). A second inline script turns it into "couldn't load"
  (script / modulepreload error) or "taking longer than usual" (still up after `SPLASH_STALL_MS`, 30 s) with a
  Reload button. `?debug=1` in a dev bundle exposes the App as `window.__raft` (MAINTAINING.md §5).

### 6.2 Event → feedback (client-app wires these in GameController)

"me" = local id. Events already predicted for me (`throw` of mine) skip the duplicate SFX (`localThrow` played it).

| Event | Characters / arms | Fx | Audio | UI | Camera |
|---|---|---|---|---|---|
| `matchStart` | clear | clear | music day, `dayStart` | banner day 1 + "storm in 7:45" | wake-up (landing lock) |
| `dayPhase` day/dusk/night | — | — | music mood; `dayStart` / `duskDrums` / `nightStart` | banner (day n / night is coming / night) | — |
| `weather`, `dayEvent`; lightning (`Renderer.onLightning`) | — | — | thunder after a distance delay / rain loop, gull / monkey | banner + feed; thunder caption | shake on thunder |
| `stormWarning` / `storm` | — | — | `stormWarn` / storm loop | banner | shake |
| `throw` / `localThrow` | trigger throw / toss; arms play | (ProjectileSync) | `throw` / `throwHeavy` / `toss` | — | recoil (me) |
| `hit` | trigger hit (player) / monsters hurt | hitStars / bonk, popText dmg | `bonk` / `hit` / `bootBonk` | — | shake if me |
| `splash`, `stick`, `palmShake`, `gather` | gather anim | splash / woodChips / leaves / berries; itemPop | `splash` / `stick` / `palmShake` / `chop*` / `mine*` / `rustle` | feed (only notable: depleted? no) | — |
| `pickup`, `catch`, `eat`, `crafted`, `fireFuel` | arms eat / catch | sparkle / embers | `pickup` / `catch` / `eat` / `drink` / `craft` / `fireFeed` | feed for notable (craft, fire out) | punch on catch |
| `deliver`, `raftReady`, `raftDamage`, `board`, `raftLaunch` | trigger board | sparkle / woodChips | `deliver` / `raftStage` / `raftReady` / `raftGnaw` / `board` / `launch` | banners (RAFT READY! / boarding countdown), feed | launch cinematic |
| `monsterSpawn/Hurt/Flip/Die/Attack`, `steal` | monsters triggers | splash / crabBits / flip | crab SFX, `bossRoar` (duck music) | feed for boss / steals; spawn caption (not under the night banner) | shake on boss |
| `playerHurt/Downed/Revived/Washed/Respawn`, `lowBar` | triggers | hitStars / hearts | `hurt` / `downed` / `revive` / `washed` / voices | feed ("X is starving"), downed / washed screens | shake if me |
| `blast` | inflate (holder) | blast | `blast` | feed; caption when no feed line | shake |
| `fishCast/Bite/Result/Miss`, `treasure`, `bottle` | arms cast / reel | bobber dip, gold | `cast` / `bite` / `reel*` / `catchFish` / `golden` / `treasure` | fishing bar, reel (me; small for others), feed | punch on golden |
| `structurePlaced/Hit/Destroyed` | — | dust / woodChips | `place` / `fenceBreak` | caption when a monster gnaws a fence | — |
| `marker`, `emote` | trigger emote | marker balloon | `marker` / `emote` + voice | compass ping 8 s | — |
| `notice`, `reject` (mine only: the server sends a reject to its actor) | — | — | `uiError` (reject) | toast / short hint | — |
| `matchEnd` | cheer | confetti (win) | `win` / `lose`, music | matchEnd screen | orbit |

**First-person viewmodel** (`characters/fpArms.ts` + `fpHand.ts` / `fpHolds.ts` / `fpMotion.ts`). The local
tourist's arms are a camera-attached overlay (depth cleared, fixed 75° framing via a depth scale of the root) with
skinned hands (one bone per phalanx; poses solved by FK on the geometry, incl. `gripPose(R)` / `cupPose(Rs)`).
Every item kind has a first-person hold (`FP_HOLDS`: anchor on the hand, pose, orientation, rest spot; checked by
`fpHolds.readability.test.ts`) and a smooth close-up mesh (`buildItemMesh(kind, {closeUp: true})`). The rig infers
everything from `FpArmsFrame` plus the gestures above: the item swap (holster → change → equip, reload after a
throw, consumed, catch, land after a reel, pocket), the clip variant per item (`fpMotion` `CLIPS`: e.g. use = jab /
chop / bonk / fish slap / torch swing; eat = bite / drink / gulp / "nope" for inedible or empty hands, since the
sim raises `eat` on every F press), charge wind-ups, hold-E loops locked to the channel (`channelItem` /
`channelSec`), fishing states, idle fidgets and item secondary motion. Optional frame fields `bobPhase`
(`FpCamera.walkPhase`), `yaw` / `pitch` (predicted look, so the sway ignores shake and recoil). The local
projectile's visual starts at `fpArms.handPosition` and blends into the simulated path over 80 ms (render only).

Sound captions (`ui.caption`, `ui/hud/Subtitle.ts` above the feed, game screen only) cover cues that are only
heard: crabs / puffers crawling ashore, a monster gnawing a fence, a blast nobody got a feed line for, thunder
(`GameController.onLightning` → `GameFeedback.thunder`). Keys `hud.cap_<CAPTION_KEYS>` (`app/feedback.ts`), with
`{dir}` = "" or " · " + `hud.dir_<ahead|right|behind|left>` relative to the view; each is rate-limited, and the
positional ones only within 30 m of the camera.

## 7. i18n key conventions

`t("section.key")`. Sections and owners: see `client/src/i18n/index.ts`. Conventions:
- `items.<ItemKind>`, `items.recipe_<RecipeId>`, `items.loot_<FishLoot>`, `items.treasure_<TreasureId>`,
  `items.bottle_<BottleEffect>`, `items.biome_<Biome>`, `items.weather_<Weather>`, `items.difficulty_<id>`,
  `items.berry` (client-ui).
- `characters.<CharacterId>` (name), `characters.<id>_perk`, `characters.<id>_tagline`, `characters.role_<BotRole>`.
- `overlays.title_<TitleId>` (+ `_desc`), settings / scoreboard / legend / match-end labels (client-ui); settings
  `overlays.hudScale`, `keyPreset_<KeyPreset>` (+ `keyPresetHint_*`), `mouseLock`, `quality_auto`, `tipsReset`.
- `reject.<reason>`: `full`, `fireOut`, `missing`, `tooFar`, `locked`, `wrongStage`, `nothingToDeliver`,
  `notReady`, `empty`, `noRoom`, `noSpot`, `busy`, `dead` (client-ui; server-world uses exactly these reasons).
- `prompt.<kind>[_<item>]`: e.g. `prompt.gather_wood`, `prompt.gather_stone`, `prompt.gather_rope`,
  `prompt.gather_berry`, `prompt.pickup` ({item}), `prompt.revive` ({name}), `prompt.collectCrab`, `prompt.board`,
  `prompt.deliver`, `prompt.craft`, `prompt.chest`, `prompt.spring`, `prompt.collector`, `prompt.secretChest`,
  `prompt.palm` (LMB), `prompt.cast` (LMB), `prompt.strike` (LMB!) (client-app).
- `feed.*` and `banner.*`: whatever the event → feedback table needs (client-app), params already translated.
- `hud.cap_<key>` + `hud.dir_<bearing>` (sound captions, §6.2), `hud.reconnecting` / `reconnectingHint`,
  `hud.gpuLostTitle` / `gpuLostText` / `gpuLostReload`, `hud.spectateHint`; `menu.reload`, `menu.device*` (the
  keyboard + mouse card).
- `server.*`: exactly the keys of `server/room/text.ts NOTICE_EN` (server-room, test-enforced).
- `menu.err<Kind>` for NetError messages (client-ui writes them; client-net uses the keys
  `menu.errRoomFull`, `menu.errNotFound`, `menu.errBadNickname`, `menu.errBadCharacter`, `menu.errServerDown`,
  `menu.errServerBusy`, `menu.errServerRestart`, `menu.errOutdated`, `menu.errKicked`, `menu.errUnknown`; `net/errors.ts`).
- **Key placeholders**: a string that names a key never spells the letter; it says `{kMove}`, `{kSprint}`,
  `{kJump}`, `{kInteract}`, `{kEat}`, `{kToss}`, `{kSlots}`, `{kPing}`, `{kEmote}`, `{kLegend}`, `{kStats}`,
  `{kMute}`, `{kPingKeys}` or `{kEmoteKeys}`, filled by `ui/controls.ts` `keyParams()` from the active preset and
  the keyboard layout (AZERTY prints ZQSD). HUD / menu / overlay / coach / panel strings are rendered with
  `t(key, keyParams())` at the call; `feed.*` and `banner.*` lines are filled by `ui/hud/Feed.ts` / `Banner.ts`
  with `withKeys(params)` (the caller's params win), so any caller may name a key there. Turkish says
  "{kInteract} tuşuna" so no suffix depends on the letter. `ui/keyStrings.test.ts` checks every `t()` / `tr()`
  call that can print such a string passes the keys (run-time keys are listed in its `PLAIN_RENDERERS`);
  `ui/controls.test.ts` checks every placeholder is one `keyParams()` fills, in both languages.

## 8. Testing

Commands, the room-test caveats (manual clock, wall-clock flakes) and the balance harness: MAINTAINING.md §4, §6.
What each suite covers:
- island `shared/island` (`generate.test.ts`, `parts.test.ts`); sim `shared/sim` (`player`, `projectile`,
  `throw`, `cover`, `island.sim`).
- world `server/world`: `World.test.ts` (match start, gathering, palms, throws / catches, eating, crafting & chest,
  raft, downed / revive / wash, bars, structures, treasures), `interact`, `inputs`, `fishing`, `loot`, `monsters`,
  `weather`; `eventBuffer.test.ts` (reject coalescing, the cap, every reject's actor and action);
  `bookkeeping.test.ts` (per-player data goes with the player, light rings reused, separation scratch).
- room: `server/RaftRoom.test.ts` (in-process Colyseus, colyseus.js clients, `RAFT_TEST` stubbed, `manualClock` for
  bot matches and timers: create / join validation, lobby settings, ready gating, welcome seed + hashes, inputs,
  emote / marker limits, garbage payloads, solo + `SOLO_AUTO_BOTS` to matchEnd, rematch, reconnect with a stand-in,
  leaver → takeover bot, room full, outdated / busy creates refused before a code exists, never-joined and
  empty-room disposal, rejects to their actor only, the action budget, floods, "abandoned", the log lines);
  `server/text.test.ts` (every notice key in `client/src/i18n/strings/server.ts`); `server/room/{lobby,scoring,
  ops}.test.ts` (ops: registry cap + health, log lines + throttle, message / action budgets);
  `test/room-smoke.test.ts` (through `register()`: a warped real-time bot match, `health()`).
- bots `server/room`: `botBrain`, `botMotor`, `bots.test.ts`, `botStandIn.test.ts` (a stand-in through a night at
  normal timings leaves inventory and chest untouched and causes no spending event); `botBalance.test.ts` is the
  balance harness (skipped by default).
- client `client/src/`: net (`Net.test.ts`: join flow, protocol version, prediction, clocks, reconnection + freeze;
  `Clock`, `Prediction`, `Interpolation`, `MonsterSync`, `ProjectileSync`, `LocalHandoff`, `islandCache`,
  `reconnectToken`, `errors`), render (`FpCamera`, `ContextWatch`, `FrameGovernor`, `LightPool`, `island/*`,
  `sky/DayNight`, `kit/Baker`), app (`GameController`, `cinematics` (spectator follow), `captions`, `coach`,
  `quality`, `settings`, `session`, `splash`, `strings`, `viewModels`, `frameHelpers`, `guard`), input (`Input`,
  `InputAccess`, `bindings`), ui (`controls`, `keyStrings`, `dom`, `hud/Subtitle`, `panels/ChestPanel`,
  `screens/homeState`), audio / fx / characters tables.
- hub: `server/games.test.ts` (manifest helpers, `/healthz` aggregation and its public report).
- Everyone: the typecheck and the client build (MAINTAINING.md §6).
