# 9. Durable Execution

[← 8. Multi-Agent](08-multi-agent.md) · [Index](master-design.md) · Next: [10. Security & Sandbox →](10-security-sandbox.md)

A 99%-reliable-per-step agent succeeds on a 15-step task only 86% of the time; at 50 steps,
60%. Without durability every crash, rate-limit, or closed laptop destroys in-flight work,
and resumed runs duplicate side effects. Durable execution is a Constitution-#3 fundamental,
architected into the loop — not a plugin.

## 9.1 Event-sourced session as the substrate

A `Session` is an **append-only event log** (§3.2 events + checkpoints). The log backs **three
distinct projections** — they are *views over the same log, not the same bytes* (correction from
review, §0-C5):

1. **Replay state** — the deterministic, content-hashed subset used for resume. The hash
   **excludes** cost/timing/trace metadata (those live in event `meta`, §12), so two functionally
   identical runs hash identically and checkpoint dedup works.
2. **Trace** — replay state + ephemeral spans (timing, KV-cache hit-rate, memory ops), sampled and
   exported via OTel (§11.1). Not all of this is in the log; some is transient span data.
3. **Audit** — an immutable, redacted, separately-retained record (§15.7).

"Durable state" means projection (1). Conflating all three was the original over-claim; keeping
them as explicit projections preserves the elegance without the inconsistency.

```
session.events:  [ user, assistant, tool_call, tool_result, checkpoint, compaction, … ]
                                                  ▲ resume from last checkpoint
```

Stored as JSONL-on-disk (embedded) or rows (server). State must be **serializable** — no open
handles/connections persist; adapters re-establish them on resume.

## 9.2 The four durability components

Implemented behind `DurablePort`, woven into the loop stages (§2.6):

1. **Checkpointing.** After every LLM call completes and every tool returns, the full agent
   context (events, memory deltas, plan, sub-agent states) is checkpointed. Overhead is
   milliseconds. Checkpoints are content-addressed for dedup.
2. **Resumability.** Restart from the most recent checkpoint, not the beginning. Completed
   steps return cached results — no redundant model/tool calls (saves cost on recovery).
3. **Retry.** Transient failures retry with exponential backoff + jitter; rate-limit headers
   are parsed; a circuit breaker stops hammering a consistently-failing dependency.
4. **Idempotency.** Every side-effecting tool declares an `idempotencyKey` (§5.2). On resume,
   a tool whose key is already recorded as applied is **skipped, not re-run** — exactly-once
   semantics for payments, emails, writes. (The "don't send the email twice" guarantee.)

## 9.3 Idempotency in depth

The hard case: a tool call *succeeds* but the process crashes before its result is
checkpointed. On resume the loop would re-issue the call. Mitigation:

- The dispatcher writes an **intent record** (idempotencyKey + args hash) *before* executing
  and a **completion record** after. On resume: intent-without-completion ⇒ query the tool's
  idempotent endpoint (or its declared `check` probe) to learn whether it applied, rather than
  blindly re-running.
- Tools annotated `read-only` are always safe to re-run. `idempotent` tools are safe by key.
  `destructive` tools *must* provide a key (enforced at registration) — a destructive tool
  without an idempotency story is a configuration error.

## 9.4 Human-in-the-loop = durable suspension

A run can suspend indefinitely (tool approval, §5.7; permission "ask", §3.5) **consuming no
compute while waiting**, then resume with full context when the human responds. The pending
approval is a checkpoint; the resume injects the decision. This makes long-lived,
approval-gated workflows first-class without holding processes open.

## 9.5 Fast path vs durable path (latency honesty)

Durability adds per-step journaling overhead (~5–20 ms). For sub-100 ms interactive loops
that's prohibitive, so Eidentic exposes both, per-agent or per-run:

- **Fast path** (`durable: false`) — in-memory, no checkpoints; for short, cheap, retryable
  interactions. Crash = lost run (acceptable for a quick chat turn).
- **Durable path** (`durable: true`, default for multi-step/long runs) — full checkpointing.

The default is chosen by run shape: single-turn fast, multi-turn/tool-using/long durable.
This is the explicit answer to "durable execution adds latency" — it's a documented,
per-run trade-off, not a hidden tax.

## 9.6 Adapter model

`DurablePort` keeps the engine swappable (Constitution #1/#3):

- **In-house SQLite/libSQL checkpoint-resume journal** (**default**, embedded) — checkpoint/resume
  + idempotency built directly on our own event log + `idempotency_keys` ledger (§12). This is the
  only option that satisfies "embedded, zero-infra, in-process" — see the correction below. It is a
  *checkpoint/resume journal, not a general workflow engine* (so it does **not** violate the
  non-goal of reinventing durable execution; we are not building distributed sagas).
- **Pluggable durable-execution adapters** (opt-in, server) — Postgres-backed workflows,
  sidecar journal-replay, or full cluster orchestration are all supported via the `DurablePort`
  adapter model. Each runs as a separate process or requires external infra, so none can be
  the embedded zero-infra default.
- **In-memory** — tests and the fast path.

**Scope of the embedded default (be precise):** embedded "durable" = crash-resume + exactly-once
side effects via idempotency keys. It is **not** distributed-saga durability, multi-service
orchestration, or in-flight cross-version workflow migration (that's the adapters' job, and §19.2
defines version-skew handling). The 2026 consensus (AWS Durable Functions, Cloudflare Workflows,
Vercel Workflow DevKit) validates durable execution as a substrate; we adopt it via a port, with a
deliberately minimal, well-tested (§18.4 crash-injection) in-house default.

## 9.7 Resume & fork

```ts
// docs-check-skip: conceptual resume and future fork API sketch
// Resume a crashed/suspended run (same cwd/scope):
for await (const ev of agent.resume(sessionId)) { … }

// Fork: branch from a prior checkpoint without mutating the original:
const forked = await agent.fork(sessionId, { atCheckpoint })   // new sessionId
```

Fork copies the event log up to the checkpoint and assigns a new id (the original is never
modified) — enabling "try a different approach from step N" and time-travel debugging (§11).

## 9.8 Interaction with consolidation

Memory consolidation (§6.5) and skill evolution (§7.7) run as **durable background jobs** on
this same machinery — so they survive restarts, retry safely, and never block interactive
turns.

## 9.9 API sketch

```ts
new Agent({
  durable: durable({ adapter: 'dbos', checkpoint: 'per-tool', retry: { max: 4, backoff: 'expo' } }),
  // or durable: false for the fast path
})
```

## 9.10 Traceability

- Compounding step failure → §9.2 checkpoint/resume.
- Resume duplicating side effects → §9.3 idempotency (intent/completion records).
- Long approval workflows holding resources → §9.4 zero-compute suspension.
- "Durability adds latency" → §9.5 explicit fast/durable paths.
- Lock-in to one engine → §9.6 adapter model.
