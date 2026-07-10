import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";

/** Plays scripted responses; records how many times it was asked (proves zero-compute-while-suspended). */
class ScriptModel implements ModelPort {
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly scripted: ModelResponse[]) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const r = this.scripted[this.i++];
    if (!r) throw new Error(`ScriptModel: no scripted response #${this.i}`);
    return r;
  }
}

/** A refund tool that suspends for approval; on approval increments a SHARED counter exactly once. */
function makeRefundTool(state: { refunds: number }) {
  return createTool({
    id: "request_refund",
    description: "Issue a refund after human approval (destructive).",
    sideEffect: "destructive",
    inputSchema: z.object({ amount: z.number() }),
    idempotencyKey: (i) => `refund:${i.amount}`,
    execute: async ({ input, ctx }) => {
      const decision = await ctx!.suspend!({ reason: "approve refund", present: { amount: input.amount } });
      if (!decision.approved) return { refunded: false };
      state.refunds += 1; // the real side effect — must run EXACTLY ONCE
      return { refunded: true, amount: input.amount };
    },
  });
}

const newIdFactory = (p: string) => ((n) => () => `${p}${n++}`)(0);

describe("§5.7/§9.4 human-in-the-loop durable suspension", () => {
  it("first run yields subtype:'suspended' with the request, and writes NO tool_result; zero compute after", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const state = { refunds: 0 };
    const model = new ScriptModel([
      { content: [toolUseBlock("c1", "request_refund", { amount: 50 })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model, store, tools: [makeRefundTool(state)], durable: true, now: () => "t", newId: newIdFactory("e") });

    const events = [];
    for await (const e of agent.query("refund 50", { sessionId: "s" })) events.push(e);

    const last = events.at(-1)!;
    expect(last).toMatchObject({ type: "result", subtype: "suspended", callId: "c1" });
    expect((last as any).request).toEqual({ reason: "approve refund", present: { amount: 50 } });
    // No tool_result emitted for the suspended call:
    expect(events.some((e) => e.type === "tool.result" && (e as any).callId === "c1")).toBe(false);
    // Side effect NOT yet applied:
    expect(state.refunds).toBe(0);
    // Zero compute while suspended: the model was asked exactly once (the suspend turn), never again.
    expect(model.calls.length).toBe(1);
  });

  it("resume with {approved:true} completes and applies the refund EXACTLY ONCE", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const state = { refunds: 0 };
    const refund = makeRefundTool(state);

    // Run 1: suspend.
    const m1 = new ScriptModel([
      { content: [toolUseBlock("c1", "request_refund", { amount: 50 })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a1 = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model: m1, store, tools: [refund], durable: true, now: () => "t", newId: newIdFactory("e") });
    for await (const _ of a1.query("refund 50", { sessionId: "s" })) { /* drain */ }
    expect(state.refunds).toBe(0);

    // Run 2: resume with the decision. The persisted tool_use is re-dispatched DIRECTLY (callId-stable,
    // no model re-emit). The model is called only ONCE for the final text after the tool_result is in.
    const m2 = new ScriptModel([
      { content: [textBlock("refund approved and processed")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a2 = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model: m2, store, tools: [refund], durable: true, now: () => "t", newId: newIdFactory("r") });
    const resumed = [];
    for await (const e of a2.resume("s", { decision: { approved: true } })) resumed.push(e);

    expect(resumed.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "refund approved and processed" });
    expect(state.refunds).toBe(1); // EXACTLY ONCE across suspend→resume
    // Model was called exactly once (for the post-tool final answer), NOT to re-emit the tool_use.
    expect(m2.calls.length).toBe(1);
  });

  it("resume with {approved:false} declines (refund stays 0)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const state = { refunds: 0 };
    const refund = makeRefundTool(state);

    const m1 = new ScriptModel([
      { content: [toolUseBlock("c1", "request_refund", { amount: 50 })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a1 = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model: m1, store, tools: [refund], durable: true, now: () => "t", newId: newIdFactory("e") });
    for await (const _ of a1.query("refund 50", { sessionId: "s" })) { /* drain */ }

    // Resume: the persisted tool_use is re-dispatched directly (no model re-emit).
    // Model is called once for the final text answer only.
    const m2 = new ScriptModel([
      { content: [textBlock("refund declined")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a2 = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model: m2, store, tools: [refund], durable: true, now: () => "t", newId: newIdFactory("r") });
    const resumed = [];
    for await (const e of a2.resume("s", { decision: { approved: false } })) resumed.push(e);

    expect(resumed.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "refund declined" });
    expect(state.refunds).toBe(0); // declined → no side effect
    expect(m2.calls.length).toBe(1); // model called once for the final answer, not to re-emit tool_use
  });

  it("ctx.suspend without durable throws a clear error (surfaces as a tool error result)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const refund = makeRefundTool({ refunds: 0 });
    const model = new ScriptModel([
      { content: [toolUseBlock("c1", "request_refund", { amount: 50 })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    // durable NOT enabled → ctx.suspend throws; it is an ORDINARY throw → becomes a tool error result.
    const agent = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model, store, tools: [refund], now: () => "t", newId: newIdFactory("e") });
    const events = [];
    for await (const e of agent.query("refund 50", { sessionId: "s" })) events.push(e);
    const toolErr = events.find((e) => e.type === "tool.result" && (e as any).callId === "c1") as any;
    expect(toolErr?.isError).toBe(true);
    expect(JSON.stringify(toolErr?.output)).toMatch(/durable/i);
  });

  it("resume with a decision on a non-durable agent throws a clear error", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const agent = new Agent({ permissions: { mode: "bypass" }, id: "r", instructions: "", model: new ScriptModel([]), store, tools: [], now: () => "t" });
    await expect(async () => {
      for await (const _ of agent.resume("s", { decision: { approved: true } })) { /* */ }
    }).rejects.toThrow(/durable/i);
  });
});

describe("resume() ownership check (§M2)", () => {
  const makeAgent = (store: InMemoryStore) =>
    new Agent({ permissions: { mode: "bypass" }, id: "owner-agent", instructions: "", model: new ScriptModel([
      { content: [{ type: "text", text: "done" }], usage: { inputTokens: 1, outputTokens: 1 } },
    ]), store, durable: true, now: () => "t", newId: newIdFactory("ow") });

  it("back-compat: no caller identity + session has no owner → succeeds (no check)", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // Create a session with no ownership
    await store.createSession({ id: "sess-noowner", agentId: "owner-agent", createdAt: "t" });
    const agent = makeAgent(store);
    // Should not throw even though there's nothing to replay
    const events: unknown[] = [];
    for await (const e of agent.resume("sess-noowner")) events.push(e);
    expect(events.length).toBeGreaterThan(0);
  });

  it("match: caller userId matches session userId → succeeds", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    // Simulate a session created by query() with userId
    await store.createSession({ id: "sess-alice", agentId: "owner-agent", createdAt: "t", userId: "alice" });
    const agent = makeAgent(store);
    const events: unknown[] = [];
    for await (const e of agent.resume("sess-alice", { userId: "alice" })) events.push(e);
    expect(events.length).toBeGreaterThan(0);
  });

  it("mismatch: caller userId does not match session userId → throws ownership error", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.createSession({ id: "sess-alice2", agentId: "owner-agent", createdAt: "t", userId: "alice" });
    const agent = makeAgent(store);
    await expect(async () => {
      for await (const _ of agent.resume("sess-alice2", { userId: "bob" })) { /* */ }
    }).rejects.toThrow(/ownership mismatch/i);
  });

  it("mismatch: caller orgId does not match session orgId → throws ownership error", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.createSession({ id: "sess-org", agentId: "owner-agent", createdAt: "t", orgId: "acme" });
    const agent = makeAgent(store);
    await expect(async () => {
      for await (const _ of agent.resume("sess-org", { orgId: "rival" })) { /* */ }
    }).rejects.toThrow(/ownership mismatch/i);
  });

  it("mismatch: caller apiKey does not match session apiKey → throws ownership error", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.createSession({ id: "sess-key", agentId: "owner-agent", createdAt: "t", apiKey: "key-real" });
    const agent = makeAgent(store);
    await expect(async () => {
      for await (const _ of agent.resume("sess-key", { apiKey: "key-evil" })) { /* */ }
    }).rejects.toThrow(/ownership mismatch/i);
  });

  it("no caller identity + session has owner → rejects fail-closed", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    await store.createSession({ id: "sess-owned-nocheck", agentId: "owner-agent", createdAt: "t", userId: "charlie" });
    const agent = makeAgent(store);
    await expect(async () => {
      for await (const _ of agent.resume("sess-owned-nocheck")) { /* */ }
    }).rejects.toThrow(/ownership mismatch/i);
  });
});
