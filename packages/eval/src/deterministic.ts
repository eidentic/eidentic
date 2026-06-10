import type { Scorer, ScoreContext, ScoreResult, DatasetExpectation } from "./scorer.js";
import { clamp01, passAt } from "./scorer.js";
import { toolCallsOf, toolNamesOf, type ToolCallStep } from "./trajectory.js";

const fail = (rationale: string, details?: Record<string, unknown>): ScoreResult =>
  ({ score: 0, passed: false, rationale, ...(details ? { details } : {}) });
const ok = (rationale?: string, details?: Record<string, unknown>): ScoreResult =>
  ({ score: 1, passed: true, ...(rationale ? { rationale } : {}), ...(details ? { details } : {}) });

const exp = (ctx: ScoreContext): DatasetExpectation => ctx.expected ?? {};

/** toolCorrectness — every `expectedTools` entry was called at least once. */
const toolCorrectness: Scorer = {
  name: "toolCorrectness",
  score(ctx) {
    const want = exp(ctx).expectedTools ?? [];
    if (want.length === 0) return ok("no expected tools declared");
    const called = new Set(toolNamesOf(ctx.trajectory));
    const missing = want.filter((t) => !called.has(t));
    return missing.length === 0
      ? ok("all expected tools called", { called: [...called] })
      : fail(`missing expected tool(s): ${missing.join(", ")}`, { missing, called: [...called] });
  },
};

/** requiredParams — for each (tool => params) rule, EVERY call of that tool included those params. */
const requiredParams: Scorer = {
  name: "requiredParams",
  score(ctx) {
    const rules = exp(ctx).requiredParams ?? {};
    const names = Object.keys(rules);
    if (names.length === 0) return ok("no required-param rules declared");
    const calls = toolCallsOf(ctx.trajectory);
    const violations: string[] = [];
    for (const tool of names) {
      const params = rules[tool] ?? [];
      const matching = calls.filter((c) => c.name === tool);
      if (matching.length === 0) { violations.push(`${tool}: never called`); continue; }
      for (const c of matching) {
        const inp = (typeof c.input === "object" && c.input !== null) ? (c.input as Record<string, unknown>) : {};
        for (const p of params) {
          if (!(p in inp) || inp[p] === undefined || inp[p] === null || inp[p] === "") {
            violations.push(`${tool}: missing '${p}' (callId ${c.callId})`);
          }
        }
      }
    }
    return violations.length === 0
      ? ok("all required params present")
      : fail(`required-param violations: ${violations.length}`, { violations });
  },
};

/**
 * Minimal structural JSON-Schema validity check, sufficient for `z.toJSONSchema` output:
 * top-level `type:"object"`, declared `required` keys present, and (when `additionalProperties`
 * is false) no extra keys. Not a full validator — enough to catch the common tool-input bugs.
 */
function validateAgainstSchema(input: unknown, schema: unknown): string[] {
  const errs: string[] = [];
  if (typeof schema !== "object" || schema === null) return errs;
  const s = schema as Record<string, unknown>;
  if (s.type === "object") {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return ["input is not an object"];
    }
    const obj = input as Record<string, unknown>;
    const props = (typeof s.properties === "object" && s.properties !== null ? s.properties : {}) as Record<string, unknown>;
    const required = Array.isArray(s.required) ? (s.required as string[]) : [];
    for (const r of required) {
      if (!(r in obj) || obj[r] === undefined) errs.push(`missing required '${r}'`);
    }
    if (s.additionalProperties === false) {
      for (const k of Object.keys(obj)) if (!(k in props)) errs.push(`unexpected property '${k}'`);
    }
  }
  return errs;
}

/** schemaValidity — every tool call's input validates against the matching tool schema. */
const schemaValidity: Scorer = {
  name: "schemaValidity",
  score(ctx) {
    const schemas = ctx.toolSchemas ?? [];
    if (schemas.length === 0) return ok("no tool schemas supplied — skipped");
    const byName = new Map(schemas.map((s) => [s.name, s.inputSchema]));
    const calls = toolCallsOf(ctx.trajectory);
    const violations: string[] = [];
    for (const c of calls) {
      const schema = byName.get(c.name);
      if (schema === undefined) continue; // unknown tool: not this scorer's concern
      for (const e of validateAgainstSchema(c.input, schema)) violations.push(`${c.name}: ${e}`);
    }
    return violations.length === 0
      ? ok("all tool inputs valid")
      : fail(`schema violations: ${violations.length}`, { violations });
  },
};

/**
 * idempotencyKeyPresence — mutating tool calls carried an idempotency key.
 *
 * A call is treated as "keyed" iff its `input` contains a non-empty `idempotencyKey` field OR the
 * matching `toolSchema` declares an `idempotencyKey` predicate (schema-level marker; the registry
 * computes the actual key from input at dispatch, so it is never in the event log). "Mutating" =
 * a tool whose schema's `sideEffect` is not "read-only".
 *
 * **Important**: the public `ToolSchema` shape (`{name, description, inputSchema}`) does NOT expose
 * a `sideEffect` field, and `ToolRegistry.schemas()` strips it. Consequently, when schemas are
 * supplied but NONE carry a `sideEffect` marker this scorer cannot distinguish mutating from
 * read-only calls — it skips the check and returns a labeled non-actionable result
 * (`passed: true`, `score: 1`) rather than a misleading confident pass. Augment the schemas with
 * `sideEffect` markers (e.g. cast to `ToolSchemaLike`) to enable real evaluation.
 */
const idempotencyKeyPresence: Scorer = {
  name: "idempotencyKeyPresence",
  score(ctx) {
    const schemas = ctx.toolSchemas ?? [];
    const meta = new Map(
      schemas.map((s) => [s.name, s as ToolSchemaLike]),
    );
    const calls = toolCallsOf(ctx.trajectory);

    // When tool calls exist but NO supplied schema carries a sideEffect marker, we cannot
    // determine which calls are mutating. Return a clearly-labeled skip rather than a
    // misleading affirmative pass.
    if (calls.length > 0) {
      const anySideEffectMarker = schemas.some((s) => (s as ToolSchemaLike).sideEffect !== undefined);
      if (!anySideEffectMarker) {
        return {
          score: 1,
          passed: true,
          rationale: "idempotency-key check skipped: no sideEffect markers on supplied tool schemas (augment schemas to enable)",
          details: { skipped: "no sideEffect markers on supplied schemas" },
        };
      }
    }

    const offenders: string[] = [];
    let mutatingSeen = 0;
    for (const c of calls) {
      const m = meta.get(c.name);
      const isMutating = m ? m.sideEffect !== undefined && m.sideEffect !== "read-only" : false;
      if (!isMutating) continue;
      mutatingSeen++;
      const inp = (typeof c.input === "object" && c.input !== null) ? (c.input as Record<string, unknown>) : {};
      const hasKeyField = typeof inp.idempotencyKey === "string" && inp.idempotencyKey.length > 0;
      const hasKeyMarker = m?.idempotencyKey === true;
      if (!hasKeyField && !hasKeyMarker) offenders.push(`${c.name} (callId ${c.callId})`);
    }
    if (mutatingSeen === 0) return ok("no mutating tool calls — nothing to key");
    return offenders.length === 0
      ? ok("all mutating calls carried an idempotency key", { mutatingSeen })
      : fail(`mutating calls without an idempotency key: ${offenders.length}`, { offenders });
  },
};

/** Schema with the eval-relevant markers the registry exposes (sideEffect + idempotencyKey presence). */
interface ToolSchemaLike {
  name: string;
  sideEffect?: string;
  idempotencyKey?: boolean;
}

/** toolSequence — the ordered tool names exactly match `expectedSequence`. */
const toolSequence: Scorer = {
  name: "toolSequence",
  score(ctx) {
    const want = exp(ctx).expectedSequence;
    if (!want) return ok("no expected sequence declared");
    const got = toolNamesOf(ctx.trajectory);
    const equal = got.length === want.length && got.every((n, i) => n === want[i]);
    return equal
      ? ok("tool sequence matches", { got })
      : fail("tool sequence mismatch", { got, want });
  },
};

/**
 * stepEfficiency — tool calls (and/or model calls) within budget. Score degrades linearly past
 * the budget (so a 2x overrun ~= 0.5), clamped to [0,1]; passes when at/under budget.
 */
const stepEfficiency: Scorer = {
  name: "stepEfficiency",
  score(ctx) {
    const e = exp(ctx);
    const toolCalls = toolCallsOf(ctx.trajectory).length;
    const modelCalls = ctx.trajectory.steps.filter((s) => s.kind === "modelCall").length;
    const checks: Array<{ label: string; used: number; budget: number }> = [];
    if (e.maxToolCalls !== undefined) checks.push({ label: "toolCalls", used: toolCalls, budget: e.maxToolCalls });
    if (e.maxModelCalls !== undefined) checks.push({ label: "modelCalls", used: modelCalls, budget: e.maxModelCalls });
    if (checks.length === 0) return ok("no budget declared", { toolCalls, modelCalls });
    let worst = 1;
    const detail: Record<string, unknown> = { toolCalls, modelCalls };
    for (const c of checks) {
      const ratio = c.used === 0 ? 1 : clamp01(c.budget / c.used);
      detail[c.label] = { used: c.used, budget: c.budget, ratio };
      worst = Math.min(worst, ratio);
    }
    const passed = checks.every((c) => c.used <= c.budget);
    return { score: clamp01(worst), passed, rationale: passed ? "within budget" : "over budget", details: detail };
  },
};

/**
 * verifierStall — flags the "verifier stall" failure mode: a run of MORE THAN N consecutive
 * tool calls with the SAME name (§11.3 default >10). Score 0 / fail when a stall run exists.
 */
const verifierStall: Scorer = {
  name: "verifierStall",
  score(ctx) {
    const threshold = exp(ctx).maxSameNameRun ?? 10;
    const names = toolNamesOf(ctx.trajectory);
    let longest = 0, run = 0, prev = "", longestName = "";
    for (const n of names) {
      run = n === prev ? run + 1 : 1;
      prev = n;
      if (run > longest) { longest = run; longestName = n; }
    }
    const stalled = longest > threshold;
    return stalled
      ? fail(`verifier stall: ${longest} consecutive '${longestName}' calls (> ${threshold})`, { longest, threshold, tool: longestName })
      : ok("no verifier stall", { longest, threshold });
  },
};

/**
 * noRepeatedSteps — flags step-repetition (17% of failures, §11.3): the SAME (toolName + canonical
 * input) appearing more than once across the whole trajectory. Score = unique/total of tool calls.
 */
const noRepeatedSteps: Scorer = {
  name: "noRepeatedSteps",
  score(ctx) {
    const calls = toolCallsOf(ctx.trajectory);
    if (calls.length === 0) return ok("no tool calls");
    const sig = (c: ToolCallStep) => `${c.name}|${canonicalJson(c.input)}`;
    const seen = new Map<string, number>();
    for (const c of calls) seen.set(sig(c), (seen.get(sig(c)) ?? 0) + 1);
    const repeats = [...seen.entries()].filter(([, n]) => n > 1);
    const unique = seen.size;
    const score = clamp01(unique / calls.length);
    return repeats.length === 0
      ? ok("no repeated steps", { unique, total: calls.length })
      : { score, passed: false, rationale: `repeated step(s): ${repeats.length}`, details: { repeats: repeats.map(([k, n]) => ({ step: k, count: n })) } };
  },
};

/** Stable canonical JSON for step signatures (mirrors core's idempotency hashing approach). */
function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson((v as Record<string, unknown>)[k])).join(",") + "}";
}

/** The `trajectory.*` namespace (matches the §11.4 sketch surface). */
export const trajectory = {
  toolCorrectness,
  requiredParams,
  schemaValidity,
  idempotencyKeyPresence,
  toolSequence,
  stepEfficiency,
  verifierStall,
  noRepeatedSteps,
} as const;

export { passAt };
