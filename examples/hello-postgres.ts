import { Agent, createTool } from "@eidentic/core";
import { PostgresStore } from "@eidentic/postgres";
import { MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { PGlite } from "@electric-sql/pglite";
import { z } from "zod";

// Infra-free via pglite: real Postgres in WASM, no server needed.
const client = new PGlite();
const store = await PostgresStore.create({ client });

const weather = createTool({
  id: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ input }) => ({ city: input.city, tempC: 18, sky: "cloudy" }),
});

const model = new MockModel([
  { content: [toolUseBlock("c1", "get_weather", { city: "Istanbul" })], usage: { inputTokens: 6, outputTokens: 3 } },
  { content: [textBlock("It's 18°C and cloudy in Istanbul.")], usage: { inputTokens: 8, outputTokens: 9 } },
]);

const agent = new Agent({
  id: "weather-bot-pg",
  instructions: "You are a concise weather assistant. Use the get_weather tool, then answer.",
  model,
  tools: [weather],
  store,
});

console.log("--- hello-postgres (PostgresStore via pglite) ---");
for await (const ev of agent.query("What's the weather in Istanbul?", { sessionId: "pg-demo-1" })) {
  if (ev.type === "result") console.log("\nRESULT:", ev.output, "\nusage:", ev.usage);
  else console.log(ev.type, JSON.stringify("content" in ev ? ev.content : ev));
}

// Demonstrate stateful memory: upsert a block and read it back
await store.upsertBlock({ kind: "agent", agentId: "weather-bot-pg" }, { label: "user_pref", value: "Celsius" });
const block = await store.getBlock({ kind: "agent", agentId: "weather-bot-pg" }, "user_pref");
console.log("\nPersisted block:", block);
await store.close();
