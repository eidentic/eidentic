# @eidentic/transformers

Local embedder and reranker for Eidentic — run `bge-small-en-v1.5` (384-dim embeddings)
and a cross-encoder reranker via `@huggingface/transformers`, entirely in-process with no
API key or external service required. Implements `EmbeddingPort` and `RerankPort` from
`@eidentic/types`.

## Install

```bash
pnpm add @eidentic/transformers @huggingface/transformers
```

## Usage

```ts
import { LocalEmbedder, LocalReranker } from "@eidentic/transformers";

// Load once (downloads model on first run, then caches)
const embedder = await LocalEmbedder.load(); // bge-small-en-v1.5, dim=384
const reranker = await LocalReranker.load(); // cross-encoder/ms-marco-MiniLM-L-6-v2

// Single embedding
const vec = await embedder.embed("What is the capital of France?");
console.log(vec.length); // 384

// Batch embedding
const vecs = await embedder.embedBatch(["hello", "world"]);

// Rerank candidates
const reranked = await reranker.rerank("What is Paris?", [
  { id: "a", text: "Paris is the capital of France." },
  { id: "b", text: "London is the capital of England." },
]);
// reranked sorted by relevance score descending
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
