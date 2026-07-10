import { describe, it, expect, vi } from "vitest";
import { MockModel, StreamMockModel } from "@eidentic/types/testing";
import type { ModelRequest, ModelResponse, ModelStreamPart } from "@eidentic/types";
import { withFallback } from "../src/fallback.js";
import { routeModel, byTokenEstimate } from "../src/route.js";
import { cachedModel } from "../src/cache.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const req: ModelRequest = { messages: [{ role: "user", content: "hello" }], tools: [] };

function resp(text: string, inputTokens = 1, outputTokens = 1): ModelResponse {
  return { content: [{ type: "text", text }], usage: { inputTokens, outputTokens } };
}

/** A model that always rejects with the given error. */
function failModel(err: unknown): MockModel & { stream(req: ModelRequest): AsyncIterable<ModelStreamPart> } {
  const m = new MockModel([]) as any;
  m.complete = async () => { throw err; };
  m.stream = async function* () { throw err; };
  return m;
}

/** A model whose stream throws after optionally yielding some deltas. */
function partialStreamModel(deltas: string[], thenThrow: unknown) {
  return {
    calls: [] as ModelRequest[],
    async complete(_req: ModelRequest): Promise<ModelResponse> { throw thenThrow; },
    async *stream(r: ModelRequest): AsyncIterable<ModelStreamPart> {
      this.calls.push(r);
      for (const d of deltas) yield { type: "delta", delta: { text: d } };
      throw thenThrow;
    },
  };
}

// ---------------------------------------------------------------------------
// withFallback — complete()
// ---------------------------------------------------------------------------

describe("withFallback – complete()", () => {
  it("returns the primary's result when it succeeds", async () => {
    const primary = new MockModel([resp("primary")]);
    const fallback = new MockModel([resp("fallback")]);
    const model = withFallback(primary, [fallback]);
    const result = await model.complete(req);
    expect(result.content[0]).toMatchObject({ type: "text", text: "primary" });
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back to the first fallback on primary error", async () => {
    const primary = failModel(new Error("network error"));
    const fallback = new MockModel([resp("fallback-result")]);
    const model = withFallback(primary, [fallback]);
    const result = await model.complete(req);
    expect(result.content[0]).toMatchObject({ type: "text", text: "fallback-result" });
  });

  it("annotates responses with the model that actually answered", async () => {
    const primary = Object.assign(failModel(new Error("down")), { modelId: "primary" });
    const fallback = Object.assign(new MockModel([resp("fallback")]), { modelId: "fallback" });
    const result = await withFallback(primary, [fallback]).complete(req);
    expect(result.resolvedModelId).toBe("fallback");
  });

  it("does not advertise streaming when the primary is complete-only", () => {
    const primary = new MockModel([resp("primary")]);
    const fallback = new StreamMockModel([{ deltas: ["x"], response: resp("x") }]);
    expect(withFallback(primary, [fallback]).stream).toBeUndefined();
  });

  it("tries all fallbacks in order", async () => {
    const model = withFallback(
      failModel(new Error("e1")),
      [failModel(new Error("e2")), new MockModel([resp("third")])],
    );
    const result = await model.complete(req);
    expect(result.content[0]).toMatchObject({ type: "text", text: "third" });
  });

  it("throws the last error when all models fail", async () => {
    const model = withFallback(
      failModel(new Error("e1")),
      [failModel(new Error("e2")), failModel(new Error("last"))],
    );
    await expect(model.complete(req)).rejects.toThrow("last");
  });

  it("does NOT fall back on AbortError", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    const fallback = new MockModel([resp("fallback")]);
    const model = withFallback(failModel(abortErr), [fallback]);
    await expect(model.complete(req)).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.calls).toHaveLength(0);
  });

  it("does NOT fall back on AbortError (duck-typed Error.name)", async () => {
    const abortErr = Object.assign(new Error("aborted"), { name: "AbortError" });
    const fallback = new MockModel([resp("fallback")]);
    const model = withFallback(failModel(abortErr), [fallback]);
    await expect(model.complete(req)).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.calls).toHaveLength(0);
  });

  it("calls onFallback with the correct indices", async () => {
    const events: Array<{ from: number; to: number }> = [];
    const model = withFallback(
      failModel(new Error("e1")),
      [failModel(new Error("e2")), new MockModel([resp("ok")])],
      { onFallback: (_err, from, to) => events.push({ from, to }) },
    );
    await model.complete(req);
    expect(events).toEqual([{ from: 0, to: 1 }, { from: 1, to: 2 }]);
  });

  it("respects custom shouldFallback predicate (skip fallback for 400 errors)", async () => {
    const err400 = Object.assign(new Error("Bad Request"), { status: 400 });
    const fallback = new MockModel([resp("fb")]);
    const model = withFallback(
      failModel(err400),
      [fallback],
      { shouldFallback: (e) => !((e as any).status === 400) },
    );
    await expect(model.complete(req)).rejects.toMatchObject({ message: "Bad Request" });
    expect(fallback.calls).toHaveLength(0);
  });

  it("preserves usage from the fallback model", async () => {
    const model = withFallback(
      failModel(new Error("fail")),
      [new MockModel([resp("ok", 10, 20)])],
    );
    const result = await model.complete(req);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
  });
});

// ---------------------------------------------------------------------------
// withFallback — stream()
// ---------------------------------------------------------------------------

describe("withFallback – stream()", () => {
  it("streams from primary when it succeeds", async () => {
    const primary = new StreamMockModel([{ deltas: ["a", "b"], response: resp("ab") }]);
    const fallback = new StreamMockModel([{ deltas: ["x"], response: resp("x") }]);
    const model = withFallback(primary, [fallback]);
    const parts: ModelStreamPart[] = [];
    for await (const p of model.stream!(req)) parts.push(p);
    const deltas = parts.filter((p) => p.type === "delta").map((p) => (p as any).delta.text);
    expect(deltas).toEqual(["a", "b"]);
    expect(fallback.calls).toHaveLength(0);
  });

  it("falls back to next model when stream fails before any deltas", async () => {
    const primary = partialStreamModel([], new Error("connect error"));
    const fallback = new StreamMockModel([{ deltas: ["ok"], response: resp("ok") }]);
    const model = withFallback(primary, [fallback]);
    const parts: ModelStreamPart[] = [];
    for await (const p of model.stream!(req)) parts.push(p);
    const deltas = parts.filter((p) => p.type === "delta").map((p) => (p as any).delta.text);
    expect(deltas).toEqual(["ok"]);
  });

  it("does NOT fall back mid-stream (after first delta emitted)", async () => {
    // Once a delta has been sent, the caller has partially consumed the stream.
    // Falling back would yield a second "Hello" from a different model, corrupting output.
    const primary = partialStreamModel(["first-delta"], new Error("mid-stream failure"));
    const fallback = new StreamMockModel([{ deltas: ["x"], response: resp("x") }]);
    const model = withFallback(primary, [fallback]);
    const parts: ModelStreamPart[] = [];
    await expect(async () => {
      for await (const p of model.stream!(req)) parts.push(p);
    }).rejects.toThrow("mid-stream failure");
    // Fallback was not used
    expect(fallback.calls).toHaveLength(0);
    // But the one delta that was emitted before the error is present
    expect(parts).toEqual([{ type: "delta", delta: { text: "first-delta" } }]);
  });

  it("does NOT fall back on AbortError in stream", async () => {
    const abortErr = new DOMException("aborted", "AbortError");
    const primary = partialStreamModel([], abortErr);
    const fallback = new StreamMockModel([{ deltas: ["x"], response: resp("x") }]);
    const model = withFallback(primary, [fallback]);
    await expect(async () => {
      for await (const _ of model.stream!(req)) { /* drain */ }
    }).rejects.toMatchObject({ name: "AbortError" });
    expect(fallback.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// routeModel
// ---------------------------------------------------------------------------

describe("routeModel", () => {
  it("routes to the correct tier based on the selector", async () => {
    const small = new MockModel([resp("small-result")]);
    const large = new MockModel([resp("large-result")]);
    const model = routeModel(() => "small", { small, large });
    const result = await model.complete(req);
    expect(result.content[0]).toMatchObject({ type: "text", text: "small-result" });
    expect(large.calls).toHaveLength(0);
  });

  it("annotates the selected model identity and only exposes shared stream capability", async () => {
    const small = Object.assign(new MockModel([resp("small")]), { modelId: "small-model" });
    const large = new StreamMockModel([{ deltas: ["large"], response: resp("large") }]);
    const model = routeModel(() => "small", { small, large });
    expect((await model.complete(req)).resolvedModelId).toBe("small-model");
    expect(model.stream).toBeUndefined();
  });

  it("routes different requests to different tiers", async () => {
    const cheap = new MockModel([resp("cheap"), resp("cheap2")]);
    const premium = new MockModel([resp("premium")]);
    let callCount = 0;
    const model = routeModel(
      () => (callCount++ % 2 === 0 ? "cheap" : "premium"),
      { cheap, premium },
    );
    const r1 = await model.complete(req); // call 0 -> cheap
    const r2 = await model.complete(req); // call 1 -> premium
    const r3 = await model.complete(req); // call 2 -> cheap
    expect((r1.content[0] as any).text).toBe("cheap");
    expect((r2.content[0] as any).text).toBe("premium");
    expect((r3.content[0] as any).text).toBe("cheap2");
  });

  it("throws a clear error for an unknown tier", async () => {
    const model = routeModel(() => "unknown", { small: new MockModel([]) });
    await expect(model.complete(req)).rejects.toThrow(/unknown tier "unknown"/);
    await expect(model.complete(req)).rejects.toThrow(/Known tiers: small/);
  });

  it("passes the full request to the selector", async () => {
    const captured: ModelRequest[] = [];
    const target = new MockModel([resp("ok")]);
    const model = routeModel(
      (r) => { captured.push(r); return "t"; },
      { t: target },
    );
    await model.complete(req);
    expect(captured[0]).toBe(req);
  });

  it("streams via the resolved tier's stream()", async () => {
    const small = new StreamMockModel([{ deltas: ["s"], response: resp("s") }]);
    const model = routeModel(() => "small", { small });
    const parts: ModelStreamPart[] = [];
    for await (const p of model.stream!(req)) parts.push(p);
    expect(parts.filter((p) => p.type === "delta")).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// byTokenEstimate
// ---------------------------------------------------------------------------

describe("byTokenEstimate", () => {
  it("selects the first tier whose upTo >= estimated tokens", () => {
    const sel = byTokenEstimate(
      [{ upTo: 100, tier: "small" }, { upTo: 1000, tier: "medium" }],
      "large",
    );
    // ~4 chars/token, 20 chars → ~5 tokens → small tier
    const shortReq: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };
    expect(sel(shortReq)).toBe("small");

    // 600 chars → ~150 tokens → medium tier
    const medReq: ModelRequest = {
      messages: [{ role: "user", content: "a".repeat(600) }],
      tools: [],
    };
    expect(sel(medReq)).toBe("medium");

    // 5000 chars → ~1250 tokens → fallback large
    const bigReq: ModelRequest = {
      messages: [{ role: "user", content: "a".repeat(5000) }],
      tools: [],
    };
    expect(sel(bigReq)).toBe("large");
  });

  it("evaluates thresholds in ascending upTo order (regardless of input order)", () => {
    // Provide thresholds in reverse order — selector should still sort them.
    const sel = byTokenEstimate(
      [{ upTo: 1000, tier: "medium" }, { upTo: 100, tier: "small" }],
      "large",
    );
    const shortReq: ModelRequest = { messages: [{ role: "user", content: "hi" }], tools: [] };
    expect(sel(shortReq)).toBe("small");
  });
});

// ---------------------------------------------------------------------------
// cachedModel
// ---------------------------------------------------------------------------

describe("cachedModel – complete()", () => {
  it("returns cached result on second identical call", async () => {
    let callCount = 0;
    const base = new MockModel([resp("first"), resp("second")]);
    const original = base.complete.bind(base);
    (base as any).complete = async (r: ModelRequest) => {
      callCount++;
      return original(r);
    };
    const model = cachedModel(base);
    const r1 = await model.complete(req);
    const r2 = await model.complete(req);
    expect(r1.content[0]).toMatchObject({ type: "text", text: "first" });
    expect(r2.content[0]).toMatchObject({ type: "text", text: "first" }); // cached
    expect(callCount).toBe(1);
  });

  it("does not advertise streaming for a complete-only wrapped model", () => {
    expect(cachedModel(new MockModel([resp("x")])).stream).toBeUndefined();
  });

  it("misses on a different request", async () => {
    const base = new MockModel([resp("a"), resp("b")]);
    const model = cachedModel(base);
    const req2: ModelRequest = { messages: [{ role: "user", content: "other" }], tools: [] };
    const r1 = await model.complete(req);
    const r2 = await model.complete(req2);
    expect((r1.content[0] as any).text).toBe("a");
    expect((r2.content[0] as any).text).toBe("b");
  });

  it("respects TTL: expired entries (expiresAt <= now) are not served from cache", async () => {
    // Deterministic expiry via an injected fake clock (no real-time races).
    let now = 1_000;
    const base = new MockModel([resp("live1"), resp("live2")]);
    const model = cachedModel(base, { ttlMs: 50, clock: () => now });

    // Call 1: miss → live call, entry cached (expires at 1050)
    const r1 = await model.complete(req);
    expect((r1.content[0] as any).text).toBe("live1");
    expect(model.stats()).toMatchObject({ hits: 0, misses: 1, size: 1 });

    // Within TTL → served from warm LRU
    now = 1_049;
    const r1b = await model.complete(req);
    expect((r1b.content[0] as any).text).toBe("live1");
    expect(model.stats()).toMatchObject({ hits: 1, misses: 1 });

    // Advance past expiry → LRU entry stale → live call
    now = 1_050;
    const r2 = await model.complete(req);
    expect((r2.content[0] as any).text).toBe("live2");
    expect(model.stats()).toMatchObject({ hits: 1, misses: 2 });
  });

  it("evicts LRU entry when maxEntries is exceeded", async () => {
    // maxEntries=2: after inserting 3 unique requests, the oldest is evicted
    const makeReq = (text: string): ModelRequest => ({
      messages: [{ role: "user", content: text }],
      tools: [],
    });
    const reqA = makeReq("aaaaaaaaaaaaaaa");
    const reqB = makeReq("bbbbbbbbbbbbbbb");
    const reqC = makeReq("ccccccccccccccc");

    const base = new MockModel([
      resp("A"), resp("B"), resp("C"), resp("A2"),
    ]);
    const model = cachedModel(base, { maxEntries: 2 });

    await model.complete(reqA); // LRU: [A]
    await model.complete(reqB); // LRU: [A, B]
    await model.complete(reqC); // LRU: [B, C] — A evicted
    // reqA miss: model call is made again
    const reA = await model.complete(reqA);
    expect((reA.content[0] as any).text).toBe("A2"); // new call, not cached
    expect(model.stats().hits).toBe(0);
  });

  it("stats() tracks hits and misses correctly", async () => {
    const base = new MockModel([resp("x"), resp("y")]);
    const model = cachedModel(base);

    expect(model.stats()).toEqual({ hits: 0, misses: 0, size: 0 });
    await model.complete(req); // miss
    expect(model.stats()).toMatchObject({ hits: 0, misses: 1, size: 1 });
    await model.complete(req); // hit
    expect(model.stats()).toMatchObject({ hits: 1, misses: 1, size: 1 });
    const req2: ModelRequest = { messages: [{ role: "user", content: "other" }], tools: [] };
    await model.complete(req2); // miss
    expect(model.stats()).toMatchObject({ hits: 1, misses: 2, size: 2 });
  });

  it("calls onCacheHit on each cache hit", async () => {
    const hits: string[] = [];
    const base = new MockModel([resp("cached-val")]);
    const model = cachedModel(base, {
      onCacheHit: (key) => hits.push(key),
    });
    await model.complete(req); // populate
    await model.complete(req); // hit
    await model.complete(req); // hit
    expect(hits).toHaveLength(2);
  });

  it("respects shouldCache predicate (does not cache when predicate returns false)", async () => {
    const base = new MockModel([resp("r1"), resp("r2")]);
    const model = cachedModel(base, { shouldCache: () => false });
    const r1 = await model.complete(req);
    const r2 = await model.complete(req);
    expect((r1.content[0] as any).text).toBe("r1");
    expect((r2.content[0] as any).text).toBe("r2"); // not cached, new call
    expect(model.stats().hits).toBe(0);
    expect(model.stats().misses).toBe(2);
  });

  it("uses custom keyFn to derive cache key", async () => {
    // All requests map to the same key regardless of content
    const base = new MockModel([resp("pinned")]);
    const model = cachedModel(base, { keyFn: () => "fixed-key" });
    const req2: ModelRequest = { messages: [{ role: "user", content: "different" }], tools: [] };
    await model.complete(req);
    const r2 = await model.complete(req2); // same key → cache hit
    expect((r2.content[0] as any).text).toBe("pinned");
    expect(model.stats().hits).toBe(1);
  });
});

describe("cachedModel – stream()", () => {
  it("passes streaming calls through without caching", async () => {
    let callCount = 0;
    const base = new StreamMockModel([
      { deltas: ["a"], response: resp("a") },
      { deltas: ["b"], response: resp("b") },
    ]);
    const origStream = base.stream.bind(base);
    (base as any).stream = async function* (r: ModelRequest) {
      callCount++;
      yield* origStream(r);
    };
    const model = cachedModel(base);
    const consume = async () => {
      const parts: ModelStreamPart[] = [];
      for await (const p of model.stream!(req)) parts.push(p);
      return parts;
    };
    await consume();
    await consume(); // second stream call — NOT from cache
    expect(callCount).toBe(2);
    expect(model.stats().hits).toBe(0);
    expect(model.stats().misses).toBe(0); // stream calls don't count in stats
  });
});

// ---------------------------------------------------------------------------
// Composition: cachedModel(withFallback(...))
// ---------------------------------------------------------------------------

describe("composition: cachedModel(withFallback(primary, [fallback]))", () => {
  it("cache hit skips the underlying withFallback chain entirely", async () => {
    const primaryCalls: number[] = [];
    const base = new MockModel([resp("combo")]);
    const origComplete = base.complete.bind(base);
    (base as any).complete = async (r: ModelRequest) => {
      primaryCalls.push(1);
      return origComplete(r);
    };

    const fallback = new MockModel([resp("fallback")]);
    const withFb = withFallback(base, [fallback]);
    const model = cachedModel(withFb);

    const r1 = await model.complete(req);
    const r2 = await model.complete(req); // cache hit
    expect((r1.content[0] as any).text).toBe("combo");
    expect((r2.content[0] as any).text).toBe("combo");
    expect(primaryCalls).toHaveLength(1); // primary called only once
    expect(fallback.calls).toHaveLength(0);
    expect(model.stats()).toMatchObject({ hits: 1, misses: 1 });
  });

  it("cache miss triggers withFallback chain; result is cached for next call", async () => {
    const err = new Error("primary down");
    const fallback = new MockModel([resp("fallback-result")]);
    const model = cachedModel(withFallback(failModel(err) as any, [fallback]));

    const r1 = await model.complete(req); // miss → fallback
    const r2 = await model.complete(req); // hit → no fallback call
    expect((r1.content[0] as any).text).toBe("fallback-result");
    expect((r2.content[0] as any).text).toBe("fallback-result");
    expect(fallback.calls).toHaveLength(1);
    expect(model.stats()).toMatchObject({ hits: 1, misses: 1 });
  });
});
