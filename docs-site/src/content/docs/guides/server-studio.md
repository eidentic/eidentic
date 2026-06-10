---
title: Server & Studio
description: Run agents as a REST+SSE service with @eidentic/server and explore them in Studio.
---

Eidentic is a **library first** — you embed `Agent` directly in your own backend. But when you want a dedicated, multi-tenant agent service with auth, rate-limiting, and streaming out of the box, `@eidentic/server` gives you a ready-made Hono application.

## `@eidentic/server`

### Install

```bash
npm install @eidentic/server
```

### Basic server

```ts
import { createServer, serveNode, ApiKeyAuth } from "@eidentic/server";
import { agent } from "./agent.js"; // your Agent instance

const app = createServer({
  agents: { support: agent },
  auth: ApiKeyAuth({ "key_live_abc123": { userId: "tenant-1" } }),
});

await serveNode(app, { port: 3000 });
```

The server exposes:

| Route | Description |
|---|---|
| `GET /health` | Health check |
| `POST /v1/agents/:id/query` | Start a new query — streams SSE |
| `POST /v1/agents/:id/resume` | Resume a suspended session |
| `GET /v1/agents/:id/sessions/:sid/events` | Audit log (opt-in, `exposeEvents: true`) |

### Request format

`POST /v1/agents/:id/query` accepts JSON:

```json
{
  "message": "What can you help me with?",
  "sessionId": "session-123",
  "userId": "user-42"
}
```

The response is an SSE stream of `StreamEvent` objects.

### Auth adapters

| Adapter | Usage |
|---|---|
| `NoAuth` (default) | Single-tenant mode, no authentication |
| `ApiKeyAuth({ key: principal })` | Bearer token or `x-api-key` header |
| Custom `AuthPort` | Implement the `authenticate(req)` interface |

### Rate limiting

```ts
import { createServer, InMemoryTokenBucketLimiter } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  rateLimiter: new InMemoryTokenBucketLimiter({
    tokensPerSecond: 10,
    burst: 20,
  }),
  rateLimitKey: (principal) => principal.userId ?? "anonymous",
});
```

Exceeding the limit returns `429 Too Many Requests` with a `Retry-After` header.

### Quotas

```ts
import { InMemoryQuota } from "@eidentic/server";

const app = createServer({
  agents: { support: agent },
  quota: new InMemoryQuota({
    maxUsdPerDay: 5.00,
    maxTokensPerDay: 100_000,
  }),
});
```

Exceeding the quota returns `402 Payment Required` with a soft-cap warning header on approach.

### Multiple agents

```ts
const app = createServer({
  agents: {
    support: supportAgent,
    research: researchAgent,
    coder: coderAgent,
  },
  auth: myAuth,
});
```

Or use a resolver function for dynamic agent lookup:

```ts
const app = createServer({
  agents: (agentId) => agentRegistry.get(agentId),
});
```

### Embedding in your framework

`createServer` returns a standard Hono app. Mount it inside Express, Fastify, or any framework that accepts a fetch-compatible handler:

```ts
// With Node's built-in http:
import { serve } from "@hono/node-server";
serve({ fetch: app.fetch, port: 3000 });
```

## Studio

Studio is a local developer dashboard for exploring agents, sessions, memory, and traces. It runs as a CLI command alongside your agent process.

### Launch

```bash
npx eidentic studio
```

Studio reads your `eidentic.config.ts` (if present) and connects to the running agent service.

### `eidentic dev`

The `dev` command starts your agent config in development mode with hot-reload:

```bash
npx eidentic dev
```

It loads `eidentic.config.ts` from the current directory, starts the server, and opens Studio.

### `eidentic.config.ts`

```ts
import { defineConfig } from "eidentic";
import { agent } from "./agent.js";

export default defineConfig({
  agents: { support: agent },
  port: 3000,
});
```

### CLI reference

| Command | Description |
|---|---|
| `eidentic init` | Scaffold a new Eidentic project |
| `eidentic dev` | Start dev server with hot-reload |
| `eidentic studio` | Open the Studio dashboard |
| `eidentic doctor` | Check configuration and connectivity |
| `eidentic eval <config>` | Run evals; see [Evals in CI](/guides/evals-ci) |
| `eidentic add skill <path>` | Copy a SKILL.md skill bundle into your project |
| `eidentic add component <name>` | Copy a pre-built UI component into your project |

Install the CLI globally:

```bash
npm install -g eidentic
```

Or use via `npx`:

```bash
npx eidentic studio
npx eidentic dev
```

### `eidentic add skill`

Copies a skill directory (containing `SKILL.md`) into your project's skills folder. Validates the manifest before copying and warns if the bundle contains executable files.

```bash
eidentic add skill ./vendor/summarise-skill
# or a registry path:
eidentic add skill @acme/billing-skill
```

Requires `@eidentic/skills` to be installed. Use `--overwrite` to replace an existing skill of the same name.

### `eidentic add component`

Copies a pre-built React UI component into your `src/components` directory.

```bash
eidentic add component --list          # show available components
eidentic add component chat            # chat bubble UI
eidentic add component workflow-trace  # step-trace visualisation
eidentic add component run-status      # async run status card
eidentic add component chat --overwrite  # replace existing
```

Available components: `chat`, `workflow-trace`, `run-status`.

### `create-eidentic` templates

```bash
npm create eidentic@latest my-app
# or with a specific template:
npm create eidentic@latest my-app -- --template bun-agent
```

| Template | Description |
|---|---|
| `default` | Node.js + TypeScript agent with SQLite |
| `nextjs-chat` | Next.js App Router chat UI |
| `bun-agent` | Bun runtime server using `@hono/node-server/bun` and LibsqlStore |
