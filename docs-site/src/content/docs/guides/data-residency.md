---
title: Data Residency & Local Models
description: Run fully local or air-gapped — local providers, LocalEmbedder, libSQL embedded store, route-by-sensitivity, GDPR erasure.
---

Eidentic's ports-and-adapters architecture means every external dependency — the model, the embedder, the store — is swappable. You can run entirely on-device with no data leaving the machine.

## Explicit provider pattern

`AgentConfig.model` accepts any `ModelPort`. You control which provider is used, where the data goes, and what is logged. There is no default cloud call.

```ts
import { Agent } from "@eidentic/core";
import { AIModel } from "@eidentic/model";

// Any AI SDK provider — hosted or local
const agent = new Agent({
  id: "local-agent",
  model: new AIModel(yourProvider("model-id")),
  store,
});
```

## Local language models

### Any OpenAI-compatible local server

Most local model runtimes expose an OpenAI-compatible API. Point the AI SDK's OpenAI provider at your local endpoint:

```ts
import { createOpenAI } from "@ai-sdk/openai";
import { AIModel } from "@eidentic/model";

const localProvider = createOpenAI({
  baseURL: "http://localhost:11434/v1", // e.g. Ollama, LM Studio, llama.cpp server
  apiKey: "not-needed",
});

const model = new AIModel(localProvider("llama3.2"));
```

### `createOllamaModel` helper

```ts
import { createOllamaModel } from "@eidentic/model";

// Convenience wrapper — connects to the local Ollama server
const model = createOllamaModel("llama3.2", { baseURL: "http://localhost:11434" });
```

## Local embeddings

`@eidentic/transformers` runs embedding models on-device using the Transformers.js runtime (no GPU required for small models):

```bash
npm install @eidentic/transformers
```

```ts
import { LocalEmbedder } from "@eidentic/transformers";
import { Memory } from "@eidentic/memory";
import { LanceDBVectorStore } from "@eidentic/lancedb";

const embedder = new LocalEmbedder(); // downloads model on first use

const memory = new Memory({
  store,
  vector: new LanceDBVectorStore("./vectors"),
  embedder, // zero API calls for embeddings
});
```

## Embedded store (libSQL / SQLite)

For a fully file-based deployment with no external database:

```ts
import { LibsqlStore } from "@eidentic/libsql";
// or
import { SqliteStore } from "@eidentic/sqlite"; // requires native addon; not edge-safe

const store = new LibsqlStore("file:./eidentic.db"); // pure-JS, bundler-safe
```

`LibsqlStore` uses a local `file:` URL and requires no external libsql server. It is safe in serverless and edge environments.

## Route by data sensitivity

Use `routeModel` to keep sensitive requests on a local model and route public queries to a hosted provider:

```ts
import { routeModel, createOllamaModel, AIModel } from "@eidentic/model";

const model = routeModel(
  (req) => {
    const text = JSON.stringify(req.messages);
    if (text.includes("PII") || text.includes("confidential")) return "local";
    return "hosted";
  },
  {
    local:  createOllamaModel("llama3.2"),
    hosted: new AIModel(hostedProvider("fast-model")),
  },
);
```

See [Model Routing](/guides/model-routing) for more routing patterns.

## GDPR right-to-erasure

Hard-delete all data for a user across every store, vector index, and knowledge graph:

```ts
// Erase all data for a specific user
await memory.eraseScope({ kind: "user", userId: "user-42" });

// Returns how many rows were deleted from each layer
// { store: number, vector: number, graph: number }
```

This permanently removes sessions, events, memory blocks, vectors, and facts for the scope. It cannot be undone.

**Export status:** a memory export API (for GDPR data portability) is on the roadmap and tracked in the GitHub issues.

## Self-hosted observability

Use the Langfuse exporter pointed at your self-hosted Langfuse instance so traces never leave your infrastructure:

```ts
import { langfuseTracer } from "@eidentic/langfuse";

const tracer = langfuseTracer({
  publicKey: "pk-lf-...",
  secretKey: "sk-lf-...",
  baseUrl: "https://langfuse.internal.example.com",
});
```

See [Observability](/guides/observability) for full exporter options including `redactAttributes`.

## Fully air-gapped example

```ts
import { Agent } from "@eidentic/core";
import { createOllamaModel, LocalEmbedder } from "@eidentic/model";
import { LibsqlStore } from "@eidentic/libsql";
import { Memory } from "@eidentic/memory";
import { LanceDBVectorStore } from "@eidentic/lancedb";

const store = new LibsqlStore("file:./agent.db");

const memory = new Memory({
  store,
  vector: new LanceDBVectorStore("./vectors"),
  embedder: new LocalEmbedder(), // on-device embeddings
});

const agent = new Agent({
  id: "local",
  model: createOllamaModel("llama3.2"), // local LLM
  store,
  memory,
  // no tracer → no telemetry egress
});
```

Zero network calls to any external service.

## Gotchas

- `LocalEmbedder` downloads the model weights on first use (~80 MB for the default model). Cache the download directory in CI.
- `LanceDBVectorStore` requires the `@lancedb/lancedb` native addon. For edge/serverless use `QdrantVectorStore` or `PgVectorStore` with a self-hosted instance.
- `LibsqlStore` with a `file:` URL holds a single write lock — run a single process per database file.
- `eraseScope` operates on the scope as a whole. To erase a specific session only, use `store.eraseScope({ kind: "session", sessionId })`.
