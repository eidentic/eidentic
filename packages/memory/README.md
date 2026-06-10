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

const store = await SqliteStore.create("./eidentic.sqlite");
const embedder = new AIEmbedder(openai.embedding("text-embedding-3-small"), { dim: 1536 });
const vector = await LanceDBVectorStore.open("./lancedb", "memory_vectors", 1536);

const memory = new Memory({ store, vector, embedder });

// Retrieve relevant snippets for a session
const scope = { userId: "u-1", sessionId: "s-1" };
const result = await memory.retrieve({ query: "budget decisions", scope, topK: 5 });
console.log(result.snippets);
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
