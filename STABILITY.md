# Stability Policy

Eidentic's coordinated repository release is v1.0. npm packages in this monorepo are
independently versioned, so some package versions may still be below 1.0; the stability
tiers below define what you can rely on, at what boundary breaking changes may occur,
and which parts of the API are still being refined.

---

## Versioning contract

### From the v1 release line

| Change type | Allowed in |
| ----------- | ---------- |
| Breaking changes to **Stable** APIs | Explicit coordinated breaking release only, with migration notes |
| Breaking changes to **Stabilizing** APIs | MINOR releases, with migration notes |
| Breaking changes to **Experimental** APIs | Any release (MINOR or PATCH) |
| New features (non-breaking) | MINOR or PATCH |
| Bug fixes | PATCH |
| Security fixes | PATCH (or out-of-band) |

**PATCH releases never contain breaking changes to Stable or Stabilizing APIs.**

Every release that contains a breaking change ships a changelog entry with migration notes
that describe exactly what changed and how to update call sites. We aim for mechanical,
find-and-replace migrations wherever possible.

Deprecations are announced at least **2 MINOR versions before removal** and, where the
runtime shape allows it, ship a `console.warn` deprecation notice so call sites are visible
in logs without requiring a code audit.

---

## Stability tiers

### Stable

The contracts below are the most load-bearing parts of the framework. They will not change
without an explicit breaking-change notice and migration guide.

| Area | Key symbols / packages |
| ---- | ---------------------- |
| Core agent loop | `Agent`, `agent.query()`, `AgentEvent` stream shape (`@eidentic/core`) |
| Store contract | `StorePort` interface — `append`, `list`, `erase`, `migrate` (`@eidentic/types`) |
| Vector contract | `VectorPort` interface — `upsert`, `query`, `delete`, `clear` (`@eidentic/types`) |
| Model contract | `ModelPort` interface — `call`, `stream` (`@eidentic/types`) |
| Server REST surface | `POST /v1/agents/:id/query`, `POST /v1/agents/:id/runs`, `GET /health` (`@eidentic/server`) |
| Memory API | `agent.memory.*` — `remember`, `recall`, `erase`, `consolidate` (`@eidentic/memory`) |
| Eval harness | `evaluate`, `assertPassRate`, `EvalReport`, `compareReports`, `renderReportMarkdown` (`@eidentic/eval`) |

### Stabilizing

These APIs are functionally complete and used in production, but their shape may still
evolve based on real-world usage feedback. Breaking changes require a MINOR bump and
migration notes.

| Area | Key symbols / packages |
| ---- | ---------------------- |
| Workflow suspend/resume + durable store | `createWorkflow`, `WorkflowRun`, `suspend`, `resume`, durable file/DB store (`@eidentic/workflow`) |
| Webhooks | `POST /v1/agents/:id/webhooks`, `WebhookPort` (`@eidentic/server`) |
| React hooks | `useAgent`, `useWorkflowRun`, `useAsyncRun`, `useRunStatus` (`@eidentic/react`) |
| Batch runner + scheduler | `batchRunner`, `scheduler` (`@eidentic/server`) |
| MCP integration | `MCPClient`, `MCPServer`, OAuth adapter (`@eidentic/mcp`) |

### Experimental

These areas are under active development. Their shape may change in any release, including
PATCH, and they may be renamed, merged, or removed without deprecation notice. Do not build
production dependencies on them without accepting this risk.

| Area | Notes |
| ---- | ----- |
| Skill self-evolution / optimizer | `evolve`, `SkillOptimizer` (`@eidentic/skills`) — optimizer strategy is in flux |
| Agent-to-Agent (A2A) protocol | `@eidentic/a2a` — spec compliance is evolving with the upstream protocol draft |

---

## Conformance suite promise

Every store adapter (SQLite, libSQL, Postgres, LanceDB, pgvector, Qdrant, Pinecone) is
validated against a **shared conformance test suite** before release. The suite exercises
the full `StorePort` and `VectorPort` contracts including edge cases (concurrent writes,
erase fan-out, migrate idempotency).

**What this means for you:** if you implement a custom `StorePort` or `VectorPort` adapter,
you can import and run the same conformance cases against your implementation:

```ts
import { storeConformanceCases } from "@eidentic/types/testing";

for (const c of storeConformanceCases) {
  it(c.name, () => c.run(myAdapter));
}
```

Any adapter that passes the conformance suite is guaranteed to work correctly as a drop-in
replacement for the built-in stores. We will not change the conformance cases in a way that
invalidates passing adapters without an explicit migration release and migration notes.

---

## Questions and upgrade guidance

- **Changelog:** breaking changes and migration notes are generated from changesets at each
  release. See [GitHub releases](https://github.com/eidentic/eidentic/releases) for the
  history from v1.0 onward.
- **Questions:** open a discussion or file an issue on GitHub — stability concerns are
  treated as high-priority.
