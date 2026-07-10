/**
 * Tests for the durable-resume re-dispatch fix: when resuming, persisted pending tool calls
 * (those in the last assistant event with no matching tool_result) are re-dispatched directly
 * using the preserved callId/name/input — no model round-trip, callId-stable.
 *
 * Branch: fix/resume-redispatch-toolcall
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { createTool, idempotencyLedgerKey } from "../src/tool.js";

/** Minimal scripted model; tracks calls so tests can assert model was NOT called for re-emit. */
class ScriptModel implements ModelPort {
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly scripted: ModelResponse[]) {}
  async complete(req: ModelRequest): Promise<ModelResponse> {
    this.calls.push(req);
    const r = this.scripted[this.i++];
    if (!r) throw new Error(`ScriptModel: no scripted response #${this.i} (only ${this.scripted.length} scripted)`);
    return r;
  }
}

const newIdFactory = (prefix: string) => ((n) => () => `${prefix}${n++}`)(0);

// ---------------------------------------------------------------------------
// Test 1: Suspension resume WITHOUT model re-emission
// ---------------------------------------------------------------------------
describe("resume re-dispatch — suspension resume (no model re-emit)", () => {
  it("re-dispatches the persisted suspended tool directly; model is called only for the final answer", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const state = { approvals: 0 };
    const approveTool = createTool({
      id: "approve_action",
      description: "Performs an action that requires human approval.",
      sideEffect: "destructive",
      inputSchema: z.object({ action: z.string() }),
      idempotencyKey: (i) => `approve:${i.action}`,
      execute: async ({ input, ctx }) => {
        const decision = await ctx!.suspend!({ reason: "approve the action", present: { action: input.action } });
        if (!decision.approved) return { done: false };
        state.approvals += 1;
        return { done: true, action: input.action };
      },
    });

    // --- Run 1: first call → model emits tool_use, tool suspends ---
    const m1 = new ScriptModel([
      { content: [toolUseBlock("tc1", "approve_action", { action: "deploy" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a1 = new Agent({ permissions: { mode: "bypass" }, id: "ag", instructions: "", model: m1, store, tools: [approveTool], durable: true, now: () => "t", newId: newIdFactory("e") });
    const firstEvents = [];
    for await (const e of a1.query("do deploy", { sessionId: "sess1" })) firstEvents.push(e);

    expect(firstEvents.at(-1)).toMatchObject({ type: "result", subtype: "suspended", callId: "tc1" });
    expect(state.approvals).toBe(0);
    expect(m1.calls.length).toBe(1); // model called once for the tool_use turn

    // --- Run 2: resume with the approval decision ---
    // The fix: the persisted tool_use (callId=tc1) is re-dispatched DIRECTLY from the log.
    // The model is NOT asked to re-emit it. Only the final text answer needs to come from the model.
    const m2 = new ScriptModel([
      // No tool_use re-emission scripted — only the final answer.
      { content: [textBlock("action approved and done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a2 = new Agent({ permissions: { mode: "bypass" }, id: "ag", instructions: "", model: m2, store, tools: [approveTool], durable: true, now: () => "t", newId: newIdFactory("r") });

    const resumed = [];
    for await (const e of a2.resume("sess1", { decision: { approved: true } })) resumed.push(e);

    expect(resumed.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "action approved and done" });
    // The side effect ran exactly once.
    expect(state.approvals).toBe(1);
    // CRITICAL: the model was called exactly once (for the post-tool final answer),
    // NOT to re-emit the tool_use. This proves the fix works without model cooperation.
    expect(m2.calls.length).toBe(1);

    // The tool.result event for callId tc1 is in the resumed events.
    const toolResult = resumed.find((e) => e.type === "tool.result" && (e as any).callId === "tc1");
    expect(toolResult).toBeDefined();
  });

  it("re-dispatches with {approved:false}; model called once for final answer; side effect skipped", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const state = { approvals: 0 };
    const approveTool = createTool({
      id: "approve_action",
      description: "Performs an action that requires human approval.",
      sideEffect: "destructive",
      inputSchema: z.object({ action: z.string() }),
      idempotencyKey: (i) => `approve:${i.action}`,
      execute: async ({ input, ctx }) => {
        const decision = await ctx!.suspend!({ reason: "approve the action", present: { action: input.action } });
        if (!decision.approved) return { done: false };
        state.approvals += 1;
        return { done: true, action: input.action };
      },
    });

    const m1 = new ScriptModel([
      { content: [toolUseBlock("tc2", "approve_action", { action: "delete" })], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a1 = new Agent({ permissions: { mode: "bypass" }, id: "ag", instructions: "", model: m1, store, tools: [approveTool], durable: true, now: () => "t", newId: newIdFactory("e") });
    for await (const _ of a1.query("do delete", { sessionId: "sess2" })) { /* drain */ }
    expect(state.approvals).toBe(0);

    const m2 = new ScriptModel([
      { content: [textBlock("action declined")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const a2 = new Agent({ permissions: { mode: "bypass" }, id: "ag", instructions: "", model: m2, store, tools: [approveTool], durable: true, now: () => "t", newId: newIdFactory("r") });
    const resumed = [];
    for await (const e of a2.resume("sess2", { decision: { approved: false } })) resumed.push(e);

    expect(resumed.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "action declined" });
    expect(state.approvals).toBe(0); // declined — side effect not applied
    expect(m2.calls.length).toBe(1); // model called once only, not for re-emit
  });
});

// ---------------------------------------------------------------------------
// Test 2: Crash mid-tool-batch resume (last persisted event is assistant with no tool_result)
// ---------------------------------------------------------------------------
describe("resume re-dispatch — crash mid-tool-batch (persisted assistant with no tool_result)", () => {
  it("re-dispatches the pending tool directly from log; model called only for post-tool continuation", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    let sideEffectCount = 0;
    const doWork = createTool({
      id: "do_work",
      description: "Does some work (idempotent).",
      sideEffect: "idempotent",
      inputSchema: z.object({ task: z.string() }),
      idempotencyKey: (i) => `work:${i.task}`,
      execute: async ({ input }) => {
        sideEffectCount++;
        return { completed: input.task, n: sideEffectCount };
      },
    });

    // Simulate a crash: manually populate the store with:
    //   [user, assistant(tool_use c3)] — NO tool_result (crash after assistant was written)
    await store.createSession({ id: "crash-sess", agentId: "ag", createdAt: "t" });
    await store.appendEvents([
      { id: "e0", sessionId: "crash-sess", seq: 0, kind: "user", schemaVersion: 1, payload: "do the task", createdAt: "t" },
      {
        id: "e1", sessionId: "crash-sess", seq: 1, kind: "assistant", schemaVersion: 1,
        payload: { content: [{ type: "tool_use", callId: "c3", name: "do_work", input: { task: "build" } }] },
        meta: { usage: { inputTokens: 1, outputTokens: 1 } },
        createdAt: "t",
      },
    ]);

    // Resume model: only needs to answer AFTER the tool_result is produced.
    // It is NOT scripted to re-emit the tool_use — proving no model round-trip for the pending call.
    const resumeModel = new ScriptModel([
      { content: [textBlock("work completed")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agentResume = new Agent({
      permissions: { mode: "bypass" },
      id: "ag", instructions: "", model: resumeModel, store,
      tools: [doWork], durable: true, now: () => "t",
      newId: newIdFactory("r"),
    });

    const events = [];
    for await (const e of agentResume.resume("crash-sess")) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "work completed" });

    // The tool ran exactly once (re-dispatched from the persisted log).
    expect(sideEffectCount).toBe(1);

    // The model was called exactly once — for the post-tool answer, NOT to re-emit the tool_use.
    expect(resumeModel.calls.length).toBe(1);

    // A tool.result event for callId c3 was emitted during the resume.
    const toolResult = events.find((e) => e.type === "tool.result" && (e as any).callId === "c3");
    expect(toolResult).toBeDefined();
    expect((toolResult as any).toolName).toBe("do_work");

    // The idempotency ledger now has "applied" for the work key.
    // A7: key is prefixed with the sessionId ("crash-sess") by ToolRegistry.runOne.
    const idem = await store.getIdempotency(idempotencyLedgerKey("crash-sess", "work:build"));
    expect(idem?.status).toBe("applied");
  });

  it("crash mid-batch: already-answered sibling is skipped, only unanswered call is re-dispatched", async () => {
    const store = new InMemoryStore();
    await store.migrate();

    const counts: Record<string, number> = {};
    const countTool = createTool({
      id: "count_call",
      description: "counts a call",
      sideEffect: "idempotent",
      inputSchema: z.object({ id: z.string() }),
      idempotencyKey: (i) => `count:${i.id}`,
      execute: async ({ input }) => {
        counts[input.id] = (counts[input.id] ?? 0) + 1;
        return { id: input.id, n: counts[input.id] };
      },
    });

    // Simulate a crash where TWO tool_use blocks were in the assistant event,
    // but only the first one got a tool_result before the crash.
    // So only the second one (c5) is pending.
    await store.createSession({ id: "batch-sess", agentId: "ag", createdAt: "t" });
    await store.appendEvents([
      { id: "e0", sessionId: "batch-sess", seq: 0, kind: "user", schemaVersion: 1, payload: "run both", createdAt: "t" },
      {
        id: "e1", sessionId: "batch-sess", seq: 1, kind: "assistant", schemaVersion: 1,
        payload: {
          content: [
            { type: "tool_use", callId: "c4", name: "count_call", input: { id: "alpha" } },
            { type: "tool_use", callId: "c5", name: "count_call", input: { id: "beta" } },
          ],
        },
        meta: { usage: { inputTokens: 1, outputTokens: 1 } },
        createdAt: "t",
      },
      // Only c4 got a tool_result before the crash:
      {
        id: "e2", sessionId: "batch-sess", seq: 2, kind: "tool_result", schemaVersion: 1,
        payload: { callId: "c4", toolName: "count_call", output: { id: "alpha", n: 1 } },
        createdAt: "t",
      },
    ]);
    // Seed the idempotency for c4 as "applied" to reflect it completed.
    // A7: key must include the sessionId prefix ("batch-sess") to match what ToolRegistry.runOne stores.
    await store.recordIntent(idempotencyLedgerKey("batch-sess", "count:alpha"), "", { sessionId: "batch-sess" });
    await store.recordCompletion(idempotencyLedgerKey("batch-sess", "count:alpha"), undefined, { sessionId: "batch-sess" });

    const resumeModel = new ScriptModel([
      { content: [textBlock("both done")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agentResume = new Agent({
      permissions: { mode: "bypass" },
      id: "ag", instructions: "", model: resumeModel, store,
      tools: [countTool], durable: true, now: () => "t",
      newId: newIdFactory("rb"),
    });

    const events = [];
    for await (const e of agentResume.resume("batch-sess")) events.push(e);

    expect(events.at(-1)).toMatchObject({ type: "result", subtype: "success", output: "both done" });

    // alpha was already applied — should NOT have been re-dispatched (counts["alpha"] stays 0 from re-dispatch,
    // since idempotency skips it). beta was pending — dispatched once.
    // alpha's count is 0 from THIS process (it was "applied" already via the pre-seeded idempotency).
    expect(counts["alpha"]).toBeUndefined(); // not re-run in this process (idempotency skip)
    expect(counts["beta"]).toBe(1); // dispatched exactly once

    // Only c5 (beta) yielded a tool.result stream event during resume.
    const toolResults = events.filter((e) => e.type === "tool.result");
    expect(toolResults.map((e) => (e as any).callId)).toContain("c5");
    expect(toolResults.map((e) => (e as any).callId)).not.toContain("c4");

    // Model called once (for final answer), not to re-emit.
    expect(resumeModel.calls.length).toBe(1);
  });
});
