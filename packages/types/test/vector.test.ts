import { describe, it, expect } from "vitest";
import { InMemoryVectorStore, FakeEmbedder } from "../src/testing.js";
import type { Scope } from "../src/index.js";

const s1: Scope = { kind: "user", agentId: "a", userId: "u1" };
const s2: Scope = { kind: "user", agentId: "a", userId: "u2" };

describe("FakeEmbedder", () => {
  it("is deterministic and unit-length with a fixed dim", async () => {
    const e = new FakeEmbedder(8);
    const v = await e.embed("hello world");
    expect(v.length).toBe(8);
    expect(await e.embed("hello world")).toEqual(v); // deterministic
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(Math.abs(norm - 1)).toBeLessThan(1e-9);
  });
});

describe("InMemoryVectorStore", () => {
  it("ranks by cosine within scope, isolates scopes, upserts idempotently, deletes", async () => {
    const e = new FakeEmbedder(8);
    const store = new InMemoryVectorStore();
    const mk = async (id: string, scope: Scope, text: string) =>
      store.upsert({ id, scopeKey: `${scope.kind}:${scope.agentId}:${"userId" in scope ? scope.userId : ""}`, text, vector: await e.embed(text) });
    await mk("m1", s1, "typescript programming language");
    await mk("m2", s1, "weather forecast sunny");
    await mk("m3", s2, "typescript programming language");
    const q = await e.embed("typescript programming");
    const key1 = `user:a:u1`;
    const hits = await store.search(q, key1, 10);
    expect(hits[0]!.id).toBe("m1");
    expect(hits.map((h) => h.id)).not.toContain("m3"); // other scope
    // idempotent upsert
    await store.upsert({ id: "m1", scopeKey: key1, text: "changed", vector: await e.embed("changed") });
    expect((await store.search(await e.embed("changed"), key1, 10))[0]!.text).toBe("changed");
    // delete
    await store.delete("m1", key1);
    expect((await store.search(q, key1, 10)).find((h) => h.id === "m1")).toBeUndefined();
  });
});
