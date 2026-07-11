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

## Live conformance test

Set `EIDENTIC_TEST_PINECONE_API_KEY` to run the real-service vector conformance suite. Without
`EIDENTIC_TEST_PINECONE_INDEX`, the suite creates a disposable dimension-4 cosine serverless index,
waits until it is ready, and deletes it in teardown. An explicitly supplied index is preserved and
only random test namespaces are deleted. Never target a production index.

The disposable index defaults to AWS `us-east-1`; override with
`EIDENTIC_TEST_PINECONE_CLOUD` and `EIDENTIC_TEST_PINECONE_REGION` when required by the project.
Because Pinecone is eventually consistent, the live suite waits 5 seconds between mutations and
dependent reads. Override this only for provider-specific testing with
`EIDENTIC_TEST_PINECONE_CONSISTENCY_DELAY_MS` (a non-negative millisecond value).

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
