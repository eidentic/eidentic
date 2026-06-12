---
"@eidentic/core": patch
"@eidentic/rag": patch
"@eidentic/a2a": patch
---

Docs fix: correct README code examples that did not match the real API (verified against source).

- `@eidentic/core`: `createTool({ name, parameters, execute: ({ city }) })` →
  `createTool({ id, inputSchema, execute: ({ input }) })`.
- `@eidentic/rag`: `ingestDocument({ source, memory, scope })` → `ingestDocument(source, { memory, scope })`
  (source first, options second); `UrlSource` is `{ url }` (no `type`); typed content `type` is
  `"markdown" | "html" | "pdf"` with a `data` field; `loadMarkdown(content)` takes the content string,
  not `{ path }`; `chunkText(text, { size, overlap })` (not `chunkSize`).
- `@eidentic/a2a`: `a2aRoutes(agent, { card })` → `a2aRoutes({ agent, card })`; `a2aTool` options use
  `id`, not `name`.
