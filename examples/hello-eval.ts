/**
 * Agent evaluation harness (§11.3) — infra-free.
 *
 *  1. Build a tiny EvalDataset (one case with expectations + human ground truth).
 *  2. Run a MockModel-driven Agent via createRunner (one tool call → text answer).
 *  3. Score with trajectory.toolCorrectness + trajectory.verifierStall + a MockModel
 *     llmJudge.taskCompletion (a DIFFERENT MockModel than the agent — Constitution #6).
 *  4. Print the EvalReport (per-case + aggregate).
 *
 * Run:  pnpm hello:eval
 */
import { Agent, createTool } from "@eidentic/core";
import { InMemoryStore, MockModel } from "@eidentic/types/testing";
import { textBlock, toolUseBlock } from "@eidentic/types";
import { z } from "zod";
import { evaluate, createRunner, trajectory, llmJudge, type EvalDataset } from "@eidentic/eval";

async function main() {
  const store = new InMemoryStore();

  // Agent: scripts a `search` tool call, then a final answer.
  const agentModel = new MockModel([
    { content: [toolUseBlock("c1", "search", { q: "capital of France" })], usage: { inputTokens: 5, outputTokens: 5 } },
    { content: [textBlock("The capital of France is Paris.")], usage: { inputTokens: 5, outputTokens: 5 } },
  ]);
  const search = createTool({
    id: "search",
    description: "Search the web.",
    inputSchema: z.object({ q: z.string() }),
    execute: async ({ input }) => ({ result: `stub result for ${input.q}` }),
  });
  const agent = new Agent({ id: "demo", instructions: "Answer using tools.", model: agentModel, tools: [search], store });

  // Judge: a DISTINCT MockModel scripting the structured `score` tool call.
  const judgeModel = new MockModel([
    { content: [toolUseBlock("j1", "score", { score: 0.95, rationale: "Correct final answer (Paris)." })], usage: { inputTokens: 3, outputTokens: 3 } },
  ]);

  const dataset: EvalDataset = {
    name: "geo-smoke",
    cases: [
      { id: "france", input: "What is the capital of France?", groundTruth: "Paris", expected: { expectedTools: ["search"], maxSameNameRun: 10 } },
    ],
  };

  const report = await evaluate(createRunner(agent, store), dataset, {
    scorers: [trajectory.toolCorrectness, trajectory.verifierStall, llmJudge.taskCompletion(judgeModel)],
    samples: 1,
  });

  console.log(JSON.stringify(report, null, 2));
}

main();
