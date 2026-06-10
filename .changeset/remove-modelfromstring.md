---
"@eidentic/model": minor
---

Remove `modelFromString` / `parseModelString`. Construct models explicitly and bring your own provider package: `new AIModel(openai("gpt-4o"))`, `new AIModel(anthropic("claude-sonnet-4-5"))`, `new AIModel(deepseek("deepseek-chat"))` — any `@ai-sdk/*` provider works, with no hardcoded provider list. This is the canonical, fully provider-agnostic path (mirrors `AIEmbedder`). The optional `@ai-sdk/*` peerDependencies are dropped since the resolver no longer imports providers.
