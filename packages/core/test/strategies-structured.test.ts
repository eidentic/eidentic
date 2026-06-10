/**
 * Structured output (`outputSchema`, D2) extended to the reasoning STRATEGIES and `resume()`.
 *
 * Semantics under test:
 *  - When a strategy is run with an `outputSchema`, the schema constrains ONLY the strategy's
 *    FINAL answer. Intermediate react sub-runs (reflection draft/critique passes, planAndExecute
 *    per-step runs) run UNCONSTRAINED (no schema forwarded). After the strategy produces its
 *    accepted free-text answer, ONE final schema-constrained react sub-run renders it as the
 *    typed object, surfaced as `result.object` on the single terminal event.
 *  - `resume({ outputSchema })` threads the schema into the resumed run so a resumed run also
 *    yields `result.object`.
 *  - Backward-compatible: no `outputSchema` → behavior unchanged.
 *
 * Branch: feat/structured-strategies
 */
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import {
  textBlock,
  toolUseBlock,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { createTool } from "../src/tool.js";
import { reflection, planAndExecute } from "../src/strategies.js";

const usage = { inputTokens: 1, outputTokens: 1 };

/** Plain text terminal turn. */
const textResp = (text: string): ModelResponse => ({ content: [textBlock(text)], usage });
/** Terminal turn that carries a pre-parsed structured object (structured-model port behavior). */
const objResp = (text: string, object: unknown): ModelResponse => ({ content: [textBlock(text)], usage, object });

/** A scripted model that records every request — lets us assert which calls were schema-constrained. */
class RecModel extends MockModel {}

const Person = z.object({ name: z.string(), age: z.number() });

function terminal(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.filter((e) => e.type === "result");
  return t[t.length - 1] as Extract<StreamEvent, { type: "result" }>;
}

const newIdFactory = (prefix: string) => ((n) => () => `${prefix}${n++}`)(0);

async function makeStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

// ---------------------------------------------------------------------------
// reflection() + outputSchema
// ---------------------------------------------------------------------------

describe("reflection() + outputSchema", () => {
  it("yields result.object on the single terminal; intermediate draft is NOT schema-constrained", async () => {
    const store = await makeStore();
    // Agent model: [draft pass (free text), final format pass (structured object)].
    const model = new RecModel([
      textResp("Ada is 36 years old."),
      objResp('{"name":"Ada","age":36}', { name: "Ada", age: 36 }),
    ]);
    // Critic model: accepts the draft on the first critique.
    const critic = new MockModel([
      { content: [toolUseBlock("c1", "critique", { satisfactory: true, feedback: "good" })], usage },
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      strategy: reflection({ critic, maxRevisions: 2 }),
      now: () => "t",
      newId: newIdFactory("e"),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("who is Ada", { sessionId: "s", outputSchema: Person })) events.push(e);

    // Exactly one terminal, carrying the validated typed object.
    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toEqual({ name: "Ada", age: 36 });

    // The DRAFT pass (model call 0) was NOT schema-constrained; the FINAL format pass (call 1) WAS.
    expect(model.calls[0]!.outputSchema).toBeUndefined();
    expect(model.calls[1]!.outputSchema).toBeDefined();
  });

  it("intermediate revision passes run unconstrained; only the accepted answer is formatted", async () => {
    const store = await makeStore();
    // Agent model: draft0 (free), draft1 revision (free), then final format (object).
    const model = new RecModel([
      textResp("draft v0"),
      textResp("draft v1 improved"),
      objResp('{"name":"Bo","age":7}', { name: "Bo", age: 7 }),
    ]);
    // Critic: reject first (request revision), accept second.
    const critic = new MockModel([
      { content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "add the age" })], usage },
      { content: [toolUseBlock("c2", "critique", { satisfactory: true, feedback: "ok" })], usage },
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      strategy: reflection({ critic, maxRevisions: 2 }),
      now: () => "t",
      newId: newIdFactory("e"),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("who is Bo", { sessionId: "s", outputSchema: Person })) events.push(e);

    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toEqual({ name: "Bo", age: 7 });

    // Both react draft passes were unconstrained; only the trailing format pass was schema-constrained.
    expect(model.calls[0]!.outputSchema).toBeUndefined();
    expect(model.calls[1]!.outputSchema).toBeUndefined();
    expect(model.calls[2]!.outputSchema).toBeDefined();
    expect(model.calls).toHaveLength(3);
  });

  it("back-compat: reflection WITHOUT outputSchema forwards no schema and yields no object", async () => {
    const store = await makeStore();
    const model = new RecModel([textResp("plain draft")]);
    const critic = new MockModel([
      { content: [toolUseBlock("c1", "critique", { satisfactory: true, feedback: "ok" })], usage },
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      strategy: reflection({ critic, maxRevisions: 1 }),
      now: () => "t",
      newId: newIdFactory("e"),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("hi", { sessionId: "s" })) events.push(e);

    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toBeUndefined();
    // No extra format pass; only the single draft call happened, with no schema.
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.outputSchema).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// planAndExecute() + outputSchema
// ---------------------------------------------------------------------------

describe("planAndExecute() + outputSchema", () => {
  it("steps run unconstrained; the final synthesis pass yields the typed object", async () => {
    const store = await makeStore();
    // Planner: a 2-step plan.
    const planner = new MockModel([
      { content: [toolUseBlock("p1", "make_plan", { steps: ["find name", "find age"] })], usage },
    ]);
    // Agent model (executor default): step1 (free), step2 (free), final format pass (object).
    const model = new RecModel([
      textResp("the name is Ada"),
      textResp("the age is 36"),
      objResp('{"name":"Ada","age":36}', { name: "Ada", age: 36 }),
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      strategy: planAndExecute({ planner }),
      now: () => "t",
      newId: newIdFactory("e"),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("profile Ada", { sessionId: "s", outputSchema: Person })) events.push(e);

    expect(events.filter((e) => e.type === "result")).toHaveLength(1);
    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toEqual({ name: "Ada", age: 36 });

    // The two step sub-runs were UNCONSTRAINED; only the final synthesis pass carried the schema.
    expect(model.calls).toHaveLength(3);
    expect(model.calls[0]!.outputSchema).toBeUndefined();
    expect(model.calls[1]!.outputSchema).toBeUndefined();
    expect(model.calls[2]!.outputSchema).toBeDefined();
  });

  it("a step may call tools (free, unconstrained) before the final structured pass", async () => {
    const store = await makeStore();
    const lookup = createTool({
      id: "lookup",
      description: "look up a fact",
      inputSchema: z.object({ q: z.string() }),
      execute: async () => ({ found: "Ada, 36" }),
    });
    const planner = new MockModel([
      { content: [toolUseBlock("p1", "make_plan", { steps: ["look up Ada"] })], usage },
    ]);
    // Step calls a tool then answers (2 calls), then the final format pass (object).
    const model = new RecModel([
      { content: [toolUseBlock("t1", "lookup", { q: "Ada" })], usage },
      textResp("found Ada aged 36"),
      objResp('{"name":"Ada","age":36}', { name: "Ada", age: 36 }),
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      tools: [lookup],
      strategy: planAndExecute({ planner }),
      now: () => "t",
      newId: newIdFactory("e"),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("profile Ada", { sessionId: "s", outputSchema: Person })) events.push(e);

    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toEqual({ name: "Ada", age: 36 });
    // The step's tool-calling turns were unconstrained; the final format pass carried the schema.
    expect(model.calls[0]!.outputSchema).toBeUndefined(); // step tool_use turn
    expect(model.calls[1]!.outputSchema).toBeUndefined(); // step terminal text turn
    expect(model.calls[2]!.outputSchema).toBeDefined(); // final structured pass
    // A tool result was produced during the step.
    expect(events.some((e) => e.type === "tool.result")).toBe(true);
  });

  it("back-compat: planAndExecute WITHOUT outputSchema runs no format pass and yields no object", async () => {
    const store = await makeStore();
    const planner = new MockModel([
      { content: [toolUseBlock("p1", "make_plan", { steps: ["step one"] })], usage },
    ]);
    const model = new RecModel([textResp("did step one")]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      strategy: planAndExecute({ planner }),
      now: () => "t",
      newId: newIdFactory("e"),
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("do it", { sessionId: "s" })) events.push(e);

    const result = terminal(events);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toBeUndefined();
    // Only the single step ran (no trailing format pass).
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.outputSchema).toBeUndefined();
  });

  it("a validation failure in the final structured pass surfaces a subtype:error terminal", async () => {
    const store = await makeStore();
    const planner = new MockModel([
      { content: [toolUseBlock("p1", "make_plan", { steps: ["one"] })], usage },
    ]);
    const model = new RecModel([
      textResp("step done"),
      // age is a string → schema mismatch in the final pass.
      objResp('{"name":"Ada","age":"old"}', { name: "Ada", age: "old" }),
    ]);
    const agent = new Agent({
      id: "a",
      instructions: "answer",
      model,
      store,
      strategy: planAndExecute({ planner }),
      now: () => "t",
      newId: newIdFactory("e"),
      // Disable structured-output retry so the single scripted invalid response
      // immediately surfaces a subtype:error terminal (the behavior being tested here).
      structuredOutputRetry: { maxAttempts: 0 },
    });

    const events: StreamEvent[] = [];
    for await (const e of agent.query("do it", { sessionId: "s", outputSchema: Person })) events.push(e);

    const result = terminal(events);
    expect(result.subtype).toBe("error");
    expect(String(result.output)).toMatch(/schema validation/i);
    expect((result as { object?: unknown }).object).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// resume() + outputSchema
// ---------------------------------------------------------------------------

/** Minimal scripted model that records calls (mirrors resume-redispatch test helper). */
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

describe("resume() + outputSchema", () => {
  it("a suspended durable run resumed WITH outputSchema yields result.object", async () => {
    const store = await makeStore();

    const approveTool = createTool({
      id: "approve",
      description: "needs approval",
      sideEffect: "destructive",
      inputSchema: z.object({ action: z.string() }),
      idempotencyKey: (i) => `approve:${i.action}`,
      execute: async ({ input, ctx }) => {
        const d = await ctx!.suspend!({ reason: "approve", present: { action: input.action } });
        return { approved: d.approved, action: input.action };
      },
    });

    // Run 1: model emits a tool_use; the tool suspends awaiting approval.
    const m1 = new ScriptModel([
      { content: [toolUseBlock("tc1", "approve", { action: "deploy" })], usage },
    ]);
    const a1 = new Agent({ id: "ag", instructions: "", model: m1, store, tools: [approveTool], durable: true, now: () => "t", newId: newIdFactory("e") });
    const first: StreamEvent[] = [];
    for await (const e of a1.query("deploy", { sessionId: "rsess" })) first.push(e);
    expect(first.at(-1)).toMatchObject({ type: "result", subtype: "suspended" });

    // Run 2: resume with the approval decision AND an outputSchema. The re-dispatched tool runs,
    // then the FINAL turn is schema-constrained → result.object.
    const m2 = new ScriptModel([
      objResp('{"name":"Ada","age":36}', { name: "Ada", age: 36 }),
    ]);
    const a2 = new Agent({ id: "ag", instructions: "", model: m2, store, tools: [approveTool], durable: true, now: () => "t", newId: newIdFactory("r") });

    const resumed: StreamEvent[] = [];
    for await (const e of a2.resume("rsess", { decision: { approved: true }, outputSchema: Person })) resumed.push(e);

    const result = terminal(resumed);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toEqual({ name: "Ada", age: 36 });
    // The resumed final turn was schema-constrained.
    expect(m2.calls[0]!.outputSchema).toBeDefined();
  });

  it("resuming an already-terminated session validates the stored text against outputSchema", async () => {
    const store = await makeStore();
    // Run 1: terminate immediately with a structured-JSON text answer (no tools).
    const m1 = new ScriptModel([textResp('{"name":"Bo","age":7}')]);
    const a1 = new Agent({ id: "ag", instructions: "", model: m1, store, durable: true, now: () => "t", newId: newIdFactory("e") });
    const first: StreamEvent[] = [];
    for await (const e of a1.query("answer", { sessionId: "tsess" })) first.push(e);
    expect(first.at(-1)).toMatchObject({ type: "result", subtype: "success" });

    // Run 2: resume the FINISHED session with an outputSchema → fast-path replay validates + attaches object.
    const m2 = new ScriptModel([]); // model must NOT be called on the terminal-completion fast-path.
    const a2 = new Agent({ id: "ag", instructions: "", model: m2, store, durable: true, now: () => "t", newId: newIdFactory("r") });
    const resumed: StreamEvent[] = [];
    for await (const e of a2.resume("tsess", { outputSchema: Person })) resumed.push(e);

    const result = terminal(resumed);
    expect(result.subtype).toBe("success");
    expect((result as { object?: unknown }).object).toEqual({ name: "Bo", age: 7 });
    expect(m2.calls).toHaveLength(0);
  });

  it("back-compat: resume WITHOUT outputSchema yields no object", async () => {
    const store = await makeStore();
    const m1 = new ScriptModel([textResp("plain done")]);
    const a1 = new Agent({ id: "ag", instructions: "", model: m1, store, durable: true, now: () => "t", newId: newIdFactory("e") });
    const first: StreamEvent[] = [];
    for await (const e of a1.query("go", { sessionId: "bsess" })) first.push(e);

    const m2 = new ScriptModel([]);
    const a2 = new Agent({ id: "ag", instructions: "", model: m2, store, durable: true, now: () => "t", newId: newIdFactory("r") });
    const resumed: StreamEvent[] = [];
    for await (const e of a2.resume("bsess")) resumed.push(e);

    const result = terminal(resumed);
    expect(result.subtype).toBe("success");
    expect(result.output).toBe("plain done");
    expect((result as { object?: unknown }).object).toBeUndefined();
  });
});
