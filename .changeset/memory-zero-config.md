---
"@eidentic/core": minor
---

Agent zero-config ergonomics: `query()`/`resume()` now lazily run `store.migrate()` on first
use (memoized), so callers no longer have to remember to migrate the store. When a `memory` is
configured but a query is made without `userId`, a one-time warning is logged (cross-session
memory is userId-scoped, so omitting it silently disables persistence). `modelId` already
defaults to `model.modelId`.
