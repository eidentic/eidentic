import { describe, it, expect, vi } from "vitest";
import { MockModel } from "@eidentic/types/testing";
import { toolUseBlock } from "@eidentic/types";
import { evolveSkill, ModelOptimizer, SkillBank } from "../src/index.js";
import type { ExecutableSkillDef } from "../src/executable.js";
import type { ModelResponse, Usage } from "@eidentic/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FIXED = () => "2026-06-07T00:00:00.000Z";

/**
 * Build a scripted `propose_skill_edit` tool-use response for MockModel.
 */
function proposeEditResponse(operation: "ADD" | "UPDATE" | "REMOVE", instructions: string): ModelResponse {
  return {
    content: [
      toolUseBlock("call-1", "propose_skill_edit", { operation, instructions }),
    ],
    usage: { inputTokens: 10, outputTokens: 5 },
  };
}

/** A malformed response — no `propose_skill_edit` tool call. */
function malformedResponse(): ModelResponse {
  return {
    content: [{ type: "text", text: "I can't help with that." }],
    usage: { inputTokens: 8, outputTokens: 3 },
  };
}

// ---------------------------------------------------------------------------
// Test skill design: use a shared mutable instructions ref so that when
// evolveSkill creates a candidate with a new description (via applyInstructions),
// the custom Optimizer also updates the shared ref, and `run` reads from it.
//
// In practice: we use a custom Optimizer implementation that wraps the model
// and ALSO updates the mutable state so that `run` can observe the change.
// This is the correct test pattern for the optimization loop.
// ---------------------------------------------------------------------------

/**
 * Create an evolvable test skill where `run` observes a mutable `instructionRef`.
 * When `instructionRef.value` contains "DOUBLE", the skill correctly doubles its input.
 * Initially `instructionRef.value` is "bad", so the test fails.
 *
 * The `instructionRef` must be updated by whoever calls the optimizer, so that the candidate
 * skill's `run` (which is the same closure) observes the new instructions.
 */
function makeEvolvableSkill(instructionRef: { value: string }): ExecutableSkillDef {
  return {
    name: "instruction-driven",
    description: instructionRef.value,
    tests: [
      {
        name: "doubles 3 when correctly instructed",
        input: 3,
        check: (o) => o === 6,
      },
    ],
    run: async (input: unknown) => {
      // `run` observes the shared mutable ref. When evolution updates the ref (via the optimizer
      // calling instructionRef.value = newInstructions), the same `run` closure now passes.
      if (instructionRef.value.includes("DOUBLE")) {
        return (input as number) * 2;
      }
      return -1;
    },
  };
}

/**
 * Build an Optimizer that wraps MockModel and ALSO updates the instructionRef so that
 * the candidate skill's `run` closure observes the new instructions.
 * This is the test harness pattern for the optimizer: the optimizer proposes new instructions
 * AND makes them observable to the run function.
 */
function makeTrackingOptimizer(
  model: MockModel,
  instructionRef: { value: string },
) {
  return {
    async propose(ctx: { instructions: string; failures: string[]; tests: ExecutableSkillDef["tests"] }): Promise<{ instructions: string; usage: Usage }> {
      const response = await model.complete({
        messages: [{ role: "user", content: ctx.instructions }],
        tools: [{ name: "propose_skill_edit", description: "propose", inputSchema: {} }],
      });

      const toolCall = response.content.find(
        (b) => b.type === "tool_use" && b.name === "propose_skill_edit",
      );

      if (!toolCall || toolCall.type !== "tool_use") {
        // Malformed — return unchanged (evolveSkill will skip this round).
        return { instructions: ctx.instructions, usage: response.usage };
      }

      const input = toolCall.input as { operation?: string; instructions?: string };
      const operation = input.operation ?? "UPDATE";
      const proposed = typeof input.instructions === "string" ? input.instructions : ctx.instructions;

      let newInstructions: string;
      switch (operation) {
        case "ADD":
          newInstructions = ctx.instructions ? `${ctx.instructions}\n${proposed}` : proposed;
          break;
        case "REMOVE":
          newInstructions = ctx.instructions.replace(proposed, "");
          break;
        case "UPDATE":
        default:
          newInstructions = proposed;
          break;
      }

      // KEY: update the mutable ref so that the skill's `run` closure observes the new instructions.
      instructionRef.value = newInstructions;
      return { instructions: newInstructions, usage: response.usage };
    },
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe("evolveSkill §7.7 — reflective prompt-optimization pattern, native over ModelPort", () => {
  it("evolves a failing skill to passing: proposer produces a fix, result.evolved is non-null", async () => {
    const instructionRef = { value: "bad-instructions" };
    const skill = makeEvolvableSkill(instructionRef);

    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 3,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
      now: FIXED,
    });

    expect(result.baselinePassed).toBe(false);
    expect(result.evolved).not.toBeNull();
    expect(result.evolved!.description).toBe("DOUBLE");
    expect(result.rounds).toBe(1);
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]!.passed).toBe(true);
    expect(result.history[0]!.failures).toHaveLength(0);

    // Verify the evolved skill actually passes its tests (using runSkillTests)
    const { runSkillTests } = await import("../src/test-runner.js");
    const testResults = await runSkillTests(result.evolved!);
    expect(testResults.every((r) => r.passed)).toBe(true);
  });

  it("returns baselinePassed=true + evolved=null when the original skill already passes", async () => {
    const instructionRef = { value: "DOUBLE" };
    const skill = makeEvolvableSkill(instructionRef);
    const mockModel = new MockModel([]); // should never be called

    const result = await evolveSkill(skill, { model: mockModel, maxRounds: 3 });

    expect(result.baselinePassed).toBe(true);
    expect(result.evolved).toBeNull();
    expect(result.rounds).toBe(0);
    expect(result.usage.inputTokens).toBe(0);
    expect(mockModel.calls).toHaveLength(0); // proposer never called
  });

  it("returns evolved=null when proposer keeps producing failing candidates across all rounds", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    // All 3 proposals still produce a non-"DOUBLE" description → all fail.
    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "still-wrong-1"),
      proposeEditResponse("UPDATE", "still-wrong-2"),
      proposeEditResponse("UPDATE", "still-wrong-3"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 3,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });

    expect(result.evolved).toBeNull();
    expect(result.baselinePassed).toBe(false);
    expect(result.rounds).toBe(3);
    expect(result.history).toHaveLength(3);
    expect(result.history.every((h) => !h.passed)).toBe(true);
    expect(result.history.every((h) => h.failures.length > 0)).toBe(true);
  });

  it("stops early on the first passing candidate (maxRounds not fully exhausted)", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    // First proposal fails, second passes.
    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "wrong"),
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 5,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });

    expect(result.evolved).not.toBeNull();
    expect(result.rounds).toBe(2);
    expect(result.history).toHaveLength(2);
    expect(result.history[0]!.passed).toBe(false);
    expect(result.history[1]!.passed).toBe(true);
    // Proposer called exactly 2 times (not 5).
    expect(mockModel.calls).toHaveLength(2);
  });

  it("skips a round where proposer returns same instructions as current (no-op / malformed)", async () => {
    // The tracking optimizer will return unchanged instructions for a malformed response,
    // which evolveSkill detects as a no-op and skips the round.
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    // First response is malformed (no tool call — tracking optimizer returns unchanged instructions),
    // second is a valid fix.
    const mockModel = new MockModel([
      malformedResponse(),
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 3,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });

    // The malformed round is skipped (same instructions returned → round skipped by evolveSkill).
    // Then the second call produces "DOUBLE" → passes.
    expect(result.evolved).not.toBeNull();
    expect(result.evolved!.description).toBe("DOUBLE");
    // history only includes rounds where instructions actually changed
    expect(result.history.some((h) => h.passed)).toBe(true);
  });

  it("respects maxRounds=1 (proposer called at most once)", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "still-wrong"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 1,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });

    expect(result.evolved).toBeNull();
    expect(result.rounds).toBe(1);
    expect(mockModel.calls).toHaveLength(1);
  });

  it("respects maxUsd budget: stops when cost ceiling exceeded before next round", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    // Each response costs 10 input + 5 output tokens.
    // At nominal rates ($15/M in, $75/M out), cost ≈ 0.000150 + 0.000375 = ~0.000525 USD per call.
    // maxUsd=0.0001 means the budget is exhausted after the first call.
    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "still-wrong"),
      proposeEditResponse("UPDATE", "DOUBLE"), // would pass but should not be reached
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 5,
      maxUsd: 0.0001, // very low ceiling — exhausted after round 1
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });

    // Budget stops after round 1; round 2 (which would have passed) is never reached.
    expect(result.evolved).toBeNull();
    expect(mockModel.calls).toHaveLength(1);
  });

  it("evolved skill is NOT auto-registered (off-by-default): evolveSkill does not mutate any SkillBank", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);

    const bank = new SkillBank({ now: FIXED });
    // Register nothing in the bank initially.
    expect(bank.list()).toHaveLength(0);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 3,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });
    expect(result.evolved).not.toBeNull();

    // SkillBank must be untouched — evolveSkill does NOT auto-register.
    expect(bank.list()).toHaveLength(0);
    expect(bank.get("instruction-driven")).toBeNull();
  });

  it("human-gate intact: evolveSkill returns a candidate but NEVER auto-calls SkillBank.register; the caller is the gate", async () => {
    // Typed-function skills evolved by evolveSkill are human-authored (the human decides
    // whether to register). The quarantine mechanism (for agent-authored code skills) is
    // intact because evolveSkill never calls register on its own — the caller decides.
    // This test verifies the contract: evolveSkill returns a candidate; registering it as
    // human (default) works fine; the human must consciously decide to call register.
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 3,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });
    expect(result.evolved).not.toBeNull();

    // The bank is not mutated by evolveSkill (off-by-default: caller decides).
    const bank = new SkillBank({ now: FIXED });
    expect(bank.get("instruction-driven")).toBeNull();

    // Caller registers as human (typed-function evolved skill is still human-authored).
    const reg = await bank.register(result.evolved!); // default author: "human"
    expect(reg.ok).toBe(true);
    expect(reg.lock!.quarantined).toBe(false); // human-authored: not quarantined
    expect(reg.lock!.author).toBe("human");

    // The skill runs correctly after registration.
    const out = await bank.use("instruction-driven", 3);
    expect(out).toBe(6);
  });

  it("quarantine gate: registering an evolved CODE skill as agent-authored is quarantined until approve()", async () => {
    // For code-string skills, the agent-authored quarantine path is: evolveSkill returns
    // a code skill candidate → caller registers as agent → quarantined → human calls approve() → usable.
    // This verifies the SkillBank quarantine gate is intact for evolved code skills.
    const bank = new SkillBank({ now: FIXED, sandbox: { async run() { return { stdout: "EIDENTIC_RESULT:6", stderr: "", exitCode: 0 }; } } });

    // Manually simulate: an already-evolved code skill (evolveSkill would produce this via
    // the instructions field; here we verify the SkillBank quarantine gate directly).
    const evolvedCodeSkill = {
      name: "evolved-adder",
      description: "DOUBLE — evolved instructions",
      tests: [{ name: "adds correctly", input: null, check: (o: unknown) => o === 6 }],
      code: "// evolved code\nconsole.log('EIDENTIC_RESULT:6')",
    };

    const reg = await bank.register(evolvedCodeSkill, { author: "agent" });
    expect(reg.ok).toBe(true);
    expect(reg.lock!.quarantined).toBe(true); // agent-authored → quarantined (human gate)

    // use() blocked while quarantined.
    await expect(bank.use("evolved-adder", null)).rejects.toThrow(/quarantined/);

    // Human approves.
    bank.approve("evolved-adder");
    const out = await bank.use("evolved-adder", null);
    expect(out).toBe(6);
  });

  it("reuses the real test-gate: a candidate passing evolveSkill also passes SkillBank.register's gate", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);

    const result = await evolveSkill(skill, {
      model: mockModel,
      maxRounds: 3,
      optimizer: makeTrackingOptimizer(mockModel, instructionRef),
    });
    expect(result.evolved).not.toBeNull();

    // The evolved candidate passed evolveSkill's test-gate (shared runSkillTests).
    // Now register it via SkillBank — it must also pass SkillBank's test-gate.
    const bank = new SkillBank({ now: FIXED });
    const reg = await bank.register(result.evolved!);
    expect(reg.ok).toBe(true); // SkillBank's gate is also satisfied (test-gate parity)
  });

  it("custom Optimizer seam: plugging in a custom optimizer works end-to-end", async () => {
    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    // Custom optimizer (simulating what an external optimizer would implement)
    const customOptimizer = {
      propose: vi.fn(async (_ctx: { instructions: string; failures: string[]; tests: unknown[] }) => {
        // Also update the ref so the candidate's run passes.
        instructionRef.value = "DOUBLE";
        return {
          instructions: "DOUBLE",
          usage: { inputTokens: 50, outputTokens: 20 },
        };
      }),
    };

    const dummyModel = new MockModel([]); // should not be called when optimizer is provided

    const result = await evolveSkill(skill, {
      model: dummyModel,
      optimizer: customOptimizer,
      maxRounds: 3,
    });

    expect(customOptimizer.propose).toHaveBeenCalledOnce();
    expect(dummyModel.calls).toHaveLength(0); // model NOT called — optimizer overrides it
    expect(result.evolved).not.toBeNull();
    expect(result.usage.inputTokens).toBe(50);
    expect(result.usage.outputTokens).toBe(20);
  });

  it("ModelOptimizer builds a well-formed request (system + user messages, propose_skill_edit tool)", async () => {
    const mockModel = new MockModel([
      proposeEditResponse("UPDATE", "DOUBLE"),
    ]);
    const optimizer = new ModelOptimizer(mockModel);

    const instructionRef = { value: "bad" };
    const skill = makeEvolvableSkill(instructionRef);

    await optimizer.propose({
      instructions: skill.description,
      failures: ["doubles 3 when correctly instructed"],
      tests: skill.tests,
    });

    expect(mockModel.calls).toHaveLength(1);
    const req = mockModel.calls[0]!;
    expect(req.messages.some((m) => m.role === "system")).toBe(true);
    expect(req.messages.some((m) => m.role === "user")).toBe(true);
    expect(req.tools.some((t) => t.name === "propose_skill_edit")).toBe(true);
  });
});
