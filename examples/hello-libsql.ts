import { Agent, createTool } from "@eidentic/core";
import { LibsqlStore } from "@eidentic/libsql";
import { MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { z } from "zod";

const store = new LibsqlStore(":memory:");
await store.migrate();

const weather = createTool({
  id: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ input }) => ({ city: input.city, tempC: 22, sky: "sunny" }),
});

const model = new MockModel([
  { content: [toolUseBlock("c1", "get_weather", { city: "Istanbul" })], usage: { inputTokens: 6, outputTokens: 3 } },
  { content: [textBlock("It's 22°C and sunny in Istanbul.")], usage: { inputTokens: 8, outputTokens: 9 } },
]);

const agent = new Agent({
  id: "weather-bot",
  instructions: "You are a concise weather assistant. Use the get_weather tool, then answer.",
  model,
  tools: [weather],
  store,
});

for await (const ev of agent.query("What's the weather in Istanbul?", { sessionId: "libsql-demo-1" })) {
  if (ev.type === "result") console.log("\nRESULT:", ev.output, "\nusage:", ev.usage);
  else console.log(ev.type, JSON.stringify("content" in ev ? ev.content : ev));
}
await store.close();
