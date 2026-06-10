import { isToolUse, type ContentBlock, type ModelPort, type ModelMessage, type ToolSchema } from "@eidentic/types";
import type { Scorer, ScoreContext, ScoreResult } from "./scorer.js";
import { clamp01 } from "./scorer.js";
import { toolNamesOf } from "./trajectory.js";

/** The structured tool every judge asks for: a numeric score in [0,1] + a rationale. */
const SCORE_TOOL: ToolSchema = {
  name: "score",
  description: "Report your judgement as a numeric score in [0,1] and a short rationale.",
  inputSchema: {
    type: "object",
    properties: {
      score: { type: "number", description: "0 = fails the criterion, 1 = fully meets it." },
      rationale: { type: "string", description: "One or two sentences justifying the score." },
    },
    required: ["score", "rationale"],
    additionalProperties: false,
  },
};

/** The fail-closed result returned whenever a judge produces no parsable score. */
const FAIL_CLOSED: ScoreResult = { score: 0, passed: false, rationale: "judge produced no parsable score" };

/** Find the judge's `score` tool call in the response content and parse it; fail-closed on anything off. */
function parseJudge(content: ContentBlock[], passThreshold: number): ScoreResult {
  const call = content.find(isToolUse);
  if (!call || call.name !== "score") return { ...FAIL_CLOSED };
  const input = call.input;
  if (typeof input !== "object" || input === null) return { ...FAIL_CLOSED };
  const raw = (input as Record<string, unknown>).score;
  const rationale = (input as Record<string, unknown>).rationale;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return { ...FAIL_CLOSED };
  const score = clamp01(raw);
  return {
    score,
    passed: score >= passThreshold,
    rationale: typeof rationale === "string" && rationale.length > 0 ? rationale : "(no rationale)",
  };
}

/** Compact, judge-friendly rendering of the trajectory (text turns + tool names) for the prompt. */
function renderTrajectory(ctx: ScoreContext): string {
  const lines: string[] = [];
  for (const s of ctx.trajectory.steps) {
    if (s.kind === "modelCall" && s.text) lines.push(`assistant: ${s.text}`);
    else if (s.kind === "toolCall") lines.push(`tool_call: ${s.name}(${JSON.stringify(s.input)})`);
    else if (s.kind === "toolResult") lines.push(`tool_result(${s.name}): ${JSON.stringify(s.output)}`);
  }
  return lines.join("\n") || "(no steps)";
}

/** Core judge driver: build messages, call the judge model, parse fail-closed. NEVER throws. */
async function runJudge(judge: ModelPort, system: string, user: string, passThreshold: number): Promise<ScoreResult> {
  const messages: ModelMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  let content: ContentBlock[];
  try {
    const resp = await judge.complete({ messages, tools: [SCORE_TOOL] });
    content = resp.content;
  } catch {
    return { ...FAIL_CLOSED, rationale: "judge call threw; failing closed" };
  }
  return parseJudge(content, passThreshold);
}

export interface JudgeOptions {
  /** Pass when score >= this (default 0.5 for subjective criteria). */
  passThreshold?: number;
}

/**
 * Build a judge factory. The JUDGE `ModelPort` MUST be a DIFFERENT model than the agent's
 * (Constitution #6 — no self-bias). The API takes it explicitly; identity is not enforceable.
 */
function makeJudge(name: string, build: (ctx: ScoreContext) => { system: string; user: string }) {
  return (judge: ModelPort, options?: JudgeOptions): Scorer => ({
    name,
    score: async (ctx) => {
      const { system, user } = build(ctx);
      return runJudge(judge, system, user, options?.passThreshold ?? 0.5);
    },
  });
}

const taskCompletion = makeJudge("taskCompletion", (ctx) => ({
  system:
    "You are an impartial evaluator. Decide whether the agent COMPLETED the user's task. " +
    "Compare the final answer to the expected ground truth when provided. Call the `score` tool.",
  user:
    `Task:\n${ctx.input}\n\n` +
    `Expected ground truth:\n${ctx.expected ? JSON.stringify(ctx.expected) : "(none provided)"}\n\n` +
    `Agent final answer:\n${ctx.finalText ?? "(none)"}\n\n` +
    `Trajectory:\n${renderTrajectory(ctx)}`,
}));

const planQuality = makeJudge("planQuality", (ctx) => ({
  system:
    "You are an impartial evaluator of an agent's PLAN QUALITY: were the steps coherent, ordered, " +
    "and non-redundant for the task? Call the `score` tool.",
  user: `Task:\n${ctx.input}\n\nTool calls in order:\n${toolNamesOf(ctx.trajectory).join(" -> ") || "(none)"}\n\nTrajectory:\n${renderTrajectory(ctx)}`,
}));

const faithfulness = makeJudge("faithfulness", (ctx) => ({
  system:
    "You are an impartial evaluator of FAITHFULNESS: is the final answer grounded in the tool " +
    "results / evidence in the trajectory, with no fabrication? Call the `score` tool.",
  user: `Final answer:\n${ctx.finalText ?? "(none)"}\n\nEvidence (trajectory):\n${renderTrajectory(ctx)}`,
}));

const answerRelevancy = makeJudge("answerRelevancy", (ctx) => ({
  system:
    "You are an impartial evaluator of ANSWER RELEVANCY: does the final answer directly address " +
    "the user's task (not off-topic, not evasive)? Call the `score` tool.",
  user: `Task:\n${ctx.input}\n\nFinal answer:\n${ctx.finalText ?? "(none)"}`,
}));

/** The `llmJudge.*` namespace (matches the §11.4 sketch surface). */
export const llmJudge = {
  taskCompletion,
  planQuality,
  faithfulness,
  answerRelevancy,
} as const;
