/**
 * hello-quota.ts — infra-free demo of §20.4 per-tenant cumulative quotas.
 *
 * Uses app.request() (no real socket) to drive two requests for the same API key
 * against a hardRuns:1 quota. The first request succeeds (200 SSE); the second
 * is rejected (402 Payment Required) with a quota_exceeded body.
 *
 * Run: pnpm --filter eidentic-examples hello:quota
 */

import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { createServer, ApiKeyAuth, InMemoryQuota } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Build a minimal agent
// ---------------------------------------------------------------------------

const store = new InMemoryStore();
const model = new MockModel([
  {
    content: [{ type: "text", text: "Hello from the quota-limited agent!" }],
    usage: { inputTokens: 10, outputTokens: 8 },
  },
  {
    content: [{ type: "text", text: "This response should not be seen." }],
    usage: { inputTokens: 10, outputTokens: 8 },
  },
]);

const agent = new Agent({
  id: "demo",
  instructions: "You are a helpful assistant.",
  model,
  store,
});

// ---------------------------------------------------------------------------
// Build server: hardRuns:1 quota — one run allowed then blocked
// ---------------------------------------------------------------------------

const quota = new InMemoryQuota({ hardRuns: 1 });

const app = createServer({
  agents: { demo: agent },
  auth: ApiKeyAuth({
    "my-key": { userId: "user-1", apiKey: "my-key" },
    "other-key": { userId: "user-2", apiKey: "other-key" },
  }),
  quota,
});

// ---------------------------------------------------------------------------
// Helper: send a query request for a given API key
// ---------------------------------------------------------------------------

async function query(apiKey: string, sessionId: string): Promise<{
  status: number;
  quotaWarning: string | null;
  body: unknown;
}> {
  const res = await app.request("/v1/agents/demo/query", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: "Hello!", sessionId }),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* SSE text — keep as-is */ }
  return {
    status: res.status,
    quotaWarning: res.headers.get("X-Eidentic-Quota-Warning"),
    body,
  };
}

// ---------------------------------------------------------------------------
// Demo: same key → 200 then 402; different key → 200 (isolated ledger)
// ---------------------------------------------------------------------------

console.log("--- Request 1 (my-key, first — within quota) ---");
const r1 = await query("my-key", "sess-1");
console.log(`Status: ${r1.status}`);           // 200
console.log(`Quota warning: ${r1.quotaWarning ?? "none"}`);

console.log("\n--- Request 2 (my-key, second — quota exceeded) ---");
const r2 = await query("my-key", "sess-2");
console.log(`Status: ${r2.status}`);           // 402
console.log(`Body: ${JSON.stringify(r2.body)}`);

console.log("\n--- Request 3 (other-key — independent ledger, allowed) ---");
const r3 = await query("other-key", "sess-3");
console.log(`Status: ${r3.status}`);           // 200

if (r1.status !== 200) throw new Error(`Expected 200 for first request, got ${r1.status}`);
if (r2.status !== 402) throw new Error(`Expected 402 for second request, got ${r2.status}`);
if (typeof r2.body !== "object" || r2.body === null) throw new Error("Expected JSON body on 402");
if ((r2.body as { error: string }).error !== "quota_exceeded") throw new Error("Expected error=quota_exceeded");
if (r3.status !== 200) throw new Error(`Expected 200 for different key, got ${r3.status}`);

console.log("\nAll assertions passed.");
