---
"@eidentic/convex": minor
"@eidentic/types": minor
"@eidentic/core": patch
---

Add a component-first Convex adapter while preserving the existing app-functions/HTTP runner path.

`@eidentic/convex` now exports a Convex Component config at `@eidentic/convex/convex.config.js`
and a runtime helper surface at `@eidentic/convex/component` with `EidenticComponentStore`,
`EidenticComponentVectorStore`, `convexActionRunner`, and generated-ref extraction helpers. Component
tables are isolated and use singular snake_case names. The app-functions path remains source
compatible, but also gains explicit `@eidentic/convex/app-functions/*` exports plus table-name
factories for prefixed schemas.

Durable idempotency records now accept optional `scopeKey`, `sessionId`, and `ownerKey` metadata.
Eidentic core passes `sessionId` metadata for durable tool dispatch so Convex authorization hooks can
check structured ownership fields instead of parsing opaque keys.
