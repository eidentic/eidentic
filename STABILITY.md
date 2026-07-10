# Stability policy

Eidentic packages are independently versioned, but releases from this repository are coordinated.
This document describes the compatibility promise for public exports; internal files, undocumented
`dist/` paths, database tables, and event-store implementation details are never public API.

## Versioning contract

| Tier | Compatibility promise |
| --- | --- |
| **Stable** | Breaking changes require a major/coordinated breaking release and migration notes. |
| **Stabilizing** | Breaking changes may ship in a minor release, with migration notes. Patch releases remain compatible. |
| **Experimental** | Shape may change in any release. Do not depend on it without accepting that risk. |

Additive fields on object types and events are non-breaking: consumers should ignore fields they do
not understand. Security fixes may tighten validation or make formerly ambiguous identity/configuration
fail closed. Those changes are documented in the release changeset.

Deprecations are normally announced before removal. A faster removal is reserved for an actively
exploitable vulnerability or for an API explicitly marked experimental.

## Stable APIs

These are the load-bearing framework contracts:

| Area | Public surface |
| --- | --- |
| Agent loop | `Agent`, `agent.query()`, `agent.resume()`, `agent.eraseScope()`, and the `StreamEvent` union (`@eidentic/core`, `@eidentic/types`) |
| Model port | `ModelPort.complete()`, optional `ModelPort.stream()`, and `ModelRequest`/`ModelResponse` (`@eidentic/types`) |
| Store port | Session, event, block, memory, listing, migration, closure, and exact-scope erasure methods on `StorePort` (`@eidentic/types`) |
| Vector port | `upsert`, `search`, `delete`, `eraseScope`, and optional `list` on `VectorPort` (`@eidentic/types`) |
| Memory port | `MemoryPort.getAlwaysInContext()`, `retrieve()`, `ingest()`, plus the editing methods on `EditableMemoryPort` (`@eidentic/types`) |
| Memory engine | `Memory` retrieval/ingestion, block editing, governance export/consent, graph operations, and scope erasure (`@eidentic/memory`) |
| Server | `createServer`, `POST /v1/agents/:agentId/query`, `POST /resume`, async `POST /runs`, `GET /runs/:runId/status`, and `GET /health` (`@eidentic/server`) |
| Eval harness | `evaluate`, `assertPassRate`, `compareReports`, `renderReportMarkdown`, and their exported report types (`@eidentic/eval`) |

`GET /v1/agents/:agentId/sessions/:sessionId/events` is opt-in via `exposeEvents` and is subject
to the configured principal/ownership policy. It is not enabled by default.

## Stabilizing APIs

These are supported and tested, but their ergonomics may still evolve:

| Area | Public surface |
| --- | --- |
| Workflows and HITL | `workflow`, `step`, combinators, `resumeWorkflow`, run registries, and `fileWorkflowRunStore` (`@eidentic/workflow`) |
| Async callbacks | The optional `callbackUrl` on an async run and `ServerOptions.webhooks` delivery policy (`@eidentic/server`); there is no standalone webhook route or `WebhookPort` |
| React client | `useEidenticStream`, `useAgent`, `useAsyncRun`, `useRunStatus`, `useWorkflowList`, and `useWorkflowRun` (`@eidentic/react`) |
| MCP | `mcpTools`, `streamableHttpClient`, `stdioClient`, `serveTools`, `serveAgent`, `createMcpServer`, and `mcpServer` (`@eidentic/mcp`) |
| Server operations | `BatchRunner`, `Scheduler`, workflow listing endpoints, and programmatic run registries (`@eidentic/server`) |
| Provider adapters | Constructor/configuration APIs for SQL, vector, model-provider, observability, sandbox, and framework adapters |

## Experimental APIs

| Area | Notes |
| --- | --- |
| Skill self-evolution | Optimizer/evolution strategy and executable-skill policy are still being refined (`@eidentic/skills`). |
| Agent-to-Agent protocol | `@eidentic/a2a` follows an evolving upstream protocol and may change with it. |

## Adapter conformance

`@eidentic/types/testing` exports shared suites:

- `storeConformanceCases` is exercised by the in-memory reference store and the SQLite, libSQL,
  Postgres, and Convex store adapters.
- `vectorConformanceCases` is exercised by the Convex, LanceDB, pgvector, Qdrant, and Pinecone
  vector adapters. Live-service variants are gated by explicit test environment variables.

Custom adapters can run the same cases:

```ts
import { storeConformanceCases } from "@eidentic/types/testing";

for (const testCase of storeConformanceCases(() => makeStore())) {
  await testCase.run();
}
```

Passing the suite demonstrates conformance to the cases in that installed SDK version. It is not a
blanket guarantee for provider outages, transaction/isolation modes outside the test configuration,
or optional live-service behavior. Changes to stable conformance requirements follow the same
versioning rules as the corresponding port.

## Upgrade guidance

Each published change includes a Changesets entry. Breaking releases include explicit migration
notes and, when storage formats change, compatibility readers or a tested migration path. Release
history is available from the repository's GitHub releases page.
