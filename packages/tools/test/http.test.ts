import { describe, it, expect } from "vitest";
import { resilientFetch, fetchJson } from "../src/http.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A fake fetch that resolves immediately with the given status/body. */
function okFetch(body: string, status = 200): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

/** A fake fetch that returns a specific Response the first N calls, then another. */
function sequenceFetch(responses: Array<{ status: number; body?: string }>): { fake: typeof fetch; callCount: number } {
  let callCount = 0;
  const fake = (async (_url: unknown, init?: RequestInit) => {
    // Reject on abort (simulates real fetch behaviour).
    if (init?.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    const i = Math.min(callCount, responses.length - 1);
    callCount++;
    const r = responses[i]!;
    return new Response(r.body ?? "", { status: r.status });
  }) as unknown as typeof fetch;
  return { fake, callCount: 0 };
}

// ---------------------------------------------------------------------------
// timeout
// ---------------------------------------------------------------------------

describe("resilientFetch — timeout", () => {
  it("rejects with a timeout error when fetch never resolves", async () => {
    // A fetch that only resolves when its signal is aborted (simulates a hanging server).
    const hangingFetch: typeof fetch = ((
      _url: unknown,
      init?: RequestInit,
    ) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted) {
          reject(new DOMException("The operation was aborted.", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted.", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    await expect(
      resilientFetch("https://example.com/hang", undefined, {
        fetchImpl: hangingFetch,
        timeoutMs: 30,
        retries: 0,
      }),
    ).rejects.toThrow(/timed out/i);
  }, 2_000);
});

// ---------------------------------------------------------------------------
// retry on 5xx
// ---------------------------------------------------------------------------

describe("resilientFetch — retry on 5xx", () => {
  it("retries on first 503, returns 200 on second call", async () => {
    let callCount = 0;
    const fake: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      callCount++;
      return new Response("body", { status: callCount === 1 ? 503 : 200 });
    }) as unknown as typeof fetch;

    const res = await resilientFetch("https://example.com/retry", undefined, {
      fetchImpl: fake,
      retries: 1,
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(200);
    expect(callCount).toBe(2);
  });

  it("returns the last 5xx response when retries are exhausted", async () => {
    let callCount = 0;
    const fake: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      callCount++;
      return new Response("error", { status: 503 });
    }) as unknown as typeof fetch;

    const res = await resilientFetch("https://example.com/always503", undefined, {
      fetchImpl: fake,
      retries: 1,
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(503);
    expect(callCount).toBe(2); // 1 attempt + 1 retry
  });
});

// ---------------------------------------------------------------------------
// no retry on 4xx
// ---------------------------------------------------------------------------

describe("resilientFetch — no retry on 4xx", () => {
  it("returns 404 as-is without retrying", async () => {
    let callCount = 0;
    const fake: typeof fetch = (async (_url: unknown, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      callCount++;
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const res = await resilientFetch("https://example.com/missing", undefined, {
      fetchImpl: fake,
      retries: 2,
      timeoutMs: 5_000,
    });
    expect(res.status).toBe(404);
    expect(callCount).toBe(1); // exactly one call
  });
});

// ---------------------------------------------------------------------------
// external abort
// ---------------------------------------------------------------------------

describe("resilientFetch — external abort", () => {
  it("rejects immediately with AbortError when signal is pre-aborted", async () => {
    let called = false;
    const fake: typeof fetch = (async () => {
      called = true;
      return new Response("should not reach", { status: 200 });
    }) as unknown as typeof fetch;

    const ctrl = new AbortController();
    ctrl.abort();

    await expect(
      resilientFetch("https://example.com/abort", undefined, {
        fetchImpl: fake,
        signal: ctrl.signal,
        retries: 2,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });

    expect(called).toBe(false);
  });

  it("aborts an in-flight request when external signal fires", async () => {
    const ctrl = new AbortController();
    let innerSignal: AbortSignal | undefined;

    const fake: typeof fetch = ((_url: unknown, init?: RequestInit) => {
      innerSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    }) as unknown as typeof fetch;

    const fetchPromise = resilientFetch("https://example.com/slow", undefined, {
      fetchImpl: fake,
      signal: ctrl.signal,
      timeoutMs: 30_000, // long timeout — won't fire
      retries: 0,
    });

    // Allow the fake fetch to start.
    await Promise.resolve();
    ctrl.abort();

    await expect(fetchPromise).rejects.toMatchObject({ name: "AbortError" });
    expect(innerSignal?.aborted).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fetchJson
// ---------------------------------------------------------------------------

describe("fetchJson", () => {
  it("throws on non-2xx (500 after retries exhausted)", async () => {
    const fake = okFetch("error", 500);
    await expect(
      fetchJson("https://example.com/fail", undefined, {
        fetchImpl: fake,
        retries: 0,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("returns parsed JSON on 200", async () => {
    const payload = { ok: true, count: 42 };
    const fake: typeof fetch = (async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const result = await fetchJson<typeof payload>("https://example.com/json", undefined, {
      fetchImpl: fake,
    });
    expect(result).toEqual(payload);
  });

  it("rejects JSON bodies above the configured response cap", async () => {
    const fake: typeof fetch = (async () =>
      new Response(JSON.stringify({ value: "x".repeat(4096) }), { status: 200 })) as typeof fetch;

    await expect(fetchJson("https://example.com/large", undefined, {
      fetchImpl: fake,
      maxResponseBytes: 512,
    })).rejects.toThrow(/response body.*512|exceeds.*512/i);
  });
});

describe("resilientFetch — retry cleanup", () => {
  it("cancels a 5xx response body before retrying", async () => {
    let calls = 0;
    let cancellations = 0;
    const fake: typeof fetch = (async () => {
      calls++;
      if (calls === 1) {
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("retry body"));
          },
          cancel() {
            cancellations++;
          },
        });
        return new Response(body, { status: 503 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const response = await resilientFetch("https://example.com/retry", undefined, {
      fetchImpl: fake,
      retries: 1,
    });

    expect(response.status).toBe(200);
    expect(cancellations).toBe(1);
  });

  it("does not let a stalled body cancel block the retry", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      if (calls === 1) {
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) { controller.enqueue(new TextEncoder().encode("error")); },
          cancel: () => new Promise<void>(() => { /* stalled transport cleanup */ }),
        }), { status: 503 });
      }
      return new Response("ok", { status: 200 });
    }) as typeof fetch;

    const response = await resilientFetch("https://example.com/retry", undefined, {
      fetchImpl: fake,
      retries: 1,
    });
    expect(response.status).toBe(200);
  }, 250);
});

describe("resilientFetch — error redaction", () => {
  it("does not echo credential-bearing fetch error messages", async () => {
    const fake = (async () => {
      throw new Error("connect failed for https://example.com/path?token=super-secret");
    }) as typeof fetch;
    let thrown: unknown;
    try {
      await resilientFetch("https://example.com/path?token=super-secret", undefined, {
        fetchImpl: fake,
        retries: 0,
      });
    } catch (error) {
      thrown = error;
    }
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    expect(message).not.toContain("super-secret");
    expect(message).toContain("https://example.com/path");
  });
});
