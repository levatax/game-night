# Bonk Brawl: architecture & module contracts

Read with `game1.md` (WHAT) and `docs/TECH_BRIEF.md` (HOW, binding). This file is the contract
between the 10 builder roles. The stub files are the source of truth for signatures; their JSDoc
is the spec. §11 reproduces every exported signature (generated from the stubs).

## 0. Rules

- **Frozen contracts** (nobody edits after the architect): `shared/constants.ts`, `shared/maps.ts`,
  `shared/protocol.ts`, `shared/types.ts`, `server/schema.ts`. Also treat as frozen (architect-written,
  complete): `shared/sim/math.ts`, `shared/sim/context.ts`, `shared/sim/actions.ts`, `server/hub.ts`,
  `server/index.ts`, `server/world/events.ts`, `client/index.html`, `client/src/util/*`,
  `client/src/app/settings.ts`, `client/src/net/types.ts`, `client/src/characters/types.ts`,
  `client/src/fx/types.ts`, `client/src/ui/models.ts`, `client/src/audio/Sfx.ts`,
  `client/src/render/Toon.ts`. Their owner may fix a bug in them but must not change a signature.
- Need a contract change? Work around it locally and append a line to `docs/CONTRACT_CHANGES.md`.
- Keep every exported signature in the stubs exactly. Add private helpers, new exports and new
  files inside your own folder only. No `any` at module boundaries. `npm run typecheck` and
  `npm run build` must pass.
- Placeholder bodies are marked `TODO(<owner>)`. Stubs never throw at runtime except
  `Renderer.loadArena` and `getFaceSheet` (only reachable once client-app runs the game).
- Imports: `.js` extensions in `shared/` and `server/`; the client omits extensions (Vite).
  `shared/` has no DOM, no Node APIs, no decorators. Only `server/` imports `@colyseus/*`; only
  `client/src/net/` imports `colyseus.js`.

## 1. Modules and owners

| Path | Owner | Purpose |
|---|---|---|
| `shared/constants.ts` | architect (frozen) | Ticks, every balance number, timings, camera, colors, CHARACTERS, POWERUPS, EMOTES, scoring, limits |
| `shared/maps.ts` | architect (frozen) | 3 arenas: rings, cover, pedestals, spawns, friction, theme, decor; `getArena`, `shapeDistance` |
| `shared/protocol.ts` | architect (frozen) | `MSG` names, `BTN` bits, every client→server and server→client payload, `JOIN_ERROR` |
| `shared/types.ts` | architect (frozen) | Unions + `*View` interfaces mirroring the schema, `PlayerSimFields`, `BallSimFields`, `MapView` |
| `server/schema.ts` | architect (frozen) | `@colyseus/schema` v3 classes (compile-time checked against the views) |
| `shared/sim/math.ts`, `context.ts`, `actions.ts` | sim (architect-written) | vec3 helpers, sim contexts, `derivePlayerAction` |
| `shared/sim/geometry.ts` | **sim** | rings/floor/cover queries, sphere-capsule, raycast |
| `shared/sim/player.ts` | **sim** | `stepPlayer` (movement, jump, roll, abilities' movement, charge/throw release, catch window/whiff) |
| `shared/sim/ball.ts` | **sim** | `stepBall` (gravity, bounces, live→dead→neutral, curve, boomerang) |
| `shared/sim/throw.ts` | **sim** | aim, throw origin, release velocities (triple spread), knockback mult, trajectory sampling |
| `shared/sim/*.test.ts` | **sim** | vitest unit tests (determinism, numbers from §16) |
| `server/index.ts`, `server/hub.ts` | architect (complete) | `register(ctx)` defines `bonk_brawl`; hub context + room codes |
| `server/BonkRoom.ts`, `server/room/**` | **server-room** | lifecycle, lobby, phases, scheduling, scoring, crown, ping, broadcasts |
| `server/world/World.ts`, `server/world/**` | **server-world** | per-tick authoritative rules → `GameEvent[]` |
| `server/world/events.ts` | architect (complete) | `GameEvent` union |
| `test/**` (headless bot tests, optional) | **server-room** | bots via `colyseus.js` + `fast: true` with `BONK_TEST=1` |
| `client/index.html` | architect (complete) | Fredoka, `#game`, `#ui`, inline favicon |
| `client/src/main.ts`, `app/**`, `input/**` | **client-app** | boot, screen state machine, GameController, Input |
| `client/src/app/settings.ts` | client-app (architect-written) | typed settings + localStorage |
| `client/src/net/**` | **client-net** | Net facade, Clock, Prediction, Interpolation, BallSync |
| `client/src/render/**` | **client-render** | Renderer, Sky, textures, Arena, CameraRig, MenuScene (Toon.ts written) |
| `client/src/characters/**` | **client-characters** | 6 animals, faces, Animator, nameplates, crown, ghost, preview, menu crowd |
| `client/src/fx/**` | **client-fx** | balls, particles, pop text, power-ups, feel, arc preview, blob shadows, indicator data |
| `client/src/audio/**` | **client-audio** | AudioEngine, synthesized SFX + voices, Music |
| `client/src/ui/**` | **client-ui** | every HTML/CSS screen, HUD, overlays, one `ui.css` |
| `client/src/util/**` | architect (complete) | `Emitter`, color helpers |

Allowed cross-module imports on the client (everything else goes through client-app):
`net → shared`, `render → shared, app/settings (types)`, `characters → render/Toon, render/MenuScene (type), net/types, shared`,
`fx → render/Toon, render/textures, net/types, ui/models (types), shared`, `audio → shared`,
`ui → app/settings (types), shared`, `app → everything`. Every client module may import `util/*`.

## 2. Key contract decisions (interpretations of game1.md)

1. **Ball states**: `neutral | held | live | dead` (game1's 3 states + `held`). Held balls stay in
   `state.balls` with `holderId`; the server pins them to the hand, the client renders them at the
   animal's hand anchor.
2. **Own ball** never hits its thrower (`OWNER_IMMUNE`); a returning boomerang is auto-caught by
   its owner (no points).
3. **Triple Shot**: the throw releases the held ball + 2 new `bonus` balls (±15°); bonus balls are
   removed when they come to rest and never count toward the arena ball target. While a Triple
   Shot is held the player may carry 2 balls.
4. **Catch**: catcher +2, thrower −1 heart (KO credited to the catcher, `ko` cause `caught`).
   Caught ball goes to the catcher's hand, or drops neutral if hands are full (`kept: false`).
   A whiff happens only when the 0.25 s window expires without a catch. One catch per press (the
   window closes on success); sibling balls of the caught throw (same `ownerId + throwSeq`) that
   touch the catcher within the next 8 ticks bounce off harmlessly (`deflect`), so a Triple Shot
   catch never costs more than 1 heart and the catcher isn't punished right after a perfect catch.
5. **Eliminations**: exactly one of `ringOut` (fell; credit to the last hitter/knocker within 3 s,
   +2) or `ko` (hearts 0 or disconnect) per eliminated player. Headbutts and shockwaves count as
   "knocks" for ring-out credit.
6. **Lag-compensated catches use delayed hits** (≤ 5 ticks, only for players with RTT): see §7.4.
7. **Movement abilities are predicted** (they live in `stepPlayer`); their effects on others
   (shockwave, headbutt hit, belly-bounce deflect, curve steering) are server-only.
8. **Cover never falls** (footprints inside ring 0). Pedestals sit in ring 1, so late sudden death
   stops power-up spawns once ring 1 drops. Ring 0 never falls.
9. **Random map** is re-rolled each round (never the same twice in a row).
10. **Rematch**: any player may send `rematch` at matchEnd (after 3 s): the room returns to the
    lobby (everyone un-readied, characters kept); the sender is readied if `{ ready: true }`
    ("Rematch") or not ("Back to lobby"). The room also auto-returns after 45 s.
11. **Mid-match joiners** take a free slot as `spectator: true` (ghost camera) until the lobby.
12. **Round-end slow-mo** is server-side (`world.step({ dtScale: 0.3, locked: true, combat: false })`
    for 1 s); hit-stop and catch slow-mo are client-cosmetic (`Feel`).
13. **Emotes**: Q cycles honk → wave → dance; server rate-limits to 1/s.
14. **Caught / picked-up balls become plain held balls** (kind `normal`, radius 0.25, flags reset).
    A caught bonus ball therefore stays in play as a normal ball; the room only respawns while
    `countBalls() < target`, so a temporary surplus is harmless.
15. **Stats `throws` counts balls** (a Triple Shot adds 3), so accuracy = hits / throws ≤ 100%.
16. **Input seq** is one strictly increasing counter per page (GameController never resets it);
    the server forgets the last seen seq on join/reconnect (`world.clearInputs(id)` also sets
    `lastSeq = 0`), so a reloaded page may restart at 1. Not reset per round.
17. **Too few players**: a round that would start with fewer than 2 participants ends the match
    instead (matchEnd with current standings). A consented leave of an alive player mid-round is a
    `ko` with cause `disconnect`, exactly like an expired reconnect window.
18. **State collections are mutated in place** (`MapSchema.clear()`, `ArraySchema.clear()/push`),
    never reassigned, so decoded client references (`state.rings` in FloorQuery objects) stay valid.
    Verified: in-place clear/push round-trips through `Reflection` decoding with the same instances.
19. **Eliminated bodies freeze** on the server (not stepped while `!alive`). The client anchors the
    ghost with the `ko` / `ringOut` character triggers (`opts.pos` = KO position / last grounded
    position), so ring-out ghosts float over the island, not under it.

## 3. Data flow

```
                     ┌──────────────── server (Node, 30 Hz) ────────────────┐
 client input ──────▶│ BonkRoom.handleInput ──▶ GameWorld.queueInput         │
 (MSG.INPUT 30 Hz)   │ BonkRoom.onTick:                                      │
                     │   schedule (balls, power-ups, rings, phases)          │
                     │   GameWorld.step() ── stepPlayer/stepBall (shared) ──▶│ mutates BonkState
                     │        └─▶ GameEvent[] ─▶ BonkRoom.applyEvents        │
                     │                 scoring/stats/crown ─▶ broadcast(type)│
                     └───────────────┬─────────────────────┬─────────────────┘
                       state patches │ 20 Hz               │ event messages
                                     ▼                     ▼
 ┌─────────────────────────── client (browser) ───────────────────────────────┐
 │ Net (colyseus.js) ── emits NetEventMap ──────────────────▶ GameController   │
 │   ├ Clock          (server tick estimate)                      │            │
 │   ├ Prediction     (own player: stepPlayer + replay)           ├▶ Characters│
 │   ├ Interpolation  (remote players, 100 ms behind)             ├▶ Fx        │
 │   └ BallSync       (stepBall dead-reckoning + predicted throws)├▶ AudioEngine│
 │ Input ── InputCmd (fixed 30 Hz) ──▶ Net.sendInput              ├▶ CameraRig │
 │ Ui ◀── models (HudModel, LobbyModel, …) ◀── App/GameController ┘  Renderer  │
 │ Ui ── UiEventMap ──▶ App ──▶ Net.send* / settings                           │
 └─────────────────────────────────────────────────────────────────────────────┘
```

## 4. Server

### 4.1 Room vs world

| Concern | BonkRoom (server-room) | GameWorld (server-world) |
|---|---|---|
| Join/leave/reconnect, slots, host, spectators, nickname/character validation | ✔ | `removePlayer`, `eliminate(id, "disconnect")` when told |
| Lobby ready / character / settings / start / rematch / emote | ✔ | |
| Phases, timers, round & match flow, map choice | ✔ | `setArena`, `resetForRound` when told |
| Input validation & queues (1 per tick, repeat, cap 4), `lastSeq` | forwards | ✔ |
| Movement, jump, roll, abilities, charge/throw (via shared sim) | | ✔ |
| Pickups (balls, power-ups), power-up effects | | ✔ |
| Hits, knockback, stun, hearts, catches + lag comp, deflects, i-frames | | ✔ |
| Shockwave, headbutt, curve steering, boomerang return | | ✔ |
| Ring-outs + last-hitter credit, KO, ghosts | | ✔ (emits `ringOut`/`ko`) |
| WHEN to spawn balls / power-ups, WHICH type/pedestal, ring shake/drop schedule | ✔ | executes `spawnBall`, `spawnPowerUpWarning`, `activatePowerUp`, `shakeRing`, `dropRing` |
| Points, roundPoints, stats, crown, round winner, standings, places | ✔ | |
| Ping/RTT → `player.ping`, rewind ticks | ✔ computes | `setRewindTicks` |
| Broadcasting | ✔ (`broadcast(ev.type, ev)` + its own round-flow messages) | never |

### 4.2 Per-tick order (every 1/30 s)

`setSimulationInterval` is a plain `setInterval` (Node truncates 33.33 ms to 33 ms ≈ 30.3 Hz), so
`onTick(deltaMs)` accumulates real time and runs one fixed tick per `TICK_MS` due (≤ 4 per call).
Each fixed tick:

1. `state.tick++`; phase timer `phaseTicksLeft--`.
2. Phase work: countdown numbers (`countdown` n=3,2,1 each second, n=0 → `playing`);
   playing: due ball respawns, power-up timer (first 15 s, then every 20 s; skip if one exists or
   power-ups are off; random type from `POWERUP_TYPES`, random pedestal on a non-fallen ring →
   `spawnPowerUpWarning`, `activatePowerUp` 2 s later); `phaseTicksLeft == 0` → `suddenDeath`
   (broadcast, extra ball). suddenDeath: same + ring schedule (shake outermost solid ring at once
   and every 5 s, drop it 0.8 s after its shake).
3. `world.step(opts)`:
   countdown `{dtScale 1, locked true, combat false}`; playing/suddenDeath `{1, false, true}`;
   roundEnd first second `{0.3, true, false}`; lobby/matchEnd/round-end card: no step (use
   `world.drainEvents()` instead, so out-of-step events such as disconnect KOs still go out).
4. `applyEvents(events)`: scoring (`POINTS`), stats (`throws += ballIds.length`), respawn
   scheduling on `ballLost`, broadcast each broadcast event, crown update.
5. Round decided? (playing/suddenDeath and ≤ 1 participant alive): winner +3 (`roundWins++`),
   `roundWinnerId`, broadcast `roundWin` (with `finalVictimId/finalPos` = last eliminated),
   phase `roundEnd` (`ROUND_END_SLOWMO_TICKS + ROUND_END_CARD_TICKS`). Then next round's
   countdown (`roundStart` broadcast) or `matchEnd` (places by points → round wins → catches →
   lower slot; `matchWinnerId`; broadcast `matchEnd`). If fewer than `MIN_PLAYERS_TO_START`
   participants (non-spectators still in the room, including ones in the reconnect window) remain
   for the next round, go to `matchEnd` instead.
6. Colyseus sends the state patch on its own 20 Hz timer (`patchRate = 50`).

Returning to the lobby (rematch, or `MATCH_END_LOBBY_TICKS` timeout): phase `lobby`, round 0,
`world.resetForRound([])` (clears balls, power-ups and rings in place; everyone `alive = false`),
`ready = spectator = false`, `place = 0`, schedules cleared; points/stats kept until the next start.

Join / reconnect: `world.clearInputs(id)` (forgets the last seq, `lastSeq = 0`). Leaving (consented,
or reconnect window expired): if alive mid-round → `world.eliminate(id, "disconnect")` first.
Empty room: `this.disconnect()` after `EMPTY_ROOM_DISPOSE_SEC` (autoDispose is off).

Pings: every 1 s, `ping { t: Date.now(), tick }` to each client; `pong` → RTT EMA (α 0.25) →
`player.ping` (ms) and `world.setRewindTicks(id, rewindTicksForRtt(rtt))`.

### 4.3 GameWorld.step order

Documented on `GameWorld.step` (inputs → stepPlayer + results → headbutt → separation → held
balls → pickups → stepBall + history → catches/hits (+ pending hits) → eliminations).

## 5. Client per-frame order

`App` runs one `requestAnimationFrame` loop. Home/lobby: `MenuScene.update` → `renderer.render`.
In game (`GameController.frame(now, realDt)`):

1. `dt = fx.feel.update(realDt)` — cosmetic dt (hit-stop 0, slow-mo scaled).
2. Fixed-step input: if `!net.wantsInput` → `acc = 0` (no input backlog burst later). Else
   `acc += min(realDt, 0.25)`; `while (acc >= DT)`: `cmd = input.sample(++seq)`,
   `net.sendInput(cmd)` (predicts; fires `localThrow`/`localStep`); `acc -= DT`. `alpha = acc / DT`.
   `seq` is one counter for the page lifetime, never reset (§2.16).
3. `net.update(now, realDt)`.
4. `local = net.getLocalPlayer(alpha, {yaw, pitch} from input)`, `remotes = net.getRemotePlayers(now)`,
   `balls = net.getBalls()`.
5. `renderer.arena.syncRings(state.rings)`.
6. `characters.sync([local, ...remotes], {crownId, localId, hideLocal}, dt)`; landing detection
   (grounded false→true per id) → `trigger("land")`, dust, `land` SFX.
7. `fx.balls.sync(balls, dt, {handOf, colorOf})`; charge telegraph for EVERY alive player frame
   (remote `chargeTicks` is synced): `fx.balls.setChargeGlow(id, chargeFraction(frame))` plus a
   positional `charge` loop per charging player;
   `fx.powerUps.sync([...state.powerUps.values()], dt, elapsed)`, `fx.shadows.update(players+balls)`,
   `fx.arc.update(local fullCharge && settings.showArcPreview ? sampleTrajectory(...) : null, color)`,
   bounce squash/SFX for `ball.bounced`, zoomies speed lines + `zoomies` loop, Pip `slide` loop.
   FloorQuery objects given to fx/camera read the current `state.rings` (live getter, or re-set on
   map change and after a reconnect, which creates a new decoded state).
8. `fx.update(dt)`.
9. `camera.update(realDt, follow | ghost | orbit)` (follow uses the local frame + input look,
   `charge` for FOV zoom).
10. `audio.setListener(camera pos, forward)`, `audio.setTimeScale(fx.feel.timeScale)`.
11. `renderer.update(dt, elapsed)`, `renderer.render()`.
12. `ui.updateHud(hudModel)`, `ui.setIndicators(computeOffscreenIndicators(...))`, scoreboard rows
    while Tab is held.

Screen state machine: see `App` JSDoc (`home → connecting → lobby → game → matchEnd → lobby`).

## 6. View models

`ui/models.ts` defines `HomeModel`, `LobbyModel`, `HudModel`, `ScoreRow`, `KillFeedEntry`,
`OffscreenIndicator`, `RoundEndModel`, `MatchEndModel`, `UiEventMap`. client-app builds them
(suggested file `app/viewModels.ts`): HUD values come from `net.localSim` (predicted timers,
charge, heldCount, powerUp, zoomies) + `net.me` (hearts) + `state` (phase, round, timer =
`phaseTicksLeft / TICK_RATE`, crown, scoreboard). Kill feed entries are composed from events
(`hit` → bonk, `catch` → catch, `ringOut` → ringOut/fell, `ko` → ko/dropped).

## 7. Netcode algorithms

### 7.1 Input
Client sends one `InputCmd` per sim tick while `net.wantsInput` (alive participant in
countdown/playing/suddenDeath). `seq` is strictly increasing for the page lifetime (never reset;
§2.16). THROW is level-triggered (held now OR pressed since the previous sample, so a sub-tick
click is still a 1-tick quick throw), the other buttons edge-triggered (latched by Input until the
next sample). Server: queue per player, consume 1 per tick (repeat last without edges when empty;
cap 4 dropping oldest but carrying edge bits forward), `lastSeq` = consumed seq; seqs ≤ the last
seen one are dropped; `clearInputs(id)` on join/reconnect forgets the last seen seq.

### 7.2 Prediction + reconciliation (own player)
`Prediction.predict(cmd, ctx)`: store cmd, `prev = current`, `stepPlayer(current, cmd, ctx)`;
the returned result is the only one used for feedback. On each patch: `reconcile(me, ctx)`:
copy server sim fields (`copyPlayerSim`), drop `seq <= lastSeq`, replay the rest, error = old −
new position; > 2 m snap, else add to a visual offset decaying with τ = 100 ms. Render =
lerp(prev, current, alpha) + offset; yaw/pitch from Input. ctx = `{arena, rings, character,
dt: DT, locked: phase ∉ {playing, suddenDeath}}`. Pickups, hits, knockback and catches are not
predicted; they arrive via reconciliation (knockback appears ~RTT/2 late, acceptable).
Prediction resets when the local player becomes alive at round start / reconnect. When not
predicting (round-end slow-mo, ghost, spectator, matchEnd) `getLocalPlayer` returns the local
player interpolated exactly like a remote one (never raw 20 Hz state).

### 7.3 Remote players
`Interpolation` keeps snapshots keyed by `state.tick` (for every player, local included), renders
at `clock.serverTickAt(now) − (clock.rttMs/2 + INTERP_DELAY_MS)/TICK_MS` (serverTickAt is the
server's present and the newest snapshot is ~RTT/2 old, so this keeps ~100 ms ≈ 2 patches of
buffer); lerp positions, lerpAngle yaw/pitch, discrete fields from the older snapshot, ≤ 100 ms
extrapolation.

### 7.4 Lag-compensated catches (server-world)
- Ball history: ring buffer of the last `BALL_HISTORY_TICKS` (10) positions/states per ball.
- `r` = player's rewind ticks = `rewindTicksForRtt(rtt)` (≤ 5).
- A catch press consumed at tick T opens a window `[S, S + 8)` with `S = T − r`.
  At T, test each live (non-own) ball's history at ticks S..T; afterwards test current
  positions while inside the window. Catch when the ball center is within `CATCH_RANGE` (+ ball
  radius) of `chest + forward·0.5` and in front (`dot(ball − chest, forward) > 0`).
- Hits on a player with `r > 0` become **pending** for r ticks (the ball turns dead and bounces
  away immediately so visuals stay prompt); a catch window with `S ≤ hitTick` converts the
  pending hit into a catch; otherwise it applies at `hitTick + r`. `r == 0` → immediate.
- The catcher's `catchTicks` is cleared on success (no whiff). Clients only predict the pose.
- At most one ball per press (closest to the catch center); siblings of the caught throw deflect.

### 7.5 Balls
`BallSync` simulates every ball locally with `stepBall` in fixed DT substeps. On each patch it
fast-forwards the server ball from `patchTick` to the clock's current server tick (≤ 6 steps) and
blends the difference out over 100 ms (snap > 3 m). Own throws spawn predicted balls at once
(`computeThrowVelocities` from the predicted player; index 0 gets the throw's kind, 1/2 are
`bonus`); the server ball with the same `(ownerId, throwSeq, throwIndex)` takes over with a
blended offset; unmatched predicted balls fade after 600 ms. Curveball/boomerang dead-reckoning —
both the per-frame substeps AND the patch fast-forward (`onServerState(..., owners)`) — uses an
`OwnerResolver` (aim, chest, hand of the RENDERED owner); without it a returning boomerang would
turn dead locally. A new live ball thrown by a remote player starts with its visual offset at the
thrower's rendered hand and catches up over 200 ms (remote players are drawn ~RTT/2 + 100 ms in
the past, balls at the server's present). `getFrames` hides own held balls beyond the predicted
`heldCount`.

### 7.6 Clock
`Clock.sample(tick, now, rtt)` from every `ping` and every patch (`state.tick`), slewed,
monotonic; `serverTickAt(now)` used by Interpolation and BallSync.

## 8. Event → feedback table (client-app wires these in GameController)

"me" = local sessionId. Events whose actor is me and that were already predicted (`throw`,
`ability`) are skipped for me — `localThrow`/`localStep` played them instantly.

| Event | Characters | Fx | Audio | UI | Camera |
|---|---|---|---|---|---|
| `roundStart` | clear ghosts | `fx.clear()`, `setArena` if map changed | music `fight` | banner "ROUND n" | follow; `input.setLook(spawn yaw)` |
| `countdown` n>0 / n=0 | — / — | — / popText `bonk` above me | `countdownTick` / `countdownGo` | HUD countdown n / "BONK!" | — |
| `suddenDeath` | — | — | `suddenDeath`, music `suddenDeath`, tempo ramps 1→1.35 over 25 s | banner "SUDDEN DEATH!" (danger) | shake 0.15 |
| `localThrow` / `throw` | `trigger(owner,"throw")` | (ball visuals from BallSync) | stop that player's `charge` loop; `throw` / `throwHeavy` (charge≥full or mega) at origin, 30% `voice(char,"throw")` | — | — |
| `localStep` | — | `rollStarted` → puff; `abilityStarted` → as `ability` | `jumped` → `jump`; `rollStarted` → `roll`; `abilityStarted` → ability SFX | — | — |
| `pickup` | `trigger("pickup")` | — | `pickup` (+`squeak`) at pos | — | — |
| `hit` | `trigger(target,"hit",{dir})` | stars burst, popText `bonk`; hitStop 60 ms if me is thrower or target | `bonk` at pos, `voice(target,"hit")`; `ding` if me = thrower | kill feed `bonk`; HUD heart pop if me | shake 0.35 (mega 0.6) if me = target |
| `catch` | `trigger(catcher,"catch")` | popText `catch`, sparkles; slowMo 0.3×150 ms if me = catcher | `catch`, `crowdOoh`, `voice(catcher,"catch")` | kill feed `catch` | — |
| `whiff` | `trigger("whiff")` | popText `miss` (small) | `whiff` | — | — |
| `deflect` | Mochi bouncing: `trigger(id,"ability")`; otherwise — | popText `boing` (+ bubbles for Mochi) | `bellyBoing` (Mochi) / `bounce` (others) | — | — |
| `ringOut` | `trigger(victim,"ringOut",{pos})` (keeps tumbling down, then ghost above `pos`) | popText `out` at pos | `slideWhistle` at pos, `voice(victim,"ko")` | kill feed `ringOut`/`fell`; spectating banner if me | `enterGhost(pos + up)` if me (after 0.8 s) |
| `ko` | `trigger(id,"ko",{pos})` (pop, floating hat, ghost) | puff + feathers/fur in animal color, popText `out` | `ko`, `voice(id,"ko")` | kill feed `ko`/`dropped`; spectating banner if me | `enterGhost` if me |
| `emote` | `trigger(id,"emote",{emote})` | — | `honk` for honk, else `voice(char,"emote")` | — | — |
| `ability` | `trigger(id,"ability")` | flapDash feathers + speed lines; bellyBounce bubbles; curveball sparkles; bellySlide dust trail | `flapDash` / `groundPoundLeap` / `voice` / `curveArm` / `bellySlide` / `roll`(pitch 0.8) | HUD ability (state-driven) | — |
| `shockwave` | `trigger(id,"slam")`, affected `trigger("hit")` | `shockwave` ring (radius) + dust | `shockwave` | — | shake 0.5 if within 6 m |
| `headbutt` | `trigger(target,"hit")` | stars | `headbutt` | — | shake 0.5 if me = target |
| `ballSpawn` | — | — | `ballDrop` at pos | — | — |
| `boomerangReturn` | — | — | `boomerang` (caught → `pickup`) | — | — |
| `powerUpWarning` | — | (shimmer is state-driven) | `powerUpWarning` | — | — |
| `powerUpSpawn` | — | sparkles | `powerUpSparkle` | — | — |
| `powerUpPickup` | — | sparkles | `powerUpPickup` (+`zoomies`) | toast "<icon> <name>!" if me | — |
| `ringShake` | — | (arena shake is state-driven) | `ringShake` | — | shake 0.1 |
| `ringDrop` | — | crumbs via `arena.onRingFall` | `crumbleRumble` | — | shake 0.25 |
| `roundWin` | `trigger(winner,"victory")` | confetti at winner | jingle `roundWin` (or `roundLose` if me lost) | after the slow-mo: `showRoundEnd` | `koCut(finalPos, 1)` |
| `matchEnd` | winner `victory` | confetti | jingle `matchWin`, music `lobby` | `setMatchEnd`, screen `matchEnd` | orbit |
| `notice` | — | — | — | toast | — |
| `phase` → lobby | `characters.clear()` | `fx.clear()` | music `lobby` | screen `lobby` | — |
| `disconnected` | clear | clear | music `lobby` | home + error toast | — |

## 9. Feature checklist (game1.md → modules)

| § | Feature | Modules |
|---|---|---|
| 3 | Arcs, leading targets, no auto-aim | sim `computeThrowVelocity`/`stepBall`; world throws |
| 3 | Charge telegraph: glowing ball + sound, slow while charging | sim `CHARGE_MOVE_MULT`; fx `setChargeGlow`; audio loop `charge`; CameraRig FOV; HUD charge meter |
| 3 | Catch timing 0.25 s / whiff 0.6 s | sim catch window/whiff; world lag-comp catch; characters `catch`/`whiff` |
| 3 | Cover & positioning | maps cover; sim geometry; render Arena |
| 3 | Silly: knockback tumble, squeaks, BONK!, victory dance over the loser's floating hat | world knockback; characters tumble/`victory`/KO hat prop; audio; fx PopText |
| 4 | Lobby → countdown 3-2-1 → spawn corners → balls drop center (players−1, min 2) | room phases + `ballsForPlayers`; world `resetForRound`/`spawnBall`; maps spawns; ui Lobby/HUD |
| 4 | Fight 60 s, power-ups | room timers + power-up schedule; world pickups |
| 4 | Sudden death: rings crumble every 5 s, extra ball | room ring schedule; world `shakeRing`/`dropRing`; render Arena; fx crumbs; audio |
| 4 | Round end slow-mo 3 s card; 5 rounds; podium; rematch | room; world dtScale; ui RoundEnd/MatchEnd; characters victory |
| 5 | 3 hearts, −1 + knockback, KO → ghost + free cam, ring-out instant | world; characters ghost; CameraRig ghost; Input `ghostMove` |
| 5 | Ball states neutral/live/dead (+held), auto pickup, can't hit own thrower, hold 1 (2 w/ triple) | sim `stepBall`; world pickups/hits; fx Balls |
| 5 | Points hit +1 / catch +2 / ring-out +2 (3 s credit) / win +3; tiebreaks; crown | room `applyEvents`/standings/`crownId`; world credit; characters crown; ui scoreboard |
| 6 | WASD, mouse, LMB hold/tap, RMB, Space, Shift, E, Q, Tab, Esc | Input; sim; ui Scoreboard/SettingsMenu; room emote |
| 7 | 6 characters, identical stats, abilities + cooldowns | constants `CHARACTERS`; sim abilities; world effects; characters models/anims; audio voices |
| 8 | Power-ups: one at a time, 3 pedestals, 15 s/20 s, 2 s warning | room schedule; world `spawnPowerUpWarning`/`activatePowerUp`; fx PowerUps |
| 8 | Mega / Triple / Boomerang / Zoomies | sim throw + `stepBall`; world; fx Balls/speed lines; HUD badge |
| 9 | 3 arenas, ~30 m, void, 2–4 cover, 4 spawns, themes, Bath slippery, Cake crumbs, ring shake 0.8 s + wobbly fall | maps; sim friction; render Arena/Sky/textures; fx crumbs |
| 10 | Low-poly toon, squash & stretch, outlines, palette, procedural textures, faces 8 expressions, sun + hemi + blob shadows, optional bloom/FXAA, full animation list | render Toon/Renderer/textures; characters Animal/faces/Animator; fx Shadows/Balls |
| 11 | Camera offsets, cover collision, FOV 70→62 charging, crosshair, arc preview at full charge, hit-stop/shake/BONK!/stars/bonk+ding, catch slow-mo + CATCH! + ooh, knockback arc + dust, final KO slow-mo + cut | CameraRig; sim `raycastWorld`/`sampleTrajectory`; fx Feel/PopText/Particles/ArcPreview; audio; ui Hud |
| 12 | Music lobby/fight + SD tempo ramp + jingles; all SFX; voices; spatial; 3 volume sliders | audio AudioEngine/Music/Sfx; settings; ui SettingsMenu |
| 13 | Home (logo, nickname, create/join, idle arena backdrop) | ui Home; render MenuScene; characters MenuCrowd |
| 13 | Lobby (code, copy link /r/ABCD, 4 cards, carousel + 3D turntable + ability text, host settings, Start) | ui Lobby; characters CharacterPreview; room |
| 13 | HUD (timer + round dots, mini scoreboard + crown, hearts + ability radial, charge meter + held/power-up, kill feed, off-screen indicators) | ui Hud/KillFeed; fx Indicators; app view models |
| 13 | Round-end card, match-end podium + stats, settings menu, Fredoka | ui RoundEnd/MatchEnd/SettingsMenu; index.html |
| 14 | Authoritative server, inputs only 30 Hz, tick 30 / patch 20 | BonkRoom; Net; Input |
| 14 | Prediction + reconciliation, interpolation 100 ms, predicted throws, server hits, lag-comp catches | Prediction; Interpolation; BallSync; world |
| 14 | 4-letter codes, `/r/ABCD`, max 4 + "Room full", late joiners spectate, host migration, 20 s reconnect, dispose 60 s | hub/`getRoomCodes`; room; Net error mapping + reconnect; App deep link |
| 16 | Balance numbers | constants |

## 10. Testing

- sim: `npx vitest run games/bonk-brawl/shared/sim` — determinism (same inputs → identical state
  after 300 ticks), jump apex ≈ 1.2 m, roll distance ≈ 4 m, throw speeds 16/34, live→dead on first
  bounce, dead→neutral at rest, ring floor holes, cover push-out, curve/boomerang.
- server: optional bot tests under `games/bonk-brawl/test/` using `colyseus.js` against
  `npm start` with `BONK_TEST=1` and create option `fast: true`.
- Everyone: `npm run typecheck` and `npm run build` from the repo root.

## 11. Exact public APIs (generated from the stubs)

Data-only contract files (`shared/constants.ts`, `shared/maps.ts`, `shared/protocol.ts`,
`shared/types.ts`, `server/schema.ts`) are not repeated here: read them directly.

#### `shared/sim/math.ts`

```ts
export type Vec3 = Vec3Like;
export function vec3(x = 0, y = 0, z = 0): Vec3;
export function clone(a: Vec3): Vec3;
export function set(out: Vec3, x: number, y: number, z: number): Vec3;
export function copy(out: Vec3, a: Vec3): Vec3;
export function add(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3;
export function sub(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3;
export function scale(a: Vec3, s: number, out: Vec3 = vec3()): Vec3;
export function addScaled(a: Vec3, b: Vec3, s: number, out: Vec3 = vec3()): Vec3;
export function dot(a: Vec3, b: Vec3): number;
export function cross(a: Vec3, b: Vec3, out: Vec3 = vec3()): Vec3;
export function lengthSq(a: Vec3): number;
export function length(a: Vec3): number;
export function length2D(a: Vec3): number;
export function distSq(a: Vec3, b: Vec3): number;
export function dist(a: Vec3, b: Vec3): number;
export function dist2D(a: Vec3, b: Vec3): number;
export function normalize(a: Vec3, out: Vec3 = vec3()): Vec3;
export function lerpVec(a: Vec3, b: Vec3, t: number, out: Vec3 = vec3()): Vec3;
export function clampLength(a: Vec3, max: number, out: Vec3 = vec3()): Vec3;
export function clamp(v: number, min: number, max: number): number;
export function lerp(a: number, b: number, t: number): number;
export function approach(current: number, target: number, maxDelta: number): number;
export const TAU = Math.PI * 2;
export function wrapAngle(a: number): number;
export function angleDelta(a: number, b: number): number;
export function lerpAngle(a: number, b: number, t: number): number;
export function smoothFactor(dt: number, tau: number): number;
export function forwardFromYaw(yaw: number, out: Vec3 = vec3()): Vec3;
export function rightFromYaw(yaw: number, out: Vec3 = vec3()): Vec3;
export function dirFromYawPitch(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3;
export function yawFromDir(dx: number, dz: number): number;
export function pitchFromDir(d: Vec3): number;
export function rotateY(a: Vec3, angle: number, out: Vec3 = vec3()): Vec3;
```

#### `shared/sim/context.ts`

```ts
export interface FloorQuery …
export interface SimContext extends FloorQuery …
export interface BallContext extends FloorQuery …
```

#### `shared/sim/geometry.ts`

```ts
export interface Contact …
export function ringIndexAt(arena: ArenaDef, x: number, z: number): number;
export function isFloorAt(q: FloorQuery, x: number, z: number): boolean;
export function coverTopAt(arena: ArenaDef, x: number, z: number, radius: number): number;
export function groundHeightAt(q: FloorQuery, x: number, z: number, radius: number, feetY: number): number;
export function resolveCoverCollision(arena: ArenaDef, pos: Vec3, radius: number, height: number, vel?: Vec3): boolean;
export function sphereCoverContact(arena: ArenaDef, center: Vec3, radius: number): Contact | null;
export function sphereCapsuleOverlap(center: Vec3, sphereRadius: number, capFeet: Vec3, capRadius: number, capHeight: number): boolean;
export function raycastWorld(q: FloorQuery, origin: Vec3, dir: Vec3, maxDist: number): number;
export function pointInCover(c: CoverDef, x: number, z: number, radius: number): boolean;
```

#### `shared/sim/player.ts`

```ts
export type PlayerSim = PlayerSimFields;
export const PLAYER_SIM_KEYS …
export function createPlayerSim(): PlayerSim;
export function copyPlayerSim<T extends PlayerSimFields>(src: PlayerSimFields, dst: T): T;
export interface ThrowRequest …
export interface StepPlayerResult …
export function emptyStepResult(): StepPlayerResult;
export function stepPlayer(p: PlayerSim, input: InputCmd, ctx: SimContext): StepPlayerResult;
export function playerHeight(p: PlayerSim, character: CharacterId): number;
export function hasRollIFrames(p: PlayerSim): boolean;
export function isInvulnerable(p: PlayerSim): boolean;
export function isBouncy(p: PlayerSim, character: CharacterId): boolean;
export function chargeFraction(p: PlayerSim): number;
```

#### `shared/sim/ball.ts`

```ts
export type BallSim = BallSimFields;
export const BALL_SIM_KEYS …
export function createBallSim(): BallSim;
export function copyBallSim<T extends BallSimFields>(src: BallSimFields, dst: T): T;
export interface StepBallResult …
export function emptyBallResult(): StepBallResult;
export function stepBall(b: BallSim, ctx: BallContext): StepBallResult;
```

#### `shared/sim/throw.ts`

```ts
export function aimDirection(yaw: number, pitch: number, out: Vec3 = vec3()): Vec3;
export function chestPosition(p: { x: number; y: number; z: number }, out: Vec3 = vec3()): Vec3;
export function throwOrigin(p: { x: number; y: number; z: number; yaw: number }, out: Vec3 = vec3()): Vec3;
export function throwSpeed(charge: number): number;
export function ballKindForPowerUp(powerUp: HeldPowerUp): BallKind;
export function computeThrowVelocity(charge: number, aim: Vec3, powerUp: HeldPowerUp, out: Vec3 = vec3()): Vec3;
export function computeThrowVelocities(charge: number, yaw: number, pitch: number, powerUp: HeldPowerUp): Vec3[];
export function knockbackMultiplier(charge: number, kind: BallKind): number;
export interface TrajectoryOptions …
export function sampleTrajectory(q: FloorQuery, origin: Vec3, velocity: Vec3, opts: TrajectoryOptions): Vec3[];
```

#### `shared/sim/actions.ts`

```ts
export const RUN_SPEED_THRESHOLD = 0.6;
export function derivePlayerAction(p: PlayerSimFields, character: CharacterId): PlayerAction;
```

#### `server/hub.ts`

```ts
export const GAME_ID = "bonk-brawl";
export function setHub(ctx: HubContext): void;
export function getHub(): HubContext | null;
export function getRoomCodes(): RoomCodeRegistry;
```

#### `server/index.ts`

```ts
export function register(ctx: HubContext): void;
```

#### `server/world/events.ts`

```ts
export type BroadcastWorldEvent = { [K in WorldEventType]: { type: K } & ServerMessages[K] }[WorldEventType];
export interface BallLostEvent …
export type InternalWorldEvent = BallLostEvent;
export type GameEvent = BroadcastWorldEvent | InternalWorldEvent;
export type GameEventType = GameEvent["type"];
export type GameEventOf<T extends GameEventType> = Extract<GameEvent, { type: T }>;
export function isBroadcastEvent(ev: GameEvent): ev is BroadcastWorldEvent;
```

#### `server/world/World.ts`

```ts
export interface WorldOptions …
export interface WorldStepOptions …
export class GameWorld {
  readonly state: BonkState;
  arena: ArenaDef;
  constructor(state: BonkState, arena: ArenaDef, opts: WorldOptions = {});
  queueInput(sessionId: string, cmd: InputCmd): void;
  clearInputs(sessionId?: string): void;
  setRewindTicks(sessionId: string, ticks: number): void;
  setArena(arena: ArenaDef): void;
  resetForRound(participants: readonly string[]): void;
  eliminate(sessionId: string, cause: "disconnect"): void;
  removePlayer(sessionId: string): void;
  spawnBall(dropIndex: number): string;
  countBalls(): number;
  spawnPowerUpWarning(pedestal: number, type: PowerUpType): string;
  activatePowerUp(id: string): void;
  clearPowerUps(): void ;
  shakeRing(index: number): void;
  dropRing(index: number): void;
  outermostSolidRing(): number;
  step(opts: WorldStepOptions): GameEvent[];
  drainEvents(): GameEvent[];
  alivePlayers(): string[];
}
```

#### `server/BonkRoom.ts`

```ts
export class BonkRoom extends Room<BonkState> {
  maxClients = MAX_PLAYERS;
  autoDispose = false;
  protected code = "";
  protected fast = false;
  protected world!: GameWorld;
  onCreate(options: CreateOptions): void;
  onAuth(client: Client, options: JoinOptions): boolean;
  onJoin(client: Client, options: JoinOptions): void;
  async onLeave(client: Client, consented?: boolean): Promise<void>;
  onDispose(): void;
  protected onTick(deltaMs: number): void;
  protected applyEvents(events: GameEvent[]): void;
  protected handleInput(client: Client, msg: InputCmd): void;
  protected handleReady(client: Client, msg: ReadyMsg): void;
  protected handleCharacter(client: Client, msg: CharacterMsg): void;
  protected handleSettings(client: Client, msg: SettingsMsg): void;
  protected handleStart(client: Client, msg: StartMsg): void;
  protected handleEmote(client: Client, msg: EmoteMsg): void;
  protected handleRematch(client: Client, msg: RematchMsg): void;
  protected handlePong(client: Client, msg: PongMsg): void;
}
```

#### `client/src/net/types.ts`

```ts
export interface PlayerFrame extends PlayerSimFields …
export interface BallFrame …
export type NetStatus = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";
export interface NetError …
export interface NetEventMap extends ServerMessages …
```

#### `client/src/net/Net.ts`

```ts
export interface NetOptions …
export class Net {
  readonly events = new Emitter<NetEventMap>();
  readonly clock = new Clock();
  constructor(opts: NetOptions = {});
  get status(): NetStatus;
  get sessionId(): string;
  get code(): string;
  get state(): BonkStateView | null;
  get me(): PlayerView | null;
  get isHost(): boolean;
  get wantsInput(): boolean;
  get localSim(): Readonly<PlayerSimFields> | null;
  createRoom(opts: CreateOptions): Promise<void>;
  joinRoom(code: string, opts: JoinOptions): Promise<void>;
  async tryReconnect(): Promise<boolean>;
  async leave(): Promise<void> ;
  sendReady(ready: boolean): void;
  sendCharacter(character: CharacterId): void;
  sendSettings(patch: SettingsMsg): void;
  sendStart(): void ;
  sendEmote(emote: EmoteId): void;
  sendRematch(ready: boolean): void;
  sendInput(cmd: InputCmd): StepPlayerResult | null;
  update(nowMs: number, dtSec: number): void;
  getLocalPlayer(alpha: number, look: { yaw: number; pitch: number }): PlayerFrame | null;
  getRemotePlayers(nowMs: number): PlayerFrame[];
  getBalls(): BallFrame[];
  dispose(): void;
}
```

#### `client/src/net/Clock.ts`

```ts
export class Clock {
  get rttMs(): number;
  get synced(): boolean;
  sample(serverTick: number, nowMs: number, rttMs: number): void;
  serverTickAt(nowMs: number): number;
  serverTimeMs(nowMs: number): number;
  reset(): void ;
}
```

#### `client/src/net/Prediction.ts`

```ts
export class Prediction {
  readonly current: PlayerSim = createPlayerSim();
  get active(): boolean;
  reset(server: PlayerView): void;
  stop(): void ;
  predict(cmd: InputCmd, ctx: SimContext): StepPlayerResult;
  reconcile(server: PlayerView, ctx: SimContext): void;
  getRenderSim(alpha: number, dtSec: number, out: PlayerSimFields): PlayerSimFields;
  get pendingCount(): number;
}
```

#### `client/src/net/Interpolation.ts`

```ts
export class Interpolation {
  push(id: string, tick: number, sim: PlayerSimFields): void;
  sample(id: string, renderTick: number, out: PlayerSimFields): boolean;
  remove(id: string): void;
  clear(): void ;
}
```

#### `client/src/net/BallSync.ts`

```ts
export type OwnerResolver = (ownerId: string) => { aim: Vec3; chest: Vec3; hand: Vec3; alive: boolean } | null;
export class BallSync {
  onServerState(balls: MapView<BallView>, patchTick: number, serverTickNow: number, q: FloorQuery, owners: OwnerResolver): void;
  addPredictedThrow(ownerId: string, seq: number, origin: Vec3, velocities: Vec3[], kind: BallKind, charge: number, curve: boolean): void;
  update(dtSec: number, q: FloorQuery, owners: OwnerResolver): void;
  getFrames(localId: string, localHeldCount: number): BallFrame[];
  clear(): void ;
}
```

#### `client/src/input/Input.ts`

```ts
export interface InputEventMap …
export class Input {
  readonly events = new Emitter<InputEventMap>();
  constructor(target: HTMLElement);
  get yaw(): number;
  get pitch(): number;
  setLook(yaw: number, pitch: number): void;
  configure(opts: { sensitivity: number; invertY: boolean }): void;
  setEnabled(enabled: boolean): void;
  get pointerLocked(): boolean;
  requestPointerLock(): void ;
  exitPointerLock(): void ;
  sample(seq: number): InputCmd;
  ghostMove(): { x: number; y: number; z: number };
  get throwHeld(): boolean;
  dispose(): void;
}
```

#### `client/src/app/settings.ts`

```ts
export type Quality = "low" | "medium" | "high";
export interface Settings …
export const DEFAULT_SETTINGS: Readonly<Settings> …
export const MOUSE_RADIANS_PER_PIXEL = 0.0022;
export function sanitizeSettings(raw: Partial<Record<keyof Settings, unknown>>): Settings;
export type SettingsListener = (next: Readonly<Settings>, changed: ReadonlyArray<keyof Settings>) => void;
export class SettingsStore {
  constructor(private readonly storageKey = SETTINGS_STORAGE_KEY);
  get(): Readonly<Settings>;
  set(patch: Partial<Settings>): void;
  reset(): void;
  onChange(fn: SettingsListener): () => void;
}
export const settings = new SettingsStore();
```

#### `client/src/app/App.ts`

```ts
export class App {
  constructor(gameRoot: HTMLElement, uiRoot: HTMLElement);
  async start(): Promise<void>;
}
```

#### `client/src/app/GameController.ts`

```ts
export interface GameControllerDeps …
export class GameController {
  constructor(deps: GameControllerDeps);
  enter(): void ;
  exit(): void ;
  get active(): boolean;
  frame(nowMs: number, realDt: number): void;
}
```

#### `client/src/render/Renderer.ts`

```ts
export class Renderer {
  readonly webgl: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(70, 1, 0.1, 600);
  constructor(container: HTMLElement, quality: Quality);
  get arena(): Arena | null;
  loadArena(mapId: MapId): Arena;
  setQuality(quality: Quality): void;
  update(dt: number, elapsed: number): void;
  render(): void;
  resize(): void;
  get viewport(): { width: number; height: number };
  dispose(): void;
}
```

#### `client/src/render/Toon.ts`

```ts
export function getToonRamp(): THREE.DataTexture;
export interface ToonOptions …
export function createToonMaterial(color: THREE.ColorRepresentation, opts: ToonOptions = {}): THREE.MeshToonMaterial;
export function getOutlineMaterial(thickness = 0.03, color: THREE.ColorRepresentation = PALETTE.ink): THREE.ShaderMaterial;
export function createOutlineMaterial(thickness = 0.03, color: THREE.ColorRepresentation = PALETTE.ink): THREE.ShaderMaterial;
export function getSmoothOutlineGeometry(geometry: THREE.BufferGeometry): THREE.BufferGeometry;
export function addOutline(target: THREE.Object3D, thickness = 0.03, color: THREE.ColorRepresentation = PALETTE.ink): THREE.Mesh[];
export function removeOutline(target: THREE.Object3D): void;
```

#### `client/src/render/Sky.ts`

```ts
export class Sky {
  readonly object = new THREE.Group();
  constructor(theme: ArenaTheme, quality: Quality);
  update(dt: number, elapsed: number): void;
  dispose(): void ;
}
```

#### `client/src/render/textures.ts`

```ts
export function grassTexture(theme: ArenaTheme): THREE.CanvasTexture;
export function tileTexture(theme: ArenaTheme): THREE.CanvasTexture;
export function frostingTexture(theme: ArenaTheme): THREE.CanvasTexture;
export function woodTexture(): THREE.CanvasTexture;
export function ballTexture(): THREE.CanvasTexture;
export function cloudTexture(color: string, shadow: string): THREE.CanvasTexture;
export function softDotTexture(): THREE.CanvasTexture;
```

#### `client/src/render/Arena.ts`

```ts
export class Arena {
  readonly def: ArenaDef;
  readonly group = new THREE.Group();
  onRingFall: ((ring: number, crumble: CrumbleKind) => void) | null = null;
  constructor(def: ArenaDef, quality: Quality);
  syncRings(rings: ArrayLike<number>): void;
  update(dt: number, elapsed: number): void;
  pedestalTop(index: number, out: THREE.Vector3): THREE.Vector3;
  setQuality(quality: Quality): void;
  dispose(): void ;
}
```

#### `client/src/render/CameraRig.ts`

```ts
export type CameraMode = "follow" | "ghost" | "orbit";
export interface CameraUpdate …
export class CameraRig {
  readonly camera: THREE.PerspectiveCamera;
  constructor(camera: THREE.PerspectiveCamera);
  setFloorQuery(q: FloorQuery | null): void;
  setBaseFov(deg: number): void;
  enterGhost(from: Vec3Like, yaw: number): void;
  update(realDt: number, u: CameraUpdate): void;
  shake(intensity: number, durationSec: number): void;
  koCut(pos: Vec3Like, durationSec: number): void;
  get cutting(): boolean;
}
```

#### `client/src/render/MenuScene.ts`

```ts
export type MenuCrowdFactory = (
export class MenuScene {
  constructor(renderer: Renderer, crowd: MenuCrowdFactory);
  start(): void ;
  stop(): void ;
  get running(): boolean;
  update(dt: number, elapsed: number): void;
}
```

#### `client/src/characters/types.ts`

```ts
export type FaceExpression = "idle" | "blink" | "angry" | "hurt" | "dizzy" | "happy" | "charging" | "ko";
export const FACE_EXPRESSIONS: ReadonlyArray<FaceExpression> …
export type AnimTrigger =
export interface TriggerOptions …
export interface CharacterSyncOptions …
```

#### `client/src/characters/Characters.ts`

```ts
export class Characters {
  constructor(scene: THREE.Scene);
  sync(frames: readonly PlayerFrame[], opts: CharacterSyncOptions, dt: number): void;
  trigger(id: string, anim: AnimTrigger, opts?: TriggerOptions): void;
  getHandPosition(id: string, out: THREE.Vector3): boolean;
  getHeadTop(id: string, out: THREE.Vector3): boolean;
  clear(): void ;
  dispose(): void ;
}
```

#### `client/src/characters/Animal.ts`

```ts
export interface AnimalRig …
export class Animal {
  readonly character: CharacterId;
  readonly rig: AnimalRig;
  constructor(character: CharacterId, slotColor: string);
  setSlotColor(color: string): void;
  setExpression(expression: FaceExpression): void;
  setGhost(ghost: boolean): void;
  setFlash(on: boolean): void;
  dispose(): void ;
}
```

#### `client/src/characters/Animator.ts`

```ts
export class Animator {
  constructor(animal: Animal, character: CharacterId);
  update(frame: PlayerFrame, dt: number): void;
  trigger(anim: AnimTrigger, opts?: TriggerOptions): void;
  get expression(): FaceExpression;
}
```

#### `client/src/characters/faces.ts`

```ts
export const FACE_SHEET_SIZE = 512;
export const FACE_COLUMNS = 4;
export const FACE_ROWS = 2;
export function getFaceSheet(character: CharacterId): THREE.CanvasTexture;
export function faceOffset(expression: FaceExpression): { u: number; v: number };
```

#### `client/src/characters/Nameplate.ts`

```ts
export class Nameplate {
  readonly object = new THREE.Group();
  constructor(nickname: string, color: string);
  update(nickname: string, color: string, hearts: number): void;
  dispose(): void ;
}
export function createCrown(): THREE.Object3D;
```

#### `client/src/characters/CharacterPreview.ts`

```ts
export class CharacterPreview {
  constructor(canvas: HTMLCanvasElement);
  setCharacter(character: CharacterId, slotColor: string): void;
  start(): void ;
  stop(): void ;
  dispose(): void ;
}
```

#### `client/src/characters/MenuCrowd.ts`

```ts
export const createMenuCrowd: MenuCrowdFactory = (scene, arena) => …
```

#### `client/src/fx/types.ts`

```ts
export type ParticleKind =
export interface BurstOptions …
export type PopTextKind = "bonk" | "catch" | "out" | "miss" | "boing" | "ding";
export interface BallVisualContext …
export interface ShadowCaster …
```

#### `client/src/fx/Fx.ts`

```ts
export class Fx {
  readonly balls: BallVisuals;
  readonly particles: Particles;
  readonly popText: PopText;
  readonly powerUps: PowerUpVisuals;
  readonly arc: ArcPreview;
  readonly shadows: BlobShadows;
  readonly feel = new Feel();
  constructor(scene: THREE.Scene);
  setArena(def: ArenaDef, q: FloorQuery): void;
  update(dt: number): void;
  clear(): void;
  dispose(): void;
}
```

#### `client/src/fx/Balls.ts`

```ts
export class BallVisuals {
  constructor(scene: THREE.Scene);
  sync(balls: readonly BallFrame[], dt: number, ctx: BallVisualContext): void;
  setChargeGlow(playerId: string, charge: number): void;
  clear(): void ;
  dispose(): void ;
}
```

#### `client/src/fx/Particles.ts`

```ts
export class Particles {
  constructor(scene: THREE.Scene);
  burst(kind: ParticleKind, pos: { x: number; y: number; z: number }, opts?: BurstOptions): void;
  emit(key: string, kind: ParticleKind, pos: { x: number; y: number; z: number }, opts?: BurstOptions): void;
  update(dt: number): void;
  setQualityScale(scale: number): void;
  clear(): void ;
  dispose(): void ;
}
```

#### `client/src/fx/PopText.ts`

```ts
export class PopText {
  constructor(scene: THREE.Scene);
  show(kind: PopTextKind, pos: { x: number; y: number; z: number }, color?: string): void;
  update(dt: number): void;
  clear(): void ;
  dispose(): void ;
}
```

#### `client/src/fx/PowerUps.ts`

```ts
export class PowerUpVisuals {
  constructor(scene: THREE.Scene);
  setArena(def: ArenaDef): void;
  sync(powerUps: readonly PowerUpView[], dt: number, elapsed: number): void;
  clear(): void ;
  dispose(): void ;
}
```

#### `client/src/fx/Feel.ts`

```ts
export class Feel {
  hitStop(ms: number): void;
  slowMo(scale: number, ms: number): void;
  update(realDt: number): number;
  get timeScale(): number;
}
```

#### `client/src/fx/ArcPreview.ts`

```ts
export class ArcPreview {
  constructor(scene: THREE.Scene);
  update(points: readonly Vec3Like[] | null, color: string): void;
  dispose(): void ;
}
```

#### `client/src/fx/Shadows.ts`

```ts
export class BlobShadows {
  constructor(scene: THREE.Scene);
  setFloorQuery(q: FloorQuery | null): void;
  update(casters: readonly ShadowCaster[]): void;
  dispose(): void ;
}
```

#### `client/src/fx/Indicators.ts`

```ts
export interface IndicatorInput …
export function computeOffscreenIndicators(input: IndicatorInput): OffscreenIndicator[];
```

#### `client/src/audio/Sfx.ts`

```ts
export type SfxId =
export type LoopId =
export type VoiceKind = "hit" | "throw" | "emote" | "ko" | "win" | "catch";
export type SfxBus = "sfx" | "ui";
export interface SfxDef …
export const SFX: Readonly<Record<SfxId, SfxDef>> …
export const SFX_IDS = Object.keys(SFX) as SfxId[];
```

#### `client/src/audio/AudioEngine.ts`

```ts
export interface PlayOptions …
export interface LoopHandle …
export class AudioEngine {
  unlock(): void ;
  get ready(): boolean;
  setVolumes(master: number, music: number, sfx: number): void;
  setListener(pos: Vec3Like, forward: Vec3Like): void;
  play(id: SfxId, opts?: PlayOptions): void;
  voice(character: CharacterId, kind: VoiceKind, opts?: PlayOptions): void;
  startLoop(id: LoopId, opts?: PlayOptions): LoopHandle;
  playMusic(track: MusicTrack): void;
  setMusicTempo(scale: number): void;
  jingle(kind: Jingle): void;
  setTimeScale(scale: number): void;
  dispose(): void ;
}
```

#### `client/src/audio/Music.ts`

```ts
export type MusicTrack = "none" | "lobby" | "fight" | "suddenDeath";
export type Jingle = "roundWin" | "matchWin" | "roundLose";
export class Music {
  constructor(ctx: AudioContext, output: AudioNode);
  play(track: MusicTrack): void;
  get track(): MusicTrack;
  setTempo(scale: number): void;
  jingle(kind: Jingle): void;
  stop(): void ;
  dispose(): void ;
}
```

#### `client/src/ui/models.ts`

```ts
export type ScreenId = "home" | "connecting" | "lobby" | "game" | "matchEnd";
export type ToastKind = "info" | "success" | "warning" | "error";
export interface HomeModel …
export interface LobbyPlayerCard …
export interface LobbyModel …
export const MAP_CHOICES: ReadonlyArray<{ value: MapChoice; label: string }> …
export interface ScoreRow …
export interface AbilityHud …
export interface HudModel …
export interface OffscreenIndicator …
export interface FeedPlayer …
export type KillFeedKind = "bonk" | "catch" | "ringOut" | "fell" | "ko" | "dropped";
export interface KillFeedEntry …
export interface RoundEndRow …
export interface RoundEndModel …
export interface PodiumEntry …
export interface MatchEndModel …
export interface UiEventMap …
```

#### `client/src/ui/Ui.ts`

```ts
export class Ui {
  readonly events = new Emitter<UiEventMap>();
  protected readonly home: HomeScreen;
  protected readonly lobby: LobbyScreen;
  protected readonly hud: Hud;
  protected readonly killFeed: KillFeed;
  protected readonly scoreboard: Scoreboard;
  protected readonly roundEnd: RoundEndCard;
  protected readonly matchEnd: MatchEndScreen;
  protected readonly settingsMenu: SettingsMenu;
  protected readonly toasts: Toasts;
  constructor(root: HTMLElement);
  showScreen(id: ScreenId): void;
  get screen(): ScreenId;
  setConnecting(text: string): void;
  setHome(model: HomeModel): void;
  setLobby(model: LobbyModel): void;
  get previewCanvas(): HTMLCanvasElement;
  updateHud(model: HudModel): void;
  setIndicators(list: readonly OffscreenIndicator[]): void;
  pushKillFeed(entry: KillFeedEntry): void;
  setScoreboard(open: boolean, rows: readonly ScoreRow[]): void;
  showRoundEnd(model: RoundEndModel): void;
  hideRoundEnd(): void;
  setMatchEnd(model: MatchEndModel): void;
  openSettings(current: Readonly<Settings>, inRoom: boolean): void;
  closeSettings(): void;
  get settingsOpen(): boolean;
  setClickToPlay(visible: boolean): void;
  banner(text: string, style: "info" | "danger" | "success" = "info"): void;
  toast(text: string, kind: ToastKind = "info"): void;
}
```

#### `client/src/util/Emitter.ts`

```ts
export type Listener<T> = (payload: T) => void;
export class Emitter<Events extends object> {
  on<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void;
  once<K extends keyof Events>(type: K, fn: Listener<Events[K]>): () => void;
  off<K extends keyof Events>(type: K, fn: Listener<Events[K]>): void;
  emit<K extends keyof Events>(type: K, payload: Events[K]): void;
  clear(type?: keyof Events): void;
}
```

#### `client/src/util/color.ts`

```ts
export function hexToInt(hex: string): number;
export function intToHex(value: number): string;
export function mixHex(a: string, b: string, t: number): string;
export function shadeHex(hex: string, amount: number): string;
export function hexToRgba(hex: string, alpha: number): string;
```


## 12. Contract review fixes (adversarial review before the parallel build)

Everything below is already applied to the stubs/contracts above; this list is the audit trail.
Builders: these are the rules, not suggestions.

**Foundational files (bugs fixed)**
- `render/Toon.ts`: `ToonOptions.flatShading` was silently ignored (MeshToonMaterial has no
  `flatShading` constructor parameter); it is now set on the material after construction, which
  the toon shader honors. The outline vertex shader now supports `InstancedMesh`
  (`USE_INSTANCING`), and `addOutline` skips InstancedMesh children (a plain child would draw one
  copy at the origin).
- `app/settings.ts`: `set({ key: undefined })` reset that setting to its default; undefined keys
  are now ignored.
- `shared/sim/player.ts` `hasRollIFrames`: off by one (5 ticks instead of 6) because hit checks run
  after `stepPlayer`, which decrements `rollTicks` on the start tick; now `rollTicks > 0 &&
  rollTicks >= ROLL_TICKS - ROLL_IFRAME_TICKS`.
- `render/Arena.ts` `pedestalTop`: returned y = 0 instead of `PEDESTAL_HEIGHT`.
- Verified (no change needed): `@colyseus/schema` v3 decorators encode with `Encoder` and decode
  via `Reflection` exactly as colyseus.js does (all field types, child schema, maps, uint8
  ArraySchema, deltas, callbacks; in-place `clear()`/`push` keep client instances); `math.ts`
  yaw/pitch/rotateY conventions match TECH_BRIEF §2 and `maps.ts` spawn yaws; `hub.ts`,
  `server/index.ts` register and the room code lookup work end to end; Colyseus rejects a full
  room's `joinById` with 4212 and the text `is locked` (vs `not found`).

**Sim contracts**
- `groundHeightAt`: the floor supports a body only if `0 <= feetY + STEP_HEIGHT` (previously a
  player who dropped below the island could snap back up to y = 0). `stepPlayer` passes
  `max(yBefore, y)` so fast falls still land on cover.
- `stepBall` floor rule clarified: support only if the center was above y = 0 before integrating.
- Triple Shot: index 0 = thrown ball (power-up kind), 1/2 = `bonus`; all share ownerId,
  throwSeq, charge, curve (server and predicted balls).

**Server**
- Room runs a fixed-step accumulator (Node truncates 33.33 ms intervals to 33 ms ≈ 30.3 Hz).
- Input seq: `clearInputs(id)` forgets the last seen seq and zeroes `lastSeq`; called on join and
  reconnect. Clients never reset their counter (§2.16).
- Consented leave of an alive player mid-round → `ko` cause `disconnect` (was only on timeout).
- A round that would start with < 2 participants ends the match; participants include players
  inside the reconnect window.
- Lobby return uses `world.resetForRound([])`; out-of-step events are drained every tick.
- State collections are mutated in place, never reassigned (§2.18).
- Picked-up / caught / boomerang-returned balls become plain held balls (kind normal, flags reset).
- Catches: one ball per press; siblings of a caught throw deflect (§2.4). `DeflectEvent` now also
  covers that case (payload unchanged).
- `stats.throws` counts balls (accuracy ≤ 100%); `PodiumEntry.accuracy` clamps to 100.
- Eliminated players are not stepped (the old text said ring-out bodies keep falling server-side).
- Empty-room disposal is `this.disconnect()` (autoDispose is off).

**Client**
- `BallSync.onServerState(..., owners)`: the patch fast-forward needs the owner resolver too
  (otherwise a returning boomerang turns dead locally); `OwnerResolver` gained `hand`, and new
  remote throws start at the thrower's rendered hand and catch up.
- Interpolation render tick subtracts `rttMs/2` as well (the clock is the server's present), so the
  100 ms buffer is real; teleports (round reset) don't slide across the island.
- `Net.getLocalPlayer` interpolates the local player when not predicting (round-end slow-mo,
  ghost, spectator) instead of returning choppy 20 Hz state.
- `Input`: THROW also counts a press since the previous sample (a sub-tick click still throws).
- `GameController`: `acc = 0` while `!wantsInput`; charge glow + positional charge loop for every
  player (the telegraph is for opponents); FloorQuery objects must read the live `state.rings`.
- Characters: new `ringOut` trigger and `TriggerOptions.pos` so ghosts appear above the island
  (the server freezes ring-out bodies below y = -6); spectators are hidden.
- `Net` emits `phase` once right after connecting; every client module may import `util/*`.
