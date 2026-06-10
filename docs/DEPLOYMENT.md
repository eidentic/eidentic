# Deployment Guide

This guide covers every common way to ship an Eidentic agent to production: as a
plain Node.js server, inside Docker, on serverless/edge platforms, and inside
a Next.js app.

> **Runtime reference:** See [docs/RUNTIMES.md](RUNTIMES.md) for the full
> runtime compatibility matrix (Node, Bun, Deno, edge) and the package
> edge-safety table.

---

## 1. Node.js server

### 1a. Standalone server with `@eidentic/server`

`@eidentic/server` builds a [Hono](https://hono.dev) app and wraps it in a
thin Node.js HTTP adapter (`serveNode`, backed by `@hono/node-server`).

```bash
npm install eidentic @eidentic/server @hono/node-server ai @ai-sdk/anthropic
```

```ts
// server.ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { createServer, serveNode, ApiKeyAuth } from "@eidentic/server";
import { anthropic } from "@ai-sdk/anthropic";

const store = new SqliteStore("./eidentic.sqlite");

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
  instructions: "You are a helpful support assistant.",
});

const app = createServer({
  agents: { support: agent },
  auth: ApiKeyAuth({ [process.env.API_KEY!]: { userId: "service" } }),
});

await serveNode(app, { port: Number(process.env.PORT ?? 3000) });
console.log(`Listening on :${process.env.PORT ?? 3000}`);
```

Routes exposed:

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Liveness probe (no auth) |
| `POST` | `/v1/agents/:id/query` | Start a query — streams SSE |
| `POST` | `/v1/agents/:id/resume` | Resume a suspended session |
| `GET`  | `/v1/agents/:id/sessions/:sid/events` | Audit log (opt-in via `exposeEvents: true`) |

**Request body for `/query`:**
```json
{ "input": "What can you help me with?", "sessionId": "session-123" }
```

**Calling the server:**
```bash
curl -N -X POST http://localhost:3000/v1/agents/support/query \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello","sessionId":"u-1"}'
```

### 1b. Embedded in an existing Express / Fastify / Hono app

Eidentic is a library first. You can call `agent.query()` directly inside any
request handler without running a separate service:

```ts
// express example
import express from "express";
import { Agent, AIModel, SqliteStore } from "eidentic";
import { anthropic } from "@ai-sdk/anthropic";

const app = express();
app.use(express.json());

const store = new SqliteStore("./eidentic.sqlite");
const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

app.post("/chat", async (req, res) => {
  res.type("application/x-ndjson");
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableEnded) controller.abort(); });
  for await (const ev of agent.query(req.body.message, {
    sessionId: req.body.sessionId,
    signal: controller.signal,
  })) {
    res.write(JSON.stringify(ev) + "\n");
  }
  res.end();
});

app.listen(3000);
```

Or mount the Hono app inside your existing server:

```ts
import { serve } from "@hono/node-server";
import { createServer } from "@eidentic/server";

const eidenticApp = createServer({ agents: { support: agent } });

// Mount under /agents in your own Hono app, or pass app.fetch to node-server:
serve({ fetch: eidenticApp.fetch, port: 3000 });
```

### 1c. Choosing a store

| Store | Package | When to use |
|-------|---------|-------------|
| `SqliteStore` | `eidentic` (umbrella) | Single-node Node/Bun servers; zero infra |
| `LibsqlStore` | `@eidentic/libsql` | Next.js, edge, Deno, or when you want a hosted Turso DB |
| `PostgresStore` | `@eidentic/postgres` | Multi-instance / high-availability deployments |

For single-node Node.js deployments `SqliteStore` is the simplest choice — it
stores everything in a single file with no external dependencies:

```ts
import { SqliteStore } from "eidentic";
const store = new SqliteStore("./eidentic.sqlite");
```

For multi-instance or serverless deployments, switch to `LibsqlStore` pointing
at a [Turso](https://turso.tech) remote database (HTTP, no native addon) or
`PostgresStore` with a managed Postgres service:

```ts
// libSQL / Turso
import { LibsqlStore } from "@eidentic/libsql";
const store = new LibsqlStore({
  url: process.env.LIBSQL_URL!,
  authToken: process.env.LIBSQL_TOKEN,
});
await store.migrate();

// Postgres
import { PostgresStore } from "@eidentic/postgres";
import pg from "pg";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresStore(pool);
await store.migrate();
```

### 1d. Environment / secrets

The model API key is the critical secret. Pass it as an environment variable
and never hard-code it:

```bash
# .env (local) / platform secret store (production)
ANTHROPIC_API_KEY=sk-ant-...
API_KEY=key_live_...          # your server's bearer token
PORT=3000

# For libSQL / Turso
LIBSQL_URL=libsql://your-db.turso.io
LIBSQL_TOKEN=...

# For Postgres
DATABASE_URL=postgresql://user:pass@host:5432/db
```

Eidentic's `EnvSecrets` adapter (used by default) reads secrets from
`process.env` at call time and **never surfaces them to the model**.

---

## 2. Docker

The following multi-stage `Dockerfile` builds a minimal production image for a
Node.js Eidentic server. It keeps build tooling out of the final image.

```dockerfile
# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci --ignore-scripts

COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build          # emits dist/

# ---- production stage ----
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

# Only production deps (no devDependencies)
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts

# Copy compiled output
COPY --from=builder /app/dist ./dist

# Persist the SQLite file across container restarts by mounting a volume here.
# For multi-instance or serverless deployments, use @eidentic/libsql or
# @eidentic/postgres instead and remove this directory.
RUN mkdir -p /data
VOLUME ["/data"]

ENV SQLITE_PATH=/data/eidentic.sqlite
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server.js"]
```

**server.ts** (entry point referenced above):

```ts
import { Agent, AIModel, SqliteStore } from "eidentic";
import { createServer, serveNode, ApiKeyAuth } from "@eidentic/server";
import { anthropic } from "@ai-sdk/anthropic";

const store = new SqliteStore(process.env.SQLITE_PATH ?? "./eidentic.sqlite");
const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

const app = createServer({
  agents: { support: agent },
  auth: ApiKeyAuth({ [process.env.API_KEY!]: { userId: "service" } }),
});

await serveNode(app, { port: Number(process.env.PORT ?? 3000) });
```

**Build and run:**

```bash
docker build -t my-eidentic-agent .
docker run -p 3000:3000 \
  -v eidentic-data:/data \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e API_KEY=$API_KEY \
  my-eidentic-agent
```

**Deploy to Railway / Render / Fly.io:**

These platforms detect the `Dockerfile` automatically. Set
`ANTHROPIC_API_KEY`, `API_KEY`, and any store connection strings as platform
secrets, then push or connect the repo. For Railway:

```bash
railway up
railway variables set ANTHROPIC_API_KEY=sk-ant-... API_KEY=key_live_...
```

---

## 3. Serverless / edge

The Hono app returned by `createServer` is fully runtime-agnostic — it runs on
any platform that accepts a `fetch`-style handler. The **only constraint** is
the store: native SQLite is unavailable on edge runtimes, so use
`@eidentic/libsql` (pointing at a remote Turso database) or `@eidentic/postgres`.

> `@eidentic/server` itself uses `node:http` / `node:fs` and is **Node/Bun only**.
> For edge deployments, skip `createServer`/`serveNode` and call `agent.query()`
> directly inside your platform's fetch handler. See [docs/RUNTIMES.md](RUNTIMES.md).

### 3a. Cloudflare Workers

```ts
// worker.ts
import { Agent } from "@eidentic/core";
import { AIModel } from "@eidentic/model";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

// Constructed once at module scope — Workers reuse the isolate across requests.
const store = new LibsqlStore({
  url: "libsql://your-db.turso.io",
  authToken: "LIBSQL_TOKEN", // use env binding in wrangler.toml
});
await store.migrate();

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

export default {
  async fetch(req: Request, env: { ANTHROPIC_API_KEY: string }): Promise<Response> {
    if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

    const { input, sessionId } = await req.json<{ input: string; sessionId?: string }>();

    const stream = new ReadableStream({
      async start(c) {
        const enc = new TextEncoder();
        for await (const ev of agent.query(input, { sessionId, signal: req.signal })) {
          c.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
        }
        c.close();
      },
    });

    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
  },
};
```

`wrangler.toml` — set secrets and enable the `nodejs_compat` flag so that
`node:crypto` (used by `@eidentic/core`) resolves correctly:

```toml
name = "my-eidentic-agent"
compatibility_flags = ["nodejs_compat"]

[vars]
LIBSQL_URL = "libsql://your-db.turso.io"

# Set via wrangler secret put, not in the toml:
# ANTHROPIC_API_KEY
# LIBSQL_TOKEN
```

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put LIBSQL_TOKEN
wrangler deploy
```

### 3b. Deno Deploy

```ts
// main.ts
import { Agent } from "npm:@eidentic/core";
import { AIModel } from "npm:@eidentic/model";
import { LibsqlStore } from "npm:@eidentic/libsql";
import { anthropic } from "npm:@ai-sdk/anthropic";

const store = new LibsqlStore({
  url: Deno.env.get("LIBSQL_URL")!,
  authToken: Deno.env.get("LIBSQL_TOKEN"),
});
await store.migrate();

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

Deno.serve(async (req) => {
  const { input, sessionId } = await req.json();
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      for await (const ev of agent.query(input, { sessionId, signal: req.signal })) {
        c.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      }
      c.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
});
```

Deploy via the Deno Deploy dashboard or `deployctl`:

```bash
deployctl deploy --project=my-eidentic-agent main.ts
```

Set `ANTHROPIC_API_KEY`, `LIBSQL_URL`, and `LIBSQL_TOKEN` in the project
environment settings.

### 3c. Vercel (Node.js runtime, not edge)

On Vercel, use the **Node.js runtime** (`export const runtime = "nodejs"`) so
that `node:crypto` resolves. The edge runtime is not currently supported by
`@eidentic/server`. Use the `withEidentic` helper from `@eidentic/nextjs` instead
(see section 4).

For standalone API routes without Next.js:

```ts
// api/chat.ts  (Vercel serverless function)
import { Agent, AIModel } from "@eidentic/core";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

export const runtime = "nodejs";

const store = new LibsqlStore({
  url: process.env.LIBSQL_URL!,
  authToken: process.env.LIBSQL_TOKEN,
});
await store.migrate();

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

export default async function handler(req: Request): Promise<Response> {
  const { input, sessionId } = await req.json();
  const stream = new ReadableStream({
    async start(c) {
      const enc = new TextEncoder();
      for await (const ev of agent.query(input, { sessionId, signal: req.signal })) {
        c.enqueue(enc.encode(JSON.stringify(ev) + "\n"));
      }
      c.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson" } });
}
```

---

## 4. Next.js

`@eidentic/nextjs` provides `withEidentic(agent)` — a single-line App Router
handler that takes care of streaming, request cancellation, session wiring, and
protocol negotiation.

**See the full guide:** [eidentic.dev/guides/nextjs](https://eidentic.dev/guides/nextjs) (source: [eidentic/docs](https://github.com/eidentic/docs))

Key points for deployment:

1. **Use `@eidentic/libsql`, not `SqliteStore`.** The `better-sqlite3` native
   addon does not bundle under Next.js / Turbopack. `@eidentic/libsql` is
   pure-JS and works with a local file (`file:eidentic.db`) or a remote Turso
   URL.

2. **Add `eidenticNextConfig` to `next.config.ts`** to add `better-sqlite3` to
   `serverExternalPackages` (harmless even if you don't use it):

   ```ts
   import { eidenticNextConfig } from "@eidentic/nextjs";
   export default eidenticNextConfig({ /* your config */ });
   ```

3. **Keep the route on the Node.js runtime** with `export const runtime = "nodejs"`.
   The Next.js edge runtime does not support `node:crypto`.

4. **For Vercel deployments**, set `ANTHROPIC_API_KEY` (and `LIBSQL_TOKEN` if
   using Turso) in the Vercel project environment settings.

Minimal setup:

```bash
npm install eidentic @eidentic/nextjs @eidentic/libsql ai @ai-sdk/anthropic
```

```ts
// lib/agent.ts
import { Agent, AIModel } from "@eidentic/core";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

const store = new LibsqlStore(
  process.env.LIBSQL_URL ?? "file:eidentic.db",
  { authToken: process.env.LIBSQL_TOKEN }
);
await store.migrate();

export const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});
```

```ts
// app/api/chat/route.ts
import { withEidentic } from "@eidentic/nextjs";
import { agent } from "@/lib/agent";

export const runtime = "nodejs";
export const POST = withEidentic(agent);
```

---

## 5. Scaling & ops

### Multi-tenant sessions

Sessions are scoped by `userId` and `orgId` passed through the auth principal.
The server enforces ownership: a principal can only resume or read events for
sessions it created. In multi-tenant deployments, always use `ApiKeyAuth` (or a
custom `AuthPort`) so every session carries a recorded owner.

```ts
const app = createServer({
  agents: { support: agent },
  auth: ApiKeyAuth({
    [process.env.TENANT_A_KEY!]: { userId: "tenant-a" },
    [process.env.TENANT_B_KEY!]: { userId: "tenant-b" },
  }),
});
```

### Rate limiting

`InMemoryTokenBucketLimiter` is suitable for single-process deployments. For
multi-process setups, implement the `RateLimiterPort` interface backed by Redis
or your preferred distributed store.

```ts
import { InMemoryTokenBucketLimiter } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  rateLimiter: new InMemoryTokenBucketLimiter({
    capacity: 20,          // burst size
    refillPerSec: 5,       // sustained rate
  }),
  rateLimitKey: (principal) => principal.userId ?? "anonymous",
});
```

Throttled requests receive `429 Too Many Requests` with a `Retry-After` header.

### Cost governor / quotas

`InMemoryQuota` enforces per-tenant USD and token ceilings. For production,
back the ledger with a persistent store via the `QuotaPort` interface.

```ts
import { InMemoryQuota } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  quota: new InMemoryQuota((key) => ({
    // Per-tenant limits resolved by the quota key (userId by default)
    softUsd: 4.00,   // warns at $4 (X-Eidentic-Quota-Warning: soft-limit header)
    hardUsd: 5.00,   // blocks at $5 → HTTP 402
    hardTokens: 100_000,
  })),
});
```

Agent-level cost ceilings (per turn, per session, total) are set in
`AgentConfig.maxCost` and enforced inside the run loop regardless of which
transport layer you use.

### OpenTelemetry

Eidentic emits OpenTelemetry GenAI spans for every agent turn, tool call, and
memory operation. Configure an OTLP exporter before constructing the agent:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});
sdk.start();

// Then construct Agent and createServer as usual — spans are emitted automatically.
```

Spans appear in any OTLP-compatible backend (Jaeger, Grafana Tempo, Honeycomb,
Datadog, etc.).

### GDPR erasure

Call `agent.store.eraseScope(scope)` to delete all sessions, events, memory
blocks, facts, and vector embeddings for a user or org. This cascades across all
store tables atomically:

```ts
import { type Scope } from "@eidentic/types";

const scope: Scope = { kind: "user", userId: "u-42", agentId: "support" };
const { deleted } = await agent.store.eraseScope(scope);
console.log(`Deleted ${deleted} rows for user u-42`);
```

### Horizontal scaling

- **Single-node (Node/Docker):** `SqliteStore` with a mounted volume. No
  additional infra needed.
- **Multiple instances:** Use `LibsqlStore` (Turso remote) or `PostgresStore`
  with a shared database. Both stores are designed for concurrent access and
  pass the shared conformance suite.
- **Rate limiter / quota:** Replace `InMemoryTokenBucketLimiter` and
  `InMemoryQuota` with implementations backed by Redis or your database — both
  implement simple interfaces (`RateLimiterPort`, `QuotaPort`) that are easy to
  adapt.

### Health check

`GET /health` returns `{ "ok": true }` with no authentication required. Wire it
to your load-balancer or container orchestrator's liveness probe:

```yaml
# Kubernetes liveness probe example
livenessProbe:
  httpGet:
    path: /health
    port: 3000
  initialDelaySeconds: 5
  periodSeconds: 10
```
