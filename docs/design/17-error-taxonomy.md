# 17. Error Taxonomy & Recovery

[← 16. Concurrency](16-concurrency-cancellation.md) · [Index](master-design.md) · Next: [18. Testing & Conformance →](18-testing-conformance.md)

Added after adversarial review flagged a **major**: `TerminationSubtype` lumps everything into a
single `error` bucket, but error recovery (§3.7), observability (§11), and durability (§9) all
need to know *what kind* of error occurred and whether it's retryable. A typed taxonomy is the contract.

## 17.1 Error hierarchy

All errors extend `EidenticError` (in `@eidentic/types`), carrying a stable `code`, a
`retryable` flag, a `class`, and structured context (never raw secrets):

```ts
// docs-check-skip: conceptual error taxonomy, not an exported implementation
abstract class EidenticError extends Error {
  code: string                 // stable, documented, e.g. 'provider.rate_limited'
  class: ErrorClass
  retryable: boolean
  context: Record<string, unknown>   // redacted per §15
  cause?: unknown
}

type ErrorClass =
  | 'provider'     // model/provider failures
  | 'validation'   // schema / input validation
  | 'permission'   // denied by permission/guardrail layer
  | 'sandbox'      // sandboxed execution failure/violation
  | 'tool'         // tool execution error (user code)
  | 'memory'       // memory store/retrieval/consolidation
  | 'store'        // relational/vector store failure
  | 'durable'      // checkpoint/resume/idempotency failure
  | 'budget'       // cost/turn/wallclock cap hit
  | 'governance'   // erasure/retention/residency violation
  | 'protocol'     // MCP/A2A transport error
  | 'cancelled'    // abort
```

## 17.2 Retryability classification

Each error declares retryability so the loop (§3.7), durable retries (§9.2), and the cost
governor (§11.2) act correctly:

| Class | Typical codes | Retryable? | Recovery |
|-------|---------------|-----------|----------|
| `provider` | `rate_limited`, `overloaded`, `timeout` | yes (backoff+jitter) | retry → failover model (§3.7) |
| `provider` | `auth`, `context_too_long`, `content_filter` | no | surface / compact / fail |
| `validation` | `tool_input_invalid` | once (repair pass, §3.7) | re-prompt with schema+error |
| `permission` | `denied`, `needs_approval` | no (route to human) | `ask` gate (§3.5/§10.4) |
| `sandbox` | `violation`, `oom`, `timeout` | no | fail tool, evidence in context |
| `tool` | user-thrown | per `onToolFailure` hook | retry/substitute/surface |
| `memory`/`store` | `conflict` (CAS), `unavailable` | conflict→re-read; unavailable→backoff | §6.3 conflict policy |
| `durable` | `checkpoint_failed` | yes | retry; if persistent → abort safely |
| `budget` | `max_cost`/`max_turns`/`max_wallclock` | no | terminate with matching subtype |
| `governance` | `erasure_pending`, `residency_violation` | no | block operation |
| `cancelled` | `aborted` | no | graceful teardown (§16.4) |

**Progress-gated retry (§3.4):** even a `retryable` error only retries if there's evidence of
progress; otherwise it escalates — preventing the $47K retry-storm.

## 17.3 Mapping to TerminationSubtype

The single `error` subtype (§3.2) is replaced by class-bearing results: a run that ends in
failure emits `result` with `subtype` derived from the terminal error class
(`max_cost`/`max_turns`/`permission_denied`/`error`) plus an `error: { code, class, retryable }`
object and full cost/usage. Consumers switch on `class`, not on string matching.

## 17.4 Error flow into observability

Every error is an OTel span event with `code`, `class`, `retryable`, and the redacted context
(§15.5). A run's trace shows the *recovery path* (retry N, failover, repair) not just the final
failure — meeting the "<4-min time-to-root-cause" target (§11.1). Errors are preserved in the
agent's context as failure-evidence (§4.6) so the model adapts rather than repeating.

## 17.5 User-facing vs internal

- **Internal** errors carry full (redacted) context for operators/traces.
- **User-facing** surfacing is via a stable `code` + safe message; raw provider errors and
  stack traces are never leaked to end users or the model verbatim (injection/safety, §10).
- A documented, stable **error-code registry** ships with the SDK (semver-stable, §13.2) so users
  can branch on codes without breakage.

## 17.6 Traceability

- §3.7 recovery → needs §17.2 retryability classification.
- "Can't tell why my agent did X" → §17.4 recovery path in traces.
- $47K retry storm → §17.2 progress-gated retry on retryable errors.
- Hard "tool not found" crashes → §17.1 typed, recoverable errors fed back to the model.
