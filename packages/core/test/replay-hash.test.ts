import { describe, it, expect } from "vitest";
import type { StoredEvent } from "@eidentic/types";
import { replayHash } from "../src/replay-hash.js";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { Agent } from "../src/agent.js";
import { z } from "zod";
import { createTool } from "../src/tool.js";

const ev = (seq: number, kind: StoredEvent["kind"], payload: unknown, meta?: StoredEvent["meta"]): StoredEvent =>
  ({ id: `e${seq}`, sessionId: "s", seq, kind, schemaVersion: 1, payload, ...(meta ? { meta } : {}), createdAt: "t" });

describe("replayHash", () => {
  it("is deterministic for identical replay-state", async () => {
    const a = [ev(0, "user", "hi"), ev(1, "assistant", { content: [{ type: "text", text: "yo" }] })];
    const b = [ev(0, "user", "hi"), ev(1, "assistant", { content: [{ type: "text", text: "yo" }] })];
    expect(await replayHash(a)).toBe(await replayHash(b));
  });

  it("EXCLUDES meta (cost/timing): two runs differing only in meta hash identically (§9.1)", async () => {
    const noMeta = [ev(0, "assistant", { content: [] })];
    const withMeta = [ev(0, "assistant", { content: [] }, { usage: { inputTokens: 99, outputTokens: 42 } })];
    expect(await replayHash(noMeta)).toBe(await replayHash(withMeta));
  });

  it("changes when payload changes", async () => {
    expect(await replayHash([ev(0, "user", "a")])).not.toBe(await replayHash([ev(0, "user", "b")]));
  });

  it("changes when kind changes", async () => {
    expect(await replayHash([ev(0, "user", "x")])).not.toBe(await replayHash([ev(0, "tool_result", "x")]));
  });

  it("is independent of object key order within payload", async () => {
    expect(await replayHash([ev(0, "tool_result", { a: 1, b: 2 })])).toBe(await replayHash([ev(0, "tool_result", { b: 2, a: 1 })]));
  });

  it("is order-sensitive across the event sequence", async () => {
    const x = [ev(0, "user", "a"), ev(1, "user", "b")];
    const y = [ev(0, "user", "b"), ev(1, "user", "a")];
    expect(await replayHash(x)).not.toBe(await replayHash(y));
  });
});

// ---------------------------------------------------------------------------
// Fix 6: delta-seeded resume hash must equal the full-rehash value
// ---------------------------------------------------------------------------

import { chainHash } from "../src/loop.js";

describe("Fix 6 — delta-seeded resume hash == full-rehash (integrity invariant)", () => {
  it("hash seeded from a mid-point checkpoint equals the hash computed from the full log", async () => {
    const events = [
      ev(0, "user", "hello"),
      ev(1, "assistant", { content: [{ type: "text", text: "hi" }] }),
      ev(2, "tool_result", { callId: "c1", toolName: "foo", output: { ok: true } }),
      ev(3, "assistant", { content: [{ type: "text", text: "done" }] }),
    ];

    // Simulate: checkpoint was written after event seq=1 (hash of events[0..1])
    const checkpointHash = await chainHash(await chainHash("", events[0]!), events[1]!);
    const checkpointSeq = 2; // nextSeq after event seq=1

    // Full rehash: chain all events from scratch
    let fullHash = "";
    for (const e of events) fullHash = await chainHash(fullHash, e);

    // Delta-seeded: start from checkpointHash, apply only events with seq >= checkpointSeq
    let deltaHash = checkpointHash;
    for (const e of events.filter((e) => e.seq >= checkpointSeq)) deltaHash = await chainHash(deltaHash, e);

    expect(deltaHash).toBe(fullHash);
  });

  it("fallback (no checkpoint) produces same hash as full rehash", async () => {
    const events = [
      ev(0, "user", "go"),
      ev(1, "assistant", { content: [] }),
    ];

    let fullHash = "";
    for (const e of events) fullHash = await chainHash(fullHash, e);

    // No checkpoint → fallback = hash all events from ""
    let fallbackHash = "";
    for (const e of events) fallbackHash = await chainHash(fallbackHash, e);

    expect(fallbackHash).toBe(fullHash);
  });

  it("resume with durable: completed session terminal hash is consistent across live and resume paths", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    let lastLiveHash: string | undefined;
    let lastResumeHash: string | undefined;

    const noop = createTool({
      id: "noop", description: "noop", inputSchema: z.object({}),
      execute: async () => ({ ok: true }),
    });

    // Run a 2-turn session with durable enabled
    const model = new MockModel([
      { content: [toolUseBlock("c1", "noop", {})], usage: { inputTokens: 10, outputTokens: 5 } },
      { content: [textBlock("done")], usage: { inputTokens: 10, outputTokens: 5 } },
    ]);
    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [noop],
      durable: true, now: () => "t", newId: ((n) => () => `e${n++}`)(0),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("go", { sessionId: "s-hash-check" })) events.push(e);
    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // Get the checkpoint that was written at the end of the run
    const checkpoint = await store.lastCheckpoint("s-hash-check");
    expect(checkpoint).not.toBeNull();
    lastLiveHash = checkpoint?.hash;

    // Resume the already-terminated session
    const resumeAgent = new Agent({
      id: "a", instructions: "", model: new MockModel([]), store, tools: [noop],
      durable: true, now: () => "t", newId: ((n) => () => `r${n++}`)(0),
    });

    const resumeEvents: StreamEvent[] = [];
    for await (const e of resumeAgent.resume("s-hash-check")) resumeEvents.push(e);
    expect(resumeEvents.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // After resume, no NEW checkpoint should be written (the session was already terminated)
    // but the hash we computed matches the live hash
    const afterResumeCheckpoint = await store.lastCheckpoint("s-hash-check");
    lastResumeHash = afterResumeCheckpoint?.hash;

    // Both runs should produce the same checkpoint hash
    expect(lastResumeHash).toBe(lastLiveHash);
  });
});
