# Feature tour — test every Eidentic feature

Every feature ships a runnable `examples/hello-*.ts`. Most are **infra-free** (they fall back to a
scripted `MockModel`, so no API key is needed) — they're the fastest way to see each feature work.

## How to run any example

```bash
# once:
pnpm install && pnpm -r build

# run any feature:
pnpm -C examples hello:<name>

# with a real model (optional — most examples mock when unset):
export ANTHROPIC_API_KEY=sk-ant-...

# see the framework's debug logs on ANY example:
DEBUG=eidentic:* pnpm -C examples hello:<name>
```

> Running as a real consumer instead? Install the package(s) (`npm i eidentic @eidentic/<x>`) and adapt
> the example into your own script. The examples import from the workspace packages, so they exercise
> the exact public API a user gets.

---

## Core agent

| Feature | What it's for | Test |
|---|---|---|
| Stateful ReAct agent | The base loop: reason → tool → observe, event-sourced sessions | `hello` |
| Real model | The same agent against a real provider (AI SDK v7) | `hello:real` (needs key) |
| Token streaming | Stream the model output token-by-token | `hello:stream` |
| Built-in tools | Sealed file / bash / web tools (bash never touches the host; web has SSRF guards) | `hello:tools` |
| Embedded usage | Drop the agent into your own backend (plain `node:http`, no server pkg) | `hello:embedded` |

## Memory (the 4-tier self-improving engine)

| Feature | What it's for | Test |
|---|---|---|
| Lexical recall + blocks | BM25 recall + always-in-context memory blocks (zero infra) | `hello:memory` |
| Semantic recall | Vector recall (LanceDB + local embedder) fused with lexical via RRF | `hello:vector` |
| Hosted embedder | Bring-your-own-key embeddings over any AI SDK provider | `hello:hosted-embedding` |
| Remote vector stores | pgvector / Qdrant / Pinecone adapters (faithful in-memory fakes) | `hello:remote-vector` |
| Temporal knowledge graph | Facts with validity over time; contradictions invalidate, never delete | `hello:graph` |
| Self-editing blocks | The agent edits its own always-in-context memory mid-reasoning | `hello:self-editing` |
| Sleep-time consolidation | Background distillation of episodes → durable facts (grounded, no invention) | `hello:consolidation` |
| Passive extraction + scopes | Auto fact extraction (no LLM) + org/shared memory scopes | `hello:memory-completion` |
| TTL / dedup / scheduler | Fact staleness sweep, archival dedup/merge, single-flight consolidation | `hello:memory-maintenance` |
| Right-to-erasure (GDPR) | Hard-delete all of a scope's data across store + vector + graph | `hello:erasure` |

## Skills (self-developing skills)

| Feature | What it's for | Test |
|---|---|---|
| Prompt skills | `SKILL.md` (agentskills.io) skills the agent searches + uses | `hello:skill` |
| Executable skills | Test-gated executable skills + `allowed-tools` + ed25519 signing + quarantine | `hello:executable-skill` |
| Self-evolution | A skill improves its own playbook; the unit test is the reflection signal (off by default) | `hello:skill-evolution` |

## Multi-agent + interoperability

| Feature | What it's for | Test |
|---|---|---|
| Multi-agent | `spawn_agent` delegation with context isolation + shared tree budget | `hello:multi-agent` |
| MCP host | Consume external MCP servers' tools as first-class Eidentic tools | `hello:mcp` |
| MCP server | Expose Eidentic tools/agents as an MCP server (any MCP-compatible client) | `hello:mcp-server` |
| A2A | Agent-to-Agent protocol: expose an agent + consume a remote one | `hello:a2a` |

## Execution & control (production fundamentals)

| Feature | What it's for | Test |
|---|---|---|
| Durable execution | Checkpoint/resume, exactly-once tool dispatch (survives crashes) | `hello:durable` |
| Cancellation | Cooperative abort → `aborted` result + checkpoint + child teardown (§16.4) | `hello:cancellation` |
| Context compaction | Token-budget-triggered window compaction (keeps failure evidence, atomic tool pairs) | `hello:compaction` |
| Reasoning strategies | `reflection` (different-model critic) / `planAndExecute`, composable over the loop | `hello:strategies` |
| Lazy tool discovery | `search_tools`/`load_tool` — keep the manifest small for large toolsets | `hello:lazy-tools` |
| Schema evolution | Event upcasting (old logs replay on new code) + embedding re-index | `hello:schema-evolution` |

## Security & ops

| Feature | What it's for | Test |
|---|---|---|
| Permissions + secrets | Deny-by-default tool gating; the model never sees secret values | `hello:security` |
| Sandbox | `SandboxPort` (E2B microVM); `NoopSandbox` refuses untrusted exec by default | `hello:sandbox` |
| Rate limiting | Per-tenant token-bucket throttle → 429 + Retry-After | `hello:rate-limit` |
| Quotas | Per-tenant $/token/run ceilings → 402 + soft-cap warning | `hello:quota` |
| Auth (better-auth) | Verify a better-auth session → tenant scope | `hello:better-auth` |
| Cost governor + OTel | On by default — enforce $/token/turn ceilings; OTel GenAI spans. Watch with `DEBUG=eidentic:cost` | (in every run) |
| Debug logging | Namespaced dev logs with secret redaction. Add `DEBUG=eidentic:*` to any example | (any example) |

## Eval & benchmark

| Feature | What it's for | Test |
|---|---|---|
| Eval harness | Score agent runs: deterministic trajectory scorers + LLM-judge + `captureFailure` | `hello:eval` |
| Memory benchmark | recall@k by category over a Memory config + CI baseline gate | `hello:bench` |

## Server / Studio / DX

| Feature | What it's for | Test |
|---|---|---|
| Server (REST+SSE) | Agents-as-a-service: `POST /v1/agents/:id/query` SSE + auth | `hello:server` |
| Studio | Local dev dashboard API (agents/sessions/trace/memory/skills) | `hello:studio` · or `npx eidentic studio` |
| CLI | `eidentic init` (scaffold) · `dev` · `studio` · `doctor` | `npx eidentic <cmd>` |

## Store adapters

| Feature | What it's for | Test |
|---|---|---|
| libSQL / Turso | Edge/serverless store (async, SQLite-compatible) | `hello:libsql` |
| Postgres | Server/scale store (tsvector FTS, pg.Pool or pglite) | `hello:postgres` |
| SQLite | Embedded default store (better-sqlite3) | used by most examples |

---

## Gated live tests (real services)

These have CI-runnable **faithful fakes**; to test against the REAL service, set the env var and run
the package's test suite:

| Package | Real-service env | What it checks |
|---|---|---|
| `@eidentic/transformers` | `EIDENTIC_TEST_MODELS=1` | downloads + runs the real local embedder/reranker |
| `@eidentic/e2b` | `E2B_API_KEY` | real E2B microVM sandbox execution |
| `@eidentic/qdrant` | `EIDENTIC_TEST_QDRANT_URL` | real Qdrant vector store |
| `@eidentic/pinecone` | `EIDENTIC_TEST_PINECONE_*` | real Pinecone index |
| `@eidentic/pgvector` / `@eidentic/postgres` | `EIDENTIC_TEST_PG_URL` | real Postgres (CI uses pglite/WASM) |
| `@eidentic/mcp` | a live MCP server URL | real MCP transport round-trip |

Run a single package's tests: `npx vitest run packages/<pkg>/test/`.
Full suite: `pnpm test` (the command prints the current test count; gated live tests skip unless
their explicit environment variable is set).

Before publishing or requesting a release review, also run `pnpm release:check -- --skip-install`.
The release gate compiles generated CLI templates and documentation examples, enforces performance
budgets, and installs packed tarballs into an isolated consumer to verify ESM/CJS runtime loading
and Node16/NodeNext declaration resolution.
