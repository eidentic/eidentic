# 15. Data Governance, PII, Retention & Erasure

[← 14. Traceability](14-traceability-matrix.md) · [Index](master-design.md) · Next: [16. Concurrency →](16-concurrency-cancellation.md)

Added after adversarial review flagged a **blocker**: "store complete spans, never truncate"
(§11.1) plus "memory persists user data" (§6) directly conflicts with GDPR/CCPA and the
right to erasure. An agent SDK that remembers users is a data-controller's nightmare unless
governance is designed in.

## 15.1 The core tension

Three subsystems want to keep everything; the law requires the ability to delete and minimize:

- **Event-sourced log (§9)** is append-only and immutable — but immutability fights erasure.
- **Traces (§11)** store complete payloads (prompts, tool I/O) — which contain PII.
- **Memory (§6)** persists across sessions by design, with opt-in TTL — but "opt-in" is unsafe as a default for regulated data.

Resolution: **separate the immutable *fact that an event happened* from its *erasable content*,
and make erasure a first-class operation that fans out across every store.**

## 15.2 Data classification & tagging

Every stored datum carries a classification, set at ingestion:

```ts
type DataClass = 'public' | 'internal' | 'pii' | 'secret' | 'untrusted'
```

- **`pii`** — subject to erasure/retention/residency rules; redacted in traces by default.
- **`untrusted`** — content from outside the trust boundary (web, tool output, imported skills);
  tracked for injection-propagation (§10.3) and never auto-promoted into a signed skill or shared block.
- **`secret`** — never persisted in plaintext, never in traces (see §20).

Classification flows with the datum into the event log, memory, and traces, so policies apply uniformly.

## 15.3 Erasure architecture (crypto-shredding + tombstones)

Right-to-erasure must work even over an immutable, content-hashed event log. Approach:

- **Content-key encryption.** PII-classified content in events/memory is encrypted with a
  per-subject (per-user) data key. **Erasure = destroy the subject's data key** → all ciphertext
  becomes unrecoverable without rewriting the immutable log ("crypto-shredding"). The event's
  *structure* (it happened, when, which kind) survives; its *content* is gone.
- **Tombstones.** A `subject.erased` event is appended; readers/replayers treat erased content
  as redacted. Checkpoints referencing erased content remain valid structurally.
- **Fan-out.** `erase(subjectId)` is a single API that cascades across **every** store:
  event content (key destroyed), memory blocks/archival/facts (deleted by scope), vector
  embeddings (deleted by scope filter), checkpoints (PII fields nulled), and traces (purged or
  redacted at the backend via subject id).

```ts
interface GovernancePort {
  erase(subject: { userId?: string; orgId?: string }): Promise<ErasureReceipt>  // fans out to all stores
  export(subject): Promise<DataExport>            // right-to-access / portability
  classify(datum, hint?): DataClass
}
```

Every store/vector/durable adapter must implement an `eraseByScope(scope)` method — part of
the adapter conformance suite (§18). An adapter that cannot erase cannot be certified for
PII workloads.

## 15.4 Retention & minimization

- **Retention policies** are declarative and **default-on** for `pii` (not opt-in):
  `retention: { pii: '90d', events: '1y', traces: '30d' }`. A background job (§16 queue)
  enforces TTL by erasing expired content.
- **Memory staleness TTL** (§6.6) participates: expired facts are invalidated then erased.
- **Minimization:** the context engine and memory store only what policy permits; `secret`-class
  data is never written to memory or traces.

## 15.5 Trace redaction (reconciles §11.1)

§11.1's "complete payloads, never truncate" is amended: traces store complete payloads **after a
redaction pass**. A `RedactionPipeline` runs before export:

- PII detectors (configurable: regex + classifier) mask emails, tokens, secrets, and
  classification-tagged fields.
- `gen_ai.input.messages` / `gen_ai.output.messages` are **opt-in** (per OTel GenAI spec) and
  redacted when enabled.
- Two modes: `full` (dev, local studio, complete), `redacted` (default for exported/persistent
  traces). The *primary event log* keeps complete content under crypto-shredding; *exported
  traces* are redacted. This removes the §11.1 ↔ GDPR contradiction.

## 15.6 Residency hooks

Scope (§6.7) carries an optional `region`. Store/vector adapters may pin a subject's data to a
region; the server router honors it. Full multi-region replication is v2, but the **hook exists
in the data model from v1** so it isn't a breaking change later.

## 15.7 Audit (the third event-log projection)

Per the §0 decision, the audit view is **immutable, redacted, separately retained**: who did
what to which scope, when — block edits (`block_history`), permission decisions, erasures,
skill approvals. Audit entries reference subjects by id (erasable) but retain the action record
(required for compliance) — the action survives erasure; the PII payload does not.

## 15.8 API sketch

```ts
const agent = new Agent({
  governance: governance({
    retention: { pii: '90d', traces: '30d' },
    redaction: 'pii',                 // trace export redaction
    residency: 'eu',                  // optional region pin
  }),
})
await agent.governance.erase({ userId: 'u_123' })   // GDPR Art. 17, fans out everywhere
await agent.governance.export({ userId: 'u_123' })  // GDPR Art. 20
```

## 15.9 Traceability

- GDPR/retention gap → §15.3 erasure fan-out + §15.4 default-on retention.
- "Complete spans vs PII" (review blocker) → §15.5 crypto-shredded log + redacted exports.
- Cross-user pollution / no governance → §15.2 classification + §6.7 scope erasure.
- Regulated-use claim (§7.6) → §15.7 audit + §15.3 erasure make it real.
