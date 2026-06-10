/**
 * hello-cancellation.ts
 *
 * Infra-free demo of §16.4 cooperative query cancellation.
 *
 * A MockModel-driven agent is given a multi-turn script. A tool's execute() aborts
 * the AbortController mid-run. The post-tool-batch boundary check fires immediately
 * and the loop terminates with `result{subtype:"aborted"}`, carrying the partial
 * usage accumulated up to that point.
 */
import { Agent } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { z } from "zod";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { createTool } from "@eidentic/core";

const controller = new AbortController();

// A tool that aborts the run when executed.
const abortingTool = createTool({
  id: "abort_now",
  description: "Aborts the current run",
  inputSchema: z.object({ reason: z.string() }),
  execute: async ({ input }) => {
    console.log(`[tool] abort_now triggered: "${input.reason}"`);
    controller.abort();
    return { aborted: true, reason: input.reason };
  },
});

const store = new InMemoryStore();
await store.migrate();

// Turn 1: call the aborting tool.
// Turn 2 would be the terminal text reply — but the abort fires before it runs.
const model = new MockModel([
  {
    content: [toolUseBlock("c1", "abort_now", { reason: "user cancelled" })],
    usage: { inputTokens: 12, outputTokens: 4 },
  },
  {
    content: [textBlock("This turn should never execute.")],
    usage: { inputTokens: 15, outputTokens: 6 },
  },
]);

const agent = new Agent({
  id: "cancellation-demo",
  instructions: "You are a helpful assistant.",
  model,
  store,
  tools: [abortingTool],
  now: () => new Date().toISOString(),
  newId: (() => { let n = 0; return () => `evt_${n++}`; })(),
});

console.log("Starting agent run with abort signal...\n");

const events: StreamEvent[] = [];
for await (const ev of agent.query("Please abort the run.", { sessionId: "demo-cancel-1", signal: controller.signal })) {
  events.push(ev);
  if (ev.type === "tool.result") {
    console.log(`[event] tool.result: ${ev.toolName} →`, ev.output);
  }
}

const result = events.at(-1) as Extract<StreamEvent, { type: "result" }>;

console.log("\n=== Terminal event ===");
console.log("subtype:", result.subtype); // "aborted"
console.log("numTurns:", result.numTurns);
console.log("usage (partial):", result.usage);
console.log("cost:", result.cost);

if (result.subtype !== "aborted") {
  throw new Error(`Expected aborted, got: ${result.subtype}`);
}
if (model.calls.length !== 1) {
  throw new Error(`Expected 1 model call (partial run), got: ${model.calls.length}`);
}
console.log(`\nModel calls made: ${model.calls.length} (second turn was skipped — correct)`);
console.log("Done. AbortSignal cooperative cancellation working correctly.");
