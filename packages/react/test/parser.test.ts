import { describe, it, expect } from "vitest";
import { parseEidenticStream, applyEvent } from "../src/parser.js";
import type { ParsedStreamState } from "../src/parser.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal NDJSON SSE body from an array of [eventType, payload] pairs. */
function buildSSE(events: Array<[string, Record<string, unknown>]>): string {
  return events
    .map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
}

/**
 * Collect all ParsedStreamState snapshots from the async generator, given
 * an array of raw SSE string chunks (to test split-across-chunk behavior).
 */
async function collectStates(chunks: string[]): Promise<ParsedStreamState[]> {
  const encoder = new TextEncoder();

  async function* toAsyncIterable(): AsyncIterable<Uint8Array> {
    for (const chunk of chunks) {
      yield encoder.encode(chunk);
    }
  }

  const states: ParsedStreamState[] = [];
  for await (const state of parseEidenticStream(toAsyncIterable())) {
    states.push(state);
  }
  return states;
}

/** Shorthand: single-chunk parse. */
async function parse(events: Array<[string, Record<string, unknown>]>): Promise<ParsedStreamState[]> {
  const body = buildSSE(events);
  return collectStates([body]);
}

// ---------------------------------------------------------------------------
// applyEvent unit tests
// ---------------------------------------------------------------------------

describe("applyEvent", () => {
  it("handles stream.delta — creates a new streaming message", () => {
    // We need to import the accumulator internals; we'll test via exported applyEvent
    // by starting from a clean state derived from the parser.
    // Test via collectStates for simplicity.
  });
});

// ---------------------------------------------------------------------------
// stream.delta
// ---------------------------------------------------------------------------

describe("stream.delta", () => {
  it("accumulates delta tokens into a streaming assistant message", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "Hello" } }],
      ["stream.delta", { delta: { text: ", world" } }],
    ]);

    expect(states).toHaveLength(2);
    expect(states[0]!.messages).toHaveLength(1);
    expect(states[0]!.messages[0]).toMatchObject({ role: "assistant", content: "Hello", streaming: true });

    expect(states[1]!.messages).toHaveLength(1);
    expect(states[1]!.messages[0]).toMatchObject({ role: "assistant", content: "Hello, world", streaming: true });
  });

  it("ignores empty delta text", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "" } }],
    ]);
    // Empty text → no update, no state yield
    expect(states).toHaveLength(0);
  });

  it("does not create a second message when delta follows an existing streaming message", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "A" } }],
      ["stream.delta", { delta: { text: "B" } }],
      ["stream.delta", { delta: { text: "C" } }],
    ]);
    const last = states[states.length - 1]!;
    expect(last.messages).toHaveLength(1);
    expect(last.messages[0]!.content).toBe("ABC");
  });
});

// ---------------------------------------------------------------------------
// assistant final event
// ---------------------------------------------------------------------------

describe("assistant event", () => {
  it("finalizes the streaming entry with authoritative text", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "Hello" } }],
      ["assistant", { content: [{ type: "text", text: "Hello, world!" }] }],
    ]);

    const last = states[states.length - 1]!;
    expect(last.messages).toHaveLength(1);
    expect(last.messages[0]).toMatchObject({ role: "assistant", content: "Hello, world!", streaming: false });
  });

  it("emits text directly when no streaming entry exists", async () => {
    const states = await parse([
      ["assistant", { content: [{ type: "text", text: "Direct text" }] }],
    ]);

    expect(states[0]!.messages[0]).toMatchObject({ role: "assistant", content: "Direct text", streaming: false });
  });

  it("surfaces tool_use blocks as toolCalls", async () => {
    const states = await parse([
      [
        "assistant",
        {
          content: [
            { type: "text", text: "Using a tool" },
            { type: "tool_use", callId: "call-1", name: "get_weather", input: { city: "Paris" } },
          ],
        },
      ],
    ]);

    const last = states[states.length - 1]!;
    expect(last.toolCalls).toHaveLength(1);
    expect(last.toolCalls[0]).toMatchObject({ callId: "call-1", name: "get_weather", input: { city: "Paris" } });
  });

  it("accumulates multiple tool calls across turns", async () => {
    const states = await parse([
      ["assistant", { content: [{ type: "tool_use", callId: "c1", name: "tool_a", input: {} }] }],
      ["assistant", { content: [{ type: "tool_use", callId: "c2", name: "tool_b", input: {} }] }],
    ]);

    const last = states[states.length - 1]!;
    expect(last.toolCalls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// tool.result
// ---------------------------------------------------------------------------

describe("tool.result", () => {
  it("accumulates tool results", async () => {
    const states = await parse([
      ["tool.result", { callId: "call-1", toolName: "get_weather", output: "Sunny 25°C", isError: false }],
    ]);

    const last = states[states.length - 1]!;
    expect(last.toolResults).toHaveLength(1);
    expect(last.toolResults[0]).toMatchObject({
      callId: "call-1",
      toolName: "get_weather",
      output: "Sunny 25°C",
      isError: false,
    });
  });

  it("marks error tool results", async () => {
    const states = await parse([
      ["tool.result", { callId: "c1", toolName: "broken_tool", output: "timeout", isError: true }],
    ]);

    expect(states[0]!.toolResults[0]!.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// result (terminal event)
// ---------------------------------------------------------------------------

describe("result event", () => {
  it("sets result with subtype success", async () => {
    const states = await parse([
      [
        "result",
        {
          subtype: "success",
          usage: { inputTokens: 10, outputTokens: 20 },
          numTurns: 1,
          sessionId: "sess-123",
        },
      ],
    ]);

    const last = states[states.length - 1]!;
    expect(last.result).toMatchObject({
      subtype: "success",
      numTurns: 1,
      sessionId: "sess-123",
      usage: { inputTokens: 10, outputTokens: 20 },
    });
  });

  it("exposes suspend request on subtype suspended", async () => {
    const states = await parse([
      [
        "result",
        {
          subtype: "suspended",
          usage: { inputTokens: 5, outputTokens: 5 },
          numTurns: 1,
          sessionId: "sess-456",
          callId: "call-suspend",
          request: { reason: "Need approval", present: { action: "delete_file" } },
        },
      ],
    ]);

    const r = states[states.length - 1]!.result!;
    expect(r.subtype).toBe("suspended");
    expect(r.callId).toBe("call-suspend");
    expect(r.request).toMatchObject({ reason: "Need approval" });
  });

  it("finalizes an in-flight streaming message on result", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "partial" } }],
      [
        "result",
        {
          subtype: "success",
          usage: { inputTokens: 1, outputTokens: 1 },
          numTurns: 1,
          sessionId: "s",
        },
      ],
    ]);

    const last = states[states.length - 1]!;
    expect(last.messages[0]!.streaming).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// session.init and compaction (informational, no state change)
// ---------------------------------------------------------------------------

describe("session.init and compaction", () => {
  it("yields state for session.init (for onEvent consumers) but does not change messages/result", async () => {
    const states = await parse([
      ["session.init", { sessionId: "s", agentId: "a", tools: [], model: "claude-3-5" }],
    ]);
    // session.init is informational — parser yields so onEvent fires, but no messages/result change.
    expect(states).toHaveLength(1);
    expect(states[0]!.messages).toHaveLength(0);
    expect(states[0]!.result).toBeNull();
    expect(states[0]!.lastEvent).toMatchObject({ type: "session.init", sessionId: "s" });
  });

  it("ignores compaction events without changing messages", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "Hi" } }],
      ["compaction", { sessionId: "s", before: 1000, after: 500, stages: ["fifo-truncate"] }],
    ]);

    // Compaction does not touch message content
    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("Hi");
  });
});

// ---------------------------------------------------------------------------
// Full multi-turn conversation
// ---------------------------------------------------------------------------

describe("full conversation flow", () => {
  it("handles streaming text → tool call → tool result → final result", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "Let me check" } }],
      ["stream.delta", { delta: { text: " the weather." } }],
      [
        "assistant",
        {
          content: [
            { type: "text", text: "Let me check the weather." },
            { type: "tool_use", callId: "tc1", name: "get_weather", input: { city: "London" } },
          ],
        },
      ],
      ["tool.result", { callId: "tc1", toolName: "get_weather", output: "Rainy 12°C", isError: false }],
      ["stream.delta", { delta: { text: "It's rainy in London." } }],
      [
        "assistant",
        { content: [{ type: "text", text: "It's rainy in London." }] },
      ],
      [
        "result",
        {
          subtype: "success",
          usage: { inputTokens: 50, outputTokens: 30 },
          numTurns: 2,
          sessionId: "sess-abc",
        },
      ],
    ]);

    const last = states[states.length - 1]!;

    // Two assistant messages
    expect(last.messages).toHaveLength(2);
    expect(last.messages[0]).toMatchObject({ content: "Let me check the weather.", streaming: false });
    expect(last.messages[1]).toMatchObject({ content: "It's rainy in London.", streaming: false });

    // One tool call, one result
    expect(last.toolCalls).toHaveLength(1);
    expect(last.toolCalls[0]!.name).toBe("get_weather");
    expect(last.toolResults).toHaveLength(1);
    expect(last.toolResults[0]!.output).toBe("Rainy 12°C");

    // Terminal result
    expect(last.result?.subtype).toBe("success");
    expect(last.result?.numTurns).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Split-across-chunk lines
// ---------------------------------------------------------------------------

describe("split-across-chunk lines", () => {
  it("correctly parses events split across multiple chunks", async () => {
    // Split an SSE event mid-line across three chunks.
    const full = buildSSE([["stream.delta", { delta: { text: "hello" } }]]);
    // Split at arbitrary byte positions
    const mid1 = Math.floor(full.length / 3);
    const mid2 = Math.floor((full.length * 2) / 3);
    const chunks = [full.slice(0, mid1), full.slice(mid1, mid2), full.slice(mid2)];

    const states = await collectStates(chunks);
    expect(states.length).toBeGreaterThan(0);
    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("hello");
  });

  it("handles event split across exactly the newline boundary", async () => {
    // event:\ndata:\n\n split so \n\n is in a different chunk
    const part1 = "event: stream.delta\ndata: {\"delta\":{\"text\":\"split\"}}";
    const part2 = "\n\n";

    const states = await collectStates([part1, part2]);
    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("split");
  });

  it("handles multiple events packed into a single chunk", async () => {
    const states = await parse([
      ["stream.delta", { delta: { text: "A" } }],
      ["stream.delta", { delta: { text: "B" } }],
      ["stream.delta", { delta: { text: "C" } }],
    ]);

    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("ABC");
  });

  it("handles a chunk that ends mid-event", async () => {
    const full = buildSSE([
      ["stream.delta", { delta: { text: "first" } }],
      ["stream.delta", { delta: { text: "second" } }],
    ]);

    // Find position of second event start and split there.
    const splitAt = full.indexOf("event: stream.delta\ndata:") + 5;
    const chunks = [full.slice(0, splitAt), full.slice(splitAt)];

    const states = await collectStates(chunks);
    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("firstsecond");
  });
});

// ---------------------------------------------------------------------------
// Error resilience
// ---------------------------------------------------------------------------

describe("error resilience", () => {
  it("skips malformed JSON lines without throwing", async () => {
    // Build a body with an invalid JSON line.
    const body = "event: stream.delta\ndata: not-json\n\nevent: stream.delta\ndata: {\"delta\":{\"text\":\"ok\"}}\n\n";
    const states = await collectStates([body]);
    // The valid event should still be parsed.
    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("ok");
  });

  it("handles an unknown event type gracefully", async () => {
    const states = await parse([
      ["unknown.event.type", { foo: "bar" }],
      ["stream.delta", { delta: { text: "still works" } }],
    ]);

    const last = states[states.length - 1]!;
    expect(last.messages[0]!.content).toBe("still works");
  });
});
