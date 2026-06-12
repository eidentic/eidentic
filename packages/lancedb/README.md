# @eidentic/lancedb

LanceDB vector store adapter for Eidentic — high-performance local/embedded vector search
for agent memory using LanceDB. Implements `VectorPort` from `@eidentic/types`. Suitable
for single-node deployments; no external service required.

## Install

```bash
pnpm add @eidentic/lancedb @lancedb/lancedb apache-arrow
```

## Usage

```ts
import { LanceDBVectorStore } from "@eidentic/lancedb";
import { AIEmbedder } from "@eidentic/model";
import { openai } from "@ai-sdk/openai";

const embedder = await AIEmbedder.create(openai.embedding("text-embedding-3-small"));

const vector = await LanceDBVectorStore.open(
  "./lancedb",       // local directory for LanceDB tables
  "memory_vectors",  // table name
  1536,              // embedding dimension
);

// Use with Memory
import { Memory } from "@eidentic/memory";
const memory = new Memory({ store, vector, embedder });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
