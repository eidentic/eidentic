import { Agent } from "@eidentic/core";
import { Memory } from "@eidentic/memory";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type Scope } from "@eidentic/types";

const store = new InMemoryStore();
await store.migrate();

const memory = new Memory({
  store,
  blocks: { human: { value: "", description: "durable facts about the user", limit: 500 } },
});
const scope: Scope = { kind: "user", agentId: "selfedit", userId: "baran" };

// Session 1: the agent self-edits its `human` block via a scripted memory_append.
const model1 = new MockModel([
  { content: [toolUseBlock("c1", "memory_append", { label: "human", text: "Name: Baran\nLoves: TypeScript\n" })], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [textBlock("Noted — I'll remember that.")], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agent1 = new Agent({ id: "selfedit", instructions: "Remember durable facts about the user.", model: model1, store, memory });

console.log("--- session 1: agent edits its own memory ---");
for await (const ev of agent1.query("My name is Baran and I love TypeScript.", { sessionId: "s1", userId: "baran" })) {
  if (ev.type === "result") console.log("assistant:", ev.output);
}

const human1 = (await memory.getAlwaysInContext(scope)).find((b) => b.label === "human");
console.log("human block now:", JSON.stringify(human1?.value));

// Session 2: a brand-new session under the SAME user scope. The self-edit persisted.
const model2 = new MockModel([{ content: [textBlock("Welcome back!")], usage: { inputTokens: 1, outputTokens: 1 } }]);
const agent2 = new Agent({ id: "selfedit", instructions: "Greet the user.", model: model2, store, memory });

console.log("\n--- session 2: NEW session, same user — the edit persisted ---");
for await (const _ev of agent2.query("hi again", { sessionId: "s2", userId: "baran" })) { /* drain */ }

const blocks = await memory.getAlwaysInContext(scope);
console.log("always-in-context blocks for this user:");
for (const b of blocks) console.log(`  <${b.label}> v${b.version}: ${JSON.stringify(b.value)}`);
