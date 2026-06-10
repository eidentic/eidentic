# @eidentic/qdrant

Qdrant vector store adapter for Eidentic — fast approximate-nearest-neighbor search for
agent memory using a Qdrant-compatible API. Implements `VectorPort` from `@eidentic/types`.
String IDs are deterministically mapped to UUIDs (SHA-1, UUIDv5 format) to satisfy
Qdrant's ID constraints.

## Install

```bash
pnpm add @eidentic/qdrant
```

## Usage

```ts
import { QdrantVectorStore } from "@eidentic/qdrant";

// Pass a Qdrant-compatible client (e.g. @qdrant/js-client-rest)
import { QdrantClient } from "@qdrant/js-client-rest";

const client = new QdrantClient({ url: process.env.QDRANT_URL });

const vector = await QdrantVectorStore.create({
  client,
  collection: "eidentic-memory",
  dim: 1536,
});

// Use with Memory
import { Memory } from "@eidentic/memory";
const memory = new Memory({ store, vector, embedder });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
