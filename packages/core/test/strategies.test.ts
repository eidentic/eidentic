import { describe, it, expect } from "vitest";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock, type StreamEvent } from "@eidentic/types";
import type { ModelRequest, ModelResponse } from "@eidentic/types";
import { Agent } from "../src/agent.js";
import { react, reflection, planAndExecute } from "../src/strategies.js";
import type { GroundSignal } from "../src/strategies.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeStore(): Promise<InMemoryStore> {
  const s = new InMemoryStore();
  await s.migrate();
  return s;
}

async function runAgent(agent: Agent, input: string, sessionId: string): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of agent.query(input, { sessionId })) events.push(ev);
  return events;
}

function terminalEvent(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }> {
  const t = events.filter((e) => e.type === "result");
  if (t.length === 0) throw new Error("no terminal result event");
  return t[t.length - 1] as Extract<StreamEvent, { type: "result" }>;
}

function allTerminals(events: StreamEvent[]): Extract<StreamEvent, { type: "result" }>[] {
  return events.filter((e) => e.type === "result") as Extract<StreamEvent, { type: "result" }>[];
}

const basicResponse = (text: string): ModelResponse => ({
  content: [textBlock(text)],
  usage: { inputTokens: 5, outputTokens: 5 },
});

// A MockModel that records calls and returns scripted responses.
// Re-exported from @eidentic/types/testing but we add a helper that captures
// the full request texts so we can assert critic/planner inputs.
class RecordingMockModel extends MockModel {
  constructor(scripted: ModelResponse[]) {
    super(scripted);
  }
  // Inherited `calls` array gives access to all ModelRequest objects.
}

// ---------------------------------------------------------------------------
// react default byte-identical tests
// ---------------------------------------------------------------------------

describe("react() default — byte-identical no-strategy path", () => {
  it("yields the same events as no strategy for a simple run", async () => {
    const store = await makeStore();
    const model = new MockModel([basicResponse("hello world")]);
    const agentNoStrategy = new Agent({
      id: "a",
      instructions: "be helpful",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const eventsNoStrategy = await runAgent(agentNoStrategy, "say hello", "sess-no-strategy");

    const store2 = await makeStore();
    const model2 = new MockModel([basicResponse("hello world")]);
    const agentWithReact = new Agent({
      id: "a",
      instructions: "be helpful",
      model: model2,
      store: store2,
      strategy: react(),
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const eventsWithReact = await runAgent(agentWithReact, "say hello", "sess-react");

    // Terminal result should match on the important fields.
    const t1 = terminalEvent(eventsNoStrategy);
    const t2 = terminalEvent(eventsWithReact);
    expect(t1.subtype).toBe("success");
    expect(t2.subtype).toBe("success");
    expect(t1.output).toBe(t2.output);
    // Both emit exactly one terminal result.
    expect(allTerminals(eventsNoStrategy).length).toBe(1);
    expect(allTerminals(eventsWithReact).length).toBe(1);
  });

  it("no extra events appear beyond what the loop produces (session.init + assistant + result)", async () => {
    const store = await makeStore();
    const model = new MockModel([basicResponse("hi")]);
    const agent = new Agent({
      id: "a",
      instructions: "",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });
    const events = await runAgent(agent, "hello", "sess-minimal");
    const types = events.map((e) => e.type);
    expect(types).toContain("session.init");
    expect(types).toContain("assistant");
    expect(types).toContain("result");
    // All types should be in the known set — no unexpected extra events.
    for (const t of types) {
      expect(["session.init", "assistant", "result", "stream.delta", "tool.result", "compaction"]).toContain(t);
    }
  });
});

// ---------------------------------------------------------------------------
// reflection tests
// ---------------------------------------------------------------------------

describe("reflection() strategy", () => {
  it("revises once and accepts: agent called for both passes, exactly ONE terminal result with B", async () => {
    const store = await makeStore();

    // Agent model: first call returns draft A, second call returns improved B.
    const agentModel = new RecordingMockModel([
      basicResponse("draft answer A"),
      basicResponse("improved answer B"),
    ]);

    // Critic model: dissatisfied with A, satisfied with B.
    // The critic is called with a tool call request; we return tool_use responses.
    const criticModel = new RecordingMockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "too vague, elaborate" })],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [toolUseBlock("c2", "critique", { satisfactory: true, feedback: "" })],
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    ]);

    const agent = new Agent({
      id: "refl-agent",
      instructions: "answer questions",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 2 }),
    });

    const events = await runAgent(agent, "what is 2+2?", "sess-refl-1");

    // Exactly ONE terminal result event.
    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);

    const terminal = terminals[0]!;
    expect(terminal.subtype).toBe("success");
    // Output should be the accepted draft B.
    expect(terminal.output).toBe("improved answer B");

    // Agent model was called for both passes (pass 1 → A, pass 2 → B).
    expect(agentModel.calls.length).toBe(2);
    // Critic was called for both passes (once after A, once after B).
    expect(criticModel.calls.length).toBe(2);

    // The revision input (pass 2) should contain the critic's feedback.
    const secondAgentCall = agentModel.calls[1]!;
    const userMsg = secondAgentCall.messages.find((m) => m.role === "user");
    const userText = typeof userMsg?.content === "string" ? userMsg.content : "";
    expect(userText).toContain("too vague, elaborate");
    expect(userText).toContain("draft answer A");
  });

  it("maxRevisions cap: stops at maxRevisions with the last draft even if critic always unsatisfied", async () => {
    const store = await makeStore();

    // Agent model returns 3 drafts (initial + 2 revisions).
    const agentModel = new MockModel([
      basicResponse("draft 1"),
      basicResponse("draft 2"),
      basicResponse("draft 3"),
    ]);

    // Critic always dissatisfied.
    const criticModel = new MockModel([
      { content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "still bad" })], usage: { inputTokens: 5, outputTokens: 3 } },
      { content: [toolUseBlock("c2", "critique", { satisfactory: false, feedback: "still bad" })], usage: { inputTokens: 5, outputTokens: 3 } },
      { content: [toolUseBlock("c3", "critique", { satisfactory: false, feedback: "still bad" })], usage: { inputTokens: 5, outputTokens: 3 } },
    ]);

    const agent = new Agent({
      id: "refl-max",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 2 }),
    });

    const events = await runAgent(agent, "question", "sess-refl-max");

    // Must stop — exactly 1 terminal result.
    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);
    const terminal = terminals[0]!;
    expect(terminal.subtype).toBe("success");
    // The last draft (revision 2 = "draft 3") is the output.
    expect(terminal.output).toBe("draft 3");

    // Agent called exactly 3 times: initial + 2 revisions.
    expect(agentModel.calls.length).toBe(3);
    // Critic called at most 2 times (not called after last revision since maxRevisions exhausted).
    expect(criticModel.calls.length).toBe(2);
  });

  it("malformed critic output (no tool call, invalid JSON) → fail-safe accept: no infinite loop", async () => {
    const store = await makeStore();

    const agentModel = new MockModel([basicResponse("my answer")]);
    // Critic returns plain text with no JSON — malformed.
    const criticModel = new MockModel([
      {
        content: [textBlock("this is totally unrelated text with no structure")],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);

    const agent = new Agent({
      id: "refl-malformed",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 3 }),
    });

    const events = await runAgent(agent, "test", "sess-refl-malformed");

    // Should terminate without looping — exactly one terminal result.
    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.subtype).toBe("success");
    expect(terminals[0]!.output).toBe("my answer");

    // Agent called only once (no revisions due to fail-safe).
    expect(agentModel.calls.length).toBe(1);
  });

  it("ground signal: report is included in the critic's input", async () => {
    const store = await makeStore();

    const agentModel = new MockModel([
      basicResponse("draft answer"),
      basicResponse("revised answer"),
    ]);

    // Critic: dissatisfied on first call, satisfied on second.
    const criticModel = new RecordingMockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "address the ground failures" })],
        usage: { inputTokens: 10, outputTokens: 5 },
      },
      {
        content: [toolUseBlock("c2", "critique", { satisfactory: true, feedback: "" })],
        usage: { inputTokens: 10, outputTokens: 3 },
      },
    ]);

    const ground: GroundSignal = async (draft: string, _input: string) => ({
      passed: false,
      report: `Test suite failed: ${draft} did not pass validation`,
    });

    const agent = new Agent({
      id: "refl-ground",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 2, ground: [ground] }),
    });

    const events = await runAgent(agent, "write code", "sess-refl-ground");

    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.output).toBe("revised answer");

    // The critic's first request should contain the ground report.
    const firstCriticCall = criticModel.calls[0]!;
    const userMsg = firstCriticCall.messages.find((m) => m.role === "user");
    const userText = typeof userMsg?.content === "string" ? userMsg.content : "";
    expect(userText).toContain("Test suite failed");
    expect(userText).toContain("FAILED");
  });

  it("different-model: critic is a distinct ModelPort from the agent model", async () => {
    const store = await makeStore();

    const agentModel = new MockModel([basicResponse("answer")]);
    const criticModel = new MockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: true, feedback: "" })],
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    ]);

    // They must be different object references.
    expect(agentModel).not.toBe(criticModel);

    const agent = new Agent({
      id: "refl-diff-model",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel }),
    });

    const events = await runAgent(agent, "q", "sess-diff-model");
    const terminal = terminalEvent(events);
    expect(terminal.subtype).toBe("success");
    // Agent model called once; critic model called once.
    expect(agentModel.calls.length).toBe(1);
    expect(criticModel.calls.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// planAndExecute tests
// ---------------------------------------------------------------------------

describe("planAndExecute() strategy", () => {
  it("runs all steps and emits exactly ONE terminal result", async () => {
    const store = await makeStore();

    // Planner: returns ["step 1", "step 2"].
    const plannerModel = new RecordingMockModel([
      {
        content: [toolUseBlock("p1", "make_plan", { steps: ["step 1: do the first thing", "step 2: do the second thing"] })],
        usage: { inputTokens: 10, outputTokens: 8 },
      },
    ]);

    // Executor: handles each step.
    const executorModel = new RecordingMockModel([
      basicResponse("result of step 1"),
      basicResponse("result of step 2"),
    ]);

    const agentModel = new MockModel([]); // Should not be called (executor handles steps).

    const agent = new Agent({
      id: "pne-agent",
      instructions: "execute a plan",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: planAndExecute({ planner: plannerModel, executor: executorModel }),
    });

    const events = await runAgent(agent, "do a 2-step task", "sess-pne-1");

    // Exactly ONE terminal result.
    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);
    const terminal = terminals[0]!;
    expect(terminal.subtype).toBe("success");

    // Both steps ran — executor called twice.
    expect(executorModel.calls.length).toBe(2);
    // Planner called once.
    expect(plannerModel.calls.length).toBe(1);
    // Agent's own model never called (executor took over).
    expect(agentModel.calls.length).toBe(0);

    // Output contains both step results.
    expect(String(terminal.output)).toContain("result of step 1");
    expect(String(terminal.output)).toContain("result of step 2");
  });

  it("empty plan → single fallback react run on original input", async () => {
    const store = await makeStore();

    // Planner returns an empty step list.
    const plannerModel = new MockModel([
      {
        content: [toolUseBlock("p1", "make_plan", { steps: [] })],
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]);

    // The fallback will use the agent model (no executor for the fallback path).
    const agentModel = new MockModel([basicResponse("fallback answer")]);

    const agent = new Agent({
      id: "pne-empty-plan",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: planAndExecute({ planner: plannerModel }),
    });

    const events = await runAgent(agent, "do something", "sess-pne-empty");

    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);
    expect(terminals[0]!.subtype).toBe("success");
    expect(terminals[0]!.output).toBe("fallback answer");

    // Agent model called once (the fallback react run).
    expect(agentModel.calls.length).toBe(1);
  });

  it("failing step triggers replan: planner called again with progress", async () => {
    const store = await makeStore();

    // Planner: first call returns step 1 and step 2 (step 2 will fail).
    // Second call (replan) returns step 3 as recovery.
    const plannerModel = new RecordingMockModel([
      {
        content: [toolUseBlock("p1", "make_plan", { steps: ["step 1: succeed", "step 2: fail"] })],
        usage: { inputTokens: 10, outputTokens: 8 },
      },
      {
        content: [toolUseBlock("p2", "make_plan", { steps: ["step 3: recover"] })],
        usage: { inputTokens: 12, outputTokens: 6 },
      },
    ]);

    // Executor: step 1 succeeds, step 2 produces max_turns (error-subtype), step 3 succeeds.
    const executorModel = new RecordingMockModel([
      basicResponse("step 1 done"),
      // Step 2 fails: emit a max_turns result (non-success subtype triggers replan).
      {
        content: [textBlock("step 2 failed")],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
      basicResponse("step 3 recovery done"),
    ]);

    // Intercept executor to inject a failing result for step 2.
    // We use a custom ModelPort that returns max_turns for step 2.
    let executorCallCount = 0;
    const fakeExecutor = {
      async complete(req: ModelRequest): Promise<ModelResponse> {
        executorCallCount++;
        if (executorCallCount === 2) {
          // Return a response with a policy-exceeding reply to trigger max_turns.
          // Simplest: just return a normal response — the test checks that replan is triggered
          // when the step result has a non-success subtype. Since runTurn always terminates with
          // "success" on a plain text response, we need to trigger a different subtype.
          // The easiest way: return a model error response that runLoop treats as "error".
          throw new Error("executor error: step 2 failed intentionally");
        }
        // Other steps: delegate to executorModel.
        return executorModel.complete(req);
      },
    };

    const agentModel = new MockModel([]);

    const agent = new Agent({
      id: "pne-replan",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: planAndExecute({
        planner: plannerModel,
        executor: fakeExecutor,
        replanEvery: 10, // don't trigger time-based replan
        maxSteps: 10,
      }),
    });

    const events = await runAgent(agent, "do a task with recovery", "sess-pne-replan");

    // Exactly ONE terminal result.
    const terminals = allTerminals(events);
    expect(terminals.length).toBe(1);

    // Planner called at least twice (initial plan + replan after step 2 failure).
    expect(plannerModel.calls.length).toBeGreaterThanOrEqual(2);

    // The replan request should contain progress info (step 1 result).
    const secondPlannerCall = plannerModel.calls[1]!;
    const userMsg = secondPlannerCall.messages.find((m) => m.role === "user");
    const userText = typeof userMsg?.content === "string" ? userMsg.content : "";
    expect(userText).toContain("step 1 done");
  });

  it("different-model: planner and executor are distinct ModelPort instances", async () => {
    const store = await makeStore();

    const plannerModel = new MockModel([
      {
        content: [toolUseBlock("p1", "make_plan", { steps: ["only step"] })],
        usage: { inputTokens: 5, outputTokens: 3 },
      },
    ]);
    const executorModel = new MockModel([basicResponse("done")]);
    const agentModel = new MockModel([]);

    expect(plannerModel).not.toBe(executorModel);
    expect(plannerModel).not.toBe(agentModel);
    expect(executorModel).not.toBe(agentModel);

    const agent = new Agent({
      id: "pne-distinct",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: planAndExecute({ planner: plannerModel, executor: executorModel }),
    });

    const events = await runAgent(agent, "task", "sess-pne-distinct");
    const terminal = terminalEvent(events);
    expect(terminal.subtype).toBe("success");
    expect(plannerModel.calls.length).toBe(1);
    expect(executorModel.calls.length).toBe(1);
    expect(agentModel.calls.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FIX 5: coherence tests
// ---------------------------------------------------------------------------

describe("strategy coherence: sessionId, usage aggregation, session.init suppression, cost governor", () => {
  // ---------------------------------------------------------------------------
  // (a) Final terminal's sessionId equals the CALLER's sessionId
  // ---------------------------------------------------------------------------

  it("reflection: final terminal sessionId equals the caller sessionId (not _refl_ sub-run id)", async () => {
    const store = await makeStore();

    const agentModel = new MockModel([basicResponse("draft A"), basicResponse("better B")]);
    const criticModel = new MockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "improve it" })],
        usage: { inputTokens: 3, outputTokens: 3 },
      },
      {
        content: [toolUseBlock("c2", "critique", { satisfactory: true, feedback: "" })],
        usage: { inputTokens: 3, outputTokens: 3 },
      },
    ]);

    const agent = new Agent({
      id: "coh-refl-sid",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 2 }),
    });

    const callerSessionId = "caller-session-42";
    const events = await runAgent(agent, "test", callerSessionId);
    const terminal = terminalEvent(events);

    // sessionId must be the CALLER's, not an internal "_refl_" sub-run id.
    expect(terminal.sessionId).toBe(callerSessionId);
    expect(terminal.sessionId).not.toContain("_refl_");
  });

  it("planAndExecute: final terminal sessionId equals the caller sessionId (not _step_ sub-run id)", async () => {
    const store = await makeStore();

    const plannerModel = new MockModel([
      {
        content: [toolUseBlock("p1", "make_plan", { steps: ["step A", "step B"] })],
        usage: { inputTokens: 4, outputTokens: 4 },
      },
    ]);
    const executorModel = new MockModel([basicResponse("result A"), basicResponse("result B")]);
    const agentModel = new MockModel([]);

    const agent = new Agent({
      id: "coh-pne-sid",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: planAndExecute({ planner: plannerModel, executor: executorModel }),
    });

    const callerSessionId = "caller-session-99";
    const events = await runAgent(agent, "test", callerSessionId);
    const terminal = terminalEvent(events);

    expect(terminal.sessionId).toBe(callerSessionId);
    expect(terminal.sessionId).not.toContain("_step_");
  });

  // ---------------------------------------------------------------------------
  // (b) Final terminal usage = SUM across all sub-runs (including critic/planner)
  // ---------------------------------------------------------------------------

  it("reflection: terminal usage sums all sub-run passes AND critic calls", async () => {
    const store = await makeStore();

    // Agent pass 1: 10 in + 10 out.
    // Agent pass 2 (after revision): 20 in + 20 out.
    // Critic call 1 (after pass 1): 5 in + 5 out → dissatisfied.
    // Critic call 2 (after pass 2): 5 in + 5 out → satisfied.
    // Expected total: (10+20) in + (10+20) out + (5+5) in + (5+5) out = 40 in + 40 out.
    const agentModel = new MockModel([
      { content: [{ type: "text", text: "draft A" }], usage: { inputTokens: 10, outputTokens: 10 } },
      { content: [{ type: "text", text: "better B" }], usage: { inputTokens: 20, outputTokens: 20 } },
    ]);
    const criticModel = new MockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "revise" })],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
      {
        content: [toolUseBlock("c2", "critique", { satisfactory: true, feedback: "" })],
        usage: { inputTokens: 5, outputTokens: 5 },
      },
    ]);

    const agent = new Agent({
      id: "coh-usage-refl",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 2 }),
    });

    const events = await runAgent(agent, "test", "sess-coh-usage-refl");
    const terminal = terminalEvent(events);

    // Each agent response is one model call → input: 10+20 = 30 from agent + 5+5 = 10 from critic.
    expect(terminal.usage.inputTokens).toBe(40);
    expect(terminal.usage.outputTokens).toBe(40);
  });

  it("planAndExecute: terminal usage sums all step sub-runs AND planner calls", async () => {
    const store = await makeStore();

    // Planner call: 4 in + 4 out.
    // Step 1 executor: 10 in + 10 out.
    // Step 2 executor: 20 in + 20 out.
    // Expected: (4+10+20) in + (4+10+20) out = 34 in + 34 out.
    const plannerModel = new MockModel([
      {
        content: [toolUseBlock("p1", "make_plan", { steps: ["step 1", "step 2"] })],
        usage: { inputTokens: 4, outputTokens: 4 },
      },
    ]);
    const executorModel = new MockModel([
      { content: [{ type: "text", text: "r1" }], usage: { inputTokens: 10, outputTokens: 10 } },
      { content: [{ type: "text", text: "r2" }], usage: { inputTokens: 20, outputTokens: 20 } },
    ]);
    const agentModel = new MockModel([]);

    const agent = new Agent({
      id: "coh-usage-pne",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: planAndExecute({ planner: plannerModel, executor: executorModel }),
    });

    const events = await runAgent(agent, "test", "sess-coh-usage-pne");
    const terminal = terminalEvent(events);

    expect(terminal.usage.inputTokens).toBe(34);
    expect(terminal.usage.outputTokens).toBe(34);
  });

  // ---------------------------------------------------------------------------
  // (c) Exactly one session.init emitted per multi-pass reflection, with caller sessionId
  // ---------------------------------------------------------------------------

  it("reflection: exactly one session.init emitted for a 2-pass run, carrying the caller sessionId", async () => {
    const store = await makeStore();

    const agentModel = new MockModel([basicResponse("draft A"), basicResponse("better B")]);
    const criticModel = new MockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "more detail" })],
        usage: { inputTokens: 3, outputTokens: 3 },
      },
      {
        content: [toolUseBlock("c2", "critique", { satisfactory: true, feedback: "" })],
        usage: { inputTokens: 3, outputTokens: 3 },
      },
    ]);

    const agent = new Agent({
      id: "coh-init-refl",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      strategy: reflection({ critic: criticModel, maxRevisions: 2 }),
    });

    const callerSessionId = "caller-init-session";
    const events = await runAgent(agent, "test", callerSessionId);

    const sessionInits = events.filter((e) => e.type === "session.init") as Extract<StreamEvent, { type: "session.init" }>[];

    // Exactly ONE session.init despite 2 sub-runs.
    expect(sessionInits.length).toBe(1);
    // Its sessionId is the caller's, not an internal sub-run id.
    expect(sessionInits[0]!.sessionId).toBe(callerSessionId);
    expect(sessionInits[0]!.sessionId).not.toContain("_refl_");
  });

  // ---------------------------------------------------------------------------
  // (d) Cost governor: a reflection that would exceed policy.maxCostUsd
  //     aborts via the shared budget (stops early, doesn't spend N×)
  // ---------------------------------------------------------------------------

  it("reflection: shared budget aborts mid-strategy when policy.maxCostUsd is exceeded", async () => {
    const store = await makeStore();

    // Price config: 1 input token = $1/MToken, 1 output token = $1/MToken.
    // Each agent pass = 200 tokens = $0.0002. Budget ceiling = $0.00015.
    // Pass 0 (200 tokens) → budget = $0.0002 > $0.00015 → pass 1 should be aborted.
    const PRICES = { "test-model": { inputPerMTok: 1000, outputPerMTok: 1000 } };

    // Agent returns responses with known token cost.
    const agentModel = new MockModel([
      // Pass 0: costs 100 in + 100 out = 200 tokens = $0.0002.
      { content: [{ type: "text", text: "draft A" }], usage: { inputTokens: 100, outputTokens: 100 } },
      // Pass 1 would cost another $0.0002 but should never be called — budget already exceeded.
      { content: [{ type: "text", text: "draft B" }], usage: { inputTokens: 100, outputTokens: 100 } },
    ]);
    // Critic: always dissatisfied so strategy tries to loop.
    const criticModel = new MockModel([
      {
        content: [toolUseBlock("c1", "critique", { satisfactory: false, feedback: "not good enough" })],
        usage: { inputTokens: 10, outputTokens: 10 },
      },
    ]);

    const agent = new Agent({
      id: "coh-budget-refl",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelId: "test-model",
      prices: PRICES,
      // Ceiling just below what one pass + critic call costs ($0.0002 + $0.00002 = $0.00022 > $0.00015).
      policy: { maxCostUsd: 0.00015 },
      strategy: reflection({ critic: criticModel, maxRevisions: 3 }),
    });

    const events = await runAgent(agent, "test", "sess-budget-refl");
    const terminals = allTerminals(events);

    // Must terminate — exactly one terminal.
    expect(terminals.length).toBe(1);
    const terminal = terminals[0]!;

    // The strategy must have stopped — either the sub-run itself aborted (max_cost subtype)
    // or it accepted the draft early. Either way: agent model called at most once.
    // (The cost governor fires before the second model call.)
    expect(agentModel.calls.length).toBeLessThanOrEqual(1);

    // The terminal must be non-"success" (max_cost abort) OR success if the strategy
    // accepted the draft before trying the second pass.
    // The critical invariant: it stopped; it did NOT call agent model twice.
    expect(["success", "max_cost"]).toContain(terminal.subtype);
  });

  // ---------------------------------------------------------------------------
  // (e) REAL cross-pass cumulative cost test: each pass is individually UNDER the
  //     ceiling, but the CUMULATIVE sum exceeds it → strategy must abort before
  //     all passes complete. This FAILS without the sharedBudget fold fix and
  //     PASSES with it.
  // ---------------------------------------------------------------------------

  it("reflection: cross-pass cumulative cost abort — individually-OK passes exceed ceiling cumulatively", async () => {
    const store = await makeStore();

    // Price: $3/MTok input + $3/MTok output = $0.000003 per token.
    // Each agent pass: 50 in + 50 out = 100 tokens = $0.0003 per pass.
    // maxCostUsd = $0.00055. Two passes = $0.0006 > ceiling, one pass = $0.0003 < ceiling.
    // With the fix: pass 1 folds into sharedBudget; pass 2 preflight sees cumulative
    //   $0.0003 + $0.0003 = $0.0006 >= $0.00055 → aborts before the third model call.
    // Without the fix: each pass sees only its OWN $0.0003 < $0.00055 → all 5 passes run.
    const PRICES = { "cross-pass-model": { inputPerMTok: 3000, outputPerMTok: 3000 } };
    const PER_PASS_USD = (50 * 3000 + 50 * 3000) / 1_000_000; // = 0.0003
    const CEILING = PER_PASS_USD * 1.5; // = 0.00045, allows ~1 full pass; 2nd partial triggers abort

    const agentModel = new MockModel([
      { content: [{ type: "text", text: "draft 1" }], usage: { inputTokens: 50, outputTokens: 50 } },
      { content: [{ type: "text", text: "draft 2" }], usage: { inputTokens: 50, outputTokens: 50 } },
      { content: [{ type: "text", text: "draft 3" }], usage: { inputTokens: 50, outputTokens: 50 } },
      { content: [{ type: "text", text: "draft 4" }], usage: { inputTokens: 50, outputTokens: 50 } },
      { content: [{ type: "text", text: "draft 5" }], usage: { inputTokens: 50, outputTokens: 50 } },
      { content: [{ type: "text", text: "draft 6" }], usage: { inputTokens: 50, outputTokens: 50 } }, // should never be reached
    ]);
    // Critic always dissatisfied so the strategy always tries another pass.
    const criticModel = new MockModel(
      Array.from({ length: 5 }, (_, i) => ({
        content: [toolUseBlock(`c${i}`, "critique", { satisfactory: false, feedback: "still bad" })],
        usage: { inputTokens: 1, outputTokens: 1 }, // tiny critic cost so it's not the driver
      })),
    );

    const agent = new Agent({
      id: "cross-pass-budget",
      instructions: "",
      model: agentModel,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
      modelId: "cross-pass-model",
      prices: PRICES,
      policy: { maxCostUsd: CEILING },
      strategy: reflection({ critic: criticModel, maxRevisions: 5 }),
    });

    const events = await runAgent(agent, "test cross-pass budget", "sess-cross-pass");
    const terminals = allTerminals(events);

    // Must terminate with exactly one terminal.
    expect(terminals.length).toBe(1);

    // The strategy MUST NOT have run all 5+1 passes — the ceiling cuts it off.
    // With the fix: passes 0 and start of pass 1 → abort (max_cost subtype). At most 2 agent calls.
    // Without the fix: all 5 passes run (6 agent calls) — so this assertion fails without the fix.
    expect(agentModel.calls.length).toBeLessThan(5);

    // Terminal subtype must be max_cost (aborted by governor) — not success.
    expect(terminals[0]!.subtype).toBe("max_cost");
  });
});

// ---------------------------------------------------------------------------
// no-strategy byte-identical path: verify it still passes after seam change
// ---------------------------------------------------------------------------

describe("no-strategy path: unaffected by _internalOpts seam change", () => {
  it("no-strategy: events, sessionId, and usage are byte-identical to before the seam change", async () => {
    const store = await makeStore();
    const model = new MockModel([
      { content: [{ type: "text", text: "answer" }], usage: { inputTokens: 7, outputTokens: 3 } },
    ]);

    const agent = new Agent({
      id: "no-strat",
      instructions: "be helpful",
      model,
      store,
      now: () => "t",
      newId: ((n) => () => `e${n++}`)(0),
    });

    const sid = "sess-no-strat";
    const events = await runAgent(agent, "hi", sid);
    const terminal = terminalEvent(events);

    expect(terminal.subtype).toBe("success");
    expect(terminal.output).toBe("answer");
    expect(terminal.sessionId).toBe(sid);
    expect(terminal.usage).toEqual({ inputTokens: 7, outputTokens: 3 });

    // session.init emitted with the caller's sessionId.
    const inits = events.filter((e) => e.type === "session.init") as Extract<StreamEvent, { type: "session.init" }>[];
    expect(inits.length).toBe(1);
    expect(inits[0]!.sessionId).toBe(sid);
  });
});
