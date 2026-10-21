# KASALA! architecture

Design: [`/game3.md`](../../../game3.md) (Turkish; §-numbers below refer to it). This doc is the build contract:
who owns which file, and how the pieces talk. Files marked **frozen** are shared infrastructure; don't change
their public shape (adding a missing export in your OWN module is fine — note it in your report).

Everything the player sees or hears is **Turkish**. Code, comments and identifiers are English.

## Frozen contract
| File | What |
|---|---|
| `shared/constants.ts` | balance (§19), card table (§6), wheel (§7), bet boxes (§8), animals, colors, emotes, taunts, titles, timings, pure helpers (`raidChance`, `classicRounds`, `boxWins`, `boxAlive`) |
| `shared/announcer.ts` | the 95 Cemil Abi lines (§15) with event tags + priority, `pickLine`, `lineDurationSec` |
| `shared/protocol.ts` | phases, synced state views (`KasalaStateView` …), every message + payload |
| `server/schema.ts` | Colyseus schema implementing the views (compile-time checked) |
| `server/hub.ts`, `server/index.ts` | hub registration + room codes |
| `client/src/app/settings.ts` | client settings store (volumes, subtitles, speech fallback, quality, reduced flashing) |
| `client/src/app/ui.ts` | `esc`, `money`, `pct`, `upperTr`, `playerColor`, `animalLabel`, Turkish suffix helpers `fromName`/`toName`/`ofName`, `el`, `UiSound` |
| `client/src/scene/toon.ts` | toon material, outlines, `canvasTexture`, `fontsReady` |
| `client/src/util/Emitter.ts` | typed emitter |
| `client/src/ui/theme.css` | UI tokens + `.ks-panel` / `.ks-btn` / `.ks-neon` / `.ks-key` |
| `client/src/main.ts`, `client/index.html`, `client/vite.config.ts`, `game.json`, `tsconfig.json` | entry + build |

Every skeleton file's **public API (exported names, constructor + method signatures, documented behavior) is
the contract**. Owners fill in the bodies and may add private members, extra exports, helper files in their
own folder and their own CSS file. **Never edit another owner's file**; if a contract is truly missing
something, work around it inside your own module and note it in your final report.

## Owners
| Owner | Files |
|---|---|
| server | `server/KasalaRoom.ts`, `server/rules.ts`, `server/room/**`, `server/*.test.ts` |
| client-net-game | `client/src/net/**`, `client/src/Game.ts`, `client/src/game/**`, `client/src/input/**` |
| client-scene | `client/src/scene/Stage.ts`, `client/src/scene/room/**` |
| client-characters | `client/src/scene/Characters.ts`, `client/src/scene/characters/**` |
| client-cards-fx | `client/src/scene/Cards.ts`, `client/src/scene/Wheel.ts`, `client/src/scene/Fx.ts`, `client/src/scene/fx/**`, `client/src/scene/fx.css` |
| client-audio | `client/src/audio/**` |
| client-menu | `client/src/ui/Menu.ts`, `client/src/ui/menu/**`, `client/src/ui/menu.css`, `cover.svg` |
| client-hud | `client/src/ui/Hud.ts`, `client/src/ui/hud/**`, `client/src/ui/hud.css` |
| client-overlays | `client/src/ui/Overlays.ts`, `client/src/ui/overlays/**`, `client/src/ui/overlays.css` |

Reference code to read and adapt (same hub, same stack, same art direction): `games/jelly-jackpot/**`
(closest: turn-based, 2–6 players, gambling, toon kitchen scene, synthesized audio) and `games/bonk-brawl/**`.
Do not import from other games — copy and adapt.

## Rules of the road for parallel work
- Typecheck with `npx tsc --noEmit -p games/kasala/tsconfig.json`; only fix errors in YOUR files (other
  owners are editing theirs at the same time; their transient errors are not yours).
- Do NOT run `npm run build` / `vite build` (the shared `client/dist` would race). The integrator builds.
- No new npm dependencies. Available: `three@0.186`, `colyseus.js@0.16`, `@colyseus/core@0.16`,
  `@colyseus/schema@3`, `vitest`.
- Client imports use extensionless paths (`../../../shared/constants`); server/shared imports use `.js`.
- No external assets except the Google Fonts in index.html (Fredoka, Monoton). Models are built from three.js
  primitives in code, textures are canvas-drawn, sounds are synthesized.

## Coordinates & units
Meters, seconds, dollars. Floor y = 0, table center at the origin, table top y = `TABLE_TOP_Y` (Stage.ts),
dealer at −z, seats spread around the near arc, default camera at +z looking down ~40°. Seats are compacted
indices `0..n−1` (`PlayerView.seat`); `stage.seatPose(seat, stage.seatCount)` gives every per-seat point.

## Server
`KasalaRoom` (20 Hz `setSimulationInterval`) runs phase timers; patches go out at 20 Hz. No physics, no
secrets in the room (bets/debts/offers are public, unflipped cards don't exist yet). The rng is seeded per
match (`options.seed` in tests). Pure math (card roll, wheel roll, bet settle, interest, taşlık, standings,
titles) lives in `server/rules.ts` with unit tests. The full flow is spelled out at the top of
`server/KasalaRoom.ts`; phases in `shared/protocol.ts`.

## Client flow (client-net-game)
- Boot: Stage + Characters + Cards + Wheel + Fx + AudioEngine + Menu + Hud + Overlays + Controls, each DOM
  module in its own absolutely positioned layer under `#ui` (`position:absolute; inset:0;
  pointer-events:none`; each with an explicit `z-index` and `isolation:isolate`), bottom → top: labels
  (Characters, z 1), tint (Fx vignette / final-table tint / edge glow, z 2), hud (z 3), fx (slams, floats,
  flashes, z 4), overlays (z 5), menu (z 6), toasts (Game, z 8). While the home / lobby menu is shown the
  overlays layer is lifted to z 7 so the settings dialog and the emote picker stay above the menu backdrop.
  Layers never take pointer events themselves; modules set `pointer-events:auto` on their interactive
  elements only.
  One `requestAnimationFrame` loop: `dt` (clamped 0.05) × `fx.timeScale()` for visuals → controls.update,
  stage.update (camera first, so every DOM projection uses this frame's camera), targeting hover / crosshair,
  characters.update, cards.update, wheel.update, fx.update, hud.tick, overlays.tick (wall-clock dt ≤ 0.5 s),
  stage.render.
- Home: `menu.showHome`, `characters.setAttract(true)` (Cemil shuffles, sample gangsters idle),
  `stage.setFocus("home")`, music "lobby". `?room=CODE` (or a `/games/kasala/r/CODE` path) → prefill join.
  `net.tryReconnect()` on boot. `audio.unlock()` on the first pointerdown/keydown.
- Every `state`: stage.setSeats (lobby: all players; in match: turnOrder players), stage.setKumbara,
  stage.setSiren(raidChance during flipping, else 0) + fx.setSirenPulse + audio.setTension, stage.setTremble
  (raidChance ≥ SIREN_SHAKE_CHANCE), stage.setFinalTable/fx.setFinalTable, stage.setViewSeat(my seat),
  characters.sync, cards.setLawyers, hud.update (in match), menu.updateLobby (lobby), overlays.update.
- `phase` → screens: lobby → menu.showLobby, hud hidden, characters.setAttract(false); intro..settle /
  lastChance / elimination → hud visible; matchEnd → overlays.matchEnd. Music: lobby "lobby", in match "lounge"
  ("tango" when finalTable), wheel "wheel", matchEnd "victory". Camera: betting/flipping → setFocus("seat",
  active seat); targeting → "table"; wheel → "wheel"; result raid → "door" for ~1.5 s then back; matchEnd →
  "podium".
- `turnStart` → cards.clearTurn, banner "Sıra Kedi'de" (my turn: "SIRA SENDE!" + sfx), feed.
- `card` → characters.dealer.deal(), cards.flip(msg, activeSeatPose) then: sfx flip + rarity bell (+ choir
  for rare+), fx.edgeGlow(rarity color) for rare+, hud.banner(card name + value), fx.floatText at the stack;
  money: kaching/coins; curseHit: "🧿 NAZAR!" + boo; raid card (not saved): fx.freeze(0.3), fx.flash red,
  sfx siren; saved: characters.lawyer + sfx paper. Feed line ("🃏 Kedi **Çanta** çevirdi (+50$)"). needsTarget
  for me → characters.setTargetable(valid ids) + hud.targetPrompt(card, true).
- Controls "click" during targeting (me) → characters.pick → net.target(id) if valid.
- `attack` → chips fly target → active stack (harac/haracTuru), takas: both stacks swap with a whoosh, lanet:
  nazar puff on the target, tuzak: trap icon on the next player; characters.react (attacker laugh, target
  angry); feed ("💸 Fare, Kurbağa'dan haraç kesti (−40$)").
- `wheelStart` → stage.setLightsOut(true), stage.setFocus("wheel"), audio.setMusic("wheel"),
  characters.dealer.spinWheel(), wheel.spin(..., onTick → audio.wheelTick); `wheelResult` → wheel.celebrate,
  fx per slice (kumbara: stage.pulseKumbara("burst") + fx.glassBurst + moneyRain + shake + slam "JACKPOT!"),
  feed ("🎰 Tavşan KUMBARAYI PATLATTI (+420$)"); when the phase leaves wheel → wheel.raise(), lights back.
- `cashed` → characters.cash, fx.moneyRain at the stack (confetti by pot), sfx kaching, slam "KASALA!",
  stage.punch; skipped → feed "… bağlı değil, sırası geçti".
- `raided` → stage.breakDoor(), stage.setFocus("door"), characters.dealer.hide(true), characters.raid(id, anim),
  sfx doorBreak + siren + cuffs/sack/moths/cameraFlash per anim, fx.flash, sabika → overlays.mugshot; feed
  ("🚨 Domuz BASKIN yedi (−34$)"); others react laugh/shock.
- Vitrin & Pazar: money lands in `state.row` (one RowCardView per card, `turnPot` = what is still on the
  table). `cashed` with `taken` → those cards fly to the stack (cards.sendRow), the other flipped cards back into
  the deck, the rest of the row stays. Phase `market` → hud MarketPanel (buyers pick with 1–9 / a click on the
  row card via cards.rowCardAt, 0 = pas, Game sends `MARKET`, cards.markRow rings the pick). `marketResult` →
  sold cards fly to the buyers, fee chips to the seller, clash losers sulk, leftovers to the kumbara, my feed line.
- `betsSettled` → hud.betsSettled, chips fly to winners, sfx chips/chipCrack, my result banner.
- `loan`, `taslik`, `roundEnd` (interest feed lines, "SON MASA" slam when finalTableNext), `lastChance`
  (the HUD shows the banner from state; its "Borç ver" button → overlays.toggleLoans(true, lastChanceId)),
  `saved`, `eliminated`
  (characters.eliminate + fx.splash), `ghostReturn` (characters.ghostReturn), `emoted` (characters.emote +
  sfx), `taunted` (characters.taunt(TAUNTS[i])), `notice` (hud.feed or a toast).
- `announcer` → audio.announcer.say(id); announcer "line" → hud.subtitle("Cemil Abi: " + text, sec) +
  characters.dealer.talk(sec).
- `matchEnd` → overlays.matchEnd(msg); onStep → announcer is server-driven, so just drive the 3D: podium step
  → characters.podium(standings order), stage.setFocus("podium"), confetti.
- Controls actions → net calls when legal (flip/cash only for the active player in flipping and !busy; box →
  net.bet(box, chip) only in betting for non-active players; chip → hud.setChip; loans → overlays.toggleLoans
  (when settings.loans); emote/taunt → net; picker → overlays.openPicker; scoreboard → overlays.setScoreboard;
  escape → overlays.closeTop() || overlays.toggleSettings()). Key filter: menu.capturesKeys() ||
  overlays.capturesKeys().
- Errors (NetError) → menu.showError in Turkish ("Böyle bir masa yok.", "Masa dolu.", "Sunucuya
  bağlanılamadı.").
