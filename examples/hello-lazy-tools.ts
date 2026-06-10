/**
 * Lazy tool discovery (§5.4) — context-cost control for large toolsets.
 *
 * Registers 30 user tools (well above the 20 default threshold), so the model does NOT see
 * every schema up front. Instead it:
 *   turn 1: search_tools("send email")        → gets top-k SIGNATURES (name + description only)
 *   turn 2: load_tool("send_email")           → its full schema joins the manifest
 *   turn 3: send_email({...})                 → dispatches successfully
 *   turn 4: finishes
 *
 * We print the per-turn manifest size: it starts tiny (just the eager meta-tools), then grows by
 * one when the tool is loaded — the token saving vs. preloading all 30 schemas.
 *
 * Run:  pnpm hello:lazy-tools
 */
import { Agent, createTool } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ToolSchema } from "@eidentic/types";
import { z } from "zod";

async function main() {
  // 29 noise tools + 1 real target = 30 (> threshold 20 → lazy activates).
  const noise = Array.from({ length: 29 }, (_, i) =>
    createTool({
      id: `noise_${String(i).padStart(2, "0")}`,
      description: `Noise tool ${i} for some unrelated operation ${i}`,
      inputSchema: z.object({}),
      execute: async () => ({ ran: i }),
    }),
  );
  const sendEmail = createTool({
    id: "send_email",
    description: "Send an email message to a recipient with a subject and body",
    inputSchema: z.object({ to: z.string(), subject: z.string(), body: z.string() }),
    execute: async ({ input }) => ({ sent: true, to: input.to }),
  });

  const model = new MockModel([
    { content: [toolUseBlock("c1", "search_tools", { query: "send email" })], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [toolUseBlock("c2", "load_tool", { name: "send_email" })], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [toolUseBlock("c3", "send_email", { to: "a@b.com", subject: "hi", body: "yo" })], usage: { inputTokens: 1, outputTokens: 1 } },
    { content: [textBlock("Email sent.")], usage: { inputTokens: 1, outputTokens: 1 } },
  ]);

  const store = new InMemoryStore();
  const agent = new Agent({
    id: "lazy-demo", instructions: "Find and use the right tool.",
    model, store, tools: [...noise, sendEmail],
    lazyTools: true, // AUTO: activates because 30 user tools + 2 meta > threshold 20
  });

  for await (const ev of agent.query("Email a@b.com saying hi", { sessionId: "demo" })) {
    if (ev.type === "tool.result") {
      console.log(`tool.result  ${ev.toolName.padEnd(13)} →`, JSON.stringify(ev.output));
    }
  }

  console.log("\nPer-turn manifest sizes (tools the model saw each call):");
  model.calls.forEach((c, i) => {
    const names = c.tools.map((t: ToolSchema) => t.name);
    console.log(`  turn ${i + 1}: ${names.length} tools  [${names.join(", ")}]`);
  });
  console.log(`\nWithout lazy discovery the model would have seen all ${noise.length + 1} tool schemas every turn.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
