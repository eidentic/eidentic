---
title: Citations & Grounded Outputs
description: RAG ingestion with source provenance, structured output via outputSchema, and MemorySnippet metadata.
---

Eidentic surfaces provenance at three layers: RAG ingestion attaches source citations to every chunk, structured output validates the model's final object against a Zod schema, and recalled memory snippets carry `ingestedAt` timestamps and arbitrary metadata.

## RAG ingestion with citations

`@eidentic/rag` ingests documents into a `Memory` instance. Each chunk is tagged with the source URL or document id so that when the agent recalls the chunk, it knows where it came from.

```bash
npm install @eidentic/rag
```

```ts
import { ingestDocument } from "@eidentic/rag";
import { Memory } from "@eidentic/memory";
import { AIEmbedder } from "@eidentic/model";
import { LanceDBVectorStore } from "@eidentic/lancedb";

const memory = new Memory({ store, vector: new LanceDBVectorStore("./vectors"), embedder });

// Ingest from a URL — source citation is automatically set to the URL
await ingestDocument("https://docs.example.com/api-reference", { memory, scope });

// Ingest from pre-loaded HTML, with an explicit source tag
await ingestDocument(
  { type: "html", data: "<html>…</html>", source: "https://docs.example.com/api-reference" },
  { memory, scope }
);

// Ingest a local Markdown file with a custom docId
await ingestDocument(
  { type: "markdown", data: fs.readFileSync("./kb/faq.md", "utf8"), source: "faq" },
  { memory, scope, docId: "faq" }
);
```

The `source` field flows into each chunk's `MemoryEvent.metadata.source`. When the agent recalls those chunks, `MemorySnippet.metadata.source` tells you exactly which document the snippet came from.

### `IngestDocumentOptions`

| Option | Type | Description |
|---|---|---|
| `memory` | `IngestableMemory` | Any object with `ingest(events)` |
| `scope` | `Scope` | Memory scope (`{ kind: "user", userId }`, `{ kind: "org", orgId }`, etc.) |
| `docId` | `string` | Stable document id for chunk ids (`${docId}:chunk:${i}`). Defaults to a slug from the URL or hash. |
| `chunk` | `ChunkOptions` | Chunking config forwarded to `chunkText` |
| `fetchImpl` | `typeof fetch` | Override the fetch implementation (must respect `redirect: "manual"`) |

### SSRF in `ingestDocument`

When given a `UrlSource`, `ingestDocument` validates the URL, follows redirects hop-by-hop (manually — never auto-follows), and blocks private/loopback/metadata hosts. Supply a custom `fetchImpl` only if it honours `{ redirect: "manual" }`.

## `MemorySnippet` provenance fields

Recalled snippets carry optional provenance metadata:

```ts
export interface MemorySnippet {
  id: string;
  text: string;
  score: number;
  /** Source citation from the ingested MemoryEvent (when present) */
  metadata?: { source?: string; page?: number; [k: string]: unknown };
  /** Epoch-ms when this entry was ingested (requires store migration to v10+) */
  ingestedAt?: number;
}
```

Use `metadata.source` to build cited responses:

```ts
const { snippets } = await memory.retrieve({ query: userQuestion, scope });

const context = snippets
  .map(s => `[${s.metadata?.source ?? "unknown"}] ${s.text}`)
  .join("\n\n");

// Feed context to the agent as part of the message
```

`ingestedAt` (epoch-ms) is populated by stores that have been migrated to include the `ingested_at` column (SQLite/libSQL v10+, Postgres v8+). It is absent on older stores or pre-migration rows.

## Structured output via `outputSchema`

Pass a Zod schema to `agent.query()` to receive a validated typed object in the terminal `result` event:

```ts
import { z } from "zod";

const CitedAnswer = z.object({
  answer: z.string(),
  sources: z.array(z.string()).describe("Source URLs cited in the answer"),
  confidence: z.enum(["high", "medium", "low"]),
});

for await (const ev of agent.query("What is the refund policy?", {
  sessionId,
  outputSchema: CitedAnswer,
})) {
  if (ev.type === "result" && ev.subtype === "success") {
    const result = ev.object; // typed as z.infer<typeof CitedAnswer>
    console.log("Answer:", result.answer);
    console.log("Sources:", result.sources);
    console.log("Confidence:", result.confidence);
  }
}
```

`ev.object` is the validated output. If validation fails, the run terminates with `subtype: "error"`.

The schema is converted to JSON Schema and sent to the provider as a structured-output hint; validation uses the original Zod schema as the authoritative check.

## Putting it together — a cited RAG agent

```ts
import { z } from "zod";
import { ingestDocument } from "@eidentic/rag";

// 1. Ingest your knowledge base
await ingestDocument("https://docs.example.com/faq", { memory, scope });

// 2. Define a structured output schema with citations
const CitedResponse = z.object({
  answer: z.string(),
  citations: z.array(z.object({ source: z.string(), excerpt: z.string() })),
});

// 3. Query with structured output
const agent = new Agent({
  id: "rag-agent",
  model,
  store,
  memory,
  instructions: "Answer questions using the recalled context. Cite sources.",
});

for await (const ev of agent.query("How do I cancel my subscription?", {
  sessionId,
  userId,
  outputSchema: CitedResponse,
})) {
  if (ev.type === "result" && ev.subtype === "success" && ev.object) {
    console.log("Answer:", ev.object.answer);
    for (const c of ev.object.citations) {
      console.log(`  - ${c.source}: "${c.excerpt}"`);
    }
  }
}
```

## Gotchas

- `ingestDocument` splits content into chunks using `chunkText`. Default chunk size is 512 tokens with a 64-token overlap. Configure via `IngestDocumentOptions.chunk`.
- `metadata` and `ingestedAt` on `MemorySnippet` require the store adapter to have been migrated. Run `eidentic doctor` to check migration status.
- `outputSchema` only applies to the final `result` event — intermediate streaming text is still emitted as `text_delta` events.
