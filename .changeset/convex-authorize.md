---
"@eidentic/convex": minor
---

Add an optional `authorize` hook to secure the Convex adapter's function handlers.

The new `eidenticFunctions({ authorize })` factory builds all 31 store/vector functions with an
`EidenticAuthorize` hook that runs (and is awaited) before every handler body — throw to deny the
op, return to allow it. The hook receives the Convex `ctx` (so it can call
`ctx.auth.getUserIdentity()`) plus `{ op, args }`, enabling authentication and `scopeKey` ownership
checks. The functions stay public (the runtime calls them over HTTP), so authorization happens
in-function rather than by making them internal.

Non-breaking: the existing `export * from "@eidentic/convex/server"` / top-level exports are
unchanged and remain unauthenticated — suitable only for trusted, single-tenant deployments. Both
`eidenticFunctions` and the `EidenticAuthorize` type are re-exported from `@eidentic/convex`.
