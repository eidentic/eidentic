/**
 * hello-strategies.ts — composable agent strategies (§3.6)
 *
 * Demonstrates reflection(): a draft is critiqued by a SEPARATE critic model, revised once,
 * then accepted. All infra-free: MockModel for both agent and critic.
 */
import { Agent, reflection } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";

async function makeStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

// --- Agent model: produces a weak draft on pass 1, an improved one on pass 2 ---
const agentModel = new MockModel([
  {
    content: [textBlock("Paris is the capital of France.")],
    usage: { inputTokens: 20, outputTokens: 8 },
  },
  {
    content: [textBlock(
      "Paris is the capital and largest city of France. " +
      "It has been the country's political, cultural, and economic centre since the Middle Ages. " +
      "The city is home to iconic landmarks including the Eiffel Tower, Notre-Dame Cathedral, and the Louvre Museum.",
    )],
    usage: { inputTokens: 35, outputTokens: 45 },
  },
]);

// --- Critic model: dissatisfied with the first draft, satisfied with the second ---
// The critic is a DIFFERENT ModelPort — this is the whole point (Constitution #6).
const criticModel = new MockModel([
  {
    content: [toolUseBlock("crit1", "critique", {
      satisfactory: false,
      feedback:
        "The answer is correct but too brief. Please elaborate with cultural context, " +
        "notable landmarks, and the city's historical significance.",
    })],
    usage: { inputTokens: 30, outputTokens: 20 },
  },
  {
    content: [toolUseBlock("crit2", "critique", {
      satisfactory: true,
      feedback: "Good — comprehensive and well-structured.",
    })],
    usage: { inputTokens: 40, outputTokens: 10 },
  },
]);

// Confirm they are different objects (Constitution #6: intrinsic self-critique fails).
console.log("agentModel === criticModel:", agentModel === criticModel); // must be false

const agent = new Agent({
  id: "reflection-demo",
  instructions: "You are a knowledgeable assistant. Answer questions thoroughly.",
  model: agentModel,
  store: await makeStore(),
  now: () => new Date().toISOString(),
  newId: (() => { let n = 0; return () => `e${n++}`; })(),
  strategy: reflection({
    critic: criticModel,
    maxRevisions: 2,
  }),
});

let pass = 0;
const events: StreamEvent[] = [];

console.log("\n--- Running reflection agent ---\n");

for await (const ev of agent.query("What is Paris?", { sessionId: "hello-strategies-1" })) {
  events.push(ev);
  if (ev.type === "session.init") {
    console.log(`session: ${ev.sessionId}`);
  } else if (ev.type === "assistant") {
    pass++;
    const text = ev.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("");
    if (text) {
      console.log(`\n[pass ${pass}] draft:\n  ${text}`);
    }
  } else if (ev.type === "result") {
    console.log(`\n[final] subtype: ${ev.subtype}`);
    console.log(`[final] output: ${ev.output}`);
    console.log(`[final] numTurns: ${ev.numTurns}`);
  }
}

// Verify: exactly one terminal result event in the stream.
const terminals = events.filter((e) => e.type === "result");
console.log(`\nterminal result events emitted: ${terminals.length} (expected: 1)`);
console.log(`agent model calls: ${agentModel.calls.length} (expected: 2 — initial draft + revision)`);
console.log(`critic model calls: ${criticModel.calls.length} (expected: 2 — one per draft)`);
