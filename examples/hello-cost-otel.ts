import { Agent } from "@eidentic/core";
import { InMemoryStore, InMemoryTracer } from "@eidentic/types/testing";
import { textBlock, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";

// A scripted model: first turn asks for an unknown tool (forces a second turn via error result),
// then the second call would never be reached because the token ceiling aborts first.
class ScriptedModel implements ModelPort {
  private i = 0;
  constructor(private readonly steps: ModelResponse[]) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const r = this.steps[this.i++];
    if (!r) throw new Error(`ScriptedModel: no step #${this.i}`);
    return r;
  }
}

const store = new InMemoryStore();
await store.migrate();
const tracer = new InMemoryTracer();

// First response: 30 tokens exceeds the 25-token ceiling. The post-call check aborts with max_tokens.
const model = new ScriptedModel([
  { content: [textBlock("answered before ceiling check")], usage: { inputTokens: 30, outputTokens: 0 } },
  { content: [textBlock("never reached — the token ceiling aborts after call 1")], usage: { inputTokens: 1, outputTokens: 1 } },
]);

const agent = new Agent({
  id: "budgeted",
  instructions: "Do the task within budget.",
  model,
  store,
  modelId: "haiku",
  // Price table makes USD accounting meaningful (usd will appear in the CostBreakdown).
  prices: { haiku: { inputPerMTok: 0.8, outputPerMTok: 4 } },
  policy: { maxTokens: 25 },
  tracer,
});

for await (const ev of agent.query("do the thing", { sessionId: "demo-1" })) {
  if (ev.type === "result") {
    console.log("termination:", ev.subtype); // "max_tokens"
    console.log("cost breakdown:", JSON.stringify(ev.cost, null, 2));
  }
}

console.log("\nemitted spans:");
for (const s of tracer.spans) {
  console.log(`  ${s.name}`, s.attributes);
}

await store.close();
