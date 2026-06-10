import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { langfuseTracer, type LangfuseTracerOptions } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFakeFetch(responses: { status: number }[] = []) {
  const captured: CapturedRequest[] = [];
  let callIndex = 0;

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
    }
    const bodyText = init?.body as string;
    const body: unknown = bodyText ? JSON.parse(bodyText) : undefined;

    captured.push({ url, method: init?.method ?? "GET", headers, body });

    const status = responses[callIndex]?.status ?? 200;
    callIndex++;
    return new Response("{}", { status });
  };

  return { fetchImpl, captured };
}

function baseOpts(override: Partial<LangfuseTracerOptions> = {}): LangfuseTracerOptions {
  return {
    publicKey: "pk-lf-test",
    secretKey: "sk-lf-test",
    ...override,
  };
}

// ---------------------------------------------------------------------------
// Basic construction + auth
// ---------------------------------------------------------------------------

describe("langfuseTracer — construction", () => {
  it("returns an object with startSpan, flush, shutdown", () => {
    const { fetchImpl } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    expect(typeof t.startSpan).toBe("function");
    expect(typeof t.flush).toBe("function");
    expect(typeof t.shutdown).toBe("function");
    void t.shutdown();
  });

  it("uses default base URL (cloud.langfuse.com)", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("test.span");
    span.end();
    await t.flush();
    expect(captured[0]?.url).toBe(
      "https://cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });

  it("uses custom baseUrl", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(
      baseOpts({ fetchImpl, baseUrl: "https://us.cloud.langfuse.com", flushInterval: 999999 }),
    );
    const span = t.startSpan("test.span");
    span.end();
    await t.flush();
    expect(captured[0]?.url).toBe(
      "https://us.cloud.langfuse.com/api/public/otel/v1/traces",
    );
  });

  it("sends correct Basic auth header", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("test.span");
    span.end();
    await t.flush();
    // pk-lf-test:sk-lf-test in base64
    const expected = "Basic " + btoa("pk-lf-test:sk-lf-test");
    expect(captured[0]?.headers["authorization"]).toBe(expected);
  });

  it("sends x-langfuse-ingestion-version: 4", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("test.span");
    span.end();
    await t.flush();
    expect(captured[0]?.headers["x-langfuse-ingestion-version"]).toBe("4");
  });

  it("sends Content-Type: application/json", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("test.span");
    span.end();
    await t.flush();
    expect(captured[0]?.headers["content-type"]).toBe("application/json");
  });
});

// ---------------------------------------------------------------------------
// Span → OTLP payload shape
// ---------------------------------------------------------------------------

describe("langfuseTracer — OTLP payload shape", () => {
  it("wraps span in resourceSpans > scopeSpans structure", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.invoke_agent");
    span.end();
    await t.flush();

    const body = captured[0]?.body as { resourceSpans: unknown[] };
    expect(body.resourceSpans).toHaveLength(1);

    const rs = (body.resourceSpans[0] as { scopeSpans: unknown[] });
    expect(rs.scopeSpans).toHaveLength(1);

    const ss = (rs.scopeSpans[0] as { spans: unknown[] });
    expect(ss.spans).toHaveLength(1);
  });

  it("span has correct name and non-empty traceId/spanId", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; traceId: string; spanId: string }> }> }> });
    const s = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(s.name).toBe("gen_ai.chat");
    expect(s.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(s.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("startTimeUnixNano and endTimeUnixNano are non-empty strings (nanos)", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ startTimeUnixNano: string; endTimeUnixNano: string }> }> }> });
    const s = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(typeof s.startTimeUnixNano).toBe("string");
    expect(typeof s.endTimeUnixNano).toBe("string");
    expect(BigInt(s.endTimeUnixNano) >= BigInt(s.startTimeUnixNano)).toBe(true);
  });

  it("preserves startup attributes passed to startSpan", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.invoke_agent", {
      "gen_ai.agent.id": "my-agent",
    });
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> });
    const attrs = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    const found = attrs.find((a) => a.key === "gen_ai.agent.id");
    expect(found?.value).toMatchObject({ stringValue: "my-agent" });
  });

  it("preserves setAttribute calls (GenAI token attributes)", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.invoke_agent", { "gen_ai.agent.id": "agent-x" });
    span.setAttribute("gen_ai.usage.input_tokens", 120);
    span.setAttribute("gen_ai.usage.output_tokens", 88);
    span.setAttribute("gen_ai.usage.cached_input_tokens", 40);
    span.setAttribute("eidentic.cost_usd", 0.0012);
    span.setAttribute("eidentic.kv_cache_hit_rate", 0.333);
    span.setStatus("ok");
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> });
    const attrs = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;

    const byKey = (k: string) => attrs.find((a) => a.key === k)?.value;

    expect(byKey("gen_ai.usage.input_tokens")).toMatchObject({ intValue: "120" });
    expect(byKey("gen_ai.usage.output_tokens")).toMatchObject({ intValue: "88" });
    expect(byKey("gen_ai.usage.cached_input_tokens")).toMatchObject({ intValue: "40" });
    // floats → doubleValue
    expect(byKey("eidentic.cost_usd")).toMatchObject({ doubleValue: 0.0012 });
    expect(byKey("eidentic.kv_cache_hit_rate")).toMatchObject({ doubleValue: 0.333 });
  });

  it("maps setStatus('ok') → status.code 1", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.setStatus("ok");
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number } }> }> }> });
    expect(rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status.code).toBe(1);
  });

  it("maps setStatus('error') → status.code 2 with message", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.setStatus("error", "model timeout");
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ status: { code: number; message?: string } }> }> }> });
    const status = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.status;
    expect(status.code).toBe(2);
    expect(status.message).toBe("model timeout");
  });

  it("resource has service.name attribute", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> }; scopeSpans: unknown[] }> });
    const resourceAttrs = rs.resourceSpans[0]!.resource.attributes;
    const sn = resourceAttrs.find((a) => a.key === "service.name");
    expect(sn?.value).toMatchObject({ stringValue: "eidentic-agent" });
  });
});

// ---------------------------------------------------------------------------
// Batching / auto-flush
// ---------------------------------------------------------------------------

describe("langfuseTracer — batching", () => {
  it("does not flush until flushAt threshold is reached", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushAt: 3, flushInterval: 999999 }));

    // Add 2 spans — below the threshold of 3.
    for (let i = 0; i < 2; i++) {
      const span = t.startSpan(`span-${i}`);
      span.end();
    }
    // Allow micro-tasks to settle.
    await Promise.resolve();
    expect(captured).toHaveLength(0);
    await t.shutdown();
  });

  it("auto-flushes when flushAt threshold is reached", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushAt: 3, flushInterval: 999999 }));

    for (let i = 0; i < 3; i++) {
      const span = t.startSpan(`span-${i}`);
      span.end();
    }
    // Flush triggered by threshold — wait a tick for the promise to resolve.
    await new Promise((r) => setTimeout(r, 10));
    expect(captured).toHaveLength(1);
    const body = captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(3);
    await t.shutdown();
  });

  it("sends all buffered spans on shutdown even if below flushAt", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushAt: 20, flushInterval: 999999 }));

    const span = t.startSpan("sole-span");
    span.end();
    await t.shutdown();

    expect(captured).toHaveLength(1);
  });

  it("batches multiple spans into one HTTP call", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushAt: 10, flushInterval: 999999 }));

    for (let i = 0; i < 5; i++) {
      const s = t.startSpan(`s${i}`);
      s.end();
    }
    await t.flush();

    expect(captured).toHaveLength(1);
    const body = captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }> };
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Resilience
// ---------------------------------------------------------------------------

describe("langfuseTracer — resilience", () => {
  it("does not throw when fetch fails (network error)", async () => {
    const badFetch: typeof fetch = async () => {
      throw new Error("network error");
    };
    const t = langfuseTracer(baseOpts({ fetchImpl: badFetch, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.end();
    // Should not throw.
    await expect(t.flush()).resolves.toBeUndefined();
    await t.shutdown();
  });

  it("setAttribute after end() is a no-op (does not crash)", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    const span = t.startSpan("gen_ai.chat");
    span.end();
    span.setAttribute("late.attribute", "ignored");
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }> }> });
    const attrs = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    expect(attrs.find((a) => a.key === "late.attribute")).toBeUndefined();
  });

  it("does not flush after shutdown", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    await t.shutdown();
    // Spans created after shutdown should be dropped.
    const span = t.startSpan("post-shutdown");
    span.end();
    await t.flush();
    // Only 1 call from the shutdown flush (which was empty anyway).
    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// gen_ai tool span (mirrors loop.ts usage)
// ---------------------------------------------------------------------------

describe("langfuseTracer — tool span (mirrors loop.ts)", () => {
  it("gen_ai.execute_tool span carries gen_ai.tool.name", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));

    const toolSpan = t.startSpan("gen_ai.execute_tool", { "gen_ai.tool.name": "search_web" });
    toolSpan.setStatus("ok");
    toolSpan.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string; attributes: Array<{ key: string; value: Record<string, unknown> }> }> }> }> });
    const s = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!;
    expect(s.name).toBe("gen_ai.execute_tool");
    const toolName = s.attributes.find((a) => a.key === "gen_ai.tool.name");
    expect(toolName?.value).toMatchObject({ stringValue: "search_web" });
  });
});

// ---------------------------------------------------------------------------
// M13(a): redactAttributes option
// ---------------------------------------------------------------------------

describe("langfuseTracer — redactAttributes option (M13a)", () => {
  it("calls redactAttributes with the span's attribute array before export", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const redactFn = vi.fn((attrs: Array<{ key: string; value: string | number | boolean }>) =>
      attrs.filter(({ key }) => key !== "llm.prompt"),
    );
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999, redactAttributes: redactFn }));

    const span = t.startSpan("gen_ai.chat", { "llm.prompt": "secret prompt", "gen_ai.agent.id": "agent-x" });
    span.end();
    await t.flush();

    expect(redactFn).toHaveBeenCalledOnce();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }> }> });
    const attrs = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    expect(attrs.find((a) => a.key === "llm.prompt")).toBeUndefined();
    expect(attrs.find((a) => a.key === "gen_ai.agent.id")).toBeDefined();
  });

  it("exports all attributes unchanged when redactAttributes is not set (default)", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));

    const span = t.startSpan("gen_ai.chat", { "llm.prompt": "visible prompt", "other.key": "value" });
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<{ key: string }> }> }> }> });
    const attrs = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    expect(attrs.find((a) => a.key === "llm.prompt")).toBeDefined();
    expect(attrs.find((a) => a.key === "other.key")).toBeDefined();
  });

  it("can redact all attributes (return empty array)", async () => {
    const { fetchImpl, captured } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999, redactAttributes: () => [] }));

    const span = t.startSpan("gen_ai.chat", { "llm.prompt": "secret", "gen_ai.agent.id": "a" });
    span.end();
    await t.flush();

    const rs = (captured[0]?.body as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ attributes: Array<unknown> }> }> }> });
    const attrs = rs.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes;
    expect(attrs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// M13(b): droppedSpans counter + onFlushError + maxBufferSize
// ---------------------------------------------------------------------------

describe("langfuseTracer — droppedSpans + onFlushError (M13b)", () => {
  it("droppedSpans starts at 0", () => {
    const { fetchImpl } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999 }));
    expect(t.droppedSpans).toBe(0);
    void t.shutdown();
  });

  it("increments droppedSpans when fetch throws", async () => {
    const badFetch: typeof fetch = async () => { throw new Error("network error"); };
    const t = langfuseTracer(baseOpts({ fetchImpl: badFetch, flushInterval: 999999 }));

    const span = t.startSpan("gen_ai.chat");
    span.end();
    await t.flush();

    expect(t.droppedSpans).toBe(1);
    await t.shutdown();
  });

  it("calls onFlushError with the error and dropped count", async () => {
    const errorSpy = vi.fn();
    const badFetch: typeof fetch = async () => { throw new Error("net-err"); };
    const t = langfuseTracer(baseOpts({ fetchImpl: badFetch, flushInterval: 999999, onFlushError: errorSpy }));

    for (let i = 0; i < 3; i++) { t.startSpan(`s${i}`).end(); }
    await t.flush();

    expect(errorSpy).toHaveBeenCalledOnce();
    const [err, count] = errorSpy.mock.calls[0] as [unknown, number];
    expect((err as Error).message).toBe("net-err");
    expect(count).toBe(3);
    await t.shutdown();
  });

  it("drops oldest spans when maxBufferSize is exceeded", () => {
    const { fetchImpl } = makeFakeFetch();
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999, maxBufferSize: 3, flushAt: 9999 }));

    // Add 5 spans: the first 2 should be evicted.
    for (let i = 0; i < 5; i++) { t.startSpan(`span-${i}`).end(); }

    expect(t.droppedSpans).toBe(2);
    void t.shutdown();
  });

  it("does not call onFlushError on successful flush", async () => {
    const errorSpy = vi.fn();
    const { fetchImpl } = makeFakeFetch([{ status: 200 }]);
    const t = langfuseTracer(baseOpts({ fetchImpl, flushInterval: 999999, onFlushError: errorSpy }));

    t.startSpan("ok-span").end();
    await t.flush();

    expect(errorSpy).not.toHaveBeenCalled();
    await t.shutdown();
  });
});
