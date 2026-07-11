import { describe, expect, it } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, type StreamEvent } from "@eidentic/types";
import { Agent } from "../src/agent.js";

async function collect(iterable: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of iterable) events.push(event);
  return events;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const result = events.findLast((event) => event.type === "result");
  if (!result || result.type !== "result") throw new Error("missing terminal result");
  return result;
}

describe("persisted terminal run state", () => {
  it("replays max_tokens exactly instead of reclassifying the assistant event as success", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("partial answer")], usage: { inputTokens: 8, outputTokens: 8 } },
    ]);
    const agent = new Agent({
      id: "terminal-agent",
      instructions: "",
      model,
      store,
      durable: true,
      policy: { maxTokens: 10 },
      now: () => "t",
      newId: ((n) => () => `event-${n++}`)(0),
    });

    const live = terminal(await collect(agent.query("hello", { sessionId: "terminal-session" })));
    expect(live.subtype).toBe("max_tokens");

    const stored = await store.readEvents("terminal-session");
    expect(stored.some((event) => (event.kind as string) === "run_started")).toBe(true);
    expect(stored.some((event) => (event.kind as string) === "terminal_result")).toBe(true);

    const replayed = terminal(await collect(agent.resume("terminal-session")));
    expect(replayed).toEqual(live);
    expect(model.calls).toHaveLength(1);
  });
});
