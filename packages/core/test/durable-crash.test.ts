import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";

/** A model whose Nth `complete` call throws, simulating a crash mid-run. */
class CrashingModel implements ModelPort {
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly scripted: ModelResponse[], private readonly crashOnCall: number) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const n = ++this.i;
    if (n === this.crashOnCall) throw new Error("simulated crash");
    const r = this.scripted[n - 1];
    if (!r) throw new Error(`CrashingModel: no scripted response #${n}`);
    return r;
  }
}

describe("durable terminal errors", () => {
  it("a caught model error is final and replay does not duplicate an applied side effect", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    let counter = 0; // the external side effect
    const sendEmail = createTool({
      id: "send_email", description: "sends an email (destructive)", sideEffect: "destructive",
      inputSchema: z.object({ to: z.string() }),
      idempotencyKey: (i) => `send_email:${i.to}`,
      execute: async ({ input }) => { counter++; return { sentTo: input.to, n: counter }; },
    });

    // Call 1: ask for the tool. Call 2 (after tool completion is recorded): CRASH before the terminal event.
    const crashing = new CrashingModel(
      [{ content: [toolUseBlock("c1", "send_email", { to: "a@b.com" })], usage: { inputTokens: 1, outputTokens: 1 } }],
      2,
    );
    const agentCrash = new Agent({ permissions: { mode: "bypass" }, id: "a", instructions: "", model: crashing, store, tools: [sendEmail], durable: true, now: () => "t", newId: ((n) => () => `e${n++}`)(0) });

    const firstEvents = [];
    for await (const e of agentCrash.query("email a@b.com", { sessionId: "s" })) firstEvents.push(e);
    // The crash surfaces as a terminal error (the model threw on call 2).
    expect(firstEvents.at(-1)).toMatchObject({ type: "result", subtype: "error" });
    expect(counter).toBe(1); // the tool ran exactly once
    // A7: the effective stored key is now ${sessionId}:${tool.idempotencyKey(input)}.
    expect((await store.getIdempotency("s:send_email:a@b.com"))?.status).toBe("applied");

    // A caught model error is not a process crash: it has an authoritative terminal_result.
    // A fresh model must therefore never be invoked by resume().
    const resumeModel = new MockModelLike([
      { content: [toolUseBlock("c1", "send_email", { to: "a@b.com" })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("email sent")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agentResume = new Agent({ permissions: { mode: "bypass" }, id: "a", instructions: "", model: resumeModel, store, tools: [sendEmail], durable: true, now: () => "t", newId: ((n) => () => `r${n++}`)(0) });

    const resumed = [];
    for await (const e of agentResume.resume("s")) resumed.push(e);
    expect(resumed.at(-1)).toMatchObject({ type: "result", subtype: "error", output: "simulated crash" });
    expect(resumeModel.calls).toHaveLength(0);
    expect(counter).toBe(1);
  });

  it("a terminal error does not retry an intent-only destructive call implicitly", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    let counter = 0;
    // The tool records intent, then throws on its first execution → completion is never recorded.
    // We also crash the model on call 2 (before it can return a terminal response) so the session
    // is left in a non-terminal state: [user, assistant(tool_use), tool_result(error)].
    // On resume the loop re-enters, the model re-issues the tool, and since status is "intent"
    // (not "applied") the tool re-runs — this is the v1 re-run policy.
    const flaky = createTool({
      id: "charge", description: "charges a card (destructive)", sideEffect: "destructive",
      inputSchema: z.object({ amount: z.number() }),
      idempotencyKey: (i) => `charge:${i.amount}`,
      execute: async ({ input }) => { counter++; if (counter === 1) throw new Error("gateway timeout"); return { charged: input.amount, n: counter }; },
    });
    // Model call 1 → tool_use; tool throws (intent recorded, no completion); model call 2 → CRASH
    // (simulates process crash before the model can finish the run).
    const crashModel = new CrashingModel(
      [{ content: [toolUseBlock("c1", "charge", { amount: 10 })], usage: { inputTokens: 1, outputTokens: 1 } }],
      2, // crash on call 2, after the tool's intent-only record is in the ledger
    );
    const agent = new Agent({ permissions: { mode: "bypass" }, id: "a", instructions: "", model: crashModel, store, tools: [flaky], durable: true, now: () => "t", newId: ((n) => () => `e${n++}`)(0) });
    for await (const _ of agent.query("charge 10", { sessionId: "s" })) { /* drain */ }
    expect(counter).toBe(1);
    // A7: the effective stored key is now ${sessionId}:${tool.idempotencyKey(input)}.
    expect((await store.getIdempotency("s:charge:10"))?.status).toBe("intent"); // intent only, no completion

    // Resume replays the persisted model error. Retrying an intent-only destructive operation
    // requires an explicit new run, never an implicit terminal-state reinterpretation.
    const model2 = new MockModelLike([
      { content: [toolUseBlock("c1", "charge", { amount: 10 })], usage: { inputTokens: 1, outputTokens: 1 } },
      { content: [textBlock("charged on retry")], usage: { inputTokens: 1, outputTokens: 1 } },
    ]);
    const agent2 = new Agent({ permissions: { mode: "bypass" }, id: "a", instructions: "", model: model2, store, tools: [flaky], durable: true, now: () => "t", newId: ((n) => () => `r${n++}`)(0) });
    for await (const _ of agent2.resume("s")) { /* drain */ }
    expect(model2.calls).toHaveLength(0);
    expect(counter).toBe(1);
    expect((await store.getIdempotency("s:charge:10"))?.status).toBe("intent");
  });
});

/** Minimal scripted model (local copy to avoid coupling to testing.ts MockModel import shape). */
class MockModelLike implements ModelPort {
  readonly calls: ModelRequest[] = [];
  private i = 0;
  constructor(private readonly scripted: ModelResponse[]) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.calls.push(request);
    const r = this.scripted[this.i++];
    if (!r) throw new Error(`MockModelLike: no scripted response #${this.i}`);
    return r;
  }
}
