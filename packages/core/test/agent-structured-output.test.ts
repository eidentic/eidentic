import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type ModelResponse, type StreamEvent } from "@eidentic/types";
import { createTool } from "../src/tool.js";
import { Agent } from "../src/agent.js";

const usage = { inputTokens: 1, outputTokens: 1 };

/** A scripted terminal response that already carries a parsed structured object (structured-model). */
const objResponse = (text: string, object: unknown): ModelResponse => ({ content: [textBlock(text)], usage, object });

async function runWith(
  model: MockModel,
  outputSchema: z.ZodType,
  opts: { tools?: ReturnType<typeof createTool>[]; sessionId?: string } = {},
): Promise<StreamEvent[]> {
  const store = new InMemoryStore();
  await store.migrate();
  const agent = new Agent({
    id: "a",
    instructions: "extract",
    model,
    store,
    ...(opts.tools ? { tools: opts.tools } : {}),
    now: () => "t",
    newId: ((n) => () => `e${n++}`)(0),
    // Disable structured-output retry so tests that script a single invalid response
    // still terminate immediately with an error (the behavior being tested here).
    structuredOutputRetry: { maxAttempts: 0 },
  });
  const out: StreamEvent[] = [];
  for await (const e of agent.query("classify this", { sessionId: opts.sessionId ?? "s", outputSchema })) out.push(e);
  return out;
}

const Person = z.object({ name: z.string(), age: z.number() });

describe("Agent structured output (D2)", () => {
  it("surfaces the validated object on the terminal result (from response.object)", async () => {
    const model = new MockModel([objResponse('{"name":"Ada","age":36}', { name: "Ada", age: 36 })]);
    const events = await runWith(model, Person);
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", subtype: "success" });
    expect((result as { object?: unknown }).object).toEqual({ name: "Ada", age: 36 });
    // The raw text answer is still present on `output` (back-compat with text consumers).
    expect((result as { output?: unknown }).output).toBe('{"name":"Ada","age":36}');
  });

  it("forwards the JSON Schema to the model request as outputSchema", async () => {
    const model = new MockModel([objResponse("{}", { name: "x", age: 1 })]);
    await runWith(model, Person);
    const sent = model.calls[0]!;
    expect(sent.outputSchema).toBeDefined();
    const schema = sent.outputSchema as { type?: string; properties?: Record<string, unknown> };
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("name");
    expect(schema.properties).toHaveProperty("age");
  });

  it("composes with the tool loop: tools run first, then a structured final answer", async () => {
    const lookup = createTool({
      id: "lookup",
      description: "look up a record",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ found: true }),
    });
    const model = new MockModel([
      // Turn 1: the model calls a tool (no structured object on a tool-calling turn).
      { content: [toolUseBlock("c1", "lookup", { q: "Ada" })], usage },
      // Turn 2: terminal structured answer.
      objResponse('{"name":"Ada","age":36}', { name: "Ada", age: 36 }),
    ]);
    const events = await runWith(model, Person, { tools: [lookup] });
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", subtype: "success" });
    expect((result as { object?: unknown }).object).toEqual({ name: "Ada", age: 36 });
    // The structured schema was forwarded on BOTH turns (the provider constrains the final one).
    expect(model.calls[0]!.outputSchema).toBeDefined();
    expect(model.calls[1]!.outputSchema).toBeDefined();
    // A tool result was produced in between.
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
  });

  it("falls back to parsing the final text when the model port did not parse it (response.object absent)", async () => {
    // A model that only emits structured JSON as TEXT (no `object` set) — e.g. streaming or a plain mock.
    const model = new MockModel([{ content: [textBlock('{"name":"Bo","age":7}')], usage }]);
    const events = await runWith(model, Person);
    const result = events.at(-1);
    expect(result).toMatchObject({ type: "result", subtype: "success" });
    expect((result as { object?: unknown }).object).toEqual({ name: "Bo", age: 7 });
  });

  it("terminates with error when the structured object fails schema validation", async () => {
    // age is a string, not a number → schema mismatch.
    const model = new MockModel([objResponse('{"name":"Ada","age":"old"}', { name: "Ada", age: "old" })]);
    const events = await runWith(model, Person);
    const result = events.at(-1) as { type: string; subtype: string; output?: unknown; object?: unknown; details?: Record<string, unknown> };
    expect(result.type).toBe("result");
    expect(result.subtype).toBe("error");
    expect(String(result.output)).toMatch(/schema validation/i);
    expect(result.object).toBeUndefined();
    expect(result.details?.errorKind).toBe("structured_output_validation");
    expect(result.details?.validationIssues).toEqual(expect.arrayContaining([expect.stringMatching(/age/i)]));
    expect(result.details?.rawOutput).toBeUndefined();
    expect(JSON.stringify(result.details)).not.toContain('{"name":"Ada","age":"old"}');
  });

  it("terminates with error when the final answer is not valid JSON", async () => {
    const model = new MockModel([{ content: [textBlock("I cannot do that")], usage }]);
    const events = await runWith(model, Person);
    const result = events.at(-1) as { type: string; subtype: string; output?: unknown; details?: Record<string, unknown> };
    expect(result.subtype).toBe("error");
    expect(String(result.output)).toMatch(/not valid JSON/i);
    expect(result.details?.errorKind).toBe("structured_output_parse");
    expect(result.details?.rawOutput).toBeUndefined();
    expect(JSON.stringify(result.details)).not.toContain("I cannot do that");
  });

  it("back-compat: a query WITHOUT outputSchema never forwards a schema and yields no object", async () => {
    const store = new InMemoryStore();
    await store.migrate();
    const model = new MockModel([{ content: [textBlock("plain answer")], usage }]);
    const agent = new Agent({ id: "a", instructions: "", model, store, now: () => "t", newId: ((n) => () => `e${n++}`)(0) });
    const events: StreamEvent[] = [];
    for await (const e of agent.query("hi", { sessionId: "s" })) events.push(e);
    expect(model.calls[0]!.outputSchema).toBeUndefined();
    const result = events.at(-1) as { subtype: string; output?: unknown; object?: unknown };
    expect(result.subtype).toBe("success");
    expect(result.output).toBe("plain answer");
    expect(result.object).toBeUndefined();
  });
});
