# eidentic

**Eidentic is the open-source TypeScript SDK for AI agents with self-improving memory and
production fundamentals built in.** Durable execution, enforced cost ceilings, multi-tenant
isolation, GDPR erasure, and sandboxed tools — not bolted on. Apache-2.0. Runs on **Node, Bun,
Deno, and the edge**.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/eidentic/eidentic/blob/main/LICENSE)

## Install

```bash
npm install eidentic ai @ai-sdk/anthropic
# or
pnpm add eidentic ai @ai-sdk/anthropic
```

## Quickstart

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
});

for await (const ev of agent.query("What did we decide last week?", { sessionId: "u-42" })) {
  if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
  if (ev.type === "result") console.log("\nDone:", ev.subtype);
}
```

> **Next.js / serverless:** use `@eidentic/libsql` (pure-JS, no native addon) instead of
> `SqliteStore`. See the [Next.js quickstart](https://github.com/eidentic/eidentic#readme).

## What the umbrella package covers

The `eidentic` package re-exports the core stack so you get everything in one install:

| Included package | What it provides |
|---|---|
| `@eidentic/core` | `Agent`, `createTool`, `ToolRegistry`, strategies, guardrails, permissions |
| `@eidentic/types` | Canonical protocol types and port interfaces |
| `@eidentic/model` | `AIModel`, `AIEmbedder`, price tables, Ollama adapter |
| `@eidentic/sqlite` | `SqliteStore` — durable store over `better-sqlite3` (Node/Bun) |
| `@eidentic/convex` | `ConvexStore` — Convex-backed store + temporal KG + vector (reactive, TS-native) |
| `@eidentic/memory` | `Memory` — four-tier recall, self-editing blocks, knowledge graph |
| `@eidentic/cli` | `eidentic dev` / `eidentic studio` / `eidentic init` commands |

Optional adapters are separate packages — install only what you need:

| Package | Purpose |
|---|---|
| `@eidentic/server` | Hono HTTP server (streaming query, async runs, auth, rate-limiting) |
| `@eidentic/nextjs` | Next.js App Router route helper (`withEidentic`) |
| `@eidentic/react` | React hooks (`useAgent`, `useEidenticStream`, `useWorkflowList`) |
| `@eidentic/libsql` | LibSQL / Turso store (edge-compatible, no native addon) |
| `@eidentic/postgres` | PostgreSQL store adapter |
| `@eidentic/workflow` | Durable workflow orchestration (steps, parallel, retry) |
| `@eidentic/mcp` | MCP host + server with OAuth 2.1 |
| `@eidentic/a2a` | A2A protocol interoperability |
| `@eidentic/skills` | Skill substrate (SKILL.md + executable + self-evolution) |
| `@eidentic/eval` | Eval harness with CI gate and trace promotion |
| `@eidentic/tools` | File, bash, web search, and HTTP tools |
| `@eidentic/rag` | Document ingestion and chunking (PDF / HTML / Markdown) |
| `@eidentic/lancedb` | LanceDB vector store |
| `@eidentic/pgvector` | pgvector (PostgreSQL) vector store |
| `@eidentic/qdrant` | Qdrant vector store |
| `@eidentic/pinecone` | Pinecone vector store |
| `@eidentic/e2b` | E2B Firecracker sandbox adapter |
| `@eidentic/transformers` | Local embedder / reranker (no API key) |
| `@eidentic/langfuse` | Langfuse OTLP tracing |
| `@eidentic/studio` | Local dev dashboard |

## Three pillars

**1. Memory that improves itself.** Four-tier engine: lexical + semantic recall (RRF
fusion), self-editing blocks, a temporal knowledge graph (facts with validity ranges;
contradictions invalidate rather than accumulate), and sleep-time consolidation.

**2. Production fundamentals built in.** Durable checkpoint/resume with exactly-once tool
dispatch, enforced cost ceilings per turn, built-in rate-limiting and quotas,
OpenTelemetry GenAI spans, a structured audit-event stream (permission denials, quota/rate-limit
rejections, auth failures, erasure), deny-by-default permissions, sandboxed code execution, secret
isolation, and one-call GDPR erasure that fans out across every store.

**3. Runs everywhere.** Ports-and-adapters: swap the store, vector backend, embedder, or
sandbox without touching agent code. Verified on Node, Bun, and Deno in CI.

## Links

- [GitHub](https://github.com/eidentic/eidentic)
- [Issue tracker](https://github.com/eidentic/eidentic/issues)
- [Docs](https://github.com/eidentic/eidentic#readme)

Apache-2.0
