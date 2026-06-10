# @eidentic/model

Model and embedder wrappers for Eidentic — `AIModel` wraps any Vercel AI SDK provider,
`AIEmbedder` wraps embedding models, and the package ships a live price table (sourced
from LiteLLM) plus an Ollama adapter for local inference.

## Install

```bash
pnpm add @eidentic/model ai @ai-sdk/anthropic
# or any other @ai-sdk/* provider
```

## Usage

```ts
import { AIModel, AIEmbedder } from "@eidentic/model";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

// Wrap a provider model
const model = new AIModel(anthropic("claude-sonnet-4-5"));

// Wrap an embedding model
const embedder = new AIEmbedder(openai.embedding("text-embedding-3-small"), { dim: 1536 });

// Check current prices
import { defaultPrices, pricesUpdatedAt } from "@eidentic/model";
console.log(defaultPrices["claude-sonnet-4-5"]); // { inputUsd: ..., outputUsd: ... }

// Ollama for local inference
import { createOllamaModel } from "@eidentic/model";
const local = createOllamaModel("llama3.2", { baseUrl: "http://localhost:11434" });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
