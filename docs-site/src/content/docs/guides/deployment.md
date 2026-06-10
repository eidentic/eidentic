---
title: Deployment
description: Deploy a Eidentic agent to Node.js, Docker, Cloudflare Workers, Deno Deploy, Vercel, and Next.js.
---

This guide covers every common way to ship a Eidentic agent to production: as a
plain Node.js server, inside Docker, on serverless/edge platforms, and inside a
Next.js app.

:::note[Runtime matrix]
See the [Runtimes guide](/guides/runtimes) for the full compatibility matrix
(Node, Bun, Deno, edge) and the package edge-safety table.
:::

---

## Node.js server

### Standalone server with `@eidentic/server`

`@eidentic/server` builds a Hono app and wraps it in a thin Node.js HTTP adapter
(`serveNode`, backed by `@hono/node-server`).

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
```

Routes exposed:

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/health` | Liveness probe (no auth) |
| `POST` | `/v1/agents/:id/query` | Start a query — streams SSE |
| `POST` | `/v1/agents/:id/resume` | Resume a suspended session |
| `GET`  | `/v1/agents/:id/sessions/:sid/events` | Audit log (opt-in) |

**Calling the server:**

```bash
curl -N -X POST http://localhost:3000/v1/agents/support/query \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"input":"Hello","sessionId":"u-1"}'
```

### Embedded in an existing app

Eidentic is a library first. Call `agent.query()` directly inside any request
handler:

```ts
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
```

### Choosing a store

| Store | Package | When to use |
|-------|---------|-------------|
| `SqliteStore` | `eidentic` | Single-node Node/Bun; zero infra |
| `LibsqlStore` | `@eidentic/libsql` | Next.js, edge, Deno, or Turso remote |
| `PostgresStore` | `@eidentic/postgres` | Multi-instance / HA deployments |

For remote or multi-instance deployments:

```ts
// libSQL / Turso
import { LibsqlStore } from "@eidentic/libsql";
const store = new LibsqlStore({
  url: process.env.LIBSQL_URL!,
  authToken: process.env.LIBSQL_TOKEN,
});
await store.migrate();
```

### Environment variables

```bash
ANTHROPIC_API_KEY=sk-ant-...   # model API key — never hard-code
API_KEY=key_live_...           # your server's bearer token
PORT=3000

# If using libSQL / Turso
LIBSQL_URL=libsql://your-db.turso.io
LIBSQL_TOKEN=...

# If using Postgres
DATABASE_URL=postgresql://user:pass@host:5432/db
```

---

## Docker

Multi-stage `Dockerfile` for a minimal production Node.js image:

```dockerfile
# ---- build stage ----
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# ---- production stage ----
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts
COPY --from=builder /app/dist ./dist

RUN mkdir -p /data
VOLUME ["/data"]

ENV SQLITE_PATH=/data/eidentic.sqlite
ENV PORT=3000
EXPOSE 3000

CMD ["node", "dist/server.js"]
```

Build and run:

```bash
docker build -t my-eidentic-agent .
docker run -p 3000:3000 \
  -v eidentic-data:/data \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  -e API_KEY=$API_KEY \
  my-eidentic-agent
```

**Deploy to Railway, Render, or Fly.io** — these platforms detect the
`Dockerfile` automatically. Set `ANTHROPIC_API_KEY` and `API_KEY` as platform
secrets, then connect the repo or push:

```bash
# Railway
railway up
railway variables set ANTHROPIC_API_KEY=sk-ant-... API_KEY=key_live_...
```

:::note[Multi-instance SQLite]
SQLite on a mounted volume works well for single-container deployments.
For multi-instance, switch to `@eidentic/libsql` (Turso remote) or
`@eidentic/postgres` so all instances share the same database.
:::

---

## Serverless / edge

The Hono app returned by `createServer` accepts any `fetch`-style handler. The
only constraint is the store: native SQLite is unavailable on edge runtimes —
use `@eidentic/libsql` (Turso remote) or `@eidentic/postgres` instead.

:::note[`@eidentic/server` is Node/Bun only]
`@eidentic/server` itself uses `node:http` / `node:fs`. For edge deployments,
skip `createServer`/`serveNode` and call `agent.query()` directly in your
platform's fetch handler.
:::

### Cloudflare Workers

```ts
// worker.ts
import { Agent } from "@eidentic/core";
import { AIModel } from "@eidentic/model";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

const store = new LibsqlStore({
  url: "libsql://your-db.turso.io",
  authToken: "LIBSQL_TOKEN",
});
await store.migrate();

const agent = new Agent({
  id: "support",
  model: new AIModel(anthropic("claude-sonnet-4-5")),
  store,
});

export default {
  async fetch(req: Request): Promise<Response> {
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

Enable the `nodejs_compat` flag in `wrangler.toml` so that `node:crypto`
(used by `@eidentic/core`) resolves:

```toml
name = "my-eidentic-agent"
compatibility_flags = ["nodejs_compat"]

[vars]
LIBSQL_URL = "libsql://your-db.turso.io"
```

```bash
wrangler secret put ANTHROPIC_API_KEY
wrangler secret put LIBSQL_TOKEN
wrangler deploy
```

### Deno Deploy

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

```bash
deployctl deploy --project=my-eidentic-agent main.ts
```

Set `ANTHROPIC_API_KEY`, `LIBSQL_URL`, and `LIBSQL_TOKEN` in the Deno Deploy
project environment settings.

---

## Next.js

`@eidentic/nextjs` provides `withEidentic(agent)` — a single-line App Router
handler that handles streaming, cancellation, and session wiring.

**Full guide:** [Next.js Integration](/guides/nextjs)

Key deployment notes:

1. **Use `@eidentic/libsql`, not `SqliteStore`.** The `better-sqlite3` native
   addon does not bundle under Next.js / Turbopack.

2. **Add `eidenticNextConfig` to `next.config.ts`:**

   ```ts
   import { eidenticNextConfig } from "@eidentic/nextjs";
   export default eidenticNextConfig({ /* your config */ });
   ```

3. **Keep `export const runtime = "nodejs"` on every Eidentic route** — the
   edge runtime does not support `node:crypto`.

4. **Set `ANTHROPIC_API_KEY`** (and `LIBSQL_TOKEN` if using Turso) in your
   platform's environment settings.

Minimal setup:

```ts
// lib/agent.ts
import { Agent, AIModel } from "@eidentic/core";
import { LibsqlStore } from "@eidentic/libsql";
import { anthropic } from "@ai-sdk/anthropic";

const store = new LibsqlStore(process.env.LIBSQL_URL ?? "file:eidentic.db");
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

## Scaling & ops

### Multi-tenant sessions

Sessions carry `userId` and `orgId` from the auth principal. The server
enforces ownership: a principal can only resume or read events for sessions it
created. Always use `ApiKeyAuth` (or a custom `AuthPort`) in multi-tenant
deployments.

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

```ts
import { InMemoryTokenBucketLimiter } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  rateLimiter: new InMemoryTokenBucketLimiter({
    capacity: 20,       // burst
    refillPerSec: 5,    // sustained rate
  }),
  rateLimitKey: (principal) => principal.userId ?? "anonymous",
});
```

Throttled requests receive `429 Too Many Requests` with a `Retry-After` header.
For multi-process deployments, implement `RateLimiterPort` backed by Redis or a
shared database.

### Cost governor / quotas

```ts
import { InMemoryQuota } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  quota: new InMemoryQuota({
    softUsd: 4.00,      // X-Eidentic-Quota-Warning header at $4
    hardUsd: 5.00,      // HTTP 402 at $5
    hardTokens: 100_000,
  }),
});
```

Agent-level cost ceilings (per turn, per session, total) are set in
`AgentConfig` and enforced in the run loop regardless of transport layer.

### OpenTelemetry

Eidentic emits OpenTelemetry GenAI spans for every agent turn, tool call, and
memory operation. Configure an OTLP exporter before constructing the agent:

```ts
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
  }),
});
sdk.start();
```

Spans appear in any OTLP-compatible backend (Jaeger, Grafana Tempo, Honeycomb,
Datadog, etc.).

### GDPR / right-to-erasure

```ts
import { type Scope } from "@eidentic/types";

const scope: Scope = { kind: "user", userId: "u-42", agentId: "support" };
const { deleted } = await agent.store.eraseScope(scope);
```

This atomically deletes all sessions, events, memory blocks, facts, and vector
embeddings for the given scope.

### Health check

`GET /health` returns `{ "ok": true }` with no auth required — wire it to your
load-balancer or container orchestrator:

```yaml
livenessProbe:
  httpGet:
    path: /health
    port: 3000
```
