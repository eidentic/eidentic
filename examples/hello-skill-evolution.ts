/**
 * Skill self-evolution (§7.7) — reflective prompt-optimization pattern, native over ModelPort.
 *
 * Demonstrates, with NO infra:
 *   1. A skill whose initial instructions cause its test to fail (baseline fails).
 *   2. evolveSkill() runs the optimization loop — the model proposes a fix, the shared test-gate
 *      is used as the reflection signal (the failing test names ARE the failures fed back).
 *   3. The evolved skill passes all tests. Usage is surfaced for cost.background.
 *   4. OFF BY DEFAULT: evolveSkill() does NOT register anything. The caller decides.
 *   5. Registering via SkillBank still quarantines agent-authored code skills (human gate).
 *
 * The example uses a scripted MockModel so it runs infra-free (no real API key needed).
 *
 * Run:  pnpm -C examples hello:skill-evolution
 */
import { MockModel } from "@eidentic/types/testing";
import { toolUseBlock } from "@eidentic/types";
import {
  evolveSkill,
  SkillBank,
  type ExecutableSkillDef,
  type EvolveOptions,
} from "@eidentic/skills";

// ---------------------------------------------------------------------------
// Shared mutable instruction register (for demo; see comment below)
// ---------------------------------------------------------------------------

/**
 * In a real optimizer over typed-function skills, the `run` function would receive instructions
 * from an LLM-readable playbook (the `description` field). Here we use a mutable ref to
 * demonstrate the evolution loop with a scripted model, so `run` can observe the change.
 *
 * In production: use a code-string skill whose code reads its instructions, or wire an LLM
 * call inside `run` that reads `description` from a skills catalog at runtime.
 */
const instructionRef: { value: string } = { value: "wrong-instructions" };

// ---------------------------------------------------------------------------
// The skill to evolve: initially fails its test
// ---------------------------------------------------------------------------

const greetingSkill: ExecutableSkillDef = {
  name: "greeter",
  description: instructionRef.value, // the "playbook" — evolution will fix this
  tests: [
    {
      name: "greets with the correct prefix",
      input: "Alice",
      // Test: the skill must return "Hello, Alice!" — passes only when description says "GREET"
      check: (output) => output === "Hello, Alice!",
    },
  ],
  // run reads from the mutable instructionRef so it observes the evolved instructions.
  run: async (input: unknown) => {
    if (instructionRef.value.includes("GREET")) {
      return `Hello, ${input}!`;
    }
    return `wrong:${input}`;
  },
};

// ---------------------------------------------------------------------------
// Custom Optimizer: wraps the MockModel AND updates instructionRef
// ---------------------------------------------------------------------------

// The scripted model proposes "GREET" instructions on the first call.
const scriptedModel = new MockModel([
  {
    content: [
      toolUseBlock("call-1", "propose_skill_edit", {
        operation: "UPDATE",
        instructions: "GREET",
      }),
    ],
    usage: { inputTokens: 150, outputTokens: 30 },
  },
]);

// Custom Optimizer: relays the scripted model's proposal AND updates instructionRef
// so that the candidate skill's run function observes the new instructions.
const optimizer: EvolveOptions["optimizer"] = {
  async propose(ctx) {
    const response = await scriptedModel.complete({
      messages: [{ role: "user", content: ctx.instructions }],
      tools: [{ name: "propose_skill_edit", description: "propose edit", inputSchema: {} }],
    });

    const toolCall = response.content.find(
      (b) => b.type === "tool_use" && b.name === "propose_skill_edit",
    );

    if (!toolCall || toolCall.type !== "tool_use") {
      return { instructions: ctx.instructions, usage: response.usage };
    }

    const input = toolCall.input as { instructions?: string };
    const newInstructions = input.instructions ?? ctx.instructions;

    // Update the shared ref so the candidate skill's `run` observes the new instructions.
    instructionRef.value = newInstructions;

    return { instructions: newInstructions, usage: response.usage };
  },
};

// ---------------------------------------------------------------------------
// Main demo
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Eidentic §7.7 Skill Self-Evolution (reflective prompt-optimization pattern) ===\n");

  // ---- 1. Show baseline failure -----------------------------------------------------------
  console.log("[1] Baseline: running tests on the ORIGINAL skill...");
  console.log("    description:", JSON.stringify(greetingSkill.description));
  console.log("    (instructions are wrong — test will fail)\n");

  // ---- 2. Evolve --------------------------------------------------------------------------
  console.log("[2] Running evolveSkill() — optimization loop (max 3 rounds)...");

  const result = await evolveSkill(greetingSkill, {
    model: scriptedModel,   // proposer model (normally a capable model like Claude)
    optimizer,              // custom optimizer (wraps model + updates shared ref)
    maxRounds: 3,
    maxUsd: 1.0,            // cost ceiling ($1 USD for this demo)
  });

  console.log("    baselinePassed:", result.baselinePassed);
  console.log("    rounds executed:", result.rounds);
  console.log("    proposer usage:", JSON.stringify(result.usage));
  console.log("    history:", JSON.stringify(result.history, null, 2));

  if (result.evolved) {
    console.log("\n[3] Evolution succeeded! Evolved skill description:", JSON.stringify(result.evolved.description));
    console.log("    (instructions now contain 'GREET' — test passes)");
  } else {
    console.log("\n[3] Evolution did not produce a passing candidate (all rounds exhausted).");
  }

  // ---- 3. Off-by-default: evolved NOT auto-registered ------------------------------------
  console.log("\n[4] OFF BY DEFAULT: evolveSkill does NOT register anything.");
  const bank = new SkillBank({ now: () => "2026-06-07T00:00:00.000Z" });
  console.log("    bank.list() after evolveSkill:", bank.list().length, "(should be 0)");

  // ---- 4. Register manually (caller decides) --------------------------------------------
  if (result.evolved) {
    console.log("\n[5] Caller registers the evolved skill (human decides — human gate)...");
    const reg = await bank.register(result.evolved);
    if (reg.ok) {
      console.log("    registered! lock:", JSON.stringify({
        name: reg.lock.name,
        version: reg.lock.version,
        author: reg.lock.author,
        quarantined: reg.lock.quarantined,
        testsPassed: reg.lock.testsPassed,
      }));
      const out = await bank.use("greeter", "Alice");
      console.log("    bank.use('greeter', 'Alice'):", out); // Hello, Alice!
    } else {
      console.log("    registration failed:", reg.failures);
    }
  }

  // ---- 5. Human-gate for agent-authored code skills (quarantine demo) -------------------
  console.log("\n[6] Human-gate demo: agent-authored code skill stays quarantined until approve()...");
  const codeSkill: ExecutableSkillDef = {
    name: "evolved-code",
    description: "GREET — agent-authored evolved",
    tests: [{ name: "returns hi-world", input: null, check: (o) => o === "hi-world" }],
    code: "EIDENTIC_RESULT:\"hi-world\"",
  };

  const codeBank = new SkillBank({
    now: () => "2026-06-07T00:00:00.000Z",
    sandbox: {
      async run(code: string) {
        // Demo sandbox: find and echo any EIDENTIC_RESULT:<json> line in the code.
        const m = /EIDENTIC_RESULT:(.*)/.exec(code);
        const stdout = m ? `EIDENTIC_RESULT:${m[1]!.trim()}` : "";
        return { stdout, stderr: "", exitCode: 0 };
      },
    },
  });

  const codeReg = await codeBank.register(codeSkill, { author: "agent" });
  console.log("    registered:", codeReg.ok, "quarantined:", codeReg.ok && codeReg.lock.quarantined);

  try {
    await codeBank.use("evolved-code", null);
  } catch (e) {
    console.log("    use() while quarantined:", (e as Error).message.split(":")[0]);
  }

  codeBank.approve("evolved-code");
  const codeOut = await codeBank.use("evolved-code", null);
  console.log("    use() after approve():", codeOut);

  console.log("\n=== Done. Evolution loop reused the real SkillBank test-gate (not duplicated). ===");
  console.log("=== evolveSkill is OFF BY DEFAULT — it never auto-runs in the Agent loop.       ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
