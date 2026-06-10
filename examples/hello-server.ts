/**
 * hello-server.ts — infra-free demo of @eidentic/server.
 *
 * Builds a MockModel agent and serves it via createServer, then drives
 * the whole thing through app.request() (no real socket needed).
 *
 * Run: pnpm --filter eidentic-examples hello:server
 */

import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { createServer, ApiKeyAuth } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Build agent
// ---------------------------------------------------------------------------

const store = new InMemoryStore();
const model = new MockModel([
  {
    content: [{ type: "text", text: "The capital of France is Paris." }],
    usage: { inputTokens: 20, outputTokens: 12 },
  },
]);

const agent = new Agent({
  id: "demo",
  instructions: "You are a knowledgeable geography assistant.",
  model,
  store,
});

// ---------------------------------------------------------------------------
// Build server with ApiKeyAuth
// ---------------------------------------------------------------------------

const app = createServer({
  agents: { demo: agent },
  auth: ApiKeyAuth({
    "my-secret-key": { userId: "user-42", apiKey: "my-secret-key" },
  }),
  // Opt in to the audit-log endpoint (single-tenant demo; not safe for multi-tenant use).
  exposeEvents: true,
});

// ---------------------------------------------------------------------------
// Drive the query via app.request (no socket)
// ---------------------------------------------------------------------------

console.log("--- Querying agent via app.request ---");

const res = await app.request("/v1/agents/demo/query", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    authorization: "Bearer my-secret-key",
  },
  body: JSON.stringify({ input: "What is the capital of France?", sessionId: "demo-session-1" }),
});

console.log("Status:", res.status);
console.log("Content-Type:", res.headers.get("content-type"));

const text = await res.text();
console.log("\n--- Raw SSE stream ---");
console.log(text);

// Parse and pretty-print SSE events
console.log("--- Parsed events ---");
const lines = text.split("\n");
let event = "";
let data = "";
for (const line of lines) {
  if (line.startsWith("event:")) {
    event = line.slice("event:".length).trim();
  } else if (line.startsWith("data:")) {
    data = line.slice("data:".length).trim();
  } else if (line === "" && event && data) {
    try {
      const parsed = JSON.parse(data) as unknown;
      console.log(`[${event}]`, JSON.stringify(parsed, null, 2));
    } catch {
      console.log(`[${event}]`, data);
    }
    event = "";
    data = "";
  }
}

// ---------------------------------------------------------------------------
// Check audit log
// ---------------------------------------------------------------------------

console.log("\n--- Fetching audit log ---");
const auditRes = await app.request(
  "/v1/agents/demo/sessions/demo-session-1/events",
  { headers: { authorization: "Bearer my-secret-key" } },
);
const audit = (await auditRes.json()) as { events: unknown[] };
console.log(`Stored events: ${audit.events.length}`);

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------

const health = await app.request("/health");
const healthBody = (await health.json()) as { ok: boolean };
console.log("\nHealth:", healthBody);
