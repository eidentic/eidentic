# 18. SDK Testing & Adapter Conformance

[← 17. Error Taxonomy](17-error-taxonomy.md) · [Index](master-design.md) · Next: [19. Schema & Prompt Evolution →](19-schema-prompt-evolution.md)

Added after adversarial review flagged a **major**: the spec describes *user* eval (§11.3) but
never how **Eidentic itself** is tested, nor how a community adapter (a third-party pgvector or
durable adapter) is proven correct. For a framework whose pitch is "stable + production-grade,"
the test strategy is part of the product.

## 18.1 In-memory fakes for every port

Every port (`ModelPort`, `StorePort`, `VectorPort`, `DurablePort`, `SandboxPort`, `TracerPort`,
`AuthPort`, `GovernancePort`, `SecretsPort`) ships with an **in-memory fake** in `@eidentic/types`'
test utilities. This makes the core testable with zero infra and gives users a fast harness for
their own agents. A `MockModel` returns scripted completions/tool-calls so the loop is
deterministically testable.

## 18.2 Property-based tests for the hard invariants

The subsystems most likely to be subtly wrong get property tests (fast-check):

- **CAS / conflict policy (§6.3):** for any interleaving of concurrent block writes, no update is
  silently lost; the declared policy (`reject|merge|append-only`) holds.
- **Idempotency / exactly-once (§9.3, §0-C2):** for any crash point (before/after execute,
  before/after checkpoint), a destructive tool applies **exactly once** across resume.
- **Replay determinism (§9.1):** replaying an event log reconstructs identical *replay state*
  (the hashed subset, excluding cost/timing) — fuzz with injected clock/random and assert
  divergence is impossible inside step boundaries.
- **Context assembly stability (§4.3):** for an unchanged stable prefix, the serialized cache
  region is byte-identical (KV-cache hit-rate invariant); golden/snapshot tested.
- **Compaction reversibility (§4.4):** offloaded content is always re-expandable via its handle;
  pointers are never lost.
- **Erasure completeness (§15.3):** after `erase(subject)`, no PII-classified content for that
  subject is recoverable from any store.

## 18.3 Adapter conformance suite

Every adapter — first-party or community — must pass a published **conformance suite**
(`@eidentic/conformance`). This is how "swap any infrastructure" (Constitution #1) stays honest:

```ts
import { runStoreConformance } from '@eidentic/conformance'
runStoreConformance(() => new MyPgStore(testDsn))   // must pass to be "Eidentic-certified"
```

Suites assert the *contract*, not the implementation:

- **StorePort:** CRUD + scope isolation (no cross-scope leakage), CAS semantics, atomic
  `appendBlock`, `withLock`, `eraseByScope` completeness, migration idempotency, FTS5/lexical search.
- **VectorPort:** upsert/search/delete-by-scope, dimension handling, hybrid + RRF.
- **DurablePort:** checkpoint/resume, exactly-once via idempotency ledger, crash-injection.
- **SandboxPort:** isolation (no host fs/network escape), resource limits, timeout.
- **AuthPort / GovernancePort / SecretsPort:** their respective contracts.

A badge/registry lists certified adapters. An adapter that can't `eraseByScope` is not certified
for PII workloads (§15.3).

## 18.4 Replay & crash-injection harness

A deterministic harness drives the loop with a `MockModel` and a fault-injecting wrapper that can
kill the process at any checkpoint boundary, then asserts resume correctness and no duplicate side
effects. This is the primary defense for the durability claims that the review (rightly) treated skeptically.

## 18.5 Memory quality in CI (falsifiable differentiation)

The memory benchmark harness (§6.10: LongMemEval / LoCoMo / temporal) runs in CI against pinned
fixtures, tracking scores over time. Regressions fail the build. Published baselines live in the
repo. This makes the memory differentiation *falsifiable* rather than asserted — and guards against
silent quality drift in consolidation/extraction prompts (the review's "the architecture can be
perfect and the memory still mediocre" critique).

## 18.6 The SDK's own agents are eval-tested

Dogfooding: Eidentic's bundled agents/skills are tested with `@eidentic/eval` (§11.3) — trajectory
+ deterministic checks — so the eval harness is proven on real agents, and every reported bug
becomes a regression case (`captureFailure`).

## 18.7 CI structure

- Unit + property tests on every PR (in-memory fakes, no infra).
- Conformance suites run against real adapters (libSQL, Postgres, LanceDB, E2B) in a matrix.
- Crash-injection + replay determinism nightly.
- Memory benchmarks weekly + on memory-engine PRs.
- Bundle-size + tree-shaking assertions (no heavy dep leaks into `@eidentic/core`, §2.3/§13.2).
- Supply-chain: provenance, lockfile integrity, advisory gate (§13.7).

## 18.8 Traceability

- "How is the SDK tested?" (review gap) → §18.1–18.7.
- "Prove a community adapter is correct" → §18.3 conformance suite.
- Durability skepticism → §18.4 crash-injection.
- "Memory could be mediocre" → §18.5 CI benchmarks, falsifiable.
