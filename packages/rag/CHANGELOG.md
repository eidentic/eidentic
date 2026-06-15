# @eidentic/rag

## 0.1.5

### Patch Changes

- Updated dependencies [2360146]
  - @eidentic/types@0.3.0
  - @eidentic/tools@0.1.5

## 0.1.4

### Patch Changes

- 9d3b98d: Docs: correct README code examples that drifted from the real API — surfaced by the new
  `check:readme` CI gate that type-checks every README snippet against the built types. Fixes include
  the stale streaming loop (`ev.kind`/`ev.delta` → `ev.type`/`ev.delta.text`) across several stores,
  `new AIEmbedder(...)` → `await AIEmbedder.create(...)`, `SqliteStore.create(...)` → `new SqliteStore(...)`,
  invalid `Scope` literals (now `{ kind, agentId, … }`), `costCeiling` → `policy.maxCostUsd`,
  Ollama `baseUrl` → `baseURL`, and adapter-specific signature corrections.
- Updated dependencies [9d3b98d]
  - @eidentic/tools@0.1.4
  - @eidentic/types@0.2.1

## 0.1.3

### Patch Changes

- 39137dd: Docs fix: correct README code examples that did not match the real API (verified against source).

  - `@eidentic/core`: `createTool({ name, parameters, execute: ({ city }) })` →
    `createTool({ id, inputSchema, execute: ({ input }) })`.
  - `@eidentic/rag`: `ingestDocument({ source, memory, scope })` → `ingestDocument(source, { memory, scope })`
    (source first, options second); `UrlSource` is `{ url }` (no `type`); typed content `type` is
    `"markdown" | "html" | "pdf"` with a `data` field; `loadMarkdown(content)` takes the content string,
    not `{ path }`; `chunkText(text, { size, overlap })` (not `chunkSize`).
  - `@eidentic/a2a`: `a2aRoutes(agent, { card })` → `a2aRoutes({ agent, card })`; `a2aTool` options use
    `id`, not `name`.
  - @eidentic/tools@0.1.3

## 0.1.2

### Patch Changes

- Updated dependencies
- Updated dependencies [7c454e5]
- Updated dependencies [de07ecc]
  - @eidentic/types@0.2.0
  - @eidentic/tools@0.1.2

## 0.1.1

### Patch Changes

- Republish all packages via GitHub Actions trusted publishing (OIDC). This is the
  first release with provenance attestation — every package now carries a verifiable
  build provenance statement linking it to its source commit and workflow.
- Updated dependencies
  - @eidentic/tools@0.1.1
  - @eidentic/types@0.1.1

## 0.1.0

### Minor Changes

- 3a605b5: Add document loaders (Markdown, HTML, PDF) to `@eidentic/rag`.

  **New loaders** — each returns `{ text, metadata }` and integrates directly with `ingestDocument`:

  - **`loadMarkdown(content, opts?)`** — pure-JS regex stripper: removes heading markers, bold/italic, code blocks, links, blockquotes, list markers, and embedded HTML tags. No external dependencies.
  - **`loadHtml(html, opts?)`** — extracts readable text from HTML using `node-html-parser` (new runtime dependency). Strips `<script>`, `<style>`, `<head>`, and `<noscript>` elements, preserves block-level line breaks, collapses whitespace.
  - **`loadPdf(buf, opts?)`** — extracts text from a PDF `Buffer` via `pdf-parse` (**optional peer dependency** — install separately: `npm install pdf-parse`). Loaded via lazy `require()` mirroring the `ollama-ai-provider` pattern in `@eidentic/model`; throws a clear install-hint error if the peer dep is absent. Returns `metadata.pages` alongside `metadata.source`.

  **Extended `ingestDocument` API** — the `source` argument now accepts a `TypedContentSource`:

  ```ts
  // Markdown
  await ingestDocument(
    { type: "markdown", data: markdownString, source: "README.md" },
    opts,
  );
  // HTML
  await ingestDocument(
    { type: "html", data: htmlString, source: "https://example.com" },
    opts,
  );
  // PDF (requires pdf-parse peer dep)
  await ingestDocument(
    { type: "pdf", data: pdfBuffer, source: "report.pdf" },
    opts,
  );
  ```

  All existing `string` and `{ url }` signatures are fully backward compatible. Each chunk receives `metadata.source` (and `metadata.pages` for PDF) so citations work out of the box with the existing RAG citation pipeline.

- 3a605b5: Add `@eidentic/rag` — document ingestion convenience package for RAG pipelines.

  **`chunkText(text, opts?): Chunk[]`** — split plain text or markdown into overlapping chunks ready for embedding. Three strategies: `"fixed"` (word-boundary sliding window, default), `"paragraph"` (split on blank lines first), `"sentence"` (split on sentence-ending punctuation first). Options: `size` (chars, default 1000), `overlap` (chars, default 150), `strategy`. Each `Chunk` carries `{ text, index, start, end }`. Handles empty/whitespace input, unicode (CJK, emoji), and pathologically long words (hard-cut fallback).

  **`ingestDocument(source, opts): Promise<{ chunks: number }>`** — chunk a document and call `memory.ingest(events)` in one call. `source` is either a raw `string` or `{ url: string }` (fetches via `resilientFetch` — plain text/markdown only, no HTML/PDF parsing). Chunk events get stable ids `${docId}:chunk:${i}` so re-ingesting is idempotent. `opts.memory` accepts any structural `{ ingest }` — not coupled to `@eidentic/memory`'s class. `opts.docId` defaults to a URL slug or a djb2 hash of the text.

  Depends on `@eidentic/types` (Scope/MemoryEvent) and `@eidentic/tools` (resilientFetch). No new runtime deps.

- 3a605b5: Three backward-compatible developer improvements:

  **Feature 1 — Model retry/backoff:** `AgentConfig.modelRetry?: { maxAttempts: number; backoffMs?: number }` retries transient failures (network errors, 429, 5xx) on the `complete()` path only. Streaming is never buffered or retried. `AbortError` is never treated as transient. Default is OFF (no `modelRetry` config).

  **Feature 2 — Per-turn cost visibility:** Every streamed `assistant` event now carries a `usage: Usage` field with that turn's token counts. The terminal `result` event already carried cumulative `usage` and `cost`; this change surfaces the per-turn breakdown mid-run.

  **Feature 3 — RAG citations:** `MemoryEvent` and `MemorySnippet` gain an optional `metadata?: { source?: string; page?: number; [k: string]: unknown }` field. `Memory.ingest` stores it; `Memory.retrieve` returns it per snippet. The `<recall>` block injected into the system prompt now prefixes each snippet with `[source: X]` when `metadata.source` is set — fully backward-compatible when absent. `ingestDocument` attaches `metadata: { source: <url or docId> }` per chunk automatically. Durable-store persistence of metadata is a follow-up.

### Patch Changes

- 3a605b5: Full-audit remediation + feature wave (PRs #143–#162).

  Security: A2A task ownership + bounded store; per-tenant workflow runs (owner + UUID ids); pre-auth rate limiting + per-client anon buckets; apiKey session ownership; MCP transport auth hook; chunked body cap; prompt-injection escapes (skill_reference/user_input); web_fetch oversize + URL secret stripping; timing-safe OAuth compare; langfuse redaction hooks.

  Correctness: single-connection pg.Pool transactions; atomic libsql upsert; FTS5 quote escaping; pgvector composite (id,scope_key) key; lancedb filter hardening; workflow failed-run recording + composite map errors + abort propagation; react unmount/polling fixes; persisted structured-output retries; sandbox timeouts/abort.

  Features: workflow durable run store + suspend/resume (deterministic replay) + per-step retry + versioning + map collect mode; HMAC-signed webhooks; CORS + graceful drain; onPostToolUse hook; typed terminal result details; per-turn context injection; persistent memory ingest metadata (sqlite/libsql v10, postgres v8 migrations); Bun template; typed useAsyncRun + stream retry; studio share links.

- 3a605b5: Fix SSRF vulnerability in `@eidentic/rag` `ingestDocument({ url })`.

  **`@eidentic/tools`**: add `assertFetchableUrl(rawUrl, opts?)` — a reusable safe-URL guard that
  parses the URL, rejects non-http(s) schemes, rejects private/loopback/link-local/metadata hosts
  via the existing `isBlockedHost`, and optionally enforces a hostname allowlist via `hostAllowed`.
  Exported from the package index alongside the existing helpers.

  **`@eidentic/rag`**: `ingestDocument({ url })` now calls `assertFetchableUrl` before any network
  I/O, blocking requests to cloud-metadata endpoints (e.g. `169.254.169.254`), localhost, RFC-1918
  ranges, and IPv6-mapped private addresses. Redirects are now fetched with `redirect: "manual"` and
  the redirect target is re-validated with the same guard before following (SSRF redirect defense).
  A new optional `allowlist` field on `IngestDocumentOptions` allows callers to further restrict
  which hosts may be fetched.

- 3a605b5: Security hardening: SSRF redirect-chain bypass in `ingestDocument`, OAuth refresh-token loss, and OAuth endpoint scheme validation.

  **@eidentic/rag — FIX 1 (A-P1, SSRF): Redirect-chain bypass in `ingestDocument`.** Previously, after validating and following the first redirect, subsequent hops were issued with `redirect:"follow"` — the platform transparently followed any further redirects (including to internal/metadata addresses) without re-running `assertFetchableUrl`. Now every hop in the redirect chain is issued with `redirect:"manual"` and each `Location` header is re-validated before following, up to a bounded hop count of 5. A redirect to `169.254.169.254`, `127.0.0.1`, or any other blocked address on hop 2+ is now rejected. Exceeding the hop limit also rejects to prevent redirect-loop DoS.

  **@eidentic/rag — FIX 4 (C-P2): Plain string `ingestDocument` URL misuse warning.** A plain `string` source is raw text — no fetch occurs. A `console.warn` is now emitted when the string starts with `http://` or `https://`, since this is almost certainly a misuse (caller probably meant `{ url: "..." }`). Existing behavior is unchanged.

  **@eidentic/mcp — FIX 2 (A-P2): OAuth refresh token dropped on refresh.** When the authorization server's refresh response omits `refresh_token` (permitted by RFC 6749 §6), the prior refresh token is now preserved: `this.tokens = { ...fresh, refreshToken: fresh.refreshToken ?? this.tokens.refreshToken }`. Without this fix, a user was silently logged out when the next expiry cycle triggered a refresh against a now-dropped token. Token rotation (server provides a new refresh token) continues to work correctly.

  **@eidentic/mcp — FIX 3 (A-P2): OAuth endpoint scheme validation.** `beginAuthorizationFlow` and `OAuthConnection` constructor now validate that `authorizationEndpoint` and `tokenEndpoint` use `https:` (OAuth 2.1 mandates HTTPS for all server endpoints) and that `redirectUri` is `https:` or a loopback `http:` address (`localhost`, `127.0.0.1`, `[::1]` — the OAuth 2.1 native-app exception). An `http://evil.com` token endpoint or redirect URI is now rejected at configuration time with a clear error message.

- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
- Updated dependencies [3a605b5]
  - @eidentic/tools@0.1.0
  - @eidentic/types@0.1.0
