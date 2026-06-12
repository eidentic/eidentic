/**
 * Tests for toUIMessageStream / toUIMessageStreamResponse
 *
 * Strategy: build scripted AsyncIterable<StreamEvent> arrays, consume the
 * resulting ReadableStream<UIMessageChunk>, collect chunks and assert the
 * right parts appear in order.
 */

import { describe, it, expect } from "vitest";
import type { StreamEvent } from "@eidentic/types";
import { toUIMessageStream, toUIMessageStreamResponse } from "@eidentic/server";
import { readUIMessageStream } from "ai";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Wraps a plain array as an AsyncIterable<StreamEvent> */
async function* asStream(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const ev of events) {
    yield ev;
  }
}

/**
 * Collect all UIMessageChunks from a ReadableStream produced by
 * toUIMessageStream().
 */
async function collectChunks(
  events: StreamEvent[],
): Promise<Array<{ type: string; [key: string]: unknown }>> {
  const stream = toUIMessageStream(asStream(events));
  const chunks: Array<{ type: string; [key: string]: unknown }> = [];

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value as { type: string; [key: string]: unknown });
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

function chunkTypes(chunks: Array<{ type: string }>): string[] {
  return chunks.map((c) => c.type);
}

// ---------------------------------------------------------------------------
// Baseline: empty stream
// ---------------------------------------------------------------------------

describe("toUIMessageStream", () => {
  it("emits start + start-step at minimum with only a result event", async () => {
    const events: StreamEvent[] = [
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 10, outputTokens: 5 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const types = chunkTypes(chunks);

    expect(types).toContain("start");
    expect(types).toContain("start-step");
    expect(types).toContain("finish-step");
    expect(types).toContain("finish");

    const finish = chunks.find((c) => c.type === "finish");
    expect(finish?.finishReason).toBe("stop");
  });

  // ---------------------------------------------------------------------------
  // stream.delta events → text-start / text-delta / text-end
  // ---------------------------------------------------------------------------

  it("maps stream.delta events to text-start + text-delta + text-end", async () => {
    const events: StreamEvent[] = [
      { type: "stream.delta", delta: { text: "Hello" } },
      { type: "stream.delta", delta: { text: " world" } },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const types = chunkTypes(chunks);

    // text-start appears exactly once for the streaming block
    expect(types.filter((t) => t === "text-start")).toHaveLength(1);
    // two deltas
    const deltas = chunks.filter((c) => c.type === "text-delta");
    expect(deltas).toHaveLength(2);
    expect(deltas[0].delta).toBe("Hello");
    expect(deltas[1].delta).toBe(" world");
    // text-end closes the block
    expect(types.filter((t) => t === "text-end")).toHaveLength(1);

    // All text parts share the same id
    const textStartId = chunks.find((c) => c.type === "text-start")?.id;
    for (const d of deltas) {
      expect(d.id).toBe(textStartId);
    }
  });

  // ---------------------------------------------------------------------------
  // assistant event — text blocks
  // ---------------------------------------------------------------------------

  it("maps assistant text blocks to text-start + text-delta + text-end (no prior delta)", async () => {
    const events: StreamEvent[] = [
      {
        type: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const types = chunkTypes(chunks);

    expect(types).toContain("text-start");
    expect(types).toContain("text-delta");
    expect(types).toContain("text-end");

    const delta = chunks.find((c) => c.type === "text-delta");
    expect(delta?.delta).toBe("Hi there!");
  });

  // ---------------------------------------------------------------------------
  // stream.delta + assistant (typical streaming flow)
  // ---------------------------------------------------------------------------

  it("closes the streaming text block when assistant event arrives", async () => {
    const events: StreamEvent[] = [
      { type: "stream.delta", delta: { text: "token1 " } },
      { type: "stream.delta", delta: { text: "token2" } },
      {
        type: "assistant",
        content: [{ type: "text", text: "token1 token2" }],
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);

    // The streaming block opens on first delta
    const textStarts = chunks.filter((c) => c.type === "text-start");
    // One open from stream.delta, one open from the assistant text block
    expect(textStarts.length).toBeGreaterThanOrEqual(1);

    // The streaming block is closed (text-end) before the assistant text block
    const textEnds = chunks.filter((c) => c.type === "text-end");
    expect(textEnds.length).toBeGreaterThanOrEqual(1);
  });

  it("does NOT re-emit streamed text as a second block (no duplicate assistant message)", async () => {
    const events: StreamEvent[] = [
      { type: "stream.delta", delta: { text: "Mer" } },
      { type: "stream.delta", delta: { text: "haba" } },
      // turn-final assistant event carries the SAME accumulated text
      { type: "assistant", content: [{ type: "text", text: "Merhaba" }] },
      { type: "result", subtype: "success", usage: { inputTokens: 5, outputTokens: 2 }, numTurns: 1, sessionId: "s1" },
    ];

    const chunks = await collectChunks(events);

    // Exactly ONE text block (the streamed one) — the assistant event must not open a second.
    expect(chunks.filter((c) => c.type === "text-start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "text-end")).toHaveLength(1);
    // The whole-string re-emit is gone…
    expect(chunks.filter((c) => c.type === "text-delta" && c.delta === "Merhaba")).toHaveLength(0);
    // …and the streamed deltas reconstruct the message exactly once.
    const streamed = chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("");
    expect(streamed).toBe("Merhaba");
  });

  it("still emits the assistant text block when the turn was NOT streamed (no deltas)", async () => {
    const events: StreamEvent[] = [
      { type: "assistant", content: [{ type: "text", text: "full answer" }] },
      { type: "result", subtype: "success", usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1, sessionId: "s1" },
    ];

    const chunks = await collectChunks(events);

    expect(chunks.filter((c) => c.type === "text-start")).toHaveLength(1);
    expect(chunks.filter((c) => c.type === "text-delta").map((c) => c.delta).join("")).toBe("full answer");
  });

  // ---------------------------------------------------------------------------
  // assistant event — tool_use blocks → tool-input-available
  // ---------------------------------------------------------------------------

  it("maps assistant tool_use blocks to tool-input-available", async () => {
    const events: StreamEvent[] = [
      {
        type: "assistant",
        content: [
          {
            type: "tool_use",
            callId: "call-abc",
            name: "search",
            input: { query: "Eidentic SDK" },
          },
        ],
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 10, outputTokens: 20 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const toolInput = chunks.find((c) => c.type === "tool-input-available");

    expect(toolInput).toBeDefined();
    expect(toolInput?.toolCallId).toBe("call-abc");
    expect(toolInput?.toolName).toBe("search");
    expect(toolInput?.input).toEqual({ query: "Eidentic SDK" });
  });

  // ---------------------------------------------------------------------------
  // tool.result (success) → tool-output-available
  // ---------------------------------------------------------------------------

  it("maps successful tool.result to tool-output-available", async () => {
    const events: StreamEvent[] = [
      {
        type: "tool.result",
        callId: "call-abc",
        toolName: "search",
        output: { results: ["item1"] },
        isError: false,
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const toolOutput = chunks.find((c) => c.type === "tool-output-available");

    expect(toolOutput).toBeDefined();
    expect(toolOutput?.toolCallId).toBe("call-abc");
    expect(toolOutput?.output).toEqual({ results: ["item1"] });
  });

  // ---------------------------------------------------------------------------
  // tool.result (error) → tool-output-error
  // ---------------------------------------------------------------------------

  it("maps error tool.result to tool-output-error", async () => {
    const events: StreamEvent[] = [
      {
        type: "tool.result",
        callId: "call-xyz",
        toolName: "fetch",
        output: "Network timeout",
        isError: true,
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const errChunk = chunks.find((c) => c.type === "tool-output-error");

    expect(errChunk).toBeDefined();
    expect(errChunk?.toolCallId).toBe("call-xyz");
    expect(errChunk?.errorText).toBe("Network timeout");
  });

  it("serialises non-string error output as JSON in tool-output-error", async () => {
    const events: StreamEvent[] = [
      {
        type: "tool.result",
        callId: "call-xyz",
        toolName: "fetch",
        output: { code: 500, message: "Internal error" },
        isError: true,
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const errChunk = chunks.find((c) => c.type === "tool-output-error");

    expect(errChunk?.errorText).toBe('{"code":500,"message":"Internal error"}');
  });

  // ---------------------------------------------------------------------------
  // TerminationSubtype → finishReason mapping
  // ---------------------------------------------------------------------------

  it.each([
    ["success", "stop"],
    ["max_tokens", "length"],
    ["error", "error"],
    ["max_turns", "other"],
    ["max_cost", "other"],
    ["max_wall_clock", "other"],
    ["aborted", "other"],
    ["suspended", "other"],
  ] as const)(
    "maps subtype \"%s\" to finishReason \"%s\"",
    async (subtype, expected) => {
      const events: StreamEvent[] = [
        {
          type: "result",
          subtype,
          usage: { inputTokens: 5, outputTokens: 2 },
          numTurns: 1,
          sessionId: "s1",
        },
      ];

      const chunks = await collectChunks(events);
      const finish = chunks.find((c) => c.type === "finish");
      expect(finish?.finishReason).toBe(expected);
    },
  );

  // ---------------------------------------------------------------------------
  // Ignored events
  // ---------------------------------------------------------------------------

  it("silently ignores session.init and compaction events", async () => {
    const events: StreamEvent[] = [
      {
        type: "session.init",
        sessionId: "s1",
        agentId: "agent1",
        tools: ["search"],
        model: "claude-opus-4-8",
      },
      { type: "stream.delta", delta: { text: "hi" } },
      {
        type: "compaction",
        sessionId: "s1",
        before: 10000,
        after: 2000,
        stages: ["summarise"],
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    // Should complete without errors
    const chunks = await collectChunks(events);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunkTypes(chunks)).toContain("finish");
  });

  // ---------------------------------------------------------------------------
  // Full multi-turn agentic flow
  // ---------------------------------------------------------------------------

  it("handles a full turn: streaming deltas + tool use + result", async () => {
    const events: StreamEvent[] = [
      {
        type: "session.init",
        sessionId: "s1",
        agentId: "agent1",
        tools: ["search"],
        model: "claude-opus-4-8",
      },
      { type: "stream.delta", delta: { text: "Let me search for you..." } },
      {
        type: "assistant",
        content: [
          { type: "text", text: "Let me search for you..." },
          {
            type: "tool_use",
            callId: "call-1",
            name: "search",
            input: { q: "Eidentic" },
          },
        ],
      },
      {
        type: "tool.result",
        callId: "call-1",
        toolName: "search",
        output: ["result1"],
        isError: false,
      },
      { type: "stream.delta", delta: { text: "Found something!" } },
      {
        type: "assistant",
        content: [{ type: "text", text: "Found something!" }],
      },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 100, outputTokens: 50 },
        numTurns: 2,
        sessionId: "s1",
      },
    ];

    const chunks = await collectChunks(events);
    const types = chunkTypes(chunks);

    // Overall envelope
    expect(types).toContain("start");
    expect(types).toContain("finish");

    // Text streaming
    expect(types).toContain("text-delta");

    // Tool call
    expect(types).toContain("tool-input-available");
    const toolInput = chunks.find((c) => c.type === "tool-input-available");
    expect(toolInput?.toolCallId).toBe("call-1");

    // Tool output
    expect(types).toContain("tool-output-available");
    const toolOutput = chunks.find((c) => c.type === "tool-output-available");
    expect(toolOutput?.toolCallId).toBe("call-1");
  });
});

// ---------------------------------------------------------------------------
// toUIMessageStreamResponse — basic HTTP contract
// ---------------------------------------------------------------------------

describe("toUIMessageStreamResponse", () => {
  it("returns a 200 Response with SSE content-type", async () => {
    const events: StreamEvent[] = [
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const res = toUIMessageStreamResponse(asStream(events));

    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(200);
    // AI SDK wraps as SSE
    expect(res.headers.get("content-type")).toMatch(/text\/event-stream/);
  });

  it("passes through custom headers and status code", async () => {
    const events: StreamEvent[] = [
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const res = toUIMessageStreamResponse(asStream(events), {
      status: 201,
      headers: { "x-custom": "yes" },
    });

    expect(res.status).toBe(201);
    expect(res.headers.get("x-custom")).toBe("yes");
  });

  it("produces SSE body containing AI SDK protocol markers", async () => {
    const events: StreamEvent[] = [
      { type: "stream.delta", delta: { text: "hello" } },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const res = toUIMessageStreamResponse(asStream(events));
    const body = await res.text();

    // The AI SDK SSE body uses "data: " lines
    expect(body).toContain("data:");
    // Should contain serialised chunk data
    expect(body).toContain("text-delta");
  });

  it("readUIMessageStream reconstructs parts including text", async () => {
    const events: StreamEvent[] = [
      { type: "stream.delta", delta: { text: "hi " } },
      { type: "stream.delta", delta: { text: "there" } },
      {
        type: "result",
        subtype: "success",
        usage: { inputTokens: 5, outputTokens: 2 },
        numTurns: 1,
        sessionId: "s1",
      },
    ];

    const stream = toUIMessageStream(asStream(events));
    const messages: unknown[] = [];
    for await (const msg of readUIMessageStream({ stream })) {
      messages.push(msg);
    }

    expect(messages.length).toBeGreaterThan(0);
    // The last message should contain the accumulated text
    const last = messages[messages.length - 1] as { parts?: Array<{ type: string; text?: string }> };
    const textParts = last.parts?.filter((p) => p.type === "text") ?? [];
    const combined = textParts.map((p) => p.text ?? "").join("");
    expect(combined).toContain("hi there");
  });
});
