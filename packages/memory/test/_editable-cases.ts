import { expect } from "vitest";
import type { EditableMemoryPort, Scope, StorePort } from "@eidentic/types";

const scope: Scope = { kind: "user", agentId: "a", userId: "u" };

/** Shared behavioral suite run against Memory (lexical and semantic modes). `store` is the same store the memory wraps. */
export function editableMemoryCases(
  makeMemory: () => { memory: EditableMemoryPort; store: StorePort },
): Array<{ name: string; run: () => Promise<void> }> {
  return [
    { name: "getAlwaysInContext seeds configured-but-absent blocks once, merges metadata", run: async () => {
      const { memory, store } = makeMemory();
      const blocks = await memory.getAlwaysInContext(scope);
      const human = blocks.find((b) => b.label === "human");
      expect(human).toBeTruthy();
      expect(human!.value).toBe("");
      expect(human!.description).toBe("facts about the user");
      expect(human!.limit).toBe(20);
      const again = await memory.getAlwaysInContext(scope);
      expect(again.find((b) => b.label === "human")!.version).toBe(human!.version);
      expect((await store.getBlocks(scope)).some((b) => b.label === "human")).toBe(true);
    } },
    { name: "append happy path bumps version and returns ok", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      const r = await memory.append(scope, "human", "Name: Baran\n");
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.block.value).toBe("Name: Baran\n"); expect(r.block.version).toBe(1); }
    } },
    { name: "append on readOnly block is rejected", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      const r = await memory.append(scope, "persona", "x");
      expect(r).toMatchObject({ ok: false, reason: "readonly" });
    } },
    { name: "append over limit is rejected", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      const r = await memory.append(scope, "human", "x".repeat(21));
      expect(r).toMatchObject({ ok: false, reason: "limit" });
    } },
    { name: "replace replaces ALL occurrences with correct version", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      await memory.append(scope, "human", "ab ab");
      const r = await memory.replace(scope, "human", "ab", "Z", 1);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.block.value).toBe("Z Z");
    } },
    { name: "replace with stale version returns conflict + current", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      await memory.append(scope, "human", "hello");
      const r = await memory.replace(scope, "human", "hello", "hi", 0);
      expect(r.ok).toBe(false);
      if (!r.ok) { expect(r.reason).toBe("conflict"); expect(r.current!.value).toBe("hello"); expect(r.current!.version).toBe(1); }
    } },
    { name: "replace find-not-present returns notfound", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      await memory.append(scope, "human", "hello");
      const r = await memory.replace(scope, "human", "zzz", "x", 1);
      expect(r).toMatchObject({ ok: false, reason: "notfound" });
    } },
    { name: "replace on absent block returns missing", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      const r = await memory.replace(scope, "ghost", "a", "b", 0);
      expect(r).toMatchObject({ ok: false, reason: "missing" });
    } },
    { name: "rewrite happy path with correct version", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      const r = await memory.rewrite(scope, "human", "fresh", 0);
      expect(r.ok).toBe(true);
      if (r.ok) { expect(r.block.value).toBe("fresh"); expect(r.block.version).toBe(1); }
    } },
    { name: "rewrite with stale version returns conflict", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      await memory.append(scope, "human", "x");
      const r = await memory.rewrite(scope, "human", "y", 0);
      expect(r).toMatchObject({ ok: false, reason: "conflict" });
    } },
    { name: "rewrite over limit is rejected", run: async () => {
      const { memory } = makeMemory();
      await memory.getAlwaysInContext(scope);
      const r = await memory.rewrite(scope, "human", "x".repeat(21), 0);
      expect(r).toMatchObject({ ok: false, reason: "limit" });
    } },
    { name: "archive routes text into retrieve()/recall", run: async () => {
      const { memory } = makeMemory();
      await memory.archive(scope, "Baran prefers TypeScript and pnpm");
      const { snippets } = await memory.retrieve({ text: "what does Baran prefer typescript", scope });
      expect(snippets.some((s) => s.text.includes("TypeScript"))).toBe(true);
    } },
  ];
}
