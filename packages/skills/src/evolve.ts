/**
 * §7.7 Skill self-evolution — the reflective prompt-optimization pattern, implemented natively over ModelPort.
 *
 * Architecture decision: the Eidentic design (§7.7) names an external prompt-optimization library as the optimizer.
 * That library ships its own model-client layer that conflicts with Eidentic's BYO-ModelPort architecture.
 * We therefore implement a reflective prompt-optimization algorithm natively over ModelPort (the test-gate IS the
 * reflection signal) and expose an `Optimizer` seam so an external optimizer can be plugged in later as
 * one `Optimizer` implementation. No external optimizer library is added as a dependency.
 *
 * OFF BY DEFAULT: `evolveSkill` is an opt-in function. It never auto-runs in the Agent loop.
 * NEVER auto-registers: the caller must call `SkillBank.register()`, which quarantines
 * agent-authored candidates until a human calls `approve()` (the human gate).
 */

import type { ModelPort, ModelMessage, Usage } from "@eidentic/types";
import type { ExecutableSkillDef, SkillTest } from "./executable.js";
import { runSkillTests } from "./test-runner.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvolveOptions {
  /** A capable model that proposes instruction edits (the proposer). */
  model: ModelPort;
  /** Maximum refinement rounds. Default 3. Cost-bounded. */
  maxRounds?: number;
  /**
   * Optional cost ceiling in USD. When `usage` cost (estimated from token counts at a nominal
   * $15/M-input, $75/M-output pricing) exceeds this, the loop stops early. Omit for no ceiling.
   */
  maxUsd?: number;
  /**
   * Override the default native optimizer with a custom one. Intended for plugging in
   * an external optimizer — implement `Optimizer` there and pass the instance here.
   */
  optimizer?: Optimizer;
  /** Injected clock (deterministic in tests). */
  now?: () => string;
}

export interface EvolveResult {
  /** The best evolved candidate that passes ALL tests, or null if none improved on the baseline. */
  evolved: ExecutableSkillDef | null;
  /** Whether the original skill already passed its tests before any evolution. */
  baselinePassed: boolean;
  /** Number of proposer rounds executed (≤ maxRounds). */
  rounds: number;
  /** Total proposer model usage (surface to cost.background accounting). */
  usage: Usage;
  /** Per-round outcome history (for debugging / audit). */
  history: Array<{ round: number; passed: boolean; failures: string[] }>;
}

/**
 * Optimizer seam: implement this interface to plug in a custom proposer (e.g. an external prompt optimizer).
 * The default is `ModelOptimizer` (native implementation using ModelPort).
 */
export interface Optimizer {
  propose(ctx: {
    instructions: string;
    failures: string[];
    tests: SkillTest[];
  }): Promise<{ instructions: string; usage: Usage }>;
}

// ---------------------------------------------------------------------------
// Native ModelOptimizer — the reflective proposer over ModelPort
// ---------------------------------------------------------------------------

/** JSON schema for the `propose_skill_edit` tool (bounded instruction edit). */
const PROPOSE_SKILL_EDIT_SCHEMA = {
  type: "object",
  required: ["operation", "instructions"],
  properties: {
    operation: {
      type: "string",
      enum: ["ADD", "UPDATE", "REMOVE"],
      description: "ADD appends to existing instructions, UPDATE replaces them, REMOVE deletes specific text.",
    },
    instructions: {
      type: "string",
      description:
        "The new skill instructions text. For ADD: text appended to current instructions. " +
        "For UPDATE: the full replacement instructions. For REMOVE: the substring to delete.",
    },
  },
};

/**
 * Native proposer over ModelPort implementing the reflective prompt-optimization pattern. Calls `model.complete()` with a `propose_skill_edit`
 * tool. The test failures are the reflection signal (bounded ADD/UPDATE/REMOVE edits).
 * Only modifies `instructions` — `run`/`code` and `tests` are invariant.
 */
export class ModelOptimizer implements Optimizer {
  constructor(private readonly model: ModelPort) {}

  async propose(ctx: {
    instructions: string;
    failures: string[];
    tests: SkillTest[];
  }): Promise<{ instructions: string; usage: Usage }> {
    const testDescriptions = ctx.tests
      .map((t) => `  - ${t.name} (input: ${JSON.stringify(t.input)})`)
      .join("\n");

    const failureText =
      ctx.failures.length === 0
        ? "All tests currently pass."
        : `Failing tests:\n${ctx.failures.map((f) => `  - ${f}`).join("\n")}`;

    const systemPrompt: ModelMessage = {
      role: "system",
      content:
        "You are a skill-instruction optimizer implementing the reflective prompt-optimization pattern. " +
        "Your task is to propose a bounded edit to a skill's instructions so its tests pass. " +
        "You MUST call the `propose_skill_edit` tool with your proposed change. " +
        "Only edit the instructions field — do NOT modify the skill's run/code or tests. " +
        "Use UPDATE to replace the full instructions, ADD to append, or REMOVE to delete a substring.",
    };

    const userPrompt: ModelMessage = {
      role: "user",
      content:
        `Current skill instructions:\n${ctx.instructions || "(none)"}\n\n` +
        `Declared tests:\n${testDescriptions}\n\n` +
        `${failureText}\n\n` +
        "Propose an instruction edit (ADD/UPDATE/REMOVE) that will make all tests pass.",
    };

    const response = await this.model.complete({
      messages: [systemPrompt, userPrompt],
      tools: [
        {
          name: "propose_skill_edit",
          description:
            "Propose a bounded edit (ADD/UPDATE/REMOVE) to a skill's instructions field. " +
            "This is the reflective-optimizer edit surface: only the instructions may change.",
          inputSchema: PROPOSE_SKILL_EDIT_SCHEMA,
        },
      ],
    });

    // Extract the propose_skill_edit tool call from the response.
    const toolCall = response.content.find(
      (b) => b.type === "tool_use" && b.name === "propose_skill_edit",
    );

    if (!toolCall || toolCall.type !== "tool_use") {
      // Malformed proposer output — no tool call. Caller handles this as a skipped round.
      return { instructions: ctx.instructions, usage: response.usage };
    }

    const input = toolCall.input as { operation?: string; instructions?: string };
    const operation = input.operation ?? "UPDATE";
    const proposed = typeof input.instructions === "string" ? input.instructions : "";

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

    return { instructions: newInstructions, usage: response.usage };
  }
}

// ---------------------------------------------------------------------------
// Helper: apply a proposed instruction to a candidate skill def
// ---------------------------------------------------------------------------

function applyInstructions(
  skill: ExecutableSkillDef,
  instructions: string,
): ExecutableSkillDef {
  // `instructions` lives in the `description` field (the natural-language playbook/instructions).
  // In the reflective-optimizer surface, evolution tunes the description (the playbook) — `run`/`code`/`tests` are fixed.
  return { ...skill, description: instructions };
}

// ---------------------------------------------------------------------------
// Cost estimation (nominal; stops loop early when maxUsd set)
// ---------------------------------------------------------------------------

const NOMINAL_INPUT_USD_PER_TOKEN = 15 / 1_000_000;
const NOMINAL_OUTPUT_USD_PER_TOKEN = 75 / 1_000_000;

function estimateUsd(usage: Usage): number {
  return (
    usage.inputTokens * NOMINAL_INPUT_USD_PER_TOKEN +
    usage.outputTokens * NOMINAL_OUTPUT_USD_PER_TOKEN
  );
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0),
  };
}

// ---------------------------------------------------------------------------
// Main evolution loop
// ---------------------------------------------------------------------------

/**
 * §7.7 Skill self-evolution (reflective prompt-optimization pattern, native over ModelPort).
 *
 * OFF BY DEFAULT: call this function explicitly; it never auto-runs in the Agent loop.
 * NEVER auto-registers: call `SkillBank.register(result.evolved, { author: "agent" })` to
 * persist — the bank will quarantine it until a human calls `approve()`.
 *
 * @param skill - The skill to evolve (id/run/code/tests are fixed; only instructions change).
 * @param opts  - EvolveOptions including the proposer model and cost bounds.
 */
export async function evolveSkill(
  skill: ExecutableSkillDef,
  opts: EvolveOptions,
): Promise<EvolveResult> {
  const maxRounds = opts.maxRounds ?? 3;
  const optimizer: Optimizer = opts.optimizer ?? new ModelOptimizer(opts.model);

  let totalUsage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  const history: EvolveResult["history"] = [];

  // 1. Establish baseline: run the skill's tests against the current skill.
  //    Reuses runSkillTests (shared test-gate logic, NOT duplicated from SkillBank).
  const baselineResult = await runSkillTests(skill);
  const baselinePassed = baselineResult.every((r) => r.passed);
  const baselineFailures = baselineResult.filter((r) => !r.passed).map((r) => r.name);

  // If baseline already passes, we have nothing to improve — return immediately.
  if (baselinePassed) {
    return {
      evolved: null,
      baselinePassed: true,
      rounds: 0,
      usage: totalUsage,
      history: [],
    };
  }

  let best: ExecutableSkillDef | null = null;
  let currentInstructions = skill.description;
  let currentFailures = baselineFailures;

  for (let round = 1; round <= maxRounds; round++) {
    // Check budget before calling the proposer.
    if (opts.maxUsd !== undefined && estimateUsd(totalUsage) >= opts.maxUsd) {
      break;
    }

    // 2. Call the optimizer (proposer) with current instructions + failures (reflection signal).
    let proposed: string;
    let roundUsage: Usage;
    try {
      const result = await optimizer.propose({
        instructions: currentInstructions,
        failures: currentFailures,
        tests: skill.tests,
      });
      proposed = result.instructions;
      roundUsage = result.usage;
    } catch {
      // Proposer threw — skip this round.
      history.push({ round, passed: false, failures: currentFailures });
      continue;
    }

    totalUsage = addUsage(totalUsage, roundUsage);

    // Detect malformed output: if proposed instructions unchanged AND no change was made,
    // the proposer returned nothing useful. Skip this round gracefully.
    if (proposed === currentInstructions) {
      history.push({ round, passed: false, failures: currentFailures });
      continue;
    }

    // 3. Apply the proposed edit → candidate skill (run/code/tests are fixed).
    const candidate = applyInstructions(skill, proposed);

    // 4. Test-gate: run the candidate through the same test logic as SkillBank.
    const candidateResult = await runSkillTests(candidate);
    const candidatePassed = candidateResult.every((r) => r.passed);
    const candidateFailures = candidateResult.filter((r) => !r.passed).map((r) => r.name);

    history.push({ round, passed: candidatePassed, failures: candidateFailures });

    if (candidatePassed) {
      // Candidate passes all tests — this is the first and only passing candidate we accept.
      best = candidate;
      break;
    }

    // Feed remaining failures into next round.
    currentInstructions = proposed;
    currentFailures = candidateFailures;
  }

  return {
    evolved: best,
    baselinePassed: false,
    rounds: history.length,
    usage: totalUsage,
    history,
  };
}
