import { describe, it, expect } from "vitest";
import { MockModel, InMemoryStore, storeConformanceCases, durableConformanceCases, EchoSandbox, sandboxConformanceCases } from "../src/testing.js";
import { textBlock, toolUseBlock, EVENT_SCHEMA_VERSION } from "../src/index.js";

describe("EchoSandbox conformance", () => {
  for (const c of sandboxConformanceCases(() => new EchoSandbox())) it(c.name, c.run);
});

describe("InMemoryStore conformance", () => {
  for (const c of storeConformanceCases(() => new InMemoryStore())) it(c.name, c.run);
});

describe("InMemoryStore durable conformance", () => {
  for (const c of durableConformanceCases(() => new InMemoryStore())) it(c.name, c.run);
});

describe("MockModel", () => {
  it("returns scripted responses in order", async () => {
    const m = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const r1 = await m.complete({ messages: [], tools: [] });
    expect(r1.content[0]).toMatchObject({ type: "tool_use", name: "ping" });
    const r2 = await m.complete({ messages: [], tools: [] });
    expect(r2.content[0]).toMatchObject({ type: "text", text: "done" });
    expect(m.calls.length).toBe(2);
  });
});

describe("InMemoryStore", () => {
  it("persists and reads events; CAS + append on blocks", async () => {
    const s = new InMemoryStore();
    await s.migrate();
    await s.createSession({ id: "s1", agentId: "a1", createdAt: "t0" });
    await s.appendEvents([
      { id: "e1", sessionId: "s1", seq: 0, kind: "user", schemaVersion: EVENT_SCHEMA_VERSION, payload: "hi", createdAt: "t0" },
    ]);
    expect((await s.readEvents("s1")).length).toBe(1);

    const scope = { kind: "agent", agentId: "a1" } as const;
    const b0 = await s.upsertBlock(scope, { label: "persona", value: "v1" });
    expect(b0.version).toBe(0);
    const b1 = await s.appendBlock(scope, "persona", " more");
    expect(b1.value).toBe("v1 more");
    await expect(s.upsertBlock(scope, { label: "persona", value: "x" }, 0)).rejects.toThrow();
  });
});

describe("InMemoryStore — assertFact idempotent path returns a clone (Fix 3)", () => {
  it("mutating the returned fact on the idempotent path does not corrupt the store", async () => {
    const s = new InMemoryStore();
    await s.migrate();
    const scope = { kind: "agent", agentId: "clone-test" } as const;
    const t1 = "2026-01-01T00:00:00.000Z";

    // First assert — establishes the fact.
    const r1 = await s.assertFact(scope, { subject: "S", predicate: "p", object: "O", validFrom: t1 });
    expect(r1.invalidated).toHaveLength(0);

    // Second assert with same object → idempotent path.
    const r2 = await s.assertFact(scope, { subject: "S", predicate: "p", object: "O", validFrom: t1 });
    expect(r2.invalidated).toHaveLength(0);
    expect(r2.asserted.id).toBe(r1.asserted.id); // same fact

    // Mutate the returned object — must NOT affect what the store returns next.
    (r2.asserted as { object: string }).object = "MUTATED";

    const [stored] = await s.queryFacts({ scope, subject: "S" });
    expect(stored?.object).toBe("O"); // store is unaffected
  });
});
