/**
 * Structured / schema-constrained output (D2).
 *
 * Pass `{ outputSchema }` (a Zod schema, same convention as createTool's inputSchema) to
 * `agent.query`. The agent runs its normal multi-turn tool loop; only the FINAL turn is
 * constrained to emit an object matching the schema. The parsed + validated value is surfaced
 * on the terminal `result` event as `result.object` (the raw text stays on `result.output`).
 *
 *   1. One-shot extraction: classify/extract a typed object from free text.
 *   2. Tools-then-structured: the agent calls a tool, then returns a structured final answer.
 *   3. Schema mismatch: an invalid object terminates the run with subtype:"error".
 *
 * Infra-free — uses a structured MockModel (no API key needed). For a REAL model, swap the
 * MockModel for `new AIModel(anthropic("claude-sonnet-4-5"))` from @eidentic/model: the AI SDK
 * forwards the schema as a JSON `responseFormat` and the provider constrains the final answer.
 *
 * Run:  pnpm hello:structured
 */
import { z } from "zod";
import { Agent } from "@eidentic/core";
import { createTool } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelResponse } from "@eidentic/types";

const usage = { inputTokens: 1, outputTokens: 1 };
/** A structured-model response: the parsed object rides alongside the JSON text (what AIModel returns). */
const structured = (object: unknown): ModelResponse => ({
  content: [textBlock(JSON.stringify(object))],
  usage,
  object,
});

// The shape we want back — typed AND runtime-validated.
const Ticket = z.object({
  category: z.enum(["bug", "feature", "question"]),
  priority: z.enum(["low", "medium", "high"]),
  summary: z.string(),
});
type Ticket = z.infer<typeof Ticket>;

async function newAgent(model: MockModel, tools?: ReturnType<typeof createTool>[]) {
  const store = new InMemoryStore();
  await store.migrate();
  return new Agent({
    id: "support-triage",
    instructions: "Classify the user's support message into a structured ticket.",
    model,
    store,
    ...(tools ? { tools } : {}),
  });
}

async function main() {
  // 1. One-shot extraction → typed object on result.object.
  {
    const model = new MockModel([
      structured({ category: "bug", priority: "high", summary: "Login button does nothing on Safari" }),
    ]);
    const agent = await newAgent(model);
    let ticket: Ticket | undefined;
    for await (const ev of agent.query("The login button is broken on Safari, nothing happens!", {
      sessionId: "s1",
      outputSchema: Ticket,
    })) {
      if (ev.type === "result" && ev.subtype === "success") ticket = ev.object as Ticket;
    }
    // `ticket` is typed AND validated — safe to use its fields directly.
    console.log("[1] typed ticket:", ticket);
    console.log("    priority is:", ticket?.priority);
  }

  // 2. Tools-then-structured: the agent looks something up, THEN returns a structured answer.
  {
    const lookupOrder = createTool({
      id: "lookup_order",
      description: "look up an order by id",
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => ({ status: "shipped", item: "Mechanical keyboard" }),
    });
    const model = new MockModel([
      // Turn 1: call the tool (no structured object on a tool-calling turn).
      { content: [toolUseBlock("c1", "lookup_order", { orderId: "A-1001" })], usage },
      // Turn 2: terminal structured answer.
      structured({ category: "question", priority: "low", summary: "Order A-1001 shipped: Mechanical keyboard" }),
    ]);
    const agent = await newAgent(model, [lookupOrder]);
    let ticket: Ticket | undefined;
    for await (const ev of agent.query("Where is my order A-1001?", { sessionId: "s2", outputSchema: Ticket })) {
      if (ev.type === "tool.result") console.log("[2] tool result:", ev.output);
      if (ev.type === "result" && ev.subtype === "success") ticket = ev.object as Ticket;
    }
    console.log("[2] structured after tool:", ticket);
  }

  // 3. Schema mismatch → the run terminates with subtype:"error" (no silent bad data).
  {
    const model = new MockModel([
      // `priority: "urgent"` is not in the enum → validation fails.
      structured({ category: "bug", priority: "urgent", summary: "x" }),
    ]);
    const agent = await newAgent(model);
    for await (const ev of agent.query("classify", { sessionId: "s3", outputSchema: Ticket })) {
      if (ev.type === "result") console.log(`[3] subtype=${ev.subtype}:`, ev.output);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
