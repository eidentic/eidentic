import { describe, it, expect } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import type { ModelMessage, ModelStreamPart } from "@eidentic/types";
import { AIModel } from "../src/model.js";

const usage = (inputTokens: number, outputTokens: number, cacheRead?: number) => ({
  inputTokens: { total: inputTokens, noCache: cacheRead === undefined ? inputTokens : inputTokens - cacheRead, cacheRead, cacheWrite: undefined },
  outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
});

function mockReturning(
  content: any[],
  tokenUsage = usage(80, 30),
  finishReason: any = { unified: "stop", raw: "end" },
) {
  let received: any = null;
  const model = new MockLanguageModelV4({
    doGenerate: async (options: any) => {
      received = options;
      return { content, finishReason, usage: tokenUsage, warnings: [] };
    },
  });
  return { model, getReceived: () => received };
}

const messages: ModelMessage[] = [
  { role: "system", content: "be helpful" },
  { role: "user", content: "weather in Paris?" },
];

describe("AIModel", () => {
  it("returns text + tool calls (parsed) and mapped usage", async () => {
    const { model } = mockReturning([
      { type: "text", text: "checking" },
      { type: "tool-call", toolCallId: "c1", toolName: "search", input: '{"query":"Paris"}' },
    ]);
    const port = new AIModel(model);
    const res = await port.complete({
      messages,
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    });
    expect(res.content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", callId: "c1", name: "search", input: { query: "Paris" } },
    ]);
    expect(res.usage).toEqual({ inputTokens: 80, outputTokens: 30 });
  });

  it("sends the tool's JSON schema to the model non-empty (guards the v6 schema bug)", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: "ok" }]);
    const port = new AIModel(model);
    await port.complete({
      messages,
      tools: [{ name: "search", description: "Search", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } }],
    });
    const sent = getReceived();
    const sentTool = sent.tools.find((t: any) => t.name === "search");
    expect(sentTool.inputSchema.properties).toHaveProperty("query");
  });

  it("works with no tools (plain completion)", async () => {
    const { model } = mockReturning([{ type: "text", text: "hello" }]);
    const port = new AIModel(model);
    const res = await port.complete({ messages, tools: [] });
    expect(res.content).toEqual([{ type: "text", text: "hello" }]);
  });

  it("forwards generation settings (temperature, maxOutputTokens, …) to the model call", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: "ok" }]);
    const port = new AIModel(model, { temperature: 0.2, maxOutputTokens: 1024, topP: 0.9, stopSequences: ["END"] });
    await port.complete({ messages, tools: [] });
    const sent = getReceived();
    expect(sent.temperature).toBe(0.2);
    expect(sent.maxOutputTokens).toBe(1024);
    expect(sent.topP).toBe(0.9);
    expect(sent.stopSequences).toEqual(["END"]);
  });

  it("forwards no settings by default (back-compat: single-arg constructor)", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: "ok" }]);
    const port = new AIModel(model);
    await port.complete({ messages, tools: [] });
    expect(getReceived().temperature).toBeUndefined();
  });

  it("structured output: sets responseFormat to json and returns the parsed object", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: '{"answer":42}' }]);
    const port = new AIModel(model);
    const res = await port.complete({
      messages,
      tools: [],
      outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
    });
    // The JSON Schema is forwarded as a json responseFormat (structured-output mode).
    const sent = getReceived();
    expect(sent.responseFormat?.type).toBe("json");
    expect(sent.responseFormat?.schema?.properties).toHaveProperty("answer");
    // The parsed structured value is surfaced on response.object.
    expect(res.object).toEqual({ answer: 42 });
  });

  it("structured output: no object when the turn emits a tool call instead", async () => {
    const { model } = mockReturning(
      [{ type: "tool-call", toolCallId: "c1", toolName: "search", input: '{"q":"x"}' }],
      undefined,
      { unified: "tool-calls", raw: "tool_calls" },
    );
    const port = new AIModel(model);
    const res = await port.complete({
      messages,
      tools: [{ name: "search", description: "s", inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } }],
      outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    });
    // A tool-calling turn carries no structured object — the loop reads it only on a terminal turn.
    expect(res.object).toBeUndefined();
    expect(res.content.some((b) => b.type === "tool_use")).toBe(true);
  });

  it("no structured output requested → object is absent (back-compat)", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: "plain" }]);
    const port = new AIModel(model);
    const res = await port.complete({ messages, tools: [] });
    expect(res.object).toBeUndefined();
    expect(getReceived().responseFormat).toBeUndefined();
  });

  it("cacheControl: true → system message in prompt has Anthropic ephemeral providerOptions", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: "ok" }]);
    const port = new AIModel(model);
    await port.complete({ messages, tools: [], cacheControl: true });
    const sent = getReceived();
    // The AI SDK maps the instructions option into a prompt entry with role:"system".
    const systemMsg = (sent.prompt as any[]).find((m: any) => m.role === "system");
    expect(systemMsg).toBeDefined();
    expect(systemMsg.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } });
  });

  it("cacheControl absent → no providerOptions on system prompt entry (back-compat)", async () => {
    const { model, getReceived } = mockReturning([{ type: "text", text: "ok" }]);
    const port = new AIModel(model);
    await port.complete({ messages, tools: [] });
    const sent = getReceived();
    const systemMsg = (sent.prompt as any[]).find((m: any) => m.role === "system");
    expect(systemMsg?.providerOptions).toBeUndefined();
  });
});

describe("AIModel.stream", () => {
  it("yields text deltas then a final assembled response with tool call + usage", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "Hello" },
            { type: "text-delta", id: "t1", delta: ", world" },
            { type: "text-end", id: "t1" },
            { type: "tool-call", toolCallId: "c1", toolName: "get_weather", input: '{"city":"Paris"}' },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage(10, 20) },
          ],
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      }),
    });
    const port = new AIModel(model);
    const parts: ModelStreamPart[] = [];
    for await (const p of port.stream!({
      messages: [{ role: "user", content: "weather?" }],
      tools: [{ name: "get_weather", description: "w", inputSchema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
    })) parts.push(p);

    const deltas = parts.filter((p): p is Extract<ModelStreamPart, { type: "delta" }> => p.type === "delta");
    expect(deltas.map((d) => d.delta.text)).toEqual(["Hello", ", world"]);

    const final = parts.at(-1);
    expect(final).toEqual({
      type: "final",
      response: {
        content: [
          { type: "text", text: "Hello, world" },
          { type: "tool_use", callId: "c1", name: "get_weather", input: { city: "Paris" } },
        ],
        usage: { inputTokens: 10, outputTokens: 20 },
      },
    });
  });

  it("surfaces structured output from the AI SDK v7 stream result on terminal turns", async () => {
    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: '{"answer":' },
            { type: "text-delta", id: "t1", delta: "42}" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(12, 6) },
          ],
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      }),
    });
    const port = new AIModel(model);
    const parts: ModelStreamPart[] = [];
    for await (const p of port.stream!({
      messages: [{ role: "user", content: "answer as JSON" }],
      tools: [],
      outputSchema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"] },
    })) parts.push(p);

    const final = parts.at(-1);
    expect(final?.type).toBe("final");
    if (final?.type !== "final") return;
    expect(final.response.object).toEqual({ answer: 42 });
    expect(final.response.usage).toEqual({ inputTokens: 12, outputTokens: 6 });
  });
});

// ---------------------------------------------------------------------------
// M17 fix — aborted stream must throw AbortError, not yield `final`
// ---------------------------------------------------------------------------

describe("M17 fix — AIModel.stream: aborted signal throws AbortError instead of yielding final", () => {
  it("throws a DOMException AbortError when the signal is already aborted before the stream ends", async () => {
    const controller = new AbortController();

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "partial" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(5, 3) },
          ],
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      }),
    });

    // Abort the signal before iteration begins so that the check after the stream loop fires.
    controller.abort();

    const port = new AIModel(model);
    const parts: ModelStreamPart[] = [];
    let thrown: unknown;
    try {
      for await (const p of port.stream!({
        messages: [{ role: "user", content: "hi" }],
        tools: [],
        signal: controller.signal,
      })) {
        parts.push(p);
      }
    } catch (err) {
      thrown = err;
    }

    // Must throw an AbortError — no `final` part yielded.
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe("AbortError");
    // No `final` event should have been yielded.
    expect(parts.some((p) => p.type === "final")).toBe(false);
  });

  it("does NOT throw when the signal is not aborted (normal completion)", async () => {
    const controller = new AbortController();
    // Do NOT abort — normal run.

    const model = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(2, 1) },
          ],
          initialDelayInMs: 0,
          chunkDelayInMs: 0,
        }),
      }),
    });

    const port = new AIModel(model);
    const parts: ModelStreamPart[] = [];
    for await (const p of port.stream!({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      signal: controller.signal,
    })) {
      parts.push(p);
    }

    // Normal completion: `final` must be yielded.
    expect(parts.some((p) => p.type === "final")).toBe(true);
  });
});
