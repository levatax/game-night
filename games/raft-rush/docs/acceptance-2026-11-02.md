# Raft Rush acceptance run — 2026-11-02

Branch `devops/raft-rush-acceptance`, forked from the staging commit `e0e6abb` (branch `feat/raft-rush-fun`).
Staging: <https://goost-game.uwmttz.easypanel.host> (project `goost`, service `game`, healthy at the time of the run).
No balance, difficulty or gameplay rule was changed. The only non-test change is the measurement statistic in
`shared/island/generate.test.ts` (see §4).

## 1. Run the harness

```bash
RAFT_ACCEPT=1 npx vitest run \
  games/raft-rush/server/room/botAcceptance.test.ts --disableConsoleIntercept
```

Knobs: `RAFT_ACCEPT_RUNS` (120), `RAFT_ACCEPT_ISLANDS` (40 → 3 attempts each), `RAFT_ACCEPT_NOVICE_RUNS` (20),
`RAFT_ACCEPT_SHARD` / `RAFT_ACCEPT_SHARDS` (nightly split). CI: `.github/workflows/acceptance.yml` (4 shards +
an isolated perf job, nightly 02:41 UTC).

## 2. Gates (120 matches on 40 islands × 3 attempts; 20 novice matches)

| Gate | Target | Measured | Verdict |
|---|---|---|---|
| A. 2 bots + 1 idle human | 0 launches / 20 | **12 / 20 launched = 60 %** (Wilson 95 % 39–78 %) | **FAIL** |
| B. bot-only launch median | 440–460 s | **~323 s** (per-shard medians 321.5, 322, 324, 326) | **FAIL** |
| B. early launches < 440 s | 0 | **115 of 115 launches** | **FAIL** |
| B. late launches > 460 s | 0 | 0 | pass |
| C. storm HUD vs banner | 0 s difference | 0 differing ticks over 1 561 clock ticks | pass (contract) |
| D. tutorial / first choice | none / ≤ 20 s | no tutorial; first choice 11.5 s (10 s landing + 1.5 s move tip) | pass |

B totals: 115 / 120 launched = 95.8 % (Wilson 95 % 90.6–98.2 %). With `ICC = 0.1` and 3 attempts per island the
design effect is 1.2, so the honest interval is ±4.2 → 91.7–100 % and the effective sample is ≈100 runs, not 120.
Outcomes: 115 launched, 3 wiped, 2 storm.

The two failing gates are real product findings, not harness noise: the bot team finishes the raft roughly two
minutes before the intended window, and an idle human is carried to a launch in 60 % of novice matches.
Both are balance/design decisions (bot pacing, idle-player handling); this branch only reports them and leaves the
game rules untouched.

## 3. Cost and render budget

| Metric | Value | Note |
|---|---|---|
| Server tick, idle machine | 0.045 ms mean | headless acceptance batch, 12 matches |
| Server tick, loaded host | 0.71–1.02 ms mean, 58–68 ms worst | 34 load avg from other work; not a game regression |
| Process RSS | 144–188 MB | whole vitest worker after a batch |
| Draw objects, solo island | 27 | budget ≤ 50 |
| Triangles, solo island | 29 990 | budget ≤ 138 k |
| Draw objects, duel island | **52** | **over the 50 budget by 2** |
| Triangles, duel island | 51 524 | under budget |
| FPS | **not measured** | no GPU in this environment; needs a real browser run |

Reproduce the render numbers with `npx tsx scripts/measure-render-budget.ts`. The Technical Artist's 50 draw /
138 k triangle result can only be confirmed after their branch is merged; these numbers are the `e0e6abb` baseline.

## 4. CI perf test: keep the budget, isolate the measurement

Same test, same machine, different load:

| Conditions | solo | duel | budget (solo/duel) |
|---|---|---|---|
| full suite (many files in parallel) | 233.6 ms | 594.6 ms | 120 / 240 ms |
| isolated, host still busy | 192.5 ms | 468.6 ms | 120 / 240 ms |
| isolated, quiet host | **55.4 ms** | **70.0 ms** | pass |

The 174.5 ms CI failure is CPU contention, not generator cost: the per-generation samples on a busy host ranged
from 20 ms to 375 ms (p90). Raising the threshold would hide a future real regression and still be flaky.
Decision:

1. Keep the 40 ms / 80 ms budget with ×3 CI slack.
2. Assert the **median** of warmed-up generations (robust to a GC pause or a noisy neighbour), as done here.
3. Run it in its own CI job with `--no-file-parallelism` (`.github/workflows/acceptance.yml`, job `perf`).
4. The default `npm test` still runs it, but that copy is informational under load; the gate is the isolated job.

## 5. Staging

- `GET /healthz` → 200; client loads at `/games/raft-rush/` (lobby, name field, Start an island, controls).
- Joined room `QKFD` with the Colyseus client against the staging URL: `welcome` (protocol 1, seed 39094,
  solo) → `matchStart` with participants `[human, bot-1, bot-2]` → phase `landing` → `playing`, clock ticking
  (`clockTicks` 58, day 1) after the landing. A lone human gets 2 helper bots, as designed.
- Not verified live: the storm HUD/banner once at the end of a full match (checked by contract, not observed),
  FPS, and a real GPU frame time.

## 6. Pre-existing failures on the base commit

Running the full suite at `e0e6abb` (without this branch's files) leaves 21 unrelated failures
(KASALA wheel, RaftRoom lobby/lifecycle, room smoke, bot stand-ins, loot, monsters, weather, island rasters and
sim). They come from the base commit; the Gameplay Programmer's uncommitted work in their worktree fixes several
of them. The acceptance harness does not depend on that suite and runs on its own.
