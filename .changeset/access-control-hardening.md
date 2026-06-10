---
"@eidentic/server": patch
"@eidentic/core": patch
"@eidentic/nextjs": patch
---

Close three access-control gaps found in security review.

**Finding #1 (Critical) — IDOR on `/query`:** The `/query` route now performs the same `checkOwnership` check as `/resume` and `/events` before opening an SSE stream, preventing a caller from forwarding another tenant's `sessionId` to read or write into their session. Defense-in-depth: `Session.open` in `@eidentic/core` now also rejects opens where the caller's `userId`/`orgId` does not match the stored session owner, covering NextJS, A2A, and MCP entry points that bypass the HTTP server.

**Finding #4 (High) — Quota reservation leak:** `quota.check()` on `/query` and `/resume` is now called _after_ body validation and agent resolution, so malformed-JSON `400` and unknown-agent `404` responses no longer consume an in-flight reservation slot. `InMemoryQuota` gains a `reservationMaxAgeMs` option (default 5 min) and a background sweep that automatically releases reservations that were never settled, preventing permanent capacity exhaustion from crashes or missed `release()` calls.

**Finding #8 (Medium) — `withEidentic` body/identity:** `withEidentic` now rejects requests whose `Content-Length` exceeds `maxBodyBytes` (default 1 MB) with HTTP 413 before parsing the body. A new `identify(req)` option lets callers derive `userId`/`orgId` server-side from the authenticated session; the returned values override any client-supplied identity. JSDoc emphatically notes that `withEidentic` performs no authentication and that identity must come from the app's session, not the request body.
