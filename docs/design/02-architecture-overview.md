# 2. Architecture Overview

[← 1. Vision](01-vision-principles.md) · [Index](master-design.md) · Next: [3. Agent Loop →](03-agent-loop.md)

## 2.1 Design philosophy: ports & adapters (hexagonal)

Eidentic is built as a **hexagonal (ports-and-adapters) architecture**. The runtime core
depends only on *interfaces* (ports); concrete infrastructure (LLM providers, storage,
vector stores, sandboxes, durable engines, tracers) are *adapters* that satisfy those
ports. This is the structural enforcement of Constitution principle #1 (composable, no
lock-in) and #3 (swappable fundamentals).

```
                         ┌──────────────────────────────┐
   Driving adapters  →   │            CORE               │   ← Driven adapters
   (how you call it)     │   (depends on ports only)     │   (what it depends on)
                         │                              │
   • SDK API (query)     │   Agent loop                 │   • ModelPort   → AI SDK v6
   • CLI                 │   Context engine             │   • StorePort   → libSQL / PG
   • Server (REST)       │   Tool dispatch              │   • VectorPort  → LanceDB / pgvector
   • Workflow/pipeline   │   Memory orchestrator        │   • SandboxPort → E2B / microsandbox
                         │   Skill orchestrator         │   • DurablePort → pluggable durable-execution backends
                         │   Multi-agent coordinator    │   • TracerPort  → OTel exporter
                         │   Permission + cost governor │   • MCPPort     → MCP host/server
                         └──────────────────────────────┘
```

**Rule:** core code never imports a concrete adapter. Adapters are injected at
construction. This makes every fundamental (storage, durability, sandbox, tracing)
replaceable and testable with in-memory fakes.

## 2.2 Package graph

Each package is independently consumable and independently versioned (but released
together via Changesets with a shared compatibility range). Arrows = "depends on".

```
                         @eidentic/types         (zero-dep: ports, schemas, message types)
                              ▲   ▲   ▲
            ┌─────────────────┘   │   └─────────────────┐
   @eidentic/core              @eidentic/memory      @eidentic/skills
   (loop, context,                 │                    │
    tools, permissions)            │                    │
        ▲   ▲   ▲                  │                    │
        │   │   └─────── @eidentic/multi-agent           │
        │   └─────────── @eidentic/mcp                    │
        │                                                │
   ┌────┴───────────────────────────────────────────────┴────┐
   │ Fundamentals (adapters + cross-cutting, depend on types) │
   │  @eidentic/model   @eidentic/durable   @eidentic/sandbox    │
   │  @eidentic/observability                                  │
   │  @eidentic/sqlite   @eidentic/postgres   (StorePort)       │
   │  @eidentic/lancedb  @eidentic/qdrant     (VectorPort)      │
   └──────────────────────────────────────────────────────────┘
   (adapter packages are named by their concrete tech — §0-A0)
        ▲
   @eidentic/server   (optional REST API + agents-as-a-service)
        ▲
   eidentic            (CLI + create-eidentic scaffolding + dev studio)
```

Key properties:

- **`@eidentic/types` is the contract hub.** It contains *only* TypeScript types, Zod/
  Standard-Schema definitions, port interfaces, and the message/streaming protocol. It
  has zero runtime dependencies, so anyone (including non-Eidentic code) can implement an
  adapter or a memory consumer against it.
- **`@eidentic/memory` and `@eidentic/skills` depend on `types`, not `core`.** This is what
  makes them genuine drop-ins: you can use the memory engine inside any custom loop without
  pulling in the Eidentic runtime. This addresses the #1 memory-layer complaint: "not a
  memory layer — the stack itself."
- **Fundamentals are separate packages with default + alternative adapters.** Storage and
  vector adapters are split so the core bundle never pulls a heavy optional dependency,
  keeping bundles small and serverless-friendly.

## 2.3 Subpath exports & bundle discipline

Every package ships ESM + CJS dual output (tsup) with **granular subpath exports** and
`sideEffects: false`. Importing `@eidentic/core/agent` must not transitively pull storage
or vector code. The default `@eidentic/core` entry contains an in-memory store/vector fake
so "hello world" needs no infra, and production adapters are opt-in installs.

Anti-pattern explicitly avoided: unconditionally bundling `@libsql/client` into core.
Our `@eidentic/store-libsql` is a separate package; core ships only the `StorePort`
interface + an in-memory implementation.

## 2.4 The hybrid library ↔ server model

The same core runs in two modes; the boundary is the adapter set, not a code fork.

| Concern | Embedded (library) mode | Server mode |
|---------|------------------------|-------------|
| Process | Developer's own process | `@eidentic/server` (Hono) |
| Store | libSQL/SQLite (local file) or in-memory | Postgres (`@eidentic/store-pg`) |
| Vector | LanceDB (in-process) | pgvector or external Qdrant |
| Durable | In-house SQLite journal or in-memory | Pluggable durable-execution adapters |
| Access | `query()` / `Agent` API in-process | REST API, `agent_id`-addressed |
| Identity | caller-managed | multi-tenant (org/user scoping) |
| Sandbox | local microsandbox / none | E2B fleet |

**`Agent` is the same object in both modes**, but be precise about "materialized from a persisted
record" (correction from review §0-C6): the store persists the agent's **config + schemas**
(instructions, model, tool/skill *schemas*, policies) — **not its code**. Tool *handlers*, custom
strategies, and `idempotencyKey` functions are JS closures and **cannot** be persisted; they must
exist in the server deployment's codebase. So "flip a flag to server mode" moves **state**, not
**behavior** — the same code package runs in both modes, just with Postgres + REST in front. A
developer prototypes embedded, then sets `mode: 'server'` + a Postgres URL to scale the *state and
access layer* with no rewrite of agent logic. (Answers the "clean transition path" without
the false promise that behavior is reconstructed from a DB row.)

## 2.5 The five core abstractions

Everything composes from five primitives, each defined in `@eidentic/types`:

1. **`Agent`** — a configured, addressable unit: instructions, model, tools, skills,
   memory binding, policies (cost/permission), and durability settings. Stateless to
   construct; its *state* lives in the store, keyed by `agentId` + scope.
2. **`Tool`** — a typed capability: `{ id, description, inputSchema, outputSchema,
   execute, annotations }`. Tools are pure functions of input → output plus declared
   side-effect annotations (read-only/destructive/idempotent) used by permissions, cost,
   and durability.
3. **`Memory`** — the self-improving store bound to a `(agentId, scope)`: blocks +
   archival + temporal graph + vector recall, plus the consolidation job. Exposed both as
   automatic context injection and as explicit tools the agent can call.
4. **`Skill`** — a packaged, discoverable capability (SKILL.md interop *or* executable
   test-gated code) with its own per-skill memory and provenance.
5. **`Session`** — a durable run/thread: an append-only event log of messages, tool
   calls, checkpoints, and traces, resumable and forkable.

These mirror proven primitive sets from across the ecosystem but are unified under one contract package.

## 2.6 Data flow of a single agent turn

```
caller → Agent.query(input)
   │
   ├─ 1. Session: append user event (durable checkpoint #n)
   ├─ 2. Memory: retrieve (blocks always-in-context + multi-signal recall)
   ├─ 3. Context engine: assemble window
   │        (stable cached prefix | memory | tools manifest | recent events | input)
   ├─ 4. Cost governor: pre-flight budget check (tokens/$/iterations) — may abort
   ├─ 5. Permission: filter tool schemas for this turn (deny-by-default)
   ├─ 6. ModelPort: stream completion  ──► emit StreamEvents to caller
   │        ├─ text → AssistantMessage
   │        └─ toolCalls →
   ├─ 7. Tool dispatch: validate → permission gate → (sandbox if needed) → execute
   │        read-only tools run in parallel; mutating tools serialize
   │        each tool result is a durable checkpoint + OTel span
   ├─ 8. Append tool results; loop to 3 until no tool calls or a stop condition
   ├─ 9. Memory: enqueue async write (episodic); schedule consolidation if due
   └─ 10. Session: finalize → ResultMessage (usage, cost, termination subtype)
```

Each numbered stage is a port boundary with an OTel span. Stages 1, 7 produce durable
checkpoints. Stages 2, 9 are the memory hooks. Stage 4 is the cost backstop. This single
diagram is the backbone the later sections elaborate.

## 2.7 Extension points (how users customize without forking)

- **Adapters** (ports) — swap any infrastructure.
- **Hooks/middleware** — typed lifecycle events (pre/post tool, pre-compact, session
  start/stop, pre-model, on-cost-threshold). See [Section 3](03-agent-loop.md).
- **Processors** — input/output guardrails around the model call (PII, injection,
  schema). Pure, composable, parallelizable when non-mutating.
- **Custom tools, skills, memory strategies** — register implementations of the contracts.
- **Policies** — declarative cost/permission/retention config objects.

## 2.8 Cross-cutting concerns are first-class, not middleware afterthoughts

Durability, observability, cost, and permission are **woven into the turn loop at defined
stages** (2.6), not left to optional plugins. This is the central architectural bet from
the research: frameworks that bolt these on later die. A developer can *tune* them
(thresholds, exporters, adapters) but cannot accidentally run without them — the defaults
are safe (in-memory tracer, conservative caps, deny-by-default perms) and always present.

## 2.9 Technology substrate (defaults; all swappable)

- **Language/runtime:** TypeScript, Node 22+ / Bun / Deno; edge-aware (no hard Node-only deps in core).
- **Model abstraction:** AI SDK v6 (`ai`) behind `ModelPort`.
- **Validation:** Standard Schema (Zod 4 / Valibot / ArkType) for all tool/skill/memory schemas.
- **Store:** **better-sqlite3** (Node embedded default; ships FTS5 for BM25) + **libsql** adapter
  (async / Turso Cloud); Bun→`bun:sqlite`; Deno→libsql → **Postgres** (scale). *(`node:sqlite` lacks
  FTS5 and is RC — not the default.)*
- **Vector:** LanceDB (embedded, native vector+FTS+RRF) → pgvector / Qdrant.
- **Durable:** **in-house SQLite checkpoint-resume journal** (default) → pluggable durable-execution
  adapters (opt-in, separate installs).
- **Reranker:** off in embedded `lite` (RRF only) → `RerankerPort`: local bge (transformers.js) /
  Cohere (hosted) in `full`/server.
- **Sandbox:** E2B (cloud) / microsandbox (Linux self-host); `none` on Mac dev (honest, §10.5).
- **Tracing:** OpenTelemetry GenAI (incubating; conventions still "Development") → any OTLP backend
  (a self-hostable open-source UI by default); shielded behind our own stable event types.
- **Protocols:** MCP host+server (core) + A2A (`@eidentic/a2a`, optional). **Auth:** `AuthPort` +
  better-auth default (OSS). **Server:** Hono.
- **Build:** pnpm + Turborepo + tsup (→ tsdown at its v1.0) + Changesets; Node 22 min / 24 rec.

See [Section 0](00-decisions.md) for the fully verified stack table and rationale.
