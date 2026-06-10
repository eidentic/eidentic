import { describe, it, expect } from "vitest";
import { InMemoryStore } from "../src/testing.js";
import { tokenize } from "../src/text.js";
import type { Scope } from "../src/index.js";

const s1: Scope = { kind: "user", agentId: "a", userId: "u1" };
const s2: Scope = { kind: "user", agentId: "a", userId: "u2" };

describe("tokenize", () => {
  it("lowercases unicode word tokens and drops punctuation", () => {
    expect(tokenize("Weather in Paris?")).toEqual(["weather", "in", "paris"]);
    expect(tokenize("İstanbul ☃ c++")).toEqual(["i̇stanbul", "c"]);
    expect(tokenize("?!")).toEqual([]);
  });
});

describe("InMemoryStore lexical memory", () => {
  it("indexes, searches by relevance within scope, and ignores other scopes", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.indexMemory([
      { scope: s1, id: "m1", text: "the weather in Paris is sunny" },
      { scope: s1, id: "m2", text: "I like programming in TypeScript" },
      { scope: s2, id: "m3", text: "weather weather weather" },
    ]);
    const hits = await store.searchMemory(s1, "Paris weather", 10);
    expect(hits.map((h) => h.id)).toContain("m1");
    expect(hits.map((h) => h.id)).not.toContain("m3"); // other scope excluded
    expect(hits.every((h) => h.score > 0)).toBe(true);
  });

  it("returns [] for an empty/punctuation-only query and never throws", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.indexMemory([{ scope: s1, id: "m1", text: "hello world" }]);
    expect(await store.searchMemory(s1, "?!", 10)).toEqual([]);
    expect(await store.searchMemory(s1, "", 10)).toEqual([]);
  });
});
