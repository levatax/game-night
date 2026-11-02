# Raft Rush draw-call pass

Branch `perf/raft-rush-drawcalls` (base `main`). Engine: three.js r186. Target: 1080p, high quality,
1080p / 60 fps reference desktop class (GTX 1660 / RX 580, 6-core). No GPU is available in the build
environment, so draw calls and triangles are measured from the real scene objects and frame time is a
documented model, not a capture.

## How to measure

```bash
npx tsx games/raft-rush/client/dev/bench.mts          # solo, 5 tourists
npx tsx games/raft-rush/client/dev/bench.mts --duel   # duel, 6 tourists
npx tsx games/raft-rush/client/dev/bench.mts --json
```

The benchmark builds the real `IslandView`, `Sky`, `Fx`, five/six `Avatar`s or `Characters`, runs the
animator for two frames, then counts every renderable on layer 0 (main pass) and every shadow caster.
`before` uses the old path: one mesh per animated bone, per-seat outline materials, four/twelve terrain
chunk meshes, terrain in the shadow pass, small raft props casting shadows. `after` is the shipped path.

`frame ms* = 5.0 ms fixed 1080p cost + 0.045 ms/draw + 0.00002 ms/triangle` — indicative only, for
comparing the two scenes on the same budget.

## Measured (seed 4471, high)

### Solo island, 5 tourists

| scene | main draws | shadow draws | total draws | main tris | shadow tris | total tris | frame ms* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 123 | 44 | 167 | 85k | 64k | 148k | ~15.5 |
| after | 45 | 5 | 50 | 85k | 53k | 138k | ~10.0 |

### Duel island, 6 tourists

| scene | main draws | shadow draws | total draws | main tris | shadow tris | total tris | frame ms* |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| before | 167 | 64 | 231 | 151k | 121k | 271k | ~20.8 |
| after | 64 | 7 | 71 | 151k | 101k | 252k | ~13.2 |

Solo meets the budget (≤60 draws, ≤250k triangles). Duel is two full islands and is still above it; the
shadow triangles are an upper bound because the counter does not apply per-object frustum culling.

## What changed

| change | file | effect |
| --- | --- | --- |
| Character parts batched into one body + one flash + one face + one outline `BatchedMesh`; bone groups still drive per-instance matrices every frame | `client/src/characters/CharacterBatcher.ts`, `Characters.ts`, `Tourist.ts` | 5 tourists main pass 80 → 4 draws (body, flash, face, outline); shadow pass 30 → 1 |
| Seat tint moved to the per-instance colour (outline shader multiplies its uniform ink by `vColor`) | `render/Toon.ts` | one outline material/batch for all seats instead of one per seat colour |
| Terrain chunks batched into one `BatchedMesh` per island (per-chunk culling kept) | `render/island/Terrain.ts`, `IslandView.ts` | 4 → 1 draw solo, 12 → 2 duel |
| Terrain removed from the shadow pass; high shadow map 2048→1024 and extent 34→22 m (medium 30→22) | `render/island/IslandView.ts`, `render/quality.ts` | −4 shadow draws, −10k shadow triangles, tighter/cheaper shadow map |
| Small raft props (crates, gourds, slip) no longer cast shadows | `render/island/Raft.ts` | −3 shadow draws |
| Water fragment shader distance LOD: past 60–100 m flat normal, foam breakup/fish bursts/rain ripples/glints fade out | `render/island/Water.ts` | less far-water fragment work, same 1 draw |

## Remaining bottlenecks

1. **Duel layout** — 71 draws / 252k triangles (upper bound). Two islands double the sites (10 draws),
   campfires (12) and rafts (18). Batching raft hull/mast pieces and sharing campfire smoke point clouds
   would take it under 60.
2. **Held props** are not batched; each player's tool adds 1–3 draws. Six players with tools can add
   ~6–18 draws on top of the table.
3. **Nameplates and blob shadows** stay one draw per player (unique nickname texture, per-avatar opacity).
   An instanced blob-shadow batch would save 5–6 draws.
4. **Shadow pass** is now 5 draws solo / 7 duel (flora, landmarks, raft logs/beams, character batch).
   Flora is one draw but the biggest shadow triangle source; per-instance frustum culling handles most of it.
5. **No `WEBGL_multi_draw`** → three falls back to one GL call per `BatchedMesh` instance, so the draw
   reduction needs a browser with that extension (all current Chrome/Edge/Firefox WebGL2 builds have it).
6. **Frame time is modeled**, not captured; verify on the reference GPU with the in-game `Tab` stats or the
   dev island harness (`renderer.stats().calls/triangles`).
