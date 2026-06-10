/**
 * Tests for Agent.eraseScope — GDPR right-to-erasure fan-out coordinator (§15).
 *
 * Coverage:
 *  - Fan-out erases sessions, memory (store + vector + graph) in one call
 *  - Cross-scope isolation: erasing user A does NOT touch user B's data
 *  - Idempotent: repeated erase is a no-op success (no throw, deleted=0)
 *  - Adapter without eraseScope is skipped gracefully (memorySkipped=true)
 *  - No memory configured → store erased directly (memorySkipped=true)
 */

import { describe, it, expect } from "vitest";
import { InMemoryStore, InMemoryVectorStore, FakeEmbedder, MockModel } from "@eidentic/types/testing";
import type { Scope, MemoryPort, RetrievalQuery, RetrievedMemory, MemoryBlock } from "@eidentic/types";
import { textBlock } from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { Memory } from "@eidentic/memory";

const agentId = "ag-erase-test";

/** Minimal MockModel that always returns a single text response. */
function makeModel() {
  return new MockModel([
    { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);
}

// ─── Fan-out: erases store + memory ──────────────────────────────────────────────────────────────

describe("Agent.eraseScope — fan-out to store + memory", () => {
  it("erases sessions, FTS memory, and in-memory metadata for the user scope", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store });
    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store, memory });

    const scope: Scope = { kind: "user", agentId, userId: "user-a" };

    // Ingest memory for user A
    await memory.ingest([
      { id: "evt-1", scope, text: "alice uses TypeScript" },
      { id: "evt-2", scope, text: "alice prefers pnpm" },
    ]);

    // Verify data exists before erase
    const beforeBlocks = await store.getBlocks(scope);
    const beforeMem = await memory.retrieve({ text: "alice", scope });
    // At least the memory FTS entries should be findable
    expect(beforeMem.snippets.length).toBeGreaterThan(0);

    const result = await agent.eraseScope(scope);

    // eraseScope should report > 0 total deletions (FTS entries)
    expect(result.store).toBeGreaterThan(0);
    expect(result.vector).toBe(0); // no vector store configured
    expect(result.graph).toBe(0);  // no graph configured
    expect(result.memorySkipped).toBe(false);

    // Data must be gone
    const afterMem = await memory.retrieve({ text: "alice", scope });
    expect(afterMem.snippets.length).toBe(0);
  });

  it("erases vector entries when memory has a vector store", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(4);
    const memory = new Memory({ store, vector, embedder });
    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store, memory });

    const scope: Scope = { kind: "user", agentId, userId: "user-vec" };
    await memory.ingest([{ id: "v1", scope, text: "vector memory text" }]);

    // Confirm vector entry exists
    const qv = await embedder.embed("vector");
    const beforeSearch = await vector.search(qv, `user:${agentId}:user-vec`, 10);
    expect(beforeSearch.length).toBeGreaterThan(0);

    const result = await agent.eraseScope(scope);
    expect(result.vector).toBeGreaterThan(0);
    expect(result.memorySkipped).toBe(false);

    // Vector entries gone
    const afterSearch = await vector.search(qv, `user:${agentId}:user-vec`, 10);
    expect(afterSearch.length).toBe(0);
  });
});

// ─── Cross-scope isolation ────────────────────────────────────────────────────────────────────────

describe("Agent.eraseScope — cross-scope isolation (security)", () => {
  it("erasing user A leaves user B's data completely intact", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store });
    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store, memory });

    const scopeA: Scope = { kind: "user", agentId, userId: "user-alice" };
    const scopeB: Scope = { kind: "user", agentId, userId: "user-bob" };

    // Write memory for both users
    await memory.ingest([
      { id: "a1", scope: scopeA, text: "alice prefers TypeScript" },
      { id: "a2", scope: scopeA, text: "alice lives in Berlin" },
    ]);
    await memory.ingest([
      { id: "b1", scope: scopeB, text: "bob prefers Python" },
      { id: "b2", scope: scopeB, text: "bob lives in Amsterdam" },
    ]);

    // Write a block for scope B
    await store.upsertBlock(scopeB, { label: "human", value: "name: Bob" });

    // Erase ONLY scope A
    const result = await agent.eraseScope(scopeA);
    expect(result.store).toBeGreaterThan(0);
    expect(result.memorySkipped).toBe(false);

    // Scope A data must be gone
    const aliceAfter = await memory.retrieve({ text: "alice", scope: scopeA });
    expect(aliceAfter.snippets.length).toBe(0);

    // Scope B data MUST remain untouched
    const bobAfter = await memory.retrieve({ text: "bob", scope: scopeB });
    expect(bobAfter.snippets.length).toBeGreaterThan(0);
    expect(bobAfter.snippets.some((s) => s.id === "b1" || s.id === "b2")).toBe(true);

    // Bob's block must still exist
    const bobBlock = await store.getBlock(scopeB, "human");
    expect(bobBlock?.value).toBe("name: Bob");
  });

  it("erasing with vector store: cross-scope isolation preserved", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const vector = new InMemoryVectorStore();
    const embedder = new FakeEmbedder(4);
    const memory = new Memory({ store, vector, embedder });
    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store, memory });

    const scopeA: Scope = { kind: "user", agentId, userId: "iso-alice" };
    const scopeB: Scope = { kind: "user", agentId, userId: "iso-bob" };

    await memory.ingest([
      { id: "iso-a1", scope: scopeA, text: "alice data" },
      { id: "iso-b1", scope: scopeB, text: "bob data" },
    ]);

    // Erase A only
    await agent.eraseScope(scopeA);

    // B's vector must still be searchable
    const qv = await embedder.embed("bob");
    const bobVec = await vector.search(qv, `user:${agentId}:iso-bob`, 10);
    expect(bobVec.length).toBeGreaterThan(0);
    expect(bobVec[0]!.id).toBe("iso-b1");

    // A's vector must be gone
    const aliceVec = await vector.search(qv, `user:${agentId}:iso-alice`, 10);
    expect(aliceVec.length).toBe(0);
  });
});

// ─── Idempotency ─────────────────────────────────────────────────────────────────────────────────

describe("Agent.eraseScope — idempotent", () => {
  it("erasing an already-erased scope is a no-op success (deleted=0, no throw)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const memory = new Memory({ store });
    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store, memory });

    const scope: Scope = { kind: "user", agentId, userId: "idem-user" };
    await memory.ingest([{ id: "idem-1", scope, text: "some fact" }]);

    // First erase
    const first = await agent.eraseScope(scope);
    expect(first.store).toBeGreaterThan(0);

    // Second erase must be a no-op (0 deleted), must not throw
    const second = await agent.eraseScope(scope);
    expect(second.store).toBe(0);
    expect(second.vector).toBe(0);
    expect(second.graph).toBe(0);
    expect(second.memorySkipped).toBe(false);
  });
});

// ─── Graceful degradation when memory lacks eraseScope ───────────────────────────────────────────

describe("Agent.eraseScope — graceful degradation", () => {
  it("memory adapter without eraseScope is skipped, not crashed", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    // A bare MemoryPort that intentionally lacks eraseScope
    const legacyMemory: MemoryPort = {
      getAlwaysInContext: async () => [] as MemoryBlock[],
      retrieve: async (_q: RetrievalQuery): Promise<RetrievedMemory> => ({ snippets: [] }),
      ingest: async () => {},
      // No eraseScope — simulates a pre-§15 adapter
    };

    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store, memory: legacyMemory });

    const scope: Scope = { kind: "user", agentId, userId: "legacy-user" };

    // Add data directly to the store (bypassing legacy memory adapter)
    await store.upsertBlock(scope, { label: "test", value: "data" });
    await store.indexMemory([{ scope, id: "leg-1", text: "some text" }]);

    // Must NOT throw — store is erased directly
    const result = await agent.eraseScope(scope);

    expect(result.memorySkipped).toBe(true);
    expect(result.store).toBeGreaterThan(0); // blocks + FTS entries deleted
    expect(result.vector).toBe(0);
    expect(result.graph).toBe(0);
  });

  it("no memory configured at all — store erased directly, memorySkipped=true", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const agent = new Agent({ id: agentId, instructions: "test", model: makeModel(), store });

    const scope: Scope = { kind: "user", agentId, userId: "no-mem-user" };
    await store.upsertBlock(scope, { label: "info", value: "hello" });

    const result = await agent.eraseScope(scope);

    expect(result.memorySkipped).toBe(true);
    expect(result.store).toBeGreaterThan(0);

    // Block must be gone
    const block = await store.getBlock(scope, "info");
    expect(block).toBeNull();
  });
});
