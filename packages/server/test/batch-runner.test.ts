/**
 * BatchRunner tests — deterministic, no real model calls, no real sleeps.
 *
 * Assertions:
 *   1. All items processed and results collected.
 *   2. Concurrency bound respected (never more than N in-flight simultaneously).
 *   3. A throwing item is captured as per-item error; batch completes.
 *   4. Aggregate usage/cost summed correctly.
 *   5. AbortSignal stops further dispatch (cancelled flag set; partial results returned).
 *   6. Progress callback invoked once per completion.
 *
 * We use a fake `BatchBackend` spy so no real agent or model is involved.
 * "Concurrency" is measured by tracking the peak simultaneous in-flight count
 * via a shared counter that is incremented at the start of each item and
 * decremented when it finishes.
 */

import { describe, it, expect, vi } from "vitest";
import {
  BatchRunner,
  type BatchItem,
  type BatchItemResult,
  type BatchBackend,
} from "@eidentic/server";
import type { CostBreakdown } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * A resolveMap entry describing one item's canned response.
 * `delayTicks` controls when the item's promise resolves relative to others.
 * Since we use real microtasks (no fake timers), we model concurrency by
 * having the backend await a manually-controlled promise per item.
 */
interface CannedResponse {
  /** Throw an error instead of returning a success. */
  throws?: string;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  output?: string;
  /** If provided, the backend awaits this promise before resolving. */
  gate?: Promise<void>;
}

/**
 * A deferred that can be resolved/rejected from outside.
 */
function makeGate(): { promise: Promise<void>; resolve: () => void } {
  let res!: () => void;
  const promise = new Promise<void>((r) => { res = r; });
  return { promise, resolve: res };
}

/**
 * Build a fake BatchBackend spy.
 *
 * `responses` is a map from item id → CannedResponse.
 * Items not in the map default to a successful zero-usage response.
 *
 * The spy tracks:
 *   - `calls`: ordered list of item ids as they START (enter the run method).
 *   - `peakInFlight`: max simultaneous in-flight count observed.
 *   - `completions`: ordered list of item ids as they FINISH.
 */
function makeFakeBackend(responses: Record<string, CannedResponse> = {}): BatchBackend & {
  calls: string[];
  completions: string[];
  peakInFlight: number;
} {
  let inFlight = 0;
  let peak = 0;
  const calls: string[] = [];
  const completions: string[] = [];

  return {
    calls,
    completions,
    get peakInFlight() { return peak; },
    async run(item, _signal) {
      // Track start.
      calls.push(item.id);
      inFlight++;
      if (inFlight > peak) peak = inFlight;

      const resp = responses[item.id] ?? {};

      // Optionally wait on a gate (for concurrency tests).
      if (resp.gate) {
        await resp.gate;
      }

      inFlight--;
      completions.push(item.id);

      if (resp.throws) {
        return {
          status: "error",
          id: item.id,
          error: resp.throws,
          sessionId: item.sessionId,
        };
      }

      const cost: CostBreakdown | undefined =
        resp.usd !== undefined
          ? {
              foreground: { inputTokens: resp.inputTokens ?? 0, outputTokens: resp.outputTokens ?? 0 },
              background: { inputTokens: 0, outputTokens: 0 },
              cachedInputTokens: 0,
              usd: resp.usd,
            }
          : undefined;

      return {
        status: "success",
        id: item.id,
        output: resp.output ?? `output-${item.id}`,
        usage: { inputTokens: resp.inputTokens ?? 10, outputTokens: resp.outputTokens ?? 5 },
        cost,
        sessionId: item.sessionId,
      };
    },
  };
}

// Build a minimal fake Agent — BatchRunner only uses it when no backend is provided.
// For all tests here we inject a fake backend, so the agent is never actually called.
// We still need an Agent-shaped value to satisfy the constructor type.
function makeFakeAgent() {
  return {
    query: vi.fn(),
    store: {},
    sandbox: {},
    modelId: undefined,
    instructions: "",
    greeting: undefined,
    skillCatalog: vi.fn(() => []),
    toolSchemas: vi.fn(() => []),
    setPermissionMode: vi.fn(),
    resume: vi.fn(),
  } as unknown as import("@eidentic/core").Agent;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchRunner", () => {
  // -------------------------------------------------------------------------
  // 1. All items processed
  // -------------------------------------------------------------------------
  it("processes all items and returns a result for each", async () => {
    const backend = makeFakeBackend();
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const items: BatchItem[] = [
      { id: "a", input: "hello" },
      { id: "b", input: "world" },
      { id: "c", input: "foo" },
    ];

    const { results, aggregate } = await runner.run(items);

    expect(results).toHaveLength(3);
    expect(aggregate.successCount).toBe(3);
    expect(aggregate.errorCount).toBe(0);
    expect(aggregate.cancelled).toBe(false);
    // All ids accounted for.
    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["a", "b", "c"]);
  });

  // -------------------------------------------------------------------------
  // 2. Concurrency bound respected
  // -------------------------------------------------------------------------
  it("never exceeds the configured concurrency limit", async () => {
    // Use gates to control when each item's backend resolves.
    // Items a, b, c, d — concurrency 2 — at most 2 should ever be in-flight.
    const gateA = makeGate();
    const gateB = makeGate();
    const gateC = makeGate();
    const gateD = makeGate();

    const backend = makeFakeBackend({
      a: { gate: gateA.promise },
      b: { gate: gateB.promise },
      c: { gate: gateC.promise },
      d: { gate: gateD.promise },
    });

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const runPromise = runner.run([
      { id: "a", input: "a" },
      { id: "b", input: "b" },
      { id: "c", input: "c" },
      { id: "d", input: "d" },
    ]);

    // Let microtasks run so the first 2 lanes start.
    await Promise.resolve();
    await Promise.resolve();

    // First wave: a and b should be in-flight.
    expect(backend.calls).toContain("a");
    expect(backend.calls).toContain("b");
    // c and d not yet started (concurrency cap).
    expect(backend.calls).not.toContain("c");
    expect(backend.calls).not.toContain("d");

    // Release a → c should start.
    gateA.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Release b → d should start.
    gateB.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // Release the rest.
    gateC.resolve();
    gateD.resolve();

    const { aggregate } = await runPromise;

    expect(aggregate.successCount).toBe(4);
    // Peak in-flight should never have exceeded 2.
    expect(backend.peakInFlight).toBeLessThanOrEqual(2);
  });

  it("never exceeds concurrency 1 (serial)", async () => {
    const order: string[] = [];
    // Gate each item — only released sequentially.
    const gates: Record<string, ReturnType<typeof makeGate>> = {
      x: makeGate(), y: makeGate(), z: makeGate(),
    };

    const backend = makeFakeBackend({
      x: { gate: gates.x.promise },
      y: { gate: gates.y.promise },
      z: { gate: gates.z.promise },
    });

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 1, backend });

    const runPromise = runner.run([
      { id: "x", input: "x" },
      { id: "y", input: "y" },
      { id: "z", input: "z" },
    ], {
      onProgress: (item) => order.push(item.id),
    });

    // Pump microtasks — x should start but y/z not yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(backend.calls).toEqual(["x"]);
    expect(backend.calls).not.toContain("y");

    gates.x.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(backend.calls).toContain("y");
    expect(backend.calls).not.toContain("z");

    gates.y.resolve();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    expect(backend.calls).toContain("z");

    gates.z.resolve();
    await runPromise;

    expect(backend.peakInFlight).toBe(1);
    // Should complete in input order with concurrency=1.
    expect(order).toEqual(["x", "y", "z"]);
  });

  // -------------------------------------------------------------------------
  // 3. A throwing item is captured; batch completes
  // -------------------------------------------------------------------------
  it("captures a per-item error without aborting the batch", async () => {
    const backend = makeFakeBackend({
      boom: { throws: "Something went wrong" },
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const { results, aggregate } = await runner.run([
      { id: "good1", input: "ok" },
      { id: "boom", input: "bad" },
      { id: "good2", input: "ok" },
    ]);

    expect(results).toHaveLength(3);
    expect(aggregate.errorCount).toBe(1);
    expect(aggregate.successCount).toBe(2);

    const errResult = results.find((r) => r.id === "boom");
    expect(errResult?.status).toBe("error");
    if (errResult?.status === "error") {
      expect(errResult.error).toBe("Something went wrong");
    }

    // Other items still succeeded.
    const good1 = results.find((r) => r.id === "good1");
    const good2 = results.find((r) => r.id === "good2");
    expect(good1?.status).toBe("success");
    expect(good2?.status).toBe("success");
  });

  it("captures multiple errors and the batch still completes", async () => {
    const backend = makeFakeBackend({
      e1: { throws: "err-1" },
      e2: { throws: "err-2" },
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 4, backend });

    const { results, aggregate } = await runner.run([
      { id: "e1", input: "a" },
      { id: "e2", input: "b" },
      { id: "ok", input: "c" },
    ]);

    expect(results).toHaveLength(3);
    expect(aggregate.successCount).toBe(1);
    expect(aggregate.errorCount).toBe(2);
    expect(aggregate.cancelled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 4. Aggregate usage/cost summed correctly
  // -------------------------------------------------------------------------
  it("sums usage and cost across successful items", async () => {
    const backend = makeFakeBackend({
      i1: { inputTokens: 100, outputTokens: 50, usd: 0.001 },
      i2: { inputTokens: 200, outputTokens: 80, usd: 0.002 },
      i3: { inputTokens: 50, outputTokens: 20 }, // no usd
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 3, backend });

    const { aggregate } = await runner.run([
      { id: "i1", input: "a" },
      { id: "i2", input: "b" },
      { id: "i3", input: "c" },
    ]);

    expect(aggregate.totalUsage.inputTokens).toBe(350);
    expect(aggregate.totalUsage.outputTokens).toBe(150);
    // Only i1+i2 have usd; i3 does not.
    expect(aggregate.totalUsd).toBeCloseTo(0.003, 6);
    expect(aggregate.successCount).toBe(3);
  });

  it("does not include error items in usage totals", async () => {
    const backend = makeFakeBackend({
      bad: { throws: "oops" },
      good: { inputTokens: 40, outputTokens: 20, usd: 0.005 },
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const { aggregate } = await runner.run([
      { id: "bad", input: "x" },
      { id: "good", input: "y" },
    ]);

    expect(aggregate.totalUsage.inputTokens).toBe(40);
    expect(aggregate.totalUsage.outputTokens).toBe(20);
    expect(aggregate.totalUsd).toBeCloseTo(0.005, 6);
  });

  it("returns totalUsd=undefined when no item has cost data", async () => {
    const backend = makeFakeBackend({
      a: { inputTokens: 10, outputTokens: 5 },
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 1, backend });
    const { aggregate } = await runner.run([{ id: "a", input: "x" }]);
    expect(aggregate.totalUsd).toBeUndefined();
  });

  it("returns zero totals for an empty items array", async () => {
    const backend = makeFakeBackend();
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 4, backend });
    const { results, aggregate } = await runner.run([]);
    expect(results).toHaveLength(0);
    expect(aggregate.successCount).toBe(0);
    expect(aggregate.errorCount).toBe(0);
    expect(aggregate.totalUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(aggregate.cancelled).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 5. AbortSignal stops further dispatch
  // -------------------------------------------------------------------------
  it("stops dispatching new items when signal is aborted", async () => {
    const controller = new AbortController();

    // Gate: block all items indefinitely until we control them.
    const gateA = makeGate();
    const gateB = makeGate();

    const backend = makeFakeBackend({
      a: { gate: gateA.promise },
      b: { gate: gateB.promise },
      // c and d should never start once aborted.
      c: {},
      d: {},
    });

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const runPromise = runner.run(
      [
        { id: "a", input: "a" },
        { id: "b", input: "b" },
        { id: "c", input: "c" },
        { id: "d", input: "d" },
      ],
      { signal: controller.signal },
    );

    // Let lanes start — a and b in-flight.
    await Promise.resolve();
    await Promise.resolve();

    // Abort before releasing gates.
    controller.abort();

    // Release in-flight items.
    gateA.resolve();
    gateB.resolve();

    const { results, aggregate } = await runPromise;

    // c and d were never started.
    expect(backend.calls).not.toContain("c");
    expect(backend.calls).not.toContain("d");
    // Only a and b completed.
    expect(results).toHaveLength(2);
    expect(aggregate.cancelled).toBe(true);
  });

  it("sets cancelled=true even when all items were dispatched before the abort", async () => {
    // If abort fires after all items have been dispatched but before the Promise.all
    // resolves, cancelled should still be true (re-check after all lanes finish).
    const controller = new AbortController();

    const backend = makeFakeBackend({
      x: {},
      y: {},
    });

    // Abort immediately.
    controller.abort();

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 4, backend });
    const { aggregate } = await runner.run(
      [{ id: "x", input: "x" }, { id: "y", input: "y" }],
      { signal: controller.signal },
    );

    // Since we aborted before dispatch, no items should have run.
    expect(aggregate.cancelled).toBe(true);
    expect(backend.calls.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 6. Progress callback invoked per completion
  // -------------------------------------------------------------------------
  it("calls onProgress once per completed item in completion order", async () => {
    const backend = makeFakeBackend({
      p1: { output: "r1", inputTokens: 5, outputTokens: 2 },
      p2: { output: "r2", inputTokens: 8, outputTokens: 3 },
      p3: { output: "r3", inputTokens: 3, outputTokens: 1 },
    });

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 3, backend });
    const progressCalls: BatchItemResult[] = [];

    await runner.run(
      [
        { id: "p1", input: "a" },
        { id: "p2", input: "b" },
        { id: "p3", input: "c" },
      ],
      { onProgress: (item) => progressCalls.push(item) },
    );

    // onProgress called exactly 3 times.
    expect(progressCalls).toHaveLength(3);
    // All items present in progress callbacks.
    const progressIds = progressCalls.map((r) => r.id).sort();
    expect(progressIds).toEqual(["p1", "p2", "p3"]);
  });

  it("calls onProgress for error items too", async () => {
    const backend = makeFakeBackend({
      fail: { throws: "boom" },
    });

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 1, backend });
    const progressCalls: BatchItemResult[] = [];

    await runner.run(
      [{ id: "fail", input: "x" }],
      { onProgress: (item) => progressCalls.push(item) },
    );

    expect(progressCalls).toHaveLength(1);
    expect(progressCalls[0]?.status).toBe("error");
  });

  // -------------------------------------------------------------------------
  // 7. Default id assignment (no id provided)
  // -------------------------------------------------------------------------
  it("assigns string indices as ids when items have no id", async () => {
    const backend = makeFakeBackend();
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const { results } = await runner.run([
      { input: "first" },
      { input: "second" },
      { input: "third" },
    ]);

    const ids = results.map((r) => r.id).sort();
    expect(ids).toEqual(["0", "1", "2"]);
  });

  // -------------------------------------------------------------------------
  // 8. sessionId is forwarded to the backend
  // -------------------------------------------------------------------------
  it("passes caller-supplied sessionId to the backend", async () => {
    const seenSessionIds: string[] = [];
    const backend: BatchBackend = {
      async run(item) {
        seenSessionIds.push(item.sessionId);
        return {
          status: "success",
          id: item.id,
          output: "ok",
          usage: { inputTokens: 1, outputTokens: 1 },
          sessionId: item.sessionId,
        };
      },
    };

    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 1, backend });
    await runner.run([{ id: "s1", input: "hi", sessionId: "my-session-42" }]);

    expect(seenSessionIds).toContain("my-session-42");
  });

  // -------------------------------------------------------------------------
  // 9. concurrency=1 is clamped to minimum 1 (not 0)
  // -------------------------------------------------------------------------
  it("clamps concurrency to at least 1", async () => {
    const backend = makeFakeBackend({ q: {} });
    // Pass 0 — should be treated as 1.
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 0, backend });
    const { aggregate } = await runner.run([{ id: "q", input: "x" }]);
    expect(aggregate.successCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 10. collectResults: false — opt-out path (Fix 3: scalability)
  // -------------------------------------------------------------------------
  it("collectResults:false returns empty results array but correct aggregate", async () => {
    const backend = makeFakeBackend({
      r1: { inputTokens: 10, outputTokens: 5, usd: 0.001 },
      r2: { inputTokens: 20, outputTokens: 8, usd: 0.002 },
      r3: { throws: "boom" },
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 3, backend });

    const { results, aggregate } = await runner.run(
      [
        { id: "r1", input: "a" },
        { id: "r2", input: "b" },
        { id: "r3", input: "c" },
      ],
      { collectResults: false },
    );

    // results array must be empty (not accumulated in memory).
    expect(results).toHaveLength(0);

    // Aggregate still reflects actual outcomes.
    expect(aggregate.successCount).toBe(2);
    expect(aggregate.errorCount).toBe(1);
    expect(aggregate.totalUsage.inputTokens).toBe(30);
    expect(aggregate.totalUsage.outputTokens).toBe(13);
    expect(aggregate.totalUsd).toBeCloseTo(0.003, 6);
    expect(aggregate.cancelled).toBe(false);
  });

  it("collectResults:false still invokes onProgress for each item", async () => {
    const backend = makeFakeBackend({
      p1: { output: "o1" },
      p2: { output: "o2" },
    });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });
    const progressIds: string[] = [];

    const { results } = await runner.run(
      [{ id: "p1", input: "a" }, { id: "p2", input: "b" }],
      {
        collectResults: false,
        onProgress: (item) => progressIds.push(item.id),
      },
    );

    // results not accumulated.
    expect(results).toHaveLength(0);
    // onProgress called for all items.
    expect(progressIds.sort()).toEqual(["p1", "p2"]);
  });

  it("collectResults defaults to true (default behaviour unchanged)", async () => {
    const backend = makeFakeBackend({ d1: {}, d2: {} });
    const runner = new BatchRunner(makeFakeAgent(), { concurrency: 2, backend });

    const { results, aggregate } = await runner.run([
      { id: "d1", input: "x" },
      { id: "d2", input: "y" },
    ]);

    expect(results).toHaveLength(2);
    expect(aggregate.successCount).toBe(2);
  });
});
