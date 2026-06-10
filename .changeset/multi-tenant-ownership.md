---
"@eidentic/types": minor
"@eidentic/core": minor
"@eidentic/sqlite": minor
"@eidentic/libsql": minor
"@eidentic/postgres": minor
"@eidentic/server": minor
"@eidentic/a2a": minor
---

feat(security): multi-tenant session ownership, listSessions filtering, IDOR fix, A2A auth

Fix 1 — Session ownership: `SessionRecord` gains optional `userId`/`orgId` fields. All three
stores (sqlite/libsql/postgres) add migration v9 (sqlite/libsql) / v7 (postgres) to add
nullable `user_id`/`org_id` columns. `createSession` persists them; `getSession` returns them.
`Agent.query`/`resume` thread `userId`/`orgId` from `QueryOptions` into `Session.open` so
the owner is recorded on the first turn.

Fix 2 — `listSessions` by principal: `StorePort.listSessions` accepts optional `userId` and
`orgId` filter options. All three stores + `InMemoryStore` implement strict filtering (only
exact matches returned; sessions with no owner are excluded when a filter is provided).
Two new shared `storeConformanceCases` verify the behaviour.

Fix 3a — Server IDOR prevention: the `resume` and `events` routes now load the `SessionRecord`
and check that the authenticated principal's `userId`/`orgId` matches. Sessions with no
recorded owner (legacy / NoAuth) are allowed through for backward compatibility. Returns 403
Forbidden on mismatch.

Fix 3b — A2A auth + unguessable task IDs: `a2aRoutes` accepts an optional `auth.verify`
callback that guards the `POST /` JSON-RPC endpoint (the agent-card discovery endpoint stays
public). Task and message IDs now use `crypto.randomUUID()` instead of guessable
`Date.now()`-based strings.

All changes are backward-compatible: new fields are optional/nullable, auth is opt-in.
