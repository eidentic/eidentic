import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { createTool } from "../src/tool.js";
import { Agent } from "../src/agent.js";

async function run(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of agent.query(input, { sessionId })) out.push(e);
  return out;
}

const remember = createTool({
  id: "remember_name",
  description: "store the user's name in memory",
  inputSchema: z.object({ name: z.string() }),
  sideEffect: "idempotent",
  execute: async () => ({ ok: true }),
});

describe("Agent durable resume", () => {
  it("rejects an unknown session without creating an orphan record", async () => {
    const store = new InMemoryStore();
    const agent = new Agent({
      id: "a",
      instructions: "",
      model: new MockModel([]),
      store,
      durable: true,
    });
    await expect((async () => {
      for await (const _ of agent.resume("typo")) { /* drain */ }
    })()).rejects.toThrow(/unknown session/i);
    expect(await store.getSession("typo")).toBeNull();
  });

  it("durable: true with a non-durable store throws a clear error on query", async () => {
    // A bare StorePort without DurablePort methods.
    const bare = {
      migrate: async () => {}, close: async () => {},
      createSession: async () => {}, getSession: async () => null,
      appendEvents: async () => {}, readEvents: async () => [],
      getBlocks: async () => [], getBlock: async () => null,
      upsertBlock: async () => ({ label: "", value: "", version: 0, updatedAt: "t" }),
      appendBlock: async () => ({ label: "", value: "", version: 0, updatedAt: "t" }),
      getBlockHistory: async () => [], indexMemory: async () => {}, searchMemory: async () => [],
    } as unknown as import("@eidentic/types").StorePort;
    const model = new MockModel([{ content: [textBlock("x")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const agent = new Agent({ id: "a", instructions: "", model, store: bare, durable: true, now: () => "t", newId: ((n) => () => `e${n++}`)(0) });
    await expect((async () => { for await (const _ of agent.query("hi", { sessionId: "s" })) { /* */ } })()).rejects.toThrow(/DurablePort/i);
  });

  it("resume continues an interrupted run from the event log to completion", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // First model finishes after a tool; we run query to completion to seed the log...
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("first done")], usage: { inputTokens: 1, outputTokens: 1 } },
      // ...then resume on a COMPLETED run should replay the terminal result without calling the model.
    ]);
    const agent = new Agent({ id: "a", instructions: "", model, store, durable: true, now: () => "t", newId: ((n) => () => `e${n++}`)(0) });
    const first = [];
    for await (const e of agent.query("go", { sessionId: "s" })) first.push(e);
    expect(first.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "first done" });
    const callsAfterQuery = model.calls.length;

    const resumed = [];
    for await (const e of agent.resume("s")) resumed.push(e);
    expect(resumed.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "first done" });
    expect(model.calls.length).toBe(callsAfterQuery); // completed run → model NOT re-called
  });
});

describe("Agent", () => {
  it("is stateful across sessions via memory blocks", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const model1 = new MockModel([
      { content: [toolUseBlock("c1", "remember_name", { name: "Baran" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("Got it, Baran.")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent1 = new Agent({
      id: "a1", instructions: "assistant", model: model1, tools: [remember], store,
      now: () => "t", newId: ((n) => () => `id${n++}`)(0),
    });
    await store.upsertBlock({ kind: "agent", agentId: "a1" }, { label: "human", value: "name: Baran" });
    const r1 = await run(agent1, "I'm Baran", "s1");
    expect(r1.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "Got it, Baran." });

    const model2 = new MockModel([{ content: [textBlock("Welcome back, Baran.")], usage: { inputTokens: 1, outputTokens: 1 } }]);
    const agent2 = new Agent({
      id: "a1", instructions: "assistant", model: model2, tools: [remember], store,
      now: () => "t", newId: ((n) => () => `id2_${n++}`)(0),
    });
    await run(agent2, "hello again", "s2");
    const context = String(model2.calls[0]!.messages.find((message) =>
      message.role === "user" && String(message.content).includes("<memory>"),
    )?.content);
    expect(context).toContain("name: Baran");
  });

  it("replays prior turns into the next query on the same session", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([
      { content: [textBlock("hi there")], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("again")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({
      id: "a2", instructions: "asst", model, store,
      now: () => "t", newId: ((n) => () => `r${n++}`)(0),
    });
    await run(agent, "first", "sess");
    await run(agent, "second", "sess");
    const msgs = model.calls[1]!.messages;
    const userContents = msgs.filter((m) => m.role === "user").map((m) => m.content);
    expect(userContents).toContain("first");
    expect(userContents).toContain("second");
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
  });

  it("serializes concurrent queries targeting the same session in one process", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    let releaseFirst!: () => void;
    const firstMayFinish = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let signalFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { signalFirstStarted = resolve; });
    let calls = 0;
    const model: import("@eidentic/types").ModelPort = {
      async complete() {
        calls++;
        if (calls === 1) {
          signalFirstStarted();
          await firstMayFinish;
        }
        return {
          content: [textBlock(`answer-${calls}`)],
          usage: { inputTokens: 1, outputTokens: 1 },
        };
      },
    };
    const firstAgent = new Agent({
      id: "serialized-agent",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `serial-a-${n++}`)(0),
    });
    const secondAgent = new Agent({
      id: "serialized-agent",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `serial-b-${n++}`)(0),
    });

    const first = run(firstAgent, "first", "shared-session");
    const second = run(secondAgent, "second", "shared-session");
    await firstStarted;
    await Promise.resolve();
    expect(calls).toBe(1);
    releaseFirst();

    const [firstEvents, secondEvents] = await Promise.all([first, second]);
    expect(firstEvents.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    expect(secondEvents.at(-1)).toMatchObject({ type: "result", subtype: "success" });
    const stored = await store.readEvents("shared-session");
    expect(stored.filter((event) => event.kind === "user").map((event) => event.payload)).toEqual([
      "first",
      "second",
    ]);
  });
});
