---
"@eidentic/model": minor
"@eidentic/core": minor
"@eidentic/types": minor
---

Add `@eidentic/model`: a `ModelPort` adapter over Vercel AI SDK v6 (non-streaming) that runs the agent loop against real Anthropic/OpenAI/Google models, plus `modelFromString("provider/model")`. Thread `toolName` through tool-result events/messages in `@eidentic/core` and `@eidentic/types` (required by AI SDK tool results).
