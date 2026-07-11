// @vitest-environment jsdom

/**
 * Hook-level tests using @testing-library/react + jsdom.
 *
 * Covers:
 *  (a) unmount during in-flight stream → fetch aborted, no setState-after-unmount warnings
 *  (b) useWorkflowList polling tick race — first tick aborted before second resolves
 *  (c) sessionId is non-empty on FIRST render (no effect flush needed)
 *  (d) useAsyncRun unmount right after mount → initial POST aborted
 *      useAsyncRun maxPollMs exceeded → error/timeout state
 *  (e) StrictMode sanity — no duplicate sends on a single user-initiated send()
 */

import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useEidenticStream } from "../src/useEidenticStream.js";
import { useWorkflowList } from "../src/useWorkflow.js";
import { useAsyncRun } from "../src/useAsyncRun.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal SSE body string from [eventType, payload] pairs. */
function buildSSE(events: Array<[string, Record<string, unknown>]>): string {
  return events
    .map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
}

/** Create a ReadableStream from an SSE body string. */
function makeStreamBody(sse: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
}

/**
 * Create a "hanging" ReadableStream that never resolves (simulates a slow stream).
 * Returns { stream, abort } where abort() closes the stream prematurely.
 */
function makeHangingStream(): { stream: ReadableStream<Uint8Array>; abort: () => void } {
  let _controller: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      _controller = controller;
    },
  });
  return {
    stream,
    abort: () => _controller.close(),
  };
}

// ---------------------------------------------------------------------------
// (c) sessionId is non-empty on FIRST render
// ---------------------------------------------------------------------------

describe("sessionId is non-empty on first render", () => {
  it("generates a non-empty sessionId immediately (no effect flush required)", () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query"),
    );

    // session id is baked into the send closure — trigger a send and inspect the fetch call
    // But we can also check by inspecting the hook's send closure captures effectiveSessionId.
    // The simplest check: call send() synchronously after mount and confirm the POST body
    // has a non-empty sessionId.
    act(() => {
      result.current.send("hello");
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, fetchOpts] = mockFetch.mock.calls[0]!;
    const body = JSON.parse((fetchOpts as RequestInit).body as string) as Record<string, unknown>;
    expect(typeof body.sessionId).toBe("string");
    expect((body.sessionId as string).length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });
});

describe("browser identity fields", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("strips caller-controlled identity fields from query bodies by default", () => {
    const mockFetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", mockFetch);
    const { result } = renderHook(() => useEidenticStream("/query", { userId: "option-user" }));

    act(() => result.current.send("hello", {
      body: { userId: "body-user", orgId: "body-org", apiKey: "body-key" },
    }));
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body).not.toHaveProperty("userId");
    expect(body).not.toHaveProperty("orgId");
    expect(body).not.toHaveProperty("apiKey");
  });

  it("keeps legacy userId forwarding behind an explicit unsafe opt-in", () => {
    const mockFetch = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", mockFetch);
    const { result } = renderHook(() => useEidenticStream("/query", {
      userId: "legacy-user",
      allowUntrustedIdentityBody: true,
    }));

    act(() => result.current.send("hello"));
    const body = JSON.parse(mockFetch.mock.calls[0]?.[1]?.body as string);
    expect(body.userId).toBe("legacy-user");
  });
});

// ---------------------------------------------------------------------------
// (a) unmount during in-flight stream → fetch aborted, no setState-after-unmount
// ---------------------------------------------------------------------------

describe("unmount during in-flight stream", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts the fetch signal when the component unmounts mid-stream", async () => {
    let capturedSignal: AbortSignal | undefined;

    // A fetch that hangs until aborted.
    const mockFetch = vi.fn((_url: string, opts?: RequestInit) => {
      capturedSignal = opts?.signal;
      return new Promise<Response>((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result, unmount } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query"),
    );

    act(() => {
      result.current.send("hello");
    });

    // Fetch was called and stream is in-flight.
    expect(mockFetch).toHaveBeenCalledOnce();
    expect(capturedSignal?.aborted).toBe(false);

    // Unmount — should abort the signal.
    unmount();

    expect(capturedSignal?.aborted).toBe(true);
  });

  it("does not fire setState after unmount (no act() warnings)", async () => {
    const consoleError = vi.spyOn(console, "error");

    // Fetch that resolves after unmount.
    let resolveStream!: () => void;
    const streamReady = new Promise<void>((r) => { resolveStream = r; });

    const mockFetch = vi.fn(async (_url: string, opts?: RequestInit) => {
      // Wait until test signals us.
      await streamReady;
      if (opts?.signal?.aborted) {
        throw Object.assign(new Error("AbortError"), { name: "AbortError" });
      }
      const sse = buildSSE([
        ["stream.delta", { delta: { text: "hi" } }],
        ["result", { subtype: "success", usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1, sessionId: "s" }],
      ]);
      return {
        ok: true,
        body: makeStreamBody(sse),
      } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result, unmount } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query"),
    );

    act(() => {
      result.current.send("test");
    });

    // Unmount before fetch resolves.
    unmount();

    // Now let the fetch complete — should NOT call setState on unmounted component.
    await act(async () => {
      resolveStream();
      await new Promise((r) => setTimeout(r, 50));
    });

    // No React "Can't perform a state update on an unmounted component" errors.
    const reactUnmountErrors = consoleError.mock.calls.filter((args) =>
      args.some((a) => typeof a === "string" && a.includes("unmounted")),
    );
    expect(reactUnmountErrors).toHaveLength(0);

    consoleError.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (b) useWorkflowList polling tick race
// ---------------------------------------------------------------------------

describe("useWorkflowList polling tick race", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts first tick's fetch before starting second tick's fetch", async () => {
    const abortedSignals: boolean[] = [];
    let resolveFirst!: (v: Response) => void;
    const firstFetchPending = new Promise<Response>((r) => { resolveFirst = r; });
    let fetchCallCount = 0;

    const mockFetch = vi.fn(((_url: string, opts?: RequestInit) => {
      fetchCallCount++;
      const signal = opts?.signal;
      if (fetchCallCount === 1) {
        // Initial mount fetch — hangs until resolved externally.
        return new Promise<Response>((resolve, reject) => {
          firstFetchPending.then(resolve);
          signal?.addEventListener("abort", () => {
            abortedSignals.push(true);
            reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
          }, { once: true });
        });
      }
      // Second+ fetches (poll tick) — resolve immediately with empty list.
      return Promise.resolve({
        ok: true,
        json: async () => [],
      } as Response);
    }) as typeof fetch);
    vi.stubGlobal("fetch", mockFetch);

    renderHook(() => useWorkflowList({ pollIntervalMs: 100 }));

    // First fetch is in-flight. Advance time to trigger a poll tick.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(110);
    });

    // The poll tick should have aborted the first fetch.
    expect(abortedSignals).toContain(true);
    // Second fetch was called.
    expect(fetchCallCount).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// (d) useAsyncRun unmount right after mount → initial POST aborted
// ---------------------------------------------------------------------------

describe("useAsyncRun unmount aborts initial POST", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts the initial POST when component unmounts before fetch resolves", async () => {
    let capturedSignal: AbortSignal | undefined;

    const mockFetch = vi.fn((_url: string, opts?: RequestInit) => {
      capturedSignal = opts?.signal;
      return new Promise<Response>((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result, unmount } = renderHook(() =>
      useAsyncRun("my-agent", { baseUrl: "http://localhost" }),
    );

    // Start a run — this issues a POST.
    let startPromise!: Promise<{ runId: string }>;
    act(() => {
      startPromise = result.current.start({ input: "test" });
    });

    expect(capturedSignal?.aborted).toBe(false);

    // Unmount before the POST resolves.
    unmount();

    expect(capturedSignal?.aborted).toBe(true);

    // Suppress the unhandled rejection from start() being aborted.
    await startPromise.catch(() => undefined);
  });
});

// ---------------------------------------------------------------------------
// (d) useAsyncRun maxPollMs timeout
// ---------------------------------------------------------------------------

describe("useAsyncRun maxPollMs timeout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("transitions to failed/error state when maxPollMs is exceeded", async () => {
    // Use real timers but a very short maxPollMs so the test completes quickly.
    // POST to create run succeeds immediately.
    // Status poll hangs (never returns terminal status).
    const mockFetch = vi.fn(async (_url: string, opts?: RequestInit) => {
      if ((opts?.method ?? "GET") === "POST") {
        return {
          ok: true,
          json: async () => ({ runId: "run-timeout", sessionId: "s", status: "running" }),
        } as Response;
      }
      // Status poll — hangs until aborted.
      return new Promise<Response>((_, reject) => {
        opts?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("AbortError"), { name: "AbortError" }));
        }, { once: true });
      });
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(() =>
      useAsyncRun("my-agent", {
        baseUrl: "http://localhost",
        pollIntervalMs: 200,
        maxPollMs: 100, // very short — expires before first poll resolves
      }),
    );

    // Start the run — fire-and-forget (the POST itself succeeds synchronously via mock).
    await act(async () => {
      result.current.start({ input: "test" }).catch(() => undefined);
      // Let the POST resolve and polling begin.
      await new Promise((r) => setTimeout(r, 50));
    });

    // Wait for maxPollMs to expire and state to update.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 200));
    });

    expect(result.current.status).toBe("failed");
    expect(result.current.error).toBe("Run timed out");
    expect(result.current.isPolling).toBe(false);
  }, 10_000); // generous test timeout
});

// ---------------------------------------------------------------------------
// (e) StrictMode — no duplicate sends on single user-initiated send()
// ---------------------------------------------------------------------------

describe("StrictMode: no duplicate sends", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("sends exactly one POST request per user-initiated send() in StrictMode", async () => {
    let fetchCallCount = 0;

    const sse = buildSSE([
      ["stream.delta", { delta: { text: "hi" } }],
      ["result", { subtype: "success", usage: { inputTokens: 1, outputTokens: 1 }, numTurns: 1, sessionId: "s" }],
    ]);

    const mockFetch = vi.fn(async () => {
      fetchCallCount++;
      return {
        ok: true,
        body: makeStreamBody(sse),
      } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);

    const { result } = renderHook(
      () => useEidenticStream("http://localhost/v1/agents/test/query"),
      { wrapper: ({ children }) => <React.StrictMode>{children}</React.StrictMode> },
    );

    await act(async () => {
      result.current.send("hello");
    });

    // The hook guard (statusRef === "streaming") prevents a second concurrent send.
    // Even in StrictMode where effects re-run, a single send() call should issue exactly one POST.
    expect(fetchCallCount).toBe(1);
  });

  it("coalesces two send() calls made in the same tick", async () => {
    let release!: () => void;
    const responseReady = new Promise<void>((resolve) => { release = resolve; });
    const sse = buildSSE([["result", {
      subtype: "success",
      usage: { inputTokens: 1, outputTokens: 1 },
      numTurns: 1,
      sessionId: "same-tick",
    }]]);
    const mockFetch = vi.fn(async () => {
      await responseReady;
      return { ok: true, body: makeStreamBody(sse) } as Response;
    });
    vi.stubGlobal("fetch", mockFetch);
    const { result } = renderHook(() =>
      useEidenticStream("http://localhost/v1/agents/test/query"),
    );

    act(() => {
      result.current.send("first");
      result.current.send("second");
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release();
    await waitFor(() => expect(result.current.status).toBe("done"));
  });
});
