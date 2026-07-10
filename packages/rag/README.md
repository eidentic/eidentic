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
  {
    memory,
    scope: { kind: "user", agentId: "my-agent", userId: "u-1" },
    allowlist: ["docs.example.com"],
    maxResponseBytes: 5 * 1024 * 1024,
    timeoutMs: 10_000,
  },
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

URL ingestion uses the shared `@eidentic/tools` safe-egress boundary: URL credentials and
non-global/private A/AAAA answers are rejected, redirects and retries are revalidated, binary
media types are refused, and response bytes/body time are bounded. URL fetching is disabled when
`allowlist` is omitted or empty, and HTTPS is required. Deprecated unsafe migration options may be
used only behind an equivalent network boundary. DNS validation cannot pin
the later Fetch connection, so untrusted URL ingestion should also run behind an egress
proxy/firewall. Query strings and fragments are omitted from stored citation metadata.
After redirects, citation metadata records the final validated URL rather than the untrusted
starting URL.

`pdf-parse` is loaded through Node's real `createRequire` path in both ESM and CommonJS builds.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Root README](https://github.com/eidentic/eidentic#readme)

Apache-2.0
