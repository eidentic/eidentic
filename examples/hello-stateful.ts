import { Agent, createTool } from "@eidentic/core";
import { SqliteStore } from "@eidentic/sqlite";
import { MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { z } from "zod";

const store = new SqliteStore("./eidentic-demo.sqlite");
await store.migrate();

const greet = createTool({
  id: "greet",
  description: "greet a person",
  inputSchema: z.object({ name: z.string() }),
  execute: async ({ input }) => ({ greeting: `Hello, ${input.name}!` }),
});

// A scripted model so the demo runs with no API key.
const model = new MockModel([
  { content: [toolUseBlock("c1", "greet", { name: "Baran" })], usage: { inputTokens: 4, outputTokens: 2 } },
  { content: [textBlock("Done — I greeted Baran.")], usage: { inputTokens: 5, outputTokens: 3 } },
]);

const agent = new Agent({ id: "demo", instructions: "You are a demo agent.", model, tools: [greet], store });

for await (const ev of agent.query("Please greet Baran", { sessionId: "demo-session-1" })) {
  console.log(JSON.stringify(ev));
}
await store.close();
