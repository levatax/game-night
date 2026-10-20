# Contract changes (append-only)

The shared contracts (`shared/constants.ts`, `shared/maps.ts`, `shared/protocol.ts`,
`shared/types.ts`, `server/schema.ts`) and the architect-written files listed in
`docs/ARCHITECTURE.md` §0 are frozen while builders work in parallel. If you need a change,
do NOT edit them: work around it inside your own folder (local constant, adapter, extra field
in your own types) and append one line below so the integrator can reconcile it later.

Format: `- [role] file: what you need changed and why (where your workaround lives).`

- [server] server/world/events.ts: `BroadcastWorldEvent` for powerUpWarning/powerUpSpawn/powerUpPickup was uninhabitable (the payload's own `type: PowerUpType` intersected with the `type` discriminator → never). Those three world events now carry the power-up kind as `powerUpType`, and the new `toMessage(ev)` rebuilds the exact protocol payload (`type: PowerUpType`) that BonkRoom broadcasts. Wire format unchanged; only server-internal typing.
- [client-audio] client/src/audio/AudioEngine.ts: PlayOptions says "HRTF on high quality, equalpower otherwise", but the engine has no quality input. Added `AudioEngine.setSpatialQuality(hrtf: boolean)` (default HRTF); client-app may call `audio.setSpatialQuality(s.quality !== "low")` where it applies the `quality` setting in App.applySettings. Optional: without it every quality level uses HRTF.
