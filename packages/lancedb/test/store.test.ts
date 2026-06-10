import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vectorConformanceCases } from "@eidentic/types/testing";
import { LanceDBVectorStore } from "../src/index.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("LanceDBVectorStore conformance", () => {
  for (const c of vectorConformanceCases(async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-lance-"));
    dirs.push(dir);
    return LanceDBVectorStore.open(dir, "memories", 4); // 4-dim to match the conformance vectors
  })) it(c.name, c.run);
});

describe("LanceDBVectorStore SQL filter hardening", () => {
  it("handles single-quotes in id and scopeKey (upsert + scoped search + delete)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-lance-quote-"));
    dirs.push(dir);
    const store = await LanceDBVectorStore.open(dir, "memories", 3);

    const quotedId = "it's-1";
    const quotedScope = "o'brien";
    const otherScope = "plain-scope";
    const vec: number[] = [1, 0, 0];

    await store.upsert({ id: quotedId, scopeKey: quotedScope, text: "hello", vector: vec });
    await store.upsert({ id: "other-1", scopeKey: otherScope, text: "world", vector: vec });

    const hits = await store.search(vec, quotedScope, 10);
    expect(hits.map((h) => h.id)).toContain(quotedId);
    expect(hits.every((h) => h.id !== "other-1")).toBe(true);

    await store.delete(quotedId, quotedScope);
    const hitsAfterDelete = await store.search(vec, quotedScope, 10);
    expect(hitsAfterDelete.every((h) => h.id !== quotedId)).toBe(true);
  });

  it("handles backslash in id and scopeKey", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-lance-backslash-"));
    dirs.push(dir);
    const store = await LanceDBVectorStore.open(dir, "memories", 3);

    const backslashId = "path\\to\\item";
    const backslashScope = "scope\\foo";
    const vec: number[] = [0, 1, 0];

    await store.upsert({ id: backslashId, scopeKey: backslashScope, text: "backslash-test", vector: vec });

    const hits = await store.search(vec, backslashScope, 10);
    expect(hits.map((h) => h.id)).toContain(backslashId);

    await store.delete(backslashId, backslashScope);
    const hitsAfterDelete = await store.search(vec, backslashScope, 10);
    expect(hitsAfterDelete.every((h) => h.id !== backslashId)).toBe(true);
  });

  it("rejects id containing a NUL byte with a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-lance-nul-"));
    dirs.push(dir);
    const store = await LanceDBVectorStore.open(dir, "memories", 3);

    await expect(
      store.search([1, 0, 0], "scope\x00injected", 10),
    ).rejects.toThrow(/NUL or control character/);
  });

  it("rejects id containing an ASCII control character with a clear error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "eidentic-lance-ctrl-"));
    dirs.push(dir);
    const store = await LanceDBVectorStore.open(dir, "memories", 3);

    await expect(
      store.delete("id\x01bad", "scope"),
    ).rejects.toThrow(/NUL or control character/);
  });
});
