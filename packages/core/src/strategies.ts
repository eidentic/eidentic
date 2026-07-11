import { addUsage, type ModelPort, type ModelResponse, type StreamEvent, type Usage } from "@eidentic/types";
import type { QueryOptions } from "./agent.js";
import type { TreeBudget } from "./agent.js";

// ---------------------------------------------------------------------------
// Core interfaces (§3.6)
// ---------------------------------------------------------------------------

/**
 * Internal query options shape as seen by strategies. Strategies must not
 * depend on this outside this module — it exists purely to thread the shared
 * budget/depth through sub-runs without exposing those fields in the public API.
 */
interface InternalQueryOptions extends QueryOptions {
  _depth?: number;
  _budget?: TreeBudget;
}

/**
 * Context handed to every strategy at execution time. `react` is the primitive
 * that enters the base ReAct loop — strategies compose around it.
 */
export interface StrategyContext {
  input: string;
  opts: QueryOptions;
  /** The agent's own model (used as the executor default in planAndExecute). */
  model: ModelPort;
  /**
   * Framework-supplied boundary for auxiliary model calls. Custom strategies that call a model
   * directly should invoke this before inspecting or forwarding the response.
   */
  enforceModelResponseLimits?: (response: ModelResponse) => void;
  /**
   * The internal opts that carry `_budget`/`_depth`. Strategies must pass these
   * (with the sessionId overridden for each sub-run) into `react` so that the
   * shared tree budget is preserved across all passes/steps of the strategy.
   *
   * **Internal — do not set.** This field is populated by the framework when
   * `AgentStrategy.run` is invoked; custom strategy authors should read it to
   * thread the shared budget through sub-runs but must never set it from outside
   * an `AgentStrategy.run` implementation. Its type and presence are not part of
   * the public API and may change between minor versions.
   */
  _internalOpts?: InternalQueryOptions;
  /**
   * Run the base ReAct loop on the given input, optionally with a model override.
   * `runtime.model` replaces the agent's own model for that sub-run only.
   */
  react(input: string, opts: QueryOptions, runtime?: { model?: ModelPort }): AsyncIterable<StreamEvent>;
}

/** Plug-in strategy: receives a bound StrategyContext and drives the run to exactly ONE terminal result. */
export interface AgentStrategy {
  run(ctx: StrategyContext): AsyncIterable<StreamEvent>;
}

/**
 * External validation signal fed into the critic so the critique is grounded, not vibes.
 * Called with the current draft and the original input; returns {passed, report}.
 */
export type GroundSignal = (
  draft: string,
  input: string,
) => Promise<{ passed: boolean; report: string }> | { passed: boolean; report: string };

// addUsage is imported from @eidentic/types (canonical shared implementation).

// ---------------------------------------------------------------------------
// Helper: drain a react sub-run, forwarding intermediate events and suppressing
// `session.init` events after the first (FIX 4). The first `session.init` is
// rewritten to the CALLER's sessionId before being forwarded.
//
// Returns the terminal StreamEvent (always type "result") and all
// non-result/non-suppressed events.
// ---------------------------------------------------------------------------
interface DrainResult {
  terminal: Extract<StreamEvent, { type: "result" }>;
  events: StreamEvent[];
  /** True if a session.init was found and forwarded. */
  hadSessionInit: boolean;
}

async function drainReact(
  iterable: AsyncIterable<StreamEvent>,
  callerSessionId: string,
  isFirstSubRun: boolean,
): Promise<DrainResult> {
  const events: StreamEvent[] = [];
  let terminal: Extract<StreamEvent, { type: "result" }> | undefined;
  let hadSessionInit = false;
  for await (const ev of iterable) {
    if (ev.type === "result") {
      terminal = ev;
    } else if (ev.type === "session.init") {
      if (isFirstSubRun) {
        // Rewrite the sessionId to the caller's sessionId (FIX 4).
        hadSessionInit = true;
        events.push({ ...ev, sessionId: callerSessionId });
      }
      // Suppress subsequent session.init events from later sub-runs.
    } else {
      events.push(ev);
    }
  }
  if (!terminal) {
    // Should not happen — runLoop always emits a terminal result. Synthesize one.
    terminal = {
      type: "result",
      subtype: "error",
      output: "strategy: react sub-run did not emit a terminal result",
      usage: { inputTokens: 0, outputTokens: 0 },
      numTurns: 0,
      sessionId: callerSessionId,
      cost: { foreground: { inputTokens: 0, outputTokens: 0 }, background: { inputTokens: 0, outputTokens: 0 }, cachedInputTokens: 0 },
    };
  }
  return { terminal, events, hadSessionInit };
}

// ---------------------------------------------------------------------------
// Structured-output threading across strategy sub-runs (§3.6 + D2).
//
// Semantics: when a strategy is run with an `outputSchema`, the schema must
// constrain ONLY the strategy's FINAL answer — never an intermediate react
// sub-run (reflection's draft/critique passes; planAndExecute's per-step runs),
// which may need to call tools or emit free text. We therefore:
//   1. STRIP `outputSchema` from the opts threaded into every intermediate pass
//      (so those passes behave exactly as they do today, with no schema), and
//   2. after the strategy has produced its accepted free-text answer, run ONE
//      additional, schema-constrained react sub-run ("the last react call it
//      makes") whose sole job is to render that answer as the typed object. Its
//      validated `object` rides the synthesized terminal.
// When no `outputSchema` is present this is all a no-op and behavior is
// byte-identical to before.
// ---------------------------------------------------------------------------

/**
 * Return a shallow copy of `opts` with any `outputSchema` removed, so an
 * intermediate strategy sub-run is NOT schema-constrained. Pure; never mutates.
 */
function withoutSchema<T extends QueryOptions>(opts: T): T {
  if (opts.outputSchema === undefined) return opts;
  const { outputSchema: _drop, ...rest } = opts;
  return rest as T;
}

/**
 * Run the strategy's FINAL, schema-constrained react sub-run. Given the accepted
 * free-text `answer`, it re-enters the base loop on a fresh session with the
 * requested `outputSchema` so the terminal turn is constrained to emit the typed
 * object. Intermediate events are forwarded; the validated terminal (carrying
 * `object`) is returned via `drainReact` so the caller can fold usage and emit a
 * single synthesized terminal.
 *
 * The model is only asked to format the already-produced answer — it does not
 * re-do the task — so no tools are needed and the structured terminal turn
 * applies cleanly.
 */
async function runFinalStructuredPass(
  ctx: StrategyContext,
  internalOpts: InternalQueryOptions,
  outputSchema: NonNullable<QueryOptions["outputSchema"]>,
  answer: string,
  sessionSuffix: string,
  isFirstSubRun: boolean,
): Promise<DrainResult> {
  const formatInput =
    `Original request:\n${ctx.input}\n\n` +
    `A complete answer has already been produced:\n${answer}\n\n` +
    `Return ONLY that answer as a structured object matching the required schema. ` +
    `Do not change the substance of the answer; only format it.`;
  const passOpts: InternalQueryOptions = {
    ...withoutSchema(internalOpts),
    sessionId: `${ctx.opts.sessionId}_${sessionSuffix}`,
    outputSchema,
  };
  return drainReact(ctx.react(formatInput, passOpts), ctx.opts.sessionId, isFirstSubRun);
}

// ---------------------------------------------------------------------------
// react() — trivial passthrough strategy (§3.6)
// ---------------------------------------------------------------------------

/**
 * The default ReAct strategy: a direct passthrough to the base loop.
 * Behavior is byte-identical to running with no strategy configured.
 */
export function react(): AgentStrategy {
  return {
    async *run(ctx: StrategyContext): AsyncIterable<StreamEvent> {
      yield* ctx.react(ctx.input, ctx.opts);
    },
  };
}

// ---------------------------------------------------------------------------
// reflection() — draft → critic → revise (§3.6)
// ---------------------------------------------------------------------------

/**
 * Reflection strategy: runs the base loop to get a draft, then a DIFFERENT
 * critic model evaluates the draft. If unsatisfactory, re-enters the loop with
 * the critic's feedback in context and tries again, up to `maxRevisions` times.
 *
 * `ground` signals are optional external validation functions (e.g. run tests,
 * validate a schema) whose reports are fed into the critic's input so the
 * critique is grounded in real signals rather than pure model vibes.
 *
 * The critic MUST be a different ModelPort instance from the agent's model
 * (Constitution #6: intrinsic self-critique fails). The API takes it explicitly.
 *
 * The stream emits exactly ONE terminal `result` at the end — the accepted draft
 * (either satisfactory or when maxRevisions is exhausted). Intermediate drafts'
 * terminal events are swallowed; only their intermediate events (assistant, tool.result,
 * stream.delta) are forwarded so the consumer sees progress.
 *
 * Cost governor: a SINGLE shared `_budget` is threaded across ALL sub-runs (react passes
 * + critic calls) so `policy.maxCostUsd` applies to the WHOLE strategy, not per-pass.
 * If a mid-strategy budget overrun is detected (the react sub-run returns a non-success
 * terminal), the strategy accepts the current draft immediately (fail-safe).
 */
export function reflection(opts: {
  critic: ModelPort;
  maxRevisions?: number;
  ground?: GroundSignal[];
}): AgentStrategy {
  const maxRevisions = opts.maxRevisions ?? 2;

  return {
    async *run(ctx: StrategyContext): AsyncIterable<StreamEvent> {
      // The critique tool schema that the critic model is asked to call.
      const critiqueTool = {
        name: "critique",
        description: "Evaluate the draft and provide structured feedback.",
        inputSchema: {
          type: "object",
          properties: {
            satisfactory: { type: "boolean", description: "Is the draft satisfactory?" },
            feedback: { type: "string", description: "Specific, actionable feedback for improvement." },
          },
          required: ["satisfactory", "feedback"],
        },
      };

      // FIX 2: Extract the shared budget from the internal opts so ALL sub-runs share
      // the same accumulator. The budget is created by the first runReact call (in agent.ts)
      // when _budget is absent; here we must carry the EXISTING one through or create one
      // if this is the outermost root (no _budget yet on the internal opts).
      // _internalOpts is optional (custom strategy authors must not set it; the framework does).
      // Fallback: synthesise a minimal InternalQueryOptions from ctx.opts when absent.
      const internalOpts: InternalQueryOptions = ctx._internalOpts ?? { ...ctx.opts };
      // If there is no budget yet (caller is a public root), create one now so it is shared
      // across all strategy sub-runs from the start.
      if (!internalOpts._budget) {
        internalOpts._budget = { usage: { inputTokens: 0, outputTokens: 0 }, usd: 0 };
      }
      const sharedBudget = internalOpts._budget;

      // D2: schema-constrained output applies to the strategy's FINAL answer only.
      // Intermediate draft/critique passes run UNCONSTRAINED (schema stripped below);
      // once a draft is accepted, `finishAccepted` runs one final structured pass.
      const outputSchema = ctx.opts.outputSchema;

      let currentInput = ctx.input;
      let lastTerminal: Extract<StreamEvent, { type: "result" }> | undefined;

      // Track aggregated usage and numTurns across all sub-runs.
      let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let totalNumTurns = 0;
      let isFirstSubRun = true;

      /**
       * Accept `draft` as the final answer and emit exactly ONE terminal result.
       * Without an `outputSchema` this is the previous behavior (synthesized text
       * terminal). With one, it runs a single final schema-constrained react pass
       * to render the accepted draft as the typed object and carries `object` on
       * the terminal. Folds the format pass's spend into the aggregated totals.
       */
      async function* finishAccepted(
        terminal: Extract<StreamEvent, { type: "result" }>,
        draft: string,
      ): AsyncIterable<StreamEvent> {
        if (!outputSchema) {
          yield buildSynthesizedTerminal(terminal, ctx.opts.sessionId, totalUsage, totalNumTurns, draft);
          return;
        }
        const fmt = await runFinalStructuredPass(
          ctx, internalOpts, outputSchema, draft, "refl_format", isFirstSubRun,
        );
        isFirstSubRun = false;
        for (const ev of fmt.events) yield ev;
        // Fold the format pass spend into shared budget + aggregated totals.
        const budgetUsdAfterFmt = sharedBudget.usd;
        sharedBudget.usage = addUsage(sharedBudget.usage, fmt.terminal.usage);
        if (fmt.terminal.cost?.usd !== undefined) {
          sharedBudget.usd += Math.max(0, fmt.terminal.cost.usd - budgetUsdAfterFmt);
        }
        totalUsage = addUsage(totalUsage, fmt.terminal.usage);
        totalNumTurns += fmt.terminal.numTurns;
        // If the format pass failed (e.g. validation error / budget abort), surface its
        // terminal verbatim (it carries the error subtype) so callers see the failure.
        if (fmt.terminal.subtype !== "success") {
          yield { ...fmt.terminal, sessionId: ctx.opts.sessionId, usage: totalUsage, numTurns: totalNumTurns };
          return;
        }
        const formatted = typeof fmt.terminal.output === "string" ? fmt.terminal.output : draft;
        yield buildSynthesizedTerminal(
          fmt.terminal, ctx.opts.sessionId, totalUsage, totalNumTurns, formatted, fmt.terminal.object,
        );
      }

      for (let revision = 0; revision <= maxRevisions; revision++) {
        // Build a unique session per pass to avoid event-log conflicts, but thread
        // the SAME _budget so spend accumulates across passes (FIX 2). Intermediate
        // passes are NOT schema-constrained (withoutSchema) — only the final format
        // pass in `finishAccepted` carries the outputSchema.
        const passOpts: InternalQueryOptions = {
          ...withoutSchema(internalOpts),
          sessionId: `${ctx.opts.sessionId}_refl_${revision}`,
        };

        const { terminal, events, hadSessionInit: _ } = await drainReact(
          ctx.react(currentInput, passOpts),
          ctx.opts.sessionId,
          isFirstSubRun,
        );
        isFirstSubRun = false;
        // Forward intermediate events from this pass.
        for (const ev of events) yield ev;
        lastTerminal = terminal;

        // Fold this sub-run's OWN-FOREGROUND spend into the shared budget so that
        // the next pass's cost preflight sees cumulative spend (mirrors spawn_agent §8.6).
        // Snapshot AFTER drainReact: sharedBudget.usd already includes any grandchild
        // spend accumulated during this sub-run; terminal.cost?.usd = own_fg_usd + that snapshot.
        // So: own_fg_usd = terminal.cost?.usd - sharedBudget.usd (after sub-run). Double-count-safe.
        const budgetUsdAfterPass = sharedBudget.usd;
        sharedBudget.usage = addUsage(sharedBudget.usage, terminal.usage);
        if (terminal.cost?.usd !== undefined) {
          const passFgUsd = Math.max(0, terminal.cost.usd - budgetUsdAfterPass);
          sharedBudget.usd += passFgUsd;
        }

        // Accumulate usage/turns from this sub-run (FIX 3).
        totalUsage = addUsage(totalUsage, terminal.usage);
        totalNumTurns += terminal.numTurns;

        // If the sub-run did not succeed (e.g. budget abort), accept immediately
        // (fail-safe: don't loop forever, and the terminal already carries the abort subtype).
        if (terminal.subtype !== "success") {
          yield {
            ...terminal,
            sessionId: ctx.opts.sessionId,
            usage: totalUsage,
            numTurns: totalNumTurns,
          };
          return;
        }

        const draft = typeof terminal.output === "string" ? terminal.output : String(terminal.output ?? "");

        // Last iteration: accept the draft regardless of critic opinion.
        if (revision === maxRevisions) {
          yield* finishAccepted(terminal, draft);
          return;
        }

        // Run ground signals (if any) to get grounded reports.
        const groundReports: string[] = [];
        if (opts.ground && opts.ground.length > 0) {
          for (const signal of opts.ground) {
            try {
              const result = await signal(draft, ctx.input);
              groundReports.push(
                `[ground: ${result.passed ? "PASSED" : "FAILED"}] ${result.report}`,
              );
            } catch (err) {
              groundReports.push(`[ground: ERROR] ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        }

        // Build the critic prompt.
        const groundSection = groundReports.length > 0
          ? `\n\nExternal validation:\n${groundReports.join("\n")}`
          : "";

        const criticPrompt = `You are a critic. Evaluate the following draft response.

Original request: ${ctx.input}

Draft response:
${draft}${groundSection}

Call the \`critique\` tool with your evaluation.`;

        // Call the critic model (FIX 2: account its usage into the shared budget).
        let criticResponse: import("@eidentic/types").ModelResponse;
        try {
          criticResponse = await opts.critic.complete({
            messages: [
              { role: "system", content: "You are a rigorous evaluator. Be specific in your feedback." },
              { role: "user", content: criticPrompt },
            ],
            tools: [critiqueTool],
            ...(ctx.opts.signal ? { signal: ctx.opts.signal } : {}),
          });
        } catch (err) {
          // Critic call failed — fail-safe: accept the draft.
          yield* finishAccepted(terminal, draft);
          return;
        }

        // FIX 2 + FIX 3: fold critic usage into both the shared budget and the aggregated total.
        const criticUsage = criticResponse.usage;
        sharedBudget.usage = addUsage(sharedBudget.usage, criticUsage);
        totalUsage = addUsage(totalUsage, criticUsage);
        try {
          ctx.enforceModelResponseLimits?.(criticResponse);
        } catch {
          // The call was billable, but its oversized output is untrusted and must not enter context.
          yield* finishAccepted(terminal, draft);
          return;
        }

        // Extract the critique tool call from the critic response.
        let satisfactory = true;
        let feedback = "";

        const toolUses = criticResponse.content.filter((b) => b.type === "tool_use");
        if (toolUses.length > 0) {
          const critiqueCall = toolUses[0];
          if (critiqueCall && critiqueCall.type === "tool_use") {
            const input = critiqueCall.input as Record<string, unknown>;
            // Robustly parse: malformed ⇒ fail-safe treat as satisfactory.
            if (typeof input.satisfactory === "boolean") {
              satisfactory = input.satisfactory;
              feedback = typeof input.feedback === "string" ? input.feedback : "";
            } else {
              // Malformed critic output: fail-safe accept.
              yield* finishAccepted(terminal, draft);
              return;
            }
          }
        } else {
          // No tool call from the critic — try to extract from text.
          const textParts = criticResponse.content.filter((b) => b.type === "text");
          const rawText = textParts.map((b) => (b.type === "text" ? b.text : "")).join("");
          // Attempt JSON parse as a last resort.
          try {
            const parsed = JSON.parse(rawText) as Record<string, unknown>;
            if (typeof parsed.satisfactory === "boolean") {
              satisfactory = parsed.satisfactory;
              feedback = typeof parsed.feedback === "string" ? parsed.feedback : rawText;
            } else {
              // Malformed: fail-safe accept.
              yield* finishAccepted(terminal, draft);
              return;
            }
          } catch {
            // Malformed: fail-safe accept.
            yield* finishAccepted(terminal, draft);
            return;
          }
        }

        if (satisfactory) {
          yield* finishAccepted(terminal, draft);
          return;
        }

        // Build the next input with the revision block.
        const groundFeedback = groundReports.length > 0
          ? `\n\nExternal validation signals:\n${groundReports.join("\n")}`
          : "";

        currentInput =
          `${ctx.input}\n\n` +
          `<revision_request revision="${revision + 1}">\n` +
          `Previous draft:\n${draft}\n\n` +
          `Critic feedback: ${feedback}${groundFeedback}\n` +
          `</revision_request>\n\n` +
          `Please revise your response addressing the critic's feedback.`;
      }

      // Should be unreachable, but emit the last terminal as a safety net.
      if (lastTerminal) {
        const draft = typeof lastTerminal.output === "string" ? lastTerminal.output : String(lastTerminal.output ?? "");
        yield* finishAccepted(lastTerminal, draft);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// planAndExecute() — planner + per-step executor (§3.6)
// ---------------------------------------------------------------------------

/**
 * Plan-and-Execute strategy: a strong PLANNER model produces a typed step list,
 * each step runs as a ReAct sub-run (optionally on a cheaper EXECUTOR model),
 * with optional replanning after `replanEvery` steps or on step failure.
 *
 * The stream emits exactly ONE terminal `result` at the end — a synthesis of
 * all step outputs (concatenated, or the last step's output on a single step).
 * Intermediate step events are forwarded so the consumer sees progress.
 *
 * Robust against:
 * - Malformed planner output (no steps / tool not called) → single fallback react run.
 * - Failing steps → trigger replan (planner called again with progress).
 * - Infinite replanning → bounded by total steps (maxSteps).
 *
 * Cost governor: a SINGLE shared `_budget` is threaded across ALL step sub-runs
 * and planner calls so `policy.maxCostUsd` applies to the WHOLE strategy.
 */
export function planAndExecute(opts: {
  planner: ModelPort;
  executor?: ModelPort;
  replanEvery?: number;
  maxSteps?: number;
}): AgentStrategy {
  const maxSteps = opts.maxSteps ?? 10;
  const replanEvery = opts.replanEvery ?? 5;

  return {
    async *run(ctx: StrategyContext): AsyncIterable<StreamEvent> {
      const makePlanTool = {
        name: "make_plan",
        description: "Produce a step-by-step plan to complete the task. Each step should be a clear, actionable instruction.",
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: { type: "string" },
              description: "Ordered list of steps to execute.",
            },
          },
          required: ["steps"],
        },
      };

      // FIX 2: Extract / initialise the shared budget (same pattern as reflection).
      // _internalOpts is optional (custom strategy authors must not set it; the framework does).
      // Fallback: synthesise a minimal InternalQueryOptions from ctx.opts when absent.
      const internalOpts: InternalQueryOptions = ctx._internalOpts ?? { ...ctx.opts };
      if (!internalOpts._budget) {
        internalOpts._budget = { usage: { inputTokens: 0, outputTokens: 0 }, usd: 0 };
      }
      const sharedBudget = internalOpts._budget;

      // Aggregated totals across all sub-runs and planner calls (FIX 3).
      let totalUsage: Usage = { inputTokens: 0, outputTokens: 0 };
      let totalNumTurns = 0;

      /**
       * Call the planner and extract the step list.
       * Returns [] on malformed output (triggers fallback).
       * FIX 2/3: folds planner usage into both the shared budget and the aggregated total.
       */
      const callPlanner = async (planInput: string): Promise<string[]> => {
        let plannerResponse: import("@eidentic/types").ModelResponse;
        try {
          plannerResponse = await opts.planner.complete({
            messages: [
              { role: "system", content: "You are a planning agent. Break the task into clear, sequential steps. Call the make_plan tool." },
              { role: "user", content: planInput },
            ],
            tools: [makePlanTool],
            ...(ctx.opts.signal ? { signal: ctx.opts.signal } : {}),
          });
        } catch {
          return [];
        }

        // FIX 2 + FIX 3: account planner usage into shared budget and aggregated total.
        sharedBudget.usage = addUsage(sharedBudget.usage, plannerResponse.usage);
        totalUsage = addUsage(totalUsage, plannerResponse.usage);
        try {
          ctx.enforceModelResponseLimits?.(plannerResponse);
        } catch {
          return [];
        }

        const toolUses = plannerResponse.content.filter((b) => b.type === "tool_use");
        if (toolUses.length > 0) {
          const planCall = toolUses[0];
          if (planCall && planCall.type === "tool_use") {
            const input = planCall.input as Record<string, unknown>;
            if (Array.isArray(input.steps) && input.steps.length > 0) {
              return (input.steps as unknown[]).filter((s) => typeof s === "string") as string[];
            }
          }
        }

        // Try text fallback (JSON).
        const textParts = plannerResponse.content.filter((b) => b.type === "text");
        const rawText = textParts.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
        try {
          const parsed = JSON.parse(rawText) as Record<string, unknown>;
          if (Array.isArray(parsed.steps)) {
            return (parsed.steps as unknown[]).filter((s) => typeof s === "string") as string[];
          }
        } catch {
          // ignore
        }

        return []; // malformed → fallback
      };

      // Initial plan.
      const initialPlanInput = ctx.input;
      let remainingSteps = await callPlanner(initialPlanInput);

      // Fallback: no plan produced → single react run on original input.
      if (remainingSteps.length === 0) {
        // For the fallback path, thread the shared budget and rewrite sessionId.
        const fallbackOpts: InternalQueryOptions = {
          ...internalOpts,
          sessionId: ctx.opts.sessionId,
        };
        yield* ctx.react(ctx.input, fallbackOpts);
        return;
      }

      const stepOutputs: string[] = [];
      let totalStepsRun = 0;
      let lastTerminal: Extract<StreamEvent, { type: "result" }> | undefined;
      let isFirstSubRun = true;

      // Slice to max at the start (the replan loop keeps checking this too).
      remainingSteps = remainingSteps.slice(0, maxSteps);

      outer: while (remainingSteps.length > 0 && totalStepsRun < maxSteps) {
        const step = remainingSteps.shift()!;
        totalStepsRun++;

        // FIX 2: thread the shared budget through each step sub-run.
        // D2: steps run UNCONSTRAINED (schema stripped) — they may call tools / emit
        // free text. The schema is applied only to the final synthesis pass below.
        const stepOpts: InternalQueryOptions = {
          ...withoutSchema(internalOpts),
          sessionId: `${ctx.opts.sessionId}_step_${totalStepsRun}`,
        };

        const { terminal, events } = await drainReact(
          ctx.react(step, stepOpts, { model: opts.executor }),
          ctx.opts.sessionId,
          isFirstSubRun,
        );
        isFirstSubRun = false;
        // Forward intermediate events.
        for (const ev of events) yield ev;
        lastTerminal = terminal;

        // Fold this step sub-run's OWN-FOREGROUND spend into the shared budget so
        // subsequent steps' cost preflight sees cumulative spend (mirrors spawn_agent §8.6).
        const budgetUsdAfterStep = sharedBudget.usd;
        sharedBudget.usage = addUsage(sharedBudget.usage, terminal.usage);
        if (terminal.cost?.usd !== undefined) {
          const stepFgUsd = Math.max(0, terminal.cost.usd - budgetUsdAfterStep);
          sharedBudget.usd += stepFgUsd;
        }

        // FIX 3: accumulate usage/turns from this step sub-run.
        totalUsage = addUsage(totalUsage, terminal.usage);
        totalNumTurns += terminal.numTurns;

        const stepOutput = typeof terminal.output === "string"
          ? terminal.output
          : String(terminal.output ?? "");

        const stepSucceeded = terminal.subtype === "success";
        stepOutputs.push(`[step ${totalStepsRun}] ${step}\n${stepOutput}`);

        const shouldReplan =
          !stepSucceeded ||
          (replanEvery > 0 && totalStepsRun % replanEvery === 0 && remainingSteps.length > 0);

        if (shouldReplan && totalStepsRun < maxSteps) {
          // Build a replan prompt with progress so far.
          const progressSummary = stepOutputs.join("\n\n");
          const replanInput =
            `Original task: ${ctx.input}\n\n` +
            `Progress so far (${totalStepsRun} steps completed):\n${progressSummary}\n\n` +
            (stepSucceeded
              ? `Please provide a revised plan for the remaining work.`
              : `The last step failed: ${stepOutput}\nPlease provide a revised plan to recover and complete the task.`);

          const newSteps = await callPlanner(replanInput);
          const remaining = maxSteps - totalStepsRun;
          remainingSteps = newSteps.slice(0, remaining);

          if (newSteps.length === 0) {
            // Planner couldn't produce new steps — stop here with what we have.
            break outer;
          }
        } else if (!stepSucceeded) {
          // Non-recoverable failure without replanning budget — stop.
          break outer;
        }
      }

      // Synthesize a single terminal result from all step outputs.
      const allOutput = stepOutputs.length === 1
        ? stepOutputs[0]!
        : stepOutputs.join("\n\n");

      // D2: if an outputSchema was requested, run ONE final schema-constrained react
      // pass to render the synthesized step outputs as the typed object — the strategy's
      // FINAL answer. Steps themselves ran unconstrained (above).
      const outputSchema = ctx.opts.outputSchema;
      if (outputSchema) {
        const fmt = await runFinalStructuredPass(
          ctx, internalOpts, outputSchema, allOutput, "pae_format", isFirstSubRun,
        );
        for (const ev of fmt.events) yield ev;
        const budgetUsdAfterFmt = sharedBudget.usd;
        sharedBudget.usage = addUsage(sharedBudget.usage, fmt.terminal.usage);
        if (fmt.terminal.cost?.usd !== undefined) {
          sharedBudget.usd += Math.max(0, fmt.terminal.cost.usd - budgetUsdAfterFmt);
        }
        totalUsage = addUsage(totalUsage, fmt.terminal.usage);
        totalNumTurns += fmt.terminal.numTurns;
        if (fmt.terminal.subtype !== "success") {
          yield { ...fmt.terminal, sessionId: ctx.opts.sessionId, usage: totalUsage, numTurns: totalNumTurns };
          return;
        }
        const formatted = typeof fmt.terminal.output === "string" ? fmt.terminal.output : allOutput;
        yield buildSynthesizedTerminal(
          fmt.terminal, ctx.opts.sessionId, totalUsage, totalNumTurns, formatted, fmt.terminal.object,
        );
        return;
      }

      // FIX 3: emit ONE terminal with SUMMED usage/numTurns and CALLER's sessionId.
      if (lastTerminal) {
        yield buildSynthesizedTerminal(lastTerminal, ctx.opts.sessionId, totalUsage, totalNumTurns, allOutput);
      } else {
        yield {
          type: "result",
          subtype: "success",
          output: allOutput,
          usage: totalUsage,
          numTurns: totalNumTurns,
          sessionId: ctx.opts.sessionId,
          cost: { foreground: totalUsage, background: { inputTokens: 0, outputTokens: 0 }, cachedInputTokens: 0 },
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helper: build the synthesized terminal result with summed fields
// (FIX 3: coherent aggregated terminal).
// ---------------------------------------------------------------------------

/**
 * Build the final synthesized terminal result for a strategy.
 * - Uses the CALLER's `sessionId` (not the sub-run's internal id).
 * - Carries the SUMMED `usage` and `numTurns` across all sub-runs + auxiliary calls.
 * - Preserves the `cost` structure from the last sub-run's terminal but updates
 *   `foreground` to reflect the aggregated spend.
 * - `subtype` is always "success" (callers only reach this on success).
 */
function buildSynthesizedTerminal(
  lastTerminal: Extract<StreamEvent, { type: "result" }>,
  callerSessionId: string,
  totalUsage: Usage,
  totalNumTurns: number,
  output: unknown,
  /**
   * The validated structured object from a final schema-constrained pass, when the
   * strategy was run with an `outputSchema`. Carried through to the terminal so a
   * strategy run yields `result.object` exactly like the plain react path. Omitted
   * (undefined) when no schema was requested — the terminal then has no `object`.
   */
  object?: unknown,
): Extract<StreamEvent, { type: "result" }> {
  // Rebuild cost breakdown with aggregated foreground usage.
  const baseCost = lastTerminal.cost;
  const aggregatedCost = baseCost
    ? {
        ...baseCost,
        foreground: totalUsage,
        cachedInputTokens: totalUsage.cachedInputTokens ?? baseCost.cachedInputTokens,
      }
    : {
        foreground: totalUsage,
        background: { inputTokens: 0, outputTokens: 0 },
        cachedInputTokens: totalUsage.cachedInputTokens ?? 0,
      };

  return {
    ...lastTerminal,
    sessionId: callerSessionId,
    usage: totalUsage,
    numTurns: totalNumTurns,
    output,
    subtype: "success",
    cost: aggregatedCost,
    ...(object !== undefined ? { object } : {}),
  };
}
