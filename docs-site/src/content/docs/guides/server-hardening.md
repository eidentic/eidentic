---
title: Server Production Guide
description: Webhooks, CORS, graceful drain, pre-auth rate limiting, maxInputChars, maxAsyncRuns, and workflowRuns registry injection.
---

`@eidentic/server` is designed for production from day one. This guide covers the hardening options available in `ServerOptions`.

## Webhooks

For async runs (`POST /v1/agents/:id/runs`), enable webhooks so your system is notified on completion without polling:

```ts
import { createServer } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  webhooks: {
    signingSecret: process.env.WEBHOOK_SECRET!,
    allowPrivateHosts: false, // default; set true only in dev
  },
});
```

Clients include a `callbackUrl` in the runs request body:

```json
{ "input": "Summarise Q3", "callbackUrl": "https://yourapp.com/webhooks/eidentic" }
```

On completion the server POSTs to that URL:

```json
{
  "runId": "…",
  "agentId": "support",
  "status": "completed",
  "output": "…",
  "usage": { "inputTokens": 120, "outputTokens": 80 }
}
```

### Signature verification

Every webhook carries two headers:
- `X-Eidentic-Signature`: `sha256=<hex HMAC-SHA256>`
- `X-Eidentic-Timestamp`: Unix timestamp in milliseconds (string)

The HMAC message is `<timestamp>.<rawBody>`. Verify it on your receiver:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

function verifyWebhook(secret: string, timestamp: string, rawBody: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", secret)
    .update(timestamp + "." + rawBody)
    .digest("hex");
  // Use timingSafeEqual to prevent timing attacks
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
```

**Delivery guarantees:** 1 attempt + 2 retries (1 s, 2 s backoff), 10 s timeout per attempt, redirects never followed.

**Security:** `callbackUrl` must be an `http`/`https` URL with a non-private host. Private/loopback/metadata addresses are always blocked (`allowPrivateHosts: false`).

## CORS

```ts
const app = createServer({
  agents: { support: agent },
  cors: { origin: "https://app.example.com", credentials: true },
  // cors: { origin: "*" }  // for public unauthenticated APIs only
});
```

`cors` is passed through to `hono/cors`. When omitted, no CORS headers are added (safest default).

**Warning:** `{ origin: "*", credentials: true }` is rejected by browsers. Never combine a wildcard origin with `credentials: true`.

## Pre-auth rate limiting

By default the server applies a **60 req/min per IP** limit to all `/v1/*` routes before authentication runs. This defends against unauthenticated hammering, credential brute-force, and enumeration attacks:

```ts
// Default: 60 req/min. Override:
import { InMemoryTokenBucketLimiter } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  preAuthRateLimiter: new InMemoryTokenBucketLimiter({
    capacity: 120,      // 120 requests burst
    refillPerSec: 2,    // 120 req/min steady state
  }),
  // Explicitly disable (not recommended for public deployments):
  // preAuthRateLimiter: null,

  // Trust x-forwarded-for from a reverse proxy:
  trustProxy: true,

  // Custom client key (e.g. use a different header):
  getClientKey: (c) => c.req.header("cf-connecting-ip") ?? "unknown",
});
```

## Post-auth rate limiting

Per-tenant rate limiting applied after authentication:

```ts
const app = createServer({
  agents: { support: agent },
  rateLimiter: new InMemoryTokenBucketLimiter({ tokensPerSecond: 10, burst: 20 }),
  rateLimitKey: (principal, agentId) => `${principal.userId ?? "anon"}:${agentId}`,
});
```

Exceeding returns `429 Too Many Requests` with a `Retry-After` header.

## Input length cap

```ts
const app = createServer({
  agents: { support: agent },
  maxInputChars: 10_000, // default 32_000
});
```

Requests exceeding `maxInputChars` receive `400 Bad Request` before any auth or quota check.

## Async runs registry size

```ts
const app = createServer({
  agents: { support: agent },
  maxAsyncRuns: 500, // default 1000
});
```

Once the limit is reached, the oldest settled (completed/failed/aborted) entry is evicted. In-flight runs are never evicted.

## Workflow runs registry injection

Inject a durable registry so workflow run history survives server restarts and is shared across instances:

```ts
import { createServer } from "@eidentic/server";
import { createWorkflowRunRegistry, fileWorkflowRunStore } from "@eidentic/workflow";

const workflowRuns = createWorkflowRunRegistry({
  store: fileWorkflowRunStore("./data/workflow-runs.json"),
  limit: 1000,
});
await workflowRuns.hydrate(); // load persisted runs on startup

const app = createServer({
  agents: { support: agent },
  workflowRuns, // injected registry drives GET /v1/workflows
});
```

When `workflowRuns` is omitted, an in-memory bounded registry is created automatically.

## Graceful drain

`serveNode` supports graceful shutdown. In-flight requests complete; new `/v1` requests receive `503 Service Unavailable` with `Retry-After: 5`:

```ts
import { createServer, serveNode } from "@eidentic/server";

const app = createServer({ agents: { support: agent } });
const server = await serveNode(app, { port: 3000 });

process.on("SIGTERM", async () => {
  await server.drain(); // stops accepting new requests
  // Wait for in-flight requests to finish, then exit
  setTimeout(() => process.exit(0), 5000);
});
```

## Auth adapters

| Adapter | Usage |
|---|---|
| `NoAuth` (default) | Single-tenant / local dev. All requests share one anonymous principal. Do NOT expose to the public internet. |
| `ApiKeyAuth({ key: principal })` | Bearer token or `x-api-key` header lookup |
| Custom `AuthPort` | Implement `authenticate(req): AuthPrincipal \| null` |

## Route reference

| Route | Auth required | Description |
|---|---|---|
| `GET /health` | No | Liveness check; returns `{ ok: true }` |
| `POST /v1/agents/:id/query` | Yes | SSE-streamed synchronous query |
| `POST /v1/agents/:id/resume` | Yes | SSE-streamed resume after suspension |
| `POST /v1/agents/:id/runs` | Yes | Fire-and-forget async run |
| `GET /v1/agents/:id/runs/:runId/status` | Yes | Poll async run status |
| `GET /v1/agents/:id/sessions/:sid/events` | Yes | Audit log (`exposeEvents: true` required) |
| `GET /v1/workflows` | Yes | List workflow run summaries |
| `GET /v1/workflows/:id` | Yes | Single workflow run detail |

## Gotchas

- `NoAuth` in multi-tenant mode means every client can read every session when `exposeEvents: true`. Only use `NoAuth` for trusted single-tenant services.
- `ApiKeyAuth` uses a plain object lookup which is not constant-time. For timing-attack resistance, supply a custom `AuthPort` with HMAC-based key comparison.
- Session ownership is enforced on every `/query`, `/resume`, and `/events` request. A principal may only access sessions it owns.
