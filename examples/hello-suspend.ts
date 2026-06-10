import { Agent, createTool } from "@eidentic/core";
import { SqliteStore } from "@eidentic/sqlite";
import { textBlock, toolUseBlock, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";
import { z } from "zod";

// A tiny scripted model: emit the tool call on the first run; on resume the persisted pending
// tool call is re-dispatched DIRECTLY (no model round-trip), so the model only needs to
// supply the final text answer after the tool result is in.
class ScriptedModel implements ModelPort {
  private i = 0;
  constructor(private readonly steps: ModelResponse[]) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const r = this.steps[this.i++];
    if (!r) throw new Error(`no scripted step #${this.i}`);
    return r;
  }
}

const store = new SqliteStore(":memory:"); // embedded default; implements DurablePort
await store.migrate();

let refunds = 0; // the external, exactly-once side effect

const requestRefund = createTool({
  id: "request_refund",
  description: "Issue a refund after human approval (destructive).",
  sideEffect: "destructive",
  inputSchema: z.object({ amount: z.number() }),
  idempotencyKey: (i) => `refund:${i.amount}`,
  execute: async ({ input, ctx }) => {
    // Pause for a human decision. First run: throws SuspendSignal (run persists, zero compute).
    // On resume: returns the recorded decision so we continue here.
    const decision = await ctx!.suspend!({ reason: "approve refund", present: { amount: input.amount } });
    if (!decision.approved) {
      console.log(`  tool: refund of $${input.amount} DECLINED by human`);
      return { refunded: false };
    }
    refunds += 1; // runs EXACTLY ONCE across suspend → resume
    console.log(`  tool: refund of $${input.amount} APPROVED — processed (refunds so far: ${refunds})`);
    return { refunded: true, amount: input.amount };
  },
});

// ---- Scenario A: suspend, then resume with APPROVAL ----
console.log("Scenario A — approve:");
const mA1 = new ScriptedModel([
  { content: [toolUseBlock("c1", "request_refund", { amount: 50 })], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agentA1 = new Agent({ id: "refunder", instructions: "Refund the customer.", model: mA1, store, tools: [requestRefund], durable: true });
let suspended: { request: unknown; callId?: string } | undefined;
for await (const ev of agentA1.query("refund 50", { sessionId: "run-A" })) {
  if (ev.type === "result" && ev.subtype === "suspended") suspended = { request: (ev as any).request, callId: (ev as any).callId };
}
console.log("  run suspended with request:", JSON.stringify(suspended?.request));
console.log("  refunds after suspend (should be 0):", refunds);

// On resume: the persisted tool_use (callId c1) is re-dispatched directly from the log.
// The model is only called ONCE for the final text answer — no tool_use re-emit needed.
const mA2 = new ScriptedModel([
  { content: [textBlock("refund approved and processed")], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agentA2 = new Agent({ id: "refunder", instructions: "Refund the customer.", model: mA2, store, tools: [requestRefund], durable: true });
let finalA = "";
for await (const ev of agentA2.resume("run-A", { decision: { approved: true } })) {
  if (ev.type === "result") finalA = String(ev.output ?? "");
}
console.log("  resume result:", finalA);
console.log("  refunds after resume (should be EXACTLY 1):", refunds);

// ---- Scenario B: suspend, then resume with DENIAL ----
console.log("Scenario B — deny:");
const mB1 = new ScriptedModel([
  { content: [toolUseBlock("c2", "request_refund", { amount: 999 })], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agentB1 = new Agent({ id: "refunder", instructions: "Refund the customer.", model: mB1, store, tools: [requestRefund], durable: true });
for await (const _ of agentB1.query("refund 999", { sessionId: "run-B" })) { /* drain to suspension */ }

// On resume: same pattern — persisted tool_use re-dispatched directly, model only answers once.
const mB2 = new ScriptedModel([
  { content: [textBlock("refund declined")], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agentB2 = new Agent({ id: "refunder", instructions: "Refund the customer.", model: mB2, store, tools: [requestRefund], durable: true });
let finalB = "";
for await (const ev of agentB2.resume("run-B", { decision: { approved: false } })) {
  if (ev.type === "result") finalB = String(ev.output ?? "");
}
console.log("  resume result:", finalB);
console.log("  refunds after deny (should STILL be 1):", refunds);

await store.close();
