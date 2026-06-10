/**
 * hello-studio.ts — infra-free demo of @eidentic/studio.
 *
 * Builds an agent + studio, runs a query, then exercises the management API:
 * lists agents, sessions, events, edits a block via PUT, shows facts and skills.
 *
 * No real server socket needed — all driven via app.request().
 *
 * Run: pnpm --filter eidentic-examples hello:studio
 */

import { Agent } from "@eidentic/core";
import { MockModel, InMemoryStore } from "@eidentic/types/testing";
import { SkillBank } from "@eidentic/skills";
import { createStudio } from "@eidentic/studio";

// ---------------------------------------------------------------------------
// Build agent
// ---------------------------------------------------------------------------

const store = new InMemoryStore();

const model = new MockModel([
  {
    content: [{ type: "text", text: "Hello from studio agent!" }],
    usage: { inputTokens: 15, outputTokens: 8 },
  },
]);

const agent = new Agent({
  id: "studio-demo",
  instructions: "You are a knowledgeable assistant for the studio demo.",
  model,
  store,
});

// ---------------------------------------------------------------------------
// Seed some initial data
// ---------------------------------------------------------------------------

await store.migrate();
await store.upsertBlock(
  { kind: "agent", agentId: "studio-demo" },
  { label: "profile", value: "Initial profile value" },
);
await store.assertFact(
  { kind: "agent", agentId: "studio-demo" },
  {
    subject: "user",
    predicate: "preferred_language",
    object: "TypeScript",
    validFrom: new Date().toISOString(),
  },
);
await store.indexMemory([
  {
    scope: { kind: "agent", agentId: "studio-demo" },
    id: "m1",
    text: "The user prefers TypeScript over JavaScript",
  },
]);

// ---------------------------------------------------------------------------
// Build skill bank with a quarantined skill
// ---------------------------------------------------------------------------

// Use a fake sandbox so code-string (agent-authored) skills can run during test-gate.
const fakeSandbox = {
  async run(_code: string, _opts?: unknown) {
    return { stdout: "EIDENTIC_RESULT:null", stderr: "", exitCode: 0 };
  },
};
const bank = new SkillBank({ sandbox: fakeSandbox });
// Register a human-authored skill (runnable immediately)
await bank.register({
  name: "summarize",
  description: "Summarizes text.",
  allowedTools: [],
  tests: [{ name: "ok", input: "hello", check: () => true }],
  run: async (input: unknown) => `Summary: ${String(input)}`,
});
// Register an agent-authored skill (quarantined until approved) using code-string form
await bank.register(
  {
    name: "greet",
    description: "Greets a user by name.",
    allowedTools: [],
    tests: [{ name: "ok", input: null, check: () => true }],
    code: "console.log('EIDENTIC_RESULT:\"hello\"')",
  },
  { author: "agent" }, // quarantined until approved
);

// ---------------------------------------------------------------------------
// Build studio app
// ---------------------------------------------------------------------------

const app = createStudio({
  agents: { "studio-demo": agent },
  skillBanks: { "studio-demo": bank },
  // auth: ApiKeyAuth({ ... }) — wire auth before exposing to any network!
});

// ---------------------------------------------------------------------------
// Step 1: Run a query via the run route
// ---------------------------------------------------------------------------

console.log("=== Step 1: Run agent query ===");
const runRes = await app.request("/v1/agents/studio-demo/query", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ input: "Hello, agent!", sessionId: "demo-session-1" }),
});
console.log("Run status:", runRes.status);
const sseText = await runRes.text();
// Parse the result event
const lines = sseText.split("\n");
let lastResult: unknown;
let ev = "", data = "";
for (const line of lines) {
  if (line.startsWith("event:")) ev = line.slice(6).trim();
  else if (line.startsWith("data:")) data = line.slice(5).trim();
  else if (line === "" && ev && data) {
    if (ev === "result") lastResult = JSON.parse(data);
    ev = ""; data = "";
  }
}
console.log("Result:", JSON.stringify(lastResult, null, 2));

// ---------------------------------------------------------------------------
// Step 2: List agents
// ---------------------------------------------------------------------------

console.log("\n=== Step 2: GET /api/agents ===");
const agentsRes = await app.request("/api/agents");
const agents = await agentsRes.json();
console.log(JSON.stringify(agents, null, 2));

// ---------------------------------------------------------------------------
// Step 3: List sessions
// ---------------------------------------------------------------------------

console.log("\n=== Step 3: GET /api/agents/studio-demo/sessions ===");
const sessRes = await app.request("/api/agents/studio-demo/sessions");
const sessions = await sessRes.json();
console.log(JSON.stringify(sessions, null, 2));

// ---------------------------------------------------------------------------
// Step 4: Read session events (trace)
// ---------------------------------------------------------------------------

console.log("\n=== Step 4: GET /api/agents/studio-demo/sessions/demo-session-1/events ===");
const eventsRes = await app.request("/api/agents/studio-demo/sessions/demo-session-1/events");
const eventsBody = (await eventsRes.json()) as { events: unknown[] };
console.log(`Events count: ${eventsBody.events.length}`);
console.log(JSON.stringify(eventsBody.events.slice(0, 2), null, 2));

// ---------------------------------------------------------------------------
// Step 5: List blocks
// ---------------------------------------------------------------------------

console.log("\n=== Step 5: GET /api/agents/studio-demo/blocks ===");
const blocksRes = await app.request("/api/agents/studio-demo/blocks");
const blocks = await blocksRes.json();
console.log(JSON.stringify(blocks, null, 2));

// ---------------------------------------------------------------------------
// Step 6: Edit a block via PUT
// ---------------------------------------------------------------------------

console.log("\n=== Step 6: PUT /api/agents/studio-demo/blocks/profile ===");
const putRes = await app.request("/api/agents/studio-demo/blocks/profile", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ value: "Updated profile via studio PUT", expectVersion: 0 }),
});
console.log("PUT status:", putRes.status);
const updatedBlock = await putRes.json();
console.log(JSON.stringify(updatedBlock, null, 2));

// Verify CAS conflict: version is now 1, trying expectVersion: 0 again should 409
const conflictRes = await app.request("/api/agents/studio-demo/blocks/profile", {
  method: "PUT",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ value: "Should conflict", expectVersion: 0 }),
});
console.log("Conflict status (expect 409):", conflictRes.status);

// ---------------------------------------------------------------------------
// Step 7: Facts
// ---------------------------------------------------------------------------

console.log("\n=== Step 7: GET /api/agents/studio-demo/facts ===");
const factsRes = await app.request("/api/agents/studio-demo/facts");
const facts = await factsRes.json();
console.log(JSON.stringify(facts, null, 2));

// ---------------------------------------------------------------------------
// Step 8: Memories search
// ---------------------------------------------------------------------------

console.log("\n=== Step 8: GET /api/agents/studio-demo/memories?q=TypeScript ===");
const memRes = await app.request("/api/agents/studio-demo/memories?q=TypeScript");
const memories = await memRes.json();
console.log(JSON.stringify(memories, null, 2));

// ---------------------------------------------------------------------------
// Step 9: Skills list + approve
// ---------------------------------------------------------------------------

console.log("\n=== Step 9: GET /api/agents/studio-demo/skills ===");
const skillsRes = await app.request("/api/agents/studio-demo/skills");
const skills = await skillsRes.json();
console.log(JSON.stringify(skills, null, 2));

console.log("\n=== Step 9b: POST /api/agents/studio-demo/skills/greet/approve ===");
const approveRes = await app.request("/api/agents/studio-demo/skills/greet/approve", {
  method: "POST",
});
console.log("Approve status:", approveRes.status);
const approveBody = await approveRes.json();
console.log(JSON.stringify(approveBody, null, 2));

// Verify no longer quarantined
const skillsAfterRes = await app.request("/api/agents/studio-demo/skills");
const skillsAfter = (await skillsAfterRes.json()) as Array<{ name: string; quarantined: boolean }>;
const greetAfter = skillsAfter.find((s) => s.name === "greet");
console.log("greet.quarantined after approve:", greetAfter?.quarantined); // false

console.log("\n=== Done ===");
