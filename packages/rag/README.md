# @eidentic/rag

RAG pipeline utilities for Eidentic — chunk text into overlapping windows, ingest
documents from URLs or typed content sources, and load Markdown, HTML, and PDF files
into a format ready for agent memory. Works with any `Memory` instance.

## Install

```bash
pnpm add @eidentic/rag
```

For PDF loading, also install `pdf-parse`:

```bash
pnpm add pdf-parse
```

## Usage

```ts
import { ingestDocument, loadMarkdown, chunkText } from "@eidentic/rag";
import { Memory } from "@eidentic/memory";

// Ingest a URL directly into agent memory
await ingestDocument({
  source: { type: "url", url: "https://docs.example.com/guide" },
  memory,
  scope: { userId: "u-1" },
});

// Or load and chunk manually
const doc = await loadMarkdown({ path: "./docs/guide.md" });
const chunks = chunkText(doc.text, { chunkSize: 512, overlap: 64 });

// Or ingest typed content
await ingestDocument({
  source: { type: "text", text: "...", mimeType: "text/plain", title: "My Doc" },
  memory,
  scope: { userId: "u-1" },
});
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
