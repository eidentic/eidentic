import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { toolUseBlock, type Scope, type GraphPort } from "@eidentic/types";
import { Consolidator } from "../src/consolidate.js";

const scope: Scope = { kind: "user", agentId: "a", userId: "u" };

const rec = (facts: unknown[]) => ({
  content: [toolUseBlock("c1", "record_facts", { facts })],
  usage: { inputTokens: 5, outputTokens: 5 },
});

describe("Consolidator", () => {
  it("(a) asserts grounded facts into the graph and surfaces usage", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Baran loves TypeScript and works as an engineer.";
    const model = new MockModel([
      rec([
        { subject: "Baran", predicate: "loves", object: "TypeScript", sourceQuote: "Baran loves TypeScript" },
        { subject: "Baran", predicate: "role", object: "engineer", sourceQuote: "works as an engineer" },
      ]),
    ]);
    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts.map((f) => f.object).sort()).toEqual(["TypeScript", "engineer"]);
    expect(r.dropped).toHaveLength(0);
    expect(r.usage.inputTokens).toBe(5);
    expect(r.usage.outputTokens).toBe(5);

    const inGraph = await store.queryFacts({ scope });
    expect(inGraph).toHaveLength(2);
  });

  it("(b) drops an ungrounded fact (sourceQuote not present in source), does not assert it", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Alice likes Python.";
    const model = new MockModel([
      rec([
        // grounded — quote exists in src
        { subject: "Alice", predicate: "likes", object: "Python", sourceQuote: "Alice likes Python" },
        // ungrounded — quote not in source
        { subject: "Alice", predicate: "hates", object: "Java", sourceQuote: "Alice absolutely hates Java" },
      ]),
    ]);
    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.object).toBe("Python");
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]!.object).toBe("Java");

    const inGraph = await store.queryFacts({ scope });
    expect(inGraph).toHaveLength(1);
  });

  it("(c) returns empty result without calling the model when source is empty", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([]); // no scripted responses — a call would throw
    const c = new Consolidator({ model, graph: store });

    const r = await c.consolidate({ scope, text: "   " });

    expect(r.facts).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);
    expect(r.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    expect(model.calls).toHaveLength(0);
  });

  it("(d) model returns no record_facts call → empty result", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Some text without any tool call response.";
    // model returns a text block only — no tool use
    const model = new MockModel([
      { content: [{ type: "text", text: "I see." }], usage: { inputTokens: 3, outputTokens: 2 } },
    ]);
    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);
    expect(r.usage).toEqual({ inputTokens: 3, outputTokens: 2 });

    const inGraph = await store.queryFacts({ scope });
    expect(inGraph).toHaveLength(0);
  });

  it("(e) sessionId path reads events from the store and distills them", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.createSession({ id: "sess1", agentId: "a", createdAt: new Date().toISOString() });
    await store.appendEvents([
      {
        id: "ev1", sessionId: "sess1", seq: 0, kind: "user",
        schemaVersion: 1, payload: "My name is Carol and I am a designer.",
        createdAt: new Date().toISOString(),
      },
      {
        id: "ev2", sessionId: "sess1", seq: 1, kind: "assistant",
        schemaVersion: 1,
        payload: { content: [{ type: "text", text: "Nice to meet you, Carol!" }] },
        createdAt: new Date().toISOString(),
      },
    ]);

    const model = new MockModel([
      rec([
        { subject: "Carol", predicate: "occupation", object: "designer", sourceQuote: "I am a designer" },
      ]),
    ]);
    const c = new Consolidator({ model, graph: store, store });
    const r = await c.consolidate({ scope, sessionId: "sess1" });

    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.object).toBe("designer");

    const inGraph = await store.queryFacts({ scope });
    expect(inGraph).toHaveLength(1);
  });

  it("(g) non-array facts in tool response — does not throw, returns empty facts", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Some source text for non-array test.";
    const model = new MockModel([
      {
        content: [toolUseBlock("c1", "record_facts", { facts: { not: "an array" } })],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);
    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);

    const inGraph = await store.queryFacts({ scope });
    expect(inGraph).toHaveLength(0);
  });

  it("(h) null/primitive items in facts array — only valid object items are asserted", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Baran likes TS programming and other things.";
    const model = new MockModel([
      {
        content: [
          toolUseBlock("c1", "record_facts", {
            facts: [
              null,
              42,
              "x",
              { subject: "Baran", predicate: "likes", object: "TS", sourceQuote: "Baran likes TS programming" },
            ],
          }),
        ],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);
    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    // Only the well-formed object fact passes — others are filtered before grounding check
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0]!.object).toBe("TS");
    expect(r.dropped).toHaveLength(0);
  });

  it("(i) sourceQuote shorter than 8 chars — fact is dropped even if quote is in source", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Baran uses TS every day.";
    const model = new MockModel([
      {
        content: [
          toolUseBlock("c1", "record_facts", {
            facts: [
              // short quote — exactly "TS" (2 chars), present in source but below MIN_QUOTE_LEN
              { subject: "Baran", predicate: "uses", object: "TS", sourceQuote: "TS" },
              // whitespace-only quote — should also be dropped
              { subject: "Baran", predicate: "uses", object: "nothing", sourceQuote: "  " },
            ],
          }),
        ],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);
    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts).toHaveLength(0);
    expect(r.dropped).toHaveLength(2);

    const inGraph = await store.queryFacts({ scope });
    expect(inGraph).toHaveLength(0);
  });

  it("(j) assertFact throwing — fact goes to dropped, consolidate does not throw, other facts proceed", async () => {
    const src = "Dana loves Elixir and also loves coffee every morning.";

    const throwingGraph: GraphPort = {
      assertFact: async () => {
        throw new Error("temporal order violation");
      },
      queryFacts: async () => [],
    };

    const model = new MockModel([
      {
        content: [
          toolUseBlock("c1", "record_facts", {
            facts: [
              { subject: "Dana", predicate: "loves", object: "Elixir", sourceQuote: "Dana loves Elixir" },
              { subject: "Dana", predicate: "drinks", object: "coffee", sourceQuote: "loves coffee every morning" },
            ],
          }),
        ],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);

    const c = new Consolidator({ model, graph: throwingGraph });
    const r = await c.consolidate({ scope, text: src });

    // Both facts are grounded but assertFact always throws → both end up in rejected (not dropped)
    expect(r.facts).toHaveLength(0);
    expect(r.dropped).toHaveLength(0);
    expect(r.rejected).toHaveLength(2);
    // The consolidate call itself must not throw
  });

  it("(k) temporal-order violation lands in rejected (not dropped), consolidate does not throw", async () => {
    const src = "Eve prefers Haskell for all tasks.";

    // A graph that throws only on the second call (simulating temporal-order guard rejecting a back-dated update)
    let callCount = 0;
    const temporalGraph: GraphPort = {
      assertFact: async () => {
        callCount += 1;
        if (callCount === 1) throw new Error("temporal order violation: validFrom before current validFrom");
        return { asserted: { id: "f1", subject: "Eve", predicate: "prefers", object: "Haskell", objectKind: "literal", confidence: 1, validFrom: "2026-01-01T00:00:00.000Z" }, invalidated: [] };
      },
      queryFacts: async () => [],
    };

    const model = new MockModel([
      rec([
        // grounded — will hit the temporal guard and be rejected
        { subject: "Eve", predicate: "prefers", object: "Haskell", sourceQuote: "Eve prefers Haskell for all tasks" },
        // grounded — succeeds
        { subject: "Eve", predicate: "uses", object: "Haskell", sourceQuote: "Eve prefers Haskell for all" },
      ]),
    ]);

    const c = new Consolidator({ model, graph: temporalGraph });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts).toHaveLength(1);
    expect(r.dropped).toHaveLength(0);
    expect(r.rejected).toHaveLength(1);
    expect(r.rejected[0]!.object).toBe("Haskell");
  });

  it("(l) confidence is clamped: 1e9 → 1, -5 → 0, NaN/Infinity/missing → 1", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src = "Frank loves Go and hates PHP and drinks coffee and eats sushi and runs daily and sleeps well.";

    const model = new MockModel([
      rec([
        { subject: "Frank", predicate: "loves", object: "Go", sourceQuote: "Frank loves Go and hates PHP", confidence: 1e9 },
        { subject: "Frank", predicate: "hates", object: "PHP", sourceQuote: "loves Go and hates PHP and drinks", confidence: -5 },
        { subject: "Frank", predicate: "drinks", object: "coffee", sourceQuote: "hates PHP and drinks coffee and eats", confidence: NaN },
        { subject: "Frank", predicate: "eats", object: "sushi", sourceQuote: "drinks coffee and eats sushi and runs", confidence: Infinity },
        { subject: "Frank", predicate: "runs", object: "daily", sourceQuote: "eats sushi and runs daily and sleeps" },
      ]),
    ]);

    const c = new Consolidator({ model, graph: store });
    const r = await c.consolidate({ scope, text: src });

    expect(r.facts).toHaveLength(5);
    const byObject = Object.fromEntries(r.facts.map((f) => [f.object, f.confidence]));
    expect(byObject["Go"]).toBe(1);       // 1e9 → 1
    expect(byObject["PHP"]).toBe(0);      // -5 → 0
    expect(byObject["coffee"]).toBe(1);   // NaN → 1
    expect(byObject["sushi"]).toBe(1);    // Infinity → 1
    expect(byObject["daily"]).toBe(1);    // missing → 1
  });

  it("(f) second consolidation asserting a contradicting object invalidates the first (functional predicate)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const src1 = "Baran loves TypeScript.";
    const src2 = "Baran now loves Rust.";

    const t1 = "2026-01-01T00:00:00.000Z";
    const t2 = "2026-06-01T00:00:00.000Z";

    const model1 = new MockModel([
      rec([{ subject: "Baran", predicate: "loves", object: "TypeScript", sourceQuote: "Baran loves TypeScript" }]),
    ]);
    const c1 = new Consolidator({ model: model1, graph: store, now: () => t1 });
    await c1.consolidate({ scope, text: src1 });

    const model2 = new MockModel([
      rec([{ subject: "Baran", predicate: "loves", object: "Rust", sourceQuote: "Baran now loves Rust" }]),
    ]);
    const c2 = new Consolidator({ model: model2, graph: store, now: () => t2 });
    await c2.consolidate({ scope, text: src2 });

    // Only the new fact should be currently valid
    const current = await store.queryFacts({ scope, subject: "Baran", predicate: "loves" });
    expect(current).toHaveLength(1);
    expect(current[0]!.object).toBe("Rust");

    // Full history should show both
    const all = await store.queryFacts({ scope, subject: "Baran", predicate: "loves", includeInvalidated: true });
    expect(all).toHaveLength(2);
    const objects = all.map((f) => f.object);
    expect(objects).toContain("TypeScript");
    expect(objects).toContain("Rust");
  });
});
