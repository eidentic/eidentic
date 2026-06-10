---
"@eidentic/a2a": minor
---

Add `@eidentic/a2a` — Agent-to-Agent (A2A) interop package.

**Server side** (`a2aRoutes`): expose any `AgentLike` (or a real `@eidentic/core` `Agent`) as an A2A-compatible Hono endpoint — `GET /.well-known/agent-card.json` returns the discovery card; `POST /` handles JSON-RPC `message/send` (run the agent, return a completed `Task` with a text part) and `tasks/get` (retrieve stored task by id). Unknown method → -32601; malformed input → -32600/-32602/-32700.

**Client side** (`a2aTool`, `httpA2ATransport`, `fetchAgentCard`): consume any remote A2A agent as a first-class Eidentic `Tool`. `a2aTool(transport)` wraps an `A2ATransport` (structural interface — network-free in tests), calls `message/send`, extracts the reply text from the returned Task history. Error responses and transport throws surface as `{ error }` results (never throw out of execute). `httpA2ATransport(baseUrl)` provides a real fetch-based transport for production; `fetchAgentCard(baseUrl)` fetches the well-known agent card.

**Structural transport** keeps CI network-free: `A2ATransport` is a plain interface (`send(method, params): Promise<unknown>`) so tests inject an in-memory fake without importing `@a2a-js/sdk`.

**Deferred**: `message/stream` + SSE streaming, push notifications, OAuth.
