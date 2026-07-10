// @vitest-environment jsdom

/**
 * Tests for DX features:
 *  (a) useAsyncRun<TOutput> — generic typed output
 *  (b) useEidenticStream retryOnError — auto-retry on network failure, then succeed
 *  (c) retryOnError does NOT retry when terminal result.subtype=error arrives
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useAsyncRun } from "../src/useAsyncRun.js";
import { useEidenticStream } from "../src/useEidenticStream.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSSE(events: Array<[string, Record<string, unknown>]>): string {
  return events
    .map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
}

function makeStreamBody(sse: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// (a) useAsyncRun<TOutput> — generic typed output
// ---------------------------------------------------------------------------

describe("useAsyncRun<TOutput> — generic typed output", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("output field carries the typed value from a completed run", async () => {
    interface RunOutput {
      answer: string;
      confidence: number;
    }

    const mockFetch = vi.fn(async (_url: string, opts?: RequestInit) => {
      if ((opts?.method ?? "GET") === "POST") {
        return {
          ok: true,
          json: async () => ({ runId: "typed-run-1", sessionId: "s", status: "running" }),
        } as Response;
      }
      // Status poll — returns a completed run with typed output.
      return {
        ok: true,
        json: async () => ({
          runId: "typed-run-1",
          sessionId: "s",
          status: "completed",
          output: { answer: "42", confidence: 0.99 },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useAsyncRun<RunOutput>("my-agent", {
        baseUrl: "http://localhost",
        pollIntervalMs: 50,
      }),
    );

    await act(async () => {
      result.current.start({ input: "What is the answer?" }).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 200));
    });

    await waitFor(() => {
      expect(result.current.status).toBe("completed");
    });

    // output is typed — TypeScript would prevent .nonexistent access at compile time
    expect(result.current.output).not.toBeNull();
    expect(result.current.output?.answer).toBe("42");
    expect(result.current.output?.confidence).toBe(0.99);
  });

  it("output is null before any run completes", () => {
    vi.stubGlobal("fetch", vi.fn());

    const { result } = renderHook(() =>
      useAsyncRun<{ value: string }>("my-agent"),
    );

    expect(result.current.output).toBeNull();
    expect(result.current.status).toBe("idle");
  });
});

// ---------------------------------------------------------------------------
// (b) useEidenticStream retryOnError — retries on transient network failure
// ---------------------------------------------------------------------------

describe("useEidenticStream retryOnError — transient failure then success", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not replay a failed POST without an explicit unsafe opt-in", async () => {
    let fetchCallCount = 0;

    const successSSE = buildSSE([
      ["stream.delta", { delta: { text: "Hello from retry" } }],
      ["result", { subtype: "success", usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1, sessionId: "s" }],
    ]);

    const mockFetch = vi.fn(async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        // First attempt: network-level failure (no result yet).
        throw Object.assign(new Error("Network error"), { name: "NetworkError" });
      }
      // Second attempt: success.
      return {
        ok: true,
        body: makeStreamBody(successSSE),
      } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query", {
        retryOnError: { attempts: 1, backoffMs: 10 },
      }),
    );

    await act(async () => {
      result.current.send("hello");
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(fetchCallCount).toBe(1);
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error?.message).toContain("Network error");
  });

  it("surfaces error status after exhausting all retries", async () => {
    let fetchCallCount = 0;

    const mockFetch = vi.fn(async () => {
      fetchCallCount++;
      throw Object.assign(new Error("Persistent network error"), { name: "FetchError" });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query", {
        retryOnError: { attempts: 2, backoffMs: 10 },
        allowUnsafePostRetry: true,
      }),
    );

    await act(async () => {
      result.current.send("hello");
      await new Promise((r) => setTimeout(r, 300));
    });

    // 1 original + 2 retries = 3 total calls.
    expect(fetchCallCount).toBe(3);
    await waitFor(() => {
      expect(result.current.status).toBe("error");
    });
    expect(result.current.error?.message).toContain("Persistent network error");
  });

  it("never retries after the stream has emitted an event", async () => {
    let fetchCallCount = 0;
    const encoder = new TextEncoder();
    const partial = buildSSE([["stream.delta", { delta: { text: "already executed" } }]]);
    const mockFetch = vi.fn(async () => {
      fetchCallCount++;
      return {
        ok: true,
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!(controller as unknown as { emitted?: boolean }).emitted) {
              (controller as unknown as { emitted?: boolean }).emitted = true;
              controller.enqueue(encoder.encode(partial));
            } else {
              controller.error(new Error("connection reset mid-stream"));
            }
          },
        }),
      } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query", {
        retryOnError: { attempts: 3, backoffMs: 1 },
        allowUnsafePostRetry: true,
      }),
    );
    await act(async () => {
      result.current.send("side effecting request");
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(fetchCallCount).toBe(1);
    expect(result.current.status).toBe("error");
    expect(result.current.messages[0]?.content).toBe("already executed");
  });
});

describe("useEidenticStream resume DTO", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("normalizes approve/reject shortcuts to the server SuspendDecision shape", async () => {
    const suspended = buildSSE([["result", {
      subtype: "suspended",
      request: { reason: "approve?" },
      callId: "call-1",
      usage: { inputTokens: 1, outputTokens: 1 },
      numTurns: 1,
      sessionId: "resume-session",
    }]]);
    const resumed = buildSSE([["result", {
      subtype: "success",
      usage: { inputTokens: 2, outputTokens: 2 },
      numTurns: 2,
      sessionId: "resume-session",
    }]]);
    const mockFetch = vi.fn(async () => ({
      ok: true,
      body: makeStreamBody(mockFetch.mock.calls.length === 1 ? suspended : resumed),
    }) as Response);
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query", { sessionId: "resume-session" }),
    );
    await act(async () => {
      result.current.send("run");
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(result.current.status).toBe("suspended");

    await act(async () => {
      result.current.resume("approve");
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    const resumeBody = JSON.parse(mockFetch.mock.calls[1]?.[1]?.body as string);
    expect(resumeBody).toMatchObject({
      sessionId: "resume-session",
      decision: { approved: true },
    });
  });

  it("treats a malformed resume stream without a terminal result as an error", async () => {
    const suspended = buildSSE([["result", {
      subtype: "suspended",
      request: { reason: "approve?" },
      callId: "call-broken",
      usage: { inputTokens: 1, outputTokens: 1 },
      numTurns: 1,
      sessionId: "broken-resume",
    }]]);
    const mockFetch = vi.fn(async () => ({
      ok: true,
      body: makeStreamBody(mockFetch.mock.calls.length === 1 ? suspended : "not-json\n"),
    }) as Response);
    vi.stubGlobal("fetch", mockFetch);
    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query", { sessionId: "broken-resume" }),
    );

    await act(async () => {
      result.current.send("run");
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(result.current.status).toBe("suspended");
    await act(async () => {
      result.current.resume(true);
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toMatch(/malformed|terminal result|resume stream/i);
  });
});

describe("useEidenticStream regenerate safety", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not replay the last input into the same append-only session", async () => {
    const terminal = buildSSE([
      ["stream.delta", { delta: { text: "original" } }],
      ["result", {
        subtype: "success",
        usage: { inputTokens: 1, outputTokens: 1 },
        numTurns: 1,
        sessionId: "append-only-session",
      }],
    ]);
    const mockFetch = vi.fn(async () => ({
      ok: true,
      body: makeStreamBody(terminal),
    }) as Response);
    const onError = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() => useEidenticStream("/query", {
      sessionId: "append-only-session",
      onError,
    }));
    await act(async () => {
      result.current.send("side effecting input");
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(result.current.status).toBe("done");

    act(() => result.current.regenerate());

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("error");
    expect(result.current.error?.message).toMatch(/append-only|new session|fork/i);
    expect(result.current.messages[0]?.content).toBe("original");
    expect(onError).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// (c) retryOnError does NOT retry terminal result.subtype=error events
// ---------------------------------------------------------------------------

describe("useEidenticStream retryOnError — terminal result.subtype=error is NOT retried", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not retry when the stream terminates with result.subtype=error (real agent error)", async () => {
    let fetchCallCount = 0;

    // The server returns a valid SSE stream that ends with a result.subtype=error.
    // This is a real agent-level error result, not a network failure — must not be retried.
    const agentErrorSSE = buildSSE([
      ["result", { subtype: "error", usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1, sessionId: "s" }],
    ]);

    const mockFetch = vi.fn(async () => {
      fetchCallCount++;
      return {
        ok: true,
        body: makeStreamBody(agentErrorSSE),
      } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query", {
        retryOnError: { attempts: 3, backoffMs: 10 },
        allowUnsafePostRetry: true,
      }),
    );

    await act(async () => {
      result.current.send("hello");
      await new Promise((r) => setTimeout(r, 200));
    });

    // Fetch called exactly once — no retries for a terminal result event.
    expect(fetchCallCount).toBe(1);
    // Status is "done" (stream completed normally — the result.subtype=error is the agent's answer).
    await waitFor(() => {
      expect(result.current.status).toBe("done");
    });
  });
});
