---
title: API Reference
description: Per-package API reference for all Eidentic packages.
---

Full generated TypeDoc reference is in progress. Each package ships inline JSDoc on every exported symbol — browse the source or use your editor's hover docs.

## Package index

| Package | npm | Source | Description |
|---|---|---|---|
| `eidentic` | [npmjs.com](https://www.npmjs.com/package/eidentic) | [packages/umbrella](https://github.com/eidentic/eidentic/tree/main/packages/umbrella) | Umbrella: re-exports core, types, model, sqlite, memory |
| `@eidentic/core` | [npmjs.com](https://www.npmjs.com/package/@eidentic/core) | [packages/core](https://github.com/eidentic/eidentic/tree/main/packages/core) | `Agent`, `createTool`, strategies |
| `@eidentic/types` | [npmjs.com](https://www.npmjs.com/package/@eidentic/types) | [packages/types](https://github.com/eidentic/eidentic/tree/main/packages/types) | All ports, DTOs, protocol types |
| `@eidentic/model` | [npmjs.com](https://www.npmjs.com/package/@eidentic/model) | [packages/model](https://github.com/eidentic/eidentic/tree/main/packages/model) | `AIModel`, `AIEmbedder`, `withFallback`, `routeModel`, `cachedModel` |
| `@eidentic/memory` | [npmjs.com](https://www.npmjs.com/package/@eidentic/memory) | [packages/memory](https://github.com/eidentic/eidentic/tree/main/packages/memory) | `Memory`, `ConsolidationScheduler`, `TRANSIENT_MARKERS` |
| `@eidentic/sqlite` | [npmjs.com](https://www.npmjs.com/package/@eidentic/sqlite) | [packages/sqlite](https://github.com/eidentic/eidentic/tree/main/packages/sqlite) | `SqliteStore` (better-sqlite3) |
| `@eidentic/libsql` | [npmjs.com](https://www.npmjs.com/package/@eidentic/libsql) | [packages/libsql](https://github.com/eidentic/eidentic/tree/main/packages/libsql) | `LibsqlStore` (edge-safe, pure-JS) |
| `@eidentic/postgres` | [npmjs.com](https://www.npmjs.com/package/@eidentic/postgres) | [packages/postgres](https://github.com/eidentic/eidentic/tree/main/packages/postgres) | `PostgresStore` |
| `@eidentic/workflow` | [npmjs.com](https://www.npmjs.com/package/@eidentic/workflow) | [packages/workflow](https://github.com/eidentic/eidentic/tree/main/packages/workflow) | `workflow`, `chain`, `parallel`, `map`, suspend/resume, registry |
| `@eidentic/server` | [npmjs.com](https://www.npmjs.com/package/@eidentic/server) | [packages/server](https://github.com/eidentic/eidentic/tree/main/packages/server) | `createServer`, `serveNode`, auth adapters, webhooks |
| `@eidentic/react` | [npmjs.com](https://www.npmjs.com/package/@eidentic/react) | [packages/react](https://github.com/eidentic/eidentic/tree/main/packages/react) | `useEidenticStream`, `useAsyncRun`, `useWorkflowList`, workflow hooks |
| `@eidentic/nextjs` | [npmjs.com](https://www.npmjs.com/package/@eidentic/nextjs) | [packages/nextjs](https://github.com/eidentic/eidentic/tree/main/packages/nextjs) | `withEidentic`, `eidenticNextConfig` |
| `@eidentic/mcp` | [npmjs.com](https://www.npmjs.com/package/@eidentic/mcp) | [packages/mcp](https://github.com/eidentic/eidentic/tree/main/packages/mcp) | `mcpTools` (host), `createMcpServer`, OAuth adapter |
| `@eidentic/browser` | [npmjs.com](https://www.npmjs.com/package/@eidentic/browser) | [packages/browser](https://github.com/eidentic/eidentic/tree/main/packages/browser) | `browserTools`, `PageLike`, SSRF-safe browser automation |
| `@eidentic/rag` | [npmjs.com](https://www.npmjs.com/package/@eidentic/rag) | [packages/rag](https://github.com/eidentic/eidentic/tree/main/packages/rag) | `ingestDocument`, `chunkText`, document loaders |
| `@eidentic/prompts` | [npmjs.com](https://www.npmjs.com/package/@eidentic/prompts) | [packages/prompts](https://github.com/eidentic/eidentic/tree/main/packages/prompts) | `createPromptRegistry`, `filePromptStore`, canary splitting |
| `@eidentic/eval` | [npmjs.com](https://www.npmjs.com/package/@eidentic/eval) | [packages/eval](https://github.com/eidentic/eidentic/tree/main/packages/eval) | Eval harness, LLM judge, `compareReports`, CI gate |
| `@eidentic/langfuse` | [npmjs.com](https://www.npmjs.com/package/@eidentic/langfuse) | [packages/langfuse](https://github.com/eidentic/eidentic/tree/main/packages/langfuse) | `langfuseTracer` — OTLP/HTTP exporter implementing `TracerPort` |
| `@eidentic/tools` | [npmjs.com](https://www.npmjs.com/package/@eidentic/tools) | [packages/tools](https://github.com/eidentic/eidentic/tree/main/packages/tools) | `fileTools`, `bashTool`, `webTools` |
| `@eidentic/skills` | [npmjs.com](https://www.npmjs.com/package/@eidentic/skills) | [packages/skills](https://github.com/eidentic/eidentic/tree/main/packages/skills) | `SkillSet`, `SkillBank`, `evolveSkill` |
| `@eidentic/e2b` | [npmjs.com](https://www.npmjs.com/package/@eidentic/e2b) | [packages/e2b](https://github.com/eidentic/eidentic/tree/main/packages/e2b) | `E2BSandbox` |
| `@eidentic/lancedb` | [npmjs.com](https://www.npmjs.com/package/@eidentic/lancedb) | [packages/lancedb](https://github.com/eidentic/eidentic/tree/main/packages/lancedb) | `LanceDBVectorStore` |
| `@eidentic/pgvector` | [npmjs.com](https://www.npmjs.com/package/@eidentic/pgvector) | [packages/pgvector](https://github.com/eidentic/eidentic/tree/main/packages/pgvector) | `PgVectorStore` |
| `@eidentic/qdrant` | [npmjs.com](https://www.npmjs.com/package/@eidentic/qdrant) | [packages/qdrant](https://github.com/eidentic/eidentic/tree/main/packages/qdrant) | `QdrantVectorStore` |
| `@eidentic/pinecone` | [npmjs.com](https://www.npmjs.com/package/@eidentic/pinecone) | [packages/pinecone](https://github.com/eidentic/eidentic/tree/main/packages/pinecone) | `PineconeVectorStore` |
| `@eidentic/transformers` | [npmjs.com](https://www.npmjs.com/package/@eidentic/transformers) | [packages/transformers](https://github.com/eidentic/eidentic/tree/main/packages/transformers) | `LocalEmbedder`, `LocalReranker` — on-device inference |

## Key types

### `AgentConfig`

```ts
interface AgentConfig {
  id: string;
  model: ModelPort;
  store: StorePort;
  tools?: Tool[];
  instructions?: string;
  memory?: MemoryPort;
  skills?: SkillPort;
  durable?: boolean;
  policy?: CostPolicy;
  prices?: PriceTable;
  tracer?: TracerPort;
  onPreToolUse?: (toolId, input) => PermissionDecision | void;
  onPostToolUse?: (info) => void;
  onPermissionRequest?: (toolId, input) => PermissionDecision;
  onCostThreshold?: (info: CostThresholdInfo) => void;
  guardrails?: GuardrailPort | GuardrailPort[];
  subAgents?: Record<string, SubAgent>;
  compaction?: CompactionConfig;
  strategy?: AgentStrategy;
}
```

See [Agent Hooks](/guides/agent-hooks) for hook semantics.

### `StreamEvent`

The async iterable returned by `agent.query()` yields a union of event types:

| Event type | Description |
|---|---|
| `text_delta` | Incremental model text output |
| `tool_use` | The model is calling a tool |
| `tool.result` | Tool execution result |
| `assistant` | Full assistant turn content |
| `session.init` | Session initialised |
| `compaction` | Context window compacted |
| `result` | Terminal event; `subtype` is `"success"`, `"error"`, `"max_tokens"`, `"max_cost"`, `"aborted"`, `"suspended"`, `"max_wall_clock"`, or `"guardrail"` |

The terminal `result` event carries `usage`, `cost`, `sessionId`, `numTurns`, and (when `outputSchema` was set) `object`.

## Ports (extension points)

Eidentic is built on a ports-and-adapters architecture. Every external dependency is accessed through a port interface.

| Port | Purpose | Adapters |
|---|---|---|
| `StorePort` | Session/event/memory persistence | `SqliteStore`, `LibsqlStore`, `PostgresStore`, `InMemoryStore` |
| `VectorPort` | Vector similarity search | `LanceDBVectorStore`, `PgVectorStore`, `QdrantVectorStore`, `PineconeVectorStore`, `InMemoryVectorStore` |
| `EmbeddingPort` | Text embeddings | `AIEmbedder`, `LocalEmbedder` |
| `RerankPort` | Result re-ranking | `LocalReranker` |
| `ModelPort` | LLM completions | `AIModel`, `withFallback`, `routeModel`, `cachedModel` |
| `SandboxPort` | Sandboxed code execution | `E2BSandbox`, `NoopSandbox` |
| `AuthPort` | Request authentication | `NoAuth`, `ApiKeyAuth`, custom |
| `TracerPort` | Observability spans | `langfuseTracer`, custom OTLP |

## Testing utilities

`@eidentic/types` exports test helpers so you can write unit tests without real infrastructure:

```ts
import {
  InMemoryStore,
  InMemoryVectorStore,
  FakeEmbedder,
  MockModel,
  StreamMockModel,
} from "@eidentic/types";

const agent = new Agent({
  id: "test",
  model: new MockModel(),
  store: new InMemoryStore(),
});
```

`MockModel` returns a scripted sequence of responses; `StreamMockModel` streams them token-by-token.
