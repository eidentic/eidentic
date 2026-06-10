import { describe, it, expect } from "vitest";
import { InMemoryStore } from "@eidentic/types/testing";
import type { Scope } from "@eidentic/types";
import { Memory } from "@eidentic/memory";
import { memoryTools, isEditableMemory } from "../src/memory-tools.js";

const scope: Scope = { kind: "user", agentId: "a", userId: "u" };

function makeMem() {
  const store = new InMemoryStore();
  void store.migrate();
  const memory = new Memory({
    store,
    blocks: {
      human: { value: "", description: "facts about the user", limit: 20 },
      persona: { value: "I am helpful.", readOnly: true },
    },
    newId: ((n) => () => `arc${n++}`)(0),
  });
  return { store, memory };
}

const byId = (mem: ReturnType<typeof makeMem>["memory"], scope: Scope, id: string) => {
  const tools = memoryTools(mem, scope);
  const t = tools.find((x) => x.id === id);
  if (!t) throw new Error(`no tool ${id}`);
  return t;
};

describe("isEditableMemory", () => {
  it("accepts an editable memory and rejects a plain port", () => {
    const { memory } = makeMem();
    expect(isEditableMemory(memory)).toBe(true);
    expect(isEditableMemory({ getAlwaysInContext: async () => [], retrieve: async () => ({ snippets: [] }), ingest: async () => {} })).toBe(false);
  });
});

describe("memoryTools", () => {
  it("exposes exactly the four memory_* tools, all destructive", () => {
    const { memory } = makeMem();
    const tools = memoryTools(memory, scope);
    expect(tools.map((t) => t.id).sort()).toEqual(["memory_append", "memory_archive", "memory_replace", "memory_rewrite"]);
    expect(tools.every((t) => t.sideEffect === "destructive")).toBe(true);
  });

  it("memory_append succeeds and writes the block", async () => {
    const { memory, store } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_append").execute({ label: "human", text: "Name: Baran\n" });
    expect(out).toMatchObject({ ok: true, label: "human", version: 1, value: "Name: Baran\n" });
    expect((await store.getBlocks(scope)).find((b) => b.label === "human")!.value).toBe("Name: Baran\n");
  });

  it("memory_append returns {ok:false, reason:'limit'} without throwing", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_append").execute({ label: "human", text: "x".repeat(21) });
    expect(out).toMatchObject({ ok: false, reason: "limit" });
  });

  it("memory_append returns {ok:false, reason:'readonly'}", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_append").execute({ label: "persona", text: "x" });
    expect(out).toMatchObject({ ok: false, reason: "readonly" });
  });

  it("memory_replace returns conflict with current on stale version", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    await memory.append(scope, "human", "hello");
    const out = await byId(memory, scope, "memory_replace").execute({ label: "human", find: "hello", replace: "hi", version: 0 });
    expect(out).toMatchObject({ ok: false, reason: "conflict" });
    expect((out as { current?: { value: string } }).current?.value).toBe("hello");
  });

  it("memory_replace notfound / missing", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    await memory.append(scope, "human", "hello");
    const nf = await byId(memory, scope, "memory_replace").execute({ label: "human", find: "zzz", replace: "x", version: 1 });
    expect(nf).toMatchObject({ ok: false, reason: "notfound" });
    const ms = await byId(memory, scope, "memory_replace").execute({ label: "ghost", find: "a", replace: "b", version: 0 });
    expect(ms).toMatchObject({ ok: false, reason: "missing" });
  });

  it("memory_rewrite succeeds with correct version", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_rewrite").execute({ label: "human", value: "fresh", version: 0 });
    expect(out).toMatchObject({ ok: true, label: "human", version: 1, value: "fresh" });
  });

  it("memory_archive routes text into recall", async () => {
    const { memory } = makeMem();
    const out = await byId(memory, scope, "memory_archive").execute({ text: "Baran prefers TypeScript" });
    expect(out).toEqual({ ok: true });
    const { snippets } = await memory.retrieve({ text: "what does Baran prefer typescript", scope });
    expect(snippets.some((s) => s.text.includes("TypeScript"))).toBe(true);
  });
});

describe("Fix 4a — label validation in memory-tool writes", () => {
  it("memory_append rejects a label containing XML special chars (e.g. '</memory>')", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_append").execute({ label: "</memory>", text: "evil" });
    expect(out).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("memory_append rejects an empty label", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_append").execute({ label: "", text: "x" });
    expect(out).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("memory_append rejects a label longer than 64 chars", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_append").execute({ label: "a".repeat(65), text: "x" });
    expect(out).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("memory_append accepts valid identifiers (letters, digits, hyphens, underscores)", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    // Use a label that is in the pre-configured block schema so it is known.
    const out = await byId(memory, scope, "memory_append").execute({ label: "human", text: "valid\n" });
    expect(out).toMatchObject({ ok: true });
  });

  it("memory_replace rejects an invalid label", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_replace").execute({ label: "bad label!", find: "x", replace: "y", version: 0 });
    expect(out).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("memory_rewrite rejects an invalid label", async () => {
    const { memory } = makeMem();
    await memory.getAlwaysInContext(scope);
    const out = await byId(memory, scope, "memory_rewrite").execute({ label: "bad/label", value: "v", version: 0 });
    expect(out).toMatchObject({ ok: false, reason: "invalid" });
  });
});
