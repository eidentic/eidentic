import { Agent } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { z } from "zod";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";

// A tiny demo of multi-agent (§8): a supervisor fans out to two scripted sub-agents (agent-as-tool),
// each running in an isolated context window, then synthesizes — with the whole tree under one budget.
// Infra-free: every model is a MockModel, every store is in-memory.

const PRICES = { haiku: { inputPerMTok: 0.8, outputPerMTok: 4 } };

async function makeStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

// --- Sub-agent 1: a "searcher" returning typed structured output ---
const searcher = new Agent({
  id: "searcher",
  instructions: "Find sources. Reply ONLY with JSON: { \"sources\": string[] }.",
  model: new MockModel([
    { content: [textBlock('{"sources":["wikipedia.org/Paris","britannica.com/Paris"]}')], usage: { inputTokens: 30, outputTokens: 12 } },
  ]),
  store: await makeStore(),
  modelId: "haiku",
  prices: PRICES,
});

// --- Sub-agent 2: a "reader" returning plain text. It must NOT see the parent's history (§8.3). ---
const readerModel = new MockModel([
  { content: [textBlock("Paris has been France's capital since 987 AD.")], usage: { inputTokens: 25, outputTokens: 14 } },
]);
const reader = new Agent({
  id: "reader",
  instructions: "Summarize the requested fact in one sentence.",
  model: readerModel,
  store: await makeStore(),
  modelId: "haiku",
  prices: PRICES,
});

// --- Supervisor: scripted to spawn each sub-agent, then synthesize ---
const supervisor = new Agent({
  id: "research-lead",
  instructions: "Coordinate parallel research; synthesize a cited answer.",
  model: new MockModel([
    { content: [toolUseBlock("s1", "spawn_agent", { agent: "searcher", input: "sources on the capital of France" })], usage: { inputTokens: 6, outputTokens: 6 } },
    { content: [toolUseBlock("s2", "spawn_agent", { agent: "reader", input: "summarize the capital of France" })], usage: { inputTokens: 6, outputTokens: 6 } },
    { content: [textBlock("The capital of France is Paris (since 987 AD), per 2 sources.")], usage: { inputTokens: 8, outputTokens: 10 } },
  ]),
  store: await makeStore(),
  modelId: "haiku",
  prices: PRICES,
  // Whole-tree budget (§8.6): one ceiling across supervisor + both workers.
  policy: { maxCostUsd: 1.0 },
  subAgents: {
    searcher: { agent: searcher, description: "Finds sources; returns { sources: string[] }.", outputSchema: z.object({ sources: z.array(z.string()) }) },
    reader: { agent: reader, description: "Reads and summarizes a fact in one sentence." },
  },
});

const events: StreamEvent[] = [];
for await (const ev of supervisor.query("Research the capital of France", { sessionId: "demo-multi-1" })) {
  events.push(ev);
  if (ev.type === "tool.result") {
    console.log(`\nspawn_agent → ${ev.isError ? "ERROR" : "ok"}:`, JSON.stringify((ev.output as { output?: unknown }).output ?? ev.output));
  }
}

const result = events.at(-1) as Extract<StreamEvent, { type: "result" }>;
console.log("\nfinal answer:", result.output);
console.log("termination:", result.subtype);

// Typed output of the searcher (validated against its outputSchema) was returned as structured data.
// Isolation: the reader's first model request never contained the supervisor's instructions.
const readerSys = readerModel.calls[0]?.messages.find((m) => m.role === "system");
const readerSysText = typeof readerSys?.content === "string" ? readerSys.content : "";
console.log("\nisolation check — reader saw supervisor instructions?",
  readerSysText.includes("Coordinate parallel research") ? "LEAK!" : "no (isolated)");

// Aggregated tree cost (§8.6): the parent's CostBreakdown folds child usage into `children`.
console.log("\ntree cost breakdown:");
console.log("  foreground (supervisor):", result.cost?.foreground);
console.log("  children (workers):", result.cost?.children);
console.log("  total usd:", result.cost?.usd);
