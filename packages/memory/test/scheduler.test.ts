import { describe, it, expect } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder, MockModel } from "@eidentic/types/testing";
import { toolUseBlock, type Scope, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";
import { Consolidator } from "../src/consolidate.js";
import { Memory } from "../src/memory.js";
import { ConsolidationScheduler } from "../src/scheduler.js";

const scopeA: Scope = { kind: "agent", agentId: "sched-a" };
const scopeB: Scope = { kind: "agent", agentId: "sched-b" };

/** Source text — must be non-empty so the Consolidator actually calls the model. */
const SRC = "The user likes TypeScript and works as an engineer.";

/** Empty facts response with controllable usage. */
function recResponse(usage: { inputTokens: number; outputTokens: number }): ModelResponse {
  return {
    content: [toolUseBlock("c1", "record_facts", { facts: [] })],
    usage,
  };
}

/** Merge-passages response. */
function mergeResponse(passage: string, usage: { inputTokens: number; outputTokens: number }): ModelResponse {
  return {
    content: [toolUseBlock("m1", "merge_passages", { passage })],
    usage,
  };
}

/**
 * GatedModel: each call increments `calls`, then awaits a manually-released promise.
 * `releaseAll()` resolves all pending calls at once.
 */
class GatedModel implements ModelPort {
  calls = 0;
  private gates: Array<() => void> = [];

  constructor(private readonly response: ModelResponse) {}

  async complete(_req: ModelRequest): Promise<ModelResponse> {
    this.calls += 1;
    await new Promise<void>((resolve) => {
      this.gates.push(resolve);
    });
    return this.response;
  }

  releaseAll(): void {
    const pending = this.gates.splice(0);
    for (const r of pending) r();
  }
}

function makeStack(distModel: ModelPort) {
  const store = new InMemoryStore();
  const vector = new InMemoryVectorStore();
  const embedder = new FakeEmbedder(16);
  const memory = new Memory({ store, graph: store, vector, embedder });
  const consolidator = new Consolidator({ model: distModel, graph: store });
  return { store, memory, consolidator };
}

describe("ConsolidationScheduler", () => {
  it("two concurrent schedule() calls run the consolidator EXACTLY ONCE; a third coalesces", async () => {
    const model = new GatedModel(recResponse({ inputTokens: 10, outputTokens: 5 }));
    const { memory, consolidator } = makeStack(model);
    const sched = new ConsolidationScheduler({ consolidator, memory, text: SRC });

    const p1 = sched.schedule(scopeA);
    const p2 = sched.schedule(scopeA);
    // p1 and p2 must be the same promise (single-flight coalescing)
    expect(p1).toBe(p2);

    const p3 = sched.schedule(scopeA);
    // p3 also coalesces into p1 (queued follow-up, but returns in-flight promise)
    expect(p3).toBe(p1);

    // Only ONE model call so far (the first pass)
    expect(model.calls).toBe(1);

    // Release the first pass
    model.releaseAll();
    await Promise.all([p1, p2, p3]);

    // Allow the finally() + queued follow-up to fire
    await new Promise<void>((r) => setTimeout(r, 0));

    // Release the coalesced follow-up pass
    model.releaseAll();
    await new Promise<void>((r) => setTimeout(r, 0));

    // Exactly two passes total: first pass + one coalesced follow-up
    expect(model.calls).toBe(2);
  });

  it("runNow aggregates distillation + dedupe usage; sweep counts", async () => {
    const distModel = new MockModel([recResponse({ inputTokens: 100, outputTokens: 40 })]);
    const mergeModel = new MockModel([mergeResponse("canonical passage", { inputTokens: 30, outputTokens: 10 })]);

    const store = new InMemoryStore();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(16);
    // dedupeOnWrite: false — intentionally seeds two identical passages to exercise deduplicateArchival
    const memory = new Memory({ store, graph: store, vector, embedder, dedupeOnWrite: false });
    const consolidator = new Consolidator({ model: distModel, graph: store });

    // Seed a TTL'd fact that is already expired at the sweep time
    const T0 = "2026-01-01T00:00:00.000Z";
    await store.assertFact(scopeA, {
      subject: "Session",
      predicate: "token",
      object: "abc123",
      validFrom: T0,
      ttlMs: 60_000, // expires at 00:01:00
    });

    // Seed a no-TTL fact (should survive)
    await store.assertFact(scopeA, {
      subject: "User",
      predicate: "name",
      object: "Baran",
      validFrom: T0,
    });

    // Ingest two near-identical passages so dedup finds them
    await memory.ingest([
      { scope: scopeA, id: "p1", text: "the user prefers dark mode" },
      { scope: scopeA, id: "p2", text: "the user prefers dark mode" },
    ]);

    const sched = new ConsolidationScheduler({
      consolidator,
      memory,
      text: SRC,
      dedupe: { threshold: 0.95, mergeModel },
      now: () => "2026-01-01T01:00:00.000Z",
    });

    const result = await sched.runNow(scopeA);

    expect(result.swept).toBe(1);
    expect(result.merged).toBe(1);
    expect(result.usage).toEqual({ inputTokens: 130, outputTokens: 50 });
    expect(result.dedupe).toMatchObject({ comparisons: 1, totalPairs: 1, truncated: false });
  });

  it("skips dedupe when not configured", async () => {
    const distModel = new MockModel([recResponse({ inputTokens: 5, outputTokens: 2 })]);

    const store = new InMemoryStore();
    const memory = new Memory({ store, graph: store });
    const consolidator = new Consolidator({ model: distModel, graph: store });

    const sched = new ConsolidationScheduler({ consolidator, memory, text: SRC });

    const result = await sched.runNow(scopeA);

    expect(result.merged).toBe(0);
    expect(result.usage).toEqual({ inputTokens: 5, outputTokens: 2 });
    expect(result.dedupe).toBeUndefined();
  });

  it("runs distinct scopes independently (per-scope isolation)", async () => {
    const model = new GatedModel(recResponse({ inputTokens: 10, outputTokens: 5 }));
    const { memory, consolidator } = makeStack(model);
    const sched = new ConsolidationScheduler({ consolidator, memory, text: SRC });

    const pa = sched.schedule(scopeA);
    const pb = sched.schedule(scopeB);

    // Different scopes → different promises (independent passes)
    expect(pa).not.toBe(pb);
    // Both passes started immediately (two model calls)
    expect(model.calls).toBe(2);

    model.releaseAll();
    await Promise.all([pa, pb]);
  });
});
