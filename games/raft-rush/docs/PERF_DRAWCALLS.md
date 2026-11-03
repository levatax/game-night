# Raft Rush draw-call pass

Branch `perf/raft-rush-drawcalls`. Engine: three.js r186. Target: 1080p, high quality, reference desktop
class (GTX 1660 / RX 580, 6-core). No GPU is available in the build environment, so draw calls and triangles
are measured from the real scene objects and frame time is a documented model, not a capture.

## Budget

| layout | budget | measured (after) | |
| --- | --- | --- | --- |
| solo (5 tourists) | ≤60 draws, ≤250k tris | **42 draws, 118k tris** | pass |
| duel (6 tourists) | ≤60 draws, ≤250k tris | **57 draws, 211k tris** | pass |

The duel budget is the same as solo (it is a different layout, not a bigger machine target): two islands on
the same screen may not cost more than one, which is why the second pass below pushes the raft batches.

## How to measure

```bash
npx tsx games/raft-rush/client/dev/bench.mts          # solo, 5 tourists
npx tsx games/raft-rush/client/dev/bench.mts --duel   # duel, 6 tourists
npx tsx games/raft-rush/client/dev/bench.mts --json   # machine readable
npx tsx games/raft-rush/client/dev/breakdown.mts --duel  # per-object draw breakdown
```

The benchmark builds the real `IslandView`, `Sky`, `Fx` and five/six `Avatar`s or `Characters`, runs the
animator for two frames, then counts every renderable on layer 0 (main pass) and every shadow caster.
`before` reconstructs the old path (one mesh per animated bone, terrain chunks casting, small raft props
casting, every flora archetype in the shadow batch). `after` is the shipped path.

`frame ms* = 5.0 ms fixed 1080p cost + 0.045 ms/draw + 0.00002 ms/triangle` — indicative only, for
comparing two scenes on the same budget.

## Measured (seed 4471, high)

### Solo island, 5 tourists

| scene | main draws | shadow draws | total draws | main tris | shadow tris | total tris | frame ms* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 120 | 42 | 162 | 84k | 64k | 148k | ~15.3 |
| after | 38 | 4 | 42 | 85k | 33k | 118k | ~9.2 |

### Duel island, 6 tourists

| scene | main draws | shadow draws | total draws | main tris | shadow tris | total tris | frame ms* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 160 | 59 | 219 | 150k | 121k | 271k | ~20.3 |
| after | 52 | 5 | 57 | 151k | 60k | 211k | ~11.8 |

Shadow triangles are an upper bound: the counter does not apply the shadow camera's per-object /
per-instance frustum culling, which three.js does at draw time.

### Duel draw breakdown (after, 52 main)

| group | draws |
| --- | ---: |
| terrain (2 islands, one batch) | 1 |
| water | 1 |
| flora casters (trees/palms/rocks) | 1 |
| flora soft (bushes/berries, no shadows) | 1 |
| grass | 1 |
| landmarks + wreck lettering | 2 |
| landmark outline | 1 |
| spring water / sparkles | 6 |
| campfires (2 × 6) | 12 |
| rafts (2 × 4: hull batch, hull outline, ropes, slip + sparkles) | 10 |
| sky | 4 |
| characters (body/face/flash/outline batches, 6 avatars) | 4 |
| avatar shadows (one instanced pool) | 1 |
| nameplates | 6 |
| monsters / fx | 2 |

## What changed

| change | file | effect |
| --- | --- | --- |
| Character parts batched into one body + one flash + one face + one outline `BatchedMesh`; bone groups still drive per-instance matrices every frame | `client/src/characters/CharacterBatcher.ts`, `Characters.ts`, `Tourist.ts` | 5 tourists main pass 80 → 4 draws (body, flash, face, outline); shadow pass 30 → 1 |
| Seat tint moved to the per-instance colour (outline shader multiplies its uniform ink by `vColor`) | `render/Toon.ts` | one outline material/batch for all seats instead of one per seat colour |
| Terrain chunks batched into one `BatchedMesh` per island (per-chunk culling kept) | `render/island/Terrain.ts`, `IslandView.ts` | 4 → 1 draw solo, 12 → 2 duel |
| Terrain removed from the shadow pass; high shadow map 2048→1024 and extent 34→22 m (medium 30→22) | `render/island/IslandView.ts`, `render/quality.ts` | −4 shadow draws, −10k shadow triangles, tighter/cheaper shadow map |
| Water fragment shader distance LOD: past 60–100 m flat normal, foam breakup / fish bursts / rain ripples / glints fade out | `render/island/Water.ts` | less far-water fragment work, same 1 draw |
| **Raft hull, cross beams, provision crates and gourds in ONE `BatchedMesh` + one batched ink outline** (stage visibility via `setVisibleAt`, the pop-in animation still per instance) | `render/island/Raft.ts` | 9 → 4 draws per raft; duel rafts 18 → 8 |
| **All player contact shadows in one instanced pool** (`AvatarShadowPool`, per-instance alpha) | `characters/shadowBlob.ts`, `Avatar.ts`, `Characters.ts` | 6 avatar shadows → 1 draw |
| **Bushes (and berries) moved to a second flora `BatchedMesh` that does not cast shadows**; trees, palms and rocks still cast | `render/island/Flora.ts`, `IslandView.ts` | −23.5k shadow triangles on duel, +1 main draw |

## Budget trade accepted: bush contact shadows

Bushes are 1.1 m grass-level clumps (92–104 tris each, 240 of them on a duel map). They were 23,472 of the
41,346 flora shadow triangles but their cast shadow is a small dark patch that merges with the bush itself.
Dropping them from the shadow pass is what takes the duel from 252k to 211k triangles. Trees, palms and
rocks keep full shadows, and bushes are still drawn and still receive shadows. Reverting is one line
(`softMesh.castShadow = true`) at +23.5k shadow triangles.

## WEBGL_multi_draw fallback (measured)

`BatchedMesh` needs `WEBGL_multi_draw` for one draw call. Without the extension three.js r186 loops the
`BatchedMesh` draw ranges itself (`WebGLRenderer.js`, `object.isBatchedMesh` branch), i.e. one GL call per
frustum-visible range — effectively one per instance for flora. `bench.mts` reproduces that range count
exactly by calling `BatchedMesh.onBeforeRender` with the same camera:

| layout | main draws with the extension | without it (per-range loop) |
| --- | ---: | ---: |
| solo | 38 | **288** (+ shadow pass) |
| duel | 52 | **255** (+ shadow pass) |

So on a browser without `WEBGL_multi_draw` the batched client does **not** hold the 60-draw budget. The
extension ships with every Chromium/WebKit/Firefox build that has WebGL2 (2022+), and the game already needs
WebGL2-era features, so the exposure is old drivers / WebGL1-only hardware. If that must be supported, the
alternative is the pre-batch shape, which is draw-heavy but multi-draw-free: one `InstancedMesh` **per flora
archetype** (17 archetypes → 17 draws instead of ~660), terrain merged into one static mesh (1 draw, loses
per-chunk culling), rafts back to instanced parts (5 per raft) and characters to per-bone meshes
(16/avatar). That profile measures ~120 draws solo / ~170 duel — still over budget, which is why per-archetype
instancing alone does not replace multi-draw.

## Verification

Run on a fresh `npm ci --include=dev` (this sandbox's npm config sets `omit=dev`, so a plain `npm ci`
installs no tsc/vitest — CI must pass `--include=dev`):

- `npm run typecheck` → exit 0, no diagnostics.
- `npx vitest run games/raft-rush` → 900 passed, 19 failed; the same 18–19 tests fail on unmodified
  `origin/main` (e0e6abb). All failures are in `server/`, `shared/sim/` and `test/room-smoke` (room timers,
  match progression, generation time budget) and are 5 s-default-timeout / wall-clock flakes on this loaded
  2-vCPU sandbox, not client render code.
- `npx vitest run games/raft-rush/client` → 466 passed, 1 failed (the same `fpHolds.readability` timeout;
  it passes 34/34 in 31 s when given `--testTimeout=30000`).

## Remaining bottlenecks

1. **Campfires** — 12 draws for 56 triangles (2 × {3 flame cones, coal bed, smoke, embers}). Sharing the
   flame layers and the coal bed across fires (instanced, per-instance scale/colour) would take duel to
   ~49 draws and give real headroom for held props.
2. **Held props** are not batched; each player's tool adds 1–3 draws. Six players with tools add ~6–18
   draws on top of the table above, so a 6-player match with tools sits around 60–65 rather than 52.
3. **Nameplates** stay one sprite per player (unique nickname texture, per-avatar opacity).
4. **Frame time is modeled**, not captured; verify on the reference GPU with the in-game `Tab` stats or the
   dev island harness (`renderer.stats().calls/triangles`).
