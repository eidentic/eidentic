---
title: Memory 101
description: Understand Eidentic's three memory layers and wire them into your agent.
---

Eidentic's memory engine goes far beyond storing chat history. It is a four-tier system that makes an agent genuinely remember things across sessions, improve over time, and reason about facts that change. Here's how it fits together and how to use it.

## The three layers you configure

### Layer 1: Per-session history (always on)

Every call to `agent.query()` with the same `sessionId` continues the same conversation. The store (`SqliteStore`, `LibsqlStore`, `PostgresStore`) persists the event log automatically. No extra setup is required.

```ts
// Same sessionId → agent sees the full prior conversation
for await (const ev of agent.query("Remind me what we discussed.", {
  sessionId: "user-42-support",
}));
```

This layer is free — it happens whenever you pass a `sessionId`.

### Layer 2: Per-user cross-session memory (requires `Memory` + `userId`)

This is where Eidentic's memory engine activates. When you attach a `Memory` instance to the agent and pass a `userId`, the engine builds durable, self-improving knowledge about that user across all their sessions.

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { Memory } from "@eidentic/memory";
import { anthropic } from "@ai-sdk/anthropic";

const store = new SqliteStore("./eidentic.sqlite");

const agent = new Agent({
  id: "assistant",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
  memory: new Memory({ store }),
});
```

Then pass `userId` at query time:

```ts
for await (const ev of agent.query("I prefer dark mode.", {
  sessionId: "s-123",
  userId: "user-42",   // <-- activates per-user memory
}));
```

**What `userId` does:** it scopes all memory reads and writes to that user. Memory blocks, recalled facts, and the temporal knowledge graph are all keyed by this value. Without `userId`, memory is available to the agent but not scoped to an individual — useful for shared/org-level context.

**What the agent gets at query time:**

1. **Self-editing memory blocks** — always-in-context text blocks the agent can read and rewrite mid-reasoning. Think of them as a scratchpad the agent maintains about you.
2. **BM25 lexical recall** — full-text search over historical events and extracted facts, surfaced as relevant snippets.
3. **Semantic recall** (optional, requires a vector store + embedder) — vector similarity search fused with lexical recall via Reciprocal Rank Fusion (RRF).
4. **Temporal knowledge graph** — structured facts with validity over time. Contradictory facts invalidate the old value rather than deleting it, preserving the history of what was known when.

### Layer 3: Skills (self-developing capability)

Skills are reusable playbooks the agent searches and executes. They live in `SKILL.md` files (agentskills.io format) and can be registered in a `SkillBank` with test-gating and ed25519 signing. The agent searches the skill set and loads relevant skills into context at query time.

```ts
import { SkillSet } from "@eidentic/skills";

const agent = new Agent({
  // ...
  skills: new SkillSet("./skills"),  // directory of SKILL.md files
});
```

Skills can optionally self-evolve: when a skill repeatedly fails its test, the `evolveSkill` function runs a reflection loop to improve the playbook. This is off by default.

## Wiring `Memory` with semantic recall

For semantic recall, provide a vector store and an embedder:

```ts
import { Memory } from "@eidentic/memory";
import { AIEmbedder } from "@eidentic/model";
import { LanceDBVectorStore } from "@eidentic/lancedb";
import { anthropic } from "@ai-sdk/anthropic";

// Using a hosted embedder (any AI SDK provider)
const embedder = new AIEmbedder(anthropic.textEmbeddingModel("text-embedding-3-small"));

// Using a local embedder (no API key, runs on device)
// import { LocalEmbedder } from "@eidentic/transformers";
// const embedder = new LocalEmbedder();

const memory = new Memory({
  store,
  vector: new LanceDBVectorStore("./vectors"),
  embedder,
});
```

With `vector` + `embedder` set, `memory.semantic` is `true` and semantic recall activates automatically.

## Sleep-time consolidation

The consolidation background job distills raw episodes into durable summary facts. It is grounded — it extracts only information present in the actual conversation history, never invents.

```ts
import { ConsolidationScheduler } from "@eidentic/memory";

const scheduler = new ConsolidationScheduler({
  memory,
  model: new AIModel(anthropic("claude-haiku-4-5")), // use a fast/cheap model
  intervalMs: 5 * 60 * 1000, // every 5 minutes
});

scheduler.start();
```

## Temporal knowledge graph

The knowledge graph stores facts with validity windows. When the agent asserts a new fact that contradicts an existing one (e.g., "user's city is Berlin" after previously "user's city is London"), the old fact is marked expired — not deleted. This means you can query the history of a fact over time.

```ts
// Accessible directly from the Memory instance
await memory.assertFact({ subject: "user", predicate: "city", object: "Berlin" }, userId);

const facts = await memory.queryFacts({ subject: "user", predicate: "city" }, userId);
// Returns facts with validFrom / validTo timestamps
```

## Right-to-erasure (GDPR)

To hard-delete all data for a user across the store, vector index, and knowledge graph:

```ts
await memory.eraseScope({ kind: "user", userId: "user-42" });
```

This removes sessions, events, memory blocks, vectors, and facts for that scope — permanently.

## Memory governance

Beyond basic recall, the memory system provides a full governance layer:

- **State-transition timelines** — `memory.factTimeline(scope, subject, predicate)` returns every version ever asserted, ordered by `validFrom`. Point-in-time queries (`queryFacts({ validAt })`) let you ask "what was known at a past date?".
- **Corroboration and staleness tiers** — `corroborationTtlMs` per predicate flags facts that haven't been re-confirmed recently with a `stale` marker and a context annotation.
- **Consent enforcement** — a `ConsentManifest` gates write-time and retroactive storage of personal-data categories (`"never"`, `"session"`, retention ms).
- **Portable export** — `memory.exportScope` produces a versioned `eidentic.memory.export.v1` envelope for data-subject access and GDPR portability.
- **Identity merge** — `memory.mergeScopes(from, to)` safely upgrades an anonymous scope to an authenticated one, with crash-safe copy-then-erase semantics.

See the [Memory Governance guide](/guides/memory-governance) for full API details, options tables, and gotchas.

## Memory config summary

| Config | What it enables |
|---|---|
| `Memory({ store })` | Self-editing blocks + lexical (BM25) recall |
| `+ vector + embedder` | Semantic recall (RRF-fused with lexical) |
| `+ graph` | Temporal knowledge graph |
| `+ reranker` | Re-ranking of recalled snippets (requires `@eidentic/transformers` or hosted reranker) |
| `ConsolidationScheduler` | Background distillation of episodes → facts |

---

## Memory quality options

### Deduplication on write

By default (`dedupeOnWrite: true`), ingesting a snippet whose normalised text already exists in the same scope is silently skipped. This prevents duplicate entries from accumulating when the same fact is extracted multiple times.

```ts
const memory = new Memory({
  store,
  dedupeOnWrite: true, // default — set false to restore append-always behaviour
});
```

### Transient TTL and markers

Some facts are inherently temporary (e.g. "user is currently travelling"). Mark them as transient by including one of the `TRANSIENT_MARKERS` strings in the text, and set `transientTtlMs` so they expire automatically:

```ts
import { Memory, TRANSIENT_MARKERS } from "@eidentic/memory";

// TRANSIENT_MARKERS includes: "today", "currently", "right now", "this week", etc.
console.log(TRANSIENT_MARKERS.slice(0, 3)); // ["today", "currently", "right now"]

const memory = new Memory({
  store,
  transientTtlMs: 24 * 60 * 60 * 1000, // expire transient facts after 24 h
});
```

Facts without a transient marker are never auto-expired. Set `transientTtlMs: 0` to preserve transient facts indefinitely.

### Recall quality: `minScore` and `topK`

```ts
const memory = new Memory({
  store,
  topK: 8,       // return up to 8 snippets per query (default varies)
  minScore: 0.3, // filter out snippets below this RRF-fused score
});
```

`topK` is overridable per-query. `minScore` is applied after RRF fusion; set it to prune low-relevance snippets before they reach the model's context window.

### Entity fusion signal

The memory engine extracts named entities from ingested text and uses them as an additional retrieval signal (lexical matching by entity name). This improves recall for queries that reference people, organisations, or products by name.

Entity extraction is automatic. You can inspect or override extraction behaviour by supplying a `passiveExtract` configuration — see `@eidentic/memory` source for the extraction schema.

### `ingestedAt` and `metadata` on recalled snippets

Every recalled `MemorySnippet` carries optional provenance fields:

```ts
const { snippets } = await memory.retrieve({ query: "What's the refund policy?", scope });

for (const s of snippets) {
  console.log(s.text);
  console.log("Source:", s.metadata?.source);  // e.g. "https://docs.example.com/faq"
  console.log("Ingested at:", s.ingestedAt);   // epoch-ms (requires store v10+)
}
```

`ingestedAt` is populated by SQLite/libSQL stores at v10+ and Postgres stores at v8+. It is absent on older stores or pre-migration rows.
