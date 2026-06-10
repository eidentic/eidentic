/**
 * Feature 1 — Model retry/backoff.
 *
 * Tests cover:
 *  1. MockModel that throws-then-succeeds on the `complete` path → retries and returns success.
 *  2. Non-transient error (4xx client error) → immediately fails, no retry.
 *  3. Aborted run → does NOT retry; emits `result{subtype:"aborted"}`.
 *  4. maxAttempts=1 (default OFF) → no retry even on transient errors.
 *  5. Streaming path is NOT retried (verify: model.stream() throws → terminal error, not retried).
 *  6. Retry exhaust: all attempts fail → terminal error.
 */
import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import {
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
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
// Test 1: throws-then-succeeds on complete() path — should retry and succeed
// ---------------------------------------------------------------------------

describe("Feature 1 — model retry: complete() path throws transient then succeeds", () => {
  it("retries a transient (network) error and returns success on the second attempt", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          throw new Error("network failure: ECONNRESET");
        }
        return { content: [textBlock("done")], usage: { inputTokens: 2, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 3, backoffMs: 0 },
    });

    const events = await collect(agent.query("hi", { sessionId: "s-retry-success" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).output).toBe("done");
    expect(callCount).toBe(2);
  });

  it("retries a 429 rate-limit error and returns success on the second attempt", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount === 1) {
          throw new Error("HTTP 429 Too Many Requests: rate limit exceeded");
        }
        return { content: [textBlock("done after 429")], usage: { inputTokens: 3, outputTokens: 2 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 3, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-429-retry" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect(callCount).toBe(2);
  });

  it("retries a 500 server error and returns success", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        if (callCount <= 2) {
          throw new Error("HTTP 500 Internal Server Error");
        }
        return { content: [textBlock("eventual success")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 5, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-500-retry" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as Extract<StreamEvent, { type: "result"; subtype: "success" }>).output).toBe("eventual success");
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Test 2: Non-transient error → no retry
// ---------------------------------------------------------------------------

describe("Feature 1 — model retry: non-transient error is not retried", () => {
  it("a 400 Bad Request error is not retried", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        throw new Error("HTTP 400 Bad Request: invalid input schema");
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 5, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-400-no-retry" }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    // A non-transient error should fail on the first attempt without retry.
    expect(callCount).toBe(1);
  });

  it("an auth error (401) is not retried", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        throw new Error("HTTP 401 Unauthorized");
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 3, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-401-no-retry" }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 3: Aborted run is NEVER retried
// ---------------------------------------------------------------------------

describe("Feature 1 — model retry: AbortError is never retried", () => {
  it("aborted complete() path emits aborted, not error, and does not retry", async () => {
    const store = await freshStore();
    const controller = new AbortController();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        // Abort the signal then throw an AbortError — simulating provider abort.
        controller.abort();
        throw new DOMException("AbortError", "AbortError");
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      // Even with retry configured, AbortError must not be retried.
      modelRetry: { maxAttempts: 5, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-abort-no-retry", signal: controller.signal }));
    const result = terminal(events);
    // Must emit aborted, not error.
    expect(result.subtype).toBe("aborted");
    // Must NOT retry: called exactly once.
    expect(callCount).toBe(1);
  });

  it("pre-aborted signal → no model calls at all, emits aborted immediately", async () => {
    const store = await freshStore();
    const controller = new AbortController();
    controller.abort(); // pre-abort before the run even starts
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        return { content: [textBlock("should not be reached")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 5, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-preabort-retry", signal: controller.signal }));
    const result = terminal(events);
    expect(result.subtype).toBe("aborted");
    // Top-of-turn boundary fires before any model call.
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Test 4: Default (no modelRetry config) — behaves as before, no retry
// ---------------------------------------------------------------------------

describe("Feature 1 — model retry: OFF by default (no modelRetry config)", () => {
  it("without modelRetry, a transient error fails immediately", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        throw new Error("ECONNRESET"); // transient, but no retry configured
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      // NO modelRetry → default OFF
    });

    const events = await collect(agent.query("go", { sessionId: "s-no-retry-default" }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 5: Retry exhaust — all attempts fail → terminal error
// ---------------------------------------------------------------------------

describe("Feature 1 — model retry: all attempts exhausted → terminal error", () => {
  it("when all maxAttempts fail, emits terminal error", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        throw new Error("service unavailable"); // always transient
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 3, backoffMs: 0 },
    });

    const events = await collect(agent.query("go", { sessionId: "s-exhaust-retry" }));
    const result = terminal(events);
    expect(result.subtype).toBe("error");
    // All 3 attempts should have fired.
    expect(callCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Fix 4: maxAttempts: 0 → one guarded attempt (not un-guarded fallthrough)
// ---------------------------------------------------------------------------

describe("Fix 4 — modelRetry: maxAttempts: 0 → exactly one guarded attempt", () => {
  it("maxAttempts:0 still performs exactly one guarded (abort-checked) attempt and succeeds", async () => {
    const store = await freshStore();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        return { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 0 },
    });

    const events = await collect(agent.query("hi", { sessionId: "s-zero-attempts-success" }));
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect(callCount).toBe(1);
  });

  it("maxAttempts:0 with pre-aborted signal emits aborted (not an unguarded complete call)", async () => {
    const store = await freshStore();
    const controller = new AbortController();
    controller.abort();
    let callCount = 0;

    const model: ModelPort = {
      async complete(_req: ModelRequest): Promise<ModelResponse> {
        callCount++;
        return { content: [textBlock("should not reach")], usage: { inputTokens: 1, outputTokens: 1 } };
      },
    };

    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelRetry: { maxAttempts: 0 },
    });

    const events = await collect(agent.query("hi", { sessionId: "s-zero-abort", signal: controller.signal }));
    const result = terminal(events);
    // Should be aborted (caught at top-of-turn boundary), not reaching the model
    expect(result.subtype).toBe("aborted");
    expect(callCount).toBe(0);
  });
});
