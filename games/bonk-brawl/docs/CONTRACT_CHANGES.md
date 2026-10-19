# Contract changes (append-only)

The shared contracts (`shared/constants.ts`, `shared/maps.ts`, `shared/protocol.ts`,
`shared/types.ts`, `server/schema.ts`) and the architect-written files listed in
`docs/ARCHITECTURE.md` §0 are frozen while builders work in parallel. If you need a change,
do NOT edit them: work around it inside your own folder (local constant, adapter, extra field
in your own types) and append one line below so the integrator can reconcile it later.

Format: `- [role] file: what you need changed and why (where your workaround lives).`

