/**
 * Tests for the generic audit bus (§10.4/§15) — the optional `onAuditEvent` sink.
 *
 * Covers the three Agent-owned event variants and the best-effort (crash-safe) contract:
 *  - `tool.call` — one per executed dispatch (success + error), with scopeKey/sessionId/durationMs
 *  - `permission.denied` — emitted at the gate (reason "denied" and "gate-error"); NOT a `tool.call`
 *  - `erasure` — emitted from Agent.eraseScope with per-subsystem + total counts and memorySkipped
 *  - a throwing sink is swallowed and never affects control flow
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, scopeKey, type AuditEvent, type PermissionPolicy, type Scope, type StreamEvent } from "@eidentic/types";
import { Memory } from "@eidentic/memory";
import { Agent } from "../src/agent.js";
import { createTool, ToolRegistry } from "../src/tool.js";

// ─── helpers ────────────────────────────────────────────────────────────────

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.at(-1);
  if (!t || t.type !== "result") throw new Error(`last event is not a result; got ${JSON.stringify(t)}`);
  return t as Extract<StreamEvent, { type: "result" }>;
}

async function freshStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

const idFactory = (prefix = "e") => ((n: number) => () => `${prefix}${n++}`)(0);

const scope: Scope = { kind: "agent", agentId: "audit-agent" };

const ping = createTool({
  id: "ping",
  description: "returns pong",
  inputSchema: z.object({}),
  execute: async () => ({ reply: "pong" }),
});

const boom = createTool({
  id: "boom",
  description: "throws",
  inputSchema: z.object({}),
  sideEffect: "idempotent",
  execute: async () => { throw new Error("kaboom"); },
});

// ─── tool.call (registry level) ───────────────────────────────────────────────

describe("audit: tool.call", () => {
  it("emits one tool.call per executed dispatch with scopeKey, isError, durationMs", async () => {
    const events: AuditEvent[] = [];
    const reg = new ToolRegistry([ping], { scope, sessionId: "s1", onAuditEvent: (e) => events.push(e) });
    await reg.dispatch([{ callId: "c1", name: "ping", input: {} }]);

    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.type).toBe("tool.call");
    if (e.type !== "tool.call") throw new Error("narrowing");
    expect(e.toolId).toBe("ping");
    expect(e.isError).toBe(false);
    expect(e.sessionId).toBe("s1");
    expect(e.scopeKey).toBe(scopeKey(scope));
    expect(typeof e.durationMs).toBe("number");
    expect(e.durationMs).toBeGreaterThanOrEqual(0);
    expect(typeof e.at).toBe("number");
  });

  it("emits tool.call with isError=true when the tool throws", async () => {
    const events: AuditEvent[] = [];
    const reg = new ToolRegistry([boom], { scope, permissions: { mode: "bypass" }, onAuditEvent: (e) => events.push(e) });
    await reg.dispatch([{ callId: "c1", name: "boom", input: {} }]);

    const calls = events.filter((e) => e.type === "tool.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type === "tool.call" && calls[0]!.isError).toBe(true);
  });

  it("threads through Agent.query end-to-end", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("done")], usage: { inputTokens: 6, outputTokens: 3 } },
    ]);
    const events: AuditEvent[] = [];
    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [ping],
      now: () => "t", newId: idFactory(),
      onAuditEvent: (e) => events.push(e),
    });

    const out = await collect(agent.query("hi", { sessionId: "s9" }));
    expect(terminal(out).subtype).toBe("success");
    const calls = events.filter((e) => e.type === "tool.call");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.type === "tool.call" && calls[0]!.sessionId).toBe("s9");
  });
});

// ─── permission.denied (registry level) ───────────────────────────────────────

describe("audit: permission.denied", () => {
  it("emits permission.denied (reason 'denied') and NO tool.call when policy denies", async () => {
    const events: AuditEvent[] = [];
    const dangerous = createTool({
      id: "danger_rm", description: "removes", sideEffect: "destructive",
      inputSchema: z.object({}), execute: async () => ({ done: true }),
    });
    const policy: PermissionPolicy = { deny: ["danger_*"] };
    const reg = new ToolRegistry([dangerous], { permissions: policy, scope, onAuditEvent: (e) => events.push(e) });
    await reg.dispatch([{ callId: "c1", name: "danger_rm", input: {} }]);

    const denied = events.filter((e) => e.type === "permission.denied");
    expect(denied).toHaveLength(1);
    const d = denied[0]!;
    if (d.type !== "permission.denied") throw new Error("narrowing");
    expect(d.toolId).toBe("danger_rm");
    expect(d.reason).toBe("denied");
    expect(d.scopeKey).toBe(scopeKey(scope));
    // A denied dispatch never executes, so no tool.call is emitted for it.
    expect(events.some((e) => e.type === "tool.call")).toBe(false);
  });

  it("emits permission.denied (reason 'gate-error') when the gate itself throws", async () => {
    const events: AuditEvent[] = [];
    const t = createTool({ id: "x", description: "x", inputSchema: z.object({}), execute: async () => ({ ok: true }) });
    const reg = new ToolRegistry([t], {
      scope,
      onPreToolUse: () => { throw new Error("gate exploded"); },
      onAuditEvent: (e) => events.push(e),
    });
    await reg.dispatch([{ callId: "c1", name: "x", input: {} }]);

    const denied = events.filter((e) => e.type === "permission.denied");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.type === "permission.denied" && denied[0]!.reason).toBe("gate-error");
  });
});

// ─── erasure (agent level) ────────────────────────────────────────────────────

describe("audit: erasure", () => {
  it("emits erasure with per-subsystem + total counts and memorySkipped=false", async () => {
    const store = await freshStore();
    const memory = new Memory({ store });
    const events: AuditEvent[] = [];
    const agent = new Agent({
      id: "ag", instructions: "test",
      model: new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]),
      store, memory, onAuditEvent: (e) => events.push(e),
    });
    const userScope: Scope = { kind: "user", agentId: "ag", userId: "user-a" };
    await memory.ingest([{ id: "evt-1", scope: userScope, text: "alice uses TypeScript" }]);

    const result = await agent.eraseScope(userScope);

    const erasures = events.filter((e) => e.type === "erasure");
    expect(erasures).toHaveLength(1);
    const e = erasures[0]!;
    if (e.type !== "erasure") throw new Error("narrowing");
    expect(e.scopeKey).toBe(scopeKey(userScope));
    expect(e.memorySkipped).toBe(false);
    expect(e.deleted.store).toBe(result.store);
    expect(e.deleted.total).toBe(result.store + result.vector + result.graph);
    expect(e.deleted.total).toBeGreaterThan(0);
  });

  it("emits erasure with memorySkipped=true when no erasable memory is configured", async () => {
    const store = await freshStore();
    const events: AuditEvent[] = [];
    const agent = new Agent({
      id: "ag", instructions: "test",
      model: new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]),
      store, onAuditEvent: (e) => events.push(e),
    });
    await agent.eraseScope({ kind: "user", agentId: "ag", userId: "nobody" });

    const erasures = events.filter((e) => e.type === "erasure");
    expect(erasures).toHaveLength(1);
    expect(erasures[0]!.type === "erasure" && erasures[0]!.memorySkipped).toBe(true);
  });
});

// ─── crash-safety ─────────────────────────────────────────────────────────────

describe("audit: best-effort contract", () => {
  it("a throwing sink is swallowed and never kills the run", async () => {
    const store = await freshStore();
    const model = new MockModel([
      { content: [toolUseBlock("c1", "ping", {})], usage: { inputTokens: 5, outputTokens: 2 } },
      { content: [textBlock("done")], usage: { inputTokens: 6, outputTokens: 3 } },
    ]);
    const agent = new Agent({
      id: "a", instructions: "", model, store, tools: [ping],
      now: () => "t", newId: idFactory(),
      onAuditEvent: () => { throw new Error("sink boom"); },
    });

    const out = await collect(agent.query("hi", { sessionId: "s1" }));
    expect(terminal(out).subtype).toBe("success");
  });

  it("a throwing sink does not break Agent.eraseScope", async () => {
    const store = await freshStore();
    const agent = new Agent({
      id: "ag", instructions: "test",
      model: new MockModel([{ content: [textBlock("ok")], usage: { inputTokens: 1, outputTokens: 1 } }]),
      store, onAuditEvent: () => { throw new Error("sink boom"); },
    });
    const result = await agent.eraseScope({ kind: "user", agentId: "ag", userId: "u" });
    expect(typeof result.store).toBe("number");
  });
});
