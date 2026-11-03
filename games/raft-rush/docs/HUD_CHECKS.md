# HUD acceptance checks: night compass + storm clock

Measured 2026-11-03 in a real Chromium page (the built-in browser, `file://` bundle of the dev harness)
at 1280×720, using the shipped `Compass`, `DayClock` and `Banner` classes with the real `hud.css` / `ui.css`.
Not a unit test and not a reading of the string tables.

## Night compass: overlapping mark pairs ≤ 1

Harness: `client/dev/hud-check.ts` (also `hud-check.html` + `vite.hud-check.config.ts`).

- Scenario: 18 marks — 2 pings, camp, raft, spring, secret chest, cave, 4 teammates, 5 danger marks and
  2 resource marks — with bearings clustered around the centre and both edges (the night situation).
- For each of 24 yaw samples around the full circle: render, then take every visible `.rr-cmark` and build
  the union rectangle of its pin and its distance chip (`getBoundingClientRect`). Count pairs whose
  rectangles intersect by more than 0.5 px in both axes.
- Before the layout fix, all marks shared one row and the cluster produced several overlapping pairs.
  After the fix (`Compass.stack`): at most **0** overlapping pairs (target ≤ 1), **0** at yaw 0,
  **18/18** marks visible, 0 hidden. Rows: 2; crowded bearings fan sideways, non-key marks fall back from
  “Name · 9 m” to “9 m” or to the pin only, so no chip is drawn over another.

## Storm clock: HUD vs banner = 0 s

- Show the real storm-warning banner (`banner.stormWarning`, live duration) and update the real `DayClock`
  and banner from the same `HudModel` for `stormSecLeft` = 30, 29, 28, 27, 26, 25.
- Parse the seconds from `.rr-clock__storm-text` (“STORM IN 0:30!”) and `.rr-banner__main`
  (“STORM IN 30 SECONDS!”) at each step.
- Result: HUD and banner agree at every sample; **max |difference| = 0 s**. The banner now calls
  `Banner.syncCountdown()` from the HUD update, so both use `Math.ceil` of the same live `stormSecLeft`
  instead of freezing the event-time number.

## Rerun

```bash
npx vite --config games/raft-rush/client/dev/vite.hud-check.config.ts
# open http://localhost:5193/games/raft-rush/dev/hud-check.html and read #result
```

`#result` and `window.__hudCheck` carry `{ compass: { maxOverlappingPairs, atYawZero, minVisible, maxHidden },
storm: { samples, maxAbsDiffSec }, pass }`.
