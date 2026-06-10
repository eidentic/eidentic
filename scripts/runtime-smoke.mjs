/**
 * Cross-runtime smoke test for Eidentic core.
 * Imports built dist via relative paths — no package resolution needed.
 * Runs under Node, Bun, and Deno with --allow-read --allow-env.
 */

import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

// Detect runtime name best-effort
const runtime =
  typeof globalThis.Bun !== "undefined"
    ? "bun"
    : typeof globalThis.Deno !== "undefined"
    ? "deno"
    : "node";

// Import built dist via relative paths (no npm/Deno registry resolution)
const { Agent } = await import(join(root, "packages/core/dist/index.js"));
const { textBlock } = await import(join(root, "packages/types/dist/index.js"));
const { InMemoryStore, MockModel } = await import(
  join(root, "packages/types/dist/testing.js")
);

// --- Build a simple MockModel agent with InMemoryStore (pure JS, no native addon) ---
const scripted = [
  {
    content: [textBlock("hello from eidentic")],
    usage: { inputTokens: 5, outputTokens: 4 },
  },
];
const model = new MockModel(scripted);
const store = new InMemoryStore();
await store.migrate();

const agent = new Agent({
  id: "smoke-agent",
  instructions: "You are a smoke test agent.",
  model,
  store,
});

const events = [];
for await (const event of agent.query("say hello", { sessionId: "smoke-s1" })) {
  events.push(event);
}

const result = events.at(-1);

if (!result) {
  console.error("runtime-smoke FAILED: no events emitted");
  process.exit(1);
}
if (result.subtype !== "success") {
  console.error("runtime-smoke FAILED: expected subtype 'success', got:", result.subtype, result);
  process.exit(1);
}
if (!result.output || !result.output.includes("hello from eidentic")) {
  console.error("runtime-smoke FAILED: unexpected output:", result.output);
  process.exit(1);
}

console.log("runtime-smoke OK on", runtime);
process.exit(0);
