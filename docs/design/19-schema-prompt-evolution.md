# 19. Schema & Prompt Evolution

[← 18. Testing & Conformance](18-testing-conformance.md) · [Index](master-design.md) · Next: [20. Secrets, Rate Limiting & Quotas →](20-secrets-rate-limiting.md)

Added after adversarial review flagged a **major**: event-sourcing's hardest problem (replaying
an old log against new code) was one hand-waved sentence (§12.6), and the *guaranteed* operational
events — changing an embedding model, evolving the message schema, editing a system prompt — had
no story. These are not edge cases; they happen to every deployed agent.

## 19.1 Event-schema versioning & upcasting

Every event carries `schemaVersion`. Readers never assume the latest shape:

- **Upcasters** transform an event from version *n* to *n+1* at read time (a pure function chain).
  Old logs always replay on new code because the reader upcasts before the loop sees them.
- Upcasters are **additive and tested**: §18 includes a "replay a v1.0 log on vN code" conformance
  test. Removing/renaming a field requires an upcaster, never an in-place rewrite of the immutable log.
- This upholds Constitution #2 (no breaking changes) *at the data layer*, which is where event
  sourcing usually breaks the promise.

## 19.2 In-flight workflow/version skew

A durable run may be mid-flight when code is deployed with a changed step structure (the
"workflow patching" problem). Policy for the in-house journal (§9):

- Runs are tagged with the **code version** that started them. On resume, if the step structure
  changed incompatibly, the run is **not silently replayed against new logic** — it is either
  completed under a pinned compatibility shim or drained/failed with a typed `durable.version_skew`
  error (§17), surfaced to the operator. Never silent state corruption.
- Long-lived background jobs (consolidation) are idempotent and version-tagged; a skewed job is
  re-enqueued fresh rather than resumed.

## 19.3 Embeddings model migration & re-indexing

Changing the embedding model (better quality, cost, or a deprecated model) invalidates the entire
vector store — a *guaranteed* event the design must own:

- **Embeddings are versioned** by `(model, dimension)` and stored alongside each vector. Recall only
  fuses vectors from the **active** embedding version.
- **Online re-index job:** a background job (§16 queue) re-embeds archival/memory content under the
  new model into a new vector namespace; recall runs **dual-read** (old + new) during migration, then
  cuts over and erases the old namespace. No downtime, no silent staleness.
- **Dimension change** is handled by the namespace switch (no in-place dimension mutation).
- **Multi-vector coexistence** (e.g., a multilingual model for some scopes) is supported via per-scope
  embedding config; recall selects the matching namespace.

## 19.4 System-prompt / instruction versioning

Instructions are part of the cached prefix (§4.2) *and* part of agent identity and memory provenance:

- Agent **instructions are versioned**; each session records the instruction version it ran under.
- Changing instructions invalidates the KV-cache prefix from that point (accepted, documented) and
  starts a new provenance lineage — memory/skills record which instruction version produced them, so
  behavior changes are auditable (and a regression can be traced to a prompt change).
- Prompt changes are a normal, tracked migration — not an silent in-place edit.

## 19.5 Memory-block & skill-format evolution

- **Block schema** (labels, limits, descriptions) evolves via the same migration discipline; existing
  blocks are migrated forward by the consolidation job, with `block_history` preserving the prior shape.
- **Skill format** (`SKILL.md` + extensions) is versioned; the loader upcasts older skills and remains
  agentskills.io-compatible (§7.10). A skill's `skill.lock` records the format version.

## 19.6 Migration discipline (unifying §12.5)

All migrations — relational schema, event upcasters, embedding re-index, prompt/skill versions —
follow one discipline: **forward-only, versioned, run-on-startup, tested** (replay/conformance, §18).
Both SQLite and Postgres are first-class upgradable backends (no SQLite-can't-migrate trap).

## 19.7 Traceability

- Event-sourcing replay-on-new-code (review major) → §19.1 upcasters + §18 replay test.
- In-flight version skew → §19.2 version-tagged runs, no silent corruption.
- Embeddings re-index (guaranteed op, review major) → §19.3 versioned namespaces + dual-read cutover.
- Prompt versioning (review minor) → §19.4 versioned instructions + provenance.
- Constitution #2 at the data layer → §19.1/§19.6 forward-only tested migrations.
