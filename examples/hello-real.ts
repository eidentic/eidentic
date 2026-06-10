import { Agent, createTool } from "@eidentic/core";
import { SqliteStore } from "@eidentic/sqlite";
import { AIModel } from "@eidentic/model";
import { MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const store = new SqliteStore("./eidentic-demo.sqlite");
await store.migrate();

const weather = createTool({
  id: "get_weather",
  description: "Get the current weather for a city.",
  inputSchema: z.object({ city: z.string() }),
  execute: async ({ input }) => ({ city: input.city, tempC: 18, sky: "clear" }),
});

// Real Anthropic model when ANTHROPIC_API_KEY is set; otherwise a scripted mock so the demo always runs.
const model = process.env.ANTHROPIC_API_KEY
  ? new AIModel(anthropic("claude-sonnet-4-5"))
  : new MockModel([
      { content: [toolUseBlock("c1", "get_weather", { city: "Istanbul" })], usage: { inputTokens: 6, outputTokens: 3 } },
      { content: [textBlock("It's 18°C and clear in Istanbul.")], usage: { inputTokens: 8, outputTokens: 9 } },
    ]);

const agent = new Agent({
  id: "weather-bot",
  instructions: "You are a concise weather assistant. Use the get_weather tool, then answer.",
  model,
  tools: [weather],
  store,
});

for await (const ev of agent.query("What's the weather in Istanbul?", { sessionId: "weather-1" })) {
  if (ev.type === "result") console.log("\nRESULT:", ev.output, "\nusage:", ev.usage);
  else console.log(ev.type, JSON.stringify("content" in ev ? ev.content : ev));
}
await store.close();
