---
"@eidentic/core": patch
"@eidentic/tools": patch
"@eidentic/memory": patch
"@eidentic/server": patch
"@eidentic/types": patch
---

Security hardening pass — five audit findings closed (A10, A7, B4, A4, A8, A9, A11).

**A10 — Recursive secret redaction in logger (`@eidentic/core`)**
`redactFields` now recurses into nested objects and arrays. String values that match `sk-…` or `Bearer …` patterns are redacted regardless of which key they appear under. Previous behaviour only checked direct top-level key names.

**A10 — Safe URL in error messages (`@eidentic/tools`)**
`web_fetch` error messages now use `safeUrlForError()` (new public export), which strips the query string and fragment before including a URL in an error message. This prevents API keys or session tokens passed as query parameters from leaking into logs via error text.

**A7 — Session-scoped idempotency keys (`@eidentic/core`)**
`ToolRegistry.runOne` prefixes every durable idempotency key with `${sessionId}:` when a session ID is present. Two sessions that call the same tool with identical arguments no longer share an idempotency ledger entry, eliminating cross-session result suppression and accidental run-skip.

**B4 — Post-call cost ceiling abort order (`@eidentic/core`)**
The agent loop now persists and checkpoints the assistant event *before* aborting on a cost-ceiling breach. Previously the abort could occur before the event was durably written, leaving the session log in an inconsistent state on resume.

**A4 — `Memory.eraseScope` covers separately-injected `GraphPort` (`@eidentic/types`, `@eidentic/memory`)**
`GraphPort` gains an optional `eraseScope?(scope): Promise<{ deleted: number }>` method. `Memory.eraseScope` calls it when the injected graph adapter provides the method, enabling full GDPR erasure for graph facts stored in a distinct adapter. Backward-compatible: adapters that do not implement the method see `graph: 0` in the erasure result.

**A8 — Reserve-then-settle quota to prevent concurrent burst (`@eidentic/server`)**
`InMemoryQuota.check()` now reserves an in-flight run count and returns a `QuotaReservation` token. Hard-run ceilings are evaluated against `committed + reserved`, so concurrent requests that have not yet settled are visible to each other and cannot collectively exceed the cap. `record(key, spend, reservation)` settles the reservation; `release(reservation)` frees it on the error/abort path. Backward-compatible: callers that omit the `reservation` argument continue to work.

**A9 — `skill_use` frames skill body in `<skill_reference>` delimiters (`@eidentic/core`)**
The `skill_use` tool now wraps the returned skill body in `<skill_reference>\n…\n</skill_reference>` before returning it to the model. This makes the boundary between operator-supplied skill content and the conversation unambiguous, reducing prompt-injection risk from malicious skill content.

**A11 — Construction-time warning for dangerous tools without a permissions policy (`@eidentic/core`)**
The `Agent` constructor now emits a `warn` log (`eidentic:permission`) when no `permissions` policy is configured but one or more dangerous tools (`bash`, `write_file`, `spawn_agent`, or any `sideEffect: "destructive"` tool) are registered. This is a one-time advisory at construction — no behaviour change.
