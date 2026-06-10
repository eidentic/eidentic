// ---------------------------------------------------------------------------
// @eidentic/a2a — Agent-to-Agent (A2A) interop
//
// SERVER: expose a Eidentic Agent as an A2A endpoint (Hono routes)
//   GET  /.well-known/agent-card.json
//   POST /  (JSON-RPC: message/send, tasks/get)
//
// CLIENT: consume a remote A2A agent as a first-class Eidentic Tool
//   a2aTool(transport) → Tool
//   httpA2ATransport(baseUrl) → A2ATransport
//   fetchAgentCard(baseUrl) → A2AAgentCard
//
// DEFERRED: streaming (message/stream + SSE), push notifications, OAuth.
//
// A2A v0.3 — confirmed shapes from @a2a-js/sdk@0.3.13.
// ---------------------------------------------------------------------------

export { a2aRoutes, drainIterableAgent, drainPromiseResult } from "./server.js";
export type { A2AAgentCard, A2ASkill, A2AServerOptions, AgentLike } from "./server.js";

export { a2aTool, httpA2ATransport, fetchAgentCard } from "./client.js";
export type { A2ATransport, A2AToolOptions } from "./client.js";
