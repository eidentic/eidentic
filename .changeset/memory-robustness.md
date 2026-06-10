---
"@eidentic/memory": minor
---

fix(memory): robustness hardening — eraseScope best-effort, bounded maps, recency NaN guard, dedup O(n²) cap

Six audit fixes for `@eidentic/memory`:

- **FIX 1 (B-P1)** `eraseScope` is now best-effort: each subsystem (store, vector, graph) is
  attempted independently with individual try/catch; in-memory maps are always cleared in a
  `finally`-style block regardless of subsystem errors; an aggregate error is thrown naming
  every failed subsystem after all three attempts complete.

- **FIX 2 (coordinated)** Updated the vector call from `deleteScope` → `eraseScope` to match
  the `VectorPort` rename in `@eidentic/types`.

- **FIX 3 (B-P2/E-P1-2)** Added `maxInMemoryEntries` option to `MemoryOptions` to cap the
  `metadataStore` and `ingestedAtStore` maps. When the cap is exceeded, oldest entries are
  evicted first (Map insertion-order LRU); evicted ids are also removed from `scopedIds` to
  keep the erase index in sync. Default: unbounded (no behaviour change for existing callers).

- **FIX 4 (B-P2)** Recency decay now guards against NaN clocks: if `Date.parse(clock())` or a
  stored `ingestedAt` value is NaN, the recency factor falls back to 1.0 (similarity-only
  ordering) rather than propagating NaN scores. Added JSDoc note on the restart-degradation
  caveat to `RecencyOptions`.

- **FIX 5 (E-P2)** `deduplicateArchival` retains the existing O(n²) brute-force cosine scan
  (ANN replacement deferred — would change semantics). Added an n > 10_000 safety guard that
  short-circuits with a no-op to prevent runaway cost. Documented the tradeoff in JSDoc.

- **FIX 6 (C-P2)** `blockHealth` JSDoc now prominently documents the hidden write side-effect:
  calling `getAlwaysInContext` seeds missing configured blocks as a store write.
