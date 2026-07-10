import { describe, expect, it, vi } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import {
  textBlock,
  toolUseBlock,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
  type StreamEvent,
} from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { reflection } from "../src/strategies.js";

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const event = events.at(-1);
  if (!event || event.type !== "result") throw new Error("expected a terminal result");
  return event;
}

describe("model response limits", () => {
  it("rejects an oversized complete response before it is persisted or exposed", async () => {
    const secret = "provider-secret-that-must-not-cross-the-boundary";
    const store = new InMemoryStore();
    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [textBlock(secret)],
          usage: { inputTokens: 1, outputTokens: 100 },
        };
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelResponseLimits: { maxBytes: 8 },
    });

    const events = await collect(agent.query("go", { sessionId: "complete-limit" }));

    expect(terminal(events)).toMatchObject({
      subtype: "error",
      output: "model response exceeded the configured output limit",
      usage: { inputTokens: 1, outputTokens: 100 },
      details: { errorName: "ModelResponseLimitError" },
    });
    expect(events.some((event) => event.type === "assistant")).toBe(false);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(await store.readEvents("complete-limit"))).not.toContain(secret);
  });

  it("stops an oversized stream, cancels the provider, and persists only the bounded partial text", async () => {
    const secret = "secret-overflow-chunk";
    const store = new InMemoryStore();
    const caller = new AbortController();
    const addSpy = vi.spyOn(caller.signal, "addEventListener");
    const removeSpy = vi.spyOn(caller.signal, "removeEventListener");
    let providerSignalAborted = false;
    let generatorClosed = false;

    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("complete must not be called");
      },
      async *stream(request: ModelRequest): AsyncIterable<ModelStreamPart> {
        try {
          yield { type: "delta", delta: { text: "safe" } };
          yield { type: "delta", delta: { text: secret } };
          yield {
            type: "final",
            response: { content: [textBlock(`safe${secret}`)], usage: { inputTokens: 1, outputTokens: 10 } },
          };
        } finally {
          providerSignalAborted = request.signal?.aborted === true;
          generatorClosed = true;
        }
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelResponseLimits: { maxBytes: 5 },
    });

    const events = await collect(agent.query("go", { sessionId: "stream-limit", signal: caller.signal }));

    expect(events.filter((event) => event.type === "stream.delta")).toEqual([
      { type: "stream.delta", delta: { text: "safe" } },
    ]);
    expect(terminal(events)).toMatchObject({
      subtype: "error",
      output: "model response exceeded the configured output limit",
      details: { errorName: "ModelResponseLimitError" },
    });
    expect(providerSignalAborted).toBe(true);
    expect(generatorClosed).toBe(true);
    expect(caller.signal.aborted).toBe(false);

    const stored = await store.readEvents("stream-limit");
    expect(stored.find((event) => event.kind === "assistant")?.payload).toMatchObject({
      content: [textBlock("safe")],
      partial: true,
      interrupted: "output_limit",
    });
    expect(JSON.stringify(stored)).not.toContain(secret);

    const addedAbort = addSpy.mock.calls.find(([type]) => type === "abort");
    expect(addedAbort).toBeDefined();
    expect(removeSpy).toHaveBeenCalledWith("abort", addedAbort?.[1]);
  });

  it("closes the stream at the first final response instead of accumulating post-final chunks", async () => {
    const secret = "post-final-secret";
    const store = new InMemoryStore();
    let generatorClosed = false;
    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("complete must not be called");
      },
      async *stream(): AsyncIterable<ModelStreamPart> {
        try {
          yield { type: "delta", delta: { text: "ok" } };
          yield {
            type: "final",
            response: { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
          };
          yield { type: "delta", delta: { text: secret } };
        } finally {
          generatorClosed = true;
        }
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelResponseLimits: { maxBytes: 8 },
    });

    const events = await collect(agent.query("go", { sessionId: "first-final" }));

    expect(terminal(events)).toMatchObject({ subtype: "success", output: "ok" });
    expect(generatorClosed).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("applies the optional estimated-token ceiling to complete responses", async () => {
    const store = new InMemoryStore();
    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return { content: [textBlock("123456789")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelResponseLimits: { maxBytes: 100, maxEstimatedTokens: 2 },
    });

    const events = await collect(agent.query("go", { sessionId: "token-limit" }));

    expect(terminal(events)).toMatchObject({
      subtype: "error",
      details: { errorName: "ModelResponseLimitError" },
    });
  });

  it("bounds structured response objects even when the visible text is small", async () => {
    const secret = "structured-secret-that-is-far-too-large";
    const store = new InMemoryStore();
    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [textBlock("{}")],
          object: { value: secret },
          usage: { inputTokens: 1, outputTokens: 10 },
        };
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelResponseLimits: { maxBytes: 24 },
    });

    const events = await collect(agent.query("go", { sessionId: "structured-limit" }));

    expect(terminal(events)).toMatchObject({
      subtype: "error",
      details: { errorName: "ModelResponseLimitError" },
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(await store.readEvents("structured-limit"))).not.toContain(secret);
  });

  it("applies the same boundary to a reflection strategy's auxiliary critic call", async () => {
    const secret = "oversized-critic-feedback-that-must-not-enter-the-revision-prompt";
    const store = new InMemoryStore();
    let primaryCalls = 0;
    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        primaryCalls++;
        return { content: [textBlock("bounded draft")], usage: { inputTokens: 1, outputTokens: 2 } };
      },
    };
    const critic: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return {
          content: [toolUseBlock("critic-call", "critique", { satisfactory: false, feedback: secret })],
          usage: { inputTokens: 2, outputTokens: 20 },
        };
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      strategy: reflection({ critic, maxRevisions: 1 }),
      modelResponseLimits: { maxBytes: 32 },
    });

    const events = await collect(agent.query("go", { sessionId: "critic-limit" }));

    expect(terminal(events)).toMatchObject({ subtype: "success", output: "bounded draft" });
    expect(primaryCalls).toBe(1);
    expect(JSON.stringify(events)).not.toContain(secret);
  });

  it("removes the retry-backoff abort listener after a normal timer completion", async () => {
    const store = new InMemoryStore();
    const caller = new AbortController();
    const addSpy = vi.spyOn(caller.signal, "addEventListener");
    const removeSpy = vi.spyOn(caller.signal, "removeEventListener");
    let calls = 0;
    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        calls++;
        if (calls === 1) throw new Error("network timeout");
        return { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      modelRetry: { maxAttempts: 2, backoffMs: 1 },
    });

    const events = await collect(agent.query("go", { sessionId: "retry-cleanup", signal: caller.signal }));

    expect(terminal(events)).toMatchObject({ subtype: "success", output: "ok" });
    const addedAbort = addSpy.mock.calls.find(([type]) => type === "abort");
    expect(addedAbort).toBeDefined();
    expect(removeSpy).toHaveBeenCalledWith("abort", addedAbort?.[1]);
  });

  it.each([
    { maxBytes: 0 },
    { maxBytes: Number.NaN },
    { maxBytes: 10, maxEstimatedTokens: -1 },
  ])("rejects invalid limit configuration: %j", (modelResponseLimits) => {
    const store = new InMemoryStore();
    const model: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    expect(() => new Agent({ id: "a", instructions: "", model, store, modelResponseLimits }))
      .toThrow(/modelResponseLimits\..*positive safe integer/);
  });
});
