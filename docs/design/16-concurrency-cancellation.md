# 16. Concurrency, Cancellation & Backpressure

[← 15. Data Governance](15-data-governance.md) · [Index](master-design.md) · Next: [17. Error Taxonomy →](17-error-taxonomy.md)

Added after adversarial review flagged a **blocker**: the spec defined CAS for two concurrent
block writes but had no model for a *hot agent* receiving parallel requests, retrieve-then-write
races, consolidation stampedes, streaming backpressure, or abort/rollback semantics. These are
exactly the things that break agents in production.

## 16.1 Concurrency model

The unit of isolation is the **session**. Within a session, the agent loop is single-threaded
(one turn at a time); concurrency happens *across* sessions and in *background jobs*.

- **Embedded mode:** one process, possibly many concurrent sessions. SQLite/libSQL is
  single-writer (WAL): writes serialize. Mitigation — **one DB file per user/agent** (the Turso
  "database-per-agent" pattern, §12.4) so write contention is per-subject, not global. Above N
  concurrent sessions, recommend the Postgres adapter.
- **Server mode:** many processes hit the same `agentId`. The agent is stateless to construct
  (§2.5); state is in the store. Contention is over **shared/org-scoped memory** (§6.7), not the
  agent object.

## 16.2 Shared-state contention (beyond CAS)

CAS (§6.3) handles two concurrent *writes* to one block, but not the **retrieve-then-write race**
(agent A reads a block, reasons, writes back — meanwhile B changed it) nor **thundering herd**
on a hot org block. Mechanisms:

- **Optimistic by default:** CAS on `version`; on conflict, the writer re-reads and the
  conflict policy (`reject|merge|append-only`, §6.3) applies. `appendBlock` (atomic, §0-C10) is
  contention-free for additive updates — the recommended path for high-concurrency shared blocks.
- **Advisory locks for hot scopes:** an optional per-scope advisory lock (`StorePort.withLock`)
  serializes critical sections (e.g., a supervisor rewriting a shared plan) when append-only
  isn't sufficient. Default off; opt-in for known-hot blocks.
- **Read snapshots:** retrieval reads a consistent snapshot; a write conflict is detected at
  commit, never silently lost.

## 16.3 Consolidation & background-job concurrency

Consolidation (§6.5) and skill evolution (§7.7) are durable background jobs (§9.8) on a queue
with strict controls (preventing the "consolidation stampede"):

- **Single-flight per scope:** at most one consolidation per `(scope)` runs at a time; concurrent
  triggers coalesce (dedup by scope key).
- **Concurrency cap:** a global worker limit; excess jobs queue.
- **Debounce:** consolidation for a scope is debounced (e.g., trailing 30s after last activity or
  on idle/session-close), not fired per event.
- **Poison-job handling:** a job that fails K times goes to a dead-letter with a trace; it never
  loops. Budget-capped (§11.2) so a runaway consolidation can't burn tokens.

## 16.4 Cancellation & abort semantics

`AbortSignal` (§3.4) is cooperative and well-defined at each boundary:

- **Mid-model-call:** the provider stream is aborted; partial output is preserved in the event
  log (failure-evidence, §4.6) and a checkpoint is written; result subtype `aborted` with partial cost.
- **In-flight tool call:** read-only/idempotent tools are simply abandoned (safe). A
  **destructive tool already dispatched cannot be un-sent** — the dispatcher records the
  idempotency intent (§9.3); on resume it checks completion rather than re-running, and surfaces
  an `aborted-mid-side-effect` status so the caller/agent can compensate. We never pretend an
  external side effect was rolled back.
- **Partial checkpoint:** abort always writes a checkpoint so the run is resumable or auditable.
- **Sub-agent tree teardown:** aborting a parent propagates the signal to all `spawn_agent`
  children (§8); each tears down with the same semantics. The shared cost budget is finalized.

```ts
const ctrl = new AbortController()
const run = agent.query(input, { signal: ctrl.signal })
// ctrl.abort() → graceful: stop stream, checkpoint, teardown children, emit `aborted`
```

## 16.5 Streaming backpressure

`query()` is a pull-based async generator, so a slow consumer naturally exerts backpressure on
event production. But the model stream and tool execution run ahead of consumption; without
bounds they buffer unboundedly. Controls:

- **Bounded internal queues** between (model stream → event emission) and (tool dispatch → event
  emission), with a high-water mark. When the consumer lags, token-delta events are **coalesced**
  (not dropped silently — coalesced deltas preserve content) and non-essential events may be
  sampled, while `result`/`tool.result`/checkpoints are never dropped.
- **Server (SSE):** standard HTTP backpressure; a disconnected client triggers `abort` (§16.4)
  unless the run is `durable` (then it continues to completion and is resumable).
- **Tool-execution concurrency cap** within a turn (read-only parallelism, §5.3) is bounded so a
  fan-out of tool calls can't exhaust resources.

## 16.6 Idempotency under concurrency

The `idempotency_keys` table (§12, §0-C2) is the concurrency-safe ledger: an `intent` row is
written transactionally before a destructive call; a concurrent duplicate sees the intent and
waits/short-circuits rather than double-executing. This makes retries (§9) and parallel resumes safe.

## 16.7 API surface

```ts
// advisory lock for a known-hot shared block
await store.withLock({ kind: 'org', orgId }, async () => { /* critical section */ })

// background job controls (defaults shown)
consolidation({ singleFlightPerScope: true, maxConcurrent: 4, debounce: '30s', maxRetries: 3 })
```

## 16.8 Traceability

- Hot-agent parallel requests (review blocker) → §16.1–16.2 session isolation + advisory locks.
- Last-writer-wins data loss → §6.3 CAS + §16.2 + §0-C10 atomic append.
- Consolidation stampede → §16.3 single-flight + debounce.
- Abort rollback ambiguity (review major) → §16.4 explicit per-boundary semantics.
- Streaming slow-consumer (review major) → §16.5 bounded queues + coalescing.
