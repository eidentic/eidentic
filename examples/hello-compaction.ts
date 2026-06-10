/**
 * Context-engine compaction demo (§4.4, Plan 15).
 *
 * Uses an InMemoryStore + a scripted MockModel — no API keys, no external infrastructure.
 * The agent is configured with a deliberately tiny `maxContextTokens` budget so compaction
 * triggers after a couple of large tool results. The `onPreCompact` hook prints a message
 * before any drop. The run calls a failing tool whose error evidence must survive compaction
 * (§4.6), then finishes successfully.
 *
 * Run: pnpm hello:compaction
 */

import { Agent, createTool } from "@eidentic/core";
import { InMemoryStore } from "@eidentic/types/testing";
import {
  textBlock,
  toolUseBlock,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
} from "@eidentic/types";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Scripted model: asks for big-output tools (growing the window past the tiny
// budget), fails once (failure evidence must survive compaction), then finishes.
// ---------------------------------------------------------------------------

class ScriptedModel implements ModelPort {
  private i = 0;
  constructor(private readonly steps: ModelResponse[]) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const r = this.steps[this.i++];
    if (!r) throw new Error(`ScriptedModel: no step #${this.i}`);
    return r;
  }
}

const BIG = "x".repeat(8_000); // ~2000 estimated tokens per tool result

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const bigTool = createTool({
  id: "fetch_doc",
  description: "Fetches a large document.",
  inputSchema: z.object({}),
  execute: async () => ({ url: "https://example.com/huge", body: BIG }),
});

const failTool = createTool({
  id: "flaky",
  description: "A tool that always fails (to demonstrate failure-evidence preservation).",
  inputSchema: z.object({}),
  execute: async () => {
    throw new Error("network-timeout (this failure must survive compaction)");
  },
});

// ---------------------------------------------------------------------------
// Scripted turns:
//   1. fetch_doc → big result
//   2. flaky    → error (isError=true, must survive compaction)
//   3. fetch_doc → big result  (window grows past budget → compaction fires)
//   4. fetch_doc → big result  (window still large → second compaction may fire)
//   5. text     → done
// ---------------------------------------------------------------------------

const model = new ScriptedModel([
  { content: [toolUseBlock("c1", "fetch_doc", {})], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [toolUseBlock("c2", "flaky", {})], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [toolUseBlock("c3", "fetch_doc", {})], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [toolUseBlock("c4", "fetch_doc", {})], usage: { inputTokens: 1, outputTokens: 1 } },
  {
    content: [textBlock("All done — compaction preserved the system prefix, recent turns, and the failure evidence.")],
    usage: { inputTokens: 1, outputTokens: 1 },
  },
]);

// ---------------------------------------------------------------------------
// Agent with a tiny pre-rot budget
// ---------------------------------------------------------------------------

const store = new InMemoryStore();
await store.migrate();

const agent = new Agent({
  id: "compaction-demo",
  instructions: "SYSTEM-PREFIX: you are a research assistant.",
  model,
  store,
  tools: [bigTool, failTool],
  maxTurns: 20,
  // A deliberately tiny pre-rot budget so compaction triggers within a few large turns.
  compaction: { maxContextTokens: 1_500, keepRecentTurns: 2, toolResultMaxChars: 1_000 },
  // Archive hook: fires BEFORE any drop; a real app could persist the full transcript here.
  onPreCompact: ({ estTokens }) => {
    console.log(`  [onPreCompact] about to compact — current window ~${estTokens} tokens`);
  },
});

console.log("Starting compaction demo...\n");

for await (const ev of agent.query("Research the topic thoroughly.", { sessionId: "compaction-1" })) {
  if (ev.type === "compaction") {
    console.log(`[compaction] ${ev.before} → ${ev.after} tokens via stages: ${ev.stages.join(", ")}`);
  } else if (ev.type === "tool.result") {
    const preview = String(ev.output).slice(0, 60);
    console.log(`[tool.result] ${ev.toolName} isError=${ev.isError} output="${preview}..."`);
  } else if (ev.type === "result") {
    console.log("\ntermination:", ev.subtype);
    console.log("final output:", ev.output);
  }
}

await store.close();
