---
"@eidentic/types": minor
"@eidentic/core": patch
"@eidentic/server": minor
---

§13 Hono REST+SSE agent server — `@eidentic/server` + `AuthPort` in `@eidentic/types`.

- **`AuthPort`** (new in `@eidentic/types`): framework-agnostic auth interface with `AuthRequest` / `AuthPrincipal` types. Returned `null` → server responds 401.
- **`@eidentic/server`** (new package): Hono 4.x app exposing Eidentic agents as a service.
  - `createServer(opts)` — builds the Hono router; accepts `Record<string, Agent>` or an `AgentResolver` function.
  - `GET /health` — liveness probe (no auth).
  - `POST /v1/agents/:agentId/query` — SSE-streamed run via `streamSSE`; wires `c.req.raw.signal` into `agent.query` (§16.4 request-abort cancellation); auto-generates `sessionId` when absent. Body capped at 512 KB.
  - `POST /v1/agents/:agentId/resume` — SSE-streamed resume (HITL / durable continuation). Body capped at 512 KB. `signal` now threaded into `Agent.resume` so a client disconnect aborts the underlying run.
  - `GET /v1/agents/:agentId/sessions/:sessionId/events` — JSON audit log via `store.readEvents`. **Opt-in only** (`exposeEvents: true`); returns 404 when omitted (secure-by-default). v1 limitation: no per-principal session ownership check — do not expose to untrusted multi-tenant callers without an ownership layer.
  - `NoAuth` — always-allow single-tenant adapter (default).
  - `ApiKeyAuth(keys)` — reads `Authorization: Bearer <key>` or `x-api-key`, maps to `AuthPrincipal`; principal's `userId` flows into `agent.query` scope.
  - `serveNode(app, opts?)` — optional thin wrapper over `@hono/node-server` (dynamic import; actionable error if the dep is absent).
- **`@eidentic/core`** (patch): `Agent.store` public getter (mirrors `Agent.sandbox`); `Agent.resume` accepts `signal?: AbortSignal` threaded into the resume loop for cooperative cancellation on client disconnect.
