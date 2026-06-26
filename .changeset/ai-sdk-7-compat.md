---
"@eidentic/model": minor
"@eidentic/server": minor
"@eidentic/nextjs": minor
"@eidentic/studio": minor
"eidentic": minor
"create-eidentic": minor
---

Upgrade Eidentic's AI SDK integration to AI SDK 7.

- `@eidentic/model` now calls AI SDK 7 with `instructions`, `output`, `result.output`, `result.stream`, and `usage.inputTokenDetails.cacheReadTokens` instead of the removed/deprecated v6 surfaces.
- `@eidentic/server` continues to emit the AI SDK UI message stream protocol against `ai@^7`.
- AI SDK-backed packages are now ESM-only where required by the AI SDK 7 ecosystem. CommonJS consumers should migrate to ESM `import`.
- New scaffolded projects use `ai@^7.0.2`, `@ai-sdk/react@^4.0.2`, and v7-compatible provider packages.
- `createOllamaModel()` no longer auto-loads the old `ollama-ai-provider` package. For Ollama with AI SDK 7, install `ai-sdk-ollama@^4` and pass `ollama("model-id")` directly to `new AIModel(...)`.
