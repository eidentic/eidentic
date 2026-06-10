---
"@eidentic/model": minor
---

Add `AIEmbedder` — a provider-agnostic, bring-your-own-key hosted `EmbeddingPort` over AI SDK v6. Use any `@ai-sdk/*` embedding model (OpenAI, Cohere, Google, Mistral, …) with your own API key and chosen model: `await AIEmbedder.create(openai.embedding("text-embedding-3-small"))`. It is a first-class peer to the local `@eidentic/transformers` embedder — both implement `EmbeddingPort` and are interchangeable in `FullMemory`. Dimension is discovered automatically via a one-shot probe at construction.
