# 0. Finalized Decisions Log (ADR)

[Index](master-design.md)

This is the authoritative record of locked decisions, resolved from two rounds of June-2026
deep research + an adversarial design review. Each decision is final unless a dated revision
supersedes it. Where research corrected an earlier assumption, the correction is noted.

---

## A0. Package naming convention (locked 2026-06-06)

Packages are **single-word**, scoped `@eidentic/*`, with **no implementation-leaking prefixes**
(never `store-sqlite`, `model-aisdk`, `vector-lance`, `adapter-*`). Two kinds:

- **Capability packages** — core SDK concepts / the single canonical implementation of a concept —
  named by the **concept**: `core`, `types`, `memory`, `skills`, `model`, `multi-agent`, `mcp`, `a2a`,
  `durable`, `sandbox`, `vector`, `observability`, `governance`, `server`.
- **Adapter packages** — one of several interchangeable implementations of a port — named by their
  **concrete technology/vendor**: `sqlite`, `libsql`, `postgres`, `lancedb`, `qdrant`, `cohere`,
  `e2b`, `microsandbox`, `restate`, `temporal`, `dbos`, `langfuse`, `otel`, `better-auth`.

Rationale: `@eidentic/sqlite` + `@eidentic/postgres` scales cleanly where `store` / `store-pg` would be
inconsistent; matches the scoped-package naming convention used across the ecosystem, similar to Prisma and others. Class names also
avoid leaking the underlying lib (the AI-SDK model class is `AIModel`, not `AISDKModel`). **Applied:**
`store-sqlite`→`sqlite`, `model-aisdk`→`model`. Apply to every future package.

---

## A. Technology stack (locked, verified June 2026)

| Layer | Decision | Notes / correction |
|-------|----------|--------------------|
| Language/runtime | TypeScript; **Node 22 min, 24 recommended**; Bun/Deno supported; edge-aware | Node 26 too new for a min baseline |
| Model abstraction | **AI SDK v6** (`ai@^6`, `@ai-sdk/*@^3`) as `ModelPort` only | API: `inputSchema`/`outputSchema` (not `parameters`); structured output via `Output.object/array/choice` (`generateObject` deprecated); their loop class is `ToolLoopAgent` — **we build our own loop**, using AI SDK for single round-trips + provider breadth + `@ai-sdk/mcp` + prompt-cache control |
| Validation | **Standard Schema** (Zod 4 / Valibot / ArkType); JSON Schema via `~standard.jsonSchema` | Valibot needs `@valibot/to-json-schema` |
| Embedded relational store | **better-sqlite3** (Node default) + **libsql** adapter (async / Turso Cloud sync); Bun→`bun:sqlite`; Deno→libsql | **Correction:** `node:sqlite` is RC + **lacks FTS5** (we need FTS5 for BM25) → not the default. "Turso Database"/Limbo is beta — not used. |
| Server relational store | **Postgres** (`@eidentic/store-pg`) + pgvector 0.8.2 | pgvector has **no native BM25**; hybrid = pgvector + tsvector/ParadeDB + RRF |
| Embedded vector + archival FTS | **LanceDB** (`@lancedb/lancedb`, not deprecated `vectordb`) — native vector + FTS + hybrid + built-in `RRFReranker` | in-process, zero-server |
| Lexical/BM25 over event history | **SQLite FTS5** via better-sqlite3 (`bm25()`); `@orama/orama` for pure-JS/edge | archival passages use LanceDB FTS; events use SQLite FTS5 |
| Embeddings | default **local** `@huggingface/transformers` v4 + `bge-small-en-v1.5` (q8) when no key; **hosted** `text-embedding-3-small` / Voyage when configured | `fastembed-js` archived Jan 2026 — do not use |
| Reranker | **OFF by default in embedded** (RRF fusion only). `RerankerPort`: local `bge-reranker-v2-m3` (transformers.js) opt-in; **Cohere rerank v3.5/v4** hosted default in server mode | resolves the "zero-infra cross-encoder" contradiction |
| Token counting | provider-aware dispatcher: `js-tiktoken` (OpenAI), Anthropic `countTokens()` API, Google `countTokens()`; heuristic for hot-path budgeting, reconciled with reported usage | no single tokenizer is portable |
| Durable execution | **In-house SQLite/libSQL checkpoint-resume journal** (default, embedded). Pluggable durable-execution adapters — opt-in | External durable-execution engines need a separate process or Postgres. Embedded "durable" = crash-resume + idempotency, **not** distributed-saga durability |
| Sandbox | `SandboxPort`: **E2B** (cloud default), **microsandbox** (Linux self-host). Embedded-Mac dev default = **`none`** (honest) or remote E2B | **Correction:** Landlock (Linux-only) / Seatbelt (macOS, undocumented) give **no portable** guarantee — do not over-claim OS-level sandboxing |
| Tool/agent protocols | **MCP host+server** in core (spec `2025-11-25`, `@modelcontextprotocol/sdk` v1.x); **A2A** as separate `@eidentic/a2a` (protocol v1.0 stable; wrap `@a2a-js/sdk` behind adapter) | MCP v2 RC (`2026-07-28`) deferred until stable; AP2 deferred |
| Server framework | **Hono** v4 | 2026 edge+Node consensus |
| Auth (server mode) | pluggable **`AuthPort`**; default adapter **better-auth** (MIT, orgs + API keys); Stack Auth secondary; Clerk/WorkOS = BYO adapters | **all auth OSS** — never behind a commercial license |
| Observability | **OpenTelemetry GenAI** via `@opentelemetry/semantic-conventions/incubating` → OTLP; any OTLP-compatible UI | **Correction:** conventions are **Development** status, not Stable — we shield users behind our own stable event types and document that OTel attrs may evolve |
| Skill optimizer | integrate an **external prompt-optimization library** (pure-TS, opt-in) for skill-context refinement; build per-skill memory ourselves; defer multi-objective Pareto optimization | Python-only alternatives archived; pure-TS path is the only viable option |
| Memory controller | **interface-only in v1**; default impl = LLM-heuristic | Research implementations are research-only with no open weights |
| Build | pnpm v10 + Turborepo v2 + **tsup** (+ changesets); migrate to **tsdown** when it hits v1.0 | dual ESM/CJS, subpath exports, `sideEffects:false` |

---

## B. The six open questions (§14.4) — resolved

1. **Skill optimizer:** Integrate an external prompt-optimization library (opt-in, off by default); ship per-skill memory + test-gated versioning in v1; defer multi-objective Pareto optimization and any Python sidecar. Self-evolution is a **research bet, not a default flagship**.
2. **Reranker default:** Off in embedded (RRF only); `RerankerPort` with local (transformers.js bge) opt-in and Cohere hosted in server mode.
3. **Durable default:** In-house SQLite checkpoint-resume journal for v1 embedded; pluggable durable-execution adapters opt-in.
4. **Trainable memory controller:** Ship the `MemoryController` interface; LLM-heuristic default; RL impl deferred.
5. **A2A:** Separate `@eidentic/a2a` package, shipped but optional; wrap the JS SDK behind a Eidentic adapter; AP2 deferred.
6. **Server auth:** `AuthPort` + better-auth default adapter (MIT); Stack Auth secondary; Clerk/WorkOS BYO. All OSS.

---

## C. Adversarial-review fixes (design changes, locked)

These revise the section docs (applied inline; listed here for traceability):

1. **No logit masking.** "Mask, don't remove" is reframed: a restricted tool **stays in the cached schema; the dispatch/permission layer rejects invocation** (returns `permission_denied` to the model). Portable logit-level tool masking does **not** exist across hosted providers. *(updates §4.3, §8.3, §10.2/§10.4)*
2. **Idempotency persistence.** Add an `idempotency_keys` table (key, args_hash, session_id, status `intent|applied`, result_handle, created_at). Keys must include args (e.g. `${orderId}:${amountCents}` or caller request-id), never just an entity id. *(updates §5.2, §9.3, §12)*
3. **Memory port reconciliation.** One narrow contract in `@eidentic/types`, used identically inside the loop and as a drop-in:
   - `getAlwaysInContext(scope): Promise<Block[]>` — **push** (Tier-1 blocks for the stable prefix)
   - `retrieve(query: RetrievalQuery): Promise<RetrievedMemory>` — **pull** (volatile recall)
   - `ingest(events: MemoryEvent[]): Promise<void>` — async write
   `RetrievalQuery`/`MemoryEvent`/`Block` are plain DTOs in `types`, **not** `Session`. Core adapts `Session → RetrievalQuery`. Drop-in consumers get recall for free but must place always-in-context blocks themselves. *(updates §2.5, §3.3, §6.9, §6.11)*
4. **Memory profiles.** `memory: 'lite'` (blocks + lexical/BM25 recall, passive extraction, **no** embeddings/KG/consolidation/rerank) is the **zero-infra hello-world default**. `memory: 'full'` (vector + temporal KG + consolidation + rerank) is opt-in and **acknowledges background LLM cost** (still fully accounted, never hidden). Resolves the "<5 min zero-infra" vs "flagship memory" tension. *(updates §1.7, §6)*
5. **Event-log = three projections, not one byte stream.** The append-only log backs three *views*: (a) **replay state** — deterministic, content-hashed subset (no cost/timestamps in the hash); (b) **trace** — log + ephemeral spans, sampled, exported (OTel); (c) **audit** — immutable, redacted, separately retained. State explicitly; don't conflate. *(updates §9.1, §11.1, §12.6)*
6. **Server-mode "materialization" honesty.** Persisted = agent **config + schemas**; the **code** (tool handlers, strategies, `idempotencyKey` functions) must exist in the server deployment. "Flip a flag" moves *state*, not *behavior*. Non-serializable closures are documented. *(updates §2.4, §2.5)*
7. **Sandbox honesty matrix.** Embedded-Mac dev → `none` or remote E2B; Linux self-host → microsandbox; cloud → E2B. No portable Landlock/Seatbelt guarantee. Secure default for code/skill exec requires a real sandbox adapter; we say so. *(updates §10.5/§10.7)*
8. **Model-selection precedence** (single resolution point immediately before `model.stream`): cascade routing → `prepareStep` override → cost-threshold downgrade. Soft-threshold downgrade affects the step being assembled, not "next turn." *(updates §3.3/§3.6/§11.2)*
9. **Provider-capability registry.** Add a `ModelCapabilityPort`/pricing registry (cache support: explicit/implicit/none; pricing; structured-output mode) so cost + KV-cache features degrade gracefully per provider. *(updates §2.1/§2.3/§11.2)*
10. **Atomic block append.** `appendBlock(scope, label, text)` is a first-class atomic store op (not CAS-replace), so `memory_append` is genuinely safe/commutative. *(updates §6.2/§6.3/§12.1)*
11. **Event-schema versioning + adapter conformance.** Events carry a `schemaVersion`; readers upcast. Every store/vector/durable/sandbox adapter must pass a published conformance suite. *(new §18, updates §12.6)*
12. **Differentiation repositioning.** Lead with **memory-as-a-drop-in** (the falsifiable, near-term win) + **honest production fundamentals**; treat **self-evolving executable skills as a research bet** (off by default). Add explicit content on **how consolidation/extraction reach quality** (the actual hard part) to §6/§7. *(updates §1.4, §6, §7)*

---

## D. New documents (gaps the review found)

Created to fill production-critical gaps:

- **§15 — Data Governance, PII, Retention & Erasure** (right-to-erasure across event log + vector + KG + checkpoints + traces; redaction; retention; residency hooks). *Reconciles "store complete spans" with GDPR.*
- **§16 — Concurrency, Cancellation & Backpressure** (single-agent parallel-request model + hot-agent locking/queueing for shared/org blocks; AbortSignal rollback; streaming flow-control; consolidation job queue + dedup).
- **§17 — Error Taxonomy & Recovery** (typed error hierarchy → `TerminationSubtype`, retries, traces).
- **§18 — SDK Testing & Adapter Conformance** (how Eidentic is tested: in-memory fakes, property tests for CAS/idempotency/replay-determinism, adapter conformance suite).
- **§19 — Schema & Prompt Evolution** (event upcasting; embeddings re-index/dimension migration; multi-vector coexistence; system-prompt versioning).
- **§20 — Secrets, Rate Limiting & Quotas** (`SecretsPort`, rotation, per-tool scoping, embedded-mode secrets; per-user/org/key rate limits, provider-429 coordination, batch APIs).

---

## E. v1 scope (phase split, locked)

The full spec is a multi-phase effort. v1 is deliberately the **memory-led credible core**:

**v1 — "a stateful agent that doesn't lie about cost or crash":**
- §3 loop (ReAct only; defer plan-execute/reflection strategies), §3.2 protocol, §3.4 guards.
- §4 context engine (append-only, KV-cache prefix, compaction stages 1–3; **no** logit-masking; **no** object-store offload yet).
- §5 tools, sealed endpoints, lazy discovery, **MCP host** (defer MCP server to v1.1).
- §6 **memory `lite`** (blocks w/ CAS+atomic-append, recall = vector+BM25+RRF, passive+agentic extraction; **no** cross-encoder, KG, or consolidation). Ships the **drop-in** adapter.
- §9 durable = **in-house SQLite checkpoint/resume + idempotency**; fast/durable paths.
- §10 schema-filter permissions, deny-by-default, human-gates, **E2B sandbox adapter** (honest `none` default on laptop).
- §11 OTel tracing + **cost governor (enforcement)**; defer eval harness to v1.1.
- §12 data model **with** idempotency table + event `schemaVersion`.
- §13 packaging, semver discipline, read-only studio.
- §15 minimal (erasure API + retention), §16 minimal (abort + single-writer guidance), §17 error taxonomy.
- Embedded mode primary; minimal `@eidentic/server`.

**v1.1–v1.2 — differentiators, hardened:** memory `full` (temporal KG + consolidation + rerank), eval harness + memory benchmarks, MCP server, multi-agent (agent-as-tool + shared blocks), plan-execute/reflection strategies, interop SKILL.md skills.

**v2 — research bets & scale:** self-developing executable skills with provenance/signing + prompt optimization, pluggable durable-execution adapters, A2A, Postgres/multi-tenant server hardening, multi-region, Python SDK.

> The hard rule from the review: **do not gate v1 on the two least-proven subsystems** (self-evolving skills, full agentic memory). Ship the memory-led core; earn the right to the research bets.
