# @eidentic/memory

Self-improving memory engine for Eidentic — four-tier recall with lexical + semantic RRF
fusion, self-editing memory blocks, a temporal knowledge graph, passive fact extraction,
and sleep-time consolidation. This package provides the `Memory` class that wires a
`StorePort` and `VectorPort` together into Eidentic's full memory stack.

## Install

```bash
pnpm add @eidentic/memory
```

## Usage

```ts
import { Memory } from "@eidentic/memory";
import { SqliteStore } from "@eidentic/sqlite";
import { LanceDBVectorStore } from "@eidentic/lancedb";
import { AIEmbedder } from "@eidentic/model";
import { openai } from "@ai-sdk/openai";

const store = new SqliteStore("./eidentic.sqlite");
const embedder = await AIEmbedder.create(openai.embedding("text-embedding-3-small"));
const vector = await LanceDBVectorStore.open("./lancedb", "memory_vectors", 1536);

const memory = new Memory({ store, vector, embedder });

// Retrieve relevant snippets for a session
const scope = { kind: "user" as const, agentId: "my-agent", userId: "u-1" };
const result = await memory.retrieve({ text: "budget decisions", scope, topK: 5 });
console.log(result.snippets);
```

## Bounded archival deduplication

`deduplicateArchival` preserves exhaustive pair matching for small scopes, but caps one maintenance
pass at 100,000 candidate pairs by default. Large scopes use a deterministic widening-window order
so the budget covers the whole list before considering more distant entries. A partial pass is never
silent:

```ts
const maintenanceAbort = new AbortController();
const dedupe = await memory.deduplicateArchival(scope, {
  mergeModel,
  threshold: 0.95,
  maxComparisons: 100_000,
  maxMerges: 100,
  maxMergeTokens: 100_000,
  signal: maintenanceAbort.signal,
});

if (dedupe.truncated) {
  console.warn(
    `Archival dedup used ${dedupe.comparisons}/${dedupe.totalPairs} comparisons; ` +
    "partition the scope or schedule another pass.",
  );
}
```

The result reports comparison, merge, and token budgets plus `truncated`. Duplicate lexical rows
are physically deleted after a successful canonical merge. `ConsolidationScheduler.runNow()` also
exposes the same object as `result.dedupe` when
deduplication is configured. Raising the budget is explicit; use a larger value only in a bounded
offline maintenance window.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
