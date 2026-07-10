---
"@eidentic/browser": minor
---

Add `withBrowserTools`, the secure browser lifecycle API. It creates one fresh
context/page per verified tenant run, installs context-wide request interception
before page creation, requests blocked service workers, rejects context reuse,
and closes pages, popups, and context on every completion path.

The caller-owned `browserTools(page, options)` API is now deprecated and requires
the explicit `unsafeSharedPage: true` compatibility opt-in. Migrate by wrapping
each agent run in `withBrowserTools` and binding `tenantId`/`runId` from the
verified request principal and session.
