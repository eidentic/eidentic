---
"@eidentic/types": minor
"@eidentic/model": minor
"@eidentic/core": minor
---

Add Ollama (local/offline) model support and multimodal image input.

**Feature 1 — Ollama helper (`@eidentic/model`)**

`createOllamaModel(modelId, opts?)` returns a Vercel AI SDK `LanguageModel` backed by a locally-running [Ollama](https://ollama.com) instance. No API key required — works fully offline.

```ts
import { AIModel, createOllamaModel } from "@eidentic/model";

const model = new AIModel(createOllamaModel("llama3.2"));
// or with a custom server URL:
const model2 = new AIModel(createOllamaModel("mistral", { baseURL: "http://192.168.1.10:11434/api" }));
```

`ollama-ai-provider` is an **optional peer dependency** — install it separately when you need local inference:

```sh
npm install ollama-ai-provider
# or
pnpm add ollama-ai-provider
```

**Feature 2 — Multimodal image input (`@eidentic/types`, `@eidentic/model`, `@eidentic/core`)**

Added an `"image"` variant to `ContentBlock` (input-only / vision):

```ts
import { textBlock, imageBlock } from "@eidentic/types";

// base64 data:
imageBlock({ data: "<base64>", mediaType: "image/jpeg" });
// or URL:
imageBlock({ url: "https://example.com/photo.jpg" });
```

`Agent.query` now accepts `ContentBlock[]` in addition to `string`:

```ts
for await (const ev of agent.query(
  [textBlock("What is in this image?"), imageBlock({ url: "https://..." })],
  { sessionId: "s1" },
)) { ... }
```

Image blocks are forwarded to vision-capable models (e.g. `llava`, `claude-3-5-sonnet`, `gpt-4o`) as AI SDK `ImagePart` objects. `query(string)` is unchanged — fully backward-compatible.

New helpers exported from `@eidentic/types`: `imageBlock`, `isImage`, `ImageInput`, `encodeMultimodalInput`, `decodeMultimodalInput`, `MULTIMODAL_INPUT_PREFIX`, `extractTextFromBlocks`.
