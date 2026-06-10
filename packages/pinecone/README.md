# @eidentic/pinecone

Pinecone vector store adapter for Eidentic — fully-managed vector search for agent memory
using the Pinecone API. Implements `VectorPort` from `@eidentic/types`. The Pinecone index
must be pre-created with the matching dimension and cosine metric; the adapter does not
create indexes.

## Install

```bash
pnpm add @eidentic/pinecone @pinecone-database/pinecone
```

## Usage

```ts
import { PineconeVectorStore } from "@eidentic/pinecone";
import { Pinecone } from "@pinecone-database/pinecone";

const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
const index = pinecone.index("eidentic-memory");

const vector = PineconeVectorStore.create({
  index,
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
