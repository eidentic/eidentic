import type { Scorer, ScoreResult } from "./scorer.js";
import type { Runner } from "./runner.js";
import { trajectoryFromEvents } from "./trajectory.js";
import type { EvalDataset } from "./dataset.js";
import type { ToolSchema } from "@eidentic/types";

export interface SampleScores {
  sampleIndex: number;
  scores: Record<string, ScoreResult>;
  /**
   * Present when the runner threw for this sample. Scores will be empty (or each requested scorer
   * marked failed) and the trajectory is empty. Other samples in the same case still run.
   */
  runnerError?: string;
}
export interface CaseReport {
  caseId: string;
  input: string;
  samples: SampleScores[];
  /** Per-scorer aggregate over this case's samples. */
  scorerMeans: Record<string, { mean: number; pass: number; n: number }>;
}
export interface AggregateEntry { mean: number; pass: number; n: number; }
export interface EvalReport {
  cases: CaseReport[];
  /** Per-scorer aggregate across ALL (case x sample) pairs. */
  aggregate: Record<string, AggregateEntry>;
}

export interface EvaluateOptions {
  scorers: Scorer[];
  /** Samples per case (trajectory metrics need repeats). Default 1. */
  samples?: number;
  /** Tool schemas threaded into every ScoreContext (schemaValidity / idempotencyKeyPresence). */
  toolSchemas?: ToolSchema[];
}

function mean(ns: number[]): number { return ns.length === 0 ? 0 : ns.reduce((a, b) => a + b, 0) / ns.length; }

/** Run every case (x samples) through `runner`, score, and aggregate. */
export async function evaluate(runner: Runner, dataset: EvalDataset, opts: EvaluateOptions): Promise<EvalReport> {
  const samples = Math.max(1, opts.samples ?? 1);
  const cases: CaseReport[] = [];
  // Accumulators for the global aggregate.
  const globalScores: Record<string, number[]> = {};
  const globalPass: Record<string, number> = {};
  const globalN: Record<string, number> = {};

  for (const c of dataset.cases) {
    const sampleScores: SampleScores[] = [];
    const perScorer: Record<string, { scores: number[]; pass: number }> = {};
    for (let i = 0; i < samples; i++) {
      // Isolate runner failures: one throwing runner must not abort the entire eval run.
      let run: Awaited<ReturnType<Runner>>;
      try {
        run = await runner(c.input);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // Record a synthetic failed sample. All requested scorers are marked failed so that
        // aggregation denominators stay correct (no NaN from empty arrays).
        const scores: Record<string, ScoreResult> = {};
        for (const s of opts.scorers) {
          const r: ScoreResult = { score: 0, passed: false, rationale: `runner threw: ${msg}` };
          scores[s.name] = r;
          (perScorer[s.name] ??= { scores: [], pass: 0 }).scores.push(r.score);
          (globalScores[s.name] ??= []).push(r.score);
          globalPass[s.name] = (globalPass[s.name] ?? 0);
          globalN[s.name] = (globalN[s.name] ?? 0) + 1;
        }
        sampleScores.push({ sampleIndex: i, scores, runnerError: msg });
        continue;
      }

      const trajectory = trajectoryFromEvents(run.events);
      const ctxBase = {
        input: c.input,
        trajectory,
        sampleIndex: i,
        ...(run.finalText !== undefined ? { finalText: run.finalText } : {}),
        ...(run.finalSubtype !== undefined ? { finalSubtype: run.finalSubtype } : {}),
        ...(c.expected ? { expected: c.expected } : {}),
        ...(opts.toolSchemas ? { toolSchemas: opts.toolSchemas } : {}),
      };
      const scores: Record<string, ScoreResult> = {};
      for (const s of opts.scorers) {
        // Isolate scorer failures: a throwing scorer becomes fail-closed for that scorer only.
        let r: ScoreResult;
        try {
          r = await s.score(ctxBase);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          r = { score: 0, passed: false, rationale: `scorer threw: ${msg}` };
        }
        scores[s.name] = r;
        (perScorer[s.name] ??= { scores: [], pass: 0 }).scores.push(r.score);
        if (r.passed) perScorer[s.name]!.pass++;
        (globalScores[s.name] ??= []).push(r.score);
        globalPass[s.name] = (globalPass[s.name] ?? 0) + (r.passed ? 1 : 0);
        globalN[s.name] = (globalN[s.name] ?? 0) + 1;
      }
      sampleScores.push({ sampleIndex: i, scores });
    }
    const scorerMeans: Record<string, { mean: number; pass: number; n: number }> = {};
    for (const [name, agg] of Object.entries(perScorer)) {
      scorerMeans[name] = { mean: mean(agg.scores), pass: agg.pass / agg.scores.length, n: agg.scores.length };
    }
    cases.push({ caseId: c.id, input: c.input, samples: sampleScores, scorerMeans });
  }

  const aggregate: Record<string, AggregateEntry> = {};
  for (const name of Object.keys(globalScores)) {
    const n = globalN[name] ?? 0;
    aggregate[name] = { mean: mean(globalScores[name]!), pass: n === 0 ? 0 : (globalPass[name] ?? 0) / n, n };
  }
  return { cases, aggregate };
}
