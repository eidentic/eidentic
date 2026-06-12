# Eidentic — Post-launch engineering roadmap (VERIFIED against source)

> **INTERNAL — do not commit to the public repo.** Like LAUNCH-KIT.md.
> Source-verified June 2026 by 5 parallel code audits. Do after the June 16 launch.
>
> **Context:** a design partner on a **Convex + LiteLLM** stack evaluated Eidentic for a
> memory-engine pilot and produced an 11-item gap list. We verified each item against the
> actual `packages/*` source. Most items are generic SDK concerns (worth building for
> everyone); a few are app-specific (don't build).

---

## TL;DR

**Several "blockers" are already solved — they just read as ❌ because they're undocumented.**

- **#3 Single-gateway (LiteLLM) enforcement → FULL PASS today.** No internal code path constructs
  a provider or hits a hardcoded endpoint. Every LLM/embedding call (agent loop, memory
  extraction/consolidation, embeddings, sub-agents, guardrails, strategies, judges, skills) goes
  through an injected `ModelPort`/`EmbeddingPort`. A user forces 100% of traffic through one
  OpenAI-compatible base-URL purely by config. → **docs only.**
- **#2 Durable HITL approval gates → REAL.** `ctx.suspend()` → run terminates → persisted to
  store (`DurablePort.recordDecision`, `suspension_decisions` table) → survives redeploy →
  `agent.resume(sessionId, {decision})` re-dispatches. Only missing: an `assignee` field.
- **#8 better-auth → adapter EXISTS** (`@eidentic/better-auth` `betterAuthPort()`, maps
  `userId`/`orgId`). Missing: principal → per-request permission policy bridge.
- **#5 memory provenance/temporal/staleness/consent/export/versioning → all present & tested.**

**Real generic gaps worth building (post-launch):** generic audit bus (#9), `VectorPort.list` on
production adapters (#7 — currently a silent no-op = a real bug), per-request permission resolver
(#8), org-scope derivation + org-quota (#11), `LexicalPort` extraction (#6), FTS-less store
fallback + custom-store guide (#1).

**Don't build (app's job, not the SDK's):** visual workflow node-graph builder + NL generator
(#4), Convex streaming bridge (#10), sub-org namespaces (#5).

**Pilot:** memory-engine-only. Convex stays source-of-truth; gateway via LiteLLM works today.

---

## Verified status — all 11

| # | Requirement | Status | Evidence (file:line) | Gap | Effort | Build? |
|---|---|---|---|---|---|---|
| 1 | Custom store port (Convex BYO-store) | 🟡 | `types/src/ports.ts:256-296` (StorePort), `STABILITY.md:53,87` (Stable + conformance suite) | No "write a store" guide; **stale README shows `putBlock` not `upsertBlock`**; `searchMemory` assumes native FTS (Convex has none) | S (guide/README), M (FTS fallback), L (official adapter) | Guide+fallback = ✅ generic; Convex adapter = bespoke |
| 2 | Durable HITL approval gates | ✅ | `core/tool.ts:321`, `core/loop.ts:1243-1274`, `agent.ts:938-979`, `sqlite/migrations.ts:104` | No `assignee`/required-approver field | S | ✅ add field, else docs |
| 3 | Force all calls through one OpenAI-compatible gateway | ✅ | `model/src/model.ts` (only imports `"ai"`), `memory/consolidate.ts:128`, `core/loop.ts:873`, audit found **zero** hardcoded providers | None (docs only) | S | ✅ docs |
| 4 | Visual workflow engine (node graph + NL gen) | 🟡 | `workflow/*` (durable code runtime: step/branch/parallel/retry/suspend/resume/versioning, file-store) | Visual builder + NL generator absent | — | ❌ BESPOKE (their product) |
| 5 | Human-governed memory | mixed | provenance/temporal/consent/export/version all ✅ (`memory.ts:756,788,872,939`, `governance.test.ts`); scopes ✅ (`ports.ts:24-29`) | **human pre-write approval/flag ❌**; sub-org namespaces ❌ | M-L | approval-gate = ✅ generic hook; sub-org = bespoke |
| 6 | Pluggable lexical backend (Meilisearch) | ❌ | FTS hardcoded in `StorePort.searchMemory` (`sqlite/index.ts:42`, `postgres/index.ts:71`); no `LexicalPort` | Extract a `LexicalPort` seam | M | ✅ generic |
| 7 | Org-filtered Qdrant + gateway embeds + migration | 🟡 | Qdrant `scope_key` filter ✅ (`qdrant/index.ts:111`); embedder injected ✅ | **`VectorPort.list` not implemented on Qdrant/pgvector/LanceDB/Pinecone → `reindexEmbeddings` is a silent no-op in prod**; no cross-store import | S each (list), M (import) | ✅ generic (fix the no-op) |
| 8 | Pluggable auth/permission → better-auth | 🟡 | `AuthPort` ✅, `betterAuthPort()` ✅ (`better-auth/index.ts:60`), principal carries userId/orgId/apiKey | `PermissionPolicy` has no role/org dim; principal identity doesn't flow into permission eval | S-M | ✅ add `permissionsFor(principal)` resolver |
| 9 | Generic domain audit sink (actor/org) | 🟡 | `onPostToolUse` exists (`agent.ts:148`) — tool calls only; OTel via `TracerPort` | No unified `onAuditEvent` bus for model/memory/permission events with actor/org tags | S | ✅ generic — high ROI |
| 10 | Streaming bridge to reactive UI (Convex) | ✅ | `agent.query()` = `AsyncIterable<StreamEvent>`, typed union `protocol.ts:195-261` | None — `for await` + write to Convex is ~5 lines | 0 | ❌ BESPOKE app glue |
| 11 | Multi-tenant org isolation (all subsystems) | 🟡 | vector/rate/quota org-isolation ✅; `Scope` has `org` kind | **core never derives `{kind:"org"}` scope** (`agent.ts:765` builds only user/agent); no org-aggregate quota | S (scope) + M (quota) | ✅ generic |

---

## Work items (prioritized, do after June 16)

### P0 — Docs + cheap fixes (closes half the "❌"s honestly, ~1-2 days total)
1. **Gateway guide** (#3): "Use any OpenAI-compatible gateway — LiteLLM / OpenRouter / vLLM /
   Ollama. Point `AIModel`, `AIEmbedder`, and every `ModelPort` (consolidator, guardrail,
   strategies, judges) at one base-URL." Include the embedder + memory-model config so 100% of
   traffic is provably single-gateway.
2. **Custom store adapter guide** (#1) + **fix the stale `@eidentic/types` README** (`putBlock`
   → `upsertBlock`/`appendBlock`). Document the minimum viable StorePort subset and the
   conformance suite.
3. **Durable HITL approval guide** (#2): the suspend → persist → resume flow + the store-durability
   requirement (use libSQL/Postgres or a persisted SQLite file for multi-day/cross-instance pauses).
4. **better-auth → permission bridge pattern** (#8): how `userId`/`orgId`/role flow into
   `onPreToolUse`/`onPermissionRequest` today.
5. **Org-tenancy wiring note** (#11): current guarantees + the org-scope caveat.

### P1 — Small generic features (high ROI, ~days each)
6. **Generic audit bus** (#9): `onAuditEvent(e: AuditEvent)` emitting typed events
   (`tool_call` | `model_call` | `memory_write` | `permission_decision` | `run_result`) tagged
   `{ actorId, orgId, sessionId, agentId }`. Generalize from the existing `onPostToolUse` shape.
   *(This is the single best "design-partner→everyone" feature — pipe to Convex auditLog, Datadog, anything.)*
7. **`VectorPort.list` on production adapters** (#7): Qdrant/pgvector/LanceDB/Pinecone — fixes
   `reindexEmbeddings` + `deduplicateArchival` being silent no-ops in production. **Real bug.**
8. **`permissionsFor(principal): PermissionPolicy`** per-request resolver on `ServerOptions`/agent
   (#8) — wire identity → policy. Hooks already exist; this is the documented seam.
9. **Org-scope derivation** (#11): optionally derive `{kind:"org"}` from `orgId` (needs a design
   decision on user-vs-org memory fan-out). + optional `assignee` on suspension (#2).

### P2 — Larger generic features (~weeks)
10. **Extract `LexicalPort`** from StorePort (#6) → enables Meilisearch/Typesense adapters.
11. **FTS-less store fallback** (pure-JS BM25 in the `searchMemory` path) (#1) → lets non-FTS
    stores (Convex) satisfy the contract; unblocks a community Convex adapter.
12. **Org-aggregate quota** (hierarchical ledger) (#11).
13. **Cross-store vector import tooling** (#7).
14. **Official `@eidentic/convex` store (+ vector)** adapter (#1) — flagship integration; ship
    *after* the LexicalPort + FTS-fallback land so it's clean. Great launch-week-2 announcement.
15. **Human-memory-approval gate** (#5): a generic pre-write hook around `EditableMemoryPort`
    (enqueue edit → human approves → write), rather than a bespoke pipeline.

### Won't build — app's responsibility
- **#4 Visual workflow node-graph + NL generator** — the partner's product surface.
  `@eidentic/workflow` already provides the durable runtime to build it on.
- **#10 Convex streaming bridge** — ~5 lines of app glue over `agent.query()`.
- **#5 sub-org namespaces (contact/business/team)** — app convention over `org` scope, or a
  custom scope kind the partner adds.

---

## Pilot path (give to the partner now — works on today's 0.1.x)

A **narrow memory-engine pilot**, not a full migration:
1. Keep **Convex as source-of-truth** and keep their workflow/UI/auth as-is.
2. Use **Eidentic Memory** as a component: temporal KG (facts with validity + supersedes +
   `factTimeline`), scoped recall, staleness, consent/export. This is where Eidentic genuinely
   beats an add-only memory layer.
3. **Gateway:** construct `AIModel` + `AIEmbedder` + the consolidator model with
   `createOpenAI({ baseURL: <litellm> })(...)` → 100% through LiteLLM today.
4. **Store:** either implement a thin Convex `StorePort` against the documented interface, or run
   memory on libSQL/Postgres alongside Convex for the pilot (decouples the store decision from the
   memory eval).
5. Measure: recall quality + temporal correctness vs their current Meilisearch+Qdrant Ask-bar.

This validates our strongest differentiator with a real user, with zero changes to their Convex
backbone — and feeds items 6–11 above with real-world signal.
