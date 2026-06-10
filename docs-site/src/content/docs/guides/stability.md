---
title: Stability & Versioning
description: Eidentic's versioning contract — stability tiers, breaking-change policy, conformance suite promise.
---

Eidentic is pre-1.0 and moving toward a stable v1. Stability is treated as a differentiator: every API is explicitly classified, and breaking changes only happen at predictable version boundaries.

The canonical source of truth is [`STABILITY.md`](https://github.com/eidentic/eidentic/blob/main/STABILITY.md) in the repository root. This page is a summary.

---

## Versioning contract

### Pre-1.0 (current: 0.x)

| Change type | Allowed in |
|---|---|
| Breaking changes to **Stable** APIs | **MINOR** releases only (e.g. 0.5 → 0.6) |
| Breaking changes to **Stabilizing** APIs | MINOR releases |
| Breaking changes to **Experimental** APIs | Any release (MINOR or PATCH) |
| New features (non-breaking) | MINOR or PATCH |
| Bug fixes | PATCH |
| Security fixes | PATCH (or out-of-band) |

**PATCH releases never contain breaking changes to Stable or Stabilizing APIs.**

Every MINOR release with a breaking change ships a changelog entry with migration notes designed to be mechanical (find-and-replace where possible).

### From 1.0

| Change type | Allowed in |
|---|---|
| Breaking changes | **MAJOR** releases only |
| Deprecations | MINOR (runtime warning in the next MINOR or PATCH where feasible) |
| New features | MINOR |
| Bug fixes / security | PATCH |

Deprecations are announced at least **2 MINOR versions before removal**.

---

## Stability tiers

### Stable

These contracts will not change without a MINOR-version breaking-change notice and migration guide.

| Area | Key symbols / packages |
|---|---|
| Core agent loop | `Agent`, `agent.query()`, `StreamEvent` shape (`@eidentic/core`) |
| Store contract | `StorePort` interface (`@eidentic/types`) |
| Vector contract | `VectorPort` interface (`@eidentic/types`) |
| Model contract | `ModelPort` interface (`@eidentic/types`) |
| Server REST surface | `POST /v1/agents/:id/query`, `POST /v1/agents/:id/runs`, `GET /health` (`@eidentic/server`) |
| Memory API | `agent.memory.*` (`@eidentic/memory`) |
| Eval harness | `evaluate`, `assertPassRate`, `EvalReport`, `compareReports`, `renderReportMarkdown` (`@eidentic/eval`) |

### Stabilizing

Functionally complete and used in production, but shape may still evolve based on real-world feedback. Breaking changes require a MINOR bump and migration notes.

| Area | Key symbols / packages |
|---|---|
| Workflow suspend/resume + durable store | `createWorkflow`, `WorkflowRun`, `suspend`, `resume`, durable stores (`@eidentic/workflow`) |
| Webhooks | `POST /v1/agents/:id/webhooks` (`@eidentic/server`) |
| React hooks | `useAgent`, `useWorkflowRun`, `useAsyncRun`, `useRunStatus` (`@eidentic/react`) |
| Batch runner + scheduler | `BatchRunner`, `Scheduler` (`@eidentic/server`) |
| MCP integration | `mcpTools`, `createMcpServer`, OAuth adapter (`@eidentic/mcp`) |

### Experimental

Shape may change in any release including PATCH, and symbols may be renamed, merged, or removed without deprecation notice.

| Area | Notes |
|---|---|
| Skill self-evolution / optimizer | `evolve`, `SkillOptimizer` (`@eidentic/skills`) — optimizer strategy is in flux |
| Agent-to-Agent (A2A) protocol | `@eidentic/a2a` — spec compliance evolves with the upstream protocol draft |

---

## Conformance suite

Every store adapter (SQLite, libSQL, Postgres, LanceDB, pgvector, Qdrant, Pinecone) is validated against a shared conformance test suite before release. If you build a custom `StorePort` or `VectorPort` adapter, run the same suite against it:

```ts
import { storeConformanceCases } from "@eidentic/types/testing";

for (const c of storeConformanceCases) {
  it(c.name, () => c.run(myAdapter));
}
```

Any adapter that passes the conformance suite is guaranteed to work as a drop-in replacement. The conformance cases will not be changed in a way that invalidates passing adapters without a MINOR-version bump.

---

## Upgrade guidance

- **Changelog:** breaking changes and migrations for each release are listed in [CHANGELOG.md](https://github.com/eidentic/eidentic/blob/main/CHANGELOG.md).
- **Questions:** open a discussion or file an issue on GitHub — stability concerns are treated as high priority.
