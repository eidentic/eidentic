import { Agent, createTool } from "@eidentic/core";
import { SqliteStore } from "@eidentic/sqlite";
import { Memory } from "@eidentic/memory";
import { StreamMockModel } from "@eidentic/types/testing";
import { textBlock } from "@eidentic/types";
import { z } from "zod";

const store = new SqliteStore("./eidentic-demo.sqlite");
await store.migrate();

const memory = new Memory({ store });
const scope = { kind: "user", agentId: "memo", userId: "baran" } as const;

// Seed a cross-session memory.
await memory.ingest([{ id: "seed1", scope, text: "Baran is building Eidentic, a TypeScript agent SDK." }]);

const noop = createTool({ id: "noop", description: "does nothing", inputSchema: z.object({}), execute: async () => ({}) });

const model = new StreamMockModel([
  { deltas: ["I ", "recall ", "that."], response: { content: [textBlock("I recall that.")], usage: { inputTokens: 4, outputTokens: 3 } } },
]);

const agent = new Agent({ id: "memo", instructions: "Use recalled memory.", model, tools: [noop], store, memory });

console.log("--- query (recalls the seeded memory into context) ---");
for await (const ev of agent.query("What is Baran building?", { sessionId: "m1", userId: "baran" })) {
  if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
  else if (ev.type === "result") process.stdout.write(`\n[done]\n`);
}

// Prove recall works: the seeded fact is retrievable for this scope.
const hits = await store.searchMemory(scope, "what is Baran building", 5);
console.log("recall hits:", hits.map((h) => h.text));
await store.close();
