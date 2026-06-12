# Eidentic

**Eidentic is the open-source TypeScript SDK for AI agents with self-improving memory and
production fundamentals built in.** Durable execution, enforced cost ceilings, multi-tenant
isolation, GDPR erasure, and sandboxed tools — not bolted on. Apache-2.0, no enterprise gating.
Runs on **Node, Bun, Deno, and the edge**.

[![CI](https://github.com/eidentic/eidentic/actions/workflows/ci.yml/badge.svg)](https://github.com/eidentic/eidentic/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/eidentic)](https://www.npmjs.com/package/eidentic)
![Runtimes](https://img.shields.io/badge/runtimes-Node%20·%20Bun%20·%20Deno%20·%20Edge-blue)
![License](https://img.shields.io/badge/license-Apache--2.0-blue)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/eidentic/eidentic)

[![Featured on Product Hunt](https://api.producthunt.com/widgets/embed-image/v1/featured.svg?post_id=1169568&theme=dark)](https://www.producthunt.com/products/eidentic?utm_source=badge-featured&utm_medium=badge)

> **Status: 0.x — APIs stabilizing toward v1; see [STABILITY](STABILITY.md).**
> We'd rather over-disclose gaps than oversell — see the
> [benchmarks](docs/BENCHMARKS.md) for honest, reproducible numbers.

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new SqliteStore("./eidentic.sqlite"),
});

for await (const ev of agent.query("What did we decide last week?", { sessionId: "u-42" })) {
  console.log(ev);
}
```

## Why Eidentic?

Most agent frameworks lead one lane — memory, or coding/sandbox, or DX, or durable
orchestration, or skills. **Rarely do all of these ship together, and production-readiness
is usually behind an enterprise tier.** Eidentic's thesis: *everything in one composable,
fully-open package.*

**1. Memory that improves itself.** Not just vector recall — a four-tier engine with
self-editing memory blocks, a **temporal knowledge graph** (facts with validity over time;
contradictions invalidate rather than accumulate), sleep-time consolidation, and passive
fact extraction. ([design spec](docs/design/master-design.md))

**2. Production fundamentals, built in — not bolted on.** Durable checkpoint/resume with
exactly-once tool dispatch, **enforced cost ceilings** ($/token/turn) with **per-turn cost
visibility**, **built-in rate-limiting + quotas**, OpenTelemetry GenAI spans, a **structured
audit-event stream** (permission denials, quota/rate-limit rejections, auth failures, and
right-to-erasure — the events a compliance log needs), deny-by-default permissions, sandboxed
code/command execution, secrets the model never sees, and **one-call right-to-erasure (GDPR)**
that fans out across every store. For offline workloads there's a
**batch runner** and **scheduled/background runs**. And because shipping an agent without
tests is shipping blind, there's a built-in **eval harness with a CI pass-rate gate** plus
one-call **promotion of a production trace into a regression test** — every incident becomes
a test, not a repeat. Several of these are unique or near-unique among open frameworks.

**3. Composable, fully open, runs everywhere.** Ports-and-adapters architecture: swap the
store (SQLite / libSQL / Postgres), vector backend (LanceDB / pgvector / Qdrant /
Pinecone), or embedder without touching agent code. Ingest PDF, HTML, and Markdown out of
the box; interop via **MCP (with OAuth) and A2A**. Apache-2.0, no code-gating. Verified on
Node, Bun, and Deno in CI.

## Two ways to use Eidentic

Eidentic is a **library first**. You don't have to run a separate service — you `import` it
straight into your own backend and call `agent.query()`. Running it as a standalone HTTP
service is an *optional* second mode for when you want agents-as-a-service.

### 1. Embedded — drop it into your app (the common path)

One install, then construct an agent and stream it from any request handler. The agent runs
server-side (it holds your model key); your frontend just calls your endpoint.

```bash
npm install eidentic ai @ai-sdk/anthropic
```

**Next.js (App Router)** — `app/api/chat/route.ts`:

> **Next.js / serverless:** use `@eidentic/libsql` (pure-JS, bundler-friendly), not `SqliteStore`.
> The native `better-sqlite3` addon behind `SqliteStore` doesn't bundle under Next/Turbopack
> (`Dynamic require not supported`). `npm install @eidentic/libsql` and keep the route on the
> Node runtime. (For Node servers/scripts, `SqliteStore` is great — see the snippet at the top.)

```ts
import { Agent, AIModel } from "eidentic";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

export const runtime = "nodejs"; // native/edge-safe store; not the edge runtime

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store: new LibsqlStore("file:eidentic.db"),
});

export async function POST(req: Request) {
  const { message, sessionId } = await req.json();
  const stream = new ReadableStream({
    async start(c) {
      for await (const ev of agent.query(message, { sessionId, signal: req.signal }))
        c.enqueue(new TextEncoder().encode(JSON.stringify(ev) + "\n"));
      c.close();
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
}
```

**Express:**

```ts
app.post("/chat", async (req, res) => {
  res.type("application/x-ndjson");
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  for await (const ev of agent.query(req.body.message, { sessionId: req.body.sessionId, signal: controller.signal }))
    res.write(JSON.stringify(ev) + "\n");
  res.end();
});
```

**Cloudflare Workers / edge** — same `Agent`, swap the store for a libSQL/Postgres adapter:

```ts
export default {
  async fetch(req: Request) {
    const { message, sessionId } = await req.json();
    const stream = new ReadableStream({
      async start(c) {
        for await (const ev of agent.query(message, { sessionId, signal: req.signal }))
          c.enqueue(new TextEncoder().encode(JSON.stringify(ev) + "\n"));
        c.close();
      },
    });
    return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
  },
};
```

A complete, runnable version (plain `node:http`, no extra packages) is in
[`examples/hello-embedded.ts`](examples/hello-embedded.ts) — `pnpm --filter eidentic-examples hello:embedded`.

### 2. Server — agents-as-a-service (optional)

When you'd rather not hand-write the endpoint, or want a dedicated multi-tenant agent backend
with auth, sessions, and streaming out of the box, `@eidentic/server` gives you a ready Hono app:

```ts
import { createServer, serveNode, ApiKeyAuth } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  auth: ApiKeyAuth({ key_live_123: { userId: "u1" } }),
});
await serveNode(app, { port: 3000 }); // POST /v1/agents/support/query → SSE
```

Or scaffold a project and boot it in dev:

```bash
npm create eidentic@latest my-agent
cd my-agent && eidentic dev   # loads eidentic.config.ts and serves it
```

## What's in the box

| Area | Highlights |
|---|---|
| **Agent** | Stateful ReAct loop · event-sourced sessions · composable strategies (reflection / plan-and-execute) · token streaming |
| **Memory** | Lexical + semantic recall (RRF fusion) · self-editing blocks · temporal knowledge graph · sleep-time consolidation · passive extraction · TTL/dedup |
| **Skills** | `SKILL.md` prompt skills · test-gated executable skills (ed25519-signed) · optional self-evolution |
| **Multi-agent** | `spawn_agent` delegation with context isolation + shared budget · MCP host & server · A2A protocol |
| **Execution** | Durable checkpoint/resume (exactly-once) · human-in-the-loop suspension · cooperative cancellation · context compaction |
| **Security & ops** | Deny-by-default permissions · sandboxed exec (E2B) · secret isolation · cost governor · rate-limit + quotas · OTel · audit-event stream · GDPR erasure |
| **Stores** | SQLite · libSQL/Turso · Postgres · Convex · vector: LanceDB / pgvector / Qdrant / Pinecone · local + hosted embedders |
| **DX** | `npx eidentic init` scaffold · Studio dev dashboard (`npx eidentic studio`) · eval harness · memory benchmark suite |

Every feature ships a runnable `examples/hello-*.ts` (most use a mock model, so no API key
needed). See the [**feature tour**](docs/TESTING.md) for the full list and how to run each one.

## Benchmarks

On two public long-term-memory benchmarks, Eidentic's retrieval-based memory **beats the
full-context baseline** — at a fraction of the tokens. Same script, same models, same seed, full
splits, full-context baseline included. Honest caveats and the per-category gaps where memory
loses are published alongside.

| Benchmark | Full-context | Eidentic memory | Tokens/query |
|---|---|---|---|
| [LongMemEval](docs/BENCHMARKS.md) (500 q, ~115k-token haystacks) | 41.0% | **55.2%** (+14.2pp, wins all 6 types) | **2.5k vs 99k** (~39× less) |
| [LoCoMo](docs/BENCHMARKS.md) (1,540 q) | 61.6% | 53.8% (wins temporal +12pp, adversarial +16pp) | **0.9k vs 19k** (~21× less) |

The larger the history, the more memory wins: stuffing ~115k tokens into the context window
buries the evidence among distractors, while targeted retrieval surfaces it. Methodology,
configuration, and reproduction commands: [**docs/BENCHMARKS.md**](docs/BENCHMARKS.md).

## Example apps

Clonable, runnable starter apps — a memory-backed chat agent in each framework. Add an API key
and `npm run dev`:

- [**example-nextjs**](https://github.com/eidentic/example-nextjs) — Next.js App Router + `withEidentic` handler + `useChat`
- [**example-react**](https://github.com/eidentic/example-react) — Vite + React hooks (`useEidenticStream`) against an Eidentic server
- [**example-express**](https://github.com/eidentic/example-express) — drop the `Agent` into a plain Express route and stream over SSE

## Quickstart (from this repo)

```bash
pnpm install
pnpm -r build
pnpm --filter eidentic-examples hello          # mock model — no API key needed
```

Run against a real model or stream tokens live:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
pnpm --filter eidentic-examples hello:real
pnpm --filter eidentic-examples hello:stream
```

## Debugging

Set `DEBUG=eidentic:*` for verbose, namespaced loop logs (model calls, tool dispatch, memory
recall, compaction, cost) with secret values redacted. Scope it (`DEBUG=eidentic:tool,eidentic:cost`)
to focus. It's the fastest way to see what an agent actually did when something looks off.

```bash
DEBUG=eidentic:* pnpm --filter eidentic-examples hello
```

## Package layout

The `eidentic` umbrella package bundles **core, types, model, sqlite, and memory** — one
install for the common case. All 32 packages are in this monorepo; optional adapters are
separate installs so you only pay for what you use. This keeps cold-start footprint small
and avoids pulling in native addons you don't need.

| Install separately | Purpose |
|---|---|
| `@eidentic/server` | Hono HTTP server with auth + SSE streaming |
| `@eidentic/react` | React hooks (`useAgent`, `useEidenticStream`, `useAsyncRun`, …) |
| `@eidentic/nextjs` | Next.js App Router adapter (`withEidentic`, `eidenticNextConfig`) |
| `@eidentic/studio` | Dev dashboard — sessions, memory, skills, workflows |
| `@eidentic/workflow` | Multi-step workflow orchestration |
| `@eidentic/libsql` | libSQL/Turso store (pure-JS, works under Next.js/Bun/edge) |
| `@eidentic/postgres` | Postgres store (pgvector-ready) |
| `@eidentic/convex` | Convex store (`StorePort` + `GraphPort` + `VectorPort` + `DurablePort`) — reactive, TypeScript-native backend with durable execution |
| `@eidentic/mcp` | MCP host + server |
| … | pgvector, lancedb, qdrant, pinecone, e2b, langfuse, eval, bench |

`npm install eidentic` gives you the core stack. Optional packages — server, React hooks,
vector stores, sandbox — are separate installs by design. See the table above.

## Production checklist

A few defaults are safe for local development but need attention before going public:

- **Studio defaults to NoAuth.** `serveStudio` and `createStudioApi` expose full
  read/write access to agent memory and session traces. Never bind Studio to a
  publicly reachable address without configuring `ApiKeyAuth` (or a custom `AuthPort`).
  It is strictly a dev tool.
- **`@eidentic/server` also defaults to NoAuth.** Add `ApiKeyAuth` (or your own `AuthPort`)
  before deploying. Combine with your load-balancer's rate-limiting or use the built-in
  quota/rate-limit options — the server has no default cap on request volume.
- **`SkillBank` and executable skills.** If you allow agent-authored or user-submitted
  skills, set `requireSigned: true` so only ed25519-signed bundles are accepted. The
  default quarantine gate helps, but signed skills are the recommended production posture.
- **Langfuse / observability.** If you use `@eidentic/langfuse`, pass `redactAttributes`
  to strip PII or secrets from span attributes before they leave your network. The default
  records all tool inputs and outputs verbatim.

## Docs

- [Deployment guide](docs/DEPLOYMENT.md) — Node, Docker, edge, Next.js, scaling & ops
- [Benchmarks](docs/BENCHMARKS.md) — methodology and reproducible numbers
- [Runtime support matrix](docs/RUNTIMES.md) — Node / Bun / Deno / edge
- [Feature tour](docs/TESTING.md) — run every feature locally
- [Design spec](docs/design/master-design.md) — the full architecture
- [Stability policy](STABILITY.md) — versioning contract, stability tiers, conformance-suite promise
- [Full docs](https://docs.eidentic.dev) — guides, API reference, and examples ([source](https://github.com/eidentic/docs))

### Use the docs with your AI tools

Point your AI coding agent at Eidentic and it answers from the real, current docs:

- **MCP (Cursor, Claude Code, Windsurf):** add the auto-generated server — `https://gitmcp.io/eidentic/eidentic`
- **Context7:** write `use context7` in your prompt; the docs are indexed there.
- **llms.txt:** [docs.eidentic.dev/llms.txt](https://docs.eidentic.dev/llms.txt) (index) · [llms-full.txt](https://docs.eidentic.dev/llms-full.txt) (full text)
- Every docs page has **Copy page / Open in ChatGPT / Claude / Perplexity** actions.

## License

Apache-2.0.
