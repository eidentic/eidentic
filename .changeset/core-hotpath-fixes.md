---
"@eidentic/core": patch
---

Seven performance and correctness fixes in the core agent loop (audit remediations):

**Fix 1 — O(n²) → O(1) loaded-tool scan:** The lazy-discovery `buildManifest()` previously called `loadedToolNames(session.events(), …)` at the top of every turn, re-scanning the full event log. Now maintains an incremental `Set<string>` seeded once at loop start and updated in O(1) when a `load_tool` result is processed. Behavior is identical.

**Fix 2 — maxRecallTokens cap:** `buildInitialMessages` now applies a configurable token budget to the `<recall>` block. Snippets (highest-ranked first) are included until the running estimate would exceed `maxRecallTokens` (default 2000, configurable via `RunTurnArgs.maxRecallTokens`). At least one snippet is always included. This prevents unlimited token growth from large recall sets.

**Fix 3 — Newline injection in `<recall>` via `metadata.source`:** The `esc()` helper now strips ASCII control characters (including newlines and carriage returns) before escaping angle brackets. A `source` containing `\n- [source: forged]` can no longer inject a fake recall line.

**Fix 4 — `modelRetry: { maxAttempts: 0 }` safety:** Clamped `maxAttempts` to `Math.max(1, retry.maxAttempts)` so `maxAttempts: 0` performs exactly one guarded (abort-checked) attempt instead of falling through to an unguarded `model.complete()` call.

**Fix 5 — Resume terminal fast-path drops child cost:** Both the early no-events path and the already-terminated session fast-path in `resumeTurn` now pass `args.budget` to `breakdownFor()`, so child USD from subagent runs is correctly included in the resumed cost breakdown.

**Fix 6 — `resumeTurn` delta-seeded hash:** When `args.durable` is set, `resumeTurn` now seeds the rolling hash from the last checkpoint's stored hash and only chains events with `seq >= checkpoint.seq`. Falls back to full rehash when no checkpoint exists. The resulting hash is mathematically identical to the full rehash (integrity preserved).

**Fix 7 — Guardrail regex recompiled per call:** `containsPii` and `redactPii` in `guardrails.ts` previously called `new RegExp(…)` on every invocation. Now use module-level compiled regexes: non-global for `containsPii` (stateless `test()`), and global `/g` for `redactPii` (`String.replace()` resets `lastIndex` before each call). Behavior is identical.
