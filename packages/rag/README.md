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

// Ingest a URL directly into agent memory (source first, options second)
await ingestDocument(
  { url: "https://docs.example.com/guide" },
  { memory, scope: { kind: "user", agentId: "my-agent", userId: "u-1" } },
);

// Or ingest pre-loaded typed content — type is "markdown" | "html" | "pdf"
await ingestDocument(
  { type: "markdown", data: "# My Doc\n\nHello.", source: "my-doc" },
  { memory, scope: { kind: "user", agentId: "my-agent", userId: "u-1" } },
);

// Or load and chunk manually (loadMarkdown takes the content string)
const doc = loadMarkdown("# My Doc\n\nHello.");
const chunks = chunkText(doc.text, { size: 512, overlap: 64 });
```

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
