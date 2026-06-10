---
"@eidentic/rag": minor
---

Add `@eidentic/rag` — document ingestion convenience package for RAG pipelines.

**`chunkText(text, opts?): Chunk[]`** — split plain text or markdown into overlapping chunks ready for embedding. Three strategies: `"fixed"` (word-boundary sliding window, default), `"paragraph"` (split on blank lines first), `"sentence"` (split on sentence-ending punctuation first). Options: `size` (chars, default 1000), `overlap` (chars, default 150), `strategy`. Each `Chunk` carries `{ text, index, start, end }`. Handles empty/whitespace input, unicode (CJK, emoji), and pathologically long words (hard-cut fallback).

**`ingestDocument(source, opts): Promise<{ chunks: number }>`** — chunk a document and call `memory.ingest(events)` in one call. `source` is either a raw `string` or `{ url: string }` (fetches via `resilientFetch` — plain text/markdown only, no HTML/PDF parsing). Chunk events get stable ids `${docId}:chunk:${i}` so re-ingesting is idempotent. `opts.memory` accepts any structural `{ ingest }` — not coupled to `@eidentic/memory`'s class. `opts.docId` defaults to a URL slug or a djb2 hash of the text.

Depends on `@eidentic/types` (Scope/MemoryEvent) and `@eidentic/tools` (resilientFetch). No new runtime deps.
