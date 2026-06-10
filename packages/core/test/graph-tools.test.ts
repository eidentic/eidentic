import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";
import { Memory } from "@eidentic/memory";
import { graphTools, hasGraph } from "../src/graph-tools.js";

const scope: Scope = { kind: "user", agentId: "a", userId: "u" };

function makeMem() {
  const store = new InMemoryStore();
  void store.migrate();
  const memory = new Memory({ store, graph: store });
  return memory;
}

const byId = (tools: ReturnType<typeof graphTools>, id: string) => {
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

describe("hasGraph", () => {
  it("returns true only when a graph backend is configured", () => {
    // WITH graph: should be true
    expect(hasGraph(makeMem())).toBe(true);
    // WITHOUT graph: must be false (Memory always has the methods, but graphEnabled === false)
    const store = new InMemoryStore();
    void store.migrate();
    expect(hasGraph(new Memory({ store }))).toBe(false);
    // WITH graph explicitly provided
    expect(hasGraph(new Memory({ store, graph: store }))).toBe(true);
    // Plain object without graphEnabled: false
    expect(hasGraph({ getAlwaysInContext: async () => [], retrieve: async () => ({ snippets: [] }), ingest: async () => {} })).toBe(false);
  });
});

describe("graphTools", () => {
  it("exposes exactly graph_query (read-only) and graph_assert (destructive)", () => {
    const tools = graphTools(makeMem(), scope);
    expect(tools.map((t) => t.id).sort()).toEqual(["graph_assert", "graph_query"]);
    expect(byId(tools, "graph_query").sideEffect).toBe("read-only");
    expect(byId(tools, "graph_assert").sideEffect).toBe("destructive");
  });

  it("graph_assert asserts a fact and returns {asserted, invalidated} compactly", async () => {
    const tools = graphTools(makeMem(), scope);
    const assert = byId(tools, "graph_assert");
    const r1 = (await assert.execute({ subject: "Baran", predicate: "favorite_language", object: "TypeScript" })) as {
      asserted: { subject: string; predicate: string; object: string }; invalidated: unknown[];
    };
    expect(r1.asserted.object).toBe("TypeScript");
    expect(r1.invalidated).toEqual([]);
  });

  it("graph_assert contradiction invalidates the prior fact", async () => {
    const mem = makeMem();
    const tools = graphTools(mem, scope);
    const assert = byId(tools, "graph_assert");
    await assert.execute({ subject: "Baran", predicate: "favorite_language", object: "TypeScript" });
    const r2 = (await assert.execute({ subject: "Baran", predicate: "favorite_language", object: "Rust" })) as {
      asserted: { object: string }; invalidated: Array<{ object: string }>;
    };
    expect(r2.asserted.object).toBe("Rust");
    expect(r2.invalidated.map((f) => f.object)).toEqual(["TypeScript"]);
  });

  it("graph_query returns currently-valid facts compactly", async () => {
    const mem = makeMem();
    const tools = graphTools(mem, scope);
    const assert = byId(tools, "graph_assert");
    const query = byId(tools, "graph_query");
    await assert.execute({ subject: "Baran", predicate: "favorite_language", object: "TypeScript" });
    const out = (await query.execute({ subject: "Baran" })) as { facts: Array<{ object: string }> };
    expect(out.facts.map((f) => f.object)).toEqual(["TypeScript"]);
  });

  it("graph_assert clamps confidence: 1e9 → 1, -5 → 0, missing → 1", async () => {
    const mem = makeMem();
    const tools = graphTools(mem, scope);
    const assert = byId(tools, "graph_assert");

    const r1 = (await assert.execute({ subject: "X", predicate: "p1", object: "v1", confidence: 1e9 })) as { asserted: { confidence: number } };
    expect(r1.asserted.confidence).toBe(1);

    const r2 = (await assert.execute({ subject: "X", predicate: "p2", object: "v2", confidence: -5 })) as { asserted: { confidence: number } };
    expect(r2.asserted.confidence).toBe(0);

    const r3 = (await assert.execute({ subject: "X", predicate: "p3", object: "v3" })) as { asserted: { confidence: number } };
    expect(r3.asserted.confidence).toBe(1);
  });

  it("graph_query supports point-in-time validAt", async () => {
    const mem = makeMem();
    await mem.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "TypeScript", validFrom: "2026-01-01T00:00:00.000Z" });
    await mem.assertFact(scope, { subject: "Baran", predicate: "favorite_language", object: "Rust", validFrom: "2026-03-01T00:00:00.000Z" });
    const query = byId(graphTools(mem, scope), "graph_query");
    const out = (await query.execute({ subject: "Baran", validAt: "2026-02-01T00:00:00.000Z" })) as { facts: Array<{ object: string }> };
    expect(out.facts.map((f) => f.object)).toEqual(["TypeScript"]);
  });
});
