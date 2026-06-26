# @eidentic/model

Model and embedder wrappers for Eidentic — `AIModel` wraps any Vercel AI SDK 7 provider,
`AIEmbedder` wraps embedding models, and the package ships a live price table (sourced
from LiteLLM).

## Install

```bash
pnpm add @eidentic/model ai @ai-sdk/anthropic
# or any other @ai-sdk/* provider
```

`@eidentic/model` follows AI SDK 7 and is ESM-only. Use ESM `import`, not CommonJS
`require()`.

## Usage

```ts
import { AIModel, AIEmbedder } from "@eidentic/model";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";

// Wrap a provider model
const model = new AIModel(anthropic("claude-sonnet-4-5"));

// Wrap an embedding model (async factory — the dimension is probed automatically)
const embedder = await AIEmbedder.create(openai.embedding("text-embedding-3-small"));

// Check current prices
import { defaultPrices, pricesUpdatedAt } from "@eidentic/model";
console.log(defaultPrices["claude-sonnet-4-5"]); // { inputUsd: ..., outputUsd: ... }

// Ollama for local inference
// pnpm add ai-sdk-ollama
import { ollama } from "ai-sdk-ollama";
const local = new AIModel(ollama("llama3.2"));
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
