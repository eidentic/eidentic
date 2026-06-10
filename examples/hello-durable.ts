import { Agent, createTool } from "@eidentic/core";
import { SqliteStore } from "@eidentic/sqlite";
import { textBlock, toolUseBlock, type ModelPort, type ModelRequest, type ModelResponse } from "@eidentic/types";
import { z } from "zod";

// A tiny scripted model: ask for the tool, then (on the next call) "crash".
class ScriptedModel implements ModelPort {
  private i = 0;
  constructor(private readonly steps: ModelResponse[], private readonly crashOn?: number) {}
  async complete(_req: ModelRequest): Promise<ModelResponse> {
    const n = ++this.i;
    if (this.crashOn && n === this.crashOn) throw new Error("simulated crash before terminal event");
    const r = this.steps[n - 1];
    if (!r) throw new Error(`no scripted step #${n}`);
    return r;
  }
}

const store = new SqliteStore(":memory:"); // embedded default; SqliteStore implements DurablePort
await store.migrate();

let sent = 0; // the external, exactly-once side effect

// IMPORTANT — idempotency window: Eidentic records an "intent" before executing the tool and a
// "completion" after. If the process crashes after the email is sent but before "completion" is
// persisted, resume will re-run the tool (intent-without-completion policy). The `idempotencyKey`
// below deduplicates retries *within* Eidentic, but not against the external email provider.
// To make the end-to-end operation truly once, pass the same key to the email provider so it can
// deduplicate at its end regardless of how many times we call it.
const sendEmail = createTool({
  id: "send_email",
  description: "sends an email (destructive — declares an idempotencyKey)",
  sideEffect: "destructive",
  inputSchema: z.object({ to: z.string() }),
  idempotencyKey: (i) => `send_email:${i.to}`,
  execute: async ({ input }) => { sent++; return { sentTo: input.to, count: sent }; },
});

// Run 1: the model asks to send the email, then "crashes" before the run finishes.
const crashing = new ScriptedModel(
  [{ content: [toolUseBlock("c1", "send_email", { to: "baran@example.com" })], usage: { inputTokens: 1, outputTokens: 1 } }],
  2, // crash on the 2nd model call (after the email tool's completion is recorded)
);
const agent1 = new Agent({ id: "mailer", instructions: "Send the email.", model: crashing, store, tools: [sendEmail], durable: true });
for await (const _ of agent1.query("email baran@example.com", { sessionId: "run-1" })) { /* drain */ }
console.log("after crash — emails actually sent:", sent); // 1

// Run 2: resume the SAME session with a healthy model. The already-applied send_email is SKIPPED.
const healthy = new ScriptedModel([
  { content: [toolUseBlock("c1", "send_email", { to: "baran@example.com" })], usage: { inputTokens: 1, outputTokens: 1 } },
  { content: [textBlock("email delivered")], usage: { inputTokens: 1, outputTokens: 1 } },
]);
const agent2 = new Agent({ id: "mailer", instructions: "Send the email.", model: healthy, store, tools: [sendEmail], durable: true });
let final = "";
for await (const ev of agent2.resume("run-1")) {
  if (ev.type === "result") final = String(ev.output ?? "");
}
console.log("after resume — emails actually sent:", sent); // still 1 (skipped, not re-sent)
console.log("run result:", final);                          // "email delivered"

await store.close();
