# BONK BRAWL — Game Design Document (game1.md)

> A cartoony, physics-y, 3rd-person **dodgeball free-for-all** for 3–4 friends in the browser.
> Grab a ball, charge it, aim it, *BONK* your friends off a floating island. Catch their throws at the right moment to turn the tables.

## 1. Decisions (from the interview)
| Topic | Decision |
|---|---|
| Core skill | **Aim & timing**: leading moving targets, charge timing, catch timing |
| Players | 3–4 (works with 2 for testing) |
| Mode | Free-for-all |
| Match | Best of 5 rounds, ~60 s each → ~5 min per match |
| Theme | Cartoony & silly: low-poly, wobbly, bright |
| Mechanic | Dodgeball brawl with hit points + ring-outs |
| Camera | 3rd-person over-the-shoulder, mouse aim |
| Randomness | Light power-ups (rare, one on the map at a time) |
| Characters | 6 animal characters, identical base stats, one unique ability each |
| Joining | Host creates a room → 4-letter code / share link → nickname → play. No accounts |
| Tech | Three.js client, Node.js + Colyseus authoritative server, WebSockets |

## 2. Elevator pitch
Four goofy animals stand on a floating picnic island. Balls drop from the sky. You **hold left-click to charge** a throw, **release to fire** in a gravity arc, and try to hit someone. Each hit costs a heart and knocks the target back toward the edge. Fall off and you're out. The skill twist: **right-click at the exact moment a ball reaches you to CATCH it**. A catch costs the thrower a heart and gives you the ball. The last animal standing wins the round.

## 3. Why it's fun / where the skill is
- **Aim:** balls fly in arcs, so you have to lead targets and judge distance. No auto-aim and only a short trajectory hint.
- **Charge timing:** a fully charged throw is fast and hits hard, but it telegraphs your attack (glowing ball, sound) and leaves you slow while you charge.
- **Catch timing:** a 0.25 s catch window. Catch too early or too late and you're stuck in a 0.6 s whiff animation and get hit. Mind games follow: fake a throw, delay a throw.
- **Positioning:** stay away from the edges and use cover, but the balls spawn in the middle.
- **Silly moments:** ragdoll-ish knockback, squeaky sounds, "BONK!" pop-up text, and a victory dance over the loser's floating hat.

## 4. Core gameplay loop
1. **Lobby:** pick a character, press Ready.
2. **Round start:** 3-2-1 countdown. Players spawn at the 4 corners. 3 balls drop into the center (1 per player minus 1, so there's always contention).
3. **Fight (60 s):** grab, throw, dodge, catch, use abilities. Power-ups spawn occasionally.
4. **Sudden death (after 60 s):** the arena edges crumble inward ring by ring every 5 s, and an extra ball drops.
5. **Round end:** the last one standing is the winner. 3 s slow-mo on the final hit, then the scoreboard.
6. Repeat for 5 rounds → **match podium** → "Rematch" button (same room, same characters, everyone re-readies).

## 5. Rules & scoring
### Health
- Each player has **3 hearts** per round.
- **Hit by a live ball:** −1 heart plus knockback.
- **0 hearts:** you're knocked out and become a spectator (a ghost floats above with a free camera) until the round ends.
- **Ring-out:** falling off the island = instantly out, whatever your hearts.

### Ball states (classic dodgeball)
| State | Look | Behavior |
|---|---|---|
| **Neutral** | White/cream with a subtle bob | On the ground. Walk over it to pick it up (auto pickup) |
| **Live** | Glows in the thrower's color plus a colored trail | Thrown, airborne. Hits deal damage |
| **Dead** | Glow fades on first ground/wall bounce | Becomes neutral after landing. Can't hurt anyone |

- A ball **can't hit its own thrower** (immunity for 0.3 s after release, then only after a bounce).
- You can hold **only 1 ball** (2 with the Triple Shot power-up; see below).

### Points (accumulated across 5 rounds)
| Event | Points |
|---|---|
| Hit an opponent | +1 |
| Catch a live ball | +2 |
| Ring-out an opponent (last hit/knock before they fell, within 3 s) | +2 |
| Win the round (last standing) | +3 |

**Match winner** = most points after round 5. Tiebreaker: most round wins, then most catches.
The current point leader wears a **gold crown** visible to everyone, so the others gang up on them, which keeps matches close.

## 6. Controls (keyboard + mouse)
| Input | Action |
|---|---|
| **W A S D** | Move (camera-relative) |
| **Mouse** | Aim / rotate camera (pointer lock) |
| **Left click (hold)** | Charge throw (0 → 1.0 s); release to throw |
| **Left click (tap)** | Quick throw (weak, fast to release) |
| **Right click** | Catch (0.25 s window, 1.0 s cooldown) |
| **Space** | Jump |
| **Shift** | Dodge roll (i-frames 0.2 s, cooldown 1.5 s) |
| **E** | Character ability |
| **Q** | Emote / taunt (honk, wave, dance) |
| **Tab** | Scoreboard |
| **Esc** | Menu / release mouse |

Gamepad support is a stretch goal (sticks: move/aim, RT throw, LT catch, A jump, B roll, Y ability).

## 7. Characters (6, identical base stats)
All characters: move speed 6 m/s, jump 1.2 m, 3 hearts, same hitbox size (capsule r=0.45 m, h=1.4 m). This keeps hit fairness. Only the **ability** differs.

| Character | Look | Ability (E) | Cooldown |
|---|---|---|---|
| **Quacky** (duck) | Yellow duck, orange beak, tiny sailor hat | **Flap Dash**: quick 5 m air dash in any direction, usable mid-air | 6 s |
| **Hopsworth** (frog) | Green frog, bow tie, huge eyes | **Ground Pound**: leap, then slam down. Shockwave (r=3 m) knocks nearby players back with no damage | 9 s |
| **Mochi** (bear) | Round brown bear, pink cheeks | **Belly Bounce**: 1.5 s of being bouncy. Balls that hit you bounce off harmlessly (still dead) | 12 s |
| **Whiskers** (cat) | Grey tabby, smug face, bell collar | **Curveball**: the next throw curves toward where your crosshair drifts during flight (light steering) | 10 s |
| **Pip** (penguin) | Black/white penguin, red scarf | **Belly Slide**: 2 s fast, low slide. Ducks under head-height balls | 8 s |
| **Gruff** (goat) | White goat, curly horns, bell | **Headbutt**: short lunge (3 m). Hitting a player gives big knockback, no damage. Great for ring-outs | 9 s |

Balance notes: abilities are **utility or mobility, never direct damage**, so aim and timing always decide the kills. Cooldowns get tuned in playtests (milestone M7, §17).

## 8. Power-ups (light)
- **Spawn:** one at a time, on one of 3 fixed pedestals per map, every **20 s** (first at 15 s). It shows a 2 s warning shimmer before it appears.
- **Pickup:** walk into it. The effect applies to your **next throw** (or a short duration).

| Power-up | Icon / look | Effect |
|---|---|---|
| **Mega Ball** | Giant red beach ball | Next throw is a 2× size ball with 2× knockback. Still −1 heart |
| **Triple Shot** | Three small balls in a bundle | Next throw fires 3 balls in a 15° spread |
| **Boomerang** | Banana-shaped ball | Next throw returns to you after 1.2 s if it misses (can hit on the way back) |
| **Zoomies** | Sneakers with wings | +40% move speed for 6 s, with speed lines |

## 9. Arenas (3 maps, ~30 × 30 m, floating over a void)
All maps: roughly round or rounded-square islands, **no walls on the outer edge** (ring-outs), 2–4 pieces of low cover in the middle third, and 4 corner spawns.

1. **Picnic Plateau** (default): grassy floating island with fluffy clouds below. Cover: picnic table, giant watermelon slice, a picnic basket. Decor: checkered blanket, ants marching (cosmetic), a few trees on the far edges. Sky: sunny, soft blue gradient.
2. **Bath Time**: inside a giant bathtub floating in a cartoon bathroom. Floor: white tiles, **slightly slippery** (lower friction, +momentum). Cover: rubber duck, soap bar, shampoo bottle. Bubbles float up as decor. Void = drain water below.
3. **Cake Topper**: top tier of a giant birthday cake. Floor: pink frosting. Cover: candles (lit, cosmetic flames) and giant strawberries. In sudden death the cake edge crumbles into crumbs. Sky: dusk purple with balloons drifting.

Sudden-death crumble: each map's floor is built from **concentric ring segments**. They shake (0.8 s) then drop away with a wobbly fall animation.

## 10. Art direction
### Style
- **Low-poly + toon shading.** Chunky, rounded shapes, big heads (about a 1:1.5 head-to-body ratio), oversized hands/feet/wings.
- **Squash & stretch** on everything: characters squash on landing and stretch while jumping, balls squash on bounce.
- **Black outlines** (inverted-hull method, 2–3 px look) on characters and balls only, so they pop against the environment.
- Flat, saturated colors. **No realistic PBR textures.**

### Color palette
| Use | Hex |
|---|---|
| Grass | `#7BD389` / shadow `#4FA36B` |
| Sky top / bottom | `#6EC6FF` / `#D6F1FF` |
| Cloud | `#FFFFFF` / shadow `#CFE3F2` |
| Wood | `#C68B59` / dark `#8D5B3A` |
| Frosting pink | `#FFB7D5` |
| Bath tile | `#F4F7FA` / grout `#C9D4DE` |
| Neutral ball | `#FFF4DC` |
| UI accent | `#FFCF33` (yellow), `#FF5A5F` (red), `#2D2A32` (ink) |

**Player colors** (ball glow, trail, nameplate, outline tint): P1 `#FF5A5F` red · P2 `#3FA7FF` blue · P3 `#7BE07B` green · P4 `#FFC23F` yellow.

### Textures & materials
The goal is a tiny download (<15 MB total), so most color comes from **vertex colors / small palette atlases**, not big textures.

| Asset | Texture | Size | Notes |
|---|---|---|---|
| Toon ramp | 3-step grayscale gradient (dark / mid / light) | 4×1 px, nearest filter | Shared by all `MeshToonMaterial`s, which gives the cel look |
| Palette atlas | Grid of flat color swatches | 256×256 PNG | Low-poly models UV-map to swatches. One texture for all props |
| Grass top | Stylized painted grass with soft noise and tiny flower dots | 512×512, tiling | Faint, low contrast so balls stay readable |
| Wood planks | Hand-painted planks, 3 tones | 512×512, tiling | Picnic table, crates |
| Bath tiles | White square tiles with grout lines | 512×512, tiling | Plus a separate glossy normal map (256×256) for a subtle shine |
| Frosting | Swirly pink with sprinkles (decal) | 512×512 | Sprinkles as a separate decal texture |
| Ball | Cream base plus a stitched seam stripe | 256×256 | Glow comes from an emissive color, not the texture |
| Character faces | Eyes / mouth **sprite sheet** (8 expressions: idle, blink, angry, hurt, dizzy, happy, charging, KO "X X") | 512×512 | Swapped at runtime by changing UV offset. Cheap and very expressive |
| Sky | Vertical gradient (shader, no texture) plus cloud billboards | Clouds 512×256 PNG with alpha | |
| VFX sprites | Stars, puffs, "BONK!", "CATCH!", "OUT!", confetti, speed lines | One 1024×1024 sprite atlas | Pop-text is hand-lettered comic style |

- **Format:** PNG for authoring → **KTX2 (Basis)** for shipping, with WebP as a fallback. Models as **glTF/GLB** with Draco compression.
- **Sources:** custom Blender models, or a start from **CC0 packs (Kenney, Quaternius)** for props/animals, then recolored and given faces. Check each pack's license before use.
- **Lighting:** 1 directional "sun" (soft shadows, 1024 shadow map, only characters and balls cast shadows), 1 hemisphere light (sky/ground tint). Plus a **blob shadow** decal under each player and ball, so height reads clearly while aiming.
- **Post-processing (optional, can be toggled):** light bloom on live balls and the crown, plus FXAA.

### Character animations (per character, shared rig if possible)
Idle (bouncy), run, jump / fall / land (squash), charge-throw (wind-up, wobbling harder at full charge), throw, catch (success: big hug pose; fail: flail), hit-react (spin plus stars), knockback tumble, dodge roll, ability, emote ×3, victory dance, KO (pops into a puff of feathers/fur, leaving a ghost).

## 11. Camera & game feel
- **Over-the-shoulder** 3rd-person: offset right 0.6 m, up 1.6 m, back 4.5 m, FOV 70°. The camera collides with cover so it doesn't clip through.
- **While charging:** zoom FOV to 62° and slow movement to 60%. The crosshair tightens.
- **Crosshair:** small circle. A **short arc preview** (first ~25% of the trajectory) appears only at full charge. A skill helper, not an aimbot.
- **Hit feedback:** 60 ms hit-stop (freeze frame) on hit, small screen shake for the victim, "BONK!" pop text, star particles, a squeaky "bonk" SFX. The thrower hears a satisfying "ding".
- **Catch feedback:** brief slow-mo (0.15 s at 30% speed) for the catcher, "CATCH!" text, crowd "OOOH".
- **Knockback:** players fly in a comical arc, spinning, with a dust-trail puff on landing.
- **Final KO of a round:** 1 s slow-mo plus the camera cuts to the KO.

## 12. Audio
- **Music:** upbeat, goofy (ukulele, kazoo, xylophone, ~120 BPM) for the lobby and fights. Tempo ramps up in sudden death. Short jingles for round win / match win.
- **SFX:** ball squeak and boing (bounce), charge whoosh rising in pitch, throw "fwip", hit "BONK" (cartoon), catch "thwap" plus crowd "ooh", ring-out slide whistle down, character voices (quack, ribbit, grumble, meow, squawk, bleat) on hit / throw / emote, power-up sparkle, crumble rumble.
- **Sources:** CC0 libraries (Kenney audio, freesound CC0) or self-made. **Spatial audio** (Three.js `PositionalAudio`) so you can hear throws coming from behind you.
- Volume sliders: Master, Music, SFX.

## 13. UI / screens
1. **Home:** big bouncy logo "BONK BRAWL", nickname field, buttons **Create Room** / **Join Room** (code input). The background is an idle arena with animals bouncing around.
2. **Lobby:** room code shown big, with a "Copy link" button (`/r/ABCD`). Up to 4 player cards (nickname, character, ready ✓). Character select carousel showing a 3D turntable preview plus an ability description. Host-only settings: map (or random), rounds (3/5/7), power-ups on/off. Host presses **Start** when everyone is ready.
3. **In-game HUD:**
   - Top center: round timer plus round number (●●○○○).
   - Top right: mini scoreboard (4 rows: color dot, name, points, crown).
   - Bottom left: your hearts (3 big cartoon hearts) plus the ability icon with a radial cooldown.
   - Bottom center: charge meter (curved bar under the crosshair) plus a held-ball / power-up indicator.
   - Kill feed top left: "🦆 Quacky BONKED 🐸 Hopsworth", "🐻 Mochi CAUGHT 🐱 Whiskers' ball!"
   - Off-screen indicators: colored arrows at the screen edge pointing to incoming live balls (important for fair dodging in 3rd person).
4. **Round end:** 3 s card with the winner's animal doing a dance plus points earned this round.
5. **Match end:** podium (1st, 2nd, 3rd; 4th falls into the void, which is funny), stats (hits, catches, ring-outs, accuracy %), buttons **Rematch** / **Back to lobby**.
6. **Settings (Esc):** mouse sensitivity, invert Y, FOV, volume, graphics quality (Low/Med/High → shadow & post-FX toggles), show-arc-preview toggle.

**Font:** a rounded, chunky display font (e.g. "Fredoka" or "Baloo 2", Google Fonts) for headings, and the same font in regular weight for the HUD.

## 14. Multiplayer & networking
### Architecture
- **Authoritative server** (Node.js + **Colyseus**). The server owns the truth: positions, balls, hits, hearts, scores.
- **Client** (browser, Three.js) sends **inputs only** (move vector, look yaw/pitch, buttons, and a sequence number) at 30 Hz.
- **Server tick:** 30 Hz simulation. State patches are sent to clients at 20 Hz (Colyseus schema delta encoding).
- **Physics:** **Rapier** (WASM, runs in Node and the browser) for the server simulation of characters (kinematic character controller) and balls (rigid bodies). The client runs the same Rapier setup for local prediction.

### Lag handling (for friends on reasonable connections, target <120 ms)
- **Own movement:** client-side prediction plus server reconciliation (replay unacknowledged inputs).
- **Other players:** snapshot interpolation with a ~100 ms buffer.
- **Throws:** the client spawns a **predicted ball** instantly for responsiveness. The server spawns the real one, and the client blends to it.
- **Hits:** decided by the server on the server's ball vs the server's player positions.
- **Catches (the critical timing mechanic):** server-side **lag compensation**. When a catch input arrives, the server rewinds the ball's position by the catcher's half-RTT (capped at 150 ms) and checks whether the ball was within catch range (1.2 m in front of the player) during the 0.25 s window.

### Rooms
- `Create Room` → the server generates a 4-letter code (no ambiguous letters: no O/0/I/1). Room URL `https://<host>/r/ABCD`.
- Max 4 clients per room. The 5th gets "Room full". Late joiners during a match wait in the lobby or spectate until the next match.
- If the host leaves, host status passes to the next player. If a player disconnects mid-round, there's a 20 s reconnect grace window (Colyseus `allowReconnection`). After that they count as KO for that round.
- The room is destroyed 60 s after the last player leaves.

### State (conceptual schema)
- `Room`: phase (`lobby | countdown | playing | suddenDeath | roundEnd | matchEnd`), round #, timer, mapId, settings, hostId.
- `Player`: id, nickname, character, color, position, velocity, yaw, hearts, points, state flags (charging, catching, rolling, KO), ability cooldown, heldBall, activePowerUp, stats.
- `Ball`: id, position, velocity, state (`neutral | live | dead`), ownerId, size, type.
- `PowerUp`: id, type, pedestalIndex, active.
- Events (one-shot messages, not state): `hit`, `catch`, `ringOut`, `ko`, `roundWin`, `emote`, used to trigger VFX/SFX.

### Hosting
- One small VM/container (e.g. **Fly.io** or Render, 1 shared CPU / 512 MB is plenty for several rooms), in the region closest to the group.
- The same server serves the static client build (or the client goes on Netlify / Cloudflare Pages with WebSocket to the game server).
- HTTPS + WSS (TLS required for pointer lock and modern browsers).
- Estimated bandwidth: ~4 players × ~3 KB/s ≈ under 15 KB/s per room. Trivial.

## 15. Tech stack summary (planning only, no code yet)
| Layer | Choice |
|---|---|
| Language | TypeScript (client, server, shared types) |
| Client build | Vite |
| 3D | Three.js (`MeshToonMaterial`, GLTFLoader + Draco + KTX2Loader) |
| Physics | Rapier (`@dimforge/rapier3d-compat`) on both sides |
| Networking | Colyseus server + `colyseus.js` client |
| UI | Plain HTML/CSS overlay (or a light framework like Preact) on top of the canvas |
| Audio | Three.js Audio / PositionalAudio (Web Audio API) |
| Assets | Blender → glTF/GLB, textures → KTX2 |
| Hosting | Fly.io / Render (Node server + static files) |

Suggested repo layout (for later):
```
/client   – Vite + Three.js game client
/server   – Colyseus rooms, Rapier simulation
/shared   – constants (balance numbers), types, message definitions
/assets   – source .blend, textures, audio (raw)
```

## 16. Balance numbers (starting values, tune in playtests)
| Parameter | Value |
|---|---|
| Move speed | 6 m/s (3.6 while charging) |
| Throw speed | quick tap 16 m/s → full charge 34 m/s |
| Charge time to full | 1.0 s |
| Ball gravity | 1.0× world gravity (−20 m/s², slightly floaty-cartoony) |
| Ball radius | 0.25 m (Mega: 0.5 m) |
| Knockback on hit | 6 m/s horizontal + 4 m/s up (×1.5 at full charge, ×2 Mega) |
| Catch window / cooldown | 0.25 s / 1.0 s, whiff recovery 0.6 s |
| Catch range | 1.2 m sphere in front of chest |
| Dodge roll | 4 m distance, 0.2 s i-frames, 1.5 s cooldown |
| Balls in arena | players − 1 (min 2) + 1 at sudden death |
| Ball respawn | if a ball falls off the island, a new one drops at center after 3 s |
| Round time | 60 s + sudden death (rings drop every 5 s) |
| Power-up interval | first 15 s, then every 20 s |

## 17. Development milestones (for when building starts)
1. **M1 – Graybox single-player:** a capsule moves, the camera works, pick up / charge / throw a ball with an arc, bounce/dead logic, a ring-out plane.
2. **M2 – Networking:** Colyseus rooms, room codes, 2–4 capsules moving with prediction/interpolation, server-side balls.
3. **M3 – Combat rules:** hits, hearts, knockback, catches with lag compensation, dodge roll, rounds, scoring, sudden death.
4. **M4 – Characters & power-ups:** 6 abilities, 4 power-ups, character select.
5. **M5 – Art & audio pass:** toon shading, models, face sprites, the 3 maps, VFX, SFX, music.
6. **M6 – UI & polish:** all screens, HUD, settings, off-screen ball indicators, hit-stop, slow-mo.
7. **M7 – Deploy & playtest:** host on Fly.io, play with friends, tune §16 numbers, fix the jank.

**Definition of "fun enough":** 4 friends play 3 matches in a row voluntarily and someone yells after a catch.

## 18. Stretch ideas (not in v1)
- Gamepad support, mobile touch controls.
- Bots to fill empty slots.
- More maps (Pirate Ship deck, Snow Globe with slippery ice).
- Cosmetic hats unlocked by stats (stored in localStorage).
- Replay of the round's best catch ("Play of the Round").
- Team modes (2v2, 1-vs-all "Boss" round with a giant player).
