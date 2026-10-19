# Jelly Jackpot architecture

Design: [`/game2.md`](../../../game2.md). This doc is the build contract: who owns which file, and how the
pieces talk. Files marked **complete** are shared infrastructure; don't change their public shape.

## Frozen contract (complete)
| File | What |
|---|---|
| `shared/constants.ts` | balance (§16), card table (§6), piece table + colliders (§8), colors, timings |
| `shared/protocol.ts` | phases, synced state views (`JellyStateView` …), every message + payload |
| `server/schema.ts` | Colyseus schema implementing the views (no secrets in state) |
| `server/hub.ts`, `server/index.ts` | hub registration + room codes |
| `client/src/app/settings.ts` | client settings store |
| `client/src/scene/toon.ts` | toon material, outlines, googly eyes |
| `client/src/util/Emitter.ts` | typed emitter |
| `client/src/ui/theme.css` | UI tokens + `.jj-panel` / `.jj-btn` |
| `client/src/main.ts`, `client/index.html`, `client/vite.config.ts`, `game.json` | entry + build |

Each skeleton file's **public API (exported names, constructor + method signatures) is the contract**.
Owners fill in the bodies and may add private members, extra exports, helper files in their own folder
and their own CSS file. Never edit another owner's file; if a contract is truly missing something, add
it in your own module and note it in your final report.

## Owners
| Owner | Files |
|---|---|
| server-physics | `server/physics/**` (TowerSim, Rapier) |
| server-rules | `server/rules.ts`, `server/rules.test.ts` |
| server-room | `server/JellyRoom.ts`, `server/room/**` |
| client-net | `client/src/net/**` |
| client-scene | `client/src/scene/Stage.ts`, `client/src/scene/kitchen/**` |
| client-pieces | `client/src/scene/Pieces.ts`, `client/src/scene/pieces/**` |
| client-chefs | `client/src/scene/Chefs.ts`, `client/src/scene/chefs/**` |
| client-fx | `client/src/scene/Fx.ts`, `client/src/scene/fx.css` |
| client-music | `client/src/audio/Music.ts` |
| client-sfx | `client/src/audio/AudioEngine.ts`, `client/src/audio/sfx/**` |
| client-menu | `client/src/ui/Menu.ts`, `client/src/ui/menu.css` |
| client-reel | `client/src/ui/CaseReel.ts`, `client/src/ui/reel.css` |
| client-hud | `client/src/ui/Hud.ts`, `client/src/ui/hud.css` |
| client-overlays | `client/src/ui/Overlays.ts`, `client/src/ui/overlays.css` |
| client-controls | `client/src/input/**` |
| client-game | `client/src/Game.ts`, `client/src/game/**` |
| art | `cover.svg`, favicon in `client/index.html`, README row |

## Frames & units
Meters, seconds. Table top y = 0. The physics world, piece poses, hover poses, wind direction: all in the
cake stand's **local** frame. The stand's rotation (`state.standAngle`) is purely visual: the client puts
every piece under `Stage.standGroup` and rotates that group. Pieces' collider shapes in
`PIECES[type].colliders` define the physical shape; client meshes are modelled to match them.

## Server tick
`JellyRoom` (60 Hz `setSimulationInterval`) runs phase timers, and during `settling` steps `TowerSim`,
copies transforms into `state.pieces`, emits `IMPACT` / `TOPPLE`. Patches go out at 20 Hz. Secrets
(roles, bets, votes, rig records, hidden bonus) live only in JellyRoom fields and private messages.

## Client flow (client-game)
- Boot: Stage + TowerView + Chefs + Fx + AudioEngine + Menu + Hud + CaseReel + Overlays + Controls. One
  `requestAnimationFrame` loop: `dt` (clamped 0.05) × `fx.timeScale(dt)` for visuals → controls.update,
  tower.update, chefs.update, fx.update, stage.update, hud.tick, stage.render. While on the home screen, the
  scene plays an attract loop (a local fake tower that builds itself and topples, no server).
- `?room=CODE` → prefill join. `net.tryReconnect()` on boot.
- On every `state`: tower.sync, chefs.sync, stage.setStandAngle/setTowerHeight/setWind/setQuake, hud.update,
  menu.updateLobby (lobby), overlays.updateVote (voting), audio.setHum/setWindLevel.
- `phase` → screen switches + music modes (lobby→"lobby", spinning/result→"lounge", placing→"tension",
  settling→"drumroll", matchEnd→"victory"), stage.pushIn during settling.
- `spinStart` → reel.spin; `spinResult` → reel.land (ticks → audio.reelTick), on landed: stinger, edge glow,
  neon sign, Legendary → jackpotLights + coinShower, Cursed → red flash + recordScratch.
- Card effects for the active (local) player: mirrorHands / tiedHands → Controls options, upsideDown →
  stage.setUpsideDown, fog → stage.setFog, blindfold → fx.setBlindfold 2 s into placing (only for the active
  player; everyone else sees normally). Reset all at the end of the turn.
- `placing` & I'm active → controls.beginPlacement, each frame net.hover(controls.pose()) +
  tower.setLocalHover. `drop` action → net.drop, audio whoosh.
- `impact` → audio.impact(PIECES[type].sound, speed), tower.squish, small fx.puff. `topple` → fx.freeze(0.3),
  "TIMBER!", slide whistle, splat, chefs: toppler gets "pie", others laugh/gasp. `result` stand → "DING!",
  coins from the tower to the chef, confetti (multiplier/5), cheer. `bets` → feed lines + coin deltas + chef
  cheer/cry. `hiccup` → "*hic*" + sound. `emoted` → chef reaction + voice.
- voting/reveal/matchEnd → Overlays. Reveal: saboteur chef "devil".
