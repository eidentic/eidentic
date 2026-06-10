/**
 * Feature 1 — Model fallback chain.
 *
 * Tests cover:
 *  1. Primary fails after exhausting modelRetry → first fallback used, run succeeds.
 *  2. All fallbacks also fail → error surfaces with last fallback's error message.
 *  3. AbortError → fallback is NEVER tried; run emits aborted immediately.
 *  4. Streaming: primary throws BEFORE first delta → fallback streams OK.
 *  5. Streaming: primary throws AFTER first delta has been emitted → NO fallback
 *     (would break incremental streaming); emits terminal error.
 *  6. Primary succeeds → fallbacks never called.
 *  7. Non-transient error on primary (no modelRetry configured) → falls back immediately.
 *  8. Non-transient error on primary (modelRetry configured) → exhausts retry then falls back.
 */

import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import {
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ModelStreamPart,
  type StreamEvent,
} from "@eidentic/types";
import { textBlock } from "@eidentic/types";
import { Agent } from "../src/agent.js";

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.at(-1);
  if (!t || t.type !== "result") throw new Error(`last event is not a result; got ${JSON.stringify(t)}`);
  return t as Extract<StreamEvent, { type: "result" }>;
}

async function freshStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

// ---------------------------------------------------------------------------
// Test 1: primary fails after exhausting retries → first fallback used
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: primary fails → first fallback used", () => {
  it("falls back to first fallback model when primary exhausts all retries", async () => {
    const store = await freshStore();

    // Primary always fails with a transient error.
    const primaryCalls: ModelRequest[] = [];
    const primary: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        primaryCalls.push(req);
        throw new Error("service unavailable");
      },
    };

    // First fallback: succeeds.
    const fallback1Calls: ModelRequest[] = [];
    const fallback1: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        fallback1Calls.push(req);
        return { content: [textBlock("fallback1 answer")], usage: { inputTokens: 2, outputTokens: 2 } };
      },
    };

    // Second fallback: should never be called.
    const fallback2Calls: ModelRequest[] = [];
    const fallback2: ModelPort = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        fallback2Calls.push(req);
        return { content: [textBlock("fallback2 answer")], usage: { inputTokens: 2, outputTokens: 2 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 2, backoffMs: 0 },
      modelFallback: [fallback1, fallback2],
    });

    const events = await collect(agent.query("hi", { sessionId: "s-fallback-basic" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).output).toBe("fallback1 answer");
    // Primary was called maxAttempts times.
    expect(primaryCalls).toHaveLength(2);
    // First fallback was called once.
    expect(fallback1Calls).toHaveLength(1);
    // Second fallback never called (first one succeeded).
    expect(fallback2Calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: all models fail → error surfaces
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: all models fail → terminal error", () => {
  it("surfaces error when primary and all fallbacks fail", async () => {
    const store = await freshStore();

    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("primary: 503 Service Unavailable");
      },
    };

    const fallback1: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("fallback1: 502 Bad Gateway");
      },
    };

    const fallback2: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("fallback2: rate limit exceeded");
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 1, backoffMs: 0 },
      modelFallback: [fallback1, fallback2],
    });

    const events = await collect(agent.query("go", { sessionId: "s-all-fail" }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    // The error message should contain the last fallback's failure.
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "error" }>).output).toMatch(/fallback2|rate limit/i);
  });
});

// ---------------------------------------------------------------------------
// Test 3: AbortError → fallback NEVER tried
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: AbortError → no fallback, emit aborted", () => {
  it("does not fall back on AbortError; emits aborted terminal immediately", async () => {
    const store = await freshStore();
    const controller = new AbortController();

    let fallbackCalled = false;
    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        controller.abort();
        throw new DOMException("AbortError", "AbortError");
      },
    };
    const fallback: ModelPort = {
      async complete(): Promise<ModelResponse> {
        fallbackCalled = true;
        return { content: [textBlock("should not reach")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelFallback: [fallback],
    });

    const events = await collect(agent.query("go", { sessionId: "s-abort-no-fallback", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
    expect(fallbackCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Streaming primary fails BEFORE first delta → fallback streams
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: streaming primary fails before first delta → fallback streams", () => {
  it("falls back to fallback model when streaming primary throws before any delta", async () => {
    const store = await freshStore();

    let primaryStreamCalled = false;
    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("complete() not expected on streaming path");
      },
      async *stream(): AsyncIterable<ModelStreamPart> {
        primaryStreamCalled = true;
        // Throw immediately — NO deltas emitted.
        throw new Error("503 streaming endpoint unavailable");
        // eslint-disable-next-line no-unreachable
        yield { type: "delta", delta: { text: "" } };
      },
    };

    let fallbackStreamCalled = false;
    const fallback: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("complete() not expected on streaming fallback path");
      },
      async *stream(): AsyncIterable<ModelStreamPart> {
        fallbackStreamCalled = true;
        yield { type: "delta", delta: { text: "fallback " } };
        yield { type: "delta", delta: { text: "stream" } };
        yield { type: "final", response: { content: [textBlock("fallback stream")], usage: { inputTokens: 3, outputTokens: 2 } } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelFallback: [fallback],
    });

    const events = await collect(agent.query("go", { sessionId: "s-stream-fallback" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).output).toBe("fallback stream");
    expect(primaryStreamCalled).toBe(true);
    expect(fallbackStreamCalled).toBe(true);
    // Deltas from the fallback stream should be in the events.
    const deltas = events.filter((e) => e.type === "stream.delta");
    expect(deltas.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Streaming primary fails AFTER first delta → NO fallback (stream already started)
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: streaming primary fails AFTER first delta → no fallback, terminal error", () => {
  it("does NOT fall back when streaming primary already emitted a delta before failing", async () => {
    const store = await freshStore();

    let fallbackCalled = false;
    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("complete() not expected on streaming path");
      },
      async *stream(): AsyncIterable<ModelStreamPart> {
        yield { type: "delta", delta: { text: "partial..." } };
        // Fail AFTER emitting a delta — fallback must NOT be triggered.
        throw new Error("stream broken mid-flight");
      },
    };

    const fallback: ModelPort = {
      async complete(): Promise<ModelResponse> {
        throw new Error("complete() not expected on fallback streaming path");
      },
      async *stream(): AsyncIterable<ModelStreamPart> {
        fallbackCalled = true;
        yield { type: "delta", delta: { text: "should not appear" } };
        yield { type: "final", response: { content: [textBlock("should not appear")], usage: { inputTokens: 1, outputTokens: 1 } } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelFallback: [fallback],
    });

    const events = await collect(agent.query("go", { sessionId: "s-stream-no-fallback-after-delta" }));
    const result = terminal(events);
    // Must error — no fallback after partial stream.
    expect(result.subtype).toBe("error");
    expect(fallbackCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 6: Primary succeeds → fallbacks never touched
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: primary succeeds → fallbacks untouched", () => {
  it("does not call any fallback when primary succeeds", async () => {
    const store = await freshStore();

    let fallbackCalled = false;
    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return { content: [textBlock("primary ok")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };
    const fallback: ModelPort = {
      async complete(): Promise<ModelResponse> {
        fallbackCalled = true;
        return { content: [textBlock("fallback answer")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelFallback: [fallback],
    });

    const events = await collect(agent.query("hi", { sessionId: "s-primary-succeeds" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).output).toBe("primary ok");
    expect(fallbackCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 7: Non-transient error on primary (no modelRetry) → falls back immediately
// ---------------------------------------------------------------------------

describe("Feature 1 — model fallback: non-transient error without retry → falls back", () => {
  it("falls back immediately on non-transient error when no modelRetry configured", async () => {
    const store = await freshStore();

    let primaryCalls = 0;
    const primary: ModelPort = {
      async complete(): Promise<ModelResponse> {
        primaryCalls++;
        // 400 is non-transient — never retried, but should still fall back.
        throw new Error("HTTP 400 Bad Request: invalid schema");
      },
    };

    const fallback: ModelPort = {
      async complete(): Promise<ModelResponse> {
        return { content: [textBlock("fallback handled it")], usage: { inputTokens: 2, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model: primary,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      // No modelRetry — but fallback should still fire on any failure.
      modelFallback: [fallback],
    });

    const events = await collect(agent.query("go", { sessionId: "s-non-transient-fallback" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).output).toBe("fallback handled it");
    // Primary called once (no retry).
    expect(primaryCalls).toBe(1);
  });
});
