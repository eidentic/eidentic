/**
 * hello-better-auth.ts — infra-free demo of @eidentic/better-auth.
 *
 * Uses a fake better-auth verifier (no real DB or provider needed).
 * Shows:
 *  - Request WITH a valid session → 200 SSE, scoped to userId
 *  - Request WITHOUT a session → 401 Unauthorized
 *
 * Run: pnpm --filter eidentic-examples hello:better-auth
 */

import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { createServer } from "@eidentic/server";
import { betterAuthPort } from "@eidentic/better-auth";
import type { BetterAuthLike } from "@eidentic/better-auth";

// ---------------------------------------------------------------------------
// Fake better-auth verifier — returns a session for one magic token.
// In production this would be your real `auth.api` from better-auth.
// ---------------------------------------------------------------------------

const MAGIC_TOKEN = "secret-session-token";

const fakeBetterAuth: BetterAuthLike = {
  async getSession({ headers }) {
    const token = headers.get("x-session-token");
    if (token === MAGIC_TOKEN) {
      return {
        user: { id: "user-42" },
        session: { activeOrganizationId: "org-acme" },
      };
    }
    return null;
  },
};

// ---------------------------------------------------------------------------
// Build agent
// ---------------------------------------------------------------------------

const store = new InMemoryStore();
const model = new MockModel([
  {
    content: [{ type: "text", text: "Hi! I know you are user-42." }],
    usage: { inputTokens: 10, outputTokens: 8 },
  },
  {
    content: [{ type: "text", text: "Hello again!" }],
    usage: { inputTokens: 10, outputTokens: 4 },
  },
]);

const agent = new Agent({
  id: "demo",
  instructions: "You are a helpful assistant.",
  model,
  store,
});

// ---------------------------------------------------------------------------
// Build server with betterAuthPort
// ---------------------------------------------------------------------------

const app = createServer({
  agents: { demo: agent },
  auth: betterAuthPort(fakeBetterAuth),
});

// ---------------------------------------------------------------------------
// Helper: parse SSE text
// ---------------------------------------------------------------------------

function parseSse(text: string) {
  const events: Array<{ event: string; data: unknown }> = [];
  const lines = text.split("\n");
  let event = "";
  let data = "";
  for (const line of lines) {
    if (line.startsWith("event:")) event = line.slice("event:".length).trim();
    else if (line.startsWith("data:")) data = line.slice("data:".length).trim();
    else if (line === "" && event && data) {
      try { events.push({ event, data: JSON.parse(data) }); }
      catch { events.push({ event, data }); }
      event = ""; data = "";
    }
  }
  return events;
}

// ---------------------------------------------------------------------------
// 1. Request WITH a valid session → 200, response scoped to userId
// ---------------------------------------------------------------------------

console.log("--- Request WITH valid session ---");

const authed = await app.request("/v1/agents/demo/query", {
  method: "POST",
  headers: {
    "content-type": "application/json",
    "x-session-token": MAGIC_TOKEN,
  },
  body: JSON.stringify({ input: "Hello!", sessionId: "ba-sess-1" }),
});

console.log("Status:", authed.status); // 200
const authedEvents = parseSse(await authed.text());
const resultEvent = authedEvents.find((e) => e.event === "result");
const output = (resultEvent?.data as { output?: string })?.output;
console.log("Result output:", output);
console.log("Result subtype:", (resultEvent?.data as { subtype?: string })?.subtype);

// ---------------------------------------------------------------------------
// 2. Request WITHOUT a session → 401
// ---------------------------------------------------------------------------

console.log("\n--- Request WITHOUT session ---");

const unauthed = await app.request("/v1/agents/demo/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "Hello!" }),
});

console.log("Status:", unauthed.status); // 401
const unauthedBody = (await unauthed.json()) as { error: string };
console.log("Error:", unauthedBody.error); // "Unauthorized"

// ---------------------------------------------------------------------------
// 3. Health check (no auth required)
// ---------------------------------------------------------------------------

const health = await app.request("/health");
console.log("\nHealth:", await health.json()); // { ok: true }
