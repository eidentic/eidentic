---
"@eidentic/better-auth": minor
---

New package: `@eidentic/better-auth` — better-auth → AuthPort adapter.

Turns a user's better-auth 1.6.x server instance into a Eidentic `AuthPort`
so `@eidentic/server` and `@eidentic/studio` get real session authentication
without any DB/schema wiring in the adapter itself.

- `betterAuthPort(auth, opts?)` — accepts a real better-auth instance
  (`{ api }`) or any `BetterAuthLike` structural fake; returns an `AuthPort`.
- Maps `getSession` result: `user.id → userId`, `session.activeOrganizationId → orgId`.
- Optional `principalFrom` hook for custom field mapping.
- Fail-closed: `getSession` errors → `null` (401), never 500.
- `better-auth` is an optional peer dependency; no DB or provider code is bundled.
