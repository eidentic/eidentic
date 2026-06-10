/**
 * hello-rate-limit.ts — infra-free demo of §20.3 tenant token-bucket rate limiting.
 *
 * Uses app.request() (no real socket) to drive two requests for the same API key
 * against a capacity-1 limiter. The first request succeeds (200 SSE), the second
 * is rejected (429) with a Retry-After header.
 *
 * Run: pnpm --filter eidentic-examples hello:rate-limit
 */

import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { createServer, ApiKeyAuth, InMemoryTokenBucketLimiter } from "@eidentic/server";

// ---------------------------------------------------------------------------
// Build a minimal agent
// ---------------------------------------------------------------------------

const store = new InMemoryStore();
const model = new MockModel([
  {
    content: [{ type: "text", text: "Hello from the rate-limited agent!" }],
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
// Build server: capacity-1 limiter, refill=10 tokens/sec (finite Retry-After)
// ---------------------------------------------------------------------------

const app = createServer({
  agents: { demo: agent },
  auth: ApiKeyAuth({
    "my-key": { userId: "user-1", apiKey: "my-key" },
    "other-key": { userId: "user-2", apiKey: "other-key" },
  }),
  rateLimiter: new InMemoryTokenBucketLimiter({ capacity: 1, refillPerSec: 10 }),
});

// ---------------------------------------------------------------------------
// Helper: send a query request for a given API key
// ---------------------------------------------------------------------------

async function query(apiKey: string, sessionId: string): Promise<{ status: number; retryAfter: string | null }> {
  const res = await app.request("/v1/agents/demo/query", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ input: "Hello!", sessionId }),
  });
  await res.text(); // drain any SSE stream
  return { status: res.status, retryAfter: res.headers.get("Retry-After") };
}

// ---------------------------------------------------------------------------
// Demo: same key → 200 then 429; different key → 200 (isolated bucket)
// ---------------------------------------------------------------------------

console.log("--- Request 1 (my-key, first) ---");
const r1 = await query("my-key", "sess-1");
console.log(`Status: ${r1.status}`);         // 200

console.log("\n--- Request 2 (my-key, second — throttled) ---");
const r2 = await query("my-key", "sess-2");
console.log(`Status: ${r2.status}`);         // 429
console.log(`Retry-After: ${r2.retryAfter}`); // e.g. "1"

console.log("\n--- Request 3 (other-key — different bucket, allowed) ---");
const r3 = await query("other-key", "sess-3");
console.log(`Status: ${r3.status}`);         // 200

if (r1.status !== 200) throw new Error(`Expected 200 for first request, got ${r1.status}`);
if (r2.status !== 429) throw new Error(`Expected 429 for second request, got ${r2.status}`);
if (r3.status !== 200) throw new Error(`Expected 200 for different key, got ${r3.status}`);

console.log("\nAll assertions passed.");
