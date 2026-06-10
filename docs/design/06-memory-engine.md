# 6. Self-Improving Memory Engine

[← 5. Tool System](05-tool-system.md) · [Index](master-design.md) · Next: [7. Skill System →](07-skill-system.md)

This is Eidentic's flagship differentiator. It unifies the four mechanisms that today exist
only separately (and mostly only in Python): **self-editing memory blocks**,
**background sleep-time consolidation**, **temporal knowledge graph**,
and **multi-signal vector recall** — and it ships as a
**drop-in** (`@eidentic/memory` depends on `@eidentic/types`, not `core`), fixing the #1
memory-framework complaint ("not a layer — the stack"). It is engineered around the documented failure
modes of every existing system.

## 6.0 Two profiles (resolves the "zero-infra vs flagship memory" tension)

A single always-on flagship memory cannot also be a <5-minute zero-infra hello-world (it would
require a reranker model, an embedding model, and background consolidation LLM calls). So memory
ships in two explicit profiles (correction from review, §0-C4):

- **`memory: 'lite'` (default, zero-infra):** Tier-1 blocks (CAS + atomic append) + recall over
  lexical/BM25 (SQLite FTS5) with RRF fusion + passive extraction. **No** embeddings, cross-encoder
  rerank, temporal KG, or background consolidation. No API key, no external service.
- **`memory: 'full'` (opt-in):** adds vector recall + cross-encoder rerank + temporal KG +
  sleep-time consolidation. Requires an embedding provider and **acknowledges background LLM cost**
  — always fully accounted in `cost.background`, never hidden (Constitution #5).

Everything below describes `full`; `lite` is the noted subset.

## 6.1 The four tiers (unified)

| Tier | Name | In context? | Backing | Access |
|------|------|-------------|---------|--------|
| 1 | **Core memory** (blocks) | Always | `blocks` table | direct (injected) + self-edit tools |
| 2 | **Recall** (event history) | On demand | `events` table + FTS | `recall_search` tool / auto |
| 3 | **Archival** (semantic) | On demand | vector store (multi-signal) | `archival_search` tool / auto |
| 4 | **Knowledge graph** (facts) | On demand | `entities`/`relationships` (temporal) | `graph_query` tool / auto |

Tiers 2–4 are *out-of-context* and retrieved by the recall pipeline (§6.4); Tier 1 is
*always-in-context* and self-edited (§6.2). A background consolidation job (§6.5) moves
information *up* the value chain (raw events → distilled facts → updated blocks).

## 6.2 Core memory: self-editing blocks, made safe

A **block** is:

```ts
interface MemoryBlock {
  id: string
  label: string            // 'persona' | 'human' | 'project' | custom
  description: string      // tells the agent what this block is for
  value: string            // markdown/JSON/text
  limit: number            // char cap (enforced)
  readOnly: boolean        // only dev/API edits, not the agent
  scope: MemoryScope       // see §6.7
  version: number          // for optimistic concurrency (§6.3)
  updatedAt: string
}
```

Blocks are injected into the stable/semi-stable region of the window (§4.2). The agent
edits its own blocks via tools during reasoning — *what* to remember and *how* is the
agent's decision:

| Tool | Semantics | Concurrency |
|------|-----------|-------------|
| `memory_append(label, text)` | additive | safe (commutative) |
| `memory_replace(label, find, replace, version)` | substring edit | CAS on `version` |
| `memory_rewrite(label, value, version)` | full rewrite | CAS on `version` |
| `memory_archive(text)` | write to archival (tier 3) | safe |

Every mutation writes a prior-value row to **`block_history`** (audit trail + rollback) —
Constitution traceability.

### Guardrails against the documented failure modes

Self-editing memory can silently fail in five ways; we instrument each at the
*framework* level, not via prompt-hope:

- **Empty blocks** (agent never writes) → memory-health metric `block_fill_ratio`; if a
  required block stays empty past N turns, a hook/consolidation nudge writes it.
- **Runaway blocks** (over-append) → hard `limit` enforcement + an LRU/importance eviction
  to archival when near limit (the value isn't lost, it's demoted to tier 3).
- **Memory-over-answering** (agent writes instead of replies) → memory edits and the user
  answer are separate channels; an edit never satisfies a turn's response obligation.
- **Archival junk drawer** → consolidation dedups/merges (§6.5); writes are not blindly appended.
- **Cross-user pollution** → scope isolation enforced at the store query layer (§6.7), not
  the app layer.

## 6.3 Concurrency safety (fixing last-writer-wins)

Last-writer-wins is a documented source of silent data loss in multi-agent memory.
Eidentic blocks carry a `version`; `replace`/`rewrite` are **compare-and-swap**: if the
block changed since the agent read it, the write fails with the current value and the agent
(or a merge strategy) retries. Configurable conflict policy: `reject` (default, CAS),
`merge` (3-way text merge), or `append-only` (force additive). Shared blocks (§8) thus
never silently lose updates.

**Append is genuinely contention-free** (correction from review §0-C10): `memory_append` maps to
the store's **atomic `appendBlock`** op (§12.1), not a CAS read-modify-write — so two concurrent
appends to one block both land without conflict. This makes append-only the recommended path for
high-concurrency shared blocks (§16.2); only `replace`/`rewrite` go through CAS-on-`version`.

## 6.4 Recall: multi-signal retrieval (not naive RAG)

Single-signal vector search is the documented reason most memory is mediocre (49% vs
91% on LongMemEval is largely retrieval quality). The recall pipeline runs
**four signals in parallel** and fuses them:

```
query → ┌ semantic (vector, LanceDB/pgvector) ┐
        ├ lexical  (BM25 / FTS5)               ├→ reciprocal-rank fusion → cross-encoder rerank → top-k
        ├ entity   (graph_query over KG)        │
        └ temporal (valid-at filter)           ┘
```

- **Reranking** via a `RerankerPort`. **Off by default in embedded `lite`** (RRF fusion only —
  a real cross-encoder is a 100–600 MB model or a hosted call, which would break the zero-infra
  promise; correction from review §0-C2). In `full`/server mode it is on, using a hosted reranker
  (Cohere v3.5/v4) or an opt-in local `bge-reranker-v2-m3` (transformers.js). RRF fusion is always
  applied; the cross-encoder is the optional quality multiplier on top.
- **Token-efficient** by design: target a high accuracy-per-token (SOTA ≈ 7k tokens/query,
  not 26k). Recall returns compact, cited snippets, not raw dumps.
- **Async, never blocking.** Retrieval for the *current* turn is on the hot path; *writes*
  are always enqueued off the hot path (§6.6).

## 6.5 Sleep-time consolidation (background self-improvement)

The mechanism that makes memory *self-improving*. A separate **consolidation agent** runs
during idle periods (or on a schedule / on session close), with a slower, more capable
model — fully decoupled from the interactive primary agent (which uses a fast model and,
during conversation, does light memory edits only). Research has shown sleep-time-compute
yields 5× test-time compute reduction and 13–18% accuracy gains; we adopt the dual-agent separation.

Consolidation duties:

1. **Episodic → semantic distillation.** Compress raw event spans into clean facts; write to
   the knowledge graph and update blocks. (Turns "raw context" into "learned context".)
2. **Archival dedup/merge.** Cosine-similarity near-duplicate detection → LLM-merge →
   single canonical passage (fixes the junk-drawer).
3. **Staleness resolution.** Apply TTLs; mark superseded facts `invalid_at` (§6.6).
4. **Block hygiene.** Tighten runaway blocks, fill empty required blocks, reconcile
   contradictions.
5. **Skill memory rollup.** Aggregate per-skill `.memory.md` lessons (§7).

**Transparency (Constitution #5):** every consolidation LLM call is counted in
`cost.background` and traced — no hidden token bills. Frequency, model, and budget are
configurable; consolidation itself respects the cost governor (§11).

**Quality is the actual hard part (named, not hand-waved).** The architecture can be perfect and
the memory still mediocre — retrieval and consolidation quality are prompt/extraction problems, not
just plumbing (the review's sharpest critique). Our quality strategy: (1) **structured extraction
schemas** (facts as typed `subject-predicate-object`, not free text) so consolidation output is
checkable; (2) **grounded reflection** — consolidation cites the source events for every fact and is
verified against them (no ungrounded invention; same principle as §6 Constitution #6); (3) **the
benchmark harness (§6.10) runs in CI (§18.5)** so any regression in extraction/consolidation prompts
fails the build — quality is *falsifiable and defended*, not asserted; (4) optional **optimizer-driven
prompt optimization (§7)** to evolve the consolidation prompt itself against benchmark feedback over time.

**2026 architecture note:** consolidation runs as a durable background job (§9, §16.3 single-flight
+ debounce), not an in-loop step — so it never adds latency to the interactive turn.

## 6.6 Temporal knowledge graph (facts that evolve)

No TypeScript framework has temporal validity at the data-model level; this is documented
as a 15-point gap in benchmark results. Every fact is a timestamped, invalidatable edge:

```ts
interface Fact {
  subject: EntityRef; predicate: string; object: EntityRef | Literal
  validFrom: string; validUntil?: string         // temporal validity interval
  confidence: number; source: EventRef            // provenance
}
```

- **Contradiction handling:** a new fact that conflicts with an existing one sets the old
  fact's `validUntil` (it is *invalidated*, not deleted) — enabling "what did the agent
  believe on date X?" queries via interval lookup.
- **Implicit pattern learning:** beyond explicit facts, consolidation can record behavioral
  patterns ("user consistently tightens thresholds") as facts — addressing the frequently-requested
  "not just explicit facts" capability.
- Backed by `entities`/`relationships` tables (§12); queryable via `graph_query` and as the
  entity signal in recall (§6.4).

## 6.7 Scope & multi-tenant isolation

Memory is keyed by **scope**, enforced at the store query layer (every query carries a scope
predicate — no app-layer trust):

```ts
type MemoryScope =
  | { kind: 'agent' }                         // shared across all of this agent's sessions
  | { kind: 'user';   userId: string }        // per-end-user (cross-session personalization)
  | { kind: 'thread'; sessionId: string }     // ephemeral to one conversation
  | { kind: 'org';    orgId: string }          // tenant-wide institutional knowledge
  | { kind: 'shared'; blockId: string }        // explicitly shared block (multi-agent, §8)
```

This gives both **personalization memory** (user scope) and **institutional knowledge
memory** (org scope) — the distinction most frameworks miss. Tenant
isolation is structural (row-level scoping), not left to app-layer trust.

## 6.8 Model-independent path (don't collapse on weak models)

Memory quality collapses on small/local models when *the LLM* decides every write.
Eidentic offers a **passive extraction** path that runs independently of the primary
model: a lightweight pipeline (rules + small classifier/embedder) extracts salient facts
from events even when the agent doesn't self-edit. Modes:

- `agentic` — agent self-edits (best on frontier models),
- `passive` — extraction pipeline only (robust on weak/local models),
- `hybrid` (default) — agentic edits + passive safety net.

This is graceful degradation as a first-class config, not a failure mode.

## 6.9 Drop-in usage (outside the Eidentic loop)

Because `@eidentic/memory` depends only on `@eidentic/types`, it plugs into any loop. The contract
is **one narrow port**, identical inside the Eidentic loop and as a drop-in — with an explicit
**push** vs **pull** split (correction from review §0-C3; DTOs in `types`, never `Session`):

```ts
interface MemoryPort {
  getAlwaysInContext(scope: MemoryScope): Promise<Block[]>          // PUSH: Tier-1 blocks for the prefix
  retrieve(query: RetrievalQuery): Promise<RetrievedMemory>         // PULL: volatile multi-signal recall
  ingest(events: MemoryEvent[]): Promise<void>                      // async write + schedules consolidation
}

// drop-in use inside any custom loop or node:
const mem = new Memory({ scope: { kind: 'user', userId }, store, vector })
const blocks  = await mem.getAlwaysInContext(scope)                 // you place these in your prompt
const recall  = await mem.retrieve({ text: userMessage, scope, signals, topK: 8 })
// ... call your own LLM with blocks + recall ...
await mem.ingest(toMemoryEvents(turn))
```

A drop-in consumer gets recall for free but **must place always-in-context blocks itself** (the
Eidentic context engine does this automatically, §4.2). One adapter, no runtime commitment —
without pretending push-model blocks fit a pull-only API.

## 6.10 Benchmark harness (credibility)

Eidentic ships `@eidentic/memory/bench`: runnable LongMemEval, LoCoMo, and a temporal-reasoning
suite, with published baseline scores in the repo and CI regression tracking. Users can score
*their own* configuration. (Constitution #9.)

## 6.11 Memory as both context and tools

Tier 1 blocks are auto-injected (§4.2). Tiers 2–4 are exposed *both* as automatic recall
(the engine retrieves relevant memory each turn) *and* as explicit tools (`recall_search`,
`archival_search`, `graph_query`, `memory_*`) so the agent can deliberately reach for memory
— the insight that memory operations work best as first-class agent actions. (A future
trainable controller can sit behind this interface; not in core, per non-goals.)

## 6.12 API sketch

```ts
const memory = memory({
  scope: 'user',                                  // shorthand → { kind:'user', userId from ctx }
  blocks: { persona: '…', human: '' },            // seed blocks
  recall: { signals: ['semantic','lexical','entity','temporal'], rerank: true, topK: 8 },
  consolidation: { model: 'opus', schedule: 'on-idle', budgetUsd: 0.05 },
  extraction: 'hybrid',
  temporal: true,
  store, vector,
})
new Agent({ /* … */ memory })
```

## 6.13 Traceability

- "Stack not layer" lock-in → §6.9 drop-in (`types`-only dependency).
- Last-writer-wins data loss → §6.3 CAS + conflict policies.
- Archival junk drawer / no dedup → §6.5 consolidation merge.
- Weak-model collapse → §6.8 passive extraction.
- No published benchmarks → §6.10 shipped harness + published scores.
- Single-signal retrieval mediocrity → §6.4 multi-signal + rerank.
- No TS temporal memory → §6.6 temporal KG.
- Hidden memory costs → §6.5 transparent `cost.background`.
- Personalization vs institutional knowledge → §6.7 user/org scopes.
