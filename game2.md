# JELLY JACKPOT — Game Design Document (game2.md)

> A silly, physics-y, **stack-and-topple gambling party game** for 2–6 friends in the browser.
> Every turn, open a case, see which ridiculous rule you got, then drop a wobbly piece of kitchen junk onto a shared cake tower. Bet on whether your friends' pieces stand or fall. And somebody at the table is secretly rigging the cases…

## 1. Decisions (from the interview)
| Topic | Decision |
|---|---|
| Core physics | **Stack & topple**: players take turns dropping wobbly pieces onto one shared tower |
| Trickster | **1 secret Saboteur** (3+ players). The group votes on who it was at the end |
| Gamble | **Open a CS-style case every turn**. A spinning reel lands on a rule + a multiplier that apply to that turn only |
| Case | The active player spins on each of their turns |
| Scoring | Coins = base × case multiplier. The multiplier **cuts both ways**: topple and you lose × multiplier too |
| Sabotage | **Rigged case**: once per round the Saboteur can secretly turn someone's spin into a Cursed card |
| Side bets | Everyone else bets **STAND** or **FALL** on every turn |
| Players | 2–6 |
| Match | 6–8 rounds, ~10 min |
| Theme | Kitchen junk stacked on a cake on a slowly spinning cake stand |
| Controls | Grab, rotate, drop, against a turn timer |
| Tech | Three.js client, Node.js + Colyseus authoritative server, Rapier physics (same stack as Bonk Brawl) |

## 2. Elevator pitch
Six bean-shaped chefs sit around a kitchen table. In the middle, a birthday cake slowly turns on a cake stand. On your turn you **open a case**: a reel of glowing cards whizzes past and stops on something like *"Moon Gravity ×2"* or *"Butter Fingers ×1.5"*. Then you get a random piece of kitchen junk (a rubber chicken, a toaster, a jiggling jelly) and have **10 seconds** to hover it, rotate it, and drop it onto the tower. Meanwhile everyone else bets coins on whether it'll **stand or fall**. If the tower survives, you earn coins × your multiplier. If anything hits the table, you lose coins × your multiplier and take a cream pie to the face.

The twist: one player is the **Saboteur**. Once per round they can secretly rig someone's case so it lands on a **Cursed** rule (bowling ball, upside-down camera, wind storm). A rigged case looks exactly like an unlucky natural roll. At the end, everyone votes on who the Saboteur was.

## 3. Why it's fun
- **The hover:** everyone watches the active player wiggle a fish over a leaning tower in real time. Pure tension, plenty of shouting.
- **The case reveal:** the CS-style reel slows down... ticks... past the gold card... onto *"Plain Turn"*. Groans. Or it lands on Legendary and the table erupts.
- **Risk both ways:** a ×4 Cursed rule is terrible to play, but if you survive it you get rich. Luck creates drama, and skill still decides whether the piece stands.
- **Side-bet trash talk:** "I've got 50 on FALL, no pressure."
- **Paranoia:** "Third Cursed card this game? THAT WAS RIGGED." Sometimes it was. Sometimes it was just luck.
- **Silly physics:** jelly jiggles, the chicken squeaks, pancakes slide off, and a toppled tower explodes in a cake splat.

## 4. Core gameplay loop
1. **Lobby:** pick a chef hat color, press Ready. The host can change settings.
2. **Role reveal:** each player privately sees a card: **Baker** (normal player) or **Saboteur**. With 2 players there is no Saboteur.
3. **Rounds:** a round is **4 turns or one turn per player, whichever is more**. With 2–3 players the order wraps around so a round is still ~1 min. The turn order rotates each round so nobody always gets the tall tower.
4. **Turn (~15 s):**
   1. **Case spin (3 s):** press Space (or wait 2 s for an auto spin). The reel lands on a rule + multiplier.
   2. **Place (10 s):** your piece hovers above the cake. Move, rotate, drop. Everyone else places a side bet. Bets lock the moment you drop.
   3. **Settle (≤4 s):** physics runs until everything sleeps (or 4 s pass). A drumroll plays.
   4. **Result:** STAND → coins + confetti. FALL → coin loss, a cake splat, a pie face, and the cake resets.
5. **After the last round:** **accusation vote** (20 s) → dramatic **Saboteur reveal** → coin tally → **podium** → "Rematch".

## 5. Rules & scoring
### Coins
- Everyone starts with **100 coins**. **Most coins at the end wins.** Tiebreaker: most successful placements.

### Placement
| Result | Coins |
|---|---|
| Tower **stands** | `(10 + 1 per 10 cm of tower height) × multiplier`, so placing on a tall tower is worth more |
| Tower **topples** | `−10 × multiplier` (you can't go below 0) |

- **Topple** = any piece falls below the cake stand's rim (touches the table or floor) during the settle phase.
- After a topple the tower is cleared with a big splat, a fresh cake slides in, and the next player starts from scratch, so tower height (and the payout) resets.
- **Timer runs out** → the piece auto-drops from wherever it's hovering (usually hilarious).
- The piece must be dropped from at least 10 cm above the highest point of the tower: no "placing" it gently into the frosting. A ghost shadow shows where it will land.

### Side bets (players who aren't on turn)
| Bet | Payout |
|---|---|
| 0 / 10 / 25 / 50 coins on **STAND** or **FALL** | A win pays back 2× the stake. A loss forfeits the stake |

- You can't bet on your own turn.
- All bets are **hidden until the result**, then revealed in the feed. Someone who always bets FALL right before a Cursed card is a suspect.

## 6. The Case (the gamble system)
A CS-style case opening: a horizontal strip of cards scrolls fast, slows down with a ticking sound, and stops under the center marker. Card border colors show rarity.

| Rarity | Color | Odds | Multiplier |
|---|---|---|---|
| Common | Blue `#4B8BFF` | 55% | ×1 – ×1.5 |
| Uncommon | Purple `#8847FF` | 25% | ×2 |
| Rare | Pink `#D32CE6` | 12% | ×3 |
| Legendary | Gold `#FFD700` | 5% | ×5 |
| Cursed | Red `#EB4B4B` | 3% (6% with 2 players) | ×4 |

### Rule cards
| Card | Rarity | × | Effect (this turn only) |
|---|---|---|---|
| **Plain Turn** | Common | ×1 | Nothing special |
| **Butter Fingers** | Common | ×1.5 | Your piece has almost no friction |
| **Speed Round** | Common | ×1.5 | 5 s placement timer |
| **Mirror Hands** | Common | ×1.5 | Mouse controls are mirrored left/right |
| **Heavy Snack** | Common | ×1.5 | Your piece weighs 3× as much |
| **Moon Gravity** | Uncommon | ×2 | Gravity ×0.4 during the settle: everything floats and drifts |
| **Jelly Mode** | Uncommon | ×2 | Your piece turns into wobbly, bouncy jelly |
| **Chonk** | Uncommon | ×2 | Your piece is 1.6× bigger |
| **Spin Cycle** | Uncommon | ×2 | The cake stand spins 3× faster |
| **Fog** | Uncommon | ×2 | Steam from the kitchen clouds your camera |
| **Blindfold** | Rare | ×3 | Your screen goes dark 2 s into placement. Drop from memory (everyone else can still see!) |
| **Double Decker** | Rare | ×3 | You place 2 pieces in a row (same 10 s timer) |
| **Earthquake** | Rare | ×3 | The table shakes for 1 s after your drop |
| **Hiccups** | Rare | ×3 | Your piece randomly hops while you hover it |
| **Golden Cherry** | Legendary | ×5 | Your piece is a tiny golden cherry. Easy money! |
| **Glue Gun** | Legendary | ×5 | Your piece sticks to whatever it touches first |
| **Insurance** | Legendary | ×5 | If it topples you lose nothing (side bets still pay out normally) |
| **Bowling Ball** | Cursed | ×4 | Your piece is a heavy, round bowling ball |
| **Upside Down** | Cursed | ×4 | Your camera is flipped upside down |
| **Wind Storm** | Cursed | ×4 | A gusty fan blows across the tower during placement and settle |
| **Tied Hands** | Cursed | ×4 | Your piece can't be rotated and swings like it's on a string |

- The **server** decides the result with a seeded RNG when the spin starts. The client reel animation is just choreographed to decelerate onto that card. Clients can't cheat or predict it.
- Rules apply to the active player's turn only. Board-wide effects like Spin Cycle, Wind Storm, and Moon Gravity reset after the settle.

## 7. The Saboteur
- **Assignment:** with 3+ players, exactly **1 random Saboteur** per match. With 2 players there's no Saboteur (Cursed odds go up instead to keep the chaos).
- The Saboteur plays normal turns and earns coins normally. They also want towers to fall on **other** players' turns.
- **Rig (R key, once per round):** only while someone else's case is spinning. The result secretly becomes a random **Cursed** card. On screen it is **identical to a natural Cursed roll**: same animation, same sound. That's the whole trick.
  - The risk: a Cursed card is ×4. If the victim survives it, they get a big payout. Good Saboteurs rig the shaky player on the tall tower.
- **Hidden bonus:** +30 coins per topple on someone else's turn. This is tracked secretly and added only at the reveal.
- **Accusation vote (end of match):** everyone (including the Saboteur, to stay hidden) votes for a suspect.
  | Outcome | Effect |
  |---|---|
  | **Majority guesses correctly** | The Saboteur **loses** the hidden bonus. Each correct voter gets **+40** |
  | **Majority is wrong / tie** | The Saboteur keeps the hidden bonus **+60** |
- **Reveal:** the Saboteur's chef rips off their hat to show a little devil hat underneath. The game then replays a highlight list: *"Rigged: Deniz's turn, round 3 → Bowling Ball 🎳 (FELL)"*.
- **Clues available to good players:** the bet reveal after each turn, how often the Cursed cards appear (3% naturally, so 2–3 in one match is suspicious), and whose turns they land on.

## 8. Pieces (kitchen junk, ~16)
A piece is dealt from a shuffled **bag** (every piece once before any repeats). The "Next up" piece is shown in the HUD so you can plan ahead.

| Piece | Shape | Mass | Friction / feel |
|---|---|---|---|
| Jelly | Wobbly dome | Medium | Bouncy, jiggles, grippy |
| Rubber chicken | Long, floppy | Light | Squeaks on impact |
| Fish | Long, curved | Medium | Slippery |
| Toaster | Box | Heavy | Solid, a great base |
| Donut | Ring | Light | Rolls if dropped on edge |
| Banana | Curved | Light | Rocks back and forth |
| Teapot | Odd lumpy shape | Medium | Spout catches on things |
| Cheese wedge | Triangle prism | Medium | Grippy, good for leveling |
| Spatula | Thin flat paddle | Light | Bridges gaps |
| Egg | Ellipsoid | Light | Rolls. Cracks (cosmetic) on landing |
| Pancake stack | Short cylinder | Medium | Top pancake can slide off (2 bodies) |
| Watermelon | Big sphere-ish | Heavy | Rolls, very dangerous |
| Croissant | Crescent | Light | Weirdly stable |
| Soap bar | Rounded box | Light | Almost no friction |
| Cupcake | Truncated cone | Light | Flat top, nice to stack on |
| Frying pan | Disc + handle | Heavy | Wide platform, off-center weight |

Physics shapes: compound convex hulls (2–4 per piece) authored in Blender as simplified collision meshes. Jelly is a single convex body with high restitution plus a vertex-shader wobble. It's not a real soft body.

## 9. Controls (keyboard + mouse)
| Input | Action |
|---|---|
| **Space** | Open the case (auto after 2 s) |
| **Mouse move** | Move the hovering piece over the cake (raycast onto a plane above the tower top) |
| **Scroll / Q E** | Rotate the piece (yaw) |
| **W S** | Tilt the piece (pitch) |
| **Left click** | Drop |
| **Right-drag / A D** | Orbit the camera around the cake |
| **R** | Rig the current spin (Saboteur only, once per round) |
| **1–4** | Bet size: 0 / 10 / 25 / 50 |
| **F / G** | Bet STAND / FALL |
| **T** | Emote (cheer, gasp, point, laugh) |
| **Tab** | Scoreboard |
| **Esc** | Menu |

No pointer lock is needed. Because it's turn-based and click-driven, **mobile touch controls** are realistic soon after v1 (drag to move, two-finger twist to rotate, tap button to drop).

## 10. Arena & art direction
### Scene
- A cozy cartoon **kitchen** at night with warm lamp light. The table is round with a checkered tablecloth.
- A **birthday cake** on a glass cake stand that slowly rotates (6°/s). The cake top is the build surface.
- **2–6 bean-shaped chef avatars** sit around the table in their player colors. They react live: lean in during the hover, cheer on STAND, gasp, and take a cream pie to the face if they toppled it. The active player's chef stands up and "holds" the piece by puppeting the hover.
- A **neon casino sign** above the fridge flashes the current case result, and a coin counter sits on each chef's placemat.

### Style
- Same pipeline as Bonk Brawl: low-poly, `MeshToonMaterial` with a 3-step toon ramp, palette atlas, black outlines on pieces and chefs, squash & stretch, glTF/GLB + Draco, KTX2 textures. Target <15 MB total.
- Bright, saturated food colors against a darker kitchen so the tower pops.

### Palette
| Use | Hex |
|---|---|
| Frosting | `#FFB7D5` / shadow `#E58AB0` |
| Cake sponge | `#F6D59A` |
| Tablecloth | `#FF5A5F` + `#FFFFFF` checks |
| Kitchen wall (night) | `#2D2A44` |
| Lamp light | `#FFD9A0` |
| Coin gold | `#FFCF33` |
| UI ink | `#2D2A32` |

**Player colors** (chef hat, nameplate, bet chips): P1 `#FF5A5F` red · P2 `#3FA7FF` blue · P3 `#7BE07B` green · P4 `#FFC23F` yellow · P5 `#B07CFF` purple · P6 `#FF8BD1` pink.

## 11. Camera & game feel
- **Default view:** orbit camera at a 35° downward angle, auto-framed to the tower height. Spectators can orbit freely or lock to the active player's view.
- **Hover:** a drop-shadow ring plus a faint vertical guide line shows where the piece will land.
- **Settle:** the camera slowly pushes in, a drumroll builds, and the tower wobble is exaggerated by a slight slow-mo (0.7×) for the first second.
- **Topple:** a 0.3 s freeze frame, then pieces fly in slow-mo, a cake **SPLAT** with frosting particles, the slide whistle, and "TIMBER!" pop text. Pie to the toppler's face.
- **Stand:** a "ding!", coins fly from the center to the player's placemat, confetti scaled by the multiplier.
- **Case:** screen-edge glow in the rarity color. Legendary = jackpot lights + coin shower. Cursed = red flash + an ominous organ sting.

## 12. Audio
- **Music:** lounge-casino jazz (upright bass, brushes, vibraphone) in the lobby and between turns. It drops to just a tense hi-hat during the hover, and goes into a drumroll during the settle.
- **SFX:** case reel ticks (slowing), rarity stings, piece-specific impacts (chicken squeak, toaster clank, jelly *blorp*, fish slap, egg crack), cake stand hum, chef voices (gibberish "ooh!", "noo!", "yesss"), coin jingles, slide whistle on topple, crowd "OOOH".
- Volume sliders: Master, Music, SFX.

## 13. UI / screens
1. **Home:** bouncy "JELLY JACKPOT" logo, nickname field, **Create Room** / **Join Room**. The background is a tower slowly building itself and toppling on a loop.
2. **Lobby:** big room code + "Copy link" (`/r/ABCD`). Up to 6 chef cards (name, hat color, ready ✓). Host settings: rounds (Auto / 4–10), turn timer (8 / 10 / 15 s), Saboteur on/off, side bets on/off.
3. **Role reveal:** a private card flip: "You are a **BAKER**" (cream card) or "You are the **SABOTEUR** 😈" (red card + "Press R during someone's spin to rig it, once per round").
4. **In-game HUD:**
   - Top center: round (●●●○○○○) + turn-order strip of chef icons.
   - Center (during the spin): the case reel.
   - Top right: coin leaderboard.
   - Bottom center: current rule card + multiplier, placement timer ring, "Next up" piece.
   - Bottom right (when not your turn): bet panel (amount + STAND / FALL).
   - Left: tower height meter (cm) with the current "survive payout" preview.
   - Saboteur only: a small 😈 icon with "Rig ready" / "Used".
   - Feed: "🎰 Deniz opened **Moon Gravity ×2**", "💥 Ada TOPPLED it (−20)", "Bets: Sam 25 FALL ✅, Kai 10 STAND ❌".
5. **Accusation vote:** grid of chef cards. Click a suspect, see a 20 s timer, then votes are revealed one by one.
6. **Reveal:** the devil-hat moment, the rig replay list, and the hidden-bonus math.
7. **Podium:** top 3 on a giant cake. Last place gets a pie. Stats: placements survived, topples, best multiplier, bet profit. **Rematch** / **Back to lobby**.
8. **Settings (Esc):** camera sensitivity, invert orbit, volume, graphics quality, reduced flashing (tones down the Cursed/Legendary screen effects).

**Font:** a chunky rounded display font (e.g. "Fredoka" or "Baloo 2") for headings and HUD, the same as Bonk Brawl for a consistent hub feel.

## 14. Multiplayer & networking
### Architecture
- **Authoritative server** (Node.js + **Colyseus**). The server owns the turn order, case results, roles, coins, bets, and **all physics**.
- **Turn-based** makes this much simpler than Bonk Brawl: no client-side prediction is needed.
- **Hover:** the active player's client sends the hover pose (position + rotation) at **15 Hz**. The server validates it (inside the allowed area, above the drop height) and relays it so everyone sees the wobble live. The piece isn't a physics body yet.
- **Drop:** the client sends `drop` with the final pose. The server spawns the rigid body in **Rapier** and simulates at **60 Hz** until all bodies are asleep (or 4 s pass). It streams piece transforms at **20 Hz**. Clients interpolate with a ~100 ms buffer.
- **Between turns:** the tower is frozen (bodies asleep), so there's almost no traffic.
- **Topple detection** happens server-side: any piece's center goes below the stand-rim height.

### Secrets
- **Roles** are sent only to their owner via a private message, never in the shared state.
- **Rig** is a client → server message. The server swaps the pending case result **before** broadcasting it. No other client ever learns that a rig happened until the reveal.
- **Bets** are stored server-side and only broadcast after the result.

### Rooms
- 4-letter code via `ctx.codes.allocate(ctx.gameId)`, released in `onDispose`. Share link `/r/ABCD`.
- Max **6** clients. Late joiners spectate until the next match.
- Host leaves → host passes to the next player. Disconnect → 30 s reconnect grace (`allowReconnection`). If it's their turn, the piece auto-drops from the center when the timer runs out. If the Saboteur disconnects for good, the match continues and the reveal still happens.
- The room is destroyed 60 s after the last player leaves.

### State (conceptual schema)
- `Room`: phase (`lobby | roleReveal | spinning | placing | settling | result | voting | reveal | matchEnd`), round #, turn index, turnOrder[], timer, settings, hostId, standAngle, towerHeight.
- `Player`: id, nickname, color, coins, isActive, connected, stats (survived, topples, betProfit). **No role field in the shared state.**
- `Piece`: id, type, position, rotation, scale, ownerId, asleep.
- `CaseResult`: cardId, rarity, multiplier (the shared one is always the final, possibly rigged, card).
- `Bet` (server-only until the result): playerId, side, amount.
- Events (one-shot messages): `spinStart`, `spinResult`, `hover`, `drop`, `topple`, `survive`, `betResults`, `voteCast`, `reveal`, `emote`.

### Bandwidth
Hover is ~30 bytes × 15 Hz. During the settle, ~40 pieces × ~28 bytes × 20 Hz ≈ 22 KB/s for a few seconds. Trivial.

## 15. Tech & hub integration (planning only, no code yet)
| Layer | Choice |
|---|---|
| Language | TypeScript (client, server, shared constants) |
| Client build | Vite, `base: "/games/jelly-jackpot/"` |
| 3D | Three.js (`MeshToonMaterial`, GLTFLoader + Draco + KTX2Loader) |
| Physics | Rapier (`@dimforge/rapier3d-compat`), **server only** (the client just renders) |
| Networking | Colyseus server + `colyseus.js` client, rooms defined in `register(ctx)` |
| UI | HTML/CSS overlay on top of the canvas (the case reel is CSS-animated DOM) |
| Audio | Web Audio via Three.js Audio |

Hub folder (per `README.md` → "Add a game"):
```
games/jelly-jackpot/
  game.json            # id "jelly-jackpot", players "2–6", duration "~10 min", status "soon" until playable
  cover.svg            # 16:10 card art: a leaning cake tower + a gold case card
  server/index.ts      # export function register(ctx) → ctx.gameServer.define("jelly_jackpot", JellyRoom)
  client/vite.config.ts
  shared/              # balance constants, card table, piece table, message types
```

## 16. Balance numbers (starting values, tune in playtests)
| Parameter | Value |
|---|---|
| Starting coins | 100 |
| Rounds (auto) | 8 rounds for 2–4 players, 7 for 5, 6 for 6 |
| Turns per round | max(players, 4) |
| Case spin | 3 s (auto-spin after 2 s idle) |
| Placement timer | 10 s (Speed Round: 5 s) |
| Settle | until all bodies asleep, max 4 s |
| Sleep threshold | linear < 0.05 m/s and angular < 0.1 rad/s for 0.5 s |
| Gravity | −9.81 m/s² (Moon Gravity ×0.4) |
| Stand rotation | 6°/s (Spin Cycle 18°/s) |
| Cake top radius | 0.35 m. Pieces are 8–30 cm (toy scale feels right with physics) |
| Min drop height | 10 cm above the highest tower point |
| Survive payout | (10 + height_cm / 10) × multiplier |
| Topple penalty | −10 × multiplier, floor 0 |
| Side bets | 0 / 10 / 25 / 50, win pays 2× stake |
| Rarity odds | 55 / 25 / 12 / 5 / 3 (2 players: 52 / 25 / 12 / 5 / 6) |
| Saboteur rig | 1 per round, only during others' spins |
| Saboteur hidden bonus | +30 per topple on others' turns |
| Vote | correct majority: +40 per correct voter, Saboteur loses bonus. Wrong: Saboteur +60 |

**Match length check:** a turn is ~15–17 s, so a 4-turn round is ~65 s. 4 players: 8 rounds ≈ 8.5 min + ~1.5 min for role reveal, vote, and podium ≈ **10 min**. 6 players: 6 rounds × 6 turns × 16 s ≈ 9.5 min + 1.5 ≈ **11 min**.

## 17. Development milestones (for when building starts)
1. **M1 – Graybox stacking (single player):** cake stand + rotation, piece hover/rotate/drop, Rapier settle, topple detection, 5 box-ish pieces.
2. **M2 – Networked turns:** Colyseus room + codes, turn order, hover relay, server-side settle with transform streaming, 2–6 players.
3. **M3 – Case + scoring:** case reel UI, server RNG, all 21 rule cards, coins, height payout, round structure.
4. **M4 – Social layer:** secret roles, rig, side bets with hidden reveal, accusation vote, Saboteur reveal + rig replay list.
5. **M5 – Art & audio:** kitchen scene, chefs with reactions, 16 piece models with collision hulls, toon shading, splat/confetti VFX, music + SFX.
6. **M6 – UI & polish:** all screens, HUD, settings, slow-mo/freeze-frame juice, reduced-flashing option.
7. **M7 – Deploy & playtest:** add to the hub (`status: "live"`), play with friends, tune §16 (especially rarity odds and the rig risk/reward).

**Definition of "fun enough":** someone yells "THAT WAS RIGGED!" and it actually was, and the group immediately hits Rematch.

## 18. Stretch ideas (not in v1)
- **Double or nothing:** after seeing your case, pay 10 coins to re-spin. The new result must be kept.
- 2 Saboteurs at 5–6 players (they don't know each other).
- More Saboteur tricks: a secret "table bump" or a fake piece slipped into the next player's hand.
- Mobile touch controls.
- More themes: **Casino** (chips and dice on a spinning roulette wheel), **Bonk Brawl animals** as pieces on a rocking boat.
- A per-match "Tallest Tower" record and a cosmetic-hat unlock stored in localStorage.
- "Replay of the Topple" from three angles after a big fall.
