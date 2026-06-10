import { Agent, createTool } from "@eidentic/core";
import { SqliteStore } from "@eidentic/sqlite";
import { AIModel } from "@eidentic/model";
import { StreamMockModel } from "@eidentic/types/testing";
import { textBlock } from "@eidentic/types";
import { anthropic } from "@ai-sdk/anthropic";
import { z } from "zod";

const store = new SqliteStore("./eidentic-demo.sqlite");
await store.migrate();

const time = createTool({
  id: "now",
  description: "Get the current time.",
  inputSchema: z.object({}),
  execute: async () => ({ iso: new Date().toISOString() }),
});

// Real streaming via Anthropic when ANTHROPIC_API_KEY is set; otherwise a scripted stream so the demo always runs.
const model = process.env.ANTHROPIC_API_KEY
  ? new AIModel(anthropic("claude-sonnet-4-5"))
  : new StreamMockModel([
      {
        deltas: ["Hello", "! ", "Streaming ", "works ", "token ", "by ", "token."],
        response: { content: [textBlock("Hello! Streaming works token by token.")], usage: { inputTokens: 5, outputTokens: 9 } },
      },
    ]);

const agent = new Agent({ id: "streamer", instructions: "Be brief.", model, tools: [time], store });

process.stdout.write("assistant: ");
for await (const ev of agent.query("Say hello and confirm streaming.", { sessionId: "stream-1" })) {
  if (ev.type === "stream.delta") process.stdout.write(ev.delta.text);
  else if (ev.type === "result") process.stdout.write(`\n[done] usage=${JSON.stringify(ev.usage)}\n`);
}
await store.close();
