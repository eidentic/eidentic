---
"@eidentic/rag": minor
---

Add document loaders (Markdown, HTML, PDF) to `@eidentic/rag`.

**New loaders** — each returns `{ text, metadata }` and integrates directly with `ingestDocument`:

- **`loadMarkdown(content, opts?)`** — pure-JS regex stripper: removes heading markers, bold/italic, code blocks, links, blockquotes, list markers, and embedded HTML tags. No external dependencies.
- **`loadHtml(html, opts?)`** — extracts readable text from HTML using `node-html-parser` (new runtime dependency). Strips `<script>`, `<style>`, `<head>`, and `<noscript>` elements, preserves block-level line breaks, collapses whitespace.
- **`loadPdf(buf, opts?)`** — extracts text from a PDF `Buffer` via `pdf-parse` (**optional peer dependency** — install separately: `npm install pdf-parse`). Loaded via lazy `require()` mirroring the `ollama-ai-provider` pattern in `@eidentic/model`; throws a clear install-hint error if the peer dep is absent. Returns `metadata.pages` alongside `metadata.source`.

**Extended `ingestDocument` API** — the `source` argument now accepts a `TypedContentSource`:

```ts
// Markdown
await ingestDocument({ type: "markdown", data: markdownString, source: "README.md" }, opts);
// HTML
await ingestDocument({ type: "html", data: htmlString, source: "https://example.com" }, opts);
// PDF (requires pdf-parse peer dep)
await ingestDocument({ type: "pdf", data: pdfBuffer, source: "report.pdf" }, opts);
```

All existing `string` and `{ url }` signatures are fully backward compatible. Each chunk receives `metadata.source` (and `metadata.pages` for PDF) so citations work out of the box with the existing RAG citation pipeline.
